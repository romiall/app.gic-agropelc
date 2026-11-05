/**
 * Présence du personnel relevée sur la fiche papier PT (PP-E ; REQ-306, AV-313, ADR-056) :
 * `fieldwork.presence.record` (report d'une feuille hebdomadaire) et `fieldwork.presence.cancel` (annulation motivée).
 *
 * - **Une commande = une feuille** : un site, une semaine (lundi), le numéro de la feuille papier, le responsable, et
 *   une ligne par personne avec ses jours (arrivée, départ ou code d'absence). L'identifiant de l'agrégat est celui de
 *   la feuille ; un rejeu sous la même identité ne double rien. Les lignes sont en ajout seul (règle 4) : la
 *   correction passe par l'annulation motivée de la feuille puis un nouveau report.
 * - **Droit** : `fieldwork.presence.record` sur le site de la feuille (portée jugée à `occurred_at`, hors ligne
 *   comprise). Les règles des jours (semaine, doublons, heures, codes) sont celles de `@gic/domain` : l'appareil les
 *   applique avant d'envoyer, le serveur les rejoue.
 * - **Personnes** : un nom (la plupart n'ont pas de compte) et, facultativement, le compte lié, vérifié avant l'écriture
 *   (une clé étrangère en échec ferait renvoyer la feuille sans fin). Ce ne sont pas des sessions de travail : rien
 *   n'entre dans le pointage numérique ni dans `analytics_f_attendance` (aucun jour de présence compté deux fois).
 * - Usage statistique et de suivi : ni paie ni discipline (AV-313).
 */
import { z } from 'zod';
import { sql, type Transaction } from 'kysely';
import {
  PRESENCE_ABSENCE_CODES,
  PRESENCE_MAX_LINES,
  PRESENCE_WEEK_LENGTH,
  clockHhmm,
  isMondayBusinessDay,
  personNameKey,
  presenceLineIssue,
  presenceWeekIssue,
  type IdGenerator,
} from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { evaluateAccess } from '../../../identity/application/public/index.js';
import { findSite } from '../../../organization/application/public/index.js';

type Uow = Transaction<DB>;

export const PRESENCE_RECORD_PERMISSION = 'fieldwork.presence.record';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const daySchema = z.object({
  date: z.string().regex(DATE_ONLY),
  arrival: timeOfDay.nullable().optional(),
  departure: timeOfDay.nullable().optional(),
  absenceCode: z.enum(PRESENCE_ABSENCE_CODES).nullable().optional(),
});

const lineSchema = z.object({
  personName: z.string().trim().min(1).max(120),
  personRole: optionalText(80),
  missionLabel: optionalText(80),
  userId: z.string().uuid().nullable().optional(),
  days: z.array(daySchema).min(1).max(PRESENCE_WEEK_LENGTH),
});

const recordPayloadSchema = z.object({
  siteId: z.string().uuid(),
  weekStart: z.string().regex(DATE_ONLY),
  paperRef: optionalText(30),
  responsibleName: optionalText(120),
  lines: z.array(lineSchema).min(1).max(PRESENCE_MAX_LINES),
});
type RecordPayload = z.infer<typeof recordPayloadSchema>;

const cancelPayloadSchema = z.object({ comment: z.string().trim().min(1).max(500) });
type CancelPayload = z.infer<typeof cancelPayloadSchema>;

function rejected(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}

const FORBIDDEN_SITE = rejected(
  'FORBIDDEN_SCOPE',
  'Site hors de votre périmètre pour la présence du personnel.',
);

async function canRecordAt(uow: Uow, userId: string, siteId: string, at: Date): Promise<boolean> {
  const access = await evaluateAccess(uow, {
    userId,
    permissionCode: PRESENCE_RECORD_PERMISSION,
    occurredAt: at,
    resource: { siteId },
  });
  return access.allowed;
}

/** Une heure `HH:MM` à écrire dans une colonne `TIME`. */
const timeColumn = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : `${value}:00`;

/** Forme `AAAA-MM-JJ` d'une colonne `DATE` lue (pilote en UTC : minuit UTC du jour). */
function dateOnly(value: Date): string {
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${value.getUTCFullYear()}-${month}-${day}`;
}

interface StoredSheet {
  readonly site_id: Buffer;
  readonly week_start: Date;
  readonly paper_ref: string | null;
  readonly responsible_name: string | null;
  readonly created_by: Buffer;
}

interface StoredLine {
  readonly line_no: number;
  readonly presence_date: Date;
  readonly person_name: string;
  readonly person_role: string | null;
  readonly mission_label: string | null;
  readonly user_id: Buffer | null;
  readonly arrival_time: string | null;
  readonly departure_time: string | null;
  readonly absence_code: string | null;
}

const sameLinkedUser = (stored: Buffer | null, sent: string | null | undefined): boolean =>
  stored === null ? !sent : sent ? stored.equals(toBin(sent)) : false;

/**
 * La feuille enregistrée sous cet identifiant est-elle celle de la charge ? Même auteur, même site, même semaine, mêmes
 * en-têtes, mêmes lignes et mêmes jours. Seul ce cas est un rejeu (fichier de présence rechargé sous un autre
 * `command_id`) ; un autre contenu sous le même identifiant est refusé, jamais avalé en silence (comme `loss.declare`).
 */
function sheetMatches(
  sheet: StoredSheet,
  rows: readonly StoredLine[],
  author: string,
  p: RecordPayload,
): boolean {
  if (!sheet.created_by.equals(toBin(author)) || !sheet.site_id.equals(toBin(p.siteId))) {
    return false;
  }
  if (dateOnly(sheet.week_start) !== p.weekStart) return false;
  if ((sheet.paper_ref ?? null) !== (p.paperRef ?? null)) return false;
  if ((sheet.responsible_name ?? null) !== (p.responsibleName ?? null)) return false;
  const byLine = new Map<number, StoredLine[]>();
  for (const row of rows) byLine.set(row.line_no, [...(byLine.get(row.line_no) ?? []), row]);
  if (byLine.size !== p.lines.length) return false;
  return p.lines.every((line, index) => {
    const stored = byLine.get(index + 1) ?? [];
    const head = stored[0];
    if (!head || stored.length !== line.days.length) return false;
    if (
      head.person_name !== line.personName ||
      (head.person_role ?? null) !== (line.personRole ?? null) ||
      (head.mission_label ?? null) !== (line.missionLabel ?? null) ||
      !sameLinkedUser(head.user_id, line.userId)
    ) {
      return false;
    }
    return line.days.every((day) => {
      const row = stored.find((candidate) => dateOnly(candidate.presence_date) === day.date);
      return (
        row !== undefined &&
        clockHhmm(row.arrival_time) === (day.arrival ?? null) &&
        clockHhmm(row.departure_time) === (day.departure ?? null) &&
        (row.absence_code ?? null) === (day.absenceCode ?? null)
      );
    });
  });
}

const buildRecordSheet =
  (idGenerator: IdGenerator): CommandHandler<RecordPayload> =>
  async (uow, envelope) => {
    const sheetId = toBin(envelope.aggregate_id);
    const p = envelope.payload;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const existing = await uow
      .selectFrom('fieldwork_presence_sheets')
      .select(['site_id', 'week_start', 'paper_ref', 'responsible_name', 'created_by', 'status'])
      .where('id', '=', sheetId)
      .executeTakeFirst();
    if (existing) {
      const rows = await uow
        .selectFrom('fieldwork_staff_presence')
        .select([
          'line_no',
          'presence_date',
          'person_name',
          'person_role',
          'mission_label',
          'user_id',
          'arrival_time',
          'departure_time',
          'absence_code',
        ])
        .where('sheet_id', '=', sheetId)
        .execute();
      if (!sheetMatches(existing, rows, author, p)) {
        return rejected(
          'PRESENCE_ID_TAKEN',
          'Cet identifiant désigne déjà une autre feuille de présence.',
        );
      }
      if (existing.status === 'CANCELLED') {
        return rejected(
          'PRESENCE_SHEET_CANCELLED',
          'Cette feuille a été reportée puis annulée : modifiez-la (son numéro de feuille, par exemple) pour la reporter de nouveau.',
        );
      }
      return { status: 'APPLIED' };
    }

    const weekIssue = presenceWeekIssue(p.weekStart, at);
    if (weekIssue) {
      return rejected(
        isMondayBusinessDay(p.weekStart) ? 'PRESENCE_WEEK_IN_FUTURE' : 'PRESENCE_WEEK_NOT_MONDAY',
        weekIssue,
      );
    }
    if (!(await findSite(uow, p.siteId))) return rejected('SITE_NOT_FOUND', 'Site introuvable.');
    if (!(await canRecordAt(uow, author, p.siteId, at))) return FORBIDDEN_SITE;

    const seen = new Set<string>();
    for (const line of p.lines) {
      const key = personNameKey(line.personName);
      if (seen.has(key)) {
        return rejected(
          'PRESENCE_PERSON_DUPLICATE',
          `${line.personName} figure deux fois sur la même feuille.`,
        );
      }
      seen.add(key);
      const issue = presenceLineIssue(
        p.weekStart,
        line.days.map((day) => ({
          date: day.date,
          arrival: day.arrival ?? null,
          departure: day.departure ?? null,
          absenceCode: day.absenceCode ?? null,
        })),
      );
      if (issue) return rejected(issue.code, `${line.personName} : ${issue.messageFr}`);
    }
    const linkedUsers = [...new Set(p.lines.flatMap((line) => (line.userId ? [line.userId] : [])))];
    if (linkedUsers.length > 0) {
      const known = await uow
        .selectFrom('identity_users')
        .select('id')
        .where(
          'id',
          'in',
          linkedUsers.map((id) => toBin(id)),
        )
        .execute();
      if (known.length !== linkedUsers.length) {
        return rejected('REFERENCE_INVALID', 'Présence : un compte lié est inconnu.');
      }
    }

    const origin = await loadCommandOrigin(uow, envelope.command_id);
    await uow
      .insertInto('fieldwork_presence_sheets')
      .values({
        id: sheetId,
        site_id: toBin(p.siteId),
        week_start: sql<Date>`${p.weekStart}`,
        paper_ref: p.paperRef ?? null,
        responsible_name: p.responsibleName ?? null,
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
    for (const [lineIndex, line] of p.lines.entries()) {
      for (const day of line.days) {
        await uow
          .insertInto('fieldwork_staff_presence')
          .values({
            id: toBin(idGenerator.newId()),
            sheet_id: sheetId,
            line_no: lineIndex + 1,
            presence_date: sql<Date>`${day.date}`,
            person_name: line.personName,
            person_role: line.personRole ?? null,
            mission_label: line.missionLabel ?? null,
            user_id: toBinOrNull(line.userId ?? null),
            arrival_time: timeColumn(day.arrival),
            departure_time: timeColumn(day.departure),
            absence_code: day.absenceCode ?? null,
            created_by: toBin(author),
          })
          .execute();
      }
    }
    return { status: 'APPLIED' };
  };

const cancelSheet: CommandHandler<CancelPayload> = async (uow, envelope) => {
  const sheet = await uow
    .selectFrom('fieldwork_presence_sheets')
    .select(['id', 'site_id', 'status'])
    .where('id', '=', toBin(envelope.aggregate_id))
    .forUpdate()
    .executeTakeFirst();
  if (!sheet) return rejected('NOT_FOUND', 'Feuille de présence introuvable.');
  if (sheet.status === 'CANCELLED') {
    return rejected('ALREADY_CANCELLED', 'Feuille de présence déjà annulée.');
  }
  const author = envelope.author_user_id;
  const at = new Date(envelope.occurred_at);
  if (!(await canRecordAt(uow, author, fromBin(sheet.site_id), at))) return FORBIDDEN_SITE;
  await uow
    .updateTable('fieldwork_presence_sheets')
    .set({
      status: 'CANCELLED',
      cancelled_at: at,
      cancelled_by: toBin(author),
      cancel_comment: envelope.payload.comment,
      updated_by: toBin(author),
      version: sql`version + 1`,
    })
    .where('id', '=', sheet.id)
    .execute();
  return { status: 'APPLIED' };
};

export function registerPresenceCommands(
  registry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
): void {
  registry.register({
    commandType: 'fieldwork.presence.record',
    version: 1,
    payloadSchema: recordPayloadSchema,
    permissionCode: PRESENCE_RECORD_PERMISSION,
    handler: buildRecordSheet(idGenerator),
  });
  registry.register({
    commandType: 'fieldwork.presence.cancel',
    version: 1,
    payloadSchema: cancelPayloadSchema,
    permissionCode: PRESENCE_RECORD_PERMISSION,
    handler: cancelSheet,
  });
}
