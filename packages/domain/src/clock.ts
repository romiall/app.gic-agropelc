/**
 * Horloge injectée (05-architecture/01-architecture-logicielle.md §7 « Préoccupations
 * transverses » : « Service d'horloge injecté (tests déterministes) »).
 *
 * Aucune fonction de `packages/domain` ne lit `Date.now()` ni `new Date()` directement
 * (règle vérifiée en CI par eslint.config.mjs). L'heure de référence est toujours reçue
 * via une implémentation de `Clock`, ce qui rend chaque calcul testable de façon
 * déterministe (NFR-31) et exécutable à l'identique sur l'appareil et sur le serveur (K1).
 */

export interface Clock {
  /** Heure courante, en UTC. */
  now(): Date;
}

/** Implémentation figée pour les tests : renvoie toujours le même instant. */
export class FixedClock implements Clock {
  constructor(private instant: Date) {}

  now(): Date {
    return new Date(this.instant.getTime());
  }

  /** Avance l'horloge de test de `ms` millisecondes (scénarios de synchronisation). */
  advance(ms: number): void {
    this.instant = new Date(this.instant.getTime() + ms);
  }

  setTo(instant: Date): void {
    this.instant = new Date(instant.getTime());
  }
}
