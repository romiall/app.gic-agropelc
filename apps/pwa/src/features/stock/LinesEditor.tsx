/**
 * Lignes de marchandise saisies dans l'unité choisie (expédition directe, réception sans document) :
 * produit, quantité, unité ; quantité convertie en unité de base par `checkTransferLine`.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/index.js';
import type { ProductData } from '../sales/types.js';
import type { LineRow, TransferLineDraft } from './transfer.js';
import { unitLabel } from '../sales/format.js';

interface LinesEditorProps {
  readonly rows: readonly LineRow[];
  readonly products: readonly ProductData[];
  readonly onUpdate: (key: string, patch: Partial<TransferLineDraft>) => void;
  readonly onRemove: (key: string) => void;
  readonly onAdd: () => void;
  /** Indication sous le produit choisi (ex. disponible de la source). */
  readonly hint?: (product: ProductData) => string | null;
  /** Message propre à une ligne (ex. produit en double). */
  readonly lineIssue?: (row: LineRow) => string | null;
  /** Champ supplémentaire d'une ligne (ex. choix du lot). */
  readonly extra?: (row: LineRow) => ReactNode;
  /** Message extérieur qui décrit la quantité de la ligne (ex. garde hors ligne). */
  readonly quantityDescribedBy?: (row: LineRow) => string | undefined;
  /** Quantité refusée par un contrôle extérieur (ex. garde hors ligne). */
  readonly quantityBlocked?: (row: LineRow) => boolean;
}

export function LinesEditor({
  rows,
  products,
  onUpdate,
  onRemove,
  onAdd,
  hint,
  lineIssue,
  extra,
  quantityDescribedBy,
  quantityBlocked,
}: LinesEditorProps) {
  const { t } = useTranslation();
  return (
    <>
      <ul className="line-list">
        {rows.map((row, index) => {
          const { check, units, product } = row;
          const line = check.draft;
          const note = product && hint ? hint(product) : null;
          const issue = lineIssue ? lineIssue(row) : null;
          const quantityInvalid = line.quantityText !== '' && check.issue === 'QUANTITY_INVALID';
          const outsideId = quantityDescribedBy ? quantityDescribedBy(row) : undefined;
          const describedBy =
            [quantityInvalid ? `${line.key}-quantity-issue` : null, outsideId ?? null]
              .filter(Boolean)
              .join(' ') || undefined;
          return (
            <li
              key={line.key}
              className="line-card"
              aria-label={t('transfer.line_label', { index: index + 1 })}
            >
              <div className="field">
                <label htmlFor={`${line.key}-product`}>{t('loss.product_label')}</label>
                <select
                  id={`${line.key}-product`}
                  className="text-input"
                  value={line.productId}
                  onChange={(event) =>
                    onUpdate(line.key, { productId: event.target.value, unitCode: '' })
                  }
                >
                  <option value="">{t('loss.product_placeholder')}</option>
                  {products.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
                {note ? <p className="home-muted">{note}</p> : null}
              </div>
              <div className="line-fields">
                <div className="field">
                  <label htmlFor={`${line.key}-quantity`}>{t('sales.quantity_label')}</label>
                  <input
                    id={`${line.key}-quantity`}
                    className="text-input"
                    inputMode="decimal"
                    aria-invalid={
                      quantityInvalid || (quantityBlocked ? quantityBlocked(row) : false)
                    }
                    aria-describedby={describedBy}
                    value={line.quantityText}
                    onChange={(event) => onUpdate(line.key, { quantityText: event.target.value })}
                  />
                </div>
                {units.length > 1 ? (
                  <div className="field">
                    <label htmlFor={`${line.key}-unit`}>{t('sales.unit_label')}</label>
                    <select
                      id={`${line.key}-unit`}
                      className="text-input"
                      value={line.unitCode}
                      onChange={(event) => onUpdate(line.key, { unitCode: event.target.value })}
                    >
                      {units.map((unit) => (
                        <option key={unit.unitCode} value={unit.unitCode}>
                          {unitLabel(unit.unitCode)}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </div>
              {extra ? extra(row) : null}
              {quantityInvalid ? (
                <p id={`${line.key}-quantity-issue`} className="error-message">
                  {t('loss.issue.QUANTITY_INVALID')}
                </p>
              ) : null}
              {issue ? (
                <p id={`${line.key}-issue`} className="error-message">
                  {issue}
                </p>
              ) : null}
              {rows.length > 1 ? (
                <Button variant="ghost" size="sm" icon="trash" onClick={() => onRemove(line.key)}>
                  {t('transfer.remove_line', { index: index + 1 })}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Button variant="outline" className="btn-dashed" block icon="plus" onClick={onAdd}>
        {t('transfer.add_line')}
      </Button>
    </>
  );
}
