/**
 * Commandes du cycle de vie d'un appareil (SM-DEVICE, 04-workflows/machines-a-etats/
 * 06-transverses.md ; BR-ADM-005, BR-ADM-006). Une transition absente de la table SM-DEVICE
 * est interdite (README des machines à états) : refusée ici avec `INVALID_TRANSITION` — sauf
 * quand l'état courant est déjà l'état cible, traité comme un rejeu sans effet (BR-SYN-007,
 * « aucun fait accompli n'est rejeté pour une raison d'état »), pas comme une erreur.
 *
 * MP-06 (décisions du porteur du 13/10/2026) : chaque commande vérifie la **portée** de l'auteur sur
 * l'appareil (`deviceInScope` : équipes, sites et zones de l'utilisateur qui l'a connecté, site de
 * rattachement ; AV-247, AV-260), refus `FORBIDDEN_SCOPE` sinon ; nul n'approuve ni ne débloque l'appareil
 * qu'il a connecté, sauf l'Admin (AV-258, `SELF_APPROVAL_FORBIDDEN`) ; le site cible d'un rattachement est
 * dans la portée de l'auteur (AV-259). La lecture `GET /devices` applique la même règle.
 *
 * `designate` (P5-06, BR-DIS-003, AV-007) ne change pas l'état : il fixe le rattachement de l'appareil
 * (appareil partagé entre plusieurs utilisateurs, site de rattachement). C'est une commande en ligne
 * d'administration qui écrit l'état final demandé ; la rejouer est sans effet.
 *
 * `status_changed_at` est fixé à `occurred_at` (pas l'heure de traitement) : c'est exactement
 * ce que compare `identity/application/public/device-check.ts` (RC-02) pour tolérer une
 * commande différée dont l'appareil n'était pas encore bloqué à `occurred_at`.
 *
 * P5-23 (AV-212) : `unblock`, et `retire` depuis `BLOCKED` ou `LOST`, consignent d'abord la période hors
 * service qu'ils ferment (`identity_device_status_periods`) — sans quoi la réécriture de
 * `status_changed_at` effaçait la fenêtre de quarantaine. Chaque transition lit l'appareil `FOR UPDATE` :
 * deux transitions concurrentes ne se croisent pas (une période raccourcie ou perdue). `unblock` d'un
 * appareil refusé avant toute approbation (`PENDING` → `BLOCKED`) l'approuve (`approved_by`, exigé par
 * `ck_identity_devices_approved_by` pour un appareil `ACTIVE` : l'écriture échouait, rejouée sans fin).
 */
import { z } from 'zod';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { findPosConfigByDesignatedDevice } from '../../../organization/application/public/index.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { deviceInScope, isSelfApproval, siteInScope } from '../public/device-scope.js';
import { revokeDeviceSessions } from './revoke-sessions.js';
import { closeOutOfServicePeriod, isOutOfServiceStatus } from './device-status-periods.js';
import { emitDeviceChange } from '../sync-changes.js';

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

/**
 * Approbation `PENDING` → `ACTIVE` (SM-DEVICE), partagée par la commande et par la commande d'installation
 * `db:approve-device` (AV-254, acteur système) : verrou de la ligne, écriture et publication à l'appareil.
 */
export async function approveDevice(
  uow: UnitOfWork,
  input: { readonly deviceId: string; readonly authorUserId: string; readonly occurredAt: Date },
): Promise<CommandHandlerOutcome> {
  const deviceId = toBin(input.deviceId);
  const device = await uow
    .selectFrom('identity_devices')
    .select('status')
    .where('id', '=', deviceId)
    .forUpdate()
    .executeTakeFirst();
  if (!device) return notFound();
  if (device.status === 'ACTIVE') return { status: 'APPLIED' };
  if (device.status !== 'PENDING') return invalidTransition(device.status);

  await uow
    .updateTable('identity_devices')
    .set({
      status: 'ACTIVE',
      status_changed_at: input.occurredAt,
      approved_by: toBin(input.authorUserId),
      updated_by: toBin(input.authorUserId),
      version: sql`version + 1`,
    })
    .where('id', '=', deviceId)
    .execute();
  await emitDeviceChange(uow, input.deviceId);
  return { status: 'APPLIED' };
}

const approve: CommandHandler<EmptyPayload> = (uow, envelope) =>
  approveDevice(uow, {
    deviceId: envelope.aggregate_id,
    authorUserId: envelope.author_user_id,
    occurredAt: new Date(envelope.occurred_at),
  });

const block: CommandHandler<ReasonRequiredPayload> = async (uow, envelope) => {
  const deviceId = toBin(envelope.aggregate_id);
  const device = await uow
    .selectFrom('identity_devices')
    .select('status')
    .where('id', '=', deviceId)
    .forUpdate()
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
  await emitDeviceChange(uow, envelope.aggregate_id);
  await revokeDeviceSessions(uow, envelope.aggregate_id, 'DEVICE_BLOCKED', occurredAt);
  return { status: 'APPLIED' };
};

const unblock: CommandHandler<EmptyPayload> = async (uow, envelope) => {
  const deviceId = toBin(envelope.aggregate_id);
  const device = await uow
    .selectFrom('identity_devices')
    .select(['status', 'status_changed_at', 'status_reason', 'approved_by'])
    .where('id', '=', deviceId)
    .forUpdate()
    .executeTakeFirst();
  if (!device) return notFound();
  if (device.status === 'ACTIVE') return { status: 'APPLIED' };
  if (device.status !== 'BLOCKED') return invalidTransition(device.status);

  const occurredAt = new Date(envelope.occurred_at);
  // AV-212 : la période de blocage close reste une fenêtre de quarantaine (INV-ADM-03).
  await closeOutOfServicePeriod(uow, {
    commandId: envelope.command_id,
    deviceId: envelope.aggregate_id,
    status: 'BLOCKED',
    validFrom: device.status_changed_at,
    closedAt: occurredAt,
    reason: device.status_reason,
    closedBy: envelope.author_user_id,
  });
  await uow
    .updateTable('identity_devices')
    .set({
      status: 'ACTIVE',
      status_changed_at: occurredAt,
      status_reason: null,
      // Un appareil refusé avant toute approbation est approuvé par son déblocage.
      ...(device.approved_by === null ? { approved_by: toBin(envelope.author_user_id) } : {}),
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', deviceId)
    .execute();
  await emitDeviceChange(uow, envelope.aggregate_id);
  return { status: 'APPLIED' };
};

const declareLost: CommandHandler<ReasonOptionalPayload> = async (uow, envelope) => {
  const deviceId = toBin(envelope.aggregate_id);
  const device = await uow
    .selectFrom('identity_devices')
    .select('status')
    .where('id', '=', deviceId)
    .forUpdate()
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
  await emitDeviceChange(uow, envelope.aggregate_id);
  await revokeDeviceSessions(uow, envelope.aggregate_id, 'DEVICE_BLOCKED', occurredAt);
  return { status: 'APPLIED' };
};

const retire: CommandHandler<ReasonOptionalPayload> = async (uow, envelope) => {
  const deviceId = toBin(envelope.aggregate_id);
  const device = await uow
    .selectFrom('identity_devices')
    .select(['status', 'status_changed_at', 'status_reason'])
    .where('id', '=', deviceId)
    .forUpdate()
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
  // AV-212 : la période de blocage ou de perte qui se ferme reste une fenêtre de quarantaine ; le retrait
  // ouvre la sienne (ligne vivante, `RETIRED` depuis `occurred_at`).
  if (isOutOfServiceStatus(device.status)) {
    await closeOutOfServicePeriod(uow, {
      commandId: envelope.command_id,
      deviceId: envelope.aggregate_id,
      status: device.status,
      validFrom: device.status_changed_at,
      closedAt: occurredAt,
      reason: device.status_reason,
      closedBy: envelope.author_user_id,
    });
  }
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
  await emitDeviceChange(uow, envelope.aggregate_id);
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
      // P5-23 (AV-243) : date d'effet du rattachement, lue par la garde d'appareil des faits hors ligne.
      ...(fromBinOrNull(device.designated_site_id) !== designatedSiteId
        ? { designation_changed_at: new Date(envelope.occurred_at) }
        : {}),
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', deviceId)
    .execute();
  await emitDeviceChange(uow, envelope.aggregate_id);
  return { status: 'APPLIED' };
};

function forbiddenScope(): CommandHandlerOutcome {
  return {
    status: 'REJECTED',
    errorCode: 'FORBIDDEN_SCOPE',
    messageFr: 'Cet appareil n’est pas dans votre portée.',
  };
}

/**
 * MP-06 : portée de l'auteur sur l'appareil (AV-247, AV-260), auto-approbation interdite pour `approve` et
 * `unblock` (AV-258), site cible d'un rattachement dans la portée (AV-259). Lit la ligne `FOR UPDATE`, la
 * même que le gestionnaire. Appareil inconnu : le gestionnaire répond `NOT_FOUND`.
 */
function withDeviceScope<P>(
  permissionCode: string,
  options: { readonly selfApproval?: boolean; readonly targetSite?: (payload: P) => string | null },
  handler: CommandHandler<P>,
): CommandHandler<P> {
  return async (uow, envelope) => {
    const device = await uow
      .selectFrom('identity_devices')
      .select(['enrolled_by_user_id', 'designated_site_id'])
      .where('id', '=', toBin(envelope.aggregate_id))
      .forUpdate()
      .executeTakeFirst();
    if (!device) return handler(uow, envelope);
    const at = new Date(envelope.occurred_at);
    const enrolledByUserId = fromBin(device.enrolled_by_user_id);
    const anchor = { enrolledByUserId, designatedSiteId: fromBinOrNull(device.designated_site_id) };
    const author = envelope.author_user_id;
    if (!(await deviceInScope(uow, { userId: author, permissionCode, at, device: anchor }))) {
      return forbiddenScope();
    }
    if (
      options.selfApproval === true &&
      (await isSelfApproval(uow, { authorUserId: author, enrolledByUserId, at }))
    ) {
      return {
        status: 'REJECTED',
        errorCode: 'SELF_APPROVAL_FORBIDDEN',
        messageFr:
          'Vous avez connecté cet appareil : son approbation revient à l’Admin ou à un autre responsable.',
      };
    }
    const target = options.targetSite?.(envelope.payload) ?? null;
    if (
      target !== null &&
      !(await siteInScope(uow, { userId: author, permissionCode, at, siteId: target }))
    ) {
      return {
        status: 'REJECTED',
        errorCode: 'FORBIDDEN_SCOPE',
        messageFr: 'Ce site n’est pas dans votre portée.',
      };
    }
    return handler(uow, envelope);
  };
}

export function registerDeviceCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'identity.device.approve',
    version: 1,
    payloadSchema: emptyPayloadSchema,
    permissionCode: 'identity.device.approve',
    handler: withDeviceScope('identity.device.approve', { selfApproval: true }, approve),
  });
  registry.register({
    commandType: 'identity.device.designate',
    version: 1,
    payloadSchema: designatePayloadSchema,
    permissionCode: 'identity.device.approve',
    handler: withDeviceScope<DesignatePayload>(
      'identity.device.approve',
      { targetSite: (payload) => payload.designatedSiteId },
      designate,
    ),
  });
  registry.register({
    commandType: 'identity.device.block',
    version: 1,
    payloadSchema: reasonRequiredSchema,
    permissionCode: 'identity.device.block',
    handler: withDeviceScope('identity.device.block', {}, block),
  });
  registry.register({
    commandType: 'identity.device.unblock',
    version: 1,
    payloadSchema: emptyPayloadSchema,
    permissionCode: 'identity.device.block',
    // Un déblocage approuve un appareil refusé avant toute approbation : même règle qu'approuver.
    handler: withDeviceScope('identity.device.block', { selfApproval: true }, unblock),
  });
  registry.register({
    commandType: 'identity.device.declare_lost',
    version: 1,
    payloadSchema: reasonOptionalSchema,
    permissionCode: 'identity.device.block',
    handler: withDeviceScope('identity.device.block', {}, declareLost),
  });
  registry.register({
    commandType: 'identity.device.retire',
    version: 1,
    payloadSchema: reasonOptionalSchema,
    permissionCode: 'identity.device.block',
    handler: withDeviceScope('identity.device.block', {}, retire),
  });
}
