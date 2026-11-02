/**
 * Socle des écrans d'administration en ligne (RP-1 : ECR-ADM-06, ECR-ADM-07, ECR-AUD-01).
 *
 * - `useAdminRead` : lecture d'un chemin de l'API, relue au changement de `reloadKey`, au retour du réseau
 *   et quand l'onglet redevient visible (`useOnlineRead`).
 * - `useOnlineCommands` : envoi d'une commande par la file d'envoi (principe O1, un seul chemin d'écriture),
 *   même patron que les appareils et les comptes : une commande à la fois, la suivante attend la réponse
 *   définitive de la précédente, y compris après un retour sur l'écran.
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useOnline } from '../../platform/useOnline.js';
import { isEffectivelyOnline } from '../../platform/connectivity.js';
import { getDb } from '../../storage/db.js';
import { useAuth } from '../auth/AuthContext.js';
import {
  readPages,
  readPath,
  useOnlineRead,
  useRefreshOnVisible,
  type Pages,
} from '../sales/online-read.js';
import {
  isBlockingWait,
  lastWaitingCommand,
  phaseOf,
  saveErrorKey,
  submitCommand,
  waitingCommands,
  waitingIds,
  type CommandPrefix,
} from '../sales/submit.js';

/** Lecture JSON d'un chemin de l'API ; `path` nul : rien à lire. */
export function useAdminRead<T>(path: string | null, reloadKey: string) {
  const online = useOnline();
  const read = useOnlineRead<T>(online ? path : null, (key) => readPath<T>(key), online, reloadKey);
  useRefreshOnVisible(read.retry);
  return read;
}

/** Liste paginée de l'API (`next_cursor`), lue sur au plus `maxPages` pages ; `field` : clé du tableau. */
export function useAdminPages<T>(
  path: string | null,
  field: string,
  reloadKey: string,
  maxPages = 5,
) {
  const online = useOnline();
  const read = useOnlineRead<Pages<T>>(
    online ? path : null,
    (key) => readPages<T>([key], field, maxPages),
    online,
    reloadKey,
  );
  useRefreshOnVisible(read.retry);
  return read;
}

export interface AdminCommand {
  readonly commandType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

/** Commandes d'administration de l'écran, par préfixe de type (`organization.`, `approvals.policy.`…). */
export function useOnlineCommands(prefix: CommandPrefix) {
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const outbox = useLiveQuery(() => getDb().outbox.orderBy('device_seq').toArray(), []) ?? [];
  const [last, setLast] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const lastCommand = outbox.find((command) => command.command_id === last);
  const waiting =
    (last !== undefined && (lastCommand === undefined || isBlockingWait(lastCommand, outbox))) ||
    waitingCommands(outbox, prefix, userId).length > 0;
  const adopt = last ? undefined : lastWaitingCommand(outbox, prefix, userId);
  if (adopt) setLast(adopt.command_id);
  /** Change à chaque réponse du serveur : les lectures de l'écran s'y relisent. */
  const reloadKey = `${last ?? ''}:${lastCommand ? phaseOf(lastCommand) : ''}|${waitingIds(outbox, prefix, userId)}`;

  /** `true` : la commande est enregistrée (le résultat se suit par `CommandResult`). */
  const send = async (command: AdminCommand, extraBlocked = false): Promise<boolean> => {
    if (!userId || busy || waiting || extraBlocked) return false;
    // Écran en ligne seulement : une connexion perdue entre l'affichage et l'envoi ne met rien en file,
    // sinon la commande serait rejouée au retour du réseau, longtemps après le geste de l'utilisateur.
    if (!isEffectivelyOnline()) {
      setSaveError('admin_config.offline_refused');
      return false;
    }
    setBusy(true);
    setSaveError(null);
    try {
      const sent = await submitCommand({ authorUserId: userId, ...command });
      setLast(sent.command_id);
      return true;
    } catch (error) {
      setSaveError(saveErrorKey(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return {
    userId,
    last,
    waiting,
    busy,
    blocked: busy || waiting,
    saveError,
    reloadKey,
    send,
  };
}
