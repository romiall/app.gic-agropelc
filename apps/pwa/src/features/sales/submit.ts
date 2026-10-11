/**
 * Envoi d'une opération de vente : un seul chemin d'écriture, l'outbox (principe O1), en ligne comme
 * hors ligne. La commande est enregistrée sur l'appareil, puis le moteur de synchronisation est
 * relancé ; l'écran suit le statut de la commande dans l'outbox (UX-05 : retour immédiat).
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { clock, idGenerator } from '../../platform/composition.js';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import { enqueueCommand, type EnqueueInput } from '../../sync/outbox.js';
import { getSyncEngine } from '../sync/sync-engine-instance.js';
import { isEffectivelyOnline } from '../../platform/connectivity.js';

export async function submitCommand(
  input: Omit<EnqueueInput, 'capturedOffline' | 'commandVersion'> & {
    readonly commandVersion?: number;
  },
): Promise<OutboxCommand> {
  const command = await enqueueCommand(
    getDb(),
    { clock, idGenerator },
    { commandVersion: 1, ...input, capturedOffline: !isEffectivelyOnline() },
  );
  void getSyncEngine()?.trigger();
  return command;
}

/** Commande de l'outbox suivie en direct (statut, références du serveur, erreur). */
export function useOutboxCommand(commandId: string | undefined): OutboxCommand | undefined {
  return useLiveQuery(
    async () => (commandId ? getDb().outbox.get(commandId) : undefined),
    [commandId],
  );
}

export type CommandPhase = 'WAITING' | 'DONE' | 'WARNING' | 'CONFLICT' | 'REJECTED';

export function phaseOf(command: Pick<OutboxCommand, 'status'>): CommandPhase {
  switch (command.status) {
    case 'SYNCED':
      return 'DONE';
    case 'SYNCED_WITH_WARNING':
      return 'WARNING';
    case 'CONFLICT':
      return 'CONFLICT';
    case 'REJECTED':
      return 'REJECTED';
    default:
      return 'WAITING';
  }
}

/**
 * Commandes de l'utilisateur d'un domaine (préfixe du type) encore sans réponse définitive, dans
 * l'ordre de saisie : un écran en ligne attend leur réponse avant l'opération suivante, même après un
 * retour sur l'écran (l'état local de la dernière opération est alors perdu).
 */
export function waitingCommands(
  outbox: readonly OutboxCommand[],
  prefix: string,
  userId: string | undefined,
): OutboxCommand[] {
  if (!userId) return [];
  return outbox.filter(
    (command) =>
      command.command_type.startsWith(prefix) &&
      command.author_user_id === userId &&
      phaseOf(command) === 'WAITING',
  );
}

/** Message du serveur pour une commande rejetée (`error.message_fr`), s'il existe. */
export function rejectionMessage(command: Pick<OutboxCommand, 'last_error'>): string | null {
  return command.last_error?.message_fr || command.last_error?.code || null;
}
