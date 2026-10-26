/**
 * Données des pièces d'achat : demande d'achat (DA), bon de commande fournisseur (BC), bon de
 * réception (BR). Les quantités du serveur sont en unité de base du produit : la pièce les écrit
 * dans cette unité. Fonctions pures, sur les données déjà lues par l'écran.
 */
import type { SalesReferences } from '../sales/references.js';
import type { GoodsReceiptData, PurchaseRequestData } from '../sales/types.js';
import type { OrderView as PurchaseOrderView } from '../procurement/orders.js';
import { formatQuantity, unitLabel } from '../sales/format.js';
import type { DemandePiece } from './demande.js';
import { nomUtilisateur, numeroImprime } from './adaptateurs-ventes.js';
import { dateHeurePiece, datePiece, jourPiece } from './format.js';

type Refs = Pick<
  SalesReferences,
  | 'users'
  | 'sites'
  | 'locations'
  | 'products'
  | 'units'
  | 'suppliers'
  | 'purchaseRequests'
  | 'purchaseOrders'
  | 'productionLots'
>;

const produit = (refs: Refs, id: string) => refs.products.find((p) => p.id === id);
const nombre = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const q = (v: number | null) => (v === null ? null : formatQuantity(v));

const DECISIONS: Readonly<Record<string, 'approuvée' | 'rejetée' | 'à compléter'>> = {
  APPROVED: 'approuvée',
  PARTIALLY_ORDERED: 'approuvée',
  ORDERED: 'approuvée',
  CLOSED: 'approuvée',
  REJECTED: 'rejetée',
};

export function demandeDemandeAchat(da: PurchaseRequestData, refs: Refs): DemandePiece {
  return {
    code: 'DA',
    donnees: {
      numero: numeroImprime(da.doc_number),
      site: refs.sites.get(da.site_id)?.name ?? null,
      demandeur: nomUtilisateur(refs, da.requested_by),
      date: datePiece(da.occurred_at),
      besoinLe: jourPiece(da.needed_by_date),
      lotOuBudget: null,
      justification: da.justification,
      lignes: da.lines.map((l) => {
        const p = produit(refs, l.product_id);
        const qte = nombre(l.quantity);
        return {
          designation: p?.name ?? l.product_id,
          unite: unitLabel(l.unit_code, qte ?? 1, refs.units),
          quantite: q(qte),
          prixEstime: null,
          montantEstime: null,
          observations: null,
        };
      }),
      totalEstime: da.estimated_total_xaf,
      decision: DECISIONS[da.status] ?? null,
      motifDecision: null,
      bonDeCommande: null,
      decideur: null,
    },
  };
}

export function demandeBonCommandeFournisseur(
  bc: PurchaseOrderView,
  refs: Refs,
  fournisseur: string | null,
): DemandePiece {
  const lignesDA = new Map(
    refs.purchaseRequests.flatMap((da) => da.lines.map((l) => [l.id, da.doc_number] as const)),
  );
  const demandes = [
    ...new Set(bc.lines.map((l) => (l.requestLineId ? lignesDA.get(l.requestLineId) : undefined))),
  ].filter((d): d is string => !!d);
  const lieu = refs.locations.find((l) => l.id === bc.deliveryLocationId);
  const site = refs.sites.get(bc.siteId)?.name;
  return {
    code: 'BC',
    donnees: {
      numero: numeroImprime(bc.docNumber),
      fournisseur,
      niuFournisseur: null,
      adresse: null,
      telephone: null,
      date: datePiece(bc.sentAt ?? bc.occurredAt),
      livraisonAttendue: jourPiece(bc.expectedDeliveryDate),
      demandeAchat: demandes.join(', ') || null,
      lieuLivraison: [site, lieu?.name].filter(Boolean).join(' — ') || null,
      etabliPar: null,
      lignes: bc.lines
        .filter((l) => l.status !== 'CANCELLED')
        .map((l) => {
          const p = produit(refs, l.productId);
          return {
            designation: p?.name ?? l.productId,
            unite: unitLabel(p?.base_unit_code ?? l.unitCode, l.orderedQtyBase, refs.units),
            quantite: q(l.orderedQtyBase),
            prixUnitaire: l.unitPriceXaf,
            montant: l.lineTotalXaf,
          };
        }),
      total: bc.totalXaf,
      prix: null,
      paiement: null,
      approuvePar: null,
    },
  };
}

export function demandeBonReception(
  br: GoodsReceiptData,
  refs: Refs,
  receptionnaireId: string | null,
): DemandePiece {
  const bc = br.purchase_order_id
    ? refs.purchaseOrders.find((o) => o.id === br.purchase_order_id)
    : undefined;
  const commandees = new Map(bc?.lines.map((l) => [l.id, nombre(l.ordered_qty_base)]) ?? []);
  const lieu = refs.locations.find((l) => l.id === br.location_id);
  const site = lieu?.site_id ? refs.sites.get(lieu.site_id)?.name : undefined;
  const rejets = br.lines.some((l) => (nombre(l.qty_rejected_base) ?? 0) > 0);
  const toutRejete =
    br.lines.length > 0 && br.lines.every((l) => (nombre(l.qty_accepted_base) ?? 0) === 0);
  return {
    code: 'BR',
    donnees: {
      numero: numeroImprime(br.doc_number),
      fournisseur: refs.suppliers.get(br.supplier_id)?.name ?? null,
      bonDeCommande: br.purchase_order_id ? (bc?.doc_number ?? null) : 'sans BC',
      bonLivraisonFournisseur: br.supplier_delivery_note_ref,
      transporteur: null,
      emplacement: [site, lieu?.name].filter(Boolean).join(' — ') || null,
      dateHeure: dateHeurePiece(br.occurred_at),
      receptionnaire: nomUtilisateur(refs, receptionnaireId),
      lignes: br.lines.map((l) => {
        const p = produit(refs, l.product_id);
        return {
          produit: p?.name ?? l.product_id,
          unite: unitLabel(p?.base_unit_code ?? '', nombre(l.qty_delivered_base) ?? 1, refs.units),
          commande: q(l.po_line_id ? (commandees.get(l.po_line_id) ?? null) : null),
          livre: q(nombre(l.qty_delivered_base)),
          rejete: q(nombre(l.qty_rejected_base)),
          accepte: q(nombre(l.qty_accepted_base)),
          motifRejet: null,
          lotFournisseur: null,
          peremption: null,
        };
      }),
      constat:
        br.lines.length === 0
          ? null
          : toutRejete
            ? 'refus total'
            : rejets
              ? 'réserves (voir observations)'
              : 'conforme',
      photo: null,
      observations: null,
    },
  };
}
