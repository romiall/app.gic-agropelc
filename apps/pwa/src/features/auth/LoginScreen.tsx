/**
 * ECR-ADM-01 « Connexion et enrôlement de l'appareil ». Jamais hors ligne (première
 * connexion sur cet appareil) : UX-02 respecté malgré tout (2 champs obligatoires).
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner, Button, Field, Input } from '../../components/ui/index.js';
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
      <form className="auth-form stack" onSubmit={(event) => void onSubmit(event)}>
        <Field label={t('auth.phone_label')}>
          {(control) => (
            <Input
              {...control}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder={t('auth.phone_placeholder')}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
              autoFocus
            />
          )}
        </Field>
        <Field label={t('auth.password_label')}>
          {(control) => (
            <div className="input-with-action">
              <Input
                {...control}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <Button
                variant="ghost"
                size="sm"
                className="input-action"
                aria-pressed={showPassword}
                onClick={() => setShowPassword((visible) => !visible)}
              >
                {showPassword ? t('auth.hide_password') : t('auth.show_password')}
              </Button>
            </div>
          )}
        </Field>
        {error && <Banner tone="bad">{t(`auth.error_${error.toLowerCase()}`)}</Banner>}
        <Button type="submit" size="lg" block loading={submitting}>
          {submitting ? t('auth.submitting') : t('auth.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
