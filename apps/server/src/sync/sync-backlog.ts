/**
 * Opérations en attente et conflits ouverts (KPI-OPS-02 ; D11 §7.1 « Comptage `sync.*` », PM §29 ; AV-462 (b),
 * AV-479) : fonction de référence unique du tableau de distribution, de la tour de contrôle et de l'accueil
 * (BR-ANA-009). Couche `sync` (propriétaire de `sync_device_sync_state` et de `sync_sync_conflicts`) ;
 * `identity_devices` est une référence universelle (comme dans `device-freshness.ts`).
 *
 * - **Opérations en attente** = Σ du dernier reste déclaré par l'appareil à son dernier envoi
 *   (`pending_reported` de la ligne `_device`, P5-07) des appareils **en service** (`ACTIVE`) lus. C'est l'état
 *   **connu du serveur**, jamais le réel d'un appareil hors ligne (D11 §14 : aucune extrapolation) ; un appareil
 *   qui n'a rien déclaré (aucune ligne d'état, ou `NULL`) compte pour 0 et n'est pas « avec reste ». Le reste
 *   de la ligne `_device` est déjà le total de l'appareil : les lignes par auteur d'une tablette partagée
 *   (`_a:…`) ne s'y ajoutent pas.
 * - **Conflits ouverts** = `openConflictSummary` (statut `OPEN`), inchangée : total et ventilation par type.
 * - Un appareil bloqué, perdu ou retiré n'est pas compté (même règle que le retard de KPI-OPS-01 : son signal
 *   est ailleurs, AV-208). Aucun droit n'est contrôlé ici : le droit de lire les conflits
 *   (`sync.conflict.resolve`) et l'étendue sont ceux de l'appelant.
 *
 * Fonction distincte de `deviceFreshness` (KPI-OPS-01, « dernier contact ») : étendues et droits différents.
 */
import { type Kysely, type Transaction, sql } from 'kysely';
import type { DB } from '../platform/kysely/database.js';
import { toBin } from '../platform/kysely/uuid-columns.js';
import { num } from '../platform/indicator-window.js';
import { openConflictSummary, type OpenConflictSummary } from '../platform/sync/conflicts.js';
import { DEVICE_DATASET } from './sync-state-datasets.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Taille d'un paquet d'identifiants dans la clause `IN` (même plafond que les autres lectures par liste). */
const DEVICE_CHUNK = 500;

export interface SyncBacklogInput {
  /** Appareils lus : `'ALL'` = tous les appareils en service ; une liste vide ne lit rien (zéros, jamais « tout »). */
  readonly devices: 'ALL' | { readonly deviceIds: readonly string[] };
  /** `false` : conflits non lus (lecteur sans le droit) ; sinon les filtres de `openConflictSummary`. */
  readonly conflicts:
    | false
    | {
        readonly ownerRoles?: readonly string[];
        readonly siteIds?: readonly string[];
      };
}

export interface SyncBacklog {
  /** Appareils en service lus (avec ou sans ligne d'état). */
  readonly devicesInService: number;
  /** Dont ceux dont le dernier reste déclaré est > 0. */
  readonly devicesWithBacklog: number;
  /** Σ des restes déclarés des appareils en service lus (KPI-OPS-02). */
  readonly pendingOperations: number;
  /** `null` si `conflicts: false`. */
  readonly openConflicts: OpenConflictSummary | null;
}

interface DeviceTotals {
  readonly devicesInService: number;
  readonly devicesWithBacklog: number;
  readonly pendingOperations: number;
}

const NO_DEVICES: DeviceTotals = {
  devicesInService: 0,
  devicesWithBacklog: 0,
  pendingOperations: 0,
};

/** Totaux des appareils en service dont l'identifiant est dans `ids` (tous les appareils si `ids` est `null`). */
async function deviceTotals(
  executor: Executor,
  ids: readonly Buffer[] | null,
): Promise<DeviceTotals> {
  const row = await executor
    .selectFrom('identity_devices as d')
    .leftJoin('sync_device_sync_state as s', (join) =>
      join.onRef('s.device_id', '=', 'd.id').on('s.dataset', '=', DEVICE_DATASET),
    )
    .select([
      sql<string>`COUNT(*)`.as('in_service'),
      sql<string | null>`SUM(s.pending_reported > 0)`.as('with_backlog'),
      sql<string | null>`SUM(s.pending_reported)`.as('pending'),
    ])
    .where('d.status', '=', 'ACTIVE')
    .$if(ids !== null, (qb) => qb.where('d.id', 'in', [...ids!]))
    .executeTakeFirst();
  return {
    devicesInService: num(row?.in_service),
    devicesWithBacklog: num(row?.with_backlog),
    pendingOperations: num(row?.pending),
  };
}

/** Opérations en attente et conflits ouverts (KPI-OPS-02) pour les appareils et filtres donnés. */
export async function syncBacklog(
  executor: Executor,
  input: SyncBacklogInput,
): Promise<SyncBacklog> {
  let totals: DeviceTotals;
  if (input.devices === 'ALL') {
    totals = await deviceTotals(executor, null);
  } else {
    // Liste vide : rien à lire (jamais `IN ()` ni « tous les appareils »). Doublons écartés avant le découpage
    // en paquets, pour qu'un appareil ne soit jamais compté deux fois.
    const unique = [...new Set(input.devices.deviceIds)];
    totals = NO_DEVICES;
    for (let from = 0; from < unique.length; from += DEVICE_CHUNK) {
      const chunk = await deviceTotals(
        executor,
        unique.slice(from, from + DEVICE_CHUNK).map((id) => toBin(id)),
      );
      totals = {
        devicesInService: totals.devicesInService + chunk.devicesInService,
        devicesWithBacklog: totals.devicesWithBacklog + chunk.devicesWithBacklog,
        pendingOperations: totals.pendingOperations + chunk.pendingOperations,
      };
    }
  }
  return {
    ...totals,
    openConflicts:
      input.conflicts === false ? null : await openConflictSummary(executor, input.conflicts),
  };
}
