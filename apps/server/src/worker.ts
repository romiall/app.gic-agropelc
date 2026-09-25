/**
 * Second point d'entrée (même artefact que `main.ts`, ADR-011 « deux modes de démarrage »)
 * : contexte d'application NestJS sans écoute HTTP — voir `worker/worker.module.ts`.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module.js';
import { WorkerService } from './worker/worker.service.js';
import { appLogger } from './platform/observability/logger.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const worker = app.get(WorkerService);

  const shutdown = (signal: string): void => {
    appLogger.info({ module: 'platform' }, `${signal} reçu, arrêt du worker...`);
    worker.stop();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  await worker.start();
  await app.close();
}

bootstrap().catch((error: unknown) => {
  appLogger.error({ module: 'platform' }, error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
