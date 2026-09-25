/**
 * `PUT /attachments/{id}/content` (ADR-012 point 3) reçoit un morceau d'octets bruts, pas du
 * JSON : Fastify ne sait nativement parser que `application/json`/`text/plain`. Un analyseur
 * de type de contenu dédié est nécessaire avant `app.init()` — appelé une fois par
 * `main.ts` et par chaque test e2e qui construit sa propre application Nest+Fastify (comme
 * `app.getHttpAdapter().getInstance().ready()`, déjà appelé dans ces mêmes tests).
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

export const OCTET_STREAM_CONTENT_TYPE = 'application/octet-stream';

export function registerRawBodyParser(app: NestFastifyApplication): void {
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addContentTypeParser(
    OCTET_STREAM_CONTENT_TYPE,
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );
}
