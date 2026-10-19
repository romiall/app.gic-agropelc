/**
 * `audit.chain.verify_daily` (07-security-rbac/03-audit.md §5 « tâche quotidienne qui
 * recalcule la chaîne des entrées du jour » ; BR-AUD-006 ; D13 §7.1 `AUDIT_CHAIN_BROKEN`) : gestionnaire de
 * tâche (platform.jobs, P0-08) qui vérifie le chaînage des entrées écrites sur une fenêtre de **deux jours
 * métier** — le jour métier précédent et le jour courant — (Africa/Douala, sur `recorded_at` : c'est
 * l'écriture technique qui intéresse cette tâche, pas l'heure métier de l'événement, qui peut être
 * rétroactive de plusieurs jours, AV-078).
 *
 * - **Couverture** (AV-470) : exécutée une fois par jour à 03:00 (`AuditRecurringJobs`), la fenêtre
 *   commence au début du jour métier **précédent** : toute entrée est vérifiée par au moins une exécution
 *   (une entrée écrite avant 03:00 l'est dans la même journée, une entrée écrite après l'est le lendemain),
 *   alors qu'une fenêtre « du jour » laisserait sans contrôle tout ce qui est écrit après la dernière
 *   exécution. Une rupture plus ancienne que la fenêtre n'est revue que par la vérification hebdomadaire
 *   complète du mois (§5), renvoyée à P9-22 (charge et isolation des tâches longues).
 * - **Coût** (P9-10) : le journal est lu par pages de clé `seq` (`verifyChainRange`, 2 000 lignes) et le début de
 *   la fenêtre est cherché depuis la fin de la table (`verification-window.ts`) : le coût suit la taille de la
 *   fenêtre, non celle du journal, que rien n'index par date d'écriture.
 * - **Rupture** (P9-10) : la tâche ne lève plus. Une exception ferait annuler par le point de sauvegarde du
 *   `JobRunner` tout ce que le gestionnaire a écrit — dont l'événement — puis reprendrait la tâche sans fin
 *   (ADR-071 §3) ; elle publie `AuditChainBroken` puis se termine en succès, et consigne l'erreur au journal.
 *   Sans rupture, rien n'est publié : l'alerte est un événement à résolution manuelle (`resolvedBy` vide),
 *   un contrôle réussi ultérieur ne prouvant pas la réparation d'une ligne immuable.
 * - **Partition** : aucune partition physique n'existe (ADR-023) ; la « partition » du sujet est le mois
 *   métier `AAAA-MM` de l'écriture de la ligne rompue (BR-AUD-008, D12 §14). Une rupture persistante dans
 *   la fenêtre de deux exécutions consécutives republie le même sujet : l'alerte ouverte compte une
 *   occurrence de plus sans renotifier ; résolue à la main, elle renaît seulement si la rupture est encore
 *   dans la fenêtre.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  addBusinessDays,
  businessDayOf,
  businessDayStartUtc,
  periodOfBusinessDay,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import {
  compositeSubjectId,
  detectionPassId,
  passSlotOf,
  publishDetectionEvent,
} from '../platform/events/detection-events.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../platform/jobs/job-handler-registry.provider.js';
import type { UnitOfWork } from '../platform/unit-of-work.js';
import { verifyChainRange, type ChainBreakReason } from './verify-chain.js';
import { firstSeqRecordedAtOrAfter } from './verification-window.js';

export const CHAIN_VERIFICATION_JOB_TYPE = 'audit.chain.verify_daily';

export interface ChainVerificationDeps {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export type ChainVerificationOutcome =
  | { readonly status: 'EMPTY'; readonly businessDay: string }
  | {
      readonly status: 'INTACT';
      readonly businessDay: string;
      readonly checked: number;
      readonly fromSeq: number;
      readonly toSeq: number;
    }
  | {
      readonly status: 'BROKEN';
      readonly businessDay: string;
      readonly checked: number;
      readonly fromSeq: number;
      readonly toSeq: number;
      readonly brokenAtSeq: number;
      readonly reason: ChainBreakReason;
      readonly partition: string;
      readonly published: boolean;
    };

/**
 * Vérifie la fenêtre puis, si la chaîne est rompue, publie `AuditChainBroken` dans la transaction de la
 * tâche. `payload` : la charge de la tâche (`scheduledFor` donne l'identité de la passe).
 */
export async function runChainVerification(
  uow: UnitOfWork,
  deps: ChainVerificationDeps,
  payload: unknown,
): Promise<ChainVerificationOutcome> {
  const now = deps.clock.now();
  const today = businessDayOf(now);
  const fromDate = businessDayStartUtc(addBusinessDays(today, -1));

  // Début de la fenêtre lu depuis la fin du journal (aucun index sur `recorded_at` : un `MIN(seq)` filtré le
  // parcourrait tout entier chaque nuit) ; la fin est la dernière ligne, par la clé primaire.
  const fromSeq = await firstSeqRecordedAtOrAfter(uow, fromDate);
  const to = await uow
    .selectFrom('audit_audit_log')
    .select(({ fn }) => fn.max('seq').as('maxSeq'))
    .executeTakeFirst();
  if (fromSeq === null || !to?.maxSeq) return { status: 'EMPTY', businessDay: today };

  const toSeq = Number(to.maxSeq);
  const result = await verifyChainRange(uow, { fromSeq, toSeq });
  if (result.ok || result.brokenAtSeq === null || result.reason === null) {
    return { status: 'INTACT', businessDay: today, checked: result.checked, fromSeq, toSeq };
  }

  // Mois métier de l'écriture de la ligne rompue (jamais celui de la vérification).
  const broken = await uow
    .selectFrom('audit_audit_log')
    .select('recorded_at')
    .where('seq', '=', result.brokenAtSeq)
    .executeTakeFirst();
  const partition = periodOfBusinessDay(businessDayOf(broken?.recorded_at ?? now));
  const published = await publishDetectionEvent(uow, deps.idGenerator, {
    eventType: 'AuditChainBroken',
    producerModule: 'audit',
    aggregateType: 'AUDIT_PARTITION',
    aggregateId: compositeSubjectId('AUDIT_CHAIN_BROKEN', { partition }),
    occurredAt: now,
    passId: detectionPassId('AUDIT_CHAIN_BROKEN', passSlotOf(payload, now)),
    payload: {
      partition,
      position: result.brokenAtSeq,
      reason: result.reason,
      window_from_seq: fromSeq,
      window_to_seq: toSeq,
      business_day: today,
    },
  });
  return {
    status: 'BROKEN',
    businessDay: today,
    checked: result.checked,
    fromSeq,
    toSeq,
    brokenAtSeq: result.brokenAtSeq,
    reason: result.reason,
    partition,
    published,
  };
}

@Injectable()
export class ChainVerificationJob implements OnModuleInit {
  private readonly logger = new Logger(ChainVerificationJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(CHAIN_VERIFICATION_JOB_TYPE, async (uow, payload) => {
      const outcome = await runChainVerification(
        uow,
        { clock: this.clock, idGenerator: this.idGenerator },
        payload,
      );
      if (outcome.status === 'EMPTY') {
        this.logger.log(
          `Aucune entrée d'audit à vérifier pour le jour métier ${outcome.businessDay}.`,
        );
      } else if (outcome.status === 'INTACT') {
        this.logger.log(
          `Chaîne d'audit vérifiée pour ${outcome.businessDay} : ${outcome.checked} entrée(s) ` +
            `(seq ${outcome.fromSeq} à ${outcome.toSeq}), intacte.`,
        );
      } else {
        // Le journal en tient lieu quand l'alerte est inactive (règle désactivée) ou le consommateur à l'arrêt.
        this.logger.error(
          `AUDIT_CHAIN_BROKEN : rupture à seq=${outcome.brokenAtSeq} (${outcome.reason}), partition ` +
            `${outcome.partition}, fenêtre seq ${outcome.fromSeq} à ${outcome.toSeq}.`,
        );
      }
    });
  }
}
