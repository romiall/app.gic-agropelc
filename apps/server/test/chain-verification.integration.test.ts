/**
 * Démonstration du critère de sortie P0-07 (« vérification quotidienne de la chaîne »,
 * INV-AUD-01) contre une vraie base : `verifyChainRange` sur une chaîne réellement écrite
 * par `recordAudit`, puis le trajet complet du gestionnaire de tâche
 * `audit.chain.verify_daily` — enregistré au démarrage par `ChainVerificationJob`
 * (pas un registre de test recréé à la main), réclamé et exécuté par un vrai `JobRunner`.
 *
 * Aucun test ne force ici une rupture réelle en base : `audit_audit_log` a un déclencheur
 * qui interdit tout UPDATE, y compris pour un rôle admin (INV-AUD-01) — la détection de
 * rupture est déjà prouvée, avec des lignes délibérément corrompues, par
 * src/audit/verify-chain.test.ts (fonction pure).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { SystemClock, Uuidv7Generator } from '@gic/domain';
import { PlatformModule } from '../src/platform/platform.module.js';
import { ChainVerificationModule } from '../src/audit/chain-verification.module.js';
import { CHAIN_VERIFICATION_JOB_TYPE } from '../src/audit/chain-verification-job.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../src/platform/jobs/job-handler-registry.provider.js';
import { JobsService } from '../src/platform/jobs/jobs.service.js';
import { JobRunner } from '../src/platform/jobs/job-runner.js';
import { verifyChainRange } from '../src/audit/verify-chain.js';
import { recordAudit } from '../src/audit/record-audit.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { closeTestDb, db } from './helpers.js';

const realIdGenerator = new Uuidv7Generator(new SystemClock());

/** Utilisateur réellement commité (FK `audit_audit_log.actor_user_id`), comme record-audit.test.ts. */
async function createRealTestUser(): Promise<string> {
  const id = realIdGenerator.newId();
  const phone = `+2376${Math.floor(1_000_0000 + Math.random() * 8_999_9999)}`;
  await db
    .insertInto('identity_users')
    .values({
      id: toBin(id),
      full_name: 'Test',
      phone,
      password_hash: 'x',
      status: 'ACTIVE',
      created_by: toBin(id),
    })
    .execute();
  return id;
}

describe('Vérification du chaînage d’audit (P0-07, INV-AUD-01)', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  it('verifyChainRange sur une chaîne réellement écrite (recordAudit) : ok', async () => {
    const clock = new SystemClock();
    const idGenerator = new Uuidv7Generator(clock);
    const admin = await createRealTestUser();

    const first = await db.transaction().execute((trx) =>
      recordAudit(
        trx,
        { idGenerator, clock },
        {
          occurredAt: clock.now(),
          actorUserId: admin,
          actorRoles: ['ADMIN'],
          action: 'test.chain_verify.a',
          entityType: 'TEST',
          result: 'SUCCESS',
        },
      ),
    );
    const second = await db.transaction().execute((trx) =>
      recordAudit(
        trx,
        { idGenerator, clock },
        {
          occurredAt: clock.now(),
          actorUserId: admin,
          actorRoles: ['ADMIN'],
          action: 'test.chain_verify.b',
          entityType: 'TEST',
          result: 'SUCCESS',
        },
      ),
    );

    const result = await verifyChainRange(db, { fromSeq: first.seq, toSeq: second.seq });
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(second.seq - first.seq + 1);
  });

  it('audit.chain.verify_daily (enregistré par ChainVerificationJob, réclamé par un vrai JobRunner) : DONE', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PlatformModule, ChainVerificationModule],
    }).compile();
    await moduleRef.init();

    const clock = new SystemClock();
    const idGenerator = new Uuidv7Generator(clock);
    const admin = await createRealTestUser();
    await db.transaction().execute((trx) =>
      recordAudit(
        trx,
        { idGenerator, clock },
        {
          occurredAt: clock.now(),
          actorUserId: admin,
          actorRoles: ['ADMIN'],
          action: 'test.chain_verify.job',
          entityType: 'TEST',
          result: 'SUCCESS',
        },
      ),
    );

    const registry = moduleRef.get<JobHandlerRegistry>(JOB_HANDLER_REGISTRY);
    expect(registry.resolve(CHAIN_VERIFICATION_JOB_TYPE)).toBeDefined();

    const jobsService = moduleRef.get(JobsService);
    const jobId = await db
      .transaction()
      .execute((trx) =>
        jobsService.enqueue(trx, { jobType: CHAIN_VERIFICATION_JOB_TYPE, payload: {} }),
      );

    // `jobTypes` : la table platform_jobs est partagée par toute la suite (fileParallelism,
    // vitest.config.ts) — d'autres fichiers y laissent leurs propres tâches en attente au
    // même instant ; sans ce filtre, claimAndProcessOne pourrait réclamer l'une des leurs
    // plutôt que celle-ci (constaté : une vraie collision inter-fichiers en exécutant cette
    // suite).
    const jobRunner = new JobRunner(db, registry, clock);
    const outcome = await jobRunner.claimAndProcessOne({
      jobTypes: [CHAIN_VERIFICATION_JOB_TYPE],
    });
    expect(outcome).toEqual({ claimed: true, jobId, result: 'DONE' });

    await moduleRef.close();
  });
});
