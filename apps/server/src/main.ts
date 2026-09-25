import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { ENV } from './platform/env.provider.js';
import type { Env } from './platform/env.js';
import { registerRawBodyParser } from './platform/http/register-raw-body-parser.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  registerRawBodyParser(app);
  const env = app.get<Env>(ENV);
  await app.listen(env.PORT, env.HOST);
  console.log(`@gic/server à l'écoute sur http://${env.HOST}:${env.PORT} (${env.NODE_ENV}).`);
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
