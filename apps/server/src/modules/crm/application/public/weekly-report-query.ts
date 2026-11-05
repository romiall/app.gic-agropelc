/**
 * Lecture des bilans hebdomadaires des commerciaux (PP-E ; REQ-307, AV-314). API publique de `crm` ; la portée
 * (commercial) est jugée par la couche transport, élément par élément. Les chiffres de la semaine ne sont pas ici :
 * ils se composent hors du module (ventes, encaissements, pertes), dans `crm-api/`.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { WeeklyReportStatus } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { formatDateColumn } from '../commands/shared.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const WEEKLY_REPORT_LIST_DEFAULT_LIMIT = 50;
export const WEEKLY_REPORT_LIST_MAX_LIMIT = 200;

export interface WeeklyReportSummary {
  readonly id: string;
  readonly userId: string;
  /** Lundi de la semaine, `AAAA-MM-JJ`. */
  readonly weekStart: string;
  readonly successes: string | null;
  readonly difficulties: string | null;
  readonly needs: string | null;
  readonly priorities: string | null;
  readonly marketInfo: string | null;
  readonly status: WeeklyReportStatus;
  readonly lastEditedAt: Date;
  readonly reviewedAt: Date | null;
  readonly reviewedBy: string | null;
  readonly managerComment: string | null;
  readonly version: number;
}

export interface WeeklyReportFilter {
  /** Commerciaux lus ; vide : rien à lire ; absent : tous. */
  readonly userIds?: readonly string[];
  /** Semaine exacte (lundi). */
  readonly weekStart?: string;
  /** Bornes de semaines (lundis), incluses. */
  readonly fromWeek?: string;
  readonly toWeek?: string;
  readonly limit?: number;
}

function toSummary(row: {
  readonly id: Buffer;
  readonly user_id: Buffer;
  readonly week_start: Date;
  readonly successes: string | null;
  readonly difficulties: string | null;
  readonly needs: string | null;
  readonly priorities: string | null;
  readonly market_info: string | null;
  readonly status: string;
  readonly last_edited_at: Date;
  readonly reviewed_at: Date | null;
  readonly reviewed_by: Buffer | null;
  readonly manager_comment: string | null;
  readonly version: number;
}): WeeklyReportSummary {
  return {
    id: fromBin(row.id),
    userId: fromBin(row.user_id),
    weekStart: formatDateColumn(row.week_start)!,
    successes: row.successes,
    difficulties: row.difficulties,
    needs: row.needs,
    priorities: row.priorities,
    marketInfo: row.market_info,
    status: row.status as WeeklyReportStatus,
    lastEditedAt: row.last_edited_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: fromBinOrNull(row.reviewed_by),
    managerComment: row.manager_comment,
    version: row.version,
  };
}

/** Bilans, les plus récents d'abord (semaine puis commercial). */
export async function listWeeklyReports(
  executor: Executor,
  filter: WeeklyReportFilter,
): Promise<readonly WeeklyReportSummary[]> {
  if (filter.userIds !== undefined && filter.userIds.length === 0) return [];
  const limit = Math.min(
    filter.limit ?? WEEKLY_REPORT_LIST_DEFAULT_LIMIT,
    WEEKLY_REPORT_LIST_MAX_LIMIT,
  );
  const rows = await executor
    .selectFrom('crm_weekly_reports')
    .selectAll()
    .$if(filter.userIds !== undefined, (qb) =>
      qb.where(
        'user_id',
        'in',
        filter.userIds!.map((id) => toBin(id)),
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
    .orderBy('week_start', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows.map(toSummary);
}
