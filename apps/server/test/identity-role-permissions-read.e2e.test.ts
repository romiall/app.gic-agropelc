/**
 * Lectures de l'éditeur des droits des rôles (questionnaire de clôture, Q28 du 08/11/2026 ; ADR-072) :
 * `GET /roles/editable` et `GET /roles/{id}/permissions`, au droit `identity.role.manage` (Admin et Direction). Les
 * portées proposées et le retrait suivent la même règle que la commande (`judgeRolePermissionChange`) : on ne donne
 * que ce qu'on a. Seuls des rôles d'essai sont lus en détail ; aucune écriture sur un rôle système.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Clock } from '@gic/domain';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import {
  closeTestDb,
  freshUuid,
  grantTestPermission,
  insertTestRole,
  insertTestUser,
  signTestAccessToken,
} from './helpers.js';
import { newActor, tx, type Actor } from './cash-transfer-fixtures.js';

interface PermissionEntry {
  readonly code: string;
  readonly maxScope: string | null;
  readonly editable: boolean;
  readonly grantableScopes: readonly string[];
  readonly canRevoke: boolean;
}

describe('éditeur des droits des rôles : lectures (Q28, ADR-072)', { timeout: 180_000 }, () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let direction: Actor;
  let outsider: Actor;
  let target: string;

  const get = async (actor: Actor, url: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: {
        authorization: `Bearer ${await signTestAccessToken(
          app.get(JWT_KEYS).privateKey,
          { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
          clock.now(),
        )}`,
      },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    clock = app.get(CLOCK);
    const root = await tx((trx) => insertTestUser(trx));
    direction = await newActor('DIRECTION', root);
    outsider = await newActor('FINANCE', root);
    target = await tx(async (trx) => {
      const role = await insertTestRole(trx, root);
      // Une permission que la Direction ne détient pas (`identity.role_assignment.manage`, Admin seul), accordée au
      // rôle d'essai : la Direction ne peut ni la retirer ni en changer la portée.
      await grantTestPermission(trx, role, 'identity.role_assignment.manage', root, {
        maxScope: 'ALL',
      });
      return role;
    });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('GET /roles/editable : les rôles actifs, l’Administrateur figé ; refusé sans identity.role.manage', async () => {
    const response = await get(direction, '/api/v1/roles/editable');
    expect(response.statusCode, response.body).toBe(200);
    const roles = response.json().roles as { id: string; code: string; editable: boolean }[];
    expect(roles.find((role) => role.code === 'ADMIN')).toMatchObject({ editable: false });
    expect(roles.find((role) => role.id === target)).toMatchObject({ editable: true });
    expect((await get(outsider, '/api/v1/roles/editable')).statusCode).toBe(403);
  });

  it('GET /roles/{id}/permissions : portées proposées selon ce que le lecteur détient, droit protégé non modifiable', async () => {
    const response = await get(direction, `/api/v1/roles/${target}/permissions`);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      role: { id: string; editable: boolean };
      permissions: PermissionEntry[];
      changes: unknown[];
    };
    expect(body.role).toMatchObject({ id: target, editable: true });
    const byCode = new Map(body.permissions.map((permission) => [permission.code, permission]));
    // Détenue par la Direction à ALL : toutes les portées admises lui sont proposées ; non accordée au rôle.
    expect(byCode.get('finance.expense.approve')).toMatchObject({
      maxScope: null,
      editable: true,
      canRevoke: false,
    });
    expect(byCode.get('finance.expense.approve')!.grantableScopes).toContain('ALL');
    // Accordée au rôle, mais étrangère à la Direction : ni portée proposée, ni retrait.
    expect(byCode.get('identity.role_assignment.manage')).toMatchObject({
      maxScope: 'ALL',
      grantableScopes: [],
      canRevoke: false,
    });
    // Le droit de modifier les droits ne se modifie jamais dans l'application.
    expect(byCode.get('identity.role.manage')).toMatchObject({
      editable: false,
      grantableScopes: [],
    });
    expect(body.changes).toEqual([]);
    expect((await get(outsider, `/api/v1/roles/${target}/permissions`)).statusCode).toBe(403);
  });
});
