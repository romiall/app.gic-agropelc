/**
 * Choix d'un produit vendable (actif, `is_sellable`) parmi le catalogue téléchargé, avec le disponible
 * de l'emplacement choisi (solde moins les opérations de l'appareil en attente). Un produit sans stock
 * reste proposé : en ligne, c'est le serveur qui décide ; hors ligne, l'écran bloque la vente.
 */
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatQuantity } from './format.js';
import type { ProductData } from './types.js';

const MAX_RESULTS = 12;

interface ProductPickerProps {
  readonly products: readonly ProductData[];
  /** Disponible par produit sur l'emplacement ; absent : non affiché (préparation d'une commande). */
  readonly availableOf?: (productId: string) => number;
  readonly onPick: (product: ProductData) => void;
  readonly onClose: () => void;
}

export function ProductPicker({ products, availableOf, onPick, onClose }: ProductPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const inputId = useId();
  const results = useMemo(() => {
    const text = query.trim().toLowerCase();
    return products
      .filter(
        (product) =>
          !text ||
          product.name.toLowerCase().includes(text) ||
          product.code.toLowerCase().includes(text),
      )
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
      .slice(0, MAX_RESULTS);
  }, [products, query]);

  return (
    <div className="picker" role="group" aria-label={t('sales.add_product')}>
      <div className="picker-head">
        <label htmlFor={inputId} className="visually-hidden">
          {t('sales.product_search')}
        </label>
        <input
          id={inputId}
          type="search"
          className="text-input"
          placeholder={t('sales.product_search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoComplete="off"
          autoFocus
        />
        <button type="button" className="secondary" onClick={onClose}>
          {t('sales.close_picker')}
        </button>
      </div>
      <ul className="picker-list">
        {results.map((product) => {
          const available = availableOf?.(product.id);
          return (
            <li key={product.id}>
              <button type="button" onClick={() => onPick(product)}>
                <span>{product.name}</span>
                {available !== undefined ? (
                  <small className={available > 0 ? undefined : 'text-warn'}>
                    {t('sales.product_available', {
                      quantity: formatQuantity(available),
                      unit: product.base_unit_code,
                    })}
                  </small>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {results.length === 0 ? <p className="home-muted">{t('sales.product_none')}</p> : null}
    </div>
  );
}
