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
 *
 * **Quotas d'appareil** (P5-11 ; ADR-033 §5 à §7) : seule la vente directe (`sales.sale.record`) est un
 * fait de l'appareil et passe `consumesAllocation` ; `inventory` consomme alors d'abord le quota du
 * couple (auteur, appareil de l'inbox), puis le stock libre, refuse en ligne ce que ni l'un ni l'autre
 * ne couvre (`ALLOCATION_EXCEEDED`, `INSUFFICIENT_STOCK`) et contrôle hors ligne la garde d'appareil.
 * La confirmation d'une commande (`strict`) et la vente de régularisation d'une livraison sont des
 * opérations du serveur : elles ne le passent jamais (aucun quota consommé). Les avertissements de
 * quota et de garde de tous les mouvements (un par lot, plusieurs sur l'élevage) sont regroupés.
 */
import { selectLotsFifo, type IdGenerator } from '@gic/domain';
import type { WarningCode } from '@gic/contracts';
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
  /** Saisie hors ligne : trace d'origine ; sauf `strict`, elle autorise aussi le fait accompli. */
  readonly offline: boolean;
  /**
   * Ne jamais dépasser le stock réel, même saisie hors ligne : la confirmation d'une commande est une
   * intention confirmée par le serveur (AV-126), non un fait accompli (vente du disponible, AV-127).
   */
  readonly strict?: boolean;
  /**
   * Fait de l'appareil (vente directe seule) : la sortie consomme d'abord le quota du couple
   * (`createdBy`, `createdDeviceId` lu dans l'inbox). Jamais avec `strict` (opération du serveur).
   */
  readonly consumesAllocation?: boolean;
  /**
   * Vente directe : la vente ouvre elle-même le conflit `STOCK_NEGATIVE`, un par ligne (P4-04) ; sinon
   * (livraison de régularisation, confirmation), `inventory` l'ouvre par mouvement (AV-215).
   */
  readonly stockNegativeByCaller?: boolean;
}

export type SoldStockResult =
  | {
      readonly ok: true;
      readonly moves: readonly RecordedMove[];
      /** Un solde est devenu négatif (hors ligne) : conflit `STOCK_NEGATIVE`. */
      readonly negative: boolean;
      /** Des animaux de lots non vendables ont été vendus (hors ligne) : `LOT_NOT_SELLABLE`. */
      readonly lotsNotSellable: readonly string[];
      /**
       * Avertissements de quota et de garde consignés par `inventory` sur l'un des mouvements
       * (`ALLOCATION_EXCEEDED`, `ALLOCATION_REVOKED_CONSUMED`, `ALLOCATION_OVERCOMMITTED`,
       * `CUSTODY_DEVICE_MISMATCH`), sans doublon ; les conflits sont déjà ouverts.
       */
      readonly warnings: readonly WarningCode[];
    }
  | { readonly ok: false; readonly outcome: CommandHandlerOutcome };

/** Avertissements de tous les mouvements, sans doublon, dans l'ordre d'apparition. */
function movesWarnings(moves: readonly RecordedMove[]): readonly WarningCode[] {
  return [...new Set<WarningCode>(moves.flatMap((move) => move.warnings ?? []))];
}

export async function moveSoldStock(
  uow: Uow,
  deps: { readonly idGenerator: IdGenerator },
  input: SoldStockInput,
): Promise<SoldStockResult> {
  const lenient = input.offline && input.strict !== true;
  const consumesAllocation = input.consumesAllocation === true && input.strict !== true;
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
    allowNegative: lenient,
    ...(consumesAllocation ? { consumesAllocation: true } : {}),
    ...(input.stockNegativeByCaller === true ? { stockNegativeConflict: 'CALLER' as const } : {}),
  } satisfies Omit<RecordMoveInput, 'quantityBase' | 'lotId'>;

  if (!REARING_LOCATION_TYPES.includes(input.locationType)) {
    const moves = await recordStockMove(uow, deps, { ...base, quantityBase: input.quantityBase });
    return {
      ok: true,
      moves,
      negative: moves.some((move) => move.fromBalanceAfter < 0),
      lotsNotSellable: [],
      warnings: movesWarnings(moves),
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
    if (!lenient) {
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
    warnings: movesWarnings(moves),
  };
}
