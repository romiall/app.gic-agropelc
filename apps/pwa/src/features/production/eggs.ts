/**
 * Collecte d'œufs (ECR-PRD-02 ; BR-OEU-001 à 003, INV-OEU-01, AV-046) : logique pure.
 *
 * - Lots de pondeuses ou de reproducteurs seulement (`LOT_NOT_LAYING`).
 * - Bilan : collectés = cassés + non conformes + commercialisables par calibre + à couver
 *   (`eggCollectionBalance`, même calcul que le serveur).
 * - Calibres : produits actifs et non biologiques de `production.egg_grade_product_codes`, hors produit
 *   des œufs à couver ; tant que le paramètre n'est pas servi, les produits commercialisables (le
 *   serveur refuse en ligne un calibre non paramétré, `EGG_GRADE_INVALID`).
 * - Œufs à couver : produit actif et non biologique de `production.hatching_egg_product_code`, exigé
 *   dès qu'il y en a, même hors ligne (`HATCHING_PRODUCT_MISSING`).
 * - Paramètres lus en portée globale, comme le serveur (une valeur de site n'est pas lue).
 * - Seuls les commercialisables et les œufs à couver entrent en stock (BR-OEU-002).
 */
import { DomainError, eggCollectionBalance } from '@gic/domain';
import type { ProductData, SettingData } from '../sales/types.js';
import { settingValue } from '../sales/stock.js';

export interface EggDraft {
  readonly collected: string;
  readonly broken: string;
  readonly nonconforming: string;
  readonly hatching: string;
  readonly grades: Readonly<Record<string, string>>;
}

export const EMPTY_EGGS: EggDraft = {
  collected: '',
  broken: '',
  nonconforming: '',
  hatching: '',
  grades: {},
};

const count = (text: string): number | null => {
  const normalized = text.trim().replace(/\s/g, '');
  if (normalized === '') return 0;
  return /^\d+$/.test(normalized) ? Number(normalized) : null;
};

export interface EggSetup {
  /** Produits des calibres commercialisables. */
  readonly grades: readonly ProductData[];
  /** Les calibres viennent du paramètre (sinon : déduits, le serveur peut refuser en ligne). */
  readonly gradesConfigured: boolean;
  readonly hatchingProduct: ProductData | undefined;
}

export function eggSetup(
  products: readonly ProductData[],
  settings: readonly SettingData[],
  now: Date,
): EggSetup {
  // Le serveur lit ces deux clés en portée globale seulement : une valeur de site n'est pas lue.
  const usable = (product: ProductData | undefined): product is ProductData =>
    product !== undefined && product.status === 'ACTIVE' && product.stock_family !== 'BIOLOGIQUE';
  const codes = settingValue(settings, 'production.egg_grade_product_codes', null, now);
  const list = Array.isArray(codes) ? codes.map(String) : [];
  const byCode = new Map(products.map((product) => [product.code, product]));
  const hatchingCode = settingValue(settings, 'production.hatching_egg_product_code', null, now);
  const hatchingCandidate =
    typeof hatchingCode === 'string' && hatchingCode.trim()
      ? byCode.get(hatchingCode.trim())
      : undefined;
  const hatchingProduct = usable(hatchingCandidate) ? hatchingCandidate : undefined;
  const configured = list
    .map((code) => byCode.get(code))
    .filter(usable)
    .filter((product) => product.id !== hatchingProduct?.id);
  if (configured.length > 0) {
    return { grades: configured, gradesConfigured: true, hatchingProduct };
  }
  return {
    grades: products
      .filter(
        (product) =>
          product.stock_family === 'PRODUCTION_COMMERCIALISABLE' &&
          product.status === 'ACTIVE' &&
          product.id !== hatchingProduct?.id,
      )
      .sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    gradesConfigured: false,
    hatchingProduct,
  };
}

export type EggIssue = 'COUNT_INVALID' | 'BALANCE' | 'HATCHING_PRODUCT_MISSING' | 'NOTHING';

export interface EggCheck {
  readonly issues: readonly EggIssue[];
  /** Message du domaine pour un bilan faux. */
  readonly balanceMessage: string | null;
  readonly values: {
    readonly collected: number;
    readonly broken: number;
    readonly nonconforming: number;
    readonly hatching: number;
    readonly grades: readonly { readonly productId: string; readonly quantity: number }[];
  } | null;
  /** Écart restant à répartir (collectés − somme des autres), pour aider la saisie. */
  readonly remaining: number | null;
}

export function checkEggs(draft: EggDraft, setup: EggSetup): EggCheck {
  const collected = count(draft.collected);
  const broken = count(draft.broken);
  const nonconforming = count(draft.nonconforming);
  const hatching = count(draft.hatching);
  const grades = setup.grades.map((product) => ({
    productId: product.id,
    quantity: count(draft.grades[product.id] ?? ''),
  }));
  if (
    collected === null ||
    broken === null ||
    nonconforming === null ||
    hatching === null ||
    grades.some((grade) => grade.quantity === null)
  ) {
    return { issues: ['COUNT_INVALID'], balanceMessage: null, values: null, remaining: null };
  }
  const lines = grades
    .filter((grade) => (grade.quantity ?? 0) > 0)
    .map((grade) => ({ productId: grade.productId, quantity: grade.quantity as number }));
  const issues: EggIssue[] = [];
  if (collected === 0) issues.push('NOTHING');
  if (hatching > 0 && !setup.hatchingProduct) issues.push('HATCHING_PRODUCT_MISSING');
  let balanceMessage: string | null = null;
  try {
    eggCollectionBalance({
      collected,
      broken,
      nonconforming,
      hatching,
      marketableByGrade: lines.map((line) => ({ grade: line.productId, quantity: line.quantity })),
    });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    issues.push('BALANCE');
    balanceMessage = error.message;
  }
  const marketable = lines.reduce((sum, line) => sum + line.quantity, 0);
  return {
    issues,
    balanceMessage,
    values: { collected, broken, nonconforming, hatching, grades: lines },
    remaining: collected - broken - nonconforming - hatching - marketable,
  };
}

export function eggCollectionPayload(input: {
  readonly lotId: string;
  readonly collectionDate: string;
  readonly storageLocationId: string;
  readonly values: NonNullable<EggCheck['values']>;
}) {
  return {
    productionLotId: input.lotId,
    collectionDate: input.collectionDate,
    storageLocationId: input.storageLocationId,
    collected: input.values.collected,
    broken: input.values.broken,
    nonconforming: input.values.nonconforming,
    hatching: input.values.hatching,
    grades: input.values.grades.map((grade) => ({
      productId: grade.productId,
      quantity: grade.quantity,
    })),
  };
}
