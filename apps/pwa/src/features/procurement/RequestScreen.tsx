/**
 * ECR-APP-02 « Demande d'achat » (tous les demandeurs ; création hors ligne). Site bénéficiaire, date
 * souhaitée, justification, lignes de produits achetables (unité d'achat, quantité, prix estimé,
 * note). Commande `procurement.request.submit` (agrégat `PURCHASE_REQUEST`) ; le numéro `DA-…` revient
 * avec la réponse. Mes demandes listées avec leur statut (validation et commande en ligne, hors écran).
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { clock, idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatMoment } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { useSalesReferences } from '../sales/references.js';
import { submitCommand } from '../sales/submit.js';
import { scopeSiteIds } from '../stock/stock-view.js';
import { checkTransferLine } from '../stock/transfer.js';
import {
  checkRequest,
  MAX_JUSTIFICATION,
  MAX_LINE_NOTES,
  myRequests,
  parsePrice,
  purchasableProducts,
  purchaseUnitsOf,
  requestPayload,
} from './request.js';

interface LineDraft {
  readonly key: string;
  readonly productId: string;
  readonly unitCode: string;
  readonly quantityText: string;
  readonly priceText: string;
  readonly notes: string;
}

const newLine = (): LineDraft => ({
  key: idGenerator.newId(),
  productId: '',
  unitCode: '',
  quantityText: '',
  priceText: '',
  notes: '',
});

export function RequestScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [siteChoice, setSiteChoice] = useState<string | null>(null);
  const [neededBy, setNeededBy] = useState('');
  const [justification, setJustification] = useState('');
  const [lines, setLines] = useState<readonly LineDraft[]>(() => [newLine()]);
  const [last, setLast] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const ids = { site: useId(), date: useId(), justification: useId() };

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.purchase_request')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const today = businessDayOf(clock.now());
  // Sites du périmètre déduit de l'appareil (jeux bornés par le serveur ; le jeu `location` ne l'est
  // pas) d'abord, puis les autres sites actifs : un site affecté mais encore vide (ni stock, ni
  // document) n'apparaît dans aucun jeu, et le serveur tranche le droit. Présélection seulement quand
  // le périmètre déduit compte un seul site.
  const scopeSites = scopeSiteIds(refs, userId);
  const allSites = [...refs.sites.values()]
    .filter((site) => site.status === 'ACTIVE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const scoped = allSites.filter((site) => scopeSites.has(site.id));
  const others = allSites.filter((site) => !scopeSites.has(site.id));
  const sites = allSites;
  const siteId = siteChoice ?? (scoped.length === 1 ? (scoped[0]?.id ?? '') : '');
  const products = purchasableProducts(refs.products);
  const rows = lines.map((line) => {
    const product = products.find((candidate) => candidate.id === line.productId);
    const units = product ? purchaseUnitsOf(product, refs) : [];
    const unitCode = line.unitCode || product?.base_unit_code || '';
    return {
      line,
      product,
      units,
      unitCode,
      check: checkTransferLine(
        { key: line.key, productId: line.productId, unitCode, quantityText: line.quantityText },
        units.find((unit) => unit.unitCode === unitCode),
      ),
      price: parsePrice(line.priceText),
    };
  });
  const issues = checkRequest({
    siteId,
    justification,
    neededByDate: neededBy,
    lineCount: rows.length,
    today,
  });
  const settling =
    last !== undefined && !refs.outbox.some((command) => command.command_id === last);
  const ready =
    issues.length === 0 &&
    rows.every((row) => row.check.issue === null && row.price !== null) &&
    !busy &&
    !settling;
  const requests = myRequests(refs.purchaseRequests, refs.outbox, userId);

  const update = (key: string, patch: Partial<LineDraft>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'procurement.request.submit',
        aggregateType: 'PURCHASE_REQUEST',
        payload: requestPayload({
          siteId,
          neededByDate: neededBy,
          justification,
          lines: rows.map((row) => ({
            check: {
              ...row.check,
              quantity: row.check.quantity as number,
              quantityBase: row.check.quantityBase as number,
            },
            price: row.price ?? undefined,
            notes: row.line.notes,
          })),
        }),
      });
      setLast(command.command_id);
      setLines([newLine()]);
      setJustification('');
      setNeededBy('');
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale">
      <h1>{t('nav.screens.purchase_request')}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('purchase_request.offline_banner')}
        </p>
      ) : null}
      {last ? <CommandResult commandId={last} messages="purchase_request.result" /> : null}
      <section className="sale-block" aria-labelledby="purchase-request-new-title">
        <h2 id="purchase-request-new-title">{t('purchase_request.new_title')}</h2>
        <div className="line-fields">
          <div className="field">
            <label htmlFor={ids.site}>{t('purchase_request.site_label')}</label>
            <select
              id={ids.site}
              className="text-input"
              value={siteId}
              onChange={(event) => setSiteChoice(event.target.value)}
            >
              {siteId === '' ? (
                <option value="">{t('purchase_request.site_placeholder')}</option>
              ) : null}
              {scoped.length > 0 && others.length > 0 ? (
                <>
                  <optgroup label={t('purchase_request.scope_sites')}>
                    {scoped.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={t('purchase_request.other_sites')}>
                    {others.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.name}
                      </option>
                    ))}
                  </optgroup>
                </>
              ) : (
                sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))
              )}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.date}>{t('purchase_request.needed_by_label')}</label>
            <input
              id={ids.date}
              type="date"
              className="text-input"
              min={today}
              value={neededBy}
              onChange={(event) => setNeededBy(event.target.value)}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor={ids.justification}>{t('purchase_request.justification_label')}</label>
          <textarea
            id={ids.justification}
            className="text-input"
            rows={2}
            maxLength={MAX_JUSTIFICATION}
            value={justification}
            onChange={(event) => setJustification(event.target.value)}
          />
        </div>
        {products.length === 0 ? (
          <p className="alert alert-error">{t('purchase_request.no_product')}</p>
        ) : null}
        <ul className="line-list">
          {rows.map((row, index) => {
            const { line } = row;
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
                      update(line.key, { productId: event.target.value, unitCode: '' })
                    }
                  >
                    <option value="">{t('loss.product_placeholder')}</option>
                    {products.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="line-fields">
                  <div className="field">
                    <label htmlFor={`${line.key}-quantity`}>{t('sales.quantity_label')}</label>
                    <input
                      id={`${line.key}-quantity`}
                      className="text-input"
                      inputMode="decimal"
                      value={line.quantityText}
                      onChange={(event) => update(line.key, { quantityText: event.target.value })}
                    />
                  </div>
                  {row.units.length > 1 ? (
                    <div className="field">
                      <label htmlFor={`${line.key}-unit`}>{t('sales.unit_label')}</label>
                      <select
                        id={`${line.key}-unit`}
                        className="text-input"
                        value={row.unitCode}
                        onChange={(event) => update(line.key, { unitCode: event.target.value })}
                      >
                        {row.units.map((unit) => (
                          <option key={unit.unitCode} value={unit.unitCode}>
                            {unit.unitCode}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  <div className="field">
                    <label htmlFor={`${line.key}-price`}>
                      {t('purchase_request.price_label', {
                        unit: row.product?.base_unit_code ?? '',
                      })}
                    </label>
                    <input
                      id={`${line.key}-price`}
                      className="text-input"
                      inputMode="numeric"
                      value={line.priceText}
                      onChange={(event) => update(line.key, { priceText: event.target.value })}
                    />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor={`${line.key}-notes`}>{t('purchase_request.notes_label')}</label>
                  <input
                    id={`${line.key}-notes`}
                    className="text-input"
                    maxLength={MAX_LINE_NOTES}
                    value={line.notes}
                    onChange={(event) => update(line.key, { notes: event.target.value })}
                  />
                </div>
                {line.quantityText && row.check.issue === 'QUANTITY_INVALID' ? (
                  <p className="error-message">{t('loss.issue.QUANTITY_INVALID')}</p>
                ) : null}
                {row.price === null ? (
                  <p className="error-message">{t('purchase_request.price_invalid')}</p>
                ) : null}
                {rows.length > 1 ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      setLines((current) =>
                        current.filter((candidate) => candidate.key !== line.key),
                      )
                    }
                  >
                    {t('transfer.remove_line', { index: index + 1 })}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className="secondary"
          onClick={() => setLines((current) => [...current, newLine()])}
        >
          {t('transfer.add_line')}
        </button>
        {issues
          .filter((issue) => issue !== 'SITE_REQUIRED' || sites.length === 0)
          .filter(
            (issue) => issue !== 'JUSTIFICATION_REQUIRED' || lines.some((line) => line.productId),
          )
          .map((issue) => (
            <p key={issue} className="error-message">
              {t(`purchase_request.issue.${issue}`)}
            </p>
          ))}
        <p className="home-muted">{t('purchase_request.validation_hint')}</p>
        {saveError ? (
          <p className="alert alert-error" role="alert">
            {t('sales.error_local_save')}
          </p>
        ) : null}
        <button
          type="button"
          className="btn-block submit-sale"
          disabled={!ready}
          onClick={() => void submit()}
        >
          {busy ? t('sales.submitting') : t('purchase_request.submit')}
        </button>
      </section>

      <section className="sale-block" aria-labelledby="purchase-request-mine-title">
        <h2 id="purchase-request-mine-title">{t('purchase_request.mine_title')}</h2>
        {requests.length === 0 ? (
          <p className="home-muted">{t('purchase_request.none')}</p>
        ) : (
          <ul className="receipt-lines">
            {requests.map((request) => (
              <li key={request.id}>
                <span>
                  <strong>{request.docNumber ?? t('count.pending_number')}</strong>
                  <small>{request.justification}</small>
                </span>
                <span>
                  {t(`purchase_request.status.${request.status}`, { defaultValue: request.status })}
                  <small>{formatMoment(request.occurredAt, today)}</small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
