/**
 * Affichages des photos (MP-10) : état d'envoi des photos d'un document, photo jointe après coup,
 * photo lue sur le serveur pour le valideur (AV-286).
 *
 * Refonte (ADR-049, lot L9) : boutons teintés avec icône, anomalies en bandeau avec « Réessayer » ;
 * les textes, rôles et noms accessibles ne changent pas.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner, Button } from '../../components/ui/index.js';
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
import './attachments.css';

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
    <ul className="ph-status">
      {photos.map((photo) => (
        <li key={photo.id} className={photo.state === 'REFUSED' ? 'ph-state is-warn' : 'ph-state'}>
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
      <div className="ph-attach">
        <PhotoStatus ownerId={target.ownerId} userId={userId} />
        <Button variant="tonal" size="sm" icon="camera" onClick={() => setOpen(true)}>
          {label}
        </Button>
      </div>
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
    <div className="ph-attach">
      <PhotoField label={label} value={photo} onChange={setPhoto} onBusyChange={setPreparing} />
      {error ? <Banner tone="bad">{t(error)}</Banner> : null}
      <div className="ph-buttons">
        <Button disabled={!photo || preparing || busy} onClick={() => void send()}>
          {t('photo.send')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setPhoto(null);
            setOpen(false);
          }}
        >
          {t('photo.cancel')}
        </Button>
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
      <Button variant="tonal" size="sm" icon="eye" onClick={() => setShown(true)}>
        {label ?? t('photo.view')}
      </Button>
    );
  }
  if (failure) {
    return (
      <Banner
        tone="warn"
        role="status"
        action={
          <Button
            variant="tonal"
            size="sm"
            onClick={() => {
              setFailure(undefined);
              setAttempt((value) => value + 1);
            }}
          >
            {t('photo.retry')}
          </Button>
        }
      >
        {t(`photo.view_error.${failure}`)}
      </Banner>
    );
  }
  if (!url) {
    return (
      <p className="ph-hint" role="status">
        {t('photo.loading')}
      </p>
    );
  }
  return <img className="ph-image" src={url} alt={alt} />;
}
