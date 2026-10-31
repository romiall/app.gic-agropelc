/**
 * ECR-SYN-01 « État de synchronisation et opérations en attente » : liste l'outbox et un bouton de
 * synchronisation manuelle.
 *
 * MP-09 (AV-250, décision du porteur du 13/10/2026) : le diagnostic « Tester la synchronisation » est
 * retiré. Il enregistrait un vrai paramètre système (`organization.setting.set`), immuable une fois
 * enregistré (BR-ADM-015), et polluait définitivement les paramètres à chaque essai.
 *
 * Refonte (ADR-049, lot L9) : en-tête de page avec l'action de synchronisation, bandeaux pour l'approbation
 * de l'appareil et les photos, opérations en listes à icônes, explication du classement repliée. Le titre
 * « Opérations à examiner » reste le parent direct de sa liste (les essais la lisent par lui).
 */
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { Banner, Button, Icon, List, ListRow, PageHeader } from '../../components/ui/index.js';
import { getDb } from '../../storage/db.js';
import { acknowledgeCommand } from '../../sync/outbox.js';
import { pendingAttachments } from '../../sync/attachment-upload.js';
import { refusedPhotosCount } from '../attachments/attachments.js';
import { useAuth } from '../auth/AuthContext.js';
import { awaitsDeviceApproval } from '../sales/pending.js';
import { HelpDisclosure } from '../users/HelpDisclosure.js';
import { operationLabel } from './operation-label.js';
import { getSyncEngine } from './sync-engine-instance.js';
import { useSyncStatus } from './useSyncStatus.js';
import '../users/admin.css';

/** Groupe d'opérations sous son titre : le titre est le parent direct de ce qui le suit. */
function Block({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const id = useId();
  return (
    <section className="adm-block" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

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
    <section className="sale adm-screen">
      <PageHeader
        title={t('sync.screen_title')}
        actions={
          <Button icon="sync" loading={syncing} onClick={() => void forceSync()}>
            {syncing ? t('sync.syncing') : t('sync.force_sync')}
          </Button>
        }
      />

      <div className="adm-notices">
        {/* Opérations de l'utilisateur seulement : sur une tablette partagée, celles d'un autre
            attendent sa reconnexion, pas l'approbation de l'appareil. */}
        {status.pending.some(
          (command) => command.author_user_id === state.userId && awaitsDeviceApproval(command),
        ) ? (
          <Banner tone="warn" role="status">
            {t('sync.device_pending_notice')}
          </Banner>
        ) : null}
        {photos && photos.count > 0 ? (
          <Banner tone="info" role="status">
            {t('sync.photos_pending', {
              count: photos.count,
              size: Math.max(1, Math.round(photos.bytes / 1024)),
            })}
          </Banner>
        ) : null}
        {refusedPhotos && refusedPhotos > 0 ? (
          <Banner tone="warn" role="status">
            {t('sync.photos_refused', { count: refusedPhotos })}
          </Banner>
        ) : null}
      </div>

      <Block title={t('sync.pending_operations')}>
        {status.pending.length === 0 ? (
          <p className="adm-ok">
            <Icon name="check-circle" size={18} />
            {t('sync.no_pending')}
          </p>
        ) : (
          <List>
            {status.pending.map((command) => (
              <ListRow
                key={command.command_id}
                icon="clock"
                iconTone="info"
                title={`${operationLabel(t, command.command_type)} — ${t(`sync.status.${command.status}`)}`}
              />
            ))}
          </List>
        )}
      </Block>

      {status.attention.length > 0 && (
        <Block title={t('sync.attention_operations')}>
          <HelpDisclosure title={t('sync.help_title')}>
            <p>{t('sync.acknowledge_help')}</p>
          </HelpDisclosure>
          <List>
            {status.attention.map((command) => {
              const label = operationLabel(t, command.command_type);
              return (
                <ListRow
                  key={command.command_id}
                  icon="alert"
                  iconTone={command.status === 'REJECTED' ? 'bad' : 'warn'}
                  title={`${label} — ${t(`sync.status.${command.status}`)}${
                    command.last_error ? ` : ${command.last_error.message_fr}` : ''
                  }`}
                  subtitle={
                    command.status === 'CONFLICT' ? t('sync.acknowledged_conflict') : undefined
                  }
                  badge={
                    // Sur une tablette partagée, chacun classe ses propres opérations.
                    command.author_user_id === state.userId ? (
                      <Button
                        variant="tonal"
                        size="sm"
                        aria-label={t('sync.acknowledge_label', { operation: label })}
                        onClick={() => void acknowledgeCommand(getDb(), command.command_id)}
                      >
                        {t('sync.acknowledge')}
                      </Button>
                    ) : undefined
                  }
                />
              );
            })}
          </List>
        </Block>
      )}
    </section>
  );
}
