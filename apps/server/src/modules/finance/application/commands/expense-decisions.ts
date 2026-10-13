/**
 * Décision `EXPENSE` (P8-06 ; ADR-060 §2, §7, §8 ; SM-EXPENSE ; BR-FIN-021, BR-FIN-022 ; AV-350,
 * AV-355) : gestionnaire appelé par `approvals.request.approve` / `reject` (`decideApprovalRequest`,
 * qui a déjà vérifié la permission et la portée de l'approbateur, l'auto-approbation et les pièces
 * exigées).
 *
 * - **Approbation** : `PENDING_APPROVAL` → `APPROVED`, `PAID_PENDING_APPROVAL` → `PAID` ; l'écriture de
 *   coût de la dépense imputée est posée à ce moment (BR-FIN-022), à la date de la dépense.
 * - **Limite par rôle** (RC-06, AV-350) : `limits.maxAmountXaf` du droit `finance.expense.approve` de
 *   l'approbateur, combiné entre ses rôles (le plus permissif) ; au-delà, refus
 *   `APPROVAL_LIMIT_EXCEEDED` (la demande reste en attente).
 * - **Rejet** : `PENDING_APPROVAL` → `REJECTED` ; `PAID_PENDING_APPROVAL` → `PAID_REJECTED` : le
 *   décaissement reste, la dépense est reclassée dans la catégorie système `NON_JUSTIFIEE` et imputée à
 *   son déclarant (`responsibility_user_id`), sans écriture de coût (AV-355, comme une perte non
 *   justifiée, AV-038).
 * - **Retrait** par le demandeur : refusé (`EXPENSE_NOT_WITHDRAWABLE`) ; une dépense non payée
 *   s'annule par `finance.expense.cancel`, une dépense payée attend sa décision.
 */
import {
  UNJUSTIFIED_EXPENSE_CATEGORY_CODE,
  expenseApprovalWithinLimits,
  expenseTransition,
  type IdGenerator,
} from '@gic/domain';
import { sql } from 'kysely';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { evaluateAccessLimits } from '../../../identity/application/public/index.js';
import {
  ApprovalDecisionRefused,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import {
  EXPENSE_APPROVE_PERMISSION,
  insertExpenseEvent,
  loadExpense,
  loadExpenseCategory,
  writeExpenseCost,
} from '../expense-support.js';
import { emitExpenseChange } from '../sync-changes.js';

export function registerExpenseDecisions(
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
): void {
  const deps = { idGenerator };

  decisionRegistry.register('EXPENSE', async (uow, ctx) => {
    const expense = await loadExpense(uow, ctx.subjectId, { lock: 'update' });
    if (!expense) throw new ApprovalDecisionRefused('NOT_FOUND', 'Dépense introuvable.');
    const action = ctx.decision === 'APPROVED' ? 'APPROVE' : 'REJECT';
    let next;
    try {
      next = expenseTransition(expense.status, action);
    } catch {
      throw new ApprovalDecisionRefused(
        'EXPENSE_STATUS_INVALID',
        `Dépense ${expense.status} : aucune décision attendue.`,
      );
    }

    if (ctx.decision === 'APPROVED') {
      const limits = await evaluateAccessLimits(uow, {
        userId: ctx.decidedBy,
        permissionCode: EXPENSE_APPROVE_PERMISSION,
        occurredAt: ctx.decidedAt,
        resource: { siteId: expense.siteId },
      });
      if (!expenseApprovalWithinLimits(expense.amountXaf, limits)) {
        throw new ApprovalDecisionRefused(
          'APPROVAL_LIMIT_EXCEEDED',
          'Montant au-delà de votre plafond d’approbation des dépenses (RC-06).',
        );
      }
      const category = await loadExpenseCategory(uow, expense.categoryId);
      await uow
        .updateTable('finance_expenses')
        .set({ status: next, updated_by: toBin(ctx.decidedBy), version: sql`version + 1` })
        .where('id', '=', toBin(expense.id))
        .execute();
      // BR-FIN-022 : l'écriture de coût d'une dépense validée est posée à l'approbation.
      await writeExpenseCost(uow, deps, {
        expense,
        categoryCostType: category?.defaultCostType ?? null,
        createdBy: ctx.decidedBy,
      });
      await insertExpenseEvent(uow, idGenerator, {
        eventType: 'ExpenseApproved',
        expenseId: expense.id,
        occurredAt: ctx.decidedAt,
        commandId: null,
        payload: { docNumber: expense.docNumber, status: next, decidedBy: ctx.decidedBy },
      });
    } else {
      const unjustified =
        next === 'PAID_REJECTED'
          ? await uow
              .selectFrom('finance_expense_categories')
              .select('id')
              .where('code', '=', UNJUSTIFIED_EXPENSE_CATEGORY_CODE)
              .executeTakeFirst()
          : undefined;
      if (next === 'PAID_REJECTED' && !unjustified) {
        throw new ApprovalDecisionRefused(
          'EXPENSE_CATEGORY_UNKNOWN',
          'Catégorie système NON_JUSTIFIEE absente : relancer le seed.',
        );
      }
      await uow
        .updateTable('finance_expenses')
        .set({
          status: next,
          ...(unjustified
            ? {
                reclassified_category_id: unjustified.id,
                responsibility_user_id: toBin(expense.createdBy),
              }
            : {}),
          updated_by: toBin(ctx.decidedBy),
          version: sql`version + 1`,
        })
        .where('id', '=', toBin(expense.id))
        .execute();
      await insertExpenseEvent(uow, idGenerator, {
        eventType: 'ExpenseRejected',
        expenseId: expense.id,
        occurredAt: ctx.decidedAt,
        commandId: null,
        payload: {
          docNumber: expense.docNumber,
          status: next,
          decidedBy: ctx.decidedBy,
          ...(unjustified ? { responsibilityUserId: expense.createdBy } : {}),
        },
      });
    }
    await emitExpenseChange(uow, expense.id);
  });

  decisionRegistry.registerWithdrawalGuard('EXPENSE', async () => {
    throw new ApprovalDecisionRefused(
      'EXPENSE_NOT_WITHDRAWABLE',
      'Une dépense non payée s’annule par « Annuler la dépense » ; une dépense payée attend sa décision.',
    );
  });
}
