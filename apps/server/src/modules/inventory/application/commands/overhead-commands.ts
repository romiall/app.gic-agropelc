/**
 * Frais généraux d'une ferme (P7-02 ; ADR-026 amendé le 28/09/2026 ; AV-103, AV-104) :
 * `inventory.overhead.record` et `.cancel`, en ligne, sous `inventory.cost_entry.record`
 * (Finance ALL, Responsable production ALL, Responsable ferme SITE).
 *
 * Une saisie = une en-tête (`inventory_overhead_entries`) et une ligne par espèce (volaille,
 * porc) : un frais commun à toute la ferme est **ventilé à la saisie** (AV-104, jamais de
 * mélange entre espèces). Chaque ligne porte une écriture de coût `SITE`, nature
 * `FRAIS_GENERAUX`, espèce renseignée, source `OVERHEAD_ENTRY` — c'est la masse que la
 * répartition à la demande (`production.overhead.allocate`, P7-10) partage entre les lots de
 * l'espèce au prorata têtes × jours.
 *
 * Annulation (ADR-006) : écritures inverses (`CREDIT`) ; refusée si le mois de l'espèce a déjà
 * été réparti (`OVERHEAD_ALREADY_ALLOCATED`) — DÉDUIT : une répartition n'est jamais réécrite
 * (ADR-026) ; un frais saisi en trop après la répartition reste dans les coûts du mois.
 */
import { z } from 'zod';
import { sql } from 'kysely';
import { businessDayOf, businessDayStartUtc, type IdGenerator } from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import { evaluateAccess } from '../../../identity/application/public/index.js';
import { SPECIES_GROUPS, recordCostEntry, type SpeciesGroup } from '../public/cost-entries.js';

const PERMISSION = 'inventory.cost_entry.record';

const recordPayloadSchema = z.object({
  siteId: z.string().uuid(),
  label: z.string().trim().min(1).max(200),
  lines: z
    .array(
      z.object({
        speciesGroup: z.enum(SPECIES_GROUPS),
        amountXaf: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(SPECIES_GROUPS.length),
});

const cancelPayloadSchema = z.object({
  entryId: z.string().uuid(),
  comment: z.string().trim().min(1).max(2000),
  reasonCodeId: z.string().uuid().optional(),
});

function rejected(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}

async function allowed(uow: UnitOfWork, userId: string, siteId: string, at: Date) {
  return (
    await evaluateAccess(uow, {
      userId,
      permissionCode: PERMISSION,
      occurredAt: at,
      resource: { siteId },
    })
  ).allowed;
}

/** Premier instant (UTC) du mois métier (Africa/Douala) contenant `at`, et du mois suivant. */
export function businessMonthBounds(at: Date): { readonly start: Date; readonly end: Date } {
  const day = businessDayOf(at);
  const [year, month] = day.split('-').map(Number) as [number, number];
  const start = businessDayStartUtc(`${year}-${String(month).padStart(2, '0')}-01`);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const end = businessDayStartUtc(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01`);
  return { start, end };
}

function buildHandlers(idGenerator: IdGenerator) {
  const deps = { idGenerator };

  const record: CommandHandler<z.infer<typeof recordPayloadSchema>> = async (uow, envelope) => {
    const entryId = envelope.aggregate_id;
    const replay = await uow
      .selectFrom('inventory_overhead_entries')
      .select('id')
      .where('id', '=', toBin(entryId))
      .executeTakeFirst();
    if (replay) return { status: 'APPLIED' };

    const p = envelope.payload;
    const at = new Date(envelope.occurred_at);
    const species = new Set(p.lines.map((line) => line.speciesGroup));
    if (species.size !== p.lines.length) {
      return rejected('SPECIES_DUPLICATE', 'Une seule ligne par espèce (volaille, porc).');
    }
    const site = await uow
      .selectFrom('organization_sites')
      .select(['id', 'site_type', 'status'])
      .where('id', '=', toBin(p.siteId))
      .executeTakeFirst();
    if (!site || site.site_type !== 'FERME') {
      return rejected('SITE_NOT_FARM', 'Les frais généraux se saisissent sur une ferme.');
    }
    if (!(await allowed(uow, envelope.author_user_id, p.siteId, at))) {
      return rejected('FORBIDDEN_SCOPE', 'Ferme hors de votre périmètre.');
    }
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const total = p.lines.reduce((sum, line) => sum + line.amountXaf, 0);
    await uow
      .insertInto('inventory_overhead_entries')
      .values({
        id: toBin(entryId),
        site_id: toBin(p.siteId),
        label: p.label,
        total_xaf: total,
        occurred_at: at,
        client_created_at: new Date(envelope.client_created_at),
        received_at_server: origin.receivedAt,
        command_id: toBin(envelope.command_id),
        created_device_id: toBinOrNull(origin.deviceId),
        captured_offline: envelope.captured_offline ? 1 : 0,
        clock_suspect: origin.clockSuspect ? 1 : 0,
        backdated_reason: envelope.backdated_reason,
        created_by: toBin(envelope.author_user_id),
      })
      .execute();
    for (const line of p.lines) {
      const lineId = idGenerator.newId();
      const costEntryId = await recordCostEntry(uow, deps, {
        costObjectType: 'SITE',
        costObjectId: p.siteId,
        costType: 'FRAIS_GENERAUX',
        speciesGroup: line.speciesGroup,
        amountXaf: line.amountXaf,
        direction: 'DEBIT',
        sourceType: 'OVERHEAD_ENTRY',
        sourceId: lineId,
        occurredAt: at,
        createdBy: envelope.author_user_id,
        comment: p.label,
      });
      await uow
        .insertInto('inventory_overhead_entry_lines')
        .values({
          id: toBin(lineId),
          entry_id: toBin(entryId),
          species_group: line.speciesGroup,
          amount_xaf: line.amountXaf,
          cost_entry_id: toBin(costEntryId!),
        })
        .execute();
    }
    return { status: 'APPLIED' };
  };

  const cancel: CommandHandler<z.infer<typeof cancelPayloadSchema>> = async (uow, envelope) => {
    const entry = await uow
      .selectFrom('inventory_overhead_entries')
      .select(['id', 'site_id', 'status', 'occurred_at'])
      .where('id', '=', toBin(envelope.payload.entryId))
      .forUpdate()
      .executeTakeFirst();
    if (!entry) return rejected('NOT_FOUND', 'Saisie de frais généraux introuvable.');
    if (entry.status !== 'RECORDED') {
      return rejected('OVERHEAD_STATUS_INVALID', 'Saisie déjà annulée.');
    }
    const at = new Date(envelope.occurred_at);
    const siteId = fromBin(entry.site_id);
    if (!(await allowed(uow, envelope.author_user_id, siteId, at))) {
      return rejected('FORBIDDEN_SCOPE', 'Ferme hors de votre périmètre.');
    }
    const lines = await uow
      .selectFrom('inventory_overhead_entry_lines as l')
      .innerJoin('inventory_cost_entries as c', 'c.id', 'l.cost_entry_id')
      .select([
        'l.species_group as species_group',
        'c.id as cost_entry_id',
        'c.amount_xaf as amount',
      ])
      .where('l.entry_id', '=', entry.id)
      .execute();
    const month = businessMonthBounds(entry.occurred_at);
    for (const line of lines) {
      if (await monthAllocated(uow, siteId, line.species_group as SpeciesGroup, month)) {
        return rejected(
          'OVERHEAD_ALREADY_ALLOCATED',
          'Le mois de cette espèce est déjà réparti entre les lots : la saisie ne peut plus être annulée (ADR-026).',
        );
      }
    }
    for (const line of lines) {
      await recordCostEntry(uow, deps, {
        costObjectType: 'SITE',
        costObjectId: siteId,
        costType: 'FRAIS_GENERAUX',
        speciesGroup: line.species_group as SpeciesGroup,
        amountXaf: Number(line.amount),
        direction: 'CREDIT',
        sourceType: 'OVERHEAD_ENTRY',
        sourceId: idGenerator.newId(),
        reversesEntryId: fromBin(line.cost_entry_id),
        occurredAt: entry.occurred_at,
        createdBy: envelope.author_user_id,
        comment: envelope.payload.comment,
      });
    }
    await uow
      .updateTable('inventory_overhead_entries')
      .set({
        status: 'CANCELLED',
        cancelled_at: at,
        cancelled_by: toBin(envelope.author_user_id),
        cancel_comment: envelope.payload.comment,
        cancel_reason_code_id: toBinOrNull(envelope.payload.reasonCodeId ?? null),
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', entry.id)
      .execute();
    return { status: 'APPLIED' };
  };

  return { record, cancel };
}

/** Une répartition (`ALLOCATION`) a-t-elle déjà crédité les frais de l'espèce sur ce mois ? */
async function monthAllocated(
  uow: UnitOfWork,
  siteId: string,
  speciesGroup: SpeciesGroup,
  month: { readonly start: Date; readonly end: Date },
): Promise<boolean> {
  const row = await uow
    .selectFrom('inventory_cost_entries')
    .select('id')
    .where('cost_object_type', '=', 'SITE')
    .where('cost_object_id', '=', toBin(siteId))
    .where('source_type', '=', 'ALLOCATION')
    .where('species_group', '=', speciesGroup)
    .where('occurred_at', '>=', month.start)
    .where('occurred_at', '<', month.end)
    .executeTakeFirst();
  return row !== undefined;
}

export function registerOverheadCommands(
  registry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
): void {
  const handlers = buildHandlers(idGenerator);
  registry.register({
    commandType: 'inventory.overhead.record',
    version: 1,
    payloadSchema: recordPayloadSchema,
    permissionCode: PERMISSION,
    handler: handlers.record,
  });
  registry.register({
    commandType: 'inventory.overhead.cancel',
    version: 1,
    payloadSchema: cancelPayloadSchema,
    permissionCode: PERMISSION,
    handler: handlers.cancel,
  });
}
