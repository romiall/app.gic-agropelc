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
import {
  CHAIN_VERIFICATION_JOB_TYPE,
  runChainVerification,
} from '../src/audit/chain-verification-job.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../src/platform/jobs/job-handler-registry.provider.js';
import { JobsService } from '../src/platform/jobs/jobs.service.js';
import { JobRunner } from '../src/platform/jobs/job-runner.js';
import { verifyChainRange } from '../src/audit/verify-chain.js';
import { recordAudit } from '../src/audit/record-audit.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { rolledBack } from './communication-test-kit.js';
import { closeTestDb, db, freshPhone } from './helpers.js';

const realIdGenerator = new Uuidv7Generator(new SystemClock());

/** Utilisateur réellement commité (FK `audit_audit_log.actor_user_id`), comme record-audit.test.ts. */
async function createRealTestUser(): Promise<string> {
  const id = realIdGenerator.newId();
  const phone = await freshPhone();
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

  it('verifyChainRange lue par pages (P9-10) : même résultat qu’en un seul tenant, quelle que soit la taille de page', async () => {
    const clock = new SystemClock();
    const idGenerator = new Uuidv7Generator(clock);
    const admin = await createRealTestUser();
    const written: number[] = [];
    for (const suffix of ['a', 'b', 'c']) {
      const recorded = await db.transaction().execute((trx) =>
        recordAudit(
          trx,
          { idGenerator, clock },
          {
            occurredAt: clock.now(),
            actorUserId: admin,
            actorRoles: ['ADMIN'],
            action: `test.chain_verify.paged.${suffix}`,
            entityType: 'TEST',
            result: 'SUCCESS',
          },
        ),
      );
      written.push(recorded.seq);
    }
    const range = { fromSeq: written[0]!, toSeq: written[2]! };
    const whole = await verifyChainRange(db, range);
    expect(whole.ok).toBe(true);
    // D'autres suites peuvent écrire entre les trois lignes : la plage contient au moins les trois.
    expect(whole.checked).toBe(range.toSeq - range.fromSeq + 1);
    for (const pageSize of [1, 2, 3, 1000]) {
      expect(await verifyChainRange(db, { ...range, pageSize })).toEqual(whole);
    }
    // Plage commençant au milieu de la chaîne : l'empreinte précédente est lue une fois, en base.
    const tail = await verifyChainRange(db, {
      fromSeq: written[1]!,
      toSeq: written[2]!,
      pageSize: 1,
    });
    expect(tail.ok).toBe(true);
    expect(tail.checked).toBe(written[2]! - written[1]! + 1);
    // Plage vide : rien à vérifier.
    expect(
      await verifyChainRange(db, {
        fromSeq: written[2]! + 1_000_000,
        toSeq: written[2]! + 1_000_010,
      }),
    ).toEqual({
      checked: 0,
      ok: true,
      brokenAtSeq: null,
      reason: null,
    });
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

    // La tâche ne lève plus à la rupture (elle publie `AuditChainBroken` puis réussit) : `DONE` seul ne prouve
    // pas que la chaîne est intacte. On borne donc les événements de rupture publiés par cette exécution, et
    // l'on vérifie que la fenêtre contient bien l'écriture ci-dessus (ni vide, ni rompue).
    const lastEvent = await db
      .selectFrom('platform_domain_events')
      .select(({ fn }) => fn.max('seq').as('maxSeq'))
      .executeTakeFirst();
    const eventsBefore = Number(lastEvent?.maxSeq ?? 0);
    // Transaction annulée : une rupture réelle ne laisserait pas d'événement critique dans la base d'essai.
    await rolledBack(async (uow) => {
      const direct = await runChainVerification(uow, { clock, idGenerator }, {});
      expect(direct.status).toBe('INTACT');
      expect(direct.status === 'INTACT' ? direct.checked : 0).toBeGreaterThanOrEqual(1);
    });

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
    const broken = await db
      .selectFrom('platform_domain_events')
      .select('seq')
      .where('event_type', '=', 'AuditChainBroken')
      .where('seq', '>', eventsBefore)
      .execute();
    expect(broken).toEqual([]);

    await moduleRef.close();
  });
});
