/**
 * P8-10 : jeux hors ligne de la finance opérationnelle (ADR-042 §9 et §11 ; dictionnaire
 * `finance.expenses` « DL (30 j) », `finance.expense_categories` « DL ») — par le pull réel
 * (`SyncPullService`) : dépenses de l'auteur seul dans `cash` (fenêtre de 30 jours, version suivie),
 * catégories dans `catalog`, seuils des dépenses publiés dans `me`. Revue de P8-14 : une dépense plus
 * ancienne reste servie tant qu'elle attend sa décision, et à nouveau quand elle est modifiée.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import type { Change, CommandResult } from '@gic/contracts';
import { sql } from 'kysely';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { resolveEntityProjection } from '../src/sync/entity-projections.js';
import { registerExpenseCommands } from '../src/modules/finance/application/commands/expense-commands.js';
import { registerExpenseCategoryCommands } from '../src/modules/finance/application/commands/expense-category-commands.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestUser,
  insertTestZone,
  neutralizePolicy,
} from './helpers.js';
import {
  fund,
  newAccount,
  newActor,
  newPosSite,
  tx,
  type Actor,
} from './cash-transfer-fixtures.js';

describe('P8-10 : jeux hors ligne de la finance opérationnelle', { timeout: 60_000 }, () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let pullService: SyncPullService;
  let cursor0 = 0;
  let deviceSeq = 0;
  let terrain: Actor;
  let other: Actor;
  let fin: Actor;
  let dir: Actor;
  let site: string;
  let account: string;
  const category: Record<string, string> = {};
  const recently = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  const send = async (
    actor: Actor,
    type: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    offline = false,
  ): Promise<CommandResult> => {
    const result = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: type,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: offline,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: offline ? 'SYNC_PUSH' : 'ONLINE_API',
      },
    );
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
    return result;
  };
  const pull = async (actor: Actor, dataset: string): Promise<readonly Change[]> => {
    const changes: Change[] = [];
    let cursor = cursor0;
    for (;;) {
      const page = await pullService.pull(
        { dataset, cursor, limit: 500 },
        {
          authenticatedUserId: actor.userId,
          authenticatedDeviceId: actor.deviceId,
          now: new Date(),
        },
      );
      changes.push(...page.changes);
      cursor = page.next_cursor;
      if (!page.has_more) return changes;
    }
  };
  const latest = (changes: readonly Change[], entityType: string, entityId: string) =>
    changes
      .filter((change) => change.entity_type === entityType && change.entity_id === entityId)
      .at(-1);
  const recordExpense = async (
    actor: Actor,
    occurredAt: string,
    amountXaf = 1_000,
    offline = false,
  ) => {
    const id = freshUuid();
    await send(
      actor,
      'finance.expense.record',
      'EXPENSE',
      id,
      occurredAt,
      {
        categoryId: category.CARBURANT,
        amountXaf,
        description: 'Essence',
        siteId: site,
        paidNow: true,
        paidFromAccountId: account,
      },
      offline,
    );
    return id;
  };
  /** Dernière modification d'une dépense reculée (la fenêtre lit aussi `updated_at`). */
  const touchedDaysAgo = (id: string, days: number) =>
    db
      .updateTable('finance_expenses')
      .set({ updated_at: new Date(Date.now() - days * 24 * 3_600_000) })
      .where('id', '=', toBin(id))
      .execute();

  beforeAll(async () => {
    const clock = new FixedClock(new Date());
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerExpenseCommands(registry, idGenerator, new DocumentSequenceService());
    registerExpenseCategoryCommands(registry);
    registerPolicyCommands(registry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    pullService = new SyncPullService(db);
    const root = await tx((trx) => insertTestUser(trx));
    const zoneId = await tx((trx) => insertTestZone(trx, root));
    site = await newPosSite(root, zoneId);
    terrain = await newActor('COMMERCIAL_TERRAIN', root, {
      scopeType: 'ZONE',
      scopeZoneId: zoneId,
    });
    other = await newActor('COMMERCIAL_TERRAIN', root, { scopeType: 'ZONE', scopeZoneId: zoneId });
    fin = await newActor('FINANCE', root);
    dir = await newActor('DIRECTION', root);
    account = await newAccount({
      type: 'CAISSE_UTILISATEUR',
      responsible: terrain.userId,
      holder: terrain.userId,
    });
    await fund(idGenerator, account, 100_000, recently(24 * 60 * 60), root);
    for (const row of await db
      .selectFrom('finance_expense_categories')
      .select(['id', 'code'])
      .execute()) {
      category[row.code] = fromBin(row.id);
    }
    const max = await db
      .selectFrom('sync_change_feed')
      .select(sql<string>`COALESCE(MAX(seq), 0)`.as('seq'))
      .executeTakeFirstOrThrow();
    cursor0 = Number(max.seq);
  });

  afterAll(closeTestDb);

  it('cash : la dépense est servie à son auteur seul, à sa dernière version', async () => {
    const id = await recordExpense(terrain, recently(60), 2_500);
    const mine = latest(await pull(terrain, 'cash'), 'EXPENSE', id);
    expect(mine?.change_type).toBe('UPSERT');
    expect(mine?.data).toMatchObject({
      id,
      site_id: site,
      category_id: category.CARBURANT,
      amount_xaf: 2_500,
      paid_now: true,
      paid_from_account_id: account,
      status: 'PAID',
      review_reasons: [],
      version: 1,
    });
    expect(latest(await pull(other, 'cash'), 'EXPENSE', id)?.data ?? null).toBeNull();
    expect(latest(await pull(fin, 'cash'), 'EXPENSE', id)?.data ?? null).toBeNull();
  });

  it('projection : ligne GLOBAL de repli jamais servie ; au-delà de 30 jours, plus servie', async () => {
    const project = resolveEntityProjection('EXPENSE')!;
    const id = await recordExpense(terrain, recently(30));
    expect(await project(db, id, { scopeType: 'USER', scopeId: terrain.userId })).toMatchObject({
      id,
    });
    expect(await project(db, id, { scopeType: 'GLOBAL', scopeId: null })).toBeUndefined();
    expect(await project(db, id, { scopeType: 'USER', scopeId: other.userId })).toBeUndefined();
    // Datée de 31 jours mais tout juste synchronisée : servie (modifiée dans la fenêtre) ; plus
    // modifiée depuis 31 jours : plus servie.
    const old = await recordExpense(terrain, recently(31 * 24 * 60));
    expect(await project(db, old, { scopeType: 'USER', scopeId: terrain.userId })).toMatchObject({
      id: old,
    });
    await touchedDaysAgo(old, 31);
    expect(await project(db, old, { scopeType: 'USER', scopeId: terrain.userId })).toBeUndefined();
  });

  it('au-delà de 30 jours, une dépense en attente de décision reste servie à son auteur (revue de P8-14)', async () => {
    const project = resolveEntityProjection('EXPENSE')!;
    // Politique EXPENSE du jour de la dépense (40 jours plus tôt), neutralisée ensuite.
    const day = recently(40 * 24 * 60).slice(0, 10);
    const policyId = freshUuid();
    await send(dir, 'approvals.policy.set', 'CONTROL_POLICY', policyId, `${day}T00:00:00.000Z`, {
      code: `EXP-SYNC-${policyId.slice(-12)}`,
      operationType: 'EXPENSE',
      requiresApproval: true,
      approverPermission: 'finance.expense.approve',
      approverScope: 'ALL',
      validFrom: `${day}T00:00:00.000Z`,
      validTo: `${day}T23:59:59.000Z`,
    });
    try {
      // Payée hors ligne au-delà du seuil du justificatif, sans photo : en validation a posteriori.
      const pending = await recordExpense(terrain, `${day}T12:00:00.000Z`, 15_000, true);
      const row = await db
        .selectFrom('finance_expenses')
        .select('status')
        .where('id', '=', toBin(pending))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('PAID_PENDING_APPROVAL');
      await touchedDaysAgo(pending, 40);
      expect(
        await project(db, pending, { scopeType: 'USER', scopeId: terrain.userId }),
      ).toMatchObject({ id: pending, status: 'PAID_PENDING_APPROVAL' });
    } finally {
      await neutralizePolicy(policyId);
    }
  });

  it('catalog : une catégorie créée est servie à tout appareil ; me : seuils des dépenses publiés', async () => {
    const id = freshUuid();
    await send(fin, 'finance.expense_category.create', 'EXPENSE_CATEGORY', id, recently(5), {
      code: `CAT_${id.replace(/-/g, '').slice(-10).toUpperCase()}`,
      label: 'Gardiennage',
      allowedOnPos: true,
    });
    expect(latest(await pull(terrain, 'catalog'), 'EXPENSE_CATEGORY', id)?.data).toMatchObject({
      id,
      label: 'Gardiennage',
      allowed_on_pos: true,
      is_system: false,
      is_active: true,
    });
    const published = await db
      .selectFrom('sync_change_feed as f')
      .innerJoin('organization_system_settings as s', 's.id', 'f.entity_id')
      .select('s.key as key')
      .where('f.dataset', '=', 'me')
      .where('f.entity_type', '=', 'SETTING')
      .where('s.key', 'in', [
        'finance.expense_approval_threshold_xaf',
        'finance.expense_photo_threshold_xaf',
        'finance.pos_expense_max_xaf',
      ])
      .execute();
    expect(new Set(published.map((row) => row.key)).size).toBe(3);
    const setting = await db
      .selectFrom('organization_system_settings')
      .select('id')
      .where('key', '=', 'finance.expense_photo_threshold_xaf')
      .executeTakeFirstOrThrow();
    expect(
      await resolveEntityProjection('SETTING')!(db, fromBin(setting.id), {
        scopeType: 'GLOBAL',
        scopeId: null,
      }),
    ).toMatchObject({
      key: 'finance.expense_photo_threshold_xaf',
    });
  });
});
