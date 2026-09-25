/**
 * `correlation_id` par requête (09-non-functional/02-observabilite.md §1 : « créé par
 * requête ou par lot de synchronisation... propagé aux gestionnaires, aux événements, à
 * l'audit et aux logs, et renvoyé au client dans les réponses d'erreur »). Posé le plus tôt
 * possible (`onRequest`, avant tout garde ou contrôleur) pour qu'aucun chemin — y compris un
 * rejet d'authentification — n'en soit privé ; renvoyé sur **toute** réponse (succès compris,
 * en-tête `x-correlation-id`), pas seulement les erreurs (`ApiErrorFilter` le lit, ne le
 * régénère plus).
 *
 * Fonction simple appelée après `createNestApplication()` (comme
 * `register-raw-body-parser.ts`), pas un fournisseur `PlatformModule` : `HttpAdapterHost`
 * n'existe que pour une véritable application HTTP, absent d'un `TestingModule` compilé sans
 * `createNestApplication()` (`endpoint-coverage.test.ts`, `chain-verification.integration.
 * test.ts`) — un fournisseur global aurait fait échouer leur compilation, HTTP ou non.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { IdGenerator } from '@gic/domain';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

export const CORRELATION_ID_HEADER = 'x-correlation-id';
const MAX_CLIENT_PROVIDED_LENGTH = 100;

export function registerCorrelationId(app: NestFastifyApplication, idGenerator: IdGenerator): void {
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', (request, reply, done) => {
    const provided = request.headers[CORRELATION_ID_HEADER];
    const clientProvided =
      typeof provided === 'string' &&
      provided.length > 0 &&
      provided.length <= MAX_CLIENT_PROVIDED_LENGTH
        ? provided
        : undefined;
    request.correlationId = clientProvided ?? idGenerator.newId();
    reply.header(CORRELATION_ID_HEADER, request.correlationId);
    done();
  });
}
