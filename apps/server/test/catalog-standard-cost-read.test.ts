/**
 * AV-516 — historique du coût standard d'un produit : `GET /api/v1/products/{id}/standard-costs`. Application
 * complète, rôles réels du seed : l'Admin saisit les coûts (`catalog.product.manage`), la valorisation les lit
 * (`inventory.valuation.read` : Direction, Finance, Resp. achats, Resp. production) ; un autre rôle, même lecteur
 * du catalogue, reçoit 403 (RC-05 : un coût ne se lit pas avec le seul droit de lire le catalogue).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Clock } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import {
  closeTestDb,
  freshUuid,
  insertTestProduct,
  insertTestUser,
  signTestAccessToken,
} from './helpers.js';
import { newActor, tx, type Actor } from './cash-transfer-fixtures.js';

interface CostRow {
  readonly id: string;
  readonly unitCostXaf: number;
  readonly validFrom: string;
  readonly reason: string | null;
  readonly createdBy: string;
}

describe('AV-516 : historique du coût standard', { timeout: 120_000 }, () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let pipeline: CommandPipelineService;
  let root: string;
  let admin: Actor;
  let direction: Actor;
  let respFerme: Actor;
  let productId: string;
  let deviceSeq = 0;

  const tokenOf = (actor: Actor) =>
    signTestAccessToken(
      app.get(JWT_KEYS).privateKey,
      { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
      clock.now(),
    );
  const get = async (actor: Actor, url: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${await tokenOf(actor)}` },
    });
  const setCost = (
    product: string,
    unitCostXaf: number,
    occurredAt: string,
    reason?: string,
  ): Promise<CommandResult> =>
    pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: 'catalog.product_standard_cost.set',
        aggregate_type: 'PRODUCT_STANDARD_COST',
        aggregate_id: freshUuid(),
        author_user_id: admin.userId,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: { productId: product, unitCostXaf, ...(reason ? { reason } : {}) },
      },
      {
        authenticatedUserId: admin.userId,
        authenticatedDeviceId: admin.deviceId,
        transport: 'ONLINE_API' as const,
      },
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    clock = app.get(CLOCK);
    pipeline = app.get(CommandPipelineService);

    root = await tx((trx) => insertTestUser(trx));
    admin = await newActor('ADMIN', root);
    direction = await newActor('DIRECTION', root);
    // Lecteur du catalogue sans droit de valorisation, de portée globale permise (COMMERCIAL_SEDENTAIRE).
    respFerme = await newActor('COMMERCIAL_SEDENTAIRE', root);
    productId = await tx((trx) => insertTestProduct(trx, root));
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('rend les versions du coût, la plus récente en tête, avec leur motif', async () => {
    const empty = await get(direction, `/api/v1/products/${productId}/standard-costs`);
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toEqual({ product_id: productId, costs: [] });

    expect((await setCost(productId, 1200, '2026-10-01T08:00:00.000Z')).status).toBe('APPLIED');
    expect(
      (await setCost(productId, 1500, '2026-10-20T08:00:00.000Z', 'Hausse de l’aliment')).status,
    ).toBe('APPLIED');

    const response = await get(direction, `/api/v1/products/${productId}/standard-costs`);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { product_id: string; costs: CostRow[] };
    expect(body.product_id).toBe(productId);
    expect(body.costs.map((cost) => cost.unitCostXaf)).toEqual([1500, 1200]);
    expect(body.costs[0]).toMatchObject({
      reason: 'Hausse de l’aliment',
      validFrom: '2026-10-20T08:00:00.000Z',
      createdBy: admin.userId,
    });
    expect(body.costs[1]!.reason).toBeNull();
  });

  it('refuse un lecteur sans droit de valorisation (403), un identifiant invalide (400) et un produit inconnu (404)', async () => {
    // L'Admin saisit les coûts mais ne les relit pas : la valorisation est un autre droit.
    expect((await get(admin, `/api/v1/products/${productId}/standard-costs`)).statusCode).toBe(403);
    expect((await get(respFerme, `/api/v1/products/${productId}/standard-costs`)).statusCode).toBe(
      403,
    );
    expect((await get(direction, '/api/v1/products/pas-un-uuid/standard-costs')).statusCode).toBe(
      400,
    );
    expect(
      (await get(direction, `/api/v1/products/${freshUuid()}/standard-costs`)).statusCode,
    ).toBe(404);
  });

  it('la liste des produits ne porte aucun coût', async () => {
    const response = await get(direction, '/api/v1/products');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toMatch(/unitCost|unit_cost|standardCost/);
  });
});
