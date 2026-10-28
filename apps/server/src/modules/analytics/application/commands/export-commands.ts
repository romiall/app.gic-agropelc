/**
 * Commande de demande d'export (P9-20 ; ADR-067 §3, §7 et §8, BR-ANA-008, UC-ANA-05, AT-046) :
 * `analytics.export.request` (permission `analytics.export`, **en ligne**). Toujours asynchrone (AV-383) : la commande
 * valide la demande, crée la ligne `QUEUED` (définition figée, version du catalogue), dépose la tâche
 * `analytics.export.run` et publie `AnalyticsExportRequested` ; le calcul, les droits revérifiés et le fichier sont
 * du worker (`run-export.ts`).
 *
 * - **Validée comme à l'écran** : jeu lisible, définition valide contre le catalogue, mesure au coût réservée à
 *   `inventory.valuation.read` (un export financier exige donc les deux droits, AV-384), plafond de lignes de
 *   l'export (`analytics.export_max_rows`) ; version du catalogue égale à la version courante.
 * - **Garde-fou** : au plus `analytics.export_max_pending_per_user` exports en file ou en cours par demandeur
 *   (`EXPORT_BACKLOG`), pour qu'un utilisateur n'occupe pas la file. Le compte se lit **après le verrou** de la ligne
 *   du demandeur : deux demandes simultanées ne passent plus toutes deux sous le plafond (P9-25, EX-8).
 * - **Période figée à la demande** (P9-25, EX-7) : une période nommée (« ce mois ») est résolue au jour de la demande
 *   et remplacée par sa plage dans la définition conservée ; l'export calculé plus tard (file d'attente, rejeu) porte
 *   donc sur les jours que le demandeur a vus. L'audit garde la période demandée et la plage résolue.
 * - **Idempotente** : un identifiant d'export déjà connu du même demandeur est rendu appliqué sans second effet ; celui
 *   d'un autre est introuvable (existence opaque).
 */
import { ANALYTICS_CATALOG_VERSION, type Clock, type IdGenerator } from '@gic/domain';
import {
  analyticsExportRequestPayloadSchema,
  ANALYTICS_COMMAND_TYPES,
  type AnalyticsExportRequestPayload,
} from '@gic/contracts';
import type { z } from 'zod';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { JobsService } from '../../../../platform/jobs/jobs.service.js';
import { lockUserById } from '../../../identity/application/public/index.js';
import { explorationDefinitionFrom } from '../query/exploration-definition.js';
import { validateExplorationForUser } from '../query/validate-for-user.js';
import { publishExportEvent } from '../exports/export-events.js';
import { readExportSettings } from '../exports/export-settings.js';
import { insertExport, lockExport, pendingExportCount } from '../exports/export-store.js';

export const EXPORT_REQUEST_PERMISSION = 'analytics.export';
export const EXPORT_RUN_JOB_TYPE = 'analytics.export.run';

export interface ExportCommandDeps {
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly jobs: JobsService;
}

const rejected = (errorCode: string, messageFr: string): CommandHandlerOutcome => ({
  status: 'REJECTED',
  errorCode,
  messageFr,
});

type RequestedDefinition = AnalyticsExportRequestPayload['definition'];

/** La définition dont une période nommée est remplacée par la plage que `period` a résolue (EX-7). */
function frozenDefinition(
  definition: RequestedDefinition,
  period: { readonly fromDay: string; readonly toDay: string } | null,
): RequestedDefinition {
  if (period === null || definition.period === undefined || definition.period.code === 'CUSTOM') {
    return definition;
  }
  return {
    ...definition,
    period: { code: 'CUSTOM', fromDay: period.fromDay, toDay: period.toDay },
  };
}

function request(deps: ExportCommandDeps): CommandHandler<AnalyticsExportRequestPayload> {
  return async (uow, envelope) => {
    if (envelope.captured_offline) {
      return rejected('ONLINE_REQUIRED', 'Un export se demande en ligne.');
    }
    const exportId = envelope.aggregate_id;
    const author = envelope.author_user_id;
    const existing = await lockExport(uow, exportId);
    if (existing !== undefined) {
      return existing.requestedBy === author
        ? { status: 'APPLIED', serverRefs: { exportId } }
        : rejected('NOT_FOUND', 'Export introuvable.');
    }

    const payload = envelope.payload;
    if (payload.catalogVersion !== ANALYTICS_CATALOG_VERSION) {
      return rejected(
        'CATALOG_OUTDATED',
        `Le catalogue est passé à la version ${ANALYTICS_CATALOG_VERSION} : relisez-le avant d’exporter.`,
      );
    }
    const now = deps.clock.now();
    const settings = await readExportSettings(uow, now);
    const definition = explorationDefinitionFrom(payload.definition);
    const validation = await validateExplorationForUser(uow, {
      userId: author,
      definition,
      at: now,
      maxRows: settings.maxRows,
    });
    if (!validation.ok) return rejected(validation.code, validation.messageFr);
    // Le plafond se lit après le verrou du demandeur : une seconde demande simultanée attend la première (EX-8).
    await lockUserById(uow, author);
    if ((await pendingExportCount(uow, author)) >= settings.maxPendingPerUser) {
      return rejected(
        'EXPORT_BACKLOG',
        `Vous avez déjà ${settings.maxPendingPerUser} exports en cours : attendez la fin de l’un d’eux.`,
      );
    }
    const frozen = frozenDefinition(payload.definition, validation.plan.period);

    await insertExport(uow, {
      id: exportId,
      requestedBy: author,
      dataset: definition.dataset,
      definition: frozen,
      format: payload.format,
      catalogVersion: payload.catalogVersion,
      commandId: envelope.command_id,
      expiresAt: new Date(now.getTime() + settings.fileHours * 3_600_000),
    });
    await deps.jobs.enqueue(uow, { jobType: EXPORT_RUN_JOB_TYPE, payload: { exportId } });
    await publishExportEvent(uow, deps, {
      eventType: 'AnalyticsExportRequested',
      exportId,
      occurredAt: new Date(envelope.occurred_at),
      commandId: envelope.command_id,
      payload: {
        export_id: exportId,
        requested_by: author,
        dataset: definition.dataset,
        format: payload.format,
        catalog_version: payload.catalogVersion,
      },
    });
    return {
      status: 'APPLIED',
      serverRefs: { exportId },
      audit: {
        before: null,
        after: {
          dataset: definition.dataset,
          format: payload.format,
          catalog_version: payload.catalogVersion,
          definition: frozen,
          requested_period: payload.definition.period ?? null,
          status: 'QUEUED',
        },
      },
    };
  };
}

export function registerExportCommands(
  registry: CommandHandlerRegistry,
  deps: ExportCommandDeps,
): void {
  registry.register<AnalyticsExportRequestPayload>({
    commandType: ANALYTICS_COMMAND_TYPES.exportRequest,
    version: 1,
    // Valeurs par défaut de la définition : le type en sortie est celui du gestionnaire.
    payloadSchema:
      analyticsExportRequestPayloadSchema as unknown as z.ZodType<AnalyticsExportRequestPayload>,
    permissionCode: EXPORT_REQUEST_PERMISSION,
    handler: request(deps),
    isolationLevel: 'read committed',
  });
}
