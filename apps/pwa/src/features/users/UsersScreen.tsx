/**
 * ECR-ADM-04 partiel « Utilisateurs » (MP-08 ; AV-252, AV-281). En ligne seulement. Liste des comptes de
 * la portée du lecteur (`GET /users`), filtrée par état (actifs par défaut) et par une recherche locale ;
 * réinitialisation du mot de passe par l'Admin, avec un mot de passe provisoire qu'il saisit deux fois.
 *
 * La réinitialisation est une route en ligne hors du journal des commandes (AV-252) : le mot de passe
 * saisi n'est jamais conservé (ni file d'envoi, ni base locale), et le champ est vidé dès la réponse. Le
 * compte devra changer ce mot de passe à sa prochaine connexion (AV-251) ; ses sessions sont fermées.
 * Création des comptes et affectations de rôles : hors de cet incrément (plan §4, AV-257).
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PASSWORD_MAX_LENGTH } from '@gic/domain';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatDateTime } from '../home/format-home.js';
import { readPages, useOnlineRead, type Pages } from '../sales/online-read.js';
import {
  matchesSearch,
  refusalOf,
  resetPath,
  resetProblem,
  sortByName,
  USER_FILTERS,
  usersPath,
  type ResetOutcome,
  type UserFilter,
  type UserView,
} from './users.js';

/** Pages lues au plus pour un filtre (200 comptes chacune). */
const MAX_PAGES = 5;

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: 'badge-ok',
  SUSPENDED: 'badge-warn',
  DEACTIVATED: 'badge-muted',
};

interface ResetFormProps {
  readonly user: UserView;
  readonly onCancel: () => void;
  readonly onDone: (outcome: ResetOutcome) => void;
}

function ResetForm({ user, onCancel, onDone }: ResetFormProps) {
  const { t } = useTranslation();
  const ids = { password: useId(), confirm: useId() };
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [sending, setSending] = useState(false);
  const problem = resetProblem(password, confirm);
  const type = show ? 'text' : 'password';

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
      <div className="field">
        <label htmlFor={ids.password}>{t('users.reset_password')}</label>
        <input
          id={ids.password}
          className="text-input"
          type={type}
          autoComplete="new-password"
          maxLength={PASSWORD_MAX_LENGTH}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
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
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>
      <label className="choice">
        <input type="checkbox" checked={show} onChange={(event) => setShow(event.target.checked)} />
        {t('users.reset_show')}
      </label>
      {password && problem ? (
        <p className="text-warn">{t(`auth.password_change_error.${problem}`)}</p>
      ) : null}
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

export function UsersScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const online = useOnline();
  const searchId = useId();
  const [filter, setFilter] = useState<UserFilter>('ACTIVE');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ name: string; result: ResetOutcome } | null>(null);
  const [reload, setReload] = useState(0);
  const read = useOnlineRead<Pages<UserView>>(
    online ? usersPath(filter) : null,
    (path) => readPages<UserView>([path], 'users', MAX_PAGES),
    online,
    String(reload),
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

  const users = read.data
    ? sortByName(read.data.items.filter((user) => matchesSearch(user, search)))
    : undefined;

  return (
    <section className="sale">
      <h1>{t('nav.screens.users')}</h1>
      <p className="home-muted">{t('users.intro')}</p>
      {outcome ? (
        outcome.result.kind === 'DONE' ? (
          <p className="alert" role="status">
            {t('users.reset_done', { name: outcome.name })}
          </p>
        ) : (
          <p className="alert alert-error" role="alert">
            {outcome.result.kind === 'OFFLINE'
              ? t('users.reset_offline')
              : t('users.reset_refused', {
                  reason: outcome.result.message ?? outcome.result.code,
                })}
          </p>
        )
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
      {read.data?.more ? <p className="home-muted">{t('users.truncated')}</p> : null}
      {users && users.length === 0 ? (
        <p className="home-muted">{t(`users.none.${filter}`)}</p>
      ) : null}
      {users && users.length > 0 ? (
        <ul className="line-list">
          {users.map((user) => (
            <li key={user.id} className="line-card" aria-label={user.fullName}>
              <div className="line-head">
                <strong>{user.fullName}</strong>
                <span className={`badge ${STATUS_BADGE[user.status] ?? 'badge-muted'}`}>
                  {t(`users.status.${user.status}`, { defaultValue: user.status })}
                </span>
              </div>
              <p className="home-muted">
                {[
                  user.phone,
                  user.roles.length > 0
                    ? user.roles
                        .map((role) => t(`users.role.${role}`, { defaultValue: role }))
                        .join(', ')
                    : t('users.no_role'),
                ].join(' · ')}
              </p>
              <p className="home-muted">
                {user.lastLoginAt
                  ? t('users.last_login', { date: formatDateTime(user.lastLoginAt) })
                  : t('users.never_logged_in')}
              </p>
              {user.mustChangePassword ? (
                <p className="text-warn">{t('users.must_change')}</p>
              ) : null}
              {open === user.id ? (
                <ResetForm
                  user={user}
                  onCancel={() => setOpen(null)}
                  onDone={(result) => {
                    setOutcome({ name: user.fullName, result });
                    setOpen(null);
                    if (result.kind === 'DONE') setReload((value) => value + 1);
                  }}
                />
              ) : user.actions.resetPassword ? (
                <div className="result-actions">
                  <button
                    type="button"
                    className="secondary"
                    aria-label={t('users.reset_open', { name: user.fullName })}
                    onClick={() => {
                      setOutcome(null);
                      setOpen(user.id);
                    }}
                  >
                    {t('users.reset_action')}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
