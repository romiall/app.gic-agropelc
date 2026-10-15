/**
 * ECR-SYN-01 « État de synchronisation et opérations en attente » : liste l'outbox et un bouton de
 * synchronisation manuelle.
 *
 * MP-09 (AV-250, décision du porteur du 13/10/2026) : le diagnostic « Tester la synchronisation » est
 * retiré. Il enregistrait un vrai paramètre système (`organization.setting.set`), immuable une fois
 * enregistré (BR-ADM-015), et polluait définitivement les paramètres à chaque essai.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { getDb } from '../../storage/db.js';
import { acknowledgeCommand } from '../../sync/outbox.js';
import { pendingAttachments } from '../../sync/attachment-upload.js';
import { refusedPhotosCount } from '../attachments/attachments.js';
import { useAuth } from '../auth/AuthContext.js';
import { awaitsDeviceApproval } from '../sales/pending.js';
import { operationLabel } from './operation-label.js';
import { getSyncEngine } from './sync-engine-instance.js';
import { useSyncStatus } from './useSyncStatus.js';

export function SyncScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const status = useSyncStatus();
  const [syncing, setSyncing] = useState(false);
  // Photos de l'utilisateur encore à envoyer (MP-10) : elles partent après les opérations.
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const photos = useLiveQuery(() => pendingAttachments(getDb(), userId), [userId]);
  const refusedPhotos = useLiveQuery(() => refusedPhotosCount(userId), [userId]);

  if (state.status !== 'unlocked' || !status) return null;

  const forceSync = async () => {
    setSyncing(true);
    try {
      await getSyncEngine()?.trigger();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <section>
      <h1>{t('sync.screen_title')}</h1>
      <button type="button" onClick={() => void forceSync()} disabled={syncing}>
        {syncing ? t('sync.syncing') : t('sync.force_sync')}
      </button>

      {/* Opérations de l'utilisateur seulement : sur une tablette partagée, celles d'un autre
          attendent sa reconnexion, pas l'approbation de l'appareil. */}
      {status.pending.some(
        (command) => command.author_user_id === state.userId && awaitsDeviceApproval(command),
      ) ? (
        <p className="home-banner" role="status">
          {t('sync.device_pending_notice')}
        </p>
      ) : null}
      {photos && photos.count > 0 ? (
        <p className="home-muted">
          {t('sync.photos_pending', {
            count: photos.count,
            size: Math.max(1, Math.round(photos.bytes / 1024)),
          })}
        </p>
      ) : null}
      {refusedPhotos && refusedPhotos > 0 ? (
        <p className="text-warn">{t('sync.photos_refused', { count: refusedPhotos })}</p>
      ) : null}
      <h2>{t('sync.pending_operations')}</h2>
      {status.pending.length === 0 ? (
        <p>{t('sync.no_pending')}</p>
      ) : (
        <ul className="outbox-list">
          {status.pending.map((command) => (
            <li key={command.command_id}>
              {operationLabel(t, command.command_type)} — {t(`sync.status.${command.status}`)}
            </li>
          ))}
        </ul>
      )}

      {status.attention.length > 0 && (
        <>
          <h2>{t('sync.attention_operations')}</h2>
          <p className="home-muted">{t('sync.acknowledge_help')}</p>
          <ul className="outbox-list">
            {status.attention.map((command) => {
              const label = operationLabel(t, command.command_type);
              return (
                <li key={command.command_id}>
                  {label} — {t(`sync.status.${command.status}`)}
                  {command.last_error ? ` : ${command.last_error.message_fr}` : ''}
                  {command.status === 'CONFLICT' ? (
                    <small> {t('sync.acknowledged_conflict')}</small>
                  ) : null}
                  {/* Sur une tablette partagée, chacun classe ses propres opérations. */}
                  {command.author_user_id === state.userId ? (
                    <button
                      type="button"
                      className="secondary"
                      aria-label={t('sync.acknowledge_label', { operation: label })}
                      onClick={() => void acknowledgeCommand(getDb(), command.command_id)}
                    >
                      {t('sync.acknowledge')}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
