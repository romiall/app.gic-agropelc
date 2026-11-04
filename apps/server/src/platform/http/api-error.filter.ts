/**
 * Formate toute exception en enveloppe `apiErrorSchema` (@gic/contracts) — un seul format
 * d'erreur transport pour toute l'API (08-api-events/01-architecture-api.md §2). Aucune
 * pile d'appels exposée au client (07-security-rbac/02-securite.md §7) : les erreurs
 * inattendues sont journalisées côté serveur et renvoyées sous un code générique.
 *
 * `correlation_id` (P0-16, NFR-28) : lu sur la requête (posé par `CorrelationIdHook`, le
 * plus tôt possible), jamais régénéré ici — la même valeur doit identifier cette requête
 * dans la réponse d'erreur, dans les logs, et dans l'audit si l'échec est survenu après le
 * début du traitement métier.
 *
 * Journal d'un refus (`refusalLogEntry`) : la ligne dit **où** (méthode et chemin, sans paramètres), **pour qui**
 * (appareil et utilisateur pseudonymisé, quand la requête est authentifiée) et, pour une requête mal formée, ce que
 * le serveur lui a reproché (le texte déjà rendu à l'appelant, jamais la charge). Sans cela, un lot refusé en bloc
 * laissait « Requête refusée : VALIDATION_ERROR. » sans appareil, ni route, ni motif, et l'origine du blocage de la
 * file d'un appareil n'a pu être établie que par recoupement d'horaires (constaté le 04/11/2026, ADR-052).
 */
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './api-error.exception.js';
import { logStructured, type StructuredLogFields } from '../observability/logger.js';

/** Longueur maximale du motif de validation reporté dans le journal. */
const VALIDATION_DETAIL_MAX = 300;

/** Ce que le journal d'un refus a besoin de lire sur la requête. */
export type RefusedRequest = Pick<FastifyRequest, 'method' | 'url' | 'correlationId'> & {
  readonly auth?: { readonly sub: string; readonly device_id: string } | undefined;
};

export function refusalLogEntry(
  code: string,
  status: number,
  message: string,
  request: RefusedRequest,
): { readonly fields: StructuredLogFields; readonly line: string } {
  const path = request.url.split('?')[0] ?? '';
  const detail = status === 400 ? ` : ${message.slice(0, VALIDATION_DETAIL_MAX)}` : '';
  return {
    fields: {
      module: 'http',
      correlationId: request.correlationId,
      userId: request.auth?.sub,
      deviceId: request.auth?.device_id,
      code,
    },
    line: `Requête refusée : ${code} (${request.method} ${path})${detail}`,
  };
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const correlationId = request.correlationId;

    if (exception instanceof ApiError) {
      const entry = refusalLogEntry(
        exception.code,
        exception.getStatus(),
        exception.message,
        request,
      );
      logStructured('warn', entry.fields, `${entry.line}.`);
      reply.status(exception.getStatus()).send(exception.toBody(correlationId));
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message);
      const code = status === 400 ? 'VALIDATION_ERROR' : 'HTTP_ERROR';
      const text = Array.isArray(message) ? message.join(' ; ') : message;
      const entry = refusalLogEntry(code, status, text, request);
      logStructured('warn', entry.fields, `${entry.line}.`);
      reply.status(status).send({
        error: {
          code,
          message: text,
          correlation_id: correlationId,
        },
      });
      return;
    }

    logStructured(
      'error',
      { module: 'http', correlationId, code: 'INTERNAL_ERROR' },
      exception instanceof Error ? exception.message : 'Erreur interne inattendue.',
    );
    reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Erreur interne du serveur.',
        correlation_id: correlationId,
      },
    });
  }
}
