/**
 * P8-04 : catégories de dépense (AV-058, AV-270 ; ADR-042 §9) — création, modification,
 * désactivation et réactivation par la Finance ou l'Administrateur (`finance.expense_category.manage`),
 * en ligne seulement ; code unique ; catégorie système intouchable ; publication dans le jeu `catalog`
 * (ligne `GLOBAL`, version de la ligne) et projection `EXPENSE_CATEGORY`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerExpenseCategoryCommands } from '../src/modules/finance/application/commands/expense-category-commands.js';
import { resolveEntityProjection } from '../src/sync/entity-projections.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { closeTestDb, db, freshUuid, insertTestUser } from './helpers.js';
import { codeOf, newActor, runCommand, tx, type Actor } from './cash-transfer-fixtures.js';

const AT = '2026-11-02T09:00:00.000Z';
const code = () => `CAT_${freshUuid().replace(/-/g, '').slice(-10).toUpperCase()}`;

describe('P8-04 : catégories de dépense', () => {
  let pipeline: CommandPipelineService;
  let finance: Actor;
  let admin: Actor;
  let seller: Actor;

  const run = (
    actor: Actor,
    type: string,
    aggregateId: string,
    payload: unknown,
    offline = false,
  ) =>
    runCommand(pipeline, actor, {
      type: `finance.expense_category.${type}`,
      aggregateType: 'EXPENSE_CATEGORY',
      aggregateId,
      occurredAt: AT,
      payload,
      offline,
    });

  const row = (id: string) =>
    db
      .selectFrom('finance_expense_categories')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirst();

  const feedOf = (id: string) =>
    db
      .selectFrom('sync_change_feed')
      .select(['dataset', 'scope_type', 'row_version', 'change_type'])
      .where('entity_type', '=', 'EXPENSE_CATEGORY')
      // Le repli générique du pipeline écrit aussi une ligne au jeu `expense_category` (agrégat).
      .where('dataset', '=', 'catalog')
      .where('entity_id', '=', toBin(id))
      .orderBy('seq')
      .execute();

  beforeAll(async () => {
    const clock = new FixedClock(new Date('2026-11-02T10:00:00.000Z'));
    const registry = new CommandHandlerRegistry();
    registerExpenseCategoryCommands(registry);
    pipeline = new CommandPipelineService(db, registry, clock, new Uuidv7Generator(clock));
    const root = await tx((trx) => insertTestUser(trx));
    finance = await newActor('FINANCE', root);
    admin = await newActor('ADMIN', root);
    seller = await newActor('RESP_ACHATS', root);
  });

  afterAll(closeTestDb);

  it('création : publiée dans `catalog` (GLOBAL, version 1), rejeu sans effet, code unique', async () => {
    const id = freshUuid();
    const categoryCode = code();
    const payload = {
      code: categoryCode,
      label: 'Gardiennage',
      defaultCostType: 'DEPENSE_DIRECTE',
      allowedOnPos: true,
    };
    expect(codeOf(await run(finance, 'create', id, payload))).toBe('APPLIED');
    expect(await row(id)).toMatchObject({
      code: categoryCode,
      label: 'Gardiennage',
      default_cost_type: 'DEPENSE_DIRECTE',
      allowed_on_pos: 1,
      is_system: 0,
      is_active: 1,
      version: 1,
    });
    expect(await feedOf(id)).toEqual([
      { dataset: 'catalog', scope_type: 'GLOBAL', row_version: 1, change_type: 'UPSERT' },
    ]);
    // Rejeu par un autre `command_id` sur le même agrégat : sans effet.
    expect(codeOf(await run(admin, 'create', id, payload))).toBe('APPLIED');
    expect(await feedOf(id)).toHaveLength(1);
    // Même code, autre catégorie : refus.
    expect(codeOf(await run(admin, 'create', freshUuid(), payload))).toBe(
      'EXPENSE_CATEGORY_DUPLICATE',
    );
  });

  it('droits et canal : Resp. achats refusé, hors ligne refusé, code mal formé refusé', async () => {
    const payload = { code: code(), label: 'x' };
    expect(codeOf(await run(seller, 'create', freshUuid(), payload))).toBe('FORBIDDEN');
    expect(codeOf(await run(finance, 'create', freshUuid(), payload, true))).toBe(
      'ONLINE_REQUIRED',
    );
    expect(
      codeOf(await run(finance, 'create', freshUuid(), { code: 'minuscules', label: 'x' })),
    ).toMatch(/^VALIDATION_ERROR/);
  });

  it('modification et désactivation : version incrémentée et republiée ; état déjà atteint sans effet', async () => {
    const id = freshUuid();
    await run(finance, 'create', id, { code: code(), label: 'Gardiennage' });
    expect(
      codeOf(await run(admin, 'update', id, { label: 'Gardiennage de nuit', allowedOnPos: true })),
    ).toBe('APPLIED');
    expect(await row(id)).toMatchObject({
      label: 'Gardiennage de nuit',
      allowed_on_pos: 1,
      version: 2,
    });
    expect(codeOf(await run(finance, 'deactivate', id, { reason: 'Regroupée dans DIVERS' }))).toBe(
      'APPLIED',
    );
    expect(await row(id)).toMatchObject({
      is_active: 0,
      status_reason: 'Regroupée dans DIVERS',
      version: 3,
    });
    expect(codeOf(await run(finance, 'deactivate', id, { reason: 'Encore' }))).toBe('APPLIED');
    expect((await row(id))?.version).toBe(3);
    expect(codeOf(await run(finance, 'reactivate', id, { reason: 'Reprise' }))).toBe('APPLIED');
    expect(await row(id)).toMatchObject({ is_active: 1, status_reason: 'Reprise', version: 4 });
    expect((await feedOf(id)).map((line) => line.row_version)).toEqual([1, 2, 3, 4]);
    expect(codeOf(await run(finance, 'update', freshUuid(), { label: 'x' }))).toBe('NOT_FOUND');
  });

  it('catégorie système NON_JUSTIFIEE : ni modifiée ni désactivée (BR-FIN-022)', async () => {
    const system = await db
      .selectFrom('finance_expense_categories')
      .select('id')
      .where('code', '=', 'NON_JUSTIFIEE')
      .executeTakeFirstOrThrow();
    const id = fromBin(system.id);
    expect(codeOf(await run(finance, 'update', id, { label: 'Autre' }))).toBe(
      'EXPENSE_CATEGORY_SYSTEM',
    );
    expect(codeOf(await run(admin, 'deactivate', id, { reason: 'x' }))).toBe(
      'EXPENSE_CATEGORY_SYSTEM',
    );
  });

  it('projection `EXPENSE_CATEGORY` : servie sur la ligne GLOBAL, jamais ailleurs', async () => {
    const id = freshUuid();
    const categoryCode = code();
    await run(finance, 'create', id, {
      code: categoryCode,
      label: 'Pesage',
      defaultCostType: 'AUTRE_INTRANT',
    });
    const project = resolveEntityProjection('EXPENSE_CATEGORY')!;
    expect(await project(db, id, { scopeType: 'GLOBAL', scopeId: null })).toEqual({
      id,
      code: categoryCode,
      label: 'Pesage',
      default_cost_type: 'AUTRE_INTRANT',
      allowed_on_pos: false,
      is_system: false,
      is_active: true,
      version: 1,
    });
    expect(await project(db, id, { scopeType: 'SITE', scopeId: freshUuid() })).toBeUndefined();
    expect(await project(db, freshUuid(), { scopeType: 'GLOBAL', scopeId: null })).toBeUndefined();
  });
});
