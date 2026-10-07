/**
 * Prix d'une ligne de vente (BR-VEN-013, BR-VEN-015, BR-VEN-029 ; AV-026, AV-063, AV-141).
 *
 * Le prix catalogue de référence dépend de l'état de la commande :
 * - **en ligne**, c'est celui que le serveur résout à `occurred_at` avec le moteur partagé ; le prix
 *   catalogue déclaré par l'appareil doit lui être égal, sinon la vente est refusée
 *   (`PRICE_OUTDATED`, AV-141) pour que le vendeur actualise son catalogue ;
 * - **hors ligne**, la vente est un fait accompli : le prix catalogue et la règle sont ceux de
 *   l'appareil (figés sur la ligne), et un écart avec le prix que le serveur aurait résolu à
 *   `occurred_at` n'est qu'une anomalie `PRICE_MISMATCH` (le prix appliqué n'est jamais recalculé).
 *
 * Une ligne dont le montant diffère du montant au prix catalogue est une dérogation
 * (`priceOverrideCheck`) : permission `sales.price.override` à la portée de la vente, plafond de
 * remise du rôle (le plus élevé si plusieurs rôles, RC-06), motif obligatoire ; au-delà du plafond
 * ou sans prix catalogue, la ligne est enregistrée et une validation `PRICE_OVERRIDE` est demandée.
 */
import {
  maxDiscountPctOf,
  priceOverrideCheck,
  quantityToDecimal,
  saleLineAmounts,
  xaf,
  type Quantity,
} from '@gic/domain';
import type { CommandHandlerOutcome } from '../../../../platform/sync/command-handler-registry.js';
import { findReasonCode } from '../../../catalog/application/public/index.js';
import {
  evaluateAccessLimits,
  type ResourceLocator,
} from '../../../identity/application/public/index.js';
import {
  findPriceRule,
  resolvePriceForContext,
} from '../../../pricing/application/public/index.js';
import { rejected, type Uow } from './shared.js';
import type { SaleLineInput } from './sale-payload.js';

export interface PricingContext {
  readonly at: Date;
  readonly offline: boolean;
  readonly userId: string;
  readonly resource: ResourceLocator;
  readonly siteId: string;
  readonly zoneId: string;
  readonly customerCategoryId: string | null;
  readonly channelCode: string;
}

export interface PricedLine {
  readonly listUnitPriceXaf: number | null;
  readonly unitPriceXaf: number;
  readonly priceRuleId: string | null;
  readonly priceRuleVersion: number | null;
  readonly priceSpecificity: number | null;
  readonly priceSource: 'RULE' | 'MANUAL_OVERRIDE';
  readonly overrideReasonCodeId: string | null;
  /** Dérogation au-delà du plafond, ou sans prix catalogue : validation `PRICE_OVERRIDE`. */
  readonly needsApproval: boolean;
  /** Hors ligne : le prix catalogue de l'appareil diffère du prix résolu par le serveur. */
  readonly priceMismatch: boolean;
  readonly serverUnitPriceXaf: number | null;
  /** Montant de la ligne au prix catalogue ; `null` sans prix catalogue. */
  readonly listAmountXaf: number | null;
  readonly grossXaf: number;
  readonly discountXaf: number;
  readonly lineTotalXaf: number;
}

export type PriceLineResult =
  | { readonly ok: true; readonly priced: PricedLine }
  | { readonly ok: false; readonly outcome: CommandHandlerOutcome };

const fail = (code: string, message: string): PriceLineResult => ({
  ok: false,
  outcome: rejected(code, message),
});

/** Plafond de remise de l'utilisateur à la portée de la vente (`null` : pas de dérogation). */
export async function discountCeilingPct(
  uow: Uow,
  context: Pick<PricingContext, 'userId' | 'at' | 'resource'>,
): Promise<number | null> {
  const limits = await evaluateAccessLimits(uow, {
    userId: context.userId,
    permissionCode: 'sales.price.override',
    occurredAt: context.at,
    resource: context.resource,
  });
  return maxDiscountPctOf(
    limits.map((limit) => {
      const value = limit?.['max_discount_pct'];
      return typeof value === 'number' ? value : null;
    }),
  );
}

export async function priceLine(
  uow: Uow,
  context: PricingContext,
  input: {
    readonly productId: string;
    readonly pricingQuantity: Quantity;
    readonly line: SaleLineInput;
    readonly maxDiscountPct: number | null;
  },
): Promise<PriceLineResult> {
  const { line } = input;
  const server = await resolvePriceForContext(uow, {
    productId: input.productId,
    at: context.at,
    siteId: context.siteId,
    zoneId: context.zoneId,
    channelCode: context.channelCode,
    quantity: quantityToDecimal(input.pricingQuantity),
    ...(context.customerCategoryId !== null
      ? { customerCategoryId: context.customerCategoryId }
      : {}),
  });
  const serverList = server.found ? server.resolution.unitPriceXaf : null;
  const declaredList = line.listUnitPriceXaf ?? null;

  let listUnitPriceXaf: number | null;
  let ruleId: string | null;
  let specificity: number | null = null;
  let priceMismatch = false;
  if (!context.offline) {
    if (declaredList !== serverList) {
      return fail(
        'PRICE_OUTDATED',
        'Le prix catalogue a changé : actualiser le catalogue avant d’enregistrer la vente.',
      );
    }
    listUnitPriceXaf = serverList;
    ruleId = server.found ? server.resolution.rule.id : null;
    specificity = server.found ? server.resolution.specificity : null;
  } else {
    listUnitPriceXaf = declaredList;
    ruleId = line.priceRuleId ?? null;
    if (
      listUnitPriceXaf !== null &&
      ruleId === null &&
      server.found &&
      serverList === declaredList
    ) {
      ruleId = server.resolution.rule.id;
    }
    priceMismatch = declaredList !== serverList;
  }

  let ruleVersion: number | null = null;
  if (ruleId !== null) {
    const rule = await findPriceRule(uow, ruleId);
    if (!rule || rule.productId !== input.productId) {
      return fail('PRICE_RULE_INVALID', 'Règle tarifaire inconnue ou d’un autre produit.');
    }
    ruleVersion = rule.version;
    specificity = specificity ?? rule.specificity;
  }

  const amounts = saleLineAmounts({
    pricingQuantity: input.pricingQuantity,
    unitPriceXaf: xaf(line.unitPriceXaf),
    discountXaf: xaf(line.discountXaf ?? 0),
    listUnitPriceXaf: listUnitPriceXaf === null ? null : xaf(listUnitPriceXaf),
  });
  const check = priceOverrideCheck({
    listAmountXaf: amounts.listAmountXaf,
    lineTotalXaf: amounts.lineTotalXaf,
    maxDiscountPct: input.maxDiscountPct,
  });

  if (check.outcome === 'NOT_PERMITTED') {
    return amounts.listAmountXaf === null
      ? fail('PRICE_NOT_FOUND', 'Aucun prix catalogue pour ce produit : dérogation requise.')
      : fail(
          'PRICE_OVERRIDE_NOT_PERMITTED',
          'Dérogation de prix non autorisée pour cet utilisateur.',
        );
  }

  let overrideReasonCodeId: string | null = null;
  if (check.outcome !== 'NONE') {
    if (!line.overrideReasonCodeId) {
      return fail('OVERRIDE_REASON_REQUIRED', 'Motif de dérogation de prix obligatoire.');
    }
    const reason = await findReasonCode(uow, line.overrideReasonCodeId);
    if (
      !reason ||
      reason.category !== 'PRICE_OVERRIDE' ||
      // Hors ligne, un motif désactivé depuis la saisie ne remet pas en cause le fait.
      (!reason.isActive && !context.offline)
    ) {
      return fail('OVERRIDE_REASON_INVALID', 'Motif de dérogation inconnu ou désactivé.');
    }
    overrideReasonCodeId = reason.id;
  } else if (ruleId === null) {
    // Prix égal au prix catalogue sans règle désignée : la ligne `RULE` exige règle et version.
    return fail('PRICE_RULE_REQUIRED', 'Règle tarifaire requise pour une vente au prix catalogue.');
  }

  return {
    ok: true,
    priced: {
      listUnitPriceXaf,
      unitPriceXaf: line.unitPriceXaf,
      priceRuleId: ruleId,
      priceRuleVersion: ruleVersion,
      priceSpecificity: specificity,
      priceSource: check.outcome === 'NONE' ? 'RULE' : 'MANUAL_OVERRIDE',
      overrideReasonCodeId,
      needsApproval: check.outcome === 'EXCEEDS_LIMIT' || check.outcome === 'NO_REFERENCE_PRICE',
      priceMismatch,
      serverUnitPriceXaf: serverList,
      listAmountXaf: amounts.listAmountXaf,
      grossXaf: amounts.grossXaf,
      discountXaf: amounts.discountXaf,
      lineTotalXaf: amounts.lineTotalXaf,
    },
  };
}
