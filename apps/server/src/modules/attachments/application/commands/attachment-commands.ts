/**
 * `attachments.attachment.register` (UC-ADM-16 ; SM-ATTACHMENT `[*] --> PENDING_UPLOAD`,
 * 04-workflows/machines-a-etats/06-transverses.md ; ADR-012 point 2 : « métadonnées
 * envoyées avec la commande — la pièce existe dès l'application, PENDING_UPLOAD »).
 *
 * L'upload du contenu lui-même est délibérément séparé (ADR-012 point 3, « après le push
 * des commandes ») : endpoints de fichiers dans `attachments-api/`, hors du pipeline de
 * commande (transfert d'octets bruts, pas une commande JSON).
 *
 * Permission — `attachments.attachment.manage` (AV-093, SECONDAIRE/OUVERT) : SM-ATTACHMENT
 * documente « Permission de l'opération » (celle du document auquel la pièce est jointe),
 * mais `CommandHandlerRegistry.register()` (P0-06) n'accepte qu'un `permissionCode` statique
 * — aucun module propriétaire (inventory, procurement…) n'existe encore en P0 pour la
 * fournir dynamiquement. Ce contrôle RC-01 générique n'exempte pas le module propriétaire de
 * vérifier, dans son propre gestionnaire, le droit de créer le document lui-même.
 *
 * `[STD-ORIGIN]` (03-data/01-identifiants-et-conventions.md §3.3) : `created_device_id`,
 * `received_at` et `clock_skew_ms` (→ `clock_suspect`) ne sont pas portés par
 * `CommandEnvelope` (signature `CommandHandler` stable, P0-06) — lus depuis
 * `sync_command_inbox` par `command_id`, déjà écrite (étape 2 du pipeline) et déjà visible
 * dans la transaction du gestionnaire (étape 6) au moment où ce gestionnaire s'exécute.
 */
import { z } from 'zod';
import { isClockSkewSuspect } from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';

/** D01 §8 (validations) ; CHECK ck_attachments_attachments_size (migration P0-04). */
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/webp', 'application/pdf'] as const;
const MAX_SIZE_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_KINDS = [
  'PHOTO',
  'INVOICE',
  'RECEIPT',
  'DELIVERY_NOTE',
  'SUPPLIER_DOCUMENT',
  'OTHER',
] as const;

const registerPayloadSchema = z.object({
  ownerType: z.string().min(1).max(40),
  ownerId: z.string().uuid(),
  kind: z.enum(ATTACHMENT_KINDS),
  mimeType: z.enum(ALLOWED_MIME_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_SIZE_BYTES),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'Empreinte SHA-256 attendue (64 caractères hexadécimaux).'),
  capturedAt: z.string().datetime({ offset: true }),
  capturedLat: z.number().min(-90).max(90).optional(),
  capturedLng: z.number().min(-180).max(180).optional(),
});
type RegisterPayload = z.infer<typeof registerPayloadSchema>;

/** `storage_key` : déterministe (jamais fourni par l'appareil), lu par `attachments-api/`. */
export function attachmentStorageKey(attachmentId: string): string {
  return `attachments/${attachmentId}`;
}

const register: CommandHandler<RegisterPayload> = async (uow, envelope) => {
  const id = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('attachments_attachments')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' }; // rejeu idempotent (même command_id, P0-06)

  const inboxRow = await uow
    .selectFrom('sync_command_inbox')
    .select(['device_id', 'received_at', 'clock_skew_ms'])
    .where('command_id', '=', toBin(envelope.command_id))
    .executeTakeFirstOrThrow();

  const {
    ownerType,
    ownerId,
    kind,
    mimeType,
    sizeBytes,
    sha256,
    capturedAt,
    capturedLat,
    capturedLng,
  } = envelope.payload;

  await uow
    .insertInto('attachments_attachments')
    .values({
      id,
      owner_type: ownerType,
      owner_id: toBin(ownerId),
      kind,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      sha256,
      storage_key: attachmentStorageKey(envelope.aggregate_id),
      upload_status: 'PENDING_UPLOAD',
      uploaded_bytes: 0,
      captured_at: new Date(capturedAt),
      captured_lat: capturedLat !== undefined ? String(capturedLat) : null,
      captured_lng: capturedLng !== undefined ? String(capturedLng) : null,
      occurred_at: new Date(envelope.occurred_at),
      client_created_at: new Date(envelope.client_created_at),
      received_at: inboxRow.received_at,
      command_id: toBin(envelope.command_id),
      created_device_id: inboxRow.device_id,
      captured_offline: toDbBool(envelope.captured_offline),
      clock_suspect: toDbBool(isClockSkewSuspect(inboxRow.clock_skew_ms)),
      backdated_reason: envelope.backdated_reason ?? null,
      created_by: toBin(envelope.author_user_id),
    })
    .execute();

  return { status: 'APPLIED' };
};

export function registerAttachmentCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'attachments.attachment.register',
    version: 1,
    payloadSchema: registerPayloadSchema,
    permissionCode: 'attachments.attachment.manage',
    handler: register,
  });
}
