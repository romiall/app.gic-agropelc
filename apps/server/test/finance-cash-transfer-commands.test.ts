/**
 * P5-15 — remises de fonds (D05 BR-DIS-009, D09 BR-FIN-012 et 013, §16 ; SM-CASH-TRANSFER ; ADR-032
 * §2, §7, §8, §10 ; AV-153, AV-157, AV-158, AV-175 à AV-179) à travers le vrai pipeline de commandes,
 * le protocole hors ligne (`OfflineDevice` → `SyncPushService`), le registre des décisions
 * d'`approvals` et la tâche `finance.cash_transfers.unreceived_check`, avec les rôles réels du seed.
 *
 * Démontre : envoi `TRANSFER_OUT` et numéro `RMF` ; rejeu sans double écriture (INV-SYN-01) ; refus
 * sans écriture (INV-SYN-05) ; caisse jamais négative en ligne, `CASH_NEGATIVE` hors ligne
 * (BR-FIN-012) ; paires de comptes ; portée du compte (`CASH_ACCOUNT_FORBIDDEN`) ; référence locale ;
 * série globale de numérotation ; réception égale, manque, excédent, réception de 0 ; aucun second
 * mouvement d'écart (ADR-032 §7) ; décision `CASH_TRANSFER_DISCREPANCY` (imputation, motif, valideur,
 * rejet et retrait refusés) ; annulation par l'expéditeur, inverse daté de l'annulation (ADR-032 §2) ;
 * courses hors ligne en observation ; concurrence ; garde de désactivation ; indicateur « en
 * transit » ; alerte à 48 h ; cohérence registre / remises (INV-FIN-01, INV-FIN-02).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_CASH_TRANSFER_PAIRS,
  FixedClock,
  Uuidv7Generator,
  expectedCashXaf,
  type IdGenerator,
} from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerAccountCommands } from '../src/modules/finance/application/commands/account-commands.js';
import { registerCashTransferCommands } from '../src/modules/finance/application/commands/cash-transfer-commands.js';
import {
  CASH_TRANSFER_UNRECEIVED_JOB_TYPE,
  CashTransferUnreceivedJob,
} from '../src/modules/finance/application/jobs/cash-transfer-unreceived-job.js';
import {
  cashTransferPairsAt,
  cashTransferUnreceivedHoursAt,
  nextCashTransferNumber,
} from '../src/modules/finance/application/cash-transfer-support.js';
import { currentSettingValue } from '../src/modules/organization/application/public/index.js';
import {
  cashTransfersInTransit,
  findCashAccount,
  findCashTransfer,
  recordCashMovement,
  verifyCashLedger,
  verifyCashTransfers,
} from '../src/modules/finance/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestTeam,
  insertTestUser,
  insertTestZone,
  neutralizePolicy,
  withTestUow,
  withoutActivePolicies,
} from './helpers.js';
import { OfflineDevice } from './device-harness.js';
import {
  approvalOf,
  auditOf,
  balanceOf,
  codeOf,
  conflictsOf,
  eventsOf,
  fund,
  movementsOf,
  newAccount,
  newActor,
  newPosSite,
  roleIdOf,
  runCommand,
  siteCode,
  transferRow,
  tx,
  type Actor,
} from './cash-transfer-fixtures.js';

const DAY = '2026-10-08';
const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00.000Z`;
const NOW = at('23:00', '2026-10-09');
const FUNDED_AT = at('06:00', '2026-10-06');

// Chaque test enchaîne des dizaines de transactions validées (fsync à chaque validation) : sur le
// poste partagé et chargé, le délai par défaut de 20 s produisait des dépassements sans défaut du code.
describe('P5-15 : remises de fonds', { timeout: 60_000 }, () => {
  let clock: FixedClock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let services: { push: SyncPushService; pull: SyncPullService };
  let root: Actor;
  let zoneId: string;
  let fin1: Actor;
  let fin2: Actor;
  let fin3: Actor;
  let policyId: string;

  const run = (
    actor: Actor,
    type: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: {
      readonly offline?: boolean;
      readonly commandId?: string;
      readonly deviceSeq?: number;
    } = {},
  ) =>
    runCommand(pipeline, actor, {
      type,
      aggregateType: type.startsWith('approvals.') ? 'APPROVAL_REQUEST' : 'CASH_TRANSFER',
      aggregateId,
      occurredAt,
      payload,
      ...options,
    });

  const send = (
    actor: Actor,
    payload: Record<string, unknown>,
    occurredAt = at('18:00'),
    options: { readonly offline?: boolean; readonly id?: string } = {},
  ) => {
    const id = options.id ?? freshUuid();
    return run(actor, 'finance.cash_transfer.send', id, occurredAt, payload, options).then(
      (result) => ({ id, result }),
    );
  };
  const receive = (
    actor: Actor,
    id: string,
    receivedXaf: number,
    occurredAt = at('19:00'),
    options: { readonly offline?: boolean; readonly comment?: string } = {},
  ) =>
    run(
      actor,
      'finance.cash_transfer.receive',
      id,
      occurredAt,
      { receivedXaf, ...(options.comment !== undefined ? { comment: options.comment } : {}) },
      options,
    );
  const cancel = (
    actor: Actor,
    id: string,
    occurredAt = at('18:30'),
    options: { readonly offline?: boolean } = {},
  ) => run(actor, 'finance.cash_transfer.cancel', id, occurredAt, { reason: 'Erreur' }, options);
  const approve = (
    actor: Actor,
    requestId: string,
    payload: Record<string, unknown> = {},
    occurredAt = at('20:00'),
  ) => run(actor, 'approvals.request.approve', requestId, occurredAt, { requestId, ...payload });

  const ledgerOk = async (accountIds: readonly string[], transferIds: readonly string[]) => {
    const [ledger, transfers] = await tx(async (trx) => [
      await verifyCashLedger(trx, { cashAccountIds: accountIds }),
      await verifyCashTransfers(trx, { transferIds }),
    ]);
    expect(ledger, JSON.stringify(ledger)).toMatchObject({ ok: true });
    expect(transfers, JSON.stringify(transfers)).toMatchObject({ ok: true });
  };

  /** Point de vente neuf : site, caisse de PDV alimentée, vendeur du site. */
  async function newPdv(funded = 200_000) {
    const siteId = await newPosSite(root.userId, zoneId);
    const seller = await newActor('VENDEUR_PDV', root.userId, {
      scopeType: 'SITE',
      scopeSiteId: siteId,
    });
    const pos = await newAccount({ type: 'CAISSE_PDV', responsible: seller.userId, siteId });
    if (funded > 0) await fund(idGenerator, pos, funded, FUNDED_AT, root.userId);
    return { siteId, seller, pos };
  }
  const newCentral = () => newAccount({ type: 'CAISSE_CENTRALE', responsible: fin1.userId });
  /** Commercial terrain neuf (une seule caisse personnelle active par détenteur). */
  const newTerrain = () =>
    newActor('COMMERCIAL_TERRAIN', root.userId, { scopeType: 'ZONE', scopeZoneId: zoneId });

  beforeAll(async () => {
    clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
    registerAccountCommands(registry);
    registerCashTransferCommands(registry, decisions, idGenerator, sequences);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    services = { push: new SyncPushService(pipeline, db, clock), pull: new SyncPullService(db) };

    root = await tx(async (trx) => {
      const userId = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
      const role = await insertTestRole(trx, userId);
      await grantTestPermission(trx, role, 'approvals.policy.manage', userId);
      await assignTestRole(trx, userId, role, userId);
      zoneId = await insertTestZone(trx, userId);
      return { userId, deviceId };
    });
    fin1 = await newActor('FINANCE', root.userId);
    fin2 = await newActor('FINANCE', root.userId);
    fin3 = await newActor('FINANCE', root.userId);

    // Politique propre au fichier, bornée aux jours du test (la plus récente l'emporte) ; neutralisée
    // en fin de fichier. Approbateur : la Finance (`finance.cash_session.validate`, ALL).
    policyId = freshUuid();
    const policy = await runCommand(pipeline, root, {
      type: 'approvals.policy.set',
      aggregateType: 'CONTROL_POLICY',
      aggregateId: policyId,
      occurredAt: at('00:00', '2026-10-06'),
      payload: {
        code: `CTD-TEST-${policyId.slice(-12)}`,
        operationType: 'CASH_TRANSFER_DISCREPANCY',
        requiresApproval: true,
        approverPermission: 'finance.cash_session.validate',
        approverScope: 'ALL',
        validFrom: at('00:00', '2026-10-06'),
        validTo: at('00:00', '2026-10-10'),
      },
    });
    expect(policy.status, JSON.stringify(policy)).toBe('APPLIED');
  });

  afterAll(async () => {
    await neutralizePolicy(policyId);
    await closeTestDb();
  });

  // --- Envoi --------------------------------------------------------------------------------------------

  it('envoi en ligne PDV → centrale : TRANSFER_OUT, remise SENT, numéro RMF du site, audit et événement', async () => {
    const { siteId, seller, pos } = await newPdv();
    const central = await newCentral();
    const { id, result } = await send(seller, {
      fromAccountId: pos,
      toAccountId: central,
      amountXaf: 173_000,
      carrierName: 'Moto-taxi Paul',
      comment: 'Recette du jour',
    });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const code = await siteCode(siteId);
    expect(result.server_refs?.docNumber).toBe(`RMF-${code}-2026-000001`);
    expect(await balanceOf(pos)).toBe(200_000 - 173_000);
    expect(await transferRow(id)).toMatchObject({
      status: 'SENT',
      doc_number: `RMF-${code}-2026-000001`,
      amount_sent_xaf: 173_000,
      carrier_name: 'Moto-taxi Paul',
      captured_offline: 0,
    });
    expect(fromBin((await transferRow(id))!.site_id!)).toBe(siteId);
    const movements = await movementsOf(id);
    expect(movements).toEqual([
      expect.objectContaining({
        accountId: pos,
        direction: 'OUT',
        amountXaf: 173_000,
        movementType: 'TRANSFER_OUT',
        isReversal: false,
      }),
    ]);
    expect((await eventsOf(id)).map((e) => e.eventType)).toContain('finance.cash_transfer.send');
    const audit = await auditOf(id);
    expect(audit.map((a) => a.action)).toEqual(['finance.cash_transfer.send']);
    expect(audit[0]!.after).toMatchObject({ comment: 'Recette du jour', status: 'SENT' });
    // Second envoi du même PDV : numéro suivant.
    const second = await send(seller, { fromAccountId: pos, toAccountId: central, amountXaf: 1 });
    expect(second.result.server_refs?.docNumber).toBe(`RMF-${code}-2026-000002`);
    await ledgerOk([pos, central], [id, second.id]);
  });

  it('rejeu de la même enveloppe : même résultat, un seul mouvement ; même agrégat renvoyé : sans effet', async () => {
    const { seller, pos } = await newPdv();
    const central = await newCentral();
    const id = freshUuid();
    const commandId = freshUuid();
    const payload = { fromAccountId: pos, toAccountId: central, amountXaf: 5_000 };
    const envelope = { commandId, deviceSeq: 900_000 + Math.floor(Math.random() * 90_000) };
    const first = await run(
      seller,
      'finance.cash_transfer.send',
      id,
      at('18:00'),
      payload,
      envelope,
    );
    const replay = await run(
      seller,
      'finance.cash_transfer.send',
      id,
      at('18:00'),
      payload,
      envelope,
    );
    expect(replay).toEqual(first);
    const again = await send(seller, payload, at('18:05'), { id });
    expect(again.result).toMatchObject({
      status: 'APPLIED',
      server_refs: { docNumber: first.server_refs?.docNumber },
    });
    expect(await movementsOf(id)).toHaveLength(1);
    expect(await balanceOf(pos)).toBe(195_000);
  });

  it('envoi en ligne au-delà du solde : CASH_INSUFFICIENT, ni remise ni mouvement (INV-SYN-05)', async () => {
    const { seller, pos } = await newPdv(10_000);
    const central = await newCentral();
    const { id, result } = await send(seller, {
      fromAccountId: pos,
      toAccountId: central,
      amountXaf: 10_001,
    });
    expect(codeOf(result)).toBe('CASH_INSUFFICIENT');
    expect(await transferRow(id)).toBeUndefined();
    expect(await movementsOf(id)).toHaveLength(0);
    expect(await balanceOf(pos)).toBe(10_000);
  });

  it('envoi hors ligne (OfflineDevice) au-delà du solde : appliqué, CASH_NEGATIVE et conflit pour la Finance', async () => {
    const { seller, pos } = await newPdv(10_000);
    const central = await newCentral();
    const device = new OfflineDevice(services, seller.deviceId, clock);
    const id = freshUuid();
    device.enqueue(seller.userId, {
      type: 'finance.cash_transfer.send',
      aggregateType: 'CASH_TRANSFER',
      aggregateId: id,
      occurredAt: at('18:00'),
      payload: { fromAccountId: pos, toAccountId: central, amountXaf: 12_000 },
    });
    const [result] = await device.sync(seller.userId);
    expect(result).toMatchObject({ status: 'APPLIED_WITH_WARNINGS', warnings: ['CASH_NEGATIVE'] });
    expect(await balanceOf(pos)).toBe(-2_000);
    expect(await transferRow(id)).toMatchObject({ status: 'SENT', captured_offline: 1 });
    const [conflict] = await conflictsOf(pos, 'CASH_NEGATIVE');
    expect(conflict).toMatchObject({
      entityType: 'CASH_ACCOUNT',
      ownerRole: 'FINANCE',
      applied: true,
      status: 'OPEN',
    });
    expect(conflict!.details).toMatchObject({ transferId: id, balanceAfterXaf: -2_000 });
    await ledgerOk([pos], [id]);
  });

  it('paires de comptes (AV-158) : PDV → caisse d’utilisateur refusée en ligne, appliquée avec conflit hors ligne ; centrale → PDV et → banque admises', async () => {
    const { seller, pos } = await newPdv();
    const terrain = await newTerrain();
    const userCash = await newAccount({
      type: 'CAISSE_UTILISATEUR',
      responsible: terrain.userId,
      holder: terrain.userId,
    });
    const online = await send(seller, {
      fromAccountId: pos,
      toAccountId: userCash,
      amountXaf: 1_000,
    });
    expect(codeOf(online.result)).toBe('CASH_TRANSFER_PAIR_NOT_ALLOWED');
    expect(await transferRow(online.id)).toBeUndefined();
    const offline = await send(
      seller,
      { fromAccountId: pos, toAccountId: userCash, amountXaf: 1_000 },
      at('18:10'),
      { offline: true },
    );
    expect(offline.result).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['CASH_TRANSFER_PAIR_NOT_ALLOWED'],
    });
    expect(await conflictsOf(offline.id, 'CASH_TRANSFER_PAIR_NOT_ALLOWED')).toEqual([
      expect.objectContaining({ applied: true, ownerRole: 'FINANCE' }),
    ]);

    const central = await newCentral();
    await fund(idGenerator, central, 100_000, FUNDED_AT, root.userId);
    const bank = await newAccount({ type: 'BANQUE', responsible: fin1.userId });
    const toPos = await send(fin1, { fromAccountId: central, toAccountId: pos, amountXaf: 20_000 });
    const toBank = await send(fin1, {
      fromAccountId: central,
      toAccountId: bank,
      amountXaf: 30_000,
    });
    expect(toPos.result.status).toBe('APPLIED');
    expect(toBank.result.status).toBe('APPLIED');
    await ledgerOk([pos, central, bank, userCash], [offline.id, toPos.id, toBank.id]);
  });

  it('portée du compte : vendeur d’un autre PDV et commercial sur la caisse d’un autre → CASH_ACCOUNT_FORBIDDEN', async () => {
    const { pos } = await newPdv();
    const other = await newPdv();
    const central = await newCentral();
    const foreign = await send(other.seller, {
      fromAccountId: pos,
      toAccountId: central,
      amountXaf: 1,
    });
    expect(codeOf(foreign.result)).toBe('CASH_ACCOUNT_FORBIDDEN');

    const terrain = await newTerrain();
    const terrain2 = await newTerrain();
    const terrainCash = await newAccount({
      type: 'CAISSE_UTILISATEUR',
      responsible: terrain.userId,
      holder: terrain.userId,
    });
    await fund(idGenerator, terrainCash, 50_000, FUNDED_AT, root.userId);
    const stolen = await send(terrain2, {
      fromAccountId: terrainCash,
      toAccountId: central,
      amountXaf: 1,
    });
    expect(codeOf(stolen.result)).toBe('CASH_ACCOUNT_FORBIDDEN');
    // Le détenteur remet sa propre caisse, malgré une affectation de zone (RBAC §3).
    const own = await send(terrain, {
      fromAccountId: terrainCash,
      toAccountId: central,
      amountXaf: 1,
    });
    expect(own.result.status, JSON.stringify(own.result)).toBe('APPLIED');
  });

  it('Resp. commercial (TEAM) : remet sa propre caisse (seed aligné sur la matrice §5.5)', async () => {
    const rcoRole = await roleIdOf('RESP_COMMERCIAL');
    const rco = await tx(async (trx) => {
      const userId = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
      const teamId = await insertTestTeam(trx, userId, root.userId);
      await assignTestRole(trx, userId, rcoRole, root.userId, {
        scopeType: 'TEAM',
        scopeTeamId: teamId,
      });
      return { userId, deviceId };
    });
    const rcoCash = await newAccount({
      type: 'CAISSE_UTILISATEUR',
      responsible: rco.userId,
      holder: rco.userId,
    });
    await fund(idGenerator, rcoCash, 40_000, FUNDED_AT, root.userId);
    const central = await newCentral();
    const { result } = await send(rco, {
      fromAccountId: rcoCash,
      toAccountId: central,
      amountXaf: 40_000,
    });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    expect(await balanceOf(rcoCash)).toBe(0);
  });

  it('porteur inconnu : CASH_TRANSFER_CARRIER_INVALID ; destinataire inactif en ligne : CASH_ACCOUNT_INACTIVE', async () => {
    const { seller, pos } = await newPdv();
    const central = await newCentral();
    const carrier = await send(seller, {
      fromAccountId: pos,
      toAccountId: central,
      amountXaf: 1,
      carrierUserId: freshUuid(),
    });
    expect(codeOf(carrier.result)).toBe('CASH_TRANSFER_CARRIER_INVALID');
    const inactive = await newAccount({
      type: 'CAISSE_CENTRALE',
      responsible: fin1.userId,
      status: 'INACTIVE',
    });
    const toInactive = await send(seller, {
      fromAccountId: pos,
      toAccountId: inactive,
      amountXaf: 1,
    });
    expect(codeOf(toInactive.result)).toBe('CASH_ACCOUNT_INACTIVE');
    expect(await balanceOf(pos)).toBe(200_000);
  });

  it('référence locale déjà prise sur l’appareil : refus en ligne ; hors ligne, appliquée sans elle (LOCAL_REF_DUPLICATE)', async () => {
    const { seller, pos } = await newPdv();
    const central = await newCentral();
    const localRef = `R${freshUuid().slice(-12)}`;
    const payload = { fromAccountId: pos, toAccountId: central, amountXaf: 1_000, localRef };
    const first = await send(seller, payload);
    expect(first.result.status).toBe('APPLIED');
    const online = await send(seller, payload, at('18:05'));
    expect(codeOf(online.result)).toBe('LOCAL_REF_DUPLICATE');
    const offline = await send(seller, payload, at('18:06'), { offline: true });
    expect(offline.result).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['LOCAL_REF_DUPLICATE'],
    });
    expect(await transferRow(offline.id)).toMatchObject({ local_ref: null });
    expect(await transferRow(first.id)).toMatchObject({ local_ref: localRef });
  });

  it('numérotation (AV-179) : caisse d’utilisateur → centrale dans la série globale SIEGE, sans site ; numéros consécutifs', async () => {
    const terrain = await newTerrain();
    const terrainCash = await newAccount({
      type: 'CAISSE_UTILISATEUR',
      responsible: terrain.userId,
      holder: terrain.userId,
    });
    await fund(idGenerator, terrainCash, 10_000, FUNDED_AT, root.userId);
    const central = await newCentral();
    const a = await send(terrain, {
      fromAccountId: terrainCash,
      toAccountId: central,
      amountXaf: 1_000,
    });
    const b = await send(terrain, {
      fromAccountId: terrainCash,
      toAccountId: central,
      amountXaf: 1_000,
    });
    const number = (r: typeof a) => r.result.server_refs?.docNumber ?? '';
    expect(number(a)).toMatch(/^RMF-SIEGE-2026-\d{6}$/);
    expect(Number(number(b).slice(-6))).toBe(Number(number(a).slice(-6)) + 1);
    expect((await transferRow(a.id))!.site_id).toBeNull();
  });

  it('numérotation : un site réel de code SIEGE partage son compteur avec la série globale (aucun doublon)', async () => {
    await withTestUow(async (trx) => {
      let siegeId: string;
      const existing = await trx
        .selectFrom('organization_sites')
        .select('id')
        .where('code', '=', 'SIEGE')
        .executeTakeFirst();
      if (existing) {
        siegeId = fromBin(existing.id);
      } else {
        siegeId = freshUuid();
        await trx
          .insertInto('organization_sites')
          .values({
            id: toBin(siegeId),
            code: 'SIEGE',
            name: 'Siège (test annulé)',
            site_type: 'BUREAU',
            zone_id: toBin(zoneId),
            created_by: toBin(root.userId),
          })
          .execute();
      }
      const summary = (
        type: 'CAISSE_PDV' | 'CAISSE_UTILISATEUR' | 'CAISSE_CENTRALE',
        siteId: string | null,
      ) => ({
        id: freshUuid(),
        code: 'X',
        name: 'X',
        accountType: type,
        siteId,
        holderUserId: null,
        responsibleUserId: fin1.userId,
        externalRef: null,
        balanceXaf: 0,
        status: 'ACTIVE' as const,
      });
      const sequences = new DocumentSequenceService();
      const fromSiege = await nextCashTransferNumber(trx, sequences, {
        from: summary('CAISSE_PDV', siegeId),
        to: summary('CAISSE_CENTRALE', null),
        at: new Date(at('18:00')),
      });
      const global = await nextCashTransferNumber(trx, sequences, {
        from: summary('CAISSE_UTILISATEUR', null),
        to: summary('CAISSE_CENTRALE', null),
        at: new Date(at('18:00')),
      });
      expect(fromSiege.siteId).toBe(siegeId);
      expect(global.siteId).toBeNull();
      expect(fromSiege.docNumber).toMatch(/^RMF-SIEGE-2026-\d{6}$/);
      expect(Number(global.docNumber.slice(-6))).toBe(Number(fromSiege.docNumber.slice(-6)) + 1);
    });
  });

  it('paramètres semés lus à l’heure réelle (lecture seule) : paires et délai reconnus par le domaine, code de série valide', async () => {
    const now = new Date();
    const pairs = await tx((trx) => cashTransferPairsAt(trx, now));
    // Valeur venue du paramètre (pas le repli) et égale au défaut du domaine.
    expect(pairs).not.toBe(DEFAULT_CASH_TRANSFER_PAIRS);
    expect(pairs).toEqual(DEFAULT_CASH_TRANSFER_PAIRS);
    expect(await cashTransferUnreceivedHoursAt(db, now)).toBe(48);
    expect(
      await currentSettingValue(db, {
        key: 'finance.cash_transfer_series_code',
        scopeType: 'GLOBAL',
        scopeId: null,
        at: now,
      }),
    ).toBe('SIEGE');
  });

  // --- Réception -----------------------------------------------------------------------------------------

  it('réception égale par la Finance : RECEIVED, TRANSFER_IN du montant, aucune demande', async () => {
    const { seller, pos } = await newPdv();
    const central = await newCentral();
    const { id } = await send(seller, {
      fromAccountId: pos,
      toAccountId: central,
      amountXaf: 173_000,
    });
    const result = await receive(fin1, id, 173_000);
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const row = await transferRow(id);
    expect(row).toMatchObject({
      status: 'RECEIVED',
      amount_received_xaf: 173_000,
      discrepancy_xaf: 0,
    });
    expect(fromBin(row!.received_by!)).toBe(fin1.userId);
    expect(fromBin(row!.received_device_id!)).toBe(fin1.deviceId);
    expect(await balanceOf(central)).toBe(173_000);
    expect(await approvalOf(id)).toHaveLength(0);
    expect((await eventsOf(id)).map((e) => e.eventType)).toEqual([
      'finance.cash_transfer.send',
      'finance.cash_transfer.receive',
    ]);
    const inTransit = await cashTransfersInTransit(db, {
      now: new Date(NOW),
      accountIds: [pos, central],
    });
    expect(inTransit).toMatchObject({ count: 0, totalXaf: 0 });
    await ledgerOk([pos, central], [id]);
  });

  it('réception par l’expéditeur : CASH_TRANSFER_SELF_RECEIVE, en ligne et hors ligne', async () => {
    const central = await newCentral();
    await fund(idGenerator, central, 50_000, FUNDED_AT, root.userId);
    const bank = await newAccount({ type: 'BANQUE', responsible: fin1.userId });
    const { id } = await send(fin1, {
      fromAccountId: central,
      toAccountId: bank,
      amountXaf: 50_000,
    });
    expect(codeOf(await receive(fin1, id, 50_000))).toBe('CASH_TRANSFER_SELF_RECEIVE');
    expect(codeOf(await receive(fin1, id, 50_000, at('19:05'), { offline: true }))).toBe(
      'CASH_TRANSFER_SELF_RECEIVE',
    );
    expect(await transferRow(id)).toMatchObject({ status: 'SENT' });
    // Le vendeur d'un PDV n'a aucune portée sur la caisse centrale.
    const { seller, pos } = await newPdv();
    const central2 = await newCentral();
    const sent = await send(seller, { fromAccountId: pos, toAccountId: central2, amountXaf: 1 });
    expect(codeOf(await receive(await newTerrain(), sent.id, 1))).toBe('CASH_ACCOUNT_FORBIDDEN');
  });

  it('manque 173 000 / 170 000 : DISCREPANCY_PENDING, écart −3 000, demande de 3 000, source débitée de 173 000 exactement, aucun second mouvement', async () => {
    const { seller, pos } = await newPdv();
    const central = await newCentral();
    const { id } = await send(seller, {
      fromAccountId: pos,
      toAccountId: central,
      amountXaf: 173_000,
      carrierUserId: fin3.userId,
    });
    const result = await receive(fin1, id, 170_000, at('19:00'), { comment: 'Billets manquants' });
    expect(result).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['CASH_TRANSFER_DISCREPANCY'],
    });
    const row = await transferRow(id);
    expect(row).toMatchObject({
      status: 'DISCREPANCY_PENDING',
      amount_received_xaf: 170_000,
      discrepancy_xaf: -3_000,
    });
    expect(await balanceOf(pos)).toBe(200_000 - 173_000);
    expect(await balanceOf(central)).toBe(170_000);
    const movements = await movementsOf(id);
    expect(movements.map((m) => `${m.movementType}:${m.direction}:${m.amountXaf}`).sort()).toEqual([
      'TRANSFER_IN:IN:170000',
      'TRANSFER_OUT:OUT:173000',
    ]);
    // Aucun SESSION_VARIANCE ne cite la remise ni le compte source (ADR-032 §7).
    const variances = await db
      .selectFrom('finance_cash_movements')
      .select('id')
      .where('movement_type', '=', 'SESSION_VARIANCE')
      .where((eb) =>
        eb.or([eb('source_doc_id', '=', toBin(id)), eb('cash_account_id', '=', toBin(pos))]),
      )
      .execute();
    expect(variances).toHaveLength(0);
    const [request] = await approvalOf(id);
    expect(request).toMatchObject({ status: 'PENDING', amount_xaf: 3_000 });
    expect(request!.subject_summary).toContain('Billets manquants');
    expect(fromBin(request!.requested_by)).toBe(fin1.userId);
    const [event] = await eventsOf(id, 'CashTransferDiscrepancyDetected');
    expect(event?.payload).toMatchObject({
      discrepancy_xaf: -3_000,
      approval_request_id: fromBin(request!.id),
    });
    await ledgerOk([pos, central], [id]);

    // Décision : séparation des tâches, imputation et motif obligatoires, aucun mouvement ajouté.
    const requestId = fromBin(request!.id);
    expect(
      codeOf(
        await approve(fin1, requestId, {
          decisionOption: 'COMPANY',
          decisionData: { reason: 'x' },
        }),
      ),
    ).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(
      codeOf(
        await approve(fin1, requestId, {
          decisionOption: 'COMPANY',
          decisionData: { reason: 'x' },
          selfApproved: true,
        }),
      ),
    ).toBe('CASH_TRANSFER_VALIDATOR_INVOLVED');
    expect(
      codeOf(
        await approve(fin3, requestId, {
          decisionOption: 'COMPANY',
          decisionData: { reason: 'x' },
        }),
      ),
    ).toBe('CASH_TRANSFER_VALIDATOR_INVOLVED'); // porteur
    expect(codeOf(await approve(fin2, requestId, { decisionData: { reason: 'x' } }))).toBe(
      'CASH_TRANSFER_IMPUTATION_REQUIRED',
    );
    expect(
      codeOf(
        await approve(fin2, requestId, { decisionOption: 'VOLEUR', decisionData: { reason: 'x' } }),
      ),
    ).toBe('CASH_TRANSFER_IMPUTATION_REQUIRED');
    expect(codeOf(await approve(fin2, requestId, { decisionOption: 'CARRIER' }))).toBe(
      'REASON_REQUIRED',
    );
    expect(
      codeOf(
        await run(fin2, 'approvals.request.reject', requestId, at('20:00'), {
          requestId,
          comment: 'Non',
        }),
      ),
    ).toBe('CASH_TRANSFER_DISCREPANCY_NOT_REJECTABLE');
    expect(
      codeOf(await run(fin1, 'approvals.request.withdraw', requestId, at('20:00'), { requestId })),
    ).toBe('CASH_TRANSFER_DISCREPANCY_NOT_WITHDRAWABLE');
    expect((await approvalOf(id))[0]).toMatchObject({ status: 'PENDING' });
    expect(await transferRow(id)).toMatchObject({ status: 'DISCREPANCY_PENDING' });

    const approved = await approve(fin2, requestId, {
      decisionOption: 'CARRIER',
      decisionData: { reason: 'Porteur reconnu responsable' },
    });
    expect(approved.status, JSON.stringify(approved)).toBe('APPLIED');
    const closed = await transferRow(id);
    expect(closed).toMatchObject({
      status: 'CLOSED',
      imputation: 'CARRIER',
      closing_reason: 'Porteur reconnu responsable',
    });
    expect(fromBin(closed!.closed_by!)).toBe(fin2.userId);
    expect(closed!.closed_at?.toISOString()).toBe(at('20:00'));
    expect((await approvalOf(id))[0]).toMatchObject({
      status: 'APPROVED',
      decision_option: 'CARRIER',
    });
    expect(await movementsOf(id)).toHaveLength(2);
    expect(await balanceOf(pos)).toBe(27_000);
    expect(await balanceOf(central)).toBe(170_000);
    await ledgerOk([pos, central], [id]);
  });

  it('excédent : écart +2 000, entrée du montant reçu', async () => {
    const { seller, pos } = await newPdv();
    const central = await newCentral();
    const { id } = await send(seller, {
      fromAccountId: pos,
      toAccountId: central,
      amountXaf: 10_000,
    });
    expect((await receive(fin1, id, 12_000)).status).toBe('APPLIED_WITH_WARNINGS');
    expect(await transferRow(id)).toMatchObject({
      status: 'DISCREPANCY_PENDING',
      discrepancy_xaf: 2_000,
    });
    expect(await balanceOf(central)).toBe(12_000);
    expect((await approvalOf(id))[0]).toMatchObject({ amount_xaf: 2_000 });
    await ledgerOk([pos, central], [id]);
  });

  it('remise perdue (AV-178) : réception de 0, aucune entrée, écart = −envoyé ; imputation au porteur sans porteur refusée', async () => {
    const { seller, pos } = await newPdv();
    const central = await newCentral();
    const { id } = await send(seller, {
      fromAccountId: pos,
      toAccountId: central,
      amountXaf: 8_000,
    });
    expect((await receive(fin1, id, 0)).status).toBe('APPLIED_WITH_WARNINGS');
    const row = await transferRow(id);
    expect(row).toMatchObject({
      status: 'DISCREPANCY_PENDING',
      amount_received_xaf: 0,
      discrepancy_xaf: -8_000,
    });
    expect(row!.in_movement_id).toBeNull();
    expect(await movementsOf(id)).toHaveLength(1);
    expect(await balanceOf(central)).toBe(0);
    const requestId = fromBin((await approvalOf(id))[0]!.id);
    expect(
      codeOf(
        await approve(fin2, requestId, {
          decisionOption: 'CARRIER',
          decisionData: { reason: 'Perdue' },
        }),
      ),
    ).toBe('CASH_TRANSFER_IMPUTATION_INVALID');
    expect(
      (
        await approve(fin2, requestId, {
          decisionOption: 'SENDER',
          decisionData: { reason: 'Perdue' },
        })
      ).status,
    ).toBe('APPLIED');
    expect(await transferRow(id)).toMatchObject({ status: 'CLOSED', imputation: 'SENDER' });
    await ledgerOk([pos, central], [id]);
  });

  it('écart sans politique applicable : CONTROL_POLICY_MISSING (aucune, ou seulement une politique sans approbation)', async () => {
    const { seller, pos } = await newPdv();
    const central = await newCentral();
    const { id } = await send(seller, {
      fromAccountId: pos,
      toAccountId: central,
      amountXaf: 1_000,
    });
    await withoutActivePolicies(
      'CASH_TRANSFER_DISCREPANCY',
      new Date(at('00:00', '2026-10-06')),
      async () => {
        expect(codeOf(await receive(fin1, id, 900))).toBe('CONTROL_POLICY_MISSING');
        const lax = freshUuid();
        const created = await runCommand(pipeline, root, {
          type: 'approvals.policy.set',
          aggregateType: 'CONTROL_POLICY',
          aggregateId: lax,
          occurredAt: at('00:00'),
          payload: {
            code: `CTD-LAX-${lax.slice(-12)}`,
            operationType: 'CASH_TRANSFER_DISCREPANCY',
            requiresApproval: false,
            validFrom: at('00:00'),
            validTo: at('00:00', '2026-10-09'),
          },
        });
        expect(created.status).toBe('APPLIED');
        try {
          expect(codeOf(await receive(fin1, id, 900, at('19:01')))).toBe('CONTROL_POLICY_MISSING');
        } finally {
          await neutralizePolicy(lax);
        }
      },
    );
    expect(await transferRow(id)).toMatchObject({ status: 'SENT' });
    // Une réception égale ne demande aucune politique.
    expect((await receive(fin1, id, 1_000, at('19:02'))).status).toBe('APPLIED');
  });

  it('réception en ligne sur un compte désactivé de force : refus métier CASH_ACCOUNT_INACTIVE, jamais RETRY_LATER', async () => {
    const { seller, pos } = await newPdv();
    const central = await newCentral();
    const { id } = await send(seller, {
      fromAccountId: pos,
      toAccountId: central,
      amountXaf: 3_000,
    });
    await db
      .updateTable('finance_cash_accounts')
      .set({ status: 'INACTIVE' })
      .where('id', '=', toBin(central))
      .execute();
    const result = await receive(fin1, id, 3_000);
    expect(result.status).toBe('REJECTED');
    expect(codeOf(result)).toBe('CASH_ACCOUNT_INACTIVE');
    // L'expéditeur annule et l'argent revient (correction admise même vers un compte inactif).
    expect((await cancel(seller, id)).status).toBe('APPLIED');
    expect(await balanceOf(pos)).toBe(200_000);
  });

  // --- Annulation --------------------------------------------------------------------------------------

  it('annulation par l’expéditeur : inverse IN daté de l’annulation (le lendemain), solde rendu ; par un autre : refusée ; seconde : sans effet', async () => {
    const { siteId, seller, pos } = await newPdv(100_000);
    const colleague = await newActor('VENDEUR_PDV', root.userId, {
      scopeType: 'SITE',
      scopeSiteId: siteId,
    });
    const central = await newCentral();
    const { id } = await send(
      seller,
      { fromAccountId: pos, toAccountId: central, amountXaf: 40_000 },
      at('18:00', '2026-10-07'),
    );
    expect(codeOf(await cancel(colleague, id, at('09:00')))).toBe('CASH_TRANSFER_NOT_SENDER');
    expect((await cancel(seller, id, at('09:00'))).status).toBe('APPLIED');
    const row = await transferRow(id);
    expect(row).toMatchObject({ status: 'CANCELLED', cancel_reason: 'Erreur' });
    expect(row!.cancelled_at?.toISOString()).toBe(at('09:00'));
    const movements = await movementsOf(id);
    const out = movements.find((m) => !m.isReversal)!;
    const inverse = movements.find((m) => m.isReversal)!;
    expect(out).toMatchObject({
      direction: 'OUT',
      occurredAt: new Date(at('18:00', '2026-10-07')),
    });
    expect(inverse).toMatchObject({
      accountId: pos,
      direction: 'IN',
      amountXaf: 40_000,
      movementType: 'TRANSFER_OUT',
      reversesMovementId: out.id,
      occurredAt: new Date(at('09:00')),
    });
    expect(fromBin(row!.cancel_movement_id!)).toBe(inverse.id);
    expect(await balanceOf(pos)).toBe(100_000);
    // ADR-032 §2 : fait physique nouveau, compté dans la fenêtre du jour de l'annulation (par son
    // occurred_at, jamais par le lien d'inverse) ; la fenêtre de la veille garde la sortie.
    const windowOf = async (from: string, to: string) =>
      (
        await db
          .selectFrom('finance_cash_movements')
          .select(['direction', 'movement_type', 'amount_xaf'])
          .where('cash_account_id', '=', toBin(pos))
          .where('occurred_at', '>=', new Date(from))
          .where('occurred_at', '<', new Date(to))
          .execute()
      ).map((m) => ({
        direction: m.direction as 'IN' | 'OUT',
        movementType: m.movement_type,
        amountXaf: Number(m.amount_xaf),
      }));
    expect(expectedCashXaf(0, await windowOf(at('08:00'), at('19:00')))).toBe(40_000);
    expect(
      expectedCashXaf(0, await windowOf(at('08:00', '2026-10-07'), at('19:00', '2026-10-07'))),
    ).toBe(-40_000);
    // Seconde annulation : sans effet.
    expect((await cancel(seller, id, at('09:30'))).status).toBe('APPLIED');
    expect(await movementsOf(id)).toHaveLength(2);
    // INV-FIN-01 : rien ne disparaît — la sortie d'origine reste au registre.
    expect(movements.map((m) => m.id)).toContain(out.id);
    await ledgerOk([pos, central], [id]);
  });

  it('en ligne : réception d’une remise annulée, annulation d’une remise reçue, réception avant l’envoi → refus', async () => {
    const { seller, pos } = await newPdv();
    const central = await newCentral();
    const a = await send(seller, { fromAccountId: pos, toAccountId: central, amountXaf: 1_000 });
    expect((await cancel(seller, a.id)).status).toBe('APPLIED');
    expect(codeOf(await receive(fin1, a.id, 1_000))).toBe('CASH_TRANSFER_CANCELLED');
    const b = await send(seller, { fromAccountId: pos, toAccountId: central, amountXaf: 1_000 });
    expect(codeOf(await receive(fin1, b.id, 1_000, at('17:00')))).toBe('CASH_TRANSFER_BEFORE_SENT');
    expect((await receive(fin1, b.id, 1_000)).status).toBe('APPLIED');
    expect(codeOf(await cancel(seller, b.id, at('19:30')))).toBe('CASH_TRANSFER_ALREADY_RECEIVED');
    expect(codeOf(await receive(fin2, b.id, 1_000, at('19:40')))).toBe(
      'CASH_TRANSFER_ALREADY_RECEIVED',
    );
    await ledgerOk([pos, central], [a.id, b.id]);
  });

  // --- Courses hors ligne (deux appareils) -------------------------------------------------------------

  it('course 1 : annulation synchronisée, puis réception hors ligne → observation CASH_TRANSFER_RECEIVED_AFTER_CANCEL, aucune entrée', async () => {
    const { seller, pos } = await newPdv();
    const central = await newCentral();
    const sellerTablet = new OfflineDevice(services, seller.deviceId, clock);
    const financeLaptop = new OfflineDevice(services, fin1.deviceId, clock);
    const id = freshUuid();
    sellerTablet.enqueue(seller.userId, {
      type: 'finance.cash_transfer.send',
      aggregateType: 'CASH_TRANSFER',
      aggregateId: id,
      occurredAt: at('18:00'),
      payload: { fromAccountId: pos, toAccountId: central, amountXaf: 50_000 },
      capturedOffline: false,
    });
    await sellerTablet.sync(seller.userId);
    // La Finance reçoit hors ligne à 18:40 ; le vendeur annule hors ligne à 18:30 et synchronise d'abord.
    financeLaptop.enqueue(fin1.userId, {
      type: 'finance.cash_transfer.receive',
      aggregateType: 'CASH_TRANSFER',
      aggregateId: id,
      occurredAt: at('18:40'),
      payload: { receivedXaf: 50_000, comment: 'Compté au siège' },
    });
    sellerTablet.enqueue(seller.userId, {
      type: 'finance.cash_transfer.cancel',
      aggregateType: 'CASH_TRANSFER',
      aggregateId: id,
      occurredAt: at('18:30'),
      payload: { reason: 'Porteur absent' },
    });
    const [cancelled] = await sellerTablet.sync(seller.userId);
    expect(cancelled?.status).toBe('APPLIED');
    const [observed] = await financeLaptop.sync(fin1.userId);
    expect(observed).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['CASH_TRANSFER_RECEIVED_AFTER_CANCEL'],
    });
    expect(await transferRow(id)).toMatchObject({ status: 'CANCELLED' });
    expect(await balanceOf(central)).toBe(0);
    expect((await movementsOf(id)).map((m) => m.movementType)).toEqual([
      'TRANSFER_OUT',
      'TRANSFER_OUT',
    ]);
    const [conflict] = await conflictsOf(id, 'CASH_TRANSFER_RECEIVED_AFTER_CANCEL');
    expect(conflict).toMatchObject({ ownerRole: 'FINANCE', applied: true, status: 'OPEN' });
    expect(conflict!.details).toMatchObject({
      receivedXaf: 50_000,
      comment: 'Compté au siège',
      observedBy: fin1.userId,
      observedDeviceId: fin1.deviceId,
      observedAt: at('18:40'),
      statusFound: 'CANCELLED',
    });
    await ledgerOk([pos, central], [id]);
  });

  it('course 2 : réception en ligne, puis annulation hors ligne → observation CASH_TRANSFER_CANCEL_AFTER_RECEIVE, aucun inverse', async () => {
    const { seller, pos } = await newPdv();
    const central = await newCentral();
    const { id } = await send(seller, {
      fromAccountId: pos,
      toAccountId: central,
      amountXaf: 7_000,
    });
    expect((await receive(fin1, id, 7_000)).status).toBe('APPLIED');
    const sellerTablet = new OfflineDevice(services, seller.deviceId, clock);
    sellerTablet.enqueue(seller.userId, {
      type: 'finance.cash_transfer.cancel',
      aggregateType: 'CASH_TRANSFER',
      aggregateId: id,
      occurredAt: at('18:30'),
      payload: { reason: 'Erreur de compte' },
    });
    const [result] = await sellerTablet.sync(seller.userId);
    expect(result).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['CASH_TRANSFER_CANCEL_AFTER_RECEIVE'],
    });
    expect(await transferRow(id)).toMatchObject({ status: 'RECEIVED' });
    expect((await movementsOf(id)).some((m) => m.isReversal)).toBe(false);
    expect((await conflictsOf(id, 'CASH_TRANSFER_CANCEL_AFTER_RECEIVE'))[0]?.details).toMatchObject(
      {
        reason: 'Erreur de compte',
        statusFound: 'RECEIVED',
      },
    );
    await ledgerOk([pos, central], [id]);
  });

  it('course 3 : double réception hors ligne → une seule entrée, observation CASH_TRANSFER_RECEIVED_TWICE', async () => {
    const { seller, pos } = await newPdv();
    const central = await newCentral();
    const { id } = await send(seller, {
      fromAccountId: pos,
      toAccountId: central,
      amountXaf: 9_000,
    });
    const first = await receive(fin1, id, 9_000, at('19:00'), { offline: true });
    const second = await receive(fin2, id, 8_500, at('19:10'), { offline: true });
    expect(first.status).toBe('APPLIED');
    expect(second).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['CASH_TRANSFER_RECEIVED_TWICE'],
    });
    expect(await balanceOf(central)).toBe(9_000);
    expect((await movementsOf(id)).filter((m) => m.movementType === 'TRANSFER_IN')).toHaveLength(1);
    expect((await conflictsOf(id, 'CASH_TRANSFER_RECEIVED_TWICE'))[0]?.details).toMatchObject({
      receivedXaf: 8_500,
      amountReceivedXaf: 9_000,
    });
    await ledgerOk([pos, central], [id]);
  });

  // --- Concurrence --------------------------------------------------------------------------------------

  it('réception et annulation en parallèle : une seule passe, deux mouvements en tout', async () => {
    const { seller, pos } = await newPdv();
    const central = await newCentral();
    const { id } = await send(seller, {
      fromAccountId: pos,
      toAccountId: central,
      amountXaf: 6_000,
    });
    const [received, cancelled] = await Promise.all([
      receive(fin1, id, 6_000, at('19:00')),
      cancel(seller, id, at('19:00')),
    ]);
    const statuses = [received.status, cancelled.status].sort();
    expect(statuses).toEqual(['APPLIED', 'REJECTED']);
    const loser = received.status === 'REJECTED' ? received : cancelled;
    expect(['CASH_TRANSFER_CANCELLED', 'CASH_TRANSFER_ALREADY_RECEIVED']).toContain(codeOf(loser));
    expect(await movementsOf(id)).toHaveLength(2);
    await ledgerOk([pos, central], [id]);
  });

  it('deux envois concurrents sur le dernier solde : un seul passe ; envois croisés A→B et B→A : tous deux passent', async () => {
    const { seller, pos } = await newPdv(10_000);
    const central = await newCentral();
    const [a, b] = await Promise.all([
      send(seller, { fromAccountId: pos, toAccountId: central, amountXaf: 8_000 }),
      send(seller, { fromAccountId: pos, toAccountId: central, amountXaf: 8_000 }),
    ]);
    expect([codeOf(a.result), codeOf(b.result)].sort()).toEqual(['APPLIED', 'CASH_INSUFFICIENT']);
    expect(await balanceOf(pos)).toBe(2_000);

    await fund(idGenerator, central, 30_000, FUNDED_AT, root.userId);
    const [toCentral, toPos] = await Promise.all([
      send(seller, { fromAccountId: pos, toAccountId: central, amountXaf: 2_000 }),
      send(fin1, { fromAccountId: central, toAccountId: pos, amountXaf: 20_000 }),
    ]);
    expect(toCentral.result.status, JSON.stringify(toCentral.result)).toBe('APPLIED');
    expect(toPos.result.status, JSON.stringify(toPos.result)).toBe('APPLIED');
    await ledgerOk([pos, central], [a.id, b.id, toCentral.id, toPos.id]);
  });

  // --- Garde de désactivation, en transit, tâche ----------------------------------------------------------

  it('désactivation d’un compte avec une remise SENT entrante ou sortante : CASH_ACCOUNT_TRANSFER_IN_TRANSIT ; après réception et solde nul : appliquée', async () => {
    const { seller, pos } = await newPdv(30_000);
    const central = await newCentral();
    const { id } = await send(seller, {
      fromAccountId: pos,
      toAccountId: central,
      amountXaf: 30_000,
    });
    const deactivate = (accountId: string, occurredAt: string) =>
      runCommand(pipeline, fin1, {
        type: 'finance.cash_account.deactivate',
        aggregateType: 'CASH_ACCOUNT',
        aggregateId: accountId,
        occurredAt,
        payload: {},
      });
    expect(codeOf(await deactivate(central, at('18:30')))).toBe('CASH_ACCOUNT_TRANSFER_IN_TRANSIT');
    expect(codeOf(await deactivate(pos, at('18:30')))).toBe('CASH_ACCOUNT_TRANSFER_IN_TRANSIT');
    expect((await receive(fin1, id, 30_000)).status).toBe('APPLIED');
    expect((await deactivate(pos, at('19:30'))).status).toBe('APPLIED');
    expect(codeOf(await deactivate(central, at('19:30')))).toBe('CASH_ACCOUNT_NOT_EMPTY');
    const bank = await newAccount({ type: 'BANQUE', responsible: fin2.userId });
    const toBank = await send(
      fin1,
      { fromAccountId: central, toAccountId: bank, amountXaf: 30_000 },
      at('19:40'),
    );
    expect(codeOf(await deactivate(central, at('19:45')))).toBe('CASH_ACCOUNT_TRANSFER_IN_TRANSIT');
    expect((await receive(fin2, toBank.id, 30_000, at('19:50'))).status).toBe('APPLIED');
    expect((await deactivate(central, at('20:00'))).status).toBe('APPLIED');
    expect(await findCashAccount(db, central)).toMatchObject({ status: 'INACTIVE', balanceXaf: 0 });
  });

  it('en transit : 173 000 après l’envoi, retard au-delà de 48 h, 0 après la réception ou l’annulation', async () => {
    const { seller, pos } = await newPdv();
    const central = await newCentral();
    const old = await send(
      seller,
      { fromAccountId: pos, toAccountId: central, amountXaf: 173_000 },
      at('17:00', '2026-10-06'),
    );
    const fresh = await send(seller, {
      fromAccountId: pos,
      toAccountId: central,
      amountXaf: 2_000,
    });
    const now = new Date(at('18:00'));
    const transit = await cashTransfersInTransit(db, { now, accountIds: [central] });
    expect(transit).toMatchObject({
      count: 2,
      totalXaf: 175_000,
      unreceivedHours: 48,
      overdueCount: 1,
      overdueXaf: 173_000,
      outgoingByAccount: [{ accountId: pos, count: 2, totalXaf: 175_000 }],
      incomingByAccount: [{ accountId: central, count: 2, totalXaf: 175_000 }],
    });
    expect(transit.oldestSentAt?.toISOString()).toBe(at('17:00', '2026-10-06'));
    expect((await findCashTransfer(db, old.id))?.status).toBe('SENT');
    expect((await receive(fin1, old.id, 173_000)).status).toBe('APPLIED');
    expect((await cancel(seller, fresh.id, at('19:00'))).status).toBe('APPLIED');
    expect(await cashTransfersInTransit(db, { now, accountIds: [pos] })).toMatchObject({
      count: 0,
      totalXaf: 0,
      oldestSentAt: null,
    });
    expect(await cashTransfersInTransit(db, { now, accountIds: [] })).toMatchObject({ count: 0 });
  });

  it('tâche à 48 h : un CashTransferUnreceived par remise en retard et par jour métier ; rien pour une remise reçue ou récente', async () => {
    const { seller, pos } = await newPdv();
    const central = await newCentral();
    const late = await send(
      seller,
      { fromAccountId: pos, toAccountId: central, amountXaf: 11_000 },
      at('17:00', '2026-10-06'),
    );
    const receivedOld = await send(
      seller,
      { fromAccountId: pos, toAccountId: central, amountXaf: 12_000 },
      at('16:00', '2026-10-06'),
    );
    expect((await receive(fin1, receivedOld.id, 12_000, at('09:00', '2026-10-07'))).status).toBe(
      'APPLIED',
    );
    const recent = await send(
      seller,
      { fromAccountId: pos, toAccountId: central, amountXaf: 13_000 },
      at('10:00'),
    );
    const jobClock = new FixedClock(new Date(at('18:00'))); // 49 h après l'envoi tardif
    const jobs = new JobHandlerRegistry();
    new CashTransferUnreceivedJob(jobClock, new Uuidv7Generator(jobClock), jobs).onModuleInit();
    const runJob = () => tx((trx) => jobs.resolve(CASH_TRANSFER_UNRECEIVED_JOB_TYPE)!(trx, {}));
    await runJob();
    await runJob(); // rejeu le même jour métier : aucun doublon
    const events = await eventsOf(late.id, 'CashTransferUnreceived');
    expect(events).toHaveLength(1);
    expect(events[0]!.producer).toBe('finance');
    expect(events[0]!.payload).toMatchObject({
      transfer_id: late.id,
      amount_sent_xaf: 11_000,
      hours_elapsed: 49,
      unreceived_hours: 48,
      business_day: DAY,
      sent_by: seller.userId,
    });
    expect(await eventsOf(receivedOld.id, 'CashTransferUnreceived')).toHaveLength(0);
    expect(await eventsOf(recent.id, 'CashTransferUnreceived')).toHaveLength(0);
    expect(await transferRow(late.id)).toMatchObject({ status: 'SENT' });
    // Le lendemain, un nouvel événement.
    jobClock.setTo(new Date(at('08:00', '2026-10-09')));
    await runJob();
    expect(await eventsOf(late.id, 'CashTransferUnreceived')).toHaveLength(2);
  });

  it('cohérence : un mouvement de trop qui cite la remise est signalé (verifyCashTransfers)', async () => {
    const { seller, pos } = await newPdv();
    const central = await newCentral();
    const { id } = await send(seller, {
      fromAccountId: pos,
      toAccountId: central,
      amountXaf: 4_000,
    });
    expect((await receive(fin1, id, 4_000)).status).toBe('APPLIED');
    await withTestUow(async (trx) => {
      await recordCashMovement(
        trx,
        { idGenerator },
        {
          cashAccountId: central,
          direction: 'IN',
          amountXaf: 4_000,
          movementType: 'TRANSFER_IN',
          sourceDocType: 'CASH_TRANSFER',
          sourceDocId: id,
          occurredAt: new Date(at('19:30')),
          createdBy: fin1.userId,
          allowNegative: false,
        },
      );
      const result = await verifyCashTransfers(trx, { transferIds: [id] });
      expect(result.ok).toBe(false);
      expect(result.mismatches.map((m) => m.issue)).toEqual(['UNEXPECTED_MOVEMENT']);
    });
    await ledgerOk([pos, central], [id]);
    expect(await tx((trx) => verifyCashTransfers(trx, { transferIds: [] }))).toMatchObject({
      ok: true,
      transfersChecked: 0,
    });

    // Un écart en attente dont la demande n'est plus en attente (retrait forcé) est signalé.
    const pending = await send(seller, {
      fromAccountId: pos,
      toAccountId: central,
      amountXaf: 3_000,
    });
    expect((await receive(fin1, pending.id, 2_500)).status).toBe('APPLIED_WITH_WARNINGS');
    await withTestUow(async (trx) => {
      await trx
        .updateTable('approvals_approval_requests')
        .set({ status: 'CANCELLED' })
        .where('subject_id', '=', toBin(pending.id))
        .execute();
      const result = await verifyCashTransfers(trx, { transferIds: [pending.id] });
      expect(result.mismatches.map((m) => m.issue)).toEqual(['DISCREPANCY_REQUEST_MISMATCH']);
    });
    await ledgerOk([pos, central], [id, pending.id]);
  });
});
