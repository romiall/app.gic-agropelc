/**
 * Sessions de caisse (P5-12 ; ADR-032 ; D05 UC-DIS-02, UC-DIS-03, BR-DIS-005 à 007, §14, §15 ;
 * SM-CASH-SESSION ; BR-FIN-014 ; AV-154 à AV-156, AV-165, AV-167 à AV-171) :
 * `finance.cash_session.open` et `.close` (hors ligne possibles), `.force_close` (en ligne).
 *
 * - **Le registre fait foi** (ADR-032 §1-4) : l'écart d'ouverture compare le fonds compté au solde du
 *   registre à l'ouverture ; l'attendu de clôture se tire des mouvements du compte dont l'`occurred_at`
 *   est dans la fenêtre `[ouverture, clôture[`, jamais de l'index `cash_session_id`. Le serveur calcule
 *   seul l'attendu, l'écart et le statut ; la commande ne porte que le montant compté.
 * - Un écart non nul, d'ouverture ou de clôture, est un mouvement `SESSION_VARIANCE` écrit par
 *   `recordCashMovement` dans la transaction (constat, jamais refusé pour un solde négatif).
 * - **Faits accomplis** (ADR-032 §8, BR-SYN-007) : seuls la validité (type de caisse, identifiant
 *   inconnu), l'authenticité (pipeline) et l'autorisation rejettent un fait hors ligne. Les refus d'état
 *   (`CASH_SESSION_ALREADY_OPEN`, `_OVERLAP`, `_DAILY_LIMIT`, `_NOT_OPEN`, `_CLOSE_BEFORE_OPEN`) ne
 *   valent qu'en ligne ; hors ligne, l'ouverture est fusionnée (ou décalée, AV-168) et la clôture est
 *   conservée comme observation, avec un conflit informatif pour la Finance.
 * - Seule une caisse de PDV ouvre une session (AV-165). Portée évaluée sur le site de la caisse.
 * - **Clôture face au registre** (AV-171) : une clôture datée avant un mouvement déjà enregistré sur la
 *   caisse l'exclurait de l'attendu ; refusée en ligne (`CASH_SESSION_CLOSE_BEFORE_LAST_MOVEMENT`),
 *   appliquée hors ligne mais jamais validée d'office et signalée à la Finance.
 * - **Montants démesurés** : un écart hors des entiers sûrs (compté démesuré face à un attendu négatif)
 *   est un refus de validité (`CASH_AMOUNT_INVALID`), jamais une exception rejouée sans fin.
 * - Verrous : site (partagé), compte, sessions du compte, registre (voir `cash-session-ledger.ts`) ;
 *   transaction en lecture confirmée (`isolationLevel`), sans verrou de plage entre caisses voisines.
 *   Le non-chevauchement des fenêtres est décidé sous ces verrous : les déclencheurs de la base restent
 *   un filet jamais atteint (une erreur SQL serait rejouée sans fin).
 * - **Validation** (P5-13, ADR-032 §5) : une clôture en `PENDING_VALIDATION` crée la demande
 *   `CASH_VARIANCE` de la session (`cash-session-validation.ts`) ; `finance.cash_session.validate`
 *   (en ligne) est la façade de sa décision, ou valide directement une session sans demande (AV-183) ;
 *   la décision `CASH_VARIANCE` est enregistrée ici auprès du registre d'`approvals`.
 * - Hors périmètre : exigence d'une session à l'encaissement (P5-14).
 */
import {
  businessDayOf,
  businessDayStartUtc,
  cashSessionOpenLongerThan,
  cashVarianceImputedUser,
  cashVarianceXaf,
  checkCashSessionCloseAgainstLedger,
  DomainError,
  planCashSessionClose,
  planCashSessionOpen,
  sessionStatusAfterClose,
  varianceMovement,
  varianceSeverity,
  type CashSessionOpenPlan,
  type IdGenerator,
} from '@gic/domain';
import {
  cashSessionClosePayloadSchema,
  cashSessionForceClosePayloadSchema,
  cashSessionOpenPayloadSchema,
  cashSessionValidatePayloadSchema,
  type CashSessionClosePayload,
  type CashSessionForceClosePayload,
  type CashSessionOpenPayload,
  type CashSessionValidatePayload,
  type CommandEnvelope,
  type WarningCode,
} from '@gic/contracts';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { loadCommandOrigin, type CommandOrigin } from '../../../../platform/sync/command-origin.js';
import {
  latestConflictDetails,
  recordConflict,
  resolveOpenConflicts,
} from '../../../../platform/sync/conflicts.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';
import { evaluateAccess } from '../../../identity/application/public/index.js';
import {
  decideApprovalRequest,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import { CashMovementError, recordCashMovement } from '../public/cash-movements.js';
import {
  cashSetting,
  expectedAtClose,
  latestMovementAtOrAfter,
  ledgerBalanceAtOpening,
  loadCashSession,
  lockAccountSessionsFrom,
  lockCashAccount,
  lockSiteShared,
  peekCashAccount,
  type CashAccountFacts,
  type CashSessionRow,
} from '../cash-session-ledger.js';
import { publishCashSessionEvent } from '../cash-session-events.js';
import {
  hasPendingIncludedAdjustment,
  openingAdjustmentsXaf,
  registerCashVarianceDecisions,
  requestCashVarianceValidation,
  resolveCashValidationTarget,
  validateCashSession,
  validateCashSessionAdjustment,
} from '../cash-session-validation.js';
import { emitCashSessionChange } from '../sync-changes.js';

export const CASH_SESSION_OPERATE = 'finance.cash_session.operate';
export const CASH_SESSION_VALIDATE = 'finance.cash_session.validate';

/** Conflits informatifs consignés pour la Finance (matrice des conflits, lignes « Session de caisse »). */
export const CASH_SESSION_CONFLICTS = {
  concurrentOpen: 'CASH_SESSION_CONCURRENT_OPEN',
  concurrentClose: 'CASH_SESSION_CONCURRENT_CLOSE',
  inactiveAccount: 'CASH_ACCOUNT_INACTIVE',
  siteClosed: 'CASH_SESSION_SITE_CLOSED',
  closeBeforeMovements: 'CASH_SESSION_CLOSE_BEFORE_MOVEMENTS',
} as const;

type Deps = { readonly idGenerator: IdGenerator };

function rejected(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}

const FORBIDDEN_SCOPE = rejected(
  'FORBIDDEN_SCOPE',
  'Vous n’avez pas ce droit sur la caisse de ce point de vente.',
);
const POS_ACCOUNT_REQUIRED = rejected(
  'CASH_SESSION_POS_ACCOUNT_REQUIRED',
  'Seule la caisse d’un point de vente ouvre une session de caisse (AV-165).',
);
const ACCOUNT_INACTIVE = rejected('CASH_ACCOUNT_INACTIVE', 'Cette caisse est désactivée.');
const SESSION_NOT_FOUND = rejected('NOT_FOUND', 'Session de caisse introuvable.');

const OPEN_REFUSALS: Record<string, string> = {
  CASH_SESSION_ALREADY_OPEN:
    'Une session est déjà ouverte sur cette caisse : la clôturer avant d’en ouvrir une autre.',
  CASH_SESSION_OVERLAP:
    'Cette heure d’ouverture tombe dans la fenêtre d’une session existante de cette caisse.',
  CASH_SESSION_DAILY_LIMIT:
    'Le nombre de sessions de caisse autorisé pour ce jour est atteint (finance.cash_sessions_per_day_max).',
};

/** Droit `permissionCode` sur le site de la caisse, à l'heure de l'opération (RC-01, RC-04, RC-10). */
async function allowedOnSite(
  uow: UnitOfWork,
  input: { userId: string; permissionCode: string; occurredAt: Date; siteId: string },
): Promise<boolean> {
  const access = await evaluateAccess(uow, {
    userId: input.userId,
    permissionCode: input.permissionCode,
    occurredAt: input.occurredAt,
    resource: { siteId: input.siteId },
  });
  return access.allowed;
}

/** Tolérance (≥ 0), seuil critique (≥ 0) et seuil d'heures (> 0) : une valeur absurde reprend le défaut. */
const nonNegativeInt = (value: number, fallback: number): number =>
  Number.isSafeInteger(value) && value >= 0 ? value : fallback;
const positiveHours = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? value : fallback;

/** Écrit l'écart signé en mouvement `SESSION_VARIANCE` (constat : ni refus de solde, ni compte inactif). */
async function postVariance(
  uow: UnitOfWork,
  deps: Deps,
  input: {
    readonly sessionId: string;
    readonly cashAccountId: string;
    readonly varianceXaf: number;
    readonly occurredAt: Date;
    readonly author: string;
    readonly origin: CommandOrigin;
    readonly commandId: string;
    readonly capturedOffline: boolean;
  },
): Promise<string> {
  const { amount, direction } = varianceMovement(input.varianceXaf);
  const recorded = await recordCashMovement(uow, deps, {
    cashAccountId: input.cashAccountId,
    direction,
    amountXaf: amount,
    movementType: 'SESSION_VARIANCE',
    sourceDocType: 'CASH_SESSION',
    sourceDocId: input.sessionId,
    cashSessionId: input.sessionId,
    occurredAt: input.occurredAt,
    createdBy: input.author,
    ...(input.origin.deviceId !== null ? { createdDeviceId: input.origin.deviceId } : {}),
    commandId: input.commandId,
    capturedOffline: input.capturedOffline,
    allowNegative: true,
    pastFact: true,
  });
  return recorded.movementId;
}

async function publishVariance(
  uow: UnitOfWork,
  deps: Deps,
  input: {
    readonly session: Pick<CashSessionRow, 'id' | 'cashAccountId' | 'siteId' | 'openedBy'>;
    readonly phase: 'OPENING' | 'CLOSING';
    readonly varianceXaf: number;
    readonly countedXaf: number;
    readonly expectedXaf: number;
    readonly closedBy: string | null;
    readonly forced: boolean;
    readonly occurredAt: Date;
    readonly commandId: string;
  },
): Promise<void> {
  const criticalXaf = nonNegativeInt(
    await cashSetting(uow, 'varianceCriticalXaf', input.session.siteId, input.occurredAt),
    10_000,
  );
  await publishCashSessionEvent(uow, deps, {
    eventType: 'CashVarianceDetected',
    sessionId: input.session.id,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    payload: {
      session_id: input.session.id,
      cash_account_id: input.session.cashAccountId,
      site_id: input.session.siteId,
      phase: input.phase,
      variance_xaf: input.varianceXaf,
      severity: varianceSeverity(input.varianceXaf, criticalXaf),
      counted_xaf: input.countedXaf,
      expected_xaf: input.expectedXaf,
      // AV-155, AV-170 : responsable imputé, distinct du clôtureur et de l'auteur d'une clôture forcée.
      imputed_user_id: cashVarianceImputedUser({
        kind: input.phase,
        openedBy: input.session.openedBy,
        closedBy: input.closedBy,
        forced: input.forced,
      }),
      opened_by: input.session.openedBy,
      closed_by: input.closedBy,
      forced: input.forced,
    },
  });
}

/** Codes d'erreur de domaine d'un montant hors des entiers sûrs (compté démesuré, somme déraisonnable). */
const UNSAFE_AMOUNT_CODES: readonly string[] = ['NOT_SAFE_INTEGER', 'AMOUNT_INVALID'];

/**
 * Une erreur du registre ou d'un montant démesuré n'est jamais une exception rejouée sans fin : refus
 * explicite (validité du montant, pas un état métier : BR-SYN-007 ne s'y oppose pas). Toute autre
 * erreur reste transitoire (le pipeline la rejoue).
 */
function cashRejection(error: unknown): CommandHandlerOutcome {
  if (error instanceof CashMovementError) return rejected(error.code, error.message);
  if (error instanceof DomainError && UNSAFE_AMOUNT_CODES.includes(error.code)) {
    return rejected(
      'CASH_AMOUNT_INVALID',
      'Le montant compté est démesuré : l’écart avec l’attendu sort des entiers représentables.',
    );
  }
  throw error;
}

// --- finance.cash_session.open ---------------------------------------------------------------------------

function openHandler(deps: Deps): CommandHandler<CashSessionOpenPayload> {
  return async (uow, envelope) => {
    const p = envelope.payload;
    const sessionId = envelope.aggregate_id;
    // Rejeu d'une ouverture déjà appliquée (autre commande sur le même identifiant) : sans effet.
    if (await loadCashSession(uow, sessionId)) {
      return { status: 'APPLIED', serverRefs: { cashSessionId: sessionId } };
    }
    const author = envelope.author_user_id;
    const occurredAt = new Date(envelope.occurred_at);
    const offline = envelope.captured_offline;

    const peek = await peekCashAccount(uow, p.cashAccountId);
    if (!peek) return rejected('NOT_FOUND', 'Caisse introuvable.');
    if (peek.accountType !== 'CAISSE_PDV' || peek.siteId === null) return POS_ACCOUNT_REQUIRED;
    const siteId = peek.siteId;
    if (
      !(await allowedOnSite(uow, {
        userId: author,
        permissionCode: CASH_SESSION_OPERATE,
        occurredAt,
        siteId,
      }))
    ) {
      return FORBIDDEN_SCOPE;
    }

    const siteStatus = await lockSiteShared(uow, siteId);
    // Site fermé entre-temps (`organization.site.close`, garde `finance` passée) : refus en ligne ;
    // hors ligne, le comptage reste un fait accompli (BR-SYN-007).
    if (siteStatus !== 'ACTIVE' && !offline) {
      return rejected('SITE_CLOSED', 'Ce point de vente est fermé : aucune session ne s’y ouvre.');
    }
    const account = (await lockCashAccount(uow, p.cashAccountId))!;
    // Un compte désactivé refuse une ouverture en ligne ; hors ligne, le comptage est un fait accompli.
    if (account.status !== 'ACTIVE' && !offline) return ACCOUNT_INACTIVE;

    const sessions = await lockAccountSessionsFrom(
      uow,
      account.id,
      occurredAt,
      businessDayStartUtc(businessDayOf(occurredAt)),
    );
    const plan = planCashSessionOpen({
      openedAt: occurredAt,
      capturedOffline: offline,
      sessions,
      maxSessionsPerDay: await cashSetting(uow, 'sessionsPerDayMax', siteId, occurredAt),
    });
    if (plan.kind === 'REJECT') return rejected(plan.code, OPEN_REFUSALS[plan.code]!);

    const origin = await loadCommandOrigin(uow, envelope.command_id);
    if (plan.kind === 'MERGE') {
      const target = sessions.find((session) => session.id === plan.targetSessionId)!;
      return mergeOpening(uow, deps, { envelope, account, siteId, target, plan, origin });
    }
    try {
      return await createSession(uow, deps, {
        envelope,
        account,
        siteId,
        siteStatus: siteStatus ?? 'UNKNOWN',
        plan,
        origin,
      });
    } catch (error) {
      return cashRejection(error);
    }
  };
}

async function createSession(
  uow: UnitOfWork,
  deps: Deps,
  input: {
    readonly envelope: CommandEnvelope<CashSessionOpenPayload>;
    readonly account: CashAccountFacts;
    readonly siteId: string;
    readonly siteStatus: string;
    readonly plan: Extract<CashSessionOpenPlan, { kind: 'CREATE' }>;
    readonly origin: CommandOrigin;
  },
): Promise<CommandHandlerOutcome> {
  const { envelope, account, siteId, plan, origin } = input;
  const p = envelope.payload;
  const sessionId = envelope.aggregate_id;
  const author = envelope.author_user_id;
  const offline = envelope.captured_offline;
  const openedAt = plan.openedAt;

  // ADR-032 §4 : écart d'ouverture = fonds compté − solde du registre à l'ouverture.
  const openingExpectedXaf = await ledgerBalanceAtOpening(uow, account.id, openedAt);
  const openingVarianceXaf = cashVarianceXaf(p.countedXaf, openingExpectedXaf);
  await uow
    .insertInto('finance_cash_sessions')
    .values({
      id: toBin(sessionId),
      cash_account_id: toBin(account.id),
      site_id: toBin(siteId),
      opened_by: toBin(author),
      opened_device_id: toBinOrNull(origin.deviceId),
      opened_at: openedAt,
      opening_counted_xaf: p.countedXaf,
      opening_expected_xaf: openingExpectedXaf,
      opening_variance_xaf: openingVarianceXaf,
      status: 'OPEN',
      command_id: toBin(envelope.command_id),
      client_created_at: new Date(envelope.client_created_at),
      received_at_server: origin.receivedAt,
      captured_offline: toDbBool(offline),
      clock_suspect: toDbBool(origin.clockSuspect),
      backdated_reason: envelope.backdated_reason,
      created_by: toBin(author),
    })
    .execute();
  await emitCashSessionChange(uow, sessionId);
  const session = { id: sessionId, cashAccountId: account.id, siteId, openedBy: author };
  if (openingVarianceXaf !== 0) {
    await postVariance(uow, deps, {
      sessionId,
      cashAccountId: account.id,
      varianceXaf: openingVarianceXaf,
      occurredAt: openedAt,
      author,
      origin,
      commandId: envelope.command_id,
      capturedOffline: offline,
    });
  }

  await publishCashSessionEvent(uow, deps, {
    eventType: 'CashSessionOpened',
    sessionId,
    occurredAt: openedAt,
    commandId: envelope.command_id,
    payload: {
      session_id: sessionId,
      cash_account_id: account.id,
      site_id: siteId,
      opened_by: author,
      opened_device_id: origin.deviceId,
      opened_at: openedAt.toISOString(),
      opening_counted_xaf: p.countedXaf,
      opening_expected_xaf: openingExpectedXaf,
      opening_variance_xaf: openingVarianceXaf,
      captured_offline: offline,
      shifted_from: plan.shiftedFrom?.toISOString() ?? null,
      comment: p.comment ?? null,
    },
  });
  // P5-14 (AV-184) : une ouverture appliquée après coup (saisie hors ligne, synchronisée plus tard)
  // couvre, par le temps, les encaissements en espèces de la caisse saisis hors ligne sans session
  // depuis son heure d'ouverture : leurs conflits CASH_SESSION_MISSING sont résolus (l'index des
  // mouvements n'est jamais réécrit, ADR-032 §2 : la lecture se fait par la fenêtre). P8-05 (AV-267) :
  // de même pour les dépenses payées en espèces par la caisse du PDV.
  for (const kind of [
    {
      type: 'CUSTOMER_PAYMENT',
      comment: 'Encaissement couvert par une session de caisse ouverte après coup (AV-184).',
    },
    {
      type: 'EXPENSE',
      comment: 'Dépense couverte par une session de caisse ouverte après coup (AV-267).',
    },
  ] as const) {
    const uncovered = await uow
      .selectFrom('finance_cash_movements')
      .select('source_doc_id')
      .where('cash_account_id', '=', toBin(account.id))
      .where('movement_type', '=', kind.type)
      .where('source_doc_type', '=', kind.type)
      .where('is_reversal', '=', 0)
      .where('cash_session_id', 'is', null)
      .where('occurred_at', '>=', openedAt)
      .execute();
    await resolveOpenConflicts(uow, {
      conflictType: 'CASH_SESSION_MISSING',
      entityType: kind.type,
      entityIds: uncovered.map((row) => fromBin(row.source_doc_id)),
      resolution: 'MERGE',
      resolvedBy: author,
      resolvedAt: openedAt,
      comment: kind.comment,
      refs: [sessionId],
    });
  }

  if (openingVarianceXaf !== 0) {
    await publishVariance(uow, deps, {
      session,
      phase: 'OPENING',
      varianceXaf: openingVarianceXaf,
      countedXaf: p.countedXaf,
      expectedXaf: openingExpectedXaf,
      closedBy: null,
      forced: false,
      occurredAt: openedAt,
      commandId: envelope.command_id,
    });
  }

  const warnings: WarningCode[] = [];
  if (plan.shiftedFrom !== null) {
    // AV-168 : ouverture saisie pendant la session de la veille, close depuis : décalée à sa clôture.
    // Les mouvements de l'intervalle appartiennent à la session de la veille ; leur solde explique
    // l'écart d'ouverture (il est donné à la Finance).
    const flowsBetweenXaf = await expectedAtClose(uow, {
      cashAccountId: account.id,
      openingCountedXaf: 0,
      openedAt: plan.shiftedFrom,
      closedAt: openedAt,
    });
    await recordConflict(uow, {
      id: deps.idGenerator.newId(),
      commandId: envelope.command_id,
      conflictType: CASH_SESSION_CONFLICTS.concurrentOpen,
      entityType: 'CASH_SESSION',
      entityId: sessionId,
      siteId,
      ownerRole: 'FINANCE',
      applied: true,
      details: {
        outcome: 'SHIFTED',
        reason: 'OPENED_DURING_PREVIOUS_DAY_SESSION',
        previousSessionId: plan.shiftedAfterSessionId,
        requestedOpenedAt: plan.shiftedFrom.toISOString(),
        openedAt: openedAt.toISOString(),
        countedXaf: p.countedXaf,
        openingExpectedXaf,
        openingVarianceXaf,
        flowsBetweenXaf,
        cashAccountId: account.id,
        deviceId: origin.deviceId,
        authorUserId: author,
        comment: p.comment ?? null,
      },
    });
    warnings.push('CASH_SESSION_CONCURRENT_OPEN');
  }
  if (input.siteStatus !== 'ACTIVE') {
    // Site fermé depuis (la garde de fermeture ne voyait pas cette ouverture, pas encore synchronisée) :
    // la session est ouverte (fait accompli hors ligne), la Finance le voit pour la clôturer.
    await recordConflict(uow, {
      id: deps.idGenerator.newId(),
      commandId: envelope.command_id,
      conflictType: CASH_SESSION_CONFLICTS.siteClosed,
      entityType: 'CASH_SESSION',
      entityId: sessionId,
      siteId,
      ownerRole: 'FINANCE',
      applied: true,
      details: {
        cashAccountId: account.id,
        siteStatus: input.siteStatus,
        openedAt: openedAt.toISOString(),
        countedXaf: p.countedXaf,
        deviceId: origin.deviceId,
        authorUserId: author,
      },
    });
    warnings.push('CASH_SESSION_SITE_CLOSED');
  }
  if (account.status !== 'ACTIVE') {
    // Caisse désactivée depuis : la session est ouverte (fait accompli hors ligne), la Finance le voit.
    await recordConflict(uow, {
      id: deps.idGenerator.newId(),
      commandId: envelope.command_id,
      conflictType: CASH_SESSION_CONFLICTS.inactiveAccount,
      entityType: 'CASH_SESSION',
      entityId: sessionId,
      siteId,
      ownerRole: 'FINANCE',
      applied: true,
      details: {
        cashAccountId: account.id,
        openedAt: openedAt.toISOString(),
        countedXaf: p.countedXaf,
        deviceId: origin.deviceId,
        authorUserId: author,
      },
    });
    warnings.push('CASH_ACCOUNT_INACTIVE');
  }

  const serverRefs = {
    cashSessionId: sessionId,
    openedAt: openedAt.toISOString(),
    openingExpectedXaf: String(openingExpectedXaf),
    openingVarianceXaf: String(openingVarianceXaf),
  };
  const audit = {
    after: {
      cashAccountId: account.id,
      countedXaf: p.countedXaf,
      comment: p.comment ?? null,
      openedAt: openedAt.toISOString(),
      shiftedFrom: plan.shiftedFrom?.toISOString() ?? null,
      openingExpectedXaf,
      openingVarianceXaf,
      status: 'OPEN',
    },
  };
  return warnings.length > 0
    ? { status: 'APPLIED_WITH_WARNINGS', warnings, serverRefs, audit }
    : { status: 'APPLIED', serverRefs, audit };
}

/**
 * Ouverture hors ligne en concurrence (AV-154, AV-167) : aucune session ni aucun mouvement ; le comptage
 * est conservé comme observation dans un conflit sur l'identifiant proposé, qui sert ensuite d'alias à
 * la clôture de l'appareil (`server_refs.cashSessionId` = session retenue).
 */
async function mergeOpening(
  uow: UnitOfWork,
  deps: Deps,
  input: {
    readonly envelope: CommandEnvelope<CashSessionOpenPayload>;
    readonly account: CashAccountFacts;
    readonly siteId: string;
    readonly target: CashSessionRow;
    readonly plan: Extract<CashSessionOpenPlan, { kind: 'MERGE' }>;
    readonly origin: CommandOrigin;
  },
): Promise<CommandHandlerOutcome> {
  const { envelope, account, siteId, target, plan, origin } = input;
  const p = envelope.payload;
  const details = {
    outcome: 'MERGED',
    reason: plan.reason,
    targetSessionId: target.id,
    targetOpenedAt: target.openedAt.toISOString(),
    targetStatus: target.status,
    earlierThanTarget: plan.earlierThanTarget,
    requestedOpenedAt: envelope.occurred_at,
    consideredOpenedAt: plan.consideredOpenedAt.toISOString(),
    countedXaf: p.countedXaf,
    countDifferenceXaf: p.countedXaf - target.openingCountedXaf,
    cashAccountId: account.id,
    deviceId: origin.deviceId,
    authorUserId: envelope.author_user_id,
    comment: p.comment ?? null,
  };
  await recordConflict(uow, {
    id: deps.idGenerator.newId(),
    commandId: envelope.command_id,
    conflictType: CASH_SESSION_CONFLICTS.concurrentOpen,
    entityType: 'CASH_SESSION',
    entityId: envelope.aggregate_id,
    siteId,
    ownerRole: 'FINANCE',
    applied: true,
    details,
  });
  return {
    status: 'APPLIED_WITH_WARNINGS',
    warnings: ['CASH_SESSION_CONCURRENT_OPEN'],
    // S-48 (P5-23) : le statut de la session retenue, pour que l'appareil sache si la caisse est ouverte.
    serverRefs: { cashSessionId: target.id, mergedInto: target.id, targetStatus: target.status },
    audit: { after: { merged: true, ...details } },
  };
}

// --- Résolution de la session visée par une clôture ------------------------------------------------------

/**
 * Session visée par une clôture : l'identifiant lui-même, ou, s'il a été fusionné à l'ouverture
 * (AV-154), la session retenue consignée dans le conflit `CASH_SESSION_CONCURRENT_OPEN` (alias).
 */
async function resolveSessionTarget(
  uow: UnitOfWork,
  sessionId: string,
): Promise<{ readonly session: CashSessionRow; readonly aliasOf: string | null } | undefined> {
  const direct = await loadCashSession(uow, sessionId);
  if (direct) return { session: direct, aliasOf: null };
  const details = (await latestConflictDetails(uow, {
    conflictType: CASH_SESSION_CONFLICTS.concurrentOpen,
    entityId: sessionId,
  })) as { outcome?: unknown; targetSessionId?: unknown } | null;
  if (details?.outcome !== 'MERGED' || typeof details.targetSessionId !== 'string') {
    return undefined;
  }
  const target = await loadCashSession(uow, details.targetSessionId);
  return target ? { session: target, aliasOf: sessionId } : undefined;
}

/** Verrous de la clôture : site (partagé), compte, puis session, relue sous verrou. */
async function lockForClose(uow: UnitOfWork, peek: CashSessionRow): Promise<CashSessionRow> {
  await lockSiteShared(uow, peek.siteId);
  await lockCashAccount(uow, peek.cashAccountId);
  return (await loadCashSession(uow, peek.id, { lock: true }))!;
}

// --- Clôture commune (ordinaire ou forcée) ------------------------------------------------------------------

async function closeSession(
  uow: UnitOfWork,
  deps: Deps,
  input: {
    readonly envelope: CommandEnvelope<CashSessionClosePayload | CashSessionForceClosePayload>;
    readonly session: CashSessionRow;
    readonly closedAt: Date;
    readonly countedXaf: number;
    readonly forced: boolean;
    readonly reason: string | null;
    readonly comment: string | null;
    readonly aliasOf: string | null;
    /** AV-171 : mouvement le plus récent daté à la clôture ou après (signalé hors ligne), sinon `null`. */
    readonly precedesMovementAt: Date | null;
  },
): Promise<CommandHandlerOutcome> {
  const { envelope, session, closedAt, countedXaf, forced, precedesMovementAt } = input;
  const author = envelope.author_user_id;
  const offline = envelope.captured_offline;
  const origin = await loadCommandOrigin(uow, envelope.command_id);

  // ADR-032 §3 : attendu par fenêtre `[ouverture, clôture[`, écart = compté − attendu.
  const closingExpectedXaf = await expectedAtClose(uow, {
    cashAccountId: session.cashAccountId,
    openingCountedXaf: session.openingCountedXaf,
    openedAt: session.openedAt,
    closedAt,
  });
  const varianceXaf = cashVarianceXaf(countedXaf, closingExpectedXaf);
  const toleranceXaf = nonNegativeInt(
    await cashSetting(uow, 'varianceToleranceXaf', session.siteId, closedAt),
    0,
  );
  // AV-224 (P5-23) : écart d'ouverture effectif, corrigé des opérations antérieures à l'ouverture
  // appliquées depuis ; un ajustement inclus encore en attente exige la validation.
  const openingVarianceXaf =
    session.openingVarianceXaf + (await openingAdjustmentsXaf(uow, session.id));
  const { status, autoValidated } = sessionStatusAfterClose({
    openingVarianceXaf,
    closingVarianceXaf: varianceXaf,
    toleranceXaf,
    forced,
    precedesMovements: precedesMovementAt !== null,
    pendingAdjustments: await hasPendingIncludedAdjustment(uow, session.id),
  });
  if (varianceXaf !== 0) {
    await postVariance(uow, deps, {
      sessionId: session.id,
      cashAccountId: session.cashAccountId,
      varianceXaf,
      occurredAt: closedAt,
      author,
      origin,
      commandId: envelope.command_id,
      capturedOffline: offline,
    });
  }
  // P5-13, ADR-032 §5 : une session à valider porte sa demande `CASH_VARIANCE` (montant : écarts
  // d'ouverture et de clôture en valeur absolue, DÉDUIT) ; sans politique active, aucune demande et la
  // validation directe prend le relais (AV-183) — la clôture n'est jamais refusée pour autant.
  const approvalRequestId =
    status === 'PENDING_VALIDATION'
      ? await requestCashVarianceValidation(uow, deps, {
          subjectType: 'CASH_SESSION',
          subjectId: session.id,
          siteId: session.siteId,
          amountXaf: Math.abs(openingVarianceXaf) + Math.abs(varianceXaf),
          summary:
            `Session de caisse du ${businessDayOf(session.openedAt)} : écart d'ouverture ` +
            `${openingVarianceXaf} XAF, écart de clôture ${varianceXaf} XAF` +
            (forced ? ' (clôture forcée)' : '') +
            (precedesMovementAt !== null ? ' (clôture datée avant un mouvement)' : ''),
          requestedBy: author,
          requestedAt: closedAt,
          ...(offline ? { policyFallbackAt: origin.receivedAt } : {}),
        })
      : null;
  await uow
    .updateTable('finance_cash_sessions')
    .set({
      status,
      approval_request_id: toBinOrNull(approvalRequestId),
      closed_by: toBin(author),
      closed_device_id: toBinOrNull(origin.deviceId),
      closed_at: closedAt,
      closing_counted_xaf: countedXaf,
      closing_expected_xaf: closingExpectedXaf,
      variance_xaf: varianceXaf,
      force_closed: toDbBool(forced),
      forced_by: forced ? toBin(author) : null,
      // Validation d'office (écarts nuls ou tolérés) : à la clôture, sans valideur (AV-057).
      auto_validated: toDbBool(autoValidated),
      validated_at: autoValidated ? closedAt : null,
      close_command_id: toBin(envelope.command_id),
      close_captured_offline: toDbBool(offline),
      updated_by: toBin(author),
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(session.id))
    .execute();
  await emitCashSessionChange(uow, session.id);

  await publishCashSessionEvent(uow, deps, {
    eventType: 'CashSessionClosed',
    sessionId: session.id,
    occurredAt: closedAt,
    commandId: envelope.command_id,
    payload: {
      session_id: session.id,
      cash_account_id: session.cashAccountId,
      site_id: session.siteId,
      opened_by: session.openedBy,
      opened_at: session.openedAt.toISOString(),
      opening_counted_xaf: session.openingCountedXaf,
      opening_variance_xaf: session.openingVarianceXaf,
      closed_by: author,
      closed_device_id: origin.deviceId,
      closed_at: closedAt.toISOString(),
      closing_counted_xaf: countedXaf,
      closing_expected_xaf: closingExpectedXaf,
      variance_xaf: varianceXaf,
      status,
      auto_validated: autoValidated,
      forced,
      forced_by: forced ? author : null,
      reason: input.reason,
      comment: input.comment,
      captured_offline: offline,
      approval_request_id: approvalRequestId,
    },
  });
  if (varianceXaf !== 0) {
    await publishVariance(uow, deps, {
      session,
      phase: 'CLOSING',
      varianceXaf,
      countedXaf,
      expectedXaf: closingExpectedXaf,
      closedBy: author,
      forced,
      occurredAt: closedAt,
      commandId: envelope.command_id,
    });
  }
  if (precedesMovementAt !== null) {
    // AV-171 : clôture datée avant un mouvement déjà enregistré (hors ligne : fait accompli). Elle est
    // appliquée mais ne se valide pas d'office ; la Finance voit le mouvement que l'attendu exclut.
    await recordConflict(uow, {
      id: deps.idGenerator.newId(),
      commandId: envelope.command_id,
      conflictType: CASH_SESSION_CONFLICTS.closeBeforeMovements,
      entityType: 'CASH_SESSION',
      entityId: session.id,
      siteId: session.siteId,
      ownerRole: 'FINANCE',
      applied: true,
      details: {
        closedAt: closedAt.toISOString(),
        latestMovementAt: precedesMovementAt.toISOString(),
        countedXaf,
        closingExpectedXaf,
        varianceXaf,
        status,
        forced,
        capturedOffline: offline,
        deviceId: origin.deviceId,
        authorUserId: author,
      },
    });
  }
  const serverRefs = {
    cashSessionId: session.id,
    closingExpectedXaf: String(closingExpectedXaf),
    varianceXaf: String(varianceXaf),
    status,
    ...(approvalRequestId !== null ? { approvalRequestId } : {}),
  };
  const audit = {
    after: {
      cashSessionId: session.id,
      aliasOf: input.aliasOf,
      countedXaf,
      comment: input.comment,
      reason: input.reason,
      closedAt: closedAt.toISOString(),
      closingExpectedXaf,
      varianceXaf,
      status,
      autoValidated,
      forced,
      precedesMovementAt: precedesMovementAt?.toISOString() ?? null,
      approvalRequestId,
    },
  };
  return precedesMovementAt !== null
    ? {
        status: 'APPLIED_WITH_WARNINGS',
        warnings: ['CASH_SESSION_CLOSE_BEFORE_MOVEMENTS'],
        serverRefs,
        audit,
      }
    : { status: 'APPLIED', serverRefs, audit };
}

/**
 * AV-171 : la clôture précède-t-elle un mouvement déjà enregistré ? Un refus en ligne (`rejection`), ou
 * le mouvement à signaler (`flaggedMovementAt`, hors ligne), ou rien.
 */
async function closeVersusLedger(
  uow: UnitOfWork,
  session: CashSessionRow,
  closedAt: Date,
  offline: boolean,
): Promise<{ rejection: CommandHandlerOutcome | null; flaggedMovementAt: Date | null }> {
  const check = checkCashSessionCloseAgainstLedger({
    closedAt,
    latestMovementAt: await latestMovementAtOrAfter(uow, session.cashAccountId, closedAt),
    capturedOffline: offline,
  });
  if (check.kind === 'REJECT') {
    return {
      rejection: rejected(
        check.code,
        `La clôture est datée avant un mouvement déjà enregistré sur cette caisse (${check.latestMovementAt.toISOString()}) : vérifier l’horloge de l’appareil, puis clôturer à l’heure réelle.`,
      ),
      flaggedMovementAt: null,
    };
  }
  return {
    rejection: null,
    flaggedMovementAt: check.kind === 'FLAG' ? check.latestMovementAt : null,
  };
}

/**
 * Clôture saisie hors ligne d'une session qui n'est plus ouverte, ou datée avant son ouverture : le
 * comptage est conservé comme observation (session et registre inchangés, INV-FIN-05 pour une session
 * validée), conflit informatif pour la Finance (ADR-032 §8).
 */
async function observeClosing(
  uow: UnitOfWork,
  deps: Deps,
  input: {
    readonly envelope: CommandEnvelope<CashSessionClosePayload>;
    readonly session: CashSessionRow;
    readonly reason: 'ALREADY_CLOSED' | 'CLOSE_BEFORE_OPEN';
    readonly aliasOf: string | null;
  },
): Promise<CommandHandlerOutcome> {
  const { envelope, session } = input;
  const origin = await loadCommandOrigin(uow, envelope.command_id);
  const details = {
    reason: input.reason,
    proposedSessionId: input.aliasOf,
    countedXaf: envelope.payload.countedXaf,
    occurredAt: envelope.occurred_at,
    comment: envelope.payload.comment ?? null,
    existingOpenedAt: session.openedAt.toISOString(),
    existingClosedAt: session.closedAt?.toISOString() ?? null,
    existingCountedXaf: session.closingCountedXaf,
    existingStatus: session.status,
    existingForced: session.forceClosed,
    existingClosedBy: session.closedBy,
    deviceId: origin.deviceId,
    authorUserId: envelope.author_user_id,
  };
  await recordConflict(uow, {
    id: deps.idGenerator.newId(),
    commandId: envelope.command_id,
    conflictType: CASH_SESSION_CONFLICTS.concurrentClose,
    entityType: 'CASH_SESSION',
    entityId: session.id,
    siteId: session.siteId,
    ownerRole: 'FINANCE',
    applied: true,
    details,
  });
  return {
    status: 'APPLIED_WITH_WARNINGS',
    warnings: ['CASH_SESSION_CONCURRENT_CLOSE'],
    serverRefs: { cashSessionId: session.id, status: session.status },
    audit: { after: { observation: true, cashSessionId: session.id, ...details } },
  };
}

// --- finance.cash_session.close ---------------------------------------------------------------------------

function closeHandler(deps: Deps): CommandHandler<CashSessionClosePayload> {
  return async (uow, envelope) => {
    const resolved = await resolveSessionTarget(uow, envelope.aggregate_id);
    if (!resolved) return SESSION_NOT_FOUND;
    const occurredAt = new Date(envelope.occurred_at);
    const session = await lockForClose(uow, resolved.session);
    if (
      !(await allowedOnSite(uow, {
        userId: envelope.author_user_id,
        permissionCode: CASH_SESSION_OPERATE,
        occurredAt,
        siteId: session.siteId,
      }))
    ) {
      return FORBIDDEN_SCOPE;
    }

    const plan = planCashSessionClose({
      session,
      closedAt: occurredAt,
      capturedOffline: envelope.captured_offline,
    });
    if (plan.kind === 'REJECT') {
      return plan.code === 'CASH_SESSION_NOT_OPEN'
        ? rejected(plan.code, 'Cette session de caisse n’est plus ouverte.')
        : rejected(plan.code, 'La clôture ne peut pas précéder l’ouverture de la session.');
    }
    if (plan.kind === 'OBSERVE') {
      return observeClosing(uow, deps, {
        envelope,
        session,
        reason: plan.reason,
        aliasOf: resolved.aliasOf,
      });
    }
    const versusLedger = await closeVersusLedger(
      uow,
      session,
      plan.closedAt,
      envelope.captured_offline,
    );
    if (versusLedger.rejection) return versusLedger.rejection;
    try {
      return await closeSession(uow, deps, {
        envelope,
        session,
        closedAt: plan.closedAt,
        countedXaf: envelope.payload.countedXaf,
        forced: false,
        reason: null,
        comment: envelope.payload.comment ?? null,
        aliasOf: resolved.aliasOf,
        precedesMovementAt: versusLedger.flaggedMovementAt,
      });
    } catch (error) {
      return cashRejection(error);
    }
  };
}

// --- finance.cash_session.force_close ---------------------------------------------------------------------

function forceCloseHandler(deps: Deps): CommandHandler<CashSessionForceClosePayload> {
  return async (uow, envelope) => {
    if (envelope.captured_offline) {
      return rejected(
        'ONLINE_REQUIRED',
        'La clôture forcée d’une session se fait en ligne, par la Finance ou la Direction.',
      );
    }
    const resolved = await resolveSessionTarget(uow, envelope.aggregate_id);
    if (!resolved) return SESSION_NOT_FOUND;
    const occurredAt = new Date(envelope.occurred_at);
    const session = await lockForClose(uow, resolved.session);
    if (
      !(await allowedOnSite(uow, {
        userId: envelope.author_user_id,
        permissionCode: CASH_SESSION_VALIDATE,
        occurredAt,
        siteId: session.siteId,
      }))
    ) {
      return FORBIDDEN_SCOPE;
    }
    if (session.status !== 'OPEN') {
      return rejected('CASH_SESSION_NOT_OPEN', 'Cette session de caisse n’est plus ouverte.');
    }
    const thresholdHours = positiveHours(
      await cashSetting(uow, 'forceCloseHours', session.siteId, occurredAt),
      24,
    );
    if (!cashSessionOpenLongerThan(session.openedAt, occurredAt, thresholdHours)) {
      return rejected(
        'CASH_SESSION_FORCE_CLOSE_TOO_EARLY',
        `Une session ne se clôture d’office qu’après plus de ${thresholdHours} h d’ouverture (finance.cash_session_force_close_hours).`,
      );
    }
    const versusLedger = await closeVersusLedger(uow, session, occurredAt, false);
    if (versusLedger.rejection) return versusLedger.rejection;
    try {
      return await closeSession(uow, deps, {
        envelope,
        session,
        closedAt: occurredAt,
        countedXaf: envelope.payload.countedXaf,
        forced: true,
        reason: envelope.payload.reason,
        comment: null,
        aliasOf: resolved.aliasOf,
        precedesMovementAt: versusLedger.flaggedMovementAt,
      });
    } catch (error) {
      return cashRejection(error);
    }
  };
}

// --- finance.cash_session.validate (P5-13) ------------------------------------------------------------------

/**
 * Façade de la décision `CASH_VARIANCE` (ADR-032 §5, SM-CASH-SESSION) : l'identifiant d'agrégat est
 * celui de la session `PENDING_VALIDATION`, ou celui d'un ajustement à validation propre d'une session
 * `VALIDATED`. Avec une demande liée, la décision passe par `approvals` (`decideApprovalRequest` :
 * droit d'approbation, auto-approbation, pièces) puis par le gestionnaire `CASH_VARIANCE` ; sans
 * demande (aucune politique active à la clôture, AV-183), la validation est directe. En ligne
 * seulement ; motif (`reason`) exigé dès qu'un écart existe.
 */
function validateHandler(
  deps: Deps,
  decisionRegistry: ApprovalDecisionHandlerRegistry,
): CommandHandler<CashSessionValidatePayload> {
  return async (uow, envelope) => {
    if (envelope.captured_offline) {
      return rejected(
        'ONLINE_REQUIRED',
        'La validation d’un écart de caisse se fait en ligne, par la Finance ou la Direction.',
      );
    }
    const target = await resolveCashValidationTarget(uow, envelope.aggregate_id);
    if (!target) return SESSION_NOT_FOUND;
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    if (
      !(await allowedOnSite(uow, {
        userId: author,
        permissionCode: CASH_SESSION_VALIDATE,
        occurredAt: at,
        siteId: target.session.siteId,
      }))
    ) {
      return FORBIDDEN_SCOPE;
    }
    const reason = envelope.payload.reason?.trim() || null;
    const requestId =
      target.kind === 'SESSION' ? target.approvalRequestId : target.adjustment.approvalRequestId;
    if (requestId !== null) {
      const decided = await decideApprovalRequest(uow, decisionRegistry, {
        requestId,
        decision: 'APPROVED',
        decidedBy: author,
        decidedAt: at,
        ...(reason !== null ? { comment: reason, decisionData: { reason } } : {}),
      });
      if (!decided.ok) return rejected(decided.errorCode, decided.messageFr);
    } else {
      const refusal =
        target.kind === 'SESSION'
          ? await validateCashSession(uow, deps, {
              sessionId: target.session.id,
              requestId: null,
              validatorId: author,
              at,
              reason,
              commandId: envelope.command_id,
            })
          : await validateCashSessionAdjustment(uow, deps, {
              adjustmentId: target.adjustment.id,
              requestId: null,
              validatorId: author,
              at,
              reason,
              commandId: envelope.command_id,
            });
      if (refusal) return rejected(refusal.errorCode, refusal.messageFr);
    }
    const serverRefs = {
      cashSessionId: target.session.id,
      ...(target.kind === 'ADJUSTMENT' ? { adjustmentId: target.adjustment.id } : {}),
      status: 'VALIDATED',
      ...(requestId !== null ? { approvalRequestId: requestId } : {}),
    };
    return {
      status: 'APPLIED',
      serverRefs,
      audit: {
        before: {
          status: target.kind === 'SESSION' ? target.session.status : target.adjustment.status,
        },
        after: { ...serverRefs, reason, validatedBy: author, validatedAt: at.toISOString() },
      },
    };
  };
}

export function registerCashSessionCommands(
  registry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
  decisionRegistry: ApprovalDecisionHandlerRegistry,
): void {
  const deps: Deps = { idGenerator };
  registerCashVarianceDecisions(decisionRegistry, deps);
  registry.register({
    commandType: 'finance.cash_session.open',
    version: 1,
    payloadSchema: cashSessionOpenPayloadSchema,
    permissionCode: CASH_SESSION_OPERATE,
    handler: openHandler(deps),
    isolationLevel: 'read committed',
  });
  registry.register({
    commandType: 'finance.cash_session.close',
    version: 1,
    payloadSchema: cashSessionClosePayloadSchema,
    permissionCode: CASH_SESSION_OPERATE,
    handler: closeHandler(deps),
    isolationLevel: 'read committed',
  });
  registry.register({
    commandType: 'finance.cash_session.force_close',
    version: 1,
    payloadSchema: cashSessionForceClosePayloadSchema,
    permissionCode: CASH_SESSION_VALIDATE,
    handler: forceCloseHandler(deps),
    isolationLevel: 'read committed',
  });
  // Validation : en ligne ; verrous compte puis session (puis ajustements), sans lecture par plage des
  // sessions : isolation par défaut (ADR-034 ne s'applique pas).
  registry.register({
    commandType: 'finance.cash_session.validate',
    version: 1,
    payloadSchema: cashSessionValidatePayloadSchema,
    permissionCode: CASH_SESSION_VALIDATE,
    handler: validateHandler(deps, decisionRegistry),
  });
}
