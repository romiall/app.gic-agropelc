/**
 * Emplacement « à livrer » d'un site (`V_TO_DELIVER`, ADR-028 §1, BR-ADM-010 amendée) : un
 * emplacement **virtuel par site**, créé à la première confirmation d'une commande sur le site.
 * Virtuel, il n'est ni vendable, ni compté dans le disponible, ni dans l'effectif non vendu d'un
 * lot, ni dans un inventaire : la marchandise vendue y est mise de côté jusqu'à sa remise.
 *
 * Contrairement aux neuf emplacements virtuels globaux (seed, mis en cache par processus), celui-ci
 * se crée à la demande et ne se met donc pas en cache. Un seul actif par site
 * (`uq_organization_locations_active_to_deliver_site`) : deux confirmations simultanées sur un site
 * neuf créent une ligne, la seconde la retrouve. Lecture simple d'abord (une lecture verrouillante
 * d'un intervalle vide, suivie de l'insertion, provoquerait un interblocage entre les deux
 * transactions), insertion, puis — seulement après un doublon — lecture **verrouillante**, qui voit
 * la ligne validée par l'autre transaction malgré l'isolation répétable.
 */
import type { Transaction } from 'kysely';
import type { IdGenerator } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

export interface ToDeliverLocation {
  readonly locationId: string;
  readonly siteId: string;
  /** Vrai si cet appel a créé l'emplacement. */
  readonly created: boolean;
}

export class ToDeliverLocationError extends Error {
  constructor(
    message: string,
    public readonly code: 'SITE_NOT_FOUND' | 'SITE_CLOSED',
  ) {
    super(message);
    this.name = 'ToDeliverLocationError';
  }
}

async function findActive(
  uow: Transaction<DB>,
  siteId: string,
  lock: boolean,
): Promise<string | null> {
  const query = uow
    .selectFrom('organization_locations')
    .select('id')
    .where('site_id', '=', toBin(siteId))
    .where('location_type', '=', 'V_TO_DELIVER')
    .where('status', '=', 'ACTIVE');
  const row = await (lock ? query.forShare() : query).executeTakeFirst();
  return row ? fromBin(row.id) : null;
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { errno?: number }).errno === 1062
  );
}

/** Emplacement « à livrer » actif du site, créé s'il n'existe pas encore. */
export async function ensureToDeliverLocation(
  uow: Transaction<DB>,
  deps: { readonly idGenerator: IdGenerator },
  input: { readonly siteId: string; readonly createdBy: string },
): Promise<ToDeliverLocation> {
  const existing = await findActive(uow, input.siteId, false);
  if (existing !== null) return { locationId: existing, siteId: input.siteId, created: false };

  const site = await uow
    .selectFrom('organization_sites')
    .select(['code', 'name', 'status'])
    .where('id', '=', toBin(input.siteId))
    .executeTakeFirst();
  if (!site) throw new ToDeliverLocationError('Site introuvable.', 'SITE_NOT_FOUND');
  if (site.status !== 'ACTIVE') {
    throw new ToDeliverLocationError('Site fermé : pas d’emplacement « à livrer ».', 'SITE_CLOSED');
  }

  const locationId = deps.idGenerator.newId();
  try {
    await uow
      .insertInto('organization_locations')
      .values({
        id: toBin(locationId),
        site_id: toBin(input.siteId),
        code: `TD-${site.code}`.slice(0, 40),
        name: `À livrer — ${site.name}`.slice(0, 200),
        location_type: 'V_TO_DELIVER',
        status: 'ACTIVE',
        created_by: toBin(input.createdBy),
      })
      .execute();
  } catch (error) {
    // Créé entre-temps par une autre transaction : on le retrouve (lecture verrouillante).
    if (isDuplicateKey(error)) {
      const concurrent = await findActive(uow, input.siteId, true);
      if (concurrent !== null)
        return { locationId: concurrent, siteId: input.siteId, created: false };
    }
    throw error;
  }
  return { locationId, siteId: input.siteId, created: true };
}
