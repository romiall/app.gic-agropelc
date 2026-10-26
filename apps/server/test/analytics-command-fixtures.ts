/**
 * Banc d'essai des commandes de `analytics` (P9-19, P9-20) : le vrai pipeline de commande (idempotence, droits,
 * audit, événement générique) devant les vrais gestionnaires des vues sauvegardées et des exports, sur la base
 * partagée, avec une horloge fixe et des acteurs à rôle d'essai.
 */
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { JobsService } from '../src/platform/jobs/jobs.service.js';
import { registerExportCommands } from '../src/modules/analytics/application/commands/export-commands.js';
import { registerViewCommands } from '../src/modules/analytics/application/commands/view-commands.js';
import {
  assignTestRole,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestUser,
} from './helpers.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';

export const NOW = '2026-10-22T09:00:00.000Z';
export const TODAY = '2026-10-22';
export const FROM_DAY = '2026-10-01';

export interface CommandActor {
  readonly id: string;
  readonly deviceId: string;
}

let deviceSeq = 0;

export class AnalyticsCommandHarness {
  readonly clock: FixedClock;
  readonly idGenerator: IdGenerator;
  readonly jobs: JobsService;
  readonly pipeline: CommandPipelineService;

  /** `now` : l'instant où le serveur traite les commandes (par défaut `NOW`). */
  constructor(private readonly now: string = NOW) {
    this.clock = new FixedClock(new Date(now));
    this.idGenerator = new Uuidv7Generator(this.clock);
    this.jobs = new JobsService(this.clock, this.idGenerator);
    const registry = new CommandHandlerRegistry();
    registerViewCommands(registry, { idGenerator: this.idGenerator, clock: this.clock });
    registerExportCommands(registry, {
      idGenerator: this.idGenerator,
      clock: this.clock,
      jobs: this.jobs,
    });
    this.pipeline = new CommandPipelineService(db, registry, this.clock, this.idGenerator);
  }

  run(
    actor: CommandActor,
    commandType: string,
    aggregateType: 'SAVED_VIEW' | 'ANALYTICS_EXPORT',
    aggregateId: string,
    payload: unknown,
    options: { readonly offline?: boolean; readonly commandId?: string } = {},
  ) {
    deviceSeq += 1;
    this.clock.setTo(new Date(this.now));
    return this.pipeline.handle(
      {
        command_id: options.commandId ?? freshUuid(),
        device_seq: deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        author_user_id: actor.id,
        base_version: null,
        depends_on: [],
        occurred_at: this.now,
        client_created_at: this.now,
        captured_offline: options.offline ?? false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.id,
        authenticatedDeviceId: actor.deviceId,
        transport: 'SYNC_PUSH',
      },
    );
  }
}

/** Définition valide des lignes de vente sur le mois, au chiffre d'affaires. */
export function salesDefinition(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dataset: 'f_sales_line',
    period: { code: 'CUSTOM', fromDay: FROM_DAY, toDay: TODAY },
    dimensions: [],
    measures: ['revenue'],
    filters: [],
    sort: [],
    ...extra,
  };
}

/** Un acteur à rôle d'essai (permissions à portée `ALL`), affecté globalement, sur un appareil en service. */
export async function actorWith(
  admin: string,
  permissions: readonly string[],
): Promise<CommandActor & { readonly roleCode: string }> {
  return db.transaction().execute(async (trx) => {
    const id = await insertTestUser(trx);
    const deviceId = await insertTestDevice(trx, id, { status: 'ACTIVE' });
    const roleId = await insertTestRole(trx, admin);
    for (const permission of permissions) await grantTestPermission(trx, roleId, permission, admin);
    await assignTestRole(trx, id, roleId, admin);
    const role = await trx
      .selectFrom('identity_roles')
      .select('code')
      .where('id', '=', toBin(roleId))
      .executeTakeFirstOrThrow();
    return { id, deviceId, roleCode: role.code };
  });
}
