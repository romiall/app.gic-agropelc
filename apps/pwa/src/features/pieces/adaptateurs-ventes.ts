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
import { dateHeurePiece, datePiece, jourPiece, moyenPiece, xafPiece } from './format.js';

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
  | 'products'
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
const arrondi3 = (q: number) => Math.round(q * 1000) / 1000;

/**
 * Prix d'une ligne dans l'unité imprimée. Le serveur tarife par unité de base (ou au kg pour un
 * produit vendu au poids) : `montant = quantité tarifée × prix − remise`. La pièce écrit donc :
 * - au poids : la quantité de la ligne, le poids tarifé et le prix au kg ;
 * - sinon : le prix ramené à l'unité de la ligne quand il est entier (2 plateaux à 3 000), à défaut
 *   la quantité et le prix en unité de base, pour que quantité × prix = montant + remise.
 * La quantité tarifée se lit dans le montant brut (`montant + remise`) : le serveur l'arrondit au
 * franc, d'où l'arrondi à trois décimales (DÉDUIT : exact dès que le prix dépasse 1 000 XAF le kg).
 */
function lignePrix(
  refs: Pick<Refs, 'products' | 'units'>,
  l: {
    readonly productId: string;
    readonly quantity: number;
    readonly unitCode: string;
    readonly unitPriceXaf: number;
    readonly brutXaf: number;
  },
  auPoids = true,
): { unite: string; quantite: string; poidsKg: string | null; prix: number } {
  const produit = refs.products.find((p) => p.id === l.productId);
  const tarifee = l.unitPriceXaf > 0 ? arrondi3(l.brutXaf / l.unitPriceXaf) : null;
  const dansLaLigne = {
    unite: unitLabel(l.unitCode, l.quantity, refs.units),
    quantite: quantite(l.quantity),
  };
  if (auPoids && produit?.pricing_mode === 'PER_WEIGHT') {
    return {
      ...dansLaLigne,
      poidsKg: tarifee === null ? null : quantite(tarifee),
      prix: l.unitPriceXaf,
    };
  }
  const parUnite = l.quantity > 0 ? l.brutXaf / l.quantity : null;
  if (tarifee === null || (parUnite !== null && Number.isInteger(parUnite))) {
    return { ...dansLaLigne, poidsKg: null, prix: parUnite ?? l.unitPriceXaf };
  }
  const base = produit?.base_unit_code ?? l.unitCode;
  return {
    unite: unitLabel(base, tarifee, refs.units),
    quantite: quantite(tarifee),
    poidsKg: null,
    prix: l.unitPriceXaf,
  };
}

/**
 * Lignes d'une vente telles qu'elles restent après ses annulations partielles : une ligne annulée en
 * entier disparaît, une ligne annulée en partie garde sa part restante (quantité au prorata de la
 * quantité de base annulée, connue par le jeu `sales_recent`). Une vente annulée en entier garde
 * ses lignes d'origine, sous le tampon « ANNULÉE ». Le total des lignes est alors le total net.
 */
function lignesRestantes(sale: SaleView, refs: Pick<Refs, 'sales'>) {
  const projection = refs.sales.find((s) => s.id === sale.id);
  return sale.lines
    .map((l, i) => {
      if (sale.status === 'CANCELLED' || l.cancelledXaf <= 0) return l;
      const origine = projection?.lines[i];
      const reste =
        origine && origine.quantity_base > 0
          ? (origine.quantity_base - origine.cancelled_quantity_base) / origine.quantity_base
          : null;
      return {
        ...l,
        quantity: reste === null ? l.quantity : arrondi3(l.quantity * reste),
        lineTotalXaf: l.lineTotalXaf - l.cancelledXaf,
        // Remise au prorata : la part annulée en emporte sa part.
        discountXaf: reste === null ? l.discountXaf : Math.round(l.discountXaf * reste),
      };
    })
    .filter((l) => sale.status === 'CANCELLED' || l.lineTotalXaf > 0 || l.cancelledXaf <= 0);
}

export function demandeBonDeVente(sale: SaleView, refs: Refs): DemandePiece {
  const c = client(refs, sale.customerId);
  const projection = refs.sales.find((s) => s.id === sale.id);
  const { moyens, reference } = paiementsDeVente(sale, refs);
  const lignes = lignesRestantes(sale, refs);
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
      lignes: lignes.map((l) => {
        const p = lignePrix(refs, { ...l, brutXaf: l.lineTotalXaf + l.discountXaf });
        return {
          designation: l.productName,
          unite: p.unite,
          quantite: p.quantite,
          poidsKg: p.poidsKg,
          prixUnitaire: p.prix,
          remise: l.discountXaf,
          montant: l.lineTotalXaf,
        };
      }),
      total: lignes.reduce((t, l) => t + l.lineTotalXaf, 0),
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
  const lignes = lignesRestantes(sale, refs);
  const total = lignes.reduce((t, l) => t + l.lineTotalXaf, 0);
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
      // Pas de colonne « remise » sur la facture : quantité × prix = montant net quand c'est possible
      // (prix net par unité entier), sinon la remise est écrite dans la désignation. Au poids, la
      // facture compte en kg (le nombre de pièces est rappelé dans la désignation).
      lignes: lignes.map((l) => {
        const brut = lignePrix(refs, { ...l, brutXaf: l.lineTotalXaf + l.discountXaf });
        const netParUnite = l.quantity > 0 ? l.lineTotalXaf / l.quantity : null;
        const remise = l.discountXaf > 0 ? `remise ${xafPiece(l.discountXaf)} XAF` : null;
        if (brut.poidsKg) {
          const details = [`${brut.quantite} ${brut.unite}`, remise].filter(Boolean).join(', ');
          return {
            designation: `${l.productName} (${details})`,
            unite: 'kg',
            quantite: brut.poidsKg,
            prixUnitaireHt: brut.prix,
            tauxTva: '0 %',
            montantHt: l.lineTotalXaf,
          };
        }
        if (netParUnite !== null && Number.isInteger(netParUnite)) {
          return {
            designation: l.productName,
            unite: unitLabel(l.unitCode, l.quantity, refs.units),
            quantite: quantite(l.quantity),
            prixUnitaireHt: netParUnite,
            tauxTva: '0 %',
            montantHt: l.lineTotalXaf,
          };
        }
        return {
          designation: remise ? `${l.productName} (${remise})` : l.productName,
          unite: brut.unite,
          quantite: brut.quantite,
          prixUnitaireHt: brut.prix,
          tauxTva: '0 %',
          montantHt: l.lineTotalXaf,
        };
      }),
      regimeTva: null,
      mentionExoneration: null,
      totalHt: total,
      tva: 0,
      totalTtc: total,
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

/**
 * Reçu d'un encaissement affecté à une vente. « Reste dû » est le solde de la vente juste après cet
 * encaissement (total net moins les affectations actives des encaissements antérieurs ou égaux),
 * pas le solde du jour de l'impression. Un encaissement qui règle aussi autre chose que cette vente
 * garde son montant reçu, mais son objet reste à écrire à la main.
 */
export function demandeRecuDeVente(
  sale: SaleView,
  paiement: CustomerPaymentData,
  refs: Refs,
): DemandePiece {
  const projection = refs.sales.find((s) => s.id === sale.id);
  const affectations = (projection?.payments ?? []).filter((a) => a.status === 'ACTIVE');
  const ici = affectations.find((a) => a.payment_id === paiement.id);
  const avant = (a: { readonly payment_id: string }) => {
    if (a.payment_id === paiement.id) return true;
    const autre = refs.payments.find((p) => p.id === a.payment_id);
    // Un encaissement absent de l'appareil (plus de 7 jours) est antérieur.
    if (!autre) return true;
    return (
      autre.occurred_at < paiement.occurred_at ||
      (autre.occurred_at === paiement.occurred_at && autre.id < paiement.id)
    );
  };
  const regle = affectations.filter(avant).reduce((t, a) => t + a.amount_xaf, 0);
  const seul = ici !== undefined && ici.amount_xaf === paiement.amount_xaf;
  return demandeRecu(
    paiement,
    refs,
    seul ? { type: 'vente', numero: sale.docNumber } : null,
    projection ? Math.max(0, sale.netTotalXaf - regle) : null,
  );
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
      commercial: nomUtilisateur(refs, projection?.commercial_user_id),
      // Prix convenu par unité de base : ramené à l'unité de la ligne quand il tombe juste.
      lignes: order.lines.map((l) => {
        const p = lignePrix(
          refs,
          {
            productId: l.productId,
            quantity: l.quantity,
            unitCode: l.unitCode,
            unitPriceXaf: l.quotedUnitPriceXaf,
            brutXaf: l.lineTotalXaf,
          },
          // Une commande est estimée sur la quantité de base, même pour un produit au poids.
          false,
        );
        return {
          designation: l.productName,
          unite: p.unite,
          quantite: p.quantite,
          prixConvenu: p.prix,
          montant: l.lineTotalXaf,
        };
      }),
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
