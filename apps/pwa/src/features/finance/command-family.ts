/**
 * Opérations d'un écran de gestion (factures, paiements fournisseurs : P8E-05, P8E-06) suivies dans
 * l'outbox : leur clé de relecture fait relire les listes et la saisie à chaque opération nouvelle et à
 * chaque réponse, même immédiate ou tardive (revue de P8E-05).
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import { phaseOf } from '../sales/submit.js';

/** Commandes de l'outbox dont le type commence par `prefix`, dans l'ordre d'enregistrement. */
export function useCommandFamily(prefix: string): readonly OutboxCommand[] {
  return (
    useLiveQuery(
      () =>
        getDb()
          .outbox.orderBy('device_seq')
          .filter((command) => command.command_type.startsWith(prefix))
          .toArray(),
      [prefix],
    ) ?? []
  );
}

/** Chaque opération de l'utilisateur et sa phase. */
export function familyReloadKey(
  family: readonly OutboxCommand[],
  userId: string | undefined,
): string {
  return family
    .filter((command) => command.author_user_id === userId)
    .map((command) => `${command.command_id}:${phaseOf(command)}`)
    .join(',');
}
