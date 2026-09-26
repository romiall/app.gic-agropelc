/**
 * Objectifs commerciaux (UC-CRM-10 ; BR-CRM-018, AV-016) : `crm.target.set`, `crm.target.cancel`
 * — en ligne. Un objectif n'est pas modifiable : on l'annule et on en définit un nouveau
 * (déclencheur). Deux objectifs actifs de même cible, métrique et produit ne se chevauchent pas
 * (`TARGET_OVERLAP`, revérifié par déclencheur).
 *
 * Portée (RC-04) : cible `USER` → le commercial visé (portée `TEAM` d'un responsable sur son
 * équipe) ; `SITE` → le site ; `TEAM` → le responsable de l'équipe, ou une portée `ALL` (DÉDUIT :
 * une ressource « équipe » n'a ni titulaire ni site). Montants (`CA`) et comptages en entiers ;
 * seule une quantité de produit peut être décimale (ADR-013, `numeric(14,3)`).
 */
import { z } from 'zod';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { fromBinOrNull, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import type { ResourceLocator } from '../../../identity/application/public/index.js';
import { DATE_ONLY, FORBIDDEN_SCOPE, dateColumn, isAllowed, rejected, type Uow } from './shared.js';
import { emitTargetChange } from '../sync-changes.js';

const setPayloadSchema = z
  .object({
    targetType: z.enum(['USER', 'TEAM', 'SITE']),
    userId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    siteId: z.string().uuid().optional(),
    metric: z.enum(['CA', 'QTE_PRODUIT', 'NOUVEAUX_CLIENTS', 'VISITES', 'PROSPECTS_CREES']),
    productId: z.string().uuid().optional(),
    periodStart: z.string().regex(DATE_ONLY),
    periodEnd: z.string().regex(DATE_ONLY),
    targetValue: z.number().positive().max(9_999_999_999_999),
  })
  .superRefine((p, ctx) => {
    const targets = { USER: p.userId, TEAM: p.teamId, SITE: p.siteId };
    const provided = Object.entries(targets).filter(([, v]) => v !== undefined);
    if (provided.length !== 1 || targets[p.targetType] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Une seule cible, conforme à targetType (BR-CRM-018).',
      });
    }
    if ((p.metric === 'QTE_PRODUIT') !== (p.productId !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Un produit est requis pour QTE_PRODUIT, et seulement pour elle.',
      });
    }
    if (p.metric !== 'QTE_PRODUIT' && !Number.isInteger(p.targetValue)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Montant (XAF) ou comptage : valeur entière.',
      });
    }
    if (p.periodEnd < p.periodStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Période invalide.' });
    }
  });
type SetPayload = z.infer<typeof setPayloadSchema>;

const cancelPayloadSchema = z.object({ comment: z.string().trim().min(1).max(2000).optional() });

interface TargetRef {
  readonly targetType: string;
  readonly userId: string | null;
  readonly teamId: string | null;
  readonly siteId: string | null;
}

/** Droit de gérer les objectifs de cette cible (voir l'en-tête). */
async function canManage(uow: Uow, author: string, at: Date, target: TargetRef): Promise<boolean> {
  let resource: ResourceLocator = {};
  if (target.targetType === 'USER' && target.userId !== null) {
    resource = { ownerUserId: target.userId };
  } else if (target.targetType === 'SITE' && target.siteId !== null) {
    resource = { siteId: target.siteId };
  } else if (target.targetType === 'TEAM' && target.teamId !== null) {
    const team = await uow
      .selectFrom('organization_teams')
      .select('manager_user_id')
      .where('id', '=', toBin(target.teamId))
      .executeTakeFirst();
    if (team?.manager_user_id && team.manager_user_id.equals(toBin(author))) return true;
  }
  return isAllowed(uow, author, 'crm.target.manage', at, resource);
}

async function targetExists(uow: Uow, p: SetPayload): Promise<boolean> {
  if (p.targetType === 'USER') {
    const row = await uow
      .selectFrom('identity_users')
      .select('id')
      .where('id', '=', toBin(p.userId!))
      .executeTakeFirst();
    return row !== undefined;
  }
  if (p.targetType === 'TEAM') {
    const row = await uow
      .selectFrom('organization_teams')
      .select('id')
      .where('id', '=', toBin(p.teamId!))
      .executeTakeFirst();
    return row !== undefined;
  }
  const row = await uow
    .selectFrom('organization_sites')
    .select('id')
    .where('id', '=', toBin(p.siteId!))
    .executeTakeFirst();
  return row !== undefined;
}

const setTarget: CommandHandler<SetPayload> = async (uow, envelope) => {
  const id = toBin(envelope.aggregate_id);
  const replay = await uow
    .selectFrom('crm_sales_targets')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  if (replay) return { status: 'APPLIED' };
  const p = envelope.payload;
  const at = new Date(envelope.occurred_at);
  const author = envelope.author_user_id;
  if (!(await targetExists(uow, p))) {
    return rejected('REFERENCE_INVALID', "Cible de l'objectif introuvable.");
  }
  if (p.productId !== undefined) {
    const product = await uow
      .selectFrom('catalog_products')
      .select('id')
      .where('id', '=', toBin(p.productId))
      .executeTakeFirst();
    if (!product) return rejected('REFERENCE_INVALID', 'Produit introuvable.');
  }
  const target: TargetRef = {
    targetType: p.targetType,
    userId: p.userId ?? null,
    teamId: p.teamId ?? null,
    siteId: p.siteId ?? null,
  };
  if (!(await canManage(uow, author, at, target))) return FORBIDDEN_SCOPE;

  const overlapping = await uow
    .selectFrom('crm_sales_targets')
    .select('id')
    .where('status', '=', 'ACTIVE')
    .where('target_type', '=', p.targetType)
    .where(sql<boolean>`user_id <=> ${toBinOrNull(target.userId)}`)
    .where(sql<boolean>`team_id <=> ${toBinOrNull(target.teamId)}`)
    .where(sql<boolean>`site_id <=> ${toBinOrNull(target.siteId)}`)
    .where('metric', '=', p.metric)
    .where(sql<boolean>`product_id <=> ${toBinOrNull(p.productId ?? null)}`)
    .where(sql<boolean>`period_start <= ${p.periodEnd}`)
    .where(sql<boolean>`period_end >= ${p.periodStart}`)
    .forUpdate()
    .executeTakeFirst();
  if (overlapping) {
    return rejected(
      'TARGET_OVERLAP',
      'Un objectif actif de même cible, métrique et produit couvre déjà cette période (BR-CRM-018).',
    );
  }
  await uow
    .insertInto('crm_sales_targets')
    .values({
      id,
      target_type: p.targetType,
      user_id: toBinOrNull(target.userId),
      team_id: toBinOrNull(target.teamId),
      site_id: toBinOrNull(target.siteId),
      metric: p.metric,
      product_id: toBinOrNull(p.productId ?? null),
      period_start: dateColumn(p.periodStart),
      period_end: dateColumn(p.periodEnd),
      target_value: String(p.targetValue),
      created_by: toBin(author),
    })
    .execute();
  await emitTargetChange(uow, envelope.aggregate_id);
  return { status: 'APPLIED' };
};

const cancelTarget: CommandHandler<z.infer<typeof cancelPayloadSchema>> = async (uow, envelope) => {
  const row = await uow
    .selectFrom('crm_sales_targets')
    .select(['id', 'status', 'target_type', 'user_id', 'team_id', 'site_id'])
    .where('id', '=', toBin(envelope.aggregate_id))
    .forUpdate()
    .executeTakeFirst();
  if (!row) return rejected('TARGET_NOT_FOUND', 'Objectif introuvable.');
  if (row.status === 'CANCELLED') return rejected('ALREADY_CANCELLED', 'Objectif déjà annulé.');
  const at = new Date(envelope.occurred_at);
  const author = envelope.author_user_id;
  const target: TargetRef = {
    targetType: row.target_type,
    userId: fromBinOrNull(row.user_id),
    teamId: fromBinOrNull(row.team_id),
    siteId: fromBinOrNull(row.site_id),
  };
  if (!(await canManage(uow, author, at, target))) return FORBIDDEN_SCOPE;
  await uow
    .updateTable('crm_sales_targets')
    .set({ status: 'CANCELLED', updated_by: toBin(author), version: sql`version + 1` })
    .where('id', '=', row.id)
    .execute();
  await emitTargetChange(uow, envelope.aggregate_id);
  return { status: 'APPLIED' };
};

export function registerTargetCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'crm.target.set',
    version: 1,
    payloadSchema: setPayloadSchema,
    permissionCode: 'crm.target.manage',
    handler: setTarget,
  });
  registry.register({
    commandType: 'crm.target.cancel',
    version: 1,
    payloadSchema: cancelPayloadSchema,
    permissionCode: 'crm.target.manage',
    handler: cancelTarget,
  });
}
