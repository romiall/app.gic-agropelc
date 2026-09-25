import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { ENV } from './platform/env.provider.js';
import type { Env } from './platform/env.js';
import { registerRawBodyParser } from './platform/http/register-raw-body-parser.js';
import { registerCorrelationId } from './platform/http/register-correlation-id.js';
import { appLogger } from './platform/observability/logger.js';
import { ID_GENERATOR } from './platform/id-generator.provider.js';
import type { IdGenerator } from '@gic/domain';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  registerRawBodyParser(app);
  registerCorrelationId(app, app.get<IdGenerator>(ID_GENERATOR));
  const env = app.get<Env>(ENV);
  await app.listen(env.PORT, env.HOST);
  appLogger.info(
    { module: 'platform', env: env.NODE_ENV },
    `@gic/server à l'écoute sur http://${env.HOST}:${env.PORT}.`,
  );
}

bootstrap().catch((error: unknown) => {
  appLogger.error({ module: 'platform' }, error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
