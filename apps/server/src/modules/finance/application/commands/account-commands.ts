/**
 * Comptes de trésorerie (D09 §7.2 ; BR-FIN-010 ; dictionnaire `finance.cash_accounts`) : création,
 * modification, désactivation, par le titulaire de `finance.cash_account.manage` (Admin).
 *
 * - Cinq types : `CAISSE_PDV` (site requis, une active par site), `CAISSE_UTILISATEUR` (détenteur
 *   requis, une active par détenteur), `CAISSE_CENTRALE`, `MOBILE_MONEY`, `BANQUE`. Chaque compte
 *   a un responsable (utilisateur actif). Le solde part de 0 : il ne se saisit jamais, il vient
 *   des mouvements (INV-FIN-02) ; un solde d'ouverture est un mouvement `OPENING_BALANCE`.
 * - Désactivation (« DÉSACTIVATION, solde nul ») : refusée tant que le solde n'est pas nul. Les
 *   sessions de caisse ouvertes (P5) s'ajouteront à cette condition.
 */
import { z } from 'zod';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { CASH_ACCOUNT_TYPES } from '../public/cash-accounts.js';

const PERMISSION = 'finance.cash_account.manage';

const createPayloadSchema = z
  .object({
    code: z.string().min(1).max(40),
    name: z.string().min(1).max(200),
    accountType: z.enum(CASH_ACCOUNT_TYPES),
    siteId: z.string().uuid().optional(),
    holderUserId: z.string().uuid().optional(),
    responsibleUserId: z.string().uuid(),
    externalRef: z.string().min(1).max(60).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.accountType === 'CAISSE_PDV' && data.siteId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CAISSE_PDV exige siteId.' });
    }
    if (data.accountType === 'CAISSE_UTILISATEUR' && data.holderUserId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CAISSE_UTILISATEUR exige holderUserId.',
      });
    }
  });

const updatePayloadSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  responsibleUserId: z.string().uuid().optional(),
  externalRef: z.string().min(1).max(60).optional(),
});

type CreatePayload = z.infer<typeof createPayloadSchema>;
type UpdatePayload = z.infer<typeof updatePayloadSchema>;
type Uow = Parameters<CommandHandler<unknown>>[0];

function rejected(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}

async function activeUserExists(uow: Uow, userId: string): Promise<boolean> {
  const user = await uow
    .selectFrom('identity_users')
    .select('status')
    .where('id', '=', toBin(userId))
    .executeTakeFirst();
  return user?.status === 'ACTIVE';
}

const create: CommandHandler<CreatePayload> = async (uow, envelope) => {
  const accountId = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('finance_cash_accounts')
    .select('id')
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' }; // rejeu idempotent

  const { code, name, accountType, siteId, holderUserId, responsibleUserId, externalRef } =
    envelope.payload;
  if (!(await activeUserExists(uow, responsibleUserId))) {
    return rejected('CASH_ACCOUNT_INVALID', 'Le responsable doit être un utilisateur actif.');
  }
  if (holderUserId !== undefined && !(await activeUserExists(uow, holderUserId))) {
    return rejected('CASH_ACCOUNT_INVALID', 'Le détenteur doit être un utilisateur actif.');
  }
  if (siteId !== undefined) {
    const site = await uow
      .selectFrom('organization_sites')
      .select('id')
      .where('id', '=', toBin(siteId))
      .executeTakeFirst();
    if (!site) return rejected('NOT_FOUND', 'Site introuvable.');
  }
  const codeTaken = await uow
    .selectFrom('finance_cash_accounts')
    .select('id')
    .where('code', '=', code)
    .executeTakeFirst();
  if (codeTaken) return rejected('CASH_ACCOUNT_DUPLICATE', 'Ce code de compte existe déjà.');
  // BR-FIN-010 : une caisse de PDV active par site, une caisse d'utilisateur active par détenteur.
  if (accountType === 'CAISSE_PDV') {
    const existing = await uow
      .selectFrom('finance_cash_accounts')
      .select('id')
      .where('account_type', '=', 'CAISSE_PDV')
      .where('status', '=', 'ACTIVE')
      .where('site_id', '=', toBin(siteId!))
      .executeTakeFirst();
    if (existing) {
      return rejected('CASH_ACCOUNT_DUPLICATE', 'Ce site a déjà une caisse de PDV active.');
    }
  }
  if (accountType === 'CAISSE_UTILISATEUR') {
    const existing = await uow
      .selectFrom('finance_cash_accounts')
      .select('id')
      .where('account_type', '=', 'CAISSE_UTILISATEUR')
      .where('status', '=', 'ACTIVE')
      .where('holder_user_id', '=', toBin(holderUserId!))
      .executeTakeFirst();
    if (existing) {
      return rejected('CASH_ACCOUNT_DUPLICATE', 'Ce détenteur a déjà une caisse active.');
    }
  }

  await uow
    .insertInto('finance_cash_accounts')
    .values({
      id: accountId,
      code,
      name,
      account_type: accountType,
      site_id: toBinOrNull(siteId ?? null),
      holder_user_id: toBinOrNull(holderUserId ?? null),
      responsible_user_id: toBin(responsibleUserId),
      external_ref: externalRef ?? null,
      created_by: toBin(envelope.author_user_id),
    })
    .execute();
  return { status: 'APPLIED' };
};

const update: CommandHandler<UpdatePayload> = async (uow, envelope) => {
  const accountId = toBin(envelope.aggregate_id);
  const account = await uow
    .selectFrom('finance_cash_accounts')
    .select('id')
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (!account) return rejected('NOT_FOUND', 'Compte de trésorerie introuvable.');
  const { name, responsibleUserId, externalRef } = envelope.payload;
  if (responsibleUserId !== undefined && !(await activeUserExists(uow, responsibleUserId))) {
    return rejected('CASH_ACCOUNT_INVALID', 'Le responsable doit être un utilisateur actif.');
  }
  await uow
    .updateTable('finance_cash_accounts')
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(responsibleUserId !== undefined ? { responsible_user_id: toBin(responsibleUserId) } : {}),
      ...(externalRef !== undefined ? { external_ref: externalRef } : {}),
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', accountId)
    .execute();
  return { status: 'APPLIED' };
};

const deactivate: CommandHandler<Record<string, never>> = async (uow, envelope) => {
  const accountId = toBin(envelope.aggregate_id);
  const account = await uow
    .selectFrom('finance_cash_accounts')
    .select(['status', 'balance_xaf'])
    .where('id', '=', accountId)
    .forUpdate()
    .executeTakeFirst();
  if (!account) return rejected('NOT_FOUND', 'Compte de trésorerie introuvable.');
  if (account.status === 'INACTIVE') return { status: 'APPLIED' }; // rejeu idempotent
  if (Number(account.balance_xaf) !== 0) {
    return rejected(
      'CASH_ACCOUNT_NOT_EMPTY',
      'Le solde du compte doit être nul pour le désactiver : remettre les fonds avant.',
    );
  }
  await uow
    .updateTable('finance_cash_accounts')
    .set({
      status: 'INACTIVE',
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', accountId)
    .execute();
  return { status: 'APPLIED' };
};

export function registerAccountCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'finance.cash_account.create',
    version: 1,
    payloadSchema: createPayloadSchema,
    permissionCode: PERMISSION,
    handler: create,
  });
  registry.register({
    commandType: 'finance.cash_account.update',
    version: 1,
    payloadSchema: updatePayloadSchema,
    permissionCode: PERMISSION,
    handler: update,
  });
  registry.register({
    commandType: 'finance.cash_account.deactivate',
    version: 1,
    payloadSchema: z.object({}),
    permissionCode: PERMISSION,
    handler: deactivate,
  });
}
