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
  /** P5-21 (AV-210) : une commande précédente du lot doit être renvoyée d'abord (INV-SYN-04). */
  'PRECEDING_COMMAND_PENDING',
  'SERVER_BUSY',
  /**
   * P5-21 (revue adverse, AV-217) : commande à renvoyer qui ne se règle pas depuis plus de
   * `sync.retry_hold_minutes` — toujours `RETRY_LATER`, mais elle ne suspend plus la suite du lot.
   */
  'COMMAND_STALLED',
  /**
   * P5-23 (revue adverse, AV-225) : commande bloquée écartée par la résolution de son signal
   * `SYNC_COMMAND_STALLED` (`sync.conflict.resolve`) — définitive : jamais appliquée après coup.
   */
  'COMMAND_DISCARDED',
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
  // P3-04 : collision sur un même champ d'un compte client modifié sur deux appareils — la
  // valeur la plus récente est appliquée, l'autre conservée dans un conflit informatif
  // (03-matrice-conflits.md, ligne « prospect modifié sur deux appareils »).
  'VERSION_CONFLICT',
  // P6-05 : réception hors ligne appliquée au-delà du reliquat, excédent tracé en revue
  // (BR-APP-010, mode `APPLY_WITH_REVIEW` du paramètre procurement.offline_over_receipt_mode).
  'OVER_RECEIPT',
  // P7-08 : éclosion saisie hors ligne avec moins d'issues que d'œufs restants — la différence
  // est comptée en œufs non éclos (INV-INC-01), conflit informatif pour le Resp. production.
  'INCUBATION_BALANCE_ADJUSTED',
  // P4-04 : vente directe hors ligne appliquée malgré une anomalie à traiter (BR-SYN-007) —
  // vente anonyme non payée (AV-137), animaux d'un lot qui n'était pas « en vente » (BR-PRD-010),
  // dérogation de prix au-delà du plafond ou sans prix catalogue (validation `PRICE_OVERRIDE`).
  'ANONYMOUS_UNPAID',
  'LOT_NOT_SELLABLE',
  'PRICE_OVERRIDE_EXCEEDS_LIMIT',
  // P4-08 : encaissement saisi hors ligne dont une part n'a pu être affectée à la vente ou à la
  // commande visée (soldée, annulée, livrée entre-temps) : elle reste en crédit client, conflit pour
  // la Finance (AV-150, BR-SYN-007).
  'PAYMENT_UNALLOCATED',
  // P5-07 : vente saisie hors ligne avec une référence locale déjà utilisée par le même appareil
  // (compteur partagé entre vendeurs d'une tablette, AV-007) : le fait est appliqué, la référence
  // locale n'est pas conservée (BR-SYN-007).
  'LOCAL_REF_DUPLICATE',
  // P5-08 : libération d'un quota où le reste déclaré par l'appareil diffère du reste du serveur ;
  // le quota est fermé sur le reste du serveur, l'écart est signalé (ADR-033 §9).
  'ALLOCATION_RELEASE_MISMATCH',
  // P5-09 (ADR-033 §6, AV-161) : sortie d'un emplacement partagé saisie hors ligne au-delà du quota
  // de l'appareil (l'excédent est pris sur le stock commun, conflit informatif) ; solde physique
  // tombé sous la somme des restes des quotas actifs, après une perte ou un inventaire (conflit
  // informatif, jamais corrigé en silence) ; fait saisi hors ligne par un appareil qui n'est pas
  // celui de la garde de l'emplacement (appareil non désigné, non principal, d'un autre site).
  'ALLOCATION_EXCEEDED',
  'ALLOCATION_OVERCOMMITTED',
  'CUSTODY_DEVICE_MISMATCH',
  // P5-12 (ADR-032 §8, AV-154, AV-167 à AV-169) : ouverture de caisse saisie hors ligne fusionnée
  // dans une session existante ou décalée après la session de la veille close depuis ; clôture
  // saisie hors ligne d'une session qui n'est plus ouverte (ou datée avant son ouverture), comptage
  // conservé comme observation ; ouverture hors ligne d'une caisse désactivée depuis (fait accompli).
  // Conflits informatifs appliqués pour la Finance, jamais un rejet (BR-SYN-007).
  'CASH_SESSION_CONCURRENT_OPEN',
  'CASH_SESSION_CONCURRENT_CLOSE',
  'CASH_ACCOUNT_INACTIVE',
  // P5-12 (revue adverse ; AV-171) : ouverture hors ligne sur un site fermé depuis (fait accompli,
  // conflit informatif pour la Finance) ; clôture saisie hors ligne datée avant un mouvement déjà
  // enregistré sur la caisse (jamais validée d'office, conflit informatif pour la Finance).
  'CASH_SESSION_SITE_CLOSED',
  'CASH_SESSION_CLOSE_BEFORE_MOVEMENTS',
  // P5-15 (remises de fonds ; ADR-032 §8, BR-FIN-012, AV-158, AV-173) : envoi hors ligne qui rend
  // négative une caisse physique (anomalie `CASH_NEGATIVE`, conflit pour la Finance) ; envoi hors
  // ligne entre deux types de comptes non admis par `finance.cash_transfer_allowed_pairs` (fait
  // appliqué, conflit) ; réception d'un montant différent de l'envoi (validation
  // `CASH_TRANSFER_DISCREPANCY`) ; courses hors ligne conservées en observation, sans mouvement :
  // réception après l'annulation, annulation après la réception, seconde réception.
  'CASH_NEGATIVE',
  'CASH_TRANSFER_PAIR_NOT_ALLOWED',
  'CASH_TRANSFER_DISCREPANCY',
  'CASH_TRANSFER_RECEIVED_AFTER_CANCEL',
  'CASH_TRANSFER_CANCEL_AFTER_RECEIVE',
  'CASH_TRANSFER_RECEIVED_TWICE',
  // P5-16 (BR-STK-021, AV-177) : réception au-delà de l'expédié, appliquée (réception sans document
  // rapprochée, ou réception avec document saisie hors ligne) ; l'excédent est reçu, le conflit
  // informatif `TRANSFER_OVER_RECEIVED` le signale au magasinier du site expéditeur.
  'TRANSFER_OVER_RECEIVED',
  // P5-14 (BR-DIS-005, ADR-032 §8, AV-184) : encaissement en espèces au PDV saisi hors ligne sans
  // session de caisse couvrant sa date (fait appliqué, conflit informatif pour la Finance) ; annulation
  // directe d'une vente dont la session de caisse est close (BR-VEN-028, AV-185) : transformée en
  // demande soumise à validation.
  'CASH_SESSION_MISSING',
  'CANCEL_SESSION_CLOSED',
  // P5-23 (S-40, AV-223) : expédition saisie hors ligne d'une demande refusée ou annulée depuis — appliquée
  // en expédition directe (fait accompli), conflit informatif pour le magasinier du site expéditeur.
  'TRANSFER_REQUEST_CLOSED',
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
