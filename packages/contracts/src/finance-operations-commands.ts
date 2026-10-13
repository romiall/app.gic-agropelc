/**
 * Charges utiles des commandes de la finance opérationnelle (P8 ; ADR-021, ADR-060, ADR-061) :
 * catégories de dépense, dépenses, factures et paiements fournisseurs. Contrat partagé entre
 * l'appareil (dépense hors ligne) et le serveur, qui l'importe pour valider (un seul schéma).
 *
 * Règles communes : montants en XAF **entiers** (ADR-013) ; quantités en unité de base à trois
 * décimales au plus ; le serveur calcule seul le statut, le rapprochement, le reste dû et le reste
 * non affecté. L'identifiant de l'agrégat (catégorie, dépense, facture, paiement) est
 * l'`aggregate_id` de l'enveloppe ; les justificatifs sont les `attachment_ids` de l'enveloppe.
 */
import {
  EXPENSE_COST_OBJECT_TYPES,
  EXPENSE_LOT_COST_TYPES,
  EXPENSE_SPECIES_GROUPS,
} from '@gic/domain';
import { z } from 'zod';
import { positiveQuantitySchema } from './stock-transfer-commands.js';

const uuid = z.string().uuid();
const xafInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveXaf = xafInt.refine((value) => value > 0, 'Montant strictement positif attendu.');
const text = (max: number) => z.string().trim().min(1).max(max);
const reason = text(500);
/** Jour calendaire `AAAA-MM-JJ` existant (le 31 février est refusé). */
const businessDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date AAAA-MM-JJ attendue.')
  .refine((value) => {
    const day = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
  }, 'Date inexistante.');

/** Nombre maximal de lignes d'une facture et d'affectations d'un paiement. */
export const SUPPLIER_INVOICE_MAX_LINES = 100;
export const SUPPLIER_PAYMENT_MAX_ALLOCATIONS = 50;

// --- Catégories de dépense (finance.expense_category.*) ----------------------------------------

/** Code d'une catégorie : majuscules, chiffres et soulignés, comme les codes semés (AV-058). */
const categoryCode = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Code en majuscules, chiffres et soulignés (2 à 40).');

/** `finance.expense_category.create` — en ligne ; `NON_JUSTIFIEE` est réservé au système. */
export const expenseCategoryCreatePayloadSchema = z.object({
  code: categoryCode,
  label: text(120),
  defaultCostType: z.enum(EXPENSE_LOT_COST_TYPES).nullable().optional(),
  allowedOnPos: z.boolean().optional(),
});
export type ExpenseCategoryCreatePayload = z.infer<typeof expenseCategoryCreatePayloadSchema>;

/** `finance.expense_category.update` — au moins un champ ; le code ne change pas. */
export const expenseCategoryUpdatePayloadSchema = z
  .object({
    label: text(120).optional(),
    defaultCostType: z.enum(EXPENSE_LOT_COST_TYPES).nullable().optional(),
    allowedOnPos: z.boolean().optional(),
  })
  .refine((payload) => Object.values(payload).some((value) => value !== undefined), {
    message: 'Au moins un champ à modifier.',
  });
export type ExpenseCategoryUpdatePayload = z.infer<typeof expenseCategoryUpdatePayloadSchema>;

/** `finance.expense_category.deactivate` et `.reactivate` — motif obligatoire. */
export const expenseCategoryStatusPayloadSchema = z.object({ reason });
export type ExpenseCategoryStatusPayload = z.infer<typeof expenseCategoryStatusPayloadSchema>;

// --- Dépenses (finance.expense.*) ----------------------------------------------------------------

/** Objet de coût d'une dépense (ADR-060 §8) ; l'espèce ne vaut que pour un site (AV-356). */
const costObjectSchema = z
  .object({
    type: z.enum(EXPENSE_COST_OBJECT_TYPES),
    id: uuid,
    speciesGroup: z.enum(EXPENSE_SPECIES_GROUPS).optional(),
  })
  .refine((value) => value.type === 'SITE' || value.speciesGroup === undefined, {
    message: "L'espèce ne s'indique que pour une dépense imputée à un site.",
    path: ['speciesGroup'],
  });

/**
 * `finance.expense.record` — hors ligne possible (UC-FIN-08). Payée immédiatement : le compte
 * payeur est obligatoire ; à payer : aucun compte. `siteId` porte la numérotation et la portée.
 */
export const expenseRecordPayloadSchema = z
  .object({
    categoryId: uuid,
    amountXaf: positiveXaf,
    description: text(1000),
    payeeName: text(120).optional(),
    supplierId: uuid.optional(),
    siteId: uuid,
    costObject: costObjectSchema.optional(),
    paidNow: z.boolean(),
    paidFromAccountId: uuid.optional(),
    localRef: text(20).optional(),
  })
  .refine((payload) => payload.paidNow === (payload.paidFromAccountId !== undefined), {
    message: 'Une dépense payée indique son compte ; une dépense à payer n’en indique pas.',
    path: ['paidFromAccountId'],
  });
export type ExpenseRecordPayload = z.infer<typeof expenseRecordPayloadSchema>;

/** `finance.expense.pay` — en ligne ; dépense enregistrée ou approuvée. */
export const expensePayPayloadSchema = z.object({ paidFromAccountId: uuid });
export type ExpensePayPayload = z.infer<typeof expensePayPayloadSchema>;

/** `finance.expense.cancel` — en ligne ; dépense non payée. */
export const expenseCancelPayloadSchema = z.object({ reason });
export type ExpenseCancelPayload = z.infer<typeof expenseCancelPayloadSchema>;

// --- Factures fournisseurs (finance.supplier_invoice.*) -----------------------------------------

const invoiceLineSchema = z.object({
  poLineId: uuid.optional(),
  receiptLineId: uuid.optional(),
  productId: uuid.optional(),
  description: text(200),
  quantity: positiveQuantitySchema.optional(),
  unitPriceXaf: xafInt.optional(),
  lineTotalXaf: xafInt,
});

/** `finance.supplier_invoice.record` — en ligne ; rapprochement par le serveur (BR-FIN-031). */
export const supplierInvoiceRecordPayloadSchema = z
  .object({
    supplierId: uuid,
    supplierInvoiceRef: text(60),
    invoiceDate: businessDay,
    dueDate: businessDay.optional(),
    purchaseOrderId: uuid.optional(),
    printedTotalXaf: xafInt.optional(),
    lines: z.array(invoiceLineSchema).min(1).max(SUPPLIER_INVOICE_MAX_LINES),
    comment: text(500).optional(),
  })
  .refine((payload) => payload.dueDate === undefined || payload.dueDate >= payload.invoiceDate, {
    message: "L'échéance précède la date de facture.",
    path: ['dueDate'],
  })
  .refine(
    (payload) =>
      payload.purchaseOrderId !== undefined ||
      payload.lines.every((line) => line.poLineId === undefined),
    {
      message: 'Une ligne rattachée à un bon de commande exige le bon de commande.',
      path: ['lines'],
    },
  );
export type SupplierInvoiceRecordPayload = z.infer<typeof supplierInvoiceRecordPayloadSchema>;

/** `finance.supplier_invoice.dispute`, `.approve`, `.cancel` — en ligne, motif obligatoire. */
export const supplierInvoiceDecisionPayloadSchema = z.object({ reason });
export type SupplierInvoiceDecisionPayload = z.infer<typeof supplierInvoiceDecisionPayloadSchema>;

// --- Paiements fournisseurs (finance.supplier_payment.*) ----------------------------------------

const allocationsSchema = z
  .array(z.object({ invoiceId: uuid, amountXaf: positiveXaf }))
  .max(SUPPLIER_PAYMENT_MAX_ALLOCATIONS)
  .refine(
    (allocations) =>
      new Set(allocations.map((allocation) => allocation.invoiceId)).size === allocations.length,
    { message: 'Une facture apparaît deux fois dans les affectations.' },
  );

/** `finance.supplier_payment.record` — en ligne ; le reste non affecté est une avance (AV-362). */
export const supplierPaymentRecordPayloadSchema = z
  .object({
    supplierId: uuid,
    amountXaf: positiveXaf,
    paymentMethodCode: text(30),
    fromAccountId: uuid,
    externalReference: text(80).optional(),
    allocations: allocationsSchema,
    comment: text(500).optional(),
  })
  .refine(
    (payload) =>
      payload.allocations.reduce((sum, allocation) => sum + allocation.amountXaf, 0) <=
      payload.amountXaf,
    { message: 'Les affectations dépassent le montant du paiement.', path: ['allocations'] },
  );
export type SupplierPaymentRecordPayload = z.infer<typeof supplierPaymentRecordPayloadSchema>;

/** `finance.supplier_payment.allocate` — en ligne ; affecte tout ou partie d'une avance. */
export const supplierPaymentAllocatePayloadSchema = z.object({
  allocations: allocationsSchema.refine((allocations) => allocations.length > 0, {
    message: 'Au moins une affectation.',
  }),
});
export type SupplierPaymentAllocatePayload = z.infer<typeof supplierPaymentAllocatePayloadSchema>;

/** `finance.supplier_payment.cancel` — en ligne, motif obligatoire (AV-364). */
export const supplierPaymentCancelPayloadSchema = z.object({ reason });
export type SupplierPaymentCancelPayload = z.infer<typeof supplierPaymentCancelPayloadSchema>;
