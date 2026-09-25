/**
 * Composition transport (comme `commands/`) : `GET /audit` a besoin à la fois d'`audit`
 * (lecture, écriture de l'entrée d'audit de consultation) et d'`identity` (authentification,
 * existence du droit) — cette rencontre vit ici, jamais dans `audit/` lui-même
 * (03-graphe-dependances.md, `audit` reste N1, sans dépendance).
 */
import { Module } from '@nestjs/common';
import { IdentityModule } from '../modules/identity/identity.module.js';
import { AuditController } from './audit.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [AuditController],
})
export class AuditApiModule {}
