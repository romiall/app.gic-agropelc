/**
 * P9-06 — lectures HTTP de la communication, de bout en bout : NestJS + Fastify, `app.inject()`, alertes
 * levées par le vrai consommateur, rôles réels du seed.
 *
 * Démontre (ADR-062 §3, BR-NOT-001, BR-NOT-008, RC-04, RC-05, RC-07, RC-09) : la liste est la boîte du
 * lecteur plus sa supervision, jugée exactement ligne à ligne (`ALL`, `SITE`, `OWN`, `TEAM`) ; une alerte
 * sans site est invisible sous `SITE` ; la boîte vaut droit de lecture ; le résumé suit la liste ; la
 * valeur au coût n'est rendue qu'avec `inventory.valuation.read` et n'est jamais dans la charge utile ;
 * un détail inconnu ou hors portée est un 404 opaque audité ; filtres, curseur et paramètres invalides ;
 * notifications (non lues, canal, pagination) ; règles d'alerte réservées à `comm.alert_rule.manage`.
 * Chaque assertion porte sur les identifiants du fichier (base partagée).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Clock, IdGenerator } from '@gic/domain';
import {
  alertListResponseSchema,
  alertRuleListResponseSchema,
  alertSummarySchema,
  notificationListResponseSchema,
  type AlertItem,
} from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import type { DomainEvent } from '../src/platform/events/domain-event.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { newActor, tx, type Actor } from './cash-transfer-fixtures.js';
import { committed } from './communication-test-kit.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestSite,
  insertTestTeam,
  insertTestTeamMembership,
  insertTestUser,
  insertTestZone,
  signTestAccessToken,
} from './helpers.js';

/**
 * Dates de détection futures et propres à l'exécution : mes alertes sont les plus récentes de la base
 * partagée (liste triée par dernière détection), quel que soit le nombre d'exécutions précédentes.
 */
const RUN_BASE = Date.now() + 400 * 86_400_000;
const detectedAt = (minutes: number) => new Date(RUN_BASE + minutes * 60_000).toISOString();

let seq = 9_700_000_000;
function eventOf(
  eventType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  occurredAt: string,
): DomainEvent {
  seq += 1;
  return {
    seq,
    eventId: freshUuid(),
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

describe('P9-06 : lectures HTTP de la communication', { timeout: 180_000 }, () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let idGenerator: IdGenerator;
  const tokens = new Map<string, string>();
  let root: string;
  let finance: Actor;
  let direction: Actor;
  let admin: Actor;
  let sellerA: Actor;
  let sellerB: Actor;
  let commercial: Actor;
  let teamLead: Actor;
  let stranger: string;
  let siteA: string;
  let siteB: string;
  let siteC: string;

  /** Alertes du fichier. */
  const alerts = {
    lossA: '',
    lossB: '',
    overdueOwned: '',
    overdueStranger: '',
    global: '',
    boxed: '',
    resolved: '',
    boxedClosed: '',
  };

  const get = (actor: Actor, url: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${tokens.get(actor.userId)!}` },
    });

  const alertsOf = async (actor: Actor, query = ''): Promise<AlertItem[]> => {
    const items: AlertItem[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams(query.replace(/^\?/, ''));
      if (cursor !== null) params.set('cursor', cursor);
      const qs = params.toString();
      const response = await get(actor, `/api/v1/alerts${qs === '' ? '' : `?${qs}`}`);
      expect(response.statusCode, response.body).toBe(200);
      const body = alertListResponseSchema.parse(response.json());
      items.push(...body.items);
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    return items;
  };
  const mine = (items: readonly AlertItem[]) => {
    const wanted = new Set(Object.values(alerts));
    return items.filter((item) => wanted.has(item.id)).map((item) => item.id);
  };
  const idOfAlert = async (dedupKey: string): Promise<string> => {
    const row = await db
      .selectFrom('communication_alerts')
      .select('id')
      .where('dedup_key', '=', dedupKey)
      .executeTakeFirstOrThrow();
    const { fromBin } = await import('../src/platform/kysely/uuid-columns.js');
    return fromBin(row.id);
  };
  const raise = (event: DomainEvent) =>
    committed((uow) => handleAlertEvent(uow, event, { idGenerator }));
  const deniedAudit = (actor: Actor, entityId: string) =>
    db
      .selectFrom('audit_audit_log')
      .select(['action', 'error_code'])
      .where('actor_user_id', '=', toBin(actor.userId))
      .where('entity_id', '=', toBin(entityId))
      .where('action', '=', 'access.denied')
      .execute();

  beforeAll(async () => {
    process.env.SERVER_DATABASE_URL ??=
      'mysql://gic_app:gic_app_password@127.0.0.1:3306/gic_agropelc_test';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    clock = app.get(CLOCK);
    idGenerator = app.get(ID_GENERATOR);
    const jwtKeys = app.get(JWT_KEYS);

    root = await tx((trx) => insertTestUser(trx));
    const zone = await tx((trx) => insertTestZone(trx, root));
    await tx(async (trx) => {
      siteA = await insertTestSite(trx, root, zone);
      siteB = await insertTestSite(trx, root, zone);
      siteC = await insertTestSite(trx, root, zone);
    });
    finance = await newActor('FINANCE', root);
    direction = await newActor('DIRECTION', root);
    admin = await newActor('ADMIN', root);
    sellerA = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteA });
    sellerB = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteB });
    commercial = await newActor('COMMERCIAL_TERRAIN', root, {
      scopeType: 'ZONE',
      scopeZoneId: zone,
    });
    teamLead = await newActor('RESP_COMMERCIAL', root, { scopeType: 'ZONE', scopeZoneId: zone });
    stranger = await tx((trx) => insertTestUser(trx));
    const team = await tx((trx) => insertTestTeam(trx, teamLead.userId, root));
    await tx((trx) => insertTestTeamMembership(trx, team, commercial.userId, root));
    for (const actor of [finance, direction, admin, sellerA, sellerB, commercial, teamLead]) {
      // MP-11 (AV-282) : la garde exige une session vivante ; `signTestAccessToken` la crée puis signe.
      tokens.set(
        actor.userId,
        await signTestAccessToken(
          jwtKeys.privateKey,
          { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
          clock.now(),
        ),
      );
    }

    // Alertes réelles : perte anormale au site A et au site B (valeur au coût dans la charge utile),
    // créances échues d'un titulaire de l'équipe et d'un étranger, alerte sans site, alerte du site A
    // dans la boîte du vendeur du site B, alerte résolue.
    const loss = (site: string, minutes: number) => {
      const location = freshUuid();
      return {
        location,
        event: eventOf(
          'HighLossDetected',
          location,
          {
            location_id: location,
            business_day: '2026-12-31',
            loss_quantity: 8,
            loss_value_xaf: 120_000,
            site_id: site,
          },
          detectedAt(minutes),
        ),
      };
    };
    const lossA = loss(siteA, 10);
    const lossB = loss(siteB, 9);
    const boxedLoss = loss(siteA, 8);
    const resolvedLoss = loss(siteA, 7);
    const boxedClosedLoss = loss(siteA, 3);
    await raise(lossA.event);
    await raise(lossB.event);
    await raise(boxedLoss.event);
    await raise(resolvedLoss.event);
    await raise(boxedClosedLoss.event);
    const overdue = (owner: string, minutes: number) => {
      const sale = freshUuid();
      return {
        sale,
        event: eventOf(
          'ReceivableOverdue',
          sale,
          {
            sale_id: sale,
            doc_number: `VTE-2027-${minutes}`,
            commercial_user_id: owner,
            site_id: siteC,
            days_overdue: 11,
            balance_due_xaf: 25_000,
          },
          detectedAt(minutes),
        ),
      };
    };
    const owned = overdue(commercial.userId, 6);
    const foreign = overdue(stranger, 5);
    await raise(owned.event);
    await raise(foreign.event);
    const session = freshUuid();
    await raise(
      eventOf(
        'CashVarianceDetected',
        session,
        { session_id: session, variance_xaf: -500, severity: 'WARNING' },
        detectedAt(4),
      ),
    );

    alerts.lossA = await idOfAlert(`HIGH_LOSS:LOSS_DAY:${lossA.location}:2026-12-31`);
    alerts.lossB = await idOfAlert(`HIGH_LOSS:LOSS_DAY:${lossB.location}:2026-12-31`);
    alerts.boxed = await idOfAlert(`HIGH_LOSS:LOSS_DAY:${boxedLoss.location}:2026-12-31`);
    alerts.resolved = await idOfAlert(`HIGH_LOSS:LOSS_DAY:${resolvedLoss.location}:2026-12-31`);
    alerts.boxedClosed = await idOfAlert(
      `HIGH_LOSS:LOSS_DAY:${boxedClosedLoss.location}:2026-12-31`,
    );
    alerts.overdueOwned = await idOfAlert(`OVERDUE_RECEIVABLE:${owned.sale}`);
    alerts.overdueStranger = await idOfAlert(`OVERDUE_RECEIVABLE:${foreign.sale}`);
    alerts.global = await idOfAlert(`CASH_VARIANCE:${session}`);

    // La boîte du vendeur du site B porte une alerte du site A (hors de sa portée).
    await tx((trx) =>
      trx
        .insertInto('communication_alert_recipients')
        .values({
          alert_id: toBin(alerts.boxed),
          user_id: toBin(sellerB.userId),
          origin: 'RULE',
          role_code: 'VENDEUR_PDV',
        })
        .execute(),
    );
    await tx((trx) =>
      trx
        .insertInto('communication_alert_recipients')
        .values({
          alert_id: toBin(alerts.boxedClosed),
          user_id: toBin(sellerB.userId),
          origin: 'RULE',
          role_code: 'VENDEUR_PDV',
        })
        .execute(),
    );
    // Le vendeur du site A est aussi destinataire d'une alerte de son site, résolue ensuite : sa boîte
    // ne la contient plus, sa supervision la lit encore.
    await tx((trx) =>
      trx
        .insertInto('communication_alert_recipients')
        .values({
          alert_id: toBin(alerts.resolved),
          user_id: toBin(sellerA.userId),
          origin: 'RULE',
          role_code: 'VENDEUR_PDV',
        })
        .execute(),
    );
    // Alertes résolues : hors de la liste par défaut, présentes avec `status=RESOLVED`.
    for (const id of [alerts.resolved, alerts.boxedClosed]) {
      await tx((trx) =>
        trx
          .updateTable('communication_alerts')
          .set({
            status: 'RESOLVED',
            resolved_at: new Date(),
            resolution_kind: 'CONDITION_CLEARED',
          })
          .where('id', '=', toBin(id))
          .execute(),
      );
    }
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('401 sans jeton', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/alerts' });
    expect(response.statusCode).toBe(401);
  });

  it('portée ALL (Finance, Direction) : toutes les alertes ouvertes, sans la résolue', async () => {
    for (const actor of [finance, direction]) {
      const ids = mine(await alertsOf(actor));
      expect(ids.sort()).toEqual(
        [
          alerts.lossA,
          alerts.lossB,
          alerts.overdueOwned,
          alerts.overdueStranger,
          alerts.global,
          alerts.boxed,
        ].sort(),
      );
    }
    const resolved = mine(await alertsOf(finance, '?status=RESOLVED'));
    expect(resolved.sort()).toEqual([alerts.resolved, alerts.boxedClosed].sort());
  });

  it('portée SITE : le site du vendeur, jamais un autre site ni une alerte sans site', async () => {
    const visibleA = mine(await alertsOf(sellerA));
    expect(visibleA.sort()).toEqual([alerts.lossA, alerts.boxed].sort());
    expect(visibleA).not.toContain(alerts.global);
    expect(visibleA).not.toContain(alerts.lossB);

    // Le vendeur du site B : son site, plus l'alerte du site A qui est dans sa boîte.
    const itemsB = await alertsOf(sellerB);
    expect(mine(itemsB).sort()).toEqual([alerts.lossB, alerts.boxed].sort());
    const boxed = itemsB.find((item) => item.id === alerts.boxed)!;
    expect(boxed.visibility).toEqual(['RECIPIENT']);
    const own = itemsB.find((item) => item.id === alerts.lossB)!;
    expect(own.visibility).toEqual(['SUPERVISION']);
  });

  it('portées OWN et TEAM : le titulaire, ou les membres de l’équipe dirigée', async () => {
    expect(mine(await alertsOf(commercial))).toEqual([alerts.overdueOwned]);
    const lead = mine(await alertsOf(teamLead));
    expect(lead).toEqual([alerts.overdueOwned]);
    expect(lead).not.toContain(alerts.overdueStranger);
  });

  it('valeur au coût : rendue avec inventory.valuation.read, jamais dans la charge utile', async () => {
    const seen = (await alertsOf(finance)).find((item) => item.id === alerts.lossA)!;
    expect(seen.message).toMatch(/Valeur perdue : 120\s000 XAF/);
    expect(seen.payload).not.toHaveProperty('loss_value_xaf');
    expect(seen.payload).toHaveProperty('loss_quantity');
    // L'objet du sujet composite reste identifiable (écran d'action) : identifiant, jamais une valeur au coût.
    expect(typeof seen.payload['location_id']).toBe('string');

    const masked = (await alertsOf(sellerA)).find((item) => item.id === alerts.lossA)!;
    expect(masked.message).not.toMatch(/120\s?000/);
    expect(masked.message).not.toContain('Valeur');
    expect(masked.payload).not.toHaveProperty('loss_value_xaf');
    // L'alerte elle-même ne conserve jamais la valeur dans son message stocké.
    const stored = await db
      .selectFrom('communication_alerts')
      .select('message')
      .where('id', '=', toBin(alerts.lossA))
      .executeTakeFirstOrThrow();
    expect(stored.message).not.toMatch(/120\s?000/);
  });

  it('filtres : type, gravité, site, boîte seule ; paramètres invalides = 400', async () => {
    const byType = mine(await alertsOf(finance, '?type=OVERDUE_RECEIVABLE'));
    expect(byType.sort()).toEqual([alerts.overdueOwned, alerts.overdueStranger].sort());
    const bySite = mine(await alertsOf(finance, `?site_id=${siteB}`));
    expect(bySite).toEqual([alerts.lossB]);
    const critical = mine(await alertsOf(finance, '?severity=CRITICAL'));
    expect(critical).toContain(alerts.lossA);
    expect(critical).not.toContain(alerts.overdueOwned);
    expect(mine(await alertsOf(sellerB, '?box=true'))).toEqual([alerts.boxed]);

    for (const bad of ['?type=INCONNU', '?status=OPEN,NOPE', '?limit=0', '?site_id=pas-un-uuid']) {
      const response = await get(finance, `/api/v1/alerts${bad}`);
      expect(response.statusCode, bad).toBe(400);
      expect(response.json().error.code ?? response.json().code).toBe('VALIDATION_ERROR');
    }
    const badCursor = await get(finance, '/api/v1/alerts?cursor=nimporte-quoi');
    expect(badCursor.statusCode).toBe(400);
  });

  it('pagination par curseur : une alerte à la fois, sans doublon ni perte', async () => {
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 40; page += 1) {
      const response = await get(
        finance,
        `/api/v1/alerts?limit=1&type=HIGH_LOSS,OVERDUE_RECEIVABLE,CASH_VARIANCE${
          cursor === null ? '' : `&cursor=${cursor}`
        }`,
      );
      expect(response.statusCode).toBe(200);
      const body = alertListResponseSchema.parse(response.json());
      expect(body.items.length).toBeLessThanOrEqual(1);
      collected.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      if (collected.filter((id) => Object.values(alerts).includes(id)).length >= 6) break;
      if (cursor === null) break;
    }
    expect(new Set(collected).size).toBe(collected.length);
    for (const id of [
      alerts.lossA,
      alerts.lossB,
      alerts.overdueOwned,
      alerts.overdueStranger,
      alerts.global,
      alerts.boxed,
    ]) {
      expect(collected).toContain(id);
    }
  });

  it('détail : visible par la portée ou la boîte ; hors des deux, 404 opaque audité', async () => {
    const ok = await get(sellerA, `/api/v1/alerts/${alerts.lossA}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: alerts.lossA, alertType: 'HIGH_LOSS' });

    // Hors portée (autre site) : 404, jamais 403 ; l'existence n'est pas révélée.
    const outside = await get(sellerA, `/api/v1/alerts/${alerts.lossB}`);
    expect(outside.statusCode).toBe(404);
    const unknown = freshUuid();
    const missing = await get(sellerA, `/api/v1/alerts/${unknown}`);
    expect(missing.statusCode).toBe(404);
    expect(outside.json().error?.code ?? outside.json().code).toBe('NOT_FOUND');
    expect((await deniedAudit(sellerA, alerts.lossB)).length).toBeGreaterThanOrEqual(1);
    expect((await deniedAudit(sellerA, unknown)).length).toBeGreaterThanOrEqual(1);

    // Dans la boîte : lisible malgré une portée qui ne couvre pas le site.
    const boxed = await get(sellerB, `/api/v1/alerts/${alerts.boxed}`);
    expect(boxed.statusCode).toBe(200);
    expect(boxed.json().visibility).toEqual(['RECIPIENT']);
    const invalid = await get(sellerA, '/api/v1/alerts/pas-un-uuid');
    expect(invalid.statusCode).toBe(400);
  });

  it('résumé : compteurs de l’étendue du lecteur, égaux à sa liste ouverte', async () => {
    const sellerSummary = await get(sellerA, '/api/v1/alerts/summary');
    expect(sellerSummary.statusCode).toBe(200);
    const summary = alertSummarySchema.parse(sellerSummary.json());
    const list = await alertsOf(sellerA);
    expect(summary.truncated).toBe(false);
    expect(summary.open + summary.acknowledged).toBe(list.length);
    const bySeverity = { INFO: 0, WARNING: 0, CRITICAL: 0 };
    for (const item of list) bySeverity[item.severity] += 1;
    expect(summary.bySeverity).toEqual(bySeverity);

    // En portée ALL : comptage exact, au moins mes alertes ouvertes.
    const all = alertSummarySchema.parse((await get(finance, '/api/v1/alerts/summary')).json());
    expect(all.open + all.acknowledged).toBeGreaterThanOrEqual(6);
    expect(all.truncated).toBe(false);

    // Le propriétaire (OWN) ne compte que la sienne ; la prise en compte déplace le compteur.
    const owner = alertSummarySchema.parse(
      (await get(commercial, '/api/v1/alerts/summary')).json(),
    );
    expect(owner.open + owner.acknowledged).toBe(1);
  });

  it('notifications : celles du lecteur, non lues, canal, pagination, compteur exact', async () => {
    const base = Date.UTC(2027, 0, 1, 8, 0, 0);
    const insert = (
      userId: string,
      minutes: number,
      read: boolean,
      channel = 'IN_APP',
      source?: { readonly type: string; readonly id: string },
    ) =>
      tx(async (trx) => {
        const id = freshUuid();
        await trx
          .insertInto('communication_notifications')
          .values({
            id: toBin(id),
            user_id: toBin(userId),
            channel,
            kind: 'DIRECT',
            source_type: source?.type ?? null,
            source_id: source === undefined ? null : toBin(source.id),
            title: `Notification ${minutes}`,
            body: 'Corps',
            created_at: new Date(base + minutes * 60_000),
            delivered_at: new Date(base + minutes * 60_000),
            read_at: read ? new Date(base + minutes * 60_000 + 1000) : null,
          })
          .execute();
        return id;
      });
    const first = await insert(sellerA.userId, 1, true);
    const sourceId = freshUuid();
    const second = await insert(sellerA.userId, 2, false, 'IN_APP', {
      type: 'APPROVAL_REQUEST',
      id: sourceId,
    });
    const third = await insert(sellerA.userId, 3, false);
    await insert(sellerA.userId, 4, false, 'WEB_PUSH');
    const foreign = await insert(sellerB.userId, 2, false);

    const response = await get(sellerA, '/api/v1/notifications');
    expect(response.statusCode).toBe(200);
    const body = notificationListResponseSchema.parse(response.json());
    expect(body.items.map((item) => item.id).slice(0, 3)).toEqual([third, second, first]);
    expect(body.items.map((item) => item.id)).not.toContain(foreign);
    expect(body.unreadCount).toBe(2);
    // Nature et objet source d'une notification directe : de quoi ouvrir l'écran concerné.
    const byId = new Map(body.items.map((item) => [item.id, item]));
    expect(byId.get(second)).toMatchObject({
      kind: 'DIRECT',
      sourceType: 'APPROVAL_REQUEST',
      sourceId,
    });
    expect(byId.get(third)).toMatchObject({ kind: 'DIRECT', sourceType: null, sourceId: null });

    const unread = notificationListResponseSchema.parse(
      (await get(sellerA, '/api/v1/notifications?unread=true')).json(),
    );
    expect(unread.items.map((item) => item.id)).toEqual([third, second]);

    const paged = notificationListResponseSchema.parse(
      (await get(sellerA, '/api/v1/notifications?limit=1')).json(),
    );
    expect(paged.items.map((item) => item.id)).toEqual([third]);
    expect(paged.nextCursor).not.toBeNull();
    const next = notificationListResponseSchema.parse(
      (await get(sellerA, `/api/v1/notifications?limit=1&cursor=${paged.nextCursor}`)).json(),
    );
    expect(next.items.map((item) => item.id)).toEqual([second]);

    const push = notificationListResponseSchema.parse(
      (await get(sellerA, '/api/v1/notifications?channel=WEB_PUSH')).json(),
    );
    expect(push.items).toHaveLength(1);
    expect((await get(sellerA, '/api/v1/notifications?cursor=xx')).statusCode).toBe(400);
  });

  it('la boîte vaut droit de lecture pour la durée d’ouverture seulement ; une alerte close se lit par la supervision', async () => {
    // Le vendeur du site B (hors portée du site A) était destinataire de `boxedClosed` ; elle est résolue.
    const closedForB = mine(await alertsOf(sellerB, '?status=RESOLVED'));
    expect(closedForB).toEqual([]);
    expect((await get(sellerB, `/api/v1/alerts/${alerts.boxedClosed}`)).statusCode).toBe(404);
    expect(mine(await alertsOf(sellerB, '?status=RESOLVED&box=true'))).toEqual([]);
    // « Boîte seule » ne rend jamais une alerte close, même pour un destinataire qui la supervise.
    expect(mine(await alertsOf(sellerA, '?status=RESOLVED&box=true'))).toEqual([]);
    // La supervision du site A, elle, la lit encore (portée de l'alerte).
    expect(mine(await alertsOf(sellerA, '?status=RESOLVED')).sort()).toEqual(
      [alerts.resolved, alerts.boxedClosed].sort(),
    );
    const read = await get(sellerA, `/api/v1/alerts/${alerts.boxedClosed}`);
    expect(read.statusCode).toBe(200);
    expect(read.json().visibility).toEqual(['SUPERVISION']);
  });

  it('fin de page exacte : un curseur nul quand la dernière ligne vient d’être rendue', async () => {
    const response = await get(finance, `/api/v1/alerts?site_id=${siteB}&limit=1`);
    expect(response.statusCode).toBe(200);
    const body = alertListResponseSchema.parse(response.json());
    expect(body.items.map((item) => item.id)).toEqual([alerts.lossB]);
    expect(body.nextCursor).toBeNull();
  });

  it('une notification d’alerte est rendue au droit courant du lecteur, pas à celui de sa création', async () => {
    const base = Date.UTC(2027, 1, 1, 8, 0, 0);
    const insert = (userId: string, minutes: number) =>
      tx(async (trx) => {
        const id = freshUuid();
        await trx
          .insertInto('communication_notifications')
          .values({
            id: toBin(id),
            user_id: toBin(userId),
            channel: 'IN_APP',
            kind: 'ALERT',
            alert_id: toBin(alerts.lossA),
            alert_type: 'HIGH_LOSS',
            source_type: 'ALERT',
            title: 'Perte anormale',
            // Texte figé à la création, valeur au coût comprise : il ne doit pas être resservi tel quel.
            body: 'Valeur perdue : 999 XAF',
            created_at: new Date(base + minutes * 60_000),
            delivered_at: new Date(base + minutes * 60_000),
          })
          .execute();
        return id;
      });
    const forSeller = await insert(sellerA.userId, 1);
    const forFinance = await insert(finance.userId, 2);
    const seller = notificationListResponseSchema.parse(
      (await get(sellerA, '/api/v1/notifications')).json(),
    );
    const sellerBody = seller.items.find((item) => item.id === forSeller)!.body;
    expect(sellerBody).not.toMatch(/XAF/);
    expect(sellerBody).not.toContain('Valeur');
    const fin = notificationListResponseSchema.parse(
      (await get(finance, '/api/v1/notifications')).json(),
    );
    expect(fin.items.find((item) => item.id === forFinance)!.body).toMatch(
      /Valeur perdue : 120\s000 XAF/,
    );
  });

  it('règles d’alerte : réservées à comm.alert_rule.manage (Direction, Administrateur)', async () => {
    for (const actor of [direction, admin]) {
      const response = await get(actor, '/api/v1/alert-rules');
      expect(response.statusCode).toBe(200);
      const body = alertRuleListResponseSchema.parse(response.json());
      expect(body.items).toHaveLength(36);
      const stockLow = body.items.find((item) => item.alertType === 'STOCK_LOW')!;
      expect(stockLow).toMatchObject({
        nature: 'STATE',
        escalationApplicable: false,
        resolutionModesAdmitted: ['AUTO'],
      });
      const highLoss = body.items.find((item) => item.alertType === 'HIGH_LOSS')!;
      expect(highLoss).toMatchObject({ escalationApplicable: true, escalationHours: 4 });
      expect(highLoss.severitiesAdmitted).toContain('CRITICAL');
    }
    const refused = await get(finance, '/api/v1/alert-rules');
    expect(refused.statusCode).toBe(403);
    const refusedSeller = await get(sellerA, '/api/v1/alert-rules');
    expect(refusedSeller.statusCode).toBe(403);
  });
});
