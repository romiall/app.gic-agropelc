/**
 * Commandes d'un report de pièce papier (PP-B ; REQ-303, AV-308, AV-312, AV-078, AV-501 à AV-504).
 *
 * Logique PURE, sans entrée-sortie : à partir d'une pièce **résolue** (identifiants des référentiels de
 * l'appareil, montants et quantités calculés), construit la commande métier que le serveur enregistre
 * pour ce type de pièce. Types de commande, agrégats et charges utiles sont ceux des gestionnaires du
 * serveur ; l'essai `apps/server/test/pwa-paper-slip-commands.test.ts` rejoue chaque type de pièce dans
 * le vrai pipeline, et `apps/server/test/pwa-command-types.test.ts` garde les types écrits ici.
 *
 * | Pièce | Commande du serveur           | Agrégat            | Numéro de la pièce papier |
 * |-------|-------------------------------|--------------------|---------------------------|
 * | BV    | `sales.sale.record`           | `SALE`             | `localRef`                |
 * | CC    | `sales.order.place`           | `SALES_ORDER`      | `localRef`                |
 * | BL    | `sales.order.fulfil`          | `DELIVERY_NOTE`    | `localRef`                |
 * | RE    | `sales.payment.record`        | `CUSTOMER_PAYMENT` | `localRef`                |
 * | BD    | `finance.expense.record`      | `EXPENSE`          | `localRef`                |
 * | RF    | `finance.cash_transfer.send`  | `CASH_TRANSFER`    | `localRef`                |
 * | BR    | `procurement.receipt.record`  | `GOODS_RECEIPT`    | `localRef`                |
 * | BT    | `inventory.transfer.dispatch` | `STOCK_TRANSFER`   | mention dans `notes`      |
 * | FP    | `inventory.loss.declare`      | `STOCK_LOSS`       | mention dans `comment`    |
 *
 * Le numéro de la pièce papier n'a pas de champ dédié sur le serveur (AV-308 (b) n'est pas construit) : en
 * attendant, `localRef` (20 caractères au plus, unique par appareil) pour les sept commandes qui
 * l'acceptent — en « saisie hors ligne », un numéro déjà pris est appliqué sans lui, avec l'avertissement
 * `LOCAL_REF_DUPLICATE`, jamais refusé —, une mention dans le texte libre pour l'expédition d'un transfert
 * et la déclaration d'une perte, qui n'ont pas de `localRef` (AV-501). Une pièce reportée est un fait
 * accompli saisi hors du système (BR-SYN-007) : la commande part « saisie hors ligne » même appareil
 * connecté (AV-502).
 */

export type ReportableSlipType = 'BV' | 'RE' | 'BD' | 'RF' | 'CC' | 'BL' | 'BR' | 'BT' | 'FP';

export const REPORTABLE_SLIP_TYPES: readonly ReportableSlipType[] = [
  'BV',
  'RE',
  'BD',
  'RF',
  'CC',
  'BL',
  'BR',
  'BT',
  'FP',
];

/** `localRef varchar(20)` : borne des schémas de commande du serveur qui acceptent le champ. */
export const MAX_SLIP_REF_LENGTH = 20;
/** Borne des textes libres `notes` et `comment` des commandes de transfert et de perte. */
export const MAX_SLIP_FREE_TEXT = 2000;
/** Borne du motif d'antidatage de l'enveloppe (`backdated_reason`). */
export const MAX_BACKDATED_REASON = 500;

/** Où le serveur garde le numéro d'une pièce papier reportée (AV-501). */
export type PaperRefPlace = 'LOCAL_REF' | 'FREE_TEXT';

export function paperRefPlace(type: ReportableSlipType): PaperRefPlace {
  // L'expédition d'un transfert et la déclaration d'une perte n'acceptent pas `localRef`.
  return type === 'BT' || type === 'FP' ? 'FREE_TEXT' : 'LOCAL_REF';
}

/** La commande de ce type de pièce reçoit-elle le numéro en `localRef` ? */
export const carriesLocalRef = (type: ReportableSlipType): boolean =>
  paperRefPlace(type) === 'LOCAL_REF';

// --- Pièce résolue --------------------------------------------------------------------------------

/** Ligne de vente ou de commande (`saleLineSchema` du serveur) ; produite par `linePayload` (sale-form). */
export interface SlipSaleLine {
  readonly productId: string;
  readonly quantity: number;
  readonly unitCode: string;
  /** Même quantité en unité de base, recontrôlée par le serveur. */
  readonly quantityBase: number;
  readonly weightKg?: number | undefined;
  /** Prix catalogue connu de l'appareil à la date de la pièce ; `null` : aucune règle trouvée. */
  readonly listUnitPriceXaf?: number | null | undefined;
  readonly priceRuleId?: string | undefined;
  /** Prix inscrit sur la pièce : jamais recalculé par le serveur (BR-VEN-029). */
  readonly unitPriceXaf: number;
  readonly overrideReasonCodeId?: string | undefined;
}

/** Règlement joint à une vente, ou encaissement (`salePaymentSchema`, `paymentPayload` du PWA). */
export interface SlipPayment {
  readonly methodCode: string;
  readonly amountXaf: number;
  readonly reference?: string | undefined;
  readonly cashAccountId?: string | undefined;
}

export interface SlipReceiptLine {
  readonly poLineId?: string | undefined;
  readonly productId: string;
  readonly unitCode: string;
  readonly qtyDeliveredBase: number;
  readonly qtyRejectedBase?: number | undefined;
  readonly rejectionReasonCodeId?: string | undefined;
  /** Prix déclaré : réception sans bon de commande seulement. */
  readonly unitCostXaf?: number | undefined;
  readonly supplierLotRef?: string | undefined;
}

export interface SlipTransferLine {
  readonly productId: string;
  readonly unitCode: string;
  readonly quantityBase: number;
}

export type ResolvedSlip =
  | {
      readonly type: 'BV';
      readonly fromLocationId: string;
      readonly customerId?: string | undefined;
      readonly channelCode?: string | undefined;
      readonly lines: readonly SlipSaleLine[];
      readonly payment?: SlipPayment | undefined;
      /** Total des lignes (montants de ligne du domaine), pour le registre des carnets. */
      readonly totalXaf?: number | undefined;
    }
  | {
      readonly type: 'CC';
      readonly customerId: string;
      readonly fulfilmentLocationId: string;
      readonly channelCode?: string | undefined;
      readonly requestedDeliveryDate?: string | undefined;
      readonly deliveryAddress?: string | undefined;
      readonly lines: readonly SlipSaleLine[];
      /** Total des lignes (montants de ligne du domaine), pour le registre des carnets. */
      readonly totalXaf?: number | undefined;
    }
  | {
      readonly type: 'RE';
      readonly customerId: string;
      readonly siteId?: string | undefined;
      readonly payment: SlipPayment;
    }
  | {
      readonly type: 'BL';
      readonly orderId: string;
      readonly recipientName?: string | undefined;
      readonly notes?: string | undefined;
      readonly lines: readonly { readonly orderLineId: string; readonly quantityBase: number }[];
    }
  | {
      readonly type: 'BD';
      readonly categoryId: string;
      readonly siteId: string;
      readonly amountXaf: number;
      readonly description: string;
      readonly payeeName?: string | undefined;
      /** Compte d'où l'argent est sorti : un bon de décaissement est une dépense payée. */
      readonly paidFromAccountId: string;
    }
  | {
      readonly type: 'RF';
      readonly fromAccountId: string;
      readonly toAccountId: string;
      readonly amountXaf: number;
      readonly carrierName?: string | undefined;
      readonly comment?: string | undefined;
    }
  | {
      readonly type: 'BR';
      readonly purchaseOrderId?: string | undefined;
      readonly supplierId: string;
      readonly locationId: string;
      readonly supplierDeliveryNoteRef?: string | undefined;
      readonly observations?: string | undefined;
      readonly lines: readonly SlipReceiptLine[];
    }
  | {
      readonly type: 'BT';
      readonly fromLocationId: string;
      readonly toLocationId: string;
      readonly carrierName?: string | undefined;
      readonly notes?: string | undefined;
      readonly lines: readonly SlipTransferLine[];
    }
  | {
      readonly type: 'FP';
      readonly locationId: string;
      readonly productId: string;
      readonly unitCode: string;
      readonly quantity: number;
      readonly quantityBase: number;
      readonly category: string;
      readonly reasonCodeId?: string | undefined;
      readonly lotId?: string | undefined;
      readonly comment?: string | undefined;
    };

// --- Photo de la souche ---------------------------------------------------------------------------

/**
 * Rattachement de la photo de la souche (ADR-046 §2) : le serveur ne lit que quatre propriétaires de
 * pièce jointe (`ATTACHMENT_OWNER_TYPES`) ; le propriétaire est l'agrégat de l'opération reportée.
 */
export interface SlipPhotoTarget {
  readonly kind: 'DELIVERY_NOTE' | 'PHOTO' | 'RECEIPT';
  readonly ownerType: 'GOODS_RECEIPT' | 'STOCK_LOSS' | 'EXPENSE';
  /** Citée par l'opération (dépense, réception) ou rattachée par son seul propriétaire (perte). */
  readonly cited: boolean;
}

/**
 * Cible de la photo d'une pièce, ou `null` : le serveur n'a pas de propriétaire de pièce jointe pour
 * ce type de pièce (vente, commande, livraison, encaissement, remise de fonds, transfert ; AV-504).
 */
export function slipPhotoTarget(type: ReportableSlipType): SlipPhotoTarget | null {
  switch (type) {
    case 'BD':
      return { kind: 'RECEIPT', ownerType: 'EXPENSE', cited: true };
    case 'BR':
      return { kind: 'DELIVERY_NOTE', ownerType: 'GOODS_RECEIPT', cited: true };
    case 'FP':
      return { kind: 'PHOTO', ownerType: 'STOCK_LOSS', cited: false };
    default:
      return null;
  }
}

// --- Commande -------------------------------------------------------------------------------------

export interface ReportMeta {
  /** Numéro de la pièce papier, déjà normalisé (`normalizeSlipRef`). */
  readonly paperRef: string;
  /** Heure écrite sur la pièce, ISO 8601 UTC (`occurred_at` de l'enveloppe). */
  readonly occurredAt: string;
  readonly backdatedReason: string | null;
  /** Identifiant (UUIDv7) de l'opération créée, choisi par l'appareil. */
  readonly aggregateId: string;
  /** Commande de l'outbox dont celle-ci dépend (commande à livrer encore en attente d'envoi). */
  readonly dependsOn?: readonly string[] | undefined;
}

export interface ReportCommand {
  readonly commandType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly dependsOn: readonly string[];
  readonly payload: Record<string, unknown>;
  readonly occurredAt: string;
  readonly backdatedReason: string | null;
  /** Toujours vrai : fait accompli saisi hors du système, jamais refusé pour un état métier (AV-502). */
  readonly capturedOffline: true;
  /** Indices locaux (jamais envoyés) : pièce papier, type, numéro, montant pour le registre des carnets. */
  readonly localFlags: readonly string[];
  readonly photo: SlipPhotoTarget | null;
}

/** Préfixe des indices locaux (voir `loadReportedSlipsFromDb`). */
export const FLAG_PAPER_SLIP = 'PAPER_SLIP';
export const FLAG_SLIP_TYPE = 'SLIP_TYPE:';
export const FLAG_PAPER_REF = 'PAPER_REF:';
export const FLAG_AMOUNT = 'SLIP_AMOUNT:';

/** Retire les valeurs `undefined` (une charge utile n'envoie que ce qui est renseigné). */
function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

const nonEmpty = (text: string | undefined): string | undefined => {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
};

/** Texte libre d'une commande sans `localRef` (transfert, perte) : la mention de la pièce, puis la note. */
export function withPaperRef(paperRef: string, text: string | undefined): string {
  const mention = `Pièce papier ${paperRef}`;
  const body = nonEmpty(text);
  return (body ? `${mention} — ${body}` : mention).slice(0, MAX_SLIP_FREE_TEXT);
}

function saleLine(line: SlipSaleLine): Record<string, unknown> {
  return compact({
    productId: line.productId,
    quantity: line.quantity,
    unitCode: line.unitCode,
    quantityBase: line.quantityBase,
    weightKg: line.weightKg,
    listUnitPriceXaf: line.listUnitPriceXaf,
    priceRuleId: line.priceRuleId,
    unitPriceXaf: line.unitPriceXaf,
    overrideReasonCodeId: line.overrideReasonCodeId,
  });
}

function payment(entry: SlipPayment): Record<string, unknown> {
  return compact({
    methodCode: entry.methodCode,
    amountXaf: entry.amountXaf,
    reference: nonEmpty(entry.reference),
    cashAccountId: entry.cashAccountId,
  });
}

/** Type, agrégat et charge utile du serveur pour une pièce résolue. */
function commandOf(
  slip: ResolvedSlip,
  paperRef: string,
): { commandType: string; aggregateType: string; payload: Record<string, unknown> } {
  const localRef = carriesLocalRef(slip.type) ? paperRef : undefined;
  if (localRef !== undefined && localRef.length > MAX_SLIP_REF_LENGTH) {
    throw new RangeError(
      `Numéro de pièce papier trop long (${localRef.length} > ${MAX_SLIP_REF_LENGTH}) : ${localRef}.`,
    );
  }
  switch (slip.type) {
    case 'BV':
      return {
        commandType: 'sales.sale.record',
        aggregateType: 'SALE',
        payload: compact({
          fromLocationId: slip.fromLocationId,
          customerId: slip.customerId,
          channelCode: slip.channelCode,
          localRef,
          lines: slip.lines.map(saleLine),
          payments: slip.payment ? [payment(slip.payment)] : undefined,
        }),
      };
    case 'CC':
      return {
        commandType: 'sales.order.place',
        aggregateType: 'SALES_ORDER',
        payload: compact({
          customerId: slip.customerId,
          fulfilmentLocationId: slip.fulfilmentLocationId,
          channelCode: slip.channelCode,
          localRef,
          requestedDeliveryDate: slip.requestedDeliveryDate,
          deliveryAddress: nonEmpty(slip.deliveryAddress),
          lines: slip.lines.map(saleLine),
        }),
      };
    case 'RE':
      return {
        commandType: 'sales.payment.record',
        aggregateType: 'CUSTOMER_PAYMENT',
        payload: compact({
          customerId: slip.customerId,
          siteId: slip.siteId,
          ...payment(slip.payment),
          localRef,
        }),
      };
    case 'BL':
      return {
        commandType: 'sales.order.fulfil',
        aggregateType: 'DELIVERY_NOTE',
        payload: compact({
          orderId: slip.orderId,
          localRef,
          recipientName: nonEmpty(slip.recipientName),
          notes: nonEmpty(slip.notes),
          lines: slip.lines.map((line) => ({
            orderLineId: line.orderLineId,
            quantityBase: line.quantityBase,
          })),
        }),
      };
    case 'BD':
      return {
        commandType: 'finance.expense.record',
        aggregateType: 'EXPENSE',
        payload: compact({
          categoryId: slip.categoryId,
          amountXaf: slip.amountXaf,
          description: slip.description.trim(),
          payeeName: nonEmpty(slip.payeeName),
          siteId: slip.siteId,
          paidNow: true,
          paidFromAccountId: slip.paidFromAccountId,
          localRef,
        }),
      };
    case 'RF':
      return {
        commandType: 'finance.cash_transfer.send',
        aggregateType: 'CASH_TRANSFER',
        payload: compact({
          fromAccountId: slip.fromAccountId,
          toAccountId: slip.toAccountId,
          amountXaf: slip.amountXaf,
          carrierName: nonEmpty(slip.carrierName),
          comment: nonEmpty(slip.comment),
          localRef,
        }),
      };
    case 'BR':
      return {
        commandType: 'procurement.receipt.record',
        aggregateType: 'GOODS_RECEIPT',
        payload: compact({
          purchaseOrderId: slip.purchaseOrderId,
          supplierId: slip.supplierId,
          locationId: slip.locationId,
          supplierDeliveryNoteRef: nonEmpty(slip.supplierDeliveryNoteRef),
          observations: nonEmpty(slip.observations),
          lines: slip.lines.map((line) =>
            compact({
              poLineId: line.poLineId,
              productId: line.productId,
              unitCode: line.unitCode,
              qtyDeliveredBase: line.qtyDeliveredBase,
              qtyRejectedBase: line.qtyRejectedBase,
              rejectionReasonCodeId: line.rejectionReasonCodeId,
              unitCostXaf: line.unitCostXaf,
              supplierLotRef: nonEmpty(line.supplierLotRef),
            }),
          ),
          localRef,
        }),
      };
    case 'BT':
      // Le bon de transfert est établi au départ de la marchandise : expédition directe, sans demande
      // préalable (`TransferScreen`). La demande de réapprovisionnement n'a pas de pièce papier.
      return {
        commandType: 'inventory.transfer.dispatch',
        aggregateType: 'STOCK_TRANSFER',
        payload: compact({
          fromLocationId: slip.fromLocationId,
          toLocationId: slip.toLocationId,
          lines: slip.lines.map((line) => ({
            productId: line.productId,
            unitCode: line.unitCode,
            quantityBase: line.quantityBase,
          })),
          carrierName: nonEmpty(slip.carrierName),
          notes: withPaperRef(paperRef, slip.notes),
        }),
      };
    case 'FP':
      return {
        commandType: 'inventory.loss.declare',
        aggregateType: 'STOCK_LOSS',
        payload: compact({
          locationId: slip.locationId,
          productId: slip.productId,
          lotId: slip.lotId,
          quantityBase: slip.quantityBase,
          unitCode: slip.unitCode,
          quantity: slip.quantity,
          category: slip.category,
          reasonCodeId: slip.reasonCodeId,
          comment: withPaperRef(paperRef, slip.comment),
        }),
      };
  }
}

/** Montant porté par la pièce, pour le registre des carnets (`null` : pièce sans montant). */
export function slipAmountXaf(slip: ResolvedSlip): number | null {
  switch (slip.type) {
    case 'BV':
    case 'CC':
      return slip.totalXaf ?? null;
    case 'RE':
      return slip.payment.amountXaf;
    case 'BD':
    case 'RF':
      return slip.amountXaf;
    default:
      return null;
  }
}

/** Commande du serveur pour une pièce papier résolue (voir le tableau en tête de fichier). */
export function buildReportCommand(slip: ResolvedSlip, meta: ReportMeta): ReportCommand {
  const { commandType, aggregateType, payload } = commandOf(slip, meta.paperRef);
  const amount = slipAmountXaf(slip);
  const reason = nonEmpty(meta.backdatedReason ?? undefined);
  return {
    commandType,
    aggregateType,
    aggregateId: meta.aggregateId,
    dependsOn: [...(meta.dependsOn ?? [])],
    payload,
    occurredAt: meta.occurredAt,
    backdatedReason: reason ? reason.slice(0, MAX_BACKDATED_REASON) : null,
    capturedOffline: true,
    localFlags: [
      FLAG_PAPER_SLIP,
      `${FLAG_SLIP_TYPE}${slip.type}`,
      `${FLAG_PAPER_REF}${meta.paperRef}`,
      ...(amount !== null ? [`${FLAG_AMOUNT}${amount}`] : []),
    ],
    photo: slipPhotoTarget(slip.type),
  };
}
