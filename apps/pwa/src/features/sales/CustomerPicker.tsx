/**
 * Choix du client parmi le portefeuille téléchargé (jeu `customers`), par nom ou téléphone, sans
 * réseau. `allowAnonymous` : la vente directe admet le client de passage (payé en totalité, AV-027) ;
 * la commande et l'encaissement exigent un client identifié.
 */
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from './format.js';
import type { CustomerData } from './types.js';

const MAX_RESULTS = 8;

function matches(customer: CustomerData, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  if (customer.display_name.toLowerCase().includes(text)) return true;
  if (customer.contact_name?.toLowerCase().includes(text)) return true;
  const digits = text.replace(/\D/g, '');
  if (digits.length >= 3 && customer.phone_primary) {
    return customer.phone_primary.replace(/\D/g, '').includes(digits);
  }
  return false;
}

interface CustomerPickerProps {
  readonly customers: readonly CustomerData[];
  readonly value: string | null;
  readonly onChange: (customerId: string | null) => void;
  readonly allowAnonymous: boolean;
}

export function CustomerPicker({
  customers,
  value,
  onChange,
  allowAnonymous,
}: CustomerPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(value === null && !allowAnonymous);
  const inputId = useId();
  const selected = value ? customers.find((customer) => customer.id === value) : undefined;
  const results = useMemo(
    () =>
      customers
        .filter((customer) => matches(customer, query))
        .sort((a, b) => a.display_name.localeCompare(b.display_name, 'fr'))
        .slice(0, MAX_RESULTS),
    [customers, query],
  );

  if (!searching) {
    return (
      <div className="picked">
        <div>
          <p className="picked-title">
            {selected ? selected.display_name : t('sales.customer_anonymous')}
          </p>
          <p className="picked-hint">
            {selected
              ? [
                  selected.phone_primary,
                  selected.outstanding_xaf > 0
                    ? t('sales.customer_outstanding', {
                        amount: formatMoney(selected.outstanding_xaf),
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : t('sales.customer_anonymous_hint')}
          </p>
        </div>
        <button type="button" className="secondary" onClick={() => setSearching(true)}>
          {t('sales.customer_change')}
        </button>
      </div>
    );
  }

  return (
    <div className="picker">
      <label htmlFor={inputId} className="visually-hidden">
        {t('sales.customer_search')}
      </label>
      <input
        id={inputId}
        type="search"
        className="text-input"
        placeholder={t('sales.customer_search')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoComplete="off"
      />
      <ul className="picker-list">
        {allowAnonymous ? (
          <li>
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setSearching(false);
              }}
            >
              <span>{t('sales.customer_anonymous')}</span>
              <small>{t('sales.customer_anonymous_hint')}</small>
            </button>
          </li>
        ) : null}
        {results.map((customer) => (
          <li key={customer.id}>
            <button
              type="button"
              onClick={() => {
                onChange(customer.id);
                setSearching(false);
                setQuery('');
              }}
            >
              <span>{customer.display_name}</span>
              {customer.phone_primary ? <small>{customer.phone_primary}</small> : null}
            </button>
          </li>
        ))}
      </ul>
      {results.length === 0 ? <p className="home-muted">{t('sales.customer_none')}</p> : null}
    </div>
  );
}
