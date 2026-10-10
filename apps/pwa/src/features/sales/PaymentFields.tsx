/**
 * Champs d'un encaissement : moyen, montant, référence si le moyen l'exige, compte de réception si
 * l'appareil doit le désigner (`payment.ts`). Changer de moyen efface la référence et le compte saisis
 * pour le moyen précédent.
 */
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_REFERENCE_LENGTH, receivingAccounts } from './payment.js';
import type { CashAccountData, PaymentMethodData } from './types.js';

export interface PaymentFieldsValue {
  readonly methodCode: string | null;
  /** `null` : montant prérempli (par l'écran appelant). */
  readonly amountText: string | null;
  readonly reference: string;
  readonly accountId: string | null;
}

export const EMPTY_PAYMENT: PaymentFieldsValue = {
  methodCode: null,
  amountText: null,
  reference: '',
  accountId: null,
};

interface PaymentFieldsProps {
  readonly methods: readonly PaymentMethodData[];
  readonly accounts: readonly CashAccountData[];
  readonly method: PaymentMethodData | undefined;
  readonly value: PaymentFieldsValue;
  readonly amountLabel: string;
  readonly amountPlaceholder: string;
  readonly onChange: (value: PaymentFieldsValue) => void;
}

export function PaymentFields({
  methods,
  accounts,
  method,
  value,
  amountLabel,
  amountPlaceholder,
  onChange,
}: PaymentFieldsProps) {
  const { t } = useTranslation();
  const id = useId();
  const candidates = receivingAccounts(accounts, method);
  const unknownAccount =
    method !== undefined &&
    method.default_account_type !== 'CAISSE_UTILISATEUR' &&
    candidates.length === 0;

  return (
    <>
      {methods.length > 0 ? (
        <div className="field">
          <label htmlFor={`${id}-method`}>{t('sales.method_label')}</label>
          <select
            id={`${id}-method`}
            className="text-input"
            value={method?.code ?? ''}
            onChange={(event) =>
              onChange({ ...value, methodCode: event.target.value, reference: '', accountId: null })
            }
          >
            {methods.map((candidate) => (
              <option key={candidate.code} value={candidate.code}>
                {candidate.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="text-warn">{t('sales.no_payment_method')}</p>
      )}
      <div className="field">
        <label htmlFor={`${id}-amount`}>{amountLabel}</label>
        <input
          id={`${id}-amount`}
          className="text-input"
          inputMode="numeric"
          value={value.amountText ?? amountPlaceholder}
          onChange={(event) => onChange({ ...value, amountText: event.target.value })}
        />
      </div>
      {method?.requires_reference ? (
        <div className="field">
          <label htmlFor={`${id}-reference`}>{t('sales.reference_label')}</label>
          <input
            id={`${id}-reference`}
            className="text-input"
            value={value.reference}
            maxLength={MAX_REFERENCE_LENGTH}
            onChange={(event) => onChange({ ...value, reference: event.target.value })}
            autoComplete="off"
          />
        </div>
      ) : null}
      {candidates.length > 1 ? (
        <div className="field">
          <label htmlFor={`${id}-account`}>{t('sales.account_label')}</label>
          <select
            id={`${id}-account`}
            className="text-input"
            value={value.accountId ?? ''}
            onChange={(event) => onChange({ ...value, accountId: event.target.value || null })}
          >
            <option value="">{t('sales.account_placeholder')}</option>
            {candidates.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {unknownAccount ? <p className="home-muted">{t('sales.account_unknown_hint')}</p> : null}
    </>
  );
}
