/**
 * Cycle de vie d'une session de caisse (P5-12 ; ADR-032 §2, §4, §5, §8 ; D05 BR-DIS-005 à 007 ;
 * SM-CASH-SESSION ; AV-154 à AV-156, AV-165, AV-167 à AV-170), partagé appareil et serveur (ADR-021).
 * Pur, sans entrée-sortie : l'appelant fournit les sessions du compte déjà lues (sous verrou côté
 * serveur), ce module décide.
 *
 * - **Ouverture** (`planCashSessionOpen`) : créer, refuser (en ligne seulement) ou, hors ligne,
 *   fusionner dans une session existante ; jamais de chevauchement de fenêtres (`[ouverture,
 *   clôture[` d'un compte, même formule que le filet de la base) ; limite de sessions par jour métier.
 * - **Clôture** (`planCashSessionClose`) : clore, refuser (en ligne) ou, hors ligne, conserver le
 *   comptage comme observation (course avec une autre clôture, clôture datée avant l'ouverture).
 * - **Clôture face au registre** (`checkCashSessionCloseAgainstLedger`) : une clôture datée avant un
 *   mouvement déjà enregistré est refusée en ligne, signalée hors ligne (AV-171).
 * - **Statut après clôture** (`sessionStatusAfterClose`) : composé de `statusAfterClose` (P5-02),
 *   écart d'ouverture compris ; une clôture forcée attend toujours la Finance.
 *
 * Les choix laissés ouverts par les sources sont des points AV dont le défaut est un paramètre de ces
 * fonctions (CLAUDE.md règle 2) : AV-167 (ouverture plus ancienne que la session qu'elle chevauche),
 * AV-168 (ouverture tombée dans la fenêtre d'une session de la veille close depuis), AV-169 (clôture
 * datée avant l'ouverture), AV-170 (responsable imputé d'un écart), AV-171 (clôture datée avant un
 * mouvement déjà enregistré).
 */
import { businessDayOf } from './business-day.js';
import { DomainError } from './errors.js';
import {
  cashSessionWindowsOverlap,
  statusAfterClose,
  type CashSessionStatus,
} from './cash-session.js';

/** Session existante du compte, telle que lue par l'appelant. */
export interface ExistingCashSession {
  readonly id: string;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly status: CashSessionStatus;
}

// --- Ouverture -----------------------------------------------------------------------------------------------

/**
 * AV-168 : ouverture saisie hors ligne dont l'heure tombe dans la fenêtre d'une session d'un jour
 * métier **antérieur**, close depuis (clôture forcée par la Finance, ou clôture tardive).
 * `SHIFT` (défaut) : l'ouverture prend effet à la clôture de cette session (aucun chevauchement), le
 * comptage est conservé ; `MERGE` : fusion dans la session close, la journée reste sans session.
 */
export const CASH_SESSION_PREVIOUS_DAY_OVERLAP_MODES = ['SHIFT', 'MERGE'] as const;
export type CashSessionPreviousDayOverlapMode =
  (typeof CASH_SESSION_PREVIOUS_DAY_OVERLAP_MODES)[number];
export const CASH_SESSION_PREVIOUS_DAY_OVERLAP_DEFAULT: CashSessionPreviousDayOverlapMode = 'SHIFT';

export type CashSessionOpenRejection =
  'CASH_SESSION_ALREADY_OPEN' | 'CASH_SESSION_OVERLAP' | 'CASH_SESSION_DAILY_LIMIT';

export type CashSessionMergeReason =
  'OPEN_SESSION_EXISTS' | 'OVERLAPS_CLOSED_SESSION' | 'DAILY_LIMIT_REACHED';

export type CashSessionOpenPlan =
  | {
      readonly kind: 'CREATE';
      /** Heure retenue pour l'ouverture : celle saisie, ou la clôture de la session de la veille (AV-168). */
      readonly openedAt: Date;
      /** Heure saisie quand l'ouverture a été décalée (AV-168), sinon `null`. */
      readonly shiftedFrom: Date | null;
      /** Session de la veille après laquelle l'ouverture a été décalée, sinon `null`. */
      readonly shiftedAfterSessionId: string | null;
    }
  | {
      readonly kind: 'REJECT';
      readonly code: CashSessionOpenRejection;
      readonly targetSessionId: string;
    }
  | {
      readonly kind: 'MERGE';
      readonly targetSessionId: string;
      readonly reason: CashSessionMergeReason;
      /** AV-167 : l'ouverture saisie précède l'ouverture de la session retenue. */
      readonly earlierThanTarget: boolean;
      /** Heure retenue avant la fusion (différente de l'heure saisie après un décalage AV-168). */
      readonly consideredOpenedAt: Date;
    };

export interface PlanCashSessionOpenInput {
  /** Heure de l'ouverture saisie (`occurred_at`). */
  readonly openedAt: Date;
  readonly capturedOffline: boolean;
  /**
   * Sessions du compte susceptibles d'être en cause : ouvertes, closes après `openedAt`, ou du même
   * jour métier. Une session hors de ces cas est sans effet sur la décision.
   */
  readonly sessions: readonly ExistingCashSession[];
  /**
   * `finance.cash_sessions_per_day_max` (AV-154) : 0 = sans limite (défaut depuis la décision du
   * 13/10/2026) ; une valeur négative ou invalide vaut aussi « sans limite ».
   */
  readonly maxSessionsPerDay: number;
  readonly previousDayOverlap?: CashSessionPreviousDayOverlapMode;
}

/**
 * Limite de sessions par jour (AV-154, tranché le 13/10/2026 : sans limite par défaut) : entier ≥ 1, ou
 * `Infinity` pour 0 (sans limite) et pour une valeur absurde, qui ne bloque jamais une ouverture.
 */
export function normalizedSessionsPerDay(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : Number.POSITIVE_INFINITY;
}

const byOpening = (a: ExistingCashSession, b: ExistingCashSession) =>
  a.openedAt.getTime() - b.openedAt.getTime() || a.id.localeCompare(b.id);

/**
 * Décision d'ouverture (ADR-032 §2 et §8 ; AV-154). Une fenêtre `[openedAt, +∞[` qui chevaucherait une
 * session du compte (ouverte, ou close après `openedAt`) n'est jamais créée : en ligne, refus
 * (`CASH_SESSION_ALREADY_OPEN` si une session ouverte est en cause, `CASH_SESSION_OVERLAP` sinon) ;
 * hors ligne, fusion dans la plus ancienne session en cause (comptage conservé par l'appelant comme
 * observation, BR-SYN-007), sauf le décalage d'AV-168. Sans chevauchement, la limite du jour métier de
 * l'ouverture s'applique (`CASH_SESSION_DAILY_LIMIT` en ligne, fusion dans la plus ancienne session du
 * jour hors ligne).
 */
export function planCashSessionOpen(input: PlanCashSessionOpenInput): CashSessionOpenPlan {
  const mode = input.previousDayOverlap ?? CASH_SESSION_PREVIOUS_DAY_OVERLAP_DEFAULT;
  const requested = input.openedAt;
  const sessions = [...input.sessions].sort(byOpening);
  const maxPerDay = normalizedSessionsPerDay(input.maxSessionsPerDay);

  let openedAt = requested;
  let shiftedAfter: ExistingCashSession | null = null;
  // Au plus un décalage : la session de la veille couvre l'heure saisie, la fenêtre qui suit sa clôture
  // est évaluée comme une ouverture ordinaire (fusion si une autre session y est déjà).
  for (;;) {
    const window = { openedAt, closedAt: null };
    const overlapping = sessions.filter((session) => cashSessionWindowsOverlap(window, session));
    if (overlapping.length > 0) {
      if (!input.capturedOffline) {
        const open = overlapping.find((session) => session.status === 'OPEN');
        return open
          ? { kind: 'REJECT', code: 'CASH_SESSION_ALREADY_OPEN', targetSessionId: open.id }
          : { kind: 'REJECT', code: 'CASH_SESSION_OVERLAP', targetSessionId: overlapping[0]!.id };
      }
      const covering = overlapping.find(
        (session) => session.closedAt !== null && session.openedAt.getTime() <= openedAt.getTime(),
      );
      if (
        mode === 'SHIFT' &&
        shiftedAfter === null &&
        covering !== undefined &&
        businessDayOf(covering.openedAt) < businessDayOf(openedAt)
      ) {
        shiftedAfter = covering;
        openedAt = covering.closedAt!;
        continue;
      }
      const target = overlapping[0]!;
      return {
        kind: 'MERGE',
        targetSessionId: target.id,
        reason: target.status === 'OPEN' ? 'OPEN_SESSION_EXISTS' : 'OVERLAPS_CLOSED_SESSION',
        earlierThanTarget: requested.getTime() < target.openedAt.getTime(),
        consideredOpenedAt: openedAt,
      };
    }

    const day = businessDayOf(openedAt);
    const sameDay = sessions.filter((session) => businessDayOf(session.openedAt) === day);
    if (sameDay.length >= maxPerDay) {
      const target = sameDay[0]!;
      if (!input.capturedOffline) {
        return { kind: 'REJECT', code: 'CASH_SESSION_DAILY_LIMIT', targetSessionId: target.id };
      }
      return {
        kind: 'MERGE',
        targetSessionId: target.id,
        reason: 'DAILY_LIMIT_REACHED',
        earlierThanTarget: requested.getTime() < target.openedAt.getTime(),
        consideredOpenedAt: openedAt,
      };
    }
    return {
      kind: 'CREATE',
      openedAt,
      shiftedFrom: shiftedAfter === null ? null : requested,
      shiftedAfterSessionId: shiftedAfter?.id ?? null,
    };
  }
}

/**
 * ADR-032 §4 : un mouvement entre-t-il dans le solde du registre à l'ouverture ? Oui s'il précède
 * l'ouverture ; à l'instant exact de l'ouverture, seul un `SESSION_VARIANCE` y entre (écart de la
 * clôture précédente posé au même instant : sinon il serait compté deux fois, comme écart de clôture
 * puis comme écart d'ouverture). Un mouvement ordinaire à cet instant appartient à la nouvelle fenêtre.
 */
export function countsInOpeningBalance(
  movement: { readonly occurredAt: Date; readonly movementType: string },
  openedAt: Date,
): boolean {
  const at = movement.occurredAt.getTime();
  const opening = openedAt.getTime();
  return at < opening || (at === opening && movement.movementType === 'SESSION_VARIANCE');
}

// --- Clôture -------------------------------------------------------------------------------------------------

/**
 * AV-169 : clôture saisie hors ligne datée avant l'ouverture de la session visée (session fusionnée
 * ouverte plus tard par une autre tablette, horloge décalée). `OBSERVE` (défaut) : comptage conservé
 * comme observation, session laissée ouverte ; `CLOSE_AT_OPENING` : clôture ramenée à l'ouverture.
 */
export const CASH_SESSION_CLOSE_BEFORE_OPEN_MODES = ['OBSERVE', 'CLOSE_AT_OPENING'] as const;
export type CashSessionCloseBeforeOpenMode = (typeof CASH_SESSION_CLOSE_BEFORE_OPEN_MODES)[number];
export const CASH_SESSION_CLOSE_BEFORE_OPEN_DEFAULT: CashSessionCloseBeforeOpenMode = 'OBSERVE';

export type CashSessionClosePlan =
  | {
      readonly kind: 'CLOSE';
      readonly closedAt: Date;
      /** Heure saisie quand la clôture a été ramenée à l'ouverture (AV-169), sinon `null`. */
      readonly clampedFrom: Date | null;
    }
  | {
      readonly kind: 'REJECT';
      readonly code: 'CASH_SESSION_NOT_OPEN' | 'CASH_SESSION_CLOSE_BEFORE_OPEN';
    }
  | { readonly kind: 'OBSERVE'; readonly reason: 'ALREADY_CLOSED' | 'CLOSE_BEFORE_OPEN' };

/**
 * Décision de clôture (SM-CASH-SESSION ; ADR-032 §8). En ligne : refus d'une session qui n'est plus
 * ouverte ou d'une clôture datée avant l'ouverture. Hors ligne : le comptage est un constat physique
 * déjà accompli, jamais rejeté ; il devient une observation quand la session n'est plus ouverte (autre
 * tablette, clôture forcée) ou, par défaut, quand il précède l'ouverture (AV-169).
 */
export function planCashSessionClose(input: {
  readonly session: Pick<ExistingCashSession, 'openedAt' | 'status'>;
  readonly closedAt: Date;
  readonly capturedOffline: boolean;
  readonly beforeOpen?: CashSessionCloseBeforeOpenMode;
}): CashSessionClosePlan {
  if (input.session.status !== 'OPEN') {
    return input.capturedOffline
      ? { kind: 'OBSERVE', reason: 'ALREADY_CLOSED' }
      : { kind: 'REJECT', code: 'CASH_SESSION_NOT_OPEN' };
  }
  if (input.closedAt.getTime() < input.session.openedAt.getTime()) {
    if (!input.capturedOffline) return { kind: 'REJECT', code: 'CASH_SESSION_CLOSE_BEFORE_OPEN' };
    return (input.beforeOpen ?? CASH_SESSION_CLOSE_BEFORE_OPEN_DEFAULT) === 'CLOSE_AT_OPENING'
      ? { kind: 'CLOSE', closedAt: input.session.openedAt, clampedFrom: input.closedAt }
      : { kind: 'OBSERVE', reason: 'CLOSE_BEFORE_OPEN' };
  }
  return { kind: 'CLOSE', closedAt: input.closedAt, clampedFrom: null };
}

/**
 * AV-171 : une clôture dont l'heure précède un mouvement déjà enregistré sur le compte (hors écarts et
 * solde d'ouverture) exclut ce mouvement de l'attendu `[ouverture, clôture[` : un vendeur qui antidate
 * sa clôture compterait exactement l'attendu tronqué (écart nul, validation d'office) et garderait la
 * différence, retrouvée plus tard comme écart d'ouverture du vendeur suivant. `occurred_at` n'est
 * jamais corrigé en silence (ADR-016) : on refuse ou on signale.
 *
 * `REFUSE_ONLINE` (défaut) : refus en ligne (`CASH_SESSION_CLOSE_BEFORE_LAST_MOVEMENT`, sans effet) ;
 * hors ligne, le comptage est un fait accompli : la clôture est appliquée, jamais validée d'office, et
 * signalée à la Finance. `FLAG` : jamais de refus, signalement en ligne comme hors ligne.
 */
export const CASH_SESSION_CLOSE_BEFORE_MOVEMENTS_MODES = ['REFUSE_ONLINE', 'FLAG'] as const;
export type CashSessionCloseBeforeMovementsMode =
  (typeof CASH_SESSION_CLOSE_BEFORE_MOVEMENTS_MODES)[number];
export const CASH_SESSION_CLOSE_BEFORE_MOVEMENTS_DEFAULT: CashSessionCloseBeforeMovementsMode =
  'REFUSE_ONLINE';

export type CashSessionCloseLedgerCheck =
  | { readonly kind: 'OK' }
  | {
      readonly kind: 'REJECT';
      readonly code: 'CASH_SESSION_CLOSE_BEFORE_LAST_MOVEMENT';
      readonly latestMovementAt: Date;
    }
  | { readonly kind: 'FLAG'; readonly latestMovementAt: Date };

/**
 * Contrôle d'une clôture (ordinaire ou forcée) face au registre. `latestMovementAt` : le mouvement le
 * plus récent du compte daté à `closedAt` ou après, hors `SESSION_VARIANCE` et `OPENING_BALANCE`
 * (`CASH_EXPECTED_EXCLUDED_TYPES`), lu par l'appelant sous verrou ; `null` s'il n'y en a aucun. Un
 * mouvement daté exactement à `closedAt` est hors de la fenêtre demi-ouverte : il compte.
 */
export function checkCashSessionCloseAgainstLedger(input: {
  readonly closedAt: Date;
  readonly latestMovementAt: Date | null;
  readonly capturedOffline: boolean;
  readonly mode?: CashSessionCloseBeforeMovementsMode;
}): CashSessionCloseLedgerCheck {
  const latest = input.latestMovementAt;
  if (latest === null || latest.getTime() < input.closedAt.getTime()) return { kind: 'OK' };
  const mode = input.mode ?? CASH_SESSION_CLOSE_BEFORE_MOVEMENTS_DEFAULT;
  if (mode === 'REFUSE_ONLINE' && !input.capturedOffline) {
    return {
      kind: 'REJECT',
      code: 'CASH_SESSION_CLOSE_BEFORE_LAST_MOVEMENT',
      latestMovementAt: latest,
    };
  }
  return { kind: 'FLAG', latestMovementAt: latest };
}

/**
 * Statut après clôture (SM-CASH-SESSION ; ADR-032 §5 ; AV-057, AV-156, AV-171). Composé de
 * `statusAfterClose` appliqué à l'écart d'ouverture puis à l'écart de clôture : `VALIDATED` d'office
 * (sans valideur) seulement si **les deux** sont dans la tolérance ; une clôture forcée, ou datée avant
 * un mouvement déjà enregistré (`precedesMovements`), attend toujours la Finance.
 */
export function sessionStatusAfterClose(input: {
  readonly openingVarianceXaf: number;
  readonly closingVarianceXaf: number;
  readonly toleranceXaf: number;
  readonly forced: boolean;
  readonly precedesMovements?: boolean;
  /**
   * Un ajustement inclus dans la validation de la session attend encore (P5-23, AV-224 : ajustement de
   * l'écart d'ouverture) : la session ne se valide jamais d'office, l'ajustement se valide avec elle.
   */
  readonly pendingAdjustments?: boolean;
}): { readonly status: CashSessionStatus; readonly autoValidated: boolean } {
  const opening = statusAfterClose(input.openingVarianceXaf, input.toleranceXaf);
  const closing = statusAfterClose(input.closingVarianceXaf, input.toleranceXaf);
  if (
    !input.forced &&
    input.precedesMovements !== true &&
    input.pendingAdjustments !== true &&
    opening === 'VALIDATED' &&
    closing === 'VALIDATED'
  ) {
    return { status: 'VALIDATED', autoValidated: true };
  }
  return { status: 'PENDING_VALIDATION', autoValidated: false };
}

/**
 * BR-DIS-006, SM-CASH-SESSION : une session est-elle ouverte depuis **plus de** `thresholdHours`
 * (paramètre `finance.cash_session_force_close_hours`, 24 par défaut) à l'instant `at` ? Borne stricte :
 * à exactement 24 h, non.
 */
export function cashSessionOpenLongerThan(
  openedAt: Date,
  at: Date,
  thresholdHours: number,
): boolean {
  if (!Number.isFinite(thresholdHours) || thresholdHours <= 0) {
    throw new DomainError(
      'Le seuil d’une session ouverte trop longtemps est un nombre d’heures positif.',
      'THRESHOLD_INVALID',
    );
  }
  return at.getTime() - openedAt.getTime() > thresholdHours * 3_600_000;
}

// --- Imputation d'un écart (AV-155, AV-170) ------------------------------------------------------------------

/**
 * AV-170 : responsable imputé de l'écart d'une **clôture forcée**. `OPENER` (défaut) : l'ouvreur de la
 * session, qui ne l'a pas clôturée ; `NONE` : aucune imputation avant la décision de la Finance ;
 * `FORCER` : l'auteur de la clôture forcée.
 */
export const CASH_FORCED_VARIANCE_IMPUTATIONS = ['OPENER', 'NONE', 'FORCER'] as const;
export type CashForcedVarianceImputation = (typeof CASH_FORCED_VARIANCE_IMPUTATIONS)[number];
export const CASH_FORCED_VARIANCE_IMPUTATION_DEFAULT: CashForcedVarianceImputation = 'OPENER';

/**
 * Utilisateur à qui l'écart est imputé (historique par vendeur, D05 §14) : écart d'ouverture → celui
 * qui a compté le fonds (l'ouvreur, AV-170) ; écart de clôture → celui qui clôture (AV-155) ; écart
 * d'une clôture forcée → selon AV-170. `null` : aucune imputation.
 */
export function cashVarianceImputedUser(
  input: {
    readonly kind: 'OPENING' | 'CLOSING';
    readonly openedBy: string;
    readonly closedBy: string | null;
    readonly forced: boolean;
  },
  forcedImputation: CashForcedVarianceImputation = CASH_FORCED_VARIANCE_IMPUTATION_DEFAULT,
): string | null {
  if (input.kind === 'OPENING') return input.openedBy;
  if (!input.forced) return input.closedBy;
  switch (forcedImputation) {
    case 'OPENER':
      return input.openedBy;
    case 'FORCER':
      return input.closedBy;
    case 'NONE':
      return null;
  }
}
