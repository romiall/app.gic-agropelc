/**
 * ECR-ADM-01 « Connexion et enrôlement de l'appareil ». Jamais hors ligne (première
 * connexion sur cet appareil) : UX-02 respecté malgré tout (2 champs obligatoires).
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthLayout } from './AuthLayout.js';
import { useAuth } from './AuthContext.js';

export function LoginScreen() {
  const { t } = useTranslation();
  const { state, loginWithPassword } = useAuth();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const error = state.status === 'login_required' ? state.error : undefined;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await loginWithPassword(phone, password);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout title={t('auth.login_title')} subtitle={t('auth.login_subtitle')}>
      <form className="auth-form" onSubmit={(event) => void onSubmit(event)}>
        <div className="field">
          <label htmlFor="phone">{t('auth.phone_label')}</label>
          <input
            id="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder={t('auth.phone_placeholder')}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="field">
          <label htmlFor="password">{t('auth.password_label')}</label>
          <div className="input-with-action">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <button
              type="button"
              className="input-action"
              aria-pressed={showPassword}
              onClick={() => setShowPassword((visible) => !visible)}
            >
              {showPassword ? t('auth.hide_password') : t('auth.show_password')}
            </button>
          </div>
        </div>
        {error && (
          <p className="alert alert-error" role="alert">
            {t(`auth.error_${error.toLowerCase()}`)}
          </p>
        )}
        <button type="submit" className="btn-block" disabled={submitting}>
          {submitting ? t('auth.submitting') : t('auth.submit')}
        </button>
      </form>
    </AuthLayout>
  );
}
