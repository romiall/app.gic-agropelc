/**
 * Visites et interactions (D02-CRM ; SM-VISIT ; dictionnaire 04-crm-fieldwork) :
 * `crm.visit.record`, `crm.visit.cancel`, `crm.interaction.record`, `crm.interaction.cancel`.
 *
 * - Faits accomplis hors ligne, en ajout seul : une visite ou une interaction synchronisée n'est
 *   plus modifiable ; la correction passe par l'annulation motivée et une nouvelle saisie
 *   (BR-CRM-016).
 * - Visite : rattachée par le serveur à la session de travail de l'utilisateur couvrant son
 *   `occurred_at` (BR-CRM-013, `findWorkSessionAt` de `fieldwork`) ; indicateurs calculés par
 *   `evaluateVisit` (packages/domain) : `OUT_OF_SESSION`, `FAR_FROM_CUSTOMER` au-delà du paramètre
 *   `crm.visit.max_distance_m` (BR-CRM-015), `SESSION_REJECTED` si la dérogation de la session a
 *   été rejetée — ou plus tard, par réaction au rejet (`session-rejection-listener.ts`) ;
 *   `CLOCK_SUSPECT` si l'horloge de l'appareil est douteuse. Ils signalent, ne bloquent jamais.
 * - Compte fusionné : refusé en ligne (`CUSTOMER_MERGED`) ; hors ligne, la visite est conservée
 *   sur le compte d'origine (les lectures suivent la chaîne de fusion, BR-CRM-007).
 */
import { z } from 'zod';
import { sql } from 'kysely';
import { evaluateVisit, type GeoPoint } from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { findReasonCode } from '../../../catalog/application/public/index.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import { findWorkSessionAt } from '../../../fieldwork/application/public/index.js';
import {
  CUSTOMER_MERGED,
  CUSTOMER_NOT_FOUND,
  DATE_ONLY,
  FORBIDDEN_SCOPE,
  canRecordFactOn,
  dateColumn,
  isAllowed,
  rejected,
  type Uow,
} from './shared.js';

const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

const visitPayloadSchema = z.object({
  customerId: z.string().uuid(),
  position: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      accuracyM: z.number().nonnegative().nullable().optional(),
    })
    .nullable(),
  outcomeReasonCodeId: z.string().uuid(),
  notes: optionalText(4000),
  nextActionAt: z.string().regex(DATE_ONLY).nullable().optional(),
  nextActionNote: optionalText(2000),
});
type VisitPayload = z.infer<typeof visitPayloadSchema>;

const interactionPayloadSchema = z.object({
  customerId: z.string().uuid(),
  channel: z.enum(['APPEL', 'SMS', 'EMAIL', 'AUTRE']),
  direction: z.enum(['ENTRANT', 'SORTANT']).optional(),
  summary: optionalText(4000),
  nextActionAt: z.string().regex(DATE_ONLY).nullable().optional(),
  nextActionNote: optionalText(2000),
});
type InteractionPayload = z.infer<typeof interactionPayloadSchema>;

const cancelPayloadSchema = z.object({
  reasonCodeId: z.string().uuid().optional(),
  comment: z.string().trim().min(1).max(2000),
});
type CancelPayload = z.infer<typeof cancelPayloadSchema>;

async function loadCustomer(uow: Uow, customerId: string) {
  return uow
    .selectFrom('crm_customers')
    .selectAll()
    .where('id', '=', toBin(customerId))
    .executeTakeFirst();
}

async function maxVisitDistanceM(uow: Uow, at: Date): Promise<number> {
  const value = await currentSettingValue(uow, {
    key: 'crm.visit.max_distance_m',
    scopeType: 'GLOBAL',
    scopeId: null,
    at,
  });
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 500;
}

const recordVisit: CommandHandler<VisitPayload> = async (uow, envelope) => {
  const visitId = toBin(envelope.aggregate_id);
  const replay = await uow
    .selectFrom('crm_visits')
    .select('id')
    .where('id', '=', visitId)
    .executeTakeFirst();
  if (replay) return { status: 'APPLIED' };

  const p = envelope.payload;
  const author = envelope.author_user_id;
  const at = new Date(envelope.occurred_at);
  const customer = await loadCustomer(uow, p.customerId);
  if (!customer) return CUSTOMER_NOT_FOUND;
  if (customer.stage === 'MERGED' && !envelope.captured_offline) return CUSTOMER_MERGED;
  const allowed = await canRecordFactOn(uow, {
    userId: author,
    permissionCode: 'crm.visit.record',
    at,
    customer,
    capturedOffline: envelope.captured_offline,
  });
  if (!allowed) return FORBIDDEN_SCOPE;
  const outcome = await findReasonCode(uow, p.outcomeReasonCodeId);
  if (
    !outcome ||
    outcome.category !== 'VISIT_OUTCOME' ||
    (!outcome.isActive && !envelope.captured_offline)
  ) {
    return rejected(
      'REFERENCE_INVALID',
      'Résultat de visite inconnu ou inactif (catégorie VISIT_OUTCOME, BR-CRM-012).',
    );
  }

  const session = await findWorkSessionAt(uow, author, at);
  const customerPosition: GeoPoint | null =
    customer.lat === null || customer.lng === null
      ? null
      : { lat: Number(customer.lat), lng: Number(customer.lng) };
  const evaluation = evaluateVisit({
    visitPosition: p.position ? { lat: p.position.lat, lng: p.position.lng } : null,
    customerPosition,
    maxDistanceM: await maxVisitDistanceM(uow, at),
    session:
      session === undefined
        ? 'NONE'
        : session.overrideStatus === 'REJECTED'
          ? 'OPEN_REJECTED'
          : 'OPEN',
  });
  const origin = await loadCommandOrigin(uow, envelope.command_id);
  const flags: string[] = [...evaluation.flags];
  if (origin.clockSuspect) flags.push('CLOCK_SUSPECT');

  await uow
    .insertInto('crm_visits')
    .values({
      id: visitId,
      customer_id: customer.id,
      user_id: toBin(author),
      work_session_id: session ? toBin(session.id) : null,
      customer_stage_at_visit: customer.stage,
      lat: p.position ? String(p.position.lat) : null,
      lng: p.position ? String(p.position.lng) : null,
      accuracy_m:
        p.position?.accuracyM === undefined || p.position.accuracyM === null
          ? null
          : String(p.position.accuracyM),
      distance_to_customer_m:
        evaluation.distanceToCustomerM === null ? null : String(evaluation.distanceToCustomerM),
      outcome_reason_code_id: toBin(outcome.id),
      notes: p.notes ?? null,
      next_action_at: p.nextActionAt ? dateColumn(p.nextActionAt) : null,
      next_action_note: p.nextActionNote ?? null,
      flags: jsonValue(flags),
      occurred_at: at,
      client_created_at: new Date(envelope.client_created_at),
      received_at_server: origin.receivedAt,
      command_id: toBin(envelope.command_id),
      created_device_id: toBinOrNull(origin.deviceId),
      captured_offline: envelope.captured_offline ? 1 : 0,
      clock_suspect: origin.clockSuspect ? 1 : 0,
      backdated_reason: envelope.backdated_reason,
      created_by: toBin(author),
    })
    .execute();
  return { status: 'APPLIED' };
};

const recordInteraction: CommandHandler<InteractionPayload> = async (uow, envelope) => {
  const interactionId = toBin(envelope.aggregate_id);
  const replay = await uow
    .selectFrom('crm_interactions')
    .select('id')
    .where('id', '=', interactionId)
    .executeTakeFirst();
  if (replay) return { status: 'APPLIED' };

  const p = envelope.payload;
  const author = envelope.author_user_id;
  const at = new Date(envelope.occurred_at);
  const customer = await loadCustomer(uow, p.customerId);
  if (!customer) return CUSTOMER_NOT_FOUND;
  if (customer.stage === 'MERGED' && !envelope.captured_offline) return CUSTOMER_MERGED;
  const allowed = await canRecordFactOn(uow, {
    userId: author,
    permissionCode: 'crm.interaction.record',
    at,
    customer,
    capturedOffline: envelope.captured_offline,
  });
  if (!allowed) return FORBIDDEN_SCOPE;
  const origin = await loadCommandOrigin(uow, envelope.command_id);
  await uow
    .insertInto('crm_interactions')
    .values({
      id: interactionId,
      customer_id: customer.id,
      user_id: toBin(author),
      channel: p.channel,
      direction: p.direction ?? 'SORTANT',
      summary: p.summary ?? null,
      next_action_at: p.nextActionAt ? dateColumn(p.nextActionAt) : null,
      next_action_note: p.nextActionNote ?? null,
      occurred_at: at,
      client_created_at: new Date(envelope.client_created_at),
      received_at_server: origin.receivedAt,
      command_id: toBin(envelope.command_id),
      created_device_id: toBinOrNull(origin.deviceId),
      captured_offline: envelope.captured_offline ? 1 : 0,
      clock_suspect: origin.clockSuspect ? 1 : 0,
      backdated_reason: envelope.backdated_reason,
      created_by: toBin(author),
    })
    .execute();
  return { status: 'APPLIED' };
};

/**
 * Annulation motivée (BR-CRM-016, SM-VISIT) : par l'auteur, ou par un responsable qui peut
 * réaffecter les comptes de l'auteur (`crm.customer.reassign`, SM-VISIT). Le code motif éventuel
 * est de catégorie `CANCELLATION` ; le commentaire est obligatoire.
 */
function buildCancel(
  table: 'crm_visits' | 'crm_interactions',
  label: string,
  recordPermission: string,
) {
  const handler: CommandHandler<CancelPayload> = async (uow, envelope) => {
    const row = await uow
      .selectFrom(table)
      .select(['id', 'status', 'user_id', 'customer_id'])
      .where('id', '=', toBin(envelope.aggregate_id))
      .forUpdate()
      .executeTakeFirst();
    if (!row) return rejected('NOT_FOUND', `${label} introuvable.`);
    if (row.status === 'CANCELLED') {
      return rejected('ALREADY_CANCELLED', `${label} déjà annulée.`);
    }
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const authorId = toBin(author);
    // Portée : le visiteur (titulaire du fait) dans la zone du compte (OWN ∩ affectation ZONE).
    const customer = await uow
      .selectFrom('crm_customers')
      .select('zone_id')
      .where('id', '=', row.customer_id)
      .executeTakeFirstOrThrow();
    const visitor = { ownerUserId: fromBin(row.user_id), zoneId: fromBin(customer.zone_id) };
    const permitted = row.user_id.equals(authorId)
      ? await isAllowed(uow, author, recordPermission, at, visitor)
      : await isAllowed(uow, author, 'crm.customer.reassign', at, visitor);
    if (!permitted) return FORBIDDEN_SCOPE;
    const reasonCodeId = envelope.payload.reasonCodeId;
    if (reasonCodeId !== undefined) {
      const reason = await findReasonCode(uow, reasonCodeId);
      if (!reason || reason.category !== 'CANCELLATION') {
        return rejected(
          'REFERENCE_INVALID',
          "Motif d'annulation inconnu (catégorie CANCELLATION).",
        );
      }
    }
    await uow
      .updateTable(table)
      .set({
        status: 'CANCELLED',
        cancelled_at: at,
        cancelled_by: authorId,
        cancel_reason_code_id: toBinOrNull(reasonCodeId ?? null),
        cancel_comment: envelope.payload.comment,
        updated_by: authorId,
        version: sql`version + 1`,
      })
      .where('id', '=', row.id)
      .execute();
    return { status: 'APPLIED' };
  };
  return handler;
}

export function registerActivityCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'crm.visit.record',
    version: 1,
    payloadSchema: visitPayloadSchema,
    permissionCode: 'crm.visit.record',
    handler: recordVisit,
  });
  registry.register({
    commandType: 'crm.visit.cancel',
    version: 1,
    payloadSchema: cancelPayloadSchema,
    permissionCode: 'crm.visit.record',
    handler: buildCancel('crm_visits', 'Visite', 'crm.visit.record'),
  });
  registry.register({
    commandType: 'crm.interaction.record',
    version: 1,
    payloadSchema: interactionPayloadSchema,
    permissionCode: 'crm.interaction.record',
    handler: recordInteraction,
  });
  registry.register({
    commandType: 'crm.interaction.cancel',
    version: 1,
    payloadSchema: cancelPayloadSchema,
    permissionCode: 'crm.interaction.record',
    handler: buildCancel('crm_interactions', 'Interaction', 'crm.interaction.record'),
  });
}
