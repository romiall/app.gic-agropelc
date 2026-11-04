/**
 * AV-509 (décision du porteur, 04/11/2026) : une vente n'est jamais conditionnée par l'ouverture d'une
 * caisse. Lecture du paramètre `finance.cash_session_required` (`isCashSessionRequired`) : faux par
 * défaut, réglable par site, version en vigueur à l'heure du fait ; une valeur absente ou mal formée ne
 * rétablit jamais l'exigence. AV-510 (le porteur répond que les sorties gardent la caisse) :
 * `finance.cash_session_required_for_payouts` (`isCashSessionRequiredForPayouts`), vrai par défaut, que
 * seule une valeur explicitement fausse lève. Les scénarios de vente, d'encaissement, de dépense et de paiement
 * fournisseur sont dans `sales-cash-session.test.ts`, `finance-expense-commands.test.ts` et
 * `finance-supplier-payment-commands.test.ts`.
 *
 * Base partagée : chaque cas crée son site ; seuls des réglages de site sont posés (le réglage global,
 * partagé avec les autres suites, n'est jamais touché).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isCashSessionRequired,
  isCashSessionRequiredForPayouts,
} from '../src/modules/finance/application/public/index.js';
import { closeTestDb, db, insertTestUser, insertTestZone } from './helpers.js';
import {
  allowPayoutsWithoutSession,
  newPosSite,
  requireCashSession,
  tx,
} from './cash-transfer-fixtures.js';

describe('AV-509 : paramètre finance.cash_session_required', { timeout: 60_000 }, () => {
  let root: string;
  let zoneId: string;
  const AT = new Date('2026-11-04T10:00:00.000Z');

  beforeAll(async () => {
    await tx(async (trx) => {
      root = await insertTestUser(trx);
      zoneId = await insertTestZone(trx, root);
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const required = (siteId: string | null, at: Date = AT) =>
    isCashSessionRequired(db, { siteId, at });
  const requiredForPayouts = (siteId: string | null, at: Date = AT) =>
    isCashSessionRequiredForPayouts(db, { siteId, at });

  it('aucun réglage : jamais exigée, ni pour un site, ni sans site', async () => {
    const site = await newPosSite(root, zoneId);
    expect(await required(site)).toBe(false);
    expect(await required(null)).toBe(false);
  });

  it('réglage de site : exigée pour ce site seulement', async () => {
    const strict = await newPosSite(root, zoneId);
    const other = await newPosSite(root, zoneId);
    await requireCashSession(strict, root);
    expect(await required(strict)).toBe(true);
    expect(await required(other)).toBe(false);
  });

  it('version en vigueur à l’heure du fait : la plus récente décide, une version future ne compte pas', async () => {
    const site = await newPosSite(root, zoneId);
    await requireCashSession(site, root, true, '2026-01-01T00:00:00.000Z');
    await requireCashSession(site, root, false, '2026-11-01T00:00:00.000Z');
    await requireCashSession(site, root, true, '2026-12-01T00:00:00.000Z');
    expect(await required(site, new Date('2026-10-15T10:00:00.000Z'))).toBe(true);
    expect(await required(site, AT)).toBe(false);
    expect(await required(site, new Date('2026-12-02T10:00:00.000Z'))).toBe(true);
    // Avant la première version : aucun réglage, donc faux.
    expect(await required(site, new Date('2025-12-31T10:00:00.000Z'))).toBe(false);
  });

  it('valeur mal formée : ignorée, l’exigence n’est jamais rétablie par erreur', async () => {
    const text = await newPosSite(root, zoneId);
    const number = await newPosSite(root, zoneId);
    await requireCashSession(text, root, 'true');
    await requireCashSession(number, root, 1);
    expect(await required(text)).toBe(false);
    expect(await required(number)).toBe(false);
  });

  it('sorties d’espèces (AV-510) : exigée par défaut, seul un faux explicite la lève, pour son site seulement', async () => {
    const free = await newPosSite(root, zoneId);
    const other = await newPosSite(root, zoneId);
    const malformed = await newPosSite(root, zoneId);
    // Aucun réglage : les sorties gardent la caisse, alors même qu'une vente n'en a plus besoin.
    expect(await requiredForPayouts(free)).toBe(true);
    expect(await requiredForPayouts(null)).toBe(true);
    expect(await required(free)).toBe(false);

    await allowPayoutsWithoutSession(free, root);
    await allowPayoutsWithoutSession(malformed, root, 'false');
    expect(await requiredForPayouts(free)).toBe(false);
    expect(await requiredForPayouts(other)).toBe(true);
    // Valeur mal formée (texte) : ignorée, l'exigence est maintenue.
    expect(await requiredForPayouts(malformed)).toBe(true);

    // Les deux paramètres sont indépendants.
    await requireCashSession(free, root);
    expect(await required(free)).toBe(true);
    expect(await requiredForPayouts(free)).toBe(false);
  });

  it('sorties d’espèces : la version en vigueur à l’heure du fait décide', async () => {
    const site = await newPosSite(root, zoneId);
    await allowPayoutsWithoutSession(site, root, false, '2026-11-01T00:00:00.000Z');
    await allowPayoutsWithoutSession(site, root, true, '2026-11-03T00:00:00.000Z');
    expect(await requiredForPayouts(site, new Date('2026-11-02T10:00:00.000Z'))).toBe(false);
    expect(await requiredForPayouts(site, AT)).toBe(true);
    // Avant la première version : aucun réglage, donc exigée.
    expect(await requiredForPayouts(site, new Date('2026-10-31T10:00:00.000Z'))).toBe(true);
  });
});
