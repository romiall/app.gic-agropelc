/**
 * Lectures des sessions de caisse et du registre pour les commandes de session (P5-12 ; ADR-032 §2 à
 * §4, §10). Toute donnée qui fonde une décision est lue par une **lecture verrouillante** : sous
 * l'isolation répétable d'InnoDB, l'instantané d'une transaction naît à sa première lecture simple
 * (origine de la commande, droits), avant le verrou du compte ; une lecture simple pourrait ignorer un
 * mouvement ou une session validés entre-temps.
 *
 * Ordre des verrous des commandes de session (ADR-032 §10, complété) : **site** (partagé) → **compte**
 * (exclusif) → **sessions** du compte (exclusif) → **registre** du compte (partagé). Le site d'abord :
 * l'insertion d'une session ou d'un conflit pose un verrou partagé sur la ligne du site (clé
 * étrangère) ; sans lui, `organization.site.close` (site exclusif, puis garde `finance`) et une
 * ouverture (compte exclusif, puis site partagé) formeraient un cycle.
 *
 * Isolation (revue adverse P5-12) : les trois commandes de session s'exécutent en **lecture
 * confirmée** (`read committed`, option `isolationLevel` du registre). Sous la lecture répétable
 * d'InnoDB, les lectures verrouillantes par plage ci-dessous posent des verrous de plage sur l'index
 * `(cash_account_id, opened_at)` et sur celui du registre : pour deux caisses voisines dans l'index
 * (deux caisses neuves, dont les identifiants UUIDv7 se suivent), chacune verrouille le même
 * intervalle puis attend celui de l'autre pour son `INSERT` — interblocage 1213, reproduit 7 fois sur
 * 8 par deux ouvertures parallèles. En lecture confirmée, aucune lecture n'y pose de verrou de plage ;
 * la sérialisation des écritures d'un compte reste portée par le verrou exclusif de sa ligne, et
 * toute lecture voit la dernière version validée (l'instantané n'est plus un sujet).
 */
import { sql } from 'kysely';
import {
  CASH_EXPECTED_EXCLUDED_TYPES,
  expectedCashXaf,
  type CashMovementAmount,
  type CashSessionStatus,
  type ExistingCashSession,
} from '@gic/domain';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { fromBin, fromBinOrNull, toBin } from '../../../platform/kysely/uuid-columns.js';
import { currentSettingValue } from '../../organization/application/public/index.js';

export interface CashAccountFacts {
  readonly id: string;
  readonly accountType: string;
  readonly siteId: string | null;
  readonly status: string;
}

/** Lecture simple du compte (type et site sont immuables) : sert à verrouiller le site d'abord. */
export async function peekCashAccount(
  uow: UnitOfWork,
  cashAccountId: string,
): Promise<CashAccountFacts | undefined> {
  return readAccount(uow, cashAccountId, false);
}

/** Compte verrouillé en écriture (même verrou que `recordCashMovement`). */
export async function lockCashAccount(
  uow: UnitOfWork,
  cashAccountId: string,
): Promise<CashAccountFacts | undefined> {
  return readAccount(uow, cashAccountId, true);
}

async function readAccount(
  uow: UnitOfWork,
  cashAccountId: string,
  lock: boolean,
): Promise<CashAccountFacts | undefined> {
  let query = uow
    .selectFrom('finance_cash_accounts')
    .select(['id', 'account_type', 'site_id', 'status'])
    .where('id', '=', toBin(cashAccountId));
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  return row
    ? {
        id: fromBin(row.id),
        accountType: row.account_type,
        siteId: fromBinOrNull(row.site_id),
        status: row.status,
      }
    : undefined;
}

/** Verrou partagé sur la ligne du site, pris avant le compte (voir l'en-tête) ; renvoie son statut. */
export async function lockSiteShared(uow: UnitOfWork, siteId: string): Promise<string | undefined> {
  const site = await uow
    .selectFrom('organization_sites')
    .select('status')
    .where('id', '=', toBin(siteId))
    .forShare()
    .executeTakeFirst();
  return site?.status;
}

export interface CashSessionRow extends ExistingCashSession {
  readonly cashAccountId: string;
  readonly siteId: string;
  readonly openedBy: string;
  readonly openingCountedXaf: number;
  readonly openingExpectedXaf: number;
  readonly openingVarianceXaf: number;
  readonly closedBy: string | null;
  readonly closingCountedXaf: number | null;
  readonly closingExpectedXaf: number | null;
  readonly varianceXaf: number | null;
  readonly forceClosed: boolean;
  /** Demande `CASH_VARIANCE` de la session close (P5-13), lue sous le même verrou que son statut. */
  readonly approvalRequestId: string | null;
  readonly version: number;
}

const SESSION_COLUMNS = [
  'id',
  'cash_account_id',
  'site_id',
  'opened_by',
  'opened_at',
  'opening_counted_xaf',
  'opening_expected_xaf',
  'opening_variance_xaf',
  'closed_by',
  'closed_at',
  'closing_counted_xaf',
  'closing_expected_xaf',
  'variance_xaf',
  'status',
  'force_closed',
  'approval_request_id',
  'version',
] as const;

type SessionRecord = {
  id: Buffer;
  cash_account_id: Buffer;
  site_id: Buffer;
  opened_by: Buffer;
  opened_at: Date;
  opening_counted_xaf: number;
  opening_expected_xaf: number;
  opening_variance_xaf: number;
  closed_by: Buffer | null;
  closed_at: Date | null;
  closing_counted_xaf: number | null;
  closing_expected_xaf: number | null;
  variance_xaf: number | null;
  status: string;
  force_closed: number;
  approval_request_id: Buffer | null;
  version: number;
};

const numberOrNull = (value: number | null): number | null =>
  value === null ? null : Number(value);

function toSessionRow(row: SessionRecord): CashSessionRow {
  return {
    id: fromBin(row.id),
    cashAccountId: fromBin(row.cash_account_id),
    siteId: fromBin(row.site_id),
    openedBy: fromBin(row.opened_by),
    openedAt: row.opened_at,
    openingCountedXaf: Number(row.opening_counted_xaf),
    openingExpectedXaf: Number(row.opening_expected_xaf),
    openingVarianceXaf: Number(row.opening_variance_xaf),
    closedBy: fromBinOrNull(row.closed_by),
    closedAt: row.closed_at,
    closingCountedXaf: numberOrNull(row.closing_counted_xaf),
    closingExpectedXaf: numberOrNull(row.closing_expected_xaf),
    varianceXaf: numberOrNull(row.variance_xaf),
    status: row.status as CashSessionStatus,
    forceClosed: Boolean(row.force_closed),
    approvalRequestId: fromBinOrNull(row.approval_request_id),
    version: Number(row.version),
  };
}

/** Session par identifiant ; `lock` : verrou exclusif (clôture), sinon lecture simple. */
export async function loadCashSession(
  uow: UnitOfWork,
  sessionId: string,
  options: { readonly lock?: boolean } = {},
): Promise<CashSessionRow | undefined> {
  let query = uow
    .selectFrom('finance_cash_sessions')
    .select([...SESSION_COLUMNS])
    .where('id', '=', toBin(sessionId));
  if (options.lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  return row ? toSessionRow(row) : undefined;
}

/**
 * Sessions du compte qui peuvent fonder la décision d'ouverture à `openedAt` (verrou exclusif) :
 * ouvertes, closes après `openedAt`, ou ouvertes depuis le début du jour métier de `openedAt` (limite
 * du jour, AV-154). Le compte est déjà verrouillé : deux ouvertures du même compte se sérialisent.
 */
export async function lockAccountSessionsFrom(
  uow: UnitOfWork,
  cashAccountId: string,
  openedAt: Date,
  dayStart: Date,
): Promise<CashSessionRow[]> {
  const rows = await uow
    .selectFrom('finance_cash_sessions')
    .select([...SESSION_COLUMNS])
    .where('cash_account_id', '=', toBin(cashAccountId))
    .where((eb) =>
      eb.or([
        eb('closed_at', 'is', null),
        eb('closed_at', '>', openedAt),
        eb('opened_at', '>=', dayStart),
      ]),
    )
    .orderBy('opened_at')
    .forUpdate()
    .execute();
  return rows.map(toSessionRow);
}

/**
 * ADR-032 §4 : solde du registre du compte à `openedAt` = Σ signée des mouvements antérieurs, plus les
 * `SESSION_VARIANCE` de l'instant exact (écart d'une clôture au même instant : `countsInOpeningBalance`
 * du domaine). Lecture du registre, jamais de la projection `balance_xaf` ; verrou partagé.
 */
export async function ledgerBalanceAtOpening(
  uow: UnitOfWork,
  cashAccountId: string,
  openedAt: Date,
): Promise<number> {
  const rows = await uow
    .selectFrom('finance_cash_movements')
    .select(['direction', sql<string>`SUM(amount_xaf)`.as('total')])
    .where('cash_account_id', '=', toBin(cashAccountId))
    .where((eb) =>
      eb.or([
        eb('occurred_at', '<', openedAt),
        eb.and([eb('occurred_at', '=', openedAt), eb('movement_type', '=', 'SESSION_VARIANCE')]),
      ]),
    )
    .groupBy('direction')
    .forShare()
    .execute();
  return rows.reduce(
    (sum, row) => sum + (row.direction === 'IN' ? Number(row.total) : -Number(row.total)),
    0,
  );
}

/**
 * ADR-032 §3 : attendu de clôture = fonds compté à l'ouverture + Σ entrées − Σ sorties des mouvements
 * du compte dont l'`occurred_at` est dans `[openedAt, closedAt[`, hors `SESSION_VARIANCE` et
 * `OPENING_BALANCE` (exclusion portée par `expectedCashXaf`). Sommes SQL groupées par sens et type,
 * verrou partagé ; la fenêtre est déterminée par le temps, jamais par l'index `cash_session_id`.
 */
export async function expectedAtClose(
  uow: UnitOfWork,
  input: {
    readonly cashAccountId: string;
    readonly openingCountedXaf: number;
    readonly openedAt: Date;
    readonly closedAt: Date;
  },
): Promise<number> {
  const rows = await uow
    .selectFrom('finance_cash_movements')
    .select(['direction', 'movement_type', sql<string>`SUM(amount_xaf)`.as('total')])
    .where('cash_account_id', '=', toBin(input.cashAccountId))
    .where('occurred_at', '>=', input.openedAt)
    .where('occurred_at', '<', input.closedAt)
    .groupBy(['direction', 'movement_type'])
    .forShare()
    .execute();
  const flows: CashMovementAmount[] = rows.map((row) => ({
    direction: row.direction as 'IN' | 'OUT',
    movementType: row.movement_type,
    amountXaf: Number(row.total),
  }));
  return expectedCashXaf(input.openingCountedXaf, flows);
}

/**
 * AV-171 : mouvement le plus récent du compte daté à `from` ou après (`occurred_at >= from`), hors
 * `SESSION_VARIANCE` et `OPENING_BALANCE` (qui ne comptent jamais dans l'attendu) ; `null` s'il n'y en
 * a aucun. Sert à repérer une clôture datée avant un mouvement déjà enregistré, qui l'exclurait de
 * l'attendu `[ouverture, clôture[`. Lecture verrouillante partagée, comme `expectedAtClose`.
 */
export async function latestMovementAtOrAfter(
  uow: UnitOfWork,
  cashAccountId: string,
  from: Date,
): Promise<Date | null> {
  const row = await uow
    .selectFrom('finance_cash_movements')
    .select((eb) => eb.fn.max<Date | string | null>('occurred_at').as('latest'))
    .where('cash_account_id', '=', toBin(cashAccountId))
    .where('occurred_at', '>=', from)
    .where('movement_type', 'not in', [...CASH_EXPECTED_EXCLUDED_TYPES])
    .forShare()
    .executeTakeFirst();
  const latest = row?.latest ?? null;
  return latest === null ? null : new Date(latest);
}

/**
 * Paramètre numérique de caisse (règle 8) : valeur du site, à défaut globale, à défaut la valeur par
 * défaut du seed (`db/seeds/system-settings.ts`), en vigueur à `at`.
 */
export async function cashNumberSetting(
  uow: UnitOfWork,
  input: {
    readonly key: string;
    readonly siteId: string | null;
    readonly at: Date;
    readonly fallback: number;
  },
): Promise<number> {
  const scopes: { scopeType: 'SITE' | 'GLOBAL'; scopeId: string | null }[] = [];
  if (input.siteId !== null) scopes.push({ scopeType: 'SITE', scopeId: input.siteId });
  scopes.push({ scopeType: 'GLOBAL', scopeId: null });
  for (const scope of scopes) {
    const value = await currentSettingValue(uow, { key: input.key, ...scope, at: input.at });
    const parsed = typeof value === 'number' ? value : Number(value);
    if (value !== undefined && value !== null && Number.isFinite(parsed)) return parsed;
  }
  return input.fallback;
}

/** Valeurs par défaut des paramètres de caisse (seed P5-03), utilisées faute de version en vigueur. */
export const CASH_SETTING_DEFAULTS = {
  sessionsPerDayMax: { key: 'finance.cash_sessions_per_day_max', fallback: 1 },
  forceCloseHours: { key: 'finance.cash_session_force_close_hours', fallback: 24 },
  varianceToleranceXaf: { key: 'finance.cash_variance_tolerance_xaf', fallback: 0 },
  varianceCriticalXaf: { key: 'finance.cash_variance_critical_xaf', fallback: 10_000 },
} as const;

export function cashSetting(
  uow: UnitOfWork,
  name: keyof typeof CASH_SETTING_DEFAULTS,
  siteId: string | null,
  at: Date,
): Promise<number> {
  const { key, fallback } = CASH_SETTING_DEFAULTS[name];
  return cashNumberSetting(uow, { key, siteId, at, fallback });
}
