/**
 * Onglet « Politiques » de l'écran ECR-ADM-07 (RP-1 ; UC-ADM-14 ; BR-ADM-016 ; AV-494) : les politiques de contrôle
 * en vigueur — photo exigée, commentaire exigé, validation d'un responsable (permission d'approbation et portée) —
 * et leur révision. Réviser crée une nouvelle version et retire l'ancienne ; la condition JSON (seuils, catégories)
 * reste en lecture seule et reprend telle quelle. Les politiques d'un type d'opération sont décidées par la
 * Direction et l'Admin (`approvals.policy.manage`).
 */
import { useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
  Select,
  SkeletonRows,
  Switch,
} from '../../components/ui/index.js';
import { idGenerator } from '../../platform/composition.js';
import { useAdminRead, type useOnlineCommands } from '../admin/admin-online.js';
import { formatDateTime } from '../home/format-home.js';
import {
  APPROVER_SCOPES,
  POLICIES_PATH,
  policyChanged,
  policyCommand,
  policyFormOf,
  policyHistoryPath,
  policyProblem,
  type ApproverPermissionView,
  type PolicyForm,
  type PolicyView,
} from './settings.js';

interface Props {
  readonly commands: ReturnType<typeof useOnlineCommands>;
}

interface PoliciesRead {
  readonly policies: readonly PolicyView[];
  readonly approver_permissions: readonly ApproverPermissionView[];
}

function PolicyHistory({ code, reloadKey }: { code: string; reloadKey: string }) {
  const { t } = useTranslation();
  const read = useAdminRead<PoliciesRead>(policyHistoryPath(code), reloadKey);
  return (
    <div className="adm-panel" role="group" aria-label={t('settings.history_title')}>
      {read.failed ? <Banner tone="bad">{t('settings.history_unavailable')}</Banner> : null}
      {read.data === undefined && !read.failed ? <SkeletonRows rows={2} /> : null}
      {read.data ? (
        <ol className="settings-history">
          {read.data.policies.map((policy) => (
            <li key={policy.id}>
              <strong>{t('settings.policy.version', { version: policy.version })}</strong>
              <span className="adm-sub">
                {[
                  formatDateTime(policy.validFrom),
                  policy.status === 'ACTIVE'
                    ? t('settings.policy.status_active')
                    : t('settings.policy.status_retired'),
                  policy.createdByName ?? t('org.unknown_user'),
                ].join(' · ')}
              </span>
              <span className="adm-sub">{summaryOf(policy, t)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function summaryOf(policy: PolicyView, t: TFunction) {
  return [
    policy.requiresPhoto ? t('settings.policy.photo') : null,
    policy.requiresComment ? t('settings.policy.comment') : null,
    policy.requiresApproval
      ? t('settings.policy.approval', {
          permission: policy.approverPermission ?? '—',
          scope: t(`settings.policy.scope.${policy.approverScope ?? 'ALL'}`, {
            defaultValue: policy.approverScope ?? '',
          }),
        })
      : t('settings.policy.no_approval'),
  ]
    .filter(Boolean)
    .join(' · ');
}

interface EditorProps extends Props {
  readonly policy: PolicyView;
  readonly permissions: readonly ApproverPermissionView[];
  readonly blocked: boolean;
  readonly onDone: () => void;
}

function PolicyEditor({ policy, permissions, blocked, commands, onDone }: EditorProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<PolicyForm>(() => policyFormOf(policy));
  const problem = policyProblem(form);
  const changed = policyChanged(policy, form);
  const dropsApproval = policy.requiresApproval && !form.requiresApproval;

  const save = async () => {
    if (problem !== null) return;
    const sent = await commands.send(policyCommand(policy, form, idGenerator.newId()), blocked);
    if (sent) onDone();
  };

  return (
    <div
      className="adm-form adm-panel"
      role="group"
      aria-label={t('settings.policy.edit_title', { code: policy.code })}
    >
      <Switch
        label={t('settings.policy.requires_photo')}
        checked={form.requiresPhoto}
        onChange={(event) => setForm({ ...form, requiresPhoto: event.target.checked })}
      />
      <Switch
        label={t('settings.policy.requires_comment')}
        checked={form.requiresComment}
        onChange={(event) => setForm({ ...form, requiresComment: event.target.checked })}
      />
      <Switch
        label={t('settings.policy.requires_approval')}
        checked={form.requiresApproval}
        onChange={(event) => setForm({ ...form, requiresApproval: event.target.checked })}
      />
      {dropsApproval ? <Banner tone="warn">{t('settings.policy.drop_warning')}</Banner> : null}
      {form.requiresApproval ? (
        <>
          <Field
            label={t('settings.policy.approver')}
            hint={t('settings.policy.approver_hint')}
            error={problem === 'APPROVER' ? t('settings.policy.problem_approver') : undefined}
          >
            {(control) => (
              <Select
                {...control}
                value={form.approverPermission}
                onChange={(event) => setForm({ ...form, approverPermission: event.target.value })}
              >
                <option value="">{t('org.choose')}</option>
                {permissions.map((permission) => (
                  <option key={permission.code} value={permission.code}>
                    {`${permission.code} — ${permission.description}`}
                  </option>
                ))}
                {form.approverPermission !== '' &&
                !permissions.some((permission) => permission.code === form.approverPermission) ? (
                  <option value={form.approverPermission}>{form.approverPermission}</option>
                ) : null}
              </Select>
            )}
          </Field>
          <Field label={t('settings.policy.scope_label')}>
            {(control) => (
              <Select
                {...control}
                value={form.approverScope}
                onChange={(event) =>
                  setForm({
                    ...form,
                    approverScope: event.target.value as PolicyForm['approverScope'],
                  })
                }
              >
                {APPROVER_SCOPES.map((scope) => (
                  <option key={scope} value={scope}>
                    {t(`settings.policy.scope.${scope}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </>
      ) : null}
      <p className="adm-note">{t('settings.policy.condition_note')}</p>
      <div className="adm-actions">
        <Button disabled={blocked || problem !== null || !changed} onClick={() => void save()}>
          {t('settings.policy.save')}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t('org.cancel')}
        </Button>
      </div>
    </div>
  );
}

export function PoliciesPanel({ commands }: Props) {
  const { t } = useTranslation();
  const read = useAdminRead<PoliciesRead>(POLICIES_PATH, commands.reloadKey);
  const [open, setOpen] = useState<{ code: string; mode: 'EDIT' | 'HISTORY' } | null>(null);
  const blocked = commands.blocked || read.stale;
  const policies = read.data?.policies;

  return (
    <>
      <p className="adm-note">{t('settings.policy.intro')}</p>
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
          {read.denied ? t('settings.denied') : t('settings.unavailable')}
        </Banner>
      ) : null}
      {policies === undefined && !read.failed ? <SkeletonRows /> : null}
      {policies && policies.length === 0 ? (
        <EmptyState icon="shield" title={t('settings.policy.none')} />
      ) : null}
      {policies && policies.length > 0 ? (
        <ul className="adm-cards">
          {policies.map((policy) => {
            const here = open?.code === policy.code ? open : null;
            return (
              <li
                key={policy.id}
                className="line-card"
                aria-label={t('settings.policy.card', { code: policy.code })}
              >
                <div className="adm-card-head">
                  <span className="adm-card-title">
                    <strong>
                      {t(`approvals.type.${policy.operationType}`, {
                        defaultValue: policy.operationType,
                      })}
                    </strong>
                    <span className="adm-sub">
                      {`${policy.code} · ${t('settings.policy.version', { version: policy.version })}`}
                    </span>
                  </span>
                  <Badge tone={policy.requiresApproval ? 'brand' : 'muted'}>
                    {policy.requiresApproval
                      ? t('settings.policy.badge_approval')
                      : t('settings.policy.badge_free')}
                  </Badge>
                </div>
                <p className="adm-note">{summaryOf(policy, t)}</p>
                {here === null ? (
                  <div className="adm-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={blocked}
                      onClick={() => setOpen({ code: policy.code, mode: 'EDIT' })}
                    >
                      {t('settings.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setOpen({ code: policy.code, mode: 'HISTORY' })}
                    >
                      {t('settings.history')}
                    </Button>
                  </div>
                ) : null}
                {here?.mode === 'EDIT' ? (
                  <PolicyEditor
                    policy={policy}
                    permissions={read.data?.approver_permissions ?? []}
                    blocked={blocked}
                    commands={commands}
                    onDone={() => setOpen(null)}
                  />
                ) : null}
                {here?.mode === 'HISTORY' ? (
                  <>
                    <PolicyHistory code={policy.code} reloadKey={commands.reloadKey} />
                    <div className="adm-actions">
                      <Button variant="ghost" size="sm" onClick={() => setOpen(null)}>
                        {t('settings.close_history')}
                      </Button>
                    </div>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}
