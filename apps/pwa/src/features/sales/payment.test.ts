import { describe, expect, it } from 'vitest';
import { paymentIssues, paymentPayload, receivingAccounts } from './payment.js';
import type { CashAccountData, PaymentMethodData } from './types.js';

const method = (code: string, type: string, requiresReference: boolean): PaymentMethodData => ({
  id: code,
  code,
  label: code,
  requires_reference: requiresReference,
  default_account_type: type,
  is_active: true,
});

const account = (id: string, type: string): CashAccountData => ({
  id,
  code: id,
  name: `Compte ${id}`,
  account_type: type,
  site_id: null,
  holder_user_id: null,
  responsible_user_id: 'fin',
  status: 'ACTIVE',
});

const CASH = method('ESPECES', 'CAISSE_UTILISATEUR', false);
const ORANGE = method('MOBILE_MONEY_ORANGE', 'MOBILE_MONEY', true);
const ACCOUNTS = [
  account('pdv', 'CAISSE_PDV'),
  account('om', 'MOBILE_MONEY'),
  account('mtn', 'MOBILE_MONEY'),
];

describe('encaissement : compte de réception et référence (AV-300)', () => {
  it('espèces : jamais de compte désigné, le serveur déduit la caisse', () => {
    expect(receivingAccounts(ACCOUNTS, CASH)).toEqual([]);
    expect(
      paymentPayload(
        { method: CASH, amountXaf: 500, reference: 'oubliée', accountId: 'pdv' },
        ACCOUNTS,
      ),
    ).toEqual({ methodCode: 'ESPECES', amountXaf: 500 });
  });

  it('plusieurs comptes du type : choix exigé, puis compte envoyé', () => {
    const input = { method: ORANGE, amountXaf: 500, reference: 'OM-1', accountId: null };
    expect(paymentIssues(input, ACCOUNTS)).toEqual(['ACCOUNT_REQUIRED']);
    expect(paymentIssues({ ...input, accountId: 'om' }, ACCOUNTS)).toEqual([]);
    expect(paymentPayload({ ...input, accountId: 'om' }, ACCOUNTS)).toEqual({
      methodCode: 'MOBILE_MONEY_ORANGE',
      amountXaf: 500,
      reference: 'OM-1',
      cashAccountId: 'om',
    });
  });

  it('un seul compte connu : désigné d’office ; aucun connu : laissé au serveur', () => {
    const one = [account('om', 'MOBILE_MONEY')];
    const input = { method: ORANGE, amountXaf: 500, reference: 'OM-1', accountId: null };
    expect(paymentPayload(input, one)).toMatchObject({ cashAccountId: 'om' });
    expect(paymentPayload(input, [])).not.toHaveProperty('cashAccountId');
  });

  it('référence exigée, bornée à 80 caractères ; montant positif', () => {
    expect(
      paymentIssues({ method: ORANGE, amountXaf: 0, reference: '', accountId: 'om' }, ACCOUNTS),
    ).toEqual(['AMOUNT_INVALID', 'REFERENCE_REQUIRED']);
    expect(
      paymentIssues(
        { method: ORANGE, amountXaf: 10, reference: 'x'.repeat(81), accountId: 'om' },
        ACCOUNTS,
      ),
    ).toEqual(['REFERENCE_TOO_LONG']);
    expect(
      paymentIssues({ method: undefined, amountXaf: 10, reference: '', accountId: null }, ACCOUNTS),
    ).toEqual(['METHOD_REQUIRED']);
  });
});
