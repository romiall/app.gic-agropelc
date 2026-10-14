/**
 * `POST /api/v1/attachments/{id}/upload-session`, `PUT .../content`, `HEAD .../content`
 * (P0-13 ; ADR-012 point 3). Câblage HTTP réel (comme `sync-http.e2e.test.ts`) : démontre
 * NFR-08 (upload interrompu puis repris) de bout en bout — garde, contrôleur, analyseur de
 * contenu brut (`register-raw-body-parser.ts`), stockage local par morceaux, vérification
 * d'empreinte finale.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { registerRawBodyParser } from '../src/platform/http/register-raw-body-parser.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import {
  signAccessToken,
  type JwtKeyPair,
} from '../src/modules/identity/application/public/jwt.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestUser,
} from './helpers.js';

const OCCURRED_AT = '2026-09-25T09:00:00.000Z';

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Contenu commençant comme un JPEG (signature vérifiée à la fin de l'envoi, MP-10). */
function jpeg(body: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(body, 'utf8')]);
}

describe('POST/PUT/HEAD /api/v1/attachments/{id}/content (câblage NestJS + Fastify, NFR-08)', () => {
  let app: NestFastifyApplication;
  let token: string;
  let user: string;
  let device: string;

  beforeAll(async () => {
    process.env.SERVER_DATABASE_URL ??=
      'mysql://gic_app:gic_app_password@127.0.0.1:3306/gic_agropelc_test';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerRawBodyParser(app);
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const jwtKeys = app.get<JwtKeyPair>(JWT_KEYS);
    const clock = app.get(CLOCK);

    user = await db.transaction().execute((trx) => insertTestUser(trx));
    device = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, user, { status: 'ACTIVE' }));
    token = await signAccessToken(
      jwtKeys.privateKey,
      { sub: user, device_id: device, session_id: freshUuid() },
      clock.now(),
    );

    await db.transaction().execute(async (trx) => {
      const role = await insertTestRole(trx, user);
      await grantTestPermission(trx, role, 'attachments.attachment.manage', user, {
        maxScope: 'OWN',
      });
      await assignTestRole(trx, user, role, user);
    });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  async function registerAttachment(sizeBytes: number, sha256: string): Promise<string> {
    const attachmentId = freshUuid();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/commands',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        command_id: freshUuid(),
        device_seq: 1,
        command_type: 'attachments.attachment.register',
        command_version: 1,
        author_user_id: user,
        aggregate_type: 'ATTACHMENT',
        aggregate_id: attachmentId,
        base_version: null,
        depends_on: [],
        occurred_at: OCCURRED_AT,
        client_created_at: OCCURRED_AT,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: {
          ownerType: 'TEST_SUBJECT',
          ownerId: freshUuid(),
          kind: 'PHOTO',
          mimeType: 'image/jpeg',
          sizeBytes,
          sha256,
          capturedAt: OCCURRED_AT,
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ command_id: expect.any(String), status: 'APPLIED' });
    return attachmentId;
  }

  it('NFR-08 : upload interrompu après le premier morceau, repris via HEAD, complété avec succès', async () => {
    const first = jpeg('a'.repeat(96));
    const second = Buffer.from('b'.repeat(150), 'utf8');
    const full = Buffer.concat([first, second]);
    const attachmentId = await registerAttachment(full.length, sha256Hex(full));

    const session = await app.inject({
      method: 'POST',
      url: `/api/v1/attachments/${attachmentId}/upload-session`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ uploaded_bytes: 0 });

    const firstPut = await app.inject({
      method: 'PUT',
      url: `/api/v1/attachments/${attachmentId}/content`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'content-range': `bytes 0-${first.length - 1}/${full.length}`,
      },
      payload: first,
    });
    expect(firstPut.statusCode).toBe(200);
    expect(firstPut.json()).toEqual({
      uploaded_bytes: first.length,
      upload_status: 'PENDING_UPLOAD',
    });

    // « Coupure » simulée : le client ne sait plus où il en était, il interroge le serveur.
    const head = await app.inject({
      method: 'HEAD',
      url: `/api/v1/attachments/${attachmentId}/content`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(head.statusCode).toBe(200);
    expect(head.headers['x-uploaded-bytes']).toBe(String(first.length));

    // Reprise, exactement à l'offset découvert par HEAD.
    const secondPut = await app.inject({
      method: 'PUT',
      url: `/api/v1/attachments/${attachmentId}/content`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${first.length}-${full.length - 1}/${full.length}`,
      },
      payload: second,
    });
    expect(secondPut.statusCode).toBe(200);
    expect(secondPut.json()).toEqual({ uploaded_bytes: full.length, upload_status: 'AVAILABLE' });

    const row = await db
      .selectFrom('attachments_attachments')
      .select(['upload_status', 'uploaded_bytes'])
      .where('id', '=', toBin(attachmentId))
      .executeTakeFirstOrThrow();
    expect(row.upload_status).toBe('AVAILABLE');
    expect(row.uploaded_bytes).toBe(full.length);
  });

  it('décalage incohérent (Content-Range) → 409, uploaded_bytes réel renvoyé dans details', async () => {
    const content = Buffer.from('x'.repeat(50), 'utf8');
    const attachmentId = await registerAttachment(content.length, sha256Hex(content));

    const wrongOffset = await app.inject({
      method: 'PUT',
      url: `/api/v1/attachments/${attachmentId}/content`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'content-range': `bytes 10-${content.length - 1}/${content.length}`, // devrait commencer à 0
      },
      payload: content.subarray(10),
    });
    expect(wrongOffset.statusCode).toBe(409);
    const body = wrongOffset.json();
    expect(body.error.code).toBe('UPLOAD_OFFSET_MISMATCH');
    expect(body.error.details).toEqual({ uploaded_bytes: 0 });
  });

  it('empreinte finale non conforme → QUARANTINED (SM-ATTACHMENT)', async () => {
    const content = Buffer.from('contenu réel', 'utf8');
    const declaredWrongHash = 'f'.repeat(64); // ne correspondra jamais au contenu réel
    const attachmentId = await registerAttachment(content.length, declaredWrongHash);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/v1/attachments/${attachmentId}/content`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'content-range': `bytes 0-${content.length - 1}/${content.length}`,
      },
      payload: content,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ uploaded_bytes: content.length, upload_status: 'QUARANTINED' });
  });

  async function putAll(attachmentId: string, content: Buffer, authToken = token) {
    return app.inject({
      method: 'PUT',
      url: `/api/v1/attachments/${attachmentId}/content`,
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/octet-stream',
        'content-range': `bytes 0-${content.length - 1}/${content.length}`,
      },
      payload: content,
    });
  }

  it('MP-10 : empreinte juste mais contenu qui n’est pas un JPEG → QUARANTINED (signature, 02-securite §6)', async () => {
    const content = Buffer.from('<script>pas une image</script>', 'utf8');
    const attachmentId = await registerAttachment(content.length, sha256Hex(content));
    const put = await putAll(attachmentId, content);
    expect(put.json()).toEqual({ uploaded_bytes: content.length, upload_status: 'QUARANTINED' });
  });

  it('MP-10 : morceau au-delà de la taille annoncée → 400, rien d’écrit', async () => {
    const content = jpeg('z'.repeat(20));
    const attachmentId = await registerAttachment(content.length, sha256Hex(content));
    const beyond = await app.inject({
      method: 'PUT',
      url: `/api/v1/attachments/${attachmentId}/content`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'content-range': `bytes 0-${content.length}/${content.length}`,
      },
      payload: Buffer.concat([content, Buffer.from('!')]),
    });
    expect(beyond.statusCode).toBe(400);
    expect((await putAll(attachmentId, content)).json()).toMatchObject({
      upload_status: 'AVAILABLE',
    });
  });

  it('MP-10 : pièce reçue — nouvel envoi refusé (409, statut rendu) ; lecture par l’auteur, refusée à un autre', async () => {
    const content = jpeg('photo du bon');
    const attachmentId = await registerAttachment(content.length, sha256Hex(content));

    // Pas encore reçue : rien à lire.
    const early = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${attachmentId}/content`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toMatchObject({
      code: 'ATTACHMENT_NOT_AVAILABLE',
      details: { upload_status: 'PENDING_UPLOAD' },
    });

    expect((await putAll(attachmentId, content)).json()).toMatchObject({
      upload_status: 'AVAILABLE',
    });
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/attachments/${attachmentId}/upload-session`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details).toEqual({ upload_status: 'AVAILABLE' });

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${attachmentId}/content`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.rawPayload.equals(content)).toBe(true);
    expect(read.headers['content-type']).toBe('image/jpeg');
    expect(read.headers['cache-control']).toBe('private, no-store');
    expect(read.headers['x-content-type-options']).toBe('nosniff');

    // Un autre utilisateur, sans droit sur le document (propriétaire de test) : refus audité.
    const other = await db.transaction().execute((trx) => insertTestUser(trx));
    const otherDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, other, { status: 'ACTIVE' }));
    const otherToken = await signAccessToken(
      app.get<JwtKeyPair>(JWT_KEYS).privateKey,
      { sub: other, device_id: otherDevice, session_id: freshUuid() },
      app.get(CLOCK).now(),
    );
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${attachmentId}/content`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(denied.statusCode).toBe(403);
    const audit = await db
      .selectFrom('audit_audit_log')
      .select(['action', 'result'])
      .where('entity_id', '=', toBin(attachmentId))
      .where('actor_user_id', '=', toBin(other))
      .execute();
    expect(audit).toEqual([{ action: 'access.denied', result: 'DENIED' }]);
    // L'auteur seul envoie : un autre est refusé même pour une pièce en attente.
    const pending = await registerAttachment(content.length, sha256Hex(content));
    expect((await putAll(pending, content, otherToken)).statusCode).toBe(403);

    const unknown = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${freshUuid()}/content`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('sans Authorization → 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/attachments/${freshUuid()}/upload-session`,
    });
    expect(response.statusCode).toBe(401);
  });
});
