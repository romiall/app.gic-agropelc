/**
 * ECR-APP-02 « Demande d'achat » (tous les demandeurs ; création hors ligne). Site bénéficiaire, date
 * souhaitée, justification, lignes de produits achetables (unité d'achat, quantité, prix estimé,
 * note). Commande `procurement.request.submit` (agrégat `PURCHASE_REQUEST`) ; le numéro `DA-…` revient
 * avec la réponse. Mes demandes listées avec leur statut (validation et commande en ligne, hors écran) :
 * cartes sur téléphone, colonnes sur ordinateur.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActionBar,
  Badge,
  Banner,
  Button,
  DataCell,
  DataList,
  DataRow,
  Field,
  Input,
  PageHeader,
  Section,
  Select,
  SkeletonRows,
  Textarea,
} from '../../components/ui/index.js';
import { PieceAction } from '../pieces/PieceAction.js';
import { demandeDemandeAchat } from '../pieces/adaptateurs-achats.js';
import { businessDayOf } from '@gic/domain';
import { clock, idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatMoment } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { unitLabel } from '../sales/format.js';
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
import { requestStatusTone } from './tones.js';
import './procurement.css';

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

  if (!refs || !userId) {
    return (
      <section className="sale proc-screen" aria-busy="true">
        <PageHeader title={t('nav.screens.purchase_request')} />
        <SkeletonRows rows={4} />
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
    <section className="sale proc-screen">
      <PageHeader title={t('nav.screens.purchase_request')} />
      {!online ? (
        <Banner tone="warn" role="status">
          {t('purchase_request.offline_banner')}
        </Banner>
      ) : null}
      {last ? <CommandResult commandId={last} messages="purchase_request.result" /> : null}
      <Section title={t('purchase_request.new_title')}>
        <div className="proc-form">
          <div className="proc-pair">
            <Field label={t('purchase_request.site_label')}>
              {(control) => (
                <Select
                  {...control}
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
                </Select>
              )}
            </Field>
            <Field label={t('purchase_request.needed_by_label')}>
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  min={today}
                  value={neededBy}
                  onChange={(event) => setNeededBy(event.target.value)}
                />
              )}
            </Field>
          </div>
          <Field label={t('purchase_request.justification_label')}>
            {(control) => (
              <Textarea
                {...control}
                rows={2}
                maxLength={MAX_JUSTIFICATION}
                value={justification}
                onChange={(event) => setJustification(event.target.value)}
              />
            )}
          </Field>
          {products.length === 0 ? (
            <Banner tone="bad">{t('purchase_request.no_product')}</Banner>
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
                  <div className="proc-line">
                    <Field label={t('loss.product_label')}>
                      {(control) => (
                        <Select
                          {...control}
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
                        </Select>
                      )}
                    </Field>
                    <div className="line-fields">
                      <Field label={t('sales.quantity_label')}>
                        {(control) => (
                          <Input
                            {...control}
                            inputMode="decimal"
                            value={line.quantityText}
                            onChange={(event) =>
                              update(line.key, { quantityText: event.target.value })
                            }
                          />
                        )}
                      </Field>
                      {row.units.length > 1 ? (
                        <Field label={t('sales.unit_label')}>
                          {(control) => (
                            <Select
                              {...control}
                              value={row.unitCode}
                              onChange={(event) =>
                                update(line.key, { unitCode: event.target.value })
                              }
                            >
                              {row.units.map((unit) => (
                                <option key={unit.unitCode} value={unit.unitCode}>
                                  {unitLabel(unit.unitCode)}
                                </option>
                              ))}
                            </Select>
                          )}
                        </Field>
                      ) : null}
                      <Field
                        label={t('purchase_request.price_label', {
                          unit: unitLabel(row.product?.base_unit_code ?? '', 1, refs.units),
                        })}
                      >
                        {(control) => (
                          <Input
                            {...control}
                            inputMode="numeric"
                            value={line.priceText}
                            onChange={(event) =>
                              update(line.key, { priceText: event.target.value })
                            }
                          />
                        )}
                      </Field>
                    </div>
                    <Field label={t('purchase_request.notes_label')}>
                      {(control) => (
                        <Input
                          {...control}
                          maxLength={MAX_LINE_NOTES}
                          value={line.notes}
                          onChange={(event) => update(line.key, { notes: event.target.value })}
                        />
                      )}
                    </Field>
                    {line.quantityText && row.check.issue === 'QUANTITY_INVALID' ? (
                      <p className="field-error">{t('loss.issue.QUANTITY_INVALID')}</p>
                    ) : null}
                    {row.price === null ? (
                      <p className="field-error">{t('purchase_request.price_invalid')}</p>
                    ) : null}
                    {rows.length > 1 ? (
                      <div className="proc-line-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="trash"
                          onClick={() =>
                            setLines((current) =>
                              current.filter((candidate) => candidate.key !== line.key),
                            )
                          }
                        >
                          {t('transfer.remove_line', { index: index + 1 })}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          <Button
            variant="outline"
            block
            className="btn-dashed"
            icon="plus"
            onClick={() => setLines((current) => [...current, newLine()])}
          >
            {t('transfer.add_line')}
          </Button>
          {issues
            .filter((issue) => issue !== 'SITE_REQUIRED' || sites.length === 0)
            .filter(
              (issue) => issue !== 'JUSTIFICATION_REQUIRED' || lines.some((line) => line.productId),
            )
            .map((issue) => (
              <p key={issue} className="field-error">
                {t(`purchase_request.issue.${issue}`)}
              </p>
            ))}
          <p className="muted">{t('purchase_request.validation_hint')}</p>
          {saveError ? <Banner tone="bad">{t('sales.error_local_save')}</Banner> : null}
        </div>
        <ActionBar>
          <Button
            size="lg"
            className="submit-sale"
            disabled={!ready}
            loading={busy}
            onClick={() => void submit()}
          >
            {busy ? t('sales.submitting') : t('purchase_request.submit')}
          </Button>
        </ActionBar>
      </Section>

      <Section title={t('purchase_request.mine_title')}>
        {requests.length === 0 ? (
          <p className="muted">{t('purchase_request.none')}</p>
        ) : (
          <DataList
            aria-label={t('purchase_request.mine_title')}
            columns={[
              { label: t('purchase_request.col.number') },
              { label: t('purchase_request.col.justification') },
              { label: t('purchase_request.col.status') },
              { label: t('purchase_request.col.date') },
            ]}
            template="minmax(10rem, 1.5fr) minmax(0, 3fr) 11rem 9rem"
          >
            {requests.map((request) => (
              <DataRow key={request.id}>
                <DataCell primary>
                  <strong>{request.docNumber ?? t('count.pending_number')}</strong>
                </DataCell>
                <DataCell>
                  <span className="proc-text">{request.justification}</span>
                </DataCell>
                <DataCell>
                  <Badge tone={requestStatusTone(request.status)}>
                    {t(`purchase_request.status.${request.status}`, {
                      defaultValue: request.status,
                    })}
                  </Badge>
                </DataCell>
                <DataCell>
                  <span className="proc-text">{formatMoment(request.occurredAt, today)}</span>
                </DataCell>
                {/* Demande d'achat (lot PP) : une demande servie par le serveur. */}
                {refs.purchaseRequests.some((da) => da.id === request.id) ? (
                  <DataCell wide>
                    <PieceAction
                      cle={`DA:${request.id}`}
                      annulee={request.status === 'CANCELLED'}
                      demande={() => {
                        const da = refs.purchaseRequests.find((item) => item.id === request.id);
                        return da ? demandeDemandeAchat(da, refs) : null;
                      }}
                    />
                  </DataCell>
                ) : null}
              </DataRow>
            ))}
          </DataList>
        )}
      </Section>
    </section>
  );
}
