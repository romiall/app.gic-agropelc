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
    const first = Buffer.from('a'.repeat(100), 'utf8');
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

  it('sans Authorization → 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/attachments/${freshUuid()}/upload-session`,
    });
    expect(response.statusCode).toBe(401);
  });
});
