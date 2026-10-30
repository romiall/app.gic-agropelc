/**
 * Limites de l'explorateur (P9-14 ; BR-ANA-006, ADR-064 §8, ADR-068 §1, AV-371) : valeurs de `organization.system_settings`
 * (historisées), lues à l'instant de la requête, avec le défaut de D11 quand une valeur manque ou est mal formée.
 * Aucune limite n'est codée ailleurs.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import { DEFAULT_MAX_SCOPE_CANDIDATES } from '../scope/exact-scope.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface ExplorerLimits {
  /** Lignes affichées au plus (BR-ANA-006 : 10 000). */
  readonly maxRows: number;
  /** Durée d'exécution au plus, en millisecondes (BR-ANA-006 : 15 s). */
  readonly maxExecutionMs: number;
  /** Période détaillée au plus, en jours (D11 §8 : trois ans). */
  readonly maxDetailDays: number;
  /** Requêtes simultanées au plus par utilisateur (ADR-068 §1 : 2). */
  readonly maxConcurrentPerUser: number;
  /**
   * Requêtes simultanées au plus, tous utilisateurs confondus (P9-25, AV-461). Décision du porteur du 29/10/2026 :
   * désactivé par défaut. 0 = aucun plafond global ; une valeur entière > 0 l'active.
   */
  readonly maxConcurrentGlobal: number;
  /** Candidats par sorte de l'étendue exacte (AV-373 : 500). */
  readonly scopeMaxCandidates: number;
}

export const EXPLORER_SETTING_KEYS = {
  maxRows: 'analytics.query_max_rows',
  maxExecutionMs: 'analytics.query_max_execution_ms',
  maxDetailDays: 'analytics.query_max_period_days',
  maxConcurrentPerUser: 'analytics.query_max_concurrent_per_user',
  maxConcurrentGlobal: 'analytics.query_max_concurrent_global',
  scopeMaxCandidates: 'analytics.scope_max_candidates',
} as const;

export const DEFAULT_EXPLORER_LIMITS: ExplorerLimits = {
  maxRows: 10_000,
  maxExecutionMs: 15_000,
  maxDetailDays: 1_096,
  maxConcurrentPerUser: 2,
  maxConcurrentGlobal: 0,
  scopeMaxCandidates: DEFAULT_MAX_SCOPE_CANDIDATES,
};

const positiveInteger = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;

/** Entier >= 0 (0 = limite désactivée, AV-461) ; toute autre valeur retombe sur le défaut. */
const nonNegativeInteger = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;

export async function readExplorerLimits(executor: Executor, at: Date): Promise<ExplorerLimits> {
  const read = async (key: string): Promise<unknown> =>
    currentSettingValue(executor, { key, scopeType: 'GLOBAL', scopeId: null, at });
  return {
    maxRows: positiveInteger(
      await read(EXPLORER_SETTING_KEYS.maxRows),
      DEFAULT_EXPLORER_LIMITS.maxRows,
    ),
    maxExecutionMs: positiveInteger(
      await read(EXPLORER_SETTING_KEYS.maxExecutionMs),
      DEFAULT_EXPLORER_LIMITS.maxExecutionMs,
    ),
    maxDetailDays: positiveInteger(
      await read(EXPLORER_SETTING_KEYS.maxDetailDays),
      DEFAULT_EXPLORER_LIMITS.maxDetailDays,
    ),
    maxConcurrentPerUser: positiveInteger(
      await read(EXPLORER_SETTING_KEYS.maxConcurrentPerUser),
      DEFAULT_EXPLORER_LIMITS.maxConcurrentPerUser,
    ),
    maxConcurrentGlobal: nonNegativeInteger(
      await read(EXPLORER_SETTING_KEYS.maxConcurrentGlobal),
      DEFAULT_EXPLORER_LIMITS.maxConcurrentGlobal,
    ),
    scopeMaxCandidates: positiveInteger(
      await read(EXPLORER_SETTING_KEYS.scopeMaxCandidates),
      DEFAULT_EXPLORER_LIMITS.scopeMaxCandidates,
    ),
  };
}
