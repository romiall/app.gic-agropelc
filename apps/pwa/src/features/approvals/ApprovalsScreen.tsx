/**
 * ECR-ADM-08 « Validations » (MP-07 ; UC-ADM-15 ; SM-APPROVAL ; ADR-018). En ligne seulement (aucune
 * décision hors ligne, D01). File des demandes que le lecteur peut décider (`GET /approvals/inbox`), la
 * plus ancienne d'abord, éventuellement filtrée par type depuis l'accueil (`?types=`). Décisions
 * `approvals.request.approve` / `.reject` selon les règles partagées du type (`@gic/domain`) ; les écarts
 * de caisse et de remise se décident dans la trésorerie (acceptation seule). Relue après chaque
 * décision ; la suivante attend la réponse définitive de la précédente.
 */
import { useId, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { ROUTES } from '../../app/screens.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatDateTime, formatKpiValue } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { readPages, useOnlineRead, type Pages } from '../sales/online-read.js';
import { useSalesReferences } from '../sales/references.js';
import {
  isBlockingWait,
  lastWaitingCommand,
  phaseOf,
  saveErrorKey,
  submitCommand,
  waitingCommands,
  waitingIds,
} from '../sales/submit.js';
import {
  actionsFor,
  blockReason,
  commandOf,
  commentMax,
  commentRule,
  dataFieldsFor,
  EMPTY_DECISION,
  inboxPath,
  optionsFor,
  specOf,
  typesFromQuery,
  type ApprovalAction,
  type ApprovalView,
  type DecisionInput,
} from './approvals.js';

const PREFIX = 'approvals.request.';
/** Pages lues au plus (200 demandes chacune). */
const MAX_PAGES = 5;

interface DecisionProps {
  readonly view: ApprovalView;
  readonly action: ApprovalAction;
  readonly blocked: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (input: DecisionInput) => void;
}

function DecisionForm({ view, action, blocked, onCancel, onConfirm }: DecisionProps) {
  const { t } = useTranslation();
  const ids = { comment: useId(), self: useId() };
  const [input, setInput] = useState<DecisionInput>(EMPTY_DECISION);
  const options = optionsFor(view, action);
  const fields = dataFieldsFor(view, action);
  const reason = blockReason(view, action, input);
  const legendKey = `approvals.option_legend.${view.operationType}_${action}`;
  return (
    <div className="sale-block" role="group" aria-label={t(`approvals.action.${action}`)}>
      {options ? (
        <fieldset className="choice-group">
          <legend>{t(legendKey, { defaultValue: t('approvals.option_legend.default') })}</legend>
          {options.required ? null : (
            <label className="choice">
              <input
                type="radio"
                name={`option-${view.id}`}
                checked={input.option === ''}
                onChange={() => setInput((current) => ({ ...current, option: '' }))}
              />
              {options.defaultValue
                ? t(`approvals.option.${options.defaultValue}`)
                : t('approvals.option_none')}
            </label>
          )}
          {options.values
            .filter((value) => value !== options.defaultValue)
            .map((value) => (
              <label key={value} className="choice">
                <input
                  type="radio"
                  name={`option-${view.id}`}
                  checked={input.option === value}
                  onChange={() => setInput((current) => ({ ...current, option: value }))}
                />
                {t(`approvals.option.${value}`, { defaultValue: value })}
              </label>
            ))}
        </fieldset>
      ) : null}
      {fields.map((field) => (
        <div key={field.key} className="field">
          <label htmlFor={`${ids.comment}-${field.key}`}>
            {t(`approvals.data.${field.key}`, { defaultValue: field.key })}
          </label>
          <input
            id={`${ids.comment}-${field.key}`}
            className="text-input"
            value={input.data[field.key] ?? ''}
            onChange={(event) =>
              setInput((current) => ({
                ...current,
                data: { ...current.data, [field.key]: event.target.value },
              }))
            }
          />
        </div>
      ))}
      <div className="field">
        <label htmlFor={ids.comment}>
          {commentRule(view, action) === 'OPTIONAL'
            ? t('approvals.comment_optional')
            : action === 'REJECT'
              ? t('approvals.comment_required')
              : t('approvals.reason_required')}
        </label>
        <textarea
          id={ids.comment}
          className="text-input"
          maxLength={commentMax(view, action)}
          value={input.comment}
          onChange={(event) => setInput((current) => ({ ...current, comment: event.target.value }))}
        />
      </div>
      {view.selfRequest ? (
        <label className="choice">
          <input
            id={ids.self}
            type="checkbox"
            checked={input.selfApproved}
            onChange={(event) =>
              setInput((current) => ({ ...current, selfApproved: event.target.checked }))
            }
          />
          {t('approvals.self_confirm')}
        </label>
      ) : null}
      {reason && reason !== 'COMMENT_REQUIRED' && reason !== 'SELF_CONFIRM' ? (
        <p className="text-warn">{t(`approvals.block.${reason}`)}</p>
      ) : null}
      <div className="result-actions">
        <button
          type="button"
          className="btn-block submit-sale"
          disabled={blocked || reason !== null}
          onClick={() => onConfirm(input)}
        >
          {t(`approvals.confirm.${action}`)}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t('price_rules.cancel')}
        </button>
      </div>
    </div>
  );
}

export function ApprovalsScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const online = useOnline();
  const refs = useSalesReferences();
  const [searchParams] = useSearchParams();
  const types = typesFromQuery(searchParams.get('types'));
  const [open, setOpen] = useState<{ id: string; action: ApprovalAction } | null>(null);
  const [last, setLast] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Décisions lues dans la base locale (les références de vente ne les gardent pas).
  const outbox = useLiveQuery(() => getDb().outbox.orderBy('device_seq').toArray(), []) ?? [];
  const lastCommand = outbox.find((command) => command.command_id === last);
  const pendingOps = waitingCommands(outbox, PREFIX, userId);
  const read = useOnlineRead<Pages<ApprovalView>>(
    online ? inboxPath(types) : null,
    (path) => readPages<ApprovalView>([path], 'requests', MAX_PAGES),
    online,
    `${last ?? ''}:${lastCommand ? phaseOf(lastCommand) : ''}|${waitingIds(outbox, PREFIX, userId)}`,
  );

  if (!userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.approvals')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }
  if (!online) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.approvals')}</h1>
        <p className="home-muted">{t('approvals.online_only')}</p>
      </section>
    );
  }

  const waiting =
    (last !== undefined && (lastCommand === undefined || isBlockingWait(lastCommand, outbox))) ||
    pendingOps.length > 0;
  const blocked = busy || waiting || read.stale;
  const adopt = last ? undefined : lastWaitingCommand(outbox, PREFIX, userId);
  if (adopt) setLast(adopt.command_id);
  const requests = read.data?.items;
  const siteName = (id: string | null) => (id ? (refs?.sites.get(id)?.name ?? null) : null);
  const typeLabel = (type: string) => t(`approvals.type.${type}`, { defaultValue: type });

  const send = async (view: ApprovalView, action: ApprovalAction, input: DecisionInput) => {
    if (blocked) return;
    setBusy(true);
    setSaveError(null);
    try {
      const { commandType, payload } = commandOf(view, action, input);
      const command = await submitCommand({
        authorUserId: userId,
        commandType,
        aggregateType: 'APPROVAL_REQUEST',
        aggregateId: view.id,
        payload,
      });
      setLast(command.command_id);
      setOpen(null);
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale">
      <h1>{t('nav.screens.approvals')}</h1>
      <p className="home-muted">{t('approvals.intro')}</p>
      {types.length > 0 ? (
        <p className="home-muted">
          {t('approvals.filtered', { types: types.map(typeLabel).join(', ') })} ·{' '}
          <Link to={ROUTES.approvals}>{t('approvals.show_all')}</Link>
        </p>
      ) : null}
      {last ? <CommandResult commandId={last} messages="approvals.result" /> : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t(saveError)}
        </p>
      ) : null}
      {requests === undefined && !read.failed ? (
        <p className="home-muted">{t('sales.loading')}</p>
      ) : null}
      {read.failed ? (
        <div className="alert alert-error" role="alert">
          <p>{read.denied ? t('approvals.denied') : t('approvals.unavailable')}</p>
          {read.denied ? null : (
            <button type="button" className="secondary" onClick={read.retry}>
              {t('ledger.retry')}
            </button>
          )}
        </div>
      ) : null}
      {requests && read.stale && !read.failed ? (
        <p className="home-muted" role="status">
          {t('approvals.refreshing')}
        </p>
      ) : null}
      {read.data?.more ? <p className="home-muted">{t('approvals.truncated')}</p> : null}
      {requests && requests.length === 0 ? (
        <p className="home-muted">
          {types.length > 0 ? t('approvals.none_filtered') : t('approvals.none')}
        </p>
      ) : null}
      {requests && requests.length > 0 ? (
        <ul className="line-list">
          {requests.map((view) => {
            const spec = specOf(view);
            const actions = actionsFor(view);
            const site = siteName(view.siteId);
            return (
              <li
                key={view.id}
                className="line-card"
                aria-label={t('approvals.card_label', {
                  type: typeLabel(view.operationType),
                  summary: view.subjectSummary,
                })}
              >
                <div className="line-head">
                  <strong>{typeLabel(view.operationType)}</strong>
                  {view.amountXaf !== null ? (
                    <span>{formatKpiValue(view.amountXaf, 'XAF')}</span>
                  ) : null}
                </div>
                <p>{view.subjectSummary}</p>
                <p className="home-muted">
                  {[
                    t('approvals.requested', {
                      name: view.requestedByName ?? t('approvals.unknown_user'),
                      date: formatDateTime(view.requestedAt),
                    }),
                    site ? t('approvals.site', { name: site }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {view.amountMasked ? (
                  <p className="home-muted">{t('approvals.amount_masked')}</p>
                ) : null}
                {view.attachmentsPending ? (
                  <p className="text-warn">{t('approvals.attachment_pending')}</p>
                ) : null}
                {view.selfRequest ? (
                  <p className="home-muted">{t('approvals.self_request')}</p>
                ) : null}
                {spec.recordOnly ? (
                  <p className="home-muted">{t('approvals.record_only')}</p>
                ) : null}
                {spec.approveReasonRequired ? (
                  <p className="home-muted">{t('approvals.accept_only')}</p>
                ) : null}
                {open?.id === view.id ? (
                  <DecisionForm
                    view={view}
                    action={open.action}
                    blocked={blocked}
                    onCancel={() => setOpen(null)}
                    onConfirm={(input) => void send(view, open.action, input)}
                  />
                ) : actions.length > 0 ? (
                  <div className="result-actions">
                    {actions.map((action) => (
                      <button
                        key={action}
                        type="button"
                        className="secondary"
                        aria-label={t(`approvals.action_label.${action}`, {
                          summary: view.subjectSummary,
                        })}
                        disabled={blocked || (action === 'APPROVE' && view.attachmentsPending)}
                        onClick={() => setOpen({ id: view.id, action })}
                      >
                        {t(`approvals.action.${action}`)}
                      </button>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
