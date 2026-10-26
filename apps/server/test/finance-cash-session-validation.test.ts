/**
 * P5-13 — validation et réévaluation des sessions de caisse (ADR-032 §5, §6 ; SM-CASH-SESSION ;
 * BR-DIS-007, BR-DIS-008 ; INV-FIN-05, INV-FIN-11 ; AV-155, AV-159, AV-183), à travers le vrai pipeline :
 * - clôture avec écart : demande `CASH_VARIANCE` (sujet : la session) ;
 * - `finance.cash_session.validate` en façade de la décision : en ligne, portée, valideur ni ouvreur ni
 *   clôtureur ni auteur de la clôture forcée, motif dès qu'un écart existe ; équivalence avec
 *   `approvals.request.approve` ; rejet et retrait refusés (AV-159) ;
 * - opération tardive dans la fenêtre d'une session close : ajustement du **delta**, mouvement
 *   compensatoire daté de la clôture, conflit `CASH_SESSION_REEVALUATED`, alerte `CashVarianceDetected`
 *   (phase `ADJUSTMENT`) ; ajustement inclus dans la validation d'une session `PENDING_VALIDATION`,
 *   demande propre sur une session `VALIDATED`, qui reste figée (INV-FIN-05) ;
 * - INV-FIN-11 après chaque réévaluation ; sans politique `CASH_VARIANCE`, validation directe (AV-183).
 *
 * Base partagée : chaque test crée son PDV ; journée fixe dans le passé (2026-10-05) ; la politique
 * `CASH_VARIANCE` du fichier est bornée à cette journée et neutralisée en fin de fichier.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import type { Transaction } from 'kysely';
import type { DB } from '../src/platform/kysely/database.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerAccountCommands } from '../src/modules/finance/application/commands/account-commands.js';
import { registerCashSessionCommands } from '../src/modules/finance/application/commands/cash-session-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { verifyCashSessionVariance } from '../src/modules/finance/application/cash-session-validation.js';
import {
  recordCashMovement,
  verifyCashLedger,
  type CashMovementType,
  type CashSourceDocType,
} from '../src/modules/finance/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestLocation,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
  neutralizePolicy,
  withoutActivePolicies,
} from './helpers.js';

const DAY = '2026-10-05';
const NOW = `${DAY}T21:00:00.000Z`;
const t = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

interface Pos {
  readonly siteId: string;
  readonly accountId: string;
  readonly vendor: string;
  readonly vendorDevice: string;
}

describe('P5-13 : validation et réévaluation des sessions de caisse', () => {
  let clock: FixedClock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: string;
  let adminDevice: string;
  let finance: string;
  let financeDevice: string;
  let validator: string;
  let validatorDevice: string;
  let vendorRole: string;
  let policyId: string;

  const tx = <T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> =>
    db.transaction().execute(fn);

  interface RunOptions {
    readonly occurredAt: string;
    readonly offline?: boolean;
    readonly aggregateType?: string;
  }

  const run = (
    author: string,
    device: string,
    type: string,
    aggregateId: string,
    payload: unknown,
    options: RunOptions,
  ): Promise<CommandResult> =>
    pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: 1,
        command_version: 1,
        author_user_id: author,
        base_version: null,
        depends_on: [],
        client_created_at: options.occurredAt,
        captured_offline: options.offline ?? false,
        backdated_reason: null,
        attachment_ids: [],
        command_type: type,
        aggregate_type: options.aggregateType ?? 'CASH_SESSION',
        aggregate_id: aggregateId,
        occurred_at: options.occurredAt,
        payload,
      },
      { authenticatedUserId: author, authenticatedDeviceId: device, transport: 'ONLINE_API' },
    );

  const codeOf = (result: CommandResult) =>
    result.status === 'REJECTED' ? result.error?.code : result.status;

  // --- Fixtures ------------------------------------------------------------------------------------

  async function newPos(): Promise<Pos> {
    const base = await tx(async (trx) => {
      const zone = await insertTestZone(trx, admin);
      const siteId = await insertTestSite(trx, admin, zone, { siteType: 'POINT_DE_VENTE' });
      await insertTestLocation(trx, admin, siteId, { locationType: 'POS' });
      const vendor = await insertTestUser(trx);
      const vendorDevice = await insertTestDevice(trx, vendor);
      await assignTestRole(trx, vendor, vendorRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteId,
      });
      return { siteId, vendor, vendorDevice };
    });
    const accountId = freshUuid();
    const created = await run(
      admin,
      adminDevice,
      'finance.cash_account.create',
      accountId,
      {
        code: `CPT-${accountId.slice(-12)}`,
        name: 'Caisse de test P5-13',
        accountType: 'CAISSE_PDV',
        responsibleUserId: admin,
        siteId: base.siteId,
      },
      { occurredAt: t('06:00'), aggregateType: 'CASH_ACCOUNT' },
    );
    expect(created.status, JSON.stringify(created)).toBe('APPLIED');
    return { ...base, accountId };
  }

  async function open(pos: Pos, countedXaf: number, at: string): Promise<string> {
    const sessionId = freshUuid();
    const result = await run(
      pos.vendor,
      pos.vendorDevice,
      'finance.cash_session.open',
      sessionId,
      { cashAccountId: pos.accountId, countedXaf },
      { occurredAt: at },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    return sessionId;
  }

  async function close(pos: Pos, sessionId: string, countedXaf: number, at: string) {
    const result = await run(
      pos.vendor,
      pos.vendorDevice,
      'finance.cash_session.close',
      sessionId,
      { countedXaf },
      { occurredAt: at },
    );
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
    return result;
  }

  const validate = (
    author: string,
    device: string,
    id: string,
    reason?: string,
    options: { offline?: boolean; at?: string } = {},
  ) =>
    run(
      author,
      device,
      'finance.cash_session.validate',
      id,
      reason !== undefined ? { reason } : {},
      { occurredAt: options.at ?? t('20:00'), offline: options.offline ?? false },
    );

  const decide = (
    type: 'approve' | 'reject' | 'withdraw',
    author: string,
    device: string,
    requestId: string,
    extra: Record<string, unknown> = {},
  ) =>
    run(
      author,
      device,
      `approvals.request.${type}`,
      requestId,
      { requestId, ...extra },
      { occurredAt: t('20:30'), aggregateType: 'APPROVAL_REQUEST' },
    );

  const RULES: Record<string, { direction: 'IN' | 'OUT'; source: CashSourceDocType }> = {
    CUSTOMER_PAYMENT: { direction: 'IN', source: 'CUSTOMER_PAYMENT' },
    REFUND: { direction: 'OUT', source: 'SALE_REFUND' },
  };

  /** Mouvement injecté dans le registre (un encaissement ou un remboursement synchronisé en retard). */
  async function movement(
    accountId: string,
    amountXaf: number,
    at: string,
    type: CashMovementType = 'CUSTOMER_PAYMENT',
    extra: { reversesMovementId?: string; sourceDocId?: string; createdBy?: string } = {},
  ) {
    const rule = RULES[type]!;
    return tx((trx) =>
      recordCashMovement(
        trx,
        { idGenerator },
        {
          cashAccountId: accountId,
          direction:
            extra.reversesMovementId !== undefined
              ? rule.direction === 'IN'
                ? 'OUT'
                : 'IN'
              : rule.direction,
          amountXaf,
          movementType: type,
          sourceDocType: rule.source,
          sourceDocId: extra.sourceDocId ?? freshUuid(),
          occurredAt: new Date(at),
          createdBy: extra.createdBy ?? admin,
          allowNegative: true,
          capturedOffline: true,
          ...(extra.reversesMovementId !== undefined
            ? { reversesMovementId: extra.reversesMovementId }
            : {}),
        },
      ),
    );
  }

  const session = (id: string) =>
    db
      .selectFrom('finance_cash_sessions')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();

  const adjustmentsOf = (sessionId: string) =>
    db
      .selectFrom('finance_cash_session_adjustments')
      .selectAll()
      .where('session_id', '=', toBin(sessionId))
      .orderBy('applied_at')
      .orderBy('id')
      .execute();

  const request = (requestId: Buffer | string) =>
    db
      .selectFrom('approvals_approval_requests')
      .selectAll()
      .where('id', '=', typeof requestId === 'string' ? toBin(requestId) : requestId)
      .executeTakeFirstOrThrow();

  async function events(sessionId: string, eventType: string) {
    const rows = await db
      .selectFrom('platform_domain_events')
      .select(['payload'])
      .where('event_type', '=', eventType)
      .where('aggregate_id', '=', toBin(sessionId))
      .orderBy('seq')
      .execute();
    return rows.map((row) => row.payload as Record<string, unknown>);
  }

  const conflicts = (sessionId: string) =>
    db
      .selectFrom('sync_sync_conflicts')
      .select(['details', 'owner_role', 'applied', 'entity_type'])
      .where('conflict_type', '=', 'CASH_SESSION_REEVALUATED')
      .where('entity_id', '=', toBin(sessionId))
      .orderBy('created_at')
      .execute();

  async function compensations(sessionId: string) {
    const rows = await db
      .selectFrom('finance_cash_movements')
      .select(['id', 'direction', 'amount_xaf', 'occurred_at', 'cash_session_id'])
      .where('movement_type', '=', 'SESSION_VARIANCE')
      .where('source_doc_type', '=', 'CASH_SESSION')
      .where('source_doc_id', '=', toBin(sessionId))
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
    return rows.map((row) => ({
      ...row,
      signed: row.direction === 'IN' ? Number(row.amount_xaf) : -Number(row.amount_xaf),
    }));
  }

  /** INV-FIN-11 : Σ des écarts de clôture et d'ajustement = compté − attendu courant (registre et lignes). */
  async function assertInvFin11(sessionId: string, expectedVarianceXaf: number): Promise<void> {
    const check = await tx((trx) => verifyCashSessionVariance(trx, sessionId));
    expect(check).toMatchObject({
      ok: true,
      countedMinusExpectedXaf: expectedVarianceXaf,
      postedMovementsXaf: expectedVarianceXaf,
      recordedVarianceXaf: expectedVarianceXaf,
    });
  }

  const ledgerOk = async (accountId: string) =>
    expect((await verifyCashLedger(db, { cashAccountIds: [accountId] })).ok).toBe(true);

  beforeAll(async () => {
    clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisionRegistry = new ApprovalDecisionHandlerRegistry();
    registerAccountCommands(registry);
    registerCashSessionCommands(registry, idGenerator, decisionRegistry);
    registerRequestCommands(registry, decisionRegistry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    await tx(async (trx) => {
      admin = await insertTestUser(trx);
      adminDevice = await insertTestDevice(trx, admin);
      const adminRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, adminRole, 'finance.cash_account.manage', admin);
      await assignTestRole(trx, admin, adminRole, admin);

      const financeRole = await insertTestRole(trx, admin);
      for (const code of [
        'finance.cash_session.operate',
        'finance.cash_session.validate',
        'approvals.request.read',
      ]) {
        await grantTestPermission(trx, financeRole, code, admin);
      }
      finance = await insertTestUser(trx);
      financeDevice = await insertTestDevice(trx, finance);
      await assignTestRole(trx, finance, financeRole, admin);
      validator = await insertTestUser(trx);
      validatorDevice = await insertTestDevice(trx, validator);
      await assignTestRole(trx, validator, financeRole, admin);

      vendorRole = await insertTestRole(trx, admin, { allowedScopeTypes: ['SITE'] });
      for (const code of ['finance.cash_session.operate', 'approvals.request.read']) {
        await grantTestPermission(trx, vendorRole, code, admin, { maxScope: 'SITE' });
      }

      // Politique CASH_VARIANCE du fichier, bornée à sa journée (base partagée, pièges du §1).
      policyId = freshUuid();
      await trx
        .insertInto('approvals_control_policies')
        .values({
          id: toBin(policyId),
          code: `CASH_VARIANCE_T_${policyId.slice(-8)}`,
          version: 1,
          operation_type: 'CASH_VARIANCE',
          condition: jsonValue({}),
          requires_photo: 0,
          requires_comment: 0,
          requires_approval: 1,
          approver_permission: 'finance.cash_session.validate',
          approver_scope: 'ALL',
          valid_from: new Date(`${DAY}T00:00:00.000Z`),
          valid_to: new Date(`${DAY}T23:59:59.000Z`),
          status: 'ACTIVE',
          created_by: toBin(admin),
        })
        .execute();
    });
  });

  afterAll(async () => {
    if (policyId) await neutralizePolicy(policyId);
    await closeTestDb();
  });

  // --- Validation -----------------------------------------------------------------------------------

  describe('validation (ADR-032 §5, AV-155, AV-159)', () => {
    it('clôture avec écart : demande CASH_VARIANCE ; façade validate en ligne, portée, valideur, motif, puis VALIDATED', async () => {
      const pos = await newPos();
      const sessionId = await open(pos, 10_000, t('08:00'));
      await movement(pos.accountId, 5_000, t('09:00'));
      const closed = await close(pos, sessionId, 14_500, t('18:00'));
      expect(closed.status).toBe('APPLIED');
      const row = await session(sessionId);
      expect(row.status).toBe('PENDING_VALIDATION');
      expect(Number(row.variance_xaf)).toBe(-500);
      const req = await request(row.approval_request_id!);
      expect(req).toMatchObject({
        operation_type: 'CASH_VARIANCE',
        subject_type: 'CASH_SESSION',
        status: 'PENDING',
      });
      expect(fromBin(req.policy_id!)).toBe(policyId);
      expect(fromBin(req.site_id!)).toBe(pos.siteId);

      // Hors ligne : la validation se fait en ligne.
      expect(
        codeOf(
          await validate(validator, validatorDevice, sessionId, 'Erreur de rendu', {
            offline: true,
          }),
        ),
      ).toBe('ONLINE_REQUIRED');
      // Le vendeur n'a pas le droit de valider.
      expect(codeOf(await validate(pos.vendor, pos.vendorDevice, sessionId, 'x'))).toMatch(
        /PERMISSION|FORBIDDEN/,
      );
      // Un valideur sans motif : refusé, l'écart exige un motif (BR-DIS-007).
      expect(codeOf(await validate(validator, validatorDevice, sessionId))).toBe('REASON_REQUIRED');
      expect((await session(sessionId)).status).toBe('PENDING_VALIDATION');

      const ok = await validate(
        validator,
        validatorDevice,
        sessionId,
        'Erreur de rendu de monnaie',
      );
      expect(ok.status, JSON.stringify(ok)).toBe('APPLIED');
      const after = await session(sessionId);
      expect(after.status).toBe('VALIDATED');
      expect(fromBin(after.validated_by!)).toBe(validator);
      expect(after.validated_at!.toISOString()).toBe(t('20:00'));
      expect(after.variance_reason).toBe('Erreur de rendu de monnaie');
      expect(Number(after.auto_validated)).toBe(0);
      const decided = await request(row.approval_request_id!);
      expect(decided.status).toBe('APPROVED');
      expect(fromBin(decided.decided_by!)).toBe(validator);
      const [validated] = await events(sessionId, 'CashSessionValidated');
      expect(validated).toMatchObject({
        session_id: sessionId,
        validated_by: validator,
        variance_xaf: -500,
      });

      // Rejouer la validation : la demande n'est plus en attente.
      expect(codeOf(await validate(validator, validatorDevice, sessionId, 'encore'))).toMatch(
        /APPROVAL_NOT_PENDING|CASH_SESSION_NOT_PENDING/,
      );
      await assertInvFin11(sessionId, -500);
      await ledgerOk(pos.accountId);
    });

    it('séparation des tâches : ni l’ouvreur ni l’auteur de la clôture forcée ne valident (AV-155)', async () => {
      const pos = await newPos();
      // Ouverture par la Finance (droit operate sur tout site), clôture par le vendeur.
      const sessionId = freshUuid();
      expect(
        (
          await run(
            finance,
            financeDevice,
            'finance.cash_session.open',
            sessionId,
            {
              cashAccountId: pos.accountId,
              countedXaf: 2_000,
            },
            { occurredAt: t('07:00') },
          )
        ).status,
      ).toBe('APPLIED');
      await close(pos, sessionId, 1_000, t('17:00'));
      expect(codeOf(await validate(finance, financeDevice, sessionId, 'Manque'))).toBe(
        'CASH_VALIDATOR_INVOLVED',
      );
      expect(
        (await validate(validator, validatorDevice, sessionId, 'Manque constaté')).status,
      ).toBe('APPLIED');

      // Clôture forcée par la Finance : elle est le demandeur, le valideur est un tiers.
      const pos2 = await newPos();
      const forcedId = await open(pos2, 0, `2026-10-04T06:00:00.000Z`);
      const forced = await run(
        finance,
        financeDevice,
        'finance.cash_session.force_close',
        forcedId,
        { countedXaf: 0, reason: 'Vendeur absent' },
        { occurredAt: t('07:30') },
      );
      expect(forced.status, JSON.stringify(forced)).toBe('APPLIED');
      expect((await session(forcedId)).status).toBe('PENDING_VALIDATION');
      expect(codeOf(await validate(finance, financeDevice, forcedId, 'ok'))).toMatch(
        /SELF_APPROVAL_FORBIDDEN|CASH_VALIDATOR_INVOLVED/,
      );
      // Clôture forcée sans écart : validée sans motif.
      expect((await validate(validator, validatorDevice, forcedId)).status).toBe('APPLIED');
      expect((await session(forcedId)).status).toBe('VALIDATED');
    });

    it('approvals.request.approve vaut la façade ; rejet et retrait refusés (AV-159)', async () => {
      const pos = await newPos();
      const sessionId = await open(pos, 3_000, t('08:00'));
      await close(pos, sessionId, 3_200, t('12:00'));
      const requestId = fromBin((await session(sessionId)).approval_request_id!);

      expect(
        codeOf(await decide('reject', validator, validatorDevice, requestId, { comment: 'Non' })),
      ).toBe('CASH_VARIANCE_NOT_REJECTABLE');
      expect(codeOf(await decide('withdraw', pos.vendor, pos.vendorDevice, requestId))).toBe(
        'CASH_VARIANCE_NOT_WITHDRAWABLE',
      );
      // Approbation directe sans motif : refusée par le gestionnaire du module propriétaire.
      expect(codeOf(await decide('approve', validator, validatorDevice, requestId))).toBe(
        'REASON_REQUIRED',
      );
      const ok = await decide('approve', validator, validatorDevice, requestId, {
        decisionData: { reason: 'Excédent : pourboire déposé en caisse' },
      });
      expect(ok.status, JSON.stringify(ok)).toBe('APPLIED');
      const row = await session(sessionId);
      expect(row.status).toBe('VALIDATED');
      expect(row.variance_reason).toBe('Excédent : pourboire déposé en caisse');
      expect((await request(requestId)).status).toBe('APPROVED');
    });
  });

  // --- Réévaluation ---------------------------------------------------------------------------------

  describe('réévaluation par le delta (ADR-032 §6, BR-DIS-008, INV-FIN-11)', () => {
    it('session PENDING_VALIDATION : ajustements inclus, compensation datée de la clôture, conflit, validation commune', async () => {
      const pos = await newPos();
      const sessionId = await open(pos, 10_000, t('08:00'));
      await movement(pos.accountId, 5_000, t('09:00'));
      await close(pos, sessionId, 14_000, t('18:00'));
      expect(Number((await session(sessionId)).variance_xaf)).toBe(-1_000);
      await assertInvFin11(sessionId, -1_000);

      // Encaissement de 1 000 saisi hors ligne à 10 h, synchronisé après la clôture.
      const late = await movement(pos.accountId, 1_000, t('10:00'), 'CUSTOMER_PAYMENT', {
        createdBy: pos.vendor,
      });
      expect(late.reevaluation).toMatchObject({
        sessionId,
        deltaXaf: -1_000,
        treatment: 'INCLUDED_IN_VALIDATION',
        approvalRequestId: null,
      });
      let [first] = await adjustmentsOf(sessionId);
      expect(first).toMatchObject({
        cause: 'LATE_OPERATION',
        treatment: 'INCLUDED_IN_VALIDATION',
        status: 'PENDING',
        approval_request_id: null,
      });
      expect(Number(first!.variance_before_xaf)).toBe(-1_000);
      expect(Number(first!.variance_after_xaf)).toBe(-2_000);
      expect(Number(first!.delta_xaf)).toBe(-1_000);
      expect(Number(first!.expected_after_xaf)).toBe(16_000);
      expect(fromBin(first!.trigger_movement_id!)).toBe(late.movementId);
      const comp = await compensations(sessionId);
      const adjustmentMovement = comp.find((m) => fromBin(m.id) === fromBin(first!.movement_id))!;
      expect(adjustmentMovement.signed).toBe(-1_000);
      expect(adjustmentMovement.occurred_at.toISOString()).toBe(t('18:00'));
      expect(fromBin(adjustmentMovement.cash_session_id!)).toBe(sessionId);
      const [conflict] = await conflicts(sessionId);
      expect(conflict).toMatchObject({
        owner_role: 'FINANCE',
        applied: 1,
        entity_type: 'CASH_SESSION',
      });
      expect(conflict!.details).toMatchObject({
        deltaXaf: -1_000,
        treatment: 'INCLUDED_IN_VALIDATION',
      });
      const alerts = await events(sessionId, 'CashVarianceDetected');
      expect(alerts.at(-1)).toMatchObject({
        phase: 'ADJUSTMENT',
        variance_xaf: -1_000,
        variance_after_xaf: -2_000,
      });
      await assertInvFin11(sessionId, -2_000);

      // Remboursement de 500 à 11 h, lui aussi tardif : delta +500 (le manque se réduit).
      const refund = await movement(pos.accountId, 500, t('11:00'), 'REFUND');
      expect(refund.reevaluation).toMatchObject({ deltaXaf: 500 });
      await assertInvFin11(sessionId, -1_500);
      // Le statut et la clôture de la session n'ont pas bougé.
      const row = await session(sessionId);
      expect(row.status).toBe('PENDING_VALIDATION');
      expect(Number(row.variance_xaf)).toBe(-1_000);
      expect(Number(row.closing_expected_xaf)).toBe(15_000);

      // Une seule validation couvre la session et ses deux ajustements.
      expect(
        (await validate(validator, validatorDevice, sessionId, 'Ventes tardives et remboursement'))
          .status,
      ).toBe('APPLIED');
      const adjustments = await adjustmentsOf(sessionId);
      expect(adjustments).toHaveLength(2);
      for (const adjustment of adjustments) {
        expect(adjustment.status).toBe('VALIDATED');
        expect(fromBin(adjustment.validated_by!)).toBe(validator);
      }
      const [validated] = await events(sessionId, 'CashSessionValidated');
      expect(validated).toMatchObject({
        included_adjustments: 2,
        included_delta_xaf: -500,
        variance_xaf: -1_500,
      });
      // Un ajustement inclus ne se valide pas à part.
      expect(
        codeOf(await validate(validator, validatorDevice, fromBin(adjustments[0]!.id), 'x')),
      ).toBe('CASH_SESSION_ADJUSTMENT_NOT_PENDING');
      await ledgerOk(pos.accountId);
    });

    it('session VALIDATED : figée (INV-FIN-05), ajustement à demande propre validé à part', async () => {
      const pos = await newPos();
      // Fonds d'ouverture = solde du registre (0) : aucun écart d'ouverture, validation d'office.
      const sessionId = await open(pos, 0, t('08:00'));
      await close(pos, sessionId, 0, t('18:00'));
      const frozen = await session(sessionId);
      expect(frozen).toMatchObject({ status: 'VALIDATED', auto_validated: 1 });

      // Opération tardive saisie par la Finance elle-même : elle en est la demanderesse.
      const late = await movement(pos.accountId, 2_000, t('12:00'), 'CUSTOMER_PAYMENT', {
        createdBy: finance,
      });
      expect(late.reevaluation).toMatchObject({ deltaXaf: -2_000, treatment: 'OWN_APPROVAL' });
      const [adjustment] = await adjustmentsOf(sessionId);
      expect(adjustment).toMatchObject({ treatment: 'OWN_APPROVAL', status: 'PENDING' });
      const req = await request(adjustment!.approval_request_id!);
      expect(req).toMatchObject({
        operation_type: 'CASH_VARIANCE',
        subject_type: 'CASH_SESSION_ADJUSTMENT',
        status: 'PENDING',
      });
      expect(fromBin(req.subject_id)).toBe(fromBin(adjustment!.id));
      expect(Number(req.amount_xaf)).toBe(2_000);
      // INV-FIN-05 : la session validée n'a pas changé.
      expect(await session(sessionId)).toEqual(frozen);
      await assertInvFin11(sessionId, -2_000);

      const adjustmentId = fromBin(adjustment!.id);
      // L'auteur de l'opération tardive ne valide pas son propre ajustement.
      expect(codeOf(await validate(finance, financeDevice, adjustmentId, 'x'))).toMatch(
        /SELF_APPROVAL_FORBIDDEN|CASH_VALIDATOR_INVOLVED/,
      );
      expect(
        codeOf(
          await decide('reject', validator, validatorDevice, fromBin(req.id), { comment: 'Non' }),
        ),
      ).toBe('CASH_VARIANCE_NOT_REJECTABLE');
      expect(codeOf(await validate(validator, validatorDevice, adjustmentId))).toBe(
        'REASON_REQUIRED',
      );
      expect(
        (await validate(validator, validatorDevice, adjustmentId, 'Vente hors ligne tardive'))
          .status,
      ).toBe('APPLIED');
      const [validatedAdjustment] = await adjustmentsOf(sessionId);
      expect(validatedAdjustment).toMatchObject({
        status: 'VALIDATED',
        variance_reason: 'Vente hors ligne tardive',
      });
      expect((await request(req.id)).status).toBe('APPROVED');
      expect(await session(sessionId)).toEqual(frozen);
      const [event] = await events(sessionId, 'CashSessionValidated');
      expect(event).toMatchObject({ adjustment_id: adjustmentId, variance_xaf: -2_000 });
      await ledgerOk(pos.accountId);
    });

    it('P9-07 : un ajustement validé alors que d’autres attendent — l’écart restant cumulé est signalé de nouveau, jamais perdu', async () => {
      const pos = await newPos();
      const sessionId = await open(pos, 0, t('08:00'));
      await close(pos, sessionId, 0, t('18:00'));
      const first = await movement(pos.accountId, 2_000, t('12:00'), 'CUSTOMER_PAYMENT', {
        createdBy: finance,
      });
      const second = await movement(pos.accountId, 700, t('13:00'), 'CUSTOMER_PAYMENT', {
        createdBy: pos.vendor,
      });
      const third = await movement(pos.accountId, 300, t('14:00'), 'CUSTOMER_PAYMENT', {
        createdBy: pos.vendor,
      });
      for (const [late, delta] of [
        [first, -2_000],
        [second, -700],
        [third, -300],
      ] as const) {
        expect(late.reevaluation).toMatchObject({ treatment: 'OWN_APPROVAL', deltaXaf: delta });
      }
      expect(await events(sessionId, 'CashVarianceDetected')).toHaveLength(3);

      const approve = async (adjustmentId: string, reason: string) =>
        (await validate(validator, validatorDevice, adjustmentId, reason)).status;

      // Validation du premier : `CashSessionValidated` ferme l'alerte de la session ; les deux autres,
      // encore en attente, sont signalés de nouveau (écart restant cumulé, dernier ajustement cité).
      expect(await approve(first.reevaluation!.adjustmentId, 'Vente hors ligne tardive')).toBe(
        'APPLIED',
      );
      const afterFirst = await events(sessionId, 'CashVarianceDetected');
      expect(afterFirst).toHaveLength(4);
      expect(afterFirst[3]).toMatchObject({
        phase: 'ADJUSTMENT',
        cause: 'REMAINING_ADJUSTMENTS',
        variance_xaf: -1_000,
        adjustment_id: third.reevaluation!.adjustmentId,
        treatment: 'OWN_APPROVAL',
      });
      const order = await db
        .selectFrom('platform_domain_events')
        .select(['event_type', 'seq'])
        .where('aggregate_id', '=', toBin(sessionId))
        .where('event_type', 'in', ['CashSessionValidated', 'CashVarianceDetected'])
        .orderBy('seq')
        .execute();
      expect(order.map((row) => row.event_type).slice(-2)).toEqual([
        'CashSessionValidated',
        'CashVarianceDetected',
      ]);

      // Validation du deuxième : il ne reste que le dernier.
      expect(await approve(second.reevaluation!.adjustmentId, 'Seconde vente tardive')).toBe(
        'APPLIED',
      );
      const afterSecond = await events(sessionId, 'CashVarianceDetected');
      expect(afterSecond).toHaveLength(5);
      expect(afterSecond[4]).toMatchObject({
        cause: 'REMAINING_ADJUSTMENTS',
        variance_xaf: -300,
        adjustment_id: third.reevaluation!.adjustmentId,
      });

      // Validation du dernier : plus rien n'attend, aucun nouveau signalement.
      expect(await approve(third.reevaluation!.adjustmentId, 'Troisième vente tardive')).toBe(
        'APPLIED',
      );
      expect(await events(sessionId, 'CashVarianceDetected')).toHaveLength(5);
      expect(await events(sessionId, 'CashSessionValidated')).toHaveLength(3);
      await ledgerOk(pos.accountId);
    });

    it('inverse d’un encaissement de la fenêtre : cause REVERSAL ; mouvement à la clôture ou session ouverte : aucun ajustement', async () => {
      const pos = await newPos();
      const sessionId = await open(pos, 0, t('08:00'));
      const paymentId = freshUuid();
      const paid = await movement(pos.accountId, 3_000, t('09:00'), 'CUSTOMER_PAYMENT', {
        sourceDocId: paymentId,
      });
      await close(pos, sessionId, 3_000, t('18:00'));
      expect(Number((await session(sessionId)).variance_xaf)).toBe(0);
      expect((await session(sessionId)).status).toBe('VALIDATED');

      // L'inverse porte la date de l'original : il retombe dans la session close (ADR-032 §2).
      const reversed = await movement(pos.accountId, 3_000, t('09:00'), 'CUSTOMER_PAYMENT', {
        reversesMovementId: paid.movementId,
        sourceDocId: paymentId,
        createdBy: pos.vendor,
      });
      expect(reversed.reevaluation).toMatchObject({ deltaXaf: 3_000, treatment: 'OWN_APPROVAL' });
      expect((await adjustmentsOf(sessionId))[0]).toMatchObject({ cause: 'REVERSAL' });
      await assertInvFin11(sessionId, 3_000);

      // À l'heure exacte de la clôture : hors de la fenêtre [ouverture, clôture[.
      const atClose = await movement(pos.accountId, 700, t('18:00'));
      expect(atClose.reevaluation).toBeNull();
      // Session encore ouverte (autre PDV) : l'opération entre simplement dans l'attendu futur.
      const pos2 = await newPos();
      const next = await open(pos2, 0, t('08:00'));
      const inOpen = await movement(pos2.accountId, 400, t('09:00'));
      expect(inOpen.reevaluation).toBeNull();
      expect(await adjustmentsOf(next)).toHaveLength(0);
      expect(await adjustmentsOf(sessionId)).toHaveLength(1);
    });

    it('réévaluations concurrentes d’une même session : sérialisées par le compte, aucun delta compté deux fois', async () => {
      const pos = await newPos();
      const sessionId = await open(pos, 0, t('08:00'));
      await close(pos, sessionId, 0, t('18:00'));
      const results = await Promise.all(
        [100, 200, 300, 400].map((amount, i) =>
          movement(pos.accountId, amount, t(`1${i}:00`), 'CUSTOMER_PAYMENT', {
            createdBy: pos.vendor,
          }),
        ),
      );
      expect(results.every((r) => r.reevaluation !== null)).toBe(true);
      const adjustments = await adjustmentsOf(sessionId);
      expect(adjustments).toHaveLength(4);
      expect(adjustments.reduce((sum, a) => sum + Number(a.delta_xaf), 0)).toBe(-1_000);
      await assertInvFin11(sessionId, -1_000);
    });
  });

  // --- Sans politique (AV-183) ------------------------------------------------------------------------

  it('sans politique CASH_VARIANCE active : clôture sans demande, validation directe de la session et de l’ajustement (AV-183)', async () => {
    const pos = await newPos();
    const sessionId = await open(pos, 5_000, t('08:00'));
    const { adjustmentId } = await withoutActivePolicies(
      'CASH_VARIANCE',
      new Date(`${DAY}T00:00:00.000Z`),
      async () => {
        await close(pos, sessionId, 4_800, t('18:00'));
        expect((await session(sessionId)).approval_request_id).toBeNull();
        expect(
          (await validate(validator, validatorDevice, sessionId, 'Manque de 200')).status,
        ).toBe('APPLIED');
        expect((await session(sessionId)).status).toBe('VALIDATED');
        const late = await movement(pos.accountId, 300, t('10:00'), 'CUSTOMER_PAYMENT', {
          createdBy: pos.vendor,
        });
        expect(late.reevaluation).toMatchObject({
          treatment: 'OWN_APPROVAL',
          approvalRequestId: null,
        });
        return { adjustmentId: late.reevaluation!.adjustmentId };
      },
    );
    expect((await validate(validator, validatorDevice, adjustmentId, 'Vente tardive')).status).toBe(
      'APPLIED',
    );
    expect((await adjustmentsOf(sessionId))[0]).toMatchObject({ status: 'VALIDATED' });
    await assertInvFin11(sessionId, -500);
  });
});
