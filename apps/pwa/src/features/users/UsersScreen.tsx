/**
 * ECR-ADM-04 « Utilisateurs et affectations de rôle » (MP-08, complété par MP-13 ; AV-252, AV-281, AV-325,
 * AV-326). En ligne seulement. Liste des comptes de la portée du lecteur (`GET /users`), filtrée par état
 * (actifs par défaut) et par une recherche locale. L'administrateur y :
 * - crée un compte avec un mot de passe provisoire et, s'il le veut, un premier rôle (`POST /users`, hors
 *   du journal des commandes) ;
 * - réinitialise le mot de passe d'une personne qui l'a oublié (`POST /users/{id}/reset-password`, idem) ;
 * - suspend, réactive ou désactive un compte, ajoute ou retire un rôle (commandes `identity.*` de la file
 *   d'envoi, suivies jusqu'à la réponse ; la suivante attend la réponse définitive de la précédente).
 *
 * Les mots de passe saisis ne sont conservés nulle part (ni file d'envoi, ni base locale) : le champ est
 * vidé dès la réponse. Le compte doit changer son mot de passe provisoire à sa première connexion
 * (AV-251). Les rôles sont figés (AV-257) ; les périmètres proposés sont `GLOBAL` et `SITE` (AV-326).
 */
import { useId, useState } from 'react';
import type { TFunction } from 'i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { PASSWORD_MAX_LENGTH } from '@gic/domain';
import { idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatDateTime } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import {
  readPages,
  readPath,
  useOnlineRead,
  useRefreshOnVisible,
  type Pages,
} from '../sales/online-read.js';
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
  alreadyAssigned,
  assignmentProblem,
  canSendStatus,
  CREATE_PATH,
  createBody,
  EMPTY_NEW_USER,
  grantPayload,
  matchesSearch,
  newUserProblem,
  REASON_MAX,
  refusalOf,
  resetPath,
  resetProblem,
  revokePayload,
  ROLES_PATH,
  scopeTypesFor,
  sortByName,
  statusActionsFor,
  statusCommand,
  statusReasonRequired,
  USER_FILTERS,
  usersPath,
  type AssignmentChoice,
  type AssignmentView,
  type CreateOutcome,
  type NewUserForm,
  type ResetOutcome,
  type RoleView,
  type ScopeType,
  type StatusAction,
  type UserFilter,
  type UserView,
} from './users.js';

/** Pages lues au plus pour un filtre (200 comptes chacune). */
const MAX_PAGES = 5;
/** Commandes d'identité de la file d'envoi suivies par cet écran. */
const PREFIX = 'identity.';

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: 'badge-ok',
  SUSPENDED: 'badge-warn',
  DEACTIVATED: 'badge-muted',
};

interface SiteOption {
  readonly id: string;
  readonly name: string;
}

/** Ce que l'écran a ouvert sous un compte (un seul formulaire à la fois). */
type Open =
  | { readonly userId: string; readonly kind: 'RESET' }
  | { readonly userId: string; readonly kind: 'STATUS'; readonly action: StatusAction }
  | { readonly userId: string; readonly kind: 'ASSIGN' }
  | { readonly userId: string; readonly kind: 'REVOKE'; readonly assignmentId: string };

// --- Mot de passe provisoire (partagé par la création et la réinitialisation) ---------------------

interface PasswordFieldsProps {
  readonly password: string;
  readonly confirmation: string;
  readonly onPassword: (value: string) => void;
  readonly onConfirmation: (value: string) => void;
}

function PasswordFields({
  password,
  confirmation,
  onPassword,
  onConfirmation,
}: PasswordFieldsProps) {
  const { t } = useTranslation();
  const ids = { password: useId(), confirm: useId() };
  const [show, setShow] = useState(false);
  const problem = resetProblem(password, confirmation);
  const type = show ? 'text' : 'password';
  return (
    <>
      <div className="field">
        <label htmlFor={ids.password}>{t('users.reset_password')}</label>
        <input
          id={ids.password}
          className="text-input"
          type={type}
          autoComplete="new-password"
          maxLength={PASSWORD_MAX_LENGTH}
          value={password}
          onChange={(event) => onPassword(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={ids.confirm}>{t('users.reset_confirm')}</label>
        <input
          id={ids.confirm}
          className="text-input"
          type={type}
          autoComplete="new-password"
          maxLength={PASSWORD_MAX_LENGTH}
          value={confirmation}
          onChange={(event) => onConfirmation(event.target.value)}
        />
      </div>
      <label className="choice">
        <input type="checkbox" checked={show} onChange={(event) => setShow(event.target.checked)} />
        {t('users.reset_show')}
      </label>
      {/* La différence des deux saisies ne se signale qu'une fois la confirmation commencée (MP-11). */}
      {password && problem && (problem !== 'MISMATCH' || confirmation !== '') ? (
        <p className="text-warn">
          {problem === 'MISMATCH'
            ? t('users.reset_mismatch')
            : t(`auth.password_change_error.${problem}`)}
        </p>
      ) : null}
    </>
  );
}

// --- Réinitialisation ----------------------------------------------------------------------------

interface ResetFormProps {
  readonly user: UserView;
  readonly onCancel: () => void;
  readonly onDone: (outcome: ResetOutcome) => void;
}

function ResetForm({ user, onCancel, onDone }: ResetFormProps) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [sending, setSending] = useState(false);
  const problem = resetProblem(password, confirm);

  const send = async () => {
    if (problem || sending) return;
    setSending(true);
    const result = await authorizedRequest(getDb(), resetPath(user.id), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ new_password: password }),
    });
    // Le mot de passe saisi n'est gardé nulle part, pas même dans le formulaire.
    setPassword('');
    setConfirm('');
    setSending(false);
    if (result.ok) onDone({ kind: 'DONE' });
    else if (result.reason === 'HTTP_ERROR') onDone({ kind: 'REFUSED', ...refusalOf(result.body) });
    else onDone({ kind: 'OFFLINE' });
  };

  return (
    <div
      className="sale-block"
      role="group"
      aria-label={t('users.reset_title', { name: user.fullName })}
    >
      <p className="home-muted">{t('users.reset_help')}</p>
      <PasswordFields
        password={password}
        confirmation={confirm}
        onPassword={setPassword}
        onConfirmation={setConfirm}
      />
      <div className="result-actions">
        <button
          type="button"
          className="btn-block submit-sale"
          disabled={problem !== null || sending}
          onClick={() => void send()}
        >
          {sending ? t('users.reset_sending') : t('users.reset_submit', { name: user.fullName })}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t('price_rules.cancel')}
        </button>
      </div>
    </div>
  );
}

// --- Choix d'une affectation (création et ajout de rôle) -----------------------------------------

interface AssignmentFieldsProps {
  readonly choice: AssignmentChoice;
  readonly roles: readonly RoleView[];
  readonly sites: readonly SiteOption[];
  readonly optional: boolean;
  readonly onChange: (choice: AssignmentChoice) => void;
}

function AssignmentFields({ choice, roles, sites, optional, onChange }: AssignmentFieldsProps) {
  const { t } = useTranslation();
  const ids = { role: useId(), scope: useId(), site: useId() };
  const role = roles.find((candidate) => candidate.id === choice.roleId);
  const scopes = scopeTypesFor(role);
  const pick = (roleId: string) => {
    const next = roles.find((candidate) => candidate.id === roleId);
    const allowed = scopeTypesFor(next);
    onChange({
      roleId,
      scopeType: allowed.includes(choice.scopeType) ? choice.scopeType : (allowed[0] ?? 'GLOBAL'),
      siteId: choice.siteId,
    });
  };
  return (
    <>
      <div className="field">
        <label htmlFor={ids.role}>{t('users.role_label')}</label>
        <select
          id={ids.role}
          className="text-input"
          value={choice.roleId}
          onChange={(event) => pick(event.target.value)}
        >
          <option value="">{optional ? t('users.no_role_option') : t('users.choose_role')}</option>
          {roles.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {t(`users.role.${candidate.code}`, { defaultValue: candidate.name })}
            </option>
          ))}
        </select>
      </div>
      {role ? (
        <div className="field">
          <label htmlFor={ids.scope}>{t('users.scope_label')}</label>
          <select
            id={ids.scope}
            className="text-input"
            value={choice.scopeType}
            onChange={(event) =>
              onChange({ ...choice, scopeType: event.target.value as ScopeType })
            }
          >
            {scopes.map((scope) => (
              <option key={scope} value={scope}>
                {t(`users.scope.${scope}`)}
              </option>
            ))}
          </select>
          {scopes.length === 0 ? (
            <p className="text-warn" role="alert">
              {t('users.scope_unavailable')}
            </p>
          ) : null}
        </div>
      ) : null}
      {role && choice.scopeType === 'SITE' ? (
        <div className="field">
          <label htmlFor={ids.site}>{t('users.site_label')}</label>
          <select
            id={ids.site}
            className="text-input"
            value={choice.siteId}
            onChange={(event) => onChange({ ...choice, siteId: event.target.value })}
          >
            <option value="">{t('users.choose_site')}</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </>
  );
}

// --- Création d'un compte ------------------------------------------------------------------------

interface CreateFormProps {
  readonly roles: readonly RoleView[];
  readonly sites: readonly SiteOption[];
  readonly onCancel: () => void;
  readonly onDone: (outcome: CreateOutcome, name: string) => void;
}

function CreateForm({ roles, sites, onCancel, onDone }: CreateFormProps) {
  const { t } = useTranslation();
  const ids = { name: useId(), phone: useId(), email: useId() };
  const [form, setForm] = useState<NewUserForm>(EMPTY_NEW_USER);
  const [sending, setSending] = useState(false);
  const problem = newUserProblem(form, roles);
  const set = (patch: Partial<NewUserForm>) => setForm((current) => ({ ...current, ...patch }));

  const send = async () => {
    if (problem || sending) return;
    setSending(true);
    const name = form.fullName.trim();
    const result = await authorizedRequest<{ id: string }>(getDb(), CREATE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody(form)),
    });
    // Le mot de passe saisi n'est gardé nulle part, pas même dans le formulaire.
    setForm((current) => ({ ...current, password: '', confirmation: '' }));
    setSending(false);
    if (result.ok) onDone({ kind: 'CREATED', id: result.data.id }, name);
    else if (result.reason === 'HTTP_ERROR') {
      onDone({ kind: 'REFUSED', ...refusalOf(result.body) }, name);
    } else onDone({ kind: 'OFFLINE' }, name);
  };

  return (
    <div className="sale-block" role="group" aria-label={t('users.create_title')}>
      <h2>{t('users.create_title')}</h2>
      <p className="home-muted">{t('users.create_help')}</p>
      <div className="field">
        <label htmlFor={ids.name}>{t('users.name_label')}</label>
        <input
          id={ids.name}
          className="text-input"
          autoComplete="off"
          maxLength={200}
          value={form.fullName}
          onChange={(event) => set({ fullName: event.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor={ids.phone}>{t('users.phone_label')}</label>
        <input
          id={ids.phone}
          className="text-input"
          type="tel"
          autoComplete="off"
          placeholder="+237 6XX XX XX XX"
          value={form.phone}
          onChange={(event) => set({ phone: event.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor={ids.email}>{t('users.email_label')}</label>
        <input
          id={ids.email}
          className="text-input"
          type="email"
          autoComplete="off"
          maxLength={200}
          value={form.email}
          onChange={(event) => set({ email: event.target.value })}
        />
      </div>
      <AssignmentFields
        choice={form}
        roles={roles}
        sites={sites}
        optional
        onChange={(choice) => set(choice)}
      />
      <PasswordFields
        password={form.password}
        confirmation={form.confirmation}
        onPassword={(value) => set({ password: value })}
        onConfirmation={(value) => set({ confirmation: value })}
      />
      {form.fullName && problem && ['PHONE', 'EMAIL', 'SITE', 'SCOPE'].includes(problem) ? (
        <p className="text-warn">{t(`users.create_problem.${problem}`)}</p>
      ) : null}
      <div className="result-actions">
        <button
          type="button"
          className="btn-block submit-sale"
          disabled={problem !== null || sending}
          onClick={() => void send()}
        >
          {sending ? t('users.create_sending') : t('users.create_submit')}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t('price_rules.cancel')}
        </button>
      </div>
    </div>
  );
}

// --- État d'un compte et affectations (commandes) ------------------------------------------------

interface ReasonFormProps {
  readonly label: string;
  readonly confirm: string;
  readonly required: boolean;
  readonly blocked: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (reason: string) => void;
}

function ReasonForm({ label, confirm, required, blocked, onCancel, onConfirm }: ReasonFormProps) {
  const { t } = useTranslation();
  const id = useId();
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const ready = !blocked && trimmed.length <= REASON_MAX && (!required || trimmed.length > 0);
  return (
    <div className="sale-block" role="group" aria-label={label}>
      <div className="field">
        <label htmlFor={id}>
          {required ? t('users.reason_required') : t('users.reason_optional')}
        </label>
        <textarea
          id={id}
          className="text-input"
          maxLength={REASON_MAX}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <div className="result-actions">
        <button
          type="button"
          className="btn-block submit-sale"
          disabled={!ready}
          onClick={() => onConfirm(reason)}
        >
          {confirm}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t('price_rules.cancel')}
        </button>
      </div>
    </div>
  );
}

function scopeText(
  assignment: AssignmentView,
  siteName: (id: string | null) => string | null,
  t: TFunction,
): string {
  if (assignment.scopeType === 'SITE') {
    return t('users.scope_site', {
      name: siteName(assignment.scopeSiteId) ?? t('users.site_unknown'),
    });
  }
  return t(`users.scope.${assignment.scopeType}`, { defaultValue: assignment.scopeType });
}

// --- Écran ---------------------------------------------------------------------------------------

export function UsersScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const online = useOnline();
  const refs = useSalesReferences();
  const searchId = useId();
  const [filter, setFilter] = useState<UserFilter>('ACTIVE');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Open | null>(null);
  const [creating, setCreating] = useState(false);
  const [outcome, setOutcome] = useState<
    | { kind: 'RESET'; name: string; result: ResetOutcome }
    | { kind: 'CREATE'; name: string; result: CreateOutcome }
    | null
  >(null);
  const [last, setLast] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const outbox = useLiveQuery(() => getDb().outbox.orderBy('device_seq').toArray(), []) ?? [];
  const lastCommand = outbox.find((command) => command.command_id === last);
  const pendingOps = waitingCommands(outbox, PREFIX, userId);
  const read = useOnlineRead<Pages<UserView>>(
    online ? usersPath(filter) : null,
    (path) => readPages<UserView>([path], 'users', MAX_PAGES),
    online,
    `${reload}|${last ?? ''}:${lastCommand ? phaseOf(lastCommand) : ''}|${waitingIds(outbox, PREFIX, userId)}`,
  );
  useRefreshOnVisible(read.retry);
  // Les rôles ne se lisent qu'avec le droit d'affecter : leur lecture dit si l'écran peut créer et affecter.
  const rolesRead = useOnlineRead<{ readonly roles: readonly RoleView[] }>(
    online ? ROLES_PATH : null,
    (path) => readPath<{ roles: RoleView[] }>(path),
    online,
    '',
  );

  if (!userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.users')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }
  if (!online) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.users')}</h1>
        <p className="home-muted">{t('users.online_only')}</p>
      </section>
    );
  }

  const roles = rolesRead.data?.roles;
  const sites: SiteOption[] = refs
    ? [...refs.sites.values()]
        .filter((site) => site.status === 'ACTIVE')
        .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    : [];
  // Tant que le jeu `org` se charge, le nom n'est pas « inconnu » : il n'est pas encore là.
  const siteName = (id: string | null) =>
    id ? (refs ? (refs.sites.get(id)?.name ?? null) : '…') : null;
  const waiting =
    (last !== undefined && (lastCommand === undefined || isBlockingWait(lastCommand, outbox))) ||
    pendingOps.length > 0;
  const blocked = busy || waiting || read.stale;
  const adopt = last ? undefined : lastWaitingCommand(outbox, PREFIX, userId);
  if (adopt) setLast(adopt.command_id);
  const users = read.data
    ? sortByName(read.data.items.filter((user) => matchesSearch(user, search)))
    : undefined;

  const send = async (input: {
    commandType: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }) => {
    if (blocked) return;
    setBusy(true);
    setSaveError(null);
    try {
      const command = await submitCommand({ authorUserId: userId, ...input });
      setLast(command.command_id);
      setOpen(null);
      setOutcome(null);
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  const outcomeNotice = () => {
    if (!outcome) return null;
    if (outcome.kind === 'RESET') {
      return outcome.result.kind === 'DONE' ? (
        <p className="alert" role="status">
          {t('users.reset_done', { name: outcome.name })}
        </p>
      ) : (
        <p className="alert alert-error" role="alert">
          {outcome.result.kind === 'OFFLINE'
            ? t('users.reset_offline')
            : t('users.reset_refused', { reason: outcome.result.message ?? outcome.result.code })}
        </p>
      );
    }
    return outcome.result.kind === 'CREATED' ? (
      <p className="alert" role="status">
        {t('users.create_done', { name: outcome.name })}
      </p>
    ) : (
      <p className="alert alert-error" role="alert">
        {outcome.result.kind === 'OFFLINE'
          ? t('users.create_offline')
          : t('users.create_refused', { reason: outcome.result.message ?? outcome.result.code })}
      </p>
    );
  };

  return (
    <section className="sale">
      <h1>{t('nav.screens.users')}</h1>
      <p className="home-muted">{t('users.intro')}</p>
      {last ? <CommandResult commandId={last} messages="users.result" /> : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t(saveError)}
        </p>
      ) : null}
      {outcomeNotice()}
      {roles && !creating ? (
        <div className="result-actions">
          <button
            type="button"
            className="btn-block submit-sale"
            onClick={() => {
              setOutcome(null);
              setOpen(null);
              setCreating(true);
            }}
          >
            {t('users.create_action')}
          </button>
        </div>
      ) : null}
      {roles && creating ? (
        <CreateForm
          roles={roles}
          sites={sites}
          onCancel={() => setCreating(false)}
          onDone={(result, name) => {
            setOutcome({ kind: 'CREATE', name, result });
            if (result.kind === 'CREATED') {
              setCreating(false);
              setReload((value) => value + 1);
            }
          }}
        />
      ) : null}
      <fieldset className="choice-group">
        <legend>{t('users.filter_label')}</legend>
        {USER_FILTERS.map((option) => (
          <label key={option} className="choice">
            <input
              type="radio"
              name="user-filter"
              checked={filter === option}
              onChange={() => {
                setFilter(option);
                setOpen(null);
              }}
            />
            {t(`users.filter.${option}`)}
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor={searchId}>{t('users.search_label')}</label>
        <input
          id={searchId}
          className="text-input"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {users === undefined && !read.failed ? (
        <p className="home-muted">{t('sales.loading')}</p>
      ) : null}
      {read.failed ? (
        <div className="alert alert-error" role="alert">
          <p>{read.denied ? t('users.denied') : t('users.unavailable')}</p>
          {read.denied ? null : (
            <button type="button" className="secondary" onClick={read.retry}>
              {t('ledger.retry')}
            </button>
          )}
        </div>
      ) : null}
      {users && read.stale && !read.failed ? (
        <p className="home-muted" role="status">
          {t('users.refreshing')}
        </p>
      ) : null}
      {read.data?.more ? <p className="home-muted">{t('users.truncated')}</p> : null}
      {users && users.length === 0 ? (
        <p className="home-muted">{t(`users.none.${filter}`)}</p>
      ) : null}
      {users && users.length > 0 ? (
        <ul className="line-list">
          {users.map((user) => {
            const mine = open?.userId === user.id ? open : null;
            return (
              <li key={user.id} className="line-card" aria-label={user.fullName}>
                <div className="line-head">
                  <strong>{user.fullName}</strong>
                  <span className={`badge ${STATUS_BADGE[user.status] ?? 'badge-muted'}`}>
                    {t(`users.status.${user.status}`, { defaultValue: user.status })}
                  </span>
                </div>
                <p className="home-muted">{user.phone}</p>
                {user.assignments.length > 0 ? (
                  <ul
                    className="line-list"
                    aria-label={t('users.assignments_label', { name: user.fullName })}
                  >
                    {user.assignments.map((assignment) => (
                      <li key={assignment.id} className="home-muted">
                        {t(`users.role.${assignment.roleCode}`, {
                          defaultValue: assignment.roleName,
                        })}
                        {' · '}
                        {scopeText(assignment, siteName, t)}
                        {user.actions.manageRoles ? (
                          <button
                            type="button"
                            className="secondary"
                            aria-label={t('users.revoke_open', {
                              role: t(`users.role.${assignment.roleCode}`, {
                                defaultValue: assignment.roleName,
                              }),
                              name: user.fullName,
                            })}
                            onClick={() => {
                              setOutcome(null);
                              setCreating(false);
                              setOpen({
                                userId: user.id,
                                kind: 'REVOKE',
                                assignmentId: assignment.id,
                              });
                            }}
                          >
                            {t('users.revoke_action')}
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="home-muted">{t('users.no_role')}</p>
                )}
                <p className="home-muted">
                  {user.lastLoginAt
                    ? t('users.last_login', { date: formatDateTime(user.lastLoginAt) })
                    : t('users.never_logged_in')}
                </p>
                {user.mustChangePassword ? (
                  <p className="text-warn">{t('users.must_change')}</p>
                ) : null}
                {mine?.kind === 'RESET' ? (
                  <ResetForm
                    user={user}
                    onCancel={() => setOpen(null)}
                    onDone={(result) => {
                      setOutcome({ kind: 'RESET', name: user.fullName, result });
                      setOpen(null);
                      if (result.kind === 'DONE') setReload((value) => value + 1);
                    }}
                  />
                ) : null}
                {mine?.kind === 'STATUS' ? (
                  <ReasonForm
                    label={t(`users.status_action.${mine.action}`, { name: user.fullName })}
                    confirm={t(`users.status_confirm.${mine.action}`, { name: user.fullName })}
                    required={statusReasonRequired(mine.action)}
                    blocked={blocked}
                    onCancel={() => setOpen(null)}
                    onConfirm={(reason) => {
                      if (!canSendStatus(mine.action, reason)) return;
                      void send({
                        ...statusCommand(mine.action, reason),
                        aggregateType: 'USER',
                        aggregateId: user.id,
                      });
                    }}
                  />
                ) : null}
                {mine?.kind === 'REVOKE' ? (
                  <ReasonForm
                    label={t('users.revoke_title', { name: user.fullName })}
                    confirm={t('users.revoke_confirm')}
                    required
                    blocked={blocked}
                    onCancel={() => setOpen(null)}
                    onConfirm={(reason) =>
                      void send({
                        commandType: 'identity.role_assignment.revoke',
                        aggregateType: 'ROLE_ASSIGNMENT',
                        aggregateId: mine.assignmentId,
                        payload: revokePayload(reason),
                      })
                    }
                  />
                ) : null}
                {mine?.kind === 'ASSIGN' && roles ? (
                  <AssignForm
                    user={user}
                    roles={roles}
                    sites={sites}
                    blocked={blocked}
                    onCancel={() => setOpen(null)}
                    onConfirm={(choice) =>
                      void send({
                        commandType: 'identity.role_assignment.grant',
                        aggregateType: 'ROLE_ASSIGNMENT',
                        aggregateId: idGenerator.newId(),
                        payload: grantPayload(user.id, choice),
                      })
                    }
                  />
                ) : null}
                {!mine ? (
                  <div className="result-actions">
                    {user.actions.resetPassword ? (
                      <button
                        type="button"
                        className="secondary"
                        aria-label={t('users.reset_open', { name: user.fullName })}
                        onClick={() => {
                          setOutcome(null);
                          setCreating(false);
                          setOpen({ userId: user.id, kind: 'RESET' });
                        }}
                      >
                        {t('users.reset_action')}
                      </button>
                    ) : null}
                    {user.actions.manageRoles && user.status !== 'DEACTIVATED' && roles ? (
                      <button
                        type="button"
                        className="secondary"
                        aria-label={t('users.assign_open', { name: user.fullName })}
                        onClick={() => {
                          setOutcome(null);
                          setCreating(false);
                          setOpen({ userId: user.id, kind: 'ASSIGN' });
                        }}
                      >
                        {t('users.assign_action')}
                      </button>
                    ) : null}
                    {statusActionsFor(user).map((action) => (
                      <button
                        key={action}
                        type="button"
                        className="secondary"
                        aria-label={t(`users.status_action.${action}`, { name: user.fullName })}
                        onClick={() => {
                          setOutcome(null);
                          setCreating(false);
                          setOpen({ userId: user.id, kind: 'STATUS', action });
                        }}
                      >
                        {t(`users.status_short.${action}`)}
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

// --- Ajout d'un rôle à un compte -----------------------------------------------------------------

interface AssignFormProps {
  readonly user: UserView;
  readonly roles: readonly RoleView[];
  readonly sites: readonly SiteOption[];
  readonly blocked: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (choice: AssignmentChoice) => void;
}

function AssignForm({ user, roles, sites, blocked, onCancel, onConfirm }: AssignFormProps) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<AssignmentChoice>({
    roleId: '',
    scopeType: 'GLOBAL',
    siteId: '',
  });
  const problem = assignmentProblem(choice, roles);
  const duplicate = problem === null && alreadyAssigned(user, choice);
  const ready = !blocked && problem === null && !duplicate;
  return (
    <div
      className="sale-block"
      role="group"
      aria-label={t('users.assign_title', { name: user.fullName })}
    >
      <AssignmentFields
        choice={choice}
        roles={roles}
        sites={sites}
        optional={false}
        onChange={setChoice}
      />
      {duplicate ? <p className="text-warn">{t('users.assign_duplicate')}</p> : null}
      <div className="result-actions">
        <button
          type="button"
          className="btn-block submit-sale"
          disabled={!ready}
          onClick={() => onConfirm(choice)}
        >
          {t('users.assign_confirm', { name: user.fullName })}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t('price_rules.cancel')}
        </button>
      </div>
    </div>
  );
}
