/**
 * Tableau de distribution d'un PDV (D05 BR-DIS-010, BR-DIS-012 ; D11 KPI-DIS-01 à 07 ; AT-042) :
 * identité de rapprochement, partagée entre le tableau et le test d'acceptation. Pur, sans entrée-sortie.
 * Quantités en unité de base, trois décimales au plus, calculées en millièmes entiers (ADR-013).
 */
import { quantityFromDecimal, quantityMilliUnits } from './quantity.js';

const milli = (value: number): number => quantityMilliUnits(quantityFromDecimal(value));

/** Flux d'un produit à l'emplacement de vente d'un PDV sur une période (jours métier, Africa/Douala). */
export interface DistributionFlows {
  /** Solde au début de la période. */
  readonly openingBalance: number;
  /** Reçu : réceptions de transferts à l'emplacement de vente. */
  readonly received: number;
  /** Autres entrées : gains d'inventaire, retours clients rattachés, déplacements entrants. */
  readonly otherIn: number;
  /** Vendu net des contre-écritures (`SALE` − `CUSTOMER_RETURN` rattachés), y compris le vendu à livrer. */
  readonly soldNet: number;
  /** Perdu : pertes reconnues + écarts d'inventaire négatifs + écarts de transfert confirmés. */
  readonly lost: number;
  /** Autres sorties : retours au magasin, transferts vers un autre PDV, consommations. */
  readonly otherOut: number;
  /** Solde à la fin de la période. */
  readonly closingBalance: number;
}

/**
 * BR-DIS-012 : solde fin − solde début = reçu + autres entrées − vendu net − perdu − autres sorties.
 * Renvoie l'écart non expliqué (0 quand le tableau se rapproche du registre) ; chaque indicateur reste
 * ainsi explicable jusqu'aux mouvements (BR-ANA-010).
 */
export function distributionResidual(flows: DistributionFlows): number {
  const explained =
    milli(flows.openingBalance) +
    milli(flows.received) +
    milli(flows.otherIn) -
    milli(flows.soldNet) -
    milli(flows.lost) -
    milli(flows.otherOut);
  return (milli(flows.closingBalance) - explained) / 1000;
}

export function isDistributionReconciled(flows: DistributionFlows): boolean {
  return distributionResidual(flows) === 0;
}
