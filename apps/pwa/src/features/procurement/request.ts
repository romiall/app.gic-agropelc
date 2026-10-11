/**
 * ECR-APP-02 « Demande d'achat » (UC-APP-02 ; BR-APP-001 à 003) : logique pure de
 * `procurement.request.submit`. Site bénéficiaire, date souhaitée facultative, justification
 * obligatoire, 1 à 100 lignes de produits achetables dans une unité d'achat (convertie en unité de
 * base), prix estimé facultatif par unité de base. Non modifiable une fois soumise (BR-APP-002) ;
 * validée par un valideur distinct (BR-APP-003). Sans `localRef` (doublon non géré par le serveur).
 */
import type { OutboxCommand } from '../../storage/db.js';
import { isWaiting } from '../sales/pending.js';
import type { SalesReferences } from '../sales/references.js';
import type { SaleUnit } from '../sales/sale-form.js';
import type { ProductData, PurchaseRequestData } from '../sales/types.js';
import type { TransferLineCheck } from '../stock/transfer.js';

export const MAX_REQUEST_LINES = 100;
export const MAX_JUSTIFICATION = 4000;
export const MAX_LINE_NOTES = 2000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Unités d'achat d'un produit : l'unité de base, puis ses conditionnements d'achat actifs. */
export function purchaseUnitsOf(
  product: ProductData,
  refs: Pick<SalesReferences, 'productUnits'>,
): SaleUnit[] {
  const units: SaleUnit[] = [{ unitCode: product.base_unit_code, factorToBase: '1' }];
  for (const unit of refs.productUnits) {
    if (
      unit.product_id === product.id &&
      unit.is_purchase_unit === true &&
      unit.is_active &&
      unit.unit_code !== product.base_unit_code
    ) {
      units.push({ unitCode: unit.unit_code, factorToBase: unit.factor_to_base });
    }
  }
  return units;
}

/** Produits achetables et actifs, par nom. */
export function purchasableProducts(products: readonly ProductData[]): ProductData[] {
  return products
    .filter((product) => product.is_purchasable === true && product.status === 'ACTIVE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/** Prix estimé : entier ≥ 0 en francs, vide admis ; `null` si invalide, `undefined` si vide. */
export function parsePrice(text: string): number | null | undefined {
  const normalized = text.trim().replace(/\s/g, '');
  if (normalized === '') return undefined;
  return /^\d+$/.test(normalized) ? Number(normalized) : null;
}

export type RequestIssue =
  'SITE_REQUIRED' | 'JUSTIFICATION_REQUIRED' | 'DATE_INVALID' | 'LINES_REQUIRED' | 'TOO_MANY_LINES';

export function checkRequest(input: {
  readonly siteId: string;
  readonly justification: string;
  readonly neededByDate: string;
  readonly lineCount: number;
  readonly today: string;
}): RequestIssue[] {
  const issues: RequestIssue[] = [];
  if (!input.siteId) issues.push('SITE_REQUIRED');
  if (!input.justification.trim()) issues.push('JUSTIFICATION_REQUIRED');
  if (
    input.neededByDate &&
    (!DATE_ONLY.test(input.neededByDate) || input.neededByDate < input.today)
  ) {
    issues.push('DATE_INVALID');
  }
  if (input.lineCount === 0) issues.push('LINES_REQUIRED');
  if (input.lineCount > MAX_REQUEST_LINES) issues.push('TOO_MANY_LINES');
  return issues;
}

export function requestPayload(input: {
  readonly siteId: string;
  readonly neededByDate: string;
  readonly justification: string;
  readonly lines: readonly {
    readonly check: TransferLineCheck & {
      readonly quantity: number;
      readonly quantityBase: number;
    };
    readonly price: number | undefined;
    readonly notes: string;
  }[];
}) {
  return {
    siteId: input.siteId,
    ...(input.neededByDate ? { neededByDate: input.neededByDate } : {}),
    justification: input.justification.trim(),
    lines: input.lines.map(({ check, price, notes }) => {
      const text = notes.trim();
      return {
        productId: check.draft.productId,
        quantityBase: check.quantityBase,
        unitCode: check.draft.unitCode,
        quantity: check.quantity,
        ...(price !== undefined ? { estimatedUnitPriceXaf: price } : {}),
        ...(text ? { notes: text } : {}),
      };
    }),
  };
}

export interface RequestView {
  readonly id: string;
  readonly docNumber: string | null;
  readonly status: string;
  readonly occurredAt: string;
  readonly lineCount: number;
  readonly justification: string;
  /** Demande saisie sur l'appareil, pas encore retéléchargée. */
  readonly pending: boolean;
}

/**
 * Demandes de l'utilisateur : celles du jeu `procurement` et celles de l'appareil pas encore
 * retéléchargées (en attente d'envoi), la plus récente d'abord.
 */
export function myRequests(
  requests: readonly PurchaseRequestData[],
  outbox: readonly OutboxCommand[],
  userId: string,
): RequestView[] {
  const known = new Set(requests.map((request) => request.id));
  const views: RequestView[] = requests
    .filter((request) => request.requested_by === userId)
    .map((request) => ({
      id: request.id,
      docNumber: request.doc_number,
      status: request.status,
      occurredAt: request.occurred_at,
      lineCount: request.lines.length,
      justification: request.justification,
      pending: false,
    }));
  for (const command of outbox) {
    if (command.command_type !== 'procurement.request.submit') continue;
    if (command.author_user_id !== userId || known.has(command.aggregate_id)) continue;
    if (command.status === 'REJECTED' || command.status === 'CONFLICT') continue;
    const payload = command.payload as { justification?: string; lines?: readonly unknown[] };
    views.push({
      id: command.aggregate_id,
      docNumber: (command.server_refs?.docNumber as string | undefined) ?? null,
      status: isWaiting(command) ? 'PENDING' : 'SUBMITTED',
      occurredAt: command.occurred_at,
      lineCount: payload.lines?.length ?? 0,
      justification: payload.justification ?? '',
      pending: true,
    });
  }
  return views.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}
