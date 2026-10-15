/**
 * Affichages des photos (MP-10) : état d'envoi des photos d'un document, photo jointe après coup,
 * photo lue sur le serveur pour le valideur (AV-286).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getDb } from '../../storage/db.js';
import { fetchAttachmentContent } from '../../sync/attachment-content.js';
import { saveErrorKey } from '../sales/submit.js';
import {
  hasUsablePhoto,
  submitAttachment,
  useOwnerPhotos,
  type PhotoTarget,
} from './attachments.js';
import type { PreparedPhoto } from './photo.js';
import { PhotoField } from './PhotoField.js';

/** État des photos d'un document : sur ce téléphone, en cours d'envoi, reçue, refusée. */
export function PhotoStatus({
  ownerId,
  userId,
}: {
  readonly ownerId: string;
  readonly userId?: string;
}) {
  const { t } = useTranslation();
  const photos = useOwnerPhotos(ownerId, userId);
  if (!photos || photos.length === 0) return null;
  return (
    <ul className="photo-status">
      {photos.map((photo) => (
        <li key={photo.id} className={photo.state === 'REFUSED' ? 'text-warn' : 'home-muted'}>
          {t(`photo.state.${photo.state}`, { percent: photo.percent })}
        </li>
      ))}
    </ul>
  );
}

/**
 * Joindre une photo à un document déjà enregistré (photo manquante d'une réception, mortalité qui
 * attend la sienne). Proposé tant qu'aucune photo du document n'est reçue ou en route.
 */
export function AttachPhoto({
  userId,
  target,
  label,
}: {
  readonly userId: string;
  readonly target: PhotoTarget & { readonly ownerId: string };
  readonly label: string;
}) {
  const { t } = useTranslation();
  const photos = useOwnerPhotos(target.ownerId, userId);
  const [open, setOpen] = useState(false);
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (photos === undefined) return null;
  if (hasUsablePhoto(photos)) return <PhotoStatus ownerId={target.ownerId} userId={userId} />;
  if (!open) {
    return (
      <>
        <PhotoStatus ownerId={target.ownerId} userId={userId} />
        <button type="button" className="secondary" onClick={() => setOpen(true)}>
          {label}
        </button>
      </>
    );
  }
  const send = async () => {
    if (!photo || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await submitAttachment({ authorUserId: userId, photo, target });
      setPhoto(null);
      setOpen(false);
    } catch (caught) {
      setError(saveErrorKey(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="attach-photo">
      <PhotoField label={label} value={photo} onChange={setPhoto} onBusyChange={setPreparing} />
      {error ? (
        <p className="alert alert-error" role="alert">
          {t(error)}
        </p>
      ) : null}
      <div className="result-actions">
        <button type="button" disabled={!photo || preparing || busy} onClick={() => void send()}>
          {t('photo.send')}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setPhoto(null);
            setOpen(false);
          }}
        >
          {t('photo.cancel')}
        </button>
      </div>
    </div>
  );
}

/**
 * Photo lue sur le serveur, affichée sur demande (valideur, Resp. achats ; AV-286). `label` : nom du
 * bouton propre au document (« Voir le justificatif de DEP-… »), « Voir la photo » à défaut.
 */
export function ServerPhoto({
  attachmentId,
  alt,
  label,
}: {
  readonly attachmentId: string;
  readonly alt: string;
  readonly label?: string;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [url, setUrl] = useState<string>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    if (!shown) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    fetchAttachmentContent(getDb(), attachmentId)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          objectUrl = URL.createObjectURL(result.blob);
          setUrl(objectUrl);
        } else {
          setFailure(result.reason);
        }
      })
      .catch(() => {
        if (!cancelled) setFailure('ERROR');
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [shown, attachmentId, attempt]);

  if (!shown) {
    return (
      <button type="button" className="secondary" onClick={() => setShown(true)}>
        {label ?? t('photo.view')}
      </button>
    );
  }
  if (failure) {
    return (
      <p className="text-warn">
        {t(`photo.view_error.${failure}`)}{' '}
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setFailure(undefined);
            setAttempt((value) => value + 1);
          }}
        >
          {t('photo.retry')}
        </button>
      </p>
    );
  }
  if (!url) {
    return (
      <p className="home-muted" role="status">
        {t('photo.loading')}
      </p>
    );
  }
  return <img className="server-photo" src={url} alt={alt} />;
}
