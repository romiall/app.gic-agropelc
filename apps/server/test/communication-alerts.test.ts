/**
 * P9-04 : socle des alertes (ADR-061 ; SM-ALERT ; BR-NOT-002 à 005 ; INV-NOT-01) — consommateur
 * `communication.alerts` (levée, déduplication, redélivrance, relèvement de gravité, résolution par
 * condition et par passe, règle désactivée, concurrence) et commandes `communication.alert.*` et
 * `communication.alert_rule.set` (accès, fait accompli, transitions, règles).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from 'kysely';
import { FixedClock, Uuidv7Generator, type AlertType } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import type { DomainEvent } from '../src/platform/events/domain-event.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { registerAlertCommands } from '../src/modules/communication/application/commands/alert-commands.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { closeTestDb, db, freshUuid, insertTestUser } from './helpers.js';
import { codeOf, newActor, runCommand, tx, type Actor } from './cash-transfer-fixtures.js';
import { committed, rolledBack } from './communication-test-kit.js';

const AT = '2026-11-02T09:00:00.000Z';
const idGenerator = new Uuidv7Generator(new FixedClock(new Date('2026-11-02T10:00:00.000Z')));
const options = { idGenerator };

let seq = 9_000_000_000;
function eventOf(
  eventType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  occurredAt = '2026-11-02T08:00:00.000Z',
  eventId = freshUuid(),
): DomainEvent {
  seq += 1;
  return {
    seq,
    eventId,
    eventType,
    eventVersion: 1,
    producerModule: 'test',
    aggregateType: 'TEST',
    aggregateId,
    occurredAt: new Date(occurredAt),
    recordedAt: new Date(occurredAt),
    payload,
    commandId: null,
    correlationId: null,
    causationId: null,
  };
}

const overdue = (saleId: string, extra: Record<string, unknown> = {}) =>
  eventOf('ReceivableOverdue', saleId, {
    sale_id: saleId,
    doc_number: 'VTE-2026-000123',
    commercial_user_id: freshUuid(),
    site_id: freshUuid(),
    days_overdue: 13,
    balance_due_xaf: 45_000,
    business_day: '2026-11-02',
    ...extra,
  });

/**
 * Plugin de test : suspend la transaction juste après sa première lecture verrouillante qui ne trouve
 * rien (la clé ouverte n'existe pas encore), pour y intercaler une transaction concurrente.
 */
function pauseAfterEmptyAlertLock(onEmpty: () => Promise<void>): KyselyPlugin {
  const locking = new Set<string>();
  let paused = false;
  return {
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      const node = args.node;
      if (
        node.kind === 'SelectQueryNode' &&
        node.endModifiers?.some((modifier) => modifier.modifier === 'ForUpdate')
      ) {
        locking.add(args.queryId.queryId);
      }
      return node;
    },
    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
      if (!paused && locking.has(args.queryId.queryId) && args.result.rows.length === 0) {
        paused = true;
        await onEmpty();
      }
      return args.result;
    },
  };
}

const alertsOf = (uow: UnitOfWork, type: AlertType, subject: string) =>
  uow
    .selectFrom('communication_alerts')
    .selectAll()
    .where('alert_type', '=', type)
    .where('subject_id', '=', toBin(subject))
    .execute();

const eventsOf = (uow: UnitOfWork, alertId: Buffer, type: string) =>
  uow
    .selectFrom('platform_domain_events')
    .select(['event_type', 'payload'])
    .where('aggregate_id', '=', alertId)
    .where('event_type', '=', type)
    .execute();

describe('P9-04 : consommateur communication.alerts', () => {
  it('levée : une alerte ouverte, rendue en neutre, avec son événement AlertRaised', () =>
    rolledBack(async (uow) => {
      const sale = freshUuid();
      const event = overdue(sale);
      await handleAlertEvent(uow, event, options);
      const [alert] = await alertsOf(uow, 'OVERDUE_RECEIVABLE', sale);
      expect(alert).toMatchObject({
        alert_type: 'OVERDUE_RECEIVABLE',
        nature: 'STATE',
        severity: 'WARNING',
        status: 'OPEN',
        subject_type: 'SALE',
        title: 'Créance échue',
        action_screen: 'ECR-FIN-01',
        occurrences: 1,
        dedup_key: `OVERDUE_RECEIVABLE:${sale}`,
        open_dedup_key: `OVERDUE_RECEIVABLE:${sale}`,
      });
      expect(alert!.message).toBe(
        'Vente : VTE-2026-000123 ; Jours de retard : 13 ; Solde dû : 45 000 XAF',
      );
      expect(alert!.critical_since).toBeNull();
      expect(alert!.owner_user_id).not.toBeNull();
      const raised = await eventsOf(uow, alert!.id, 'AlertRaised');
      expect(raised).toHaveLength(1);
      expect(raised[0]!.payload).toMatchObject({ created: true, alert_type: 'OVERDUE_RECEIVABLE' });
    }));

  it('déduplication : une nouvelle occurrence met à jour l’alerte ouverte au lieu d’en créer une', () =>
    rolledBack(async (uow) => {
      const sale = freshUuid();
      await handleAlertEvent(uow, overdue(sale, { days_overdue: 13 }), options);
      await handleAlertEvent(uow, overdue(sale, { days_overdue: 14 }), options);
      await handleAlertEvent(
        uow,
        eventOf(
          'ReceivableOverdue',
          sale,
          {
            sale_id: sale,
            doc_number: 'VTE-2026-000123',
            days_overdue: 15,
            balance_due_xaf: 45_000,
          },
          '2026-11-04T08:00:00.000Z',
        ),
        options,
      );
      const alerts = await alertsOf(uow, 'OVERDUE_RECEIVABLE', sale);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ occurrences: 3, status: 'OPEN' });
      expect(alerts[0]!.last_detected_at.toISOString()).toBe('2026-11-04T08:00:00.000Z');
      expect(alerts[0]!.message).toContain('Jours de retard : 15');
      // Aucune levée supplémentaire : un seul AlertRaised.
      expect(await eventsOf(uow, alerts[0]!.id, 'AlertRaised')).toHaveLength(1);
    }));

  it('redélivrance : le même événement n’est compté qu’une fois (marque du consommateur)', () =>
    rolledBack(async (uow) => {
      const sale = freshUuid();
      const event = overdue(sale);
      await handleAlertEvent(uow, event, options);
      await handleAlertEvent(uow, event, options);
      await handleAlertEvent(uow, event, options);
      const [alert] = await alertsOf(uow, 'OVERDUE_RECEIVABLE', sale);
      expect(alert!.occurrences).toBe(1);
    }));

  it('un événement étranger aux alertes n’est ni marqué ni traité', () =>
    rolledBack(async (uow) => {
      const event = eventOf('sales.sale.record', freshUuid(), {});
      await handleAlertEvent(uow, event, options);
      const marks = await uow
        .selectFrom('platform_event_consumer_marks')
        .select('event_id')
        .where('consumer_name', '=', 'communication.alerts')
        .where('event_id', '=', toBin(event.eventId))
        .execute();
      expect(marks).toHaveLength(0);
    }));

  it('gravité : relevée par une occurrence plus grave (critical_since posé), jamais abaissée', () =>
    rolledBack(async (uow) => {
      const session = freshUuid();
      const variance = (severity: string, amount: number) =>
        eventOf('CashVarianceDetected', session, {
          session_id: session,
          variance_xaf: amount,
          severity,
          site_id: freshUuid(),
        });
      await handleAlertEvent(uow, variance('WARNING', -2_000), options);
      let [alert] = await alertsOf(uow, 'CASH_VARIANCE', session);
      expect(alert).toMatchObject({ severity: 'WARNING', critical_since: null });
      await handleAlertEvent(uow, variance('CRITICAL', -15_000), options);
      [alert] = await alertsOf(uow, 'CASH_VARIANCE', session);
      expect(alert!.severity).toBe('CRITICAL');
      expect(alert!.critical_since).not.toBeNull();
      expect(alert!.occurrences).toBe(2);
      // Une occurrence moins grave ne l'abaisse pas.
      await handleAlertEvent(uow, variance('WARNING', -1_000), options);
      [alert] = await alertsOf(uow, 'CASH_VARIANCE', session);
      expect(alert).toMatchObject({ severity: 'CRITICAL', occurrences: 3 });
      // Le relèvement a produit un second AlertRaised, marqué comme tel.
      const raised = await eventsOf(uow, alert!.id, 'AlertRaised');
      expect(
        raised.map((r) => (r.payload as { severity_raised: boolean }).severity_raised),
      ).toEqual([false, true]);
    }));

  it('résolution par condition disparue : l’alerte se clôt, un nouvel événement en crée une nouvelle', () =>
    rolledBack(async (uow) => {
      const session = freshUuid();
      await handleAlertEvent(
        uow,
        eventOf('CashSessionOpenLongDetected', session, {
          session_id: session,
          opened_by: freshUuid(),
          site_id: freshUuid(),
          hours_open: 30,
        }),
        options,
      );
      await handleAlertEvent(
        uow,
        eventOf('CashSessionClosed', session, { session_id: session }, '2026-11-02T12:00:00.000Z'),
        options,
      );
      let alerts = await alertsOf(uow, 'CASH_SESSION_OPEN_LONG', session);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ status: 'RESOLVED', resolution_kind: 'CONDITION_CLEARED' });
      expect(alerts[0]!.open_dedup_key).toBeNull();
      expect(alerts[0]!.resolved_by).toBeNull();
      const resolved = await eventsOf(uow, alerts[0]!.id, 'AlertResolved');
      expect(resolved).toHaveLength(1);
      // La condition revient : une alerte neuve (l'ancienne est immuable).
      await handleAlertEvent(
        uow,
        eventOf('CashSessionOpenLongDetected', session, {
          session_id: session,
          opened_by: freshUuid(),
          hours_open: 50,
        }),
        options,
      );
      alerts = await alertsOf(uow, 'CASH_SESSION_OPEN_LONG', session);
      expect(alerts.map((a) => a.status).sort()).toEqual(['OPEN', 'RESOLVED']);
    }));

  it('résolution sans alerte ouverte : sans effet', () =>
    rolledBack(async (uow) => {
      const session = freshUuid();
      await handleAlertEvent(uow, eventOf('CashSessionClosed', session, {}), options);
      expect(await alertsOf(uow, 'CASH_SESSION_OPEN_LONG', session)).toHaveLength(0);
    }));

  it('passe complète : les alertes d’état non revues sont résolues, par identité de passe', () =>
    rolledBack(async (uow) => {
      const a = freshUuid();
      const b = freshUuid();
      const c = freshUuid();
      const day = '2026-11-02';
      const seen = (sale: string, pass: string) =>
        overdue(sale, { pass_id: pass, business_day: day });
      for (const sale of [a, b, c]) await handleAlertEvent(uow, seen(sale, 'pass-1'), options);
      // Seconde passe : seule `a` est encore vraie ; le marqueur clôt la passe.
      await handleAlertEvent(uow, seen(a, 'pass-2'), options);
      await handleAlertEvent(
        uow,
        eventOf('AlertDetectionPassCompleted', freshUuid(), {
          alert_type: 'OVERDUE_RECEIVABLE',
          pass_id: 'pass-2',
          business_day: day,
        }),
        options,
      );
      // Les autres alertes de la base (autres tests) du même type sont elles aussi résolues si elles
      // n'ont pas pass-2 : on ne vérifie ici que les trois sujets du test.
      const status = async (sale: string) => (await alertsOf(uow, 'OVERDUE_RECEIVABLE', sale))[0]!;
      expect(await status(a)).toMatchObject({ status: 'OPEN', last_pass_id: 'pass-2' });
      expect(await status(b)).toMatchObject({ status: 'RESOLVED', resolution_kind: 'PASS' });
      expect(await status(c)).toMatchObject({ status: 'RESOLVED', resolution_kind: 'PASS' });
    }));

  it('une passe rejouée avec la même identité ne résout pas ce qu’elle a revu', () =>
    rolledBack(async (uow) => {
      const a = freshUuid();
      const b = freshUuid();
      await handleAlertEvent(uow, overdue(a, { pass_id: 'pass-1' }), options);
      await handleAlertEvent(uow, overdue(b, { pass_id: 'pass-1' }), options);
      const marker = (pass: string) =>
        eventOf('AlertDetectionPassCompleted', freshUuid(), {
          alert_type: 'OVERDUE_RECEIVABLE',
          pass_id: pass,
        });
      // Passe 1 rejouée : les deux sont revues par elle, aucune n'est résolue.
      await handleAlertEvent(uow, marker('pass-1'), options);
      for (const sale of [a, b]) {
        expect((await alertsOf(uow, 'OVERDUE_RECEIVABLE', sale))[0]!.status).toBe('OPEN');
      }
    }));

  it('un marqueur n’affecte ni les alertes d’événement ni les autres types', () =>
    rolledBack(async (uow) => {
      const loss = freshUuid();
      const location = freshUuid();
      await handleAlertEvent(
        uow,
        eventOf('HighLossDetected', location, {
          location_id: location,
          business_day: '2026-11-02',
          loss_value_xaf: 90_000,
          site_id: freshUuid(),
        }),
        options,
      );
      await handleAlertEvent(
        uow,
        eventOf('AlertDetectionPassCompleted', loss, { alert_type: 'HIGH_LOSS', pass_id: 'p' }),
        options,
      );
      const rows = await uow
        .selectFrom('communication_alerts')
        .select('status')
        .where('alert_type', '=', 'HIGH_LOSS')
        .where('dedup_key', '=', `HIGH_LOSS:LOSS_DAY:${location}:2026-11-02`)
        .execute();
      expect(rows).toEqual([{ status: 'OPEN' }]);
    }));

  it('sujet composite : un identifiant déterministe, une seule alerte par couple emplacement × produit', () =>
    rolledBack(async (uow) => {
      const location = freshUuid();
      const product = freshUuid();
      const breach = (available: number) =>
        eventOf('StockThresholdBreached', location, {
          location_id: location,
          product_id: product,
          level: 'LOW',
          breached: true,
          available,
          site_id: freshUuid(),
        });
      await handleAlertEvent(uow, breach(4), options);
      await handleAlertEvent(uow, breach(3), options);
      const rows = await uow
        .selectFrom('communication_alerts')
        .selectAll()
        .where('dedup_key', '=', `STOCK_LOW:STOCK_POSITION:${location}:${product}`)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ subject_type: 'STOCK_POSITION', occurrences: 2 });
      const again = await alertsOf(uow, 'STOCK_LOW', fromBin(rows[0]!.subject_id));
      expect(again).toHaveLength(1);
    }));

  it('règle désactivée : l’événement est reconnu mais aucune alerte n’est levée', async () => {
    const sale = freshUuid();
    await tx((trx) =>
      trx
        .updateTable('communication_alert_rules')
        .set({ enabled: 0 })
        .where('alert_type', '=', 'PRICE_MISMATCH')
        .execute(),
    );
    try {
      await rolledBack(async (uow) => {
        await handleAlertEvent(
          uow,
          eventOf('PriceMismatchDetected', sale, { sale_id: sale }),
          options,
        );
        expect(await alertsOf(uow, 'PRICE_MISMATCH', sale)).toHaveLength(0);
      });
    } finally {
      await tx((trx) =>
        trx
          .updateTable('communication_alert_rules')
          .set({ enabled: 1 })
          .where('alert_type', '=', 'PRICE_MISMATCH')
          .execute(),
      );
    }
  });

  it('gravité de la règle : sans gravité déclarée par l’événement, celle de la règle (relevée par un administrateur) s’applique', async () => {
    const session = freshUuid();
    const setRuleSeverity = (severity: string) =>
      tx((trx) =>
        trx
          .updateTable('communication_alert_rules')
          .set({ severity })
          .where('alert_type', '=', 'CASH_VARIANCE')
          .execute(),
      );
    await setRuleSeverity('CRITICAL');
    try {
      await rolledBack(async (uow) => {
        await handleAlertEvent(
          uow,
          eventOf('CashVarianceDetected', session, { session_id: session, variance_xaf: -500 }),
          options,
        );
        const [alert] = await alertsOf(uow, 'CASH_VARIANCE', session);
        expect(alert!.severity).toBe('CRITICAL');
        expect(alert!.critical_since).not.toBeNull();
      });
    } finally {
      await setRuleSeverity('WARNING');
    }
  });

  it('concurrence : deux consommateurs lèvent la même alerte, une seule ligne ouverte (INV-NOT-01)', async () => {
    const sale = freshUuid();
    // Sous `REPEATABLE READ` deux premières levées simultanées s'interbloquent (verrous d'intervalle) :
    // InnoDB en annule une, que le runner rejoue (jusqu'à `maxAttempts`) ; on fait de même ici.
    const deadlock = (error: unknown) => (error as { errno?: number } | null)?.errno === 1213;
    const run = async (pass: string) => {
      const event = overdue(sale, { pass_id: pass });
      for (let attempt = 1; ; attempt++) {
        try {
          return await committed((uow) => handleAlertEvent(uow, event, options));
        } catch (error) {
          if (!deadlock(error) || attempt >= 5) throw error;
        }
      }
    };
    await Promise.all([run('c-1'), run('c-2'), run('c-3'), run('c-4')]);
    const alerts = await db
      .selectFrom('communication_alerts')
      .selectAll()
      .where('alert_type', '=', 'OVERDUE_RECEIVABLE')
      .where('subject_id', '=', toBin(sale))
      .execute();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ status: 'OPEN', occurrences: 4 });
  });

  it('course à la clé ouverte (lecture validée) : le doublon est repris sur l’alerte du concurrent', async () => {
    // Sous `READ COMMITTED` il n'y a pas de verrou d'intervalle : B lit « aucune alerte ouverte », A lève
    // et valide, puis B insère et se heurte à l'index unique (1062). B doit relire, verrouiller et compter.
    const sale = freshUuid();
    let reachedEmptyRead!: () => void;
    const bReadEmpty = new Promise<void>((resolve) => {
      reachedEmptyRead = resolve;
    });
    let releaseB!: () => void;
    const bReleased = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const b = committed(
      (uow) =>
        handleAlertEvent(
          uow.withPlugin(
            pauseAfterEmptyAlertLock(async () => {
              reachedEmptyRead();
              await bReleased;
            }),
          ),
          overdue(sale, { pass_id: 'race-b' }),
          options,
        ),
      { isolation: 'read committed' },
    );
    await Promise.race([bReadEmpty, b]);
    await committed((uow) => handleAlertEvent(uow, overdue(sale, { pass_id: 'race-a' }), options), {
      isolation: 'read committed',
    });
    releaseB();
    await b;
    const alerts = await db
      .selectFrom('communication_alerts')
      .selectAll()
      .where('alert_type', '=', 'OVERDUE_RECEIVABLE')
      .where('subject_id', '=', toBin(sale))
      .execute();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ status: 'OPEN', occurrences: 2, last_pass_id: 'race-b' });
    // Une seule levée a créé l'alerte ; la reprise n'a publié aucun second AlertRaised.
    const raised = await db
      .selectFrom('platform_domain_events')
      .select('event_id')
      .where('aggregate_id', '=', alerts[0]!.id)
      .where('event_type', '=', 'AlertRaised')
      .execute();
    expect(raised).toHaveLength(1);
  });

  it('une occurrence hors passe (transition) ne détruit pas l’identité de la dernière passe', () =>
    rolledBack(async (uow) => {
      const sale = freshUuid();
      await handleAlertEvent(uow, overdue(sale, { pass_id: 'pass-1' }), options);
      await handleAlertEvent(uow, overdue(sale), options);
      const [alert] = await alertsOf(uow, 'OVERDUE_RECEIVABLE', sale);
      expect(alert).toMatchObject({ occurrences: 2, last_pass_id: 'pass-1', status: 'OPEN' });
      // Le marqueur de la passe qui l'a revue en dernier ne la résout donc pas.
      await handleAlertEvent(
        uow,
        eventOf('AlertDetectionPassCompleted', freshUuid(), {
          alert_type: 'OVERDUE_RECEIVABLE',
          pass_id: 'pass-1',
        }),
        options,
      );
      expect((await alertsOf(uow, 'OVERDUE_RECEIVABLE', sale))[0]!.status).toBe('OPEN');
    }));
});

describe('P9-04 : commandes communication.alert.*', () => {
  let pipeline: CommandPipelineService;
  let finance: Actor;
  let direction: Actor;
  let seller: Actor;
  let outsider: Actor;
  let siteA: string;
  let siteB: string;

  const run = (
    actor: Actor,
    type: string,
    aggregateId: string,
    payload: unknown,
    offline = false,
  ) =>
    runCommand(pipeline, actor, {
      type,
      aggregateType: type.includes('alert_rule') ? 'ALERT_RULE' : 'ALERT',
      aggregateId,
      occurredAt: AT,
      payload,
      offline,
    });

  const alertRow = (id: string) =>
    db
      .selectFrom('communication_alerts')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirst();

  /** Alerte `HIGH_LOSS` (alerte d'événement) ou `OVERDUE_RECEIVABLE` (état) levée par le consommateur. */
  async function raise(kind: 'EVENT' | 'STATE', siteId: string): Promise<string> {
    const subject = freshUuid();
    const event =
      kind === 'EVENT'
        ? eventOf('HighLossDetected', subject, {
            location_id: subject,
            business_day: '2026-11-02',
            loss_value_xaf: 90_000,
            site_id: siteId,
          })
        : overdue(subject, { site_id: siteId });
    await db.transaction().execute((uow) => handleAlertEvent(uow, event, options));
    const row = await db
      .selectFrom('communication_alerts')
      .select('id')
      .where(
        'dedup_key',
        '=',
        kind === 'EVENT'
          ? `HIGH_LOSS:LOSS_DAY:${subject}:2026-11-02`
          : `OVERDUE_RECEIVABLE:${subject}`,
      )
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  beforeAll(async () => {
    const clock = new FixedClock(new Date('2026-11-02T10:00:00.000Z'));
    const registry = new CommandHandlerRegistry();
    registerAlertCommands(registry, new Uuidv7Generator(clock));
    pipeline = new CommandPipelineService(db, registry, clock, new Uuidv7Generator(clock));
    const root = await tx((trx) => insertTestUser(trx));
    const zone = await tx(async (trx) => {
      const { insertTestZone } = await import('./helpers.js');
      return insertTestZone(trx, root);
    });
    const helpers = await import('./helpers.js');
    siteA = await tx((trx) => helpers.insertTestSite(trx, root, zone));
    siteB = await tx((trx) => helpers.insertTestSite(trx, root, zone));
    finance = await newActor('FINANCE', root);
    direction = await newActor('DIRECTION', root);
    // Vendeur du site A (portée SITE) : ne voit pas les alertes du site B.
    seller = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteA });
    outsider = await newActor('COMMERCIAL_TERRAIN', root, {
      scopeType: 'ZONE',
      scopeZoneId: zone,
    });
  });

  afterAll(closeTestDb);

  it('prise en compte : OPEN → ACKNOWLEDGED, rejeu et alerte close sans effet (fait accompli)', async () => {
    const id = await raise('EVENT', siteA);
    expect(codeOf(await run(finance, 'communication.alert.acknowledge', id, {}))).toBe('APPLIED');
    expect(await alertRow(id)).toMatchObject({ status: 'ACKNOWLEDGED', occurrences: 1 });
    expect((await alertRow(id))!.acknowledged_by).not.toBeNull();
    // Deuxième prise en compte (autre commande) : sans effet, jamais rejetée.
    const second = await run(direction, 'communication.alert.acknowledge', id, {});
    expect(codeOf(second)).toBe('APPLIED');
    expect(await alertRow(id)).toMatchObject({ status: 'ACKNOWLEDGED' });
    // Alerte résolue entre-temps : la prise en compte tardive est sans effet.
    expect(
      codeOf(await run(direction, 'communication.alert.resolve', id, { comment: 'Régularisé' })),
    ).toBe('APPLIED');
    expect(codeOf(await run(finance, 'communication.alert.acknowledge', id, {}))).toBe('APPLIED');
    expect(await alertRow(id)).toMatchObject({ status: 'RESOLVED', resolution_kind: 'MANUAL' });
  });

  it('prise en compte hors ligne admise ; événements nommés publiés', async () => {
    const id = await raise('EVENT', siteA);
    expect(
      codeOf(await run(finance, 'communication.alert.acknowledge', id, { comment: 'Vu' }, true)),
    ).toBe('APPLIED');
    const events = await db
      .selectFrom('platform_domain_events')
      .select('event_type')
      .where('aggregate_id', '=', toBin(id))
      .where('event_type', 'in', ['AlertRaised', 'AlertAcknowledged'])
      .execute();
    expect(events.map((e) => e.event_type).sort()).toEqual(['AlertAcknowledged', 'AlertRaised']);
  });

  it('résolution : commentaire obligatoire ; une alerte d’état ne se résout pas à la main', async () => {
    const event = await raise('EVENT', siteA);
    expect(
      codeOf(await run(finance, 'communication.alert.resolve', event, { comment: ' ' })),
    ).toMatch(/^VALIDATION_ERROR/);
    expect(
      codeOf(
        await run(finance, 'communication.alert.resolve', event, { comment: 'Perte justifiée' }),
      ),
    ).toBe('APPLIED');
    expect(await alertRow(event)).toMatchObject({
      status: 'RESOLVED',
      resolution_kind: 'MANUAL',
      resolution_comment: 'Perte justifiée',
    });
    const state = await raise('STATE', siteA);
    expect(
      codeOf(await run(finance, 'communication.alert.resolve', state, { comment: 'Fait' })),
    ).toBe('ALERT_RESOLVE_NOT_ALLOWED');
    expect(await alertRow(state)).toMatchObject({ status: 'OPEN' });
  });

  it('écart : motif obligatoire, réservé aux alertes d’événement', async () => {
    const event = await raise('EVENT', siteA);
    expect(
      codeOf(await run(finance, 'communication.alert.dismiss', event, { reason: 'Faux positif' })),
    ).toBe('APPLIED');
    expect(await alertRow(event)).toMatchObject({
      status: 'DISMISSED',
      resolution_kind: 'DISMISSED',
    });
    const state = await raise('STATE', siteA);
    expect(
      codeOf(await run(finance, 'communication.alert.dismiss', state, { reason: 'Bruit' })),
    ).toBe('ALERT_DISMISS_NOT_ALLOWED');
    // Une alerte écartée libère la clé : l'événement suivant en crée une nouvelle.
    const dismissed = await alertRow(event);
    expect(dismissed!.open_dedup_key).toBeNull();
  });

  it('accès : hors portée ou inconnue = NOT_FOUND opaque ; le vendeur du site agit sur son site', async () => {
    const other = await raise('EVENT', siteB);
    expect(codeOf(await run(seller, 'communication.alert.acknowledge', other, {}))).toBe(
      'NOT_FOUND',
    );
    expect(codeOf(await run(seller, 'communication.alert.acknowledge', freshUuid(), {}))).toBe(
      'NOT_FOUND',
    );
    const mine = await raise('EVENT', siteA);
    expect(codeOf(await run(seller, 'communication.alert.acknowledge', mine, {}))).toBe('APPLIED');
    // Un rôle à portée propre (commercial terrain, `OWN`) n'agit pas sur une alerte qui n'est pas la sienne.
    expect(codeOf(await run(outsider, 'communication.alert.acknowledge', other, {}))).toBe(
      'NOT_FOUND',
    );
  });

  it('destinataire : sa boîte l’habilite même hors de la portée de sa permission', async () => {
    const id = await raise('EVENT', siteB);
    await tx((trx) =>
      trx
        .insertInto('communication_alert_recipients')
        .values({
          alert_id: toBin(id),
          user_id: toBin(seller.userId),
          origin: 'RULE',
          role_code: 'VENDEUR_PDV',
        })
        .execute(),
    );
    expect(codeOf(await run(seller, 'communication.alert.acknowledge', id, {}))).toBe('APPLIED');
  });

  describe('communication.alert_rule.set', () => {
    const rule = (type: string) =>
      db
        .selectFrom('communication_alert_rules')
        .selectAll()
        .where('alert_type', '=', type)
        .executeTakeFirstOrThrow();

    it('droit : Direction oui, Finance non ; en ligne seulement', async () => {
      expect(
        codeOf(
          await run(finance, 'communication.alert_rule.set', freshUuid(), {
            alertType: 'STOCK_LOW',
            enabled: true,
          }),
        ),
      ).toBe('FORBIDDEN');
      expect(
        codeOf(
          await run(
            direction,
            'communication.alert_rule.set',
            freshUuid(),
            { alertType: 'STOCK_LOW', enabled: true },
            true,
          ),
        ),
      ).toBe('ONLINE_REQUIRED');
    });

    it('modification : gravité admise, escalade, rôles ; versions et audit', async () => {
      const before = await rule('HIGH_MORTALITY');
      expect(
        codeOf(
          await run(direction, 'communication.alert_rule.set', freshUuid(), {
            alertType: 'HIGH_MORTALITY',
            escalationHours: 2,
            recipientRoles: ['RESP_PRODUCTION', 'RESP_FERME', 'DIRECTION'],
          }),
        ),
      ).toBe('APPLIED');
      const after = await rule('HIGH_MORTALITY');
      expect(after.escalation_hours).toBe(2);
      expect(after.recipient_roles).toEqual(['RESP_PRODUCTION', 'RESP_FERME', 'DIRECTION']);
      expect(after.version).toBe(before.version + 1);
      // Remise de la valeur de départ pour les autres tests.
      await run(direction, 'communication.alert_rule.set', freshUuid(), {
        alertType: 'HIGH_MORTALITY',
        escalationHours: 4,
        recipientRoles: ['RESP_PRODUCTION', 'DIRECTION'],
      });
    });

    it('refus : gravité non admise, résolution manuelle d’une alerte d’état, escalade sans gravité critique', async () => {
      expect(
        codeOf(
          await run(direction, 'communication.alert_rule.set', freshUuid(), {
            alertType: 'STOCK_LOW',
            severity: 'CRITICAL',
          }),
        ),
      ).toBe('ALERT_SEVERITY_NOT_ADMITTED');
      expect(
        codeOf(
          await run(direction, 'communication.alert_rule.set', freshUuid(), {
            alertType: 'STOCK_LOW',
            resolutionMode: 'MANUAL',
          }),
        ),
      ).toBe('ALERT_RESOLUTION_NOT_ADMITTED');
      expect(
        codeOf(
          await run(direction, 'communication.alert_rule.set', freshUuid(), {
            alertType: 'STOCK_LOW',
            escalationHours: 4,
          }),
        ),
      ).toBe('ALERT_ESCALATION_NOT_APPLICABLE');
    });
  });
});
