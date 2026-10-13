/**
 * Garde de configuration d'un point de vente tenue par `inventory` (P5-23, AV-195 (1), AV-230 ; ADR-033 §2,
 * INV-STK-19) : l'emplacement de vente ne passe pas en garde exclusive (`EXCLUSIVE_DEVICE`) tant qu'il porte
 * un quota d'appareil actif, épuisé compris — le révoquer ou le libérer d'abord (décision motivée d'un
 * responsable, `inventory.allocation.revoke` / `.release`, jamais une révocation d'office). Enregistrée
 * auprès d'`organization` au démarrage (inversion de dépendance).
 *
 * Lecture simple (aucun verrou sur les quotas, qu'une vente tient en exclusif avant de toucher
 * l'emplacement : un verrou ici formerait un cycle) : `pos.configure` tient déjà l'emplacement de vente en
 * exclusif, pris avant toute lecture de sa transaction — l'instantané lu ici suit donc tout octroi validé
 * avant lui, et un octroi plus tardif attend ce verrou puis relit le mode de garde (`grantHandler`).
 */
import type {
  PosConfigurationBlock,
  PosConfigurationChange,
} from '../../organization/application/public/index.js';
import { sql } from 'kysely';
import { toBin } from '../../../platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';

export async function inventoryPosConfigurationGuard(
  uow: UnitOfWork,
  change: PosConfigurationChange,
): Promise<PosConfigurationBlock | null> {
  if (change.next.custodyMode !== 'EXCLUSIVE_DEVICE') return null;
  const row = await uow
    .selectFrom('inventory_stock_allocations')
    .select(sql<string>`COUNT(*)`.as('active'))
    .where('location_id', '=', toBin(change.salesLocationId))
    .where('status', '=', 'ACTIVE')
    .executeTakeFirstOrThrow();
  const active = Number(row.active);
  if (active === 0) return null;
  return {
    code: 'POS_ALLOCATIONS_ACTIVE',
    messageFr: `L’emplacement de vente porte encore ${active} quota(s) d’appareil actif(s) : les révoquer ou les libérer avant de le passer en garde exclusive.`,
  };
}
