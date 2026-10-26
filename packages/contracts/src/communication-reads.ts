/**
 * Réponses des lectures de `communication` (P9 ; ADR-062 §3, ADR-063 ; D13 §4 UC-NOT-03) :
 * `GET /api/v1/alerts`, `/alerts/{id}`, `/alerts/summary`, `/notifications`, `/notes`. Partagées entre le
 * serveur et la PWA (centre d'alertes ECR-NOT-01, notes ECR-NOT-02).
 *
 * Le titre et le message d'une alerte sont **rendus pour le lecteur** : une valeur au coût n'y figure que
 * s'il détient `inventory.valuation.read` (ADR-061 §11, AV-390).
 */
import {
  ALERT_NATURES,
  ALERT_RESOLUTION_MODES,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  ALERT_TYPES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
} from '@gic/domain';
import { z } from 'zod';
import { NOTE_CATEGORIES, noteAudienceEntrySchema } from './communication-commands.js';

const uuid = z.string().uuid();
const instant = z.string().min(1).max(40);
const count = z.number().int().nonnegative();

/** Pourquoi l'alerte est dans la liste de l'utilisateur : sa boîte, ou sa supervision par la portée. */
export const ALERT_VISIBILITY = ['RECIPIENT', 'SUPERVISION'] as const;

export const alertItemSchema = z.object({
  id: uuid,
  alertType: z.enum(ALERT_TYPES),
  nature: z.enum(ALERT_NATURES),
  severity: z.enum(ALERT_SEVERITIES),
  status: z.enum(ALERT_STATUSES),
  title: z.string().min(1).max(200),
  /** Message rendu pour le lecteur ; peut être vide si aucune valeur n'est affichable. */
  message: z.string().max(1000),
  subjectType: z.string().min(1).max(40),
  subjectId: uuid,
  siteId: uuid.nullable(),
  zoneId: uuid.nullable(),
  ownerUserId: uuid.nullable(),
  /** Écran d'action (`ECR-…`) ; `null` si le type n'en a pas. */
  actionScreen: z.string().max(20).nullable(),
  occurrences: z.number().int().min(1),
  firstDetectedAt: instant,
  lastDetectedAt: instant,
  criticalSince: instant.nullable(),
  escalatedAt: instant.nullable(),
  acknowledgedAt: instant.nullable(),
  acknowledgedBy: uuid.nullable(),
  resolvedAt: instant.nullable(),
  resolvedBy: uuid.nullable(),
  resolutionComment: z.string().max(500).nullable(),
  visibility: z.array(z.enum(ALERT_VISIBILITY)).min(1),
  /** Charge utile publique du message : les champs protégés n'y sont jamais (RC-05). */
  payload: z.record(z.string(), z.unknown()),
});
export type AlertItem = z.infer<typeof alertItemSchema>;

export const alertListResponseSchema = z.object({
  items: z.array(alertItemSchema),
  /** Curseur de la page suivante (plafond de balayage compris) ; `null` à la fin. */
  nextCursor: z.string().max(200).nullable(),
});
export type AlertListResponse = z.infer<typeof alertListResponseSchema>;

/** `GET /alerts/summary` : compteurs d'alertes ouvertes de l'étendue de l'utilisateur. */
export const alertSummarySchema = z.object({
  open: count,
  acknowledged: count,
  bySeverity: z.object({ INFO: count, WARNING: count, CRITICAL: count }),
  /** Vrai si le balayage borné s'est arrêté avant la fin (« plus de N », ADR-068). */
  truncated: z.boolean(),
  computedAt: instant,
});
export type AlertSummary = z.infer<typeof alertSummarySchema>;

export const notificationItemSchema = z.object({
  id: uuid,
  channel: z.enum(NOTIFICATION_CHANNELS),
  /** Nature : alerte, note de direction, notification directe d'un événement, fin d'un export (AV-389). */
  kind: z.enum(NOTIFICATION_KINDS),
  title: z.string().min(1).max(200),
  body: z.string().max(1000),
  link: z.string().max(200).nullable(),
  alertId: uuid.nullable(),
  noteId: uuid.nullable(),
  /**
   * Objet source de la notification : `ALERT` (l'alerte), `ALERT_ESCALATION`, `NOTE` (la note),
   * `APPROVAL_REQUEST` ou `STOCK_TRANSFER` (notification directe) — de quoi ouvrir l'écran concerné ; nul sinon.
   */
  sourceType: z.string().max(40).nullable(),
  sourceId: uuid.nullable(),
  createdAt: instant,
  deliveredAt: instant.nullable(),
  readAt: instant.nullable(),
});
export type NotificationItem = z.infer<typeof notificationItemSchema>;

export const notificationListResponseSchema = z.object({
  items: z.array(notificationItemSchema),
  unreadCount: count,
  nextCursor: z.string().max(200).nullable(),
});
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

/**
 * `GET /alert-rules` : règles d'alerte (réservé à `comm.alert_rule.manage`). Les gravités et modes de
 * résolution admis viennent du catalogue du domaine : l'écran ne propose que ce que `alert_rule.set`
 * acceptera. Les seuils ne sont pas ici : ce sont des paramètres système (AV-350).
 */
export const alertRuleItemSchema = z.object({
  alertType: z.enum(ALERT_TYPES),
  nature: z.enum(ALERT_NATURES),
  enabled: z.boolean(),
  severity: z.enum(ALERT_SEVERITIES),
  severitiesAdmitted: z.array(z.enum(ALERT_SEVERITIES)).min(1),
  recipientRoles: z.array(z.string().min(1).max(40)),
  resolutionMode: z.enum(ALERT_RESOLUTION_MODES),
  resolutionModesAdmitted: z.array(z.enum(ALERT_RESOLUTION_MODES)).min(1),
  escalationHours: z.number().int().min(1).max(168).nullable(),
  /** Faux : le type n'est jamais critique, l'escalade ne s'applique pas. */
  escalationApplicable: z.boolean(),
  escalationRoles: z.array(z.string().min(1).max(40)),
  /** Faux : la source de la détection n'existe pas encore (règle semée désactivée). */
  sourceAvailable: z.boolean(),
  version: z.number().int().min(1),
  updatedAt: instant,
  updatedBy: uuid.nullable(),
});
export type AlertRuleItem = z.infer<typeof alertRuleItemSchema>;

export const alertRuleListResponseSchema = z.object({ items: z.array(alertRuleItemSchema) });
export type AlertRuleListResponse = z.infer<typeof alertRuleListResponseSchema>;

export const NOTE_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;

export const noteItemSchema = z.object({
  id: uuid,
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(8000),
  category: z.enum(NOTE_CATEGORIES),
  relatedEntityType: z.string().max(40).nullable(),
  relatedEntityId: uuid.nullable(),
  requiresAck: z.boolean(),
  status: z.enum(NOTE_STATUSES),
  publishedAt: instant.nullable(),
  expiresAt: instant.nullable(),
  authorUserId: uuid,
  /** Audience : lisible de la Direction (auteur) seulement. */
  audience: z.array(noteAudienceEntrySchema).optional(),
  /** État du lecteur. */
  readAt: instant.nullable(),
  acknowledgedAt: instant.nullable(),
});
export type NoteItem = z.infer<typeof noteItemSchema>;

export const noteListResponseSchema = z.object({
  items: z.array(noteItemSchema),
  /** Notes à accusé requis non encore accusées par le lecteur (sur ce que le balayage a examiné, AV-429). */
  pendingAcknowledgements: count,
  /** Vrai si le balayage du centre de notes a atteint son plafond : des notes plus anciennes n'ont pas été examinées. */
  truncated: z.boolean(),
  nextCursor: z.string().max(200).nullable(),
});
export type NoteListResponse = z.infer<typeof noteListResponseSchema>;

/** `GET /notes/{id}/acknowledgements` : suivi pour la Direction (ADR-063 §6). */
export const noteAcknowledgementsResponseSchema = z.object({
  noteId: uuid,
  audienceSize: count,
  read: count,
  acknowledged: count,
  missing: z.array(z.object({ userId: uuid, fullName: z.string().min(1).max(200) })),
});
export type NoteAcknowledgementsResponse = z.infer<typeof noteAcknowledgementsResponseSchema>;
