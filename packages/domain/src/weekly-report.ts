/**
 * Bilan hebdomadaire du commercial (PP-E ; REQ-307, AV-314) : règles pures, identiques sur l'appareil et sur le
 * serveur.
 *
 * - Un bilan par commercial et par semaine (lundi au dimanche, jours métier de Douala). Il se rédige pendant la
 *   semaine ou après, jamais pour une semaine à venir.
 * - Cinq textes libres, repris de la fiche papier BH : réussites, difficultés, besoins et demandes à la direction,
 *   priorités de la semaine suivante, informations du marché. Au moins un est renseigné.
 * - Les **chiffres** de la fiche (visites sur place, nouveaux prospects et clients, chiffre d'affaires, encaissé,
 *   casses et pertes) ne sont jamais saisis : la lecture les calcule (`WeeklyFigures`, rempli par le serveur).
 * - Le commercial corrige son bilan tant que le responsable ne l'a pas vu ; ensuite il est figé (statut `REVIEWED`).
 */
import { businessDayOf } from './business-day.js';
import { isMondayBusinessDay, mondayOf } from './staff-presence.js';

export const WEEKLY_REPORT_TEXT_FIELDS = [
  'successes',
  'difficulties',
  'needs',
  'priorities',
  'marketInfo',
] as const;
export type WeeklyReportTextField = (typeof WEEKLY_REPORT_TEXT_FIELDS)[number];

/** Longueur maximale de chaque texte du bilan et du commentaire du responsable. */
export const WEEKLY_REPORT_TEXT_MAX = 2000;

export const WEEKLY_REPORT_STATUSES = ['SUBMITTED', 'REVIEWED'] as const;
export type WeeklyReportStatus = (typeof WEEKLY_REPORT_STATUSES)[number];

export type WeeklyReportTexts = {
  readonly [field in WeeklyReportTextField]?: string | null | undefined;
};

/** Vrai si au moins un des cinq textes porte du contenu. */
export function hasWeeklyReportContent(texts: WeeklyReportTexts): boolean {
  return WEEKLY_REPORT_TEXT_FIELDS.some((field) => (texts[field] ?? '').trim() !== '');
}

/** Textes d'un bilan, rognés, les vides ramenés à `null` (forme enregistrée). */
export function normalizeWeeklyReportTexts(
  texts: WeeklyReportTexts,
): Record<WeeklyReportTextField, string | null> {
  const clean = (value: string | null | undefined): string | null => {
    const trimmed = (value ?? '').trim();
    return trimmed === '' ? null : trimmed;
  };
  return {
    successes: clean(texts.successes),
    difficulties: clean(texts.difficulties),
    needs: clean(texts.needs),
    priorities: clean(texts.priorities),
    marketInfo: clean(texts.marketInfo),
  };
}

/**
 * Contrôle de la semaine d'un bilan écrit à l'instant `writtenAt` : un lundi, et pas après la semaine en cours.
 * `null` si valable, sinon le motif en français.
 */
export function weeklyReportWeekIssue(weekStart: string, writtenAt: Date): string | null {
  if (!isMondayBusinessDay(weekStart)) {
    return `La semaine d'un bilan commence un lundi (${weekStart}).`;
  }
  if (weekStart > mondayOf(businessDayOf(writtenAt))) {
    return `Le bilan de la semaine du ${weekStart} ne s'écrit pas avant cette semaine.`;
  }
  return null;
}

/**
 * Chiffres de la semaine d'un commercial, calculés à la lecture (jamais saisis) :
 * - `visits` : visites enregistrées (non annulées) ;
 * - `newProspects` : comptes créés par le commercial (hors comptes fusionnés) ;
 * - `newCustomers` : conversions en client dont il était le titulaire ;
 * - `salesXaf` : chiffre d'affaires net des ventes qui lui sont attribuées (annulations retranchées) ;
 * - `collectedXaf` : encaissements qu'il a reçus, nets des annulations ;
 * - `lossDeclarations` et `lossValueXaf` : pertes qu'il a déclarées ; la valeur est au coût, donc `null` sans le droit
 *   de valorisation (RC-05).
 */
export interface WeeklyFigures {
  readonly visits: number;
  readonly newProspects: number;
  readonly newCustomers: number;
  readonly salesXaf: number;
  readonly collectedXaf: number;
  readonly lossDeclarations: number;
  readonly lossValueXaf: number | null;
}
