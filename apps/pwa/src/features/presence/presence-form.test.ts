import { describe, expect, it } from 'vitest';
import {
  EMPTY_DAY,
  checkSheet,
  emptyLine,
  emptySheet,
  filledDays,
  isBlankLine,
  lineWorkedMinutes,
  recordPayload,
  serverLineMinutes,
  weekStartOfInput,
  type LineDraft,
  type SheetDraft,
} from './presence-form.js';

const WEEK = '2026-11-02'; // lundi
const SITE = '01900000-0000-7000-8000-000000000020';

function line(
  key: string,
  name: string,
  days: Partial<LineDraft['days'][number]>[] = [],
): LineDraft {
  const base = emptyLine(key);
  return {
    ...base,
    personName: name,
    days: base.days.map((day, index) => ({ ...day, ...(days[index] ?? {}) })),
  };
}

const sheet = (overrides: Partial<SheetDraft> = {}): SheetDraft => ({
  ...emptySheet(WEEK),
  siteId: SITE,
  lines: [line('a', 'Paul Essomba', [{ arrival: '07:45', departure: '16:30' }])],
  ...overrides,
});

describe('semaine du formulaire', () => {
  it('une date au milieu de la semaine ramène au lundi ; une saisie invalide garde la semaine', () => {
    expect(weekStartOfInput('2026-11-04', WEEK)).toBe('2026-11-02');
    expect(weekStartOfInput('2026-11-08', WEEK)).toBe('2026-11-02');
    expect(weekStartOfInput('2026-11-09', WEEK)).toBe('2026-11-09');
    expect(weekStartOfInput('', WEEK)).toBe(WEEK);
    expect(weekStartOfInput('2026-13-40', WEEK)).toBe(WEEK);
  });

  it('une année tapée au clavier passe par des valeurs absurdes sans déplacer la semaine ni lever d’exception', () => {
    // Chrome et Edge émettent « 0002-11-02 », « 0020-11-02 », « 0202-11-02 » avant « 2026-11-02 ».
    for (const raw of ['0002-11-02', '0020-11-02', '0202-11-02', '2019-12-30', '2101-01-04']) {
      expect(weekStartOfInput(raw, WEEK), raw).toBe(WEEK);
    }
    expect(weekStartOfInput('2026-02-30', WEEK)).toBe(WEEK);
    expect(weekStartOfInput('2026-11-04', WEEK)).toBe('2026-11-02');
  });
});

describe('lignes et jours', () => {
  it('une ligne sans nom ni jour est vide et ignorée', () => {
    expect(isBlankLine(emptyLine('a'))).toBe(true);
    expect(isBlankLine(line('a', 'Paul'))).toBe(false);
    expect(isBlankLine(line('a', '', [{ absence: 'R' }]))).toBe(false);
  });

  it('les jours renseignés portent leur date (lundi en tête) ; le total ignore absences et jours incomplets', () => {
    const l = line('a', 'Paul', [
      { arrival: '07:45', departure: '16:30' },
      { absence: 'M' },
      { arrival: '08:00' },
    ]);
    expect(filledDays(l, WEEK).map((d) => d.date)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
    expect(lineWorkedMinutes(l, WEEK)).toBe(525);
  });

  it('total d’une ligne reportée, lue du serveur', () => {
    expect(
      serverLineMinutes({
        lineNo: 1,
        personName: 'Paul',
        personRole: null,
        missionLabel: null,
        userId: null,
        days: [
          { date: '2026-11-02', arrival: '07:00', departure: '12:00', absenceCode: null },
          { date: '2026-11-03', arrival: null, departure: null, absenceCode: 'C' },
          { date: '2026-11-04', arrival: '13:00', departure: '16:30', absenceCode: 'ZZ' },
        ],
      }),
    ).toBe(300 + 210);
  });
});

describe('contrôle de la feuille', () => {
  it('une feuille complète est prête', () => {
    expect(checkSheet(sheet())).toEqual([]);
  });

  it('site manquant, semaine hors lundi, aucune personne', () => {
    const codes = (draft: SheetDraft) => checkSheet(draft).map((issue) => issue.code);
    expect(codes(sheet({ siteId: '' }))).toEqual(['SITE_REQUIRED']);
    expect(codes(sheet({ weekStart: '2026-11-03' }))).toEqual(['WEEK_NOT_MONDAY']);
    expect(codes(sheet({ lines: [emptyLine('a')] }))).toEqual(['NO_LINE']);
  });

  it('une semaine qui n’a pas commencé est refusée quand l’instant du report est connu, comme par le serveur', () => {
    const thursday = new Date('2026-11-05T09:00:00.000Z');
    const nextWeek = sheet({
      weekStart: '2026-11-09',
      lines: [line('a', 'Paul', [{ arrival: '07:45', departure: '16:30' }])],
    });
    expect(checkSheet(nextWeek, thursday).map((issue) => issue.code)).toEqual(['WEEK_IN_FUTURE']);
    // Sans instant, le contrôle ne juge que la forme de la feuille.
    expect(checkSheet(nextWeek)).toEqual([]);
    // La semaine en cours et les semaines passées se reportent.
    expect(checkSheet(sheet(), thursday)).toEqual([]);
    expect(checkSheet(sheet({ weekStart: '2026-10-26' }), thursday)).toEqual([]);
  });

  it('une ligne sans nom, sans jour ou en double est signalée avec son numéro', () => {
    expect(checkSheet(sheet({ lines: [line('a', '', [{ absence: 'R' }])] }))).toEqual([
      { code: 'NAME_REQUIRED', line: 1 },
    ]);
    expect(checkSheet(sheet({ lines: [line('a', 'Paul')] }))).toEqual([
      { code: 'NO_DAY', line: 1 },
    ]);
    const issues = checkSheet(
      sheet({
        lines: [
          line('a', 'Paul', [{ absence: 'R' }]),
          emptyLine('b'),
          line('c', ' paul ', [{ absence: 'R' }]),
        ],
      }),
    );
    expect(issues).toEqual([{ code: 'NAME_DUPLICATE', line: 3 }]);
  });

  it('un jour invalide remonte le message du domaine', () => {
    const issues = checkSheet(
      sheet({ lines: [line('a', 'Paul', [{ arrival: '16:30', departure: '07:45' }])] }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'DAY_INVALID', line: 1 });
    expect(issues[0]!.detail).toMatch(/départ/);
    // Un code d'absence avec des heures : le formulaire vide les heures à la sélection, mais le contrôle reste là.
    const both = checkSheet(
      sheet({ lines: [line('a', 'Paul', [{ arrival: '07:45', absence: 'A' }])] }),
    );
    expect(both[0]).toMatchObject({ code: 'DAY_INVALID' });
  });
});

describe('charge utile de fieldwork.presence.record', () => {
  it('lignes vides ignorées, textes vides à null, jours datés', () => {
    const payload = recordPayload(
      sheet({
        paperRef: ' 000042 ',
        responsibleName: '',
        lines: [
          {
            ...line('a', ' Paul Essomba ', [
              { arrival: '07:45', departure: '16:30' },
              { absence: 'M' },
            ]),
            personRole: 'Ouvrier',
          },
          emptyLine('b'),
        ],
      }),
    );
    expect(payload).toEqual({
      siteId: SITE,
      weekStart: WEEK,
      paperRef: '000042',
      responsibleName: null,
      lines: [
        {
          personName: 'Paul Essomba',
          personRole: 'Ouvrier',
          missionLabel: null,
          days: [
            { date: '2026-11-02', arrival: '07:45', departure: '16:30', absenceCode: null },
            { date: '2026-11-03', arrival: null, departure: null, absenceCode: 'M' },
          ],
        },
      ],
    });
  });

  it('un jour vide reste vide', () => {
    expect(EMPTY_DAY).toEqual({ arrival: '', departure: '', absence: '' });
  });
});
