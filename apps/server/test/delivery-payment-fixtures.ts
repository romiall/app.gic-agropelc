/**
 * Fixture des essais de livraison (AV-511) : une commande se reçoit sans argent, elle se livre payée.
 * Le paramètre `sales.delivery_requires_full_payment` vaut `true` par défaut ; la plupart des suites de
 * vente livrent des commandes sans les payer, pour éprouver autre chose que le paiement. Elles le lèvent
 * (`false`) **pour leur site d'essai seulement** (réglage de site : base partagée, les autres suites gardent
 * le défaut) ; seules celles qui éprouvent la garde la laissent, ou la rétablissent à une date donnée.
 */
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { db, freshUuid } from './helpers.js';

export const DELIVERY_FULL_PAYMENT_SETTING = 'sales.delivery_requires_full_payment';

/** Utilisateur système de la base (créé par l'amorçage) : auteur des réglages d'essai sans administrateur propre. */
async function systemUserId(): Promise<string> {
  const row = await db
    .selectFrom('identity_users')
    .select('id')
    .where('is_system', '=', 1)
    .executeTakeFirstOrThrow();
  return fromBin(row.id);
}

/**
 * Pose une version du réglage pour le site d'essai : `false` par défaut (lève l'exigence), `true` ou une
 * valeur mal formée pour l'éprouver. `validFrom` : début de validité (les réglages se lisent à l'heure du
 * fait, une version plus récente remplace la précédente). `createdBy` : l'auteur de la version ; à défaut,
 * l'utilisateur système (la suite n'a pas d'administrateur hors de sa transaction d'amorçage).
 */
export async function allowDeliveryWithoutPayment(
  siteId: string,
  createdBy: string | null = null,
  value: unknown = false,
  validFrom: string = '2026-01-01T00:00:00.000Z',
): Promise<void> {
  await db
    .insertInto('organization_system_settings')
    .values({
      id: toBin(freshUuid()),
      key: DELIVERY_FULL_PAYMENT_SETTING,
      value: jsonValue(value),
      scope_type: 'SITE',
      scope_id: toBin(siteId),
      valid_from: new Date(validFrom),
      // Non visible de l'appareil : le seed publie dans le jeu `me` toute version visible, et ces réglages
      // de site d'essai n'ont rien à y faire (les suites du seed comptent les lignes publiées).
      is_client_visible: 0,
      reason: 'Essai AV-511',
      created_by: toBin(createdBy ?? (await systemUserId())),
    })
    .execute();
}
