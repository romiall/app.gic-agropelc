/**
 * Traitement pur d'un événement de déclenchement et cycle de vie d'une alerte (P9 ; ADR-061 ; SM-ALERT ;
 * BR-NOT-002, BR-NOT-003 ; INV-NOT-01 ; BR-SYN-007).
 *
 * Aucune entrée-sortie : le consommateur `communication.alerts` (serveur) lit l'événement, appelle
 * {@link alertFromEvent}, puis écrit. Le même code tourne dans les tests des détecteurs des modules
 * propriétaires, qui vérifient que leurs événements sont reconnus.
 */
import {
  ALERT_CATALOG,
  ALERT_PASS_COMPLETED_EVENT,
  ALERT_TYPES,
  alertDedupKey,
  alertDefinitionOf,
  alertSubjectKey,
  isAlertSeverity,
  isAlertType,
  type AlertEventPayload,
  type AlertSeverity,
  type AlertStatus,
  type AlertTrigger,
  type AlertType,
  type AlertTypeDefinition,
} from './alerts.js';

export interface AlertEventInput {
  readonly eventId: string;
  /** `event_type` stocké (nom logique du catalogue ou type de commande du pipeline). */
  readonly eventType: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly payload: AlertEventPayload;
}

/** Levée ou nouvelle occurrence d'une alerte (déduplication par `dedupKey`, INV-NOT-01). */
export interface AlertRaiseAction {
  readonly kind: 'RAISE';
  readonly alertType: AlertType;
  readonly subjectType: string;
  /** Identifiant d'agrégat ou nom canonique d'un sujet composite (le serveur en dérive un UUID v5). */
  readonly subjectKey: string;
  readonly dedupKey: string;
  /**
   * Gravité effective si la règle n'est pas lue : celle que l'événement déclare quand le type l'admet,
   * sinon la gravité par défaut du catalogue. Le consommateur préfère `declaredSeverity`, puis la
   * gravité **de la règle** (un administrateur peut l'avoir modifiée, AV-351).
   */
  readonly severity: AlertSeverity;
  /** Gravité portée par l'événement et admise par le type ; `null` si absente ou non admise. */
  readonly declaredSeverity: AlertSeverity | null;
  readonly siteId: string | null;
  readonly zoneId: string | null;
  readonly ownerUserIds: readonly string[];
  readonly recipientRoles: readonly string[];
  readonly teamManager: boolean;
  readonly approvers: boolean;
  readonly actionScreen: string | null;
  /** Jour métier du fait (absent : celui de l'événement, calculé par l'appelant). */
  readonly businessDay: string | null;
  /** Identité de la passe de détection qui a produit l'événement (ADR-061 §3) ; `null` hors passe. */
  readonly passId: string | null;
  readonly occurredAt: Date;
  readonly payload: AlertEventPayload;
}

/** Fin de la condition d'un sujet (événement de résolution, AV-353). */
export interface AlertResolveAction {
  readonly kind: 'RESOLVE';
  readonly alertType: AlertType;
  readonly subjectKey: string;
  readonly dedupKey: string;
  readonly reason: 'CONDITION_CLEARED';
  readonly occurredAt: Date;
}

/** Marqueur de fin d'une passe **complète** de détection (ADR-061 §3). */
export interface AlertPassCompletedAction {
  readonly kind: 'PASS_COMPLETED';
  readonly alertType: AlertType;
  readonly passId: string;
  /**
   * Portée de la passe quand plusieurs producteurs publient le même type d'alerte d'état (ex. justificatif
   * manquant d'une dépense et d'une réception) : le marqueur ne résout que les alertes de sa portée.
   */
  readonly scope: string | null;
  readonly businessDay: string | null;
  readonly occurredAt: Date;
}

export type AlertAction = AlertRaiseAction | AlertResolveAction | AlertPassCompletedAction;

export interface AlertEventIssue {
  readonly eventType: string;
  readonly alertType?: AlertType;
  readonly code: 'SUBJECT_MISSING' | 'PASS_MARKER_INVALID';
  readonly message: string;
}

export interface AlertFromEventResult {
  readonly actions: readonly AlertAction[];
  readonly issues: readonly AlertEventIssue[];
}

interface TriggerEntry {
  readonly definition: AlertTypeDefinition;
  readonly trigger: AlertTrigger;
}

function buildIndex(select: (definition: AlertTypeDefinition) => readonly AlertTrigger[]) {
  const index = new Map<string, TriggerEntry[]>();
  for (const type of ALERT_TYPES) {
    const definition = ALERT_CATALOG[type];
    for (const trigger of select(definition)) {
      const entries = index.get(trigger.eventType) ?? [];
      entries.push({ definition, trigger });
      index.set(trigger.eventType, entries);
    }
  }
  return index;
}

const RAISE_INDEX = buildIndex((definition) => definition.raisedBy);
const RESOLVE_INDEX = buildIndex((definition) => definition.resolvedBy);

/** Types de l'événement qui intéressent les alertes (filtre du consommateur avant de marquer l'événement). */
export function alertTriggerEventTypes(): readonly string[] {
  return [
    ...new Set([...RAISE_INDEX.keys(), ...RESOLVE_INDEX.keys(), ALERT_PASS_COMPLETED_EVENT]),
  ].sort();
}

/** Vrai si l'événement peut lever, résoudre ou clore une passe d'alerte. */
export function isAlertTriggerEvent(eventType: string): boolean {
  return (
    eventType === ALERT_PASS_COMPLETED_EVENT ||
    RAISE_INDEX.has(eventType) ||
    RESOLVE_INDEX.has(eventType)
  );
}

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

function ownerIds(definition: AlertTypeDefinition, payload: AlertEventPayload): string[] {
  const owners = new Set<string>();
  const collect = (fields: readonly string[]): void => {
    for (const field of fields) {
      const value = stringOrNull(payload[field]);
      if (value !== null) owners.add(value.toLowerCase());
    }
  };
  collect(definition.ownerFields);
  // Repli (AV-463) : seulement si aucun champ principal n'est renseigné.
  if (owners.size === 0) collect(definition.ownerFallbackFields ?? []);
  return [...owners];
}

function matches(trigger: AlertTrigger, payload: AlertEventPayload): boolean {
  return trigger.when === undefined || trigger.when(payload);
}

/**
 * Traduit un événement en actions d'alerte (zéro, une ou plusieurs : un même événement peut intéresser
 * plusieurs types). Un événement inconnu des alertes rend une liste vide, sans erreur.
 *
 * - **Levée** : le sujet est l'agrégat de l'événement ou le sujet composite du type ; sans sujet
 *   exploitable, aucune alerte n'est levée et un constat `SUBJECT_MISSING` est rendu.
 * - **Gravité** : celle de la charge utile si le type l'admet, sinon la gravité par défaut (AV-351).
 * - **Marqueur de passe** : `alert_type` connu et `pass_id` non vide, sinon `PASS_MARKER_INVALID`.
 */
export function alertFromEvent(event: AlertEventInput): AlertFromEventResult {
  const actions: AlertAction[] = [];
  const issues: AlertEventIssue[] = [];

  if (event.eventType === ALERT_PASS_COMPLETED_EVENT) {
    const alertType = event.payload['alert_type'];
    const passId = stringOrNull(event.payload['pass_id']);
    if (!isAlertType(alertType) || passId === null) {
      issues.push({
        eventType: event.eventType,
        code: 'PASS_MARKER_INVALID',
        message: 'Marqueur de passe sans type d’alerte connu ou sans identité de passe.',
      });
    } else {
      actions.push({
        kind: 'PASS_COMPLETED',
        alertType,
        passId,
        scope: stringOrNull(event.payload['scope']),
        businessDay: stringOrNull(event.payload['business_day']),
        occurredAt: event.occurredAt,
      });
    }
    return { actions, issues };
  }

  for (const { definition, trigger } of RAISE_INDEX.get(event.eventType) ?? []) {
    if (!matches(trigger, event.payload)) continue;
    const subjectKey = alertSubjectKey(definition, event.aggregateId, event.payload);
    if (subjectKey === undefined) {
      issues.push({
        eventType: event.eventType,
        alertType: definition.code,
        code: 'SUBJECT_MISSING',
        message: `Sujet inexploitable pour ${definition.code} (parties : ${
          definition.subjectParts?.join(', ') ?? 'agrégat'
        }).`,
      });
      continue;
    }
    const declared = event.payload['severity'];
    const declaredSeverity: AlertSeverity | null =
      isAlertSeverity(declared) && definition.severities.includes(declared) ? declared : null;
    const severity: AlertSeverity = declaredSeverity ?? definition.defaultSeverity;
    actions.push({
      kind: 'RAISE',
      alertType: definition.code,
      subjectType: definition.subjectType,
      subjectKey,
      dedupKey: alertDedupKey(definition.code, subjectKey),
      severity,
      declaredSeverity,
      siteId: stringOrNull(event.payload['site_id'])?.toLowerCase() ?? null,
      zoneId: stringOrNull(event.payload['zone_id'])?.toLowerCase() ?? null,
      ownerUserIds: ownerIds(definition, event.payload),
      recipientRoles: trigger.recipientRoles ?? definition.recipientRoles,
      teamManager: definition.teamManager,
      approvers: definition.approvers,
      actionScreen: definition.actionScreen,
      businessDay: stringOrNull(event.payload['business_day']),
      passId: stringOrNull(event.payload['pass_id']),
      occurredAt: event.occurredAt,
      payload: event.payload,
    });
  }

  for (const { definition, trigger } of RESOLVE_INDEX.get(event.eventType) ?? []) {
    if (!matches(trigger, event.payload)) continue;
    const subjectKey = alertSubjectKey(definition, event.aggregateId, event.payload);
    if (subjectKey === undefined) {
      issues.push({
        eventType: event.eventType,
        alertType: definition.code,
        code: 'SUBJECT_MISSING',
        message: `Sujet de résolution inexploitable pour ${definition.code}.`,
      });
      continue;
    }
    actions.push({
      kind: 'RESOLVE',
      alertType: definition.code,
      subjectKey,
      dedupKey: alertDedupKey(definition.code, subjectKey),
      reason: 'CONDITION_CLEARED',
      occurredAt: event.occurredAt,
    });
  }

  return { actions, issues };
}

// --- Cycle de vie (SM-ALERT) ------------------------------------------------------------------------

export const ALERT_COMMANDS = ['ACKNOWLEDGE', 'RESOLVE', 'DISMISS', 'AUTO_RESOLVE'] as const;
export type AlertCommand = (typeof ALERT_COMMANDS)[number];

export type AlertTransitionRefusal =
  | 'ALERT_COMMENT_REQUIRED'
  | 'ALERT_REASON_REQUIRED'
  | 'ALERT_DISMISS_NOT_ALLOWED'
  | 'ALERT_RESOLVE_NOT_ALLOWED';

export type AlertTransition =
  | { readonly ok: true; readonly changed: true; readonly status: AlertStatus }
  | {
      readonly ok: true;
      readonly changed: false;
      readonly status: AlertStatus;
      readonly reason: 'ALREADY_ACKNOWLEDGED' | 'ALREADY_CLOSED';
    }
  | { readonly ok: false; readonly code: AlertTransitionRefusal; readonly message: string };

export interface AlertTransitionInput {
  readonly status: AlertStatus;
  readonly command: AlertCommand;
  readonly definition: AlertTypeDefinition;
  /** Commentaire de résolution ou motif d'écart. */
  readonly text?: string | undefined;
}

const isClosed = (status: AlertStatus): boolean => status === 'RESOLVED' || status === 'DISMISSED';

/**
 * Transition demandée sur une alerte (SM-ALERT).
 *
 * - `ACKNOWLEDGE` : `OPEN` → `ACKNOWLEDGED` ; déjà prise en compte ou close : **sans effet**, jamais un
 *   rejet (BR-SYN-007 : un fait accompli hors ligne n'est pas refusé pour un état métier, AV-368).
 * - `RESOLVE` : commentaire obligatoire ; réservée aux alertes d'événement ou à résolution manuelle
 *   (une alerte d'état se résout seule quand la condition disparaît, BR-NOT-003).
 * - `DISMISS` : motif obligatoire ; réservé aux alertes d'événement (écarter une alerte d'état dont la
 *   condition dure la ferait renaître à la passe suivante, AV-354).
 * - `AUTO_RESOLVE` : le système, sur condition disparue ; sans commentaire.
 */
export function applyAlertCommand(input: AlertTransitionInput): AlertTransition {
  const { status, command, definition } = input;
  const text = input.text?.trim() ?? '';

  if (isClosed(status)) {
    return { ok: true, changed: false, status, reason: 'ALREADY_CLOSED' };
  }

  switch (command) {
    case 'ACKNOWLEDGE':
      if (status === 'ACKNOWLEDGED') {
        return { ok: true, changed: false, status, reason: 'ALREADY_ACKNOWLEDGED' };
      }
      return { ok: true, changed: true, status: 'ACKNOWLEDGED' };
    case 'RESOLVE':
      if (definition.nature === 'STATE' && definition.resolution === 'AUTO') {
        return {
          ok: false,
          code: 'ALERT_RESOLVE_NOT_ALLOWED',
          message: `${definition.code} se résout seule quand la condition disparaît.`,
        };
      }
      if (text === '') {
        return {
          ok: false,
          code: 'ALERT_COMMENT_REQUIRED',
          message: 'Un commentaire est obligatoire pour résoudre une alerte.',
        };
      }
      return { ok: true, changed: true, status: 'RESOLVED' };
    case 'DISMISS':
      if (definition.nature !== 'EVENT') {
        return {
          ok: false,
          code: 'ALERT_DISMISS_NOT_ALLOWED',
          message: `${definition.code} est une alerte d'état : prenez-la en compte plutôt que de l'écarter.`,
        };
      }
      if (text === '') {
        return {
          ok: false,
          code: 'ALERT_REASON_REQUIRED',
          message: 'Un motif est obligatoire pour écarter une alerte.',
        };
      }
      return { ok: true, changed: true, status: 'DISMISSED' };
    case 'AUTO_RESOLVE':
      return { ok: true, changed: true, status: 'RESOLVED' };
  }
}

// --- Résolution par marqueur de passe ---------------------------------------------------------------

export interface OpenAlertForPass {
  readonly id: string;
  readonly alertType: AlertType;
  readonly status: AlertStatus;
  readonly lastPassId: string | null;
}

/**
 * Alertes à résoudre quand une passe complète de détection se termine (ADR-061 §3) : ouvertes, du type
 * de la passe, d'état à résolution automatique, que cette passe n'a pas revues (`last_pass_id` différent,
 * jamais l'horloge). Une alerte levée hors passe (`last_pass_id` nul) est donc résolue si la passe,
 * complète, ne l'a pas revue.
 */
export function alertsResolvedByPass(
  open: readonly OpenAlertForPass[],
  marker: {
    readonly alertType: AlertType;
    readonly passId: string;
    readonly scope?: string | null | undefined;
  },
): readonly string[] {
  const definition = alertDefinitionOf(marker.alertType);
  if (definition.nature !== 'STATE' || definition.resolution !== 'AUTO') return [];
  const scopePrefix =
    marker.scope === undefined || marker.scope === null
      ? null
      : alertPassIdPrefix(marker.alertType, marker.scope);
  return open
    .filter(
      (alert) =>
        alert.alertType === marker.alertType &&
        (alert.status === 'OPEN' || alert.status === 'ACKNOWLEDGED') &&
        alert.lastPassId !== marker.passId &&
        // Passe à portée : seules les alertes levées par une passe de cette portée sont concernées.
        (scopePrefix === null ||
          (alert.lastPassId !== null && alert.lastPassId.startsWith(scopePrefix))),
    )
    .map((alert) => alert.id);
}

/** `last_pass_id` est une colonne de 64 caractères. */
const PASS_ID_MAX = 64;

/** Début commun des identités de passe d'un type d'alerte et d'une portée (ex. `ATTACHMENT_MISSING:EXPENSE:`). */
export function alertPassIdPrefix(alertType: string, scope?: string | null): string {
  return scope === undefined || scope === null || scope === ''
    ? `${alertType}:`
    : `${alertType}:${scope}:`;
}

/**
 * Identité d'une passe : type d'alerte, portée éventuelle et créneau (`scheduledFor` de la tâche, sinon
 * l'instant de lancement). Un rejeu du même créneau donne la même identité ; le début (type et portée)
 * n'est jamais tronqué.
 */
export function alertPassId(alertType: string, slot: string, scope?: string | null): string {
  return `${alertPassIdPrefix(alertType, scope)}${slot}`.slice(0, PASS_ID_MAX);
}
