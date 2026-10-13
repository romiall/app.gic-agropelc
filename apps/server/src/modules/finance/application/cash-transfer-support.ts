/**
 * Utilitaires internes des remises de fonds (P5-15 ; D09 §16). Interne au module `finance` :
 * `finance` n'importe pas `sales` (graphe, .dependency-cruiser.cjs), d'où ces lectures écrites ici
 * plutôt qu'empruntées à `sales/commands/shared.ts`.
 *
 * - Paramètres (règle 8) : paires admises, code de la série globale, délai d'alerte — toujours
 *   ramenés au défaut du domaine quand la valeur est absente ou mal formée.
 * - Accès à un compte (D09 §8 `CASH_ACCOUNT_FORBIDDEN` ; RBAC §3) : le détenteur d'une caisse
 *   personnelle en est le propriétaire, quel que soit le périmètre de son affectation (une caisse
 *   personnelle n'a ni site ni zone) ; tout autre compte est évalué par `evaluateAccess` sur sa
 *   ressource (`cashAccountResourceOf` : responsable, site).
 * - Numérotation `RMF` (AV-077, AV-176) : site du compte source, à défaut du compte destinataire, à
 *   défaut une série globale de code paramétrable. Le compteur est clé par le code de la série, jamais
 *   par l'identifiant d'un site : numéro et compteur se correspondent un pour un, quel que soit l'ordre
 *   de création des sites.
 * - Politique `CASH_TRANSFER_DISCREPANCY` : la plus récente qui exige une validation et nomme un
 *   approbateur ; hors ligne, repli sur celle en vigueur à la réception (BR-SYN-007).
 * - Refus métier : une `DomainError` ou une `CashMovementError` devient un rejet ; toute autre erreur
 *   est relancée (transitoire, le pipeline rejoue).
 */
import type { Transaction } from 'kysely';
import {
  DomainError,
  businessDayOf,
  cashTransferPairsFrom,
  cashTransferSeriesCodeFrom,
  cashTransferUnreceivedHoursFrom,
  type CashTransferPairs,
} from '@gic/domain';
import type { DB } from '../../../platform/kysely/database.js';
import type { CommandHandlerOutcome } from '../../../platform/sync/command-handler-registry.js';
import type { DocumentSequenceService } from '../../../platform/document-sequences/document-sequence.service.js';
import { codeEntityId } from '../../../platform/sync/code-entity-id.js';
import { fromBin, toBin } from '../../../platform/kysely/uuid-columns.js';
import { currentSettingValue } from '../../organization/application/public/index.js';
import { evaluateAccess, hasPermissionAt } from '../../identity/application/public/index.js';
import {
  currentPolicies,
  type ActiveControlPolicy,
} from '../../approvals/application/public/index.js';
import { CashMovementError } from './public/cash-movements.js';
import { cashAccountResourceOf } from './public/cash-account-query.js';
import type { CashAccountSummary } from './public/cash-accounts.js';

type Uow = Transaction<DB>;

export const CASH_TRANSFER_PERMISSION = 'finance.cash_transfer.record';
export const CASH_TRANSFER_DOC_TYPE = 'RMF';

export function rejected(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}

/** `DomainError` et `CashMovementError` → rejet métier ; toute autre erreur est relancée. */
export function financeBusinessRejection(error: unknown): CommandHandlerOutcome {
  if (error instanceof DomainError) return rejected(error.code, error.message);
  if (error instanceof CashMovementError) return rejected(error.code, error.message);
  throw error;
}

async function globalSetting(
  executor: Parameters<typeof currentSettingValue>[0],
  key: string,
  at: Date,
): Promise<unknown> {
  return currentSettingValue(executor, { key, scopeType: 'GLOBAL', scopeId: null, at });
}

/** Paires admises à `at` (`finance.cash_transfer_allowed_pairs`, AV-158). */
export async function cashTransferPairsAt(uow: Uow, at: Date): Promise<CashTransferPairs> {
  return cashTransferPairsFrom(await globalSetting(uow, 'finance.cash_transfer_allowed_pairs', at));
}

/** Délai d'alerte à `at` (`finance.cash_transfer_unreceived_hours`, AV-158), 48 h par défaut. */
export async function cashTransferUnreceivedHoursAt(
  executor: Parameters<typeof currentSettingValue>[0],
  at: Date,
): Promise<number> {
  return cashTransferUnreceivedHoursFrom(
    await globalSetting(executor, 'finance.cash_transfer_unreceived_hours', at),
  );
}

/**
 * L'auteur peut-il agir sur ce compte (`finance.cash_transfer.record` par défaut ; une dépense ou un
 * paiement fournisseur passe sa propre permission, P8) à `at` ? Le détenteur d'une caisse personnelle
 * en est le propriétaire (RBAC §3) : il suffit qu'il détienne la permission ; tout autre compte est
 * évalué sur sa ressource (portée du compte, AV-158).
 */
export async function canActOnCashAccount(
  uow: Uow,
  input: {
    readonly userId: string;
    readonly at: Date;
    readonly account: CashAccountSummary;
    readonly permissionCode?: string;
  },
): Promise<boolean> {
  const permissionCode = input.permissionCode ?? CASH_TRANSFER_PERMISSION;
  if (
    input.account.accountType === 'CAISSE_UTILISATEUR' &&
    input.account.holderUserId === input.userId
  ) {
    return hasPermissionAt(uow, toBin(input.userId), permissionCode, input.at);
  }
  const access = await evaluateAccess(uow, {
    userId: input.userId,
    permissionCode,
    occurredAt: input.at,
    resource: cashAccountResourceOf(input.account),
  });
  return access.allowed;
}

export const CASH_ACCOUNT_FORBIDDEN = rejected(
  'CASH_ACCOUNT_FORBIDDEN',
  'Compte de trésorerie hors de votre périmètre (D09 §8).',
);

/** Site (code et zone) lu par clé ; `undefined` s'il n'existe pas. */
export async function loadSiteRef(
  uow: Uow,
  siteId: string,
): Promise<{ readonly id: string; readonly code: string; readonly zoneId: string } | undefined> {
  const row = await uow
    .selectFrom('organization_sites')
    .select(['id', 'code', 'zone_id'])
    .where('id', '=', toBin(siteId))
    .executeTakeFirst();
  return row ? { id: fromBin(row.id), code: row.code, zoneId: fromBin(row.zone_id) } : undefined;
}

/**
 * Clé du compteur `RMF` d'un code de série : identifiant déterministe tiré du seul code (ADR-031).
 * Le numéro `RMF-{CODE}-{AAAA}-{seq6}` ne dépend que du code et de l'année ; le compteur aussi. Ainsi
 * deux envois ne reçoivent jamais le même numéro, que le code soit celui d'un site réel, de la série
 * globale, ou des deux à la fois, et quel que soit l'ordre dans lequel le site réel a été créé
 * (AV-176). Le code d'un site est unique et ne change pas (`uq_organization_sites_code`).
 */
export function cashTransferCounterKey(code: string): string {
  return codeEntityId('DOCUMENT_SERIES', code);
}

/**
 * Numéro `RMF-{CODE}-{AAAA}-{seq6}` (AV-077, AV-176) et site de la remise. Site de numérotation : celui
 * du compte source, à défaut celui du compte destinataire (la remise porte alors ce site). Sans site,
 * série globale : code `finance.cash_transfer_series_code` (validé, `SIEGE` par défaut) ; la remise n'a
 * alors pas de site. Dans les deux cas, le compteur est celui du code (`cashTransferCounterKey`) : un
 * site réel créé après des remises de la série globale du même code reprend la suite de la numérotation,
 * sans doublon. Année = jour métier de Douala. Le compteur est pris après le verrou des comptes
 * (ADR-032 §10).
 */
export async function nextCashTransferNumber(
  uow: Uow,
  documentSequences: DocumentSequenceService,
  input: {
    readonly from: CashAccountSummary;
    readonly to: CashAccountSummary;
    readonly at: Date;
  },
): Promise<{ readonly docNumber: string; readonly siteId: string | null }> {
  const year = Number(businessDayOf(input.at).slice(0, 4));
  const accountSiteId = input.from.siteId ?? input.to.siteId;
  if (accountSiteId !== null) {
    const site = await loadSiteRef(uow, accountSiteId);
    if (site) {
      const docNumber = await documentSequences.next(uow, {
        docType: CASH_TRANSFER_DOC_TYPE,
        siteId: cashTransferCounterKey(site.code),
        codeSite: site.code,
        year,
      });
      return { docNumber, siteId: site.id };
    }
  }
  const code = cashTransferSeriesCodeFrom(
    await globalSetting(uow, 'finance.cash_transfer_series_code', input.at),
  );
  const docNumber = await documentSequences.next(uow, {
    docType: CASH_TRANSFER_DOC_TYPE,
    siteId: cashTransferCounterKey(code),
    codeSite: code,
    year,
  });
  return { docNumber, siteId: null };
}

/**
 * Politique `CASH_TRANSFER_DISCREPANCY` applicable : la plus récente qui exige une validation et
 * nomme un approbateur (une politique sans approbateur laisserait une demande impossible à décider,
 * `POLICY_UNRESOLVED`). Hors ligne, repli sur celle en vigueur à la réception.
 */
export async function transferDiscrepancyPolicy(
  uow: Uow,
  at: Date,
  offlineFallbackAt?: Date,
): Promise<ActiveControlPolicy | undefined> {
  const pick = async (instant: Date) =>
    (await currentPolicies(uow, 'CASH_TRANSFER_DISCREPANCY', instant)).find(
      (policy) => policy.requiresApproval && policy.approverPermission !== null,
    );
  const policy = await pick(at);
  if (policy !== undefined || offlineFallbackAt === undefined) return policy;
  return pick(offlineFallbackAt);
}

/** Une remise `SENT` part-elle de ce compte ou y arrive-t-elle (garde de désactivation) ? */
export async function hasCashTransferInTransit(uow: Uow, accountId: string): Promise<boolean> {
  const row = await uow
    .selectFrom('finance_cash_transfers')
    .select('id')
    .where('status', '=', 'SENT')
    .where((eb) =>
      eb.or([
        eb('from_account_id', '=', toBin(accountId)),
        eb('to_account_id', '=', toBin(accountId)),
      ]),
    )
    .executeTakeFirst();
  return row !== undefined;
}

/** Verrouille les comptes donnés dans l'ordre croissant de leur identifiant (aucun interblocage). */
export async function lockCashAccounts(
  uow: Uow,
  accountIds: readonly string[],
): Promise<ReadonlyMap<string, { readonly status: string }>> {
  const locked = new Map<string, { readonly status: string }>();
  for (const id of [...new Set(accountIds)].sort()) {
    const row = await uow
      .selectFrom('finance_cash_accounts')
      .select('status')
      .where('id', '=', toBin(id))
      .forUpdate()
      .executeTakeFirst();
    if (row) locked.set(id, { status: row.status });
  }
  return locked;
}
