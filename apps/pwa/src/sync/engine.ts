/**
 * Orchestration push → pull (WF-16, squelette) : déclenchée au démarrage, au retour du
 * réseau (`online`), périodiquement, et manuellement (ECR-SYN-01 « forcer la
 * synchronisation »). Une seule exécution à la fois (`running`) : un déclenchement pendant un
 * cycle en cours attend la fin du cycle courant plutôt que d'en empiler un second. Entre onglets, un
 * verrou du navigateur (`navigator.locks`) tient un seul cycle à la fois sur l'appareil : sans lui, un
 * onglet enverrait une commande plus récente pendant qu'un lot plus ancien est encore en vol dans un
 * autre (INV-SYN-04).
 */
import type { Clock, IdGenerator } from '@gic/domain';
import type { GicDatabase } from '../storage/db.js';
import { PUSH_TIMEOUT_MS, runPushCycle } from './push.js';
import { runPullCycle } from './pull.js';
import { runAttachmentUploadCycle } from './attachment-upload.js';
import { resetInterruptedPushes } from './outbox.js';

const PERIODIC_INTERVAL_MS = 30_000;
const MAX_PUSH_BATCHES_PER_CYCLE = 20; // borne de sécurité (outbox anormalement longue)
/** Nom du verrou du navigateur qui tient un seul cycle de synchronisation à la fois sur l'appareil. */
export const SYNC_LOCK_NAME = 'gic-sync';
/**
 * Sans verrou entre onglets : une commande restée `SYNCING` plus longtemps que le délai d'un lot (et
 * une marge) n'est plus en vol nulle part, elle repart.
 */
const INTERRUPTED_PUSH_MS = PUSH_TIMEOUT_MS + 10_000;

/**
 * `OFFLINE` : serveur injoignable (réseau). `SERVER_ERROR` : le serveur a répondu par une erreur
 * HTTP, il est joignable (ADR-037) ; les opérations repartiront au prochain cycle. `STOPPED` : cycle
 * interrompu, moteur arrêté ou session changée (relève sur une tablette partagée).
 */
export type SyncCycleOutcome =
  'SYNCED' | 'OFFLINE' | 'SERVER_ERROR' | 'SESSION_INVALID' | 'NOTHING_TO_DO' | 'STOPPED';

export interface SyncEngineDeps {
  readonly db: GicDatabase;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly deviceId: string;
  /** Utilisateur de la session : titulaire des jeux téléchargés (ADR-037). */
  readonly userId?: string;
  readonly onSessionInvalid: () => void;
  /** Appelé après chaque cycle (ex. tenter l'activation d'un service worker en attente). */
  readonly onCycleComplete?: (outcome: SyncCycleOutcome) => void;
  /** Moteur arrêté (déconnexion, relève) : le cycle en cours s'interrompt entre deux appels. */
  readonly isStopped?: () => boolean;
}

/**
 * Exécute `task` sous le verrou de synchronisation de l'appareil (`exclusive` vrai), ou directement
 * si le navigateur n'a pas de verrous (`exclusive` faux).
 */
async function withSyncLock<T>(task: (exclusive: boolean) => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks || typeof locks.request !== 'function') return task(false);
  return locks.request(SYNC_LOCK_NAME, () => task(true));
}

export async function runSyncCycle(deps: SyncEngineDeps): Promise<SyncCycleOutcome> {
  return withSyncLock((exclusive) => syncCycle(deps, exclusive));
}

async function syncCycle(deps: SyncEngineDeps, exclusive: boolean): Promise<SyncCycleOutcome> {
  if (deps.isStopped?.()) return 'STOPPED';
  // Reprise des envois interrompus : sous le verrou, aucun lot n'est en vol ailleurs, tout ce qui est
  // resté `SYNCING` repart ; sans verrou, seulement ce qui a dépassé le délai d'un lot.
  await resetInterruptedPushes(
    deps.db,
    exclusive
      ? undefined
      : new Date(deps.clock.now().getTime() - INTERRUPTED_PUSH_MS).toISOString(),
  ).catch(() => 0);
  let pushed = false;
  let serverError = false;
  // Commandes bloquées (`COMMAND_STALLED`) déjà renvoyées pendant ce cycle : elles ne retiennent plus
  // la suite, mais ne repartent qu'au cycle suivant (pas de renvoi en boucle serrée, AV-217).
  const stalled = new Set<string>();
  for (let i = 0; i < MAX_PUSH_BATCHES_PER_CYCLE; i++) {
    // Moteur arrêté pendant le cycle (déconnexion, relève) : plus aucun lot pour l'ancien utilisateur.
    if (deps.isStopped?.()) return 'STOPPED';
    const result = await runPushCycle(deps.db, deps, { skip: stalled });
    if (result.outcome === 'NOTHING_TO_PUSH') break;
    if (result.outcome === 'SESSION_CHANGED') return 'STOPPED';
    if (result.outcome === 'OFFLINE') return 'OFFLINE';
    if (result.outcome === 'SESSION_INVALID') {
      deps.onSessionInvalid();
      return 'SESSION_INVALID';
    }
    if (result.outcome === 'SERVER_ERROR') {
      // Le lot repartira au prochain cycle ; le tirage a lieu quand même (serveur joignable).
      serverError = true;
      break;
    }
    pushed = true;
    for (const commandId of result.stalled) stalled.add(commandId);
    // Rien de réglé (`RETRY_LATER` partout) : renvoyer aussitôt le même lot ne servirait à rien.
    if (result.settled === 0) break;
  }

  // Octets des pièces jointes : après les commandes (leur enregistrement doit être accepté), avant le
  // tirage (MP-10, ADR-012 point 3).
  if (deps.isStopped?.()) return 'STOPPED';
  const uploads = await runAttachmentUploadCycle(deps.db, {
    clock: deps.clock,
    ...(deps.userId ? { userId: deps.userId } : {}),
    ...(deps.isStopped ? { isStopped: deps.isStopped } : {}),
  });
  if (uploads.outcome === 'SESSION_CHANGED') return 'STOPPED';
  // Réseau coupé pendant une pièce (`INTERRUPTED`) : le tirage juge lui-même de la joignabilité.
  if (uploads.outcome === 'SESSION_INVALID') {
    deps.onSessionInvalid();
    return 'SESSION_INVALID';
  }
  if (uploads.sent > 0) pushed = true;

  if (deps.isStopped?.()) return 'STOPPED';
  const pullResult = await runPullCycle(deps.db, {
    clock: deps.clock,
    ...(deps.userId ? { userId: deps.userId } : {}),
  });
  if (pullResult.outcome === 'SESSION_CHANGED') return 'STOPPED';
  // Réseau perdu pendant le tirage : le serveur n'est plus joignable, même après un envoi réussi.
  if (pullResult.outcome === 'OFFLINE') return 'OFFLINE';
  if (pullResult.outcome === 'SESSION_INVALID') {
    deps.onSessionInvalid();
    return 'SESSION_INVALID';
  }
  if (serverError || pullResult.outcome === 'SERVER_ERROR') return 'SERVER_ERROR';
  return pushed || pullResult.changeCount > 0 ? 'SYNCED' : 'NOTHING_TO_DO';
}

export class SyncEngine {
  private running: Promise<SyncCycleOutcome> | undefined;
  /** Déclenchement reçu pendant un cycle : un nouveau cycle suit (une saisie part sans attendre). */
  private rerunRequested = false;
  private stopped = false;
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private readonly onlineListener = () => void this.trigger();

  constructor(private readonly deps: SyncEngineDeps) {}

  start(): void {
    window.addEventListener('online', this.onlineListener);
    this.intervalId = setInterval(() => void this.trigger(), PERIODIC_INTERVAL_MS);
    // Le premier cycle reprend les envois interrompus (onglet fermé, appareil éteint pendant l'envoi).
    void this.trigger();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('online', this.onlineListener);
    if (this.intervalId !== undefined) clearInterval(this.intervalId);
  }

  /**
   * Un seul cycle à la fois : un déclenchement pendant un cycle en cours renvoie ce cycle et demande
   * qu'un nouveau le suive, pour qu'une opération saisie pendant un long tirage parte sans attendre
   * le déclenchement périodique.
   */
  trigger(): Promise<SyncCycleOutcome> {
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }
    this.running = this.loop().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async loop(): Promise<SyncCycleOutcome> {
    let outcome: SyncCycleOutcome;
    do {
      this.rerunRequested = false;
      outcome = await runSyncCycle({ ...this.deps, isStopped: () => this.stopped });
      // Un cycle interrompu ne dit rien de l'état du serveur.
      if (outcome !== 'STOPPED') this.deps.onCycleComplete?.(outcome);
    } while (
      this.rerunRequested &&
      !this.stopped &&
      outcome !== 'SESSION_INVALID' &&
      outcome !== 'STOPPED'
    );
    return outcome;
  }
}
