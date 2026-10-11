/**
 * Lignes de flux de changements émises par `organization` (P5-18 ; 01-architecture-offline.md §3.1,
 * AV-195). Les sites, zones, emplacements et équipes restent publiés par le repli générique du
 * pipeline (une ligne `GLOBAL` par agrégat, jeux `site`, `zone`, `location`, `team`) ; ce module
 * publie lui-même ce que ce repli ne voit pas :
 * - la **configuration du PDV** (`POINT_OF_SALE`, jeu `org`, clé = le site) au site du PDV (`SITE`) :
 *   les appareils du site y lisent le mode de garde et l'appareil désigné. Un changement d'appareil
 *   désigné se propage par cette mise à jour (l'ancien appareil apprend qu'il n'est plus désigné)
 *   plutôt que par une sortie de périmètre qui lui retirerait la configuration (AV-195) ;
 * - l'**emplacement de vente** dont `pos.configure` reporte le mode de garde (ADR-033 §2, INV-DIS-01)
 *   : l'agrégat de la commande est le site, le repli ne publie donc pas l'emplacement modifié ;
 * - les **paramètres visibles** des appareils (`SETTING`, jeu `me`, voir `emitSettingChange`).
 * Le type d'entité est une clé de `sync/entity-projections.ts`.
 */
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { recordChanges } from '../../../platform/sync/change-feed.js';
import { fromBin, toBin } from '../../../platform/kysely/uuid-columns.js';

export const ORG_DATASET = 'org';

/** Jeu du repli générique pour l'agrégat `LOCATION` (`aggregate_type.toLowerCase()`). */
const LOCATION_FALLBACK_DATASET = 'location';

export async function emitPointOfSaleChange(uow: UnitOfWork, siteId: string): Promise<void> {
  const pos = await uow
    .selectFrom('organization_points_of_sale')
    .select(['sales_location_id', 'version'])
    .where('site_id', '=', toBin(siteId))
    .executeTakeFirst();
  if (!pos) return;
  const location = await uow
    .selectFrom('organization_locations')
    .select('id')
    .where('id', '=', pos.sales_location_id)
    .executeTakeFirst();
  await recordChanges(uow, [
    {
      dataset: ORG_DATASET,
      entityType: 'POINT_OF_SALE',
      entityId: siteId,
      scopeType: 'SITE',
      scopeId: siteId,
      rowVersion: pos.version,
    },
    ...(location
      ? [
          {
            dataset: LOCATION_FALLBACK_DATASET,
            entityType: 'LOCATION',
            entityId: fromBin(pos.sales_location_id),
            // Version 1, comme le repli des commandes d'emplacement qui publient la même clé.
            scopeType: 'GLOBAL' as const,
            scopeId: null,
          },
        ]
      : []),
  ]);
}

/** Jeu des paramètres visibles des appareils (01-architecture-offline.md §3.1 : `me`). */
export const ME_DATASET = 'me';

/**
 * Paramètre système (P5-18, AV-196) : chaque version visible des appareils (`is_client_visible`)
 * est publiée dans le jeu `me`, ligne `GLOBAL` quelle que soit sa portée — la portée (`SITE`,
 * `ZONE`, `ROLE`) est dans la donnée et l'appareil retient la valeur qui le concerne (BR-ADM-016) :
 * le flux ne sait pas cibler un rôle, et une valeur de zone doit atteindre les appareils des sites
 * de la zone. Les versions antérieures visibles de la même clé et de la même portée sont retirées
 * (`DELETE`) : l'appareil ne garde que la version en vigueur, et une clé redevenue invisible n'y
 * laisse pas de valeur périmée. Une version antidatée sous une version plus récente (visible ou non)
 * de la même clé et de la même portée n'est pas en vigueur : rien n'est publié.
 */
export async function emitSettingChange(uow: UnitOfWork, settingId: string): Promise<void> {
  const row = await uow
    .selectFrom('organization_system_settings')
    .select(['key', 'scope_type', 'scope_id', 'valid_from', 'is_client_visible'])
    .where('id', '=', toBin(settingId))
    .executeTakeFirst();
  if (!row) return;
  let later = uow
    .selectFrom('organization_system_settings')
    .select('id')
    .where('key', '=', row.key)
    .where('scope_type', '=', row.scope_type)
    .where('valid_from', '>', row.valid_from);
  later =
    row.scope_id === null
      ? later.where('scope_id', 'is', null)
      : later.where('scope_id', '=', row.scope_id);
  if (await later.executeTakeFirst()) return;
  let previous = uow
    .selectFrom('organization_system_settings')
    .select('id')
    .where('key', '=', row.key)
    .where('scope_type', '=', row.scope_type)
    .where('is_client_visible', '=', 1)
    .where('valid_from', '<=', row.valid_from)
    .where('id', '<>', toBin(settingId));
  previous =
    row.scope_id === null
      ? previous.where('scope_id', 'is', null)
      : previous.where('scope_id', '=', row.scope_id);
  const superseded = await previous.execute();
  await recordChanges(uow, [
    ...superseded.map((old) => ({
      dataset: ME_DATASET,
      entityType: 'SETTING',
      entityId: fromBin(old.id),
      scopeType: 'GLOBAL' as const,
      scopeId: null,
      changeType: 'DELETE' as const,
    })),
    ...(row.is_client_visible
      ? [
          {
            dataset: ME_DATASET,
            entityType: 'SETTING',
            entityId: settingId,
            scopeType: 'GLOBAL' as const,
            scopeId: null,
          },
        ]
      : []),
  ]);
}
