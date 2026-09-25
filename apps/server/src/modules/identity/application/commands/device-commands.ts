/**
 * Commandes du cycle de vie d'un appareil (SM-DEVICE, 04-workflows/machines-a-etats/
 * 06-transverses.md ; BR-ADM-005, BR-ADM-006). Une transition absente de la table SM-DEVICE
 * est interdite (README des machines à états) : refusée ici avec `INVALID_TRANSITION` — sauf
 * quand l'état courant est déjà l'état cible, traité comme un rejeu sans effet (BR-SYN-007,
 * « aucun fait accompli n'est rejeté pour une raison d'état »), pas comme une erreur.
 *
 * `status_changed_at` est fixé à `occurred_at` (pas l'heure de traitement) : c'est exactement
 * ce que compare `identity/application/public/device-check.ts` (RC-02) pour tolérer une
 * commande différée dont l'appareil n'était pas encore bloqué à `occurred_at`.
 */
import { z } from 'zod';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { revokeDeviceSessions } from './revoke-sessions.js';

const emptyPayloadSchema = z.object({});
const reasonRequiredSchema = z.object({ reason: z.string().min(1).max(500) });
const reasonOptionalSchema = z.object({ reason: z.string().min(1).max(500).optional() });

type EmptyPayload = z.infer<typeof emptyPayloadSchema>;
type ReasonRequiredPayload = z.infer<typeof reasonRequiredSchema>;
type ReasonOptionalPayload = z.infer<typeof reasonOptionalSchema>;

function invalidTransition(currentStatus: string): CommandHandlerOutcome {
  return {
    status: 'REJECTED',
    errorCode: 'INVALID_TRANSITION',
    messageFr: `Transition invalide depuis l'état ${currentStatus} (SM-DEVICE).`,
  };
}

function notFound(): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr: 'Appareil introuvable.' };
}

const approve: CommandHandler<EmptyPayload> = async (uow, envelope) => {
  const deviceId = toBin(envelope.aggregate_id);
  const device = await uow
    .selectFrom('identity_devices')
    .select('status')
    .where('id', '=', deviceId)
    .executeTakeFirst();
  if (!device) return notFound();
  if (device.status === 'ACTIVE') return { status: 'APPLIED' };
  if (device.status !== 'PENDING') return invalidTransition(device.status);

  await uow
    .updateTable('identity_devices')
    .set({
      status: 'ACTIVE',
      status_changed_at: new Date(envelope.occurred_at),
      approved_by: toBin(envelope.author_user_id),
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', deviceId)
    .execute();
  return { status: 'APPLIED' };
};

const block: CommandHandler<ReasonRequiredPayload> = async (uow, envelope) => {
  const deviceId = toBin(envelope.aggregate_id);
  const device = await uow
    .selectFrom('identity_devices')
    .select('status')
    .where('id', '=', deviceId)
    .executeTakeFirst();
  if (!device) return notFound();
  if (device.status === 'BLOCKED') return { status: 'APPLIED' };
  if (device.status !== 'ACTIVE' && device.status !== 'PENDING') {
    return invalidTransition(device.status);
  }

  const occurredAt = new Date(envelope.occurred_at);
  await uow
    .updateTable('identity_devices')
    .set({
      status: 'BLOCKED',
      status_changed_at: occurredAt,
      status_reason: envelope.payload.reason,
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', deviceId)
    .execute();
  await revokeDeviceSessions(uow, envelope.aggregate_id, 'DEVICE_BLOCKED', occurredAt);
  return { status: 'APPLIED' };
};

const unblock: CommandHandler<EmptyPayload> = async (uow, envelope) => {
  const deviceId = toBin(envelope.aggregate_id);
  const device = await uow
    .selectFrom('identity_devices')
    .select('status')
    .where('id', '=', deviceId)
    .executeTakeFirst();
  if (!device) return notFound();
  if (device.status === 'ACTIVE') return { status: 'APPLIED' };
  if (device.status !== 'BLOCKED') return invalidTransition(device.status);

  await uow
    .updateTable('identity_devices')
    .set({
      status: 'ACTIVE',
      status_changed_at: new Date(envelope.occurred_at),
      status_reason: null,
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', deviceId)
    .execute();
  return { status: 'APPLIED' };
};

const declareLost: CommandHandler<ReasonOptionalPayload> = async (uow, envelope) => {
  const deviceId = toBin(envelope.aggregate_id);
  const device = await uow
    .selectFrom('identity_devices')
    .select('status')
    .where('id', '=', deviceId)
    .executeTakeFirst();
  if (!device) return notFound();
  if (device.status === 'LOST') return { status: 'APPLIED' };
  if (device.status !== 'ACTIVE') return invalidTransition(device.status);

  const occurredAt = new Date(envelope.occurred_at);
  await uow
    .updateTable('identity_devices')
    .set({
      status: 'LOST',
      status_changed_at: occurredAt,
      status_reason: envelope.payload.reason ?? 'Déclaré perdu.',
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', deviceId)
    .execute();
  await revokeDeviceSessions(uow, envelope.aggregate_id, 'DEVICE_BLOCKED', occurredAt);
  return { status: 'APPLIED' };
};

const retire: CommandHandler<ReasonOptionalPayload> = async (uow, envelope) => {
  const deviceId = toBin(envelope.aggregate_id);
  const device = await uow
    .selectFrom('identity_devices')
    .select('status')
    .where('id', '=', deviceId)
    .executeTakeFirst();
  if (!device) return notFound();
  if (device.status === 'RETIRED') return { status: 'APPLIED' };
  if (device.status === 'PENDING') return invalidTransition(device.status);

  // Condition SM-DEVICE « outbox vide confirmée, ou décision explicite » : aucun mécanisme
  // serveur ne peut vérifier l'outbox local d'un appareil (elle ne quitte l'appareil qu'une
  // fois synchronisée) — l'émission même de cette commande par un Admin EST la décision
  // explicite qui satisfait la condition.
  const occurredAt = new Date(envelope.occurred_at);
  const wasActiveOrPending = device.status === 'ACTIVE';
  await uow
    .updateTable('identity_devices')
    .set({
      status: 'RETIRED',
      status_changed_at: occurredAt,
      status_reason: envelope.payload.reason ?? 'Retiré.',
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', deviceId)
    .execute();
  if (wasActiveOrPending) {
    await revokeDeviceSessions(uow, envelope.aggregate_id, 'DEVICE_BLOCKED', occurredAt);
  }
  return { status: 'APPLIED' };
};

export function registerDeviceCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'identity.device.approve',
    version: 1,
    payloadSchema: emptyPayloadSchema,
    permissionCode: 'identity.device.approve',
    handler: approve,
  });
  registry.register({
    commandType: 'identity.device.block',
    version: 1,
    payloadSchema: reasonRequiredSchema,
    permissionCode: 'identity.device.block',
    handler: block,
  });
  registry.register({
    commandType: 'identity.device.unblock',
    version: 1,
    payloadSchema: emptyPayloadSchema,
    permissionCode: 'identity.device.block',
    handler: unblock,
  });
  registry.register({
    commandType: 'identity.device.declare_lost',
    version: 1,
    payloadSchema: reasonOptionalSchema,
    permissionCode: 'identity.device.block',
    handler: declareLost,
  });
  registry.register({
    commandType: 'identity.device.retire',
    version: 1,
    payloadSchema: reasonOptionalSchema,
    permissionCode: 'identity.device.block',
    handler: retire,
  });
}
