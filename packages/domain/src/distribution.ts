/**
 * Tableau de distribution d'un PDV (D05 BR-DIS-010 ; D11 KPI-DIS-01 à 07 ; AT-042 ; AV-199) :
 * identité de rapprochement, partagée entre le tableau, les métriques d'`inventory` (P5-19,
 * `locationFlows`) et le test d'acceptation. Pur, sans entrée-sortie. Quantités en unité de base, trois
 * décimales au plus, calculées en millièmes entiers (ADR-013). Chaque mouvement de l'emplacement tombe
 * dans une seule catégorie, à sa date ; les écarts de transfert (partis du transit, jamais du solde du
 * PDV) restent hors de l'identité.
 */
import { quantityFromDecimal, quantityMilliUnits } from './quantity.js';

const milli = (value: number): number => quantityMilliUnits(quantityFromDecimal(value));

/** Flux d'un produit à l'emplacement de vente d'un PDV sur une période (jours métier, Africa/Douala). */
export interface DistributionFlows {
  /** Solde au début de la période. */
  readonly openingBalance: number;
  /** Reçu : réceptions de transferts à l'emplacement de vente (nettes des requalifications de
   * réceptions sans document), marchandise d'un écart de transfert rejeté comprise. */
  readonly received: number;
  /** Autres entrées : gains d'inventaire, déplacements entrants, achats… (jamais un retour client,
   * déjà retranché du vendu net). */
  readonly otherIn: number;
  /** Vendu net des contre-écritures (`SALE` − `CUSTOMER_RETURN` rattachés), y compris le vendu à livrer. */
  readonly soldNet: number;
  /** Perdu à l'emplacement : pertes reconnues + écarts d'inventaire négatifs. Les écarts de transfert
   * confirmés, partis du transit, s'affichent avec le perdu (AV-164) mais restent hors identité. */
  readonly lost: number;
  /** Pertes en attente de décision, nettes de leurs libérations (AV-164 : à part). */
  readonly lostPending: number;
  /** Autres sorties : transferts expédiés (retours au magasin, vers un autre PDV) nets des retours à
   * la source, consommations… */
  readonly otherOut: number;
  /** Solde à la fin de la période. */
  readonly closingBalance: number;
}

/**
 * Identité (AV-199) : solde fin − solde début = reçu + autres entrées − vendu net − perdu − pertes en
 * attente − autres sorties.
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
    milli(flows.lostPending) -
    milli(flows.otherOut);
  return (milli(flows.closingBalance) - explained) / 1000;
}

export function isDistributionReconciled(flows: DistributionFlows): boolean {
  return distributionResidual(flows) === 0;
}
