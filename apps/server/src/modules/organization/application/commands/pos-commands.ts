/**
 * Configuration d'un point de vente (organization.points_of_sale, extension 1:1 d'un site
 * `POINT_DE_VENTE` — docs/03-data/dictionnaire/02-organization.md ; D05 UC-DIS-01, BR-DIS-002,
 * BR-DIS-014 ; ADR-033 §2). `site_id` est la clé primaire de la table : l'agrégat de cette commande
 * est le site lui-même (`aggregate_id = site_id`) — un « configurer », naturellement idempotent
 * par upsert (rejouer la même configuration produit le même état final).
 *
 * P5-05 :
 * - **contrôles** (`POS_CONFIG_INVALID`) : l'emplacement de vente est un emplacement `POS` actif de
 *   ce site, propre à ce PDV ; le magasin source est un `STORE` actif d'un autre site ; l'appareil
 *   désigné est actif, non rattaché à un autre site (BR-DIS-003) et ne l'est pour aucun autre PDV ;
 * - **source unique du mode de garde** : le mode et l'appareil désigné sont écrits sur l'emplacement
 *   de vente dans la même transaction (le stock, les ventes et la synchronisation ne lisent que
 *   `organization_locations`, INV-DIS-01) ; `SHARED` ne désigne aucun appareil ;
 * - **BR-DIS-014** : changer ou retirer l'appareil désigné exige que l'ancien ait tout synchronisé
 *   (dernier rapport : aucune opération en attente) ou ait été bloqué, déclaré perdu ou retiré.
 *   Commande en ligne seulement : le refus n'est donc pas un fait accompli rejeté (BR-SYN-007).
 *
 * P5-23 (AV-195 (1), AV-230) : les gardes des modules de niveau supérieur (`PosConfigurationGuardRegistry`)
 * sont consultées avant d'écrire — `inventory` refuse `POS_ALLOCATIONS_ACTIVE` le passage en garde exclusive
 * d'un emplacement qui porte un quota actif. Ordre des verrous : l'emplacement de vente est pris en exclusif
 * **en premier**, avant toute lecture de la transaction : la vue cohérente des gardes suit alors tout octroi
 * validé avant (un octroi plus tardif attend ce verrou et relit le mode de garde), sans verrouiller les
 * quotas qu'une vente tient avant de toucher l'emplacement (pas de cycle, ADR-038).
 */
import { z } from 'zod';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { sql } from 'kysely';
import { fromBinOrNull, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { emitPointOfSaleChange } from '../sync-changes.js';
import { PosConfigurationGuardRegistry } from '../pos-configuration-guard-registry.js';

const custodyModeSchema = z.enum(['EXCLUSIVE_DEVICE', 'SHARED']);

const configurePayloadSchema = z
  .object({
    salesLocationId: z.string().uuid(),
    replenishmentSourceLocationId: z.string().uuid().optional(),
    custodyMode: custodyModeSchema,
    designatedDeviceId: z.string().uuid().optional(),
    openingHours: z.string().max(500).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.custodyMode === 'EXCLUSIVE_DEVICE' && data.designatedDeviceId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'custodyMode EXCLUSIVE_DEVICE exige designatedDeviceId.',
      });
    }
  });

type ConfigurePayload = z.infer<typeof configurePayloadSchema>;

function notFound(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr };
}

function invalid(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'POS_CONFIG_INVALID', messageFr };
}

/** États d'un appareil qui ne synchronisera plus : le changement de désignation n'attend rien de lui. */
const DEVICE_GONE_STATUSES = ['BLOCKED', 'LOST', 'RETIRED'];

/**
 * BR-DIS-014 : l'appareil quitté a-t-il tout synchronisé ? Le dernier rapport de son dernier envoi
 * (`pending_reported`) ne doit plus compter d'opération en attente. Un appareil qui n'a encore jamais
 * rien envoyé n'a déclaré aucune opération en attente : la désignation peut être corrigée (tablette
 * neuve mal désignée) ; ses éventuels faits hors ligne seront de toute façon appliqués à leur arrivée
 * (BR-SYN-007) et leur consommation de quota réglée par ADR-033.
 */
async function previousDeviceAllowsChange(
  uow: UnitOfWork,
  oldDeviceId: Buffer,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const device = await uow
    .selectFrom('identity_devices')
    .select('status')
    .where('id', '=', oldDeviceId)
    .executeTakeFirst();
  if (!device || DEVICE_GONE_STATUSES.includes(device.status)) return { ok: true };
  const state = await uow
    .selectFrom('sync_device_sync_state')
    .select(['pending_reported', 'last_push_at'])
    .where('device_id', '=', oldDeviceId)
    .where('dataset', '=', '_device')
    .executeTakeFirst();
  if (!state || state.last_push_at === null) return { ok: true };
  if ((state.pending_reported ?? 0) > 0) {
    return {
      ok: false,
      reason: `L’ancien appareil désigné a encore ${state.pending_reported} opération(s) en attente : attendre sa synchronisation ou le bloquer avant de changer d’appareil.`,
    };
  }
  return { ok: true };
}

const configureHandler =
  (guards: PosConfigurationGuardRegistry): CommandHandler<ConfigurePayload> =>
  async (uow, envelope) => {
    const siteId = toBin(envelope.aggregate_id);
    // Premier verrou, avant toute lecture (voir l'en-tête) : l'emplacement de vente en exclusif.
    const salesLocation = await uow
      .selectFrom('organization_locations')
      .select(['site_id', 'location_type', 'status', 'custody_mode', 'designated_device_id'])
      .where('id', '=', toBin(envelope.payload.salesLocationId))
      .forUpdate()
      .executeTakeFirst();
    const site = await uow
      .selectFrom('organization_sites')
      .select(['site_type', 'status'])
      .where('id', '=', siteId)
      .executeTakeFirst();
    if (!site) return notFound('Site introuvable.');
    if (site.site_type !== 'POINT_DE_VENTE') {
      return {
        status: 'REJECTED',
        errorCode: 'NOT_A_POS',
        messageFr: 'Ce site n’est pas un point de vente.',
      };
    }
    if (site.status !== 'ACTIVE') return invalid('Ce point de vente n’est pas actif.');

    const {
      salesLocationId,
      replenishmentSourceLocationId,
      custodyMode,
      designatedDeviceId,
      openingHours,
    } = envelope.payload;
    // `SHARED` ne désigne aucun appareil : la responsabilité du stock passe par les quotas (ADR-033).
    const effectiveDeviceId =
      custodyMode === 'EXCLUSIVE_DEVICE' ? (designatedDeviceId ?? null) : null;

    if (!salesLocation) return notFound('Emplacement de vente introuvable (salesLocationId).');
    if (
      salesLocation.location_type !== 'POS' ||
      fromBinOrNull(salesLocation.site_id) !== envelope.aggregate_id ||
      salesLocation.status !== 'ACTIVE'
    ) {
      return invalid(
        'L’emplacement de vente doit être un emplacement POS actif de ce point de vente.',
      );
    }
    const claimed = await uow
      .selectFrom('organization_points_of_sale')
      .select('site_id')
      .where('sales_location_id', '=', toBin(salesLocationId))
      .where('site_id', '<>', siteId)
      .executeTakeFirst();
    if (claimed)
      return invalid('Cet emplacement de vente appartient déjà à un autre point de vente.');

    if (replenishmentSourceLocationId !== undefined) {
      const source = await uow
        .selectFrom('organization_locations')
        .select(['site_id', 'location_type', 'status'])
        .where('id', '=', toBin(replenishmentSourceLocationId))
        .executeTakeFirst();
      if (!source) return notFound('Magasin source introuvable (replenishmentSourceLocationId).');
      if (
        source.location_type !== 'STORE' ||
        source.status !== 'ACTIVE' ||
        fromBinOrNull(source.site_id) === envelope.aggregate_id
      ) {
        return invalid('Le magasin source doit être un magasin actif d’un autre site.');
      }
    }

    if (effectiveDeviceId !== null) {
      const device = await uow
        .selectFrom('identity_devices')
        .select(['status', 'designated_site_id'])
        .where('id', '=', toBin(effectiveDeviceId))
        .executeTakeFirst();
      if (!device) return notFound('Appareil introuvable (designatedDeviceId).');
      if (device.status !== 'ACTIVE') {
        return invalid('L’appareil désigné doit être approuvé et actif.');
      }
      // BR-DIS-003 : un appareil rattaché à un autre site (identity.device.designate) n'y vend pas.
      if (
        device.designated_site_id !== null &&
        fromBinOrNull(device.designated_site_id) !== envelope.aggregate_id
      ) {
        return invalid('Cet appareil est rattaché à un autre site.');
      }
      const elsewhere = await uow
        .selectFrom('organization_points_of_sale')
        .select('site_id')
        .where('designated_device_id', '=', toBin(effectiveDeviceId))
        .where('site_id', '<>', siteId)
        .executeTakeFirst();
      if (elsewhere) return invalid('Cet appareil est déjà désigné pour un autre point de vente.');
    }

    // BR-DIS-014 : on ne retire pas un appareil qui a encore des opérations à envoyer.
    const current = await uow
      .selectFrom('organization_points_of_sale')
      .select('designated_device_id')
      .where('site_id', '=', siteId)
      .forUpdate()
      .executeTakeFirst();
    const previous = current?.designated_device_id ?? null;
    if (
      previous !== null &&
      (effectiveDeviceId === null || !previous.equals(toBin(effectiveDeviceId)))
    ) {
      const check = await previousDeviceAllowsChange(uow, previous);
      if (!check.ok) {
        return {
          status: 'REJECTED',
          errorCode: 'POS_DEVICE_CHANGE_BLOCKED',
          messageFr: check.reason,
        };
      }
    }

    // Gardes des modules de niveau supérieur (AV-230) : quotas actifs d'un emplacement qui devient exclusif.
    const block = await guards.firstBlock(uow, {
      siteId: envelope.aggregate_id,
      salesLocationId,
      previous: {
        custodyMode:
          salesLocation.custody_mode === 'EXCLUSIVE_DEVICE' ? 'EXCLUSIVE_DEVICE' : 'SHARED',
        designatedDeviceId: fromBinOrNull(salesLocation.designated_device_id),
      },
      next: { custodyMode, designatedDeviceId: effectiveDeviceId },
    });
    if (block) return { status: 'REJECTED', errorCode: block.code, messageFr: block.messageFr };

    const author = toBin(envelope.author_user_id);
    await uow
      .insertInto('organization_points_of_sale')
      .values({
        site_id: siteId,
        sales_location_id: toBin(salesLocationId),
        replenishment_source_location_id: toBinOrNull(replenishmentSourceLocationId ?? null),
        custody_mode: custodyMode,
        designated_device_id: toBinOrNull(effectiveDeviceId),
        opening_hours: openingHours ?? null,
        created_by: author,
      })
      .onDuplicateKeyUpdate({
        sales_location_id: toBin(salesLocationId),
        replenishment_source_location_id: toBinOrNull(replenishmentSourceLocationId ?? null),
        custody_mode: custodyMode,
        designated_device_id: toBinOrNull(effectiveDeviceId),
        opening_hours: openingHours ?? null,
        updated_by: author,
        version: sql`version + 1`,
      })
      .execute();

    // Source unique du mode de garde (ADR-033 §2, INV-DIS-01) : l'emplacement de vente porte le mode et
    // l'appareil désigné que lisent le stock, les ventes et la synchronisation.
    await uow
      .updateTable('organization_locations')
      .set({
        custody_mode: custodyMode,
        designated_device_id: toBinOrNull(effectiveDeviceId),
        updated_by: author,
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(salesLocationId))
      .execute();
    // P5-18 : la configuration et l'emplacement de vente atteignent les appareils (jeu `org`, AV-195).
    await emitPointOfSaleChange(uow, envelope.aggregate_id);
    return { status: 'APPLIED' };
  };

export function registerPosCommands(
  registry: CommandHandlerRegistry,
  guards: PosConfigurationGuardRegistry = new PosConfigurationGuardRegistry(),
): void {
  registry.register({
    commandType: 'organization.pos.configure',
    version: 1,
    payloadSchema: configurePayloadSchema,
    permissionCode: 'org.structure.manage',
    handler: configureHandler(guards),
  });
}
