/**
 * Tâches du module `analytics` (P9-20, P9-22) : `analytics.export.run` (calcul d'un export, ADR-067 §3) et
 * `analytics.maintenance.purge_daily` (purges, ADR-068 §6), enregistrées au démarrage dans le registre des tâches de
 * la plateforme ; la purge est aussi inscrite à l'ordonnanceur (une fois par jour).
 *
 * - **Export** : la charge est `{ exportId }` ; une charge illisible est consignée et abandonnée (rejouer ne la
 *   réparerait pas). Le gestionnaire ne lève que pour une erreur technique à rejouer (`run-export.ts`) ;
 *   au dernier essai l'export passe `FAILED` (`EXPORT_JOB_FAILED`, P9-25 PF-6).
 * - **Isolation** : l'export est une tâche longue (jusqu'à `analytics.export_max_seconds`) ; il s'exécute dans la
 *   file des tâches du worker, jamais dans le consommateur d'alertes (ADR-068 §3). La purge quotidienne est elle aussi
 *   rangée sur la voie longue (`job-lanes.ts`, P9-25 PF-5) et ses étapes sont isolées (`purge.ts`) : l'échec de l'une
 *   est journalisé à l'erreur, la tâche reste `DONE`.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import type { Clock, IdGenerator } from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import {
  RECURRING_JOB_REGISTRY,
  type RecurringJobRegistry,
} from '../../../../platform/jobs/recurring-job-registry.provider.js';
import { CHUNK_STORAGE } from '../../../../platform/storage/chunk-storage.provider.js';
import type { ChunkStorage } from '../../../../platform/storage/chunk-storage.js';
import { EXPORT_RUN_JOB_TYPE } from '../commands/export-commands.js';
import { runExportJob } from '../exports/run-export.js';
import { runAnalyticsPurge } from '../maintenance/purge.js';

export const ANALYTICS_PURGE_JOB_TYPE = 'analytics.maintenance.purge_daily';

const exportPayloadSchema = z.object({ exportId: z.string().uuid() });

@Injectable()
export class AnalyticsJobs implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsJobs.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(CHUNK_STORAGE) private readonly storage: ChunkStorage,
    @Inject(JOB_HANDLER_REGISTRY) private readonly handlers: JobHandlerRegistry,
    @Inject(RECURRING_JOB_REGISTRY) private readonly recurring: RecurringJobRegistry,
  ) {}

  onModuleInit(): void {
    this.handlers.register(EXPORT_RUN_JOB_TYPE, async (uow, payload, context) => {
      const parsed = exportPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        this.logger.error('Tâche d’export sans identifiant d’export lisible : abandonnée.');
        return;
      }
      // `context` : l'essai en cours ; au dernier, l'export passe FAILED (EXPORT_JOB_FAILED) au lieu de rester QUEUED.
      const outcome = await runExportJob(
        uow,
        { clock: this.clock, idGenerator: this.idGenerator, storage: this.storage },
        parsed.data.exportId,
        context,
        this.logger,
      );
      this.logger.log(
        `Export ${parsed.data.exportId} : ${outcome.status}` +
          `${outcome.status === 'FAILED' ? ` (${outcome.errorCode})` : ''}` +
          `${outcome.status === 'DONE' ? ` (${outcome.rowCount} ligne(s))` : ''}.`,
      );
    });
    this.handlers.register(ANALYTICS_PURGE_JOB_TYPE, async (uow) => {
      const outcome = await runAnalyticsPurge(uow, {
        clock: this.clock,
        idGenerator: this.idGenerator,
        storage: this.storage,
      });
      this.logger.log(
        `Purge de l’analyse : ${outcome.queryLogDeleted} requête(s) du journal, ` +
          `${outcome.exportsExpired} export(s) expiré(s), ${outcome.exportFilesDeleted} fichier(s) supprimé(s), ` +
          `${outcome.exportsAbandoned} export(s) abandonné(s).`,
      );
      // Une étape en échec ne fait pas échouer la tâche (les autres étapes sont menées) : ce journal d'erreur en est
      // le seul signal, à surveiller (P9-25, PF-5).
      for (const failure of outcome.failedSteps) {
        this.logger.error(
          `Purge de l’analyse : l’étape « ${failure.step} » a échoué (${failure.message}) ; ` +
            'les autres étapes ont été menées, elle sera reprise à la prochaine exécution.',
        );
      }
    });
    // Une fois par jour (constante de planification, pas un seuil métier).
    this.recurring.register({
      jobType: ANALYTICS_PURGE_JOB_TYPE,
      schedule: { kind: 'INTERVAL', intervalSeconds: 86_400 },
    });
  }
}
