/**
 * Gardes de désactivation d'un emplacement (BR-ADM-011, INV-STK-07) : « aucun solde non nul, aucune
 * allocation active, aucun transfert ouvert ». `organization` ne connaît ni les soldes, ni les
 * quotas, ni les transferts (modules de niveau supérieur) : il **inverse la dépendance**, comme
 * `approvals` pour les décisions. Chaque module propriétaire d'une de ces données enregistre une
 * garde au démarrage ; `organization.location.deactivate` les consulte avant d'écrire.
 *
 * Une garde ne modifie jamais rien : elle lit et renvoie le premier obstacle, ou `null`.
 */
import type { UnitOfWork } from '../../../platform/unit-of-work.js';

export interface LocationDeactivationBlock {
  /** Code stable, renvoyé au client (`LOCATION_NOT_EMPTY`, `LOCATION_HAS_ALLOCATIONS`…). */
  readonly code: string;
  readonly messageFr: string;
}

export type LocationDeactivationGuard = (
  uow: UnitOfWork,
  locationId: string,
) => Promise<LocationDeactivationBlock | null>;

export class LocationDeactivationGuardRegistry {
  private readonly guards = new Map<string, LocationDeactivationGuard>();

  /** Un module enregistre une garde par nom ; un nom pris par une autre garde est une erreur de câblage. */
  register(name: string, guard: LocationDeactivationGuard): void {
    // Idempotent : le registre est un singleton de module, et une application Nest peut être recréée
    // dans un même processus (tests) ; la même garde y est alors réenregistrée sous le même nom.
    const existing = this.guards.get(name);
    if (existing !== undefined && existing !== guard) {
      throw new Error(`Une autre garde de désactivation est déjà enregistrée sous le nom ${name}.`);
    }
    this.guards.set(name, guard);
  }

  /** Premier obstacle trouvé, dans l'ordre d'enregistrement ; `null` si la désactivation est possible. */
  async firstBlock(uow: UnitOfWork, locationId: string): Promise<LocationDeactivationBlock | null> {
    for (const guard of this.guards.values()) {
      const block = await guard(uow, locationId);
      if (block !== null) return block;
    }
    return null;
  }

  get size(): number {
    return this.guards.size;
  }
}
