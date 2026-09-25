/**
 * ECR-ADM-01 « Connexion et enrôlement de l'appareil ». Jamais hors ligne (première
 * connexion sur cet appareil) : UX-02 respecté malgré tout (2 champs obligatoires).
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from './AuthContext.js';

export function LoginScreen() {
  const { t } = useTranslation();
  const { state, loginWithPassword } = useAuth();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
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
    <section>
      <h1>{t('auth.login_title')}</h1>
      <form onSubmit={(event) => void onSubmit(event)}>
        <div className="form-field">
          <label htmlFor="phone">{t('auth.phone_label')}</label>
          <input
            id="phone"
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            required
          />
        </div>
        <div className="form-field">
          <label htmlFor="password">{t('auth.password_label')}</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        {error && <p className="error-message">{t(`auth.error_${error.toLowerCase()}`)}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? t('auth.submitting') : t('auth.submit')}
        </button>
      </form>
    </section>
  );
}
