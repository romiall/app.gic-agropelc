/**
 * Commandes clients (D04 §7.1 ; UC-VEN-02 à UC-VEN-06 ; ADR-028 ; AV-126 à AV-130) :
 *
 * - `sales.order.save_draft` : préparation d'une commande au bureau (en ligne) : brouillon sans
 *   effet de stock ni de chiffre d'affaires ; prix résolus à la saisie et figés (BR-VEN-003) ;
 * - `sales.order.place` : confirmation (hors ligne possible, AV-126 : l'intention est confirmée par le
 *   serveur à la synchronisation, avec l'heure de la saisie) — la **vente du disponible** (AV-127) crée
 *   une vente de type `ORDER`, le reste demeure en attente ; acomptes joints (ADR-028 §8) ;
 *   confirme aussi un brouillon existant (même identifiant) ;
 * - `sales.order.confirm_remaining` : vend ce qui est devenu disponible pour les quantités en attente,
 *   au prix convenu (AV-087) ;
 * - `sales.order.update` : ajustement automatique d'une commande confirmée, tant qu'aucune livraison
 *   n'a eu lieu (BR-VEN-005, AV-130) : une baisse retire l'attente puis annule par contre-écriture le
 *   vendu non livré, une hausse ou un produit ajouté crée une vente complémentaire (vente du
 *   disponible) ; version périmée : quarantaine `VERSION_CONFLICT` (matrice des conflits) ;
 * - `sales.order.cancel` : annulation d'une commande sans livraison (`DRAFT` ou `CONFIRMED`, motif) ;
 * - `sales.order.close_remaining` : clôture du reste d'une commande en partie livrée (motif).
 *   L'annulation et la clôture se font par l'auteur ou le Resp. commercial, sans validation (AV-128) ;
 *   l'argent payé libéré devient du crédit client ou un remboursement (AV-146, BR-VEN-009).
 *
 * Une commande n'est jamais refusée pour manque de stock (BR-VEN-004) ; elle exige un client
 * identifié (BR-VEN-001). Le crédit se contrôle sur la vente (BR-VEN-025, jamais par une validation
 * a posteriori : la confirmation est une intention du serveur) ; les remises passent par le prix
 * convenu (une ligne de commande n'a pas de remise, AV-147) ; un produit vendu au poids ne se
 * commande pas en P4 (AV-136).
 *
 * `version` (concurrence optimiste, BR-VEN-005) n'est incrémentée que par une modification de la
 * commande (contenu ou statut), pas par la simple progression de ses ventes : une commande saisie
 * puis modifiée hors ligne n'entre pas en conflit avec elle-même.
 */
import { z } from 'zod';
import {
  lineAmountXaf,
  quantityFromMilli,
  quantityMilliUnits,
  quantityFromDecimal,
  xaf,
  type IdGenerator,
} from '@gic/domain';
import { recordConflict } from '../../../../platform/sync/conflicts.js';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { loadCommandOrigin, type CommandOrigin } from '../../../../platform/sync/command-origin.js';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { sql } from 'kysely';
import { requestApproval } from '../../../approvals/application/public/index.js';
import { findReasonCode, findSalesChannel } from '../../../catalog/application/public/index.js';
import {
  getCustomer,
  hasCommercialRoleAt,
  lockCustomerAccount,
  ownerOfCustomerAt,
  type CustomerSummary,
} from '../../../crm/application/public/index.js';
import { findWorkSessionAt } from '../../../fieldwork/application/public/index.js';
import {
  activeRoleCodesAt,
  evaluateAccess,
  type ResourceLocator,
} from '../../../identity/application/public/index.js';
import { findStockLocation } from '../../../inventory/application/public/index.js';
import {
  CONTROL_POLICY_MISSING,
  FORBIDDEN_SCOPE,
  activePolicy,
  businessRejection,
  documentYear,
  loadSite,
  rejected,
  type SiteRef,
  type Uow,
} from './shared.js';
import { saleLineSchema, salePaymentSchema, type SaleLineInput } from './sale-payload.js';
import { discountCeilingPct } from './sale-pricing.js';
import { checkLineQuantity, resolveSaleLines, type ResolvedLine } from './sale-lines.js';
import { planPayments } from './sale-payments.js';
import { writeAdvancePayments } from './advance-payments.js';
import {
  confirmOrderPending,
  lockOrder,
  refreshOrderStatus,
  type OrderConfirmationResult,
  type OrderLineRow,
  type OrderRow,
} from './order-sale.js';
import {
  cancelOrderUndelivered,
  fullRetirement,
  releaseOrderAdvance,
  retireOrderLines,
  retirementToTarget,
  type CancellationDocument,
  type LineRetirement,
} from './order-adjust.js';
import type { PaymentTreatment } from './sale-cancellation.js';

const ORDER_LOCATION_TYPES: readonly string[] = ['STORE', 'POS', 'MOBILE', 'BUILDING', 'PEN'];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** Borne de `numeric(14,3)` (voir `sale-payload.ts`). */
const MAX_QUANTITY = 99_999_999_999.999;

const orderBodySchema = z.object({
  customerId: z.string().uuid(),
  fulfilmentLocationId: z.string().uuid(),
  channelCode: z.string().trim().min(1).max(20).optional(),
  localRef: z.string().trim().min(1).max(20).optional(),
  requestedDeliveryDate: z.string().regex(DATE_ONLY).optional(),
  deliveryAddress: z.string().trim().min(1).max(1000).optional(),
});

const saveDraftSchema = orderBodySchema.extend({
  lines: z.array(saleLineSchema).min(1).max(100),
});
type SaveDraftPayload = z.infer<typeof saveDraftSchema>;

/** `lines` absent : confirme le brouillon enregistré sous le même identifiant. */
const placeSchema = orderBodySchema.extend({
  lines: z.array(saleLineSchema).min(1).max(100).optional(),
  advancePayments: z.array(salePaymentSchema).max(10).optional(),
});
type PlacePayload = z.infer<typeof placeSchema>;

const emptySchema = z.object({}).passthrough();

const paymentTreatmentSchema = z.enum(['REFUND', 'CUSTOMER_CREDIT']);

/** Nouvelle quantité commandée d'une ligne existante ; 0 retire la ligne (AV-130). */
const adjustLineSchema = z.object({
  orderLineId: z.string().uuid(),
  quantity: z.number().min(0).finite().max(MAX_QUANTITY),
  quantityBase: z.number().min(0).finite().max(MAX_QUANTITY),
});

const updateSchema = z.object({
  fulfilmentLocationId: z.string().uuid().optional(),
  requestedDeliveryDate: z.string().regex(DATE_ONLY).nullable().optional(),
  deliveryAddress: z.string().trim().min(1).max(1000).nullable().optional(),
  lines: z.array(adjustLineSchema).max(100).optional(),
  addedLines: z.array(saleLineSchema).max(100).optional(),
  /** Sort de l'argent payé libéré par une baisse (crédit client ou remboursement, AV-146). */
  paymentTreatment: paymentTreatmentSchema.optional(),
});
type UpdatePayload = z.infer<typeof updateSchema>;

const retireSchema = z.object({
  reasonCodeId: z.string().uuid().optional(),
  comment: z.string().trim().min(1).max(2000).optional(),
  /** Sort de l'argent payé libéré : acompte et part payée des ventes annulées (AV-146). */
  paymentTreatment: paymentTreatmentSchema.optional(),
});
type RetirePayload = z.infer<typeof retireSchema>;

const NOT_FOUND = rejected('NOT_FOUND', 'Commande introuvable.');

type Warning = 'PRICE_MISMATCH' | 'PRICE_OVERRIDE_EXCEEDS_LIMIT' | 'PAYMENT_SUSPECT_DUPLICATE';
type Envelope<P> = Parameters<CommandHandler<P>>[1];

const milliOf = (value: string | number): number =>
  quantityMilliUnits(quantityFromDecimal(Number(value)));

/** Compte conservé d'un client fusionné (conditions de crédit, zone) ; le compte nommé sinon. */
async function keptCustomerOf(
  uow: Uow,
  customer: CustomerSummary,
): Promise<CustomerSummary | undefined> {
  if (customer.stage !== 'MERGED') return customer;
  return customer.mergedIntoId ? getCustomer(uow, customer.mergedIntoId) : undefined;
}

function buildHandlers(idGenerator: IdGenerator, documentSequences: DocumentSequenceService) {
  const deps = { idGenerator, documentSequences };

  /** Contrôles communs : client, emplacement de préparation, portée, canal. */
  async function loadContext(
    uow: Uow,
    input: {
      readonly author: string;
      readonly at: Date;
      readonly customerId: string;
      readonly fulfilmentLocationId: string;
      readonly channelCode: string | undefined;
      readonly ownerUserId: string;
    },
  ) {
    const customer = await getCustomer(uow, input.customerId);
    if (!customer)
      return { ok: false as const, outcome: rejected('CUSTOMER_UNKNOWN', 'Client inconnu.') };
    if (customer.stage === 'MERGED') {
      return {
        ok: false as const,
        outcome: rejected(
          'CUSTOMER_MERGED',
          'Compte fusionné dans un autre compte : commander pour le compte conservé (BR-CRM-007).',
        ),
      };
    }
    const location = await findStockLocation(uow, input.fulfilmentLocationId);
    if (!location || location.isVirtual || location.siteId === null) {
      return {
        ok: false as const,
        outcome: rejected(
          'REFERENCE_INVALID',
          'Emplacement de préparation inconnu, virtuel ou sans site.',
        ),
      };
    }
    if (!ORDER_LOCATION_TYPES.includes(location.locationType)) {
      return {
        ok: false as const,
        outcome: rejected('LOCATION_NOT_SELLABLE', 'Emplacement de préparation non autorisé.'),
      };
    }
    // Stock mobile à garde exclusive : seul son détenteur en prépare une commande (RBAC §3, OWN).
    if (location.custodyMode === 'EXCLUSIVE_USER' && location.custodianUserId !== input.author) {
      return { ok: false as const, outcome: FORBIDDEN_SCOPE };
    }
    const site = await loadSite(uow, location.siteId);
    if (!site)
      return { ok: false as const, outcome: rejected('REFERENCE_INVALID', 'Site inconnu.') };
    const access = await evaluateAccess(uow, {
      userId: input.author,
      permissionCode: 'sales.order.create',
      occurredAt: input.at,
      resource: { ownerUserId: input.ownerUserId, siteId: site.id, zoneId: site.zoneId },
    });
    if (!access.allowed) return { ok: false as const, outcome: FORBIDDEN_SCOPE };
    let channelCode = input.channelCode;
    if (channelCode === undefined) {
      const session = await findWorkSessionAt(uow, input.author, input.at);
      const roles = await activeRoleCodesAt(uow, input.author, input.at);
      channelCode =
        session !== undefined
          ? 'TERRAIN'
          : roles.includes('COMMERCIAL_SEDENTAIRE')
            ? 'SEDENTAIRE'
            : 'DIRECT';
    }
    const channel = await findSalesChannel(uow, channelCode);
    if (!channel || !channel.isActive) {
      return {
        ok: false as const,
        outcome: rejected('CHANNEL_UNKNOWN', 'Canal de vente inconnu ou désactivé.'),
      };
    }
    return {
      ok: true as const,
      customer,
      location,
      site,
      channelCode,
      resource: { ownerUserId: input.ownerUserId, siteId: site.id, zoneId: site.zoneId },
    };
  }

  /**
   * Prix et quantités des lignes d'une commande (création ou ajout de lignes) : pas de remise
   * (AV-147), pas de produit au poids (AV-136), prix convenu résolu par le moteur de tarification.
   */
  async function prepareLines(
    uow: Uow,
    input: {
      readonly lines: readonly SaleLineInput[];
      readonly author: string;
      readonly at: Date;
      readonly offline: boolean;
      readonly customer: CustomerSummary;
      readonly site: SiteRef;
      readonly channelCode: string;
      readonly resource: ResourceLocator;
      readonly firstLineNo?: number;
    },
  ): Promise<
    | { readonly ok: true; readonly lines: readonly ResolvedLine[] }
    | { readonly ok: false; readonly outcome: CommandHandlerOutcome }
  > {
    // Pas de remise sur une ligne de commande : une dérogation se saisit par le prix convenu (AV-147).
    if (input.lines.some((line) => line.discountXaf !== undefined && line.discountXaf > 0)) {
      return {
        ok: false,
        outcome: rejected(
          'DISCOUNT_NOT_SUPPORTED_ON_ORDER',
          'Une commande n’a pas de remise : la dérogation se saisit par le prix convenu.',
        ),
      };
    }
    const flags = new Set<string>();
    const maxDiscountPct = await discountCeilingPct(uow, {
      userId: input.author,
      at: input.at,
      resource: input.resource,
    });
    const resolved = await resolveSaleLines(uow, idGenerator, {
      lines: input.lines,
      offline: input.offline,
      pricing: {
        at: input.at,
        offline: input.offline,
        userId: input.author,
        resource: input.resource,
        siteId: input.site.id,
        zoneId: input.customer.zoneId,
        customerCategoryId: input.customer.categoryId,
        channelCode: input.channelCode,
      },
      maxDiscountPct,
      flags,
      ...(input.firstLineNo !== undefined ? { firstLineNo: input.firstLineNo } : {}),
    });
    if (!resolved.ok) return resolved;
    for (const line of resolved.lines) {
      if (line.pricingMode === 'PER_WEIGHT') {
        return {
          ok: false,
          outcome: rejected(
            'PRODUCT_NOT_ORDERABLE',
            `Un produit vendu au poids ne se commande pas (${line.productName}) : le vendre directement.`,
          ),
        };
      }
    }
    return resolved;
  }

  /** Validation `PRICE_OVERRIDE` (sujet : la commande) si une ligne dépasse le plafond de remise. */
  async function requestPriceApproval(
    uow: Uow,
    input: {
      readonly orderId: string;
      readonly docNumber: string;
      readonly lines: readonly ResolvedLine[];
      readonly site: SiteRef;
      readonly zoneId: string;
      readonly author: string;
      readonly at: Date;
      readonly offline: boolean;
      readonly origin: CommandOrigin;
    },
  ): Promise<
    | { readonly ok: true; readonly approvalId: string | null }
    | { readonly ok: false; readonly outcome: CommandHandlerOutcome }
  > {
    const needing = input.lines.filter((line) => line.priced.needsApproval);
    if (needing.length === 0) return { ok: true, approvalId: null };
    const policy = await activePolicy(
      uow,
      'PRICE_OVERRIDE',
      input.at,
      input.offline ? input.origin.receivedAt : undefined,
    );
    if (!policy) return { ok: false, outcome: CONTROL_POLICY_MISSING('PRICE_OVERRIDE') };
    const approvalId = idGenerator.newId();
    await requestApproval(uow, {
      requestId: approvalId,
      operationType: 'PRICE_OVERRIDE',
      subjectType: 'SALES_ORDER',
      subjectId: input.orderId,
      subjectSummary: `Dérogation de prix au-delà du plafond sur la commande ${input.docNumber}`,
      siteId: input.site.id,
      zoneId: input.zoneId,
      amountXaf: needing.reduce(
        (sum, line) =>
          sum +
          (line.priced.listAmountXaf === null
            ? line.priced.lineTotalXaf
            : Math.max(0, line.priced.listAmountXaf - line.priced.lineTotalXaf)),
        0,
      ),
      requestedBy: input.author,
      requestedAt: input.at,
      policyId: policy.id,
      policyVersion: policy.version,
    });
    return { ok: true, approvalId };
  }

  /** Insère les lignes (prix convenu figé) ; un prix périmé saisi hors ligne ouvre `PRICE_MISMATCH`. */
  async function insertOrderLines(
    uow: Uow,
    input: {
      readonly orderId: string;
      readonly lines: readonly ResolvedLine[];
      readonly approvalId: string | null;
      readonly commandId: string;
      readonly siteId: string;
    },
  ): Promise<ReadonlySet<Warning>> {
    const warnings = new Set<Warning>();
    for (const line of input.lines) {
      await uow
        .insertInto('sales_sales_order_lines')
        .values({
          id: toBin(line.id),
          order_id: toBin(input.orderId),
          line_no: line.lineNo,
          product_id: toBin(line.productId),
          product_name_snapshot: line.productName,
          quantity: String(line.input.quantity),
          unit_code: line.input.unitCode,
          quantity_base: String(line.quantityBase / 1000),
          quoted_unit_price_xaf: line.priced.unitPriceXaf,
          list_unit_price_xaf: line.priced.listUnitPriceXaf,
          price_rule_id: toBinOrNull(line.priced.priceRuleId),
          price_rule_version: line.priced.priceRuleVersion,
          price_source: line.priced.priceSource,
          override_reason_code_id: toBinOrNull(line.priced.overrideReasonCodeId),
          override_approval_request_id: line.priced.needsApproval
            ? toBinOrNull(input.approvalId)
            : null,
          line_total_xaf: line.priced.lineTotalXaf,
        })
        .execute();
      if (line.priced.needsApproval) warnings.add('PRICE_OVERRIDE_EXCEEDS_LIMIT');
      if (line.priced.priceMismatch) {
        warnings.add('PRICE_MISMATCH');
        await recordConflict(uow, {
          id: idGenerator.newId(),
          commandId: input.commandId,
          conflictType: 'PRICE_MISMATCH',
          entityType: 'SALES_ORDER',
          entityId: input.orderId,
          siteId: input.siteId,
          ownerRole: 'RESP_COMMERCIAL',
          applied: true,
          details: {
            orderLineId: line.id,
            productId: line.productId,
            declaredListUnitPriceXaf: line.priced.listUnitPriceXaf,
            serverUnitPriceXaf: line.priced.serverUnitPriceXaf,
            agreedUnitPriceXaf: line.priced.unitPriceXaf,
          },
        });
      }
    }
    return warnings;
  }

  /** Crée la commande (`DRAFT` ou `CONFIRMED`) et ses lignes à prix convenu. */
  async function createOrder(
    uow: Uow,
    envelope: Envelope<PlacePayload>,
    body: SaveDraftPayload,
    options: { readonly status: 'DRAFT' | 'CONFIRMED' },
  ) {
    const orderId = envelope.aggregate_id;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const offline = envelope.captured_offline;
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const ctx = await loadContext(uow, {
      author,
      at,
      customerId: body.customerId,
      fulfilmentLocationId: body.fulfilmentLocationId,
      channelCode: body.channelCode,
      ownerUserId: author,
    });
    if (!ctx.ok) return ctx;
    const { customer, location, site, channelCode, resource } = ctx;
    for (const id of [...new Set([body.customerId, customer.id])].sort()) {
      await lockCustomerAccount(uow, id);
    }

    const prepared = await prepareLines(uow, {
      lines: body.lines,
      author,
      at,
      offline,
      customer,
      site,
      channelCode,
      resource,
    });
    if (!prepared.ok) return prepared;

    // Validation PRICE_OVERRIDE avant les lignes (clé étrangère) ; sujet : la commande.
    const docNumber = await documentSequences.next(uow, {
      docType: 'CMD',
      siteId: site.id,
      codeSite: site.code,
      year: documentYear(at),
    });
    const approval = await requestPriceApproval(uow, {
      orderId,
      docNumber,
      lines: prepared.lines,
      site,
      zoneId: customer.zoneId,
      author,
      at,
      offline,
      origin,
    });
    if (!approval.ok) return approval;

    let commercialUserId: string | null = null;
    if (await hasCommercialRoleAt(uow, author, at)) commercialUserId = author;
    commercialUserId =
      commercialUserId ?? (await ownerOfCustomerAt(uow, customer.id, at)) ?? author;
    const totalEstimated = prepared.lines.reduce((sum, line) => sum + line.priced.lineTotalXaf, 0);
    await uow
      .insertInto('sales_sales_orders')
      .values({
        id: toBin(orderId),
        doc_number: docNumber,
        local_ref: body.localRef ?? null,
        site_id: toBin(site.id),
        customer_id: toBin(body.customerId),
        commercial_user_id: toBin(commercialUserId),
        channel_code: channelCode,
        fulfilment_location_id: toBin(location.id),
        requested_delivery_date: body.requestedDeliveryDate
          ? sql<Date>`${body.requestedDeliveryDate}`
          : null,
        delivery_address: body.deliveryAddress ?? null,
        status: options.status,
        total_estimated_xaf: totalEstimated,
        confirmed_at: options.status === 'CONFIRMED' ? at : null,
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
    const warnings = await insertOrderLines(uow, {
      orderId,
      lines: prepared.lines,
      approvalId: approval.approvalId,
      commandId: envelope.command_id,
      siteId: site.id,
    });
    return { ok: true as const, docNumber, customer, location, site, origin, warnings };
  }

  const saveDraft: CommandHandler<SaveDraftPayload> = async (uow, envelope) => {
    const existing = await uow
      .selectFrom('sales_sales_orders')
      .select('doc_number')
      .where('id', '=', toBin(envelope.aggregate_id))
      .executeTakeFirst();
    if (existing) return { status: 'APPLIED', serverRefs: { docNumber: existing.doc_number } };
    // Brouillon de bureau, en ligne seulement (D04 UC-VEN-02, SM-ORDER) : hors ligne, `place`.
    if (envelope.captured_offline) {
      return rejected(
        'ONLINE_REQUIRED',
        'Un brouillon de commande se prépare en ligne ; hors ligne, confirmer la commande.',
      );
    }
    try {
      const created = await createOrder(uow, envelope, envelope.payload, { status: 'DRAFT' });
      if (!created.ok) return created.outcome;
      return { status: 'APPLIED', serverRefs: { docNumber: created.docNumber } };
    } catch (error) {
      return businessRejection(error);
    }
  };

  /** Confirme la commande (déjà insérée) : acomptes, vente du disponible, statut. */
  async function confirmAndRefresh(
    uow: Uow,
    envelope: Envelope<unknown>,
    input: {
      readonly orderId: string;
      /** Compte conservé du client (conditions de crédit, zone). */
      readonly customer: CustomerSummary;
      readonly at: Date;
      readonly advance: PlacePayload['advancePayments'];
    },
  ): Promise<
    | {
        readonly ok: true;
        readonly confirmation: Extract<OrderConfirmationResult, { ok: true }>;
        readonly warnings: ReadonlySet<'PAYMENT_SUSPECT_DUPLICATE'>;
        readonly paymentDocs: ReadonlyMap<number, string>;
      }
    | { readonly ok: false; readonly outcome: ReturnType<typeof rejected> }
  > {
    const author = envelope.author_user_id;
    const offline = envelope.captured_offline;
    const locked = await lockOrder(uow, input.orderId);
    if (!locked) return { ok: false, outcome: NOT_FOUND };
    const location = await findStockLocation(uow, fromBin(locked.order.fulfilment_location_id));
    const site = location?.siteId ? await loadSite(uow, location.siteId) : undefined;
    if (!location || !site) {
      return {
        ok: false,
        outcome: rejected('REFERENCE_INVALID', 'Emplacement de préparation inconnu.'),
      };
    }
    const origin = await loadCommandOrigin(uow, envelope.command_id);

    // Acomptes joints : planifiés (références, comptes, doublons) puis écrits, affectés à la commande.
    const warnings = new Set<'PAYMENT_SUSPECT_DUPLICATE'>();
    let paymentDocs: ReadonlyMap<number, string> = new Map();
    if (input.advance !== undefined && input.advance.length > 0) {
      const plan = await planPayments(
        uow,
        deps,
        {
          at: input.at,
          offline,
          userId: author,
          siteId: site.id,
          atPointOfSale: location.locationType === 'POS',
          customerId: fromBin(locked.order.customer_id),
        },
        input.advance,
      );
      if (!plan.ok) return { ok: false, outcome: plan.outcome as ReturnType<typeof rejected> };
      const written = await writeAdvancePayments(
        uow,
        deps,
        {
          envelope,
          origin,
          at: input.at,
          offline,
          userId: author,
          orderId: input.orderId,
          customerId: fromBin(locked.order.customer_id),
          site,
          zoneId: input.customer.zoneId,
        },
        plan.planned,
      );
      if (written.rejection) {
        return { ok: false, outcome: written.rejection as ReturnType<typeof rejected> };
      }
      for (const warning of written.warnings) warnings.add(warning);
      paymentDocs = written.docNumbers;
    }

    // Vente du disponible : la commande est relue (acompte, compteurs) avant la confirmation.
    const fresh = await lockOrder(uow, input.orderId);
    if (!fresh) return { ok: false, outcome: NOT_FOUND };
    const confirmation = await confirmOrderPending(uow, {
      deps,
      order: fresh.order,
      orderLines: fresh.lines,
      site,
      location,
      customer: input.customer,
      actorUserId: author,
      at: input.at,
      offline,
      origin,
      commandId: envelope.command_id,
      clientCreatedAt: new Date(envelope.client_created_at),
      backdatedReason: envelope.backdated_reason,
    });
    if (!confirmation.ok)
      return { ok: false, outcome: confirmation.outcome as ReturnType<typeof rejected> };
    const refreshed = await refreshOrderStatus(uow, input.orderId);
    const statusChanged = refreshed.status !== fresh.order.status;
    await uow
      .updateTable('sales_sales_orders')
      .set((eb) => ({
        status: refreshed.status,
        confirmed_at: fresh.order.confirmed_at ?? input.at,
        // La confirmation d'un brouillon est une modification ; la progression des ventes n'en est pas une.
        ...(statusChanged ? { version: eb('version', '+', 1) } : {}),
      }))
      .where('id', '=', toBin(input.orderId))
      .execute();
    return { ok: true, confirmation, warnings, paymentDocs };
  }

  /** Verrou de la commande, puis portée de l'**auteur** de la commande (ou son responsable). */
  async function loadOrderForCommand(
    uow: Uow,
    input: {
      readonly orderId: string;
      readonly author: string;
      readonly at: Date;
      readonly permissionCode: string;
    },
  ) {
    const locked = await lockOrder(uow, input.orderId);
    if (!locked) return { ok: false as const, outcome: NOT_FOUND };
    const site = await loadSite(uow, fromBin(locked.order.site_id));
    if (!site) {
      return {
        ok: false as const,
        outcome: rejected('REFERENCE_INVALID', 'Site de la commande inconnu.'),
      };
    }
    const access = await evaluateAccess(uow, {
      userId: input.author,
      permissionCode: input.permissionCode,
      occurredAt: input.at,
      resource: {
        ownerUserId: fromBin(locked.order.created_by),
        siteId: site.id,
        zoneId: site.zoneId,
      },
    });
    if (!access.allowed) return { ok: false as const, outcome: FORBIDDEN_SCOPE };
    return { ok: true as const, locked, site };
  }

  const place: CommandHandler<PlacePayload> = async (uow, envelope) => {
    const orderId = envelope.aggregate_id;
    const existing = await uow
      .selectFrom('sales_sales_orders')
      .select(['doc_number', 'status'])
      .where('id', '=', toBin(orderId))
      .executeTakeFirst();
    if (existing && existing.status !== 'DRAFT') {
      // Déjà confirmée sous cet identifiant : la même intention n'a plus d'effet ; des acomptes
      // joints ne seraient ni encaissés ni affectés, et une commande annulée ne se reconfirme pas.
      if (existing.status === 'CANCELLED') {
        return rejected('ORDER_ALREADY_CANCELLED', 'Cette commande est annulée.');
      }
      if ((envelope.payload.advancePayments ?? []).length > 0) {
        return rejected(
          'ORDER_STATUS_INVALID',
          'Commande déjà confirmée : enregistrer l’acompte comme un encaissement.',
        );
      }
      return { status: 'APPLIED', serverRefs: { docNumber: existing.doc_number } };
    }
    try {
      const at = new Date(envelope.occurred_at);
      const p = envelope.payload;
      let docNumber: string;
      let customer: CustomerSummary;
      const warnings = new Set<Warning>();
      if (existing) {
        // Confirmation d'un brouillon : ses lignes et ses prix sont ceux de la saisie (AV-148).
        const ctx = await loadOrderForCommand(uow, {
          orderId,
          author: envelope.author_user_id,
          at,
          permissionCode: 'sales.order.create',
        });
        if (!ctx.ok) return ctx.outcome;
        // Statut relu sous verrou : une annulation ou une autre confirmation a pu passer entre-temps.
        if (ctx.locked.order.status === 'CANCELLED') {
          return rejected('ORDER_ALREADY_CANCELLED', 'Cette commande est annulée.');
        }
        if (ctx.locked.order.status !== 'DRAFT') {
          return rejected('ORDER_STATUS_INVALID', 'Ce brouillon a déjà été confirmé.');
        }
        const found = await getCustomer(uow, fromBin(ctx.locked.order.customer_id));
        if (!found) return rejected('CUSTOMER_UNKNOWN', 'Client inconnu.');
        const kept = await keptCustomerOf(uow, found);
        if (!kept) return rejected('CUSTOMER_UNKNOWN', 'Compte conservé du client introuvable.');
        customer = kept;
        docNumber = existing.doc_number;
        for (const id of [...new Set([found.id, kept.id])].sort())
          await lockCustomerAccount(uow, id);
      } else {
        if (p.lines === undefined) {
          return rejected('LINE_INVALID', 'Une commande comporte au moins une ligne.');
        }
        const created = await createOrder(
          uow,
          envelope,
          { ...p, lines: p.lines },
          { status: 'CONFIRMED' },
        );
        if (!created.ok) return created.outcome;
        docNumber = created.docNumber;
        customer = created.customer;
        for (const warning of created.warnings) warnings.add(warning);
      }
      const outcome = await confirmAndRefresh(uow, envelope, {
        orderId,
        customer,
        at,
        advance: p.advancePayments,
      });
      if (!outcome.ok) return outcome.outcome;
      for (const warning of outcome.warnings) warnings.add(warning);
      const serverRefs: Record<string, string> = { docNumber };
      if (outcome.confirmation.sale)
        serverRefs['saleDocNumber'] = outcome.confirmation.sale.docNumber;
      for (const [index, number] of outcome.paymentDocs) serverRefs[`payment${index + 1}`] = number;
      return warnings.size > 0
        ? { status: 'APPLIED_WITH_WARNINGS', warnings: [...warnings], serverRefs }
        : { status: 'APPLIED', serverRefs };
    } catch (error) {
      return businessRejection(error);
    }
  };

  const confirmRemaining: CommandHandler<z.infer<typeof emptySchema>> = async (uow, envelope) => {
    try {
      const at = new Date(envelope.occurred_at);
      const ctx = await loadOrderForCommand(uow, {
        orderId: envelope.aggregate_id,
        author: envelope.author_user_id,
        at,
        permissionCode: 'sales.order.create',
      });
      if (!ctx.ok) return ctx.outcome;
      const { order } = ctx.locked;
      if (!['CONFIRMED', 'PARTIALLY_FULFILLED'].includes(order.status)) {
        return rejected('ORDER_STATUS_INVALID', 'Cette commande n’attend plus de confirmation.');
      }
      const found = await getCustomer(uow, fromBin(order.customer_id));
      if (!found) return rejected('CUSTOMER_UNKNOWN', 'Client inconnu.');
      const kept = await keptCustomerOf(uow, found);
      if (!kept) return rejected('CUSTOMER_UNKNOWN', 'Compte conservé du client introuvable.');
      for (const id of [...new Set([found.id, kept.id])].sort()) await lockCustomerAccount(uow, id);
      const outcome = await confirmAndRefresh(uow, envelope, {
        orderId: envelope.aggregate_id,
        customer: (await getCustomer(uow, kept.id)) ?? kept,
        at,
        advance: undefined,
      });
      if (!outcome.ok) return outcome.outcome;
      return {
        status: 'APPLIED',
        serverRefs: outcome.confirmation.sale
          ? { docNumber: order.doc_number, saleDocNumber: outcome.confirmation.sale.docNumber }
          : { docNumber: order.doc_number },
      };
    } catch (error) {
      return businessRejection(error);
    }
  };

  // --- Modification (BR-VEN-005, AV-130) ---------------------------------------------------------------------

  /** Deux modifications concurrentes : quarantaine, la commande n'est pas modifiée (matrice des conflits). */
  async function quarantineStale(
    uow: Uow,
    envelope: Envelope<UpdatePayload>,
    order: OrderRow,
    site: SiteRef,
  ): Promise<CommandHandlerOutcome> {
    const conflictId = idGenerator.newId();
    await recordConflict(uow, {
      id: conflictId,
      commandId: envelope.command_id,
      conflictType: 'VERSION_CONFLICT',
      entityType: 'SALES_ORDER',
      entityId: envelope.aggregate_id,
      siteId: site.id,
      ownerRole: 'RESP_COMMERCIAL',
      applied: false,
      details: {
        commandType: envelope.command_type,
        baseVersion: envelope.base_version,
        serverVersion: order.version,
        payload: envelope.payload,
      },
    });
    return { status: 'CONFLICT', conflictId };
  }

  const update: CommandHandler<UpdatePayload> = async (uow, envelope) => {
    try {
      const orderId = envelope.aggregate_id;
      const p = envelope.payload;
      const author = envelope.author_user_id;
      const at = new Date(envelope.occurred_at);
      const offline = envelope.captured_offline;
      const ctx = await loadOrderForCommand(uow, {
        orderId,
        author,
        at,
        permissionCode: 'sales.order.create',
      });
      if (!ctx.ok) return ctx.outcome;
      const { site } = ctx;
      const { order, lines } = ctx.locked;
      // Modifiable tant qu'aucune livraison n'a eu lieu : `CONFIRMED` (D04 BR-VEN-005, SM-ORDER).
      if (order.status !== 'CONFIRMED') {
        return rejected(
          'ORDER_NOT_MODIFIABLE',
          'Commande non modifiable : elle est livrée en partie ou terminée, ou pas encore confirmée.',
        );
      }
      if (envelope.base_version !== null && envelope.base_version !== order.version) {
        return quarantineStale(uow, envelope, order, site);
      }
      const origin = await loadCommandOrigin(uow, envelope.command_id);

      // --- Lieu, date, adresse -----------------------------------------------------------------------
      const patch: {
        fulfilment_location_id?: Buffer;
        requested_delivery_date?: ReturnType<typeof sql<Date>> | null;
        delivery_address?: string | null;
      } = {};
      if (
        p.fulfilmentLocationId !== undefined &&
        p.fulfilmentLocationId !== fromBin(order.fulfilment_location_id)
      ) {
        const location = await findStockLocation(uow, p.fulfilmentLocationId);
        if (!location || location.isVirtual || location.siteId !== site.id) {
          return rejected(
            'REFERENCE_INVALID',
            'Emplacement de préparation inconnu, virtuel ou d’un autre site.',
          );
        }
        if (!ORDER_LOCATION_TYPES.includes(location.locationType)) {
          return rejected('LOCATION_NOT_SELLABLE', 'Emplacement de préparation non autorisé.');
        }
        if (location.custodyMode === 'EXCLUSIVE_USER' && location.custodianUserId !== author) {
          return FORBIDDEN_SCOPE;
        }
        patch.fulfilment_location_id = toBin(location.id);
      }
      // Une valeur identique à l'existant n'est pas une modification (NOTHING_TO_UPDATE).
      const current = await uow
        .selectFrom('sales_sales_orders')
        .select([
          sql<string | null>`DATE_FORMAT(requested_delivery_date, '%Y-%m-%d')`.as('date'),
          'delivery_address',
        ])
        .where('id', '=', order.id)
        .executeTakeFirstOrThrow();
      if (p.requestedDeliveryDate !== undefined && p.requestedDeliveryDate !== current.date) {
        patch.requested_delivery_date =
          p.requestedDeliveryDate === null ? null : sql<Date>`${p.requestedDeliveryDate}`;
      }
      if (p.deliveryAddress !== undefined && p.deliveryAddress !== current.delivery_address) {
        patch.delivery_address = p.deliveryAddress;
      }

      // --- Quantités des lignes existantes (AV-130) ------------------------------------------------------
      const byId = new Map(lines.map((line) => [fromBin(line.id), line]));
      const seen = new Set<string>();
      const retirements: LineRetirement[] = [];
      const increases: { line: OrderLineRow; newQuantity: number; newBaseMilli: number }[] = [];
      const newOrderedMilli = new Map<string, number>(
        lines.map((line) => [fromBin(line.id), milliOf(line.quantity_base)]),
      );
      for (const entry of p.lines ?? []) {
        const line = byId.get(entry.orderLineId);
        if (!line) return rejected('ORDER_LINE_UNKNOWN', 'Ligne de commande inconnue.');
        if (seen.has(entry.orderLineId)) {
          return rejected('LINE_INVALID', 'Une même ligne de commande est citée deux fois.');
        }
        seen.add(entry.orderLineId);
        const targetMilli = quantityMilliUnits(quantityFromDecimal(entry.quantityBase));
        const currentMilli = milliOf(line.quantity_base);
        if (targetMilli === currentMilli) continue;
        if (targetMilli === 0) {
          // 0 retire la ligne (D04 §15) : aucune conversion d'unité à contrôler.
          if (entry.quantity !== 0) {
            return rejected(
              'QUANTITY_BASE_MISMATCH',
              'Quantité en unité de base incohérente avec la quantité saisie.',
            );
          }
        } else {
          const checked = await checkLineQuantity(uow, {
            productId: fromBin(line.product_id),
            unitCode: line.unit_code,
            quantity: entry.quantity,
            quantityBase: entry.quantityBase,
            offline,
            requireSellable: targetMilli > currentMilli,
          });
          if (!checked.ok) return checked.outcome;
        }
        const { retirement, addMilli } = retirementToTarget(line, targetMilli);
        newOrderedMilli.set(entry.orderLineId, targetMilli);
        if (addMilli > 0) {
          increases.push({ line, newQuantity: entry.quantity, newBaseMilli: targetMilli });
        } else {
          retirements.push(retirement);
        }
      }

      // --- Lignes ajoutées (nouveaux produits) -----------------------------------------------------------
      const found = await getCustomer(uow, fromBin(order.customer_id));
      if (!found) return rejected('CUSTOMER_UNKNOWN', 'Client inconnu.');
      const kept = await keptCustomerOf(uow, found);
      if (!kept) return rejected('CUSTOMER_UNKNOWN', 'Compte conservé du client introuvable.');
      let added: readonly ResolvedLine[] = [];
      if (p.addedLines !== undefined && p.addedLines.length > 0) {
        const prepared = await prepareLines(uow, {
          lines: p.addedLines,
          author,
          at,
          offline,
          customer: kept,
          site,
          channelCode: order.channel_code,
          resource: {
            ownerUserId: fromBin(order.created_by),
            siteId: site.id,
            zoneId: site.zoneId,
          },
          firstLineNo: Math.max(0, ...lines.map((line) => line.line_no)) + 1,
        });
        if (!prepared.ok) return prepared.outcome;
        added = prepared.lines;
      }

      const contentChanged = retirements.length > 0 || increases.length > 0 || added.length > 0;
      if (!contentChanged && Object.keys(patch).length === 0) {
        return rejected('NOTHING_TO_UPDATE', 'Aucune modification à appliquer.');
      }
      const remainingTotal =
        [...newOrderedMilli.values()].reduce((sum, value) => sum + value, 0) +
        added.reduce((sum, line) => sum + quantityMilliUnits(line.quantityBase), 0);
      if (remainingTotal <= 0) {
        return rejected(
          'ORDER_EMPTY',
          'La modification retirerait toute la commande : l’annuler (sales.order.cancel).',
        );
      }

      // --- Application : contre-écritures, compteurs, hausses, lignes ajoutées ---------------------------
      const cancelled = await cancelOrderUndelivered(uow, deps, {
        order,
        retirements,
        cause: 'ORDER_ADJUSTMENT',
        reasonCodeId: null,
        comment: null,
        site,
        appliedAt: at,
        treatment: p.paymentTreatment ?? null,
        actorUserId: author,
        origin,
        commandId: envelope.command_id,
        clientCreatedAt: new Date(envelope.client_created_at),
        backdatedReason: envelope.backdated_reason,
        offline,
      });
      if (!cancelled.ok) return cancelled.outcome;
      await retireOrderLines(uow, retirements);
      for (const increase of increases) {
        await uow
          .updateTable('sales_sales_order_lines')
          .set({
            quantity: String(increase.newQuantity),
            quantity_base: String(increase.newBaseMilli / 1000),
            line_total_xaf: lineAmountXaf(
              quantityFromMilli(increase.newBaseMilli),
              xaf(Number(increase.line.quoted_unit_price_xaf)),
            ),
          })
          .where('id', '=', increase.line.id)
          .execute();
      }
      const warnings = new Set<Warning>();
      if (added.length > 0) {
        const approval = await requestPriceApproval(uow, {
          orderId,
          docNumber: order.doc_number,
          lines: added,
          site,
          zoneId: kept.zoneId,
          author,
          at,
          offline,
          origin,
        });
        if (!approval.ok) return approval.outcome;
        for (const warning of await insertOrderLines(uow, {
          orderId,
          lines: added,
          approvalId: approval.approvalId,
          commandId: envelope.command_id,
          siteId: site.id,
        })) {
          warnings.add(warning);
        }
      }

      // --- Vente complémentaire du disponible pour les hausses et les lignes ajoutées (AV-130, AV-127) -------
      let saleDocNumber: string | undefined;
      const toSell = new Set<string>([
        ...increases.map((increase) => fromBin(increase.line.id)),
        ...added.map((line) => line.id),
      ]);
      if (toSell.size > 0) {
        for (const id of [...new Set([found.id, kept.id])].sort())
          await lockCustomerAccount(uow, id);
        const fresh = await lockOrder(uow, orderId);
        const location = await findStockLocation(
          uow,
          fromBin(patch.fulfilment_location_id ?? order.fulfilment_location_id),
        );
        if (!fresh || !location) return NOT_FOUND;
        const confirmation = await confirmOrderPending(uow, {
          deps,
          order: fresh.order,
          orderLines: fresh.lines,
          site,
          location,
          customer: (await getCustomer(uow, kept.id)) ?? kept,
          actorUserId: author,
          at,
          offline,
          origin,
          commandId: envelope.command_id,
          clientCreatedAt: new Date(envelope.client_created_at),
          backdatedReason: envelope.backdated_reason,
          onlyOrderLineIds: toSell,
        });
        if (!confirmation.ok) return confirmation.outcome;
        saleDocNumber = confirmation.sale?.docNumber;
      }

      // --- Commande : montant estimé, statut, version ------------------------------------------------------
      const refreshed = await refreshOrderStatus(uow, orderId);
      const total = refreshed.lines.reduce((sum, line) => sum + Number(line.line_total_xaf), 0);
      await uow
        .updateTable('sales_sales_orders')
        .set((eb) => ({
          ...patch,
          status: refreshed.status,
          total_estimated_xaf: total,
          updated_by: toBin(author),
          version: eb('version', '+', 1),
        }))
        .where('id', '=', toBin(orderId))
        .execute();

      const serverRefs: Record<string, string> = { docNumber: order.doc_number };
      if (saleDocNumber !== undefined) serverRefs['saleDocNumber'] = saleDocNumber;
      cancelled.documents.forEach((doc: CancellationDocument, index: number) => {
        serverRefs[`cancellation${index + 1}`] = doc.docNumber;
      });
      const audit = {
        before: {
          lines: lines.map((line) => ({
            orderLineId: fromBin(line.id),
            quantityBase: Number(line.quantity_base),
          })),
          fulfilmentLocationId: fromBin(order.fulfilment_location_id),
          version: order.version,
        },
        after: {
          lines: refreshed.lines.map((line) => ({
            orderLineId: fromBin(line.id),
            quantityBase: Number(line.quantity_base),
          })),
          fulfilmentLocationId: fromBin(
            patch.fulfilment_location_id ?? order.fulfilment_location_id,
          ),
          version: order.version + 1,
        },
      };
      return warnings.size > 0
        ? { status: 'APPLIED_WITH_WARNINGS', warnings: [...warnings], serverRefs, audit }
        : { status: 'APPLIED', serverRefs, audit };
    } catch (error) {
      return businessRejection(error);
    }
  };

  // --- Annulation et clôture du reste (AV-128) -----------------------------------------------------------------

  /**
   * Retire tout ce qui n'est pas livré : l'attente, puis le vendu non livré par contre-écriture
   * (cause `ORDER_CANCELLATION` ou `ORDER_CLOSURE`) ; libère l'acompte encore affecté à la commande ;
   * la commande passe `CANCELLED` (rien livré) ou `CLOSED` (une part livrée).
   */
  async function retireRemainder(
    uow: Uow,
    envelope: Envelope<RetirePayload>,
    mode: 'CANCEL' | 'CLOSE',
  ): Promise<CommandHandlerOutcome> {
    const p = envelope.payload;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const offline = envelope.captured_offline;
    const ctx = await loadOrderForCommand(uow, {
      orderId: envelope.aggregate_id,
      author,
      at,
      permissionCode: 'sales.order.cancel',
    });
    if (!ctx.ok) return ctx.outcome;
    const { site } = ctx;
    const { order, lines } = ctx.locked;
    if (mode === 'CANCEL') {
      if (order.status === 'CANCELLED') {
        return rejected('ORDER_ALREADY_CANCELLED', 'Cette commande est déjà annulée.');
      }
      if (order.status === 'PARTIALLY_FULFILLED') {
        return rejected(
          'CANCELLATION_EXCEEDS_UNDELIVERED',
          'Une livraison a eu lieu : clôturer le reste de la commande (sales.order.close_remaining).',
        );
      }
      if (!['DRAFT', 'CONFIRMED'].includes(order.status)) {
        return rejected('ORDER_STATUS_INVALID', 'Cette commande ne peut plus être annulée.');
      }
    } else if (order.status !== 'PARTIALLY_FULFILLED') {
      return rejected(
        'ORDER_STATUS_INVALID',
        order.status === 'CONFIRMED' || order.status === 'DRAFT'
          ? 'Aucune livraison : annuler la commande (sales.order.cancel).'
          : 'Cette commande n’a plus de reste à clôturer.',
      );
    }
    if (p.reasonCodeId === undefined && p.comment === undefined) {
      return rejected('REASON_REQUIRED', 'Un motif est exigé : code motif ou commentaire.');
    }
    let reasonLabel: string | null = null;
    if (p.reasonCodeId !== undefined) {
      const reason = await findReasonCode(uow, p.reasonCodeId);
      if (!reason) return rejected('REFERENCE_INVALID', 'Motif inconnu.');
      reasonLabel = reason.label;
    }
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const treatment: PaymentTreatment | null = p.paymentTreatment ?? null;

    const retirements = lines.map((line) => fullRetirement(line));
    const cancelled = await cancelOrderUndelivered(uow, deps, {
      order,
      retirements,
      cause: mode === 'CANCEL' ? 'ORDER_CANCELLATION' : 'ORDER_CLOSURE',
      reasonCodeId: p.reasonCodeId ?? null,
      comment: p.comment ?? null,
      site,
      appliedAt: at,
      treatment,
      actorUserId: author,
      origin,
      commandId: envelope.command_id,
      clientCreatedAt: new Date(envelope.client_created_at),
      backdatedReason: envelope.backdated_reason,
      offline,
    });
    if (!cancelled.ok) return cancelled.outcome;
    await retireOrderLines(uow, retirements);
    const advance = await releaseOrderAdvance(uow, deps, {
      orderId: envelope.aggregate_id,
      cause: mode === 'CANCEL' ? 'ORDER_CANCELLED' : 'ORDER_CLOSED',
      treatment,
      at,
      actorUserId: author,
      deviceId: origin.deviceId,
      commandId: envelope.command_id,
      offline,
    });
    if (!advance.ok) return advance.outcome;

    const refreshed = await refreshOrderStatus(uow, envelope.aggregate_id, {
      remainderCancelled: true,
    });
    const expected = mode === 'CANCEL' ? 'CANCELLED' : 'CLOSED';
    if (refreshed.status !== expected) {
      throw new Error(
        `Commande ${order.doc_number} : statut dérivé ${refreshed.status} au lieu de ${expected} (compteurs de lignes incohérents).`,
      );
    }
    const total = refreshed.lines.reduce((sum, line) => sum + Number(line.line_total_xaf), 0);
    const closedReason = p.comment ?? reasonLabel;
    await uow
      .updateTable('sales_sales_orders')
      .set((eb) => ({
        status: expected,
        total_estimated_xaf: total,
        advance_paid_xaf: eb('advance_paid_xaf', '-', advance.releasedXaf),
        updated_by: toBin(author),
        version: eb('version', '+', 1),
        ...(advance.treatment !== null ? { released_payment_treatment: advance.treatment } : {}),
        ...(mode === 'CANCEL'
          ? {
              cancelled_at: at,
              cancelled_by: toBin(author),
              cancel_reason_code_id: toBinOrNull(p.reasonCodeId ?? null),
              cancel_comment: p.comment ?? null,
            }
          : { closed_at: at, closed_by: toBin(author), closed_reason: closedReason }),
      }))
      .where('id', '=', toBin(envelope.aggregate_id))
      .execute();

    const serverRefs: Record<string, string> = { docNumber: order.doc_number };
    cancelled.documents.forEach((doc: CancellationDocument, index: number) => {
      serverRefs[`cancellation${index + 1}`] = doc.docNumber;
    });
    return { status: 'APPLIED', serverRefs };
  }

  const cancel: CommandHandler<RetirePayload> = async (uow, envelope) => {
    try {
      return await retireRemainder(uow, envelope, 'CANCEL');
    } catch (error) {
      return businessRejection(error);
    }
  };

  const closeRemaining: CommandHandler<RetirePayload> = async (uow, envelope) => {
    try {
      return await retireRemainder(uow, envelope, 'CLOSE');
    } catch (error) {
      return businessRejection(error);
    }
  };

  return { saveDraft, place, confirmRemaining, update, cancel, closeRemaining };
}

export function registerOrderCommands(
  registry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  const handlers = buildHandlers(idGenerator, documentSequences);
  registry.register({
    commandType: 'sales.order.save_draft',
    version: 1,
    payloadSchema: saveDraftSchema,
    permissionCode: 'sales.order.create',
    handler: handlers.saveDraft,
  });
  registry.register({
    commandType: 'sales.order.place',
    version: 1,
    payloadSchema: placeSchema,
    permissionCode: 'sales.order.create',
    handler: handlers.place,
  });
  registry.register({
    commandType: 'sales.order.confirm_remaining',
    version: 1,
    payloadSchema: emptySchema,
    permissionCode: 'sales.order.create',
    handler: handlers.confirmRemaining,
  });
  registry.register({
    commandType: 'sales.order.update',
    version: 1,
    payloadSchema: updateSchema,
    permissionCode: 'sales.order.create',
    handler: handlers.update,
  });
  registry.register({
    commandType: 'sales.order.cancel',
    version: 1,
    payloadSchema: retireSchema,
    permissionCode: 'sales.order.cancel',
    handler: handlers.cancel,
  });
  registry.register({
    commandType: 'sales.order.close_remaining',
    version: 1,
    payloadSchema: retireSchema,
    permissionCode: 'sales.order.cancel',
    handler: handlers.closeRemaining,
  });
}
