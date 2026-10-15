/**
 * Base locale Dexie (IndexedDB) — squelette P0-14 (06-offline-sync/01-architecture-
 * offline.md §2). Magasins, alignés sur le tableau du §2 :
 *
 * - `outbox`      : commandes en attente (§5, structure conceptuelle de l'outbox) ;
 * - `projections` : état téléchargé par pull (`ref_*`/`scope_*` du §2, fusionnés ici en un
 *                   magasin générique — la spécialisation par jeu de données arrive avec les
 *                   modules qui la motivent, comme `sync_change_feed.dataset` côté serveur,
 *                   commentaire de `command-pipeline.service.ts`) ;
 * - `sync_state`  : curseurs par jeu, `device_seq`, écart d'horloge (non chiffré, §2) ;
 * - `session`     : jetons **chiffrés** par la clé dérivée du PIN (`storage/crypto.ts`) ;
 * - `pin_lock`    : sel PBKDF2 et compteur d'échecs du PIN, par utilisateur (BR-ADM-024) —
 *                   distinct de `session` car lisible avant déverrouillage (déterminer quel
 *                   écran afficher n'exige pas de posséder déjà la clé dérivée) ;
 * - `navigation`  : navigation par rôle mémorisée (ADR-036) ;
 * - `attachmentFiles` et `attachmentBlobs` : pièces jointes en attente d'envoi (MP-10, ADR-012,
 *                   ADR-046) — métadonnées et état d'envoi d'un côté, octets de l'autre (une liste
 *                   suivie en direct ne recharge pas les photos) ; non chiffrées pour l'instant,
 *                   comme l'outbox (AV-287).
 *
 * Migrations versionnées (Dexie `version()`) dès la première version, comme l'exige la
 * stack (05-stack.md §2.2) même si une seule version existe pour l'instant.
 */
import Dexie, { type EntityTable } from 'dexie';
import type { DeviceSyncState } from '@gic/contracts';

export const OUTBOX_STATUSES = [
  'LOCAL_ONLY',
  'PENDING_SYNC',
  'SYNCING',
  'SYNCED',
  'SYNCED_WITH_WARNING',
  'CONFLICT',
  'REJECTED',
] as const satisfies readonly DeviceSyncState[];

export interface OutboxCommand {
  readonly command_id: string;
  readonly device_seq: number;
  readonly command_type: string;
  readonly command_version: number;
  readonly author_user_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly base_version: number | null;
  readonly depends_on: readonly string[];
  readonly occurred_at: string;
  readonly client_created_at: string;
  /**
   * État du réseau à la saisie (serveur joignable au dernier cycle, ADR-037). Jamais modifié après
   * l'enregistrement : il fait partie de l'empreinte d'idempotence calculée par le serveur.
   */
  readonly captured_offline: boolean;
  readonly backdated_reason: string | null;
  readonly attachment_ids: readonly string[];
  readonly payload: unknown;
  status: DeviceSyncState;
  attempts: number;
  next_attempt_at: string | null;
  last_error: { readonly code: string; readonly message_fr: string } | null;
  server_refs: Record<string, string> | null;
  /** Heure à laquelle le serveur a accepté la commande (`SYNCED`, `SYNCED_WITH_WARNING`). */
  synced_at?: string | null;
  /** Codes d'avertissement renvoyés avec l'acceptation (ex. `RECEIPT_QUARANTINED`), hors enveloppe. */
  warnings?: readonly string[];
  /**
   * Indices posés sur l'appareil à la saisie, hors enveloppe et jamais envoyés (ex.
   * `EXPECTED_QUARANTINE` : réception hors ligne que le serveur mettra en quarantaine).
   */
  readonly local_flags?: readonly string[];
  /**
   * Renvois consécutifs du serveur sans application (`RETRY_LATER` avec `SERVER_BUSY`), hors
   * coupures réseau ; remis à zéro par toute autre réponse. Non indexé, hors enveloppe.
   */
  busy_retries?: number;
  /**
   * Heure du dernier passage à `SYNCING` : une commande restée `SYNCING` au-delà du délai d'un lot est
   * tenue pour interrompue (onglet fermé, appareil éteint) et repart. Non indexé, hors enveloppe.
   */
  sent_at?: string | null;
  /**
   * Heure du dernier envoi resté sans réponse (réseau coupé, délai dépassé, commande absente de la
   * réponse) : le serveur a pu commencer à la traiter, un `SERVER_BUSY` reçu peu après n'est pas un
   * échec (S-45). Non indexé, hors enveloppe.
   */
  unanswered_at?: string | null;
}

/** Une ligne par `(dataset, entity_type, entity_id)` : projection de l'état courant reçu. */
export interface Projection {
  /** `${dataset}:${entity_type}:${entity_id}` ; solde de stock : `…:${scope_id}:${entity_id}` (`projectionKey`). */
  readonly key: string;
  readonly dataset: string;
  readonly entity_type: string;
  readonly entity_id: string;
  /** Périmètre de la dernière ligne reçue (conservé pour compatibilité ; voir `scopes`). */
  readonly scope_type: string;
  readonly scope_id: string | null;
  /**
   * Périmètres par lesquels l'appareil détient l'entité (`SCOPE_TYPE:scope_id`, `GLOBAL:` pour la
   * portée globale) : une même commande arrive par son titulaire, son équipe et son emplacement de
   * préparation (jeu `orders`). Un `SCOPE_EXIT` ne retire que son périmètre ; l'entité ne quitte
   * l'appareil que lorsqu'il n'en reste aucun (02-synchronisation.md §5.3). Absent sur une ligne
   * écrite avant ce champ : `scope_type`/`scope_id` en tiennent lieu.
   */
  readonly scopes?: readonly string[];
  readonly row_version: number;
  readonly data: Record<string, unknown>;
  readonly seq: number;
}

export interface SyncCursor {
  readonly dataset: string; // clé primaire
  readonly cursor: number;
  /**
   * Heure de départ de la dernière requête d'un tirage complet du jeu (`has_more` faux) : tout ce
   * que le serveur avait appliqué avant cette heure est sur l'appareil (ADR-037).
   */
  readonly pulled_at?: string;
}

export interface SyncMeta {
  readonly key: 'device'; // singleton
  device_id: string;
  clock_skew_ms: number | null;
  last_sync_at: string | null;
  /** Utilisateur dont l'appareil détient les jeux téléchargés (ADR-037). */
  data_user_id?: string | null;
}

export interface SessionRecord {
  readonly key: 'current'; // singleton
  user_id: string;
  device_status: 'PENDING' | 'ACTIVE';
  /** Code court de l'appareil reçu à la connexion (MP-06), affiché pendant l'attente d'approbation. */
  device_short_code?: string;
  /** `refresh_token` chiffré (AES-GCM, clé dérivée du PIN) ; jamais en clair au repos. */
  encrypted_refresh_token: string;
  iv: string;
}

export interface PinLock {
  readonly user_id: string; // clé primaire : un PIN par utilisateur sur cet appareil
  salt: string;
  iterations: number;
  failed_attempts: number;
}

/**
 * Navigation mémorisée par utilisateur (ADR-036) : rôles et actions du jour de la dernière réponse
 * de l'accueil, pour proposer le menu par rôle sans réseau. Aucun indicateur ni montant : seul ce
 * qui sert à naviguer est conservé.
 */
/** État local d'une pièce jointe (MP-10, ADR-046). */
export const ATTACHMENT_FILE_STATUSES = [
  /** Enregistrée sur l'appareil, octets à envoyer (dès que sa commande d'enregistrement est acceptée). */
  'QUEUED',
  /** Envoi commencé : `uploaded_bytes` octets reçus par le serveur. */
  'UPLOADING',
  /** Reçue et vérifiée par le serveur (`AVAILABLE`) : octets retirés de l'appareil. */
  'SENT',
  /** Empreinte refusée par le serveur (`QUARANTINED`) : reprendre une nouvelle photo. */
  'QUARANTINED',
  /** Enregistrement refusé par le serveur, ou envoi refusé définitivement : elle ne partira pas. */
  'REFUSED',
] as const;
export type AttachmentFileStatus = (typeof ATTACHMENT_FILE_STATUSES)[number];

export interface AttachmentFile {
  readonly attachment_id: string;
  /** Seul l'auteur envoie les octets (serveur : `created_by`), avec sa session. */
  readonly author_user_id: string;
  readonly owner_type: string;
  readonly owner_id: string;
  readonly kind: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly captured_at: string;
  /** Commande `attachments.attachment.register` de l'outbox. */
  readonly register_command_id: string;
  status: AttachmentFileStatus;
  uploaded_bytes: number;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  sent_at?: string | null;
}

/** Octets d'une pièce en attente (`ArrayBuffer` : un `Blob` ne survit pas partout à IndexedDB). */
export interface AttachmentBlob {
  readonly attachment_id: string;
  readonly bytes: ArrayBuffer;
}

export interface NavigationRecord {
  readonly user_id: string; // clé primaire
  readonly roles: readonly string[];
  readonly sections: readonly {
    readonly role: string;
    readonly roleLabel: string;
    readonly actions: readonly {
      readonly code: string;
      readonly label: string;
      readonly hint: string | null;
      readonly route: string | null;
      readonly primary: boolean;
    }[];
  }[];
  readonly saved_at: string;
}

export class GicDatabase extends Dexie {
  outbox!: EntityTable<OutboxCommand, 'command_id'>;
  projections!: EntityTable<Projection, 'key'>;
  syncCursors!: EntityTable<SyncCursor, 'dataset'>;
  syncMeta!: EntityTable<SyncMeta, 'key'>;
  session!: EntityTable<SessionRecord, 'key'>;
  pinLocks!: EntityTable<PinLock, 'user_id'>;
  navigation!: EntityTable<NavigationRecord, 'user_id'>;
  attachmentFiles!: EntityTable<AttachmentFile, 'attachment_id'>;
  attachmentBlobs!: EntityTable<AttachmentBlob, 'attachment_id'>;

  constructor(name = 'gic-agropelc') {
    super(name);
    this.version(1).stores({
      outbox: 'command_id, device_seq, status',
      projections: 'key, dataset, [dataset+entity_type]',
      syncCursors: 'dataset',
      syncMeta: 'key',
      session: 'key',
      pinLocks: 'user_id',
    });
    // Version 2 (fork « Écrans PWA ») : navigation par rôle mémorisée (ADR-036).
    this.version(2).stores({ navigation: 'user_id' });
    // Version 3 (MP-10) : pièces jointes en attente d'envoi.
    this.version(3).stores({
      attachmentFiles: 'attachment_id, author_user_id, owner_id, register_command_id, status',
      attachmentBlobs: 'attachment_id',
    });
  }
}

let instance: GicDatabase | undefined;

/** Instance partagée (composition root) : une seule ouverture Dexie par onglet. */
export function getDb(): GicDatabase {
  instance ??= new GicDatabase();
  return instance;
}

/** Réservé aux tests : force une base isolée nommée, sans passer par le singleton. */
export function createTestDb(name: string): GicDatabase {
  return new GicDatabase(name);
}
