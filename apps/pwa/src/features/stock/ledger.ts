/**
 * ECR-STK-07 « Registre des mouvements et explication d'écart » (responsables, direction ; en ligne ;
 * `inventory.ledger.read`) : logique pure.
 *
 * - Registre d'un emplacement (`GET /stock-moves`), filtré par produit et par jours métier (bornes
 *   comprises), page par page (`next_cursor`), du plus ancien au plus récent.
 * - Explication d'un écart pour un produit : solde au début de la période (`GET /stock/at` juste avant
 *   le premier jour), entrées et sorties de la période par type de mouvement, solde à la fin (juste
 *   avant minuit du dernier jour). Début + entrées − sorties doit redonner la fin ; un reste signale
 *   un mouvement daté hors de la période (jour métier différent de l'heure de l'opération) ou une liste
 *   pas encore complète.
 */
import { businessDayEndUtc, businessDayStartUtc } from '@gic/domain';

/** Mouvement renvoyé par `GET /api/v1/stock-moves` (valeurs masquées sans droit de valorisation). */
export interface MoveView {
  readonly id: string;
  readonly productId: string;
  readonly lotId: string | null;
  readonly direction: 'IN' | 'OUT';
  readonly quantity: number;
  readonly counterpartLocationId: string;
  readonly moveType: string;
  readonly reasonCodeId: string | null;
  readonly unitCostXaf: number | null;
  readonly valueXaf: number | null;
  readonly occurredAt: string;
  readonly businessDate: string | null;
  readonly recordedAt: string;
  readonly sourceDocType: string;
  readonly sourceDocId: string;
  readonly isReversal: boolean;
  readonly capturedOffline: boolean;
}

export interface MovesPage {
  readonly moves: readonly MoveView[];
  readonly next_cursor: string | null;
}

/** Ligne de `GET /api/v1/stock/at`. */
export interface BalanceAtLine {
  readonly productId: string;
  readonly lotId: string | null;
  readonly qtyOnHand: number;
}

export const LEDGER_DEFAULT_DAYS = 7;
export const LEDGER_PAGE_SIZE = 100;
/** Période la plus longue proposée en une lecture (jours métier). */
export const LEDGER_MAX_DAYS = 366;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Jour métier `AAAA-MM-JJ` qui existe au calendrier. */
function validDay(day: string): boolean {
  if (!DAY.test(day)) return false;
  const date = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

/** Jour métier décalé de `delta` jours. */
export function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function defaultPeriod(today: string): { readonly from: string; readonly to: string } {
  return { from: shiftDay(today, -(LEDGER_DEFAULT_DAYS - 1)), to: today };
}

export type PeriodIssue = 'DATE_INVALID' | 'ORDER' | 'FUTURE' | 'TOO_LONG';

export function checkPeriod(from: string, to: string, today: string): PeriodIssue | null {
  if (!validDay(from) || !validDay(to)) return 'DATE_INVALID';
  if (to < from) return 'ORDER';
  if (to > today) return 'FUTURE';
  const days =
    (new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) /
      86_400_000 +
    1;
  return days > LEDGER_MAX_DAYS ? 'TOO_LONG' : null;
}

export function movesPath(input: {
  readonly locationId: string;
  readonly productId: string;
  readonly from: string;
  readonly to: string;
  readonly cursor?: string | null;
}): string {
  const query = new URLSearchParams({
    location_id: input.locationId,
    from: input.from,
    to: input.to,
    limit: String(LEDGER_PAGE_SIZE),
  });
  if (input.productId) query.set('product_id', input.productId);
  if (input.cursor) query.set('cursor', input.cursor);
  return `/api/v1/stock-moves?${query.toString()}`;
}

/** Instant juste avant le début du premier jour (solde d'ouverture). */
export const openingInstant = (from: string): string =>
  new Date(businessDayStartUtc(from).getTime() - 1).toISOString();

/** Instant juste avant minuit du dernier jour (solde de clôture). */
export const closingInstant = (to: string): string =>
  new Date(businessDayEndUtc(to).getTime() - 1).toISOString();

export function balanceAtPath(locationId: string, productId: string, at: string): string {
  const query = new URLSearchParams({ location_id: locationId, at, product_id: productId });
  return `/api/v1/stock/at?${query.toString()}`;
}

const milli = (value: number): number => Math.round(value * 1000);
const fromMilli = (value: number): number => value / 1000;

/** Solde d'un produit (tous lots confondus) dans une réponse de `GET /stock/at`. */
export function quantityOf(lines: readonly BalanceAtLine[], productId: string): number {
  return fromMilli(
    lines
      .filter((line) => line.productId === productId)
      .reduce((sum, line) => sum + milli(line.qtyOnHand), 0),
  );
}

export interface TypeTotal {
  readonly moveType: string;
  readonly entries: number;
  readonly exits: number;
}

export interface LedgerExplanation {
  readonly opening: number;
  readonly entries: number;
  readonly exits: number;
  readonly closing: number;
  /** Fin − (début + entrées − sorties) ; 0 quand les mouvements listés expliquent tout. */
  readonly unexplained: number;
  readonly byType: readonly TypeTotal[];
}

export function explainGap(
  opening: number,
  closing: number,
  moves: readonly MoveView[],
  productId: string,
): LedgerExplanation {
  const byType = new Map<string, { entries: number; exits: number }>();
  let entries = 0;
  let exits = 0;
  for (const move of moves) {
    if (move.productId !== productId) continue;
    const quantity = milli(move.quantity);
    const total = byType.get(move.moveType) ?? { entries: 0, exits: 0 };
    if (move.direction === 'IN') {
      entries += quantity;
      total.entries += quantity;
    } else {
      exits += quantity;
      total.exits += quantity;
    }
    byType.set(move.moveType, total);
  }
  return {
    opening,
    entries: fromMilli(entries),
    exits: fromMilli(exits),
    closing,
    unexplained: fromMilli(milli(closing) - (milli(opening) + entries - exits)),
    byType: [...byType]
      .map(([moveType, total]) => ({
        moveType,
        entries: fromMilli(total.entries),
        exits: fromMilli(total.exits),
      }))
      .sort((a, b) => a.moveType.localeCompare(b.moveType)),
  };
}
