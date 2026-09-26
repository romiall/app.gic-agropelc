/**
 * `crm.pipeline.configure` (UC-CRM-14 ; AV-011 : étapes intermédiaires du pipeline
 * configurables, terminaux `CUSTOMER`/`LOST` fixes). Une commande par étape (identifiant =
 * agrégat) : création, ou modification du libellé, de l'ordre et de l'activité — le code est
 * immuable (déclencheur). Une étape système ne se désactive pas ; au moins une étape doit rester
 * active, sans quoi aucun prospect ne pourrait être créé.
 */
import { z } from 'zod';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { rejected } from './shared.js';

const configurePayloadSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Z0-9_]+$/, 'Code en majuscules, chiffres et « _ ».'),
  label: z.string().trim().min(1).max(200),
  sortOrder: z.number().int().min(0).max(32_000),
  isActive: z.boolean(),
});
type ConfigurePayload = z.infer<typeof configurePayloadSchema>;

const configure: CommandHandler<ConfigurePayload> = async (uow, envelope) => {
  const stepId = toBin(envelope.aggregate_id);
  const p = envelope.payload;
  const author = toBin(envelope.author_user_id);
  const existing = await uow
    .selectFrom('crm_pipeline_steps')
    .selectAll()
    .where('id', '=', stepId)
    .forUpdate()
    .executeTakeFirst();

  if (!p.isActive) {
    const otherActive = await uow
      .selectFrom('crm_pipeline_steps')
      .select('id')
      .where('is_active', '=', 1)
      .where('id', '<>', stepId)
      .limit(1)
      .executeTakeFirst();
    if (!otherActive) {
      return rejected('PIPELINE_EMPTY', 'Au moins une étape du pipeline doit rester active.');
    }
  }

  if (existing) {
    if (existing.code !== p.code) {
      return rejected('CODE_IMMUTABLE', "Le code d'une étape est immuable.");
    }
    if (existing.is_system && !p.isActive) {
      return rejected('SYSTEM_REFERENCE', 'Une étape système ne peut pas être désactivée.');
    }
    await uow
      .updateTable('crm_pipeline_steps')
      .set({
        label: p.label,
        sort_order: p.sortOrder,
        is_active: p.isActive ? 1 : 0,
        updated_by: author,
        version: sql`version + 1`,
      })
      .where('id', '=', stepId)
      .execute();
  } else {
    const sameCode = await uow
      .selectFrom('crm_pipeline_steps')
      .select('id')
      .where('code', '=', p.code)
      .executeTakeFirst();
    if (sameCode) return rejected('CODE_EXISTS', 'Une étape porte déjà ce code.');
    await uow
      .insertInto('crm_pipeline_steps')
      .values({
        id: stepId,
        code: p.code,
        label: p.label,
        sort_order: p.sortOrder,
        is_active: p.isActive ? 1 : 0,
        created_by: author,
      })
      .execute();
  }
  return { status: 'APPLIED' };
};

export function registerPipelineCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'crm.pipeline.configure',
    version: 1,
    payloadSchema: configurePayloadSchema,
    permissionCode: 'crm.pipeline.configure',
    handler: configure,
  });
}
