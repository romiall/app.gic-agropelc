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
 * | DA    | `procurement.request.submit`  | `PURCHASE_REQUEST` | `localRef`                |
 * | BC    | `procurement.order.create`, puis `.submit` | `PURCHASE_ORDER` | `localRef`      |
 * | VC    | `crm.visit.record`            | `VISIT`            | mention dans `notes`      |
 * | FI    | `inventory.count.open`, `.record_lines`, `.submit` | `INVENTORY_COUNT` | `localRef` |
| FL    | `production.mortality.record`, `.input.record`, `.weighing.record`, `.observation.record` (une par mesure et par jour) | `STOCK_LOSS`, `CONSUMPTION`, `LOT_WEIGHING`, `LOT_OBSERVATION` | mention dans `comment` et `text` |
 *
 * Un bon de commande (BC) et une fiche d'inventaire (FI) sont plusieurs commandes de même agrégat, chacune dépendant de la
 * précédente : `buildReportCommands`. Seule la première porte les indices du registre des carnets et la photo. Une fiche de
 * suivi de lot (FL) est une suite de saisies du jour indépendantes (une par mesure renseignée de chaque jour), chacune avec
 * son agrégat et l'heure de son jour : l'échec d'une mesure ne retient pas les autres.
 *
 * Le numéro de la pièce papier n'a pas de champ dédié sur le serveur (AV-308 (b) n'est pas construit) : en
 * attendant, `localRef` (20 caractères au plus, unique par appareil) pour les sept commandes qui
 * l'acceptent — en « saisie hors ligne », un numéro déjà pris est appliqué sans lui, avec l'avertissement
 * `LOCAL_REF_DUPLICATE`, jamais refusé —, une mention dans le texte libre pour l'expédition d'un transfert
 * et la déclaration d'une perte, qui n'ont pas de `localRef` (AV-501). Une pièce reportée est un fait
 * accompli saisi hors du système (BR-SYN-007) : la commande part « saisie hors ligne » même appareil
 * connecté (AV-502).
 */

export type ReportableSlipType =
  'BV' | 'RE' | 'BD' | 'RF' | 'CC' | 'BL' | 'BR' | 'BT' | 'FP' | 'DA' | 'BC' | 'VC' | 'FI' | 'FL';

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
  'DA',
  'BC',
  'VC',
  'FI',
  'FL',
];

/**
 * Pièces qui ne se reportent pas : elles sont imprimées d'après des faits déjà enregistrés, elles n'ont pas de commande
 * propre. `FA` est la facture d'une vente (la vente se reporte par `BV` ou `CC`), `FJC` la feuille journalière de caisse et
 * `JE` le journal des encaissements (les mouvements de trésorerie se reportent par `RE`, `BD` et `RF`). `PT` et `BH` ont
 * leurs écrans (présence du personnel, bilan hebdomadaire).
 */
export const NON_REPORTABLE_SLIP_CODES: readonly string[] = ['FA', 'FJC', 'JE'];

/** `localRef varchar(20)` : borne des schémas de commande du serveur qui acceptent le champ. */
export const MAX_SLIP_REF_LENGTH = 20;
/** Borne des textes libres `notes` et `comment` des commandes de transfert et de perte. */
export const MAX_SLIP_FREE_TEXT = 2000;
/** Borne du motif d'antidatage de l'enveloppe (`backdated_reason`). */
export const MAX_BACKDATED_REASON = 500;

/** Où le serveur garde le numéro d'une pièce papier reportée (AV-501). */
export type PaperRefPlace = 'LOCAL_REF' | 'FREE_TEXT';

export function paperRefPlace(type: ReportableSlipType): PaperRefPlace {
  // L'expédition d'un transfert, la déclaration d'une perte, une visite et les saisies du jour d'un lot n'acceptent pas `localRef`.
  return type === 'BT' || type === 'FP' || type === 'VC' || type === 'FL'
    ? 'FREE_TEXT'
    : 'LOCAL_REF';
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

/** Ligne d'une demande d'achat (DA) : quantité en unité de base, prix estimé facultatif. */
export interface SlipRequestLine {
  readonly productId: string;
  readonly unitCode: string;
  readonly quantity: number;
  readonly quantityBase: number;
  readonly estimatedUnitPriceXaf?: number | undefined;
}

/** Ligne d'un bon de commande fournisseur (BC) : quantité commandée en unité de base, prix unitaire inscrit. */
export interface SlipOrderLine {
  readonly productId: string;
  readonly unitCode: string;
  readonly orderedQtyBase: number;
  readonly unitPriceXaf: number;
}

/** Ligne d'une fiche d'inventaire (FI) : quantité comptée en unité de base. */
export interface SlipCountLine {
  readonly productId: string;
  readonly countedQtyBase: number;
}

export type SlipCountType = 'FULL' | 'PARTIAL' | 'SPOT';

/**
 * Une ligne (un jour) de la fiche de suivi de lot (FL) : seules les mesures renseignées sont présentes. Les œufs ne s'y
 * trouvent pas : le serveur exige leur répartition par calibre, que la fiche ne porte pas (écran de collecte d'œufs).
 */
export interface SlipLotDay {
  /** Jour de la ligne, `AAAA-MM-JJ`. */
  readonly date: string;
  /** Heure de la saisie du jour, ISO 8601 UTC : midi du jour, ou l'instant du contrôle si midi n'est pas encore venu. */
  readonly occurredAt: string;
  readonly mortality?:
    | {
        readonly quantity: number;
        readonly reasonCodeId?: string | undefined;
        /** Commentaire de la déclaration (exigé par certaines causes) ; la mention de la pièce y est ajoutée. */
        readonly comment?: string | undefined;
      }
    | undefined;
  readonly input?:
    | {
        readonly productId: string;
        readonly unitCode: string;
        readonly quantity: number;
        readonly quantityBase: number;
      }
    | undefined;
  readonly weighing?: { readonly sampleSize: number; readonly avgWeightG: number } | undefined;
  /** Observation libre (santé, vaccin, incident) ; la mention de la pièce y est ajoutée. */
  readonly observation?: string | undefined;
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
    }
  | {
      readonly type: 'DA';
      readonly siteId: string;
      /** Date de besoin, `AAAA-MM-JJ`. */
      readonly neededByDate?: string | undefined;
      readonly justification: string;
      readonly lines: readonly SlipRequestLine[];
    }
  | {
      readonly type: 'BC';
      readonly supplierId: string;
      readonly deliveryLocationId: string;
      /** Date de livraison prévue, `AAAA-MM-JJ`. */
      readonly expectedDeliveryDate?: string | undefined;
      readonly lines: readonly SlipOrderLine[];
      /** Total des lignes (montants de ligne du domaine), pour le registre des carnets. */
      readonly totalXaf: number;
    }
  | {
      readonly type: 'VC';
      readonly customerId: string;
      readonly outcomeReasonCodeId: string;
      readonly notes?: string | undefined;
      /** Prochaine action, `AAAA-MM-JJ`. */
      readonly nextActionAt?: string | undefined;
      readonly nextActionNote?: string | undefined;
    }
  | {
      readonly type: 'FI';
      readonly locationId: string;
      readonly countType: SlipCountType;
      readonly lines: readonly SlipCountLine[];
    }
  | {
      readonly type: 'FL';
      readonly lotId: string;
      /** Bâtiment ou case où les animaux sont morts et ont été pesés. */
      readonly locationId: string;
      /** Magasin d'où l'aliment est pris (exigé dès qu'une ligne porte de l'aliment). */
      readonly feedLocationId?: string | undefined;
      readonly days: readonly SlipLotDay[];
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
  /** Vrai pour la 2e commande et les suivantes d'une pièce en plusieurs commandes : elle attend la précédente. */
  readonly dependsOnPrevious: boolean;
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

/** Une commande du serveur d'un report : type, agrégat (celui de la pièce) et charge utile. */
interface CommandPart {
  readonly commandType: string;
  readonly aggregateType: string;
  readonly payload: Record<string, unknown>;
  /** Pièce en commandes indépendantes (FL) : agrégat et heure propres à la commande. */
  readonly aggregateId?: string | undefined;
  readonly occurredAt?: string | undefined;
  /** Vrai : la commande n'attend pas la précédente (par défaut, la 2e et les suivantes l'attendent). */
  readonly independent?: boolean | undefined;
}

/** Numéro de la pièce en `localRef` pour les types dont la commande l'accepte ; contrôle de sa longueur. */
function localRefOf(type: ReportableSlipType, paperRef: string): string | undefined {
  const localRef = carriesLocalRef(type) ? paperRef : undefined;
  if (localRef !== undefined && localRef.length > MAX_SLIP_REF_LENGTH) {
    throw new RangeError(
      `Numéro de pièce papier trop long (${localRef.length} > ${MAX_SLIP_REF_LENGTH}) : ${localRef}.`,
    );
  }
  return localRef;
}

/**
 * Identifiant de la n-ième commande d'une pièce en commandes indépendantes (FL) : celui de la pièce pour la première, puis le
 * même dont l'octet final varie (la version UUIDv7 est conservée). Chaque mesure écrit sa propre ligne (déclaration de
 * mortalité, consommation, pesée, observation), dont l'identifiant est celui de l'agrégat de la commande : ils doivent
 * être distincts.
 */
function nthAggregateId(base: string, index: number): string {
  if (index === 0) return base;
  return `${base.slice(0, -2)}${(index % 256).toString(16).padStart(2, '0')}`;
}

/**
 * Fiche de suivi de lot (FL) : une saisie du jour du lot par mesure renseignée, jour après jour (mortalité, aliment, pesée,
 * observation). Les charges sont celles des écrans de saisie du jour (`production/daily.ts`, confrontées par un essai).
 */
function lotSheetParts(
  slip: Extract<ResolvedSlip, { readonly type: 'FL' }>,
  paperRef: string,
  aggregateId: string,
): readonly CommandPart[] {
  const parts: CommandPart[] = [];
  const add = (
    day: SlipLotDay,
    part: Pick<CommandPart, 'commandType' | 'aggregateType' | 'payload'>,
  ) => {
    parts.push({
      ...part,
      aggregateId: nthAggregateId(aggregateId, parts.length),
      occurredAt: day.occurredAt,
      independent: true,
    });
  };
  for (const day of slip.days) {
    if (day.mortality) {
      add(day, {
        commandType: 'production.mortality.record',
        aggregateType: 'STOCK_LOSS',
        payload: compact({
          productionLotId: slip.lotId,
          locationId: slip.locationId,
          quantity: day.mortality.quantity,
          reasonCodeId: day.mortality.reasonCodeId,
          comment: withPaperRef(paperRef, day.mortality.comment),
        }),
      });
    }
    if (day.input) {
      add(day, {
        commandType: 'production.input.record',
        aggregateType: 'CONSUMPTION',
        payload: compact({
          productionLotId: slip.lotId,
          locationId: slip.feedLocationId,
          productId: day.input.productId,
          quantityBase: day.input.quantityBase,
          unitCode: day.input.unitCode,
          quantity: day.input.quantity,
          costType: 'ALIMENT',
        }),
      });
    }
    if (day.weighing) {
      add(day, {
        commandType: 'production.weighing.record',
        aggregateType: 'LOT_WEIGHING',
        payload: {
          productionLotId: slip.lotId,
          locationId: slip.locationId,
          sampleSize: day.weighing.sampleSize,
          avgWeightG: day.weighing.avgWeightG,
          source: 'MANUAL',
        },
      });
    }
    if (day.observation !== undefined) {
      add(day, {
        commandType: 'production.observation.record',
        aggregateType: 'LOT_OBSERVATION',
        payload: {
          productionLotId: slip.lotId,
          observationType: 'AUTRE',
          text: withPaperRef(paperRef, day.observation),
          severity: 'INFO',
        },
      });
    }
  }
  return parts;
}

/** Pièces dont le report est une seule commande, historiques de PP-B. */
type SingleCommandSlip = Exclude<ResolvedSlip, { readonly type: 'DA' | 'BC' | 'VC' | 'FI' | 'FL' }>;

/** Commandes du serveur pour une pièce résolue : une, ou une chaîne de même agrégat (BC, FI). */
function commandPartsOf(
  slip: ResolvedSlip,
  paperRef: string,
  aggregateId: string,
  occurredAt: string,
): readonly CommandPart[] {
  const localRef = localRefOf(slip.type, paperRef);
  switch (slip.type) {
    case 'DA':
      return [
        {
          commandType: 'procurement.request.submit',
          aggregateType: 'PURCHASE_REQUEST',
          payload: compact({
            siteId: slip.siteId,
            neededByDate: slip.neededByDate,
            justification: slip.justification.trim(),
            lines: slip.lines.map((line) =>
              compact({
                productId: line.productId,
                quantityBase: line.quantityBase,
                unitCode: line.unitCode,
                quantity: line.quantity,
                estimatedUnitPriceXaf: line.estimatedUnitPriceXaf,
              }),
            ),
            localRef,
          }),
        },
      ];
    case 'BC':
      // Le bon de commande papier a été remis au fournisseur : il est créé puis soumis (au-delà du seuil, la Direction
      // le valide ; en deçà il est approuvé d'office). Le marquer « envoyé » reste un geste du bureau des achats.
      return [
        {
          commandType: 'procurement.order.create',
          aggregateType: 'PURCHASE_ORDER',
          payload: compact({
            supplierId: slip.supplierId,
            deliveryLocationId: slip.deliveryLocationId,
            expectedDeliveryDate: slip.expectedDeliveryDate,
            lines: slip.lines.map((line) => ({
              productId: line.productId,
              unitCode: line.unitCode,
              orderedQtyBase: line.orderedQtyBase,
              unitPriceXaf: line.unitPriceXaf,
            })),
            localRef,
          }),
        },
        { commandType: 'procurement.order.submit', aggregateType: 'PURCHASE_ORDER', payload: {} },
      ];
    case 'VC':
      // Une visite papier n'a pas de position GPS : le serveur la signale (indicateurs), il ne la refuse pas.
      return [
        {
          commandType: 'crm.visit.record',
          aggregateType: 'VISIT',
          payload: compact({
            customerId: slip.customerId,
            position: null,
            outcomeReasonCodeId: slip.outcomeReasonCodeId,
            notes: withPaperRef(paperRef, slip.notes),
            nextActionAt: slip.nextActionAt,
            nextActionNote: nonEmpty(slip.nextActionNote),
          }),
        },
      ];
    case 'FI':
      // La fiche est ouverte, remplie à l'heure du comptage écrite sur la pièce, puis soumise : le serveur calcule le
      // théorique à cet instant et comptabilise ou demande la validation (BR-STK-042, BR-STK-043).
      return [
        {
          commandType: 'inventory.count.open',
          aggregateType: 'INVENTORY_COUNT',
          payload: compact({ locationId: slip.locationId, countType: slip.countType, localRef }),
        },
        {
          commandType: 'inventory.count.record_lines',
          aggregateType: 'INVENTORY_COUNT',
          payload: {
            countId: aggregateId,
            lines: slip.lines.map((line) => ({
              productId: line.productId,
              countedAt: occurredAt,
              countedQtyBase: line.countedQtyBase,
            })),
          },
        },
        {
          commandType: 'inventory.count.submit',
          aggregateType: 'INVENTORY_COUNT',
          payload: { countId: aggregateId },
        },
      ];
    case 'FL':
      return lotSheetParts(slip, paperRef, aggregateId);
    default:
      return [legacyCommandOf(slip, paperRef)];
  }
}

/** Type, agrégat et charge utile du serveur pour une pièce d'une seule commande. */
function legacyCommandOf(slip: SingleCommandSlip, paperRef: string): CommandPart {
  const localRef = localRefOf(slip.type, paperRef);
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
    case 'BC':
      return slip.totalXaf;
    default:
      return null;
  }
}

/**
 * Les commandes du serveur pour une pièce papier résolue (voir le tableau en tête de fichier), dans l'ordre d'envoi : une
 * seule pour la plupart des pièces, une chaîne pour le bon de commande (BC) et la fiche d'inventaire (FI), des commandes
 * indépendantes pour la fiche de suivi de lot (FL). Seule la première porte les indices du registre des carnets et la
 * photo ; dans une chaîne, les suivantes attendent la précédente.
 */
export function buildReportCommands(
  slip: ResolvedSlip,
  meta: ReportMeta,
): readonly ReportCommand[] {
  const parts = commandPartsOf(slip, meta.paperRef, meta.aggregateId, meta.occurredAt);
  const amount = slipAmountXaf(slip);
  const reason = nonEmpty(meta.backdatedReason ?? undefined);
  return parts.map((part, index) => ({
    commandType: part.commandType,
    aggregateType: part.aggregateType,
    aggregateId: part.aggregateId ?? meta.aggregateId,
    dependsOn: index === 0 ? [...(meta.dependsOn ?? [])] : [],
    dependsOnPrevious: index > 0 && part.independent !== true,
    payload: part.payload,
    occurredAt: part.occurredAt ?? meta.occurredAt,
    backdatedReason: reason ? reason.slice(0, MAX_BACKDATED_REASON) : null,
    capturedOffline: true as const,
    localFlags:
      index === 0
        ? [
            FLAG_PAPER_SLIP,
            `${FLAG_SLIP_TYPE}${slip.type}`,
            `${FLAG_PAPER_REF}${meta.paperRef}`,
            ...(amount !== null ? [`${FLAG_AMOUNT}${amount}`] : []),
          ]
        : [],
    photo: index === 0 ? slipPhotoTarget(slip.type) : null,
  }));
}

/** La commande d'une pièce en une seule commande ; pour BC et FI, la première de la chaîne (`buildReportCommands`). */
export function buildReportCommand(slip: ResolvedSlip, meta: ReportMeta): ReportCommand {
  return buildReportCommands(slip, meta)[0]!;
}
