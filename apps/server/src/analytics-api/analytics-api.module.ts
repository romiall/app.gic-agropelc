/**
 * Composition transport de l'explorateur (P9-14, ADR-074) : la requête rencontre le catalogue du domaine, les
 * vues `analytics_f_*`, l'étendue exacte (`identity`, `organization`) et la fraîcheur des appareils (`sync`) — cette
 * rencontre vit ici, jamais dans le module `analytics`.
 */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { AnalyticsExplorerController } from './analytics-explorer.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [AnalyticsExplorerController],
})
export class AnalyticsApiModule {}
