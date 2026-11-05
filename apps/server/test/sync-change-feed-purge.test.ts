/**
 * AV-520 (BR-SYN-015) : compaction du flux de changements `sync_change_feed` — seules les lignes **remplacées** par
 * une ligne plus récente de la même clé (jeu, type d'entité, entité, portée) et de plus de `before` sont supprimées ;
 * la dernière ligne de chaque entité reste toujours (un chargement initial lit le flux depuis le curseur 0).
 *
 * Base partagée et persistante : chaque essai écrit dans un jeu propre (`tfp_<aléa>`), jamais lu par un autre essai,
 * avec des dates de 2001 très antérieures à toute ligne réelle (la coupure de 2002 ne peut donc toucher que ces
 * lignes), et les efface en fin de fichier. Les écritures sont validées (`committed`) : une transaction annulée
 * brûlerait des numéros de séquence du flux, que le tirage des autres essais attendrait pendant sa fenêtre de
 * stabilisation. Prérequis : `gic_app` a `DELETE` sur le flux (migration d'origine, P0-09).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { purgeSupersededChangeFeed } from '../src/platform/sync/change-feed-purge.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { committed } from './communication-test-kit.js';
import { closeTestDb, db, freshUuid } from './helpers.js';

const BEFORE = new Date('2002-01-01T00:00:00.000Z');
const OLD = (month: number) => new Date(`2001-${String(month).padStart(2, '0')}-10T08:00:00.000Z`);
const RECENT = new Date('2030-01-01T00:00:00.000Z');

afterAll(async () => {
  await db.deleteFrom('sync_change_feed').where('dataset', 'like', 'tfp\\_%').execute();
  await closeTestDb();
});

type ChangeType = 'UPSERT' | 'DELETE' | 'SCOPE_EXIT';

async function row(input: {
  readonly dataset: string;
  readonly entityId: string;
  readonly at: Date;
  readonly type?: ChangeType;
  readonly scopeType?: 'GLOBAL' | 'SITE';
  readonly scopeId?: string | null;
  readonly entityType?: string;
}): Promise<number> {
  const result = await db
    .insertInto('sync_change_feed')
    .values({
      dataset: input.dataset,
      entity_type: input.entityType ?? 'TEST_ENTITY',
      entity_id: toBin(input.entityId),
      change_type: input.type ?? 'UPSERT',
      scope_type: input.scopeType ?? 'GLOBAL',
      scope_id: input.scopeId === undefined || input.scopeId === null ? null : toBin(input.scopeId),
      row_version: 1,
      recorded_at: input.at,
    })
    .executeTakeFirstOrThrow();
  return Number(result.insertId);
}

const remaining = async (dataset: string): Promise<number[]> =>
  (
    await db
      .selectFrom('sync_change_feed')
      .select('seq')
      .where('dataset', '=', dataset)
      .orderBy('seq')
      .execute()
  ).map((r) => Number(r.seq));

const dataset = () => `tfp_${freshUuid().slice(-12)}`;
const purge = (before = BEFORE, options: { batch?: number; maxBatches?: number } = {}) =>
  committed((uow) => purgeSupersededChangeFeed(uow, { before, ...options }));

describe('Compaction du flux de changements (BR-SYN-015, AV-520)', () => {
  it('supprime les lignes anciennes remplacées, garde la dernière ligne de chaque entité', async () => {
    const ds = dataset();
    const e1 = freshUuid();
    const e2 = freshUuid();
    const e3 = freshUuid();
    const a1 = await row({ dataset: ds, entityId: e1, at: OLD(1) });
    const a2 = await row({ dataset: ds, entityId: e1, at: OLD(2) });
    const a3 = await row({ dataset: ds, entityId: e1, at: OLD(3) });
    // Entité qui n'a plus changé depuis plus de 60 jours : sa seule ligne reste (chargement initial).
    const b1 = await row({ dataset: ds, entityId: e2, at: OLD(1) });
    // Ancienne ligne remplacée par une ligne récente : supprimée, la récente reste.
    const c1 = await row({ dataset: ds, entityId: e3, at: OLD(1) });
    const c2 = await row({ dataset: ds, entityId: e3, at: RECENT });
    expect(await remaining(ds)).toEqual([a1, a2, a3, b1, c1, c2]);

    const outcome = await purge();
    expect(outcome).toEqual({ deleted: 3, truncated: false });
    expect(await remaining(ds)).toEqual([a3, b1, c2]);
    // Rejouable : plus rien à supprimer.
    expect(await purge()).toEqual({ deleted: 0, truncated: false });
  });

  it('une portée différente est une autre clé ; la sortie de portée la plus récente reste', async () => {
    const ds = dataset();
    const entity = freshUuid();
    const siteA = freshUuid();
    const siteB = freshUuid();
    // Même entité, deux sites : chacun garde sa dernière ligne.
    const a1 = await row({
      dataset: ds,
      entityId: entity,
      at: OLD(1),
      scopeType: 'SITE',
      scopeId: siteA,
    });
    const b1 = await row({
      dataset: ds,
      entityId: entity,
      at: OLD(1),
      scopeType: 'SITE',
      scopeId: siteB,
    });
    // Site A : l'entité part (SCOPE_EXIT), l'ancienne ligne d'entrée est remplacée, la sortie reste.
    const a2 = await row({
      dataset: ds,
      entityId: entity,
      at: OLD(2),
      type: 'SCOPE_EXIT',
      scopeType: 'SITE',
      scopeId: siteA,
    });
    // Portée globale (scope_id nul) : comparée avec l'égalité nulle-sûre.
    const g1 = await row({ dataset: ds, entityId: entity, at: OLD(1) });
    const g2 = await row({ dataset: ds, entityId: entity, at: OLD(2), type: 'DELETE' });
    await purge();
    // Ne restent que b1 (dernière ligne du site B), a2 (sortie du site A) et g2 (suppression globale) : a1 et g1,
    // remplacées dans leur propre portée, sont supprimées.
    expect(await remaining(ds)).toEqual([b1, a2, g2]);
    expect(a1).toBeLessThan(a2);
    expect(g1).toBeLessThan(g2);
  });

  it('le type d’entité fait partie de la clé ; une ligne d’âge exact la coupure est conservée', async () => {
    const ds = dataset();
    const entity = freshUuid();
    const t1 = await row({ dataset: ds, entityId: entity, at: OLD(1), entityType: 'TYPE_A' });
    const t2 = await row({ dataset: ds, entityId: entity, at: OLD(2), entityType: 'TYPE_B' });
    // Remplacée, mais exactement à la coupure : conservée (comparaison stricte).
    const exact = await row({ dataset: ds, entityId: entity, at: BEFORE, entityType: 'TYPE_A' });
    const last = await row({ dataset: ds, entityId: entity, at: RECENT, entityType: 'TYPE_A' });
    await purge();
    expect(await remaining(ds)).toEqual([t2, exact, last]);
    expect(t1).toBeLessThan(t2);
  });

  it('plafond de lots : le reste est repris à l’exécution suivante', async () => {
    const ds = dataset();
    const entity = freshUuid();
    const seqs: number[] = [];
    for (let month = 1; month <= 5; month += 1) {
      seqs.push(await row({ dataset: ds, entityId: entity, at: OLD(month) }));
    }
    // Quatre lignes remplacées, une dernière : deux lots de 2 au plus.
    const first = await purge(BEFORE, { batch: 2, maxBatches: 1 });
    expect(first).toEqual({ deleted: 2, truncated: true });
    const second = await purge(BEFORE, { batch: 2, maxBatches: 5 });
    expect(second.deleted).toBe(2);
    expect(await remaining(ds)).toEqual([seqs[4]]);
  });
});
