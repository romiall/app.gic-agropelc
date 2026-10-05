/**
 * P4-03 — trésorerie (D09 §7.2 ; BR-FIN-010 à 012 ; INV-FIN-01, INV-FIN-02) : commandes de comptes
 * à travers le vrai pipeline, `recordCashMovement` (registre en ajout seul, inverse, caisse
 * physique jamais négative en ligne), solde projeté et réconciliation avec le registre.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import type { Transaction } from 'kysely';
import type { DB } from '../src/platform/kysely/database.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerAccountCommands } from '../src/modules/finance/application/commands/account-commands.js';
import {
  CashMovementError,
  cashAccountBalance,
  findCashAccount,
  rebuildCashBalances,
  recordCashMovement,
  verifyCashLedger,
  type RecordCashMovementInput,
} from '../src/modules/finance/application/public/index.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const OCCURRED_AT = '2026-10-09T09:00:00.000Z';

describe('P4-03 : trésorerie (comptes, mouvements, solde, réconciliation)', () => {
  let pipeline: CommandPipelineService;
  let clock: Clock;
  let idGenerator: IdGenerator;
  let admin: string;
  let adminDevice: string;
  let outsider: string;
  let outsiderDevice: string;
  let siteId: string;

  const tx = <T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> =>
    db.transaction().execute(fn);

  const envelope = (author: string, type: string, aggregateId: string, payload: unknown) => ({
    command_id: freshUuid(),
    device_seq: 1,
    command_version: 1,
    author_user_id: author,
    base_version: null,
    depends_on: [],
    client_created_at: OCCURRED_AT,
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    command_type: type,
    aggregate_type: 'CASH_ACCOUNT',
    aggregate_id: aggregateId,
    occurred_at: OCCURRED_AT,
    payload,
  });

  const run = (
    author: string,
    device: string,
    type: string,
    aggregateId: string,
    payload: unknown,
  ) =>
    pipeline.handle(envelope(author, type, aggregateId, payload), {
      authenticatedUserId: author,
      authenticatedDeviceId: device,
      transport: 'ONLINE_API' as const,
    });

  const adminRun = (type: string, aggregateId: string, payload: unknown) =>
    run(admin, adminDevice, type, aggregateId, payload);

  const codeOf = (result: Awaited<ReturnType<typeof adminRun>>) =>
    result.status === 'REJECTED' ? result.error.code : result.status;

  async function createAccount(
    accountType: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const id = freshUuid();
    const result = await adminRun('finance.cash_account.create', id, {
      code: `CPT-${id.slice(-10)}`,
      name: 'Compte de test',
      accountType,
      responsibleUserId: admin,
      ...extra,
    });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    return id;
  }

  const movement = (
    cashAccountId: string,
    overrides: Partial<RecordCashMovementInput> = {},
  ): Promise<ReturnType<typeof recordCashMovement> extends Promise<infer R> ? R : never> =>
    tx((trx) =>
      recordCashMovement(
        trx,
        { idGenerator },
        {
          cashAccountId,
          direction: 'IN',
          amountXaf: 5000,
          movementType: 'CUSTOMER_PAYMENT',
          sourceDocType: 'CUSTOMER_PAYMENT',
          sourceDocId: freshUuid(),
          occurredAt: new Date(OCCURRED_AT),
          createdBy: admin,
          allowNegative: false,
          ...overrides,
        },
      ),
    );

  async function rejection(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof CashMovementError) return error.code;
      throw error;
    }
    throw new Error('rejet attendu');
  }

  beforeAll(async () => {
    clock = new FixedClock(new Date('2026-10-09T12:00:00.000Z'));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerAccountCommands(registry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    admin = await tx((trx) => insertTestUser(trx));
    adminDevice = await tx((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));
    outsider = await tx((trx) => insertTestUser(trx));
    outsiderDevice = await tx((trx) => insertTestDevice(trx, outsider, { status: 'ACTIVE' }));
    await tx(async (trx) => {
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, 'finance.cash_account.manage', admin);
      await assignTestRole(trx, admin, role, admin);
      siteId = await insertTestSite(trx, admin, await insertTestZone(trx, admin));
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------------------------

  it('commandes de comptes : création, une caisse de PDV et une caisse d’utilisateur actives, désactivation à solde nul', async () => {
    const pos = await createAccount('CAISSE_PDV', { siteId });
    expect(await findCashAccount(db, pos)).toMatchObject({
      accountType: 'CAISSE_PDV',
      siteId,
      balanceXaf: 0,
      status: 'ACTIVE',
    });
    // Rejeu idempotent de la même création.
    const replayId = freshUuid();
    const payload = {
      code: `CPT-${replayId.slice(-10)}`,
      name: 'X',
      accountType: 'BANQUE',
      responsibleUserId: admin,
    };
    expect(codeOf(await adminRun('finance.cash_account.create', replayId, payload))).toBe(
      'APPLIED',
    );
    expect(codeOf(await adminRun('finance.cash_account.create', replayId, payload))).toBe(
      'APPLIED',
    );

    // BR-FIN-010 : une caisse de PDV active par site, une caisse d'utilisateur active par détenteur.
    const duplicatePos = await adminRun('finance.cash_account.create', freshUuid(), {
      code: `CPT-${freshUuid().slice(-10)}`,
      name: 'Seconde caisse',
      accountType: 'CAISSE_PDV',
      siteId,
      responsibleUserId: admin,
    });
    expect(codeOf(duplicatePos)).toBe('CASH_ACCOUNT_DUPLICATE');
    const holder = await tx((trx) => insertTestUser(trx));
    await createAccount('CAISSE_UTILISATEUR', { holderUserId: holder });
    const duplicateUser = await adminRun('finance.cash_account.create', freshUuid(), {
      code: `CPT-${freshUuid().slice(-10)}`,
      name: 'Seconde caisse',
      accountType: 'CAISSE_UTILISATEUR',
      holderUserId: holder,
      responsibleUserId: admin,
    });
    expect(codeOf(duplicateUser)).toBe('CASH_ACCOUNT_DUPLICATE');

    // Un type qui exige son site ou son détenteur, un responsable inactif ou un code déjà pris.
    expect(
      codeOf(
        await adminRun('finance.cash_account.create', freshUuid(), {
          code: `CPT-${freshUuid().slice(-10)}`,
          name: 'Sans site',
          accountType: 'CAISSE_PDV',
          responsibleUserId: admin,
        }),
      ),
    ).not.toBe('APPLIED');
    expect(
      codeOf(
        await adminRun('finance.cash_account.create', freshUuid(), {
          code: `CPT-${replayId.slice(-10)}`,
          name: 'Code pris',
          accountType: 'BANQUE',
          responsibleUserId: admin,
        }),
      ),
    ).toBe('CASH_ACCOUNT_DUPLICATE');

    // Droit exigé : sans `finance.cash_account.manage`, rien n'est créé.
    const denied = await run(outsider, outsiderDevice, 'finance.cash_account.create', freshUuid(), {
      code: `CPT-${freshUuid().slice(-10)}`,
      name: 'Interdit',
      accountType: 'BANQUE',
      responsibleUserId: admin,
    });
    expect(denied.status).not.toBe('APPLIED');

    // Modification, puis désactivation : refusée tant que le solde n'est pas nul.
    expect(
      codeOf(await adminRun('finance.cash_account.update', pos, { name: 'Caisse du PDV' })),
    ).toBe('APPLIED');
    expect((await findCashAccount(db, pos))?.name).toBe('Caisse du PDV');
    await movement(pos);
    expect(codeOf(await adminRun('finance.cash_account.deactivate', pos, {}))).toBe(
      'CASH_ACCOUNT_NOT_EMPTY',
    );
    await movement(pos, {
      direction: 'OUT',
      movementType: 'EXPENSE',
      sourceDocType: 'EXPENSE',
    });
    expect(codeOf(await adminRun('finance.cash_account.deactivate', pos, {}))).toBe('APPLIED');
    expect(codeOf(await adminRun('finance.cash_account.deactivate', pos, {}))).toBe('APPLIED');
    expect((await findCashAccount(db, pos))?.status).toBe('INACTIVE');
  });

  it('mouvements : le solde projeté suit le registre ; sens et document source cohérents avec le type', async () => {
    const account = await createAccount('CAISSE_CENTRALE');
    const first = await movement(account, { amountXaf: 5000 });
    expect(first).toMatchObject({ balanceAfterXaf: 5000, negativeBalance: false });
    const second = await movement(account, {
      direction: 'OUT',
      amountXaf: 2000,
      movementType: 'REFUND',
      sourceDocType: 'SALE_REFUND',
    });
    expect(second.balanceAfterXaf).toBe(3000);
    expect(await cashAccountBalance(db, account)).toBe(3000);

    // Un encaissement est une entrée ; un remboursement cite un remboursement ; montant entier > 0.
    expect(await rejection(movement(account, { direction: 'OUT', amountXaf: 1 }))).toBe(
      'CASH_MOVEMENT_INVALID',
    );
    expect(await rejection(movement(account, { sourceDocType: 'EXPENSE' }))).toBe(
      'CASH_MOVEMENT_INVALID',
    );
    expect(await rejection(movement(account, { amountXaf: 0 }))).toBe('CASH_AMOUNT_INVALID');
    expect(await rejection(movement(account, { amountXaf: 10.5 }))).toBe('CASH_AMOUNT_INVALID');
    expect(await rejection(movement(freshUuid()))).toBe('CASH_ACCOUNT_INVALID');
    expect(await cashAccountBalance(db, account)).toBe(3000);

    // Registre en ajout seul : ni modification ni suppression (déclencheurs, INV-FIN-01).
    await expect(
      db
        .updateTable('finance_cash_movements')
        .set({ amount_xaf: 1 })
        .where('id', '=', toBin(first.movementId))
        .execute(),
    ).rejects.toThrow();
    await expect(
      db.deleteFrom('finance_cash_movements').where('id', '=', toBin(first.movementId)).execute(),
    ).rejects.toThrow();
  });

  it('BR-FIN-012 : une caisse physique ne devient pas négative en ligne ; hors ligne, la sortie est appliquée et signalée', async () => {
    const cashbox = await createAccount('CAISSE_CENTRALE');
    await movement(cashbox, { amountXaf: 1000 });
    const outgoing = (overrides: Partial<RecordCashMovementInput>) =>
      movement(cashbox, {
        direction: 'OUT',
        movementType: 'EXPENSE',
        sourceDocType: 'EXPENSE',
        ...overrides,
      });
    expect(await rejection(outgoing({ amountXaf: 1500 }))).toBe('CASH_INSUFFICIENT');
    expect(await cashAccountBalance(db, cashbox)).toBe(1000);

    const offline = await outgoing({ amountXaf: 1500, allowNegative: true, capturedOffline: true });
    expect(offline).toMatchObject({ balanceAfterXaf: -500, negativeBalance: true });
    expect(await cashAccountBalance(db, cashbox)).toBe(-500);

    // Un compte mobile money ou bancaire n'est pas une caisse physique.
    const mobile = await createAccount('MOBILE_MONEY');
    const out = await movement(mobile, {
      direction: 'OUT',
      amountXaf: 300,
      movementType: 'SUPPLIER_PAYMENT',
      sourceDocType: 'SUPPLIER_PAYMENT',
    });
    expect(out).toMatchObject({ balanceAfterXaf: -300, negativeBalance: false });
  });

  it('inverse (BR-FIN-011) : sens opposé, même compte, montant, type et document ; une seule fois', async () => {
    const account = await createAccount('BANQUE');
    const sourceDocId = freshUuid();
    const payment = await movement(account, { amountXaf: 7000, sourceDocId });
    const reverse = (overrides: Partial<RecordCashMovementInput> = {}) =>
      movement(account, {
        direction: 'OUT',
        amountXaf: 7000,
        sourceDocId,
        reversesMovementId: payment.movementId,
        ...overrides,
      });

    expect(await rejection(reverse({ amountXaf: 6000 }))).toBe('CASH_REVERSAL_INVALID');
    expect(await rejection(reverse({ direction: 'IN' }))).toBe('CASH_REVERSAL_INVALID');
    expect(await rejection(reverse({ sourceDocId: freshUuid() }))).toBe('CASH_REVERSAL_INVALID');
    expect(await rejection(reverse({ reversesMovementId: freshUuid() }))).toBe(
      'CASH_REVERSAL_INVALID',
    );

    const reversed = await reverse();
    expect(reversed.balanceAfterXaf).toBe(0);
    const row = await db
      .selectFrom('finance_cash_movements')
      .select(['is_reversal', 'direction', 'movement_type'])
      .where('id', '=', toBin(reversed.movementId))
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ is_reversal: 1, direction: 'OUT', movement_type: 'CUSTOMER_PAYMENT' });
    // Une seule fois, et un inverse ne s'inverse pas.
    expect(await rejection(reverse())).toBe('CASH_REVERSAL_INVALID');
    expect(
      await rejection(
        movement(account, {
          amountXaf: 7000,
          sourceDocId,
          reversesMovementId: reversed.movementId,
        }),
      ),
    ).toBe('CASH_REVERSAL_INVALID');
  });

  it('compte désactivé : refusé en ligne, appliqué hors ligne (fait accompli)', async () => {
    const account = await createAccount('BANQUE');
    expect(codeOf(await adminRun('finance.cash_account.deactivate', account, {}))).toBe('APPLIED');
    expect(await rejection(movement(account))).toBe('CASH_ACCOUNT_INACTIVE');
    const offline = await movement(account, { capturedOffline: true });
    expect(offline.balanceAfterXaf).toBe(5000);
  });

  it('INV-FIN-02 : la réconciliation relève un écart de projection et la reconstruction le corrige', async () => {
    const account = await createAccount('BANQUE');
    await movement(account, { amountXaf: 4000 });
    await movement(account, {
      direction: 'OUT',
      amountXaf: 1500,
      movementType: 'SUPPLIER_PAYMENT',
      sourceDocType: 'SUPPLIER_PAYMENT',
    });
    expect(await tx((trx) => verifyCashLedger(trx, { cashAccountIds: [account] }))).toEqual({
      ok: true,
      accountsChecked: 1,
      mismatches: [],
    });

    // Solde modifié sans mouvement (caisse « corrigée » à la main) : écart détecté.
    await db
      .updateTable('finance_cash_accounts')
      .set({ balance_xaf: 9999 })
      .where('id', '=', toBin(account))
      .execute();
    const broken = await tx((trx) => verifyCashLedger(trx, { cashAccountIds: [account] }));
    expect(broken.ok).toBe(false);
    expect(broken.mismatches).toEqual([
      { cashAccountId: account, projectedXaf: 9999, ledgerXaf: 2500 },
    ]);

    expect(await tx((trx) => rebuildCashBalances(trx, { cashAccountIds: [account] }))).toBe(1);
    expect(await cashAccountBalance(db, account)).toBe(2500);
    expect((await tx((trx) => verifyCashLedger(trx, { cashAccountIds: [account] }))).ok).toBe(true);
  });

  it('concurrence : dix encaissements simultanés sur un même compte — le solde est exact', async () => {
    const account = await createAccount('MOBILE_MONEY');
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        movement(account, { amountXaf: 100 + index, sourceDocId: freshUuid() }),
      ),
    );
    const expected = Array.from({ length: 10 }, (_, index) => 100 + index).reduce((a, b) => a + b);
    expect(await cashAccountBalance(db, account)).toBe(expected);
    expect((await tx((trx) => verifyCashLedger(trx, { cashAccountIds: [account] }))).ok).toBe(true);
  });
});
