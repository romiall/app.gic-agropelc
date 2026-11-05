/**
 * Fixtures des essais de livraison (AV-511, AV-512) : une commande se reçoit sans argent, elle se livre payée —
 * ou à crédit pour un client autorisé, dans son plafond. Les paramètres `sales.delivery_requires_full_payment`
 * et `sales.delivery_on_credit_allowed` valent `true` par défaut ; la plupart des suites de vente livrent des
 * commandes sans les payer, pour éprouver autre chose que le paiement. Elles lèvent le premier (`false`)
 * **pour leur site d'essai seulement** (réglage de site : base partagée, les autres suites gardent le défaut) ;
 * seules celles qui éprouvent la garde la laissent, ou la rétablissent à une date donnée.
 */
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { db, freshUuid } from './helpers.js';

export const DELIVERY_FULL_PAYMENT_SETTING = 'sales.delivery_requires_full_payment';
export const DELIVERY_ON_CREDIT_SETTING = 'sales.delivery_on_credit_allowed';

/** Utilisateur système de la base (créé par l'amorçage) : auteur des réglages d'essai sans administrateur propre. */
async function systemUserId(): Promise<string> {
  const row = await db
    .selectFrom('identity_users')
    .select('id')
    .where('is_system', '=', 1)
    .executeTakeFirstOrThrow();
  return fromBin(row.id);
}

/** Version d'un réglage de site d'essai (jamais le réglage global, partagé entre les suites). */
async function siteSetting(
  key: string,
  siteId: string,
  createdBy: string | null,
  value: unknown,
  validFrom: string,
): Promise<void> {
  await db
    .insertInto('organization_system_settings')
    .values({
      id: toBin(freshUuid()),
      key,
      value: jsonValue(value),
      scope_type: 'SITE',
      scope_id: toBin(siteId),
      valid_from: new Date(validFrom),
      // Non visible de l'appareil : le seed publie dans le jeu `me` toute version visible, et ces réglages
      // de site d'essai n'ont rien à y faire (les suites du seed comptent les lignes publiées).
      is_client_visible: 0,
      reason: 'Essai AV-511, AV-512',
      created_by: toBin(createdBy ?? (await systemUserId())),
    })
    .execute();
}

/**
 * Pose une version de `sales.delivery_requires_full_payment` pour le site d'essai : `false` par défaut (lève
 * tout contrôle de paiement à la livraison), `true` ou une valeur mal formée pour l'éprouver. `validFrom` :
 * début de validité (les réglages se lisent à l'heure du fait, une version plus récente remplace la
 * précédente). `createdBy` : l'auteur de la version ; à défaut, l'utilisateur système (la suite n'a pas
 * d'administrateur hors de sa transaction d'amorçage).
 */
export function allowDeliveryWithoutPayment(
  siteId: string,
  createdBy: string | null = null,
  value: unknown = false,
  validFrom: string = '2026-01-01T00:00:00.000Z',
): Promise<void> {
  return siteSetting(DELIVERY_FULL_PAYMENT_SETTING, siteId, createdBy, value, validFrom);
}

/**
 * Pose une version de `sales.delivery_on_credit_allowed` pour le site d'essai : `false` par défaut (un client
 * autorisé au crédit paie d'abord), `true` ou une valeur mal formée pour l'éprouver.
 */
export function setDeliveryOnCredit(
  siteId: string,
  createdBy: string | null = null,
  value: unknown = false,
  validFrom: string = '2026-01-01T00:00:00.000Z',
): Promise<void> {
  return siteSetting(DELIVERY_ON_CREDIT_SETTING, siteId, createdBy, value, validFrom);
}
