/**
 * Catégories de dépense (P8-04 ; AV-058, AV-270 ; ADR-042 §9 ; dictionnaire
 * `finance.expense_categories`) : création, modification, désactivation et réactivation, par le
 * titulaire de `finance.expense_category.manage` (Finance, Administrateur). En ligne seulement.
 *
 * - Le code est la clé naturelle, unique et immuable (`EXPENSE_CATEGORY_DUPLICATE`).
 * - Une catégorie système (`NON_JUSTIFIEE`, BR-FIN-022) ne se modifie ni ne se désactive
 *   (`EXPENSE_CATEGORY_SYSTEM`) : la reclassification d'une dépense rejetée en dépend.
 * - Rien ne disparaît : une catégorie se désactive (motif), les dépenses existantes la gardent.
 * - Chaque écriture publie la catégorie dans le jeu `catalog` (`emitExpenseCategoryChange`).
 */
import { sql } from 'kysely';
import {
  expenseCategoryCreatePayloadSchema,
  expenseCategoryStatusPayloadSchema,
  expenseCategoryUpdatePayloadSchema,
  type ExpenseCategoryCreatePayload,
  type ExpenseCategoryStatusPayload,
  type ExpenseCategoryUpdatePayload,
} from '@gic/contracts';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { emitExpenseCategoryChange } from '../sync-changes.js';

const PERMISSION = 'finance.expense_category.manage';

const rejected = (errorCode: string, messageFr: string): CommandHandlerOutcome => ({
  status: 'REJECTED',
  errorCode,
  messageFr,
});

const onlineOnly = (capturedOffline: boolean): CommandHandlerOutcome | null =>
  capturedOffline
    ? rejected('ONLINE_REQUIRED', 'Les catégories de dépense se gèrent en ligne.')
    : null;

const create: CommandHandler<ExpenseCategoryCreatePayload> = async (uow, envelope) => {
  const offline = onlineOnly(envelope.captured_offline);
  if (offline) return offline;
  const id = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('finance_expense_categories')
    .select('code')
    .where('id', '=', id)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' }; // rejeu idempotent
  const { code, label, defaultCostType, allowedOnPos } = envelope.payload;
  const taken = await uow
    .selectFrom('finance_expense_categories')
    .select('id')
    .where('code', '=', code)
    .executeTakeFirst();
  if (taken) {
    return rejected('EXPENSE_CATEGORY_DUPLICATE', 'Une catégorie de dépense porte déjà ce code.');
  }
  await uow
    .insertInto('finance_expense_categories')
    .values({
      id,
      code,
      label,
      default_cost_type: defaultCostType ?? null,
      allowed_on_pos: allowedOnPos === true ? 1 : 0,
      created_by: toBin(envelope.author_user_id),
    })
    .execute();
  await emitExpenseCategoryChange(uow, envelope.aggregate_id);
  return { status: 'APPLIED' };
};

/** Catégorie verrouillée pour une modification ; refus si absente ou système. */
async function editable(
  uow: Parameters<CommandHandler<unknown>>[0],
  categoryId: string,
): Promise<
  | { readonly ok: true; readonly isActive: boolean }
  | { readonly ok: false; readonly outcome: CommandHandlerOutcome }
> {
  const row = await uow
    .selectFrom('finance_expense_categories')
    .select(['is_active', 'is_system'])
    .where('id', '=', toBin(categoryId))
    .forUpdate()
    .executeTakeFirst();
  if (!row) {
    return { ok: false, outcome: rejected('NOT_FOUND', 'Catégorie de dépense introuvable.') };
  }
  if (row.is_system) {
    return {
      ok: false,
      outcome: rejected(
        'EXPENSE_CATEGORY_SYSTEM',
        'Cette catégorie est réservée au système (dépense non justifiée) : elle ne se modifie pas.',
      ),
    };
  }
  return { ok: true, isActive: Boolean(row.is_active) };
}

const update: CommandHandler<ExpenseCategoryUpdatePayload> = async (uow, envelope) => {
  const offline = onlineOnly(envelope.captured_offline);
  if (offline) return offline;
  const category = await editable(uow, envelope.aggregate_id);
  if (!category.ok) return category.outcome;
  const { label, defaultCostType, allowedOnPos } = envelope.payload;
  await uow
    .updateTable('finance_expense_categories')
    .set({
      ...(label !== undefined ? { label } : {}),
      ...(defaultCostType !== undefined ? { default_cost_type: defaultCostType } : {}),
      ...(allowedOnPos !== undefined ? { allowed_on_pos: allowedOnPos ? 1 : 0 } : {}),
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(envelope.aggregate_id))
    .execute();
  await emitExpenseCategoryChange(uow, envelope.aggregate_id);
  return { status: 'APPLIED' };
};

function setActive(active: boolean): CommandHandler<ExpenseCategoryStatusPayload> {
  return async (uow, envelope) => {
    const offline = onlineOnly(envelope.captured_offline);
    if (offline) return offline;
    const category = await editable(uow, envelope.aggregate_id);
    if (!category.ok) return category.outcome;
    if (category.isActive === active) return { status: 'APPLIED' }; // déjà dans l'état demandé
    await uow
      .updateTable('finance_expense_categories')
      .set({
        is_active: active ? 1 : 0,
        status_reason: envelope.payload.reason,
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(envelope.aggregate_id))
      .execute();
    await emitExpenseCategoryChange(uow, envelope.aggregate_id);
    return { status: 'APPLIED' };
  };
}

export function registerExpenseCategoryCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'finance.expense_category.create',
    version: 1,
    payloadSchema: expenseCategoryCreatePayloadSchema,
    permissionCode: PERMISSION,
    handler: create,
  });
  registry.register({
    commandType: 'finance.expense_category.update',
    version: 1,
    payloadSchema: expenseCategoryUpdatePayloadSchema,
    permissionCode: PERMISSION,
    handler: update,
  });
  registry.register({
    commandType: 'finance.expense_category.deactivate',
    version: 1,
    payloadSchema: expenseCategoryStatusPayloadSchema,
    permissionCode: PERMISSION,
    handler: setActive(false),
  });
  registry.register({
    commandType: 'finance.expense_category.reactivate',
    version: 1,
    payloadSchema: expenseCategoryStatusPayloadSchema,
    permissionCode: PERMISSION,
    handler: setActive(true),
  });
}
