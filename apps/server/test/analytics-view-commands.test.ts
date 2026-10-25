/**
 * P9-19 — vues sauvegardées (ADR-077 §1 et §2 ; BR-ANA-007 ; AV-432, AV-435, AV-496 ; AT-046) : les commandes
 * `analytics.view.save`, `.share`, `.set_default` et `.delete` par le vrai pipeline de commande (droits, audit),
 * puis la lecture avec exécutabilité (`listReadableViews`). Acteurs à rôle d'essai sur la base partagée.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANALYTICS_CATALOG_VERSION } from '@gic/domain';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  listReadableViews,
  readReadableView,
} from '../src/modules/analytics/application/public/index.js';
import {
  AnalyticsCommandHarness,
  NOW,
  actorWith,
  salesDefinition,
  type CommandActor,
} from './analytics-command-fixtures.js';
import { closeTestDb, db, freshUuid, insertTestUser } from './helpers.js';

const SAVE = 'analytics.view.save';
const SHARE = 'analytics.view.share';
const SET_DEFAULT = 'analytics.view.set_default';
const DELETE = 'analytics.view.delete';

describe('P9-19 : vues sauvegardées', () => {
  const harness = new AnalyticsCommandHarness();
  let owner: CommandActor & { roleCode: string };
  let stranger: CommandActor & { roleCode: string };
  let reader: CommandActor & { roleCode: string };
  let blind: CommandActor & { roleCode: string };
  let targetRole: string;

  const save = (actor: CommandActor, viewId: string, payload: Record<string, unknown>, o = {}) =>
    harness.run(actor, SAVE, 'SAVED_VIEW', viewId, payload, o);
  const content = (name: string, definition = salesDefinition()) => ({
    name,
    definition,
    catalogVersion: ANALYTICS_CATALOG_VERSION,
  });
  const rowOf = (viewId: string) =>
    db
      .selectFrom('analytics_saved_views')
      .selectAll()
      .where('id', '=', toBin(viewId))
      .executeTakeFirst();
  const uniqueName = (label: string) => `${label} ${freshUuid().slice(-12)}`;

  beforeAll(async () => {
    const admin = await db.transaction().execute((trx) => insertTestUser(trx));
    owner = await actorWith(admin, [
      'analytics.explore',
      'analytics.view.share',
      'sales.sale.read',
    ]);
    stranger = await actorWith(admin, ['analytics.explore', 'sales.sale.read']);
    reader = await actorWith(admin, ['analytics.explore', 'sales.sale.read']);
    blind = await actorWith(admin, ['analytics.explore']);
    targetRole = reader.roleCode;
  });
  afterAll(closeTestDb);

  describe('enregistrer', () => {
    it('crée la vue du propriétaire (dataset, définition, version du catalogue) et l’audite', async () => {
      const viewId = freshUuid();
      const name = uniqueName('Ventes du mois');
      const result = await save(owner, viewId, content(name));
      expect(result.status).toBe('APPLIED');
      const row = await rowOf(viewId);
      expect(row).toMatchObject({
        name,
        dataset: 'f_sales_line',
        catalog_version: ANALYTICS_CATALOG_VERSION,
        is_default_for_role: null,
        version: 1,
      });
      expect(fromBin(row!.owner_user_id)).toBe(owner.id);
      expect(row!.shared_with_roles).toEqual([]);
      const audit = await db
        .selectFrom('audit_audit_log')
        .select(['action', 'entity_type', 'result'])
        .where('entity_id', '=', toBin(viewId))
        .where('action', '=', SAVE)
        .execute();
      expect(audit).toEqual([{ action: SAVE, entity_type: 'SAVED_VIEW', result: 'SUCCESS' }]);
    });

    it('la mise à jour garde l’identifiant, change le contenu et monte la version', async () => {
      const viewId = freshUuid();
      const name = uniqueName('À mettre à jour');
      await save(owner, viewId, content(name));
      const renamed = uniqueName('Renommée');
      const result = await save(
        owner,
        viewId,
        content(renamed, salesDefinition({ measures: ['revenue', 'quantity'] })),
      );
      expect(result.status).toBe('APPLIED');
      const row = await rowOf(viewId);
      expect(row).toMatchObject({ name: renamed, version: 2 });
      expect((row!.definition as { measures: string[] }).measures).toEqual(['revenue', 'quantity']);
    });

    it('refuse un nom déjà pris par une autre vue du même propriétaire, mais le même nom chez un autre est permis', async () => {
      const name = uniqueName('Doublon');
      await save(owner, freshUuid(), content(name));
      expect(await save(owner, freshUuid(), content(name))).toMatchObject({
        status: 'REJECTED',
        error: { code: 'VIEW_NAME_TAKEN' },
      });
      expect((await save(stranger, freshUuid(), content(name))).status).toBe('APPLIED');
    });

    it('la vue d’un autre est introuvable (existence opaque), y compris pour la réécrire', async () => {
      const viewId = freshUuid();
      await save(owner, viewId, content(uniqueName('Privée')));
      expect(await save(stranger, viewId, content(uniqueName('Volée')))).toMatchObject({
        status: 'REJECTED',
        error: { code: 'NOT_FOUND' },
      });
      expect((await rowOf(viewId))!.name).not.toMatch(/^Volée/);
    });

    it('refus : hors ligne, catalogue périmé, champ inconnu, jeu illisible, mesure au coût sans droit', async () => {
      expect(
        await save(owner, freshUuid(), content(uniqueName('Hors ligne')), { offline: true }),
      ).toMatchObject({ status: 'REJECTED', error: { code: 'ONLINE_REQUIRED' } });
      expect(
        await save(owner, freshUuid(), {
          ...content(uniqueName('Vieux')),
          catalogVersion: ANALYTICS_CATALOG_VERSION + 1,
        }),
      ).toMatchObject({ status: 'REJECTED', error: { code: 'CATALOG_OUTDATED' } });
      expect(
        await save(
          owner,
          freshUuid(),
          content(uniqueName('Inconnu'), salesDefinition({ measures: ['nope'] })),
        ),
      ).toMatchObject({ status: 'REJECTED', error: { code: 'ANALYTICS_FIELD_UNKNOWN' } });
      // Le jeu des ventes n'est pas lisible sans `sales.sale.read`.
      expect(await save(blind, freshUuid(), content(uniqueName('Aveugle')))).toMatchObject({
        status: 'REJECTED',
        error: { code: 'FORBIDDEN' },
      });
      // Une mesure au coût exige `inventory.valuation.read`.
      expect(
        await save(
          owner,
          freshUuid(),
          content(uniqueName('Marge'), salesDefinition({ measures: ['margin'] })),
        ),
      ).toMatchObject({ status: 'REJECTED', error: { code: 'FORBIDDEN_MEASURE' } });
    });

    it('sans la permission d’explorer, la commande est refusée par le pipeline', async () => {
      const nobody = await actorWith(await db.transaction().execute((t) => insertTestUser(t)), []);
      expect(await save(nobody, freshUuid(), content(uniqueName('Sans droit')))).toMatchObject({
        status: 'REJECTED',
        error: { code: 'FORBIDDEN' },
      });
    });
  });

  describe('partager et vue par défaut', () => {
    it('partage par rôles actifs : écrit la liste, publie SavedViewShared, refuse un rôle inconnu et le non-propriétaire', async () => {
      const viewId = freshUuid();
      await save(owner, viewId, content(uniqueName('À partager')));
      expect(
        await harness.run(owner, SHARE, 'SAVED_VIEW', viewId, { roles: ['ROLE_QUI_NEXISTE_PAS'] }),
      ).toMatchObject({ status: 'REJECTED', error: { code: 'ROLE_UNKNOWN' } });
      expect(
        await harness.run(stranger, SHARE, 'SAVED_VIEW', viewId, { roles: [targetRole] }),
      ).toMatchObject({ status: 'REJECTED' });

      const result = await harness.run(owner, SHARE, 'SAVED_VIEW', viewId, {
        roles: [targetRole, targetRole],
      });
      expect(result.status).toBe('APPLIED');
      expect((await rowOf(viewId))!.shared_with_roles).toEqual([targetRole]);
      const events = await db
        .selectFrom('platform_domain_events')
        .select(['event_type', 'producer_module', 'payload'])
        .where('aggregate_id', '=', toBin(viewId))
        .where('event_type', '=', 'SavedViewShared')
        .execute();
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        view_id: viewId,
        roles: [targetRole],
        previous_roles: [],
      });
    });

    it('sans `analytics.view.share`, partager est refusé par le pipeline', async () => {
      const viewId = freshUuid();
      await save(stranger, viewId, content(uniqueName('Sans partage')));
      expect(
        await harness.run(stranger, SHARE, 'SAVED_VIEW', viewId, { roles: [targetRole] }),
      ).toMatchObject({ status: 'REJECTED', error: { code: 'FORBIDDEN' } });
    });

    it('vue par défaut : exige le partage avec le rôle, remplace la précédente, tombe avec le partage, se retire par null', async () => {
      const first = freshUuid();
      const second = freshUuid();
      await save(owner, first, content(uniqueName('Première')));
      await save(owner, second, content(uniqueName('Seconde')));
      await harness.run(owner, SHARE, 'SAVED_VIEW', first, { roles: [targetRole] });
      await harness.run(owner, SHARE, 'SAVED_VIEW', second, { roles: [targetRole] });

      const unshared = freshUuid();
      await save(owner, unshared, content(uniqueName('Non partagée')));
      expect(
        await harness.run(owner, SET_DEFAULT, 'SAVED_VIEW', unshared, { roleCode: targetRole }),
      ).toMatchObject({ status: 'REJECTED', error: { code: 'VIEW_NOT_SHARED_WITH_ROLE' } });

      expect(
        (await harness.run(owner, SET_DEFAULT, 'SAVED_VIEW', first, { roleCode: targetRole }))
          .status,
      ).toBe('APPLIED');
      expect((await rowOf(first))!.is_default_for_role).toBe(targetRole);
      // La seconde remplace la première : une seule vue par défaut par rôle.
      expect(
        (await harness.run(owner, SET_DEFAULT, 'SAVED_VIEW', second, { roleCode: targetRole }))
          .status,
      ).toBe('APPLIED');
      expect((await rowOf(first))!.is_default_for_role).toBeNull();
      expect((await rowOf(second))!.is_default_for_role).toBe(targetRole);
      // Retirer le partage retire la vue par défaut du rôle.
      await harness.run(owner, SHARE, 'SAVED_VIEW', second, { roles: [] });
      expect((await rowOf(second))!.is_default_for_role).toBeNull();
      // `null` retire la vue par défaut.
      await harness.run(owner, SHARE, 'SAVED_VIEW', first, { roles: [targetRole] });
      await harness.run(owner, SET_DEFAULT, 'SAVED_VIEW', first, { roleCode: targetRole });
      await harness.run(owner, SET_DEFAULT, 'SAVED_VIEW', first, { roleCode: null });
      expect((await rowOf(first))!.is_default_for_role).toBeNull();
    });
  });

  describe('supprimer', () => {
    it('suppression physique et auditée par le propriétaire seul', async () => {
      const viewId = freshUuid();
      await save(owner, viewId, content(uniqueName('À supprimer')));
      expect(await harness.run(stranger, DELETE, 'SAVED_VIEW', viewId, {})).toMatchObject({
        status: 'REJECTED',
        error: { code: 'NOT_FOUND' },
      });
      expect(await rowOf(viewId)).toBeDefined();
      expect((await harness.run(owner, DELETE, 'SAVED_VIEW', viewId, {})).status).toBe('APPLIED');
      expect(await rowOf(viewId)).toBeUndefined();
      const audit = await db
        .selectFrom('audit_audit_log')
        .select(['action', 'before'])
        .where('entity_id', '=', toBin(viewId))
        .where('action', '=', DELETE)
        .execute();
      expect(audit).toHaveLength(1);
      expect((audit[0]!.before as { name: string }).name).toMatch(/^À supprimer/);
    });
  });

  describe('lecture et exécutabilité', () => {
    it('le lecteur voit la vue partagée avec son rôle, avec son exécutabilité ; l’inconnu et l’invisible sont écartés', async () => {
      const viewId = freshUuid();
      const name = uniqueName('Partagée');
      await save(owner, viewId, content(name));
      await harness.run(owner, SHARE, 'SAVED_VIEW', viewId, { roles: [targetRole] });
      const at = new Date(NOW);

      const seen = await listReadableViews(db, { userId: reader.id, at });
      expect(seen.find((entry) => entry.view.id === viewId)).toMatchObject({
        executability: 'OK',
        view: { name, ownerUserId: owner.id },
      });
      // Le propriétaire la voit aussi ; un tiers sans le rôle partagé non.
      expect(
        (await listReadableViews(db, { userId: owner.id, at })).some((e) => e.view.id === viewId),
      ).toBe(true);
      expect(
        (await listReadableViews(db, { userId: stranger.id, at })).some(
          (e) => e.view.id === viewId,
        ),
      ).toBe(false);
      expect(await readReadableView(db, { userId: stranger.id, viewId, at })).toBeUndefined();
      expect(
        await readReadableView(db, { userId: reader.id, viewId: freshUuid(), at }),
      ).toBeUndefined();
    });

    it('UNAVAILABLE sans le droit de lire le jeu ; OUTDATED quand un champ a disparu (jamais réécrite)', async () => {
      const viewId = freshUuid();
      await save(owner, viewId, content(uniqueName('Exécutabilité')));
      await harness.run(owner, SHARE, 'SAVED_VIEW', viewId, {
        roles: [targetRole, blind.roleCode],
      });
      const at = new Date(NOW);

      const asBlind = await readReadableView(db, { userId: blind.id, viewId, at });
      expect(asBlind!.executability).toBe('UNAVAILABLE');

      // Un champ du catalogue qui disparaît : la définition stockée cite une mesure inconnue.
      await db
        .updateTable('analytics_saved_views')
        .set({
          definition: JSON.stringify({ ...salesDefinition(), measures: ['mesure_disparue'] }),
        })
        .where('id', '=', toBin(viewId))
        .execute();
      const asReader = await readReadableView(db, { userId: reader.id, viewId, at });
      expect(asReader!.executability).toBe('OUTDATED');
      expect((await rowOf(viewId))!.catalog_version).toBe(ANALYTICS_CATALOG_VERSION);
    });
  });
});
