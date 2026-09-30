/**
 * Répartition des frais généraux à la demande (ADR-026 amendé ; AV-104, AV-106 ; P7-10) :
 * `production.overhead.allocate`, en ligne, sous `production.overhead.allocate` (Finance et
 * Responsable production, toutes fermes), pour une ferme, une espèce et un mois métier.
 *
 * Première exécution du mois : `INITIAL` ; exécution suivante (frais saisis après) :
 * `REGULARIZATION` sur le seul montant non encore réparti ; jamais de réécriture. Refus :
 * ferme inconnue ou non ferme (`SITE_NOT_FARM`), mois futur (`PERIOD_INVALID`), rien à répartir
 * (`NOTHING_TO_ALLOCATE`), aucun lot de l'espèce présent sur le mois (`NO_LOT_TO_ALLOCATE` : la
 * masse reste visible, non répartie, ADR-026).
 */
import { z } from 'zod';
import { businessDayOf, type IdGenerator } from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { SPECIES_GROUPS } from '../../../inventory/application/public/index.js';
import { allocateOverheads } from '../overhead-allocation.js';
import { FORBIDDEN_SCOPE, isAllowed, rejected } from './shared.js';

const ALLOCATE = 'production.overhead.allocate';

const allocatePayloadSchema = z.object({
  siteId: z.string().uuid(),
  speciesGroup: z.enum(SPECIES_GROUPS),
  /** Mois métier `AAAA-MM`. */
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});

function buildHandlers(idGenerator: IdGenerator) {
  const deps = { idGenerator };

  const allocate: CommandHandler<z.infer<typeof allocatePayloadSchema>> = async (uow, envelope) => {
    const runId = envelope.aggregate_id;
    const replay = await uow
      .selectFrom('production_overhead_allocations')
      .select(['run_kind', 'allocated_xaf'])
      .where('id', '=', toBin(runId))
      .executeTakeFirst();
    if (replay) {
      return {
        status: 'APPLIED',
        serverRefs: { runKind: replay.run_kind, allocatedXaf: String(replay.allocated_xaf) },
      };
    }
    const p = envelope.payload;
    const at = new Date(envelope.occurred_at);
    const site = await uow
      .selectFrom('organization_sites')
      .select(['id', 'site_type'])
      .where('id', '=', toBin(p.siteId))
      .executeTakeFirst();
    if (!site || site.site_type !== 'FERME') {
      return rejected('SITE_NOT_FARM', 'Les frais généraux se répartissent sur une ferme.');
    }
    if (!(await isAllowed(uow, envelope.author_user_id, ALLOCATE, at, fromBin(site.id)))) {
      return FORBIDDEN_SCOPE;
    }
    if (p.period > businessDayOf(at).slice(0, 7)) {
      return rejected('PERIOD_INVALID', 'Un mois futur ne se répartit pas.');
    }
    const result = await allocateOverheads(uow, deps, {
      runId,
      siteId: p.siteId,
      speciesGroup: p.speciesGroup,
      period: p.period,
      occurredAt: at,
      createdBy: envelope.author_user_id,
      commandId: envelope.command_id,
    });
    if (!result.ok) {
      return result.reason === 'NOTHING_TO_ALLOCATE'
        ? rejected(
            'NOTHING_TO_ALLOCATE',
            'Aucun frais général non réparti pour cette ferme, cette espèce et ce mois.',
          )
        : rejected(
            'NO_LOT_TO_ALLOCATE',
            'Aucun lot de cette espèce présent sur la ferme ce mois-ci : les frais restent non répartis.',
          );
    }
    return {
      status: 'APPLIED',
      serverRefs: {
        runKind: result.runKind,
        allocatedXaf: String(result.allocatedXaf),
        lots: String(result.lines.length),
      },
      audit: { after: result },
    };
  };

  return { allocate };
}

export function registerOverheadCommands(
  registry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
): void {
  const handlers = buildHandlers(idGenerator);
  registry.register({
    commandType: 'production.overhead.allocate',
    version: 1,
    payloadSchema: allocatePayloadSchema,
    permissionCode: ALLOCATE,
    handler: handlers.allocate,
  });
}
