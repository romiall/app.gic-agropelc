/**
 * Module `analytics` (P9 ; ADR-070) : commandes des vues sauvegardées et des exports. Les lectures HTTP, les tableaux
 * et l'explorateur sont dans la couche de transport `analytics-api/` ; les tâches (calcul des exports, purges) sont
 * dans `AnalyticsJobsModule`, importé aussi par le processus worker.
 */
import { Module } from '@nestjs/common';
import { AnalyticsCommandsRegistrar } from './application/commands/register-analytics-commands.js';

@Module({
  providers: [AnalyticsCommandsRegistrar],
})
export class AnalyticsModule {}
