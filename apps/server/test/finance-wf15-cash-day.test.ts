/**
 * P5-15 — vecteur chiffré de WF-15 (docs/04-workflows/01-workflows.md), volet remise de fonds, de bout
 * en bout sur une journée de PDV, à travers le vrai pipeline et le protocole hors ligne :
 *
 * 1. fonds de 20 000 envoyé de la caisse centrale au PDV par une vraie remise (Finance), reçu par le
 *    vendeur avant l'ouverture (07:30) : écart d'ouverture nul (ADR-032 §4) ;
 * 2. ventes en espèces 175 500 + 4 500 = 180 000 (`sales.sale.record`) ; annulation directe de la
 *    seconde avec remboursement 4 500 (`sales.sale.cancel`, AT-009) ;
 * 3. petite dépense de 2 000 **injectée** (mouvement `EXPENSE` : les dépenses relèvent de P8) ;
 * 4. vraie session de caisse (P5-14) : ouverte par le vendeur à 08:00 (`finance.cash_session.open`),
 *    clôturée à 19:00 (`.close`) ; le serveur calcule l'attendu 20 000 + 180 000 − 4 500 − 2 000 =
 *    193 500 ; compté 193 000 → écart −500 (`SESSION_VARIANCE`), session `PENDING_VALIDATION` avec sa
 *    demande `CASH_VARIANCE`, validée par la Finance (`.validate`, P5-13) ;
 * 5. remise de 173 000 envoyée **hors ligne** après la clôture (19:30), reçue en ligne par la Finance
 *    (20:00) : PDV à 20 000 (fonds conservé), centrale à +173 000, rien en transit, aucun second
 *    mouvement, remise hors de la fenêtre close (l'attendu de [08:00, 19:00[ reste 193 500), audit de
 *    l'envoi et de la réception, registre et remises cohérents.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FixedClock,
  Uuidv7Generator,
  cashVarianceXaf,
  expectedCashXaf,
  openingVarianceXaf,
  type IdGenerator,
} from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerSaleCommands } from '../src/modules/sales/application/commands/sale-commands.js';
import { registerCancelCommands } from '../src/modules/sales/application/commands/cancel-commands.js';
import { registerCashTransferCommands } from '../src/modules/finance/application/commands/cash-transfer-commands.js';
import { registerCashSessionCommands } from '../src/modules/finance/application/commands/cash-session-commands.js';
import {
  cashTransfersInTransit,
  recordCashMovement,
  verifyCashLedger,
  verifyCashTransfers,
} from '../src/modules/finance/application/public/index.js';
import {
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestLocation,
  insertTestUser,
  insertTestZone,
} from './helpers.js';
import { OfflineDevice } from './device-harness.js';
import {
  auditOf,
  balanceOf,
  fund,
  movementsOf,
  newAccount,
  newActor,
  newPosSite,
  runCommand,
  transferRow,
  tx,
  type Actor,
} from './cash-transfer-fixtures.js';

const DAY = '2026-10-07';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
const OPENED_AT = at('08:00');
const CLOSED_AT = at('19:00');
const PRICE = 500;

describe(
  'P5-15 : WF-15 — journée de caisse d’un PDV et remise de fonds (vecteur chiffré)',
  { timeout: 120_000 },
  () => {
    let clock: FixedClock;
    let idGenerator: IdGenerator;
    let pipeline: CommandPipelineService;
    let services: { push: SyncPushService; pull: SyncPullService };
    let root: string;
    let seller: Actor;
    let fin1: Actor;
    let fin2: Actor;
    let counterId: string;
    let pos: string;
    let central: string;
    let productId: string;
    let ruleId: string;

    const ok = async (
      actor: Actor,
      type: string,
      aggregateType: string,
      aggregateId: string,
      occurredAt: string,
      payload: unknown,
    ) => {
      const result = await runCommand(pipeline, actor, {
        type,
        aggregateType,
        aggregateId,
        occurredAt,
        payload,
      });
      expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
      return result;
    };

    /** Mouvements du compte du PDV dont l'heure est dans la fenêtre [début, fin[ (ADR-032 §2). */
    async function windowMovements(fromIso: string, toIso: string) {
      const rows = await db
        .selectFrom('finance_cash_movements')
        .select(['direction', 'movement_type', 'amount_xaf'])
        .where('cash_account_id', '=', toBin(pos))
        .where('occurred_at', '>=', new Date(fromIso))
        .where('occurred_at', '<', new Date(toIso))
        .execute();
      return rows.map((row) => ({
        direction: row.direction as 'IN' | 'OUT',
        movementType: row.movement_type,
        amountXaf: Number(row.amount_xaf),
      }));
    }

    /** Solde du registre du PDV avant un instant (somme ordonnée par `occurred_at`, ADR-032 §4). */
    async function ledgerBalanceBefore(iso: string): Promise<number> {
      const rows = await db
        .selectFrom('finance_cash_movements')
        .select(['direction', 'amount_xaf'])
        .where('cash_account_id', '=', toBin(pos))
        .where('occurred_at', '<', new Date(iso))
        .execute();
      return rows.reduce(
        (sum, row) => sum + (row.direction === 'IN' ? 1 : -1) * Number(row.amount_xaf),
        0,
      );
    }

    const saleLine = (quantity: number) => ({
      productId,
      quantity,
      unitCode: 'PIECE',
      quantityBase: quantity,
      listUnitPriceXaf: PRICE,
      priceRuleId: ruleId,
      unitPriceXaf: PRICE,
    });

    beforeAll(async () => {
      clock = new FixedClock(new Date(at('21:00')));
      idGenerator = new Uuidv7Generator(clock);
      const registry = new CommandHandlerRegistry();
      const decisions = new ApprovalDecisionHandlerRegistry();
      const sequences = new DocumentSequenceService();
      registerRequestCommands(registry, decisions);
      registerSaleCommands(registry, idGenerator, sequences);
      registerCancelCommands(registry, decisions, idGenerator, sequences);
      registerCashTransferCommands(registry, decisions, idGenerator, sequences);
      registerCashSessionCommands(registry, idGenerator, decisions);
      pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
      services = { push: new SyncPushService(pipeline, db, clock), pull: new SyncPullService(db) };

      let zoneId = '';
      await tx(async (trx) => {
        root = await insertTestUser(trx);
        await insertTestDevice(trx, root, { status: 'ACTIVE' });
        zoneId = await insertTestZone(trx, root);
      });
      const siteId = await newPosSite(root, zoneId);
      seller = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteId });
      fin1 = await newActor('FINANCE', root);
      fin2 = await newActor('FINANCE', root);
      pos = await newAccount({ type: 'CAISSE_PDV', responsible: seller.userId, siteId });
      central = await newAccount({ type: 'CAISSE_CENTRALE', responsible: fin1.userId });

      await tx(async (trx) => {
        counterId = await insertTestLocation(trx, root, siteId, { locationType: 'POS' });
        if (
          !(await trx
            .selectFrom('catalog_units')
            .select('code')
            .where('code', '=', 'PIECE')
            .executeTakeFirst())
        ) {
          await trx
            .insertInto('catalog_units')
            .values({ code: 'PIECE', name: 'Pièce', is_count: 1 })
            .execute();
        }
        if (
          !(await trx
            .selectFrom('catalog_sales_channels')
            .select('code')
            .where('code', '=', 'POINT_DE_VENTE')
            .executeTakeFirst())
        ) {
          await trx
            .insertInto('catalog_sales_channels')
            .values({ code: 'POINT_DE_VENTE', name: 'Point de vente' })
            .execute();
        }
        const categoryId = freshUuid();
        await trx
          .insertInto('catalog_product_categories')
          .values({
            id: toBin(categoryId),
            code: `CAT-${categoryId.slice(-8)}`,
            name: 'Œufs',
            created_by: toBin(root),
          })
          .execute();
        productId = freshUuid();
        await trx
          .insertInto('catalog_products')
          .values({
            id: toBin(productId),
            code: `PRD-${productId.slice(-10)}`,
            name: 'Plateau d’œufs',
            category_id: toBin(categoryId),
            stock_family: 'MARCHANDISE',
            base_unit_code: 'PIECE',
            pricing_mode: 'PER_UNIT',
            is_sellable: 1,
            created_by: toBin(root),
          })
          .execute();
        ruleId = freshUuid();
        await trx
          .insertInto('pricing_price_rules')
          .values({
            id: toBin(ruleId),
            code: `PR-${ruleId.slice(-12)}`,
            version: 1,
            product_id: toBin(productId),
            unit_price_xaf: PRICE,
            pricing_unit_code: 'PIECE',
            status: 'ACTIVE',
            valid_from: new Date('2026-01-01T00:00:00.000Z'),
            approved_by: toBin(root),
            approved_at: new Date('2026-01-01T00:00:00.000Z'),
            created_by: toBin(root),
          })
          .execute();
        await recordStockMove(
          trx,
          { idGenerator },
          {
            productId,
            quantityBase: 400,
            fromLocationId: await virtualLocationId(trx, 'V_SUPPLIER'),
            toLocationId: counterId,
            moveType: 'PURCHASE_RECEIPT',
            declaredUnitCostXaf: 300,
            occurredAt: new Date(at('05:00')),
            sourceDocType: 'GOODS_RECEIPT',
            sourceDocId: freshUuid(),
            createdBy: root,
            allowNegative: false,
          },
        );
      });
      // Caisse centrale alimentée par la fixture (solde d'ouverture).
      await fund(idGenerator, central, 100_000, at('06:00'), root);
    });

    afterAll(async () => {
      await closeTestDb();
    });

    it('vecteur WF-15 : 193 500 attendus, −500 d’écart, remise de 173 000 hors ligne reçue par la Finance', async () => {
      // 1. Fonds de caisse : vraie remise centrale → PDV, reçue avant l'ouverture.
      const fundId = freshUuid();
      await ok(fin1, 'finance.cash_transfer.send', 'CASH_TRANSFER', fundId, at('06:30'), {
        fromAccountId: central,
        toAccountId: pos,
        amountXaf: 20_000,
        carrierUserId: seller.userId,
      });
      await ok(seller, 'finance.cash_transfer.receive', 'CASH_TRANSFER', fundId, at('07:30'), {
        receivedXaf: 20_000,
      });
      expect(await transferRow(fundId)).toMatchObject({ status: 'RECEIVED' });
      expect(openingVarianceXaf(20_000, await ledgerBalanceBefore(OPENED_AT))).toBe(0);
      const sessionId = freshUuid();
      await ok(seller, 'finance.cash_session.open', 'CASH_SESSION', sessionId, OPENED_AT, {
        cashAccountId: pos,
        countedXaf: 20_000,
      });

      // 2. Ventes en espèces 175 500 et 4 500 ; annulation directe de la seconde, remboursée.
      await ok(seller, 'sales.sale.record', 'SALE', freshUuid(), at('09:00'), {
        fromLocationId: counterId,
        lines: [saleLine(351)],
        payments: [{ methodCode: 'ESPECES', amountXaf: 175_500, cashAccountId: pos }],
      });
      const refundedSale = freshUuid();
      await ok(seller, 'sales.sale.record', 'SALE', refundedSale, at('11:00'), {
        fromLocationId: counterId,
        lines: [saleLine(9)],
        payments: [{ methodCode: 'ESPECES', amountXaf: 4_500, cashAccountId: pos }],
      });
      await ok(seller, 'sales.sale.cancel', 'SALE_CANCELLATION', freshUuid(), at('11:05'), {
        saleId: refundedSale,
        comment: 'Client mécontent',
        paymentTreatment: 'REFUND',
      });

      // 3. Petite dépense de 2 000 (sacs plastiques) — injectée : les dépenses relèvent de P8.
      await tx((trx) =>
        recordCashMovement(
          trx,
          { idGenerator },
          {
            cashAccountId: pos,
            direction: 'OUT',
            amountXaf: 2_000,
            movementType: 'EXPENSE',
            sourceDocType: 'EXPENSE',
            sourceDocId: freshUuid(),
            occurredAt: new Date(at('12:00')),
            createdBy: seller.userId,
            allowNegative: false,
          },
        ),
      );

      // 4. Clôture : le serveur calcule l'attendu sur le registre par fenêtre ; compté 193 000.
      const expected = expectedCashXaf(20_000, await windowMovements(OPENED_AT, CLOSED_AT));
      expect(expected).toBe(193_500);
      expect(cashVarianceXaf(193_000, expected)).toBe(-500);
      const closed = await ok(
        seller,
        'finance.cash_session.close',
        'CASH_SESSION',
        sessionId,
        CLOSED_AT,
        {
          countedXaf: 193_000,
        },
      );
      expect(closed.status === 'APPLIED' ? closed.server_refs : undefined).toMatchObject({
        closingExpectedXaf: '193500',
        varianceXaf: '-500',
        status: 'PENDING_VALIDATION',
      });
      expect(await balanceOf(pos)).toBe(193_000);
      // La Finance valide l'écart (P5-13), avec son motif.
      await ok(fin1, 'finance.cash_session.validate', 'CASH_SESSION', sessionId, at('19:15'), {
        reason: 'Manque de 500 : erreur de rendu de monnaie',
      });
      const session = await db
        .selectFrom('finance_cash_sessions')
        .select(['status', 'variance_xaf', 'closing_expected_xaf'])
        .where('id', '=', toBin(sessionId))
        .executeTakeFirstOrThrow();
      expect(session).toMatchObject({ status: 'VALIDATED' });
      expect(Number(session.variance_xaf)).toBe(-500);

      // 5. Remise de 173 000 envoyée hors ligne après la clôture, reçue en ligne par la Finance.
      const tablet = new OfflineDevice(services, seller.deviceId, clock);
      const remiseId = freshUuid();
      tablet.enqueue(seller.userId, {
        type: 'finance.cash_transfer.send',
        aggregateType: 'CASH_TRANSFER',
        aggregateId: remiseId,
        occurredAt: at('19:30'),
        payload: {
          fromAccountId: pos,
          toAccountId: central,
          amountXaf: 173_000,
          carrierName: 'Vendeur lui-même',
          comment: 'Recette du jour, fonds de 20 000 conservé',
        },
      });
      const [sent] = await tablet.sync(seller.userId);
      expect(sent?.status, JSON.stringify(sent)).toBe('APPLIED');
      await ok(fin2, 'finance.cash_transfer.receive', 'CASH_TRANSFER', remiseId, at('20:00'), {
        receivedXaf: 173_000,
      });

      // Résultats.
      expect(await transferRow(remiseId)).toMatchObject({
        status: 'RECEIVED',
        amount_sent_xaf: 173_000,
        amount_received_xaf: 173_000,
        discrepancy_xaf: 0,
        captured_offline: 1,
      });
      expect(await balanceOf(pos)).toBe(20_000);
      expect(await balanceOf(central)).toBe(100_000 - 20_000 + 173_000);
      expect(
        await cashTransfersInTransit(db, {
          now: new Date(at('21:00')),
          accountIds: [pos, central],
        }),
      ).toMatchObject({
        count: 0,
        totalXaf: 0,
      });
      // Aucun second mouvement : ni SESSION_VARIANCE ni autre écriture ne cite la remise.
      expect(
        (await movementsOf(remiseId))
          .map((m) => `${m.movementType}:${m.direction}:${m.amountXaf}`)
          .sort(),
      ).toEqual(['TRANSFER_IN:IN:173000', 'TRANSFER_OUT:OUT:173000']);
      // La remise est postérieure à la clôture : l'attendu de la fenêtre close est inchangé.
      expect(expectedCashXaf(20_000, await windowMovements(OPENED_AT, CLOSED_AT))).toBe(193_500);
      // Audit à chaque étape de la remise.
      expect((await auditOf(remiseId)).map((a) => a.action)).toEqual([
        'finance.cash_transfer.send',
        'finance.cash_transfer.receive',
      ]);
      expect((await auditOf(fundId)).map((a) => a.action)).toEqual([
        'finance.cash_transfer.send',
        'finance.cash_transfer.receive',
      ]);
      const [ledger, transfers] = await tx(async (trx) => [
        await verifyCashLedger(trx, { cashAccountIds: [pos, central] }),
        await verifyCashTransfers(trx, { transferIds: [fundId, remiseId] }),
      ]);
      expect(ledger.ok, JSON.stringify(ledger)).toBe(true);
      expect(transfers.ok, JSON.stringify(transfers)).toBe(true);
    });
  },
);
