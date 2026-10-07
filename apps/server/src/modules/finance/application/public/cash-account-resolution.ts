/**
 * Moyens de paiement et compte de trésorerie crédité par un encaissement (BR-FIN-001, BR-FIN-002).
 *
 * BR-FIN-002 (DÉDUIT, D09) : « le compte crédité est déduit du contexte : caisse du PDV (espèces
 * au PDV), caisse de l'utilisateur (espèces reçues par un commercial terrain), compte mobile
 * money de l'entreprise, compte bancaire ». Le moyen ne désigne pas à lui seul un compte
 * (`default_account_type` donne un type ; deux comptes mobile money, Orange et MTN, sont
 * indistinguables en base). Règle retenue (AV-139, défaut paramétrable par les comptes eux-mêmes) :
 *
 * 1. l'appareil peut désigner le compte (`requestedAccountId`, issu du jeu `cash`) ; il est
 *    contrôlé : type compatible avec le moyen, caisse de PDV du site de la vente, caisse
 *    d'utilisateur de celui qui encaisse ;
 * 2. sinon, espèces : la caisse du PDV si la vente a lieu en PDV, sinon la caisse de l'utilisateur ;
 * 3. sinon, autres moyens : l'unique compte actif du type du moyen ; s'il y en a plusieurs, la
 *    résolution est ambiguë (`CASH_ACCOUNT_AMBIGUOUS`) et l'appareil doit désigner le compte.
 *
 * La commande appelante traduit un échec en rejet (configuration ou saisie invalide) : aucune
 * création automatique de compte (un responsable est requis, BR-FIN-010).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { findCashAccount, type CashAccountSummary, type CashAccountType } from './cash-accounts.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface PaymentMethodSummary {
  readonly code: string;
  readonly label: string;
  /** Référence externe obligatoire (mobile money, virement, chèque). */
  readonly requiresReference: boolean;
  readonly defaultAccountType: CashAccountType;
  readonly isActive: boolean;
}

export async function findPaymentMethod(
  executor: Executor,
  code: string,
): Promise<PaymentMethodSummary | undefined> {
  const row = await executor
    .selectFrom('finance_payment_methods')
    .select(['code', 'label', 'requires_reference', 'default_account_type', 'is_active'])
    .where('code', '=', code)
    .executeTakeFirst();
  return row
    ? {
        code: row.code,
        label: row.label,
        requiresReference: Boolean(row.requires_reference),
        defaultAccountType: row.default_account_type as CashAccountType,
        isActive: Boolean(row.is_active),
      }
    : undefined;
}

export interface CashAccountContext {
  readonly paymentMethodCode: string;
  /** Utilisateur qui encaisse (vendeur). */
  readonly receivedByUserId: string;
  /** Site où a lieu l'encaissement ; `null` sans site (stock mobile). */
  readonly siteId: string | null;
  /** Vrai si l'encaissement a lieu en point de vente (emplacement de vente d'un PDV). */
  readonly atPointOfSale: boolean;
  /** Compte désigné par l'appareil, à contrôler. */
  readonly requestedAccountId?: string | null;
}

export type CashAccountResolution =
  | { readonly ok: true; readonly account: CashAccountSummary }
  | {
      readonly ok: false;
      readonly code:
        | 'PAYMENT_METHOD_INVALID'
        | 'CASH_ACCOUNT_INVALID'
        | 'CASH_ACCOUNT_NOT_FOUND'
        | 'CASH_ACCOUNT_AMBIGUOUS';
      readonly messageFr: string;
    };

function failure(
  code: Extract<CashAccountResolution, { ok: false }>['code'],
  messageFr: string,
): CashAccountResolution {
  return { ok: false, code, messageFr };
}

/** Types de compte admis pour des espèces : les caisses tenues par un site ou une personne. */
const CASH_ACCOUNT_TYPES_FOR_CASH: readonly CashAccountType[] = [
  'CAISSE_PDV',
  'CAISSE_UTILISATEUR',
];

async function activeAccountsOfType(
  executor: Executor,
  accountType: CashAccountType,
  filter: { readonly siteId?: string; readonly holderUserId?: string } = {},
): Promise<readonly string[]> {
  const rows = await executor
    .selectFrom('finance_cash_accounts')
    .select('id')
    .where('account_type', '=', accountType)
    .where('status', '=', 'ACTIVE')
    .$if(filter.siteId !== undefined, (qb) => qb.where('site_id', '=', toBin(filter.siteId!)))
    .$if(filter.holderUserId !== undefined, (qb) =>
      qb.where('holder_user_id', '=', toBin(filter.holderUserId!)),
    )
    .execute();
  return rows.map((row) => fromBin(row.id));
}

export async function cashAccountFor(
  executor: Executor,
  context: CashAccountContext,
  options: { readonly allowInactiveMethod?: boolean } = {},
): Promise<CashAccountResolution> {
  const method = await findPaymentMethod(executor, context.paymentMethodCode);
  if (!method || (!method.isActive && options.allowInactiveMethod !== true)) {
    return failure('PAYMENT_METHOD_INVALID', 'Moyen de paiement inconnu ou désactivé.');
  }
  const isCash = method.defaultAccountType === 'CAISSE_UTILISATEUR';

  if (context.requestedAccountId) {
    const account = await findCashAccount(executor, context.requestedAccountId);
    if (!account) return failure('CASH_ACCOUNT_INVALID', 'Compte de trésorerie inconnu.');
    const typeAllowed = isCash
      ? CASH_ACCOUNT_TYPES_FOR_CASH.includes(account.accountType)
      : account.accountType === method.defaultAccountType;
    if (!typeAllowed) {
      return failure(
        'CASH_ACCOUNT_INVALID',
        `Ce compte ne peut pas recevoir ce moyen de paiement (${method.label}).`,
      );
    }
    if (account.accountType === 'CAISSE_PDV' && account.siteId !== context.siteId) {
      return failure('CASH_ACCOUNT_INVALID', 'Caisse d’un autre point de vente.');
    }
    if (
      account.accountType === 'CAISSE_UTILISATEUR' &&
      account.holderUserId !== context.receivedByUserId
    ) {
      return failure('CASH_ACCOUNT_INVALID', 'Caisse d’un autre utilisateur.');
    }
    return { ok: true, account };
  }

  let candidates: readonly string[];
  if (isCash) {
    candidates =
      context.atPointOfSale && context.siteId !== null
        ? await activeAccountsOfType(executor, 'CAISSE_PDV', { siteId: context.siteId })
        : await activeAccountsOfType(executor, 'CAISSE_UTILISATEUR', {
            holderUserId: context.receivedByUserId,
          });
  } else {
    candidates = await activeAccountsOfType(executor, method.defaultAccountType);
  }
  if (candidates.length === 0) {
    return failure(
      'CASH_ACCOUNT_NOT_FOUND',
      `Aucun compte de trésorerie actif pour ce moyen de paiement (${method.label}).`,
    );
  }
  if (candidates.length > 1) {
    return failure(
      'CASH_ACCOUNT_AMBIGUOUS',
      `Plusieurs comptes peuvent recevoir ce paiement (${method.label}) : choisir le compte.`,
    );
  }
  const account = await findCashAccount(executor, candidates[0]!);
  return account
    ? { ok: true, account }
    : failure('CASH_ACCOUNT_NOT_FOUND', 'Compte de trésorerie introuvable.');
}
