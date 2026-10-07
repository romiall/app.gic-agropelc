/**
 * Livraison d'une commande (P4-07 ; UC-VEN-06 ; ADR-028 §7 ; AV-034, AV-133, AV-134) :
 * `sales.order.fulfil` enregistre un **bon de livraison** (`LIV`), même partiel, possible hors ligne.
 *
 * La vente et le chiffre d'affaires sont nés à la confirmation (ADR-025) : la livraison ne crée ni
 * vente ni écriture de chiffre d'affaires. Elle remet au client la marchandise mise de côté « à
 * livrer » : pour chaque ligne de commande livrée, la quantité se répartit sur les lignes de vente qui
 * la portent, vente la plus ancienne d'abord (`deliveryAllocation`), chacune dans la limite de son
 * vendu non livré (INV-VEN-04) ; un mouvement `DELIVERY` (« à livrer » → `V_CUSTOMER`, valeur figée de
 * la vente) est rattaché à chaque mouvement `SALE` servi (`deliverSoldGoods`, ADR-029). Les compteurs
 * `delivered_quantity_base` de la ligne de vente et de la ligne de commande montent d'un seul `UPDATE`
 * chacun ; le statut de la commande est recalculé (`PARTIALLY_FULFILLED`, `FULFILLED`).
 *
 * Au-delà du vendu non livré (D04 §14, AV-133) : en ligne, refus `ORDER_OVER_FULFILMENT` sans
 * écriture ; hors ligne, la remise est un fait accompli (BR-SYN-007) — la part rattachable l'est, le
 * surplus devient une **vente directe de régularisation** au prix convenu, depuis l'emplacement de
 * préparation (stock négatif admis), avec un conflit `ORDER_OVER_FULFILMENT` pour le Resp. commercial.
 *
 * Un bon de livraison est en ajout seul : ni modification ni suppression (AV-134 : non en V1).
 * `version` de la commande ne bouge pas (progression, comme une vente du reste : D04 §15).
 */
import { z } from 'zod';
import {
  deliveryAllocation,
  dueDateOf,
  lineAmountXaf,
  quantityFromDecimal,
  quantityFromMilli,
  quantityMilliUnits,
  unitCostXaf,
  xaf,
  type IdGenerator,
} from '@gic/domain';
import { sql } from 'kysely';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { loadCommandOrigin, type CommandOrigin } from '../../../../platform/sync/command-origin.js';
import { recordConflict } from '../../../../platform/sync/conflicts.js';
import { areAttachmentsAvailable } from '../../../attachments/application/public/index.js';
import { findProduct } from '../../../catalog/application/public/index.js';
import { getCustomer } from '../../../crm/application/public/index.js';
import { findWorkSessionAt } from '../../../fieldwork/application/public/index.js';
import { checkUserActive, evaluateAccess } from '../../../identity/application/public/index.js';
import {
  deliverSoldGoods,
  findStockLocation,
  virtualLocationId,
} from '../../../inventory/application/public/index.js';
import { lockOrder, refreshOrderStatus, type OrderLineRow, type OrderRow } from './order-sale.js';
import { lockSale, type LockedSale } from './sale-cancellation.js';
import { moveSoldStock } from './sale-stock.js';
import {
  FORBIDDEN_SCOPE,
  businessRejection,
  documentYear,
  loadSite,
  numberSetting,
  rejected,
  type SiteRef,
  type Uow,
} from './shared.js';
import { withSalesChanges } from '../sync-changes.js';

/** Borne de `numeric(14,3)` (voir `sale-payload.ts`). */
const MAX_QUANTITY = 99_999_999_999.999;

const fulfilSchema = z.object({
  orderId: z.string().uuid(),
  localRef: z.string().trim().min(1).max(20).optional(),
  /** Livreur ; par défaut l'auteur de la saisie. */
  deliveredByUserId: z.string().uuid().optional(),
  recipientName: z.string().trim().min(1).max(200).optional(),
  proofAttachmentId: z.string().uuid().optional(),
  notes: z.string().trim().min(1).max(2000).optional(),
  lines: z
    .array(
      z.object({
        orderLineId: z.string().uuid(),
        /** Quantité remise, en unité de base (> 0). */
        quantityBase: z.number().positive().finite().max(MAX_QUANTITY),
      }),
    )
    .min(1)
    .max(100),
});
type FulfilPayload = z.infer<typeof fulfilSchema>;
type Envelope = Parameters<CommandHandler<FulfilPayload>>[1];

/** Avertissements possibles d'une livraison (`WARNING_CODES`, packages/contracts). */
type Warning = 'ORDER_OVER_FULFILMENT' | 'STOCK_NEGATIVE';

const milliOf = (value: string | number): number =>
  quantityMilliUnits(quantityFromDecimal(Number(value)));

/** Vendu non livré d'une ligne de vente sur commande : quantité − annulé − livré. */
function undeliveredMilli(line: LockedSale['lines'][number]): number {
  return (
    milliOf(line.quantity_base) -
    milliOf(line.cancelled_quantity_base) -
    milliOf(line.delivered_quantity_base)
  );
}

interface DeliveredSaleLine {
  readonly locked: LockedSale;
  readonly line: LockedSale['lines'][number];
  readonly orderLine: OrderLineRow;
  readonly quantityMilli: number;
}

interface Excess {
  readonly orderLine: OrderLineRow;
  readonly quantityMilli: number;
}

function buildHandlers(idGenerator: IdGenerator, documentSequences: DocumentSequenceService) {
  const deps = { idGenerator, documentSequences };

  const fulfil: CommandHandler<FulfilPayload> = async (uow, envelope) => {
    const noteId = envelope.aggregate_id;
    const existing = await uow
      .selectFrom('sales_delivery_notes')
      .select('doc_number')
      .where('id', '=', toBin(noteId))
      .executeTakeFirst();
    if (existing) return { status: 'APPLIED', serverRefs: { docNumber: existing.doc_number } };
    try {
      return await recordDelivery(uow, envelope, noteId);
    } catch (error) {
      return businessRejection(error);
    }
  };

  async function recordDelivery(
    uow: Uow,
    envelope: Envelope,
    noteId: string,
  ): Promise<CommandHandlerOutcome> {
    const p = envelope.payload;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const offline = envelope.captured_offline;

    // --- Commande verrouillée, puis ses ventes (ordre de verrous commun : commande, ventes) ------------
    const lockedOrder = await lockOrder(uow, p.orderId);
    if (!lockedOrder) return rejected('ORDER_NOT_FOUND', 'Commande inconnue.');
    const { order, lines: orderLines } = lockedOrder;
    const site = await loadSite(uow, fromBin(order.site_id));
    if (!site) return rejected('REFERENCE_INVALID', 'Site de la commande inconnu.');
    const createdBy = fromBin(order.created_by);
    const commercialId = order.commercial_user_id ? fromBin(order.commercial_user_id) : null;
    const access = await evaluateAccess(uow, {
      userId: author,
      permissionCode: 'sales.order.fulfil',
      occurredAt: at,
      resource: {
        ownerUserId: author === commercialId ? commercialId : createdBy,
        siteId: site.id,
        zoneId: site.zoneId,
      },
    });
    if (!access.allowed) return FORBIDDEN_SCOPE;

    // En ligne, seule une commande confirmée et non terminée se livre. Hors ligne, la remise a eu
    // lieu : tout ce qui ne se rattache plus est régularisé (AV-133).
    const deliverable = ['CONFIRMED', 'PARTIALLY_FULFILLED'].includes(order.status);
    if (!deliverable && !offline) {
      return rejected(
        'ORDER_STATUS_INVALID',
        'Commande non livrable : brouillon, déjà livrée, clôturée ou annulée.',
      );
    }

    const deliveredBy = p.deliveredByUserId ?? author;
    if (deliveredBy !== author) {
      const user = await checkUserActive(uow, toBin(deliveredBy), at);
      if (!user.ok) return rejected('REFERENCE_INVALID', 'Livreur inconnu ou inactif.');
    }
    if (p.proofAttachmentId && !(await areAttachmentsAvailable(uow, [p.proofAttachmentId]))) {
      return rejected('ATTACHMENT_MISSING', 'Preuve de remise introuvable.');
    }

    const orderLineById = new Map(orderLines.map((line) => [fromBin(line.id), line]));
    const requested = new Map<string, number>();
    for (const entry of p.lines) {
      if (!orderLineById.has(entry.orderLineId)) {
        return rejected('ORDER_LINE_UNKNOWN', 'Ligne de commande inconnue.');
      }
      if (requested.has(entry.orderLineId)) {
        return rejected('LINE_INVALID', 'Une même ligne de commande est citée deux fois.');
      }
      const quantityMilli = quantityMilliUnits(quantityFromDecimal(entry.quantityBase));
      if (quantityMilli <= 0)
        return rejected('QUANTITY_INVALID', 'Quantité livrée positive attendue.');
      requested.set(entry.orderLineId, quantityMilli);
    }

    // Ventes de la commande portant ces lignes : lecture simple, puis verrou (identifiant croissant).
    const saleRows = await uow
      .selectFrom('sales_sale_lines as sl')
      .innerJoin('sales_sales as s', 's.id', 'sl.sale_id')
      .select('s.id as saleId')
      .distinct()
      .where('s.order_id', '=', order.id)
      .where(
        'sl.order_line_id',
        'in',
        [...requested.keys()].map((id) => toBin(id)),
      )
      .execute();
    const lockedSales: LockedSale[] = [];
    for (const saleId of [...new Set(saleRows.map((row) => fromBin(row.saleId)))].sort()) {
      const locked = await lockSale(uow, saleId);
      if (locked) lockedSales.push(locked);
    }

    // --- Répartition : vente la plus ancienne d'abord (INV-VEN-04) -------------------------------------
    const delivered: DeliveredSaleLine[] = [];
    const excess: Excess[] = [];
    for (const [orderLineId, quantityMilli] of requested) {
      const orderLine = orderLineById.get(orderLineId)!;
      const candidates = lockedSales
        .filter((locked) => locked.sale.status !== 'CANCELLED')
        .flatMap((locked) =>
          locked.lines
            .filter(
              (line) => line.order_line_id !== null && fromBin(line.order_line_id) === orderLineId,
            )
            .map((line) => ({ locked, line })),
        )
        .sort(
          (a, b) =>
            a.locked.sale.occurred_at.getTime() - b.locked.sale.occurred_at.getTime() ||
            fromBin(a.locked.sale.id).localeCompare(fromBin(b.locked.sale.id)),
        );
      const pendingCancellation = candidates.find(
        ({ locked, line }) =>
          locked.sale.status === 'CANCELLATION_REQUESTED' && undeliveredMilli(line) > 0,
      );
      if (pendingCancellation && !offline) {
        return rejected(
          'SALE_CANCELLATION_PENDING',
          `Une demande d’annulation est en cours sur la vente ${pendingCancellation.locked.sale.doc_number} : la décider d’abord.`,
        );
      }
      const allocation = deliveryAllocation(
        deliverable
          ? candidates.map(({ line }) => ({
              id: fromBin(line.id),
              undelivered: quantityFromMilli(Math.max(0, undeliveredMilli(line))),
            }))
          : [],
        quantityFromMilli(quantityMilli),
      );
      for (const part of allocation.allocations) {
        const found = candidates.find(({ line }) => fromBin(line.id) === part.id)!;
        delivered.push({
          locked: found.locked,
          line: found.line,
          orderLine,
          quantityMilli: quantityMilliUnits(part.quantity),
        });
      }
      const excessMilli = quantityMilliUnits(allocation.excess);
      if (excessMilli > 0) {
        if (!offline) {
          return rejected(
            'ORDER_OVER_FULFILMENT',
            `La livraison dépasse ce qui reste vendu et non livré sur ${orderLine.product_name_snapshot}.`,
          );
        }
        excess.push({ orderLine, quantityMilli: excessMilli });
      }
    }

    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const serverRefs: Record<string, string> = {};
    const warnings = new Set<Warning>();

    // --- Bon de livraison, mouvements DELIVERY, compteurs ----------------------------------------------
    if (delivered.length > 0) {
      const docNumber = await documentSequences.next(uow, {
        docType: 'LIV',
        siteId: site.id,
        codeSite: site.code,
        year: documentYear(at),
      });
      serverRefs['docNumber'] = docNumber;
      await uow
        .insertInto('sales_delivery_notes')
        .values({
          id: toBin(noteId),
          doc_number: docNumber,
          local_ref: p.localRef ?? null,
          site_id: toBin(site.id),
          order_id: order.id,
          delivered_by_user_id: toBin(deliveredBy),
          recipient_name: p.recipientName ?? null,
          proof_attachment_id: toBinOrNull(p.proofAttachmentId ?? null),
          notes: p.notes ?? null,
          occurred_at: at,
          client_created_at: new Date(envelope.client_created_at),
          received_at_server: origin.receivedAt,
          command_id: toBin(envelope.command_id),
          created_device_id: toBinOrNull(origin.deviceId),
          captured_offline: offline ? 1 : 0,
          clock_suspect: origin.clockSuspect ? 1 : 0,
          backdated_reason: envelope.backdated_reason,
          created_by: toBin(author),
        })
        .execute();

      // Stock dans un ordre constant (produit, puis ligne de vente) : pas d'interblocage sur les soldes.
      const ordered = [...delivered].sort(
        (a, b) =>
          fromBin(a.line.product_id).localeCompare(fromBin(b.line.product_id)) ||
          fromBin(a.line.id).localeCompare(fromBin(b.line.id)),
      );
      for (const entry of ordered) {
        const deliveryLineId = idGenerator.newId();
        await uow
          .insertInto('sales_delivery_note_lines')
          .values({
            id: toBin(deliveryLineId),
            delivery_note_id: toBin(noteId),
            order_line_id: entry.orderLine.id,
            sale_line_id: entry.line.id,
            quantity_base: String(entry.quantityMilli / 1000),
          })
          .execute();
        const product = await findProduct(uow, fromBin(entry.line.product_id));
        if (product && product.stockFamily !== 'SERVICE') {
          await deliverSoldGoods(uow, deps, {
            saleId: fromBin(entry.locked.sale.id),
            saleLineId: fromBin(entry.line.id),
            quantityBase: entry.quantityMilli / 1000,
            sourceDocId: noteId,
            sourceLineId: deliveryLineId,
            occurredAt: at,
            createdBy: author,
            ...(origin.deviceId !== null ? { createdDeviceId: origin.deviceId } : {}),
            commandId: envelope.command_id,
            capturedOffline: offline,
          });
        }
        await uow
          .updateTable('sales_sale_lines')
          .set({
            delivered_quantity_base: sql`delivered_quantity_base + ${String(entry.quantityMilli / 1000)}`,
          })
          .where('id', '=', entry.line.id)
          .execute();
      }
      const byOrderLine = new Map<string, number>();
      for (const entry of delivered) {
        const key = fromBin(entry.orderLine.id);
        byOrderLine.set(key, (byOrderLine.get(key) ?? 0) + entry.quantityMilli);
      }
      for (const [orderLineId, quantityMilli] of byOrderLine) {
        await uow
          .updateTable('sales_sales_order_lines')
          .set({
            delivered_quantity_base: sql`delivered_quantity_base + ${String(quantityMilli / 1000)}`,
          })
          .where('id', '=', toBin(orderLineId))
          .execute();
      }
      const refreshed = await refreshOrderStatus(uow, fromBin(order.id));
      if (refreshed.status !== order.status) {
        await uow
          .updateTable('sales_sales_orders')
          .set({ status: refreshed.status })
          .where('id', '=', order.id)
          .execute();
      }
    }

    // --- Surplus hors ligne : vente directe de régularisation (AV-133, D04 §14) -----------------------
    if (excess.length > 0) {
      const regularisation = await recordRegularisationSale(uow, {
        order,
        site,
        excess,
        at,
        author,
        envelope,
        origin,
      });
      if (!regularisation.ok) return regularisation.outcome;
      serverRefs['regularisationSaleDocNumber'] = regularisation.docNumber;
      if (regularisation.negative) warnings.add('STOCK_NEGATIVE');
      warnings.add('ORDER_OVER_FULFILMENT');
      await recordConflict(uow, {
        id: idGenerator.newId(),
        commandId: envelope.command_id,
        conflictType: 'ORDER_OVER_FULFILMENT',
        entityType: 'SALES_ORDER',
        entityId: fromBin(order.id),
        siteId: site.id,
        ownerRole: 'RESP_COMMERCIAL',
        applied: true,
        details: {
          orderDocNumber: order.doc_number,
          orderStatus: order.status,
          deliveryNoteId: delivered.length > 0 ? noteId : null,
          regularisationSaleId: regularisation.saleId,
          regularisationSaleDocNumber: regularisation.docNumber,
          lines: excess.map((entry) => ({
            orderLineId: fromBin(entry.orderLine.id),
            quantityBase: entry.quantityMilli / 1000,
          })),
        },
      });
    }

    return warnings.size > 0
      ? { status: 'APPLIED_WITH_WARNINGS', warnings: [...warnings], serverRefs }
      : { status: 'APPLIED', serverRefs };
  }

  /**
   * Vente directe de la quantité remise au-delà du vendu non livré (AV-133, défaut (a)) : au prix
   * convenu de la ligne de commande, depuis son emplacement de préparation vers le client, à crédit
   * (aucun encaissement joint ; le plafond n'est pas contrôlé, le conflit porte la revue).
   */
  async function recordRegularisationSale(
    uow: Uow,
    input: {
      readonly order: OrderRow;
      readonly site: SiteRef;
      readonly excess: readonly Excess[];
      readonly at: Date;
      readonly author: string;
      readonly envelope: Envelope;
      readonly origin: CommandOrigin;
    },
  ): Promise<
    | {
        readonly ok: true;
        readonly saleId: string;
        readonly docNumber: string;
        readonly negative: boolean;
      }
    | { readonly ok: false; readonly outcome: CommandHandlerOutcome }
  > {
    const { order, site, at } = input;
    const customer = await getCustomer(uow, fromBin(order.customer_id));
    if (!customer) return { ok: false, outcome: rejected('CUSTOMER_UNKNOWN', 'Client inconnu.') };
    const location = await findStockLocation(uow, fromBin(order.fulfilment_location_id));
    if (!location) {
      return {
        ok: false,
        outcome: rejected('REFERENCE_INVALID', 'Emplacement de préparation inconnu.'),
      };
    }
    const customerLocationId = await virtualLocationId(uow, 'V_CUSTOMER');
    const saleId = idGenerator.newId();
    const lines = input.excess.map((entry) => ({
      ...entry,
      id: idGenerator.newId(),
      amountXaf: lineAmountXaf(
        quantityFromMilli(entry.quantityMilli),
        xaf(Number(entry.orderLine.quoted_unit_price_xaf)),
      ),
    }));
    let negative = false;
    const costs = new Map<string, { readonly costXaf: number; readonly unitCostXaf: number }>();
    const stockOrder = [...lines].sort(
      (a, b) =>
        fromBin(a.orderLine.product_id).localeCompare(fromBin(b.orderLine.product_id)) ||
        a.orderLine.line_no - b.orderLine.line_no,
    );
    for (const line of stockOrder) {
      const product = await findProduct(uow, fromBin(line.orderLine.product_id));
      if (!product || product.stockFamily === 'SERVICE') continue;
      const moved = await moveSoldStock(uow, deps, {
        saleId,
        lineId: line.id,
        productId: product.id,
        quantityBase: line.quantityMilli / 1000,
        fromLocationId: location.id,
        toLocationId: customerLocationId,
        locationType: location.locationType,
        occurredAt: at,
        createdBy: input.author,
        createdDeviceId: input.origin.deviceId,
        commandId: input.envelope.command_id,
        offline: true,
      });
      if (!moved.ok) return moved;
      negative ||= moved.negative;
      const costXaf = moved.moves.reduce((sum, move) => sum + move.valueXaf, 0);
      costs.set(line.id, {
        costXaf,
        unitCostXaf: unitCostXaf(costXaf, quantityFromMilli(line.quantityMilli)),
      });
    }

    const totalXaf = lines.reduce((sum, line) => sum + line.amountXaf, 0);
    const docNumber = await documentSequences.next(uow, {
      docType: 'VTE',
      siteId: site.id,
      codeSite: site.code,
      year: documentYear(at),
    });
    const termsDays =
      customer.paymentTermsDays ??
      (await numberSetting(uow, 'sales.default_payment_terms_days', at, 30));
    const session = await findWorkSessionAt(uow, input.author, at);
    const flags = ['ORDER_OVER_FULFILMENT', ...(negative ? ['STOCK_NEGATIVE'] : [])];
    await uow
      .insertInto('sales_sales')
      .values({
        id: toBin(saleId),
        doc_number: docNumber,
        site_id: toBin(site.id),
        sale_type: 'DIRECT',
        order_id: null,
        customer_id: order.customer_id,
        customer_category_id_snapshot: toBinOrNull(customer.categoryId),
        channel_code: order.channel_code,
        from_location_id: toBin(location.id),
        to_deliver_location_id: null,
        zone_id: toBin(customer.zoneId),
        seller_user_id: toBin(input.author),
        commercial_user_id: order.commercial_user_id,
        work_session_id: toBinOrNull(session?.id ?? null),
        subtotal_xaf: totalXaf,
        discount_total_xaf: 0,
        tax_total_xaf: 0,
        total_xaf: totalXaf,
        due_date: sql<Date>`${dueDateOf(at, termsDays)}`,
        flags: jsonValue(flags),
        occurred_at: at,
        client_created_at: new Date(input.envelope.client_created_at),
        received_at_server: input.origin.receivedAt,
        command_id: toBin(input.envelope.command_id),
        created_device_id: toBinOrNull(input.origin.deviceId),
        captured_offline: 1,
        clock_suspect: input.origin.clockSuspect ? 1 : 0,
        backdated_reason: input.envelope.backdated_reason,
        created_by: toBin(input.author),
      })
      .execute();
    for (const [index, line] of lines.entries()) {
      const cost = costs.get(line.id);
      const base = String(line.quantityMilli / 1000);
      const product = await findProduct(uow, fromBin(line.orderLine.product_id));
      await uow
        .insertInto('sales_sale_lines')
        .values({
          id: toBin(line.id),
          sale_id: toBin(saleId),
          line_no: index + 1,
          order_line_id: null,
          product_id: line.orderLine.product_id,
          product_name_snapshot: line.orderLine.product_name_snapshot,
          quantity: base,
          unit_code: product?.baseUnitCode ?? line.orderLine.unit_code,
          quantity_base: base,
          pricing_quantity: base,
          pricing_unit_code: product?.baseUnitCode ?? line.orderLine.unit_code,
          list_unit_price_xaf: line.orderLine.list_unit_price_xaf,
          unit_price_xaf: Number(line.orderLine.quoted_unit_price_xaf),
          price_rule_id: line.orderLine.price_rule_id,
          price_rule_version: line.orderLine.price_rule_version,
          // Prix convenu de la commande, sans la commande : la règle ou la dérogation d'origine.
          price_source: line.orderLine.price_source,
          override_reason_code_id: line.orderLine.override_reason_code_id,
          override_approval_request_id: line.orderLine.override_approval_request_id,
          discount_xaf: 0,
          line_total_xaf: line.amountXaf,
          unit_cost_xaf: cost?.unitCostXaf ?? null,
          cost_xaf: cost?.costXaf ?? null,
        })
        .execute();
    }
    return { ok: true, saleId, docNumber, negative };
  }

  return { fulfil };
}

export function registerDeliveryCommands(
  baseRegistry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  // P4-11 : chaque commande publie ses changements (jeux `orders`, `sales_recent`, `customers`).
  const registry = withSalesChanges(baseRegistry);
  const handlers = buildHandlers(idGenerator, documentSequences);
  registry.register({
    commandType: 'sales.order.fulfil',
    version: 1,
    payloadSchema: fulfilSchema,
    permissionCode: 'sales.order.fulfil',
    handler: handlers.fulfil,
  });
}
