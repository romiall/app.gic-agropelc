/**
 * Commandes du cycle de vie d'un appareil (SM-DEVICE, 04-workflows/machines-a-etats/
 * 06-transverses.md ; BR-ADM-005, BR-ADM-006). Une transition absente de la table SM-DEVICE
 * est interdite (README des machines à états) : refusée ici avec `INVALID_TRANSITION` — sauf
 * quand l'état courant est déjà l'état cible, traité comme un rejeu sans effet (BR-SYN-007,
 * « aucun fait accompli n'est rejeté pour une raison d'état »), pas comme une erreur.
 *
 * `designate` (P5-06, BR-DIS-003, AV-007) ne change pas l'état : il fixe le rattachement de l'appareil
 * (appareil partagé entre plusieurs utilisateurs, site de rattachement). C'est une commande en ligne
 * d'administration qui écrit l'état final demandé ; la rejouer est sans effet.
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
import { fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { findPosConfigByDesignatedDevice } from '../../../organization/application/public/index.js';
import { revokeDeviceSessions } from './revoke-sessions.js';

const emptyPayloadSchema = z.object({});
const reasonRequiredSchema = z.object({ reason: z.string().min(1).max(500) });
const reasonOptionalSchema = z.object({ reason: z.string().min(1).max(500).optional() });
const designatePayloadSchema = z.object({
  isShared: z.boolean(),
  designatedSiteId: z.string().uuid().nullable(),
});

type EmptyPayload = z.infer<typeof emptyPayloadSchema>;
type ReasonRequiredPayload = z.infer<typeof reasonRequiredSchema>;
type ReasonOptionalPayload = z.infer<typeof reasonOptionalSchema>;
type DesignatePayload = z.infer<typeof designatePayloadSchema>;

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

/** États dans lesquels un appareil n'a plus de rattachement à fixer : perdu ou retiré. */
const NOT_DESIGNABLE_STATUSES = ['LOST', 'RETIRED'];

function designationInvalid(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'DEVICE_DESIGNATION_INVALID', messageFr };
}

const designate: CommandHandler<DesignatePayload> = async (uow, envelope) => {
  const deviceId = toBin(envelope.aggregate_id);
  const device = await uow
    .selectFrom('identity_devices')
    .select(['status', 'is_shared', 'designated_site_id'])
    .where('id', '=', deviceId)
    .forUpdate()
    .executeTakeFirst();
  if (!device) return notFound();
  if (NOT_DESIGNABLE_STATUSES.includes(device.status)) {
    return designationInvalid(`Un appareil à l’état ${device.status} ne peut plus être rattaché.`);
  }

  const { isShared, designatedSiteId } = envelope.payload;
  if (designatedSiteId !== null) {
    const site = await uow
      .selectFrom('organization_sites')
      .select('status')
      .where('id', '=', toBin(designatedSiteId))
      .executeTakeFirst();
    if (!site) {
      return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr: 'Site introuvable.' };
    }
    if (site.status !== 'ACTIVE') return designationInvalid('Ce site est fermé.');
  }

  // BR-DIS-003 : l'appareil désigné d'un PDV ne se rattache pas à un autre site (ni n'en est détaché).
  const pos = await findPosConfigByDesignatedDevice(uow, envelope.aggregate_id);
  if (pos !== null && designatedSiteId !== pos.siteId) {
    return designationInvalid(
      'Cet appareil est l’appareil désigné d’un point de vente : changer d’abord la configuration de ce PDV.',
    );
  }

  const unchanged =
    (device.is_shared === 1) === isShared &&
    fromBinOrNull(device.designated_site_id) === designatedSiteId;
  if (unchanged) return { status: 'APPLIED' };

  await uow
    .updateTable('identity_devices')
    .set({
      is_shared: isShared ? 1 : 0,
      designated_site_id: designatedSiteId === null ? null : toBin(designatedSiteId),
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', deviceId)
    .execute();
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
    commandType: 'identity.device.designate',
    version: 1,
    payloadSchema: designatePayloadSchema,
    permissionCode: 'identity.device.approve',
    handler: designate,
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
