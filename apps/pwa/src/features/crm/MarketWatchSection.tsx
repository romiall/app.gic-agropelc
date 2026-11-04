/**
 * Veille marché de la visite (PP-D ; REQ-308, AV-315) : le fournisseur ou le concurrent rencontré et le prix qu'il
 * pratique, un relevé par ligne. Facultative : une visite sans relevé part comme avant. Une ligne laissée vide n'est
 * pas envoyée (`isBlankWatch`, `visitPayload`).
 */
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Field, Input, Section, Select } from '../../components/ui/index.js';
import { saleUnitsOf } from '../sales/sale-form.js';
import type { SalesReferences } from '../sales/references.js';
import {
  MARKET_WATCH_TYPES,
  MAX_MARKET_WATCH_LINES,
  MAX_WATCH_SOURCE_NAME,
  type MarketWatchDraft,
  type MarketWatchType,
} from './visit.js';

interface Props {
  readonly lines: readonly MarketWatchDraft[];
  readonly refs: Pick<SalesReferences, 'products' | 'productUnits' | 'units'>;
  readonly onChange: (lines: readonly MarketWatchDraft[]) => void;
}

export function MarketWatchSection({ lines, refs, onChange }: Props) {
  const { t } = useTranslation();
  const sequence = useRef(0);
  const products = [...refs.products].sort((a, b) => a.name.localeCompare(b.name, 'fr'));

  const patch = (key: string, change: Partial<MarketWatchDraft>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...change } : line)));

  const add = () => {
    sequence.current += 1;
    onChange([
      ...lines,
      {
        key: `watch-${sequence.current}`,
        watchType: 'COMPETITOR',
        sourceName: '',
        productId: '',
        unitCode: '',
        priceText: '',
      },
    ]);
  };

  return (
    <Section title={t('visit.watch_title')}>
      <p className="muted">{t('visit.watch_hint')}</p>
      {lines.map((line, index) => {
        const product = products.find((candidate) => candidate.id === line.productId);
        const units = product ? saleUnitsOf(product, refs) : [];
        return (
          <div
            key={line.key}
            className="crm-watch-line"
            role="group"
            aria-label={t('visit.watch_line', { n: index + 1 })}
          >
            <div className="crm-pair">
              <Field label={t('visit.watch_type_label')}>
                {(control) => (
                  <Select
                    {...control}
                    value={line.watchType}
                    onChange={(event) =>
                      patch(line.key, { watchType: event.target.value as MarketWatchType })
                    }
                  >
                    {MARKET_WATCH_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {t(`visit.watch_type.${type}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('visit.watch_name_label')}>
                {(control) => (
                  <Input
                    {...control}
                    maxLength={MAX_WATCH_SOURCE_NAME}
                    value={line.sourceName}
                    onChange={(event) => patch(line.key, { sourceName: event.target.value })}
                  />
                )}
              </Field>
            </div>
            <Field label={t('visit.watch_product_label')} optional>
              {(control) => (
                <Select
                  {...control}
                  value={line.productId}
                  onChange={(event) => {
                    const chosen = products.find(
                      (candidate) => candidate.id === event.target.value,
                    );
                    patch(line.key, {
                      productId: event.target.value,
                      // Unité de base du produit choisi, modifiable ; sans produit, pas d'unité.
                      unitCode: chosen ? chosen.base_unit_code : '',
                    });
                  }}
                >
                  <option value="">{t('visit.watch_product_none')}</option>
                  {products.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="crm-pair">
              <Field label={t('visit.watch_unit_label')} optional>
                {(control) => (
                  <Select
                    {...control}
                    value={line.unitCode}
                    disabled={!product}
                    onChange={(event) => patch(line.key, { unitCode: event.target.value })}
                  >
                    {units.map((unit) => (
                      <option key={unit.unitCode} value={unit.unitCode}>
                        {refs.units.get(unit.unitCode)?.name ?? unit.unitCode}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('visit.watch_price_label')} optional unit="F CFA">
                {(control) => (
                  <Input
                    {...control}
                    inputMode="numeric"
                    value={line.priceText}
                    onChange={(event) => patch(line.key, { priceText: event.target.value })}
                  />
                )}
              </Field>
            </div>
            <Button
              variant="ghost"
              size="sm"
              icon="trash"
              onClick={() => onChange(lines.filter((candidate) => candidate.key !== line.key))}
            >
              {t('visit.watch_remove', { n: index + 1 })}
            </Button>
          </div>
        );
      })}
      <Button
        variant="outline"
        icon="plus"
        disabled={lines.length >= MAX_MARKET_WATCH_LINES}
        onClick={add}
      >
        {t('visit.watch_add')}
      </Button>
    </Section>
  );
}
