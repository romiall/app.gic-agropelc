/**
 * Jours de présence d'un périmètre (P9-15 ; KPI-COM-17, ADR-075 §1) : jours distincts (par personne, au jour
 * métier du début de la session) avec une session de travail acceptée — sans dérogation exigée, ou dérogation
 * approuvée — comme la vue `analytics_f_attendance`. Une session sans dérogation approuvée (en attente, refusée)
 * ne compte pas comme jour de présence.
 *
 * Périmètre (`ReadScope`) : la session ne porte pas de site mais la zone déclarée au pointage : seules les
 * personnes sont jugées ; un périmètre de sites ne lit rien (règle fermée, AV-424).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { num, type UtcWindow } from '../../../../platform/indicator-window.js';
import { scopeSql, type ReadScope } from '../../../../platform/read-scope.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface AttendanceDays {
  readonly presenceDays: number;
  readonly sessions: number;
}

export async function attendanceDays(
  executor: Executor,
  scope: ReadScope,
  window: UtcWindow,
): Promise<AttendanceDays> {
  // Sans colonne de site : un périmètre de sites ne lit aucune session.
  const restricted: ReadScope = scope.siteIds === undefined ? scope : { ...scope, siteIds: [] };
  const { rows } = await sql<{ days: unknown; sessions: unknown }>`
    SELECT COUNT(DISTINCT CASE WHEN w.override_status IN ('NOT_REQUIRED', 'APPROVED')
                               THEN CONCAT(HEX(w.user_id), '|', CAST(CONVERT_TZ(w.started_at, '+00:00', '+01:00') AS DATE))
                          END) AS days,
           COUNT(*) AS sessions
      FROM fieldwork_work_sessions w
     WHERE w.started_at >= ${window.fromUtc} AND w.started_at < ${window.toUtc}
       AND ${scopeSql(restricted, { users: ['w.user_id'] })}
  `.execute(executor);
  return { presenceDays: num(rows[0]?.days), sessions: num(rows[0]?.sessions) };
}
