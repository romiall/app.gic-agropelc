/**
 * Orchestration push → pull (WF-16, squelette) : déclenchée au démarrage, au retour du
 * réseau (`online`), au retour d'un onglet masqué, périodiquement, et manuellement (ECR-SYN-01 « forcer
 * la synchronisation »). Cadence (MP-12, AV-319 ; NFR-09, RISK-16) : 30 s au premier plan, aucun cycle
 * périodique pendant qu'un onglet est masqué, et attente progressive (30 s doublées à chaque cycle qui
 * échoue, plafonnée à 2 min) tant que le réseau ou le serveur ne répond pas. Le retour du réseau, une
 * action de l'utilisateur ou le retour au premier plan (si aucun cycle récent n'a eu lieu depuis) relance
 * aussitôt et remet l'attente à 30 s. Une seule exécution à la fois (`running`) : un déclenchement
 * pendant un cycle en cours attend la fin du cycle courant plutôt que d'en empiler un second. Entre onglets, un
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

/** Cadence du moteur (MP-12, AV-319) ; surchargeable pour les tests. */
export interface SyncEngineTiming {
  /** Attente entre deux cycles périodiques quand tout va bien. */
  readonly intervalMs: number;
  /**
   * Plafond de l'attente après des cycles qui échouent. Court à dessein : tant qu'un cycle n'a pas
   * réussi, l'appareil s'affiche « hors ligne » et ses saisies sont étiquetées hors ligne
   * (`connectivity.ts`) ; sur un Wi-Fi sans Internet, aucun événement `online` ne le ramène.
   */
  readonly maxBackoffMs: number;
  /** Un onglet qui redevient visible relance un cycle si le dernier date de plus que cela. */
  readonly visibleResyncMs: number;
}
export const DEFAULT_SYNC_TIMING: SyncEngineTiming = {
  intervalMs: 30_000,
  maxBackoffMs: 2 * 60_000,
  visibleResyncMs: 15_000,
};
/** Attente avant le prochain cycle périodique après `failureStreak` cycles consécutifs en échec. */
export function nextCycleDelayMs(
  failureStreak: number,
  timing: SyncEngineTiming = DEFAULT_SYNC_TIMING,
): number {
  const doublings = Math.min(Math.max(0, Math.floor(failureStreak)), 10);
  return Math.min(timing.maxBackoffMs, timing.intervalMs * 2 ** doublings);
}
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

function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** Durées mesurées sur l'horloge monotone : un réglage de l'heure de l'appareil ne les fausse pas. */
function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class SyncEngine {
  private running: Promise<SyncCycleOutcome> | undefined;
  /** Déclenchement reçu pendant un cycle : un nouveau cycle suit (une saisie part sans attendre). */
  private rerunRequested = false;
  private started = false;
  private stopped = false;
  private timerId: ReturnType<typeof setTimeout> | undefined;
  /** Cycles consécutifs en échec (hors réseau, erreur du serveur) : allonge l'attente périodique. */
  private failureStreak = 0;
  private lastCycleEndedAt = -Infinity;
  private cycleStartedAt = -Infinity;
  /** Dernier passage de l'onglet en arrière-plan (un cycle commencé avant est suspect). */
  private hiddenAt = -Infinity;
  private readonly onlineListener = () => {
    this.failureStreak = 0;
    this.scheduleNext();
    void this.trigger();
  };
  private readonly visibilityListener = () => {
    if (this.stopped) return;
    if (pageHidden()) {
      this.hiddenAt = monotonicNow();
      return;
    }
    // Retour au premier plan : l'utilisateur est là, on n'attend pas le prochain cycle périodique.
    this.failureStreak = 0;
    this.scheduleNext();
    const now = monotonicNow();
    if (this.running) {
      // Un cycle commencé avant la mise en arrière-plan, ou long, a pu perdre sa connexion pendant la
      // veille : un cycle neuf suit le sien. Un cycle récent suffit.
      if (
        this.hiddenAt >= this.cycleStartedAt ||
        now - this.cycleStartedAt >= this.timing.visibleResyncMs
      ) {
        void this.trigger();
      }
      return;
    }
    if (now - this.lastCycleEndedAt >= this.timing.visibleResyncMs) void this.trigger();
  };

  constructor(
    private readonly deps: SyncEngineDeps,
    private readonly timing: SyncEngineTiming = DEFAULT_SYNC_TIMING,
  ) {}

  /** Attente prévue avant le prochain cycle périodique (allongée après des échecs). */
  get nextDelayMs(): number {
    return nextCycleDelayMs(this.failureStreak, this.timing);
  }

  start(): void {
    this.started = true;
    window.addEventListener('online', this.onlineListener);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityListener);
    }
    this.scheduleNext();
    // Le premier cycle reprend les envois interrompus (onglet fermé, appareil éteint pendant l'envoi).
    void this.trigger();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('online', this.onlineListener);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityListener);
    }
    if (this.timerId !== undefined) clearTimeout(this.timerId);
  }

  /**
   * Seule fonction qui arme la minuterie périodique : elle remplace l'échéance déjà armée, pour que le
   * délai suive toujours l'état courant (retour du réseau, du premier plan, cycle qui vient de finir).
   */
  private scheduleNext(): void {
    if (this.timerId !== undefined) clearTimeout(this.timerId);
    this.timerId = undefined;
    if (this.stopped || !this.started) return;
    this.timerId = setTimeout(() => void this.periodicTick(), this.nextDelayMs);
  }

  /** Cycle périodique : sauté pendant qu'un onglet est masqué (NFR-09), puis le suivant est planifié. */
  private async periodicTick(): Promise<void> {
    try {
      if (!pageHidden() && !this.stopped) await this.trigger();
    } finally {
      this.scheduleNext();
    }
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
      this.cycleStartedAt = monotonicNow();
      try {
        outcome = await runSyncCycle({ ...this.deps, isStopped: () => this.stopped });
      } catch (error) {
        // Réponse inattendue du serveur, base locale pleine ou fermée : le serveur est joignable, le
        // cycle recommencera plus tard, sans rejet non géré et en comptant l'échec (attente allongée).
        console.error('Cycle de synchronisation en échec', error);
        outcome = 'SERVER_ERROR';
      }
      this.lastCycleEndedAt = monotonicNow();
      if (outcome === 'OFFLINE' || outcome === 'SERVER_ERROR') this.failureStreak += 1;
      else if (outcome === 'SYNCED' || outcome === 'NOTHING_TO_DO') this.failureStreak = 0;
      // Le délai du prochain cycle périodique suit le décompte d'échecs, quelle que soit l'origine du cycle.
      this.scheduleNext();
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
