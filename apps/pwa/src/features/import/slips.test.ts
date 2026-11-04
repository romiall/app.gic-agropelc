/**
 * Chargement par lots des pièces papier (PP-C ; REQ-303, AV-317, AV-508, AV-078) : du CSV à la commande, avec les vrais
 * référentiels de l'appareil (projections posées dans la base locale) et la résolution de l'écran de report. Rien n'est
 * mocké : une pièce du fichier donne la commande que l'écran « Reporter une pièce papier » aurait produite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../storage/db.js';
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
import { importEntityId } from './ids.js';
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

async function refsOf(roles: readonly string[] = ['VENDEUR_PDV']): Promise<ImportRefs> {
  const references = await loadSalesReferences(getDb());
  return buildImportRefs({ references, userId: IDS.user, roles, now: new Date() });
}

const plan = async (rows: string[], overrides: Partial<ImportRefs> = {}) =>
  planImport(SLIPS_ENTITY, parseCsv(`${HEADER}\n${rows.join('\n')}\n`), {
    ...(await refsOf()),
    ...overrides,
  });

describe('parseSlipDate', () => {
  it('lit JJ/MM/AAAA et AAAA-MM-JJ, avec ou sans heure (midi à défaut)', () => {
    expect(parseSlipDate('14/10/2026 09:30')).toEqual({ day: '2026-10-14', time: '09:30' });
    expect(parseSlipDate('2026-10-14')).toEqual({ day: '2026-10-14', time: '12:00' });
    expect(parseSlipDate('2026-10-14T07:05')).toEqual({ day: '2026-10-14', time: '07:05' });
    expect(parseSlipDate('3.1.2026 8h15')).toEqual({ day: '2026-01-03', time: '08:15' });
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
    expect(command!.aggregateId).toBe(await importEntityId('slip', 'BV|BV-000142'));
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
