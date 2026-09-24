/**
 * Catalogue des codes d'erreur et d'avertissement (06-offline-sync/02-synchronisation.md
 * §3.3 ; 08-api-events/01-architecture-api.md §2).
 *
 * Deux familles :
 * - les codes **du protocole de synchronisation** (authenticité, dépendances, versions) :
 *   liste fermée, stable, propre à `sync` — encodée ci-dessous en entier ;
 * - les codes **métier** (`VALIDATION_ERROR:<détail>`, et les codes propres à chaque
 *   domaine cités dans le catalogue de chaque module, ex. `INSUFFICIENT_STOCK`) : liste
 *   ouverte par construction (chaque module en ajoute), donc validée par **forme**
 *   (SCREAMING_SNAKE_CASE, avec un détail optionnel après `:`) plutôt que par énumération
 *   exhaustive ici.
 */
import { z } from 'zod';

/** Codes de rejet ou de conflit propres au protocole de synchronisation lui-même. */
export const SYNC_PROTOCOL_ERROR_CODES = [
  'COMMAND_ID_REUSED',
  'DEVICE_REVOKED',
  'USER_DEACTIVATED',
  'OCCURRED_AT_FUTURE',
  'BACKDATE_EXCEEDED',
  'JUSTIFICATION_REQUIRED',
  'UNSUPPORTED_VERSION',
  'FORBIDDEN',
  'FORBIDDEN_SCOPE',
  'VERSION_CONFLICT',
  'DEPENDENCY_PENDING',
  'DEPENDENCY_REJECTED',
  'SERVER_BUSY',
] as const;

export type SyncProtocolErrorCode = (typeof SYNC_PROTOCOL_ERROR_CODES)[number];

export function isSyncProtocolErrorCode(value: string): value is SyncProtocolErrorCode {
  return (SYNC_PROTOCOL_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Avertissements possibles d'une commande `APPLIED_WITH_WARNINGS` (§3.3, dernière ligne).
 * Liste close **pour ce que le cadrage documente aujourd'hui** : chaque phase qui
 * introduit un nouvel avertissement (P1 à P10) l'ajoute ici, dans le même commit que la
 * règle métier qui le produit (règle R8, CLAUDE.md).
 */
export const WARNING_CODES = [
  'STOCK_NEGATIVE',
  'PRICE_MISMATCH',
  'DUPLICATE_CUSTOMER',
  'CREDIT_OVER_LIMIT',
  'PRODUCT_INACTIVE',
  'ALLOCATION_REVOKED_CONSUMED',
  'ORDER_OVER_FULFILMENT',
  'CANCEL_WINDOW_EXCEEDED',
  'CLOCK_SUSPECT',
  'RECEIPT_QUARANTINED',
  'PAYMENT_SUSPECT_DUPLICATE',
  'LOT_CLOSED',
  'TRANSFER_UNMATCHED',
] as const;

export const warningCodeSchema = z.enum(WARNING_CODES);
export type WarningCode = z.infer<typeof warningCodeSchema>;

// SCREAMING_SNAKE_CASE, avec un détail optionnel après `:` (ex. VALIDATION_ERROR:PRICE_NOT_FOUND).
const BUSINESS_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]*(?::[A-Z0-9_]+)?$/;

/** Code d'erreur métier (protocole ou domaine) : forme SCREAMING_SNAKE_CASE[:DÉTAIL]. */
export const errorCodeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(BUSINESS_ERROR_CODE_RE, "Code d'erreur attendu au format SCREAMING_SNAKE_CASE[:DÉTAIL].");

/**
 * Enveloppe d'erreur API (08-api-events/01-architecture-api.md §2) : commune à toute
 * réponse en erreur, hors résultat de commande (voir sync-protocol.ts pour ce dernier).
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string().min(1), // en français (§2 « Langue »)
    details: z.record(z.unknown()).optional(),
    correlation_id: z.string().uuid().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
