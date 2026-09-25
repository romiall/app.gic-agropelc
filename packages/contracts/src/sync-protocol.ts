/**
 * Protocole de synchronisation (06-offline-sync/02-synchronisation.md §3, §5, §10 ;
 * BR-SYN-005, BR-SYN-006).
 */
import { z } from 'zod';
import { isUuidv7 } from '@gic/domain';
import { commandEnvelopeBaseSchema } from './command-envelope.js';
import { errorCodeSchema, warningCodeSchema } from './error-codes.js';

const uuidv7Schema = z.string().refine(isUuidv7, { message: 'UUIDv7 attendu (ADR-002).' });

/* -------------------------------------------------------------------------------- */
/* Push (§3)                                                                         */
/* -------------------------------------------------------------------------------- */

/** Enveloppe brute côté transport : `payload` non typé ici (voir CommandRegistry.parse). */
export const rawCommandEnvelopeSchema = commandEnvelopeBaseSchema.extend({
  payload: z.unknown(),
});
export type RawCommandEnvelope = z.infer<typeof rawCommandEnvelopeSchema>;

export const pushRequestSchema = z.object({
  device_id: uuidv7Schema,
  batch_id: uuidv7Schema,
  device_sent_at: z.string().datetime({ offset: true }),
  // Lot ≤ 50 commandes (§3.1) ; la limite de 256 Ko compressés est une contrainte de
  // transport (gzip), vérifiée par le serveur HTTP, pas par ce schéma.
  commands: z.array(rawCommandEnvelopeSchema).min(1).max(50),
});
export type PushRequest = z.infer<typeof pushRequestSchema>;

/** Statut de résultat d'une commande, côté serveur (§3.1, §3.3). */
export const SYNC_RESULT_STATUSES = [
  'APPLIED',
  'APPLIED_WITH_WARNINGS',
  'CONFLICT',
  'REJECTED',
  'RETRY_LATER',
] as const;
export const syncResultStatusSchema = z.enum(SYNC_RESULT_STATUSES);
export type SyncResultStatus = z.infer<typeof syncResultStatusSchema>;

export const commandResultSchema = z.object({
  command_id: uuidv7Schema,
  status: syncResultStatusSchema,
  /** Numéros officiels, identifiants générés par le serveur, etc. */
  server_refs: z.record(z.string()).optional(),
  warnings: z.array(warningCodeSchema).optional(),
  error: z
    .object({
      code: errorCodeSchema,
      message_fr: z.string().min(1),
    })
    .optional(),
  conflict_id: uuidv7Schema.optional(),
});
export type CommandResult = z.infer<typeof commandResultSchema>;

export const pushResponseSchema = z.object({
  results: z.array(commandResultSchema),
  server_time: z.string().datetime({ offset: true }),
  clock_skew_ms: z.number().int(),
});
export type PushResponse = z.infer<typeof pushResponseSchema>;

/* -------------------------------------------------------------------------------- */
/* États visibles par l'utilisateur (§10 ; BR-SYN-005, BR-SYN-006)                    */
/* -------------------------------------------------------------------------------- */

export const DEVICE_SYNC_STATES = [
  'LOCAL_ONLY',
  'PENDING_SYNC',
  'SYNCING',
  'SYNCED',
  'SYNCED_WITH_WARNING',
  'CONFLICT',
  'REJECTED',
] as const;
export const deviceSyncStateSchema = z.enum(DEVICE_SYNC_STATES);
export type DeviceSyncState = z.infer<typeof deviceSyncStateSchema>;

/**
 * Transition d'état côté appareil à réception d'un résultat serveur (BR-SYN-006).
 * `RETRY_LATER` ne change pas l'état visible : la commande reste `PENDING_SYNC` et
 * repart au lot suivant (§4).
 */
export function deviceStateAfterResult(status: SyncResultStatus): DeviceSyncState {
  switch (status) {
    case 'APPLIED':
      return 'SYNCED';
    case 'APPLIED_WITH_WARNINGS':
      return 'SYNCED_WITH_WARNING';
    case 'CONFLICT':
      return 'CONFLICT';
    case 'REJECTED':
      return 'REJECTED';
    case 'RETRY_LATER':
      return 'PENDING_SYNC';
  }
}

/* -------------------------------------------------------------------------------- */
/* Pull (§5)                                                                         */
/* -------------------------------------------------------------------------------- */

export const pullRequestSchema = z.object({
  dataset: z.string().min(1),
  cursor: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(2000).default(500),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

export const CHANGE_TYPES = ['UPSERT', 'DELETE', 'SCOPE_EXIT'] as const;
export const changeTypeSchema = z.enum(CHANGE_TYPES);
export type ChangeType = z.infer<typeof changeTypeSchema>;

export const SCOPE_TYPES = [
  'GLOBAL',
  'SITE',
  'ZONE',
  'TEAM',
  'USER',
  'DEVICE',
  'LOCATION',
] as const;
export const scopeTypeSchema = z.enum(SCOPE_TYPES);
export type ScopeType = z.infer<typeof scopeTypeSchema>;

export const changeSchema = z.object({
  seq: z.number().int().positive(),
  dataset: z.string().min(1),
  entity_type: z.string().min(1),
  entity_id: z.string().min(1),
  change_type: changeTypeSchema,
  scope_type: scopeTypeSchema,
  scope_id: z.string().nullable(),
  row_version: z.number().int().nonnegative(),
  /** Absent pour `DELETE` et `SCOPE_EXIT` (§5.3) : rien à projeter côté appareil. */
  data: z.record(z.unknown()).optional(),
});
export type Change = z.infer<typeof changeSchema>;

export const pullResponseSchema = z.object({
  changes: z.array(changeSchema),
  next_cursor: z.number().int().nonnegative(),
  has_more: z.boolean(),
});
export type PullResponse = z.infer<typeof pullResponseSchema>;
