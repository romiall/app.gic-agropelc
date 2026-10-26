/**
 * P9-10 : alerte `AUDIT_CHAIN_BROKEN` (D13 §7.1, BR-AUD-006, AV-420) — `audit.chain.verify_daily` publie
 * `AuditChainBroken` puis se termine en succès (plus d'exception qui annulerait l'événement), sur une
 * fenêtre qui part du jour métier précédent le créneau planifié (deux jours métier en marche normale). `audit_audit_log` interdit tout UPDATE (INV-AUD-01) : une rupture réelle
 * ne peut pas être fabriquée en base, la vérification du chaînage (`verifyChainRange`) est donc simulée —
 * ses propres tests (`verify-chain.test.ts`, `chain-verification.integration.test.ts`) la prouvent par
 * ailleurs. Le reste (fenêtre, partition, publication, rejeu, alerte levée) s'exécute pour de vrai sur des
 * entrées d'audit à dates maîtrisées (années postérieures à toute autre entrée de la base, hors de toute autre suite).
 * Le début de la fenêtre est le plus petit `seq` écrit à partir de la date de début : exact, quel que soit l'ordre
 * des dates d'écriture (une ligne écrite en dernier avec une date ancienne, horloge reculée, ne l'altère pas).
 * Hypothèse d'isolement : une seule exécution de ce fichier à la fois sur une même base (l'année des écritures est
 * choisie après la plus récente du journal ; deux exécutions simultanées choisiraient la même année).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FixedClock,
  SystemClock,
  Uuidv7Generator,
  businessDayOf,
  businessDayStartUtc,
  type IdGenerator,
} from '@gic/domain';
import type * as VerifyChain from '../src/audit/verify-chain.js';

vi.mock('../src/audit/verify-chain.js', async (importOriginal) => ({
  ...(await importOriginal<typeof VerifyChain>()),
  verifyChainRange: vi.fn(),
}));

import { verifyChainRange } from '../src/audit/verify-chain.js';
import { ChainVerificationJob, runChainVerification } from '../src/audit/chain-verification-job.js';
import { recordAudit } from '../src/audit/record-audit.js';
import {
  MAX_CATCH_UP_DAYS,
  firstSeqRecordedAtOrAfter,
  verificationWindowStart,
} from '../src/audit/verification-window.js';
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
  /** Écrite en dernier mais datée très tôt : horloge d'application reculée (hors de toute fenêtre des tests). */
  lagging: () => `${YEAR}-03-05T12:00:00.000Z`,
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
    lagging: 0,
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
    for (const name of [
      'february',
      'beforeWindow',
      'yesterday',
      'today',
      'monthEdge',
      'lagging',
    ] as const) {
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

  async function brokenEvents(uow: UnitOfWork, partition: string, position: number) {
    return (
      await uow
        .selectFrom('platform_domain_events')
        .selectAll()
        .where('event_type', '=', 'AuditChainBroken')
        .where(
          'aggregate_id',
          '=',
          toBin(compositeSubjectId('AUDIT_CHAIN_BROKEN', { partition, position })),
        )
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

  it('fenêtre : du début du jour métier précédent à la dernière entrée (AV-420)', async () => {
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

  it('début de fenêtre exact : le plus petit seq écrit à partir de la date, même si la dernière ligne écrite est ancienne (horloge reculée)', async () => {
    const fromDate = new Date(`${YEAR}-03-09T23:00:00.000Z`); // début du jour métier 03-10 à Douala
    // La ligne `lagging` est la dernière du journal et date de 03-05 : une lecture depuis la fin, qui s'arrête à
    // la première ligne antérieure, l'aurait prise pour la fin de la fenêtre.
    expect(await firstSeqRecordedAtOrAfter(db, fromDate)).toBe(seqOf.yesterday);
    expect(seqOf.lagging).toBeGreaterThan(seqOf.monthEdge);
    // Date postérieure à toute écriture : aucune fenêtre ; à la date de la première écriture de test : son numéro.
    expect(
      await firstSeqRecordedAtOrAfter(db, new Date(`${YEAR + 60}-01-01T00:00:00.000Z`)),
    ).toBeNull();
    expect(await firstSeqRecordedAtOrAfter(db, new Date(`${YEAR}-02-27T12:00:00.000Z`))).toBe(
      seqOf.february,
    );
    // Borne incluse : exactement la date d'écriture de la ligne.
    expect(await firstSeqRecordedAtOrAfter(db, new Date(written.yesterday()))).toBe(
      seqOf.yesterday,
    );
    expect(
      await firstSeqRecordedAtOrAfter(db, new Date(new Date(written.yesterday()).getTime() + 1)),
    ).toBe(seqOf.today);
  });

  it('une ligne ancienne écrite en dernier n’altère pas la fenêtre de la tâche', async () => {
    verify.mockResolvedValue({ checked: 5, ok: true, brokenAtSeq: null, reason: null });
    await rolledBack(async (uow) => {
      const outcome = await runChainVerification(uow, deps(RUN_AT()), {});
      expect(outcome).toMatchObject({ status: 'INTACT', fromSeq: seqOf.yesterday });
      // La fin est la dernière ligne du journal, y compris la ligne ancienne écrite en dernier.
      expect(verify.mock.calls[0]![1].toSeq).toBeGreaterThanOrEqual(seqOf.lagging);
    });
  });

  describe('verificationWindowStart : début de la fenêtre, du créneau planifié (AV-420)', () => {
    const now = () => new Date(RUN_AT());
    const dayStart = (iso: string) => businessDayStartUtc(businessDayOf(new Date(iso)));
    const oneDayBefore = (date: Date) => new Date(date.getTime() - 86_400_000);

    it('sans créneau exploitable : le jour métier précédent celui de l’exécution', () => {
      const expected = oneDayBefore(dayStart(RUN_AT()));
      expect(verificationWindowStart({}, now())).toEqual(expected);
      expect(verificationWindowStart(null, now())).toEqual(expected);
      expect(verificationWindowStart({ scheduledFor: '' }, now())).toEqual(expected);
      expect(verificationWindowStart({ scheduledFor: 'pas une date' }, now())).toEqual(expected);
      expect(verificationWindowStart({ scheduledFor: 12 }, now())).toEqual(expected);
    });

    it('créneau du jour : même fenêtre qu’une exécution à l’heure', () => {
      expect(verificationWindowStart({ scheduledFor: RUN_AT() }, now())).toEqual(
        oneDayBefore(dayStart(RUN_AT())),
      );
    });

    it('après un arrêt : la fenêtre part du jour précédent le créneau manqué', () => {
      const missed = runAt('08');
      expect(verificationWindowStart({ scheduledFor: missed }, now())).toEqual(
        oneDayBefore(dayStart(missed)),
      );
    });

    it('un créneau postérieur à l’exécution (horloge) est ramené à l’exécution', () => {
      expect(verificationWindowStart({ scheduledFor: runAt('15') }, now())).toEqual(
        oneDayBefore(dayStart(RUN_AT())),
      );
    });

    it('plafond de 31 jours : les deux côtés de la frontière, en dates littérales', () => {
      // Exécution le 2030-03-11 à 03:00 à Douala (année non bissextile) : le plafond est le jour métier du
      // 2030-02-08, qui commence le 2030-02-07 à 23:00 UTC.
      const run = new Date('2030-03-11T02:00:00.000Z');
      const floor = new Date('2030-02-07T23:00:00.000Z');
      // Créneau du 02-09 : son jour précédent (02-08) est exactement le plafond, non modifié.
      expect(verificationWindowStart({ scheduledFor: '2030-02-09T02:00:00.000Z' }, run)).toEqual(
        floor,
      );
      // Créneau du 02-10 : le jour précédent (02-09) est postérieur au plafond, non modifié.
      expect(verificationWindowStart({ scheduledFor: '2030-02-10T02:00:00.000Z' }, run)).toEqual(
        new Date('2030-02-08T23:00:00.000Z'),
      );
      // Créneau du 02-08 : le jour précédent (02-07) est un jour plus ancien que le plafond, ramené au plafond.
      expect(verificationWindowStart({ scheduledFor: '2030-02-08T02:00:00.000Z' }, run)).toEqual(
        floor,
      );
      // Créneau du 02-07 : ramené au plafond aussi.
      expect(verificationWindowStart({ scheduledFor: '2030-02-07T02:00:00.000Z' }, run)).toEqual(
        floor,
      );
    });

    it('plafonné : jamais plus de MAX_CATCH_UP_DAYS jours métier avant l’exécution', () => {
      const floor = new Date(dayStart(RUN_AT()).getTime() - MAX_CATCH_UP_DAYS * 86_400_000);
      expect(
        verificationWindowStart({ scheduledFor: `${YEAR}-01-01T02:00:00.000Z` }, now()),
      ).toEqual(floor);
      // Un créneau assez récent pour que son jour précédent soit au plafond ou après n'est pas modifié.
      const inside = new Date(floor.getTime() + 2 * 86_400_000 + 3_600_000).toISOString();
      expect(verificationWindowStart({ scheduledFor: inside }, now())).toEqual(
        oneDayBefore(dayStart(inside)),
      );
    });
  });

  it('après un arrêt du worker : la fenêtre remonte jusqu’au créneau manqué, aucune écriture de la période n’échappe', async () => {
    verify.mockResolvedValue({ checked: 9, ok: true, brokenAtSeq: null, reason: null });
    await rolledBack(async (uow) => {
      // Tâche du 03-08 03:00 exécutée le 03-11 à 03:00 : la fenêtre part du 03-07 (début à Douala).
      const outcome = await runChainVerification(uow, deps(RUN_AT()), {
        scheduledFor: runAt('08'),
      });
      expect(outcome).toMatchObject({ status: 'INTACT', fromSeq: seqOf.beforeWindow });
      expect(verify.mock.calls[0]![1].fromSeq).toBe(seqOf.beforeWindow);
    });
  });

  it('interruption très longue : la fenêtre est plafonnée', async () => {
    verify.mockResolvedValue({ checked: 1, ok: true, brokenAtSeq: null, reason: null });
    await rolledBack(async (uow) => {
      // Exécution le 04-15 d’un créneau du 01-01 : plafond au 03-15 (début à Douala le 03-14 à 23:00 UTC) ;
      // seule l’écriture du 31 mars y entre, ni février ni la semaine du 03-09.
      const outcome = await runChainVerification(uow, deps(`${YEAR}-04-15T02:00:00.000Z`), {
        scheduledFor: `${YEAR}-01-01T02:00:00.000Z`,
      });
      expect(outcome).toMatchObject({ status: 'INTACT', fromSeq: seqOf.monthEdge });
    });
  });

  it('chaîne intacte : aucun événement', async () => {
    verify.mockResolvedValue({ checked: 3, ok: true, brokenAtSeq: null, reason: null });
    await rolledBack(async (uow) => {
      const outcome = await runChainVerification(uow, deps(RUN_AT()), {});
      expect(outcome.status).toBe('INTACT');
      expect(await brokenEvents(uow, `${YEAR}-03`, seqOf.yesterday)).toEqual([]);
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
      const [event] = await brokenEvents(uow, `${YEAR}-03`, seqOf.yesterday);
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
      expect(await brokenEvents(uow, `${YEAR}-02`, seqOf.february)).toHaveLength(1);
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
      expect(await brokenEvents(uow, `${YEAR}-04`, seqOf.monthEdge)).toHaveLength(1);
      expect(await brokenEvents(uow, `${YEAR}-03`, seqOf.monthEdge)).toEqual([]);
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
      expect(await brokenEvents(uow, `${YEAR}-03`, seqOf.today)).toHaveLength(1);

      // Lendemain : la rupture est encore dans la fenêtre, le même sujet est republié (une occurrence de plus).
      const next = await runChainVerification(uow, deps(runAt('12')), {
        scheduledFor: runAt('12'),
      });
      expect(next).toMatchObject({ status: 'BROKEN', published: true });
      expect(await brokenEvents(uow, `${YEAR}-03`, seqOf.today)).toHaveLength(2);
    });
  });

  it('deux ruptures distinctes du même mois : deux sujets, la seconde lève sa propre alerte', async () => {
    await rolledBack(async (uow) => {
      verify.mockResolvedValue({
        checked: 2,
        ok: false,
        brokenAtSeq: seqOf.yesterday,
        reason: 'HASH_MISMATCH',
      });
      await runChainVerification(uow, deps(RUN_AT()), { scheduledFor: RUN_AT() });
      verify.mockResolvedValue({
        checked: 3,
        ok: false,
        brokenAtSeq: seqOf.today,
        reason: 'LINKAGE_MISMATCH',
      });
      await runChainVerification(uow, deps(runAt('12')), { scheduledFor: runAt('12') });

      const first = await brokenEvents(uow, `${YEAR}-03`, seqOf.yesterday);
      const second = await brokenEvents(uow, `${YEAR}-03`, seqOf.today);
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(first[0]!.aggregateId).not.toBe(second[0]!.aggregateId);
      for (const event of [...first, ...second]) {
        await handleAlertEvent(uow, event, { idGenerator });
      }
      const alerts = await uow
        .selectFrom('communication_alerts')
        .select(['dedup_key', 'occurrences'])
        .where('dedup_key', 'in', [
          `AUDIT_CHAIN_BROKEN:AUDIT_PARTITION:${YEAR}-03:${seqOf.yesterday}`,
          `AUDIT_CHAIN_BROKEN:AUDIT_PARTITION:${YEAR}-03:${seqOf.today}`,
        ])
        .orderBy('dedup_key')
        .execute();
      expect(alerts).toHaveLength(2);
      for (const alert of alerts) expect(alert.occurrences).toBe(1);
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
      expect(await brokenEvents(uow, `${YEAR}-03`, seqOf.today)).toHaveLength(1);
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
      const events = await brokenEvents(uow, `${YEAR}-03`, seqOf.today);
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
        .where('dedup_key', '=', `AUDIT_CHAIN_BROKEN:AUDIT_PARTITION:${YEAR}-03:${seqOf.today}`)
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
