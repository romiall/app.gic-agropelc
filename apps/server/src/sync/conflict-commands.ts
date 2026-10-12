/**
 * Traitement manuel des conflits de synchronisation (P5-17 ; SM-CONFLICT ; BR-SYN-017 ; AV-190) :
 * `sync.conflict.resolve` et `sync.conflict.dismiss`, agrégat `SYNC_CONFLICT` (identifiant du conflit),
 * permission `sync.conflict.resolve`, **en ligne seulement** (D14 UC-SYN-07 : `ONLINE_REQUIRED`).
 *
 * La résolution est une **clôture administrative tracée** (décision, auteur, motif, références) : le
 * serveur ne rejoue aucune commande et ne crée aucun document — la régularisation éventuelle passe
 * par les commandes ordinaires de chaque module, dont la personne cite les documents dans `refs`
 * (`resolution_refs`). En conséquence (AV-190) :
 * - `dismiss` (statut `DISMISSED`, sans résolution) : conflit **informatif** seulement (fait appliqué) ;
 * - `resolve` d'une **quarantaine** (commande non appliquée) : `KEEP_SERVER` (le fait reste écarté) ou
 *   `COMPENSATE` (régularisé par d'autres documents) ; `ACCEPT_CLIENT` et `MERGE` supposeraient le rejeu
 *   de la commande (`CONFLICT_REPLAY_NOT_SUPPORTED`) ;
 * - `COMPENSATE` exige au moins une référence (`CONFLICT_REFS_REQUIRED`) ;
 * - un conflit dont la clôture appartient à une décision propre n'est jamais clos ici
 *   (`CONFLICT_MANAGED_ELSEWHERE` : `PAYMENT_REFERENCE_DUPLICATE`, décision `PAYMENT_DUPLICATE`) ;
 * - conflit inconnu ⇒ `NOT_FOUND` ; hors rôle propriétaire ou hors portée ⇒ `FORBIDDEN_SCOPE` (AV-191) ;
 *   déjà clos (par une autre personne ou par sa régularisation) ⇒ `CONFLICT_ALREADY_CLOSED`.
 * - P5-23 (revue adverse, AV-225) : résoudre le signal `SYNC_COMMAND_STALLED` d'une commande bloquée
 *   (`KEEP_SERVER` : le fait est écarté ; `COMPENSATE` : il a été ressaisi par d'autres documents)
 *   **écarte la commande** : sa ligne d'inbox passe `REJECTED` (`COMMAND_DISCARDED`), le renvoi suivant
 *   reçoit ce refus définitif — sinon elle restait rejouable et s'appliquait après la régularisation
 *   (double comptage). L'inbox de la commande est verrouillée avant le conflit (ordre du pipeline,
 *   ADR-038 : un renvoi tient son inbox, puis clôt le signal).
 * - revue de P5-17 : un conflit sur un fait appliqué n'est jamais clos par l'auteur de ce fait
 *   (`CONFLICT_SELF_RESOLUTION_FORBIDDEN`, AV-192) ; `ALLOCATION_OVERCOMMITTED` et `STOCK_NEGATIVE` ne se
 *   closent qu'une fois l'anomalie régularisée (`CONFLICT_CONDITION_PERSISTS`).
 * Effets : conflit clos (`platform/sync/conflicts.ts`, table du noyau), événement
 * `SyncConflictResolved` (producteur `sync`), audit avant/après par le pipeline.
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import type { IdGenerator } from '@gic/domain';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../platform/sync/command-handler-registry.provider.js';
import type {
  CommandHandler,
  CommandHandlerOutcome,
} from '../platform/sync/command-handler-registry.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import type { UnitOfWork } from '../platform/unit-of-work.js';
import { jsonValue } from '../platform/kysely/json-value.js';
import { toBin } from '../platform/kysely/uuid-columns.js';
import {
  CONFLICT_RESOLUTIONS,
  closeConflict,
  findConflict,
  type ConflictRecord,
  type ConflictResolution,
} from '../platform/sync/conflicts.js';
import {
  hasNegativeStock,
  isAllocationOvercommitted,
} from '../modules/inventory/application/public/index.js';
import { CONFLICT_RESOLVE, conflictVisible } from './conflict-access.js';
import { STALLED_CONFLICT_TYPE } from '../commands/retry-hold.js';

/** Conflits dont la clôture appartient à une décision propre (jamais clos par `sync.conflict.*`). */
export const CONFLICTS_MANAGED_ELSEWHERE: ReadonlySet<string> = new Set([
  'PAYMENT_REFERENCE_DUPLICATE',
]);

const comment = z.string().trim().min(1, 'Motif obligatoire.').max(1000);
const resolvePayloadSchema = z.object({
  resolution: z.enum(CONFLICT_RESOLUTIONS),
  comment,
  refs: z.array(z.string().uuid()).max(20).optional(),
});
const dismissPayloadSchema = z.object({ comment });
type ResolvePayload = z.infer<typeof resolvePayloadSchema>;
type DismissPayload = z.infer<typeof dismissPayloadSchema>;

function rejected(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}

/** Contrôles communs : en ligne, conflit connu, visible, ouvert, clôturable ici. */
async function openConflictFor(
  uow: UnitOfWork,
  envelope: {
    readonly captured_offline: boolean;
    readonly aggregate_id: string;
    readonly author_user_id: string;
  },
  at: Date,
): Promise<
  | { readonly ok: true; readonly conflict: ConflictRecord }
  | { readonly ok: false; readonly outcome: CommandHandlerOutcome }
> {
  if (envelope.captured_offline) {
    return {
      ok: false,
      outcome: rejected('ONLINE_REQUIRED', 'Le traitement d’un conflit se fait en ligne.'),
    };
  }
  const conflict = await findConflict(uow, envelope.aggregate_id, { lock: true });
  if (!conflict) return { ok: false, outcome: rejected('NOT_FOUND', 'Conflit introuvable.') };
  if (!(await conflictVisible(uow, { userId: envelope.author_user_id, at, conflict }))) {
    return {
      ok: false,
      outcome: rejected(
        'FORBIDDEN_SCOPE',
        'Ce conflit relève d’un autre rôle ou d’un autre périmètre (matrice des conflits).',
      ),
    };
  }
  if (conflict.status !== 'OPEN') {
    return {
      ok: false,
      outcome: rejected('CONFLICT_ALREADY_CLOSED', 'Ce conflit est déjà clos.'),
    };
  }
  if (CONFLICTS_MANAGED_ELSEWHERE.has(conflict.conflictType)) {
    return {
      ok: false,
      outcome: rejected(
        'CONFLICT_MANAGED_ELSEWHERE',
        'Ce conflit se clôt par sa décision propre (validation du doublon d’encaissement).',
      ),
    };
  }
  // AV-192 : un signal sur un fait appliqué n'est jamais clos par l'auteur du fait (séparation des
  // tâches, AV-010) ; la quarantaine de sa propre commande (rien d'appliqué) peut l'être.
  if (conflict.applied && conflict.authorUserId === envelope.author_user_id) {
    return {
      ok: false,
      outcome: rejected(
        'CONFLICT_SELF_RESOLUTION_FORBIDDEN',
        'Un conflit sur une opération que vous avez saisie est traité par une autre personne.',
      ),
    };
  }
  if (await conditionPersists(uow, conflict)) {
    return {
      ok: false,
      outcome: rejected(
        'CONFLICT_CONDITION_PERSISTS',
        'L’anomalie est toujours présente : la régulariser d’abord (inventaire, révocation ou libération de quotas).',
      ),
    };
  }
  return { ok: true, conflict };
}

/**
 * AV-190 : anomalies de stock « jamais corrigées en silence » (matrice des conflits ; BR-STK-018) — la
 * clôture manuelle attend leur régularisation (`ALLOCATION_OVERCOMMITTED` : emplacement en entité,
 * produit en détail ; `STOCK_NEGATIVE` : emplacement et produit en détail).
 */
async function conditionPersists(uow: UnitOfWork, conflict: ConflictRecord): Promise<boolean> {
  const details = (conflict.details ?? {}) as Record<string, unknown>;
  const productId = typeof details['productId'] === 'string' ? details['productId'] : null;
  if (productId === null) return false;
  if (conflict.conflictType === 'ALLOCATION_OVERCOMMITTED') {
    return isAllocationOvercommitted(uow, conflict.entityId, productId);
  }
  if (conflict.conflictType === 'STOCK_NEGATIVE') {
    const locationId = typeof details['locationId'] === 'string' ? details['locationId'] : null;
    return locationId !== null && hasNegativeStock(uow, locationId, productId);
  }
  return false;
}

async function finish(
  uow: UnitOfWork,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly envelope: { readonly command_id: string; readonly author_user_id: string };
    readonly conflict: ConflictRecord;
    readonly status: 'RESOLVED' | 'DISMISSED';
    readonly resolution: ConflictResolution | null;
    readonly refs: readonly string[];
    readonly comment: string;
    readonly at: Date;
  },
): Promise<CommandHandlerOutcome> {
  const closed = await closeConflict(uow, {
    id: input.conflict.id,
    status: input.status,
    resolution: input.resolution,
    refs: input.refs,
    comment: input.comment,
    closedBy: input.envelope.author_user_id,
    closedAt: input.at,
  });
  if (!closed) return rejected('CONFLICT_ALREADY_CLOSED', 'Ce conflit est déjà clos.');
  const outcome = {
    status: input.status,
    resolution: input.resolution,
    refs: input.refs,
    comment: input.comment,
  };
  await uow
    .insertInto('platform_domain_events')
    .values({
      event_id: toBin(deps.idGenerator.newId()),
      event_type: 'SyncConflictResolved',
      producer_module: 'sync',
      aggregate_type: 'SYNC_CONFLICT',
      aggregate_id: toBin(input.conflict.id),
      occurred_at: input.at,
      payload: jsonValue({
        conflict_id: input.conflict.id,
        conflict_type: input.conflict.conflictType,
        owner_role: input.conflict.ownerRole,
        entity_type: input.conflict.entityType,
        entity_id: input.conflict.entityId,
        site_id: input.conflict.siteId,
        applied: input.conflict.applied,
        status: input.status,
        resolution: input.resolution,
        refs: input.refs,
      }),
      command_id: toBin(input.envelope.command_id),
    })
    .execute();
  return {
    status: 'APPLIED',
    serverRefs: {
      conflictId: input.conflict.id,
      status: input.status,
      ...(input.resolution !== null ? { resolution: input.resolution } : {}),
    },
    audit: {
      before: { status: 'OPEN', conflictType: input.conflict.conflictType },
      after: outcome,
    },
  };
}

export function registerSyncConflictCommands(
  registry: CommandHandlerRegistry,
  deps: { readonly idGenerator: IdGenerator },
): void {
  const resolve: CommandHandler<ResolvePayload> = async (uow, envelope) => {
    const at = new Date(envelope.occurred_at);
    // Signal d'une commande bloquée : l'inbox de la commande d'abord, puis le conflit (AV-225).
    const peek = await findConflict(uow, envelope.aggregate_id);
    const stalledCommand =
      peek?.conflictType === STALLED_CONFLICT_TYPE ? toBin(peek.entityId) : null;
    if (stalledCommand !== null) {
      await uow
        .selectFrom('sync_command_inbox')
        .select('status')
        .where('command_id', '=', stalledCommand)
        .forUpdate()
        .executeTakeFirst();
    }
    const check = await openConflictFor(uow, envelope, at);
    if (!check.ok) return check.outcome;
    const p = envelope.payload;
    const refs = [...new Set(p.refs ?? [])];
    if (!check.conflict.applied && (p.resolution === 'ACCEPT_CLIENT' || p.resolution === 'MERGE')) {
      return rejected(
        'CONFLICT_REPLAY_NOT_SUPPORTED',
        'Une commande en quarantaine n’est pas rejouée : garder l’état du serveur, ou régulariser par d’autres documents et les citer (COMPENSATE).',
      );
    }
    if (p.resolution === 'COMPENSATE' && refs.length === 0) {
      return rejected(
        'CONFLICT_REFS_REQUIRED',
        'Citer le ou les documents de régularisation (refs).',
      );
    }
    if (stalledCommand !== null && check.conflict.conflictType === STALLED_CONFLICT_TYPE) {
      // La commande ne s'appliquera plus : refus définitif rendu à son prochain renvoi.
      await uow
        .updateTable('sync_command_inbox')
        .set({
          status: 'REJECTED',
          error_code: 'COMMAND_DISCARDED',
          error_message: `Commande écartée à la résolution de son blocage (${p.resolution}) : ${p.comment}`,
        })
        .where('command_id', '=', stalledCommand)
        .where('status', 'in', ['RECEIVED', 'FAILED_RETRYABLE'])
        .execute();
    }
    return finish(uow, deps, {
      envelope,
      conflict: check.conflict,
      status: 'RESOLVED',
      resolution: p.resolution,
      refs,
      comment: p.comment,
      at,
    });
  };

  const dismiss: CommandHandler<DismissPayload> = async (uow, envelope) => {
    const at = new Date(envelope.occurred_at);
    const check = await openConflictFor(uow, envelope, at);
    if (!check.ok) return check.outcome;
    if (!check.conflict.applied) {
      return rejected(
        'CONFLICT_NOT_INFORMATIVE',
        'Une commande en quarantaine se résout (KEEP_SERVER ou COMPENSATE), elle ne s’écarte pas.',
      );
    }
    return finish(uow, deps, {
      envelope,
      conflict: check.conflict,
      status: 'DISMISSED',
      resolution: null,
      refs: [],
      comment: envelope.payload.comment,
      at,
    });
  };

  registry.register({
    commandType: 'sync.conflict.resolve',
    version: 1,
    payloadSchema: resolvePayloadSchema,
    permissionCode: CONFLICT_RESOLVE,
    handler: resolve,
  });
  registry.register({
    commandType: 'sync.conflict.dismiss',
    version: 1,
    payloadSchema: dismissPayloadSchema,
    permissionCode: CONFLICT_RESOLVE,
    handler: dismiss,
  });
}

@Injectable()
export class SyncConflictCommandsRegistrar implements OnModuleInit {
  constructor(
    @Inject(COMMAND_HANDLER_REGISTRY) private readonly registry: CommandHandlerRegistry,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  onModuleInit(): void {
    registerSyncConflictCommands(this.registry, { idGenerator: this.idGenerator });
  }
}
