/**
 * Édition d'une ligne de vente ou de commande : quantité dans l'unité choisie, poids pour un produit
 * vendu au poids, prix catalogue résolu sur l'appareil, et dérogation de prix avec son motif
 * (catégorie `PRICE_OVERRIDE`). Le montant de ligne vient de `saleLineAmounts` (`packages/domain`).
 */
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from './format.js';
import type { ComputedLine, DraftLine, SaleUnit } from './sale-form.js';
import type { ReasonCodeData } from './types.js';

interface SaleLineEditorProps {
  readonly line: ComputedLine;
  readonly units: readonly SaleUnit[];
  readonly overrideReasons: readonly ReasonCodeData[];
  readonly onChange: (draft: DraftLine) => void;
  readonly onRemove: () => void;
}

export function SaleLineEditor({
  line,
  units,
  overrideReasons,
  onChange,
  onRemove,
}: SaleLineEditorProps) {
  const { t } = useTranslation();
  const id = useId();
  const { draft, product } = line;
  const update = (patch: Partial<DraftLine>) => onChange({ ...draft, ...patch });
  const byWeight = product.pricing_mode === 'PER_WEIGHT';
  const showPrice = draft.priceText !== null || line.catalog === null;

  return (
    <li className="line-card" aria-label={product.name}>
      <div className="line-head">
        <strong>{product.name}</strong>
        <button type="button" className="link-button" onClick={onRemove}>
          {t('sales.remove_line')}
        </button>
      </div>
      <div className="line-fields">
        <div className="field">
          <label htmlFor={`${id}-qty`}>{t('sales.quantity_label')}</label>
          <input
            id={`${id}-qty`}
            className="text-input"
            inputMode="decimal"
            value={draft.quantityText}
            onChange={(event) => update({ quantityText: event.target.value })}
          />
        </div>
        {units.length > 1 ? (
          <div className="field">
            <label htmlFor={`${id}-unit`}>{t('sales.unit_label')}</label>
            <select
              id={`${id}-unit`}
              className="text-input"
              value={draft.unitCode}
              onChange={(event) => update({ unitCode: event.target.value })}
            >
              {units.map((unit) => (
                <option key={unit.unitCode} value={unit.unitCode}>
                  {unit.unitCode}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="line-unit">{draft.unitCode}</p>
        )}
        {byWeight ? (
          <div className="field">
            <label htmlFor={`${id}-weight`}>{t('sales.weight_label')}</label>
            <input
              id={`${id}-weight`}
              className="text-input"
              inputMode="decimal"
              value={draft.weightText}
              onChange={(event) => update({ weightText: event.target.value })}
            />
          </div>
        ) : null}
      </div>

      {line.catalog ? (
        <p className="line-price">
          {t('sales.unit_price', { amount: formatMoney(line.catalog.unitPriceXaf) })}
          <button
            type="button"
            className="link-button"
            onClick={() =>
              update(
                draft.priceText === null
                  ? { priceText: String(line.catalog?.unitPriceXaf ?? '') }
                  : { priceText: null, overrideReasonId: null },
              )
            }
          >
            {draft.priceText === null ? t('sales.change_price') : t('sales.use_catalog_price')}
          </button>
        </p>
      ) : (
        <p className="line-price text-warn">{t('sales.no_catalog_price')}</p>
      )}

      {showPrice ? (
        <div className="line-fields">
          <div className="field">
            <label htmlFor={`${id}-price`}>{t('sales.price_label')}</label>
            <input
              id={`${id}-price`}
              className="text-input"
              inputMode="numeric"
              value={draft.priceText ?? ''}
              onChange={(event) => update({ priceText: event.target.value })}
            />
          </div>
          {line.overridden ? (
            <div className="field field-wide">
              <label htmlFor={`${id}-reason`}>{t('sales.reason_label')}</label>
              <select
                id={`${id}-reason`}
                className="text-input"
                value={draft.overrideReasonId ?? ''}
                onChange={(event) => update({ overrideReasonId: event.target.value || null })}
              >
                <option value="">{t('sales.reason_placeholder')}</option>
                {overrideReasons.map((reason) => (
                  <option key={reason.id} value={reason.id}>
                    {reason.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      ) : null}

      {line.issue ? (
        <p className="error-message" role="alert">
          {t(`sales.issue.${line.issue}`)}
        </p>
      ) : (
        <p className="line-total">
          {t('sales.line_total', { amount: formatMoney(line.lineTotalXaf) })}
        </p>
      )}
    </li>
  );
}
