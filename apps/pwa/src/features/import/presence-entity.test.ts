/**
 * Chargement de la présence du personnel par fichier (PP-E ; AV-313, AV-317) : une ligne par personne, les jours en
 * colonnes ; les lignes d'une même feuille forment une feuille, avec les contrôles de l'écran « Présence du personnel ».
 */
import { isUuidv7 } from '@gic/domain';
import { describe, expect, it } from 'vitest';
import { ROLE_SETS } from '../../app/screens.js';
import { parseCsv } from './csv.js';
import { IMPORT_ENTITIES } from './entities.js';
import { planImport } from './model.js';
import { PRESENCE_ENTITY, parseClock, parseDay } from './presence-entity.js';
import { EMPTY_IMPORT_REFS, type ImportRefs } from './refs.js';

const AUTHOR = '01900000-0000-7000-8000-0000000000aa';
const SITE = '01900000-0000-7000-8000-000000000020';

const refs = (overrides: Partial<ImportRefs> = {}): ImportRefs => ({
  ...EMPTY_IMPORT_REFS,
  authorUserId: AUTHOR,
  sites: [{ id: SITE, code: 'FERME-BON', name: 'Ferme de Bonabéri' }],
  ...overrides,
});

const HEADER =
  'Site;Semaine du;Feuille N°;Responsable;Nom et prénom;Fonction;Zone / mission;Lun arrivée;Lun départ;Mar arrivée;Mar départ;Sam arrivée;Sam départ';
const plan = (rows: string[], context: ImportRefs = refs()) =>
  planImport(PRESENCE_ENTITY, parseCsv([HEADER, ...rows].join('\n')), context);

describe('lecture des cellules', () => {
  it('jours en jj/mm/aaaa, jj/mm/aa ou aaaa-mm-jj ; refus du reste', () => {
    expect(parseDay('02/11/2026')).toBe('2026-11-02');
    expect(parseDay('2/11/26')).toBe('2026-11-02');
    expect(parseDay('2026-11-04')).toBe('2026-11-04');
    expect(parseDay('31/02/2026')).toBeNull();
    expect(parseDay('lundi')).toBeNull();
  });

  it('heures en 07:45, 7:45, 07h45 ou 07 h 45 ; refus du reste', () => {
    expect(parseClock('07:45')).toBe('07:45');
    expect(parseClock('7:45')).toBe('07:45');
    expect(parseClock('07h45')).toBe('07:45');
    expect(parseClock('07 h 45')).toBe('07:45');
    expect(parseClock('8h')).toBe('08:00');
    expect(parseClock('25:00')).toBeNull();
    expect(parseClock('tard')).toBeNull();
  });

  it('heure au format « Heure » d’Excel (08:30:00) : les secondes sont ignorées', () => {
    expect(parseClock('08:30:00')).toBe('08:30');
    expect(parseClock('8:30:00')).toBe('08:30');
    expect(parseClock('16:05:59')).toBe('16:05');
    expect(parseClock('08:30:75')).toBeNull();
  });

  it('une année hors du siècle plausible n’est pas une date (saisie « 0002 » en tête de frappe)', () => {
    expect(parseDay('0002-11-02')).toBeNull();
    expect(parseDay('1999-11-02')).toBeNull();
    expect(parseDay('2101-01-04')).toBeNull();
    expect(parseDay('2026-11-02')).toBe('2026-11-02');
  });
});

describe('feuille de présence', () => {
  it('les lignes d’une même feuille forment une commande, un jour au milieu de la semaine ramené au lundi', async () => {
    const result = await plan([
      'Ferme de Bonabéri;04/11/2026;000042;Joseph Ngo Bayiha;Paul Essomba;Ouvrier;Poulailler B2;07:45;16:30;M;;07h00;12h00',
      'Ferme de Bonabéri;04/11/2026;000042;;Rose Atangana;;;18:00;23:30;;;;',
    ]);
    expect(result.counts).toEqual({ READY: 1, EXISTS: 0, ERROR: 0, DUPLICATE_IN_FILE: 0 });
    const [command] = result.rows[0]!.commands;
    expect(command).toMatchObject({
      commandType: 'fieldwork.presence.record',
      aggregateType: 'PRESENCE_SHEET',
      payload: {
        siteId: SITE,
        weekStart: '2026-11-02',
        paperRef: '000042',
        responsibleName: 'Joseph Ngo Bayiha',
        lines: [
          {
            personName: 'Paul Essomba',
            personRole: 'Ouvrier',
            missionLabel: 'Poulailler B2',
            days: [
              { date: '2026-11-02', arrival: '07:45', departure: '16:30', absenceCode: null },
              { date: '2026-11-03', arrival: null, departure: null, absenceCode: 'M' },
              { date: '2026-11-07', arrival: '07:00', departure: '12:00', absenceCode: null },
            ],
          },
          {
            personName: 'Rose Atangana',
            personRole: null,
            missionLabel: null,
            days: [{ date: '2026-11-02', arrival: '18:00', departure: '23:30', absenceCode: null }],
          },
        ],
      },
    });
    expect(isUuidv7(command!.aggregateId)).toBe(true);
  });

  it('deux feuilles de numéros différents sont deux commandes ; recharger le même contenu donne le même identifiant', async () => {
    const rows = [
      'FERME-BON;02/11/2026;1;;Paul;;;07:00;16:00;;;;',
      'FERME-BON;02/11/2026;2;;Rose;;;18:00;23:30;;;;',
    ];
    const first = await plan(rows);
    expect(first.counts.READY).toBe(2);
    const second = await plan(rows);
    expect(second.rows.map((r) => r.commands[0]!.aggregateId)).toEqual(
      first.rows.map((r) => r.commands[0]!.aggregateId),
    );
    expect(first.rows[0]!.commands[0]!.aggregateId).not.toBe(
      first.rows[1]!.commands[0]!.aggregateId,
    );
  });

  it('une feuille déjà dans la file de l’appareil n’est pas reportée de nouveau', async () => {
    const rows = ['FERME-BON;02/11/2026;1;;Paul;;;07:00;16:00;;;;'];
    const [command] = (await plan(rows)).rows[0]!.commands;
    const again = await plan(
      rows,
      refs({ pendingPresenceSheets: new Set([command!.aggregateId]) }),
    );
    expect(again.counts).toEqual({ READY: 0, EXISTS: 1, ERROR: 0, DUPLICATE_IN_FILE: 0 });
  });

  it('site inconnu, semaine invalide, heure invalide, départ avant l’arrivée, nom absent, personne en double', async () => {
    const issuesOf = async (row: string) => (await plan([row])).rows[0]!.issues.join(' | ');
    expect(await issuesOf('Nulle part;02/11/2026;;;Paul;;;07:00;16:00;;;;')).toMatch(
      /Site inconnu/,
    );
    expect(await issuesOf('FERME-BON;lundi;;;Paul;;;07:00;16:00;;;;')).toMatch(/Semaine invalide/);
    expect(await issuesOf('FERME-BON;02/11/2026;;;Paul;;;tard;16:00;;;;')).toMatch(
      /arrivée « tard » invalide/,
    );
    expect(await issuesOf('FERME-BON;02/11/2026;;;Paul;;;16:00;07:00;;;;')).toMatch(
      /départ doit suivre/,
    );
    expect(await issuesOf('FERME-BON;02/11/2026;;;;;;07:00;16:00;;;;')).toMatch(/nom manquant/);
    expect(await issuesOf('FERME-BON;02/11/2026;;;Paul;;;;;;;;')).toMatch(/aucun jour renseigné/);
    expect(await issuesOf('FERME-BON;02/11/2026;;;Paul;;;M;16:00;;;;')).toMatch(/code d’absence/);
    const dup = await plan([
      'FERME-BON;02/11/2026;1;;Paul;;;07:00;16:00;;;;',
      'FERME-BON;02/11/2026;1;;paul;;;07:00;16:00;;;;',
    ]);
    expect(dup.rows[0]!.issues.join(' | ')).toMatch(/figure déjà sur la feuille/);
    expect(dup.counts.ERROR).toBe(1);
  });

  it('colonnes obligatoires absentes : rien n’est chargeable', async () => {
    const result = await planImport(PRESENCE_ENTITY, parseCsv('Nom et prénom\nPaul'), refs());
    expect(result.missingColumns).toEqual(['Site', 'Semaine du']);
  });

  it('une même feuille écrite autrement (code ou nom du site, autre jour de la semaine) reste une seule commande', async () => {
    const result = await plan([
      'FERME-BON;02/11/2026;42;;Paul;;;07:00;16:00;;;;',
      'Ferme de Bonabéri;04/11/2026;42;;Rose;;;18:00;23:30;;;;',
      'ferme de bonaberi;2/11/26;42;;Marie;;;07:00;12:00;;;;',
    ]);
    // « ferme de bonaberi » (sans accent ni majuscule) désigne le même site que le nom et que le code.
    expect(result.counts).toEqual({ READY: 1, EXISTS: 0, ERROR: 0, DUPLICATE_IN_FILE: 0 });
    const payload = result.rows[0]!.commands[0]!.payload as { lines: unknown[] };
    expect(payload.lines).toHaveLength(3);
  });

  it('une heure au format « Heure » d’Excel (08:30:00) est lue', async () => {
    const result = await plan(['FERME-BON;02/11/2026;1;;Paul;;;08:30:00;16:00:00;;;;']);
    expect(result.counts.READY).toBe(1);
    expect(result.rows[0]!.commands[0]!.payload).toMatchObject({
      lines: [{ days: [{ date: '2026-11-02', arrival: '08:30', departure: '16:00' }] }],
    });
  });

  it('le responsable entre dans l’identifiant : une feuille rechargée avec un autre responsable est une autre feuille', async () => {
    const first = await plan(['FERME-BON;02/11/2026;1;Joseph;Paul;;;07:00;16:00;;;;']);
    const second = await plan(['FERME-BON;02/11/2026;1;Josephine;Paul;;;07:00;16:00;;;;']);
    expect(first.rows[0]!.commands[0]!.aggregateId).not.toBe(
      second.rows[0]!.commands[0]!.aggregateId,
    );
  });

  it('les lignes recopiées de la feuille sans personne ni jour sont ignorées ; une feuille sans personne est refusée', async () => {
    const kept = await plan([
      'FERME-BON;02/11/2026;1;;Paul;;;07:00;16:00;;;;',
      'FERME-BON;02/11/2026;1;;;;;;;;;;',
    ]);
    expect(kept.counts).toEqual({ READY: 1, EXISTS: 0, ERROR: 0, DUPLICATE_IN_FILE: 0 });
    const payload = kept.rows[0]!.commands[0]!.payload as { lines: unknown[] };
    expect(payload.lines).toHaveLength(1);
    const none = await plan(['FERME-BON;02/11/2026;1;;;;;;;;;;']);
    expect(none.rows[0]!.issues.join(' | ')).toMatch(/Aucune personne/);
  });

  it('une semaine invalide est signalée une fois, sans « aucun jour renseigné » pour chaque ligne', async () => {
    const result = await plan([
      'FERME-BON;lundi;1;;Paul;;;07:00;16:00;;;;',
      'FERME-BON;lundi;1;;Rose;;;07:00;16:00;;;;',
    ]);
    const issues = result.rows[0]!.issues;
    expect(issues.filter((issue) => /Semaine invalide/.test(issue))).toHaveLength(1);
    expect(issues.some((issue) => /aucun jour/.test(issue))).toBe(false);
  });

  it('plus de 50 personnes sur une feuille : à scinder', async () => {
    const rows = Array.from(
      { length: 51 },
      (_, index) => `FERME-BON;02/11/2026;1;;Personne ${index + 1};;;07:00;16:00;;;;`,
    );
    const result = await plan(rows);
    expect(result.rows[0]!.issues.join(' | ')).toMatch(/Plus de 50 personnes/);
    expect(result.counts.ERROR).toBe(1);
  });

  it('le dimanche se charge (colonnes Dim arrivée et Dim départ)', async () => {
    const result = await planImport(
      PRESENCE_ENTITY,
      parseCsv(
        [
          `${HEADER};Dim arrivée;Dim départ`,
          'FERME-BON;02/11/2026;1;;Paul;;;07:00;16:00;;;;;08:00;12:00',
        ].join('\n'),
      ),
      refs(),
    );
    expect(result.counts.READY).toBe(1);
    expect(result.rows[0]!.commands[0]!.payload).toMatchObject({
      lines: [
        {
          days: expect.arrayContaining([
            { date: '2026-11-08', arrival: '08:00', departure: '12:00', absenceCode: null },
          ]),
        },
      ],
    });
  });

  it('une semaine qui n’a pas commencé est refusée quand l’instant du contrôle est connu', async () => {
    const withClock = refs({
      slipContext: {
        refs: {} as never,
        userId: AUTHOR,
        roles: null,
        now: new Date('2026-11-05T09:00:00.000Z'),
      },
    });
    const future = await plan(['FERME-BON;09/11/2026;1;;Paul;;;07:00;16:00;;;;'], withClock);
    expect(future.rows[0]!.issues.join(' | ')).toMatch(/pas avant cette semaine/);
    const current = await plan(['FERME-BON;04/11/2026;1;;Paul;;;07:00;16:00;;;;'], withClock);
    expect(current.counts.READY).toBe(1);
  });
});

describe('type de chargement', () => {
  it('proposé aux rôles de l’écran de présence, après les pièces papier', () => {
    expect(IMPORT_ENTITIES.map((entity) => entity.id)).toContain('presence');
    expect(PRESENCE_ENTITY.roles).toEqual(ROLE_SETS.presence);
    expect(PRESENCE_ENTITY.columns.map((c) => c.key)).toContain('dim_depart');
  });
});
