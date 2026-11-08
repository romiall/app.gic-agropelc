/**
 * Pointage désactivé pour le pilote (AV-537 ; décision du porteur du 08/11/2026, questionnaire Q44) : le réglage
 * `fieldwork.checkin_enabled` ne masque que la présentation de l'accueil.
 *
 * - `isCheckinEnabled` lit le réglage global en vigueur à l'instant demandé, vrai par défaut (valeur absente ou
 *   mal formée). Les lignes de réglage de l'essai sont datées de l'an 2100 : la base est partagée et les réglages
 *   sont immuables, une ligne globale en vigueur aujourd'hui changerait les autres suites.
 * - `homeActionsFor` retire « PRENDRE SERVICE » et donne la place d'action principale à la suivante.
 * - `tallyFlaggedSales` ne compte plus une vente dont le seul drapeau est « hors prise de service ».
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { HomeAction } from '@gic/contracts';
import { isCheckinEnabled } from '../src/modules/fieldwork/application/public/index.js';
import { tallyFlaggedSales } from '../src/modules/sales/application/public/period-activity.js';
import { homeActionsFor } from '../src/home-api/home-format.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { closeTestDb, db, freshUuid, insertTestUser } from './helpers.js';

const KEY = 'fieldwork.checkin_enabled';
const FALSE_FROM = new Date('2100-01-01T00:00:00.000Z');
const TRUE_FROM = new Date('2100-02-01T00:00:00.000Z');
const TEXT_FROM = new Date('2100-03-01T00:00:00.000Z');

/** Pose, une seule fois pour toutes les exécutions, une ligne de réglage global datée de l'an 2100. */
async function ensureGlobalSetting(
  value: unknown,
  validFrom: Date,
  createdBy: string,
): Promise<void> {
  const existing = await db
    .selectFrom('organization_system_settings')
    .select('id')
    .where('key', '=', KEY)
    .where('scope_type', '=', 'GLOBAL')
    .where('scope_id', 'is', null)
    .where('valid_from', '=', validFrom)
    .executeTakeFirst();
  if (existing) return;
  await db
    .insertInto('organization_system_settings')
    .values({
      id: toBin(freshUuid()),
      key: KEY,
      value: jsonValue(value),
      scope_type: 'GLOBAL',
      scope_id: null,
      valid_from: validFrom,
      is_client_visible: 1,
      created_by: toBin(createdBy),
      reason: 'Essai AV-537',
    })
    .execute();
}

const action = (code: string, primary = false): HomeAction => ({
  code,
  label: code,
  hint: null,
  route: null,
  primary,
});

describe('Pointage désactivé : réglage fieldwork.checkin_enabled (AV-537)', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  it('isCheckinEnabled : faux puis vrai selon la ligne en vigueur ; une valeur qui n’est pas un booléen laisse le défaut (vrai)', async () => {
    const author = await db.transaction().execute((trx) => insertTestUser(trx));
    await ensureGlobalSetting(false, FALSE_FROM, author);
    await ensureGlobalSetting(true, TRUE_FROM, author);
    await ensureGlobalSetting('oui', TEXT_FROM, author);

    expect(await isCheckinEnabled(db, new Date('2100-01-15T00:00:00.000Z'))).toBe(false);
    expect(await isCheckinEnabled(db, new Date('2100-02-15T00:00:00.000Z'))).toBe(true);
    expect(await isCheckinEnabled(db, new Date('2100-03-15T00:00:00.000Z'))).toBe(true);
  });

  it('homeActionsFor : pointage en service, les actions telles quelles ; désactivé, « PRENDRE SERVICE » disparaît', () => {
    const actions = [action('START_SERVICE', true), action('NEW_PROSPECT'), action('NEW_VISIT')];
    expect(homeActionsFor(actions, true)).toEqual(actions);
    const withoutStart = homeActionsFor(actions, false);
    expect(withoutStart.map((item) => item.code)).toEqual(['NEW_PROSPECT', 'NEW_VISIT']);
    // L'action principale retirée : la suivante prend sa place, une seule action reste en avant.
    expect(withoutStart.filter((item) => item.primary).map((item) => item.code)).toEqual([
      'NEW_PROSPECT',
    ]);
    // Les données d'entrée ne sont jamais modifiées.
    expect(actions[0]!.primary).toBe(true);
    expect(actions).toHaveLength(3);
  });

  it('homeActionsFor : un rôle sans « PRENDRE SERVICE » garde ses actions et son action principale', () => {
    const actions = [action('CONTROL_TOWER', true), action('VALIDATIONS')];
    expect(homeActionsFor(actions, false)).toEqual(actions);
  });

  it('homeActionsFor : « PRENDRE SERVICE » secondaire retiré, l’action principale reste la même', () => {
    const actions = [action('NEW_SALE', true), action('START_SERVICE')];
    const result = homeActionsFor(actions, false);
    expect(result.map((item) => item.code)).toEqual(['NEW_SALE']);
    expect(result[0]!.primary).toBe(true);
  });

  it('tallyFlaggedSales : sans drapeau ignoré, toute ligne lue est une vente signalée (compte de flaggedCount)', () => {
    const tally = tallyFlaggedSales([
      ['OUT_OF_SESSION'],
      ['OUT_OF_SESSION', 'PRICE_MISMATCH'],
      ['STOCK_NEGATIVE'],
    ]);
    expect(tally.salesCount).toBe(3);
    expect([...tally.byFlag.entries()].sort()).toEqual([
      ['OUT_OF_SESSION', 2],
      ['PRICE_MISMATCH', 1],
      ['STOCK_NEGATIVE', 1],
    ]);
  });

  it('tallyFlaggedSales : « hors prise de service » ignoré, une vente qui n’a que ce drapeau n’est plus signalée', () => {
    const tally = tallyFlaggedSales(
      [['OUT_OF_SESSION'], ['OUT_OF_SESSION', 'PRICE_MISMATCH'], ['STOCK_NEGATIVE']],
      ['OUT_OF_SESSION'],
    );
    expect(tally.salesCount).toBe(2);
    expect([...tally.byFlag.entries()].sort()).toEqual([
      ['PRICE_MISMATCH', 1],
      ['STOCK_NEGATIVE', 1],
    ]);
    expect(tally.byFlag.has('OUT_OF_SESSION')).toBe(false);
    // Que des ventes « hors prise de service » : plus aucune vente signalée.
    expect(tallyFlaggedSales([['OUT_OF_SESSION'], ['OUT_OF_SESSION']], ['OUT_OF_SESSION'])).toEqual(
      {
        salesCount: 0,
        byFlag: new Map(),
      },
    );
  });
});
