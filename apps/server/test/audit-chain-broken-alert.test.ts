/**
 * P9-10 : alerte `AUDIT_CHAIN_BROKEN` (D13 §7.1, BR-AUD-006, AV-470) — `audit.chain.verify_daily` publie
 * `AuditChainBroken` puis se termine en succès (plus d'exception qui annulerait l'événement), sur une
 * fenêtre de deux jours métier. `audit_audit_log` interdit tout UPDATE (INV-AUD-01) : une rupture réelle
 * ne peut pas être fabriquée en base, la vérification du chaînage (`verifyChainRange`) est donc simulée —
 * ses propres tests (`verify-chain.test.ts`, `chain-verification.integration.test.ts`) la prouvent par
 * ailleurs. Le reste (fenêtre, partition, publication, rejeu, alerte levée) s'exécute pour de vrai sur des
 * entrées d'audit à dates maîtrisées (années postérieures à toute autre entrée de la base, hors de toute autre suite).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedClock, SystemClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import type * as VerifyChain from '../src/audit/verify-chain.js';

vi.mock('../src/audit/verify-chain.js', async (importOriginal) => ({
  ...(await importOriginal<typeof VerifyChain>()),
  verifyChainRange: vi.fn(),
}));

import { verifyChainRange } from '../src/audit/verify-chain.js';
import { ChainVerificationJob, runChainVerification } from '../src/audit/chain-verification-job.js';
import { recordAudit } from '../src/audit/record-audit.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { compositeSubjectId } from '../src/platform/events/detection-events.js';
import { toDomainEvent } from '../src/platform/events/domain-event.js';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { rolledBack } from './communication-test-kit.js';
import { closeTestDb, db, freshPhone } from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

afterAll(closeTestDb);

const verify = vi.mocked(verifyChainRange);
const idGenerator: IdGenerator = new Uuidv7Generator(new SystemClock());

/**
 * Année des entrées de test : postérieure à toute entrée déjà présente dans la base partagée (qui garde les
 * entrées de toutes les exécutions précédentes, en ajout seul) — la fenêtre de la tâche ne voit alors que
 * celles de cette exécution. Fixée avant les tests (voir `beforeAll`).
 */
let YEAR = 2090;
/** Dates d'écriture des entrées de test (UTC) : Douala est en UTC+1, un jour métier commence à 23:00 UTC. */
const written = {
  february: () => `${YEAR}-02-27T12:00:00.000Z`,
  /** Jour métier 03-09 (21:00 à Douala). */
  beforeWindow: () => `${YEAR}-03-09T20:00:00.000Z`,
  /** Jour métier 03-10. */
  yesterday: () => `${YEAR}-03-10T12:00:00.000Z`,
  /** Jour métier 03-11 (02:00 à Douala). */
  today: () => `${YEAR}-03-11T01:00:00.000Z`,
  /** 1er avril à 00:30 à Douala : le mois métier est avril, le mois UTC mars. */
  monthEdge: () => `${YEAR}-03-31T23:30:00.000Z`,
} as const;
type WrittenName = keyof typeof written;
const runAt = (day: string) => `${YEAR}-03-${day}T02:00:00.000Z`;
/** Lancement à 03:00 à Douala le jour métier 03-11 (02:00 UTC). */
const RUN_AT = () => runAt('11');

describe('AUDIT_CHAIN_BROKEN : vérification quotidienne de la chaîne d’audit (P9-10)', () => {
  const seqOf: Record<WrittenName, number> = {
    february: 0,
    beforeWindow: 0,
    yesterday: 0,
    today: 0,
    monthEdge: 0,
  };
  let actorId: string;

  async function write(name: WrittenName): Promise<void> {
    const clock = new FixedClock(new Date(written[name]()));
    const recorded = await db.transaction().execute((trx) =>
      recordAudit(
        trx,
        { idGenerator, clock },
        {
          occurredAt: clock.now(),
          actorUserId: actorId,
          actorRoles: ['ADMIN'],
          action: `test.chain_alert.${name}`,
          entityType: 'TEST',
          result: 'SUCCESS',
        },
      ),
    );
    seqOf[name] = recorded.seq;
  }

  beforeAll(async () => {
    const latest = await db
      .selectFrom('audit_audit_log')
      .select(({ fn }) => fn.max('recorded_at').as('latest'))
      .executeTakeFirstOrThrow();
    YEAR = Math.max(2090, (latest.latest ? new Date(latest.latest).getUTCFullYear() : 0) + 1);
    actorId = idGenerator.newId();
    await db
      .insertInto('identity_users')
      .values({
        id: toBin(actorId),
        full_name: 'Test audit',
        phone: await freshPhone(),
        password_hash: 'x',
        status: 'ACTIVE',
        created_by: toBin(actorId),
      })
      .execute();
    // Ordre d'écriture : la chaîne est celle de la base partagée, seule la date d'écriture diffère.
    for (const name of ['february', 'beforeWindow', 'yesterday', 'today', 'monthEdge'] as const) {
      await write(name);
    }
  });

  beforeEach(() => {
    verify.mockReset();
  });

  const deps = (at: string) => ({
    clock: new FixedClock(new Date(at)),
    idGenerator,
  });

  async function brokenEvents(uow: UnitOfWork, partition: string) {
    return (
      await uow
        .selectFrom('platform_domain_events')
        .selectAll()
        .where('event_type', '=', 'AuditChainBroken')
        .where('aggregate_id', '=', toBin(compositeSubjectId('AUDIT_CHAIN_BROKEN', { partition })))
        .orderBy('seq')
        .execute()
    ).map((row) => toDomainEvent(row));
  }

  it('aucune entrée dans la fenêtre : rien n’est vérifié ni publié', async () => {
    await rolledBack(async (uow) => {
      const outcome = await runChainVerification(uow, deps(`${YEAR + 50}-01-01T12:00:00.000Z`), {});
      expect(outcome).toEqual({ status: 'EMPTY', businessDay: `${YEAR + 50}-01-01` });
      expect(verify).not.toHaveBeenCalled();
    });
  });

  it('fenêtre : du début du jour métier précédent à la dernière entrée (AV-470)', async () => {
    verify.mockResolvedValue({ checked: 7, ok: true, brokenAtSeq: null, reason: null });
    await rolledBack(async (uow) => {
      const outcome = await runChainVerification(uow, deps(RUN_AT()), {});
      // Le 03-11 : la fenêtre commence le 03-10 à 00:00 à Douala (03-09 à 23:00 UTC) ; l'entrée du 03-09
      // à 20:00 UTC (21:00 à Douala le 03-09) en est exclue, celles du 03-10 et du 03-11 y sont.
      expect(outcome).toMatchObject({
        status: 'INTACT',
        businessDay: `${YEAR}-03-11`,
        checked: 7,
        fromSeq: seqOf.yesterday,
      });
      expect(verify).toHaveBeenCalledTimes(1);
      const range = verify.mock.calls[0]![1];
      expect(range.fromSeq).toBe(seqOf.yesterday);
      expect(range.toSeq).toBeGreaterThanOrEqual(seqOf.monthEdge);
    });
    // Le lendemain, la veille devient « hier » : l'entrée du 03-09 (jour métier précédent du 03-10) y entre.
    await rolledBack(async (uow) => {
      await runChainVerification(uow, deps(runAt('10')), {});
      expect(verify.mock.calls[1]![1].fromSeq).toBe(seqOf.beforeWindow);
    });
  });

  it('chaîne intacte : aucun événement', async () => {
    verify.mockResolvedValue({ checked: 3, ok: true, brokenAtSeq: null, reason: null });
    await rolledBack(async (uow) => {
      const outcome = await runChainVerification(uow, deps(RUN_AT()), {});
      expect(outcome.status).toBe('INTACT');
      expect(await brokenEvents(uow, `${YEAR}-03`)).toEqual([]);
    });
  });

  it('rupture : un événement sur la partition du mois métier de l’écriture, la tâche ne lève pas', async () => {
    verify.mockResolvedValue({
      checked: 4,
      ok: false,
      brokenAtSeq: seqOf.yesterday,
      reason: 'HASH_MISMATCH',
    });
    await rolledBack(async (uow) => {
      const outcome = await runChainVerification(uow, deps(RUN_AT()), {
        scheduledFor: RUN_AT(),
      });
      expect(outcome).toMatchObject({
        status: 'BROKEN',
        brokenAtSeq: seqOf.yesterday,
        reason: 'HASH_MISMATCH',
        partition: `${YEAR}-03`,
        published: true,
      });
      const [event] = await brokenEvents(uow, `${YEAR}-03`);
      expect(event!.producerModule).toBe('audit');
      expect(event!.aggregateType).toBe('AUDIT_PARTITION');
      expect(event!.occurredAt.toISOString()).toBe(RUN_AT());
      expect(event!.payload).toMatchObject({
        partition: `${YEAR}-03`,
        position: seqOf.yesterday,
        reason: 'HASH_MISMATCH',
        window_from_seq: seqOf.yesterday,
        window_to_seq: expect.any(Number),
        business_day: `${YEAR}-03-11`,
        pass_id: expect.stringContaining('AUDIT_CHAIN_BROKEN'),
      });
    });
  });

  it('la partition est le mois métier de l’écriture rompue, pas celui de la vérification ni le mois UTC', async () => {
    verify.mockResolvedValue({
      checked: 1,
      ok: false,
      brokenAtSeq: seqOf.february,
      reason: 'LINKAGE_MISMATCH',
    });
    await rolledBack(async (uow) => {
      const old = await runChainVerification(uow, deps(RUN_AT()), {});
      expect(old).toMatchObject({ status: 'BROKEN', partition: `${YEAR}-02` });
      expect(await brokenEvents(uow, `${YEAR}-02`)).toHaveLength(1);
    });
    verify.mockResolvedValue({
      checked: 1,
      ok: false,
      brokenAtSeq: seqOf.monthEdge,
      reason: 'LINKAGE_MISMATCH',
    });
    await rolledBack(async (uow) => {
      // 31 mars 23:30 UTC = 1er avril 00:30 à Douala : mois métier d'avril.
      const edge = await runChainVerification(uow, deps(RUN_AT()), {});
      expect(edge).toMatchObject({ status: 'BROKEN', partition: `${YEAR}-04` });
      expect(await brokenEvents(uow, `${YEAR}-04`)).toHaveLength(1);
      expect(await brokenEvents(uow, `${YEAR}-03`)).toEqual([]);
    });
  });

  it('rejeu du même créneau : un seul événement ; un autre créneau republie le sujet', async () => {
    verify.mockResolvedValue({
      checked: 2,
      ok: false,
      brokenAtSeq: seqOf.today,
      reason: 'HASH_MISMATCH',
    });
    await rolledBack(async (uow) => {
      const slot = { scheduledFor: RUN_AT() };
      expect((await runChainVerification(uow, deps(RUN_AT()), slot)).status).toBe('BROKEN');
      const replay = await runChainVerification(uow, deps(RUN_AT()), slot);
      expect(replay).toMatchObject({ status: 'BROKEN', published: false });
      expect(await brokenEvents(uow, `${YEAR}-03`)).toHaveLength(1);

      // Lendemain : la rupture est encore dans la fenêtre, le même sujet est republié (une occurrence de plus).
      const next = await runChainVerification(uow, deps(runAt('12')), {
        scheduledFor: runAt('12'),
      });
      expect(next).toMatchObject({ status: 'BROKEN', published: true });
      expect(await brokenEvents(uow, `${YEAR}-03`)).toHaveLength(2);
    });
  });

  it('le gestionnaire de tâche enregistré termine en succès malgré la rupture (publication puis succès)', async () => {
    verify.mockResolvedValue({
      checked: 2,
      ok: false,
      brokenAtSeq: seqOf.today,
      reason: 'HASH_MISMATCH',
    });
    const registry = new JobHandlerRegistry();
    new ChainVerificationJob(
      new FixedClock(new Date(RUN_AT())),
      idGenerator,
      registry,
    ).onModuleInit();
    const handler = registry.resolve('audit.chain.verify_daily');
    expect(handler).toBeDefined();
    await rolledBack(async (uow) => {
      await expect(handler!(uow, { scheduledFor: RUN_AT() })).resolves.toBeUndefined();
      expect(await brokenEvents(uow, `${YEAR}-03`)).toHaveLength(1);
    });
  });

  it('bout en bout : une alerte critique par partition, une occurrence de plus à chaque nouvelle détection', async () => {
    verify.mockResolvedValue({
      checked: 2,
      ok: false,
      brokenAtSeq: seqOf.today,
      reason: 'HASH_MISMATCH',
    });
    await rolledBack(async (uow) => {
      await runChainVerification(uow, deps(RUN_AT()), { scheduledFor: RUN_AT() });
      await runChainVerification(uow, deps(runAt('12')), {
        scheduledFor: runAt('12'),
      });
      const events = await brokenEvents(uow, `${YEAR}-03`);
      expect(events).toHaveLength(2);
      for (const event of events) await handleAlertEvent(uow, event, { idGenerator });
      const alerts = await uow
        .selectFrom('communication_alerts')
        .select([
          'severity',
          'status',
          'nature',
          'title',
          'message',
          'occurrences',
          'critical_since',
        ])
        .where('dedup_key', '=', `AUDIT_CHAIN_BROKEN:AUDIT_PARTITION:${YEAR}-03`)
        .execute();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        severity: 'CRITICAL',
        status: 'OPEN',
        nature: 'EVENT',
        title: "Chaîne du journal d'audit rompue",
        occurrences: 2,
      });
      expect(alerts[0]!.critical_since).not.toBeNull();
      expect(alerts[0]!.message).toContain(`Partition : ${YEAR}-03`);
      expect(alerts[0]!.message).toContain(`Position : ${seqOf.today}`);
    });
  });
});
