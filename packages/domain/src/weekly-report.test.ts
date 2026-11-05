import { describe, expect, it } from 'vitest';
import {
  WEEKLY_REPORT_TEXT_FIELDS,
  hasWeeklyReportContent,
  normalizeWeeklyReportTexts,
  weeklyReportWeekIssue,
} from './weekly-report.js';

describe('contenu d’un bilan hebdomadaire', () => {
  it('compte les cinq textes de la fiche BH', () => {
    expect(WEEKLY_REPORT_TEXT_FIELDS).toEqual([
      'successes',
      'difficulties',
      'needs',
      'priorities',
      'marketInfo',
    ]);
  });

  it('exige au moins un texte qui dit quelque chose', () => {
    expect(hasWeeklyReportContent({})).toBe(false);
    expect(hasWeeklyReportContent({ successes: '   ', needs: null })).toBe(false);
    expect(hasWeeklyReportContent({ priorities: 'Relancer Bonabéri' })).toBe(true);
  });

  it('range les textes : rognés, les vides ramenés à null', () => {
    expect(
      normalizeWeeklyReportTexts({
        successes: '  deux commandes  ',
        difficulties: '',
        needs: '   ',
      }),
    ).toEqual({
      successes: 'deux commandes',
      difficulties: null,
      needs: null,
      priorities: null,
      marketInfo: null,
    });
  });
});

describe('semaine d’un bilan', () => {
  // 2026-11-04 (mercredi, 12 h à Douala) : la semaine en cours commence le lundi 2026-11-02.
  const NOW = new Date('2026-11-04T11:00:00.000Z');

  it('accepte la semaine en cours et les semaines passées', () => {
    expect(weeklyReportWeekIssue('2026-11-02', NOW)).toBeNull();
    expect(weeklyReportWeekIssue('2026-10-26', NOW)).toBeNull();
  });

  it('refuse une semaine à venir', () => {
    expect(weeklyReportWeekIssue('2026-11-09', NOW)).toMatch(/avant cette semaine/);
  });

  it('refuse une semaine qui ne commence pas un lundi', () => {
    expect(weeklyReportWeekIssue('2026-11-03', NOW)).toMatch(/lundi/);
    expect(weeklyReportWeekIssue('pas-une-date', NOW)).toMatch(/lundi/);
  });

  it('juge la semaine à l’heure de Douala : dimanche 23 h 30 UTC est déjà lundi', () => {
    // 2026-11-08 22:30 UTC = lundi 2026-11-09 23:30 à Douala (UTC+1) ? Non : dimanche 22:30 UTC + 1 h = 23:30 dimanche.
    expect(
      weeklyReportWeekIssue('2026-11-09', new Date('2026-11-08T22:30:00.000Z')),
    ).not.toBeNull();
    // 23:30 UTC dimanche = 00:30 lundi à Douala : la semaine du 09/11 est la semaine en cours.
    expect(weeklyReportWeekIssue('2026-11-09', new Date('2026-11-08T23:30:00.000Z'))).toBeNull();
  });
});
