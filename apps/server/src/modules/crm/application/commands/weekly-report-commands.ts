/**
 * Bilan hebdomadaire du commercial (PP-E ; REQ-307, AV-314, ADR-056) : `crm.weekly_report.submit` (rédaction et
 * correction par le commercial) et `crm.weekly_report.review` (« vu par le responsable » et son commentaire).
 *
 * - **Un bilan par commercial et par semaine** (lundi au dimanche, jours métier de Douala). L'identifiant de l'agrégat
 *   est celui du bilan, que l'appareil dérive du couple (commercial, semaine) : renvoyer la commande sous un autre
 *   `command_id` est une **correction**, pas un doublon.
 * - **Correction** tant que le responsable n'a pas vu le bilan (`SUBMITTED`) : le texte le plus récent l'emporte
 *   (`occurred_at`), un envoi plus ancien arrivé après est ignoré. Une fois `REVIEWED`, les textes sont figés
 *   (`REPORT_LOCKED`) ; les textes d'avant une correction restent dans le journal d'audit de la commande.
 * - **Les chiffres de la fiche ne sont pas stockés** : ils sont calculés à la lecture (`GET /weekly-reports/figures`).
 * - **Droits** : `crm.weekly_report.submit` pour son propre bilan ; `crm.weekly_report.review` sur le bilan d'un commercial
 *   de sa portée (équipe dirigée ou tous), jamais sur le sien. Un bilan écrit hors ligne est un fait : la portée est
 *   jugée à `occurred_at`.
 */
import { z } from 'zod';
import { sql } from 'kysely';
import {
  WEEKLY_REPORT_TEXT_FIELDS,
  WEEKLY_REPORT_TEXT_MAX,
  hasWeeklyReportContent,
  normalizeWeeklyReportTexts,
  weeklyReportWeekIssue,
} from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { DATE_ONLY, dateColumn, formatDateColumn, isAllowed, rejected } from './shared.js';
import { emitWeeklyReportChange } from '../sync-changes.js';

export const WEEKLY_REPORT_SUBMIT_PERMISSION = 'crm.weekly_report.submit';
export const WEEKLY_REPORT_REVIEW_PERMISSION = 'crm.weekly_report.review';

const textField = z.string().trim().min(1).max(WEEKLY_REPORT_TEXT_MAX).nullable().optional();

const submitPayloadSchema = z.object({
  weekStart: z.string().regex(DATE_ONLY),
  successes: textField,
  difficulties: textField,
  needs: textField,
  priorities: textField,
  marketInfo: textField,
});
type SubmitPayload = z.infer<typeof submitPayloadSchema>;

const reviewPayloadSchema = z.object({ comment: textField });
type ReviewPayload = z.infer<typeof reviewPayloadSchema>;

/** Colonnes de texte du bilan, dans l'ordre de la fiche. */
const TEXT_COLUMNS = {
  successes: 'successes',
  difficulties: 'difficulties',
  needs: 'needs',
  priorities: 'priorities',
  marketInfo: 'market_info',
} as const;

const submitReport: CommandHandler<SubmitPayload> = async (uow, envelope) => {
  const reportId = toBin(envelope.aggregate_id);
  const p = envelope.payload;
  const author = envelope.author_user_id;
  const at = new Date(envelope.occurred_at);
  const texts = normalizeWeeklyReportTexts(p);
  if (!hasWeeklyReportContent(texts)) {
    return rejected('REPORT_EMPTY', 'Le bilan est vide : au moins une rubrique est à remplir.');
  }
  const weekIssue = weeklyReportWeekIssue(p.weekStart, at);
  if (weekIssue) return rejected('REPORT_WEEK_INVALID', weekIssue);
  // Le droit `crm.weekly_report.submit` est vérifié par le pipeline à `occurred_at`. Le bilan est celui de son auteur par
  // construction (un identifiant d'agrégat étranger est refusé plus bas) : la portée `OWN` n'ajoute rien. Ne pas la
  // juger par `evaluateAccess` avec `{ ownerUserId }` seul : sous une affectation de zone (le commercial terrain), la
  // ressource sans zone ni site serait toujours « hors périmètre ».

  const existing = await uow
    .selectFrom('crm_weekly_reports')
    .selectAll()
    .where('id', '=', reportId)
    .forUpdate()
    .executeTakeFirst();
  if (existing) {
    if (!existing.user_id.equals(toBin(author))) {
      return rejected('FORBIDDEN_SCOPE', "Ce bilan est celui d'un autre commercial.");
    }
    if (formatDateColumn(existing.week_start) !== p.weekStart) {
      return rejected('REPORT_WEEK_MISMATCH', 'Ce bilan est celui d’une autre semaine.');
    }
    if (existing.status === 'REVIEWED') {
      return rejected(
        'REPORT_LOCKED',
        'Bilan déjà vu par le responsable : il n’est plus modifiable.',
      );
    }
    // Correction : le texte le plus récent l'emporte ; un envoi plus ancien arrivé après est ignoré. Un envoi ignoré ou
    // identique ne change rien : le journal le dit (avant = après = l'état enregistré), il ne donne pas le texte ignoré
    // pour l'état « après ».
    const before = Object.fromEntries(
      WEEKLY_REPORT_TEXT_FIELDS.map((field) => [field, existing[TEXT_COLUMNS[field]]]),
    );
    if (
      at.getTime() <= existing.last_edited_at.getTime() ||
      WEEKLY_REPORT_TEXT_FIELDS.every((field) => texts[field] === before[field])
    ) {
      return { status: 'APPLIED', audit: { before, after: before } };
    }
    await uow
      .updateTable('crm_weekly_reports')
      .set({
        successes: texts.successes,
        difficulties: texts.difficulties,
        needs: texts.needs,
        priorities: texts.priorities,
        market_info: texts.marketInfo,
        last_edited_at: at,
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', reportId)
      .execute();
    await emitWeeklyReportChange(uow, reportId);
    return { status: 'APPLIED', audit: { before, after: texts } };
  }

  const sameWeek = await uow
    .selectFrom('crm_weekly_reports')
    .select('id')
    .where('user_id', '=', toBin(author))
    .where(sql<boolean>`week_start = ${p.weekStart}`)
    .executeTakeFirst();
  if (sameWeek) {
    return rejected('REPORT_EXISTS', 'Un bilan existe déjà pour cette semaine : le corriger.');
  }
  const origin = await loadCommandOrigin(uow, envelope.command_id);
  await uow
    .insertInto('crm_weekly_reports')
    .values({
      id: reportId,
      user_id: toBin(author),
      week_start: dateColumn(p.weekStart),
      successes: texts.successes,
      difficulties: texts.difficulties,
      needs: texts.needs,
      priorities: texts.priorities,
      market_info: texts.marketInfo,
      last_edited_at: at,
      occurred_at: at,
      client_created_at: new Date(envelope.client_created_at),
      received_at_server: origin.receivedAt,
      command_id: toBin(envelope.command_id),
      created_device_id: toBinOrNull(origin.deviceId),
      captured_offline: envelope.captured_offline ? 1 : 0,
      clock_suspect: origin.clockSuspect ? 1 : 0,
      backdated_reason: envelope.backdated_reason,
      created_by: toBin(author),
    })
    .execute();
  await emitWeeklyReportChange(uow, reportId);
  return { status: 'APPLIED' };
};

const reviewReport: CommandHandler<ReviewPayload> = async (uow, envelope) => {
  const row = await uow
    .selectFrom('crm_weekly_reports')
    .select(['id', 'user_id', 'status', 'manager_comment', 'reviewed_at', 'version'])
    .where('id', '=', toBin(envelope.aggregate_id))
    .forUpdate()
    .executeTakeFirst();
  if (!row) return rejected('NOT_FOUND', 'Bilan hebdomadaire introuvable.');
  const author = envelope.author_user_id;
  const at = new Date(envelope.occurred_at);
  if (row.user_id.equals(toBin(author))) {
    return rejected('SELF_REVIEW', 'Un bilan ne se valide pas soi-même.');
  }
  if (
    !(await isAllowed(uow, author, WEEKLY_REPORT_REVIEW_PERMISSION, at, {
      ownerUserId: fromBin(row.user_id),
    }))
  ) {
    return rejected('FORBIDDEN_SCOPE', 'Ce bilan est hors de votre périmètre.');
  }
  // Le « vu » est une intention sur un état partagé : le responsable valide ce qu'il a lu. Si le commercial a corrigé son
  // bilan depuis (la version a changé), le « vu » figerait un texte que le responsable n'a pas lu : refusé, à relire.
  if (envelope.base_version !== null && envelope.base_version !== row.version) {
    return rejected(
      'REPORT_CHANGED',
      'Le bilan a changé depuis votre lecture : relisez-le avant de le marquer comme vu.',
    );
  }
  const current = { status: row.status, managerComment: row.manager_comment };
  // Le dernier « vu » l'emporte : un « vu » plus ancien arrivé après (écrit hors ligne) ne fait pas reculer la date ni
  // n'écrase le commentaire du plus récent.
  if (row.reviewed_at !== null && at.getTime() <= row.reviewed_at.getTime()) {
    return { status: 'APPLIED', audit: { before: current, after: current } };
  }
  // Sans commentaire dans la charge, celui qui existe déjà reste (un second « vu » ne l'efface pas) ; `null` l'efface.
  const comment =
    envelope.payload.comment === undefined ? row.manager_comment : envelope.payload.comment;
  await uow
    .updateTable('crm_weekly_reports')
    .set({
      status: 'REVIEWED',
      reviewed_at: at,
      reviewed_by: toBin(author),
      manager_comment: comment,
      updated_by: toBin(author),
      version: sql`version + 1`,
    })
    .where('id', '=', row.id)
    .execute();
  await emitWeeklyReportChange(uow, row.id);
  return {
    status: 'APPLIED',
    audit: { before: current, after: { status: 'REVIEWED', managerComment: comment } },
  };
};

export function registerWeeklyReportCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'crm.weekly_report.submit',
    version: 1,
    payloadSchema: submitPayloadSchema,
    permissionCode: WEEKLY_REPORT_SUBMIT_PERMISSION,
    handler: submitReport,
    // Premier envoi de deux commerciaux dans le même intervalle d'identifiants : un `FOR UPDATE` sur une ligne absente
    // pose, en lecture répétable, un verrou de plage qui ferait s'interbloquer les deux transactions (1213).
    isolationLevel: 'read committed',
  });
  registry.register({
    commandType: 'crm.weekly_report.review',
    version: 1,
    payloadSchema: reviewPayloadSchema,
    permissionCode: WEEKLY_REPORT_REVIEW_PERMISSION,
    handler: reviewReport,
  });
}
