/**
 * Composition transport de l'explorateur (P9-14, ADR-074), des tableaux (P9-17), des instantanés (P9-18), des vues
 * sauvegardées (P9-19) et des exports (P9-20) : la requête rencontre le catalogue du domaine, les
 * vues `analytics_f_*`, l'étendue exacte (`identity`, `organization`) et la fraîcheur des appareils (`sync`) — cette
 * rencontre vit ici, jamais dans le module `analytics`.
 */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { AnalyticsDashboardsController } from './analytics-dashboards.controller.js';
import { AnalyticsExplorerController } from './analytics-explorer.controller.js';
import { AnalyticsExportsController } from './analytics-exports.controller.js';
import { AnalyticsSnapshotsController } from './analytics-snapshots.controller.js';
import { AnalyticsViewsController } from './analytics-views.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [
    AnalyticsExplorerController,
    AnalyticsDashboardsController,
    AnalyticsSnapshotsController,
    AnalyticsViewsController,
    AnalyticsExportsController,
  ],
})
export class AnalyticsApiModule {}
