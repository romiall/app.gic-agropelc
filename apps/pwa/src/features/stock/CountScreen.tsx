/**
 * ECR-STK-05 « INVENTAIRE » (magasinier, vendeur de PDV, responsable de ferme) : ouverture d'un
 * inventaire sur un emplacement, comptage par produit (et par lot si le suivi est obligatoire), écart
 * estimé et motif, puis fin de l'inventaire. Tout passe hors ligne (`inventory.count.*`) ; le serveur
 * calcule l'écart à `counted_at` et comptabilise, ou demande une validation, faite en ligne hors de cet
 * écran (BR-STK-043). L'activité n'est pas bloquée pendant le comptage (BR-STK-041).
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatMoment } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatQuantity } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { submitCommand } from '../sales/submit.js';
import {
  activeCount,
  COUNT_TYPES,
  countEntries,
  deviceCounts,
  estimatedVariance,
  MAX_COUNT_COMMENT,
  parseCounted,
  recordLinesPayload,
  REQUIRE_VARIANCE_REASON,
  type CountInput,
  type CountType,
} from './count.js';
import { stockLocations } from './stock-view.js';

type LastAction = 'OPEN' | 'RECORD' | 'SUBMIT' | 'CANCEL';

const signed = (value: number): string =>
  value > 0 ? `+${formatQuantity(value)}` : formatQuantity(value);

export function CountScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [locationChoice, setLocationChoice] = useState<string | null>(null);
  const [countType, setCountType] = useState<CountType>('FULL');
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [reasonIds, setReasonIds] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<readonly string[]>([]);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [last, setLast] = useState<{ commandId: string; action: LastAction }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const locationSelectId = useId();
  const typeSelectId = useId();
  const addSelectId = useId();

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.count')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const locations = stockLocations(refs);
  const location = locations.find((candidate) => candidate.id === locationChoice) ?? locations[0];
  if (!location) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.count')}</h1>
        <p className="home-muted">{t('stock.no_location')}</p>
      </section>
    );
  }

  const today = businessDayOf(clock.now());
  // Tablette partagée : seules les saisies de l'utilisateur (ADR-051 §13).
  const counts = deviceCounts(
    refs.counts,
    refs.outbox.filter((command) => command.author_user_id === userId),
    refs.countsPulledAt,
  );
  const count = activeCount(counts, location.id);
  const history = counts.filter(
    (candidate) => candidate.locationId === location.id && candidate !== count,
  );
  const reasons = refs.reasonCodes.filter((reason) => reason.category === 'INVENTORY_ADJUSTMENT');

  const resetEntries = () => {
    setTexts({});
    setReasonIds({});
    setComments({});
    setAdded([]);
    setConfirmCancel(false);
  };

  // Garde contre une seconde saisie tant que la commande envoyée n'est pas visible dans l'outbox.
  const settling =
    last !== undefined && !refs.outbox.some((command) => command.command_id === last.commandId);
  const blocked = busy || settling;
  const hasDraft =
    Object.keys(texts).length + Object.keys(reasonIds).length + Object.keys(comments).length > 0;

  /** Saisie d'un champ : revenue à la valeur enregistrée, elle n'est plus une modification. */
  const edit = (setter: typeof setTexts) => (key: string, value: string, recordedValue: string) =>
    setter((current) => {
      const next = { ...current };
      if (value === recordedValue) delete next[key];
      else next[key] = value;
      return next;
    });
  const editText = edit(setTexts);
  const editReason = edit(setReasonIds);
  const editComment = edit(setComments);
  const clearDrafts = () => {
    setTexts({});
    setReasonIds({});
    setComments({});
  };

  const send = async (action: LastAction, input: Parameters<typeof submitCommand>[0]) => {
    if (blocked) return false;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand(input);
      setLast({ commandId: command.command_id, action });
      return true;
    } catch {
      setSaveError(true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <>
      <h1>{t('nav.screens.count')}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('count.offline_banner')}
        </p>
      ) : null}
      {last ? (
        <CommandResult commandId={last.commandId} messages={`count.result_${last.action}`} />
      ) : null}
      <div className="field">
        <label htmlFor={locationSelectId}>{t('stock.location_label')}</label>
        <select
          id={locationSelectId}
          className="text-input"
          value={location.id}
          // Des comptages non enregistrés ne sont jamais perdus par un changement d'emplacement.
          disabled={hasDraft}
          onChange={(event) => {
            setLocationChoice(event.target.value);
            resetEntries();
          }}
        >
          {locations.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>
    </>
  );

  const historyBlock =
    history.length > 0 ? (
      <section className="sale-block" aria-labelledby="count-history-title">
        <h2 id="count-history-title">{t('count.history_title')}</h2>
        <ul className="receipt-lines">
          {history.map((candidate) => (
            <li key={candidate.id}>
              <span>
                <strong>{candidate.docNumber ?? t('count.pending_number')}</strong>
                <small>
                  {t(`count.type.${candidate.countType}`, { defaultValue: candidate.countType })} ·{' '}
                  {t('count.lines_count', { count: candidate.lines.size })}
                </small>
              </span>
              <span>
                {candidate.submitting
                  ? t('count.status.SUBMITTING')
                  : candidate.cancelling
                    ? t('count.status.CANCELLING')
                    : t(`count.status.${candidate.status}`, { defaultValue: candidate.status })}
                <small>{formatMoment(candidate.occurredAt, today)}</small>
              </span>
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  if (!count) {
    // Une fin ou un abandon encore en vol sur l'emplacement passe avant la nouvelle ouverture,
    // sinon le serveur la refuserait (`COUNT_ALREADY_OPEN`).
    const closing = history
      .map((candidate) => candidate.closingCommandId)
      .filter((id): id is string => id !== null);
    const open = () =>
      void send('OPEN', {
        authorUserId: userId,
        commandType: 'inventory.count.open',
        aggregateType: 'INVENTORY_COUNT',
        dependsOn: closing,
        payload: { locationId: location.id, countType },
      }).then((ok) => {
        if (ok) resetEntries();
      });
    return (
      <section className="sale">
        {header}
        <section className="sale-block" aria-labelledby="count-open-title">
          <h2 id="count-open-title">{t('count.open_title')}</h2>
          <div className="field">
            <label htmlFor={typeSelectId}>{t('count.type_label')}</label>
            <select
              id={typeSelectId}
              className="text-input"
              value={countType}
              onChange={(event) => setCountType(event.target.value as CountType)}
            >
              {COUNT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`count.type.${type}`)}
                </option>
              ))}
            </select>
          </div>
          <p className="home-muted">{t('count.open_hint')}</p>
          {saveError ? (
            <p className="alert alert-error" role="alert">
              {t('sales.error_local_save')}
            </p>
          ) : null}
          <button type="button" className="btn-block submit-sale" disabled={blocked} onClick={open}>
            {busy ? t('sales.submitting') : t('count.open')}
          </button>
        </section>
        {historyBlock}
      </section>
    );
  }

  const entries = countEntries(refs, location, count, added);
  const rows = entries.map((entry) => {
    const recorded = count.lines.get(entry.key);
    const recordedText = recorded ? formatQuantity(recorded.countedQtyBase).replace(/\s/g, '') : '';
    const recordedReason = recorded?.varianceReasonCodeId ?? '';
    const recordedComment = recorded?.comment ?? '';
    const text = texts[entry.key] ?? recordedText;
    const value = text === '' ? null : parseCounted(text);
    const reasonId = reasonIds[entry.key] ?? recordedReason;
    const comment = comments[entry.key] ?? recordedComment;
    const dirty = entry.key in texts || entry.key in reasonIds || entry.key in comments;
    // Écart estimé seulement pour une saisie en cours : celui d'une ligne enregistrée dépend de son
    // `counted_at`, que seul le serveur connaît.
    const estimable = dirty && value !== null && entry.expectedQtyBase !== null;
    const variance = estimable
      ? estimatedVariance(value as number, entry.expectedQtyBase as number)
      : null;
    const needsReason =
      REQUIRE_VARIANCE_REASON && variance !== null && variance !== 0 && reasons.length > 0;
    const invalid = dirty && text !== '' && value === null;
    const missingReason = needsReason && !reasonId;
    const reason = reasons.find((candidate) => candidate.id === reasonId);
    const needsComment = variance !== null && variance !== 0 && reason?.requires_comment === true;
    const missingComment = needsComment && !comment.trim();
    // Ligne enregistrée vidée : une quantité est attendue.
    const emptied = dirty && text === '' && recorded !== undefined;
    return {
      entry,
      recorded,
      recordedText,
      recordedReason,
      recordedComment,
      text,
      value,
      reasonId,
      comment,
      dirty,
      variance,
      invalid,
      missingReason,
      needsComment,
      missingComment,
      emptied,
    };
  });
  const toSave = rows.filter((row) => row.dirty && row.value !== null);
  const blocking = rows.some(
    (row) => row.dirty && (row.invalid || row.missingReason || row.missingComment || row.emptied),
  );
  const canSave = toSave.length > 0 && !blocking && !blocked;
  const unsaved = rows.some((row) => row.dirty);
  const canSubmit = count.lines.size > 0 && !unsaved && !blocked;
  const opening = count.openCommandId ? [count.openCommandId] : [];
  const addable = refs.products
    .filter((product) => !entries.some((entry) => entry.productId === product.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

  const save = () => {
    if (!canSave) return;
    const inputs: CountInput[] = toSave.map((row) => ({
      productId: row.entry.productId,
      lotId: row.entry.lotId,
      countedQtyBase: row.value as number,
      varianceReasonCodeId: row.reasonId,
      comment: row.comment,
    }));
    void send('RECORD', {
      authorUserId: userId,
      commandType: 'inventory.count.record_lines',
      aggregateType: 'INVENTORY_COUNT',
      aggregateId: count.id,
      dependsOn: opening,
      payload: recordLinesPayload(count.id, inputs, clock.now().toISOString()),
    }).then((ok) => {
      if (ok) {
        clearDrafts();
      }
    });
  };

  const submit = () => {
    if (!canSubmit) return;
    void send('SUBMIT', {
      authorUserId: userId,
      commandType: 'inventory.count.submit',
      aggregateType: 'INVENTORY_COUNT',
      aggregateId: count.id,
      // La fin attend l'ouverture et toutes les saisies de l'appareil (ADR-051 §11).
      dependsOn: [...opening, ...count.lineCommandIds],
      payload: { countId: count.id },
    }).then((ok) => {
      if (ok) resetEntries();
    });
  };

  const cancel = () => {
    if (!confirmCancel) {
      setConfirmCancel(true);
      return;
    }
    void send('CANCEL', {
      authorUserId: userId,
      commandType: 'inventory.count.cancel',
      aggregateType: 'INVENTORY_COUNT',
      aggregateId: count.id,
      dependsOn: opening,
      payload: { countId: count.id },
    }).then((ok) => {
      if (ok) resetEntries();
    });
  };

  return (
    <section className="sale">
      {header}
      <section className="sale-block" aria-labelledby="count-sheet-title">
        <h2 id="count-sheet-title">
          {t('count.sheet_title', {
            doc: count.docNumber ?? t('count.pending_number'),
            type: t(`count.type.${count.countType}`, { defaultValue: count.countType }),
          })}
        </h2>
        <p className="home-muted">{t('count.sheet_hint')}</p>
        {rows.length === 0 ? <p className="home-muted">{t('count.nothing_listed')}</p> : null}
        <ul className="line-list">
          {rows.map((row) => {
            const { entry } = row;
            const name = entry.lotCode
              ? `${entry.productName} · ${entry.lotCode}`
              : entry.productName;
            return (
              <li key={entry.key} className="line-card" aria-label={name}>
                <div className="line-head">
                  <strong>{name}</strong>
                  {row.recorded && !row.dirty ? (
                    <span className="badge badge-ok">
                      {row.recorded.pending ? t('count.recorded_pending') : t('count.recorded')}
                    </span>
                  ) : null}
                </div>
                <div className="field">
                  <label htmlFor={`count-${entry.key}`}>
                    {t('count.counted_label', { unit: entry.unit })}
                  </label>
                  <input
                    id={`count-${entry.key}`}
                    className="text-input"
                    inputMode="decimal"
                    value={row.text}
                    onChange={(event) => editText(entry.key, event.target.value, row.recordedText)}
                  />
                </div>
                {row.invalid ? (
                  <p className="error-message">{t('loss.issue.QUANTITY_INVALID')}</p>
                ) : row.emptied ? (
                  <p className="error-message">{t('count.quantity_required')}</p>
                ) : row.dirty && row.value !== null && entry.expectedQtyBase === null ? (
                  <p className="home-muted">{t('count.variance_unknown')}</p>
                ) : row.variance !== null ? (
                  <p className={row.variance === 0 ? 'home-muted' : 'text-warn'}>
                    {row.variance === 0
                      ? t('count.no_variance')
                      : t('count.variance', { quantity: signed(row.variance), unit: entry.unit })}
                  </p>
                ) : null}
                {row.variance !== null && row.variance !== 0 && reasons.length > 0 ? (
                  <div className="field">
                    <label htmlFor={`reason-${entry.key}`}>{t('count.reason_label')}</label>
                    <select
                      id={`reason-${entry.key}`}
                      className="text-input"
                      value={row.reasonId}
                      onChange={(event) =>
                        editReason(entry.key, event.target.value, row.recordedReason)
                      }
                    >
                      <option value="">{t('count.reason_placeholder')}</option>
                      {reasons.map((reason) => (
                        <option key={reason.id} value={reason.id}>
                          {reason.label}
                        </option>
                      ))}
                    </select>
                    {row.dirty && row.missingReason ? (
                      <p className="error-message">{t('count.reason_required')}</p>
                    ) : null}
                  </div>
                ) : null}
                {row.variance !== null && row.variance !== 0 ? (
                  <div className="field">
                    <label htmlFor={`comment-${entry.key}`}>
                      {row.needsComment
                        ? t('count.comment_required_label')
                        : t('count.comment_label')}
                    </label>
                    <input
                      id={`comment-${entry.key}`}
                      className="text-input"
                      maxLength={MAX_COUNT_COMMENT}
                      value={row.comment}
                      onChange={(event) =>
                        editComment(entry.key, event.target.value, row.recordedComment)
                      }
                    />
                    {row.missingComment ? (
                      <p className="error-message">{t('count.comment_required')}</p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {addable.length > 0 ? (
          <div className="field">
            <label htmlFor={addSelectId}>{t('count.add_label')}</label>
            <select
              id={addSelectId}
              className="text-input"
              value=""
              onChange={(event) => {
                const productId = event.target.value;
                if (productId) setAdded((current) => [...current, productId]);
              }}
            >
              <option value="">{t('count.add_placeholder')}</option>
              {addable.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {saveError ? (
          <p className="alert alert-error" role="alert">
            {t('sales.error_local_save')}
          </p>
        ) : null}
        <button type="button" className="btn-block" disabled={!canSave} onClick={save}>
          {busy ? t('sales.submitting') : t('count.save')}
        </button>
        {unsaved ? (
          <p className="home-muted">
            {t('count.unsaved')}{' '}
            <button type="button" className="link-button" onClick={clearDrafts}>
              {t('count.clear_drafts')}
            </button>
          </p>
        ) : null}
        <button
          type="button"
          className="btn-block submit-sale"
          disabled={!canSubmit}
          onClick={submit}
        >
          {t('count.submit')}
        </button>
        <button type="button" className="secondary" disabled={blocked} onClick={cancel}>
          {confirmCancel ? t('count.cancel_confirm') : t('count.cancel')}
        </button>
      </section>
      {historyBlock}
    </section>
  );
}
