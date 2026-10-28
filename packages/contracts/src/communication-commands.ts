/**
 * Charges utiles des commandes du module `communication` (P9 ; ADR-061 à ADR-063 ; D13 §4) : prise en
 * compte, résolution et écart d'une alerte, règles d'alerte, notifications, abonnement Web Push, notes de
 * direction. Contrat partagé entre l'appareil (prise en compte et accusé hors ligne, UC-NOT-02 et 06) et
 * le serveur, qui l'importe pour valider (un seul schéma).
 *
 * L'identifiant de l'agrégat (alerte, note, notification) est l'`aggregate_id` de l'enveloppe (UUIDv7) ;
 * une règle d'alerte se désigne par son `alertType` : son `aggregate_id` est un identifiant de commande
 * sans portée métier. Le serveur calcule seul les destinataires, la gravité et les états : aucune de ces
 * valeurs n'est dans une charge utile.
 */
import { ALERT_RESOLUTION_MODES, ALERT_SEVERITIES, ALERT_TYPES } from '@gic/domain';
import { z } from 'zod';

const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const instant = z.string().datetime({ offset: true });

/** Durée d'escalade en heures : de 1 h à une semaine. */
const escalationHours = z.number().int().min(1).max(168);
/** Code de rôle : majuscules, chiffres et soulignés (comme les codes semés). */
const roleCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Code de rôle attendu.');

/** Nombre maximal de notifications marquées lues par une commande. */
export const NOTIFICATIONS_READ_MAX = 100;
/** Nombre maximal de lignes d'audience d'une note. */
export const NOTE_AUDIENCE_MAX = 50;

// --- Alertes (communication.alert.*) -----------------------------------------------------------------

/** `communication.alert.acknowledge` — hors ligne possible ; sans effet sur une alerte déjà close. */
export const alertAcknowledgePayloadSchema = z.object({ comment: text(500).optional() });
export type AlertAcknowledgePayload = z.infer<typeof alertAcknowledgePayloadSchema>;

/** `communication.alert.resolve` — commentaire obligatoire (alerte d'événement ou à résolution manuelle). */
export const alertResolvePayloadSchema = z.object({ comment: text(500) });
export type AlertResolvePayload = z.infer<typeof alertResolvePayloadSchema>;

/** `communication.alert.dismiss` — motif obligatoire ; réservé aux alertes d'événement (AV-354). */
export const alertDismissPayloadSchema = z.object({ reason: text(500) });
export type AlertDismissPayload = z.infer<typeof alertDismissPayloadSchema>;

// --- Règles d'alerte (communication.alert_rule.set) ---------------------------------------------------

/**
 * `communication.alert_rule.set` — en ligne ; au moins un champ à modifier. Les seuils ne sont pas ici :
 * ce sont des paramètres `system_settings` (AV-350). La gravité doit être l'une de celles que le type
 * admet : le serveur le contrôle (le schéma ne connaît pas le type par l'enveloppe). `resolutionMode`
 * n'est accepté que s'il égale le mode du catalogue du type (état : AUTO ; événement : MANUAL), sinon le
 * serveur répond `ALERT_RESOLUTION_NOT_ADMITTED` (P9-25, AL-4, AV-464).
 */
export const alertRuleSetPayloadSchema = z
  .object({
    alertType: z.enum(ALERT_TYPES),
    enabled: z.boolean().optional(),
    severity: z.enum(ALERT_SEVERITIES).optional(),
    recipientRoles: z.array(roleCode).min(1).max(12).optional(),
    resolutionMode: z.enum(ALERT_RESOLUTION_MODES).optional(),
    escalationHours: escalationHours.nullable().optional(),
    escalationRoles: z.array(roleCode).min(1).max(12).optional(),
  })
  .refine(
    (payload) =>
      payload.enabled !== undefined ||
      payload.severity !== undefined ||
      payload.recipientRoles !== undefined ||
      payload.resolutionMode !== undefined ||
      payload.escalationHours !== undefined ||
      payload.escalationRoles !== undefined,
    { message: 'Au moins un champ à modifier.' },
  );
export type AlertRuleSetPayload = z.infer<typeof alertRuleSetPayloadSchema>;

// --- Notifications et abonnements push ---------------------------------------------------------------

/** `communication.notification.read` — des notifications, ou toutes les non lues ; hors ligne possible. */
export const notificationReadPayloadSchema = z
  .object({
    notificationIds: z.array(uuid).min(1).max(NOTIFICATIONS_READ_MAX).optional(),
    all: z.literal(true).optional(),
  })
  .refine((payload) => (payload.notificationIds === undefined) !== (payload.all === undefined), {
    message: 'Indiquer des notifications, ou « toutes ».',
  });
export type NotificationReadPayload = z.infer<typeof notificationReadPayloadSchema>;

/** `communication.push.subscribe` — abonnement Web Push de l'appareil authentifié (D13 UC-NOT-07). */
export const pushSubscribePayloadSchema = z.object({
  endpoint: z.string().url().max(500),
  keys: z.object({ p256dh: text(200), auth: text(100) }),
});
export type PushSubscribePayload = z.infer<typeof pushSubscribePayloadSchema>;

/** `communication.push.unsubscribe`. */
export const pushUnsubscribePayloadSchema = z.object({ endpoint: z.string().url().max(500) });
export type PushUnsubscribePayload = z.infer<typeof pushUnsubscribePayloadSchema>;

// --- Notes de direction (communication.note.*) -------------------------------------------------------

export const NOTE_CATEGORIES = ['PRIX', 'INSTRUCTION', 'PROCEDURE', 'INFORMATION'] as const;
export const noteCategorySchema = z.enum(NOTE_CATEGORIES);
export type NoteCategory = z.infer<typeof noteCategorySchema>;

export const NOTE_AUDIENCE_TYPES = ['ALL', 'ROLE', 'SITE', 'ZONE', 'USER'] as const;

/** Une ligne d'audience : `ALL` sans référence, les autres avec leur code de rôle ou leur identifiant. */
export const noteAudienceEntrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ALL') }),
  z.object({ type: z.literal('ROLE'), ref: roleCode }),
  z.object({ type: z.literal('SITE'), ref: uuid }),
  z.object({ type: z.literal('ZONE'), ref: uuid }),
  z.object({ type: z.literal('USER'), ref: uuid }),
]);
export type NoteAudienceEntry = z.infer<typeof noteAudienceEntrySchema>;

const noteContent = z.object({
  title: text(160),
  body: text(8000),
  category: noteCategorySchema,
  /** Objet référencé (ex. règle tarifaire) : aucun effet métier (BR-NOT-007). */
  relatedEntityType: text(40).optional(),
  relatedEntityId: uuid.optional(),
  requiresAck: z.boolean(),
  expiresAt: instant.optional(),
  audience: z.array(noteAudienceEntrySchema).min(1).max(NOTE_AUDIENCE_MAX),
});

const relatedPairConsistent = (note: {
  relatedEntityType?: string | undefined;
  relatedEntityId?: string | undefined;
}): boolean => (note.relatedEntityType === undefined) === (note.relatedEntityId === undefined);
const relatedPairMessage = {
  message: "Le type et l'identifiant de l'objet référencé vont ensemble.",
};

/** `communication.note.save_draft` — brouillon visible de son auteur seulement ; modifiable. */
export const noteDraftSavePayloadSchema = noteContent.refine(
  relatedPairConsistent,
  relatedPairMessage,
);
export type NoteDraftSavePayload = z.infer<typeof noteDraftSavePayloadSchema>;

/**
 * `communication.note.publish` — en ligne ; fige la note (BR-NOT-006) : crée et publie, ou publie le
 * brouillon désigné par l'`aggregate_id`. L'expiration, si elle est donnée, est postérieure à
 * `publishedAt` : contrôlé par le serveur (instant de publication).
 */
export const notePublishPayloadSchema = noteContent.refine(
  relatedPairConsistent,
  relatedPairMessage,
);
export type NotePublishPayload = z.infer<typeof notePublishPayloadSchema>;

/** `communication.note.archive` — retrait d'une note publiée ou abandon d'un brouillon. */
export const noteArchivePayloadSchema = z.object({ reason: text(500) });
export type NoteArchivePayload = z.infer<typeof noteArchivePayloadSchema>;

/** `communication.note.acknowledge` — lecture seule ou accusé de réception ; hors ligne possible. */
export const noteAcknowledgePayloadSchema = z.object({
  kind: z.enum(['READ', 'ACKNOWLEDGE']).default('ACKNOWLEDGE'),
});
export type NoteAcknowledgePayload = z.infer<typeof noteAcknowledgePayloadSchema>;

/** Types de commande du module, pour l'enregistrement (`CommandRegistry`) et les tests. */
export const COMMUNICATION_COMMAND_TYPES = {
  alertAcknowledge: 'communication.alert.acknowledge',
  alertResolve: 'communication.alert.resolve',
  alertDismiss: 'communication.alert.dismiss',
  alertRuleSet: 'communication.alert_rule.set',
  notificationRead: 'communication.notification.read',
  pushSubscribe: 'communication.push.subscribe',
  pushUnsubscribe: 'communication.push.unsubscribe',
  noteSaveDraft: 'communication.note.save_draft',
  notePublish: 'communication.note.publish',
  noteArchive: 'communication.note.archive',
  noteAcknowledge: 'communication.note.acknowledge',
} as const;
