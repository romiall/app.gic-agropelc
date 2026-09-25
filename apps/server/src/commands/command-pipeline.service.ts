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
 * Rejet à toute étape avant 6 : aucune table métier touchée (INV-SYN-05) — seul `inbox`
 * (registre de synchronisation, pas une table métier) change de statut ; une commande qui
 * attend une dépendance (RETRY_LATER/DEPENDENCY_PENDING) n'est même pas mise à jour, elle
 * reste `RECEIVED` (aucun statut « en attente » distinct dans `sync_command_inbox`, seule
 * la réponse au client diffère — §3.2 point 3).
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
import { recordAudit } from '../audit/record-audit.js';
import { recordDenied } from '../audit/record-denied.js';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../platform/sync/command-handler-registry.provider.js';
import type { CommandHandlerOutcome } from '../platform/sync/command-handler-registry.js';

const OCCURRED_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

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
}

@Injectable()
export class CommandPipelineService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  async handle(raw: unknown, ctx: HandleCommandContext): Promise<CommandResult> {
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
      .select(['payload_hash', 'status', 'result', 'error_code', 'error_message'])
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
    if (existing && existing.status !== 'FAILED_RETRYABLE') {
      return storedResult(envelope.command_id, existing);
    }

    if (existing) {
      // Reprise après échec transitoire : la ligne existe déjà (contrainte de clé primaire),
      // on la remet à RECEIVED plutôt que d'en insérer une seconde.
      await this.db
        .updateTable('sync_command_inbox')
        .set({ status: 'RECEIVED', attempts: sql`attempts + 1`, error_message: null })
        .where('command_id', '=', commandIdBin)
        .execute();
    } else {
      // Étape 2 : insertion RECEIVED (la clé primaire command_id garantit l'unicité même en concurrence).
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
        })
        .execute();
    }

    // Étape 3a : dépendances (BR-SYN-004) — aucun statut « en attente » propre à inbox :
    // une dépendance non connue laisse la ligne RECEIVED, seule la réponse diffère.
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
        if (status === undefined) {
          return {
            command_id: envelope.command_id,
            status: 'RETRY_LATER',
            error: {
              code: 'DEPENDENCY_PENDING',
              message_fr: 'Dépendance pas encore connue du serveur.',
            },
          };
        }
        if (status === 'REJECTED') {
          return this.markAndReject(
            commandIdBin,
            envelope.command_id,
            'DEPENDENCY_REJECTED',
            'Dépendance rejetée.',
          );
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
        commandIdBin,
        envelope.command_id,
        deviceCheck.reason,
        'Appareil bloqué, perdu ou retiré avant cette opération.',
      );
    }

    // Étape 3c : utilisateur.
    const userCheck = await checkUserActive(this.db, toBin(envelope.author_user_id), occurredAt);
    if (!userCheck.ok) {
      return this.markAndConflict(
        commandIdBin,
        envelope.command_id,
        userCheck.reason,
        'Utilisateur désactivé avant cette opération.',
      );
    }

    // Étape 3d : horodatage futur.
    if (occurredAt.getTime() > this.clock.now().getTime() + OCCURRED_AT_FUTURE_TOLERANCE_MS) {
      return this.markAndReject(
        commandIdBin,
        envelope.command_id,
        'OCCURRED_AT_FUTURE',
        'Horodatage dans le futur.',
      );
    }

    // Étape 3e : version supportée.
    if (!this.registry.isVersionSupported(envelope.command_type, envelope.command_version)) {
      return this.markAndReject(
        commandIdBin,
        envelope.command_id,
        'UNSUPPORTED_VERSION',
        'Version de commande non prise en charge.',
      );
    }

    // Étape 4 : RBAC à occurred_at (RC-01).
    const entry = this.registry.resolve(envelope.command_type, envelope.command_version);
    if (!entry) {
      return this.markAndReject(
        commandIdBin,
        envelope.command_id,
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
        },
      );
      return this.markAndReject(
        commandIdBin,
        envelope.command_id,
        'FORBIDDEN',
        'Droit insuffisant pour cette opération.',
      );
    }

    // Étape 5 : validation du payload (schéma versionné, partagé avec l'appareil).
    const parsed = this.registry.parse(raw);
    if (!parsed.ok) {
      const detail = parsed.issues?.map((i) => i.message).join(' ; ') ?? parsed.reason;
      return this.markAndReject(
        commandIdBin,
        envelope.command_id,
        `VALIDATION_ERROR:${parsed.reason}`,
        detail,
      );
    }

    // Étape 6 : transaction métier.
    try {
      const outcome = await this.db.transaction().execute(async (trx) => {
        const handlerOutcome = await entry.handler(trx, parsed.envelope);
        if (handlerOutcome.status === 'REJECTED') {
          return handlerOutcome;
        }

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
            after: envelope.payload,
            result: 'SUCCESS',
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
          .execute();

        return handlerOutcome;
      });

      if (outcome.status === 'REJECTED') {
        return this.markAndReject(
          commandIdBin,
          envelope.command_id,
          outcome.errorCode,
          outcome.messageFr,
        );
      }
      return commandResultOf(envelope.command_id, outcome);
    } catch (error) {
      // Étape 7 : erreur transitoire (verrou, délai, échec inattendu du gestionnaire) — la
      // transaction métier a déjà été annulée automatiquement (rejet de la promesse passée
      // à `transaction().execute`) ; seule la mise à jour de l'inbox, hors transaction,
      // reste à faire.
      await this.db
        .updateTable('sync_command_inbox')
        .set({ status: 'FAILED_RETRYABLE', error_message: errorMessageOf(error) })
        .where('command_id', '=', commandIdBin)
        .execute();
      return {
        command_id: envelope.command_id,
        status: 'RETRY_LATER',
        error: { code: 'SERVER_BUSY', message_fr: 'Erreur transitoire, à réessayer.' },
      };
    }
  }

  private async markAndReject(
    commandIdBin: Buffer,
    commandId: string,
    errorCode: string,
    messageFr: string,
  ): Promise<CommandResult> {
    await this.db
      .updateTable('sync_command_inbox')
      .set({ status: 'REJECTED', error_code: errorCode, error_message: messageFr })
      .where('command_id', '=', commandIdBin)
      .execute();
    return {
      command_id: commandId,
      status: 'REJECTED',
      error: { code: errorCode, message_fr: messageFr },
    };
  }

  private async markAndConflict(
    commandIdBin: Buffer,
    commandId: string,
    errorCode: string,
    messageFr: string,
  ): Promise<CommandResult> {
    await this.db
      .updateTable('sync_command_inbox')
      .set({ status: 'CONFLICT', error_code: errorCode, error_message: messageFr })
      .where('command_id', '=', commandIdBin)
      .execute();
    return {
      command_id: commandId,
      status: 'CONFLICT',
      error: { code: errorCode, message_fr: messageFr },
    };
  }
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

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
