/**
 * Récurrence de la tâche d'audit (ordonnanceur `platform/jobs/job-scheduler.ts`, P9-10, AV-470) :
 * `audit.chain.verify_daily` chaque jour à 03:00, heure de Douala — après le registre de stock (02:00) et la
 * trésorerie (02:30), sur le créneau le plus calme de l'écriture ; la fenêtre de deux jours métier de la
 * tâche couvre ainsi toute entrée par au moins une exécution. Constante technique de planification, pas un
 * seuil métier (AV-411).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  RECURRING_JOB_REGISTRY,
  type RecurringJobRegistry,
} from '../platform/jobs/recurring-job-registry.provider.js';
import { CHAIN_VERIFICATION_JOB_TYPE } from './chain-verification-job.js';

export const AUDIT_RECURRING_JOBS = [
  { jobType: CHAIN_VERIFICATION_JOB_TYPE, schedule: { kind: 'DAILY', localTime: '03:00' } },
] as const;

@Injectable()
export class AuditRecurringJobs implements OnModuleInit {
  constructor(@Inject(RECURRING_JOB_REGISTRY) private readonly recurring: RecurringJobRegistry) {}

  onModuleInit(): void {
    for (const job of AUDIT_RECURRING_JOBS) this.recurring.register(job);
  }
}
