/**
 * Validation et réévaluation des sessions de caisse (P5-13 ; ADR-032 §5, §6, §10 ; SM-CASH-SESSION ;
 * BR-DIS-007, BR-DIS-008 ; INV-FIN-05, INV-FIN-11 ; AV-155, AV-159, AV-183).
 *
 * - **Demande `CASH_VARIANCE`** : une session close en `PENDING_VALIDATION` porte une demande de
 *   validation (sujet `CASH_SESSION`) ; un ajustement d'une session `VALIDATED` porte la sienne (sujet
 *   `CASH_SESSION_ADJUSTMENT`, la contrainte « une demande en attente par sujet » interdisant de
 *   réutiliser celle de la session). Sans politique `CASH_VARIANCE` active, aucune demande n'est
 *   créée et la validation se fait directement par `finance.cash_session.validate` (AV-183) : une
 *   clôture, souvent hors ligne, n'est jamais refusée pour une configuration (BR-SYN-007).
 * - **Validation** : acceptation seule (AV-159, aucun refus ni recomptage) ; valideur ni ouvreur, ni
 *   clôtureur, ni auteur de la clôture forcée (AV-155) — pour un ajustement, ni non plus l'auteur de
 *   l'opération tardive ; motif obligatoire dès qu'un écart existe (BR-DIS-007). Les ajustements
 *   inclus (`INCLUDED_IN_VALIDATION`) sont validés avec la session. Une session `VALIDATED` est figée
 *   (INV-FIN-05) : seuls ses ajustements évoluent.
 * - **Réévaluation par le delta** (ADR-032 §6) : une opération tardive dont l'`occurred_at` tombe dans
 *   la fenêtre d'une session close recalcule l'attendu ; le mouvement compensatoire `SESSION_VARIANCE`
 *   vaut nouvel écart − Σ des écarts déjà posés (clôture et ajustements), daté de la clôture de la
 *   session (comme l'écart de clôture, hors de toute fenêtre d'attendu) ; une ligne d'ajustement
 *   l'accompagne, avec le conflit `CASH_SESSION_REEVALUATED` pour la Finance. INV-FIN-11 : Σ signée des
 *   écarts de clôture et d'ajustement = compté − attendu courant.
 * - **Verrous** (ADR-032 §10) : compte de trésorerie, puis session, puis ajustement ; la réévaluation
 *   s'exécute dans `recordCashMovement`, qui tient déjà le compte.
 */
import {
  adjustmentTreatment,
  isAllowedCashValidator,
  reevaluationDeltaXaf,
  varianceMovement,
  varianceSeverity,
  type IdGenerator,
} from '@gic/domain';
import { sql } from 'kysely';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import {
  fromBin,
  fromBinOrNull,
  toBin,
  toBinOrNull,
} from '../../../platform/kysely/uuid-columns.js';
import { recordConflict } from '../../../platform/sync/conflicts.js';
import {
  ApprovalDecisionRefused,
  currentPolicies,
  requestApproval,
  type ActiveControlPolicy,
  type ApprovalDecisionHandlerRegistry,
} from '../../approvals/application/public/index.js';
import {
  cashSetting,
  expectedAtClose,
  loadCashSession,
  lockCashAccount,
  type CashSessionRow,
} from './cash-session-ledger.js';
import { publishCashSessionEvent } from './cash-session-events.js';
import { emitCashSessionChange } from './sync-changes.js';

type Deps = { readonly idGenerator: IdGenerator };

/**
 * Zone du site d'une session (portée de la demande, BR-ADM-018). Lecture locale plutôt que l'aide des
 * remises (`cash-transfer-support.ts`), qui importe `recordCashMovement` : la réévaluation est appelée
 * par celui-ci, un import croisé formerait un cycle.
 */
async function siteZoneOf(uow: UnitOfWork, siteId: string): Promise<string | undefined> {
  const row = await uow
    .selectFrom('organization_sites')
    .select('zone_id')
    .where('id', '=', toBin(siteId))
    .executeTakeFirst();
  return row ? fromBin(row.zone_id) : undefined;
}

export const CASH_SESSION_REEVALUATED = 'CASH_SESSION_REEVALUATED';

/** Refus d'une validation : code et message, sans aucune écriture. */
export interface CashValidationRefusal {
  readonly errorCode: string;
  readonly messageFr: string;
}

const refusal = (errorCode: string, messageFr: string): CashValidationRefusal => ({
  errorCode,
  messageFr,
});

// --- Demande de validation ------------------------------------------------------------------------------

/** Politique `CASH_VARIANCE` applicable : validation requise et approbateur désigné. */
export async function cashVariancePolicy(
  uow: UnitOfWork,
  at: Date,
  fallbackAt?: Date,
): Promise<ActiveControlPolicy | undefined> {
  const pick = async (instant: Date) =>
    (await currentPolicies(uow, 'CASH_VARIANCE', instant)).find(
      (policy) => policy.requiresApproval && policy.approverPermission !== null,
    );
  const policy = await pick(at);
  if (policy !== undefined || fallbackAt === undefined) return policy;
  return pick(fallbackAt);
}

/**
 * Crée la demande `CASH_VARIANCE` d'une session ou d'un ajustement ; `null` sans politique active
 * (AV-183 : la validation directe par `finance.cash_session.validate` prend alors le relais).
 */
export async function requestCashVarianceValidation(
  uow: UnitOfWork,
  deps: Deps,
  input: {
    readonly subjectType: 'CASH_SESSION' | 'CASH_SESSION_ADJUSTMENT';
    readonly subjectId: string;
    readonly siteId: string;
    readonly amountXaf: number;
    readonly summary: string;
    readonly requestedBy: string;
    readonly requestedAt: Date;
    /** Instant de repli pour la politique (réception d'un fait hors ligne), comme les remises. */
    readonly policyFallbackAt?: Date;
  },
): Promise<string | null> {
  const policy = await cashVariancePolicy(uow, input.requestedAt, input.policyFallbackAt);
  if (!policy) return null;
  const zoneId = await siteZoneOf(uow, input.siteId);
  const requestId = deps.idGenerator.newId();
  await requestApproval(uow, {
    requestId,
    operationType: 'CASH_VARIANCE',
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    subjectSummary: input.summary,
    siteId: input.siteId,
    ...(zoneId !== undefined ? { zoneId } : {}),
    ...(input.amountXaf > 0 ? { amountXaf: input.amountXaf } : {}),
    requestedBy: input.requestedBy,
    requestedAt: input.requestedAt,
    policyId: policy.id,
    policyVersion: policy.version,
  });
  return requestId;
}

// --- Écarts déjà posés et INV-FIN-11 -------------------------------------------------------------------------

/** Σ signée des écarts de clôture et d'ajustement d'une session close (ADR-032 §6). */
export async function postedVarianceXaf(uow: UnitOfWork, session: CashSessionRow): Promise<number> {
  const row = await uow
    .selectFrom('finance_cash_session_adjustments')
    .select(sql<string | null>`SUM(delta_xaf)`.as('total'))
    .where('session_id', '=', toBin(session.id))
    // Lecture verrouillante : un ajustement concurrent déjà validé doit être compté (le compte, verrouillé
    // par l'appelant, sérialise les réévaluations d'une session ; l'instantané peut lui être antérieur).
    .forShare()
    .executeTakeFirst();
  return (session.varianceXaf ?? 0) + Number(row?.total ?? 0);
}

/**
 * INV-FIN-11 pour une session close : Σ signée des mouvements `SESSION_VARIANCE` de clôture et
 * d'ajustement (ceux qui citent la session, hors l'écart d'ouverture, posé à `opened_at` par sa
 * commande d'ouverture) = compté − attendu courant ; et ces mouvements correspondent aux écarts
 * enregistrés (session et ajustements). Sert aux tests et, en P5-22, à la réconciliation quotidienne.
 */
export async function verifyCashSessionVariance(
  uow: UnitOfWork,
  sessionId: string,
): Promise<{
  readonly ok: boolean;
  readonly countedMinusExpectedXaf: number;
  readonly postedMovementsXaf: number;
  readonly recordedVarianceXaf: number;
}> {
  const session = await loadCashSession(uow, sessionId);
  if (!session || session.closedAt === null || session.closingCountedXaf === null) {
    throw new Error(`INV-FIN-11 : session ${sessionId} absente ou encore ouverte.`);
  }
  const expected = await expectedAtClose(uow, {
    cashAccountId: session.cashAccountId,
    openingCountedXaf: session.openingCountedXaf,
    openedAt: session.openedAt,
    closedAt: session.closedAt,
  });
  const openingMovement = await uow
    .selectFrom('finance_cash_sessions')
    .select('command_id')
    .where('id', '=', toBin(session.id))
    .executeTakeFirstOrThrow();
  const rows = await uow
    .selectFrom('finance_cash_movements')
    .select(['direction', 'amount_xaf', 'command_id', 'occurred_at'])
    .where('cash_account_id', '=', toBin(session.cashAccountId))
    .where('movement_type', '=', 'SESSION_VARIANCE')
    .where('source_doc_type', '=', 'CASH_SESSION')
    .where('source_doc_id', '=', toBin(session.id))
    .execute();
  const openingCommand = fromBinOrNull(openingMovement.command_id);
  const postedMovementsXaf = rows
    // L'écart d'ouverture est posé par la commande d'ouverture, à `opened_at` ; à défaut de commande,
    // tout écart antérieur à la clôture est celui de l'ouverture (clôture et ajustements sont à `closed_at`).
    .filter((row) =>
      openingCommand !== null
        ? fromBinOrNull(row.command_id) !== openingCommand
        : row.occurred_at.getTime() >= session.closedAt!.getTime(),
    )
    .reduce(
      (sum, row) =>
        sum + (row.direction === 'IN' ? Number(row.amount_xaf) : -Number(row.amount_xaf)),
      0,
    );
  const recordedVarianceXaf = await postedVarianceXaf(uow, session);
  const countedMinusExpectedXaf = session.closingCountedXaf - expected;
  return {
    ok:
      postedMovementsXaf === countedMinusExpectedXaf &&
      recordedVarianceXaf === countedMinusExpectedXaf,
    countedMinusExpectedXaf,
    postedMovementsXaf,
    recordedVarianceXaf,
  };
}

// --- Réévaluation ----------------------------------------------------------------------------------------------

/** Écriture d'un mouvement de trésorerie (`recordCashMovement`, passé par l'appelant : aucun cycle). */
export type PostCashMovement = (
  uow: UnitOfWork,
  deps: Deps,
  input: {
    readonly cashAccountId: string;
    readonly direction: 'IN' | 'OUT';
    readonly amountXaf: number;
    readonly movementType: 'SESSION_VARIANCE';
    readonly sourceDocType: 'CASH_SESSION';
    readonly sourceDocId: string;
    readonly cashSessionId: string;
    readonly occurredAt: Date;
    readonly createdBy: string;
    readonly createdDeviceId?: string;
    readonly commandId?: string;
    readonly capturedOffline?: boolean;
    readonly allowNegative: boolean;
    readonly pastFact?: boolean;
  },
) => Promise<{ readonly movementId: string }>;

export interface CashSessionReevaluation {
  readonly sessionId: string;
  readonly adjustmentId: string;
  readonly deltaXaf: number;
  readonly treatment: 'INCLUDED_IN_VALIDATION' | 'OWN_APPROVAL';
  readonly approvalRequestId: string | null;
}

/**
 * Réaction à un mouvement tardif d'une caisse de PDV (ADR-032 §6) : si son `occurred_at` tombe dans
 * la fenêtre d'une session close, pose l'ajustement du delta. Appelé par `recordCashMovement` après
 * l'insertion du mouvement déclencheur (compte déjà verrouillé), jamais pour un `SESSION_VARIANCE` ni
 * un `OPENING_BALANCE`. Renvoie `null` si la session est ouverte, absente, ou si l'écart ne change pas.
 */
export async function reevaluateClosedSession(
  uow: UnitOfWork,
  deps: Deps,
  trigger: {
    readonly movementId: string;
    readonly cashAccountId: string;
    readonly occurredAt: Date;
    readonly isReversal: boolean;
    readonly createdBy: string;
    readonly createdDeviceId?: string;
    readonly commandId?: string;
    readonly capturedOffline: boolean;
  },
  post: PostCashMovement,
): Promise<CashSessionReevaluation | null> {
  const covering = await uow
    .selectFrom('finance_cash_sessions')
    .select('id')
    .where('cash_account_id', '=', toBin(trigger.cashAccountId))
    .where('opened_at', '<=', trigger.occurredAt)
    .where('closed_at', '>', trigger.occurredAt)
    .where('status', '<>', 'OPEN')
    .orderBy('opened_at', 'desc')
    .limit(1)
    // Lecture verrouillante partagée (comme l'index de `recordCashMovement`, déjà tenu) : l'instantané
    // de la transaction peut précéder le verrou du compte. La session est ensuite verrouillée par clé.
    .forShare()
    .executeTakeFirst();
  if (!covering) return null;
  const session = (await loadCashSession(uow, fromBin(covering.id), { lock: true }))!;
  if (
    session.status === 'OPEN' ||
    session.closedAt === null ||
    session.closingCountedXaf === null
  ) {
    return null;
  }

  const expectedAfterXaf = await expectedAtClose(uow, {
    cashAccountId: session.cashAccountId,
    openingCountedXaf: session.openingCountedXaf,
    openedAt: session.openedAt,
    closedAt: session.closedAt,
  });
  const varianceBeforeXaf = await postedVarianceXaf(uow, session);
  const deltaXaf = reevaluationDeltaXaf({
    countedXaf: session.closingCountedXaf,
    expectedXaf: expectedAfterXaf,
    postedVarianceXaf: varianceBeforeXaf,
  });
  if (deltaXaf === 0) return null;
  const varianceAfterXaf = varianceBeforeXaf + deltaXaf;
  const treatment = adjustmentTreatment(session.status) as CashSessionReevaluation['treatment'];

  const { amount, direction } = varianceMovement(deltaXaf);
  const compensation = await post(uow, deps, {
    cashAccountId: session.cashAccountId,
    direction,
    amountXaf: amount,
    movementType: 'SESSION_VARIANCE',
    sourceDocType: 'CASH_SESSION',
    sourceDocId: session.id,
    cashSessionId: session.id,
    occurredAt: session.closedAt,
    createdBy: trigger.createdBy,
    ...(trigger.createdDeviceId !== undefined ? { createdDeviceId: trigger.createdDeviceId } : {}),
    ...(trigger.commandId !== undefined ? { commandId: trigger.commandId } : {}),
    capturedOffline: trigger.capturedOffline,
    allowNegative: true,
    pastFact: true,
  });

  const adjustmentId = deps.idGenerator.newId();
  const approvalRequestId =
    treatment === 'OWN_APPROVAL'
      ? await requestCashVarianceValidation(uow, deps, {
          subjectType: 'CASH_SESSION_ADJUSTMENT',
          subjectId: adjustmentId,
          siteId: session.siteId,
          amountXaf: Math.abs(deltaXaf),
          summary:
            `Ajustement de la session de caisse du ${session.openedAt.toISOString().slice(0, 10)} : ` +
            `opération tardive, écart ${varianceBeforeXaf} → ${varianceAfterXaf} XAF (delta ${deltaXaf} XAF)`,
          requestedBy: trigger.createdBy,
          requestedAt: trigger.occurredAt,
          policyFallbackAt: new Date(),
        })
      : null;
  await uow
    .insertInto('finance_cash_session_adjustments')
    .values({
      id: toBin(adjustmentId),
      session_id: toBin(session.id),
      movement_id: toBin(compensation.movementId),
      trigger_movement_id: toBin(trigger.movementId),
      cause: trigger.isReversal ? 'REVERSAL' : 'LATE_OPERATION',
      variance_before_xaf: varianceBeforeXaf,
      variance_after_xaf: varianceAfterXaf,
      delta_xaf: deltaXaf,
      expected_after_xaf: expectedAfterXaf,
      treatment,
      status: 'PENDING',
      applied_at: sql<Date>`CURRENT_TIMESTAMP(6)`,
      approval_request_id: toBinOrNull(approvalRequestId),
      command_id: toBinOrNull(trigger.commandId ?? null),
      created_by: toBin(trigger.createdBy),
    })
    .execute();
  // P5-18 : la session à valider est republiée avec son écart courant (jeu `cash`, AV-193) ; une
  // session validée est déjà sortie du jeu.
  if (session.status === 'PENDING_VALIDATION') await emitCashSessionChange(uow, session.id);

  const details = {
    adjustmentId,
    triggerMovementId: trigger.movementId,
    cause: trigger.isReversal ? 'REVERSAL' : 'LATE_OPERATION',
    triggerOccurredAt: trigger.occurredAt.toISOString(),
    sessionStatus: session.status,
    treatment,
    varianceBeforeXaf,
    varianceAfterXaf,
    deltaXaf,
    expectedAfterXaf,
    approvalRequestId,
    capturedOffline: trigger.capturedOffline,
    deviceId: trigger.createdDeviceId ?? null,
    authorUserId: trigger.createdBy,
  };
  await recordConflict(uow, {
    id: deps.idGenerator.newId(),
    commandId: trigger.commandId ?? null,
    conflictType: CASH_SESSION_REEVALUATED,
    entityType: 'CASH_SESSION',
    entityId: session.id,
    siteId: session.siteId,
    ownerRole: 'FINANCE',
    applied: true,
    details,
  });
  const criticalXaf = await cashSetting(
    uow,
    'varianceCriticalXaf',
    session.siteId,
    session.closedAt,
  );
  await publishCashSessionEvent(uow, deps, {
    eventType: 'CashVarianceDetected',
    sessionId: session.id,
    occurredAt: trigger.occurredAt,
    commandId: trigger.commandId ?? null,
    payload: {
      session_id: session.id,
      cash_account_id: session.cashAccountId,
      site_id: session.siteId,
      phase: 'ADJUSTMENT',
      adjustment_id: adjustmentId,
      variance_xaf: deltaXaf,
      variance_after_xaf: varianceAfterXaf,
      severity: varianceSeverity(
        deltaXaf,
        Number.isSafeInteger(criticalXaf) && criticalXaf >= 0 ? criticalXaf : 10_000,
      ),
      expected_xaf: expectedAfterXaf,
      counted_xaf: session.closingCountedXaf,
      treatment,
      approval_request_id: approvalRequestId,
      opened_by: session.openedBy,
      closed_by: session.closedBy,
      forced: session.forceClosed,
    },
  });
  return { sessionId: session.id, adjustmentId, deltaXaf, treatment, approvalRequestId };
}

// --- Validation ---------------------------------------------------------------------------------------------

export interface CashSessionAdjustmentRow {
  readonly id: string;
  readonly sessionId: string;
  readonly deltaXaf: number;
  readonly treatment: string;
  readonly status: string;
  readonly approvalRequestId: string | null;
  readonly createdBy: string;
}

async function loadAdjustment(
  uow: UnitOfWork,
  adjustmentId: string,
  options: { readonly lock?: boolean } = {},
): Promise<CashSessionAdjustmentRow | undefined> {
  let query = uow
    .selectFrom('finance_cash_session_adjustments')
    .select([
      'id',
      'session_id',
      'delta_xaf',
      'treatment',
      'status',
      'approval_request_id',
      'created_by',
    ])
    .where('id', '=', toBin(adjustmentId));
  if (options.lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  return row
    ? {
        id: fromBin(row.id),
        sessionId: fromBin(row.session_id),
        deltaXaf: Number(row.delta_xaf),
        treatment: row.treatment,
        status: row.status,
        approvalRequestId: fromBinOrNull(row.approval_request_id),
        createdBy: fromBin(row.created_by),
      }
    : undefined;
}

/** Cible d'une validation : la session, ou l'un de ses ajustements à validation propre. */
export type CashValidationTarget =
  | {
      readonly kind: 'SESSION';
      readonly session: CashSessionRow;
      readonly approvalRequestId: string | null;
    }
  | {
      readonly kind: 'ADJUSTMENT';
      readonly session: CashSessionRow;
      readonly adjustment: CashSessionAdjustmentRow;
    };

/** Résout l'identifiant d'une session ou d'un ajustement (lecture simple, avant tout verrou). */
export async function resolveCashValidationTarget(
  uow: UnitOfWork,
  id: string,
): Promise<CashValidationTarget | undefined> {
  const session = await loadCashSession(uow, id);
  if (session) return { kind: 'SESSION', session, approvalRequestId: session.approvalRequestId };
  const adjustment = await loadAdjustment(uow, id);
  if (!adjustment) return undefined;
  return {
    kind: 'ADJUSTMENT',
    session: (await loadCashSession(uow, adjustment.sessionId))!,
    adjustment,
  };
}

const VALIDATOR_INVOLVED = refusal(
  'CASH_VALIDATOR_INVOLVED',
  'Le valideur d’un écart de caisse n’est ni celui qui a ouvert la session, ni celui qui l’a clôturée, ni l’auteur de la clôture forcée (AV-155).',
);
const REASON_REQUIRED = refusal(
  'REASON_REQUIRED',
  'Motif de validation obligatoire : la session présente un écart (BR-DIS-007).',
);

/**
 * Valide une session `PENDING_VALIDATION` et ses ajustements inclus (ADR-032 §5). Appelée par la
 * décision `CASH_VARIANCE` (demande liée) ou directement par `finance.cash_session.validate` quand la
 * session n'a pas de demande (AV-183). `requestId` : demande attendue sur la session, contrôlée sous
 * verrou ; `null` pour la validation directe.
 */
export async function validateCashSession(
  uow: UnitOfWork,
  deps: Deps,
  input: {
    readonly sessionId: string;
    readonly requestId: string | null;
    readonly validatorId: string;
    readonly at: Date;
    readonly reason: string | null;
    readonly commandId: string | null;
  },
): Promise<CashValidationRefusal | null> {
  const peek = await loadCashSession(uow, input.sessionId);
  if (!peek) return refusal('NOT_FOUND', 'Session de caisse introuvable.');
  await lockCashAccount(uow, peek.cashAccountId);
  const session = (await loadCashSession(uow, input.sessionId, { lock: true }))!;
  if (session.status !== 'PENDING_VALIDATION') {
    return refusal(
      'CASH_SESSION_NOT_PENDING',
      'Cette session de caisse n’est pas en attente de validation.',
    );
  }
  if (input.requestId !== null && session.approvalRequestId !== input.requestId) {
    return refusal(
      'CASH_SESSION_NOT_PENDING',
      'Cette demande ne porte pas sur la validation en attente de cette session.',
    );
  }
  if (
    !isAllowedCashValidator(input.validatorId, {
      openedBy: session.openedBy,
      closedBy: session.closedBy,
      forcedBy: session.forceClosed ? session.closedBy : null,
    })
  ) {
    return VALIDATOR_INVOLVED;
  }
  const included = await uow
    .selectFrom('finance_cash_session_adjustments')
    .select(['id', 'delta_xaf'])
    .where('session_id', '=', toBin(session.id))
    .where('treatment', '=', 'INCLUDED_IN_VALIDATION')
    .where('status', '=', 'PENDING')
    .forUpdate()
    .execute();
  const reason = input.reason?.trim() ?? '';
  const hasVariance =
    session.openingVarianceXaf !== 0 || (session.varianceXaf ?? 0) !== 0 || included.length > 0;
  if (hasVariance && reason === '') return REASON_REQUIRED;

  await uow
    .updateTable('finance_cash_sessions')
    .set({
      status: 'VALIDATED',
      validated_by: toBin(input.validatorId),
      validated_at: input.at,
      variance_reason: reason === '' ? null : reason,
      updated_by: toBin(input.validatorId),
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(session.id))
    .execute();
  await emitCashSessionChange(uow, session.id);
  if (included.length > 0) {
    await uow
      .updateTable('finance_cash_session_adjustments')
      .set({
        status: 'VALIDATED',
        validated_by: toBin(input.validatorId),
        validated_at: input.at,
        variance_reason: reason === '' ? null : reason,
        updated_by: toBin(input.validatorId),
        version: sql`version + 1`,
      })
      .where(
        'id',
        'in',
        included.map((row) => row.id),
      )
      .execute();
  }
  const includedDeltaXaf = included.reduce((sum, row) => sum + Number(row.delta_xaf), 0);
  await publishCashSessionEvent(uow, deps, {
    eventType: 'CashSessionValidated',
    sessionId: session.id,
    occurredAt: input.at,
    commandId: input.commandId,
    payload: {
      session_id: session.id,
      cash_account_id: session.cashAccountId,
      site_id: session.siteId,
      validated_by: input.validatorId,
      validated_at: input.at.toISOString(),
      opening_variance_xaf: session.openingVarianceXaf,
      closing_variance_xaf: session.varianceXaf,
      included_adjustments: included.length,
      included_delta_xaf: includedDeltaXaf,
      variance_xaf: (session.varianceXaf ?? 0) + includedDeltaXaf,
      approval_request_id: session.approvalRequestId,
      reason: reason === '' ? null : reason,
    },
  });
  return null;
}

/**
 * Valide un ajustement à validation propre (`OWN_APPROVAL`) d'une session `VALIDATED`, qui reste figée
 * (INV-FIN-05). Le valideur n'est ni impliqué dans la session (AV-155) ni l'auteur de l'opération
 * tardive (séparation des tâches, DÉDUIT de RC-03) ; motif obligatoire (l'ajustement est un écart).
 */
export async function validateCashSessionAdjustment(
  uow: UnitOfWork,
  deps: Deps,
  input: {
    readonly adjustmentId: string;
    readonly requestId: string | null;
    readonly validatorId: string;
    readonly at: Date;
    readonly reason: string | null;
    readonly commandId: string | null;
  },
): Promise<CashValidationRefusal | null> {
  const peek = await loadAdjustment(uow, input.adjustmentId);
  if (!peek) return refusal('NOT_FOUND', 'Ajustement de session de caisse introuvable.');
  const sessionPeek = (await loadCashSession(uow, peek.sessionId))!;
  await lockCashAccount(uow, sessionPeek.cashAccountId);
  const session = (await loadCashSession(uow, peek.sessionId, { lock: true }))!;
  const adjustment = (await loadAdjustment(uow, input.adjustmentId, { lock: true }))!;
  if (adjustment.treatment !== 'OWN_APPROVAL' || adjustment.status !== 'PENDING') {
    return refusal(
      'CASH_SESSION_ADJUSTMENT_NOT_PENDING',
      adjustment.treatment === 'OWN_APPROVAL'
        ? 'Cet ajustement est déjà validé.'
        : 'Cet ajustement se valide avec sa session (finance.cash_session.validate sur la session).',
    );
  }
  if (input.requestId !== null && adjustment.approvalRequestId !== input.requestId) {
    return refusal(
      'CASH_SESSION_ADJUSTMENT_NOT_PENDING',
      'Cette demande ne porte pas sur la validation en attente de cet ajustement.',
    );
  }
  if (
    !isAllowedCashValidator(input.validatorId, {
      openedBy: session.openedBy,
      closedBy: session.closedBy,
      forcedBy: session.forceClosed ? session.closedBy : null,
    }) ||
    input.validatorId === adjustment.createdBy
  ) {
    return VALIDATOR_INVOLVED;
  }
  const reason = input.reason?.trim() ?? '';
  if (reason === '') return REASON_REQUIRED;
  await uow
    .updateTable('finance_cash_session_adjustments')
    .set({
      status: 'VALIDATED',
      validated_by: toBin(input.validatorId),
      validated_at: input.at,
      variance_reason: reason,
      updated_by: toBin(input.validatorId),
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(adjustment.id))
    .execute();
  await publishCashSessionEvent(uow, deps, {
    eventType: 'CashSessionValidated',
    sessionId: session.id,
    occurredAt: input.at,
    commandId: input.commandId,
    payload: {
      session_id: session.id,
      adjustment_id: adjustment.id,
      cash_account_id: session.cashAccountId,
      site_id: session.siteId,
      validated_by: input.validatorId,
      validated_at: input.at.toISOString(),
      variance_xaf: adjustment.deltaXaf,
      approval_request_id: adjustment.approvalRequestId,
      reason,
    },
  });
  return null;
}

/**
 * Décision `CASH_VARIANCE` (ADR-018, ADR-032 §5) : l'acceptation valide la session ou l'ajustement
 * sujet de la demande ; le rejet est refusé (AV-159 : un écart s'accepte, une erreur de comptage se
 * corrige par un ajustement validé) ; le retrait aussi (la session resterait sans décision possible).
 * Le motif vient de `decisionData.reason` (façade `finance.cash_session.validate` ou approbation
 * directe par `approvals.request.approve`).
 */
export function registerCashVarianceDecisions(
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  deps: Deps,
): void {
  decisionRegistry.register('CASH_VARIANCE', async (uow, ctx) => {
    if (ctx.decision === 'REJECTED') {
      throw new ApprovalDecisionRefused(
        'CASH_VARIANCE_NOT_REJECTABLE',
        'Un écart de caisse ne se rejette pas : l’accepter avec son motif ; une erreur de comptage se corrige par un ajustement validé (AV-159).',
      );
    }
    const reason = ctx.decisionData?.['reason'] ?? null;
    const outcome =
      ctx.subjectType === 'CASH_SESSION_ADJUSTMENT'
        ? await validateCashSessionAdjustment(uow, deps, {
            adjustmentId: ctx.subjectId,
            requestId: ctx.requestId,
            validatorId: ctx.decidedBy,
            at: ctx.decidedAt,
            reason,
            commandId: null,
          })
        : await validateCashSession(uow, deps, {
            sessionId: ctx.subjectId,
            requestId: ctx.requestId,
            validatorId: ctx.decidedBy,
            at: ctx.decidedAt,
            reason,
            commandId: null,
          });
    if (outcome) throw new ApprovalDecisionRefused(outcome.errorCode, outcome.messageFr);
  });
  decisionRegistry.registerWithdrawalGuard('CASH_VARIANCE', async () => {
    throw new ApprovalDecisionRefused(
      'CASH_VARIANCE_NOT_WITHDRAWABLE',
      'La demande de validation d’un écart de caisse ne se retire pas : la Finance la décide.',
    );
  });
}
