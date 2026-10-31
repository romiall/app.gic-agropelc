/**
 * ECR-CRM-07 « Gestion des objectifs » (responsable commercial, direction ; en ligne). Objectifs lus
 * sur le serveur, définition d'un objectif avec le contrôle de chevauchement, annulation. Cibles selon
 * la portée de `crm.target.manage` (01-rbac.md) : la direction (ALL) fixe des objectifs par site,
 * équipe ou commercial ; le responsable commercial (TEAM) pour lui-même, les équipes qu'il dirige et
 * leurs membres en cours, le serveur refusant tout objectif par site (FORBIDDEN_SCOPE). L'équipe de
 * son affectation TEAM n'est pas reprise : l'appareil ne sait pas quel rôle porte la permission
 * (S-41). Commerciaux, équipes
 * et appartenances : jeux `user`, `team`, `team_membership` de l'appareil, pas encore publiés (S-28).
 * La liste relue reste affichée mais sans action tant qu'elle ne reflète pas la dernière opération ;
 * l'opération suivante attend la réponse définitive de la précédente.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import {
  ActionBar,
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Section,
  Select,
  SkeletonRows,
  Textarea,
} from '../../components/ui/index.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDate } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney, formatQuantity, formatQuantityUnit, unitLabel } from '../sales/format.js';
import { readPath, useOnlineRead, type ReadResult } from '../sales/online-read.js';
import { useSalesReferences, type SalesReferences } from '../sales/references.js';
import {
  isBlockingWait,
  lastWaitingCommand,
  phaseOf,
  submitCommand,
  waitingCommands,
  waitingIds,
} from '../sales/submit.js';
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
import './crm.css';

/** Objectifs de plusieurs lectures (chemins séparés par `|`), réunis sans doublon. */
async function readTargets(key: string): Promise<ReadResult<readonly TargetView[]>> {
  const results = await Promise.all(
    key.split('|').map((path) => readPath<{ targets?: TargetView[] }>(path)),
  );
  const failed = results.find((result) => !result.ok);
  if (failed && !failed.ok) return failed;
  return {
    ok: true,
    data: mergeTargets(results.map((result) => (result.ok ? (result.data.targets ?? []) : []))),
  };
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
  const product = target.productId
    ? refs.products.find((candidate) => candidate.id === target.productId)
    : undefined;
  const value =
    target.metric === 'CA'
      ? formatMoney(target.targetValue)
      : target.metric === 'QTE_PRODUIT'
        ? formatQuantityUnit(target.targetValue, product?.base_unit_code ?? '', refs.units)
        : formatQuantity(target.targetValue);
  // Périodes avec l'année : la liste mêle les objectifs actifs de plusieurs années.
  const period = t('performance.target_period', {
    from: formatBusinessDate(target.periodStart),
    to: formatBusinessDate(target.periodEnd),
  });
  return (
    <li
      className="crm-target"
      aria-label={`${label} · ${t(`performance.metric.${target.metric}`, { defaultValue: target.metric })} · ${period}`}
    >
      <div className="crm-target-head">
        <span className="crm-target-title">{label}</span>
        <Badge tone={target.status === 'ACTIVE' ? 'ok' : 'muted'}>
          {t(`targets.status.${target.status}`, { defaultValue: target.status })}
        </Badge>
      </div>
      <p>
        {t(`performance.metric.${target.metric}`, { defaultValue: target.metric })}
        {product ? ` · ${product.name}` : ''} : <strong>{value}</strong>
      </p>
      <span className="crm-target-period">{period}</span>
      {target.status === 'ACTIVE' ? (
        cancelling ? (
          <div className="crm-inline-form">
            <Field label={t('targets.cancel_comment_label')}>
              {(control) => (
                <Textarea
                  {...control}
                  rows={2}
                  maxLength={2000}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
              )}
            </Field>
            <div className="result-actions">
              <Button
                variant="danger"
                size="sm"
                disabled={blocked}
                onClick={() => {
                  onCancel(comment);
                  setCancelling(false);
                }}
              >
                {t('targets.cancel_confirm')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setCancelling(false)}>
                {t('price_rules.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="result-actions">
            <Button
              variant="outline"
              size="sm"
              disabled={blocked}
              onClick={() => setCancelling(true)}
            >
              {t('targets.cancel')}
            </Button>
          </div>
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
  const issuesPrefix = useId();
  const navigation = useRememberedNavigation(userId);
  // Portée ALL de `crm.target.manage` : aucun repli permissif tant que les rôles ne sont pas connus.
  const director = navigation?.roles.includes('DIRECTION') === true;
  const lastCommand = refs?.outbox.find((command) => command.command_id === last);
  const pendingOps = waitingCommands(refs?.outbox ?? [], 'crm.target.', userId);
  // Équipes dirigées : toutes pour la lecture et les membres (comme le serveur), actives seulement
  // pour les cibles proposées.
  const ledTeams = (refs?.teams ?? []).filter((team) => team.manager_user_id === userId);
  const managedTeams = ledTeams.filter((team) => team.is_active);
  // Membres en cours des équipes dirigées, et l'utilisateur lui-même (portée TEAM) : appartenances
  // comparées en instants (début inclus, fin exclue), comme le serveur.
  const nowMs = clock.now().getTime();
  const members = new Set([
    ...(userId ? [userId] : []),
    ...(refs?.teamMemberships ?? [])
      .filter(
        (membership) =>
          ledTeams.some((team) => team.id === membership.team_id) &&
          Date.parse(membership.valid_from) <= nowMs &&
          (membership.valid_to === null || Date.parse(membership.valid_to) > nowMs),
      )
      .map((membership) => membership.user_id),
  ]);
  // Sans portée ALL, `GET /targets` ne rend que les objectifs propres : les équipes dirigées et
  // leurs membres se lisent un à un (S-28).
  const read = useOnlineRead<readonly TargetView[]>(
    [
      '/api/v1/targets',
      ...ledTeams.map((team) => `/api/v1/targets?team_id=${team.id}`),
      ...(director
        ? []
        : [...members].filter((id) => id !== userId).map((id) => `/api/v1/targets?user_id=${id}`)),
    ].join('|'),
    readTargets,
    online,
    `${last ?? ''}:${lastCommand ? phaseOf(lastCommand) : ''}|${waitingIds(refs?.outbox ?? [], 'crm.target.', userId)}`,
  );
  const targets = read.data;

  if (!refs || !userId) {
    return (
      <section className="sale crm-screen" aria-busy="true">
        <PageHeader title={t('nav.screens.targets')} />
        <SkeletonRows rows={3} />
      </section>
    );
  }

  const waiting =
    (last !== undefined &&
      (lastCommand === undefined || isBlockingWait(lastCommand, refs.outbox))) ||
    pendingOps.length > 0;
  const blocked = busy || waiting || !online || read.stale;
  // Retour sur l'écran : la dernière opération encore en attente redevient « la dernière », pour que
  // son résultat (refus compris) reste affiché jusqu'à la réponse.
  const adopt = last ? undefined : lastWaitingCommand(refs.outbox, 'crm.target.', userId);
  if (adopt) setLast(adopt.command_id);
  const shownCommandId = last;
  // Cibles admises par la portée : tout pour la direction, les équipes dirigées et leurs membres
  // pour le responsable commercial.
  const users = refs.users.filter(
    (user) => user.status === 'ACTIVE' && (director || members.has(user.id)),
  );
  const teams = director ? refs.teams.filter((team) => team.is_active) : managedTeams;
  const sites = [...refs.sites.values()]
    .filter((site) => site.status === 'ACTIVE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const types: TargetType[] = [
    ...(users.length > 0 ? (['USER'] as const) : []),
    ...(teams.length > 0 ? (['TEAM'] as const) : []),
    ...(director ? (['SITE'] as const) : []),
  ];
  const targetType = types.includes(form.targetType) ? form.targetType : types[0];
  const targetOptions =
    targetType === 'USER'
      ? users.map((user) => ({ value: user.id, label: user.full_name }))
      : targetType === 'TEAM'
        ? teams.map((team) => ({ value: team.id, label: team.name }))
        : sites.map((site) => ({ value: site.id, label: site.name }));
  // Cible revalidée contre les options du moment (type forcé, appartenance close entre-temps).
  const targetId = targetOptions.some((option) => option.value === form.targetId)
    ? form.targetId
    : '';
  const effective: TargetForm = { ...form, targetType: targetType ?? form.targetType, targetId };
  const labelOf = (target: TargetView): string =>
    (target.userId && refs.users.find((user) => user.id === target.userId)?.full_name) ||
    (target.teamId && refs.teams.find((team) => team.id === target.teamId)?.name) ||
    (target.siteId && refs.sites.get(target.siteId)?.name) ||
    t(`targets.type.${target.targetType}`);
  const issues = checkTarget(effective, targets ?? []);
  const products = refs.products
    .filter((product) => product.is_sellable && product.status === 'ACTIVE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const product = products.find((candidate) => candidate.id === form.productId);
  // Anomalie affichée et champ qui la porte (annoncée et reliée, comme les règles tarifaires).
  const shown = issues.filter(
    (issue) =>
      (issue !== 'TARGET_REQUIRED' && issue !== 'VALUE_INVALID') ||
      (issue === 'VALUE_INVALID' && form.valueText !== ''),
  );
  const issueId = (issue: string) => `${issuesPrefix}-${issue}`;
  const describedBy = (...codes: string[]) => {
    const list = shown.filter((issue) => codes.includes(issue)).map(issueId);
    return list.length > 0 ? list.join(' ') : undefined;
  };
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

  const creatingForm = creating && targetType !== undefined;

  return (
    <section className="sale crm-screen">
      <PageHeader
        title={t('nav.screens.targets')}
        actions={
          !creatingForm && types.length > 0 ? (
            <Button disabled={blocked} onClick={() => setCreating(true)}>
              {t('targets.new')}
            </Button>
          ) : undefined
        }
      />
      {!online ? <Banner tone="bad">{t('targets.online_only')}</Banner> : null}
      {shownCommandId ? (
        <CommandResult commandId={shownCommandId} messages="targets.result" />
      ) : null}
      {saveError ? <Banner tone="bad">{t('sales.error_local_save')}</Banner> : null}
      {online && read.failed ? (
        <Banner
          tone="bad"
          action={
            read.denied ? undefined : (
              <Button variant="outline" size="sm" onClick={read.retry}>
                {t('ledger.retry')}
              </Button>
            )
          }
        >
          {read.denied ? t('targets.denied') : t('targets.unavailable')}
        </Banner>
      ) : null}
      {director && users.length === 0 && teams.length === 0 ? (
        <p className="muted">{t('targets.sites_only')}</p>
      ) : null}
      {types.length === 0 ? (
        <p className="muted">
          {navigation ? t('targets.no_target_for_role') : t('targets.roles_unknown')}
        </p>
      ) : null}

      {creating && targetType ? (
        <Section title={t('targets.new_title')}>
          <Card padded>
            <div className="crm-pair">
              <Field label={t('targets.type_label')}>
                {(control) => (
                  <Select
                    {...control}
                    value={targetType}
                    onChange={(event) =>
                      update({ targetType: event.target.value as TargetType, targetId: '' })
                    }
                  >
                    {types.map((type) => (
                      <option key={type} value={type}>
                        {t(`targets.type.${type}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t(`targets.target_label.${targetType}`)}>
                {(control) => (
                  <Select
                    {...control}
                    value={targetId}
                    onChange={(event) => update({ targetId: event.target.value })}
                  >
                    <option value="">{t('lot_setup.choose')}</option>
                    {targetOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <Field label={t('targets.metric_label')}>
              {(control) => (
                <Select
                  {...control}
                  value={form.metric}
                  onChange={(event) =>
                    update({
                      metric: event.target.value as TargetMetric,
                      productId: '',
                      valueText: '',
                    })
                  }
                >
                  {TARGET_METRICS.map((metric) => (
                    <option key={metric} value={metric}>
                      {t(`performance.metric.${metric}`, { defaultValue: metric })}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {form.metric === 'QTE_PRODUIT' ? (
              <Field label={t('targets.product_label')}>
                {(control) => (
                  <Select
                    {...control}
                    value={form.productId}
                    aria-invalid={describedBy('PRODUCT_REQUIRED') ? true : undefined}
                    aria-describedby={describedBy('PRODUCT_REQUIRED')}
                    onChange={(event) => update({ productId: event.target.value })}
                  >
                    <option value="">{t('lot_setup.choose')}</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
            <div className="crm-pair">
              <Field label={t('targets.start_label')}>
                {(control) => (
                  <Input
                    {...control}
                    type="date"
                    value={form.periodStart}
                    aria-invalid={describedBy('PERIOD_INVALID', 'OVERLAP') ? true : undefined}
                    aria-describedby={describedBy('PERIOD_INVALID', 'OVERLAP')}
                    onChange={(event) => update({ periodStart: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t('targets.end_label')}>
                {(control) => (
                  <Input
                    {...control}
                    type="date"
                    value={form.periodEnd}
                    aria-invalid={describedBy('PERIOD_INVALID', 'OVERLAP') ? true : undefined}
                    aria-describedby={describedBy('PERIOD_INVALID', 'OVERLAP')}
                    onChange={(event) => update({ periodEnd: event.target.value })}
                  />
                )}
              </Field>
            </div>
            <Field
              label={
                form.metric === 'QTE_PRODUIT' && product
                  ? t('targets.value_label_unit', { unit: unitLabel(product.base_unit_code) })
                  : t(`targets.value_label.${form.metric}`)
              }
            >
              {(control) => (
                <Input
                  {...control}
                  inputMode={form.metric === 'QTE_PRODUIT' ? 'decimal' : 'numeric'}
                  value={form.valueText}
                  aria-invalid={describedBy('VALUE_INVALID') ? true : undefined}
                  aria-describedby={describedBy('VALUE_INVALID')}
                  onChange={(event) => update({ valueText: event.target.value })}
                />
              )}
            </Field>
            <div role="status" aria-live="polite">
              {shown.map((issue) => (
                <p key={issue} id={issueId(issue)} className="field-error">
                  {t(`targets.issue.${issue}`)}
                </p>
              ))}
              {targets === undefined && !read.failed ? (
                <p className="muted">{t('targets.overlap_pending')}</p>
              ) : null}
            </div>
          </Card>
          <ActionBar>
            <Button variant="outline" onClick={() => setCreating(false)}>
              {t('price_rules.cancel')}
            </Button>
            <Button
              size="lg"
              className="submit-sale"
              disabled={issues.length > 0 || blocked || targets === undefined}
              onClick={() =>
                void send({
                  authorUserId: userId,
                  commandType: 'crm.target.set',
                  aggregateType: 'SALES_TARGET',
                  payload: targetPayload(effective),
                }).then((ok) => {
                  if (ok) {
                    setCreating(false);
                    update({ valueText: '' });
                  }
                })
              }
            >
              {t('targets.save')}
            </Button>
          </ActionBar>
        </Section>
      ) : null}

      {online && targets === undefined && !read.failed ? <SkeletonRows rows={3} /> : null}
      {online && targets && read.stale && !read.failed ? (
        <p className="muted" role="status">
          {t('targets.refreshing')}
        </p>
      ) : null}
      {targets ? (
        targets.length === 0 ? (
          <EmptyState icon="chart" title={t('targets.none')} />
        ) : (
          <ul className="crm-cards">
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
