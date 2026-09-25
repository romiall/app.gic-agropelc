/**
 * Composition transport (comme `audit-api/`) : `GET /organization/settings` a besoin à la
 * fois d'`organization` (lecture de l'historique) et d'`identity` (authentification,
 * existence du droit) — cette rencontre vit ici, jamais dans `organization/` lui-même
 * (03-graphe-dependances.md : `organization` reste N2, sans dépendance vers `identity`,
 * c'est l'inverse qui est vrai).
 */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { SettingsController } from './settings.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [SettingsController],
})
export class OrganizationApiModule {}
