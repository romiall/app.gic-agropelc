/**
 * Pipeline de commande (05-architecture/01-architecture-logicielle.md §4 ; ADR-011 ;
 * BR-SYN-001 à 008 ; RC-01, RC-02) : implémente exactement l'algorithme serveur de
 * 06-offline-sync/02-synchronisation.md §3.2 :
 *
 *   1. command_id ∈ inbox ? même payload_hash → résultat enregistré renvoyé ;
 *      sinon REJECTED COMMAND_ID_REUSED
 *   2. INSERT inbox (RECEIVED)
 *   3. dépendances (BR-SYN-004), appareil (RC-02), utilisateur, horodatage futur, version
 *   4. RBAC à occurred_at (RC-01)
 *   5. validation du payload (schéma versionné)
 *   6. BEGIN → gestionnaire → audit + domain_events + change_feed + inbox=APPLIED(_*) → COMMIT
 *   7. erreur transitoire → ROLLBACK, inbox=FAILED_RETRYABLE, réponse RETRY_LATER
 *
 * Rejet par le gestionnaire (étape 6) : la transaction est annulée (P3-04), aucune écriture
 * partielle n'est conservée.
 *
 * Rejet à toute étape avant 6 : aucune table métier touchée (INV-SYN-05) — seul `inbox`
 * (registre de synchronisation, pas une table métier) change de statut ; une commande qui
 * attend une dépendance passe `FAILED_RETRYABLE` (`DEPENDENCY_PENDING`), reprise au renvoi.
 *
 * Réclamation (P5-21, revue adverse ; AV-210) : chaque traitement porte un numéro de tentative
 * (`attempts`, 1 à l'insertion, +1 à chaque reprise). Toute écriture qui conclut l'inbox est
 * conditionnée à `status = 'RECEIVED'` et à ce numéro, et la transaction métier verrouille d'abord la
 * ligne d'inbox et vérifie qu'elle tient encore la réclamation : de deux traitements de la même
 * commande (renvoi pendant qu'une requête précédente tourne encore), un seul conclut ; l'autre répond
 * « réessayer » sans rien écrire. L'abandon d'une ligne `RECEIVED` se mesure depuis sa dernière
 * réclamation (`claimed_at`), jamais depuis sa première réception (`received_at`, immuable).
 *
 * Hors périmètre P0-06, délibérément non traité ici (voir docs/10-development-plan/
 * 06-passage-au-developpement.md §3 et le plan de cette session) :
 * - fenêtre de rétrodatation (AV-078) → P0-12 ;
 * - fusion automatique / `base_version` (intentions sur état partagé) → chaque module
 *   métier la décide dans son propre gestionnaire (ce pipeline reste générique).
 *
 * P0-12 (`sync/sync-push.service.ts`) : `HandleCommandContext` porte en plus, en option,
 * `deviceSentAt`/`batchId`/`clockSkewMs` — propres à `/sync/push` (un lot), absents pour
 * `/commands` (ONLINE_API, pas de lot ni d'horloge appareil à comparer par lot). L'avertissement
 * `CLOCK_SUSPECT` lui-même (§9, |écart| > 5 min) est ajouté par l'appelant sur le résultat
 * renvoyé, pas ici : ce pipeline reste agnostique du transport qui l'appelle.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Clock, IdGenerator } from '@gic/domain';
import { rawCommandEnvelopeSchema, type CommandResult } from '@gic/contracts';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { canonicalJsonStringify } from '../platform/canonical-json.js';
import { sha256Hex } from '../platform/hash.js';
import { jsonValue } from '../platform/kysely/json-value.js';
import { toBin, fromBin } from '../platform/kysely/uuid-columns.js';
import { toDbBool } from '../platform/kysely/bool-column.js';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { ApiError } from '../platform/http/api-error.exception.js';
import {
  checkDeviceActive,
  checkUserActive,
  hasPermissionAt,
} from '../modules/identity/application/public/index.js';
import { currentSettingValue } from '../modules/organization/application/public/index.js';
import { recordConflict, resolveOpenConflicts } from '../platform/sync/conflicts.js';
import type { UnitOfWork } from '../platform/unit-of-work.js';
import { retryHoldMinutesFrom, STALLED_CONFLICT_TYPE, STALLED_ENTITY_TYPE } from './retry-hold.js';
import { recordAudit } from '../audit/record-audit.js';
import { recordDenied } from '../audit/record-denied.js';
import { logStructured } from '../platform/observability/logger.js';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../platform/sync/command-handler-registry.provider.js';
import type { CommandHandlerOutcome } from '../platform/sync/command-handler-registry.js';

/** INV-GLO-02, BR-SYN-011 : `occurred_at` au plus 5 min après l'heure serveur (après correction de l'écart). */
const OCCURRED_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
/**
 * Une ligne `RECEIVED` réclamée depuis plus longtemps n'est plus en cours de traitement : arrêt brutal
 * du serveur entre la réclamation et la conclusion. Le renvoi identique la reprend (P5-21, AV-210). La
 * sûreté n'en dépend pas — la réclamation par tentative empêche tout double traitement —, seulement
 * l'économie d'un travail perdu. Délai technique, pas un seuil métier (bien au-delà du délai d'un lot,
 * 25 s, et de l'attente d'un verrou, 50 s).
 */
const STALE_CLAIM_SECONDS = 120;
/** Erreurs MySQL d'attente de verrou et d'interblocage : la ligne est tenue par un autre traitement. */
const LOCK_ERRNOS = new Set([1205, 1213]);
/** Clé primaire déjà prise : un envoi simultané de la même commande vient de l'enregistrer. */
const DUPLICATE_ENTRY_ERRNO = 1062;

/** Traitement en cours d'une commande : sa ligne d'inbox et le numéro de tentative qui la réclame. */
interface Claim {
  readonly commandIdBin: Buffer;
  readonly commandId: string;
  readonly authorUserId: string;
  readonly commandType: string;
  readonly attempt: number;
  /** Secondes écoulées depuis la première réception (`received_at`) : 0 pour une commande neuve. */
  readonly firstAgeSeconds: number;
  /** Déjà signalée bloquée (`COMMAND_STALLED`) : le signal se ferme quand elle se règle. */
  readonly wasStalled: boolean;
}

/** La ligne d'inbox a été réclamée par un autre traitement : celui-ci s'arrête sans rien écrire. */
class ClaimLost extends Error {}

export class EnvelopeValidationError extends ApiError {
  constructor(detail: string) {
    super(400, 'VALIDATION_ERROR', `Enveloppe de commande invalide : ${detail}`);
  }
}

export interface HandleCommandContext {
  readonly authenticatedUserId: string;
  readonly authenticatedDeviceId: string;
  readonly transport: 'ONLINE_API' | 'SYNC_PUSH' | 'SYSTEM';
  /** `/sync/push` seulement (§9) : horodatage d'envoi déclaré par l'appareil pour ce lot. */
  readonly deviceSentAt?: Date;
  /** `/sync/push` seulement : identifiant du lot d'envoi. */
  readonly batchId?: string;
  /** `/sync/push` seulement : `server_time − device_sent_at`, calculé une fois par lot par l'appelant. */
  readonly clockSkewMs?: number;
  /** Un par requête (`/commands`) ou par lot (`/sync/push`) — 09-non-functional/
   * 02-observabilite.md §1 : propagé à l'audit, aux événements et aux logs. */
  readonly correlationId?: string | undefined;
}

@Injectable()
export class CommandPipelineService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  /**
   * Point d'entrée observable (P0-16) : mesure la durée totale et journalise l'issue
   * (`command_type`, `correlation_id`, `user_id` pseudonymisé, `device_id`, `code`) sans
   * toucher à `handleInternal`, dont chaque branche est déjà exercée par une suite de tests
   * conséquente — un second `safeParse`, pur et sans effet, isole ce changement du reste.
   */
  async handle(raw: unknown, ctx: HandleCommandContext): Promise<CommandResult> {
    const startedAt = performance.now();
    const envelopeForLog = rawCommandEnvelopeSchema.safeParse(raw);
    const commandType = envelopeForLog.success ? envelopeForLog.data.command_type : undefined;
    const module = commandType?.split('.')[0];

    try {
      const result = await this.handleInternal(raw, ctx);
      logStructured(
        result.status === 'REJECTED' || result.status === 'CONFLICT' ? 'warn' : 'info',
        {
          module: module ?? 'commands',
          correlationId: ctx.correlationId,
          userId: ctx.authenticatedUserId,
          deviceId: ctx.authenticatedDeviceId,
          commandType,
          durationMs: Math.round(performance.now() - startedAt),
          code:
            result.status === 'RETRY_LATER' ||
            result.status === 'REJECTED' ||
            result.status === 'CONFLICT'
              ? result.error?.code
              : result.status,
        },
        `Commande ${commandType ?? '(enveloppe invalide)'} : ${result.status}.`,
      );
      return result;
    } catch (error) {
      logStructured(
        'error',
        {
          module: module ?? 'commands',
          correlationId: ctx.correlationId,
          userId: ctx.authenticatedUserId,
          deviceId: ctx.authenticatedDeviceId,
          commandType,
          durationMs: Math.round(performance.now() - startedAt),
          code: 'VALIDATION_ERROR',
        },
        `Commande ${commandType ?? '(enveloppe invalide)'} : enveloppe rejetée avant traitement.`,
      );
      throw error;
    }
  }

  private async handleInternal(raw: unknown, ctx: HandleCommandContext): Promise<CommandResult> {
    // Les colonnes NOT NULL de sync_command_inbox exigent une enveloppe entièrement valide
    // avant même l'étape 1 : seule la validation du *payload* (schéma propre au
    // command_type) reste à l'étape 5, conformément à l'algorithme.
    const envelopeCheck = rawCommandEnvelopeSchema.safeParse(raw);
    if (!envelopeCheck.success) {
      throw new EnvelopeValidationError(
        envelopeCheck.error.issues.map((i) => i.message).join(' ; '),
      );
    }
    const envelope = envelopeCheck.data;
    const commandIdBin = toBin(envelope.command_id);
    const payloadHash = sha256Hex(canonicalJsonStringify(envelope));

    // Un jeton valide authentifie un auteur (identity/api/auth.guard.ts) ; l'enveloppe doit
    // le déclarer explicitement — pas de commande « au nom d'un autre » sans mécanisme dédié.
    if (envelope.author_user_id !== ctx.authenticatedUserId) {
      return {
        command_id: envelope.command_id,
        status: 'REJECTED',
        error: {
          code: 'FORBIDDEN',
          message_fr: "L'auteur déclaré ne correspond pas à la session authentifiée.",
        },
      };
    }

    // Étape 1 : rejeu (INV-SYN-01, INV-SYN-02). `FAILED_RETRYABLE` (étape 7) n'est **pas** un
    // résultat final : c'est l'échec transitoire lui-même (verrou, délai) que l'appareil est
    // censé faire disparaître en renvoyant le même lot (§4 « reprise »). Le renvoyer tel quel
    // ici bloquerait la commande pour toujours (aucun code n'incrémente jamais `attempts` en
    // dehors de cette reprise) — au lieu de ça, l'enveloppe identique relance les étapes 3 à 6.
    const existing = await this.db
      .selectFrom('sync_command_inbox')
      .select([
        'payload_hash',
        'status',
        'result',
        'error_code',
        'error_message',
        'attempts',
        sql<number>`TIMESTAMPDIFF(SECOND, COALESCE(claimed_at, received_at), NOW(6))`.as(
          'claim_age_seconds',
        ),
        sql<number>`TIMESTAMPDIFF(SECOND, received_at, NOW(6))`.as('first_age_seconds'),
      ])
      .where('command_id', '=', commandIdBin)
      .executeTakeFirst();
    if (existing && existing.payload_hash !== payloadHash) {
      return {
        command_id: envelope.command_id,
        status: 'REJECTED',
        error: {
          code: 'COMMAND_ID_REUSED',
          message_fr: 'Identifiant de commande déjà utilisé avec un contenu différent.',
        },
      };
    }
    // Reprenable : échec transitoire ou dépendance en attente (`FAILED_RETRYABLE`), ou ligne `RECEIVED`
    // abandonnée (réclamée depuis plus de STALE_CLAIM_SECONDS). Une ligne `RECEIVED` récemment réclamée
    // est en cours de traitement ailleurs : « réessayer ».
    const reclaimable =
      existing !== undefined &&
      (existing.status === 'FAILED_RETRYABLE' ||
        (existing.status === 'RECEIVED' &&
          Number(existing.claim_age_seconds) >= STALE_CLAIM_SECONDS));
    if (existing && !reclaimable) {
      return storedResult(envelope.command_id, existing);
    }

    let claim: Claim;
    if (existing) {
      // Reprise : la ligne existe déjà (contrainte de clé primaire), on la remet à RECEIVED plutôt que
      // d'en insérer une seconde. La reprise est **réclamée** sur le compteur de tentatives : de deux
      // renvois simultanés de la même enveloppe, un seul la traite (P5-21, AV-210).
      try {
        const claimed = await this.db
          .updateTable('sync_command_inbox')
          .set({
            status: 'RECEIVED',
            attempts: sql`attempts + 1`,
            claimed_at: sql`NOW(6)`,
            error_code: null,
            error_message: null,
          })
          .where('command_id', '=', commandIdBin)
          .where('status', '=', existing.status)
          .where('attempts', '=', existing.attempts)
          .executeTakeFirst();
        if (Number(claimed.numUpdatedRows) !== 1) {
          return inProgressResult(envelope.command_id);
        }
      } catch (error) {
        // La ligne est verrouillée par la transaction d'un autre traitement de la même commande.
        if (LOCK_ERRNOS.has(mysqlErrno(error))) return inProgressResult(envelope.command_id);
        throw error;
      }
      claim = {
        commandIdBin,
        commandId: envelope.command_id,
        authorUserId: envelope.author_user_id,
        commandType: envelope.command_type,
        attempt: existing.attempts + 1,
        firstAgeSeconds: Number(existing.first_age_seconds),
        wasStalled: existing.error_code === 'COMMAND_STALLED',
      };
    } else {
      // Étape 2 : insertion RECEIVED (la clé primaire command_id garantit l'unicité même en concurrence).
      try {
        await this.db
          .insertInto('sync_command_inbox')
          .values({
            command_id: commandIdBin,
            device_id: toBin(ctx.authenticatedDeviceId),
            user_id: toBin(envelope.author_user_id),
            device_seq: ctx.transport === 'SYNC_PUSH' ? envelope.device_seq : null,
            transport: ctx.transport,
            command_type: envelope.command_type,
            command_version: envelope.command_version,
            aggregate_type: envelope.aggregate_type,
            aggregate_id: toBin(envelope.aggregate_id),
            base_version: envelope.base_version,
            depends_on: jsonValue(envelope.depends_on),
            payload: jsonValue(envelope.payload),
            payload_hash: payloadHash,
            occurred_at: new Date(envelope.occurred_at),
            client_created_at: new Date(envelope.client_created_at),
            device_sent_at: ctx.deviceSentAt ?? null,
            batch_id: ctx.batchId !== undefined ? toBin(ctx.batchId) : null,
            clock_skew_ms: ctx.clockSkewMs ?? null,
            captured_offline: toDbBool(envelope.captured_offline),
            status: 'RECEIVED',
            claimed_at: sql<Date>`NOW(6)`,
          })
          .execute();
      } catch (error) {
        // Un envoi simultané de la même commande vient de l'enregistrer : il la traite.
        if (mysqlErrno(error) === DUPLICATE_ENTRY_ERRNO)
          return inProgressResult(envelope.command_id);
        throw error;
      }
      claim = {
        commandIdBin,
        commandId: envelope.command_id,
        authorUserId: envelope.author_user_id,
        commandType: envelope.command_type,
        attempt: 1,
        firstAgeSeconds: 0,
        wasStalled: false,
      };
    }

    // Étape 3a : dépendances (BR-SYN-004). Une dépendance pas encore réglée met la ligne en
    // `FAILED_RETRYABLE` (`DEPENDENCY_PENDING`) : le renvoi identique la reprend (P5-21, AV-210 — elle
    // restait `RECEIVED` et son renvoi rendait ce statut au lieu de la traiter : fait jamais appliqué).
    // Une dépendance réglée sans être appliquée (`CONFLICT`, quarantaine) laisse passer la dépendante :
    // la faire attendre la bloquerait pour toujours, une quarantaine ne s'appliquant jamais seule.
    if (envelope.depends_on.length > 0) {
      const deps = await this.db
        .selectFrom('sync_command_inbox')
        .select(['command_id', 'status'])
        .where(
          'command_id',
          'in',
          envelope.depends_on.map((id) => toBin(id)),
        )
        .execute();
      const knownStatus = new Map(deps.map((d) => [fromBin(d.command_id), d.status]));
      for (const depId of envelope.depends_on) {
        const status = knownStatus.get(depId);
        // P5-21 (AV-210) : une dépendance reçue mais pas encore réglée (`RECEIVED`, en cours ailleurs ;
        // `FAILED_RETRYABLE`, à renvoyer) n'est pas encore appliquée : la dépendante attend aussi.
        if (status === undefined || status === 'RECEIVED' || status === 'FAILED_RETRYABLE') {
          return this.retryLater(
            claim,
            'DEPENDENCY_PENDING',
            'Dépendance pas encore appliquée par le serveur.',
          );
        }
        if (status === 'REJECTED') {
          return this.markAndReject(claim, 'DEPENDENCY_REJECTED', 'Dépendance rejetée.');
        }
      }
    }

    const occurredAt = new Date(envelope.occurred_at);

    // Étape 3b : appareil (RC-02).
    const deviceCheck = await checkDeviceActive(
      this.db,
      toBin(ctx.authenticatedDeviceId),
      occurredAt,
    );
    if (!deviceCheck.ok) {
      return this.markAndConflict(
        claim,
        deviceCheck.reason,
        'Appareil bloqué, perdu ou retiré avant cette opération.',
      );
    }

    // Étape 3c : utilisateur.
    const userCheck = await checkUserActive(this.db, toBin(envelope.author_user_id), occurredAt);
    if (!userCheck.ok) {
      return this.markAndConflict(
        claim,
        userCheck.reason,
        'Utilisateur désactivé avant cette opération.',
      );
    }

    // Étape 3d : horodatage futur, **après correction de l'écart d'horloge mesuré** du lot (INV-GLO-02,
    // BR-SYN-011, 02-synchronisation.md §3.2, ADR-016) : une tablette en avance de deux heures n'a pas
    // saisi dans le futur ; son `occurred_at` est gardé tel quel (aucune correction silencieuse), seul
    // ce contrôle le ramène à l'heure serveur. La correction n'excuse qu'une horloge **en avance** (écart
    // négatif) : une horloge en retard à l'envoi ne rend jamais future une date qui ne l'était pas (une
    // horloge qui a reculé entre la saisie et l'envoi ferait rejeter des faits exacts, revue de P5-21).
    // Sans écart mesuré (`/commands`), l'heure brute.
    const correctedOccurredAt = occurredAt.getTime() + Math.min(0, ctx.clockSkewMs ?? 0);
    if (correctedOccurredAt > this.clock.now().getTime() + OCCURRED_AT_FUTURE_TOLERANCE_MS) {
      return this.markAndReject(claim, 'OCCURRED_AT_FUTURE', 'Horodatage dans le futur.');
    }

    // Étape 3e : version supportée.
    if (!this.registry.isVersionSupported(envelope.command_type, envelope.command_version)) {
      return this.markAndReject(
        claim,
        'UNSUPPORTED_VERSION',
        'Version de commande non prise en charge.',
      );
    }

    // Étape 4 : RBAC à occurred_at (RC-01).
    const entry = this.registry.resolve(envelope.command_type, envelope.command_version);
    if (!entry) {
      return this.markAndReject(
        claim,
        'UNSUPPORTED_VERSION',
        'Aucun gestionnaire enregistré pour cette commande.',
      );
    }
    const allowed = await hasPermissionAt(
      this.db,
      toBin(envelope.author_user_id),
      entry.permissionCode,
      occurredAt,
    );
    if (!allowed) {
      await recordDenied(
        this.db,
        { idGenerator: this.idGenerator, clock: this.clock },
        {
          occurredAt,
          actorUserId: envelope.author_user_id,
          actorRoles: [],
          deviceId: ctx.authenticatedDeviceId,
          capturedOffline: envelope.captured_offline,
          commandId: envelope.command_id,
          action: 'access.denied',
          entityType: envelope.aggregate_type,
          entityId: envelope.aggregate_id,
          reason: `Permission manquante : ${entry.permissionCode}.`,
          errorCode: 'FORBIDDEN',
          correlationId: ctx.correlationId ?? null,
        },
      );
      return this.markAndReject(claim, 'FORBIDDEN', 'Droit insuffisant pour cette opération.');
    }

    // Étape 5 : validation du payload (schéma versionné, partagé avec l'appareil).
    const parsed = this.registry.parse(raw);
    if (!parsed.ok) {
      const detail = parsed.issues?.map((i) => i.message).join(' ; ') ?? parsed.reason;
      return this.markAndReject(claim, `VALIDATION_ERROR:${parsed.reason}`, detail);
    }

    // Étape 6 : transaction métier.
    try {
      const transaction = this.db.transaction();
      const outcome = await (
        entry.isolationLevel !== undefined
          ? transaction.setIsolationLevel(entry.isolationLevel)
          : transaction
      ).execute(async (trx) => {
        // La ligne d'inbox d'abord, sous verrou : ce traitement tient-il encore la réclamation ? Un
        // renvoi simultané qui voudrait la reprendre attend la fin de cette transaction (sa réclamation
        // échoue alors sur la tentative) ; s'il l'a reprise avant, celui-ci s'arrête sans effet.
        const held = await trx
          .selectFrom('sync_command_inbox')
          .select(['status', 'attempts'])
          .where('command_id', '=', commandIdBin)
          .forUpdate()
          .executeTakeFirst();
        if (held?.status !== 'RECEIVED' || held.attempts !== claim.attempt) throw new ClaimLost();

        const handlerOutcome = await entry.handler(trx, parsed.envelope);
        if (handlerOutcome.status === 'REJECTED') {
          // Un rejet n'a aucun effet : l'exception annule la transaction, y compris une
          // écriture que le gestionnaire aurait faite avant de conclure au rejet.
          throw new HandlerRejection(handlerOutcome);
        }
        const handlerAudit = 'audit' in handlerOutcome ? handlerOutcome.audit : undefined;

        await recordAudit(
          trx,
          { idGenerator: this.idGenerator, clock: this.clock },
          {
            occurredAt,
            actorUserId: envelope.author_user_id,
            actorRoles: [],
            deviceId: ctx.authenticatedDeviceId,
            capturedOffline: envelope.captured_offline,
            commandId: envelope.command_id,
            action: envelope.command_type,
            entityType: envelope.aggregate_type,
            entityId: envelope.aggregate_id,
            ...(handlerAudit?.before !== undefined ? { before: handlerAudit.before } : {}),
            after: handlerAudit?.after ?? envelope.payload,
            result: 'SUCCESS',
            correlationId: ctx.correlationId ?? null,
          },
        );

        await trx
          .insertInto('platform_domain_events')
          .values({
            event_id: toBin(this.idGenerator.newId()),
            event_type: envelope.command_type,
            producer_module: envelope.command_type.split('.')[0]!,
            aggregate_type: envelope.aggregate_type,
            aggregate_id: toBin(envelope.aggregate_id),
            occurred_at: occurredAt,
            payload: jsonValue(envelope.payload),
            command_id: commandIdBin,
            correlation_id: ctx.correlationId ? toBin(ctx.correlationId) : null,
          })
          .execute();

        // Portée/jeu de données réels déterminés par chaque module (P0-11 et suivants,
        // 06-offline-sync/02-synchronisation.md §5) : GLOBAL/aggregate_type ici est un
        // repli générique valable pour n'importe quel gestionnaire enregistré par P0-06.
        await trx
          .insertInto('sync_change_feed')
          .values({
            dataset: envelope.aggregate_type.toLowerCase(),
            entity_type: envelope.aggregate_type,
            entity_id: toBin(envelope.aggregate_id),
            change_type: 'UPSERT',
            scope_type: 'GLOBAL',
            scope_id: null,
            row_version: 1,
          })
          .execute();

        const result = commandResultOf(envelope.command_id, handlerOutcome);
        await trx
          .updateTable('sync_command_inbox')
          .set({
            status: handlerOutcome.status,
            applied_at: this.clock.now(),
            result: jsonValue(result),
          })
          .where('command_id', '=', commandIdBin)
          .where('status', '=', 'RECEIVED')
          .where('attempts', '=', claim.attempt)
          .execute();
        if (claim.wasStalled) await this.closeStalledSignal(trx, claim, handlerOutcome.status);

        return handlerOutcome;
      });
      return commandResultOf(envelope.command_id, outcome);
    } catch (error) {
      if (error instanceof ClaimLost) return inProgressResult(envelope.command_id);
      if (error instanceof HandlerRejection) {
        return this.markAndReject(claim, error.outcome.errorCode, error.outcome.messageFr);
      }
      // Étape 7 : erreur transitoire (verrou, délai, échec inattendu du gestionnaire) — la
      // transaction métier a déjà été annulée automatiquement (rejet de la promesse passée
      // à `transaction().execute`) ; seule la mise à jour de l'inbox, hors transaction,
      // reste à faire, et seulement si ce traitement tient encore la réclamation.
      return this.retryLater(
        claim,
        'SERVER_BUSY',
        'Erreur transitoire, à réessayer.',
        errorMessageOf(error),
      );
    }
  }

  /**
   * Conclut l'inbox d'un traitement qui tient encore sa réclamation (`RECEIVED`, même tentative).
   * `false` : un autre traitement l'a reprise entre-temps — celui-ci ne doit rien affirmer.
   */
  private async settleInbox(
    claim: Claim,
    values: {
      readonly status: 'REJECTED' | 'CONFLICT' | 'FAILED_RETRYABLE';
      readonly error_code: string;
      readonly error_message: string;
    },
  ): Promise<boolean> {
    const updated = await this.db
      .updateTable('sync_command_inbox')
      .set(values)
      .where('command_id', '=', claim.commandIdBin)
      .where('status', '=', 'RECEIVED')
      .where('attempts', '=', claim.attempt)
      .executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1;
  }

  private async markAndReject(
    claim: Claim,
    errorCode: string,
    messageFr: string,
  ): Promise<CommandResult> {
    const settled = await this.settleInbox(claim, {
      status: 'REJECTED',
      error_code: errorCode,
      error_message: messageFr,
    });
    if (!settled) return inProgressResult(claim.commandId);
    if (claim.wasStalled) {
      await this.db.transaction().execute((trx) => this.closeStalledSignal(trx, claim, 'REJECTED'));
    }
    return {
      command_id: claim.commandId,
      status: 'REJECTED',
      error: { code: errorCode, message_fr: messageFr },
    };
  }

  private async markAndConflict(
    claim: Claim,
    errorCode: string,
    messageFr: string,
  ): Promise<CommandResult> {
    const settled = await this.settleInbox(claim, {
      status: 'CONFLICT',
      error_code: errorCode,
      error_message: messageFr,
    });
    if (!settled) return inProgressResult(claim.commandId);
    if (claim.wasStalled) {
      await this.db.transaction().execute((trx) => this.closeStalledSignal(trx, claim, 'CONFLICT'));
    }
    return {
      command_id: claim.commandId,
      status: 'CONFLICT',
      error: { code: errorCode, message_fr: messageFr },
    };
  }

  /**
   * Commande à renvoyer (dépendance en attente, erreur transitoire) : `FAILED_RETRYABLE`, reprise au
   * renvoi identique. Au-delà de `sync.retry_hold_minutes` depuis sa première réception (AV-217), elle
   * est signalée bloquée (`COMMAND_STALLED`) : toujours à renvoyer, mais elle ne suspend plus la suite
   * de son lot, et le signal `SYNC_COMMAND_STALLED` est ouvert (une fois) pour l'Admin.
   */
  private async retryLater(
    claim: Claim,
    reasonCode: 'DEPENDENCY_PENDING' | 'SERVER_BUSY',
    messageFr: string,
    detail?: string,
  ): Promise<CommandResult> {
    const holdMinutes =
      claim.firstAgeSeconds > 0
        ? retryHoldMinutesFrom(
            await currentSettingValue(this.db, {
              key: 'sync.retry_hold_minutes',
              scopeType: 'GLOBAL',
              scopeId: null,
              at: this.clock.now(),
            }),
          )
        : undefined;
    const stalled = holdMinutes !== undefined && claim.firstAgeSeconds >= holdMinutes * 60;
    const code = stalled ? 'COMMAND_STALLED' : reasonCode;
    const message = stalled
      ? `Commande bloquée depuis plus de ${holdMinutes} min (${reasonCode}) : toujours à renvoyer, elle ne retient plus la suite de la file.`
      : messageFr;
    const settled = await this.settleInbox(claim, {
      status: 'FAILED_RETRYABLE',
      error_code: code,
      error_message: detail ?? message,
    });
    if (!settled) return inProgressResult(claim.commandId);
    if (stalled) {
      await this.openStalledSignal(claim, reasonCode, holdMinutes, detail ?? messageFr);
    }
    return {
      command_id: claim.commandId,
      status: 'RETRY_LATER',
      error: { code, message_fr: message },
    };
  }

  /** Signal `SYNC_COMMAND_STALLED` de la commande, ouvert une seule fois (file des conflits, Admin). */
  private async openStalledSignal(
    claim: Claim,
    reason: string,
    holdMinutes: number,
    detail: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const open = await trx
        .selectFrom('sync_sync_conflicts')
        .select('id')
        .where('conflict_type', '=', STALLED_CONFLICT_TYPE)
        .where('entity_type', '=', STALLED_ENTITY_TYPE)
        .where('entity_id', '=', claim.commandIdBin)
        .where('status', '=', 'OPEN')
        .executeTakeFirst();
      if (open) return;
      await recordConflict(trx, {
        id: this.idGenerator.newId(),
        commandId: claim.commandId,
        conflictType: STALLED_CONFLICT_TYPE,
        entityType: STALLED_ENTITY_TYPE,
        entityId: claim.commandId,
        siteId: null,
        ownerRole: 'ADMIN',
        applied: false,
        details: {
          commandType: claim.commandType,
          reason,
          detail,
          attempts: claim.attempt,
          stalledForMinutes: Math.floor(claim.firstAgeSeconds / 60),
          holdMinutes,
        },
      });
    });
  }

  /** La commande signalée bloquée s'est réglée au renvoi : le signal se ferme, avec son issue. */
  private async closeStalledSignal(
    executor: UnitOfWork,
    claim: Claim,
    status: string,
  ): Promise<void> {
    await resolveOpenConflicts(executor, {
      conflictType: STALLED_CONFLICT_TYPE,
      entityType: STALLED_ENTITY_TYPE,
      entityIds: [claim.commandId],
      resolution: status.startsWith('APPLIED') ? 'ACCEPT_CLIENT' : 'KEEP_SERVER',
      resolvedBy: claim.authorUserId,
      resolvedAt: this.clock.now(),
      comment: `Commande réglée au renvoi : ${status}.`,
    });
  }
}

/** Numéro d'erreur MySQL d'une exception du pilote (`errno`), 0 sinon. */
function mysqlErrno(error: unknown): number {
  return typeof error === 'object' && error !== null && 'errno' in error
    ? Number((error as { errno: unknown }).errno)
    : 0;
}

/** Même enveloppe en cours de traitement par une autre requête : l'appareil la renverra. */
function inProgressResult(commandId: string): CommandResult {
  return {
    command_id: commandId,
    status: 'RETRY_LATER',
    error: { code: 'SERVER_BUSY', message_fr: 'Commande en cours de traitement, à réessayer.' },
  };
}

function storedResult(
  commandId: string,
  existing: {
    status: string;
    result: unknown;
    error_code: string | null;
    error_message: string | null;
  },
): CommandResult {
  if (existing.result !== null && typeof existing.result === 'object') {
    return existing.result as CommandResult;
  }
  // `RECEIVED` n'est pas un résultat : la commande est en cours de traitement ailleurs.
  if (existing.status === 'RECEIVED') return inProgressResult(commandId);
  const status = existing.status as CommandResult['status'];
  if (existing.error_code) {
    return {
      command_id: commandId,
      status,
      error: { code: existing.error_code, message_fr: existing.error_message ?? '' },
    };
  }
  return { command_id: commandId, status };
}

function commandResultOf(
  commandId: string,
  outcome: Exclude<CommandHandlerOutcome, { status: 'REJECTED' }>,
): CommandResult {
  switch (outcome.status) {
    case 'APPLIED':
      return {
        command_id: commandId,
        status: 'APPLIED',
        ...(outcome.serverRefs ? { server_refs: outcome.serverRefs } : {}),
      };
    case 'APPLIED_WITH_WARNINGS':
      return {
        command_id: commandId,
        status: 'APPLIED_WITH_WARNINGS',
        warnings: [...outcome.warnings],
        ...(outcome.serverRefs ? { server_refs: outcome.serverRefs } : {}),
      };
    case 'CONFLICT':
      return { command_id: commandId, status: 'CONFLICT', conflict_id: outcome.conflictId };
  }
}

/** Rejet métier d'un gestionnaire, levé pour annuler la transaction (étape 6). */
class HandlerRejection extends Error {
  constructor(readonly outcome: Extract<CommandHandlerOutcome, { status: 'REJECTED' }>) {
    super(outcome.errorCode);
  }
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
