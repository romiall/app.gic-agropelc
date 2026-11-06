/**
 * ECR-APP-04, réception SANS bon de commande (UC-APP-07 ; BR-APP-011, AV-519) : logique pure.
 *
 * - Fournisseur du référentiel de l'appareil, emplacement physique et actif d'un site de l'appareil, produits
 *   achetables et actifs : le magasinier choisit tout lui-même, aucun bon ne limite la réception.
 * - Par ligne : livré, rejeté (motif `REJECTION` exigé, BR-APP-007), prix unitaire déclaré **exigé** (BR-APP-011 : le
 *   serveur refuse `PRICE_REQUIRED`), lot fournisseur et péremption facultatifs ; l'unité est celle de base du
 *   produit, comme pour une ligne de bon de commande.
 * - Le serveur comptabilise une réception sans bon et la soumet à la revue du responsable des achats
 *   (`POSTED_PENDING_REVIEW`) : l'écran l'annonce, la quantité acceptée entre aussitôt au disponible local.
 * - Le bon de livraison déjà reçu met la réception en quarantaine (BR-APP-012), comme sur un bon de commande.
 */
import {
  DomainError,
  quantityFromDecimal,
  quantityToDecimal,
  receiptLineQuantities,
} from '@gic/domain';
import type { LocationData, ProductData, SupplierData } from '../sales/types.js';
import { parseQty } from './receipt.js';
import { parsePrice } from './request.js';

/** Fournisseurs du référentiel de l'appareil, par nom. */
export function freeReceiptSuppliers(suppliers: ReadonlyMap<string, SupplierData>): SupplierData[] {
  return [...suppliers.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/**
 * Emplacements physiques et actifs des sites de l'utilisateur (`siteIds`, déduits de ses affectations : AV-519 (1)),
 * par nom : le magasinier choisit, rien n'est proposé d'office. Un emplacement d'un autre site serait refusé par le
 * serveur (`FORBIDDEN_SCOPE`), y compris pour un fait saisi hors ligne : la réception serait perdue. `siteIds`
 * absent : aucun filtre par site (essais).
 */
export function freeReceiptLocations(
  locations: readonly LocationData[],
  siteIds?: ReadonlySet<string>,
): LocationData[] {
  return locations
    .filter(
      (location) =>
        !location.is_virtual &&
        location.status === 'ACTIVE' &&
        location.site_id !== null &&
        (siteIds === undefined || siteIds.has(location.site_id)),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

export interface FreeLineDraft {
  /** Identifiant local de la ligne (clé de liste, jamais envoyé). */
  readonly key: string;
  readonly productId: string;
  readonly deliveredText: string;
  readonly rejectedText: string;
  readonly reasonId: string;
  readonly unitCostText: string;
  readonly lotRef: string;
  readonly expiryDate: string;
}

export const emptyFreeLine = (key: string): FreeLineDraft => ({
  key,
  productId: '',
  deliveredText: '',
  rejectedText: '',
  reasonId: '',
  unitCostText: '',
  lotRef: '',
  expiryDate: '',
});

export type FreeLineIssue =
  | 'PRODUCT_REQUIRED'
  | 'QUANTITY_INVALID'
  | 'REJECTED_OVER_DELIVERED'
  | 'REASON_REQUIRED'
  | 'COST_INVALID'
  | 'EXPIRY_INVALID';

export interface FreeLineCheck {
  /** `null` : ligne laissée vide, non envoyée. */
  readonly delivered: number | null;
  readonly rejected: number;
  readonly accepted: number;
  /** Prix unitaire déclaré (XAF par unité de base) ; `null` tant qu'il est vide ou invalide. */
  readonly unitCostXaf: number | null;
  readonly issues: readonly FreeLineIssue[];
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Prix unitaire déclaré le plus haut accepté (francs par unité de base) : au-delà, c'est une faute de frappe. */
export const MAX_UNIT_COST_XAF = 1_000_000_000;

/** Une ligne sans produit, sans quantité ni prix n'est pas une ligne : elle n'est pas envoyée et ne bloque rien. */
const isBlank = (draft: FreeLineDraft): boolean =>
  draft.productId === '' &&
  draft.deliveredText.trim() === '' &&
  draft.rejectedText.trim() === '' &&
  draft.unitCostText.trim() === '';

export function checkFreeLine(draft: FreeLineDraft): FreeLineCheck {
  const none: FreeLineCheck = {
    delivered: null,
    rejected: 0,
    accepted: 0,
    unitCostXaf: null,
    issues: [],
  };
  if (isBlank(draft)) return none;
  const issues: FreeLineIssue[] = [];
  if (draft.productId === '') issues.push('PRODUCT_REQUIRED');
  // Produit choisi sans quantité livrée : ligne pas encore livrée, non envoyée (comme sur un bon de commande).
  if (draft.deliveredText.trim() === '') {
    return draft.productId === '' ? { ...none, issues } : none;
  }
  const delivered = parseQty(draft.deliveredText);
  const rejected = draft.rejectedText.trim() === '' ? 0 : parseQty(draft.rejectedText);
  if (delivered === null || delivered <= 0 || rejected === null) {
    return { ...none, issues: [...issues, 'QUANTITY_INVALID'] };
  }
  let accepted = 0;
  try {
    accepted = quantityToDecimal(
      receiptLineQuantities({
        delivered: quantityFromDecimal(delivered),
        rejected: quantityFromDecimal(rejected),
      }).accepted,
    );
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    issues.push('REJECTED_OVER_DELIVERED');
  }
  if (rejected > 0 && !draft.reasonId) issues.push('REASON_REQUIRED');
  const parsedCost = parsePrice(draft.unitCostText);
  // BR-APP-011 : le prix déclaré est exigé (vide, invalide ou démesuré : refusé).
  const cost =
    typeof parsedCost === 'number' && parsedCost <= MAX_UNIT_COST_XAF ? parsedCost : null;
  if (cost === null) issues.push('COST_INVALID');
  if (draft.expiryDate && !DATE_ONLY.test(draft.expiryDate)) issues.push('EXPIRY_INVALID');
  return { delivered, rejected, accepted, unitCostXaf: cost, issues };
}

const optionalText = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

/** Charge utile de `procurement.receipt.record` sans bon de commande (sans `localRef`). */
export function freeReceiptPayload(input: {
  readonly supplierId: string;
  readonly locationId: string;
  readonly deliveryNoteRef: string;
  readonly observations: string;
  readonly lines: readonly {
    readonly product: Pick<ProductData, 'id' | 'base_unit_code'>;
    readonly draft: FreeLineDraft;
    readonly check: FreeLineCheck;
  }[];
}) {
  const deliveryNote = optionalText(input.deliveryNoteRef);
  const observations = optionalText(input.observations);
  return {
    supplierId: input.supplierId,
    locationId: input.locationId,
    ...(deliveryNote ? { supplierDeliveryNoteRef: deliveryNote } : {}),
    ...(observations ? { observations } : {}),
    lines: input.lines
      .filter(({ check }) => check.delivered !== null)
      .map(({ product, draft, check }) => {
        const lotRef = optionalText(draft.lotRef);
        return {
          productId: product.id,
          unitCode: product.base_unit_code,
          qtyDeliveredBase: check.delivered as number,
          ...(check.rejected > 0
            ? { qtyRejectedBase: check.rejected, rejectionReasonCodeId: draft.reasonId }
            : {}),
          unitCostXaf: check.unitCostXaf as number,
          ...(lotRef ? { supplierLotRef: lotRef } : {}),
          ...(draft.expiryDate ? { expiryDate: draft.expiryDate } : {}),
        };
      }),
  };
}
