/**
 * ECR-ADM-02 « Déverrouillage par PIN, changement d'utilisateur sur appareil partagé ».
 * Le changement d'utilisateur sur appareil partagé (AV-007) suit le même écran : se
 * déconnecter (bouton dédié, hors de cet écran une fois déverrouillé) puis se reconnecter
 * avec un autre compte ré-ouvre `LoginScreen` — pas de mécanisme séparé au P0 squelette.
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner, Button, Field, Input } from '../../components/ui/index.js';
import { AuthLayout } from './AuthLayout.js';
import { useAuth } from './AuthContext.js';

export function PinUnlockScreen() {
  const { t } = useTranslation();
  const { state, unlockWithPin } = useAuth();
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const pinError = state.status === 'locked' ? state.pinError : undefined;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await unlockWithPin(pin);
      setPin('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout title={t('auth.unlock_title')} subtitle={t('auth.unlock_help')}>
      <form className="auth-form stack" onSubmit={(event) => void onSubmit(event)}>
        <Field label={t('auth.pin_label')}>
          {(control) => (
            <Input
              {...control}
              type="password"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              autoComplete="current-password"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              required
              autoFocus
            />
          )}
        </Field>
        {pinError && pinError !== 'WIPED' && (
          <Banner tone="bad">
            {t('auth.pin_error_attempts', { count: pinError.attemptsLeft })}
          </Banner>
        )}
        {pinError === 'WIPED' && <Banner tone="bad">{t('auth.pin_wiped')}</Banner>}
        <Button type="submit" size="lg" block loading={submitting}>
          {t('auth.unlock_submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
