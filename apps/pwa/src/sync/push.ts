/**
 * Vidage de l'outbox vers `POST /api/v1/sync/push` (06-offline-sync/02-synchronisation.md
 * §3). Un seul lot par appel (≤ 50 commandes, `pushRequestSchema`) ; l'appelant (`engine.ts`)
 * boucle tant qu'il reste des commandes en attente.
 */
import type { PushRequest, PushResponse } from '@gic/contracts';
import { deviceStateAfterResult, syncResultStatusSchema } from '@gic/contracts';
import { MAX_DECLARED_SKIPS_PER_PUSH, type Clock, type IdGenerator } from '@gic/domain';
import type { GicDatabase, PushRefusal } from '../storage/db.js';
import { pendingAfterBatch, pendingOutbox, REPEATED_FAILURE_ATTEMPTS } from './outbox.js';
import { authorizedRequest } from './api-client.js';
import { checkEnvelope, LOCAL_REFUSAL_PREFIX, toEnvelope } from './envelope.js';

export type PushCycleResult =
  | { readonly outcome: 'NOTHING_TO_PUSH' }
  /**
   * `count` : résultats reçus ; `settled` : commandes qui ont reçu une réponse définitive (appliquée,
   * en conflit ou refusée). Aucune (`RETRY_LATER` partout) : inutile de renvoyer aussitôt.
   */
  | {
      readonly outcome: 'PUSHED';
      readonly count: number;
      readonly settled: number;
      /** Commandes bloquées (`COMMAND_STALLED`) : renvoyées une fois par cycle (AV-217). */
      readonly stalled: readonly string[];
    }
  | { readonly outcome: 'OFFLINE' }
  /** Le serveur a répondu par une erreur HTTP : joignable, nouvel essai au prochain cycle. */
  | { readonly outcome: 'SERVER_ERROR' }
  | { readonly outcome: 'SESSION_INVALID' }
  /** La session n'est plus celle de l'utilisateur du moteur (relève) : rien n'est parti. */
  | { readonly outcome: 'SESSION_CHANGED' };

/** Délai d'envoi d'un lot (jusqu'à 50 commandes, chacune dans sa transaction côté serveur). */
export const PUSH_TIMEOUT_MS = 60_000;

/**
 * Après un envoi resté sans réponse, durée pendant laquelle un `SERVER_BUSY` peut signifier « en cours
 * de traitement » (le serveur tient la commande réclamée 120 s, `STALE_CLAIM_SECONDS`, DÉDUIT de
 * `command-pipeline.service.ts`) : il n'est pas compté comme un échec (S-45). Constante du protocole,
 * pas un seuil métier.
 */
export const IN_PROGRESS_GRACE_MS = 120_000;

/** Longueur maximale du motif du serveur conservé sur l'appareil. */
const REFUSAL_MESSAGE_MAX = 300;

/**
 * Ce que le serveur a répondu à un lot qu'il refuse en bloc (`{ error: { code, message, correlation_id } }`,
 * @gic/contracts `apiErrorSchema`), lu sans rien supposer : le corps peut manquer ou avoir une autre forme.
 */
function readRefusal(status: number, body: unknown, at: string): PushRefusal {
  const error =
    typeof body === 'object' && body !== null && 'error' in body
      ? (body as { error: unknown }).error
      : null;
  const field = (name: string): string | null => {
    if (typeof error !== 'object' || error === null) return null;
    const value = (error as Record<string, unknown>)[name];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  const message = field('message');
  return {
    at,
    status,
    code: field('code'),
    message: message === null ? null : message.slice(0, REFUSAL_MESSAGE_MAX),
    correlation_id: field('correlation_id'),
  };
}

/** Motif d'une commande refusée sur l'appareil parce qu'elle dépend d'une autre qui l'a été. */
const DEPENDENCY_REJECTED_MESSAGE =
  "Commande non envoyable, refusée sur l'appareil : elle dépend d'une commande refusée.";

/**
 * Refuse sur l'appareil les commandes dont l'enveloppe est invalide, et celles qui en dépendent (le serveur
 * ne recevrait jamais leur dépendance). Elles passent à `REJECTED` avec leur motif — elles ne sont ni
 * supprimées (BR-SYN-009 : visibles, « classables ») ni renvoyées —, ce qui libère le reste de la file.
 * Renvoie les identifiants refusés.
 */
async function rejectUnsendable(
  db: GicDatabase,
  invalid: ReadonlyMap<string, string>,
): Promise<ReadonlySet<string>> {
  const rejected = new Map(invalid);
  const waiting = await db.outbox.where('status').anyOf(['LOCAL_ONLY', 'PENDING_SYNC']).toArray();
  for (let grew = true; grew;) {
    grew = false;
    for (const command of waiting) {
      if (rejected.has(command.command_id)) continue;
      if (command.depends_on.some((dependency) => rejected.has(dependency))) {
        rejected.set(command.command_id, DEPENDENCY_REJECTED_MESSAGE);
        grew = true;
      }
    }
  }
  await db.transaction('rw', db.outbox, async () => {
    for (const [commandId, message_fr] of rejected) {
      await db.outbox.update(commandId, {
        status: 'REJECTED',
        busy_retries: 0,
        refused_locally: true,
        last_error: { code: 'VALIDATION_ERROR', message_fr },
      });
    }
  });
  return new Set(rejected.keys());
}

/**
 * Commandes refusées sur l'appareil dont le numéro n'a pas encore été déclaré au serveur (ADR-052, AV-507) : elles
 * n'atteindront jamais le serveur, dont le détecteur de trous de séquence (BR-SYN-003) y verrait sinon des commandes
 * perdues. Reconnues au drapeau `refused_locally` ou, pour celles qu'une version antérieure a refusées, à leur motif.
 * Au plus `MAX_DECLARED_SKIPS_PER_PUSH` par envoi, les plus anciennes d'abord ; le reste suit aux envois suivants.
 */
export async function pendingSkipDeclarations(
  db: GicDatabase,
): Promise<{ readonly seqs: readonly number[]; readonly commandIds: readonly string[] }> {
  const refused = (await db.outbox.where('status').equals('REJECTED').toArray())
    .filter(
      (command) =>
        !command.skip_declared_at &&
        // Un numéro que le serveur n'accepterait pas ferait refuser tout l'envoi (HTTP 400) à chaque cycle : écarté.
        Number.isSafeInteger(command.device_seq) &&
        command.device_seq > 0 &&
        (command.refused_locally === true ||
          // Un motif absent (ligne ancienne ou abîmée) ne doit pas faire échouer l'envoi : il n'est pas local.
          (typeof command.last_error?.message_fr === 'string' &&
            command.last_error.message_fr.startsWith(LOCAL_REFUSAL_PREFIX))),
    )
    .sort((a, b) => a.device_seq - b.device_seq)
    .slice(0, MAX_DECLARED_SKIPS_PER_PUSH);
  return {
    seqs: refused.map((command) => command.device_seq),
    commandIds: refused.map((command) => command.command_id),
  };
}

export async function runPushCycle(
  db: GicDatabase,
  deps: {
    readonly clock: Clock;
    readonly idGenerator: IdGenerator;
    readonly deviceId: string;
    /**
     * Utilisateur de la session : seules ses commandes partent. Le serveur refuse définitivement
     * une commande dont l'auteur n'est pas l'utilisateur authentifié (`FORBIDDEN`) ; celles d'un
     * autre utilisateur de l'appareil attendent sa reconnexion.
     */
    readonly userId?: string;
  },
  options: { readonly skip?: ReadonlySet<string> } = {},
): Promise<PushCycleResult> {
  let batch = await pendingOutbox(db, 50, deps.userId, options.skip);
  if (batch.length === 0) {
    // Plus rien à envoyer : un refus en bloc signalé plus tôt n'a plus d'objet (les commandes en cause ont été
    // classées ou ont disparu de la file), le bandeau ne doit pas rester affiché jusqu'au prochain envoi réussi.
    if ((await db.syncMeta.get('device'))?.push_refusal) {
      await db.syncMeta.update('device', { push_refusal: null });
    }
    return { outcome: 'NOTHING_TO_PUSH' };
  }

  // Une enveloppe que le serveur refuserait ferait refuser tout le lot (HTTP 400) à chaque cycle : les
  // commandes en cause sont refusées ici, avec leur motif, et le reste du lot part.
  const invalid = new Map<string, string>();
  for (const command of batch) {
    const check = checkEnvelope(command);
    if (!check.ok) invalid.set(command.command_id, check.message_fr);
  }
  if (invalid.size > 0) {
    const rejected = await rejectUnsendable(db, invalid);
    console.warn(
      `Sync : ${rejected.size} commande(s) refusée(s) sur l'appareil (enveloppe invalide)`,
      batch.filter((command) => rejected.has(command.command_id)).map((c) => c.command_type),
    );
    batch = batch.filter((command) => !rejected.has(command.command_id));
    // Le lot ne contenait que des commandes refusées : la suite de la file part au tour suivant.
    if (batch.length === 0) {
      return { outcome: 'PUSHED', count: 0, settled: rejected.size, stalled: [] };
    }
  }

  await db.outbox
    .where('command_id')
    .anyOf(batch.map((c) => c.command_id))
    .modify({ status: 'SYNCING', sent_at: deps.clock.now().toISOString() });

  // Numéros des commandes refusées sur l'appareil : déclarés au serveur avec ce lot (ADR-052, AV-507).
  const declarations = await pendingSkipDeclarations(db);
  const request: PushRequest = {
    device_id: deps.deviceId,
    batch_id: deps.idGenerator.newId(),
    device_sent_at: deps.clock.now().toISOString(),
    commands: batch.map(toEnvelope),
    pending_by_author: await pendingAfterBatch(db, batch),
    ...(declarations.seqs.length > 0 ? { skipped_device_seqs: [...declarations.seqs] } : {}),
  };

  const result = await authorizedRequest<PushResponse>(db, '/api/v1/sync/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    timeoutMs: PUSH_TIMEOUT_MS,
    ...(deps.userId !== undefined ? { expectedUserId: deps.userId } : {}),
  });

  if (!result.ok && result.reason === 'SESSION_CHANGED') {
    // Relève sur la tablette : le lot n'est pas parti, il attend la reconnexion de son auteur.
    await db.outbox
      .where('command_id')
      .anyOf(batch.map((c) => c.command_id))
      .modify({ status: 'PENDING_SYNC' });
    return { outcome: 'SESSION_CHANGED' };
  }
  if (!result.ok) {
    // Pas de résultat serveur : les commandes redeviennent PENDING_SYNC (repartent au
    // prochain cycle) plutôt que SYNCING indéfiniment — reprise après coupure (§8). L'enveloppe
    // n'est jamais modifiée : le lot a pu atteindre le serveur avant la coupure, et son empreinte
    // (`payload_hash`, toute l'enveloppe) doit rester identique au renvoi, sans quoi le serveur
    // refuserait la commande déjà appliquée (`COMMAND_ID_REUSED`, ADR-037 §2).
    await db.outbox
      .where('command_id')
      .anyOf(batch.map((c) => c.command_id))
      .modify((c) => {
        c.status = 'PENDING_SYNC';
        c.attempts += 1;
        // Le lot a pu atteindre le serveur : sa réponse au renvoi peut être « en cours » (S-45).
        if (result.reason !== 'SESSION_INVALID') c.unanswered_at = deps.clock.now().toISOString();
      });
    // Seul un jeton de rafraîchissement invalide (session révoquée) force la déconnexion
    // locale. Une erreur HTTP du contrôleur (ex. 400 sur une enveloppe malformée) prouve que le
    // serveur est joignable : `SERVER_ERROR`, nouvel essai au prochain cycle, sans effet destructeur.
    if (result.reason === 'SESSION_INVALID') return { outcome: 'SESSION_INVALID' };
    if (result.reason === 'HTTP_ERROR' && result.status === 400) {
      // Lot refusé en bloc alors que chaque enveloppe est valide ici (version de l'application plus ancienne
      // que le serveur, identifiant d'appareil ou d'auteur non conforme) : le détail du serveur reste dans la
      // console de l'appareil et, pour l'utilisateur, dans un témoin que le bandeau de la coque affiche
      // (`PushRefusalBanner`), faute de pouvoir désigner une commande.
      console.error('Sync : lot refusé par le serveur (HTTP 400)', result.body);
      await db.syncMeta.update('device', {
        push_refusal: readRefusal(result.status, result.body, deps.clock.now().toISOString()),
      });
    }
    return result.reason === 'HTTP_ERROR' ? { outcome: 'SERVER_ERROR' } : { outcome: 'OFFLINE' };
  }

  // Le serveur a lu le lot : un refus en bloc antérieur n'a plus lieu d'être signalé, et les numéros refusés
  // sur l'appareil qui l'accompagnaient sont déclarés (pas de redéclaration inutile aux envois suivants).
  await db.syncMeta.update('device', {
    clock_skew_ms: result.data.clock_skew_ms,
    push_refusal: null,
  });
  if (declarations.commandIds.length > 0) {
    const declaredAt = deps.clock.now().toISOString();
    await db.outbox
      .where('command_id')
      .anyOf([...declarations.commandIds])
      .modify({ skip_declared_at: declaredAt });
  }

  const syncedAt = deps.clock.now().toISOString();
  const nowMs = deps.clock.now().getTime();
  const answered = new Set<string>();
  const stalled: string[] = [];
  let settled = 0;
  for (const commandResult of result.data.results) {
    answered.add(commandResult.command_id);
    const known = syncResultStatusSchema.safeParse(commandResult.status);
    if (!known.success) {
      // Statut hors du protocole (ex. `RECEIVED` après un `RETRY_LATER`, S-18) : jamais écrit sur
      // l'appareil ; la commande repart au prochain cycle, motif précédent conservé.
      await db.outbox
        .where('command_id')
        .equals(commandResult.command_id)
        .modify((c) => {
          c.status = 'PENDING_SYNC';
          c.attempts += 1;
          c.busy_retries = 0;
        });
      continue;
    }
    const nextStatus = deviceStateAfterResult(known.data);
    const accepted = nextStatus === 'SYNCED' || nextStatus === 'SYNCED_WITH_WARNING';
    if (nextStatus === 'PENDING_SYNC') {
      const code = commandResult.error?.code;
      if (code === 'PRECEDING_COMMAND_PENDING') {
        // Pas traitée : une commande précédente du lot doit d'abord être renvoyée (AV-210). Ni le
        // compteur ni le motif réel de la commande ne changent.
        await db.outbox.update(commandResult.command_id, { status: 'PENDING_SYNC' });
        continue;
      }
      if (code === 'COMMAND_STALLED') stalled.push(commandResult.command_id);
      await db.outbox
        .where('command_id')
        .equals(commandResult.command_id)
        .modify((c) => {
          c.status = 'PENDING_SYNC';
          c.attempts += 1;
          c.last_error = commandResult.error ?? c.last_error;
          // `SERVER_BUSY` peu après un envoi sans réponse : sans doute la commande encore en cours de
          // traitement au serveur (S-45), pas un échec.
          const inProgress =
            code === 'SERVER_BUSY' &&
            !!c.unanswered_at &&
            nowMs - Date.parse(c.unanswered_at) < IN_PROGRESS_GRACE_MS;
          c.busy_retries = inProgress
            ? (c.busy_retries ?? 0)
            : nextBusyRetries(code, c.busy_retries ?? 0);
        });
      continue;
    }
    settled += 1;
    await db.outbox.update(commandResult.command_id, {
      status: nextStatus,
      busy_retries: 0,
      server_refs: commandResult.server_refs ?? null,
      last_error: commandResult.error ?? null,
      ...(accepted ? { synced_at: syncedAt } : {}),
      ...(commandResult.warnings && commandResult.warnings.length > 0
        ? { warnings: [...commandResult.warnings] }
        : {}),
    });
  }
  // Commande du lot sans résultat : elle ne reste pas « en cours d'envoi » indéfiniment.
  const unanswered = batch.filter((command) => !answered.has(command.command_id));
  if (unanswered.length > 0) {
    await db.outbox
      .where('command_id')
      .anyOf(unanswered.map((command) => command.command_id))
      .modify((c) => {
        c.status = 'PENDING_SYNC';
        c.attempts += 1;
        c.unanswered_at = syncedAt;
      });
  }

  return { outcome: 'PUSHED', count: result.data.results.length, settled, stalled };
}

/**
 * Renvois consécutifs sans succès d'une commande (`busy_retries`), selon le motif du `RETRY_LATER` :
 * erreur du serveur (exception en base, S-29 à S-31, S-37 ; délai du lot dépassé, S-43) et attente de
 * dépendance comptent ; une commande bloquée (`COMMAND_STALLED`, AV-217) est aussitôt signalée en
 * échec répété ; tout autre motif remet le compteur à zéro, dont l'appareil en attente d'approbation
 * (`DEVICE_PENDING`, AV-228 : une attente, pas un échec).
 */
export function nextBusyRetries(code: string | undefined, current: number): number {
  if (code === 'COMMAND_STALLED') return Math.max(current + 1, REPEATED_FAILURE_ATTEMPTS);
  if (code === 'SERVER_BUSY' || code === 'DEPENDENCY_PENDING') return current + 1;
  return 0;
}
