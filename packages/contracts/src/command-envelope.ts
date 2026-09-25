/**
 * Enveloppe de commande (06-offline-sync/02-synchronisation.md §2 ; ADR-002, ADR-016).
 *
 * Chaque `command_type` a un schéma de validation **versionné**, partagé entre
 * l'appareil et le serveur (ADR-021, K1) : c'est {@link commandEnvelopeSchema} qui porte
 * les champs de transport communs, `payload` restant générique ici et précisé par
 * chaque module (`CommandRegistry`, command-registry.ts).
 */
import { z } from 'zod';
import { isUuidv7 } from '@gic/domain';

const uuidv7Schema = z.string().refine(isUuidv7, { message: 'UUIDv7 attendu (ADR-002).' });

// `<module>.<agrégat>.<verbe>` (00-reference/00-conventions.md §4, ex. `sales.sale.record`).
const COMMAND_TYPE_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
export const commandTypeSchema = z
  .string()
  .regex(COMMAND_TYPE_RE, 'command_type attendu au format <module>.<agrégat>.<verbe>.');

// ISO 8601 UTC en transport (08-api-events/01-architecture-api.md §2 « Dates »).
const isoDateTimeSchema = z.string().datetime({ offset: true });

/**
 * Champs de transport communs à toute commande, indépendants de son `payload`
 * (03-data/01-identifiants-et-conventions.md « [STD-ORIGIN] » pour leur usage côté base).
 */
export const commandEnvelopeBaseSchema = z.object({
  command_id: uuidv7Schema,
  device_seq: z.number().int().positive(),
  command_type: commandTypeSchema,
  command_version: z.number().int().positive(),
  author_user_id: uuidv7Schema,
  aggregate_type: z.string().min(1).max(60),
  aggregate_id: uuidv7Schema,
  /** Concurrence optimiste (intention sur un état partagé) ; `null` pour un fait accompli. */
  base_version: z.number().int().nonnegative().nullable(),
  /** `command_id` d'autres commandes du même lot dont celle-ci dépend (§3.1). */
  depends_on: z.array(uuidv7Schema).max(50).default([]),
  occurred_at: isoDateTimeSchema,
  client_created_at: isoDateTimeSchema,
  captured_offline: z.boolean(),
  backdated_reason: z.string().min(1).max(500).nullable().default(null),
  attachment_ids: z.array(uuidv7Schema).max(20).default([]),
});
export type CommandEnvelopeBase = z.infer<typeof commandEnvelopeBaseSchema>;

/**
 * Enveloppe complète pour un type de commande donné, `payload` typé par le schéma
 * fourni. Utilisé par {@link CommandRegistry} (command-registry.ts) — préférer
 * `registry.parse(...)` à un appel direct dans le code applicatif, pour bénéficier de la
 * résolution par `command_type` et `command_version`.
 */
export function commandEnvelopeSchema<P extends z.ZodTypeAny>(payloadSchema: P) {
  return commandEnvelopeBaseSchema.extend({ payload: payloadSchema });
}
export type CommandEnvelope<P> = CommandEnvelopeBase & { payload: P };
