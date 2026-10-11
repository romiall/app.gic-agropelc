/**
 * ECR-CRM-07 « Gestion des objectifs » (responsable commercial, direction ; en ligne). Objectifs lus
 * sur le serveur, définition d'un objectif (commercial, équipe ou site ; métrique, période, valeur)
 * avec le contrôle de chevauchement, annulation. Commerciaux et équipes : jeux `user` et `team` de
 * l'appareil (S-28). L'opération suivante attend la réponse définitive de la précédente.
 */
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDay } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney, formatQuantity } from '../sales/format.js';
import { useSalesReferences, type SalesReferences } from '../sales/references.js';
import { phaseOf, submitCommand, waitingCommands } from '../sales/submit.js';
import {
  checkTarget,
  currentMonth,
  mergeTargets,
  TARGET_METRICS,
  targetPayload,
  type TargetForm,
  type TargetMetric,
  type TargetType,
  type TargetView,
} from './targets.js';

/** Objectifs lus en ligne (plusieurs chemins réunis) ; `undefined` pendant la lecture, `null` si indisponibles. */
function useTargets(
  paths: readonly string[],
  online: boolean,
  reloadKey: string,
): readonly TargetView[] | null | undefined {
  const key = paths.join('|');
  const [state, setState] = useState<{ key: string; targets: readonly TargetView[] | null }>();
  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    void Promise.all(
      key
        .split('|')
        .map((path) =>
          authorizedRequest<{ targets?: TargetView[] }>(getDb(), path, { method: 'GET' }),
        ),
    ).then((results) => {
      if (cancelled) return;
      setState({
        key,
        targets: results.every((result) => result.ok)
          ? mergeTargets(results.map((result) => (result.ok ? (result.data.targets ?? []) : [])))
          : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [key, online, reloadKey]);
  if (!online) return null;
  return state?.key === key ? state.targets : state?.targets;
}

function TargetCard({
  target,
  refs,
  label,
  blocked,
  onCancel,
}: {
  readonly target: TargetView;
  readonly refs: SalesReferences;
  readonly label: string;
  readonly blocked: boolean;
  readonly onCancel: (comment: string) => void;
}) {
  const { t } = useTranslation();
  const [cancelling, setCancelling] = useState(false);
  const [comment, setComment] = useState('');
  const commentId = useId();
  const product = target.productId
    ? refs.products.find((candidate) => candidate.id === target.productId)
    : undefined;
  const value =
    target.metric === 'CA'
      ? formatMoney(target.targetValue)
      : target.metric === 'QTE_PRODUIT'
        ? `${formatQuantity(target.targetValue)} ${product?.base_unit_code ?? ''}`.trim()
        : formatQuantity(target.targetValue);
  return (
    <li
      className="line-card"
      aria-label={`${label} · ${t(`performance.metric.${target.metric}`, { defaultValue: target.metric })}`}
    >
      <div className="line-head">
        <strong>{label}</strong>
        <span className={`badge ${target.status === 'ACTIVE' ? 'badge-ok' : 'badge-muted'}`}>
          {t(`targets.status.${target.status}`, { defaultValue: target.status })}
        </span>
      </div>
      <p>
        {t(`performance.metric.${target.metric}`, { defaultValue: target.metric })}
        {product ? ` · ${product.name}` : ''} : <strong>{value}</strong>
      </p>
      <p className="home-muted">
        {t('performance.target_period', {
          from: formatBusinessDay(target.periodStart),
          to: formatBusinessDay(target.periodEnd),
        })}
      </p>
      {target.status === 'ACTIVE' ? (
        cancelling ? (
          <div className="field">
            <label htmlFor={commentId}>{t('targets.cancel_comment_label')}</label>
            <textarea
              id={commentId}
              className="text-input"
              rows={2}
              maxLength={2000}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
            <div className="result-actions">
              <button
                type="button"
                className="secondary"
                disabled={blocked}
                onClick={() => onCancel(comment)}
              >
                {t('targets.cancel_confirm')}
              </button>
              <button type="button" className="secondary" onClick={() => setCancelling(false)}>
                {t('price_rules.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="secondary"
            disabled={blocked}
            onClick={() => setCancelling(true)}
          >
            {t('targets.cancel')}
          </button>
        )
      ) : null}
    </li>
  );
}

export function TargetsScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const today = businessDayOf(clock.now());
  const month = currentMonth(today);
  const [form, setForm] = useState<TargetForm>({
    targetType: 'SITE',
    targetId: '',
    metric: 'CA',
    productId: '',
    periodStart: month.start,
    periodEnd: month.end,
    valueText: '',
  });
  const [creating, setCreating] = useState(false);
  const [last, setLast] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const ids = {
    type: useId(),
    target: useId(),
    metric: useId(),
    product: useId(),
    start: useId(),
    end: useId(),
    value: useId(),
  };
  const lastCommand = refs?.outbox.find((command) => command.command_id === last);
  const pendingOps = waitingCommands(refs?.outbox ?? [], 'crm.target.', userId);
  const managedTeams = (refs?.teams ?? []).filter((team) => team.manager_user_id === userId);
  const targets = useTargets(
    ['/api/v1/targets', ...managedTeams.map((team) => `/api/v1/targets?team_id=${team.id}`)],
    online,
    `${last ?? ''}:${lastCommand?.status ?? ''}|${pendingOps.map((c) => c.command_id).join(',')}`,
  );

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.targets')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const waiting =
    (last !== undefined && (lastCommand === undefined || phaseOf(lastCommand) === 'WAITING')) ||
    pendingOps.length > 0;
  const blocked = busy || waiting || !online;
  const shownCommandId = last ?? pendingOps[pendingOps.length - 1]?.command_id;
  const users = refs.users.filter((user) => user.status === 'ACTIVE');
  const teams = refs.teams.filter((team) => team.is_active);
  const sites = [...refs.sites.values()]
    .filter((site) => site.status === 'ACTIVE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const types: TargetType[] = [
    ...(users.length > 0 ? (['USER'] as const) : []),
    ...(teams.length > 0 ? (['TEAM'] as const) : []),
    'SITE',
  ];
  const targetOptions =
    form.targetType === 'USER'
      ? users.map((user) => ({ value: user.id, label: user.full_name }))
      : form.targetType === 'TEAM'
        ? teams.map((team) => ({ value: team.id, label: team.name }))
        : sites.map((site) => ({ value: site.id, label: site.name }));
  const labelOf = (target: TargetView): string =>
    (target.userId && refs.users.find((user) => user.id === target.userId)?.full_name) ||
    (target.teamId && refs.teams.find((team) => team.id === target.teamId)?.name) ||
    (target.siteId && refs.sites.get(target.siteId)?.name) ||
    t(`targets.type.${target.targetType}`);
  const issues = checkTarget(form, targets ?? []);
  const products = refs.products
    .filter((product) => product.is_sellable && product.status === 'ACTIVE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const update = (patch: Partial<TargetForm>) => setForm((current) => ({ ...current, ...patch }));

  const send = async (input: Parameters<typeof submitCommand>[0]) => {
    if (blocked) return false;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand(input);
      setLast(command.command_id);
      return true;
    } catch {
      setSaveError(true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale">
      <h1>{t('nav.screens.targets')}</h1>
      {!online ? (
        <p className="alert alert-error" role="alert">
          {t('targets.online_only')}
        </p>
      ) : null}
      {shownCommandId ? (
        <CommandResult commandId={shownCommandId} messages="targets.result" />
      ) : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t('sales.error_local_save')}
        </p>
      ) : null}
      {users.length === 0 && teams.length === 0 ? (
        <p className="home-muted">{t('targets.sites_only')}</p>
      ) : null}

      {creating ? (
        <section className="sale-block" aria-labelledby="target-new-title">
          <h2 id="target-new-title">{t('targets.new_title')}</h2>
          <div className="field">
            <label htmlFor={ids.type}>{t('targets.type_label')}</label>
            <select
              id={ids.type}
              className="text-input"
              value={form.targetType}
              onChange={(event) =>
                update({ targetType: event.target.value as TargetType, targetId: '' })
              }
            >
              {types.map((type) => (
                <option key={type} value={type}>
                  {t(`targets.type.${type}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.target}>{t(`targets.target_label.${form.targetType}`)}</label>
            <select
              id={ids.target}
              className="text-input"
              value={form.targetId}
              onChange={(event) => update({ targetId: event.target.value })}
            >
              <option value="">{t('lot_setup.choose')}</option>
              {targetOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.metric}>{t('targets.metric_label')}</label>
            <select
              id={ids.metric}
              className="text-input"
              value={form.metric}
              onChange={(event) =>
                update({ metric: event.target.value as TargetMetric, productId: '', valueText: '' })
              }
            >
              {TARGET_METRICS.map((metric) => (
                <option key={metric} value={metric}>
                  {t(`performance.metric.${metric}`, { defaultValue: metric })}
                </option>
              ))}
            </select>
          </div>
          {form.metric === 'QTE_PRODUIT' ? (
            <div className="field">
              <label htmlFor={ids.product}>{t('targets.product_label')}</label>
              <select
                id={ids.product}
                className="text-input"
                value={form.productId}
                onChange={(event) => update({ productId: event.target.value })}
              >
                <option value="">{t('lot_setup.choose')}</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="line-fields">
            <div className="field">
              <label htmlFor={ids.start}>{t('targets.start_label')}</label>
              <input
                id={ids.start}
                type="date"
                className="text-input"
                value={form.periodStart}
                onChange={(event) => update({ periodStart: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor={ids.end}>{t('targets.end_label')}</label>
              <input
                id={ids.end}
                type="date"
                className="text-input"
                value={form.periodEnd}
                onChange={(event) => update({ periodEnd: event.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor={ids.value}>{t(`targets.value_label.${form.metric}`)}</label>
            <input
              id={ids.value}
              className="text-input"
              inputMode={form.metric === 'QTE_PRODUIT' ? 'decimal' : 'numeric'}
              value={form.valueText}
              onChange={(event) => update({ valueText: event.target.value })}
            />
          </div>
          {issues
            .filter(
              (issue) =>
                (issue !== 'TARGET_REQUIRED' && issue !== 'VALUE_INVALID') ||
                (issue === 'VALUE_INVALID' && form.valueText),
            )
            .map((issue) => (
              <p key={issue} className="error-message">
                {t(`targets.issue.${issue}`)}
              </p>
            ))}
          <div className="result-actions">
            <button
              type="button"
              className="btn-block submit-sale"
              disabled={issues.length > 0 || blocked}
              onClick={() =>
                void send({
                  authorUserId: userId,
                  commandType: 'crm.target.set',
                  aggregateType: 'SALES_TARGET',
                  payload: targetPayload(form),
                }).then((ok) => {
                  if (ok) {
                    setCreating(false);
                    update({ valueText: '' });
                  }
                })
              }
            >
              {t('targets.save')}
            </button>
            <button type="button" className="secondary" onClick={() => setCreating(false)}>
              {t('price_rules.cancel')}
            </button>
          </div>
        </section>
      ) : (
        <button
          type="button"
          className="btn-block"
          disabled={blocked}
          onClick={() => setCreating(true)}
        >
          {t('targets.new')}
        </button>
      )}

      {online && targets === undefined ? <p className="home-muted">{t('sales.loading')}</p> : null}
      {online && targets === null ? (
        <p className="alert alert-error">{t('targets.unavailable')}</p>
      ) : null}
      {targets ? (
        targets.length === 0 ? (
          <p className="home-muted">{t('targets.none')}</p>
        ) : (
          <ul className="line-list">
            {targets.map((target) => (
              <TargetCard
                key={target.id}
                target={target}
                refs={refs}
                label={labelOf(target)}
                blocked={blocked}
                onCancel={(comment) =>
                  void send({
                    authorUserId: userId,
                    commandType: 'crm.target.cancel',
                    aggregateType: 'SALES_TARGET',
                    aggregateId: target.id,
                    payload: comment.trim() ? { comment: comment.trim() } : {},
                  })
                }
              />
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
