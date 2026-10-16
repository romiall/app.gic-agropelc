/**
 * Récurrences des tâches de `production` (ordonnanceur `platform/jobs/job-scheduler.ts`, P9-09) :
 * - `production.products.standard_cost_check` : chaque jour à 07:45, heure de Douala — le coût standard
 *   d'un produit entré en stock se définit une fois ; la passe suit le calendrier des autres détecteurs
 *   quotidiens (après les ventes de 07:30, avant les commerciaux de 08:00) ;
 * - `production.lots.daily_entry_check` : chaque jour à 10:00 — D13 §7.1 : « lot actif sans saisie du jour
 *   la veille », planifiée à 10:00 (la ferme a eu sa matinée pour saisir la veille).
 * Constantes techniques de planification, pas des seuils métier (les réglages restent des paramètres
 * système lus par chaque tâche).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  RECURRING_JOB_REGISTRY,
  type RecurringJobRegistry,
} from '../../../../platform/jobs/recurring-job-registry.provider.js';
import { DAILY_ENTRY_MISSING_JOB_TYPE } from './daily-entry-missing-job.js';
import { STANDARD_COST_MISSING_JOB_TYPE } from './standard-cost-missing-job.js';

export const PRODUCTION_RECURRING_JOBS = [
  { jobType: STANDARD_COST_MISSING_JOB_TYPE, schedule: { kind: 'DAILY', localTime: '07:45' } },
  { jobType: DAILY_ENTRY_MISSING_JOB_TYPE, schedule: { kind: 'DAILY', localTime: '10:00' } },
] as const;

@Injectable()
export class ProductionRecurringJobs implements OnModuleInit {
  constructor(@Inject(RECURRING_JOB_REGISTRY) private readonly recurring: RecurringJobRegistry) {}

  onModuleInit(): void {
    for (const job of PRODUCTION_RECURRING_JOBS) this.recurring.register(job);
  }
}
