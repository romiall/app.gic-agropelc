/**
 * Chargement par fichier des lots en cours à reprendre (ADR-069, BR-PRD-016 ; AV-072, AV-541 à AV-544), du CSV à la
 * commande, avec les vrais référentiels de l'appareil (projections posées dans la base locale, comme le serveur les
 * sert). Une ligne du fichier donne la commande `production.lot_opening.post` que l'écran « Reprise d'un lot » aurait
 * produite ; aucun lot n'est créé par le chargement (il naît à la validation de la Direction).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lotOpeningPostPayloadSchema } from '@gic/contracts';
import { isUuidv7 } from '@gic/domain';
import { getDb, type Projection } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { loadSalesReferences } from '../sales/references.js';
import { buildImportRefs } from './context.js';
import { parseCsv, toCsv } from './csv.js';
import { IMPORT_ENTITIES } from './entities.js';
import { LOT_OPENING_ENTITY, dayOf } from './lot-opening-entity.js';
import { exampleRow, planImport, templateRows } from './model.js';
import type { ImportRefs } from './refs.js';

/** Instant du contrôle : le 9 novembre 2026 à 10 h, heure de Douala. */
const NOW = new Date('2026-11-09T09:00:00.000Z');
const FARM = '01900000-0000-7000-8000-0000000007a1';
const SHOP = '01900000-0000-7000-8000-0000000007a2';
const BUILDING = '01900000-0000-7000-8000-0000000007a3';
const BUILDING_OFF = '01900000-0000-7000-8000-0000000007a4';
const SHOP_STORE = '01900000-0000-7000-8000-0000000007a5';
const BROILER = '01900000-0000-7000-8000-0000000007a6';
const LAYER = '01900000-0000-7000-8000-0000000007a7';
const FEED = '01900000-0000-7000-8000-0000000007a8';
const RETIRED = '01900000-0000-7000-8000-0000000007a9';
const SUPPLIER = '01900000-0000-7000-8000-0000000007aa';
const LOT = '01900000-0000-7000-8000-0000000007ab';

const projection = (
  dataset: string,
  entityType: string,
  id: string,
  data: Record<string, unknown>,
): Projection => ({
  key: `${dataset}:${entityType}:${id}`,
  dataset,
  entity_type: entityType,
  entity_id: id,
  scope_type: 'GLOBAL',
  scope_id: null,
  data: { id, ...data },
  seq: 1,
  row_version: 1,
});

const site = (id: string, code: string, name: string, type: string) =>
  projection('site', 'SITE', id, {
    code,
    name,
    site_type: type,
    zone_id: IDS.zone,
    status: 'ACTIVE',
  });

const location = (
  id: string,
  siteId: string,
  code: string,
  name: string,
  type: string,
  status = 'ACTIVE',
) =>
  projection('location', 'LOCATION', id, {
    site_id: siteId,
    code,
    name,
    location_type: type,
    is_virtual: false,
    custody_mode: 'SHARED',
    custodian_user_id: null,
    designated_device_id: null,
    status,
  });

const product = (id: string, code: string, extra: Record<string, unknown> = {}) =>
  projection('product', 'PRODUCT', id, {
    code,
    name: code,
    category_id: IDS.zone,
    base_unit_code: 'TETE',
    is_sellable: true,
    pricing_mode: 'PER_UNIT',
    status: 'ACTIVE',
    stock_family: 'BIOLOGIQUE',
    lot_tracking: 'REQUIRED',
    species: 'POULET_CHAIR',
    ...extra,
  });

async function refsOf(): Promise<ImportRefs> {
  const references = await loadSalesReferences(getDb());
  return buildImportRefs({ references, userId: IDS.user, roles: ['ADMIN'], now: NOW });
}

const toText = (rows: readonly Record<string, string>[]) => {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return toCsv([keys, ...rows.map((row) => keys.map((key) => row[key] ?? ''))]);
};

const plan = async (rows: readonly Record<string, string>[], overrides: Partial<ImportRefs> = {}) =>
  planImport(LOT_OPENING_ENTITY, parseCsv(toText(rows)), { ...(await refsOf()), ...overrides });

const row = (extra: Record<string, string> = {}): Record<string, string> => ({
  site: 'FERME-1',
  emplacement: 'BAT-1',
  type_de_lot: 'Poulet de chair',
  produit: 'POULET-VIF',
  date_mise_en_place: '05/10/2026',
  effectif: '4 800',
  valeur: '5 760 000',
  ...extra,
});

beforeEach(async () => {
  const db = getDb();
  await db.projections.clear();
  await db.outbox.clear();
  await seedSalesFixtures(db);
  await db.projections.bulkPut([
    site(FARM, 'FERME-1', 'Ferme de Bonabéri', 'FERME'),
    site(SHOP, 'MAG-1', 'Magasin central', 'MAGASIN'),
    location(BUILDING, FARM, 'BAT-1', 'Bâtiment 1', 'BUILDING'),
    location(BUILDING_OFF, FARM, 'BAT-X', 'Bâtiment fermé', 'BUILDING', 'INACTIVE'),
    location(SHOP_STORE, SHOP, 'MAG', 'Magasin', 'STORE'),
    product(BROILER, 'POULET-VIF'),
    product(LAYER, 'PONDEUSE-1', { species: 'PONDEUSE' }),
    product(FEED, 'ALIMENT', { stock_family: 'INTRANT', lot_tracking: 'NONE', species: null }),
    product(RETIRED, 'ANCIEN', { status: 'INACTIVE' }),
    projection('procurement', 'SUPPLIER', SUPPLIER, { code: 'COUVOIR', name: 'Couvoir du Moungo' }),
  ]);
});

afterEach(async () => {
  const db = getDb();
  await db.projections.clear();
  await db.outbox.clear();
});

describe('Lots en cours (production.lot_opening.post)', () => {
  it('une ligne donne la reprise que l’écran aurait envoyée, aux identifiants stables', async () => {
    const first = await plan([row()]);
    expect(first.missingColumns).toEqual([]);
    expect(first.unknownColumns).toEqual([]);
    expect(first.rows[0]!.status, JSON.stringify(first.rows[0])).toBe('READY');
    const [command] = first.rows[0]!.commands;
    expect(command).toMatchObject({
      commandType: 'production.lot_opening.post',
      aggregateType: 'PRODUCTION_LOT_OPENING',
      payload: {
        lotType: 'POULET_CHAIR',
        productId: BROILER,
        mainLocationId: BUILDING,
        placedOn: '2026-10-05',
        quantity: 4800,
        valueXaf: 5_760_000,
      },
    });
    expect(isUuidv7(command!.aggregateId)).toBe(true);
    // La charge utile est celle que le serveur accepte (même contrat).
    expect(lotOpeningPostPayloadSchema.safeParse(command!.payload).success).toBe(true);
    // Le même fichier rechargé : le même identifiant ; un contenu différent : un autre.
    expect((await plan([row()])).rows[0]!.commands[0]!.aggregateId).toBe(command!.aggregateId);
    expect((await plan([row({ effectif: '4 700' })])).rows[0]!.commands[0]!.aggregateId).not.toBe(
      command!.aggregateId,
    );
  });

  it('les colonnes facultatives (souche, fournisseur, poids moyen, note) passent dans la charge utile', async () => {
    const result = await plan([
      row({
        souche: 'Cobb 500',
        fournisseur: 'Couvoir du Moungo',
        poids_moyen: '1 250,5',
        note: 'Bande reprise au 09/11',
      }),
    ]);
    expect(result.rows[0]!.status, JSON.stringify(result.rows[0])).toBe('READY');
    expect(result.rows[0]!.commands[0]!.payload).toMatchObject({
      strain: 'Cobb 500',
      supplierId: SUPPLIER,
      avgWeightG: 1250.5,
      notes: 'Bande reprise au 09/11',
    });
  });

  it('accepte les noms usuels des types de lot et le code du type', async () => {
    for (const [type, product, lotType] of [
      ['POULET_CHAIR', 'POULET-VIF', 'POULET_CHAIR'],
      ['Pondeuses', 'PONDEUSE-1', 'PONDEUSE'],
      ['pondeuse', 'PONDEUSE-1', 'PONDEUSE'],
    ] as const) {
      const result = await plan([row({ type_de_lot: type, produit: product })]);
      expect(result.rows[0]!.status, type).toBe('READY');
      expect(result.rows[0]!.commands[0]!.payload).toMatchObject({ lotType });
    }
  });

  it('lit les dates d’un tableur français comme celles du format ISO', () => {
    expect(dayOf('2026-10-05')).toBe('2026-10-05');
    expect(dayOf('05/10/2026')).toBe('2026-10-05');
    expect(dayOf('5-10-2026')).toBe('2026-10-05');
    expect(dayOf('05.10.2026')).toBe('2026-10-05');
    for (const text of ['31/02/2026', '2026-13-01', '05/10/26', 'hier', '']) {
      expect(dayOf(text), text).toBeNull();
    }
  });

  it('refuse d’avance ce que le serveur refuserait, une phrase par défaut', async () => {
    const issuesOf = async (extra: Record<string, string>) => {
      const result = await plan([row(extra)]);
      expect(result.rows[0]!.status, JSON.stringify(extra)).toBe('ERROR');
      return result.rows[0]!.issues.join(' | ');
    };
    expect(await issuesOf({ site: 'Magasin central' })).toMatch(/Ferme inconnue/);
    expect(await issuesOf({ site: 'Inconnue' })).toMatch(/Ferme inconnue/);
    expect(await issuesOf({ emplacement: 'MAG' })).toMatch(/Bâtiment ou case inconnu/);
    expect(await issuesOf({ emplacement: 'BAT-X' })).toMatch(/inactif/);
    expect(await issuesOf({ type_de_lot: 'Lapins' })).toMatch(/Type de lot inconnu/);
    expect(await issuesOf({ produit: 'NUL' })).toMatch(/Produit inconnu/);
    expect(await issuesOf({ produit: 'ANCIEN' })).toMatch(/désactivé/);
    expect(await issuesOf({ produit: 'ALIMENT' })).toMatch(/pas un animal suivi par lot/);
    // Poules pondeuses dans un lot de poulets de chair.
    expect(await issuesOf({ produit: 'PONDEUSE-1' })).toMatch(/espèce du type de lot/);
    expect(await issuesOf({ date_mise_en_place: '31/02/2026' })).toMatch(/illisible/);
    expect(await issuesOf({ date_mise_en_place: '10/11/2026' })).toMatch(/postérieure/);
    expect(await issuesOf({ date_mise_en_place: '01/01/2022' })).toMatch(/plus de 1100 jours/);
    expect(await issuesOf({ effectif: '12,5' })).toMatch(/Effectif repris invalide/);
    expect(await issuesOf({ effectif: '0' })).toMatch(/entier de têtes, de 1 à/);
    expect(await issuesOf({ valeur: '1,5' })).toMatch(/Valeur totale invalide/);
    expect(await issuesOf({ effectif: '10', valeur: '2000000000' })).toMatch(/par tête/);
    expect(await issuesOf({ fournisseur: 'Inconnu' })).toMatch(/Fournisseur inconnu/);
    expect(await issuesOf({ poids_moyen: '0' })).toMatch(/Poids moyen invalide/);
    expect(await issuesOf({ site: '' })).toMatch(/Ferme manquante/);
  });

  it('un lot déjà connu de l’appareil, ou déjà dans la file, n’est pas rechargé', async () => {
    await getDb().projections.put(
      projection('production', 'PRODUCTION_LOT', LOT, {
        lot_code: 'LOT-BON-2026-001',
        lot_type: 'POULET_CHAIR',
        product_id: BROILER,
        stock_lot_id: LOT,
        site_id: FARM,
        main_location_id: BUILDING,
        parent_lot_id: null,
        strain: null,
        status: 'ACTIVE',
        start_date: '2026-10-05',
        planned_end_date: null,
        initial_quantity: 4800,
        occurred_at: '2026-10-05T08:00:00.000Z',
      }),
    );
    const known = await plan([row()]);
    expect(known.rows[0]!.status).toBe('EXISTS');
    // Un autre jour de mise en place : un autre lot.
    const other = await plan([row({ date_mise_en_place: '06/10/2026' })]);
    expect(other.rows[0]!.status).toBe('READY');
  });

  it('deux lignes du même lot réel dans le fichier : la seconde est un doublon', async () => {
    const result = await plan([row(), row({ effectif: '4 700' })]);
    expect(result.rows.map((entry) => entry.status)).toEqual(['READY', 'DUPLICATE_IN_FILE']);
  });

  it('sans référentiels de l’appareil, rien n’est chargeable', async () => {
    const { slipContext, ...withoutDevice } = await refsOf();
    expect(slipContext).toBeDefined();
    const result = await planImport(LOT_OPENING_ENTITY, parseCsv(toText([row()])), withoutDevice);
    expect(result.rows[0]!.status).toBe('ERROR');
    expect(result.rows[0]!.issues.join(' ')).toMatch(/référentiels de l’appareil/);
  });

  it('l’exemple de l’aide des colonnes est une ligne que le contrôle accepte', async () => {
    const rows = [templateRows(LOT_OPENING_ENTITY)[0]!, exampleRow(LOT_OPENING_ENTITY)];
    const result = await planImport(LOT_OPENING_ENTITY, parseCsv(toCsv(rows)), await refsOf());
    expect(result.missingColumns).toEqual([]);
    expect(result.unknownColumns).toEqual([]);
    expect(result.rows.map((entry) => [entry.status, entry.issues])).toEqual([['READY', []]]);
  });

  it('est proposé à l’administrateur (porteur du chargement), après le stock d’ouverture', () => {
    expect(LOT_OPENING_ENTITY.roles).toEqual(['ADMIN']);
    const ids = IMPORT_ENTITIES.map((entity) => entity.id);
    expect(ids.indexOf('lot_opening')).toBe(ids.indexOf('opening_stock') + 1);
  });
});
