/**
 * ECR-CRM-08 « Bilan hebdomadaire » (fiche BH ; PP-E, REQ-307, AV-314) : logique pure. Le commercial rédige cinq textes
 * pour une semaine (lundi au dimanche) ; les chiffres de la semaine sont calculés par le serveur (`GET /weekly-reports/figures`),
 * jamais saisis. Le bilan d'une semaine a un identifiant propre au couple (commercial, semaine) : l'envoyer de nouveau est une
 * correction (tant que le responsable ne l'a pas vu), jamais un doublon.
 */
import {
  WEEKLY_REPORT_TEXT_FIELDS,
  WEEKLY_REPORT_TEXT_MAX,
  addBusinessDays,
  hasWeeklyReportContent,
  mondayOf,
  normalizeWeeklyReportTexts,
  type WeeklyFigures,
  type WeeklyReportStatus,
  type WeeklyReportTextField,
} from '@gic/domain';
import type { OutboxCommand } from '../../storage/db.js';
import { authorImportId } from '../import/ids.js';

export { WEEKLY_REPORT_TEXT_FIELDS, WEEKLY_REPORT_TEXT_MAX };
export type { WeeklyFigures, WeeklyReportTextField };

export const WEEKLY_REPORT_SUBMIT = 'crm.weekly_report.submit';
export const WEEKLY_REPORT_REVIEW = 'crm.weekly_report.review';

/** Bilan lu du serveur (`GET /weekly-reports`). */
export interface ServerWeeklyReport {
  readonly id: string;
  readonly userId: string;
  readonly weekStart: string;
  readonly successes: string | null;
  readonly difficulties: string | null;
  readonly needs: string | null;
  readonly priorities: string | null;
  readonly marketInfo: string | null;
  readonly status: WeeklyReportStatus;
  readonly lastEditedAt: string;
  readonly reviewedAt: string | null;
  readonly reviewedBy: string | null;
  readonly managerComment: string | null;
  readonly version: number;
}

/** Textes du formulaire : une chaîne par rubrique, vide par défaut. */
export type ReportDraft = { readonly [field in WeeklyReportTextField]: string };

export const EMPTY_REPORT_DRAFT: ReportDraft = {
  successes: '',
  difficulties: '',
  needs: '',
  priorities: '',
  marketInfo: '',
};

/** Lundi de la semaine en cours. */
export const currentWeek = (today: string): string => mondayOf(today);
export const previousWeek = (weekStart: string): string => addBusinessDays(weekStart, -7);
export const nextWeek = (weekStart: string): string => addBusinessDays(weekStart, 7);

/** Identifiant du bilan d'un commercial pour une semaine : le même à chaque envoi, donc une correction n'est pas un doublon. */
export function weeklyReportId(userId: string, weekStart: string): Promise<string> {
  return authorImportId(userId, 'weekly-report', weekStart);
}

export function draftFromTexts(
  texts: Partial<Record<WeeklyReportTextField, string | null>>,
): ReportDraft {
  return {
    successes: texts.successes ?? '',
    difficulties: texts.difficulties ?? '',
    needs: texts.needs ?? '',
    priorities: texts.priorities ?? '',
    marketInfo: texts.marketInfo ?? '',
  };
}

export const draftFromReport = (report: ServerWeeklyReport): ReportDraft => draftFromTexts(report);

/**
 * Empreinte courte des textes d'un brouillon : elle entre dans la clé de la pièce imprimée, pour qu'un bilan corrigé
 * (même identifiant, autres textes) ne s'imprime pas « DUPLICATA » du précédent.
 */
export function draftFingerprint(draft: ReportDraft): string {
  const text = WEEKLY_REPORT_TEXT_FIELDS.map((field) => draft[field].trim()).join('\u0001');
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** Vrai quand le formulaire est prêt à partir : au moins une rubrique renseignée. */
export const isDraftReady = (draft: ReportDraft): boolean => hasWeeklyReportContent(draft);

/** Charge utile de `crm.weekly_report.submit` (textes vides omis). */
export function reportPayload(weekStart: string, draft: ReportDraft) {
  const texts = normalizeWeeklyReportTexts(draft);
  return {
    weekStart,
    ...Object.fromEntries(
      WEEKLY_REPORT_TEXT_FIELDS.flatMap((field) =>
        texts[field] === null ? [] : [[field, texts[field]]],
      ),
    ),
  } as { weekStart: string } & Partial<Record<WeeklyReportTextField, string>>;
}

const isAccepted = (command: Pick<OutboxCommand, 'status'>): boolean =>
  command.status === 'SYNCED' || command.status === 'SYNCED_WITH_WARNING';

/** Dernière rédaction du bilan dans l'outbox de l'appareil, hors celles que le serveur a refusées. */
function lastReportCommand(
  outbox: readonly OutboxCommand[],
  aggregateId: string,
): OutboxCommand | undefined {
  return outbox
    .filter(
      (command) =>
        command.command_type === WEEKLY_REPORT_SUBMIT &&
        command.aggregate_id === aggregateId &&
        command.status !== 'REJECTED',
    )
    .sort((a, b) => a.device_seq - b.device_seq)
    .at(-1);
}

/**
 * Dernière rédaction du bilan encore dans l'outbox de l'appareil (en attente d'envoi, ou envoyée mais pas encore relue du
 * serveur) : elle prime sur ce que le serveur sait, qui est plus ancien. Une rédaction refusée ne compte jamais (le bilan
 * déjà vu, par exemple, reste le texte figé). Une rédaction déjà acceptée n'est retenue que si elle est plus récente que le
 * bilan lu du serveur : corrigé depuis un autre appareil, c'est le serveur qui fait foi.
 */
export function pendingReportDraft(
  outbox: readonly OutboxCommand[],
  aggregateId: string,
  server?: Pick<ServerWeeklyReport, 'lastEditedAt'>,
): ReportDraft | undefined {
  const last = lastReportCommand(outbox, aggregateId);
  if (!last) return undefined;
  if (
    server !== undefined &&
    isAccepted(last) &&
    Date.parse(last.occurred_at) <= Date.parse(server.lastEditedAt)
  ) {
    return undefined;
  }
  const payload = last.payload as Partial<Record<WeeklyReportTextField, string | null>> | null;
  return draftFromTexts(payload ?? {});
}

/**
 * Vrai si la dernière rédaction du bilan n'est pas encore partie ou acceptée : un brouillon local, qui s'envoie même
 * sans avoir relu le serveur (écrire hors ligne reste possible).
 */
export function hasUnsentReport(outbox: readonly OutboxCommand[], aggregateId: string): boolean {
  const last = lastReportCommand(outbox, aggregateId);
  return last !== undefined && !isAccepted(last);
}

/** Chiffres de la semaine lus du serveur (`GET /weekly-reports/figures`). */
export interface ServerFigures {
  readonly user_id: string;
  readonly week_start: string;
  readonly figures: WeeklyFigures;
}
