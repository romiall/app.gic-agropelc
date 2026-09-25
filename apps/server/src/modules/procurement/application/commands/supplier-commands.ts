/**
 * Fiche fournisseur seule (procurement.suppliers, dictionnaire §suppliers ; CM §26). Le
 * reste du module (demandes d'achat, BC, réceptions) arrive en P6, avec `inventory`.
 */
import { z } from 'zod';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';

function notFound(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr };
}

const createPayloadSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  suppliedCategories: z.array(z.string().min(1).max(40)).optional(),
  contactName: z.string().max(200).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().email().max(200).optional(),
  address: z.string().max(2000).optional(),
  taxId: z.string().max(40).optional(),
  paymentTermsDays: z.number().int().nonnegative().optional(),
  notes: z.string().max(2000).optional(),
});
type CreatePayload = z.infer<typeof createPayloadSchema>;

const create: CommandHandler<CreatePayload> = async (uow, envelope) => {
  const id = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('procurement_suppliers')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' };

  const {
    code,
    name,
    suppliedCategories,
    contactName,
    phone,
    email,
    address,
    taxId,
    paymentTermsDays,
    notes,
  } = envelope.payload;

  await uow
    .insertInto('procurement_suppliers')
    .values({
      id,
      code,
      name,
      supplied_categories: jsonValue(suppliedCategories ?? []),
      contact_name: contactName ?? null,
      phone: phone ?? null,
      email: email ?? null,
      address: address ?? null,
      tax_id: taxId ?? null,
      payment_terms_days: paymentTermsDays ?? null,
      notes: notes ?? null,
      created_by: toBin(envelope.author_user_id),
    })
    .execute();
  return { status: 'APPLIED' };
};

const updatePayloadSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  suppliedCategories: z.array(z.string().min(1).max(40)).optional(),
  contactName: z.string().max(200).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().email().max(200).optional(),
  address: z.string().max(2000).optional(),
  taxId: z.string().max(40).optional(),
  paymentTermsDays: z.number().int().nonnegative().optional(),
  notes: z.string().max(2000).optional(),
});
type UpdatePayload = z.infer<typeof updatePayloadSchema>;

const update: CommandHandler<UpdatePayload> = async (uow, envelope) => {
  const id = toBin(envelope.aggregate_id);
  const supplier = await uow
    .selectFrom('procurement_suppliers')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  if (!supplier) return notFound('Fournisseur introuvable.');

  const {
    name,
    suppliedCategories,
    contactName,
    phone,
    email,
    address,
    taxId,
    paymentTermsDays,
    notes,
  } = envelope.payload;

  await uow
    .updateTable('procurement_suppliers')
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(suppliedCategories !== undefined
        ? { supplied_categories: jsonValue(suppliedCategories) }
        : {}),
      ...(contactName !== undefined ? { contact_name: contactName } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(address !== undefined ? { address } : {}),
      ...(taxId !== undefined ? { tax_id: taxId } : {}),
      ...(paymentTermsDays !== undefined ? { payment_terms_days: paymentTermsDays } : {}),
      ...(notes !== undefined ? { notes } : {}),
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', id)
    .execute();
  return { status: 'APPLIED' };
};

const emptySchema = z.object({});

function setStatus(status: 'ACTIVE' | 'INACTIVE'): CommandHandler<Record<string, never>> {
  return async (uow, envelope) => {
    const id = toBin(envelope.aggregate_id);
    const supplier = await uow
      .selectFrom('procurement_suppliers')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!supplier) return notFound('Fournisseur introuvable.');
    await uow
      .updateTable('procurement_suppliers')
      .set({ status, updated_by: toBin(envelope.author_user_id), version: sql`version + 1` })
      .where('id', '=', id)
      .execute();
    return { status: 'APPLIED' };
  };
}

export function registerSupplierCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'procurement.supplier.create',
    version: 1,
    payloadSchema: createPayloadSchema,
    permissionCode: 'procurement.supplier.manage',
    handler: create,
  });
  registry.register({
    commandType: 'procurement.supplier.update',
    version: 1,
    payloadSchema: updatePayloadSchema,
    permissionCode: 'procurement.supplier.manage',
    handler: update,
  });
  registry.register({
    commandType: 'procurement.supplier.deactivate',
    version: 1,
    payloadSchema: emptySchema,
    permissionCode: 'procurement.supplier.manage',
    handler: setStatus('INACTIVE'),
  });
  registry.register({
    commandType: 'procurement.supplier.reactivate',
    version: 1,
    payloadSchema: emptySchema,
    permissionCode: 'procurement.supplier.manage',
    handler: setStatus('ACTIVE'),
  });
}
