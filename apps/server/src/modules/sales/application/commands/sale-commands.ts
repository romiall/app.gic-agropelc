/**
 * Ventes directes (D04-VEN §7.2 ; UC-VEN-01, UC-VEN-09) : `sales.sale.record`, **hors ligne
 * possible**. Une vente naît `CONFIRMED` : c'est un fait accompli (BR-VEN-011), immuable
 * (BR-VEN-012). Une vente saisie hors ligne n'est jamais rejetée pour un état métier (stock, prix,
 * produit désactivé, lot non vendable, crédit, doublon de paiement : BR-SYN-007) ; elle est
 * appliquée avec une anomalie à traiter. Les refus restent réservés à la validité (références
 * inconnues, montants incohérents) et à l'autorisation.
 *
 * Effets, dans une seule transaction : sortie de stock par lot (FIFO) et coût figé par ligne,
 * chiffre d'affaires daté de l'heure réelle, encaissements joints affectés à la vente, reste dû et
 * échéance, attribution (vendeur, commercial, canal, zone, session de travail), conversion du
 * prospect. Détail des anomalies : `sale-pricing.ts`, `sale-stock.ts`, `sale-payments.ts`.
 *
 * Ordre d'écriture (verrous pris dans un ordre constant pour éviter les interblocages entre ventes) :
 * compte client → stock (lignes triées par produit) → numéro de vente → demandes de validation →
 * vente et lignes → mouvements de trésorerie (comptes par identifiant) → numéros et encaissements →
 * conversion.
 */
import { sql } from 'kysely';
import {
  checkSaleCustomer,
  creditCheck,
  dueDateOf,
  quantityToDecimal,
  saleTotals,
  unitCostXaf,
  xaf,
  type IdGenerator,
} from '@gic/domain';
import type { WarningCode } from '@gic/contracts';
import type {
  CommandHandler,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import { recordConflict } from '../../../../platform/sync/conflicts.js';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { requestApproval } from '../../../approvals/application/public/index.js';
import { findSalesChannel } from '../../../catalog/application/public/index.js';
import {
  convertOnConfirmedSale,
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
  hasPermissionAt,
  type ResourceLocator,
} from '../../../identity/application/public/index.js';
import {
  findStockLocation,
  virtualLocationId,
} from '../../../inventory/application/public/index.js';
import { customerOutstandingXaf } from '../public/receivables.js';
import {
  CONTROL_POLICY_MISSING,
  FORBIDDEN_SCOPE,
  activePolicy,
  businessRejection,
  documentYear,
  loadSite,
  numberSetting,
  rejected,
  type Uow,
} from './shared.js';
import { recordSalePayloadSchema, type RecordSalePayload } from './sale-payload.js';
import { discountCeilingPct } from './sale-pricing.js';
import { resolveSaleLines } from './sale-lines.js';
import { planPayments, writePayments } from './sale-payments.js';
import { moveSoldStock } from './sale-stock.js';

/** Types d'emplacement depuis lesquels une vente directe est possible (BR-VEN-017). */
const SALE_LOCATION_TYPES: readonly string[] = ['POS', 'MOBILE', 'BUILDING', 'PEN'];

/** Rôle responsable du stock d'un emplacement, qui résout `STOCK_NEGATIVE` (AV-142, DÉDUIT). */
function stockOwnerRole(locationType: string, siteType: string): string {
  if (locationType === 'MOBILE') return 'RESP_COMMERCIAL';
  return siteType === 'FERME' ? 'RESP_FERME' : 'MAGASINIER';
}

/** Canal déduit du contexte (BR-VEN-021 ; AV-140) quand le vendeur n'en choisit pas un. */
async function deduceChannel(
  uow: Uow,
  input: {
    readonly userId: string;
    readonly at: Date;
    readonly locationType: string;
    readonly hasSession: boolean;
  },
): Promise<string> {
  if (input.locationType === 'POS') return 'POINT_DE_VENTE';
  if (input.locationType === 'MOBILE' || input.hasSession) return 'TERRAIN';
  const roles = await activeRoleCodesAt(uow, input.userId, input.at);
  return roles.includes('COMMERCIAL_SEDENTAIRE') ? 'SEDENTAIRE' : 'DIRECT';
}

function buildHandlers(idGenerator: IdGenerator, documentSequences: DocumentSequenceService) {
  const deps = { idGenerator };

  const record: CommandHandler<RecordSalePayload> = async (uow, envelope) => {
    const saleId = envelope.aggregate_id;
    const replay = await uow
      .selectFrom('sales_sales')
      .select('doc_number')
      .where('id', '=', toBin(saleId))
      .executeTakeFirst();
    if (replay) return { status: 'APPLIED', serverRefs: { docNumber: replay.doc_number } };

    try {
      return await recordNewSale(uow, envelope);
    } catch (error) {
      return businessRejection(error);
    }
  };

  async function recordNewSale(
    uow: Uow,
    envelope: Parameters<CommandHandler<RecordSalePayload>>[1],
  ): ReturnType<CommandHandler<RecordSalePayload>> {
    const saleId = envelope.aggregate_id;
    const p = envelope.payload;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const offline = envelope.captured_offline;
    const origin = await loadCommandOrigin(uow, envelope.command_id);

    // --- Emplacement source et autorisation (RC-04 : portée de l'opération) ---------------------
    const location = await findStockLocation(uow, p.fromLocationId);
    if (!location || location.isVirtual || location.siteId === null) {
      return rejected('REFERENCE_INVALID', 'Emplacement de vente inconnu, virtuel ou sans site.');
    }
    if (!SALE_LOCATION_TYPES.includes(location.locationType)) {
      return rejected(
        'LOCATION_NOT_SELLABLE',
        'Vente directe impossible depuis cet emplacement (point de vente, stock mobile ou élevage).',
      );
    }
    // Stock mobile à garde exclusive : seul son détenteur vend (RBAC §3, propriété OWN).
    if (location.custodyMode === 'EXCLUSIVE_USER' && location.custodianUserId !== author) {
      return FORBIDDEN_SCOPE;
    }
    const site = await loadSite(uow, location.siteId);
    if (!site) return rejected('REFERENCE_INVALID', 'Site de l’emplacement inconnu.');
    const resource: ResourceLocator = {
      ownerUserId: location.custodianUserId ?? author,
      siteId: site.id,
      zoneId: site.zoneId,
    };
    const access = await evaluateAccess(uow, {
      userId: author,
      permissionCode: 'sales.sale.record',
      occurredAt: at,
      resource,
    });
    if (!access.allowed) return FORBIDDEN_SCOPE;
    if (p.localRef !== undefined && origin.deviceId !== null) {
      const sameRef = await uow
        .selectFrom('sales_sales')
        .select('id')
        .where('created_device_id', '=', toBin(origin.deviceId))
        .where('local_ref', '=', p.localRef)
        .executeTakeFirst();
      if (sameRef) {
        return rejected('LOCAL_REF_DUPLICATE', 'Référence locale déjà utilisée par cet appareil.');
      }
    }

    // --- Client : compte d'origine et compte conservé (fusion), verrouillés ---------------------
    let customer: CustomerSummary | undefined;
    let kept: CustomerSummary | undefined;
    if (p.customerId !== undefined) {
      customer = await getCustomer(uow, p.customerId);
      if (!customer) return rejected('CUSTOMER_UNKNOWN', 'Client inconnu.');
      kept = customer;
      if (customer.stage === 'MERGED') {
        if (!offline) {
          return rejected(
            'CUSTOMER_MERGED',
            'Compte fusionné dans un autre compte : vendre au compte conservé (BR-CRM-007).',
          );
        }
        // Hors ligne : la vente reste sur l'identifiant d'origine (D04 §14), les conditions de
        // crédit et le titulaire sont ceux du compte conservé.
        kept = customer.mergedIntoId ? await getCustomer(uow, customer.mergedIntoId) : undefined;
        if (!kept) return rejected('CUSTOMER_UNKNOWN', 'Compte conservé du client introuvable.');
      }
      for (const id of [...new Set([customer.id, kept.id])].sort()) {
        await lockCustomerAccount(uow, id);
      }
      kept = (await getCustomer(uow, kept.id)) ?? kept;
    }

    // --- Canal, session de travail, zone (BR-VEN-021, BR-VEN-022) ---------------------------------
    const session = await findWorkSessionAt(uow, author, at);
    const flags = new Set<string>();
    const warnings = new Set<WarningCode>();
    if (session?.overrideStatus === 'REJECTED') flags.add('SESSION_REJECTED');
    if (!session && (await hasPermissionAt(uow, toBin(author), 'fieldwork.checkin.perform', at))) {
      flags.add('OUT_OF_SESSION');
    }
    const channelCode =
      p.channelCode ??
      (await deduceChannel(uow, {
        userId: author,
        at,
        locationType: location.locationType,
        hasSession: session !== undefined,
      }));
    const channel = await findSalesChannel(uow, channelCode);
    if (!channel || (!channel.isActive && !offline)) {
      return rejected('CHANNEL_UNKNOWN', 'Canal de vente inconnu ou désactivé.');
    }
    const zoneId =
      location.locationType === 'POS'
        ? site.zoneId
        : (kept?.zoneId ?? session?.declaredZoneId ?? site.zoneId);

    // --- Lignes : produit, unité, quantités, prix ---------------------------------------------
    const maxDiscountPct = await discountCeilingPct(uow, { userId: author, at, resource });
    const pricingContext = {
      at,
      offline,
      userId: author,
      resource,
      siteId: site.id,
      zoneId,
      customerCategoryId: kept?.categoryId ?? null,
      channelCode,
    };
    const resolved = await resolveSaleLines(uow, idGenerator, {
      lines: p.lines,
      offline,
      pricing: pricingContext,
      maxDiscountPct,
      flags,
    });
    if (!resolved.ok) return resolved.outcome;
    const lines = resolved.lines;
    const totals = saleTotals(
      lines.map((line) => ({
        grossXaf: xaf(line.priced.grossXaf),
        discountXaf: xaf(line.priced.discountXaf),
        lineTotalXaf: xaf(line.priced.lineTotalXaf),
      })),
    );

    // --- Encaissements joints, vente anonyme, crédit (BR-VEN-023 à 025) ----------------------------
    const payments = p.payments ?? [];
    const declaredPaid = payments.reduce((sum, payment) => sum + payment.amountXaf, 0);
    if (declaredPaid > totals.totalXaf) {
      return rejected('PAYMENT_EXCEEDS_TOTAL', 'Les paiements dépassent le total de la vente.');
    }
    const plan = await planPayments(
      uow,
      deps,
      {
        at,
        offline,
        userId: author,
        siteId: site.id,
        atPointOfSale: location.locationType === 'POS',
        customerId: customer?.id ?? null,
      },
      payments,
    );
    if (!plan.ok) return plan.outcome;
    const effectivePaid = plan.planned
      .filter((payment) => payment.status === 'RECORDED')
      .reduce((sum, payment) => sum + payment.input.amountXaf, 0);
    const anonymousUnpaid = kept === undefined && effectivePaid < totals.totalXaf;
    if (anonymousUnpaid) {
      if (!offline) {
        // Lève `ANONYMOUS_REQUIRES_FULL_PAYMENT` (AV-027) ; hors ligne, la vente est un fait (AV-137).
        checkSaleCustomer({
          hasCustomer: false,
          isOrder: false,
          totalXaf: totals.totalXaf,
          paidXaf: xaf(effectivePaid),
        });
      }
      flags.add('ANONYMOUS_UNPAID');
      warnings.add('ANONYMOUS_UNPAID');
    }

    let creditExceedsByXaf = 0;
    let dueDate: string | null = null;
    if (kept !== undefined) {
      const termsDays =
        kept.paymentTermsDays ??
        (await numberSetting(uow, 'sales.default_payment_terms_days', at, 30));
      dueDate = dueDateOf(at, termsDays);
      const newCredit = totals.totalXaf - effectivePaid;
      if (newCredit > 0) {
        const creditAccess = await evaluateAccess(uow, {
          userId: author,
          permissionCode: 'sales.credit_sale.record',
          occurredAt: at,
          resource,
        });
        if (!creditAccess.allowed) {
          return rejected(
            'CREDIT_SALE_NOT_PERMITTED',
            'Vente à crédit non autorisée pour cet utilisateur.',
          );
        }
        const check = creditCheck({
          creditAllowed: kept.creditAllowed,
          creditLimitXaf: kept.creditLimitXaf === null ? null : xaf(kept.creditLimitXaf),
          outstandingXaf: xaf(await customerOutstandingXaf(uow, kept.id)),
          newCreditXaf: xaf(newCredit),
        });
        if (check.outcome === 'NOT_ALLOWED' || check.outcome === 'EXCEEDS_LIMIT') {
          if (!offline) {
            return check.outcome === 'NOT_ALLOWED'
              ? rejected('CREDIT_NOT_ALLOWED', 'Ce client n’est pas autorisé à acheter à crédit.')
              : rejected('CREDIT_LIMIT_EXCEEDED', 'Plafond de crédit du client dépassé.');
          }
          // Hors ligne : fait accompli, validation a posteriori (AV-028, AV-143).
          creditExceedsByXaf = check.exceedsByXaf;
          flags.add('CREDIT_OVER_LIMIT');
          warnings.add('CREDIT_OVER_LIMIT');
        }
      }
    }

    // --- Attribution (BR-VEN-020) ------------------------------------------------------------------
    let commercialUserId: string | null = null;
    if (kept !== undefined) commercialUserId = await ownerOfCustomerAt(uow, kept.id, at);
    if (commercialUserId === null && (await hasCommercialRoleAt(uow, author, at))) {
      commercialUserId = author;
    }

    // --- Stock : un mouvement par lot et par ligne (le coût figé en découle) ------------------------
    const customerLocationId = await virtualLocationId(uow, 'V_CUSTOMER');
    const costs = new Map<string, { readonly costXaf: number; readonly unitCostXaf: number }>();
    // Lignes triées par produit : deux ventes qui touchent les mêmes soldes les verrouillent dans le même ordre.
    const stockOrder = [...lines].sort(
      (a, b) => a.productId.localeCompare(b.productId) || a.lineNo - b.lineNo,
    );
    for (const line of stockOrder) {
      if (line.isService) continue;
      const result = await moveSoldStock(uow, deps, {
        saleId,
        lineId: line.id,
        productId: line.productId,
        quantityBase: quantityToDecimal(line.quantityBase),
        fromLocationId: location.id,
        toLocationId: customerLocationId,
        locationType: location.locationType,
        occurredAt: at,
        createdBy: author,
        createdDeviceId: origin.deviceId,
        commandId: envelope.command_id,
        offline,
      });
      if (!result.ok) return result.outcome;
      const costXaf = result.moves.reduce((sum, move) => sum + move.valueXaf, 0);
      costs.set(line.id, { costXaf, unitCostXaf: unitCostXaf(costXaf, line.quantityBase) });
      if (result.negative) {
        flags.add('STOCK_NEGATIVE');
        warnings.add('STOCK_NEGATIVE');
        await recordConflict(uow, {
          id: idGenerator.newId(),
          commandId: envelope.command_id,
          conflictType: 'STOCK_NEGATIVE',
          entityType: 'SALE',
          entityId: saleId,
          siteId: site.id,
          ownerRole: stockOwnerRole(location.locationType, site.siteType),
          applied: true,
          details: {
            saleLineId: line.id,
            productId: line.productId,
            locationId: location.id,
            balancesAfter: result.moves.map((move) => move.fromBalanceAfter),
          },
        });
      }
      if (result.lotsNotSellable.length > 0) {
        flags.add('LOT_NOT_SELLABLE');
        warnings.add('LOT_NOT_SELLABLE');
        await recordConflict(uow, {
          id: idGenerator.newId(),
          commandId: envelope.command_id,
          conflictType: 'LOT_NOT_SELLABLE',
          entityType: 'SALE',
          entityId: saleId,
          siteId: site.id,
          ownerRole: 'RESP_PRODUCTION',
          applied: true,
          details: { saleLineId: line.id, lotIds: result.lotsNotSellable },
        });
      }
    }

    // --- Numéro, validations a posteriori, vente et lignes ---------------------------------------
    const docNumber = await documentSequences.next(uow, {
      docType: 'VTE',
      siteId: site.id,
      codeSite: site.code,
      year: documentYear(at),
    });
    let priceApprovalId: string | null = null;
    const needingApproval = lines.filter((line) => line.priced.needsApproval);
    if (needingApproval.length > 0) {
      const policy = await activePolicy(
        uow,
        'PRICE_OVERRIDE',
        at,
        offline ? origin.receivedAt : undefined,
      );
      if (!policy) return CONTROL_POLICY_MISSING('PRICE_OVERRIDE');
      priceApprovalId = idGenerator.newId();
      await requestApproval(uow, {
        requestId: priceApprovalId,
        operationType: 'PRICE_OVERRIDE',
        subjectType: 'SALE',
        subjectId: saleId,
        subjectSummary: `Dérogation de prix au-delà du plafond sur la vente ${docNumber}`,
        siteId: site.id,
        zoneId,
        // Écart au prix catalogue (ou montant de la ligne sans prix catalogue) : ce que la validation engage.
        amountXaf: needingApproval.reduce(
          (sum, line) =>
            sum +
            (line.priced.listAmountXaf === null
              ? line.priced.lineTotalXaf
              : Math.max(0, line.priced.listAmountXaf - line.priced.lineTotalXaf)),
          0,
        ),
        requestedBy: author,
        requestedAt: at,
        policyId: policy.id,
        policyVersion: policy.version,
      });
      warnings.add('PRICE_OVERRIDE_EXCEEDS_LIMIT');
    }
    if (creditExceedsByXaf > 0) {
      const policy = await activePolicy(
        uow,
        'CREDIT_LIMIT_EXCEEDED',
        at,
        offline ? origin.receivedAt : undefined,
      );
      if (!policy) return CONTROL_POLICY_MISSING('CREDIT_LIMIT_EXCEEDED');
      await requestApproval(uow, {
        requestId: idGenerator.newId(),
        operationType: 'CREDIT_LIMIT_EXCEEDED',
        subjectType: 'SALE',
        subjectId: saleId,
        subjectSummary: `Plafond de crédit dépassé de ${creditExceedsByXaf} XAF sur la vente ${docNumber}`,
        siteId: site.id,
        zoneId,
        amountXaf: creditExceedsByXaf,
        requestedBy: author,
        requestedAt: at,
        policyId: policy.id,
        policyVersion: policy.version,
      });
    }
    for (const plannedPayment of plan.planned) {
      if (plannedPayment.status === 'SUSPECT_DUPLICATE') flags.add('PAYMENT_SUSPECT_DUPLICATE');
    }

    await uow
      .insertInto('sales_sales')
      .values({
        id: toBin(saleId),
        doc_number: docNumber,
        local_ref: p.localRef ?? null,
        site_id: toBin(site.id),
        sale_type: 'DIRECT',
        customer_id: toBinOrNull(customer?.id ?? null),
        customer_category_id_snapshot: toBinOrNull(kept?.categoryId ?? null),
        channel_code: channelCode,
        from_location_id: toBin(location.id),
        zone_id: toBin(zoneId),
        seller_user_id: toBin(author),
        commercial_user_id: toBinOrNull(commercialUserId),
        work_session_id: toBinOrNull(session?.id ?? null),
        lat: p.position ? String(p.position.lat) : null,
        lng: p.position ? String(p.position.lng) : null,
        accuracy_m: p.position?.accuracyM !== undefined ? String(p.position.accuracyM) : null,
        subtotal_xaf: totals.subtotalXaf,
        discount_total_xaf: totals.discountTotalXaf,
        tax_total_xaf: totals.taxTotalXaf,
        total_xaf: totals.totalXaf,
        due_date: dueDate === null ? null : sql<Date>`${dueDate}`,
        flags: jsonValue([...flags]),
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
    for (const line of lines) {
      const cost = costs.get(line.id);
      await uow
        .insertInto('sales_sale_lines')
        .values({
          id: toBin(line.id),
          sale_id: toBin(saleId),
          line_no: line.lineNo,
          product_id: toBin(line.productId),
          product_name_snapshot: line.productName,
          quantity: String(line.input.quantity),
          unit_code: line.input.unitCode,
          quantity_base: String(quantityToDecimal(line.quantityBase)),
          pricing_quantity: String(quantityToDecimal(line.pricingQuantity)),
          pricing_unit_code: line.pricingUnitCode,
          list_unit_price_xaf: line.priced.listUnitPriceXaf,
          unit_price_xaf: line.priced.unitPriceXaf,
          price_rule_id: toBinOrNull(line.priced.priceRuleId),
          price_rule_version: line.priced.priceRuleVersion,
          price_specificity: line.priced.priceSpecificity,
          price_source: line.priced.priceSource,
          override_reason_code_id: toBinOrNull(line.priced.overrideReasonCodeId),
          override_approval_request_id: line.priced.needsApproval
            ? toBinOrNull(priceApprovalId)
            : null,
          discount_xaf: line.priced.discountXaf,
          line_total_xaf: line.priced.lineTotalXaf,
          unit_cost_xaf: cost?.unitCostXaf ?? null,
          cost_xaf: cost?.costXaf ?? null,
        })
        .execute();
      if (line.priced.priceMismatch) {
        await recordConflict(uow, {
          id: idGenerator.newId(),
          commandId: envelope.command_id,
          conflictType: 'PRICE_MISMATCH',
          entityType: 'SALE',
          entityId: saleId,
          siteId: site.id,
          ownerRole: 'RESP_COMMERCIAL',
          applied: true,
          details: {
            saleLineId: line.id,
            productId: line.productId,
            declaredListUnitPriceXaf: line.priced.listUnitPriceXaf,
            serverUnitPriceXaf: line.priced.serverUnitPriceXaf,
            appliedUnitPriceXaf: line.priced.unitPriceXaf,
          },
        });
        warnings.add('PRICE_MISMATCH');
      }
      if (line.productInactive) {
        await recordConflict(uow, {
          id: idGenerator.newId(),
          commandId: envelope.command_id,
          conflictType: 'PRODUCT_INACTIVE',
          entityType: 'SALE',
          entityId: saleId,
          siteId: site.id,
          ownerRole: 'ADMIN',
          applied: true,
          details: { saleLineId: line.id, productId: line.productId },
        });
        warnings.add('PRODUCT_INACTIVE');
      }
    }
    if (anonymousUnpaid) {
      await recordConflict(uow, {
        id: idGenerator.newId(),
        commandId: envelope.command_id,
        conflictType: 'ANONYMOUS_UNPAID',
        entityType: 'SALE',
        entityId: saleId,
        siteId: site.id,
        ownerRole: 'FINANCE',
        applied: true,
        details: { totalXaf: totals.totalXaf, paidXaf: effectivePaid },
      });
    }

    // --- Trésorerie et encaissements, puis compteurs de la vente en un seul UPDATE --------------------
    const written = await writePayments(
      uow,
      { idGenerator, documentSequences },
      {
        envelope,
        origin,
        at,
        offline,
        userId: author,
        saleId,
        customerId: customer?.id ?? null,
        site,
        zoneId,
      },
      plan.planned,
    );
    if (written.rejection) return written.rejection;
    for (const warning of written.warnings) warnings.add(warning);
    if (written.paidXaf > 0) {
      await uow
        .updateTable('sales_sales')
        .set({ amount_paid_xaf: written.paidXaf })
        .where('id', '=', toBin(saleId))
        .execute();
    }

    if (customer !== undefined) {
      await convertOnConfirmedSale(uow, {
        customerId: customer.id,
        saleId,
        saleOccurredAt: at,
        actorUserId: author,
        historyId: idGenerator.newId(),
      });
    }

    const serverRefs: Record<string, string> = { docNumber };
    for (const [index, number] of written.docNumbers) serverRefs[`payment${index + 1}`] = number;
    return warnings.size > 0
      ? { status: 'APPLIED_WITH_WARNINGS', warnings: [...warnings], serverRefs }
      : { status: 'APPLIED', serverRefs };
  }

  return { record };
}

export function registerSaleCommands(
  registry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  const handlers = buildHandlers(idGenerator, documentSequences);
  registry.register({
    commandType: 'sales.sale.record',
    version: 1,
    payloadSchema: recordSalePayloadSchema,
    permissionCode: 'sales.sale.record',
    handler: handlers.record,
  });
}
