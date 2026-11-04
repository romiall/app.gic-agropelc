/**
 * Chargement par lots des pièces papier (PP-C ; REQ-303, AV-317, AV-508, AV-078) : du CSV à la commande, avec les vrais
 * référentiels de l'appareil (projections posées dans la base locale) et la résolution de l'écran de report. Rien n'est
 * mocké : une pièce du fichier donne la commande que l'écran « Reporter une pièce papier » aurait produite.
 */
import { isUuidv7 } from '@gic/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, type Projection } from '../../storage/db.js';
import {
  cashTransferTargetRow,
  expenseCategoryRow,
  IDS,
  posCashAccountRow,
  seedSalesFixtures,
} from '../sales/fixtures.js';
import { loadSalesReferences } from '../sales/references.js';
import { buildImportRefs } from './context.js';
import { parseCsv, toCsv } from './csv.js';
import { planImport, templateRows } from './model.js';
import type { ImportRefs } from './refs.js';
import { parseSlipDate, SLIPS_ENTITY } from './slips.js';

const HEADER =
  'Type de pièce;Numéro de la pièce;Date de la pièce;Motif d’antidatage;Emplacement;Destination;Site;Client;Produit;Unité;Quantité;Prix unitaire;Moyen de paiement;Montant;Compte;Catégorie;Description';

const pad = (value: number) => String(value).padStart(2, '0');
/** `JJ/MM/AAAA HH:mm` en heure locale de la machine, comme l'écran de report lit la date d'une pièce. */
const written = (date: Date) =>
  `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

const recent = new Date(Date.now() - 2 * 3_600_000);
const old = new Date(Date.now() - 20 * 24 * 3_600_000);

/** Ligne de projection servie à l'appareil, comme le serveur la sert. */
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

async function refsOf(roles: readonly string[] = ['VENDEUR_PDV']): Promise<ImportRefs> {
  const references = await loadSalesReferences(getDb());
  return buildImportRefs({ references, userId: IDS.user, roles, now: new Date() });
}

const plan = async (rows: string[], overrides: Partial<ImportRefs> = {}) =>
  planImport(SLIPS_ENTITY, parseCsv(`${HEADER}\n${rows.join('\n')}\n`), {
    ...(await refsOf()),
    ...overrides,
  });

/**
 * Contrôle un fichier dont les lignes sont des objets colonne → valeur : les clés des colonnes tiennent lieu d'en-têtes
 * (le modèle les reconnaît), ce qui évite de compter les point-virgules des types qui n'emploient que quelques colonnes.
 */
async function planFor(
  rows: readonly Record<string, string>[],
  overrides: Partial<ImportRefs> = {},
) {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const text = toCsv([keys, ...rows.map((row) => keys.map((key) => row[key] ?? ''))]);
  return planImport(SLIPS_ENTITY, parseCsv(text), { ...(await refsOf()), ...overrides });
}

describe('parseSlipDate', () => {
  it('lit JJ/MM/AAAA et AAAA-MM-JJ, avec ou sans heure (midi à défaut)', () => {
    expect(parseSlipDate('14/10/2026 09:30')).toEqual({
      day: '2026-10-14',
      time: '09:30',
      timeGiven: true,
    });
    expect(parseSlipDate('2026-10-14')).toEqual({
      day: '2026-10-14',
      time: '12:00',
      timeGiven: false,
    });
    expect(parseSlipDate('2026-10-14T07:05')).toEqual({
      day: '2026-10-14',
      time: '07:05',
      timeGiven: true,
    });
    expect(parseSlipDate('3.1.2026 8h15')).toEqual({
      day: '2026-01-03',
      time: '08:15',
      timeGiven: true,
    });
  });

  it('ignore les secondes que certains exports ajoutent', () => {
    expect(parseSlipDate('14/10/2026 09:30:45')).toEqual({
      day: '2026-10-14',
      time: '09:30',
      timeGiven: true,
    });
    expect(parseSlipDate('2026-10-14 09:30:45')).toEqual({
      day: '2026-10-14',
      time: '09:30',
      timeGiven: true,
    });
  });

  it('refuse un jour qui n’existe pas, une heure impossible ou un texte libre', () => {
    for (const text of [
      '31/02/2026',
      '2026-13-01',
      '14/10/2026 25:00',
      '14/10/2026 09:75',
      'hier',
    ]) {
      expect(parseSlipDate(text), text).toBeNull();
    }
  });
});

describe('pièces papier chargées par fichier', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await seedSalesFixtures(db);
    await db.projections.bulkPut([
      posCashAccountRow(),
      cashTransferTargetRow(),
      expenseCategoryRow(),
    ]);
  });

  afterEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
  });

  it('le fichier modèle est reconnu : aucune colonne manquante ni ignorée', async () => {
    const result = await planImport(
      SLIPS_ENTITY,
      parseCsv(toCsv(templateRows(SLIPS_ENTITY))),
      await refsOf(),
    );
    expect(result.missingColumns).toEqual([]);
    expect(result.unknownColumns).toEqual([]);
  });

  it('un bon de vente à deux lignes devient la commande de la vente, au prix catalogue de la date', async () => {
    const when = written(recent);
    const result = await plan([
      `BV;BV-000142;${when};;PDV-YDE-POS;;;;OEUF;;30;;ESPECES;;;;`,
      `BV;BV-000142;${when};;;;;;POULET;;2;;;;;;`,
    ]);
    expect(result.counts).toEqual({ READY: 1, EXISTS: 0, ERROR: 0, DUPLICATE_IN_FILE: 0 });
    const row = result.rows[0]!;
    expect(row.issues).toEqual([]);
    expect(row.key).toBe('BV BV-000142');
    const [command] = row.commands;
    expect(command).toMatchObject({
      commandType: 'sales.sale.record',
      aggregateType: 'SALE',
      capturedOffline: true,
    });
    expect(isUuidv7(command!.aggregateId)).toBe(true);
    expect(command!.payload).toMatchObject({
      localRef: 'BV-000142',
      fromLocationId: IDS.pos,
      lines: [
        { productId: IDS.eggs, quantity: 30, unitPriceXaf: 100 },
        { productId: IDS.chicken, quantity: 2, unitPriceXaf: 3500 },
      ],
      // Montant laissé vide : payé en totalité, 30 × 100 + 2 × 3 500.
      payments: [{ methodCode: 'ESPECES', amountXaf: 10_000 }],
    });
    expect(new Date(command!.occurredAt!).getTime()).toBe(
      new Date(
        recent.getFullYear(),
        recent.getMonth(),
        recent.getDate(),
        recent.getHours(),
        recent.getMinutes(),
      ).getTime(),
    );
    expect(command!.localFlags).toEqual(
      expect.arrayContaining([
        'PAPER_SLIP',
        'SLIP_TYPE:BV',
        'PAPER_REF:BV-000142',
        'SLIP_AMOUNT:10000',
      ]),
    );
  });

  it('l’identifiant de la pièce tient à son auteur, à son numéro et à son contenu : rien n’est avalé en silence', async () => {
    const when = written(recent);
    const line = (quantity: number) =>
      `BV;BV-000200;${when};;PDV-YDE-POS;;;;OEUF;;${quantity};;ESPECES;;;;`;
    const idOf = async (quantity: number, overrides: Partial<ImportRefs> = {}) =>
      (await plan([line(quantity)], overrides)).rows[0]!.commands[0]!.aggregateId;

    // Le même fichier rechargé par le même auteur retombe sur la même pièce : rien n'est reporté deux fois.
    expect(await idOf(5)).toBe(await idOf(5));
    // Une autre pièce de même numéro (autre carnet, erreur de saisie) a un autre identifiant : le serveur la reçoit
    // comme un numéro répété (enregistrée, avec l'avertissement) au lieu de reconnaître à tort un rejeu.
    expect(await idOf(6)).not.toBe(await idOf(5));
    // Un autre auteur qui charge la même pièce ne partage jamais l'agrégat du premier.
    expect(await idOf(5, { authorUserId: 'autre-utilisateur' })).not.toBe(await idOf(5));
  });

  it('un reçu (client par téléphone), un bon de décaissement et une remise de fonds sont chargés', async () => {
    const when = written(recent);
    const result = await plan([
      `RE;RE-000099;${when};;;;PDV-YDE;699 11 22 33;;;;;ESPECES;25 000;;;`,
      `BD;BD-000055;${when};;;;PDV-YDE;;;;;;;12500;CAISSE-PDV-YDE;Transport;Transport des cageots`,
      `RF;RF-000007;${when};;;CAISSE-CENTRALE;;;;;;;;100000;CAISSE-PDV-YDE;;`,
    ]);
    expect(result.rows.map((row) => [row.key, row.status, row.issues])).toEqual([
      ['RE RE-000099', 'READY', []],
      ['BD BD-000055', 'READY', []],
      ['RF RF-000007', 'READY', []],
    ]);
    const [receipt, expense, handover] = result.rows.map((row) => row.commands[0]!);
    expect(receipt).toMatchObject({
      commandType: 'sales.payment.record',
      payload: {
        customerId: IDS.customer,
        siteId: IDS.site,
        amountXaf: 25_000,
        localRef: 'RE-000099',
      },
    });
    expect(expense).toMatchObject({
      commandType: 'finance.expense.record',
      payload: { amountXaf: 12_500, description: 'Transport des cageots', localRef: 'BD-000055' },
    });
    expect(handover).toMatchObject({
      commandType: 'finance.cash_transfer.send',
      payload: { amountXaf: 100_000, localRef: 'RF-000007' },
    });
  });

  it('un bon de réception se charge sans bon de commande ; son unité est celle de base, jamais convertie en silence', async () => {
    const db = getDb();
    const SUPPLIER = '01900000-0000-7000-8000-0000000000f1';
    await db.projections.bulkPut([
      projection('procurement', 'SUPPLIER', SUPPLIER, {
        code: 'F-PROV',
        name: 'Provenderie du Littoral',
      }),
      // Le serveur refuse un produit non achetable (BR-APP-001) : le poulet de la fixture le devient pour cet essai.
      projection('product', 'PRODUCT', IDS.chicken, {
        code: 'POULET',
        name: 'Poulet de chair',
        category_id: IDS.zone,
        base_unit_code: 'U',
        is_sellable: true,
        is_purchasable: true,
        pricing_mode: 'PER_UNIT',
        status: 'ACTIVE',
      }),
    ]);
    const when = written(recent);
    const result = await planFor([
      {
        type: 'BR',
        numero: 'BR-000012',
        date: when,
        emplacement: 'PDV-YDE-POS',
        fournisseur: 'F-PROV',
        produit: 'POULET',
        unite: 'U',
        quantite: '20',
        prix: '300',
        bon_de_livraison: 'BL-FOUR-8841',
        notes: 'Sacs en bon état',
      },
      {
        type: 'BR',
        numero: 'BR-000013',
        date: when,
        emplacement: 'PDV-YDE-POS',
        fournisseur: 'F-PROV',
        produit: 'POULET',
        unite: 'PLATEAU',
        quantite: '2',
        prix: '300',
      },
    ]);
    expect(result.rows[0]!.issues).toEqual([]);
    expect(result.rows[0]!.commands[0]).toMatchObject({
      commandType: 'procurement.receipt.record',
      aggregateType: 'GOODS_RECEIPT',
      payload: {
        localRef: 'BR-000012',
        supplierId: SUPPLIER,
        locationId: IDS.pos,
        supplierDeliveryNoteRef: 'BL-FOUR-8841',
        observations: 'Sacs en bon état',
        lines: [{ productId: IDS.chicken, unitCode: 'U', qtyDeliveredBase: 20, unitCostXaf: 300 }],
      },
    });
    // « PLATEAU » est une unité de vente de l'œuf, pas du poulet : refusée.
    expect(result.rows[1]!.status).toBe('ERROR');
    expect(result.rows[1]!.issues.join(' ')).toMatch(/unité « PLATEAU » inconnue/);

    // Une unité de vente connue du produit mais autre que l'unité de base est refusée pour une réception : la quantité
    // et le prix d'une réception sont lus pour l'unité de base, une caisse de 12 donnerait un stock faux d'un facteur 12.
    await db.projections.put(
      projection('product_unit', 'PRODUCT_UNIT', '01900000-0000-7000-8000-0000000000f2', {
        product_id: IDS.chicken,
        unit_code: 'CAISSE',
        factor_to_base: '12.000000',
        is_sales_unit: true,
        is_purchase_unit: false,
        is_count_unit: false,
        is_active: true,
      }),
    );
    const crate = await planFor([
      {
        type: 'BR',
        numero: 'BR-000014',
        date: when,
        emplacement: 'PDV-YDE-POS',
        fournisseur: 'F-PROV',
        produit: 'POULET',
        unite: 'CAISSE',
        quantite: '2',
        prix: '3600',
      },
    ]);
    expect(crate.rows[0]!.status).toBe('ERROR');
    expect(crate.rows[0]!.issues.join(' ')).toMatch(
      /une réception s’écrit dans l’unité de base du produit \(« U »\), pas en « CAISSE »/,
    );
  });

  it('un transfert, une perte et une commande client se chargent depuis un fichier', async () => {
    const db = getDb();
    const STORE = '01900000-0000-7000-8000-0000000000f3';
    await db.projections.put(
      projection('location', 'LOCATION', STORE, {
        site_id: IDS.site,
        code: 'MAG-YDE',
        name: 'Magasin de Yaoundé',
        location_type: 'STORE',
        is_virtual: false,
        custody_mode: 'SHARED',
        custodian_user_id: null,
        designated_device_id: null,
        status: 'ACTIVE',
      }),
    );
    const when = written(recent);
    const result = await planFor([
      {
        type: 'BT',
        numero: 'BT-000023',
        date: when,
        emplacement: 'MAG-YDE',
        destination: 'PDV-YDE-POS',
        transporteur: 'Ali',
        notes: 'Réapprovisionnement',
        produit: 'OEUF',
        unite: 'U',
        quantite: '100',
      },
      { type: 'BT', numero: 'BT-000023', date: when, produit: 'POULET', quantite: '3' },
      {
        type: 'FP',
        numero: 'FP-000004',
        date: when,
        emplacement: 'PDV-YDE-POS',
        categorie: 'casse',
        produit: 'OEUF',
        quantite: '4',
        notes: 'Cageots tombés',
      },
      {
        type: 'CC',
        numero: 'CC-000031',
        date: when,
        emplacement: 'PDV-YDE-POS',
        client: '699 11 22 33',
        livraison_souhaitee: '30/12/2026',
        adresse_livraison: 'Marché Mokolo',
        produit: 'OEUF',
        quantite: '10',
      },
    ]);
    expect(result.rows.map((row) => [row.key, row.status, row.issues])).toEqual([
      ['BT BT-000023', 'READY', []],
      ['FP FP-000004', 'READY', []],
      ['CC CC-000031', 'READY', []],
    ]);
    const [transfer, loss, order] = result.rows.map((row) => row.commands[0]!);
    expect(transfer).toMatchObject({
      commandType: 'inventory.transfer.dispatch',
      payload: {
        fromLocationId: STORE,
        toLocationId: IDS.pos,
        carrierName: 'Ali',
        lines: [
          { productId: IDS.eggs, unitCode: 'U', quantityBase: 100 },
          { productId: IDS.chicken, unitCode: 'U', quantityBase: 3 },
        ],
      },
    });
    // Le transfert et la perte n'ont pas de champ pour le numéro de la pièce : il est cité dans le texte libre (AV-501).
    expect(JSON.stringify(transfer!.payload)).toContain('Pièce papier BT-000023');
    expect(loss).toMatchObject({
      commandType: 'inventory.loss.declare',
      payload: { locationId: IDS.pos, productId: IDS.eggs, category: 'CASSE', quantityBase: 4 },
    });
    expect(JSON.stringify(loss!.payload)).toContain('Pièce papier FP-000004');
    expect(order).toMatchObject({
      commandType: 'sales.order.place',
      payload: {
        localRef: 'CC-000031',
        customerId: IDS.customer,
        fulfilmentLocationId: IDS.pos,
        requestedDeliveryDate: '2026-12-30',
        deliveryAddress: 'Marché Mokolo',
        lines: [{ productId: IDS.eggs, quantity: 10, unitPriceXaf: 100 }],
      },
    });
  });

  it('une pièce déjà reportée depuis l’appareil n’est pas reportée deux fois', async () => {
    const when = written(recent);
    const result = await plan([`BV;BV-000142;${when};;PDV-YDE-POS;;;;OEUF;;1;;;;;;`], {
      reportedSlips: new Set(['BV|BV-000142']),
    });
    expect(result.rows[0]).toMatchObject({ status: 'EXISTS', commands: [] });
  });

  it('une pièce de plus de 24 h exige un motif : celui du fichier, à défaut le motif commun de l’écran', async () => {
    const when = written(old);
    const line = `RE;RE-000010;${when};;;;PDV-YDE;699 11 22 33;;;;;ESPECES;5000;;;`;
    const without = await plan([line]);
    expect(without.rows[0]!.status).toBe('ERROR');
    expect(without.rows[0]!.issues.join(' ')).toMatch(/plus de 24 h/);

    const common = await plan([line], { defaultBackdatedReason: 'Report du carnet de septembre' });
    expect(common.rows[0]!.status).toBe('READY');
    expect(common.rows[0]!.commands[0]!.backdatedReason).toBe('Report du carnet de septembre');

    const own = await plan(
      [
        `RE;RE-000010;${when};Carnet égaré puis retrouvé;;;PDV-YDE;699 11 22 33;;;;;ESPECES;5000;;;`,
      ],
      { defaultBackdatedReason: 'Report du carnet de septembre' },
    );
    expect(own.rows[0]!.commands[0]!.backdatedReason).toBe('Carnet égaré puis retrouvé');
  });

  it('une pièce d’aujourd’hui sans heure ne reçoit pas midi quand midi n’est pas venu (faux « dans le futur »)', async () => {
    const references = await loadSalesReferences(getDb());
    // Il est 08:30 ce jour-là : midi serait dans le futur.
    const morning = new Date(2026, 10, 4, 8, 30);
    const refs = buildImportRefs({
      references,
      userId: IDS.user,
      roles: ['VENDEUR_PDV'],
      now: morning,
    });
    const today = await planImport(
      SLIPS_ENTITY,
      parseCsv(`${HEADER}\nRE;RE-000300;04/11/2026;;;;PDV-YDE;699 11 22 33;;;;;ESPECES;5000;;;\n`),
      refs,
    );
    expect(today.rows[0]!.issues).toEqual([]);
    expect(new Date(today.rows[0]!.commands[0]!.occurredAt!).getTime()).toBe(morning.getTime());

    // Un jour passé sans heure reste à midi.
    const past = await planImport(
      SLIPS_ENTITY,
      parseCsv(
        `${HEADER}\nRE;RE-000301;02/11/2026;Report du carnet;;;PDV-YDE;699 11 22 33;;;;;ESPECES;5000;;;\n`,
      ),
      refs,
    );
    expect(past.rows[0]!.issues).toEqual([]);
    expect(new Date(past.rows[0]!.commands[0]!.occurredAt!).getTime()).toBe(
      new Date(2026, 10, 2, 12, 0).getTime(),
    );
  });

  it('chaque défaut est dit en français avec ce qu’il faut corriger', async () => {
    const when = written(recent);
    const result = await plan([
      // Emplacement et produit inconnus, unité inconnue.
      `BV;BV-1;${when};;Mars;;;;OEUF;;1;;;;;;`,
      `BV;BV-2;${when};;PDV-YDE-POS;;;;INCONNU;;1;;;;;;`,
      `BV;BV-3;${when};;PDV-YDE-POS;;;;OEUF;KG;1;;;;;;`,
      // Date invalide, type inconnu, livraison non chargeable, numéro absent.
      `BV;BV-4;31/02/2026;;PDV-YDE-POS;;;;OEUF;;1;;;;;;`,
      `ZZ;ZZ-1;${when};;;;;;;;;;;;;;`,
      `BL;BL-1;${when};;;;;;;;;;;;;;`,
      `RE;;${when};;;;PDV-YDE;699 11 22 33;;;;;ESPECES;100;;;`,
    ]);
    const issues = result.rows.map((row) => row.issues.join(' '));
    expect(issues[0]).toMatch(/Emplacement « Mars » inconnu/);
    expect(issues[1]).toMatch(/Produit « INCONNU » inconnu/);
    expect(issues[2]).toMatch(/unité « KG » inconnue/);
    expect(issues[3]).toMatch(/Date « 31\/02\/2026 » invalide/);
    expect(issues[4]).toMatch(/Type de pièce « ZZ » inconnu/);
    expect(issues[5]).toMatch(/bon de livraison \(BL\) se reporte pièce par pièce/);
    expect(issues[6]).toMatch(/Numéro de la pièce obligatoire/);
    expect(result.counts.ERROR).toBe(7);
  });

  it('les lignes d’une même pièce ne se contredisent pas ; une pièce à ligne unique n’en a qu’une', async () => {
    const when = written(recent);
    const result = await plan([
      `BV;BV-5;${when};;PDV-YDE-POS;;;;OEUF;;1;;;;;;`,
      `BV;BV-5;${when};;Autre emplacement;;;;POULET;;1;;;;;;`,
      `RE;RE-7;${when};;;;PDV-YDE;699 11 22 33;;;;;ESPECES;100;;;`,
      `RE;RE-7;${when};;;;PDV-YDE;699 11 22 33;;;;;ESPECES;100;;;`,
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.issues.join(' ')).toMatch(/Ligne 3 : « Emplacement » diffère/);
    expect(result.rows[1]!.issues.join(' ')).toMatch(/tient en une seule ligne/);
  });

  it('les lignes d’une même pièce se comparent à l’écriture près : un téléphone écrit autrement est signalé', async () => {
    const when = written(recent);
    const different = await planFor([
      {
        type: 'BV',
        numero: 'BV-000400',
        date: when,
        emplacement: 'PDV-YDE-POS',
        client: '699 11 22 33',
        produit: 'OEUF',
        quantite: '1',
      },
      // Même client, autre écriture (sans espaces) : signalé, le contrôle ne devine pas qu'il s'agit du même numéro.
      {
        type: 'BV',
        numero: 'BV-000400',
        date: when,
        client: '699112233',
        produit: 'POULET',
        quantite: '1',
      },
    ]);
    expect(different.rows[0]!.status).toBe('ERROR');
    expect(different.rows[0]!.issues.join(' ')).toMatch(/Ligne 3 : « Client » diffère/);

    // La casse et les espaces en trop ne comptent pas.
    const same = await planFor([
      {
        type: 'BV',
        numero: 'BV-000401',
        date: when,
        emplacement: 'PDV-YDE-POS',
        client: '699 11 22 33',
        produit: 'OEUF',
        quantite: '1',
      },
      {
        type: 'BV',
        numero: 'BV-000401',
        date: when,
        emplacement: 'pdv-yde-pos',
        client: '699  11 22  33',
        produit: 'POULET',
        quantite: '1',
      },
    ]);
    expect(same.rows[0]!.issues).toEqual([]);
    expect(same.rows[0]!.status).toBe('READY');
  });

  it('sans référentiels de l’appareil, rien n’est chargeable', async () => {
    const withoutContext: ImportRefs = { ...(await refsOf()) };
    delete (withoutContext as { slipContext?: unknown }).slipContext;
    const result = await planImport(
      SLIPS_ENTITY,
      parseCsv(`${HEADER}\nBV;BV-9;${written(recent)};;PDV-YDE-POS;;;;OEUF;;1;;;;;;\n`),
      withoutContext,
    );
    expect(result.rows[0]!.issues).toEqual(['Référentiels de l’appareil indisponibles.']);
  });
});
