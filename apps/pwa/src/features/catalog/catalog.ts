/**
 * ECR-PRX-01 « Catalogue produits, unités, conditionnements » (administrateur ; en ligne ; D16-CAT) :
 * logique pure des commandes `catalog.*`.
 *
 * - Unité (`catalog.unit.create`) : code majuscule, libellé, unité de comptage ou non.
 * - Catégorie de produit (`catalog.product_category.create`).
 * - Produit (`catalog.product.create`) : famille de stock, unité de base, suivi de lot (aucun pour un
 *   service, BR-CAT-005), espèce exigée pour un produit biologique, drapeaux vendable, achetable,
 *   produit, consommable ; mode de prix. Unité de base et famille immuables ensuite (D16-CAT §14).
 * - Conditionnement (`catalog.product_unit.set`) : facteur vers l'unité de base, immuable (BR-CAT-004) ;
 *   un seul par couple produit, unité.
 * - Motif (`catalog.reason_code.set`) : catégorie, code, libellé, catégorie de perte, commentaire
 *   exigé.
 */

export const STOCK_FAMILIES = [
  'BIOLOGIQUE',
  'PRODUCTION_COMMERCIALISABLE',
  'INTRANT',
  'MARCHANDISE',
  'EMBALLAGE_CONSOMMABLE',
  'SERVICE',
] as const;
export const LOT_TRACKINGS = ['NONE', 'OPTIONAL', 'REQUIRED'] as const;
export const PRICING_MODES = ['PER_UNIT', 'PER_WEIGHT'] as const;
export const SPECIES = ['POULET_CHAIR', 'PONDEUSE', 'PORC'] as const;
export const REASON_CATEGORIES = [
  'LOSS',
  'REJECTION',
  'INVENTORY_ADJUSTMENT',
  'CANCELLATION',
  'PRICE_OVERRIDE',
  'VISIT_OUTCOME',
  'PROSPECT_LOST',
  'CHECKIN_OVERRIDE',
  'PRODUCTION_YIELD',
  'CASH_VARIANCE',
  'TRANSFER_DISCREPANCY',
] as const;
/** Catégories de perte proposées pour un motif `LOSS` (ECR-STK-04, mortalité). */
export const LOSS_CATEGORIES = [
  'CASSE',
  'DETERIORATION',
  'IMPROPRE',
  'DESTRUCTION',
  'INEXPLIQUEE',
  'VOL_SUSPECTE',
  'MORTALITE',
] as const;

const CODE = /^[A-Z0-9_-]+$/;

/** Unité renvoyée par `GET /api/v1/units`. */
export interface UnitView {
  readonly code: string;
  readonly name: string;
  readonly isCount: boolean;
  readonly isActive: boolean;
}

/** Produit renvoyé par `GET /api/v1/products`. */
export interface ProductView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly categoryId: string;
  readonly stockFamily: string;
  readonly baseUnitCode: string;
  readonly lotTracking: string;
  readonly isSellable: boolean;
  readonly isPurchasable: boolean;
  readonly isProducible: boolean;
  readonly isConsumable: boolean;
  readonly pricingMode: string;
  readonly species: string | null;
  readonly status: string;
}

/** Motif renvoyé par `GET /api/v1/reason-codes`. */
export interface ReasonView {
  readonly id: string;
  readonly category: string;
  readonly code: string;
  readonly label: string;
  readonly lossCategory: string | null;
  readonly requiresComment: boolean;
  readonly isActive: boolean;
}

export type CatalogIssue =
  | 'CODE_INVALID'
  | 'CODE_TAKEN'
  | 'NAME_REQUIRED'
  | 'CATEGORY_REQUIRED'
  | 'UNIT_REQUIRED'
  | 'SPECIES_REQUIRED'
  | 'SERVICE_LOT'
  | 'BIO_LOT'
  | 'FACTOR_INVALID'
  | 'FACTOR_NOT_WHOLE'
  | 'PACKAGING_EXISTS';

const normalizedCode = (code: string): string => code.trim().toUpperCase();

export function checkUnit(
  form: { readonly code: string; readonly name: string },
  units: readonly UnitView[],
): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const code = normalizedCode(form.code);
  if (!code || code.length > 20 || !CODE.test(code)) issues.push('CODE_INVALID');
  else if (units.some((unit) => unit.code === code)) issues.push('CODE_TAKEN');
  if (!form.name.trim() || form.name.trim().length > 60) issues.push('NAME_REQUIRED');
  return issues;
}

export function unitPayload(form: {
  readonly code: string;
  readonly name: string;
  readonly isCount: boolean;
}) {
  return { code: normalizedCode(form.code), name: form.name.trim(), isCount: form.isCount };
}

export function checkCategory(
  form: { readonly code: string; readonly name: string },
  existingCodes: readonly string[],
): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const code = normalizedCode(form.code);
  if (!code || code.length > 40 || !CODE.test(code)) issues.push('CODE_INVALID');
  else if (existingCodes.includes(code)) issues.push('CODE_TAKEN');
  if (!form.name.trim()) issues.push('NAME_REQUIRED');
  return issues;
}

export function categoryPayload(form: {
  readonly code: string;
  readonly name: string;
  readonly parentId: string;
}) {
  return {
    code: normalizedCode(form.code),
    name: form.name.trim(),
    ...(form.parentId ? { parentId: form.parentId } : {}),
  };
}

export interface ProductForm {
  readonly code: string;
  readonly name: string;
  readonly categoryId: string;
  readonly stockFamily: (typeof STOCK_FAMILIES)[number];
  readonly baseUnitCode: string;
  readonly lotTracking: (typeof LOT_TRACKINGS)[number];
  readonly expiryTracking: boolean;
  readonly isSellable: boolean;
  readonly isPurchasable: boolean;
  readonly isProducible: boolean;
  readonly isConsumable: boolean;
  readonly pricingMode: (typeof PRICING_MODES)[number];
  readonly species: string;
}

export const EMPTY_PRODUCT: ProductForm = {
  code: '',
  name: '',
  categoryId: '',
  stockFamily: 'MARCHANDISE',
  baseUnitCode: '',
  lotTracking: 'NONE',
  expiryTracking: false,
  isSellable: true,
  isPurchasable: false,
  isProducible: false,
  isConsumable: false,
  pricingMode: 'PER_UNIT',
  species: '',
};

export function checkProduct(form: ProductForm, products: readonly ProductView[]): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const code = normalizedCode(form.code);
  if (!code || code.length > 40 || !CODE.test(code)) issues.push('CODE_INVALID');
  else if (products.some((product) => product.code === code)) issues.push('CODE_TAKEN');
  if (!form.name.trim()) issues.push('NAME_REQUIRED');
  if (!form.categoryId) issues.push('CATEGORY_REQUIRED');
  if (!form.baseUnitCode) issues.push('UNIT_REQUIRED');
  if (form.stockFamily === 'BIOLOGIQUE' && !form.species) issues.push('SPECIES_REQUIRED');
  if (form.stockFamily === 'SERVICE' && form.lotTracking !== 'NONE') issues.push('SERVICE_LOT');
  // Un lot de production ou d'incubation exige un produit biologique suivi par lot (BR-PRD-001) ; le
  // suivi ne se modifie plus après la création.
  if (form.stockFamily === 'BIOLOGIQUE' && form.lotTracking === 'NONE') issues.push('BIO_LOT');
  return issues;
}

export function productPayload(form: ProductForm) {
  return {
    code: normalizedCode(form.code),
    name: form.name.trim(),
    categoryId: form.categoryId,
    stockFamily: form.stockFamily,
    baseUnitCode: form.baseUnitCode,
    lotTracking: form.stockFamily === 'SERVICE' ? 'NONE' : form.lotTracking,
    expiryTracking: form.expiryTracking,
    isSellable: form.isSellable,
    isPurchasable: form.isPurchasable,
    isProducible: form.isProducible,
    isConsumable: form.isConsumable,
    pricingMode: form.pricingMode,
    ...(form.stockFamily === 'BIOLOGIQUE' && form.species ? { species: form.species } : {}),
  };
}

export function checkPackaging(
  form: { readonly productId: string; readonly unitCode: string; readonly factorText: string },
  product: Pick<ProductView, 'baseUnitCode'> | undefined,
  existing: readonly { readonly product_id: string; readonly unit_code: string }[],
  /** L'unité de base est une unité de comptage : le facteur est entier (BR-CAT-003). */
  baseIsCount = false,
): { readonly issues: readonly CatalogIssue[]; readonly factor: number | null } {
  const issues: CatalogIssue[] = [];
  if (!form.unitCode || (product && form.unitCode === product.baseUnitCode)) {
    issues.push('UNIT_REQUIRED');
  }
  const normalized = form.factorText.trim().replace(',', '.');
  // `factor_to_base` est un DECIMAL(14,6) : 8 chiffres avant la virgule au plus.
  const factor = /^\d{1,8}(\.\d{1,6})?$/.test(normalized) ? Number(normalized) : null;
  if (factor === null || factor <= 0) issues.push('FACTOR_INVALID');
  else if (baseIsCount && !Number.isInteger(factor)) issues.push('FACTOR_NOT_WHOLE');
  if (
    existing.some((unit) => unit.product_id === form.productId && unit.unit_code === form.unitCode)
  ) {
    issues.push('PACKAGING_EXISTS');
  }
  return { issues, factor: factor !== null && factor > 0 ? factor : null };
}

interface CodePayload {
  readonly code?: string;
  readonly category?: string;
}

/**
 * Codes des créations du catalogue encore sur l'appareil ou pas encore relues (non refusées) : un
 * second envoi du même code lèverait une violation d'unicité côté base, renvoyée sans fin (S-31).
 */
export function pendingCatalogCodes(
  outbox: readonly {
    readonly command_type: string;
    readonly status: string;
    readonly payload: unknown;
  }[],
): {
  readonly units: readonly string[];
  readonly categories: readonly string[];
  /** Catégories déjà acceptées par le serveur, pas encore tirées par l'appareil. */
  readonly acceptedCategories: readonly string[];
  readonly products: readonly string[];
  readonly reasons: readonly { readonly category: string; readonly code: string }[];
} {
  const live = outbox.filter((command) => command.status !== 'REJECTED');
  const accepted = live.filter(
    (command) => command.status === 'SYNCED' || command.status === 'SYNCED_WITH_WARNING',
  );
  const codes = (type: string) =>
    live
      .filter((command) => command.command_type === type)
      .map((command) => normalizedCode((command.payload as CodePayload).code ?? ''))
      .filter(Boolean);
  return {
    units: codes('catalog.unit.create'),
    categories: codes('catalog.product_category.create'),
    acceptedCategories: accepted
      .filter((command) => command.command_type === 'catalog.product_category.create')
      .map((command) => normalizedCode((command.payload as CodePayload).code ?? ''))
      .filter(Boolean),
    products: codes('catalog.product.create'),
    reasons: live
      .filter((command) => command.command_type === 'catalog.reason_code.set')
      .map((command) => command.payload as CodePayload)
      .filter((payload) => payload.code && payload.category)
      .map((payload) => ({
        category: payload.category as string,
        code: normalizedCode(payload.code as string),
      })),
  };
}

export function checkReason(
  form: { readonly category: string; readonly code: string; readonly label: string },
  reasons: readonly ReasonView[],
): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const code = normalizedCode(form.code);
  if (!code || code.length > 40 || !CODE.test(code)) issues.push('CODE_INVALID');
  else if (reasons.some((reason) => reason.category === form.category && reason.code === code)) {
    issues.push('CODE_TAKEN');
  }
  if (!form.label.trim()) issues.push('NAME_REQUIRED');
  return issues;
}

/**
 * Charge utile de `catalog.reason_code.update` (MP-11, AV-248 : libellé ajustable, commentaire exigé) :
 * les seuls champs changés ; `null` si rien ne change ou si le libellé est vide.
 */
export function reasonUpdatePayload(
  reason: Pick<ReasonView, 'label' | 'requiresComment'>,
  edit: { readonly label: string; readonly requiresComment: boolean },
): { label?: string; requiresComment?: boolean } | null {
  const label = edit.label.trim();
  if (label === '') return null;
  const payload = {
    ...(label !== reason.label ? { label } : {}),
    ...(edit.requiresComment !== reason.requiresComment
      ? { requiresComment: edit.requiresComment }
      : {}),
  };
  return Object.keys(payload).length > 0 ? payload : null;
}

export function reasonPayload(form: {
  readonly category: string;
  readonly code: string;
  readonly label: string;
  readonly lossCategory: string;
  readonly requiresComment: boolean;
}) {
  return {
    category: form.category,
    code: normalizedCode(form.code),
    label: form.label.trim(),
    ...(form.category === 'LOSS' && form.lossCategory ? { lossCategory: form.lossCategory } : {}),
    requiresComment: form.requiresComment,
  };
}
