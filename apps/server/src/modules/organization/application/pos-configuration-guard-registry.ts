/**
 * Gardes de configuration d'un point de vente (P5-23, AV-195 (1), AV-230 ; ADR-033 §2). Passer
 * l'emplacement de vente en garde exclusive (`EXCLUSIVE_DEVICE`) laissait actifs les quotas d'appareil qu'il
 * portait en garde partagée : jamais plus consommés (un emplacement exclusif n'en consomme pas), ils
 * retranchaient pourtant leur reste du stock libre (INV-STK-19). `organization` ne connaît pas les quotas
 * (module de niveau supérieur) : il **inverse la dépendance**, comme pour la désactivation d'un emplacement
 * (`deactivation-guard-registry.ts`). Chaque module propriétaire enregistre une garde au démarrage ;
 * `organization.pos.configure` les consulte avant d'écrire, l'emplacement de vente déjà tenu en exclusif.
 *
 * Une garde ne modifie jamais rien : elle lit et renvoie le premier obstacle, ou `null`.
 */
import type { UnitOfWork } from '../../../platform/unit-of-work.js';

export interface PosCustody {
  readonly custodyMode: 'SHARED' | 'EXCLUSIVE_DEVICE';
  readonly designatedDeviceId: string | null;
}

export interface PosConfigurationChange {
  readonly siteId: string;
  readonly salesLocationId: string;
  /** Garde actuelle de l'emplacement de vente (avant la configuration). */
  readonly previous: PosCustody;
  readonly next: PosCustody;
}

export interface PosConfigurationBlock {
  /** Code stable, renvoyé au client (`POS_ALLOCATIONS_ACTIVE`…). */
  readonly code: string;
  readonly messageFr: string;
}

export type PosConfigurationGuard = (
  uow: UnitOfWork,
  change: PosConfigurationChange,
) => Promise<PosConfigurationBlock | null>;

export class PosConfigurationGuardRegistry {
  private readonly guards = new Map<string, PosConfigurationGuard>();

  /** Un module enregistre une garde par nom ; un nom pris par une autre garde est une erreur de câblage. */
  register(name: string, guard: PosConfigurationGuard): void {
    // Idempotent : le registre est un singleton de module, et une application Nest peut être recréée
    // dans un même processus (tests) ; la même garde y est alors réenregistrée sous le même nom.
    const existing = this.guards.get(name);
    if (existing !== undefined && existing !== guard) {
      throw new Error(
        `Une autre garde de configuration de PDV est déjà enregistrée sous le nom ${name}.`,
      );
    }
    this.guards.set(name, guard);
  }

  /** Premier obstacle trouvé, dans l'ordre d'enregistrement ; `null` si la configuration est possible. */
  async firstBlock(
    uow: UnitOfWork,
    change: PosConfigurationChange,
  ): Promise<PosConfigurationBlock | null> {
    for (const guard of this.guards.values()) {
      const block = await guard(uow, change);
      if (block !== null) return block;
    }
    return null;
  }

  get size(): number {
    return this.guards.size;
  }
}
