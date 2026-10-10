/**
 * Encaissement saisi sur l'appareil (vente, acompte, règlement de créance) : moyen, montant,
 * référence et compte de réception. Logique pure.
 *
 * Compte de réception (BR-FIN-002, AV-139 ; `cash-account-resolution.ts` côté serveur) : pour des
 * espèces, le serveur déduit la caisse sans ambiguïté (caisse du PDV en point de vente, sinon caisse
 * de l'utilisateur) et l'appareil n'en désigne aucune. Pour un autre moyen, le serveur ne sait choisir
 * que s'il n'existe qu'un compte actif du type du moyen ; sinon l'appareil doit désigner le compte,
 * parmi ceux que lui sert le jeu `cash`. Les comptes mobile money et bancaires de l'entreprise ne sont
 * aujourd'hui servis qu'à leurs responsables : un vendeur n'en connaît aucun (AV-300, besoin S-09).
 */
import type { CashAccountData, PaymentMethodData } from './types.js';

export const CASH_METHOD_ACCOUNT_TYPE = 'CAISSE_UTILISATEUR';
/** Longueur maximale d'une référence de transaction (`salePaymentSchema`). */
export const MAX_REFERENCE_LENGTH = 80;

export interface PaymentInput {
  readonly method: PaymentMethodData | undefined;
  readonly amountXaf: number | null;
  readonly reference: string;
  readonly accountId: string | null;
}

/** Comptes que l'appareil peut désigner pour ce moyen ; vide pour des espèces. */
export function receivingAccounts(
  accounts: readonly CashAccountData[],
  method: PaymentMethodData | undefined,
): CashAccountData[] {
  if (!method || method.default_account_type === CASH_METHOD_ACCOUNT_TYPE) return [];
  return accounts.filter(
    (account) =>
      account.account_type === method.default_account_type && account.status === 'ACTIVE',
  );
}

export type PaymentIssue =
  | 'AMOUNT_INVALID'
  | 'REFERENCE_REQUIRED'
  | 'REFERENCE_TOO_LONG'
  | 'ACCOUNT_REQUIRED'
  | 'METHOD_REQUIRED';

/** Défauts bloquants d'un encaissement de montant strictement positif. */
export function paymentIssues(
  input: PaymentInput,
  accounts: readonly CashAccountData[],
): PaymentIssue[] {
  const issues: PaymentIssue[] = [];
  if (input.amountXaf === null || input.amountXaf <= 0) issues.push('AMOUNT_INVALID');
  if (!input.method) {
    issues.push('METHOD_REQUIRED');
    return issues;
  }
  const reference = input.reference.trim();
  if (input.method.requires_reference && !reference) issues.push('REFERENCE_REQUIRED');
  if (reference.length > MAX_REFERENCE_LENGTH) issues.push('REFERENCE_TOO_LONG');
  const candidates = receivingAccounts(accounts, input.method);
  if (candidates.length > 1 && !candidates.some((account) => account.id === input.accountId)) {
    issues.push('ACCOUNT_REQUIRED');
  }
  return issues;
}

/**
 * Paiement de la charge utile (`salePaymentSchema`) : la référence n'est envoyée que pour un moyen
 * qui l'exige (une référence saisie pour un autre moyen puis masquée n'est jamais transmise) ; le
 * compte est désigné quand l'appareil le connaît sans ambiguïté ou quand l'utilisateur l'a choisi.
 */
export function paymentPayload(
  input: PaymentInput & { readonly amountXaf: number; readonly method: PaymentMethodData },
  accounts: readonly CashAccountData[],
) {
  const reference = input.method.requires_reference ? input.reference.trim() : '';
  const candidates = receivingAccounts(accounts, input.method);
  const accountId =
    candidates.length === 1
      ? candidates[0]!.id
      : candidates.find((account) => account.id === input.accountId)?.id;
  return {
    methodCode: input.method.code,
    amountXaf: input.amountXaf,
    ...(reference ? { reference } : {}),
    ...(accountId ? { cashAccountId: accountId } : {}),
  };
}
