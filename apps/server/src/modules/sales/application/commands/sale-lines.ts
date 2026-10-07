/**
 * Résolution des lignes d'une vente ou d'une commande (D04 §8 ; BR-VEN-013, BR-VEN-030, BR-VEN-031) :
 * produit vendable, unité de vente et conversion en unité de base (recontrôlée), quantité entière
 * pour une unité comptée, quantité de tarification (poids pour un produit au poids) et prix de la
 * ligne (`sale-pricing.ts`). Mêmes règles pour la vente directe et pour la commande : un seul code.
 *
 * Hors ligne, un produit désactivé reste vendable (fait accompli, BR-VEN-030) : la ligne porte
 * l'indicateur et l'appelant ouvre l'anomalie.
 */
import {
  convertToBaseQuantity,
  isWholeQuantity,
  pricingQuantity,
  quantityFromDecimal,
  quantityMilliUnits,
  type IdGenerator,
  type PricingMode,
  type Quantity,
} from '@gic/domain';
import type { CommandHandlerOutcome } from '../../../../platform/sync/command-handler-registry.js';
import {
  findProduct,
  findProductUnit,
  findUnit,
} from '../../../catalog/application/public/index.js';
import { priceLine, type PricedLine, type PricingContext } from './sale-pricing.js';
import type { SaleLineInput } from './sale-payload.js';
import { rejected, type Uow } from './shared.js';

/** Unité de tarification d'un produit vendu au poids (kg ; AV-031). */
export const WEIGHT_UNIT_CODE = 'KG';

export interface ResolvedLine {
  readonly id: string;
  readonly lineNo: number;
  readonly input: SaleLineInput;
  readonly productId: string;
  readonly productName: string;
  readonly isService: boolean;
  readonly productInactive: boolean;
  readonly pricingMode: PricingMode;
  readonly quantityBase: Quantity;
  readonly pricingQuantity: Quantity;
  readonly pricingUnitCode: string;
  readonly priced: PricedLine;
}

export type ResolveLinesResult =
  | { readonly ok: true; readonly lines: readonly ResolvedLine[] }
  | { readonly ok: false; readonly outcome: CommandHandlerOutcome };

type CatalogProduct = NonNullable<Awaited<ReturnType<typeof findProduct>>>;

export type CheckedQuantity =
  | {
      readonly ok: true;
      readonly product: CatalogProduct;
      /** Produit actif et vendable : sinon vendable seulement hors ligne (BR-VEN-030). */
      readonly sellable: boolean;
      readonly declaredBase: Quantity;
    }
  | { readonly ok: false; readonly outcome: CommandHandlerOutcome };

/**
 * Contrôles d'une quantité de ligne, communs aux ventes, aux commandes et à l'ajustement d'une ligne
 * de commande : produit connu et vendable, unité de vente, quantité en unité de base recontrôlée
 * (écart d'un millième toléré), entière pour une unité comptée.
 */
export async function checkLineQuantity(
  uow: Uow,
  input: {
    readonly productId: string;
    readonly unitCode: string;
    readonly quantity: number;
    readonly quantityBase: number;
    readonly offline: boolean;
    /** `false` : une ligne existante dont on ne fait que baisser la quantité peut viser un produit retiré. */
    readonly requireSellable?: boolean;
  },
): Promise<CheckedQuantity> {
  const product = await findProduct(uow, input.productId);
  if (!product) return { ok: false, outcome: rejected('PRODUCT_UNKNOWN', 'Produit inconnu.') };
  const sellable = product.status === 'ACTIVE' && product.isSellable;
  if (!sellable && !input.offline && input.requireSellable !== false) {
    return {
      ok: false,
      outcome: rejected('PRODUCT_NOT_SELLABLE', `Produit non vendable : ${product.name}.`),
    };
  }
  const unit = await findProductUnit(uow, product.id, input.unitCode);
  if (!unit || (!input.offline && !(unit.isActive && unit.isSalesUnit))) {
    return {
      ok: false,
      outcome: rejected('UNIT_INVALID', `Unité de vente invalide pour ${product.name}.`),
    };
  }
  const declaredBase = quantityFromDecimal(input.quantityBase);
  const computedBase = convertToBaseQuantity(
    quantityFromDecimal(input.quantity),
    unit.factorToBase,
  );
  if (Math.abs(quantityMilliUnits(declaredBase) - quantityMilliUnits(computedBase)) > 1) {
    return {
      ok: false,
      outcome: rejected(
        'QUANTITY_BASE_MISMATCH',
        `Quantité en unité de base incohérente avec ${input.unitCode} pour ${product.name}.`,
      ),
    };
  }
  const baseUnit = await findUnit(uow, product.baseUnitCode);
  if (baseUnit?.isCount && !isWholeQuantity(declaredBase)) {
    return {
      ok: false,
      outcome: rejected('LINE_INVALID', `Quantité entière attendue pour ${product.name}.`),
    };
  }
  return { ok: true, product, sellable, declaredBase };
}

export async function resolveSaleLines(
  uow: Uow,
  idGenerator: IdGenerator,
  input: {
    readonly lines: readonly SaleLineInput[];
    readonly offline: boolean;
    readonly pricing: PricingContext;
    readonly maxDiscountPct: number | null;
    /** Anomalies de vente (drapeaux) : `PRICE_MISMATCH`, `PRODUCT_INACTIVE`. */
    readonly flags: Set<string>;
    /** Numéro de la première ligne (une commande peut recevoir des lignes en plus). */
    readonly firstLineNo?: number;
  },
): Promise<ResolveLinesResult> {
  const lines: ResolvedLine[] = [];
  for (const [index, line] of input.lines.entries()) {
    const checked = await checkLineQuantity(uow, {
      productId: line.productId,
      unitCode: line.unitCode,
      quantity: line.quantity,
      quantityBase: line.quantityBase,
      offline: input.offline,
    });
    if (!checked.ok) return checked;
    const { product, sellable, declaredBase } = checked;
    const pricingMode = product.pricingMode as PricingMode;
    const weight = line.weightKg === undefined ? null : quantityFromDecimal(line.weightKg);
    const priced = pricingQuantity({
      pricingMode,
      quantityBase: declaredBase,
      ...(weight !== null ? { weightKg: weight } : {}),
    });
    const pricingUnitCode = pricingMode === 'PER_WEIGHT' ? WEIGHT_UNIT_CODE : product.baseUnitCode;
    if (pricingUnitCode !== product.baseUnitCode && !(await findUnit(uow, pricingUnitCode))) {
      return {
        ok: false,
        outcome: rejected('UNIT_INVALID', `Unité de tarification inconnue : ${pricingUnitCode}.`),
      };
    }
    const price = await priceLine(uow, input.pricing, {
      productId: product.id,
      pricingQuantity: priced,
      line,
      maxDiscountPct: input.maxDiscountPct,
    });
    if (!price.ok) return { ok: false, outcome: price.outcome };
    if (price.priced.priceMismatch) input.flags.add('PRICE_MISMATCH');
    if (!sellable) input.flags.add('PRODUCT_INACTIVE');
    lines.push({
      id: idGenerator.newId(),
      lineNo: (input.firstLineNo ?? 1) + index,
      input: line,
      productId: product.id,
      productName: product.name,
      isService: product.stockFamily === 'SERVICE',
      productInactive: !sellable,
      pricingMode,
      quantityBase: declaredBase,
      pricingQuantity: priced,
      pricingUnitCode,
      priced: price.priced,
    });
  }
  return { ok: true, lines };
}
