/**
 * Établissement du PIN local après une connexion en ligne réussie (07-security-
 * rbac/02-securite.md §3 : 6 chiffres). Double saisie pour éviter un PIN mal tapé qui
 * verrouillerait l'appareil hors ligne sans recours autre que la reconnexion en ligne.
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { isValidPin } from '../../storage/crypto.js';
import { AuthLayout } from './AuthLayout.js';
import { useAuth } from './AuthContext.js';

export function PinSetupScreen() {
  const { t } = useTranslation();
  const { submitNewPin } = useAuth();
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isValidPin(pin)) {
      setError(t('auth.pin_setup_help'));
      return;
    }
    if (pin !== confirm) {
      setError(t('auth.pin_mismatch'));
      return;
    }
    setError(undefined);
    setSubmitting(true);
    try {
      await submitNewPin(pin);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout title={t('auth.pin_setup_title')} subtitle={t('auth.pin_setup_help')}>
      <form className="auth-form" onSubmit={(event) => void onSubmit(event)}>
        <div className="field">
          <label htmlFor="pin">{t('auth.pin_label')}</label>
          <input
            id="pin"
            type="password"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            autoComplete="new-password"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="pin-confirm">{t('auth.pin_confirm_label')}</label>
          <input
            id="pin-confirm"
            type="password"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            required
          />
        </div>
        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn-block" disabled={submitting}>
          {t('auth.pin_submit')}
        </button>
      </form>
    </AuthLayout>
  );
}
