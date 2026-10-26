/**
 * P9-05 : commandes de notification et d'abonnement Web Push (D13 §4, UC-NOT-04 et 07 ; ADR-072 §4, §5) —
 * `communication.notification.read` (hors ligne possible, jamais sur les notifications d'un autre),
 * `communication.push.subscribe` (lié à l'appareil authentifié, point de terminaison repris par la session
 * courante) et `communication.push.unsubscribe`. Passage par le vrai pipeline de commandes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerNotificationCommands } from '../src/modules/communication/application/commands/notification-commands.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { codeOf, newActor, runCommand, tx, type Actor } from './cash-transfer-fixtures.js';
import { closeTestDb, db, freshUuid, insertTestUser } from './helpers.js';

const AT = '2026-11-02T10:00:00.000Z';
let pipeline: CommandPipelineService;
let root: string;
let alice: Actor;
let bob: Actor;

const run = (
  actor: Actor,
  type: string,
  payload: unknown,
  offline = false,
  at = AT,
  aggregateId = freshUuid(),
) =>
  runCommand(pipeline, actor, {
    type,
    aggregateType: type.includes('push') ? 'PUSH_SUBSCRIPTION' : 'NOTIFICATION',
    aggregateId,
    occurredAt: at,
    payload,
    offline,
  });

async function notification(userId: string, createdAt = new Date('2026-11-02T09:00:00.000Z')) {
  const id = freshUuid();
  await db
    .insertInto('communication_notifications')
    .values({
      id: toBin(id),
      user_id: toBin(userId),
      channel: 'IN_APP',
      kind: 'DIRECT',
      title: 'Test',
      body: 'Corps',
      created_at: createdAt,
      delivered_at: createdAt,
    })
    .execute();
  return id;
}

const readAt = async (id: string) =>
  (
    await db
      .selectFrom('communication_notifications')
      .select('read_at')
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow()
  ).read_at;

const subscriptionOf = (endpoint: string) =>
  db
    .selectFrom('communication_push_subscriptions')
    .selectAll()
    .where('endpoint', '=', endpoint)
    .executeTakeFirst();

const keys = { p256dh: 'BPublicKeyForTests', auth: 'secretAuth' };

beforeAll(async () => {
  const clock = new FixedClock(new Date(AT));
  const registry = new CommandHandlerRegistry();
  registerNotificationCommands(registry, new Uuidv7Generator(clock));
  pipeline = new CommandPipelineService(db, registry, clock, new Uuidv7Generator(clock));
  root = await tx((trx) => insertTestUser(trx));
  alice = await newActor('FINANCE', root);
  bob = await newActor('MAGASINIER', root, {
    scopeType: 'SITE',
    scopeSiteId: await tx(async (trx) => {
      const helpers = await import('./helpers.js');
      const zone = await helpers.insertTestZone(trx, root);
      return helpers.insertTestSite(trx, root, zone);
    }),
  });
});
afterAll(closeTestDb);

describe('P9-05 : communication.notification.read', () => {
  it('marque les notifications données ; celles d’un autre ne bougent pas ; rejouer est sans effet', async () => {
    const mine = await notification(alice.userId);
    const mine2 = await notification(alice.userId);
    const theirs = await notification(bob.userId);

    expect(
      codeOf(
        await run(alice, 'communication.notification.read', { notificationIds: [mine, theirs] }),
      ),
    ).toBe('APPLIED');
    expect((await readAt(mine))?.toISOString()).toBe(AT);
    expect(await readAt(mine2)).toBeNull();
    expect(await readAt(theirs)).toBeNull(); // la notification d'un autre n'est pas touchée

    // Rejouer (autre commande, mêmes identifiants) : la date de lecture d'origine est conservée.
    await run(
      alice,
      'communication.notification.read',
      { notificationIds: [mine] },
      false,
      '2026-11-02T11:00:00.000Z',
    );
    expect((await readAt(mine))?.toISOString()).toBe(AT);
  });

  it('« toutes » marque toutes les non lues de l’auteur, hors ligne aussi', async () => {
    const a = await notification(bob.userId);
    const b = await notification(bob.userId);
    const result = await run(bob, 'communication.notification.read', { all: true }, true);
    expect(codeOf(result)).toBe('APPLIED');
    expect(await readAt(a)).not.toBeNull();
    expect(await readAt(b)).not.toBeNull();
  });

  it('« toutes » hors ligne : seulement celles créées avant l’instant du geste', async () => {
    const before = await notification(alice.userId, new Date('2026-11-02T09:00:00.000Z'));
    const after = await notification(alice.userId, new Date('2026-11-02T11:00:00.000Z'));
    await run(
      alice,
      'communication.notification.read',
      { all: true },
      true,
      '2026-11-02T10:00:00.000Z',
    );
    expect(await readAt(before)).not.toBeNull();
    expect(await readAt(after)).toBeNull();
  });

  it('une lecture n’est jamais antérieure à la création de la notification', async () => {
    const created = new Date('2026-11-02T09:30:00.000Z');
    const id = await notification(alice.userId, created);
    await run(
      alice,
      'communication.notification.read',
      { notificationIds: [id] },
      true,
      '2026-11-02T08:00:00.000Z',
    );
    expect((await readAt(id))?.toISOString()).toBe(created.toISOString());
  });

  it('charge utile invalide : des identifiants et « toutes » ensemble, ou rien', async () => {
    expect(
      codeOf(
        await run(alice, 'communication.notification.read', {
          notificationIds: [freshUuid()],
          all: true,
        }),
      ),
    ).toMatch(/^VALIDATION_ERROR/);
    expect(codeOf(await run(alice, 'communication.notification.read', {}))).toMatch(
      /^VALIDATION_ERROR/,
    );
  });
});

describe('P9-05 : abonnements Web Push', () => {
  it('abonne l’appareil authentifié ; le même abonnement n’y change rien', async () => {
    const endpoint = `https://push.test/${freshUuid()}`;
    expect(codeOf(await run(alice, 'communication.push.subscribe', { endpoint, keys }))).toBe(
      'APPLIED',
    );
    const first = await subscriptionOf(endpoint);
    expect(first).toBeDefined();
    expect(first!.user_id.equals(toBin(alice.userId))).toBe(true);
    expect(first!.device_id.equals(toBin(alice.deviceId))).toBe(true);
    expect(first!.revoked_at).toBeNull();

    await run(alice, 'communication.push.subscribe', { endpoint, keys });
    const again = await subscriptionOf(endpoint);
    expect(again!.id.equals(first!.id)).toBe(true);
  });

  it('un point de terminaison déjà connu est repris par la session courante', async () => {
    const endpoint = `https://push.test/${freshUuid()}`;
    await run(alice, 'communication.push.subscribe', { endpoint, keys });
    await run(bob, 'communication.push.subscribe', {
      endpoint,
      keys: { p256dh: 'BOtherKey', auth: 'otherAuth' },
    });
    const row = await subscriptionOf(endpoint);
    expect(row!.user_id.equals(toBin(bob.userId))).toBe(true);
    expect(row!.device_id.equals(toBin(bob.deviceId))).toBe(true);
    expect(row!.p256dh).toBe('BOtherKey');
    expect(row!.revoked_at).toBeNull();
  });

  it('se désabonner : seul le titulaire révoque ; réabonner recrée une ligne active', async () => {
    const endpoint = `https://push.test/${freshUuid()}`;
    await run(alice, 'communication.push.subscribe', { endpoint, keys });

    // Un autre utilisateur ne révoque pas l'abonnement d'autrui, sans le savoir.
    expect(codeOf(await run(bob, 'communication.push.unsubscribe', { endpoint }))).toBe('APPLIED');
    expect((await subscriptionOf(endpoint))!.revoked_at).toBeNull();

    expect(codeOf(await run(alice, 'communication.push.unsubscribe', { endpoint }))).toBe(
      'APPLIED',
    );
    const revoked = await subscriptionOf(endpoint);
    expect(revoked!.revoked_at?.toISOString()).toBe(AT);

    // Rejouer le désabonnement ne change rien ; se réabonner remplace la ligne révoquée.
    await run(alice, 'communication.push.unsubscribe', { endpoint });
    await run(alice, 'communication.push.subscribe', { endpoint, keys });
    const renewed = await subscriptionOf(endpoint);
    expect(renewed!.revoked_at).toBeNull();
    expect(renewed!.id.equals(revoked!.id)).toBe(false);
  });

  it('mêmes appareil et utilisateur mais clés renouvelées : la ligne est remplacée', async () => {
    const endpoint = `https://push.test/${freshUuid()}`;
    await run(alice, 'communication.push.subscribe', { endpoint, keys });
    const first = await subscriptionOf(endpoint);
    await run(alice, 'communication.push.subscribe', {
      endpoint,
      keys: { p256dh: 'BRotatedKey', auth: 'rotatedAuth' },
    });
    const second = await subscriptionOf(endpoint);
    expect(second!.id.equals(first!.id)).toBe(false);
    expect(second!.p256dh).toBe('BRotatedKey');
    expect(second!.revoked_at).toBeNull();
  });

  it('l’identifiant d’agrégat déjà pris par un autre abonnement : un nouvel identifiant est attribué', async () => {
    const taken = freshUuid();
    const first = `https://push.test/${freshUuid()}`;
    const second = `https://push.test/${freshUuid()}`;
    await run(alice, 'communication.push.subscribe', { endpoint: first, keys }, false, AT, taken);
    expect(
      codeOf(
        await run(
          alice,
          'communication.push.subscribe',
          { endpoint: second, keys },
          false,
          AT,
          taken,
        ),
      ),
    ).toBe('APPLIED');
    const rowOne = await subscriptionOf(first);
    const rowTwo = await subscriptionOf(second);
    expect(rowOne!.id.equals(toBin(taken))).toBe(true);
    expect(rowTwo).toBeDefined();
    expect(rowTwo!.id.equals(toBin(taken))).toBe(false);
  });

  it('deux sessions abonnent le même point de terminaison en même temps : une seule ligne, aucun échec', async () => {
    const endpoint = `https://push.test/${freshUuid()}`;
    const [a, b] = await Promise.all([
      run(alice, 'communication.push.subscribe', { endpoint, keys }),
      run(bob, 'communication.push.subscribe', { endpoint, keys }),
    ]);
    expect(codeOf(a)).toBe('APPLIED');
    expect(codeOf(b)).toBe('APPLIED');
    const rows = await db
      .selectFrom('communication_push_subscriptions')
      .select('id')
      .where('endpoint', '=', endpoint)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('point de terminaison invalide ou clés absentes : rejeté par le schéma', async () => {
    expect(
      codeOf(await run(alice, 'communication.push.subscribe', { endpoint: 'pas-une-url', keys })),
    ).toMatch(/^VALIDATION_ERROR/);
    expect(
      codeOf(
        await run(alice, 'communication.push.subscribe', {
          endpoint: `https://push.test/${freshUuid()}`,
        }),
      ),
    ).toMatch(/^VALIDATION_ERROR/);
  });
});
