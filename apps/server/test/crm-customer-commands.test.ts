/**
 * Commandes du compte client (P3-04, D02-CRM, SM-CUSTOMER) à travers le vrai pipeline, avec les
 * **rôles réels du seed** (portées OWN/TEAM/SITE/ALL de 01-rbac.md) : création et rattachement
 * (BR-CRM-002, 003), doublons en ligne et hors ligne puis fusion (BR-CRM-006, 007 ; AT-012),
 * chaîne de fusion (INV-CRM-05), modification champ par champ (matrice des conflits,
 * BR-CRM-021), étapes concurrentes, perte et réouverture (BR-CRM-009), réaffectation
 * (BR-CRM-020, AT-013 partiel), conditions de crédit (BR-CRM-022), configuration du pipeline,
 * conversion à la première vente (BR-CRM-010, AT-011 partiel).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerCustomerCommands } from '../src/modules/crm/application/commands/customer-commands.js';
import { registerPipelineCommands } from '../src/modules/crm/application/commands/pipeline-commands.js';
import {
  convertOnConfirmedSale,
  markConversionReverted,
} from '../src/modules/crm/application/public/index.js';
import { fromBin, fromBinOrNull, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestSite,
  insertTestTeam,
  insertTestTeamMembership,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const NOW = '2026-10-06T18:00:00.000Z';
const at = (hhmmss: string) => `2026-10-06T${hhmmss}.000Z`;
let deviceSeq = 0;

/** Numéro national camerounais aléatoire (9 chiffres) : unique entre exécutions (base persistante). */
function randomPhone(): string {
  return `6${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
}

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('crm.customer.* (P3-04)', () => {
  let clock: FixedClock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: string;
  let zoneId: string;
  let otherZoneId: string;
  let siteId: string;
  let cte1: Actor;
  let cte2: Actor;
  let rco: Actor;
  let ven: Actor;
  let fin: Actor;
  let dir: Actor;
  let lostReasonId: string;
  let visitReasonId: string;

  async function roleId(code: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  async function run(
    actor: Actor,
    commandType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: {
      readonly offline?: boolean;
      readonly baseVersion?: number | null;
      readonly aggregateType?: string;
    } = {},
  ) {
    return pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: options.aggregateType ?? 'CUSTOMER',
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
        base_version: options.baseVersion ?? null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: options.offline ?? false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: options.offline ? 'SYNC_PUSH' : 'ONLINE_API',
      },
    );
  }

  async function createCustomer(
    actor: Actor,
    overrides: Record<string, unknown> = {},
    options: { readonly occurredAt?: string; readonly offline?: boolean } = {},
  ) {
    const id = freshUuid();
    const phone = randomPhone();
    const result = await run(
      actor,
      'crm.customer.create',
      id,
      options.occurredAt ?? at('08:00:00'),
      {
        displayName: 'Boutique test',
        zoneId,
        sourceCode: 'PROSPECTION_TERRAIN',
        phonePrimary: phone,
        ...overrides,
      },
      { offline: options.offline ?? false },
    );
    return { id, phone, result };
  }

  async function customer(id: string) {
    return db
      .selectFrom('crm_customers')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  }

  async function stepId(code: string): Promise<Buffer> {
    const row = await db
      .selectFrom('crm_pipeline_steps')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function firstActiveStep(): Promise<Buffer> {
    const row = await db
      .selectFrom('crm_pipeline_steps')
      .select('id')
      .where('is_active', '=', 1)
      .orderBy('sort_order', 'asc')
      .orderBy('code', 'asc')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function assignments(customerId: string) {
    return db
      .selectFrom('crm_customer_assignments')
      .select(['user_id', 'valid_from', 'valid_to', 'reason'])
      .where('customer_id', '=', toBin(customerId))
      .orderBy('valid_from', 'asc')
      .execute();
  }

  beforeAll(async () => {
    clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerCustomerCommands(registry, idGenerator);
    registerPipelineCommands(registry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    const roles = {
      cte: await roleId('COMMERCIAL_TERRAIN'),
      rco: await roleId('RESP_COMMERCIAL'),
      ven: await roleId('VENDEUR_PDV'),
      fin: await roleId('FINANCE'),
      dir: await roleId('DIRECTION'),
    };
    await db.transaction().execute(async (trx) => {
      admin = await insertTestUser(trx);
      zoneId = await insertTestZone(trx, admin);
      otherZoneId = await insertTestZone(trx, admin);
      siteId = await insertTestSite(trx, admin, zoneId);
      const actor = async (
        role: string,
        options: Parameters<typeof assignTestRole>[4] = {},
      ): Promise<Actor> => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, admin, options);
        return { userId, deviceId };
      };
      cte1 = await actor(roles.cte, { scopeType: 'ZONE', scopeZoneId: zoneId });
      cte2 = await actor(roles.cte, { scopeType: 'ZONE', scopeZoneId: zoneId });
      // Responsable commercial : portée TEAM sur l'équipe qu'il dirige (cte1, cte2).
      const rcoUser = await insertTestUser(trx);
      const team = await insertTestTeam(trx, rcoUser, admin);
      await insertTestTeamMembership(trx, team, cte1.userId, admin);
      await insertTestTeamMembership(trx, team, cte2.userId, admin);
      await assignTestRole(trx, rcoUser, roles.rco, admin, {
        scopeType: 'TEAM',
        scopeTeamId: team,
      });
      rco = {
        userId: rcoUser,
        deviceId: await insertTestDevice(trx, rcoUser, { status: 'ACTIVE' }),
      };
      ven = await actor(roles.ven, { scopeType: 'SITE', scopeSiteId: siteId });
      fin = await actor(roles.fin);
      dir = await actor(roles.dir);

      lostReasonId = freshUuid();
      visitReasonId = freshUuid();
      for (const [id, category] of [
        [lostReasonId, 'PROSPECT_LOST'],
        [visitReasonId, 'VISIT_OUTCOME'],
      ] as const) {
        await trx
          .insertInto('catalog_reason_codes')
          .values({
            id: toBin(id),
            category,
            code: `TEST_${id.replace(/-/g, '').slice(-12).toUpperCase()}`,
            label: 'Motif de test',
            created_by: toBin(admin),
          })
          .execute();
      }
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('BR-CRM-003 : création par un commercial terrain — acquéreur, titulaire, première étape, historique', async () => {
    const { id, phone, result } = await createCustomer(cte1);
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const row = await customer(id);
    expect(row.stage).toBe('PROSPECT');
    expect(fromBin(row.acquired_by_user_id)).toBe(cte1.userId);
    expect(row.acquired_at.toISOString()).toBe(at('08:00:00'));
    expect(fromBinOrNull(row.owner_user_id)).toBe(cte1.userId);
    expect(row.phone_primary).toBe(`+237${phone}`); // normalisé E.164 (BR-CRM-006)
    expect(row.pipeline_step_id!.equals(await firstActiveStep())).toBe(true);
    const periods = await assignments(id);
    expect(periods).toHaveLength(1);
    expect(fromBin(periods[0]!.user_id)).toBe(cte1.userId);
    expect(periods[0]!.valid_to).toBeNull();
    const history = await db
      .selectFrom('crm_customer_stage_history')
      .select(['from_stage', 'to_stage'])
      .where('customer_id', '=', toBin(id))
      .execute();
    expect(history).toEqual([{ from_stage: null, to_stage: 'PROSPECT' }]);
  });

  it('BR-CRM-002 et validations : ni téléphone ni GPS, téléphone, zone, source, périmètre', async () => {
    const noWayToFind = await createCustomer(cte1, { phonePrimary: null });
    expect(noWayToFind.result.status).toBe('REJECTED');
    const code = (r: Awaited<ReturnType<typeof run>>) =>
      r.status === 'REJECTED' ? r.error.code : r.status;
    expect(code(noWayToFind.result)).toMatch(/^VALIDATION_ERROR/);
    expect(code((await createCustomer(cte1, { phonePrimary: '12ab' })).result)).toBe(
      'PHONE_INVALID',
    );
    expect(code((await createCustomer(cte1, { zoneId: freshUuid() })).result)).toBe('ZONE_INVALID');
    expect(code((await createCustomer(cte1, { sourceCode: 'INCONNUE' })).result)).toBe(
      'REFERENCE_INVALID',
    );
    // Zone hors de l'affectation du commercial terrain (OWN ∩ ZONE).
    expect(code((await createCustomer(cte1, { zoneId: otherZoneId })).result)).toBe(
      'FORBIDDEN_SCOPE',
    );
    // Position GPS seule : suffisante pour retrouver le compte.
    const gpsOnly = await createCustomer(cte1, {
      phonePrimary: null,
      position: { lat: 4.0511, lng: 9.7679, accuracyM: 12 },
    });
    expect(gpsOnly.result.status).toBe('APPLIED');
  });

  it('BR-CRM-003 : un vendeur de PDV crée un compte sans titulaire, rattaché à son site', async () => {
    const { id, result } = await createCustomer(ven);
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const row = await customer(id);
    expect(row.owner_user_id).toBeNull();
    expect(fromBinOrNull(row.home_site_id)).toBe(siteId);
    expect(fromBin(row.acquired_by_user_id)).toBe(ven.userId);
    expect(await assignments(id)).toHaveLength(0);
  });

  it('BR-CRM-003 : un responsable désigne le commercial acquéreur ; un non-commercial est refusé', async () => {
    const designated = await createCustomer(rco, { acquiredByUserId: cte1.userId });
    expect(designated.result.status, JSON.stringify(designated.result)).toBe('APPLIED');
    const row = await customer(designated.id);
    expect(fromBin(row.acquired_by_user_id)).toBe(cte1.userId);
    expect(fromBinOrNull(row.owner_user_id)).toBe(cte1.userId);
    expect(fromBin(row.created_by)).toBe(rco.userId);

    const refused = await createCustomer(rco, { acquiredByUserId: ven.userId });
    expect(refused.result.status === 'REJECTED' && refused.result.error.code).toBe(
      'ASSIGNEE_INVALID',
    );
  });

  it('BR-CRM-006 : doublon de téléphone refusé en ligne, sans divulguer le compte hors périmètre', async () => {
    const original = await createCustomer(cte1);
    const byColleague = await createCustomer(cte2, { phonePrimary: original.phone });
    expect(byColleague.result).toMatchObject({
      status: 'REJECTED',
      error: {
        code: 'DUPLICATE_CUSTOMER',
        message_fr: 'Compte existant, suivi par un autre commercial.',
      },
    });
    const byOwner = await createCustomer(cte1, { phonePrimary: `+237${original.phone}` });
    expect(byOwner.result.status === 'REJECTED' && byOwner.result.error.message_fr).toContain(
      'votre périmètre',
    );
  });

  it('AT-012 : même prospect créé hors ligne sur deux appareils — conflit, fusion, acquéreur le plus ancien', async () => {
    const first = await createCustomer(cte1, {}, { occurredAt: at('08:00:00'), offline: true });
    expect(first.result.status).toBe('APPLIED');
    const second = await createCustomer(
      cte2,
      { phonePrimary: first.phone, displayName: 'Même boutique' },
      { occurredAt: at('09:00:00'), offline: true },
    );
    expect(second.result).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['DUPLICATE_CUSTOMER'],
    });
    expect(fromBinOrNull((await customer(second.id)).duplicate_of_id)).toBe(first.id);
    const conflict = await db
      .selectFrom('sync_sync_conflicts')
      .selectAll()
      .where('entity_id', '=', toBin(second.id))
      .executeTakeFirstOrThrow();
    expect(conflict).toMatchObject({
      conflict_type: 'DUPLICATE_CUSTOMER',
      status: 'OPEN',
      owner_role: 'RESP_COMMERCIAL',
      applied: 1,
    });

    // Le compte conservé est le plus anciennement acquis.
    const wrongWay = await run(rco, 'crm.customer.merge', first.id, at('12:00:00'), {
      intoCustomerId: second.id,
    });
    expect(wrongWay.status === 'REJECTED' && wrongWay.error.code).toBe('MERGE_INVALID');
    const merged = await run(rco, 'crm.customer.merge', second.id, at('12:00:00'), {
      intoCustomerId: first.id,
    });
    expect(merged.status, JSON.stringify(merged)).toBe('APPLIED');

    const absorbed = await customer(second.id);
    expect(absorbed.stage).toBe('MERGED');
    expect(fromBinOrNull(absorbed.merged_into_id)).toBe(first.id);
    const absorbedPeriods = await assignments(second.id);
    expect(absorbedPeriods[0]!.valid_to?.toISOString()).toBe(at('12:00:00'));
    const kept = await customer(first.id);
    expect(fromBin(kept.acquired_by_user_id)).toBe(cte1.userId);
    expect(kept.phone_key).toBe(`+237${first.phone}`);
    const resolved = await db
      .selectFrom('sync_sync_conflicts')
      .select(['status', 'resolution'])
      .where('id', '=', conflict.id)
      .executeTakeFirstOrThrow();
    expect(resolved).toEqual({ status: 'RESOLVED', resolution: 'MERGE' });
  });

  it('AT-012 (variante) : le doublon synchronisé en second a été acquis en premier — il est conservé', async () => {
    const appliedFirst = await createCustomer(
      cte1,
      {},
      { occurredAt: at('10:00:00'), offline: true },
    );
    const acquiredFirst = await createCustomer(
      cte2,
      { phonePrimary: appliedFirst.phone },
      { occurredAt: at('07:00:00'), offline: true },
    );
    expect(acquiredFirst.result.status).toBe('APPLIED_WITH_WARNINGS');
    const merged = await run(rco, 'crm.customer.merge', appliedFirst.id, at('12:00:00'), {
      intoCustomerId: acquiredFirst.id,
    });
    expect(merged.status, JSON.stringify(merged)).toBe('APPLIED');
    const kept = await customer(acquiredFirst.id);
    expect(kept.duplicate_of_id).toBeNull(); // n'est plus un doublon en attente
    expect(kept.phone_key).toBe(`+237${appliedFirst.phone}`); // unicité du téléphone rétablie
    expect(fromBin(kept.acquired_by_user_id)).toBe(cte2.userId);
    expect((await customer(appliedFirst.id)).stage).toBe('MERGED');
  });

  it('INV-CRM-05 : chaîne de fusion aplatie — un compte fusionné pointe vers un compte non fusionné', async () => {
    const x = await createCustomer(cte1, {}, { occurredAt: at('07:00:00') });
    const y = await createCustomer(cte1, {}, { occurredAt: at('08:00:00') });
    const z = await createCustomer(cte1, {}, { occurredAt: at('09:00:00') });
    expect(
      (await run(dir, 'crm.customer.merge', z.id, at('12:00:00'), { intoCustomerId: y.id })).status,
    ).toBe('APPLIED');
    expect(
      (await run(dir, 'crm.customer.merge', y.id, at('12:30:00'), { intoCustomerId: x.id })).status,
    ).toBe('APPLIED');
    expect(fromBinOrNull((await customer(z.id)).merged_into_id)).toBe(x.id);
    expect(fromBinOrNull((await customer(y.id)).merged_into_id)).toBe(x.id);
    const again = await run(dir, 'crm.customer.merge', y.id, at('13:00:00'), {
      intoCustomerId: x.id,
    });
    expect(again.status === 'REJECTED' && again.error.code).toBe('MERGE_INVALID');
  });

  it('matrice des conflits : modification champ par champ — la valeur la plus récente l’emporte, conflit informatif', async () => {
    const { id } = await createCustomer(cte1);
    const first = await run(
      cte1,
      'crm.customer.update',
      id,
      at('10:00:00'),
      { patch: { displayName: 'Chez Mama' } },
      { baseVersion: 1 },
    );
    expect(first.status, JSON.stringify(first)).toBe('APPLIED');
    // BR-CRM-021 : valeurs avant et après journalisées.
    const audit = await db
      .selectFrom('audit_audit_log')
      .select(['before', 'after'])
      .where('command_id', '=', toBin(first.command_id))
      .executeTakeFirstOrThrow();
    expect(audit.before).toEqual({ displayName: 'Boutique test' });
    expect(audit.after).toEqual({ displayName: 'Chez Mama' });

    // Autre appareil, hors ligne, depuis la version 1 : adresse appliquée, nom en collision perdue.
    const older = await run(
      cte1,
      'crm.customer.update',
      id,
      at('09:00:00'),
      { patch: { displayName: 'Mama Boutique', addressText: 'Akwa, face pharmacie' } },
      { baseVersion: 1, offline: true },
    );
    expect(older).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['VERSION_CONFLICT'],
    });
    let row = await customer(id);
    expect(row.display_name).toBe('Chez Mama');
    expect(row.address_text).toBe('Akwa, face pharmacie');
    const conflict = await db
      .selectFrom('sync_sync_conflicts')
      .select(['conflict_type', 'owner_role', 'details'])
      .where('entity_id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    expect(conflict.conflict_type).toBe('VERSION_CONFLICT');
    expect(conflict.owner_role).toBe('TITULAIRE');
    expect(conflict.details).toMatchObject({
      collisions: [
        {
          field: 'displayName',
          clientValue: 'Mama Boutique',
          serverValue: 'Chez Mama',
          winner: 'SERVER',
        },
      ],
    });

    // Collision plus récente que l'écriture serveur : la valeur du client est appliquée.
    const newer = await run(
      cte1,
      'crm.customer.update',
      id,
      at('11:00:00'),
      { patch: { displayName: 'Mama Poulets' } },
      { baseVersion: 1, offline: true },
    );
    expect(newer.status).toBe('APPLIED_WITH_WARNINGS');
    row = await customer(id);
    expect(row.display_name).toBe('Mama Poulets');
  });

  it('modification : téléphone d’un autre compte, compte introuvable, hors périmètre', async () => {
    const a = await createCustomer(cte1);
    const b = await createCustomer(cte1);
    const code = (r: Awaited<ReturnType<typeof run>>) =>
      r.status === 'REJECTED' ? r.error.code : r.status;
    expect(
      code(
        await run(cte1, 'crm.customer.update', b.id, at('10:00:00'), {
          patch: { phonePrimary: a.phone },
        }),
      ),
    ).toBe('DUPLICATE_CUSTOMER');
    expect(
      code(
        await run(cte1, 'crm.customer.update', b.id, at('10:00:00'), {
          patch: { phonePrimary: null },
        }),
      ),
    ).toBe('CUSTOMER_NOT_FINDABLE');
    expect(
      code(
        await run(cte2, 'crm.customer.update', b.id, at('10:00:00'), {
          patch: { addressText: 'x' },
        }),
      ),
    ).toBe('FORBIDDEN_SCOPE');
    const gps = await run(cte1, 'crm.customer.update', b.id, at('10:05:00'), {
      patch: { phonePrimary: null, position: { lat: 4.05, lng: 9.7, accuracyM: 8 } },
    });
    expect(gps.status, JSON.stringify(gps)).toBe('APPLIED');
    const row = await customer(b.id);
    expect(row.phone_primary).toBeNull();
    expect(Number(row.lat)).toBeCloseTo(4.05, 6);
  });

  it('SM-CUSTOMER : deux changements d’étape concurrents — la plus récente reste courante, l’autre est historisée', async () => {
    const { id } = await createCustomer(cte1);
    const contacte = await stepId('CONTACTE');
    const interesse = await stepId('INTERESSE');
    expect(
      (
        await run(cte1, 'crm.customer.set_pipeline_step', id, at('10:00:00'), {
          stepId: fromBin(contacte),
        })
      ).status,
    ).toBe('APPLIED');
    expect(
      (
        await run(
          cte1,
          'crm.customer.set_pipeline_step',
          id,
          at('09:00:00'),
          { stepId: fromBin(interesse) },
          { offline: true },
        )
      ).status,
    ).toBe('APPLIED');
    expect((await customer(id)).pipeline_step_id!.equals(contacte)).toBe(true);
    const history = await db
      .selectFrom('crm_customer_stage_history')
      .select(['from_step_id', 'to_step_id', 'occurred_at'])
      .where('customer_id', '=', toBin(id))
      .orderBy('occurred_at', 'asc')
      .execute();
    expect(history.map((h) => h.occurred_at.toISOString())).toEqual([
      at('08:00:00'),
      at('09:00:00'),
      at('10:00:00'),
    ]);
    expect(history[1]!.to_step_id!.equals(interesse)).toBe(true);
    expect(history[1]!.from_step_id!.equals(await firstActiveStep())).toBe(true); // étape en vigueur à 09:00
  });

  it('BR-CRM-009 : perte avec motif PROSPECT_LOST, transitions invalides, réouverture', async () => {
    const { id } = await createCustomer(cte1);
    const code = (r: Awaited<ReturnType<typeof run>>) =>
      r.status === 'REJECTED' ? r.error.code : r.status;
    expect(
      code(
        await run(cte1, 'crm.customer.mark_lost', id, at('10:00:00'), {
          reasonCodeId: visitReasonId,
        }),
      ),
    ).toBe('REFERENCE_INVALID');
    expect(
      code(
        await run(cte1, 'crm.customer.mark_lost', id, at('10:00:00'), {
          reasonCodeId: lostReasonId,
        }),
      ),
    ).toBe('APPLIED');
    let row = await customer(id);
    expect(row.stage).toBe('LOST');
    expect(fromBinOrNull(row.lost_reason_code_id)).toBe(lostReasonId);
    expect(
      code(
        await run(cte1, 'crm.customer.set_pipeline_step', id, at('10:30:00'), {
          stepId: fromBin(await stepId('CONTACTE')),
        }),
      ),
    ).toBe('STAGE_TRANSITION_INVALID');
    expect(
      code(
        await run(cte1, 'crm.customer.mark_lost', id, at('10:40:00'), {
          reasonCodeId: lostReasonId,
        }),
      ),
    ).toBe('STAGE_TRANSITION_INVALID');
    expect(code(await run(cte1, 'crm.customer.reopen', id, at('11:00:00'), {}))).toBe('APPLIED');
    row = await customer(id);
    expect(row.stage).toBe('PROSPECT');
    expect(row.lost_reason_code_id).toBeNull();
    expect(row.pipeline_step_id!.equals(await firstActiveStep())).toBe(true);
    const stages = await db
      .selectFrom('crm_customer_stage_history')
      .select(['from_stage', 'to_stage'])
      .where('customer_id', '=', toBin(id))
      .orderBy('occurred_at', 'asc')
      .execute();
    expect(stages).toEqual([
      { from_stage: null, to_stage: 'PROSPECT' },
      { from_stage: 'PROSPECT', to_stage: 'LOST' },
      { from_stage: 'LOST', to_stage: 'PROSPECT' },
    ]);
  });

  it('BR-CRM-020 / AT-013 (partiel) : réaffectation — périodes contiguës, motif, droits évalués à occurred_at', async () => {
    const { id } = await createCustomer(cte1, {}, { occurredAt: at('08:00:00') });
    const code = (r: Awaited<ReturnType<typeof run>>) =>
      r.status === 'REJECTED' ? r.error.code : r.status;
    const reassigned = await run(rco, 'crm.customer.reassign', id, at('12:00:00'), {
      newOwnerUserId: cte2.userId,
      reason: 'Réorganisation des tournées',
    });
    expect(reassigned.status, JSON.stringify(reassigned)).toBe('APPLIED');
    const periods = await assignments(id);
    expect(
      periods.map((p) => [
        fromBin(p.user_id),
        p.valid_from.toISOString(),
        p.valid_to?.toISOString() ?? null,
      ]),
    ).toEqual([
      [cte1.userId, at('08:00:00'), at('12:00:00')],
      [cte2.userId, at('12:00:00'), null],
    ]);
    expect(periods[1]!.reason).toBe('Réorganisation des tournées');
    expect(fromBinOrNull((await customer(id)).owner_user_id)).toBe(cte2.userId);
    const audit = await db
      .selectFrom('audit_audit_log')
      .select(['before', 'after'])
      .where('command_id', '=', toBin(reassigned.command_id))
      .executeTakeFirstOrThrow();
    expect(audit.before).toEqual({ ownerUserId: cte1.userId });

    expect(
      code(
        await run(rco, 'crm.customer.reassign', id, at('12:30:00'), {
          newOwnerUserId: cte2.userId,
          reason: 'x',
        }),
      ),
    ).toBe('ASSIGNEE_INVALID');
    expect(
      code(
        await run(rco, 'crm.customer.reassign', id, at('12:30:00'), {
          newOwnerUserId: ven.userId,
          reason: 'x',
        }),
      ),
    ).toBe('ASSIGNEE_INVALID');
    // D02 §12 : l'ancien titulaire garde ses opérations antérieures à la réaffectation.
    expect(
      code(
        await run(cte1, 'crm.customer.update', id, at('11:00:00'), {
          patch: { addressText: 'Deido' },
        }),
      ),
    ).toBe('APPLIED');
    expect(
      code(
        await run(cte1, 'crm.customer.update', id, at('13:00:00'), {
          patch: { addressText: 'Bali' },
        }),
      ),
    ).toBe('FORBIDDEN_SCOPE');
    expect(
      code(
        await run(cte2, 'crm.customer.update', id, at('13:00:00'), {
          patch: { addressText: 'Bali' },
        }),
      ),
    ).toBe('APPLIED');
  });

  it('BR-CRM-022 : conditions de crédit réservées à crm.customer.credit_manage', async () => {
    const { id } = await createCustomer(cte1);
    const terms = { creditAllowed: true, creditLimitXaf: 150_000, paymentTermsDays: 30 };
    const byFinance = await run(fin, 'crm.customer.set_credit_terms', id, at('10:00:00'), terms);
    expect(byFinance.status, JSON.stringify(byFinance)).toBe('APPLIED');
    const row = await customer(id);
    expect(row.credit_allowed).toBe(1);
    expect(Number(row.credit_limit_xaf)).toBe(150_000);
    expect(row.payment_terms_days).toBe(30);
    const bySeller = await run(cte1, 'crm.customer.set_credit_terms', id, at('10:00:00'), terms);
    expect(bySeller.status === 'REJECTED' && bySeller.error.code).toBe('FORBIDDEN');
  });

  it('crm.pipeline.configure : création, code immuable, code en double, désactivation', async () => {
    const id = freshUuid();
    const code = `T${id.replace(/-/g, '').slice(-10).toUpperCase()}`;
    const configure = (actor: Actor, stepIdValue: string, payload: Record<string, unknown>) =>
      run(actor, 'crm.pipeline.configure', stepIdValue, at('09:00:00'), payload, {
        aggregateType: 'PIPELINE_STEP',
      });
    const base = { code, label: 'Étape de test', sortOrder: 900, isActive: true };
    expect((await configure(dir, id, base)).status).toBe('APPLIED');
    const immutable = await configure(dir, id, { ...base, code: `${code}X` });
    expect(immutable.status === 'REJECTED' && immutable.error.code).toBe('CODE_IMMUTABLE');
    const duplicate = await configure(dir, freshUuid(), base);
    expect(duplicate.status === 'REJECTED' && duplicate.error.code).toBe('CODE_EXISTS');
    expect((await configure(dir, id, { ...base, label: 'Relance', isActive: false })).status).toBe(
      'APPLIED',
    );
    const row = await db
      .selectFrom('crm_pipeline_steps')
      .select(['label', 'is_active'])
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ label: 'Relance', is_active: 0 });
    const bySeller = await configure(cte1, freshUuid(), { ...base, code: `${code}Y` });
    expect(bySeller.status === 'REJECTED' && bySeller.error.code).toBe('FORBIDDEN');
  });

  it('UC-CRM-07 / AT-011 (partiel) : conversion à la première vente confirmée, y compris via la chaîne de fusion', async () => {
    const { id } = await createCustomer(cte1);
    const convert = (customerId: string, saleId: string, occurredAt: string) =>
      db.transaction().execute((trx) =>
        convertOnConfirmedSale(trx, {
          customerId,
          saleId,
          saleOccurredAt: new Date(occurredAt),
          actorUserId: cte1.userId,
          historyId: freshUuid(),
        }),
      );
    const s1 = freshUuid();
    expect(await convert(id, s1, at('10:00:00'))).toBe('CONVERTED');
    let row = await customer(id);
    expect(row.stage).toBe('CUSTOMER');
    expect(row.converted_at?.toISOString()).toBe(at('10:00:00'));
    expect(fromBinOrNull(row.first_sale_id)).toBe(s1);
    const s0 = freshUuid();
    expect(await convert(id, s0, at('09:00:00'))).toBe('FIRST_SALE_UPDATED'); // vente antérieure synchronisée après
    expect(await convert(id, freshUuid(), at('11:00:00'))).toBe('UNCHANGED');
    row = await customer(id);
    expect(fromBinOrNull(row.first_sale_id)).toBe(s0);
    expect(row.converted_at?.toISOString()).toBe(at('09:00:00'));
    expect(row.last_sale_at?.toISOString()).toBe(at('11:00:00'));
    await db.transaction().execute((trx) => markConversionReverted(trx, id));
    expect((await customer(id)).conversion_reverted).toBe(1);

    // Vente enregistrée sur un compte absorbé : la conversion porte sur le compte conservé.
    const kept = await createCustomer(cte1, {}, { occurredAt: at('07:00:00') });
    const absorbed = await createCustomer(cte1, {}, { occurredAt: at('08:00:00') });
    await run(dir, 'crm.customer.merge', absorbed.id, at('12:00:00'), { intoCustomerId: kept.id });
    expect(await convert(absorbed.id, freshUuid(), at('13:00:00'))).toBe('CONVERTED');
    expect((await customer(kept.id)).stage).toBe('CUSTOMER');
    expect((await customer(absorbed.id)).stage).toBe('MERGED');
  });
});
