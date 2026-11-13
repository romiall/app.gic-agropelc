/**
 * ECR-ADM-09 « Droits des rôles » (questionnaire de clôture, Q28 du 08/11/2026 ; ADR-072 ; ADMIN et DIRECTION, droit
 * `identity.role.manage` ; en ligne seulement) : choisir un rôle, voir ses droits groupés par module, accorder un droit,
 * en changer la portée ou le retirer avec un motif (`identity.role_permission.set`), et l'historique des changements du
 * rôle. L'écran ne propose que ce que la commande acceptera (portées et retrait calculés par le serveur avec la règle
 * partagée) ; une commande à la fois, relue après la réponse du serveur.
 */
import { useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  DataCell,
  DataList,
  DataRow,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Section,
  Select,
  SkeletonRows,
  Textarea,
} from '../../components/ui/index.js';
import { AdminGate } from '../admin/AdminGate.js';
import { useAdminRead, useOnlineCommands } from '../admin/admin-online.js';
import { CommandResult } from '../sales/CommandResult.js';
import { HelpDisclosure } from '../users/HelpDisclosure.js';
import {
  REASON_MAX,
  REVOKE_CHOICE,
  ROLE_PERMISSION_PREFIX,
  canChange,
  groupedPermissions,
  permissionCommand,
  reasonValid,
  scopeChoices,
  type EditableRolesResponse,
  type RolePermissionEntry,
  type RolePermissionsResponse,
} from './role-permissions.js';
import './role-permissions.css';

type Commands = ReturnType<typeof useOnlineCommands>;

function scopeLabel(t: TFunction, scope: string | null): string {
  return scope === null ? t('role_permissions.not_granted') : t(`role_permissions.scope.${scope}`);
}

function PermissionEditor({
  roleId,
  entry,
  commands,
  onDone,
}: {
  readonly roleId: string;
  readonly entry: RolePermissionEntry;
  readonly commands: Commands;
  readonly onDone: () => void;
}) {
  const { t } = useTranslation();
  const choices = scopeChoices(entry);
  const [choice, setChoice] = useState(choices[0] ?? '');
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const reasonOk = reasonValid(reason);
  const save = async () => {
    if (!reasonOk || choice === '') {
      setAttempted(true);
      return;
    }
    if (await commands.send(permissionCommand(roleId, entry.code, choice, reason))) onDone();
  };
  return (
    <div className="rp-editor">
      <Field label={t('role_permissions.scope_label')}>
        {(control) => (
          <Select {...control} value={choice} onChange={(event) => setChoice(event.target.value)}>
            {choices.map((option) => (
              <option key={option} value={option}>
                {option === REVOKE_CHOICE
                  ? t('role_permissions.revoke_option')
                  : t(`role_permissions.scope.${option}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        label={t('role_permissions.reason_label')}
        error={attempted && !reasonOk ? t('role_permissions.reason_required') : undefined}
      >
        {(control) => (
          <Textarea
            {...control}
            value={reason}
            maxLength={REASON_MAX}
            rows={2}
            aria-invalid={attempted && !reasonOk ? true : undefined}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </Field>
      <div className="rp-editor-actions">
        <Button variant="outline" onClick={onDone}>
          {t('role_permissions.cancel')}
        </Button>
        <Button disabled={commands.blocked} onClick={() => void save()}>
          {t('role_permissions.save')}
        </Button>
      </div>
    </div>
  );
}

function RoleDetail({
  roleId,
  commands,
}: {
  readonly roleId: string;
  readonly commands: Commands;
}) {
  const { t, i18n } = useTranslation();
  const read = useAdminRead<RolePermissionsResponse>(
    `/api/v1/roles/${roleId}/permissions`,
    commands.reloadKey,
  );
  const [text, setText] = useState('');
  const [grantedOnly, setGrantedOnly] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  if (read.denied) return <Banner tone="bad">{t('role_permissions.denied')}</Banner>;
  if (read.data === undefined) {
    return read.failed ? (
      <Banner tone="bad">
        {t('role_permissions.load_failed')}{' '}
        <Button variant="ghost" size="sm" onClick={read.retry}>
          {t('role_permissions.retry')}
        </Button>
      </Banner>
    ) : (
      <SkeletonRows />
    );
  }
  const { role, permissions, changes } = read.data;
  const groups = groupedPermissions(permissions, { text, grantedOnly });
  const granted = permissions.filter((entry) => entry.maxScope !== null).length;
  const descriptionOf = new Map(permissions.map((entry) => [entry.code, entry.description]));
  const dateOf = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, {
      timeZone: 'Africa/Douala',
      dateStyle: 'short',
      timeStyle: 'short',
    });
  return (
    <>
      {!role.editable ? <Banner tone="info">{t('role_permissions.frozen')}</Banner> : null}
      <div className="rp-filters">
        <Field label={t('role_permissions.filter_label')}>
          {(control) => (
            <Input
              {...control}
              type="search"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          )}
        </Field>
        <Checkbox
          label={t('role_permissions.granted_only')}
          checked={grantedOnly}
          onChange={(event) => setGrantedOnly(event.target.checked)}
        />
        <p className="home-muted">
          {t('role_permissions.count', { granted, total: permissions.length })}
        </p>
      </div>
      {groups.length === 0 ? <EmptyState title={t('role_permissions.empty_filter')} /> : null}
      {groups.map((group) => (
        <Section key={group.module} title={group.module}>
          <DataList
            aria-label={group.module}
            template="minmax(0, 3fr) minmax(0, 1.2fr) auto"
            columns={[{ label: t('role_permissions.role_label') }, { label: '' }, { label: '' }]}
          >
            {group.entries.map((entry) => (
              <DataRow key={entry.code} aria-label={entry.code}>
                <DataCell primary>
                  <span className="rp-description">{entry.description}</span>
                  <code className="rp-code">{entry.code}</code>
                  {entry.isApproval ? (
                    <Badge tone="info" plain>
                      {t('role_permissions.approval')}
                    </Badge>
                  ) : null}
                  {entry.isSensitive ? (
                    <Badge tone="warn" plain>
                      {t('role_permissions.sensitive')}
                    </Badge>
                  ) : null}
                </DataCell>
                <DataCell>
                  <Badge tone={entry.maxScope === null ? 'muted' : 'ok'}>
                    {scopeLabel(t, entry.maxScope)}
                  </Badge>
                </DataCell>
                <DataCell>
                  {!entry.editable ? (
                    <span className="home-muted">{t('role_permissions.protected')}</span>
                  ) : canChange(entry) ? (
                    editing === entry.code ? null : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={commands.blocked}
                        onClick={() => setEditing(entry.code)}
                      >
                        {t('role_permissions.edit')}
                      </Button>
                    )
                  ) : (
                    <span className="home-muted">{t('role_permissions.not_held')}</span>
                  )}
                </DataCell>
                {editing === entry.code ? (
                  <PermissionEditor
                    roleId={role.id}
                    entry={entry}
                    commands={commands}
                    onDone={() => setEditing(null)}
                  />
                ) : null}
              </DataRow>
            ))}
          </DataList>
        </Section>
      ))}
      <Section title={t('role_permissions.history_title')}>
        {changes.length === 0 ? (
          <p className="home-muted">{t('role_permissions.history_empty')}</p>
        ) : (
          <ul className="rp-history">
            {changes.map((change) => (
              <li key={change.id}>
                <strong>{descriptionOf.get(change.permissionCode) ?? change.permissionCode}</strong>{' '}
                —{' '}
                {t(`role_permissions.change.${change.changeType}`, {
                  before: scopeLabel(t, change.scopeBefore),
                  after: scopeLabel(t, change.scopeAfter),
                })}
                <br />
                <span className="home-muted">
                  {t('role_permissions.history_meta', {
                    date: dateOf(change.changedAt),
                    author: change.changedByName,
                  })}
                </span>
                <br />« {change.reason} »
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function RolePermissionsBody() {
  const { t } = useTranslation();
  const commands = useOnlineCommands(ROLE_PERMISSION_PREFIX);
  const roles = useAdminRead<EditableRolesResponse>('/api/v1/roles/editable', '');
  const [roleId, setRoleId] = useState('');
  return (
    <>
      <PageHeader title={t('nav.screens.role_permissions')} />
      <HelpDisclosure title={t('role_permissions.help_title')}>
        <p>{t('role_permissions.intro')}</p>
        <p>{t('role_permissions.rule')}</p>
        <p>{t('role_permissions.screens_note')}</p>
      </HelpDisclosure>
      {commands.last ? (
        <CommandResult commandId={commands.last} messages="role_permissions.result" />
      ) : null}
      {commands.saveError ? <Banner tone="bad">{t(commands.saveError)}</Banner> : null}
      {roles.data === undefined ? (
        <SkeletonRows />
      ) : (
        <Field label={t('role_permissions.role_label')}>
          {(control) => (
            <Select {...control} value={roleId} onChange={(event) => setRoleId(event.target.value)}>
              <option value="">{t('role_permissions.role_placeholder')}</option>
              {roles.data!.roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {roleId !== '' ? <RoleDetail key={roleId} roleId={roleId} commands={commands} /> : null}
    </>
  );
}

export function RolePermissionsScreen() {
  const { t } = useTranslation();
  return (
    <AdminGate title={t('nav.screens.role_permissions')}>
      <RolePermissionsBody />
    </AdminGate>
  );
}
