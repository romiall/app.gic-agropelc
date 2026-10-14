/**
 * Champ « photo » d'un formulaire (MP-10, UX-07 : la capture est intégrée au formulaire) : prendre
 * une photo (caméra arrière) ou choisir une image ; la photo est recodée sur l'appareil (ADR-012),
 * puis gardée jusqu'à l'enregistrement de l'opération. Jamais bloquante : une opération part sans
 * photo si l'image est illisible ou si l'espace des photos en attente est plein (AV-291).
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clock } from '../../platform/composition.js';
import { fitsPendingBudget } from './attachments.js';
import { browserPhotoCodec, PhotoError, preparePhoto, type PreparedPhoto } from './photo.js';

interface PhotoFieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly value: PreparedPhoto | null;
  readonly onChange: (photo: PreparedPhoto | null) => void;
  /** Recodage en cours : l'écran attend avant d'enregistrer l'opération. */
  readonly onBusyChange?: (busy: boolean) => void;
}

type FieldError = 'UNSUPPORTED' | 'TOO_LARGE' | 'BUDGET';

export function PhotoField({ label, hint, value, onChange, onBusyChange }: PhotoFieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FieldError>();

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError(undefined);
    setBusy(true);
    onBusyChange?.(true);
    try {
      const photo = await preparePhoto(file, browserPhotoCodec, () => clock.now());
      if (!(await fitsPendingBudget(photo.sizeBytes))) {
        setError('BUDGET');
        onChange(null);
        return;
      }
      onChange(photo);
    } catch (caught) {
      setError(caught instanceof PhotoError ? caught.code : 'UNSUPPORTED');
      onChange(null);
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  return (
    <fieldset className="field photo-field" aria-describedby={hint ? `${id}-hint` : undefined}>
      <legend>{label}</legend>
      {hint ? (
        <p id={`${id}-hint`} className="home-muted">
          {hint}
        </p>
      ) : null}
      {value ? (
        <p className="photo-ready" role="status">
          {t('photo.ready', { size: Math.max(1, Math.round(value.sizeBytes / 1024)) })}{' '}
          <button type="button" className="secondary" onClick={() => onChange(null)}>
            {t('photo.remove')}
          </button>
        </p>
      ) : (
        <div className="photo-actions">
          <label className="action action-compact">
            <span className="action-label">{t('photo.take')}</span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="visually-hidden"
              aria-label={t('photo.take')}
              disabled={busy}
              onChange={(event) => {
                void choose(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>
          <label className="action action-compact">
            <span className="action-label">{t('photo.choose')}</span>
            <input
              type="file"
              accept="image/*"
              className="visually-hidden"
              aria-label={t('photo.choose')}
              disabled={busy}
              onChange={(event) => {
                void choose(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>
        </div>
      )}
      {busy ? (
        <p className="home-muted" role="status">
          {t('photo.preparing')}
        </p>
      ) : null}
      {error ? (
        <p className="error-message" role="alert">
          {t(`photo.error.${error}`)}
        </p>
      ) : null}
    </fieldset>
  );
}
