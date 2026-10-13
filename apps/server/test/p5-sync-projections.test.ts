/**
 * P5-18 — jeux hors ligne de P5, par le pull réel (`SyncPullService`) sur des données écrites par les
 * vraies commandes (registre complet de l'application, rôles réels du seed) :
 * - `allocations` : quota servi au seul appareil détenteur, détenteur projeté (AV-194), jamais par le
 *   repli `GLOBAL` ; quarante consommations = une ligne (dédoublonnage par page), taille mesurée
 *   < 10 Ko (RISK-23) ; sortie (`SCOPE_EXIT`) à la révocation et à la libération (AV-193) ;
 * - `cash` : session du PDV ouverte, puis à valider avec l'attendu et l'écart du serveur, sortie à la
 *   validation, republiée avec l'écart courant après une réévaluation ; remises envoyées aux deux
 *   comptes, sortie à la réception et à l'annulation, suivies au nouveau responsable d'un compte ;
 *   destinations de remise sans solde (AV-197) ;
 * - `org` : configuration du PDV au site, changement d'appareil désigné par mise à jour (AV-195),
 *   emplacement de vente republié (jeu `location`) ;
 * - référentiels (AV-196) : unités et canaux sous la clé dérivée de leur code (ADR-031), désactivation
 *   par le code de la charge utile, motifs, étapes, paramètres visibles (`me`, version remplacée
 *   retirée), politiques (`policies`, version retirée supprimée).
 * Chaque assertion porte sur les identifiants du fichier (base partagée) ; le curseur de départ est le
 * dernier numéro du flux avant le fichier.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { IdGenerator } from '@gic/domain';
import type { Change, CommandResult } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { codeEntityId } from '../src/platform/sync/code-entity-id.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { recordStockMove } from '../src/modules/inventory/application/public/index.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestLocation,
  insertTestProduct,
  insertTestSite,
  insertTestUser,
  insertTestZone,
  neutralizePolicy,
} from './helpers.js';
import { fund, newActor, tx, type Actor } from './cash-transfer-fixtures.js';

const DAY = '2026-10-10';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
let deviceSeq = 0;

describe('P5-18 : jeux hors ligne de P5', { timeout: 180_000 }, () => {
  let app: NestFastifyApplication;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let pullService: SyncPullService;
  let cursor0 = 0;
  let root: string;
  let admin: Actor;
  let fin: Actor;
  let venA: Actor;
  let venB: Actor;
  let venC: Actor;
  let venD: Actor;
  let magA: Actor;
  /** Second profil Finance, nouveau responsable de la caisse centrale. */
  let fin2: Actor;
  /** Second appareil du vendeur A (même utilisateur). */
  let venAOther: Actor;
  /** Second appareil du vendeur C, désigné ensuite pour le PDV C. */
  let venCNext: Actor;
  let siteA: string;
  let siteB: string;
  let siteC: string;
  let siteD: string;
  let counterA: string;
  let counterC: string;
  let products: string[];
  let customerLocation: string;
  let posA: string;
  let central: string;
  let personal: string;
  let bank: string;
  let posD: string;
  const policyIds: string[] = [];

  const send = (
    actor: Actor,
    command: {
      readonly type: string;
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly occurredAt: string;
      readonly payload: unknown;
      readonly offline?: boolean;
    },
  ): Promise<CommandResult> =>
    pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: command.type,
        aggregate_type: command.aggregateType,
        aggregate_id: command.aggregateId,
        author_user_id: actor.userId,
        base_version: null,
        depends_on: [],
        occurred_at: command.occurredAt,
        client_created_at: command.occurredAt,
        captured_offline: command.offline ?? false,
        backdated_reason: null,
        attachment_ids: [],
        payload: command.payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: command.offline ? 'SYNC_PUSH' : 'ONLINE_API',
      },
    );
  const ok = async (...args: Parameters<typeof send>) => {
    const result = await send(...args);
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
    return result;
  };

  async function pullPage(actor: Actor, dataset: string, cursor = cursor0, limit = 500) {
    return pullService.pull(
      { dataset, cursor, limit },
      { authenticatedUserId: actor.userId, authenticatedDeviceId: actor.deviceId, now: new Date() },
    );
  }
  const pull = async (actor: Actor, dataset: string): Promise<readonly Change[]> => {
    const changes: Change[] = [];
    let cursor = cursor0;
    for (;;) {
      const page = await pullPage(actor, dataset, cursor);
      changes.push(...page.changes);
      cursor = page.next_cursor;
      if (!page.has_more) return changes;
    }
  };
  /** Dernier changement reçu pour une entité (l'appareil applique dans l'ordre). */
  const latest = (changes: readonly Change[], entityType: string, entityId: string) =>
    changes.filter((c) => c.entity_type === entityType && c.entity_id === entityId).at(-1);
  /** L'appareil (PWA, harnais) : un retrait efface la clé quelle que soit la portée de la ligne. */
  const applyLocally = (changes: readonly Change[]) => {
    const local = new Map<string, unknown>();
    for (const change of changes) {
      const key = `${change.entity_type}:${change.entity_id}`;
      if (change.change_type !== 'UPSERT') local.delete(key);
      else if (change.data) local.set(key, change.data);
    }
    return local;
  };
  const servedIds = (changes: readonly Change[], entityType: string) =>
    new Set(changes.filter((c) => c.entity_type === entityType && c.data).map((c) => c.entity_id));
  const feedLines = (entityType: string, entityId: string) =>
    db
      .selectFrom('sync_change_feed')
      .select(['dataset', 'change_type', 'scope_type'])
      .where('entity_type', '=', entityType)
      .where('entity_id', '=', toBin(entityId))
      .where('seq', '>', cursor0)
      .execute();
  const maxSeq = async () =>
    Number(
      (
        await db
          .selectFrom('sync_change_feed')
          .select((eb) => eb.fn.max('seq').as('seq'))
          .executeTakeFirst()
      )?.seq ?? 0,
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    idGenerator = app.get(ID_GENERATOR);
    pipeline = app.get(CommandPipelineService);
    pullService = new SyncPullService(db);
    cursor0 = await maxSeq();

    root = await tx((trx) => insertTestUser(trx));
    await tx(async (trx) => {
      const zoneId = await insertTestZone(trx, root);
      siteA = await insertTestSite(trx, root, zoneId, { siteType: 'POINT_DE_VENTE' });
      siteB = await insertTestSite(trx, root, zoneId, { siteType: 'POINT_DE_VENTE' });
      siteC = await insertTestSite(trx, root, zoneId, { siteType: 'POINT_DE_VENTE' });
      siteD = await insertTestSite(trx, root, zoneId, { siteType: 'POINT_DE_VENTE' });
      counterA = await insertTestLocation(trx, root, siteA, { locationType: 'POS' });
      counterC = await insertTestLocation(trx, root, siteC, { locationType: 'POS' });
      products = [
        await insertTestProduct(trx, root),
        await insertTestProduct(trx, root),
        await insertTestProduct(trx, root),
      ];
    });
    admin = await newActor('ADMIN', root);
    fin = await newActor('FINANCE', root);
    fin2 = await newActor('FINANCE', root);
    venA = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteA });
    venB = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteB });
    venC = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteC });
    venD = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteD });
    magA = await newActor('MAGASINIER', root, { scopeType: 'SITE', scopeSiteId: siteA });
    venAOther = {
      userId: venA.userId,
      deviceId: await tx((trx) => insertTestDevice(trx, venA.userId, { status: 'ACTIVE' })),
    };
    venCNext = {
      userId: venC.userId,
      deviceId: await tx((trx) => insertTestDevice(trx, venC.userId, { status: 'ACTIVE' })),
    };
    const virtual = async (type: string) =>
      fromBin(
        (
          await db
            .selectFrom('organization_locations')
            .select('id')
            .where('location_type', '=', type)
            .executeTakeFirstOrThrow()
        ).id,
      );
    customerLocation = await virtual('V_CUSTOMER');
    const opening = await virtual('V_OPENING');
    for (const productId of products) {
      await tx((trx) =>
        recordStockMove(
          trx,
          { idGenerator },
          {
            productId,
            quantityBase: 100,
            fromLocationId: opening,
            toLocationId: counterA,
            moveType: 'OPENING_BALANCE',
            declaredUnitCostXaf: 300,
            occurredAt: new Date(at('05:00')),
            sourceDocType: 'INVENTORY_COUNT',
            sourceDocId: freshUuid(),
            createdBy: root,
            allowNegative: false,
          },
        ),
      );
    }

    // Comptes par la vraie commande d'administration (Finance, `finance.cash_account.manage`) : caisse du PDV A, caisse centrale, caisse
    // personnelle du vendeur A (jamais destination).
    const account = async (payload: Record<string, unknown>) => {
      const id = freshUuid();
      await ok(fin, {
        type: 'finance.cash_account.create',
        aggregateType: 'CASH_ACCOUNT',
        aggregateId: id,
        occurredAt: at('05:10'),
        payload: { code: `P518-${id.slice(-12)}`, name: 'Compte P5-18', ...payload },
      });
      return id;
    };
    posA = await account({
      accountType: 'CAISSE_PDV',
      siteId: siteA,
      responsibleUserId: venA.userId,
    });
    central = await account({ accountType: 'CAISSE_CENTRALE', responsibleUserId: fin.userId });
    personal = await account({
      accountType: 'CAISSE_UTILISATEUR',
      holderUserId: venA.userId,
      responsibleUserId: venA.userId,
    });
    bank = await account({ accountType: 'BANQUE', responsibleUserId: root });
    posD = await account({
      accountType: 'CAISSE_PDV',
      siteId: siteD,
      responsibleUserId: venD.userId,
    });
    await fund(idGenerator, posA, 20_000, at('06:00'), root);
    await fund(idGenerator, central, 50_000, at('06:00'), root);
  }, 180_000);

  afterAll(async () => {
    for (const id of policyIds) await neutralizePolicy(id);
    await app.close();
    await closeTestDb();
  });

  describe('jeu allocations (quotas d’appareil)', () => {
    const quotas: string[] = [];

    beforeAll(async () => {
      for (const [index, productId] of products.entries()) {
        const id = freshUuid();
        quotas.push(id);
        await ok(magA, {
          type: 'inventory.allocation.grant',
          aggregateType: 'STOCK_ALLOCATION',
          aggregateId: id,
          occurredAt: at(`09:0${index}`),
          payload: {
            holderUserId: venA.userId,
            holderDeviceId: venA.deviceId,
            locationId: counterA,
            productId,
            quantityBase: 50,
          },
        });
      }
      // Une journée de vente : quarante sorties d'une pièce sur le premier quota.
      for (let i = 0; i < 40; i++) {
        await tx((trx) =>
          recordStockMove(
            trx,
            { idGenerator },
            {
              productId: products[0]!,
              quantityBase: 1,
              fromLocationId: counterA,
              toLocationId: customerLocation,
              moveType: 'SALE',
              occurredAt: new Date(at(`10:${String(i).padStart(2, '0')}`)),
              sourceDocType: 'SALE',
              sourceDocId: freshUuid(),
              createdBy: venA.userId,
              createdDeviceId: venA.deviceId,
              consumesAllocation: true,
              allowNegative: false,
            },
          ),
        );
      }
    }, 120_000);

    it('sert le quota actif au seul appareil détenteur, en une ligne malgré quarante consommations', async () => {
      const lines = await feedLines('STOCK_ALLOCATION', quotas[0]!);
      expect(lines.filter((l) => l.dataset === 'allocations').length).toBeGreaterThanOrEqual(41);

      const page = await pullPage(venA, 'allocations');
      const first = page.changes.filter((c) => c.entity_id === quotas[0]);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        entity_type: 'STOCK_ALLOCATION',
        change_type: 'UPSERT',
        scope_type: 'DEVICE',
        scope_id: venA.deviceId,
      });
      expect(first[0]!.data).toMatchObject({
        id: quotas[0],
        location_id: counterA,
        product_id: products[0],
        holder_user_id: venA.userId,
        holder_device_id: venA.deviceId,
        status: 'ACTIVE',
        revocation_pending: false,
      });
      expect(Number(first[0]!.data!.quantity_granted)).toBe(50);
      expect(Number(first[0]!.data!.quantity_remaining)).toBe(10);
      expect(Object.keys(first[0]!.data!)).not.toContain('revoke_reason');
      // RISK-23 : environ 0,7 Ko par quota actif (borne documentée au §3.1 et dans AV-194).
      expect(Buffer.byteLength(JSON.stringify(first[0]), 'utf8')).toBeLessThan(800);
      expect(servedIds(page.changes, 'STOCK_ALLOCATION')).toEqual(new Set(quotas));
      // RISK-23 : la journée de l'appareil (trois quotas, quarante consommations) tient sous 10 Ko.
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(10 * 1024);
    });

    it('ne sert le quota ni à un autre appareil du même vendeur, ni par le repli GLOBAL', async () => {
      expect(servedIds(await pull(venAOther, 'allocations'), 'STOCK_ALLOCATION').size).toBe(0);
      expect(servedIds(await pull(venB, 'allocations'), 'STOCK_ALLOCATION').size).toBe(0);
      const fallback = (await feedLines('STOCK_ALLOCATION', quotas[0]!)).filter(
        (l) => l.scope_type === 'GLOBAL',
      );
      expect(fallback.length).toBeGreaterThan(0);
      const viaFallback = await pull(venA, fallback[0]!.dataset);
      expect(servedIds(viaFallback, 'STOCK_ALLOCATION').size).toBe(0);
    });

    it('fait sortir du jeu un quota révoqué ou libéré (AV-193)', async () => {
      await ok(magA, {
        type: 'inventory.allocation.revoke',
        aggregateType: 'STOCK_ALLOCATION',
        aggregateId: quotas[1]!,
        occurredAt: at('11:00'),
        payload: { reason: 'Fin de la tournée.' },
      });
      await ok(venA, {
        type: 'inventory.allocation.release',
        aggregateType: 'STOCK_ALLOCATION',
        aggregateId: quotas[2]!,
        occurredAt: at('11:05'),
        payload: { remainingBase: 50 },
        offline: true,
      });
      const changes = await pull(venA, 'allocations');
      for (const id of [quotas[1]!, quotas[2]!]) {
        expect(latest(changes, 'STOCK_ALLOCATION', id)).toMatchObject({
          change_type: 'SCOPE_EXIT',
          scope_type: 'DEVICE',
          scope_id: venA.deviceId,
        });
        expect(latest(changes, 'STOCK_ALLOCATION', id)!.data).toBeUndefined();
      }
      expect(servedIds(changes, 'STOCK_ALLOCATION')).toEqual(new Set([quotas[0]!]));
    });
  });

  describe('jeu cash (sessions, remises, destinations)', () => {
    let session: string;
    let sent: string;
    let cancelled: string;

    it('sert la session du PDV ouverte, puis à valider avec l’attendu du serveur, et la retire à la validation', async () => {
      session = freshUuid();
      await ok(venA, {
        type: 'finance.cash_session.open',
        aggregateType: 'CASH_SESSION',
        aggregateId: session,
        occurredAt: at('08:00'),
        payload: { cashAccountId: posA, countedXaf: 20_000 },
      });
      let changes = await pull(venA, 'cash');
      expect(latest(changes, 'CASH_SESSION', session)).toMatchObject({
        change_type: 'UPSERT',
        scope_type: 'SITE',
        scope_id: siteA,
      });
      expect(latest(changes, 'CASH_SESSION', session)!.data).toMatchObject({
        id: session,
        cash_account_id: posA,
        site_id: siteA,
        business_date: DAY,
        status: 'OPEN',
        opened_by: venA.userId,
        opening_counted_xaf: 20_000,
        opening_variance_xaf: 0,
        closing_expected_xaf: null,
      });
      // Ni le vendeur d'un autre PDV, ni le magasinier du site (sans `finance.cash.read`), ni le repli.
      expect(servedIds(await pull(venB, 'cash'), 'CASH_SESSION').has(session)).toBe(false);
      expect(servedIds(await pull(magA, 'cash'), 'CASH_SESSION').has(session)).toBe(false);
      expect(servedIds(await pull(venA, 'cash_session'), 'CASH_SESSION').size).toBe(0);

      await ok(venA, {
        type: 'finance.cash_session.close',
        aggregateType: 'CASH_SESSION',
        aggregateId: session,
        occurredAt: at('18:00'),
        payload: { countedXaf: 2_000 },
      });
      changes = await pull(venA, 'cash');
      expect(latest(changes, 'CASH_SESSION', session)!.data).toMatchObject({
        status: 'PENDING_VALIDATION',
        closed_by: venA.userId,
        closing_counted_xaf: 2_000,
        closing_expected_xaf: 20_000,
        variance_xaf: -18_000,
        current_expected_xaf: 20_000,
        current_variance_xaf: -18_000,
        force_closed: false,
      });

      // Opération tardive : remise de la caisse centrale reçue hors ligne à 12:00, synchronisée après
      // la clôture. La session à valider est republiée avec l'attendu et l'écart courants ; les valeurs
      // de clôture ne bougent pas.
      const late = freshUuid();
      await ok(fin, {
        type: 'finance.cash_transfer.send',
        aggregateType: 'CASH_TRANSFER',
        aggregateId: late,
        occurredAt: at('11:00'),
        payload: { fromAccountId: central, toAccountId: posA, amountXaf: 3_000 },
      });
      const beforeLate = await maxSeq();
      await ok(venA, {
        type: 'finance.cash_transfer.receive',
        aggregateType: 'CASH_TRANSFER',
        aggregateId: late,
        occurredAt: at('12:00'),
        payload: { receivedXaf: 3_000 },
        offline: true,
      });
      const republished = (await pullPage(venA, 'cash', beforeLate)).changes;
      expect(latest(republished, 'CASH_SESSION', session)!.data).toMatchObject({
        status: 'PENDING_VALIDATION',
        closing_expected_xaf: 20_000,
        variance_xaf: -18_000,
        current_expected_xaf: 23_000,
        current_variance_xaf: -21_000,
      });

      await ok(fin, {
        type: 'finance.cash_session.validate',
        aggregateType: 'CASH_SESSION',
        aggregateId: session,
        occurredAt: at('18:30'),
        payload: { reason: 'Écart constaté et expliqué.' },
      });
      changes = await pull(venA, 'cash');
      expect(latest(changes, 'CASH_SESSION', session)).toMatchObject({
        change_type: 'SCOPE_EXIT',
        scope_type: 'SITE',
        scope_id: siteA,
      });
      expect(servedIds(changes, 'CASH_SESSION').has(session)).toBe(false);
    });

    it('sert la remise en cours aux deux comptes, puis la retire à la réception et à l’annulation', async () => {
      sent = freshUuid();
      await ok(venA, {
        type: 'finance.cash_transfer.send',
        aggregateType: 'CASH_TRANSFER',
        aggregateId: sent,
        occurredAt: at('19:00'),
        payload: { fromAccountId: posA, toAccountId: central, amountXaf: 1_000 },
      });
      const seller = await pull(venA, 'cash');
      // Deux portées pour le vendeur (responsable de la caisse, site du PDV) : toutes deux servies.
      const mine = seller.filter((c) => c.entity_type === 'CASH_TRANSFER' && c.entity_id === sent);
      expect(new Set(mine.map((c) => `${c.scope_type}:${c.scope_id}`))).toEqual(
        new Set([`USER:${venA.userId}`, `SITE:${siteA}`]),
      );
      expect(mine[0]!.data).toMatchObject({
        id: sent,
        from_account_id: posA,
        to_account_id: central,
        amount_sent_xaf: 1_000,
        amount_received_xaf: null,
        status: 'SENT',
        sent_by: venA.userId,
      });
      expect(Object.keys(mine[0]!.data!)).not.toContain('approval_request_id');
      expect(servedIds(await pull(fin, 'cash'), 'CASH_TRANSFER').has(sent)).toBe(true);
      expect(servedIds(await pull(venB, 'cash'), 'CASH_TRANSFER').has(sent)).toBe(false);

      await ok(fin, {
        type: 'finance.cash_transfer.receive',
        aggregateType: 'CASH_TRANSFER',
        aggregateId: sent,
        occurredAt: at('19:30'),
        payload: { receivedXaf: 1_000 },
      });
      cancelled = freshUuid();
      await ok(venA, {
        type: 'finance.cash_transfer.send',
        aggregateType: 'CASH_TRANSFER',
        aggregateId: cancelled,
        occurredAt: at('19:40'),
        payload: { fromAccountId: posA, toAccountId: central, amountXaf: 500 },
      });
      await ok(venA, {
        type: 'finance.cash_transfer.cancel',
        aggregateType: 'CASH_TRANSFER',
        aggregateId: cancelled,
        occurredAt: at('19:45'),
        payload: { reason: 'Remise saisie deux fois.' },
      });
      const after = await pull(venA, 'cash');
      for (const id of [sent, cancelled]) {
        const last = after.filter((c) => c.entity_type === 'CASH_TRANSFER' && c.entity_id === id);
        expect(last.length).toBeGreaterThan(0);
        // Dernière ligne de chaque portée : une sortie (l'appareil retire la remise).
        for (const scope of [`USER:${venA.userId}`, `SITE:${siteA}`]) {
          const ofScope = last.filter((c) => `${c.scope_type}:${c.scope_id}` === scope);
          expect(ofScope.at(-1)?.change_type, `${id} ${scope}`).toBe('SCOPE_EXIT');
        }
      }
      expect(servedIds(after, 'CASH_TRANSFER').size).toBe(0);
    });

    it('publie à tous les comptes destinataires sans solde, jamais une caisse personnelle (AV-197)', async () => {
      const changes = await pull(venB, 'cash');
      const targets = servedIds(changes, 'CASH_TRANSFER_TARGET');
      expect(targets.has(central)).toBe(true);
      expect(targets.has(posA)).toBe(true);
      expect(targets.has(personal)).toBe(false);
      expect(latest(changes, 'CASH_TRANSFER_TARGET', personal)?.change_type).toBe('DELETE');
      const data = latest(changes, 'CASH_TRANSFER_TARGET', central)!.data!;
      expect(data).toMatchObject({ id: central, account_type: 'CAISSE_CENTRALE', site_id: null });
      expect(Object.keys(data)).not.toContain('balance_xaf');
      expect(Object.keys(data)).not.toContain('responsible_user_id');
      // Ni version : celle du compte avance à chaque mouvement (activité de la caisse).
      expect(Object.keys(data)).not.toContain('version');
      // Le compte lui-même (avec son solde) reste réservé à ses portées.
      expect(servedIds(changes, 'CASH_ACCOUNT').has(central)).toBe(false);
      expect(servedIds(changes, 'CASH_ACCOUNT').has(posA)).toBe(false);
    });
  });

  describe('jeu cash : compte réattribué', () => {
    it('fait suivre au nouveau responsable les remises en cours, et garde le compte vu par le site', async () => {
      const transit = freshUuid();
      await ok(fin, {
        type: 'finance.cash_transfer.send',
        aggregateType: 'CASH_TRANSFER',
        aggregateId: transit,
        occurredAt: at('20:00'),
        payload: { fromAccountId: central, toAccountId: bank, amountXaf: 2_000 },
      });
      expect(servedIds(await pull(fin, 'cash'), 'CASH_TRANSFER').has(transit)).toBe(true);
      expect(servedIds(await pull(fin2, 'cash'), 'CASH_TRANSFER').has(transit)).toBe(false);
      await ok(fin, {
        type: 'finance.cash_account.update',
        aggregateType: 'CASH_ACCOUNT',
        aggregateId: central,
        occurredAt: at('20:10'),
        payload: { responsibleUserId: fin2.userId },
      });
      // L'ancien responsable (comptes sans site : aucune autre portée) ne garde pas la remise.
      const former = await pull(fin, 'cash');
      expect(latest(former, 'CASH_TRANSFER', transit)).toMatchObject({
        change_type: 'SCOPE_EXIT',
        scope_type: 'USER',
        scope_id: fin.userId,
      });
      expect(applyLocally(former).has(`CASH_TRANSFER:${transit}`)).toBe(false);
      expect(applyLocally(await pull(fin2, 'cash')).has(`CASH_TRANSFER:${transit}`)).toBe(true);

      // Caisse d'un PDV réattribuée : l'ancien responsable, vendeur du site, la voit encore par son
      // site — la sortie de sa ligne USER précède la mise à jour SITE.
      await ok(fin, {
        type: 'finance.cash_account.update',
        aggregateType: 'CASH_ACCOUNT',
        aggregateId: posD,
        occurredAt: at('20:20'),
        payload: { responsibleUserId: root },
      });
      const seller = await pull(venD, 'cash');
      expect(seller.some((c) => c.entity_id === posD && c.change_type === 'SCOPE_EXIT')).toBe(true);
      expect(applyLocally(seller).has(`CASH_ACCOUNT:${posD}`)).toBe(true);
    });
  });

  describe('jeu org (configuration du PDV)', () => {
    it('sert la configuration au site du PDV et propage le changement d’appareil désigné (AV-195)', async () => {
      const configure = (hhmm: string, payload: Record<string, unknown>) =>
        ok(admin, {
          type: 'organization.pos.configure',
          aggregateType: 'SITE',
          aggregateId: siteC,
          occurredAt: at(hhmm),
          payload: { salesLocationId: counterC, ...payload },
        });
      await configure('05:30', { custodyMode: 'SHARED' });
      let changes = await pull(venC, 'org');
      expect(latest(changes, 'POINT_OF_SALE', siteC)).toMatchObject({
        change_type: 'UPSERT',
        scope_type: 'SITE',
        scope_id: siteC,
      });
      expect(latest(changes, 'POINT_OF_SALE', siteC)!.data).toMatchObject({
        site_id: siteC,
        sales_location_id: counterC,
        custody_mode: 'SHARED',
        designated_device_id: null,
      });

      await configure('05:40', {
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: venC.deviceId,
      });
      await configure('05:50', {
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: venCNext.deviceId,
      });
      // L'ancien appareil reçoit la mise à jour (pas une sortie) : il n'est plus désigné.
      changes = await pull(venC, 'org');
      const pos = latest(changes, 'POINT_OF_SALE', siteC)!;
      expect(pos.change_type).toBe('UPSERT');
      expect(pos.data).toMatchObject({
        custody_mode: 'EXCLUSIVE_DEVICE',
        designated_device_id: venCNext.deviceId,
        version: 3,
      });
      expect(changes.some((c) => c.change_type === 'SCOPE_EXIT')).toBe(false);
      // L'emplacement de vente, source unique du mode de garde, est republié (jeu du repli).
      const location = latest(await pull(venC, 'location'), 'LOCATION', counterC)!;
      expect(location.data).toMatchObject({
        custody_mode: 'EXCLUSIVE_DEVICE',
        designated_device_id: venCNext.deviceId,
      });
      // Un vendeur d'un autre site ne reçoit pas ce PDV ; une ligne GLOBAL ne le sert jamais.
      expect(servedIds(await pull(venA, 'org'), 'POINT_OF_SALE').has(siteC)).toBe(false);
      await db
        .insertInto('sync_change_feed')
        .values({
          dataset: 'org',
          entity_type: 'POINT_OF_SALE',
          entity_id: toBin(siteC),
          change_type: 'UPSERT',
          scope_type: 'GLOBAL',
          scope_id: null,
          row_version: 99,
        })
        .execute();
      expect(servedIds(await pull(venA, 'org'), 'POINT_OF_SALE').has(siteC)).toBe(false);
    });
  });

  describe('référentiels de vente (AV-196)', () => {
    it('publie unités et canaux sous la clé dérivée de leur code, désactivés par le code', async () => {
      const unitCode = `U${freshUuid().slice(-10).toUpperCase()}`;
      const channelCode = `C${freshUuid().slice(-10).toUpperCase()}`;
      await ok(admin, {
        type: 'catalog.unit.create',
        aggregateType: 'UNIT',
        aggregateId: freshUuid(),
        occurredAt: at('07:00'),
        payload: { code: unitCode, name: 'Unité P5-18', isCount: true },
      });
      await ok(admin, {
        type: 'catalog.sales_channel.create',
        aggregateType: 'SALES_CHANNEL',
        aggregateId: freshUuid(),
        occurredAt: at('07:00'),
        payload: { code: channelCode, name: 'Canal P5-18' },
      });
      const unitId = codeEntityId('UNIT', unitCode);
      const channelId = codeEntityId('SALES_CHANNEL', channelCode);
      let changes = await pull(venB, 'catalog');
      expect(latest(changes, 'UNIT', unitId)!.data).toEqual({
        id: unitId,
        code: unitCode,
        name: 'Unité P5-18',
        is_count: true,
        is_active: true,
      });
      expect(latest(changes, 'SALES_CHANNEL', channelId)!.data).toMatchObject({
        code: channelCode,
        is_active: true,
      });

      for (const [type, aggregateType, code] of [
        ['catalog.unit.deactivate', 'UNIT', unitCode],
        ['catalog.sales_channel.deactivate', 'SALES_CHANNEL', channelCode],
      ] as const) {
        await ok(admin, {
          type,
          aggregateType,
          aggregateId: freshUuid(),
          occurredAt: at('07:05'),
          payload: { code },
        });
      }
      // Un canal que le serveur déduit lui-même ne se désactive pas (dictionnaire, `is_system`).
      const refused = await send(admin, {
        type: 'catalog.sales_channel.deactivate',
        aggregateType: 'SALES_CHANNEL',
        aggregateId: freshUuid(),
        occurredAt: at('07:06'),
        payload: { code: 'POINT_DE_VENTE' },
      });
      expect(refused).toMatchObject({ status: 'REJECTED', error: { code: 'SYSTEM_REFERENCE' } });
      changes = await pull(venB, 'catalog');
      expect(latest(changes, 'UNIT', unitId)!.data).toMatchObject({ is_active: false });
      expect(latest(changes, 'SALES_CHANNEL', channelId)!.data).toMatchObject({ is_active: false });
      // Le repli générique (jeu `unit`, identifiant d'enveloppe) ne sert rien.
      const viaFallback = await pull(venB, 'unit');
      expect(viaFallback.some((c) => c.data && c.data.code === unitCode)).toBe(false);
    });

    it('publie motifs et étapes du pipeline dans le jeu catalog', async () => {
      const reasonId = freshUuid();
      await ok(admin, {
        type: 'catalog.reason_code.set',
        aggregateType: 'REASON_CODE',
        aggregateId: reasonId,
        occurredAt: at('07:10'),
        payload: {
          category: 'LOSS',
          code: `P518_${freshUuid().slice(-8).toUpperCase()}`,
          label: 'Motif P5-18',
        },
      });
      const stepId = freshUuid();
      const stepCode = `P518_${freshUuid().slice(-8).toUpperCase()}`;
      for (const [hhmm, label] of [
        ['07:15', 'Étape P5-18'],
        ['07:20', 'Étape P5-18 renommée'],
      ] as const) {
        await ok(admin, {
          type: 'crm.pipeline.configure',
          aggregateType: 'PIPELINE_STEP',
          aggregateId: stepId,
          occurredAt: at(hhmm),
          payload: { code: stepCode, label, sortOrder: 90, isActive: true },
        });
      }
      const changes = await pull(venB, 'catalog');
      expect(latest(changes, 'REASON_CODE', reasonId)!.data).toMatchObject({
        id: reasonId,
        category: 'LOSS',
        label: 'Motif P5-18',
      });
      expect(latest(changes, 'PIPELINE_STEP', stepId)).toMatchObject({ row_version: 2 });
      expect(latest(changes, 'PIPELINE_STEP', stepId)!.data).toMatchObject({
        code: stepCode,
        label: 'Étape P5-18 renommée',
        is_active: true,
        version: 2,
      });
    });

    it('publie les paramètres visibles dans me et retire la version remplacée', async () => {
      const key = `p518.test.${freshUuid()}`;
      const set = async (hhmm: string, value: unknown, isClientVisible: boolean) => {
        const id = freshUuid();
        await ok(admin, {
          type: 'organization.setting.set',
          aggregateType: 'SETTING',
          aggregateId: id,
          occurredAt: hhmm.includes('T') ? hhmm : at(hhmm),
          payload: { key, value, scopeType: 'SITE', scopeId: siteA, isClientVisible },
        });
        return id;
      };
      const v1 = await set('07:30', 1, true);
      const v2 = await set('07:31', 2, true);
      // Un vendeur d'un autre site reçoit aussi la valeur du site A (ligne GLOBAL, portée dans la donnée).
      let changes = await pull(venB, 'me');
      expect(latest(changes, 'SETTING', v1)).toMatchObject({ change_type: 'DELETE' });
      expect(latest(changes, 'SETTING', v2)!.data).toMatchObject({
        key,
        value: 2,
        scope_type: 'SITE',
        scope_id: siteA,
      });
      // Redevenue invisible : la dernière version visible sort, la nouvelle n'est pas publiée.
      const v3 = await set('07:32', 3, false);
      changes = await pull(venB, 'me');
      expect(latest(changes, 'SETTING', v2)).toMatchObject({ change_type: 'DELETE' });
      expect(latest(changes, 'SETTING', v3)).toBeUndefined();
      // Version antidatée sous la version en vigueur (v3) : pas en vigueur, rien n'est publié.
      const v4 = await set(`${DAY}T07:31:30.000Z`, 4, true);
      changes = await pull(venB, 'me');
      expect(latest(changes, 'SETTING', v4)).toBeUndefined();
      expect(changes.some((c) => c.entity_type === 'SETTING' && c.data?.key === key)).toBe(false);
    });

    it('publie la politique active dans policies et supprime la version retirée', async () => {
      const code = `P518_${freshUuid().slice(-10).toUpperCase()}`;
      for (const hhmm of ['07:40', '07:41']) {
        const id = freshUuid();
        policyIds.push(id);
        await ok(admin, {
          type: 'approvals.policy.set',
          aggregateType: 'CONTROL_POLICY',
          aggregateId: id,
          occurredAt: at(hhmm),
          payload: { code, operationType: 'CHECKIN_OVERRIDE', requiresComment: true },
        });
      }
      const changes = await pull(venB, 'policies');
      expect(latest(changes, 'CONTROL_POLICY', policyIds[0]!)).toMatchObject({
        change_type: 'DELETE',
      });
      expect(latest(changes, 'CONTROL_POLICY', policyIds[1]!)!.data).toMatchObject({
        code,
        version: 2,
        operation_type: 'CHECKIN_OVERRIDE',
        requires_comment: true,
      });
    });
  });
  describe('jeu device : fiche servie à l’appareil seul (P5-23, AV-195 (3))', () => {
    it('designate : la fiche (is_shared, designated_site_id) n’est servie qu’à l’appareil ; un autre appareil ne reçoit rien', async () => {
      const tablet = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteA });
      await ok(admin, {
        type: 'identity.device.designate',
        aggregateType: 'DEVICE',
        aggregateId: tablet.deviceId,
        occurredAt: at('08:30'),
        payload: { isShared: true, designatedSiteId: siteA },
      });
      const own = await pull(tablet, 'device');
      expect(latest(own, 'DEVICE', tablet.deviceId)?.data).toMatchObject({
        id: tablet.deviceId,
        status: 'ACTIVE',
        is_shared: true,
        designated_site_id: siteA,
      });
      // Ni la ligne DEVICE (portée d'un autre appareil), ni la ligne GLOBAL du repli du pipeline.
      const others = await pull(venA, 'device');
      expect(others.filter((change) => change.entity_id === tablet.deviceId)).toEqual([]);
      const fallback = await db
        .selectFrom('sync_change_feed')
        .select('seq')
        .where('entity_type', '=', 'DEVICE')
        .where('entity_id', '=', toBin(tablet.deviceId))
        .where('scope_type', '=', 'GLOBAL')
        .execute();
      expect(fallback.length).toBeGreaterThan(0); // le repli existe, mais n'est servi à personne
    });
  });
});
