/**
 * Processus worker (P0-08 ; ADR-011 « un seul artefact, deux modes de démarrage : api,
 * worker ») : consomme `platform_domain_events` (consommateurs enregistrés) et
 * `platform_jobs` (SKIP LOCKED), aucune écoute HTTP. N'importe ni `IdentityModule` ni
 * `CommandsModule` : rien ne s'exécute côté worker qui en ait besoin — évite de tirer la
 * garde HTTP et les contrôleurs dans un processus qui n'écoute pas. `ChainVerificationModule`
 * (P0-07) n'a que `platform` comme dépendance (`audit --> platform`, N1) : c'est bien ce
 * processus qui réclame et exécute réellement `audit.chain.verify_daily`.
 */
import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { ChainVerificationModule } from '../audit/chain-verification.module.js';
import { WorkerService } from './worker.service.js';

@Module({
  imports: [PlatformModule, ChainVerificationModule],
  providers: [WorkerService],
  exports: [WorkerService],
})
export class WorkerModule {}
