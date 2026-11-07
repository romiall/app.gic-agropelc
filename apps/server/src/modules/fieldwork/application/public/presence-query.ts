/**
 * Lecture des feuilles de présence du personnel (PP-E ; REQ-306, AV-313) : une feuille hebdomadaire d'un site et ses
 * lignes (une par personne, avec ses jours). API publique de `fieldwork` ; la portée (site) est jugée par la couche
 * transport, élément par élément.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { clockHhmm } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const PRESENCE_LIST_DEFAULT_LIMIT = 50;
export const PRESENCE_LIST_MAX_LIMIT = 100;

export interface PresenceDaySummary {
  /** Jour métier `AAAA-MM-JJ`. */
  readonly date: string;
  /** `HH:MM`. */
  readonly arrival: string | null;
  readonly departure: string | null;
  readonly absenceCode: string | null;
}

export interface PresenceLineSummary {
  readonly lineNo: number;
  readonly personName: string;
  readonly personRole: string | null;
  readonly missionLabel: string | null;
  readonly userId: string | null;
  readonly days: readonly PresenceDaySummary[];
}

export interface PresenceSheetSummary {
  readonly id: string;
  readonly siteId: string;
  /** Lundi de la semaine, `AAAA-MM-JJ`. */
  readonly weekStart: string;
  readonly paperRef: string | null;
  readonly responsibleName: string | null;
  readonly status: string;
  readonly recordedAt: Date;
  readonly cancelledAt: Date | null;
  readonly cancelComment: string | null;
  readonly lines: readonly PresenceLineSummary[];
}

function dateOnly(value: Date): string {
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${value.getUTCFullYear()}-${month}-${day}`;
}

export interface PresenceSheetFilter {
  /** Feuilles désignées (projection du jeu `presence`) ; vide : rien à lire ; absent : toutes. */
  readonly ids?: readonly string[];
  /** Sites lus ; vide : rien à lire ; absent : tous. */
  readonly siteIds?: readonly string[];
  /** Semaine exacte (lundi). */
  readonly weekStart?: string;
  /** Bornes de semaines (lundis), incluses. */
  readonly fromWeek?: string;
  readonly toWeek?: string;
  readonly includeCancelled?: boolean;
  readonly limit?: number;
}

/** Feuilles, les plus récentes d'abord (semaine puis heure de saisie), avec leurs lignes. */
export async function listPresenceSheets(
  executor: Executor,
  filter: PresenceSheetFilter,
): Promise<readonly PresenceSheetSummary[]> {
  if (filter.siteIds !== undefined && filter.siteIds.length === 0) return [];
  if (filter.ids !== undefined && filter.ids.length === 0) return [];
  const limit = Math.min(filter.limit ?? PRESENCE_LIST_DEFAULT_LIMIT, PRESENCE_LIST_MAX_LIMIT);
  const sheets = await executor
    .selectFrom('fieldwork_presence_sheets')
    .selectAll()
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        'site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.ids !== undefined, (qb) =>
      qb.where(
        'id',
        'in',
        filter.ids!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.weekStart !== undefined, (qb) =>
      qb.where(sql<boolean>`week_start = ${filter.weekStart!}`),
    )
    .$if(filter.fromWeek !== undefined, (qb) =>
      qb.where(sql<boolean>`week_start >= ${filter.fromWeek!}`),
    )
    .$if(filter.toWeek !== undefined, (qb) =>
      qb.where(sql<boolean>`week_start <= ${filter.toWeek!}`),
    )
    .$if(filter.includeCancelled !== true, (qb) => qb.where('status', '=', 'RECORDED'))
    .orderBy('week_start', 'desc')
    .orderBy('occurred_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  if (sheets.length === 0) return [];
  const rows = await executor
    .selectFrom('fieldwork_staff_presence')
    .selectAll()
    .where(
      'sheet_id',
      'in',
      sheets.map((sheet) => sheet.id),
    )
    .orderBy('line_no', 'asc')
    .orderBy('presence_date', 'asc')
    .execute();
  const linesBySheet = new Map<
    string,
    Map<number, PresenceLineSummary & { days: PresenceDaySummary[] }>
  >();
  for (const row of rows) {
    const sheetKey = fromBin(row.sheet_id);
    let lines = linesBySheet.get(sheetKey);
    if (!lines) {
      lines = new Map();
      linesBySheet.set(sheetKey, lines);
    }
    let line = lines.get(row.line_no);
    if (!line) {
      line = {
        lineNo: row.line_no,
        personName: row.person_name,
        personRole: row.person_role,
        missionLabel: row.mission_label,
        userId: fromBinOrNull(row.user_id),
        days: [],
      };
      lines.set(row.line_no, line);
    }
    line.days.push({
      date: dateOnly(row.presence_date),
      arrival: clockHhmm(row.arrival_time),
      departure: clockHhmm(row.departure_time),
      absenceCode: row.absence_code,
    });
  }
  return sheets.map((sheet) => ({
    id: fromBin(sheet.id),
    siteId: fromBin(sheet.site_id),
    weekStart: dateOnly(sheet.week_start),
    paperRef: sheet.paper_ref,
    responsibleName: sheet.responsible_name,
    status: sheet.status,
    recordedAt: sheet.occurred_at,
    cancelledAt: sheet.cancelled_at,
    cancelComment: sheet.cancel_comment,
    lines: [...(linesBySheet.get(fromBin(sheet.id))?.values() ?? [])],
  }));
}
