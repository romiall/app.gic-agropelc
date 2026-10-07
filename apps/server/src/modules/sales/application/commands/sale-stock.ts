/**
 * Effets stock d'une ligne de vente directe (BR-VEN-016, BR-VEN-017, BR-VEN-019, BR-VEN-031) :
 * un mouvement `SALE` de l'emplacement source vers `V_CUSTOMER`, un par lot (FIFO), rattaché à la
 * ligne par (`SALE`, vente, ligne). Une ligne de service n'a aucun effet stock.
 *
 * - **PDV et stock mobile** : `recordStockMove` sans lot choisit le FIFO d'`inventory`.
 * - **Emplacement d'élevage** (`BUILDING`, `PEN`) : seuls les lots `SELLING` se vendent
 *   (`sellableFromRearing`, BR-PRD-010) ; la vente choisit ses lots (FIFO parmi eux) et appelle
 *   `recordStockMove` avec un lot explicite par part. En ligne, un stock vendable insuffisant est
 *   refusé (`LOT_NOT_SELLABLE` si le stock existe mais n'est pas vendable, sinon
 *   `INSUFFICIENT_STOCK`). Hors ligne, les animaux sont partis : le fait est appliqué, le reste
 *   est pris sur les autres lots (anomalie `LOT_NOT_SELLABLE`) puis, au-delà du stock, en solde
 *   négatif (anomalie `STOCK_NEGATIVE`).
 *
 * Le stock négatif n'est jamais signalé par `inventory` : il se lit sur `fromBalanceAfter`.
 */
import { selectLotsFifo, type IdGenerator } from '@gic/domain';
import type { CommandHandlerOutcome } from '../../../../platform/sync/command-handler-registry.js';
import {
  listLotBalances,
  recordStockMove,
  type RecordedMove,
  type RecordMoveInput,
} from '../../../inventory/application/public/index.js';
import { rejected, type Uow } from './shared.js';

export const REARING_LOCATION_TYPES: readonly string[] = ['BUILDING', 'PEN'];

export interface SoldStockInput {
  readonly saleId: string;
  readonly lineId: string;
  readonly productId: string;
  readonly quantityBase: number;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly locationType: string;
  readonly occurredAt: Date;
  readonly createdBy: string;
  readonly createdDeviceId: string | null;
  readonly commandId: string;
  readonly offline: boolean;
}

export type SoldStockResult =
  | {
      readonly ok: true;
      readonly moves: readonly RecordedMove[];
      /** Un solde est devenu négatif (hors ligne) : conflit `STOCK_NEGATIVE`. */
      readonly negative: boolean;
      /** Des animaux de lots non vendables ont été vendus (hors ligne) : `LOT_NOT_SELLABLE`. */
      readonly lotsNotSellable: readonly string[];
    }
  | { readonly ok: false; readonly outcome: CommandHandlerOutcome };

export async function moveSoldStock(
  uow: Uow,
  deps: { readonly idGenerator: IdGenerator },
  input: SoldStockInput,
): Promise<SoldStockResult> {
  const base = {
    productId: input.productId,
    fromLocationId: input.fromLocationId,
    toLocationId: input.toLocationId,
    moveType: 'SALE',
    occurredAt: input.occurredAt,
    sourceDocType: 'SALE',
    sourceDocId: input.saleId,
    sourceLineId: input.lineId,
    createdBy: input.createdBy,
    ...(input.createdDeviceId !== null ? { createdDeviceId: input.createdDeviceId } : {}),
    commandId: input.commandId,
    capturedOffline: input.offline,
    allowNegative: input.offline,
  } satisfies Omit<RecordMoveInput, 'quantityBase' | 'lotId'>;

  if (!REARING_LOCATION_TYPES.includes(input.locationType)) {
    const moves = await recordStockMove(uow, deps, { ...base, quantityBase: input.quantityBase });
    return {
      ok: true,
      moves,
      negative: moves.some((move) => move.fromBalanceAfter < 0),
      lotsNotSellable: [],
    };
  }

  const balances = await listLotBalances(uow, {
    locationId: input.fromLocationId,
    productId: input.productId,
  });
  const asLots = (lines: typeof balances) =>
    lines.map((line) => ({
      lotId: line.lotId,
      qtyAvailable: line.qtyOnHand,
      rankAt: line.fifoRankAt,
    }));
  const first = selectLotsFifo(
    asLots(balances.filter((line) => line.sellableFromRearing)),
    input.quantityBase,
  );
  const allocations = [...first.allocations];
  const lotsNotSellable: string[] = [];
  let shortfall = first.shortfall;
  if (shortfall > 0) {
    const others = balances.filter((line) => !line.sellableFromRearing);
    if (!input.offline) {
      return {
        ok: false,
        outcome:
          others.length > 0
            ? rejected(
                'LOT_NOT_SELLABLE',
                'Les animaux de cet emplacement ne sont pas en vente (lot non « en vente »).',
              )
            : rejected('INSUFFICIENT_STOCK', 'Stock insuffisant à l’emplacement de vente.'),
      };
    }
    if (others.length > 0) {
      const second = selectLotsFifo(asLots(others), shortfall);
      allocations.push(...second.allocations);
      lotsNotSellable.push(...second.allocations.map((allocation) => allocation.lotId));
      shortfall = second.shortfall;
    }
  }

  const moves: RecordedMove[] = [];
  for (const allocation of allocations) {
    moves.push(
      ...(await recordStockMove(uow, deps, {
        ...base,
        lotId: allocation.lotId,
        quantityBase: allocation.quantity,
      })),
    );
  }
  if (shortfall > 0) {
    // BR-STK-018 : le fait physique est appliqué, imputé au dernier lot consulté (ou sans lot).
    const lastLotId = allocations.at(-1)?.lotId ?? balances.at(-1)?.lotId;
    moves.push(
      ...(await recordStockMove(uow, deps, {
        ...base,
        quantityBase: shortfall,
        ...(lastLotId !== undefined ? { lotId: lastLotId } : {}),
      })),
    );
  }
  return {
    ok: true,
    moves,
    negative: moves.some((move) => move.fromBalanceAfter < 0),
    lotsNotSellable,
  };
}
