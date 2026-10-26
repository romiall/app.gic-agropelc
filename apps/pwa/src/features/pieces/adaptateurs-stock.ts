/**
 * Données des pièces de stock et de production : bon de transfert (BT), fiche d'inventaire (FI),
 * fiche de perte ou de consommation (FP), suivi de lot de production (FL, une semaine). Quantités
 * du serveur en unité de base du produit. Fonctions pures, sur les données déjà lues par l'écran.
 */
import { businessDayOf } from '@gic/domain';
import type { SalesReferences } from '../sales/references.js';
import type { InventoryCountData, ProductionLotData, StockTransferData } from '../sales/types.js';
import { formatQuantity, unitLabel } from '../sales/format.js';
import type { DemandePiece } from './demande.js';
import { nomUtilisateur, numeroImprime } from './adaptateurs-ventes.js';
import { dateHeurePiece, jourPiece } from './format.js';
import { JOURS_SEMAINE, NATURES_BT, type JourLot } from './pieces-operations.js';

type Refs = Pick<
  SalesReferences,
  | 'users'
  | 'sites'
  | 'locations'
  | 'products'
  | 'units'
  | 'reasonCodes'
  | 'productionLots'
  | 'lotLosses'
  | 'lotConsumptions'
  | 'lotWeighings'
  | 'lotObservations'
  | 'eggCollections'
>;

const nombre = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const q = (v: number | null) => (v === null ? null : formatQuantity(v));
const produit = (refs: Refs, id: string) => refs.products.find((p) => p.id === id);
const unite = (refs: Refs, productId: string, qte: number | null) =>
  unitLabel(produit(refs, productId)?.base_unit_code ?? '', qte ?? 1, refs.units);
function emplacement(refs: Refs, id: string | null | undefined): string | null {
  if (!id) return null;
  const l = refs.locations.find((x) => x.id === id);
  if (!l) return null;
  const site = l.site_id ? refs.sites.get(l.site_id)?.name : undefined;
  return site && site !== l.name ? `${site} — ${l.name}` : l.name;
}

export function demandeBonTransfert(tr: StockTransferData, refs: Refs): DemandePiece {
  const versPdv = refs.locations.find((l) => l.id === tr.to_location_id)?.location_type === 'PDV';
  const recu = tr.lines.some((l) => l.received_qty_base !== null);
  const ecarts = tr.lines.map((l) => {
    const ex = nombre(l.dispatched_qty_base);
    const re = nombre(l.received_qty_base);
    return ex !== null && re !== null ? re - ex : null;
  });
  return {
    code: 'BT',
    donnees: {
      numero: numeroImprime(tr.doc_number),
      nature: versPdv ? NATURES_BT[1] : null,
      origine: emplacement(refs, tr.from_location_id),
      destination: emplacement(refs, tr.to_location_id),
      expedieLe: dateHeurePiece(tr.dispatched_at),
      expediteur: null,
      transporteur: tr.carrier_name,
      lignes: tr.lines.map((l, i) => {
        const ex = nombre(l.dispatched_qty_base ?? l.requested_qty_base);
        const ecart = ecarts[i] ?? null;
        return {
          produit: produit(refs, l.product_id)?.name ?? l.product_id,
          lot: null,
          unite: unite(refs, l.product_id, ex),
          expediee: q(nombre(l.dispatched_qty_base)),
          recue: q(nombre(l.received_qty_base)),
          ecart:
            ecart === null ? null : ecart > 0 ? `+${q(ecart)}` : ecart < 0 ? `−${q(-ecart)}` : '0',
          motifEcart: null,
        };
      }),
      recuLe: null,
      receptionnaire: null,
      constat: recu
        ? ecarts.some((e) => e !== null && e !== 0)
          ? 'écart à justifier'
          : 'conforme'
        : null,
      observations: tr.notes,
    },
  };
}

const TYPES_INVENTAIRE: Readonly<
  Record<string, 'périodique' | 'd’ouverture' | 'tournant / surprise'>
> = {
  FULL: 'périodique',
  PARTIAL: 'tournant / surprise',
  SPOT: 'tournant / surprise',
  OPENING: 'd’ouverture',
};

export function demandeFicheInventaire(
  inv: InventoryCountData,
  refs: Refs,
  compteurId: string | null,
): DemandePiece {
  return {
    code: 'FI',
    donnees: {
      numero: numeroImprime(inv.doc_number),
      emplacement: emplacement(refs, inv.location_id),
      dateHeure: dateHeurePiece(inv.occurred_at),
      compteur1: nomUtilisateur(refs, compteurId),
      compteur2: null,
      type: TYPES_INVENTAIRE[inv.count_type] ?? null,
      lignes: inv.lines.map((l) => {
        const compte = nombre(l.counted_qty_base);
        const ecart = nombre(l.variance_qty_base);
        const motif = l.variance_reason_code_id
          ? (refs.reasonCodes.find((r) => r.id === l.variance_reason_code_id)?.label ?? null)
          : null;
        return {
          produit: produit(refs, l.product_id)?.name ?? l.product_id,
          lot: null,
          unite: unite(refs, l.product_id, compte),
          theorique: q(nombre(l.theoretical_qty_base)),
          physique: q(compte),
          ecart:
            ecart === null ? null : ecart > 0 ? `+${q(ecart)}` : ecart < 0 ? `−${q(-ecart)}` : '0',
          motif: [motif, l.comment].filter(Boolean).join(' — ') || null,
        };
      }),
      responsable: null,
    },
  };
}

const CATEGORIES_PERTE: Readonly<Record<string, string>> = {
  MORTALITE: 'mortalité',
  CASSE: 'casse',
  DETERIORATION: 'détérioration',
  IMPROPRE: 'impropre à la vente',
  DESTRUCTION: 'destruction',
  INEXPLIQUEE: 'inexpliquée',
  VOL_SUSPECTE: 'vol suspecté',
  ECART_TRANSFERT: 'écart de transfert',
};

/** Déclaration de perte saisie sur l'appareil (charge utile de `inventory.loss.declare`). */
export interface PerteSaisie {
  readonly numero: string | null;
  readonly occurredAt: string;
  readonly declarantId: string | null;
  readonly locationId: string;
  readonly productId: string;
  readonly unitCode: string;
  readonly quantity: number;
  readonly category: string;
  readonly reasonCodeId?: string;
  readonly comment?: string;
  readonly lot?: string | null;
}

export function demandeFichePerte(p: PerteSaisie, refs: Refs): DemandePiece {
  const motif = p.reasonCodeId
    ? refs.reasonCodes.find((r) => r.id === p.reasonCodeId)?.label
    : undefined;
  return {
    code: 'FP',
    donnees: {
      numero: numeroImprime(p.numero),
      nature: 'perte',
      emplacement: emplacement(refs, p.locationId),
      declarant: nomUtilisateur(refs, p.declarantId),
      dateHeure: dateHeurePiece(p.occurredAt),
      categorie: CATEGORIES_PERTE[p.category] ?? p.category,
      lignes: [
        {
          produit: produit(refs, p.productId)?.name ?? p.productId,
          unite: unitLabel(p.unitCode, p.quantity, refs.units),
          quantite: q(p.quantity),
          lot: p.lot ?? null,
        },
      ],
      cause: [motif, p.comment].filter(Boolean).join(' — ') || null,
      imputeA: null,
      responsable: null,
      photo: null,
    },
  };
}

const TYPES_LOT: Readonly<
  Record<string, 'poulet de chair' | 'pondeuse' | 'porc d’engraissement' | 'autre'>
> = {
  POULET_CHAIR: 'poulet de chair',
  PONDEUSE: 'pondeuse',
  PORC_ENGRAISSEMENT: 'porc d’engraissement',
};

/** Lundi (jour métier `AAAA-MM-JJ`) de la semaine qui contient `jour`. */
export function lundiDe(jour: string): string {
  const d = new Date(`${jour}T12:00:00Z`);
  const decalage = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - decalage);
  return d.toISOString().slice(0, 10);
}

function plusJours(jour: string, n: number): string {
  const d = new Date(`${jour}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Suivi d'un lot pour une semaine (lundi à dimanche) : une ligne par jour, reprise des saisies du
 * jour servies à l'appareil (30 jours). Une saisie annulée n'est pas reprise.
 */
export function demandeSuiviLot(lot: ProductionLotData, lundi: string, refs: Refs): DemandePiece {
  const jours = JOURS_SEMAINE.map((_, i) => plusJours(lundi, i));
  const duLot = <T extends { production_lot_id: string; status?: string; occurred_at: string }>(
    xs: readonly T[],
  ) => xs.filter((x) => x.production_lot_id === lot.id && x.status !== 'CANCELLED');
  const jourDe = (iso: string) => businessDayOf(new Date(iso));
  const somme = (xs: readonly (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
  const pertes = duLot(refs.lotLosses).filter((l) => l.category === 'MORTALITE');
  const conso = duLot(refs.lotConsumptions);
  const pesees = duLot(refs.lotWeighings);
  const obs = refs.lotObservations.filter((o) => o.production_lot_id === lot.id);
  const oeufs = duLot(refs.eggCollections);

  const lignes: JourLot[] = jours.map((jour, i) => {
    const m = pertes.filter((l) => jourDe(l.occurred_at) === jour);
    const a = conso.filter((c) => jourDe(c.occurred_at) === jour);
    const p = pesees.filter((w) => jourDe(w.occurred_at) === jour).at(-1);
    const o = oeufs.filter((e) => (e.collection_date ?? jourDe(e.occurred_at)) === jour);
    const ob = obs.filter((x) => jourDe(x.occurred_at) === jour);
    const n = (v: number) => (v ? q(v) : null);
    const causes = m
      .map((l) =>
        l.reason_code_id
          ? refs.reasonCodes.find((r) => r.id === l.reason_code_id)?.label
          : l.comment,
      )
      .filter(Boolean);
    return {
      jour: JOURS_SEMAINE[i]!,
      date: jourPiece(jour),
      mortaliteNombre: n(somme(m.map((l) => l.quantity_base))),
      mortaliteCause: [...new Set(causes)].join(', ') || null,
      alimentProduit:
        [...new Set(a.map((c) => produit(refs, c.product_id)?.name ?? ''))]
          .filter(Boolean)
          .join(', ') || null,
      alimentKg: n(somme(a.map((c) => (c.unit_code === 'KG' ? c.quantity : c.quantity_base)))),
      peseeEchantillon: p ? q(p.sample_size) : null,
      peseePoidsMoyenG: p ? q(p.avg_weight_g) : null,
      oeufsCollectes: n(somme(o.map((e) => e.collected_qty))),
      oeufsCasses: n(somme(o.map((e) => e.broken_qty))),
      oeufsNonConformes: n(somme(o.map((e) => e.nonconforming_qty))),
      oeufsCommercialisables: n(somme(o.map((e) => e.marketable_qty))),
      oeufsACouver: n(somme(o.map((e) => e.hatching_qty))),
      observations: ob.map((x) => x.text).join(' ; ') || null,
    };
  });
  const total = (k: keyof JourLot) => {
    const v = somme(
      lignes.map((l) => nombre((l[k] ?? '').toString().replace(/\s/g, '').replace(',', '.'))),
    );
    return v ? q(v) : null;
  };
  const lieu = emplacement(refs, lot.main_location_id);
  return {
    code: 'FL',
    donnees: {
      numero: null,
      lot: lot.lot_code,
      typeLot: TYPES_LOT[lot.lot_type] ?? 'autre',
      batiment: lieu,
      semaineDu: jourPiece(lundi),
      au: jourPiece(jours[6]),
      effectifDebut: null,
      jours: lignes,
      totaux: [
        total('mortaliteNombre'),
        null,
        null,
        total('alimentKg'),
        null,
        null,
        total('oeufsCollectes'),
        total('oeufsCasses'),
        total('oeufsNonConformes'),
        total('oeufsCommercialisables'),
        total('oeufsACouver'),
        null,
        null,
      ],
      evenements: null,
    },
  };
}
