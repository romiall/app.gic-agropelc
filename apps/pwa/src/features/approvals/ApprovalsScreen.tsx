/**
 * ECR-ADM-08 « Validations » (MP-07 ; UC-ADM-15 ; SM-APPROVAL ; ADR-018). En ligne seulement (aucune
 * décision hors ligne, D01). File des demandes que le lecteur peut décider (`GET /approvals/inbox`), la
 * plus ancienne d'abord, éventuellement filtrée par type depuis l'accueil (`?types=`). Décisions
 * `approvals.request.approve` / `.reject` selon les règles partagées du type (`@gic/domain`) ; les écarts
 * de caisse et de remise se décident dans la trésorerie (acceptation seule). Relue après chaque
 * décision ; la suivante attend la réponse définitive de la précédente. Relue aussi par « Actualiser »
 * et au retour sur l'onglet (MP-11) : un justificatif reçu entre-temps rend l'approbation possible.
 *
 * Refonte (ADR-049, lot L9) : en-tête avec l'action d'actualisation, explication repliée, demandes en
 * cartes (type, demandeur, montant, ce qu'on décide), décision dans un formulaire sous la carte.
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { ROUTES } from '../../app/screens.js';
import {
  Banner,
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  LinkButton,
  PageHeader,
  Radio,
  SkeletonRows,
  Textarea,
} from '../../components/ui/index.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatDateTime, formatKpiValue } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { ServerPhoto } from '../attachments/PhotoViews.js';
import { readPages, useOnlineRead, useRefreshOnVisible, type Pages } from '../sales/online-read.js';
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
import { HelpDisclosure } from '../users/HelpDisclosure.js';
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
import '../users/admin.css';

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
  const [input, setInput] = useState<DecisionInput>(EMPTY_DECISION);
  const options = optionsFor(view, action);
  const fields = dataFieldsFor(view, action);
  const reason = blockReason(view, action, input);
  const legendKey = `approvals.option_legend.${view.operationType}_${action}`;
  return (
    <div className="adm-panel" role="group" aria-label={t(`approvals.action.${action}`)}>
      {options ? (
        <fieldset className="adm-choices">
          <legend>{t(legendKey, { defaultValue: t('approvals.option_legend.default') })}</legend>
          {options.required ? null : (
            <Radio
              name={`option-${view.id}`}
              checked={input.option === ''}
              onChange={() => setInput((current) => ({ ...current, option: '' }))}
              label={
                options.defaultValue
                  ? t(`approvals.option.${options.defaultValue}`)
                  : t('approvals.option_none')
              }
            />
          )}
          {options.values
            .filter((value) => value !== options.defaultValue)
            .map((value) => (
              <Radio
                key={value}
                name={`option-${view.id}`}
                checked={input.option === value}
                onChange={() => setInput((current) => ({ ...current, option: value }))}
                label={t(`approvals.option.${value}`, { defaultValue: value })}
              />
            ))}
        </fieldset>
      ) : null}
      {fields.map((field) => (
        <Field
          key={field.key}
          label={t(`approvals.data.${field.key}`, { defaultValue: field.key })}
        >
          {(control) => (
            <Input
              {...control}
              value={input.data[field.key] ?? ''}
              onChange={(event) =>
                setInput((current) => ({
                  ...current,
                  data: { ...current.data, [field.key]: event.target.value },
                }))
              }
            />
          )}
        </Field>
      ))}
      <Field
        label={
          commentRule(view, action) === 'OPTIONAL'
            ? t('approvals.comment_optional')
            : action === 'REJECT'
              ? t('approvals.comment_required')
              : t('approvals.reason_required')
        }
      >
        {(control) => (
          <Textarea
            {...control}
            maxLength={commentMax(view, action)}
            value={input.comment}
            onChange={(event) =>
              setInput((current) => ({ ...current, comment: event.target.value }))
            }
          />
        )}
      </Field>
      {view.selfRequest ? (
        <Checkbox
          checked={input.selfApproved}
          onChange={(event) =>
            setInput((current) => ({ ...current, selfApproved: event.target.checked }))
          }
          label={t(`approvals.self_confirm.${action}`)}
        />
      ) : null}
      {reason && reason !== 'COMMENT_REQUIRED' && reason !== 'SELF_CONFIRM' ? (
        <p className="adm-note is-warn">{t(`approvals.block.${reason}`)}</p>
      ) : null}
      <div className="adm-actions">
        <Button disabled={blocked || reason !== null} onClick={() => onConfirm(input)}>
          {t(`approvals.confirm.${action}`)}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('price_rules.cancel')}
        </Button>
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
  useRefreshOnVisible(read.retry);

  if (!userId) {
    return (
      <section className="sale adm-screen" aria-busy="true">
        <PageHeader title={t('nav.screens.approvals')} />
        <SkeletonRows />
      </section>
    );
  }
  if (!online) {
    return (
      <section className="sale adm-screen">
        <PageHeader title={t('nav.screens.approvals')} />
        <Banner tone="muted" role="status">
          {t('approvals.online_only')}
        </Banner>
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
    <section className="sale adm-screen">
      <PageHeader
        title={t('nav.screens.approvals')}
        actions={
          requests && !read.failed ? (
            <Button variant="tonal" icon="sync" onClick={read.retry} disabled={read.stale}>
              {t('approvals.refresh')}
            </Button>
          ) : undefined
        }
      />
      <HelpDisclosure title={t('approvals.help_title')}>
        <p>{t('approvals.intro')}</p>
      </HelpDisclosure>
      {types.length > 0 ? (
        <Banner
          tone="info"
          action={
            <LinkButton to={ROUTES.approvals} variant="tonal" size="sm">
              {t('approvals.show_all')}
            </LinkButton>
          }
        >
          {t('approvals.filtered', { types: types.map(typeLabel).join(', ') })}
        </Banner>
      ) : null}
      {last ? <CommandResult commandId={last} messages="approvals.result" /> : null}
      {saveError ? <Banner tone="bad">{t(saveError)}</Banner> : null}
      {requests === undefined && !read.failed ? <SkeletonRows /> : null}
      {read.failed ? (
        <Banner
          tone="bad"
          action={
            read.denied ? undefined : (
              <Button variant="tonal" size="sm" onClick={read.retry}>
                {t('ledger.retry')}
              </Button>
            )
          }
        >
          {read.denied ? t('approvals.denied') : t('approvals.unavailable')}
        </Banner>
      ) : null}
      {requests && read.stale && !read.failed ? (
        <p className="adm-note" role="status">
          {t('approvals.refreshing')}
        </p>
      ) : null}
      {read.data?.more ? <p className="adm-note">{t('approvals.truncated')}</p> : null}
      {requests && requests.length === 0 ? (
        <EmptyState
          icon="check-circle"
          title={types.length > 0 ? t('approvals.none_filtered') : t('approvals.none')}
        />
      ) : null}
      {requests && requests.length > 0 ? (
        <ul className="adm-cards">
          {requests.map((view) => {
            const spec = specOf(view);
            const actions = actionsFor(view);
            const site = siteName(view.siteId);
            const photos = (view.attachments ?? []).filter(
              (attachment) => attachment.uploadStatus === 'AVAILABLE',
            );
            return (
              <li
                key={view.id}
                className="line-card"
                aria-label={t('approvals.card_label', {
                  type: typeLabel(view.operationType),
                  summary: view.subjectSummary,
                })}
              >
                <div className="adm-card-head">
                  <span className="adm-card-title">
                    <strong>{typeLabel(view.operationType)}</strong>
                    <span className="adm-sub">
                      {[
                        t('approvals.requested', {
                          name: view.requestedByName ?? t('approvals.unknown_user'),
                          date: formatDateTime(view.requestedAt),
                        }),
                        site ? t('approvals.site', { name: site }) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  {view.amountXaf !== null ? (
                    <span className="adm-card-value">{formatKpiValue(view.amountXaf, 'XAF')}</span>
                  ) : null}
                </div>
                <p className="adm-summary">{view.subjectSummary}</p>
                {view.amountMasked ? (
                  <p className="adm-note">{t('approvals.amount_masked')}</p>
                ) : null}
                {view.attachmentsPending ? (
                  <p className="adm-note is-warn">{t('approvals.attachment_pending')}</p>
                ) : null}
                {/* Photos reçues du document décidé : vues avant de décider (AV-286). */}
                {photos.length > 0 ? (
                  <div className="adm-photos">
                    {photos.map((attachment) => (
                      <ServerPhoto
                        key={attachment.id}
                        attachmentId={attachment.id}
                        alt={t('photo.approval_alt', { summary: view.subjectSummary })}
                      />
                    ))}
                  </div>
                ) : null}
                {view.selfRequest ? (
                  <p className="adm-note">{t('approvals.self_request')}</p>
                ) : null}
                {spec.recordOnly ? <p className="adm-note">{t('approvals.record_only')}</p> : null}
                {spec.approveReasonRequired ? (
                  <p className="adm-note">
                    {spec.rejectable
                      ? t(`approvals.reason_note.${view.operationType}`, {
                          defaultValue: t('approvals.reason_note.default'),
                        })
                      : t('approvals.accept_only')}
                  </p>
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
                  <div className="adm-actions">
                    {actions.map((action) => (
                      <Button
                        key={action}
                        variant={action === 'APPROVE' ? 'tonal' : 'outline'}
                        aria-label={t(`approvals.action_label.${action}`, {
                          summary: view.subjectSummary,
                        })}
                        disabled={blocked || (action === 'APPROVE' && view.attachmentsPending)}
                        onClick={() => setOpen({ id: view.id, action })}
                      >
                        {t(`approvals.action.${action}`)}
                      </Button>
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
