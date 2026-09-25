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
 */
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './api-error.exception.js';
import { logStructured } from '../observability/logger.js';

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const correlationId = request.correlationId;

    if (exception instanceof ApiError) {
      logStructured(
        'warn',
        { module: 'http', correlationId, code: exception.code },
        `Requête refusée : ${exception.code}.`,
      );
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
      logStructured('warn', { module: 'http', correlationId, code }, `Requête refusée : ${code}.`);
      reply.status(status).send({
        error: {
          code,
          message: Array.isArray(message) ? message.join(' ; ') : message,
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
