import 'reflect-metadata';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath);
}
if (process.env.JWT_PRIVATE_KEY) {
  process.env.JWT_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY.replace(/\\n/g, '\n');
}
if (process.env.JWT_PUBLIC_KEY) {
  process.env.JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n');
}

const PWA_DIR = path.join(__dirname, 'pwa');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function initBackend() {
  // Compatibilite MariaDB (CAST AS JSON, FOR SHARE) : a poser avant la creation de l'application (mariadb-compat.mjs).
  const { DefaultQueryCompiler } = await import('kysely');
  const { installMariaDbCompat } = await import('./mariadb-compat.mjs');
  installMariaDbCompat(DefaultQueryCompiler);

  const { NestFactory } = await import('@nestjs/core');
  const { FastifyAdapter } = await import('@nestjs/platform-fastify');
  const { AppModule } = await import('./dist/app.module.js');
  const { loadEnv, trustProxyOption } = await import('./dist/platform/env.js');
  const { registerRawBodyParser } =
    await import('./dist/platform/http/register-raw-body-parser.js');
  const { registerCorrelationId } = await import('./dist/platform/http/register-correlation-id.js');
  const { ID_GENERATOR } = await import('./dist/platform/id-generator.provider.js');
  const { JobRunner } = await import('./dist/platform/jobs/job-runner.js');
  const { JobScheduler } = await import('./dist/platform/jobs/job-scheduler.js');
  const { EventConsumerRunner } = await import('./dist/platform/events/event-consumer-runner.js');
  const { EVENT_CONSUMER_REGISTRY } =
    await import('./dist/platform/events/event-consumer-registry.provider.js');
  const { WorkerService } = await import('./dist/worker/worker.service.js');

  const env = loadEnv();
  const adapter = new FastifyAdapter({ trustProxy: trustProxyOption(env.TRUST_PROXY) });
  const app = await NestFactory.create(AppModule, adapter);
  registerRawBodyParser(app);
  registerCorrelationId(app, app.get(ID_GENERATOR));
  await app.init();
  const fastify = app.getHttpAdapter().getInstance();
  await fastify.ready();

  const worker = new WorkerService(
    app.get(JobRunner),
    app.get(JobScheduler),
    app.get(EventConsumerRunner),
    app.get(EVENT_CONSUMER_REGISTRY),
  );
  worker.start({ pollIntervalMs: 3000 }).catch((err) => console.error('[worker]', err));

  return fastify;
}

const backendPromise = initBackend().catch((err) => {
  console.error('[backend-init-error]', err);
  throw err;
});

const server = http.createServer(async (req, res) => {
  const u = (req.url || '/').split('?')[0];
  if (u === '/api' || u.startsWith('/api/') || u === '/health' || u.startsWith('/health/')) {
    try {
      const fastify = await backendPromise;
      return fastify.routing(req, res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Backend initialization failed', message: String(err) }));
      return;
    }
  }
  const safePath = path.normalize(u).replace(/^(\.\.(\/|\\|$))+/, '');
  let filePath = path.join(PWA_DIR, safePath === '/' ? 'index.html' : safePath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PWA_DIR, 'index.html');
  }
  const ext = path.extname(filePath).toLowerCase();
  const isImmutable = u.startsWith('/assets/');
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': isImmutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`GIC AGROPELC en ligne sur le port ${port}`);
});
