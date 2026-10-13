/**
 * ECR-SYN-01 « État de synchronisation et opérations en attente » : liste l'outbox, un bouton
 * de synchronisation manuelle, et un diagnostic qui exerce tout le pipeline (`organization.
 * setting.set`, la commande de démonstration désignée par le plan de développement §3) — en
 * ligne comme hors ligne, pour prouver le trajet complet outbox → push → pipeline → audit.
 * `org.settings.manage` est requis côté serveur (RBAC) : un utilisateur sans ce droit voit sa
 * commande de test rejetée avec le motif exact (BR-SYN-009), ce qui est déjà la démonstration
 * utile pour lui.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getDb } from '../../storage/db.js';
import { clock, idGenerator } from '../../platform/composition.js';
import { isEffectivelyOnline } from '../../platform/connectivity.js';
import { enqueueCommand } from '../../sync/outbox.js';
import { useAuth } from '../auth/AuthContext.js';
import { awaitsDeviceApproval } from '../sales/pending.js';
import { saveErrorKey } from '../sales/submit.js';
import { getSyncEngine } from './sync-engine-instance.js';
import { useSyncStatus } from './useSyncStatus.js';

export function SyncScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const status = useSyncStatus();
  const [syncing, setSyncing] = useState(false);
  const [diagnosticMessage, setDiagnosticMessage] = useState<string>();

  if (state.status !== 'unlocked' || !status) return null;

  const forceSync = async () => {
    setSyncing(true);
    try {
      await getSyncEngine()?.trigger();
    } finally {
      setSyncing(false);
    }
  };

  const runDiagnostic = async () => {
    let command;
    try {
      command = await enqueueCommand(
        getDb(),
        { clock, idGenerator },
        {
          authorUserId: state.userId,
          commandType: 'organization.setting.set',
          commandVersion: 1,
          aggregateType: 'SETTING',
          payload: {
            key: `diagnostic.pwa.${idGenerator.newId()}`,
            value: clock.now().toISOString(),
            scopeType: 'GLOBAL',
            isClientVisible: true,
            reason: 'Diagnostic P0-14 : vérification du pipeline depuis la PWA.',
          },
          capturedOffline: !isEffectivelyOnline(),
        },
      );
    } catch (error) {
      // Lecture seule (AV-009) : le diagnostic est une opération comme une autre, refusée.
      setDiagnosticMessage(t(saveErrorKey(error)));
      return;
    }
    setDiagnosticMessage(
      t('sync.diagnostic_enqueued', { status: t(`sync.status.${command.status}`) }),
    );
    void getSyncEngine()?.trigger();
  };

  return (
    <section>
      <h1>{t('sync.screen_title')}</h1>
      <button type="button" onClick={() => void forceSync()} disabled={syncing}>
        {syncing ? t('sync.syncing') : t('sync.force_sync')}
      </button>

      {status.pending.some(awaitsDeviceApproval) ? (
        <p className="home-banner" role="status">
          {t('sync.device_pending_notice')}
        </p>
      ) : null}
      <h2>{t('sync.pending_operations')}</h2>
      {status.pending.length === 0 ? (
        <p>{t('sync.no_pending')}</p>
      ) : (
        <ul className="outbox-list">
          {status.pending.map((command) => (
            <li key={command.command_id}>
              {command.command_type} — {t(`sync.status.${command.status}`)}
            </li>
          ))}
        </ul>
      )}

      {status.attention.length > 0 && (
        <>
          <h2>{t('sync.attention_operations')}</h2>
          <ul className="outbox-list">
            {status.attention.map((command) => (
              <li key={command.command_id}>
                {command.command_type} — {t(`sync.status.${command.status}`)}
                {command.last_error ? ` : ${command.last_error.message_fr}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>{t('sync.diagnostic_title')}</h2>
      <p>{t('sync.diagnostic_help')}</p>
      <button type="button" className="secondary" onClick={() => void runDiagnostic()}>
        {t('sync.diagnostic_submit')}
      </button>
      {diagnosticMessage && <p>{diagnosticMessage}</p>}
    </section>
  );
}
