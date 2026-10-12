/**
 * ECR-DIS-03 « Demande de réapprovisionnement » (UC-DIS-06, vendeur du PDV ; WF-05). Hors ligne : la
 * demande (`inventory.transfer.request`, agrégat `STOCK_TRANSFER`) part de la source du PDV vers son
 * emplacement de vente ; le serveur attribue le numéro et le statut `REQUESTED`. Suggestion par
 * produit doté d'un seuil (BR-STK-051, déjà diminuée des demandes en attente), à ajouter à la main :
 * jamais de demande automatique (BR-DIS-011). Les demandes en attente vers le PDV sont rappelées ; le
 * demandeur annule la sienne tant qu'elle n'est pas expédiée (`inventory.transfer.cancel`).
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatQuantity } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { submitCommand } from '../sales/submit.js';
import { LinesEditor } from '../stock/LinesEditor.js';
import { duplicateProducts } from '../stock/receive.js';
import { computeLines, MAX_TRANSFER_NOTES, type TransferLineDraft } from '../stock/transfer.js';
import {
  cancellable,
  candidateSources,
  DUPLICATE_REQUEST,
  pendingRequests,
  pointsOfSaleOf,
  REPLENISH_WITHOUT_SOURCE,
  replenishPayload,
  replenishSuggestions,
  requestedByProduct,
} from './replenish.js';

const emptyLine = (): TransferLineDraft => ({
  key: idGenerator.newId(),
  productId: '',
  unitCode: '',
  quantityText: '',
});

interface Submitted {
  readonly commandId: string;
  readonly kind: 'request' | 'cancel';
}

export function ReplenishScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [posChoice, setPosChoice] = useState<string | null>(null);
  const [sourceChoice, setSourceChoice] = useState('');
  const [lines, setLines] = useState<TransferLineDraft[]>(() => [emptyLine()]);
  const [notes, setNotes] = useState('');
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Submitted>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const ids = { pos: useId(), source: useId(), notes: useId(), blocked: useId() };

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.replenish')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  if (submitted) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.replenish')}</h1>
        <CommandResult
          commandId={submitted.commandId}
          messages={`replenish.${submitted.kind}_result`}
        >
          <button
            type="button"
            onClick={() => {
              setLines([emptyLine()]);
              setNotes('');
              setSubmitted(undefined);
            }}
          >
            {t('replenish.back')}
          </button>
        </CommandResult>
      </section>
    );
  }

  const points = pointsOfSaleOf(refs);
  const pos = points.find((candidate) => candidate.siteId === posChoice) ?? points[0];
  if (!pos) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.replenish')}</h1>
        <p className="home-muted">{t('replenish.no_pos')}</p>
      </section>
    );
  }

  const destination = pos.salesLocation;
  const sources = pos.source ? [pos.source] : candidateSources(refs.locations, destination.id);
  const source = pos.source ?? sources.find((candidate) => candidate.id === sourceChoice) ?? null;
  const sourceBlocked = !pos.source && REPLENISH_WITHOUT_SOURCE === 'BLOCK';
  const requests = pendingRequests(refs, destination.id);
  const requested = requestedByProduct(requests);
  const suggestions = replenishSuggestions(refs, destination.id, requested);
  const products = refs.products
    .filter((product) => product.stock_family !== 'SERVICE' && product.status === 'ACTIVE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const productNames = new Map(refs.products.map((product) => [product.id, product]));
  const locationNames = new Map(refs.locations.map((location) => [location.id, location.name]));
  const rows = computeLines(lines, products, refs);
  const filled = rows.filter((row) => row.check.draft.productId !== '');
  const duplicates = duplicateProducts(filled.map((row) => row.check.draft.productId));
  // Produit déjà demandé vers le PDV : refusé seulement si le paramètre le veut (AV-307).
  const alreadyRequested = (productId: string) =>
    DUPLICATE_REQUEST === 'BLOCK' && (requested.get(productId) ?? 0) > 0;
  const ready =
    source !== null &&
    !sourceBlocked &&
    filled.length > 0 &&
    filled.every((row) => row.check.issue === null) &&
    duplicates.size === 0 &&
    !filled.some((row) => alreadyRequested(row.check.draft.productId)) &&
    !busy;

  const send = async (kind: Submitted['kind'], input: Parameters<typeof submitCommand>[0]) => {
    if (busy) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand(input);
      setSubmitted({ commandId: command.command_id, kind });
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  const addSuggestion = (productId: string, quantity: number) =>
    setLines((current) => {
      const unit = productNames.get(productId)?.base_unit_code ?? '';
      const line = {
        key: idGenerator.newId(),
        productId,
        unitCode: unit,
        quantityText: String(quantity),
      };
      const kept = current.filter(
        (candidate) => candidate.productId !== '' && candidate.productId !== productId,
      );
      return [...kept, line];
    });

  const submit = () => {
    if (!ready || !source) return;
    void send('request', {
      authorUserId: userId,
      commandType: 'inventory.transfer.request',
      aggregateType: 'STOCK_TRANSFER',
      aggregateId: idGenerator.newId(),
      payload: replenishPayload({
        fromLocationId: source.id,
        toLocationId: destination.id,
        lines: filled.map((row) => row.check),
        notes,
      }),
    });
  };

  return (
    <section className="sale">
      <h1>{t('nav.screens.replenish')}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('replenish.offline_banner')}
        </p>
      ) : null}
      {points.length > 1 ? (
        <div className="field">
          <label htmlFor={ids.pos}>{t('replenish.pos_label')}</label>
          <select
            id={ids.pos}
            className="text-input"
            value={pos.siteId}
            onChange={(event) => {
              setPosChoice(event.target.value);
              setSourceChoice('');
              setLines([emptyLine()]);
            }}
          >
            {points.map((candidate) => (
              <option key={candidate.siteId} value={candidate.siteId}>
                {candidate.salesLocation.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <p>{t('replenish.destination', { name: destination.name })}</p>
      {pos.source ? (
        <p>{t('replenish.source', { name: pos.source.name })}</p>
      ) : sourceBlocked ? (
        <p id={ids.blocked} className="error-message" role="status">
          {t('replenish.no_source_blocked')}
        </p>
      ) : (
        <div className="field">
          <label htmlFor={ids.source}>{t('replenish.source_label')}</label>
          <select
            id={ids.source}
            className="text-input"
            value={source?.id ?? ''}
            onChange={(event) => setSourceChoice(event.target.value)}
          >
            <option value="">{t('replenish.source_placeholder')}</option>
            {sources.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
          <p className="home-muted">{t('replenish.no_source_hint')}</p>
        </div>
      )}

      <section className="sale-block" aria-labelledby="replenish-suggest-title">
        <h2 id="replenish-suggest-title">{t('replenish.suggest_title')}</h2>
        {suggestions.length === 0 ? (
          <p className="home-muted">{t('replenish.suggest_empty')}</p>
        ) : (
          <ul className="line-list">
            {suggestions.map((suggestion) => {
              const unit = suggestion.product.base_unit_code;
              return (
                <li key={suggestion.product.id} className="line-card">
                  <p>
                    <strong>{suggestion.product.name}</strong>
                    {suggestion.state !== 'OK' ? (
                      <span className="badge badge-warn">
                        {' '}
                        {t(`replenish.state.${suggestion.state}`)}
                      </span>
                    ) : null}
                  </p>
                  <p className="home-muted">
                    {t('replenish.suggest_line', {
                      available: formatQuantity(suggestion.available),
                      transit: formatQuantity(suggestion.inTransit),
                      suggested: formatQuantity(suggestion.suggestedQty),
                      unit,
                    })}
                  </p>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => addSuggestion(suggestion.product.id, suggestion.suggestedQty)}
                  >
                    {t('replenish.add_suggestion', { name: suggestion.product.name })}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="sale-block" aria-labelledby="replenish-new-title">
        <h2 id="replenish-new-title">{t('replenish.new_title')}</h2>
        <LinesEditor
          rows={rows}
          products={products}
          onUpdate={(key, patch) =>
            setLines((current) =>
              current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
            )
          }
          onRemove={(key) =>
            setLines((current) =>
              current.length > 1 ? current.filter((line) => line.key !== key) : [emptyLine()],
            )
          }
          onAdd={() => setLines((current) => [...current, emptyLine()])}
          hint={(product) => {
            const already = requested.get(product.id);
            return already
              ? t('replenish.already_requested', {
                  quantity: formatQuantity(already),
                  unit: product.base_unit_code,
                })
              : null;
          }}
          lineIssue={(row) =>
            duplicates.has(row.check.draft.productId)
              ? t('replenish.duplicate')
              : alreadyRequested(row.check.draft.productId)
                ? t('replenish.already_requested_blocked')
                : null
          }
        />
        <div className="field">
          <label htmlFor={ids.notes}>{t('replenish.notes_label')}</label>
          <textarea
            id={ids.notes}
            className="text-input"
            rows={2}
            maxLength={MAX_TRANSFER_NOTES}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>
        {saveError ? (
          <p className="alert alert-error" role="alert">
            {t('sales.error_local_save')}
          </p>
        ) : null}
        <button
          type="button"
          className="btn-block submit-sale"
          disabled={!ready}
          aria-describedby={sourceBlocked ? ids.blocked : undefined}
          onClick={submit}
        >
          {busy ? t('sales.submitting') : t('replenish.submit')}
        </button>
      </section>

      <section className="sale-block" aria-labelledby="replenish-pending-title">
        <h2 id="replenish-pending-title">{t('replenish.pending_title')}</h2>
        {requests.length === 0 ? (
          <p className="home-muted">{t('replenish.pending_empty')}</p>
        ) : (
          <ul className="line-list">
            {requests.map((request) => {
              const label = request.docNumber ?? t('replenish.pending_number');
              return (
                <li key={request.id} className="line-card" aria-label={label}>
                  <p>
                    <strong>{label}</strong>
                    {' · '}
                    {t('replenish.from', {
                      name: locationNames.get(request.fromLocationId) ?? '',
                    })}
                  </p>
                  <ul>
                    {request.lines.map((line) => {
                      const product = productNames.get(line.productId);
                      return (
                        <li key={line.productId}>
                          {t('replenish.request_line', {
                            name: product?.name ?? '',
                            quantity: formatQuantity(line.quantityBase),
                            unit: product?.base_unit_code ?? '',
                          })}
                        </li>
                      );
                    })}
                  </ul>
                  {request.onDevice ? (
                    <p className="home-muted">{t('replenish.on_device')}</p>
                  ) : null}
                  {request.cancelling ? (
                    <p className="home-muted">{t('replenish.cancelling')}</p>
                  ) : null}
                  {cancellable(request, userId) ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        if (confirmCancel !== request.id) {
                          setConfirmCancel(request.id);
                          return;
                        }
                        setConfirmCancel(null);
                        void send('cancel', {
                          authorUserId: userId,
                          commandType: 'inventory.transfer.cancel',
                          aggregateType: 'STOCK_TRANSFER',
                          aggregateId: request.id,
                          payload: { transferId: request.id },
                        });
                      }}
                    >
                      {confirmCancel === request.id
                        ? t('replenish.cancel_confirm', { doc: label })
                        : t('replenish.cancel', { doc: label })}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
