/**
 * Sessions de caisse, lecture par fenêtre (P5-12 ; ADR-032 §2). Un mouvement d'une caisse de PDV
 * appartient à la session du compte dont la fenêtre `[opened_at, closed_at[` couvre son
 * `occurred_at` : ce rattachement se lit **par le temps**. `findCashSessionCovering` sert à poser
 * l'index dénormalisé `cash_session_id` à l'insertion (`recordCashMovement` ; en P5-14, `sales` pour
 * ses ventes et encaissements) ; il n'est jamais la source de l'attendu d'une session.
 *
 * AV-509 (décision du porteur, 04/11/2026) : une vente n'est jamais conditionnée par l'ouverture d'une
 * caisse. Exiger une session ouverte pour les espèces d'une caisse de PDV (BR-DIS-005) est un paramètre,
 * `finance.cash_session_required` (réglable par site), **faux par défaut** : `isCashSessionRequired`.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Paramètre qui rétablit l'exigence d'une session ouverte pour les espèces d'une caisse de PDV (AV-509). */
export const CASH_SESSION_REQUIRED_SETTING = 'finance.cash_session_required';

/**
 * Une session de caisse ouverte est-elle exigée pour encaisser ou payer en espèces sur la caisse du PDV
 * `siteId` à l'instant `at` ? Valeur du site, à défaut globale, **à défaut `false`** (AV-509) : la valeur
 * absente ou mal formée ne rétablit jamais l'exigence. Lue à l'heure du fait (`occurred_at`), comme les
 * autres paramètres de caisse.
 */
export async function isCashSessionRequired(
  executor: Executor,
  input: { readonly siteId: string | null; readonly at: Date },
): Promise<boolean> {
  const scopes: { scopeType: 'SITE' | 'GLOBAL'; scopeId: string | null }[] = [];
  if (input.siteId !== null) scopes.push({ scopeType: 'SITE', scopeId: input.siteId });
  scopes.push({ scopeType: 'GLOBAL', scopeId: null });
  for (const scope of scopes) {
    const value = await currentSettingValue(executor, {
      key: CASH_SESSION_REQUIRED_SETTING,
      ...scope,
      at: input.at,
    });
    if (typeof value === 'boolean') return value;
  }
  return false;
}

export interface CoveringCashSession {
  readonly id: string;
  readonly status: 'OPEN' | 'PENDING_VALIDATION' | 'VALIDATED';
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly siteId: string;
}

/**
 * Session du compte dont la fenêtre couvre `at` (ouverture incluse, clôture exclue), ou `null`.
 * `lock` : `share` dans une écriture (lecture verrouillante : l'instantané de la transaction peut
 * précéder le verrou du compte), `update` pour la modifier ensuite, rien pour une simple lecture.
 */
export async function findCashSessionCovering(
  executor: Executor,
  cashAccountId: string,
  at: Date,
  options: { readonly lock?: 'share' | 'update' } = {},
): Promise<CoveringCashSession | null> {
  let query = executor
    .selectFrom('finance_cash_sessions')
    .select(['id', 'status', 'opened_at', 'closed_at', 'site_id'])
    .where('cash_account_id', '=', toBin(cashAccountId))
    .where('opened_at', '<=', at)
    .where((eb) => eb.or([eb('closed_at', 'is', null), eb('closed_at', '>', at)]))
    .orderBy('opened_at', 'desc')
    .limit(1);
  if (options.lock === 'share') query = query.forShare();
  if (options.lock === 'update') query = query.forUpdate();
  const row = await query.executeTakeFirst();
  return row
    ? {
        id: fromBin(row.id),
        status: row.status as CoveringCashSession['status'],
        openedAt: row.opened_at,
        closedAt: row.closed_at,
        siteId: fromBin(row.site_id),
      }
    : null;
}
