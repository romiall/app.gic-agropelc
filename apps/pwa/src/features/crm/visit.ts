/**
 * ECR-CRM-04 « + VISITE » (BR-CRM-012 à 016) : logique pure. Résultat obligatoire (motif
 * `VISIT_OUTCOME`), position si disponible, prochaine action facultative. Les indicateurs que le
 * serveur posera (`OUT_OF_SESSION`, `SESSION_REJECTED`, `FAR_FROM_CUSTOMER`) sont annoncés avant
 * l'envoi par `evaluateVisit`, le même calcul que le serveur ; ils signalent, ne bloquent jamais
 * (AV-023). Le serveur rattache lui-même la visite à la session de travail couvrant `occurred_at`.
 */
import { evaluateVisit, type GeoPoint, type VisitFlag } from '@gic/domain';
import type { OutboxCommand } from '../../storage/db.js';
import { stillInFlight } from '../sales/pending.js';
import type { CustomerData, ReasonCodeData, WorkSessionData } from '../sales/types.js';
import type { Position } from './prospect.js';

export const MAX_VISIT_NOTES = 4000;
export const MAX_NEXT_ACTION_NOTE = 2000;
/** Paramètre `crm.visit.max_distance_m` : valeur semée, tant que le paramètre n'est pas servi (S-15). */
export const DEFAULT_VISIT_MAX_DISTANCE_M = 500;
/** BR-CRM-014 : la position d'une visite précise à 50 m au plus est proposée pour le compte. */
export const CUSTOMER_POSITION_MAX_ACCURACY_M = 50;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface VisitDraft {
  readonly customerId: string | null;
  readonly position: Position | null;
  readonly outcomeId: string;
  readonly notes: string;
  /** `AAAA-MM-JJ`, ou vide. */
  readonly nextActionAt: string;
  readonly nextActionNote: string;
  /** BR-CRM-014 : enregistrer la position de la visite comme celle du compte. */
  readonly saveCustomerPosition: boolean;
}

export const EMPTY_VISIT: VisitDraft = {
  customerId: null,
  position: null,
  outcomeId: '',
  notes: '',
  nextActionAt: '',
  nextActionNote: '',
  saveCustomerPosition: true,
};

export type VisitIssue =
  'CUSTOMER_REQUIRED' | 'OUTCOME_REQUIRED' | 'COMMENT_REQUIRED' | 'NEXT_ACTION_PAST';

export interface VisitCheck {
  readonly issues: readonly VisitIssue[];
  /** Indicateurs que le serveur posera (signalement seulement). */
  readonly flags: readonly VisitFlag[];
  readonly distanceToCustomerM: number | null;
}

/** Résultats de visite proposés : motifs `VISIT_OUTCOME` actifs, par libellé. */
export function visitOutcomes(reasons: readonly ReasonCodeData[]): ReasonCodeData[] {
  return reasons
    .filter((reason) => reason.category === 'VISIT_OUTCOME' && reason.is_active)
    .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
}

/** Position enregistrée du compte, si elle est lisible. */
export function customerPosition(customer: Pick<CustomerData, 'lat' | 'lng'>): GeoPoint | null {
  if (customer.lat == null || customer.lng == null) return null;
  const lat = Number(customer.lat);
  const lng = Number(customer.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function sessionState(session: WorkSessionData | undefined): 'NONE' | 'OPEN' | 'OPEN_REJECTED' {
  if (!session) return 'NONE';
  return session.override_status === 'REJECTED' ? 'OPEN_REJECTED' : 'OPEN';
}

export function checkVisit(
  draft: VisitDraft,
  context: {
    readonly customer: CustomerData | undefined;
    readonly session: WorkSessionData | undefined;
    readonly maxDistanceM: number;
    /** Jour métier courant (`AAAA-MM-JJ`). */
    readonly today: string;
    /** Le résultat choisi exige un commentaire (motif « Autre », AV-248 ; `requires_comment`). */
    readonly outcomeRequiresComment?: boolean;
  },
): VisitCheck {
  const issues: VisitIssue[] = [];
  if (!draft.customerId || !context.customer) issues.push('CUSTOMER_REQUIRED');
  if (!draft.outcomeId) issues.push('OUTCOME_REQUIRED');
  if (draft.outcomeId && context.outcomeRequiresComment && !draft.notes.trim()) {
    issues.push('COMMENT_REQUIRED');
  }
  if (
    draft.nextActionAt &&
    (!DATE_ONLY.test(draft.nextActionAt) || draft.nextActionAt < context.today)
  ) {
    issues.push('NEXT_ACTION_PAST');
  }
  let evaluation: {
    readonly distanceToCustomerM: number | null;
    readonly flags: readonly VisitFlag[];
  };
  try {
    evaluation = evaluateVisit({
      visitPosition: draft.position ? { lat: draft.position.lat, lng: draft.position.lng } : null,
      customerPosition: context.customer ? customerPosition(context.customer) : null,
      maxDistanceM: context.maxDistanceM,
      session: sessionState(context.session),
    });
  } catch {
    // Position hors des bornes : la visite part sans indicateur de distance.
    evaluation = {
      distanceToCustomerM: null,
      flags: evaluateVisit({
        visitPosition: null,
        customerPosition: null,
        maxDistanceM: context.maxDistanceM,
        session: sessionState(context.session),
      }).flags,
    };
  }
  return { issues, ...evaluation };
}

/**
 * BR-CRM-014 : proposer d'enregistrer la position de la visite pour un compte qui n'en a pas, si
 * elle est précise à 50 m et qu'aucune mise à jour de position de l'appareil n'est déjà en route.
 */
export function proposesCustomerPosition(
  customer: CustomerData | undefined,
  position: Position | null,
  outbox: readonly OutboxCommand[],
  customersPulledAt: string | undefined,
): boolean {
  if (!customer || !position || position.accuracyM === null) return false;
  if (position.accuracyM > CUSTOMER_POSITION_MAX_ACCURACY_M) return false;
  if (customerPosition(customer) !== null) return false;
  return !outbox.some(
    (command) =>
      command.command_type === 'crm.customer.update' &&
      command.aggregate_id === customer.id &&
      (command.payload as { patch?: { position?: unknown } }).patch?.position !== undefined &&
      stillInFlight(command, customersPulledAt),
  );
}

const optionalText = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

/** Charge utile de `crm.visit.record` ; `position` est toujours présente (null sans GPS). */
export function visitPayload(draft: VisitDraft) {
  const notes = optionalText(draft.notes);
  const nextActionNote = optionalText(draft.nextActionNote);
  return {
    customerId: draft.customerId,
    position: draft.position
      ? { lat: draft.position.lat, lng: draft.position.lng, accuracyM: draft.position.accuracyM }
      : null,
    outcomeReasonCodeId: draft.outcomeId,
    ...(notes ? { notes } : {}),
    ...(draft.nextActionAt ? { nextActionAt: draft.nextActionAt } : {}),
    ...(nextActionNote ? { nextActionNote } : {}),
  };
}

/** Charge utile de `crm.customer.update` qui enregistre la position du compte (BR-CRM-014). */
export function customerPositionPayload(position: Position) {
  return {
    patch: {
      position: { lat: position.lat, lng: position.lng, accuracyM: position.accuracyM },
    },
  };
}
