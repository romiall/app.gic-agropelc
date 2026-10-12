/**
 * Quotas d'appareil (P5-08 ; ADR-033, SM-ALLOCATION, BR-STK-011 à BR-STK-014, INV-STK-19, INV-STK-20,
 * AV-160 à AV-163) : `inventory.allocation.grant`, `.increase`, `.revoke` et `.release`.
 *
 * - **Octroi, augmentation, révocation : en ligne seulement** (`ONLINE_ONLY`). Ce sont des décisions
 *   d'un responsable prises sur un stock vu à l'instant, pas des faits accomplis hors ligne ; leur
 *   permission est `inventory.allocation.manage`, évaluée sur le site de l'emplacement (AV-162).
 * - **Libération : fait accompli de l'appareil détenteur** (BR-SYN-007), hors ligne possible, sous
 *   `inventory.allocation.release` (portée propre). Le serveur ne libère jamais seul (ADR-033 §9).
 * - Un quota est au grain (emplacement, produit) ; le lot éventuel est indicatif (AV-160). Il se
 *   détient par un couple (utilisateur, appareil) sur un emplacement `SHARED` (BR-STK-012).
 * - **Reste = Σ des entrées signées du registre immuable**, jamais négatif (ADR-033 §3) : chaque
 *   changement du reste écrit son entrée dans la même transaction que la mise à jour du quota.
 * - **Verrouillage** : soldes du couple (emplacement, produit) d'abord, puis quotas (ADR-033 §Risques) ;
 *   c'est ce qui sérialise l'octroi avec une sortie concurrente.
 * - Un quota dont le reste est nul reste actif jusqu'à sa libération ou sa révocation (DÉDUIT de
 *   SM-ALLOCATION, qui ne ferme un quota que par ces deux actions) : il se rouvre par une augmentation.
 */
import { sql } from 'kysely';
import { allocationValidUntil, checkGrantCapacity, type IdGenerator } from '@gic/domain';
import {
  allocationGrantPayloadSchema,
  allocationIncreasePayloadSchema,
  allocationReleasePayloadSchema,
  allocationRevokePayloadSchema,
  type AllocationGrantPayload,
  type AllocationIncreasePayload,
  type AllocationReleasePayload,
  type AllocationRevokePayload,
  type CommandEnvelope,
} from '@gic/contracts';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { recordChanges } from '../../../../platform/sync/change-feed.js';
import { recordConflict } from '../../../../platform/sync/conflicts.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { evaluateAccess } from '../../../identity/application/public/index.js';
import {
  activeRemainingMilli,
  loadAllocation,
  milliToText,
  quantityToMilli,
  stockOnHandMilli,
  writeAllocationEntry,
  type AllocationState,
} from '../allocation-ledger.js';
import { allocationChange } from '../sync-changes.js';
import { loadCommandOrigin } from './shared.js';

function rejected(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}

const FORBIDDEN_SCOPE = rejected(
  'FORBIDDEN_SCOPE',
  'Vous n’avez pas ce droit sur le site de cet emplacement.',
);
const ONLINE_ONLY = rejected(
  'ONLINE_ONLY',
  'Cette opération se fait en ligne : elle dépend du stock constaté à l’instant.',
);

interface LocationFacts {
  readonly id: string;
  /** Nul pour un emplacement virtuel (jamais un emplacement de quota). */
  readonly siteId: string | null;
  readonly status: string;
  readonly isVirtual: boolean;
  readonly custodyMode: string | null;
}

async function loadLocationFacts(
  uow: UnitOfWork,
  locationId: string,
): Promise<LocationFacts | undefined> {
  const row = await uow
    .selectFrom('organization_locations')
    .select(['id', 'site_id', 'status', 'is_virtual', 'custody_mode'])
    .where('id', '=', toBin(locationId))
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    id: fromBin(row.id),
    siteId: fromBinOrNull(row.site_id),
    status: row.status,
    isVirtual: row.is_virtual === 1,
    custodyMode: row.custody_mode,
  };
}

/** Droit `permissionCode` sur le site de l'emplacement, à l'heure de l'opération (RC-01, RC-04). */
async function allowed(
  uow: UnitOfWork,
  input: {
    readonly userId: string;
    readonly permissionCode: string;
    readonly occurredAt: Date;
    readonly siteId: string;
    readonly ownerUserId: string;
  },
): Promise<boolean> {
  const access = await evaluateAccess(uow, {
    userId: input.userId,
    permissionCode: input.permissionCode,
    occurredAt: input.occurredAt,
    resource: { siteId: input.siteId, ownerUserId: input.ownerUserId },
  });
  return access.allowed;
}

/** Verrouille les soldes du couple (emplacement, produit) puis ses quotas actifs, dans cet ordre. */
async function lockCouple(
  uow: UnitOfWork,
  locationId: string,
  productId: string,
): Promise<{ readonly stockMilli: number; readonly activeRemainingMilli: number }> {
  const stockMilli = await stockOnHandMilli(uow, locationId, productId, { lock: true });
  const remaining = await activeRemainingMilli(uow, locationId, productId, { lock: true });
  return { stockMilli, activeRemainingMilli: remaining };
}

function capacityRefusal(capacityMilli: number, requestedMilli: number): CommandHandlerOutcome {
  return rejected(
    'ALLOCATION_EXCEEDS_AVAILABLE',
    `Quantité demandée (${milliToText(requestedMilli)}) supérieure au stock non alloué (${milliToText(capacityMilli)}).`,
  );
}

// --- inventory.allocation.grant ----------------------------------------------------------------------------

function grantHandler(deps: {
  readonly idGenerator: IdGenerator;
}): CommandHandler<AllocationGrantPayload> {
  return async (uow, envelope) => {
    if (envelope.captured_offline) return ONLINE_ONLY;
    if (await loadAllocation(uow, envelope.aggregate_id)) return { status: 'APPLIED' }; // rejeu

    const p = envelope.payload;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);

    const location = await loadLocationFacts(uow, p.locationId);
    if (!location) return rejected('NOT_FOUND', 'Emplacement introuvable.');
    const siteId = location.siteId;
    if (location.isVirtual || siteId === null || location.status !== 'ACTIVE') {
      return rejected('ALLOCATION_LOCATION_INVALID', 'L’emplacement doit être physique et actif.');
    }
    if (location.custodyMode !== 'SHARED') {
      return rejected(
        'ALLOCATION_LOCATION_NOT_SHARED',
        'Un quota ne se donne que sur un emplacement partagé : un emplacement exclusif n’en a pas besoin.',
      );
    }
    if (
      !(await allowed(uow, {
        userId: author,
        permissionCode: 'inventory.allocation.manage',
        occurredAt: at,
        siteId,
        ownerUserId: p.holderUserId,
      }))
    ) {
      return FORBIDDEN_SCOPE;
    }

    const product = await uow
      .selectFrom('catalog_products')
      .select('id')
      .where('id', '=', toBin(p.productId))
      .executeTakeFirst();
    if (!product) return rejected('NOT_FOUND', 'Produit introuvable.');
    if (p.lotId !== undefined) {
      const lot = await uow
        .selectFrom('inventory_stock_lots')
        .select('id')
        .where('id', '=', toBin(p.lotId))
        .where('product_id', '=', toBin(p.productId))
        .executeTakeFirst();
      if (!lot) return rejected('REFERENCE_INVALID', 'Lot inconnu pour ce produit.');
    }

    const holder = await uow
      .selectFrom('identity_users')
      .select('status')
      .where('id', '=', toBin(p.holderUserId))
      .executeTakeFirst();
    if (!holder) return rejected('NOT_FOUND', 'Détenteur introuvable.');
    if (holder.status !== 'ACTIVE') {
      return rejected('ALLOCATION_HOLDER_INVALID', 'Le détenteur doit être un utilisateur actif.');
    }
    const device = await uow
      .selectFrom('identity_devices')
      .select(['status', 'designated_site_id'])
      .where('id', '=', toBin(p.holderDeviceId))
      .executeTakeFirst();
    if (!device) return rejected('NOT_FOUND', 'Appareil introuvable.');
    if (device.status !== 'ACTIVE') {
      return rejected('ALLOCATION_HOLDER_INVALID', 'L’appareil doit être approuvé et actif.');
    }
    if (device.designated_site_id !== null && fromBin(device.designated_site_id) !== siteId) {
      return rejected(
        'ALLOCATION_HOLDER_INVALID',
        'Cet appareil est rattaché à un autre site (BR-DIS-003).',
      );
    }

    const grantedAt = at;
    const validUntil =
      p.validUntil !== undefined
        ? new Date(p.validUntil)
        : allocationValidUntil(grantedAt, p.validityHours ?? null);
    if (validUntil.getTime() <= grantedAt.getTime()) {
      return rejected('VALIDITY_INVALID', 'La date de fin de validité doit suivre l’octroi.');
    }

    // Soldes puis quotas, sous verrou : deux octrois (ou un octroi et une sortie) du même couple
    // se sérialisent ici, et le contrôle de doublon ci-dessous ne peut plus être dépassé.
    const couple = await lockCouple(uow, p.locationId, p.productId);
    let duplicate = uow
      .selectFrom('inventory_stock_allocations')
      .select('id')
      .where('holder_user_id', '=', toBin(p.holderUserId))
      .where('holder_device_id', '=', toBin(p.holderDeviceId))
      .where('location_id', '=', toBin(p.locationId))
      .where('product_id', '=', toBin(p.productId))
      .where('status', '=', 'ACTIVE');
    duplicate =
      p.lotId !== undefined
        ? duplicate.where('lot_id', '=', toBin(p.lotId))
        : duplicate.where('lot_id', 'is', null);
    // Lecture verrouillante (ADR-038) : l'instantané de la transaction pouvait ignorer un octroi concurrent
    // validé avant le verrou du couple, qui heurtait alors la contrainte d'unicité (rejouée sans fin).
    if (await duplicate.forUpdate().executeTakeFirst()) {
      return rejected(
        'ALLOCATION_ALREADY_ACTIVE',
        'Ce détenteur a déjà un quota actif sur ce produit à cet emplacement : l’augmenter.',
      );
    }
    const capacity = checkGrantCapacity({
      stockOnHand: couple.stockMilli / 1000,
      activeRemainingTotal: couple.activeRemainingMilli / 1000,
      requested: p.quantityBase,
    });
    if (!capacity.ok) {
      return capacityRefusal(Math.round(capacity.capacity * 1000), quantityToMilli(p.quantityBase));
    }

    const grantedMilli = quantityToMilli(p.quantityBase);
    await uow
      .insertInto('inventory_stock_allocations')
      .values({
        id: toBin(envelope.aggregate_id),
        allocation_type: 'DEVICE_QUOTA',
        location_id: toBin(p.locationId),
        product_id: toBin(p.productId),
        lot_id: p.lotId === undefined ? null : toBin(p.lotId),
        holder_user_id: toBin(p.holderUserId),
        holder_device_id: toBin(p.holderDeviceId),
        quantity_granted: milliToText(grantedMilli),
        quantity_remaining: milliToText(grantedMilli),
        valid_until: validUntil,
        granted_by: toBin(author),
        created_by: toBin(author),
      })
      .execute();
    await writeAllocationEntry(uow, deps, {
      allocationId: envelope.aggregate_id,
      entryType: 'GRANT',
      magnitudeMilli: grantedMilli,
      occurredAt: at,
      createdBy: author,
      commandId: envelope.command_id,
    });
    await recordChanges(uow, [allocationChange(envelope.aggregate_id, p.holderDeviceId, 1)]);
    return { status: 'APPLIED', serverRefs: { validUntil: validUntil.toISOString() } };
  };
}

// --- inventory.allocation.increase -------------------------------------------------------------------------

function increaseHandler(deps: {
  readonly idGenerator: IdGenerator;
}): CommandHandler<AllocationIncreasePayload> {
  return async (uow, envelope) => {
    if (envelope.captured_offline) return ONLINE_ONLY;
    if (envelope.base_version === null) {
      return rejected(
        'BASE_VERSION_REQUIRED',
        'La version du quota affichée est exigée : un double envoi ne doit pas l’augmenter deux fois.',
      );
    }
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);

    // Lecture sans verrou pour connaître le couple, puis ordre constant : soldes, puis quota.
    const peek = await loadAllocation(uow, envelope.aggregate_id);
    if (!peek) return rejected('NOT_FOUND', 'Quota introuvable.');
    const location = await loadLocationFacts(uow, peek.locationId);
    if (!location || location.siteId === null) {
      return rejected('NOT_FOUND', 'Emplacement introuvable.');
    }
    const siteId = location.siteId;
    if (
      !(await allowed(uow, {
        userId: author,
        permissionCode: 'inventory.allocation.manage',
        occurredAt: at,
        siteId,
        ownerUserId: peek.holderUserId,
      }))
    ) {
      return FORBIDDEN_SCOPE;
    }

    const couple = await lockCouple(uow, peek.locationId, peek.productId);
    const allocation = await loadAllocation(uow, envelope.aggregate_id, { lock: true });
    if (!allocation) return rejected('NOT_FOUND', 'Quota introuvable.');
    if (allocation.status !== 'ACTIVE') {
      return rejected('ALLOCATION_NOT_ACTIVE', 'Ce quota est libéré, consommé ou révoqué.');
    }
    if (envelope.base_version !== allocation.version) {
      return quarantineStale(uow, deps, envelope, allocation, siteId);
    }
    // Même condition de service que l'octroi (SM-ALLOCATION, DÉDUIT en P5-21 : un quota signalé
    // n'appelle que la décision d'un responsable) : on n'augmente pas le quota d'un appareil ou d'un
    // utilisateur hors service, ni un quota qui attend sa révocation — sans quoi du stock resterait
    // promis à un appareil perdu.
    if (allocation.revocationPending || !(await holderInService(uow, allocation))) {
      return rejected(
        'ALLOCATION_HOLDER_INVALID',
        'Le détenteur ou son appareil est hors service : ce quota attend sa révocation.',
      );
    }

    const requestedMilli = quantityToMilli(envelope.payload.quantityBase);
    const capacity = checkGrantCapacity({
      stockOnHand: couple.stockMilli / 1000,
      activeRemainingTotal: couple.activeRemainingMilli / 1000,
      requested: envelope.payload.quantityBase,
    });
    if (!capacity.ok) return capacityRefusal(Math.round(capacity.capacity * 1000), requestedMilli);

    await uow
      .updateTable('inventory_stock_allocations')
      .set({
        quantity_granted: milliToText(allocation.grantedMilli + requestedMilli),
        quantity_remaining: milliToText(allocation.remainingMilli + requestedMilli),
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(allocation.id))
      .execute();
    await writeAllocationEntry(uow, deps, {
      allocationId: allocation.id,
      entryType: 'INCREASE',
      magnitudeMilli: requestedMilli,
      occurredAt: at,
      createdBy: author,
      commandId: envelope.command_id,
    });
    await recordChanges(uow, [
      allocationChange(allocation.id, allocation.holderDeviceId, allocation.version + 1),
    ]);
    return { status: 'APPLIED' };
  };
}

/** Détenteur et appareil du quota encore en service (`ACTIVE`) : références universelles d'`identity`. */
async function holderInService(
  uow: UnitOfWork,
  allocation: { readonly holderUserId: string; readonly holderDeviceId: string },
): Promise<boolean> {
  const user = await uow
    .selectFrom('identity_users')
    .select('status')
    .where('id', '=', toBin(allocation.holderUserId))
    .executeTakeFirst();
  const device = await uow
    .selectFrom('identity_devices')
    .select('status')
    .where('id', '=', toBin(allocation.holderDeviceId))
    .executeTakeFirst();
  return user?.status === 'ACTIVE' && device?.status === 'ACTIVE';
}

/** Deux augmentations sur la même version : la seconde n'est pas appliquée (matrice des conflits). */
async function quarantineStale(
  uow: UnitOfWork,
  deps: { readonly idGenerator: IdGenerator },
  envelope: CommandEnvelope<AllocationIncreasePayload>,
  allocation: AllocationState,
  siteId: string,
): Promise<CommandHandlerOutcome> {
  const conflictId = deps.idGenerator.newId();
  await recordConflict(uow, {
    id: conflictId,
    commandId: envelope.command_id,
    conflictType: 'VERSION_CONFLICT',
    entityType: 'STOCK_ALLOCATION',
    entityId: allocation.id,
    siteId,
    ownerRole: 'MAGASINIER',
    applied: false,
    details: {
      commandType: envelope.command_type,
      baseVersion: envelope.base_version,
      serverVersion: allocation.version,
      payload: envelope.payload,
    },
  });
  return { status: 'CONFLICT', conflictId };
}

// --- inventory.allocation.revoke ---------------------------------------------------------------------------

function revokeHandler(deps: {
  readonly idGenerator: IdGenerator;
}): CommandHandler<AllocationRevokePayload> {
  return async (uow, envelope) => {
    if (envelope.captured_offline) return ONLINE_ONLY;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);

    const peek = await loadAllocation(uow, envelope.aggregate_id);
    if (!peek) return rejected('NOT_FOUND', 'Quota introuvable.');
    const location = await loadLocationFacts(uow, peek.locationId);
    if (!location || location.siteId === null) {
      return rejected('NOT_FOUND', 'Emplacement introuvable.');
    }
    const siteId = location.siteId;
    if (
      !(await allowed(uow, {
        userId: author,
        permissionCode: 'inventory.allocation.manage',
        occurredAt: at,
        siteId,
        ownerUserId: peek.holderUserId,
      }))
    ) {
      return FORBIDDEN_SCOPE;
    }

    // ADR-038, ADR-033 §5 : les soldes du couple, puis le quota — l'ordre de toute sortie qui consomme. Sans
    // eux, une vente du couple (soldes, index des quotas, quota) et la révocation (quota, puis mise à jour
    // de son statut, indexé) s'interbloquaient.
    await stockOnHandMilli(uow, peek.locationId, peek.productId, { lock: true });
    const allocation = await loadAllocation(uow, envelope.aggregate_id, { lock: true });
    if (!allocation) return rejected('NOT_FOUND', 'Quota introuvable.');
    if (allocation.status === 'REVOKED') return { status: 'APPLIED' }; // rejeu
    if (allocation.status === 'CLOSED') {
      return rejected('ALLOCATION_NOT_ACTIVE', 'Ce quota est déjà libéré ou consommé.');
    }

    if (allocation.remainingMilli > 0) {
      await writeAllocationEntry(uow, deps, {
        allocationId: allocation.id,
        entryType: 'REVOKE',
        magnitudeMilli: allocation.remainingMilli,
        occurredAt: at,
        createdBy: author,
        commandId: envelope.command_id,
      });
    }
    await uow
      .updateTable('inventory_stock_allocations')
      .set({
        status: 'REVOKED',
        quantity_remaining: milliToText(0),
        revocation_pending: 0,
        revoked_at: at,
        revoked_by: toBin(author),
        revoke_reason: envelope.payload.reason,
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(allocation.id))
      .execute();
    // Quota terminé : il sort du jeu de l'appareil détenteur (AV-193).
    await recordChanges(uow, [
      allocationChange(
        allocation.id,
        allocation.holderDeviceId,
        allocation.version + 1,
        'SCOPE_EXIT',
      ),
    ]);
    return { status: 'APPLIED' };
  };
}

// --- inventory.allocation.release --------------------------------------------------------------------------

function releaseHandler(deps: {
  readonly idGenerator: IdGenerator;
}): CommandHandler<AllocationReleasePayload> {
  return async (uow, envelope) => {
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);

    const peek = await loadAllocation(uow, envelope.aggregate_id);
    if (!peek) return rejected('NOT_FOUND', 'Quota introuvable.');
    const location = await loadLocationFacts(uow, peek.locationId);
    if (!location || location.siteId === null) {
      return rejected('NOT_FOUND', 'Emplacement introuvable.');
    }
    const siteId = location.siteId;
    // Portée propre (AV-162) et couple (utilisateur, appareil) : seul le détenteur, depuis son appareil.
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    if (author !== peek.holderUserId || origin.deviceId !== peek.holderDeviceId) {
      return rejected(
        'ALLOCATION_NOT_HOLDER',
        'Un quota ne se libère que depuis l’appareil et par l’utilisateur qui le détiennent.',
      );
    }
    if (
      !(await allowed(uow, {
        userId: author,
        permissionCode: 'inventory.allocation.release',
        occurredAt: at,
        siteId,
        ownerUserId: peek.holderUserId,
      }))
    ) {
      return FORBIDDEN_SCOPE;
    }

    // ADR-038 : les soldes du couple, puis le quota (même raison que la révocation).
    await stockOnHandMilli(uow, peek.locationId, peek.productId, { lock: true });
    const allocation = await loadAllocation(uow, envelope.aggregate_id, { lock: true });
    if (!allocation) return rejected('NOT_FOUND', 'Quota introuvable.');
    // Déjà libéré, consommé ou révoqué par le serveur : le fait de l'appareil n'a plus rien à fermer.
    if (allocation.status !== 'ACTIVE') return { status: 'APPLIED' };

    const declaredMilli = quantityToMilli(envelope.payload.remainingBase);
    const serverMilli = allocation.remainingMilli;
    if (serverMilli > 0) {
      await writeAllocationEntry(uow, deps, {
        allocationId: allocation.id,
        entryType: 'RELEASE',
        magnitudeMilli: serverMilli,
        occurredAt: at,
        createdBy: author,
        commandId: envelope.command_id,
      });
    }
    const expired =
      allocation.validUntil !== null && at.getTime() >= allocation.validUntil.getTime();
    await uow
      .updateTable('inventory_stock_allocations')
      .set({
        status: 'CLOSED',
        close_cause: expired ? 'EXPIRED_RELEASED' : 'RELEASED',
        quantity_remaining: milliToText(0),
        revocation_pending: 0,
        released_at: at,
        release_declared_remaining: milliToText(declaredMilli),
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(allocation.id))
      .execute();
    // Quota terminé : il sort du jeu de l'appareil détenteur (AV-193).
    await recordChanges(uow, [
      allocationChange(
        allocation.id,
        allocation.holderDeviceId,
        allocation.version + 1,
        'SCOPE_EXIT',
      ),
    ]);

    // Un écart entre le reste déclaré et celui du serveur n'est jamais corrigé en silence (ADR-033 §9).
    if (declaredMilli !== serverMilli) {
      await recordConflict(uow, {
        id: deps.idGenerator.newId(),
        commandId: envelope.command_id,
        conflictType: 'ALLOCATION_RELEASE_MISMATCH',
        entityType: 'STOCK_ALLOCATION',
        entityId: allocation.id,
        siteId,
        ownerRole: 'MAGASINIER',
        applied: true,
        details: {
          declaredRemaining: milliToText(declaredMilli),
          serverRemaining: milliToText(serverMilli),
          holderUserId: allocation.holderUserId,
          holderDeviceId: allocation.holderDeviceId,
          productId: allocation.productId,
          locationId: allocation.locationId,
        },
      });
      return { status: 'APPLIED_WITH_WARNINGS', warnings: ['ALLOCATION_RELEASE_MISMATCH'] };
    }
    return { status: 'APPLIED' };
  };
}

export function registerAllocationCommands(
  registry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
): void {
  const deps = { idGenerator };
  registry.register({
    commandType: 'inventory.allocation.grant',
    version: 1,
    payloadSchema: allocationGrantPayloadSchema,
    permissionCode: 'inventory.allocation.manage',
    handler: grantHandler(deps),
  });
  registry.register({
    commandType: 'inventory.allocation.increase',
    version: 1,
    payloadSchema: allocationIncreasePayloadSchema,
    permissionCode: 'inventory.allocation.manage',
    handler: increaseHandler(deps),
  });
  registry.register({
    commandType: 'inventory.allocation.revoke',
    version: 1,
    payloadSchema: allocationRevokePayloadSchema,
    permissionCode: 'inventory.allocation.manage',
    handler: revokeHandler(deps),
  });
  registry.register({
    commandType: 'inventory.allocation.release',
    version: 1,
    payloadSchema: allocationReleasePayloadSchema,
    permissionCode: 'inventory.allocation.release',
    handler: releaseHandler(deps),
  });
}
