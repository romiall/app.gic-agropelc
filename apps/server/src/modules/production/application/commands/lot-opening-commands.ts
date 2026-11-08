/**
 * Reprise d'un lot en cours : `production.lot_opening.post` et la décision `LOT_OPENING` (ADR-069, BR-PRD-016 ;
 * AV-541 à AV-544 ; décision du porteur du 08/11/2026, Q42 réponse A, AV-517 (3)(b)).
 *
 * Un lot déjà en élevage à la date d'arrêt ne naît ni d'une réception ni d'une mise en place : il est repris par une
 * déclaration unique — effectif repris, date de mise en place réelle, valeur totale déclarée — que la Direction valide,
 * comme l'inventaire d'ouverture (BR-STK-046). **Rien n'existe avant la décision** :
 * - la commande ne pose que la déclaration (`production_lot_openings`, `PENDING_APPROVAL`) et la demande de validation
 *   `LOT_OPENING` ; l'identifiant de l'enveloppe est celui du lot qui naîtra ;
 * - l'approbation crée, dans la transaction de la décision, le lot (`ACTIVE`, `start_date` = mise en place réelle,
 *   `initial_quantity` = effectif repris : INV-PRD-01), son lot de stock de traçabilité (`PRODUCTION_LOT`, rang FIFO à
 *   la mise en place), l'entrée de reprise (`OPENING`), le mouvement `OPENING_BALANCE` depuis `V_OPENING` à la valeur
 *   déclarée et l'écriture de coût `ANIMAUX` du même montant (le coût par tête et le coût restant du lot, ADR-027, partent
 *   de cette valeur) ;
 * - le refus clôt la déclaration sans aucun effet de stock ni de coût ; une nouvelle tentative prend un autre identifiant.
 *
 * Le contrôle de doublon porte sur le lot réel : une autre reprise en attente ou comptabilisée, ou un lot existant, du
 * même produit dans le même emplacement mis en place le même jour (`LOT_OPENING_DUPLICATE`), jugé à la déclaration et
 * de nouveau à la décision. Une reprise comptabilisée ne s'annule pas (aucun type de mouvement inverse d'une ouverture) :
 * l'effectif se corrige par un inventaire d'animaux (AV-543).
 */
import { sql } from 'kysely';
import {
  lotOpeningPostPayloadSchema,
  LOT_OPENING_POST_COMMAND,
  type LotOpeningPostPayload,
} from '@gic/contracts';
import {
  DomainError,
  businessDayStartUtc,
  lotAcceptsProductSpecies,
  lotOpeningIssues,
  lotOpeningSummary,
  quantityFromDecimal,
  unitCostXaf,
  type IdGenerator,
  type ProductionLotType,
} from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { findProduct } from '../../../catalog/application/public/index.js';
import {
  InventoryMoveError,
  createStockLot,
  recordCostEntry,
  recordStockMove,
  virtualLocationId,
} from '../../../inventory/application/public/index.js';
import {
  ApprovalDecisionRefused,
  decidablePolicyFor,
  requestApproval,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import {
  FORBIDDEN_SCOPE,
  REARING_LOCATION_TYPES,
  documentYear,
  isAllowed,
  loadLocation,
  rejected,
  type FarmLocation,
  type Uow,
} from './shared.js';
import { emitProductionLotChange, emitProductionRecordChange } from '../sync-changes.js';

const PERMISSION = 'production.lot_opening.post';
const OPERATION_TYPE = 'LOT_OPENING';
const SUBJECT_TYPE = 'PRODUCTION_LOT_OPENING';

/** Colonne `DATE` au jour métier (`AAAA-MM-JJ` converti par MySQL, sans dépendre du fuseau du processus). */
const dateOf = (value: string) => sql<Date>`${value}`;

/** Jour `AAAA-MM-JJ` d'une colonne `DATE` lue par le pilote (réglé en UTC : minuit UTC du jour). */
const dayOf = (value: Date): string => value.toISOString().slice(0, 10);

const LOCATION_MESSAGE = 'L’emplacement principal est un bâtiment ou une case actif d’une ferme.';

/** Bâtiment ou case actif d'une ferme ; `undefined` sinon. */
async function farmRearingLocation(
  uow: Uow,
  locationId: string,
): Promise<FarmLocation | undefined> {
  const location = await loadLocation(uow, locationId);
  return location !== undefined &&
    location.isActive &&
    location.siteType === 'FERME' &&
    REARING_LOCATION_TYPES.includes(location.locationType)
    ? location
    : undefined;
}

/** Produit biologique actif, suivi par lot, de l'espèce du type de lot (BR-PRD-001) ; sinon `null`. */
async function openableProduct(uow: Uow, productId: string) {
  const product = await findProduct(uow, productId);
  return product !== undefined &&
    product.status === 'ACTIVE' &&
    product.stockFamily === 'BIOLOGIQUE' &&
    product.lotTracking !== 'NONE'
    ? product
    : null;
}

/**
 * Autre reprise (en attente ou comptabilisée) ou lot existant du même lot réel : même emplacement, même produit, même
 * jour de mise en place. Renvoie de quoi le dire à l'utilisateur, sinon `null`.
 */
async function findDuplicate(
  uow: Uow,
  group: {
    readonly openingId: string;
    readonly locationId: string;
    readonly productId: string;
    readonly placedOn: string;
  },
): Promise<string | null> {
  const other = await uow
    .selectFrom('production_lot_openings')
    .select('id')
    .where('id', '<>', toBin(group.openingId))
    .where('main_location_id', '=', toBin(group.locationId))
    .where('product_id', '=', toBin(group.productId))
    .where('placed_on', '=', dateOf(group.placedOn))
    .where('status', 'in', ['PENDING_APPROVAL', 'POSTED'])
    .executeTakeFirst();
  if (other) {
    return 'Une autre reprise du même produit, dans cet emplacement, mise en place le même jour, existe déjà : c’est le même lot.';
  }
  const lot = await uow
    .selectFrom('production_production_lots')
    .select('lot_code')
    .where('id', '<>', toBin(group.openingId))
    .where('main_location_id', '=', toBin(group.locationId))
    .where('product_id', '=', toBin(group.productId))
    .where('start_date', '=', dateOf(group.placedOn))
    .where('status', '<>', 'CANCELLED')
    .executeTakeFirst();
  return lot
    ? `Le lot ${lot.lot_code}, du même produit, dans cet emplacement, mis en place le même jour, existe déjà : c’est le même lot.`
    : null;
}

function buildHandler(idGenerator: IdGenerator): CommandHandler<LotOpeningPostPayload> {
  return async (uow, envelope) => {
    const openingId = envelope.aggregate_id;
    const p = envelope.payload;
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    const offline = envelope.captured_offline;

    // Rejeu : une déclaration vivante ne fait rien de plus. Une déclaration refusée par l'approbateur n'est pas « faite » :
    // répondre « appliqué » sans rien créer laisserait croire à un lot repris (une nouvelle tentative prend un autre
    // identifiant, comme pour le stock d'ouverture, AV-517 (4)).
    const already = await uow
      .selectFrom('production_lot_openings')
      .select(['id', 'status'])
      .where('id', '=', toBin(openingId))
      .executeTakeFirst();
    if (already) {
      return already.status === 'REJECTED'
        ? rejected(
            'LOT_OPENING_ID_TAKEN',
            'Cette reprise a déjà été déclarée puis refusée : corrigez-la et redéclarez-la comme une nouvelle reprise.',
          )
        : { status: 'APPLIED' };
    }
    const lotWithId = await uow
      .selectFrom('production_production_lots')
      .select('id')
      .where('id', '=', toBin(openingId))
      .executeTakeFirst();
    if (lotWithId) {
      return rejected('LOT_OPENING_ID_TAKEN', 'Un lot de production porte déjà cet identifiant.');
    }

    const location = await farmRearingLocation(uow, p.mainLocationId);
    if (!location) return rejected('LOCATION_INVALID', LOCATION_MESSAGE);
    if (!(await isAllowed(uow, author, PERMISSION, at, location.siteId))) return FORBIDDEN_SCOPE;

    const product = await openableProduct(uow, p.productId);
    // Un produit qui ne convient pas est signalé par les contrôles du domaine (espèce nulle : `PRODUCT_INVALID`).
    const issue = lotOpeningIssues(
      {
        lotType: p.lotType,
        productSpecies: product?.species ?? null,
        placedOn: p.placedOn,
        quantity: p.quantity,
        valueXaf: p.valueXaf,
      },
      at,
    )[0];
    if (issue) return rejected(issue.code, issue.message);
    if (!product) {
      return rejected(
        'PRODUCT_INVALID',
        'Produit introuvable, désactivé ou qui n’est pas un animal suivi par lot.',
      );
    }

    if (p.supplierId !== undefined) {
      const supplier = await uow
        .selectFrom('procurement_suppliers')
        .select('id')
        .where('id', '=', toBin(p.supplierId))
        .executeTakeFirst();
      if (!supplier) return rejected('REFERENCE_INVALID', 'Fournisseur inconnu.');
    }

    const duplicate = await findDuplicate(uow, {
      openingId,
      locationId: p.mainLocationId,
      productId: p.productId,
      placedOn: p.placedOn,
    });
    if (duplicate) return rejected('LOT_OPENING_DUPLICATE', duplicate);

    // Hors ligne, une politique révisée entre la saisie et l'envoi ne rend pas la déclaration refusée.
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const policy = await decidablePolicyFor(
      uow,
      OPERATION_TYPE,
      at,
      offline ? origin.receivedAt : undefined,
    );
    if (!policy) {
      return rejected(
        'CONTROL_POLICY_MISSING',
        `Aucune politique de contrôle ${OPERATION_TYPE} configurée (approvals.policy.set).`,
      );
    }

    await uow
      .insertInto('production_lot_openings')
      .values({
        id: toBin(openingId),
        site_id: toBin(location.siteId),
        main_location_id: toBin(location.id),
        lot_type: p.lotType,
        product_id: toBin(p.productId),
        supplier_id: toBinOrNull(p.supplierId ?? null),
        strain: p.strain ?? null,
        placed_on: dateOf(p.placedOn),
        quantity_base: String(p.quantity),
        value_xaf: p.valueXaf,
        avg_weight_g: p.avgWeightG === undefined ? null : String(p.avgWeightG),
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
    // La demande de validation référence la déclaration : elle vient après elle, la déclaration la référence ensuite.
    const approvalRequestId = idGenerator.newId();
    await requestApproval(uow, {
      requestId: approvalRequestId,
      operationType: OPERATION_TYPE,
      subjectType: SUBJECT_TYPE,
      subjectId: openingId,
      // Aucune valeur au coût dans le résumé (RC-05) : le montant reste dans `amount_xaf`.
      subjectSummary: lotOpeningSummary({
        productName: product.name,
        quantity: p.quantity,
        placedOn: p.placedOn,
      }),
      siteId: location.siteId,
      amountXaf: p.valueXaf,
      requestedBy: author,
      requestedAt: at,
      policyId: policy.id,
      policyVersion: policy.version,
    });
    await uow
      .updateTable('production_lot_openings')
      .set({ approval_request_id: toBin(approvalRequestId) })
      .where('id', '=', toBin(openingId))
      .execute();
    return {
      status: 'APPLIED',
      audit: {
        after: {
          lotType: p.lotType,
          productId: p.productId,
          placedOn: p.placedOn,
          quantity: p.quantity,
          valueXaf: p.valueXaf,
          status: 'PENDING_APPROVAL',
        },
      },
    };
  };
}

/**
 * Décision `LOT_OPENING` : l'approbation fait naître le lot et son stock dans la transaction de la décision ; le refus
 * clôt la déclaration. Un état qui a changé depuis la déclaration (emplacement désactivé, produit retiré, doublon né
 * entre-temps) refuse la décision d'approuver (`ApprovalDecisionRefused`) : la demande reste en attente et la Direction
 * peut la refuser.
 */
function registerLotOpeningDecision(
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  const deps = { idGenerator };

  decisionRegistry.register(OPERATION_TYPE, async (uow, ctx) => {
    const opening = await uow
      .selectFrom('production_lot_openings')
      .selectAll()
      .where('id', '=', toBin(ctx.subjectId))
      .forUpdate()
      .executeTakeFirst();
    if (!opening) throw new ApprovalDecisionRefused('NOT_FOUND', 'Reprise de lot introuvable.');
    if (opening.status !== 'PENDING_APPROVAL') {
      throw new ApprovalDecisionRefused(
        'LOT_OPENING_NOT_PENDING',
        'Cette reprise est déjà décidée.',
      );
    }

    if (ctx.decision === 'REJECTED') {
      await uow
        .updateTable('production_lot_openings')
        .set({
          status: 'REJECTED',
          decided_by: toBin(ctx.decidedBy),
          decided_at: ctx.decidedAt,
          updated_by: toBin(ctx.decidedBy),
          version: sql`version + 1`,
        })
        .where('id', '=', opening.id)
        .execute();
      return;
    }

    const openingId = fromBin(opening.id);
    const productId = fromBin(opening.product_id);
    const lotType = opening.lot_type as ProductionLotType;
    const placedOn = dayOf(opening.placed_on);
    const author = fromBin(opening.created_by);
    const occurredAt = opening.occurred_at;
    const quantity = Number(opening.quantity_base);
    const valueXaf = Number(opening.value_xaf);

    const location = await farmRearingLocation(uow, fromBin(opening.main_location_id));
    if (!location) {
      throw new ApprovalDecisionRefused(
        'LOCATION_INVALID',
        `${LOCATION_MESSAGE} Refusez cette reprise et redéclarez-la.`,
      );
    }
    const product = await openableProduct(uow, productId);
    if (!product || !lotAcceptsProductSpecies(lotType, product.species)) {
      throw new ApprovalDecisionRefused(
        'PRODUCT_INVALID',
        'Le produit n’est plus un animal actif de l’espèce du type de lot. Refusez cette reprise et redéclarez-la.',
      );
    }
    const duplicate = await findDuplicate(uow, {
      openingId,
      locationId: location.id,
      productId,
      placedOn,
    });
    if (duplicate) throw new ApprovalDecisionRefused('LOT_OPENING_DUPLICATE', duplicate);

    try {
      const lotCode = await documentSequences.next(uow, {
        docType: 'LOT',
        siteId: location.siteId,
        codeSite: location.siteCode,
        year: documentYear(occurredAt),
      });
      const stockLotId = await createStockLot(uow, deps, {
        originType: 'PRODUCTION_LOT',
        originId: openingId,
        lotCode,
        productId,
        // La mise en place réelle ordonne le FIFO : un lot plus ancien se vend avant un lot plus récent.
        fifoRankAt: businessDayStartUtc(placedOn),
        expiryDate: null,
        createdBy: author,
      });
      await uow
        .insertInto('production_production_lots')
        .values({
          id: opening.id,
          lot_code: lotCode,
          lot_type: lotType,
          product_id: opening.product_id,
          stock_lot_id: toBin(stockLotId),
          site_id: opening.site_id,
          main_location_id: opening.main_location_id,
          supplier_id: opening.supplier_id,
          strain: opening.strain,
          start_date: dateOf(placedOn),
          // INV-PRD-01 : l'effectif initial est la somme des entrées enregistrées ; ici, l'entrée de reprise seule.
          initial_quantity: String(quantity),
          status: 'ACTIVE',
          notes: opening.notes,
          occurred_at: occurredAt,
          client_created_at: opening.client_created_at,
          received_at_server: opening.received_at_server,
          command_id: opening.command_id,
          created_device_id: opening.created_device_id,
          captured_offline: opening.captured_offline,
          clock_suspect: opening.clock_suspect,
          backdated_reason: opening.backdated_reason,
          created_by: opening.created_by,
        })
        .execute();

      const entryId = idGenerator.newId();
      const openingLocationId = await virtualLocationId(uow, 'V_OPENING');
      const [move] = await recordStockMove(uow, deps, {
        productId,
        lotId: stockLotId,
        quantityBase: quantity,
        fromLocationId: openingLocationId,
        toLocationId: location.id,
        moveType: 'OPENING_BALANCE',
        // Valeur exacte du lot repris : le coût par tête en est déduit (ADR-027), jamais le CMUP d'un lot d'animaux.
        declaredValueXaf: valueXaf,
        occurredAt,
        sourceDocType: 'LOT_ENTRY',
        sourceDocId: entryId,
        costObjectType: 'PRODUCTION_LOT',
        costObjectId: openingId,
        createdBy: author,
        ...(opening.created_device_id !== null
          ? { createdDeviceId: fromBin(opening.created_device_id) }
          : {}),
        capturedOffline: false,
        allowNegative: false,
      });
      await recordCostEntry(uow, deps, {
        costObjectType: 'PRODUCTION_LOT',
        costObjectId: openingId,
        costType: 'ANIMAUX',
        amountXaf: valueXaf,
        direction: 'DEBIT',
        sourceType: 'STOCK_MOVE',
        sourceId: move!.moveId,
        occurredAt,
        createdBy: author,
        comment: `Reprise du lot ${lotCode} à la date d’arrêt (valeur déclarée)`,
      });
      await uow
        .insertInto('production_lot_entries')
        .values({
          id: toBin(entryId),
          production_lot_id: opening.id,
          entry_type: 'OPENING',
          product_id: opening.product_id,
          quantity_base: String(quantity),
          to_location_id: opening.main_location_id,
          source_kind: 'OPENING',
          avg_weight_g: opening.avg_weight_g,
          unit_cost_xaf: unitCostXaf(valueXaf, quantityFromDecimal(quantity)),
          value_xaf: valueXaf,
          occurred_at: occurredAt,
          client_created_at: opening.client_created_at,
          received_at_server: opening.received_at_server,
          command_id: opening.command_id,
          created_device_id: opening.created_device_id,
          captured_offline: opening.captured_offline,
          clock_suspect: opening.clock_suspect,
          backdated_reason: opening.backdated_reason,
          created_by: opening.created_by,
        })
        .execute();
      await uow
        .updateTable('production_lot_openings')
        .set({
          status: 'POSTED',
          entry_id: toBin(entryId),
          decided_by: toBin(ctx.decidedBy),
          decided_at: ctx.decidedAt,
          updated_by: toBin(ctx.decidedBy),
          version: sql`version + 1`,
        })
        .where('id', '=', opening.id)
        .execute();
      await emitProductionLotChange(uow, openingId);
      await emitProductionRecordChange(uow, 'LOT_ENTRY', entryId);
    } catch (error) {
      // Un refus métier du registre ou du domaine devient un refus de la décision (la demande reste en attente).
      if (error instanceof InventoryMoveError || error instanceof DomainError) {
        throw new ApprovalDecisionRefused(error.code, error.message);
      }
      throw error;
    }
  });

  // Une reprise en attente se décide (approuvée ou refusée), elle ne se retire pas : sans demande, la déclaration resterait
  // sans issue (même précédent que l'écart de rapprochement d'une facture, ADR-043).
  decisionRegistry.registerWithdrawalGuard(OPERATION_TYPE, async () => {
    throw new ApprovalDecisionRefused(
      'LOT_OPENING_NOT_WITHDRAWABLE',
      'Une reprise de lot se décide : elle est approuvée ou refusée, jamais retirée.',
    );
  });
}

export function registerLotOpeningCommands(
  registry: CommandHandlerRegistry,
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  registry.register({
    commandType: LOT_OPENING_POST_COMMAND,
    version: 1,
    payloadSchema: lotOpeningPostPayloadSchema,
    permissionCode: PERMISSION,
    handler: buildHandler(idGenerator),
  });
  registerLotOpeningDecision(decisionRegistry, idGenerator, documentSequences);
}
