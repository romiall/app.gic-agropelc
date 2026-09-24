/**
 * Formate toute exception en enveloppe `apiErrorSchema` (@gic/contracts) — un seul format
 * d'erreur transport pour toute l'API (08-api-events/01-architecture-api.md §2). Aucune
 * pile d'appels exposée au client (07-security-rbac/02-securite.md §7) : les erreurs
 * inattendues sont journalisées côté serveur et renvoyées sous un code générique.
 */
import { Catch, HttpException, Inject } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { IdGenerator } from '@gic/domain';
import { ID_GENERATOR } from '../id-generator.provider.js';
import { ApiError } from './api-error.exception.js';

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  constructor(@Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const correlationId = this.idGenerator.newId();

    if (exception instanceof ApiError) {
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
      reply.status(status).send({
        error: {
          code: status === 400 ? 'VALIDATION_ERROR' : 'HTTP_ERROR',
          message: Array.isArray(message) ? message.join(' ; ') : message,
          correlation_id: correlationId,
        },
      });
      return;
    }

    console.error(`[${correlationId}]`, exception);
    reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Erreur interne du serveur.',
        correlation_id: correlationId,
      },
    });
  }
}
