/**
 * Processus worker (P0-08 ; ADR-011 « un seul artefact, deux modes de démarrage : api,
 * worker ») : consomme `platform_domain_events` (consommateurs enregistrés) et
 * `platform_jobs` (SKIP LOCKED), aucune écoute HTTP. N'importe ni `IdentityModule` ni
 * `CommandsModule` : rien, en P0-08, ne s'exécute côté worker qui en ait besoin — évite de
 * tirer la garde HTTP et les contrôleurs dans un processus qui n'écoute pas.
 */
import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { WorkerService } from './worker.service.js';

@Module({
  imports: [PlatformModule],
  providers: [WorkerService],
  exports: [WorkerService],
})
export class WorkerModule {}
