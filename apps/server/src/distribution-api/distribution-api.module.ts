/**
 * Composition transport du tableau de distribution (P5-20, ADR-035) : la lecture rencontre `inventory`,
 * `sales`, `finance`, `organization`, `catalog`, `identity` et `sync` — cette rencontre vit ici, jamais
 * dans un module (graphe des dépendances : `analytics` n'importe que des vues publiées).
 */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { DistributionDashboardController } from './distribution-dashboard.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [DistributionDashboardController],
})
export class DistributionApiModule {}
