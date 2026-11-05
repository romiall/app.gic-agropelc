/**
 * Motifs par défaut des réceptions, du stock, des transferts et des remises (AV-320, défaut (a) mis en œuvre le
 * 05/11/2026 ; à valider avec GIC avant le pilote). Sans eux, sur une base neuve, on ne peut ni rejeter de la
 * marchandise à la réception (`REJECTION_REASON_REQUIRED`), ni justifier un écart d'inventaire, un écart de transfert
 * ou une remise : les listes de l'écran sont vides.
 *
 * Comme les motifs du CRM (AV-248), ils sont **modifiables et désactivables** par un administrateur (section « Motifs »
 * du catalogue) ; le seed n'insère que les codes absents et ne réécrit jamais un motif modifié depuis. « Autre » exige un
 * commentaire. Libellés français DÉDUITS de l'activité (aucune source ne les fixe), ajustables au catalogue.
 *
 * - `REJECTION` : rejet de marchandise à la réception d'un achat (BR-APP-007).
 * - `INVENTORY_ADJUSTMENT` : écart constaté à l'inventaire (ECR-STK-04).
 * - `TRANSFER_DISCREPANCY` : écart entre l'expédié et le reçu d'un transfert (BR-STK-026).
 * - `PRICE_OVERRIDE` : remise, c'est-à-dire un prix de vente différent du prix catalogue (BR-VEN-007).
 * - `LOSS` : cause d'une perte de stock, rattachée à la catégorie de perte (`loss_category`) ; la mortalité d'un lot
 *   et les causes sanitaires restent à définir avec la production (non semées).
 * `CHECKIN_OVERRIDE` et `CASH_VARIANCE` n'ont pas d'écran de choix de motif : non semés.
 */
import type { ReasonCodeSeed } from './production-references.js';

export const STOCK_SALES_REASON_CODES: readonly ReasonCodeSeed[] = [
  { category: 'REJECTION', code: 'PERIME', label: 'Produit périmé' },
  { category: 'REJECTION', code: 'ABIME', label: 'Marchandise abîmée ou cassée' },
  { category: 'REJECTION', code: 'NON_CONFORME', label: 'Non conforme à la commande' },
  { category: 'REJECTION', code: 'QUANTITE_ERRONEE', label: 'Quantité erronée' },
  { category: 'REJECTION', code: 'AUTRE', label: 'Autre', requiresComment: true },

  { category: 'INVENTORY_ADJUSTMENT', code: 'ERREUR_COMPTAGE', label: 'Erreur de comptage' },
  { category: 'INVENTORY_ADJUSTMENT', code: 'CASSE', label: 'Casse constatée' },
  { category: 'INVENTORY_ADJUSTMENT', code: 'PEREMPTION', label: 'Produit périmé retiré' },
  { category: 'INVENTORY_ADJUSTMENT', code: 'AUTRE', label: 'Autre', requiresComment: true },

  { category: 'TRANSFER_DISCREPANCY', code: 'MANQUANT_TRANSPORT', label: 'Manquant au transport' },
  {
    category: 'TRANSFER_DISCREPANCY',
    code: 'CASSE_TRANSPORT',
    label: 'Casse pendant le transport',
  },
  {
    category: 'TRANSFER_DISCREPANCY',
    code: 'ERREUR_EXPEDITION',
    label: 'Erreur à l’expédition',
  },
  { category: 'TRANSFER_DISCREPANCY', code: 'AUTRE', label: 'Autre', requiresComment: true },

  { category: 'PRICE_OVERRIDE', code: 'GESTE_COMMERCIAL', label: 'Geste commercial' },
  { category: 'PRICE_OVERRIDE', code: 'CLIENT_FIDELE', label: 'Client fidèle' },
  { category: 'PRICE_OVERRIDE', code: 'GROS_VOLUME', label: 'Achat en gros volume' },
  {
    category: 'PRICE_OVERRIDE',
    code: 'ALIGNEMENT_CONCURRENT',
    label: 'Alignement sur un concurrent',
  },
  {
    category: 'PRICE_OVERRIDE',
    code: 'PRODUIT_A_ECOULER',
    label: 'Produit à écouler (abîmé ou proche de la péremption)',
  },
  { category: 'PRICE_OVERRIDE', code: 'AUTRE', label: 'Autre', requiresComment: true },

  {
    category: 'LOSS',
    code: 'CASSE_MANUTENTION',
    label: 'Casse à la manutention',
    lossCategory: 'CASSE',
  },
  {
    category: 'LOSS',
    code: 'CASSE_TRANSPORT',
    label: 'Casse pendant le transport',
    lossCategory: 'CASSE',
  },
  {
    category: 'LOSS',
    code: 'MAUVAISE_CONSERVATION',
    label: 'Mauvaise conservation (chaleur, humidité)',
    lossCategory: 'DETERIORATION',
  },
  {
    category: 'LOSS',
    code: 'PEREMPTION_DEPASSEE',
    label: 'Date de péremption dépassée',
    lossCategory: 'IMPROPRE',
  },
  {
    category: 'LOSS',
    code: 'DESTRUCTION_SANITAIRE',
    label: 'Destruction sur décision sanitaire',
    lossCategory: 'DESTRUCTION',
  },
];
