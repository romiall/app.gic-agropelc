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
import { OfflineReadOnlyError } from '../sync/autonomy.js';
import { behindDeviceApproval } from './pending.js';

/**
 * Enregistre une opération dans l'outbox et relance l'envoi. En lecture seule (AV-009), elle est
 * refusée par `enqueueCommand` (`OfflineReadOnlyError`) et rien n'est enregistré.
 */
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

/**
 * Message d'un échec d'enregistrement : lecture seule (autonomie dépassée, AV-009) ou échec de la base
 * locale.
 */
export function saveErrorKey(error: unknown): string {
  return error instanceof OfflineReadOnlyError
    ? 'sync.read_only_refused'
    : 'sales.error_local_save';
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
      isBlockingWait(command, outbox),
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
 * Commande qui retient la suite de son auteur : en échec répété, mais pas encore déclarée bloquée par
 * le serveur (`COMMAND_STALLED` ne retient plus la suite, AV-217).
 */
function holdsFollowing(
  command: Pick<OutboxCommand, 'status' | 'busy_retries' | 'last_error'>,
): boolean {
  return inRepeatedFailure(command) && command.last_error?.code !== 'COMMAND_STALLED';
}

type Queued = Pick<
  OutboxCommand,
  'status' | 'busy_retries' | 'last_error' | 'author_user_id' | 'device_seq'
>;

/**
 * Commande plus ancienne du même auteur, en échec répété, qui retient celle-ci : le serveur suspend la
 * suite de son lot (`PRECEDING_COMMAND_PENDING`) tant qu'elle ne passe pas ou n'est pas déclarée
 * bloquée (au plus `sync.retry_hold_minutes`).
 */
export function heldBehindFailure<T extends Queued>(
  command: Pick<OutboxCommand, 'status' | 'author_user_id' | 'device_seq'>,
  outbox: readonly T[],
): T | undefined {
  if (phaseOf(command) !== 'WAITING') return undefined;
  return outbox.find(
    (candidate) =>
      candidate.author_user_id === command.author_user_id &&
      candidate.device_seq < command.device_seq &&
      holdsFollowing(candidate),
  );
}

/** Commande qui attend l'approbation de l'appareil, elle-même ou derrière une plus ancienne (AV-228). */
export function useBehindDeviceApproval(command: OutboxCommand | undefined): boolean {
  return (
    useLiveQuery(async () => {
      if (!command || phaseOf(command) !== 'WAITING') return false;
      const earlier = await getDb().outbox.where('device_seq').below(command.device_seq).toArray();
      return behindDeviceApproval(command, earlier);
    }, [
      command?.command_id,
      command?.status,
      command?.device_seq,
      command?.author_user_id,
      command?.last_error?.code,
    ]) ?? false
  );
}

/** Commande en échec répété qui retient celle-ci, suivie en direct (voir `heldBehindFailure`). */
export function useHeldBehindFailure(
  command: OutboxCommand | undefined,
): OutboxCommand | undefined {
  return useLiveQuery(async () => {
    if (!command || phaseOf(command) !== 'WAITING') return undefined;
    const earlier = await getDb().outbox.where('device_seq').below(command.device_seq).toArray();
    return heldBehindFailure(command, earlier);
  }, [command?.command_id, command?.status, command?.device_seq, command?.author_user_id]);
}

/**
 * Attente qui bloque l'opération suivante d'un écran : sans réponse définitive, hors échec répété
 * (sinon l'écran resterait figé à vie ; la commande est toujours réessayée et son résultat l'annonce),
 * et hors commande retenue derrière une commande plus ancienne en échec répété (`outbox` fourni) : elle
 * attendrait jusqu'à ce que le serveur déclare celle-ci bloquée.
 */
export function isBlockingWait(
  command: Pick<OutboxCommand, 'status' | 'busy_retries' | 'author_user_id' | 'device_seq'>,
  outbox?: readonly Queued[],
): boolean {
  return (
    phaseOf(command) === 'WAITING' &&
    !inRepeatedFailure(command) &&
    !(outbox && heldBehindFailure(command, outbox))
  );
}

/** Message du serveur pour une commande rejetée (`error.message_fr`), s'il existe. */
export function rejectionMessage(command: Pick<OutboxCommand, 'last_error'>): string | null {
  return command.last_error?.message_fr || command.last_error?.code || null;
}
