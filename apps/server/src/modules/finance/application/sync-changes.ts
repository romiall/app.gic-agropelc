/**
 * Lignes de flux de changements émises par `finance` (P4-11 ; 01-architecture-offline.md §3.1) :
 * jeu `cash` — comptes de trésorerie de l'utilisateur ou du PDV, avec leur solde. Audience : le
 * détenteur d'une caisse personnelle, à défaut le responsable du compte (`USER`), et le site du
 * compte (`SITE`, caisse de PDV) — la même ressource que les lectures HTTP (`cashAccountResourceOf`).
 * Émis à chaque mouvement (le solde change) et à chaque création, modification ou désactivation ;
 * un compte désactivé sort du jeu (`SCOPE_EXIT`), comme l'ancien responsable d'un compte réattribué.
 * P5-18 : sessions de caisse du PDV et remises de fonds en cours (`CASH_SESSION`, `CASH_TRANSFER`),
 * destinations de remise sans solde (`CASH_TRANSFER_TARGET`).
 * Le type d'entité est une clé de `sync/entity-projections.ts`.
 */
import type { Transaction } from 'kysely';
import type { DB } from '../../../platform/kysely/database.js';
import { recordChanges, type ChangeFeedEntry } from '../../../platform/sync/change-feed.js';
import { fromBin, fromBinOrNull, toBin } from '../../../platform/kysely/uuid-columns.js';

export const CASH_DATASET = 'cash';

export async function emitCashAccountChange(
  uow: Transaction<DB>,
  cashAccountId: string,
  options: { readonly previousOwnerId?: string } = {},
): Promise<void> {
  const row = await uow
    .selectFrom('finance_cash_accounts')
    .select(['holder_user_id', 'responsible_user_id', 'site_id', 'status', 'version'])
    .where('id', '=', toBin(cashAccountId))
    .executeTakeFirst();
  if (!row) return;
  const owner = fromBinOrNull(row.holder_user_id) ?? fromBin(row.responsible_user_id);
  const site = fromBinOrNull(row.site_id);
  const changeType = row.status === 'ACTIVE' ? 'UPSERT' : 'SCOPE_EXIT';
  const base = { dataset: CASH_DATASET, entityType: 'CASH_ACCOUNT', entityId: cashAccountId };
  const entries: ChangeFeedEntry[] = [];
  // La sortie de l'ancien titulaire passe **avant** les mises à jour (numéro de flux inférieur) :
  // l'appareil retire la clé quelle que soit la portée de la ligne, et un ancien titulaire qui voit
  // encore le compte par son site doit le garder (P5-18, revue).
  const previous = options.previousOwnerId;
  if (previous !== undefined && previous !== owner) {
    entries.push({
      ...base,
      scopeType: 'USER',
      scopeId: previous,
      changeType: 'SCOPE_EXIT',
      rowVersion: row.version,
    });
  }
  entries.push({ ...base, scopeType: 'USER', scopeId: owner, changeType, rowVersion: row.version });
  if (site !== null) {
    entries.push({
      ...base,
      scopeType: 'SITE',
      scopeId: site,
      changeType,
      rowVersion: row.version,
    });
  }
  await recordChanges(uow, entries);
}

/**
 * Destination de remise (P5-18, AV-197) : un compte sans détenteur personnel (caisse de PDV, caisse
 * centrale, banque, mobile money), actif, publié à tous les appareils (ligne `GLOBAL` du jeu `cash`)
 * **sans son solde** — l'appareil qui envoie une remise hors ligne doit connaître le compte
 * destinataire (paires admises : `finance.cash_transfer_allowed_pairs`, jeu `me`), que son périmètre
 * n'atteint pas (la caisse centrale n'est le compte d'aucun site du vendeur). Émise à la création, à
 * la modification et à la désactivation du compte, jamais à ses mouvements (le solde n'y figure pas).
 * Un compte désactivé, ou personnel, en sort (`DELETE`).
 */
export async function emitCashTransferTargetChange(
  uow: Transaction<DB>,
  cashAccountId: string,
): Promise<void> {
  const row = await uow
    .selectFrom('finance_cash_accounts')
    .select(['holder_user_id', 'status'])
    .where('id', '=', toBin(cashAccountId))
    .executeTakeFirst();
  if (!row) return;
  // Sans version : celle du compte avance à chaque mouvement et dirait l'activité de la caisse.
  await recordChanges(uow, [
    {
      dataset: CASH_DATASET,
      entityType: 'CASH_TRANSFER_TARGET',
      entityId: cashAccountId,
      scopeType: 'GLOBAL',
      scopeId: null,
      changeType: row.status === 'ACTIVE' && row.holder_user_id === null ? 'UPSERT' : 'DELETE',
    },
  ]);
}

/**
 * Session de caisse du PDV (P5-18 ; dictionnaire `finance.cash_sessions` : « DL (session ouverte du PDV,
 * jeu `cash`) ») : au site de la session (`SITE`, filtré par `finance.cash.read` pour le jeu `cash`,
 * `device-scope.ts`). Servie ouverte (`OPEN`) et à valider (`PENDING_VALIDATION` : l'appareil qui a
 * clôturé y lit l'attendu recalculé par le serveur et l'écart) ; une session validée sort du jeu
 * (`SCOPE_EXIT`, AV-193). Émise à l'ouverture, à la clôture (forcée comprise) et à la validation.
 */
export async function emitCashSessionChange(
  uow: Transaction<DB>,
  sessionId: string,
): Promise<void> {
  const row = await uow
    .selectFrom('finance_cash_sessions')
    .select(['site_id', 'status', 'version'])
    .where('id', '=', toBin(sessionId))
    .executeTakeFirst();
  if (!row) return;
  await recordChanges(uow, [
    {
      dataset: CASH_DATASET,
      entityType: 'CASH_SESSION',
      entityId: sessionId,
      scopeType: 'SITE',
      scopeId: fromBin(row.site_id),
      changeType: row.status === 'VALIDATED' ? 'SCOPE_EXIT' : 'UPSERT',
      rowVersion: row.version,
    },
  ]);
}

/** Statuts d'une remise « en cours » (dictionnaire `finance.cash_transfers` : « DL (en cours) »). */
const TRANSFER_IN_PROGRESS = new Set(['SENT', 'DISCREPANCY_PENDING']);

/**
 * Remise de fonds en cours (P5-18) : aux deux comptes, comme le compte lui-même — détenteur d'une
 * caisse personnelle, à défaut responsable (`USER`), et site du compte (`SITE`). Servie envoyée
 * (`SENT`) et en écart (`DISCREPANCY_PENDING`) ; reçue (`RECEIVED`), close (`CLOSED`) ou annulée
 * (`CANCELLED`), elle sort du jeu (`SCOPE_EXIT`, AV-193) — le solde des comptes suit par `CASH_ACCOUNT`.
 * `previousOwnerId` (compte réattribué) : sortie vers l'ancien titulaire, s'il n'est plus celui d'un des
 * deux comptes, écrite **avant** les mises à jour (comme `emitCashAccountChange`).
 */
export async function emitCashTransferChange(
  uow: Transaction<DB>,
  transferId: string,
  options: { readonly previousOwnerId?: string } = {},
): Promise<void> {
  const row = await uow
    .selectFrom('finance_cash_transfers')
    .select(['from_account_id', 'to_account_id', 'status', 'version'])
    .where('id', '=', toBin(transferId))
    .executeTakeFirst();
  if (!row) return;
  const accounts = await uow
    .selectFrom('finance_cash_accounts')
    .select(['holder_user_id', 'responsible_user_id', 'site_id'])
    .where('id', 'in', [row.from_account_id, row.to_account_id])
    .execute();
  const changeType = TRANSFER_IN_PROGRESS.has(row.status) ? 'UPSERT' : 'SCOPE_EXIT';
  const seen = new Set<string>();
  const entries: ChangeFeedEntry[] = [];
  const add = (scopeType: 'USER' | 'SITE', scopeId: string) => {
    if (seen.has(`${scopeType}:${scopeId}`)) return;
    seen.add(`${scopeType}:${scopeId}`);
    entries.push({
      dataset: CASH_DATASET,
      entityType: 'CASH_TRANSFER',
      entityId: transferId,
      scopeType,
      scopeId,
      changeType,
      rowVersion: row.version,
    });
  };
  for (const account of accounts) {
    add('USER', fromBinOrNull(account.holder_user_id) ?? fromBin(account.responsible_user_id));
    const site = fromBinOrNull(account.site_id);
    if (site !== null) add('SITE', site);
  }
  const previous = options.previousOwnerId;
  if (previous !== undefined && !seen.has(`USER:${previous}`)) {
    entries.unshift({
      dataset: CASH_DATASET,
      entityType: 'CASH_TRANSFER',
      entityId: transferId,
      scopeType: 'USER',
      scopeId: previous,
      changeType: 'SCOPE_EXIT',
      rowVersion: row.version,
    });
  }
  await recordChanges(uow, entries);
}

/**
 * Compte réattribué (P5-18, revue) : ses remises en cours sortent du jeu de l'ancien titulaire et
 * atteignent le nouveau. Sans cela, l'ancien garderait une remise « envoyée » et son montant.
 */
export async function emitCashTransfersOfAccountChange(
  uow: Transaction<DB>,
  cashAccountId: string,
  previousOwnerId: string,
): Promise<void> {
  const inProgress = await uow
    .selectFrom('finance_cash_transfers')
    .select('id')
    .where('status', 'in', [...TRANSFER_IN_PROGRESS])
    .where((eb) =>
      eb.or([
        eb('from_account_id', '=', toBin(cashAccountId)),
        eb('to_account_id', '=', toBin(cashAccountId)),
      ]),
    )
    .execute();
  for (const transfer of inProgress) {
    await emitCashTransferChange(uow, fromBin(transfer.id), { previousOwnerId });
  }
}

/**
 * P8-04 (ADR-060 §9, AV-357) : catégories de dépense, jeu `catalog`, ligne `GLOBAL`, à leur
 * identifiant et à leur version, actives ou non (l'appareil affiche la catégorie d'une dépense
 * existante ; il ne propose que les actives non système). Même jeu que les référentiels de vente
 * (`catalog/application/sync-changes.ts`, que `finance` n'importe pas). Les catégories semées sont
 * publiées par le seed (`db/seeds/publish-references.ts`).
 */
export async function emitExpenseCategoryChange(
  uow: Transaction<DB>,
  categoryId: string,
): Promise<void> {
  const row = await uow
    .selectFrom('finance_expense_categories')
    .select('version')
    .where('id', '=', toBin(categoryId))
    .executeTakeFirst();
  if (!row) return;
  await recordChanges(uow, [
    {
      dataset: 'catalog',
      entityType: 'EXPENSE_CATEGORY',
      entityId: categoryId,
      scopeType: 'GLOBAL',
      scopeId: null,
      rowVersion: row.version,
    },
  ]);
}
