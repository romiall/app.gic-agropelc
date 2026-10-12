/**
 * Envoi d'une opération de vente : un seul chemin d'écriture, l'outbox (principe O1), en ligne comme
 * hors ligne. La commande est enregistrée sur l'appareil, puis le moteur de synchronisation est
 * relancé ; l'écran suit le statut de la commande dans l'outbox (UX-05 : retour immédiat).
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { clock, idGenerator } from '../../platform/composition.js';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import { enqueueCommand, REPEATED_FAILURE_ATTEMPTS, type EnqueueInput } from '../../sync/outbox.js';
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
      isBlockingWait(command),
  );
}

/**
 * Dernière commande de l'utilisateur d'un domaine encore sans réponse définitive, échec répété
 * compris : son résultat reste affiché au retour sur l'écran.
 */
export function lastWaitingCommand(
  outbox: readonly OutboxCommand[],
  prefix: string,
  userId: string | undefined,
): OutboxCommand | undefined {
  if (!userId) return undefined;
  return outbox
    .filter(
      (command) =>
        command.command_type.startsWith(prefix) &&
        command.author_user_id === userId &&
        phaseOf(command) === 'WAITING',
    )
    .at(-1);
}

/**
 * Renvois consécutifs `SERVER_BUSY` (erreur du serveur, le plus souvent une contrainte de la base qui
 * lève une exception, S-29 à S-31, S-37) au-delà desquels une commande en attente est tenue pour en
 * échec répété. Les coupures réseau ne comptent pas (`busy_retries`, tenu par `push.ts`).
 */
export { REPEATED_FAILURE_ATTEMPTS };

/** Commande que le serveur renvoie sans l'appliquer (`RETRY_LATER`, `SERVER_BUSY`) à chaque essai. */
export function inRepeatedFailure(
  command: Pick<OutboxCommand, 'status' | 'busy_retries'>,
): boolean {
  return phaseOf(command) === 'WAITING' && (command.busy_retries ?? 0) >= REPEATED_FAILURE_ATTEMPTS;
}

/**
 * Identifiants des commandes de l'utilisateur encore sans réponse définitive pour un préfixe, échec
 * répété compris : ils entrent dans la clé de relecture d'un écran, pour que la réponse tardive d'une
 * commande en échec répété (qui ne bloque plus l'écran) relise aussi ses listes.
 */
export function waitingIds(
  outbox: readonly OutboxCommand[],
  prefix: string,
  userId: string | undefined,
): string {
  if (!userId) return '';
  return outbox
    .filter(
      (command) =>
        command.command_type.startsWith(prefix) &&
        command.author_user_id === userId &&
        phaseOf(command) === 'WAITING',
    )
    .map((command) => command.command_id)
    .join(',');
}

/**
 * Attente qui bloque l'opération suivante d'un écran : sans réponse définitive, hors échec répété
 * (sinon l'écran resterait figé à vie ; la commande est toujours réessayée et son résultat l'annonce).
 */
export function isBlockingWait(command: Pick<OutboxCommand, 'status' | 'busy_retries'>): boolean {
  return phaseOf(command) === 'WAITING' && !inRepeatedFailure(command);
}

/** Message du serveur pour une commande rejetée (`error.message_fr`), s'il existe. */
export function rejectionMessage(command: Pick<OutboxCommand, 'last_error'>): string | null {
  return command.last_error?.message_fr || command.last_error?.code || null;
}
