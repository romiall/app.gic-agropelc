/**
 * Publication des événements de détection d'alertes (P9-07 ; ADR-071 §3, §4 ; INV-NOT-01). Outil commun
 * des modules propriétaires : un module détecte dans ses données (sur fait, sur transition ou par passe
 * planifiée) et publie ; la corrélation, la déduplication et la résolution sont l'affaire du consommateur
 * `communication.alerts`, qui n'est jamais importé ici (frontières de modules).
 *
 * - **Idempotence d'un événement de passe** : l'identifiant de l'événement est dérivé de (type, sujet,
 *   passe) ; une passe rejouée (même créneau, tâche reprise) ne publie pas deux fois le même sujet. C'est
 *   la clé (`pass_id`, sujet) de l'ADR-071 §3 — l'unicité de l'alerte ouverte reste portée par la base.
 *   Un rejeu est reconnu **avant** l'insertion : un `INSERT IGNORE` sur une clé en double consomme tout de
 *   même un numéro de séquence, et le trou ainsi laissé retarde les consommateurs de la fenêtre de
 *   stabilisation (120 s, AV-438).
 * - **Identité de passe** : propre à la passe et identique à son rejeu ; elle est reportée dans chaque
 *   événement et dans le marqueur. Le consommateur résout, au marqueur, les alertes d'état du type dont
 *   la dernière passe est une autre : la comparaison se fait par identité, jamais par horloge.
 * - **Portée** : deux producteurs d'un même type d'alerte d'état (justificatif manquant d'une dépense, d'une
 *   réception) ont chacun leur portée ; le marqueur d'une portée ne résout que les alertes de sa portée.
 * - **Marqueur** : publié en dernier, par une passe **complète** seulement (une passe interrompue ou
 *   partielle ne résout rien).
 */
import {
  ALERT_CATALOG,
  alertPassId,
  alertSubjectKey,
  type AlertType,
  type IdGenerator,
} from '@gic/domain';
import { jsonValue } from '../kysely/json-value.js';
import { toBin } from '../kysely/uuid-columns.js';
import { codeEntityId } from '../sync/code-entity-id.js';
import type { UnitOfWork } from '../unit-of-work.js';

/** Nom de l'événement de fin de passe (identique à `ALERT_PASS_COMPLETED_EVENT` du domaine). */
export const PASS_COMPLETED_EVENT = 'AlertDetectionPassCompleted';

/**
 * Identité d'une passe : le type d'alerte, la portée éventuelle et le créneau (`scheduledFor` de la tâche
 * planifiée, sinon l'instant de lancement). Un rejeu du même créneau donne la même identité. La **portée**
 * sépare les producteurs d'un même type d'alerte d'état : le marqueur d'une portée ne résout que les
 * alertes levées par une passe de cette portée. Plafonnée à 64 caractères (`last_pass_id`) sans entamer
 * le début (type et portée).
 */
export function detectionPassId(alertType: AlertType, slot: string, scope?: string): string {
  return alertPassId(alertType, slot, scope);
}

/** Créneau d'une tâche planifiée : sa charge utile `scheduledFor`, à défaut l'instant courant. */
export function passSlotOf(payload: unknown, now: Date): string {
  const scheduledFor =
    typeof payload === 'object' && payload !== null
      ? (payload as { scheduledFor?: unknown }).scheduledFor
      : undefined;
  return typeof scheduledFor === 'string' && scheduledFor !== '' ? scheduledFor : now.toISOString();
}

/**
 * Identifiant d'agrégat d'un sujet **composite** (solde d'un emplacement pour un produit, emplacement ×
 * jour, appareil × code d'erreur…) : l'UUID v5 de sa clé canonique, identique à celui que calcule le
 * consommateur d'alertes. Deux producteurs d'un même sujet (seuil absolu et part des ventes de
 * `HIGH_LOSS`) publient ainsi le même `aggregate_id`.
 */
export function compositeSubjectId(
  alertType: AlertType,
  payload: Readonly<Record<string, unknown>>,
): string {
  const key = alertSubjectKey(ALERT_CATALOG[alertType], '', payload);
  if (key === undefined) {
    // Jamais la charge utile entière dans le message : elle peut porter des données personnelles.
    throw new Error(
      `Sujet composite incomplet pour ${alertType} : parties attendues ` +
        `${ALERT_CATALOG[alertType].subjectParts?.join(', ') ?? '(aucune)'}.`,
    );
  }
  return codeEntityId('ALERT_SUBJECT', key);
}

export interface DetectionEventInput {
  readonly eventType: string;
  readonly producerModule: string;
  readonly aggregateType: string;
  /** Sujet de l'alerte (identifiant d'agrégat ou UUID v5 d'un sujet composite). */
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly payload: Record<string, unknown>;
  /** Passe qui publie (détecteur d'état) : l'événement porte `pass_id` et devient idempotent. */
  readonly passId?: string;
  readonly commandId?: string | null;
  /** Événement ou commande à l'origine de la détection (chaîne de causalité). */
  readonly causationId?: string | null;
}

/** Vrai si un événement de cet identifiant est déjà dans le journal (lecture simple, sans verrou). */
async function alreadyPublished(uow: UnitOfWork, eventId: string): Promise<boolean> {
  const row = await uow
    .selectFrom('platform_domain_events')
    .select('seq')
    .where('event_id', '=', toBin(eventId))
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Publie un événement de détection ; faux si la passe l'avait déjà publié pour ce sujet.
 *
 * Hors passe (détection sur fait), l'identifiant est aléatoire : un événement par appel. Dans une passe,
 * l'identifiant dérive de (type, sujet, passe) ; le rejeu est reconnu avant l'insertion (aucun numéro de
 * séquence consommé), et `INSERT IGNORE` ne couvre plus que la course entre deux exécutions simultanées.
 */
export async function publishDetectionEvent(
  uow: UnitOfWork,
  idGenerator: IdGenerator,
  input: DetectionEventInput,
): Promise<boolean> {
  const derived = input.passId !== undefined;
  const eventId = derived
    ? codeEntityId('ALERT_PASS_EVENT', `${input.eventType}:${input.aggregateId}:${input.passId}`)
    : idGenerator.newId();
  if (derived && (await alreadyPublished(uow, eventId))) return false;
  const insert = uow.insertInto('platform_domain_events').values({
    event_id: toBin(eventId),
    event_type: input.eventType,
    producer_module: input.producerModule,
    aggregate_type: input.aggregateType,
    aggregate_id: toBin(input.aggregateId),
    occurred_at: input.occurredAt,
    payload: jsonValue(
      input.passId === undefined ? input.payload : { ...input.payload, pass_id: input.passId },
    ),
    command_id:
      input.commandId === undefined || input.commandId === null ? null : toBin(input.commandId),
    causation_id:
      input.causationId === undefined || input.causationId === null
        ? null
        : toBin(input.causationId),
  });
  const result = await (derived ? insert.ignore() : insert).executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
}

/**
 * Marqueur de fin d'une passe **complète** d'un type d'alerte d'état. L'identifiant d'événement dérive de
 * (type, passe) : un rejeu ne publie pas deux marqueurs (et ne consomme aucun numéro de séquence).
 */
export async function publishPassCompleted(
  uow: UnitOfWork,
  input: {
    readonly producerModule: string;
    readonly alertType: AlertType;
    readonly passId: string;
    /** Portée de la passe (voir {@link detectionPassId}) ; absente : tout le type. */
    readonly scope?: string;
    readonly businessDay: string | null;
    readonly occurredAt: Date;
  },
): Promise<boolean> {
  const eventId = codeEntityId('ALERT_PASS_COMPLETED', `${input.alertType}:${input.passId}`);
  if (await alreadyPublished(uow, eventId)) return false;
  const result = await uow
    .insertInto('platform_domain_events')
    .values({
      event_id: toBin(eventId),
      event_type: PASS_COMPLETED_EVENT,
      producer_module: input.producerModule,
      aggregate_type: 'ALERT_DETECTION_PASS',
      aggregate_id: toBin(
        codeEntityId('ALERT_DETECTION_PASS', `${input.alertType}:${input.passId}`),
      ),
      occurred_at: input.occurredAt,
      payload: jsonValue({
        alert_type: input.alertType,
        pass_id: input.passId,
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        business_day: input.businessDay,
      }),
      command_id: null,
    })
    .ignore()
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
}
