/**
 * Données des pièces de vente lues sur l'appareil : bon de vente (BV), facture (FA), reçu
 * d'encaissement (RE), bon de commande client (CC), bon de livraison (BL). Fonctions pures : elles
 * ne lisent que les référentiels déjà chargés par l'écran (`useSalesReferences`).
 */
import { rootCustomerId, type SalesReferences } from '../sales/references.js';
import type { SaleView } from '../sales/recent-sales.js';
import type { OrderView } from '../sales/open-orders.js';
import type { CustomerData, CustomerPaymentData, SaleData } from '../sales/types.js';
import { formatQuantity, unitLabel } from '../sales/format.js';
import type { DemandePiece } from './demande.js';
import { dateHeurePiece, datePiece, jourPiece, moyenPiece } from './format.js';

type Refs = Pick<
  SalesReferences,
  | 'users'
  | 'customers'
  | 'customerAlias'
  | 'locations'
  | 'sites'
  | 'units'
  | 'sales'
  | 'payments'
  | 'outbox'
  | 'zones'
>;

/** Numéro imprimé : numéro officiel, sinon référence locale, sinon « EN ATTENTE » (AV-310). */
export function numeroImprime(doc: string | null | undefined, local?: string | null): string {
  return doc || local || 'EN ATTENTE';
}

export function nomUtilisateur(
  refs: Pick<Refs, 'users'>,
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  return refs.users.find((u) => u.id === id)?.full_name ?? null;
}

export function client(
  refs: Pick<Refs, 'customers' | 'customerAlias'>,
  id: string | null | undefined,
): CustomerData | undefined {
  if (!id) return undefined;
  const racine = rootCustomerId(refs.customerAlias, id);
  return refs.customers.find((c) => c.id === racine);
}

function lieu(
  refs: Pick<Refs, 'locations' | 'sites'>,
  locationId: string | null,
  siteId: string | null,
): string | null {
  const loc = locationId ? refs.locations.find((l) => l.id === locationId) : undefined;
  if (loc) return loc.name;
  return siteId ? (refs.sites.get(siteId)?.name ?? null) : null;
}

interface PaiementSaisi {
  readonly methodCode?: string;
  readonly amountXaf: number;
  readonly reference?: string;
}

/** Encaissements d'une vente : ceux du serveur, sinon ceux saisis avec la vente sur l'appareil. */
function paiementsDeVente(
  sale: SaleView,
  refs: Refs,
): { moyens: string[]; reference: string | null } {
  const projection: SaleData | undefined = refs.sales.find((s) => s.id === sale.id);
  if (projection) {
    const ids = new Set(
      projection.payments.filter((p) => p.status === 'ACTIVE').map((p) => p.payment_id),
    );
    const paiements = refs.payments.filter((p) => ids.has(p.id));
    return {
      moyens: [
        ...new Set(
          paiements.map((p) => moyenPiece(p.payment_method_code)).filter((m): m is string => !!m),
        ),
      ],
      reference:
        paiements
          .map((p) => p.external_reference)
          .filter(Boolean)
          .join(', ') || null,
    };
  }
  const commande = sale.commandId
    ? refs.outbox.find((c) => c.command_id === sale.commandId)
    : undefined;
  const saisis =
    (commande?.payload as { payments?: readonly PaiementSaisi[] } | undefined)?.payments ?? [];
  return {
    moyens: [
      ...new Set(saisis.map((p) => moyenPiece(p.methodCode)).filter((m): m is string => !!m)),
    ],
    reference:
      saisis
        .map((p) => p.reference)
        .filter(Boolean)
        .join(', ') || null,
  };
}

const quantite = (q: number) => formatQuantity(q);

export function demandeBonDeVente(sale: SaleView, refs: Refs): DemandePiece {
  const c = client(refs, sale.customerId);
  const projection = refs.sales.find((s) => s.id === sale.id);
  const { moyens, reference } = paiementsDeVente(sale, refs);
  return {
    code: 'BV',
    donnees: {
      numero: numeroImprime(sale.docNumber, projection?.local_ref),
      client: c?.display_name ?? null,
      telephone: c?.phone_primary ?? null,
      anonyme: !sale.customerId,
      pointDeVente: lieu(refs, sale.fromLocationId, sale.siteId),
      dateHeure: dateHeurePiece(sale.occurredAt),
      vendeur: nomUtilisateur(refs, sale.sellerUserId),
      lignes: sale.lines.map((l) => ({
        designation: l.productName,
        unite: unitLabel(l.unitCode, l.quantity, refs.units),
        quantite: quantite(l.quantity),
        poidsKg: null,
        prixUnitaire: l.unitPriceXaf,
        remise: l.discountXaf,
        montant: l.lineTotalXaf,
      })),
      total: sale.netTotalXaf,
      moyens,
      encaisse: sale.amountPaidXaf,
      reference,
      resteDu: sale.balanceDueXaf,
    },
  };
}

/**
 * Facture d'une vente (FA, choix du porteur du 26/10/2026). Prix TTC, TVA à 0 (AV-041) : le prix
 * unitaire et le montant sont ceux de la vente, la TVA vaut 0 ; le régime de TVA et la mention
 * d'exonération restent à cocher à la main tant qu'AV-451 n'est pas tranché.
 */
export function demandeFacture(sale: SaleView, refs: Refs): DemandePiece {
  const c = client(refs, sale.customerId);
  const projection = refs.sales.find((s) => s.id === sale.id);
  const echeance = projection?.due_date ? jourPiece(projection.due_date) : null;
  return {
    code: 'FA',
    donnees: {
      numero: numeroImprime(sale.docNumber, projection?.local_ref),
      dateEmission: datePiece(sale.occurredAt),
      echeance,
      venteOuCommande: sale.docNumber,
      client: c?.display_name ?? null,
      niuClient: null,
      adresse: c?.address_text ?? null,
      telephone: c?.phone_primary ?? null,
      lignes: sale.lines.map((l) => ({
        designation: l.productName,
        unite: unitLabel(l.unitCode, l.quantity, refs.units),
        quantite: quantite(l.quantity),
        prixUnitaireHt: l.unitPriceXaf,
        tauxTva: '0 %',
        montantHt: l.lineTotalXaf,
      })),
      regimeTva: null,
      mentionExoneration: null,
      totalHt: sale.netTotalXaf,
      tva: 0,
      totalTtc: sale.netTotalXaf,
      acompte: sale.amountPaidXaf,
      netAPayer: sale.balanceDueXaf,
      banque: null,
      compte: null,
      mobileMoney: null,
      vendeur: nomUtilisateur(refs, sale.sellerUserId),
    },
  };
}

/** Reçu d'un encaissement ; `objet` : la vente ou la commande réglée, si elle est connue. */
export function demandeRecu(
  paiement: CustomerPaymentData,
  refs: Refs,
  objet: { readonly type: 'vente' | 'acompte'; readonly numero: string | null } | null,
  resteDu: number | null,
): DemandePiece {
  const c = client(refs, paiement.customer_id);
  return {
    code: 'RE',
    donnees: {
      numero: numeroImprime(paiement.doc_number),
      recuDe: c?.display_name ?? null,
      telephone: c?.phone_primary ?? null,
      site: refs.sites.get(paiement.site_id)?.name ?? null,
      dateHeure: dateHeurePiece(paiement.occurred_at),
      montant: paiement.amount_xaf,
      resteDu,
      moyen: moyenPiece(paiement.payment_method_code),
      reference: paiement.external_reference,
      objet: objet?.type ?? null,
      objetNumero: objet?.numero ?? null,
      caissier: nomUtilisateur(refs, paiement.received_by_user_id),
    },
  };
}

export function demandeCommandeClient(
  order: OrderView,
  refs: Refs & Pick<SalesReferences, 'orders'>,
): DemandePiece {
  const c = client(refs, order.customerId);
  const projection = refs.orders.get(order.id);
  const zone = c ? (refs.zones.get(c.zone_id)?.name ?? null) : null;
  return {
    code: 'CC',
    donnees: {
      numero: numeroImprime(order.docNumber, projection?.local_ref),
      client: c?.display_name ?? null,
      telephone: c?.phone_primary ?? null,
      adresse: order.deliveryAddress ?? c?.address_text ?? null,
      livraisonSouhaitee: jourPiece(order.requestedDeliveryDate),
      zone,
      dateHeure: dateHeurePiece(order.occurredAt),
      commercial: nomUtilisateur(refs, projection?.commercial_user_id ?? projection?.created_by),
      lignes: order.lines.map((l) => ({
        designation: l.productName,
        unite: unitLabel(l.unitCode, l.quantity, refs.units),
        quantite: quantite(l.quantity),
        prixConvenu: l.quotedUnitPriceXaf,
        montant: l.lineTotalXaf,
      })),
      total: order.totalEstimatedXaf,
      acompte: order.advancePaidXaf || null,
      modeAcompte: null,
    },
  };
}

/** Ligne livrée d'une livraison saisie : quantité en unité de base de la ligne de commande. */
export interface LivraisonSaisie {
  readonly numero: string | null;
  readonly occurredAt: string;
  readonly auteurId: string | null;
  readonly recuPar: string | null;
  readonly observations: string | null;
  readonly lignes: readonly { readonly orderLineId: string; readonly quantityBase: number }[];
}

/** `order` : la commande telle qu'elle était avant cette livraison (saisie de l'écran). */
export function demandeBonLivraison(
  order: OrderView,
  livraison: LivraisonSaisie,
  refs: Refs,
): DemandePiece {
  const c = client(refs, order.customerId);
  const livre = new Map(livraison.lignes.map((l) => [l.orderLineId, l.quantityBase]));
  // Les quantités de la commande sont en unité de base ; la pièce les écrit dans l'unité de la
  // ligne quand le facteur est connu (quantité / quantité de base), sinon en unité de base.
  const lignes = order.lines
    .filter((l) => l.id !== null && livre.has(l.id))
    .map((l) => {
      const facteur = l.orderedBase > 0 ? l.quantity / l.orderedBase : 1;
      const jour = livre.get(l.id!) ?? 0;
      const reste = Math.max(0, l.orderedBase - l.deliveredBase - l.deliveringBase - jour);
      return {
        designation: l.productName,
        unite: unitLabel(l.unitCode, l.quantity, refs.units),
        commandee: quantite(l.quantity),
        livree: quantite(jour * facteur),
        reste: quantite(reste * facteur),
      };
    });
  const complete = order.lines.every((l) => {
    const jour = l.id ? (livre.get(l.id) ?? 0) : 0;
    return l.orderedBase - l.deliveredBase - l.deliveringBase - jour <= 0;
  });
  return {
    code: 'BL',
    donnees: {
      numero: numeroImprime(livraison.numero),
      client: c?.display_name ?? null,
      telephone: c?.phone_primary ?? null,
      adresse: order.deliveryAddress ?? c?.address_text ?? null,
      commande: order.docNumber,
      livreLe: dateHeurePiece(livraison.occurredAt),
      livrePar: nomUtilisateur(refs, livraison.auteurId),
      lignes,
      complete,
      observations: livraison.observations,
      recuPar: livraison.recuPar,
    },
  };
}
