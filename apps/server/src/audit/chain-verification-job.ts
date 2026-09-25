/**
 * `audit.chain.verify_daily` (07-security-rbac/03-audit.md §5 « tâche quotidienne qui
 * recalcule la chaîne des entrées du jour ») : gestionnaire de tâche (platform.jobs, P0-08)
 * qui vérifie le chaînage des entrées écrites depuis le début du jour métier courant
 * (Africa/Douala, sur `recorded_at` — c'est l'écriture technique qui intéresse cette tâche,
 * pas l'heure métier de l'événement, qui peut être rétroactive de plusieurs jours, AV-078).
 * Une rupture lève (`JobRunner` marque la tâche en échec, `last_error` rempli) —
 * l'alerte technique réelle (« AUDIT_CHAIN_BROKEN, critique ») est hors périmètre P0-07,
 * comme l'alerting réel l'était pour les consommateurs d'événements en P0-08 (module
 * `communication`, phase ultérieure).
 *
 * La vérification hebdomadaire complète du mois courant (§5) réutilise la même tâche avec
 * une plage plus large : hors périmètre P0-07 (aucun ordonnanceur récurrent réel construit,
 * comme documenté dans le plan P0-08 — seule la mécanique est démontrée ici).
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { businessDayOf, businessDayStartUtc, type Clock } from '@gic/domain';
import { CLOCK } from '../platform/clock.provider.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../platform/jobs/job-handler-registry.provider.js';
import { verifyChainRange } from './verify-chain.js';

export const CHAIN_VERIFICATION_JOB_TYPE = 'audit.chain.verify_daily';

@Injectable()
export class ChainVerificationJob implements OnModuleInit {
  private readonly logger = new Logger(ChainVerificationJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(CHAIN_VERIFICATION_JOB_TYPE, async (uow) => {
      const today = businessDayOf(this.clock.now());
      const fromDate = businessDayStartUtc(today);

      const from = await uow
        .selectFrom('audit_audit_log')
        .select(({ fn }) => fn.min('seq').as('minSeq'))
        .where('recorded_at', '>=', fromDate)
        .executeTakeFirst();
      const to = await uow
        .selectFrom('audit_audit_log')
        .select(({ fn }) => fn.max('seq').as('maxSeq'))
        .executeTakeFirst();

      if (!from?.minSeq || !to?.maxSeq) {
        this.logger.log(`Aucune entrée d'audit à vérifier pour le jour métier ${today}.`);
        return;
      }

      const result = await verifyChainRange(uow, {
        fromSeq: Number(from.minSeq),
        toSeq: Number(to.maxSeq),
      });
      if (!result.ok) {
        throw new Error(
          `AUDIT_CHAIN_BROKEN : rupture détectée à seq=${result.brokenAtSeq} (${result.reason}).`,
        );
      }
      this.logger.log(
        `Chaîne d'audit vérifiée pour ${today} : ${result.checked} entrée(s), intacte.`,
      );
    });
  }
}
