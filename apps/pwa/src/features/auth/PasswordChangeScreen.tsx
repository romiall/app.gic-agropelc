/**
 * Changement imposé du mot de passe provisoire (MP-08 ; AV-251, AV-280 ; 02-securite.md §2 « changement
 * forcé à la première connexion »). Affiché juste après la connexion d'un compte dont le mot de passe
 * est provisoire (création ou réinitialisation par l'Admin) ; rien d'autre ne s'ouvre avant. Le mot de
 * passe provisoire est ressaisi (l'appareil ne l'a pas gardé) ; règles partagées avec le serveur
 * (`newPasswordProblem` : 8 à 128 caractères, différent du provisoire, confirmation identique).
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { newPasswordProblem, PASSWORD_MAX_LENGTH } from '@gic/domain';
import { AuthLayout } from './AuthLayout.js';
import { useAuth } from './AuthContext.js';

export function PasswordChangeScreen() {
  const { t } = useTranslation();
  const { state, changeProvisionalPassword, cancelPasswordChange } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const serverError = state.status === 'password_change_required' ? state.error : undefined;
  const type = showPasswords ? 'text' : 'password';

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = newPasswordProblem({ password: next, current, confirmation: confirm });
    if (problem) {
      setLocalError(t(`auth.password_change_error.${problem}`));
      return;
    }
    setLocalError(undefined);
    setSubmitting(true);
    try {
      await changeProvisionalPassword(current, next);
    } finally {
      setSubmitting(false);
    }
  };

  const error =
    localError ?? (serverError ? t(`auth.password_change_error.${serverError}`) : undefined);
  return (
    <AuthLayout title={t('auth.password_change_title')} subtitle={t('auth.password_change_help')}>
      <form className="auth-form" onSubmit={(event) => void onSubmit(event)}>
        <div className="field">
          <label htmlFor="password-current">{t('auth.password_change_current')}</label>
          <input
            id="password-current"
            type={type}
            autoComplete="current-password"
            maxLength={PASSWORD_MAX_LENGTH * 2}
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password-new">{t('auth.password_change_new')}</label>
          <input
            id="password-new"
            type={type}
            autoComplete="new-password"
            maxLength={PASSWORD_MAX_LENGTH}
            value={next}
            onChange={(event) => setNext(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password-confirm">{t('auth.password_change_confirm')}</label>
          <input
            id="password-confirm"
            type={type}
            autoComplete="new-password"
            maxLength={PASSWORD_MAX_LENGTH}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            required
          />
        </div>
        <label className="choice">
          <input
            type="checkbox"
            checked={showPasswords}
            onChange={(event) => setShowPasswords(event.target.checked)}
          />
          {t('auth.password_change_show')}
        </label>
        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn-block" disabled={submitting}>
          {submitting ? t('auth.password_change_submitting') : t('auth.password_change_submit')}
        </button>
        <button type="button" className="secondary" onClick={cancelPasswordChange}>
          {t('auth.password_change_cancel')}
        </button>
      </form>
    </AuthLayout>
  );
}
