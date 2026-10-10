/**
 * Fixtures des tests de remises de fonds (P5-15) : rôles réels du seed, comptes de trésorerie
 * propres à chaque scénario (base partagée et persistante : chaque test crée ses données et ne
 * vérifie que ses propres identifiants), alimentation d'un compte par un solde d'ouverture, lectures
 * du registre, des remises, des conflits, des événements et de l'audit.
 */
import type { Transaction } from 'kysely';
import type { IdGenerator } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import type { DB } from '../src/platform/kysely/database.js';
import type { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { recordCashMovement } from '../src/modules/finance/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  db,
  freshUuid,
  insertTestDevice,
  insertTestSite,
  insertTestUser,
  type TestAssignmentOptions,
} from './helpers.js';

export interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

export const tx = <T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> =>
  db.transaction().execute(fn);

export async function roleIdOf(code: string): Promise<string> {
  const row = await db
    .selectFrom('identity_roles')
    .select('id')
    .where('code', '=', code)
    .executeTakeFirstOrThrow();
  return fromBin(row.id);
}

/** Utilisateur actif, appareil actif, rôle réel du seed dans le périmètre donné. */
export async function newActor(
  roleCode: string,
  createdBy: string,
  scope: TestAssignmentOptions = { scopeType: 'GLOBAL' },
): Promise<Actor> {
  const roleId = await roleIdOf(roleCode);
  return tx(async (trx) => {
    const userId = await insertTestUser(trx);
    const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
    await assignTestRole(trx, userId, roleId, createdBy, scope);
    return { userId, deviceId };
  });
}

export async function newPosSite(createdBy: string, zoneId: string): Promise<string> {
  return tx((trx) => insertTestSite(trx, createdBy, zoneId, { siteType: 'POINT_DE_VENTE' }));
}

export async function siteCode(siteId: string): Promise<string> {
  const row = await db
    .selectFrom('organization_sites')
    .select('code')
    .where('id', '=', toBin(siteId))
    .executeTakeFirstOrThrow();
  return row.code;
}

export type AccountType =
  'CAISSE_PDV' | 'CAISSE_UTILISATEUR' | 'CAISSE_CENTRALE' | 'MOBILE_MONEY' | 'BANQUE';

/** Compte de trésorerie inséré directement (le responsable est un utilisateur actif). */
export async function newAccount(input: {
  readonly type: AccountType;
  readonly responsible: string;
  readonly siteId?: string;
  readonly holder?: string;
  readonly status?: 'ACTIVE' | 'INACTIVE';
}): Promise<string> {
  const id = freshUuid();
  await db
    .insertInto('finance_cash_accounts')
    .values({
      id: toBin(id),
      code: `CPT-${id.slice(-12)}`,
      name: `Compte ${input.type}`,
      account_type: input.type,
      ...(input.siteId !== undefined ? { site_id: toBin(input.siteId) } : {}),
      ...(input.holder !== undefined ? { holder_user_id: toBin(input.holder) } : {}),
      responsible_user_id: toBin(input.responsible),
      status: input.status ?? 'ACTIVE',
      created_by: toBin(input.responsible),
    })
    .execute();
  return id;
}

/** Solde d'ouverture injecté par la fixture (mouvement `OPENING_BALANCE`). */
export async function fund(
  idGenerator: IdGenerator,
  accountId: string,
  amountXaf: number,
  occurredAt: string,
  createdBy: string,
): Promise<void> {
  await tx((trx) =>
    recordCashMovement(
      trx,
      { idGenerator },
      {
        cashAccountId: accountId,
        direction: 'IN',
        amountXaf,
        movementType: 'OPENING_BALANCE',
        sourceDocType: 'CASH_SESSION',
        sourceDocId: freshUuid(),
        occurredAt: new Date(occurredAt),
        createdBy,
        allowNegative: false,
      },
    ),
  );
}

export async function balanceOf(accountId: string): Promise<number> {
  const row = await db
    .selectFrom('finance_cash_accounts')
    .select('balance_xaf')
    .where('id', '=', toBin(accountId))
    .executeTakeFirstOrThrow();
  return Number(row.balance_xaf);
}

export async function transferRow(id: string) {
  return db
    .selectFrom('finance_cash_transfers')
    .selectAll()
    .where('id', '=', toBin(id))
    .executeTakeFirst();
}

export async function movementsOf(transferId: string) {
  const rows = await db
    .selectFrom('finance_cash_movements')
    .selectAll()
    .where('source_doc_type', '=', 'CASH_TRANSFER')
    .where('source_doc_id', '=', toBin(transferId))
    .orderBy('id')
    .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    accountId: fromBin(row.cash_account_id),
    direction: row.direction,
    amountXaf: Number(row.amount_xaf),
    movementType: row.movement_type,
    occurredAt: row.occurred_at,
    isReversal: Boolean(row.is_reversal),
    reversesMovementId: row.reverses_movement_id ? fromBin(row.reverses_movement_id) : null,
  }));
}

export async function conflictsOf(entityId: string, conflictType?: string) {
  const rows = await db
    .selectFrom('sync_sync_conflicts')
    .selectAll()
    .where('entity_id', '=', toBin(entityId))
    .$if(conflictType !== undefined, (qb) => qb.where('conflict_type', '=', conflictType!))
    .execute();
  return rows.map((row) => ({
    conflictType: row.conflict_type,
    entityType: row.entity_type,
    ownerRole: row.owner_role,
    applied: Boolean(row.applied),
    status: row.status,
    details: (typeof row.details === 'string' ? JSON.parse(row.details) : row.details) as Record<
      string,
      unknown
    >,
  }));
}

export async function eventsOf(aggregateId: string, eventType?: string) {
  const rows = await db
    .selectFrom('platform_domain_events')
    .selectAll()
    .where('aggregate_id', '=', toBin(aggregateId))
    .$if(eventType !== undefined, (qb) => qb.where('event_type', '=', eventType!))
    .orderBy('seq')
    .execute();
  return rows.map((row) => ({
    eventType: row.event_type,
    producer: row.producer_module,
    occurredAt: row.occurred_at,
    payload: (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<
      string,
      unknown
    >,
  }));
}

const parsed = (value: unknown): Record<string, unknown> | null =>
  value === null
    ? null
    : ((typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>);

export async function auditOf(entityId: string) {
  const rows = await db
    .selectFrom('audit_audit_log')
    .select(['action', 'entity_type', 'result', 'after', 'before'])
    .where('entity_id', '=', toBin(entityId))
    .orderBy('seq')
    .execute();
  return rows.map((row) => ({
    action: row.action,
    entityType: row.entity_type,
    result: row.result,
    before: parsed(row.before),
    after: parsed(row.after),
  }));
}

export async function approvalOf(subjectId: string) {
  return db
    .selectFrom('approvals_approval_requests')
    .selectAll()
    .where('subject_id', '=', toBin(subjectId))
    .where('operation_type', '=', 'CASH_TRANSFER_DISCREPANCY')
    .orderBy('id')
    .execute();
}

/** Code d'un résultat : le code d'erreur d'un rejet, sinon le statut. */
export const codeOf = (result: CommandResult): string =>
  result.status === 'REJECTED' || result.status === 'CONFLICT'
    ? (result.error?.code ?? result.status)
    : result.status;

let deviceSeq = 0;

/** Exécute une commande à travers le vrai pipeline, en ligne (`/commands`) ou hors ligne (`SYNC_PUSH`). */
export function runCommand(
  pipeline: CommandPipelineService,
  actor: Actor,
  command: {
    readonly type: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly occurredAt: string;
    readonly payload: unknown;
    readonly offline?: boolean;
    readonly commandId?: string;
    /** Rejeu d'une enveloppe identique : même `command_id` **et** même `device_seq`. */
    readonly deviceSeq?: number;
  },
): Promise<CommandResult> {
  const offline = command.offline ?? false;
  return pipeline.handle(
    {
      command_id: command.commandId ?? freshUuid(),
      device_seq: command.deviceSeq ?? ++deviceSeq,
      command_version: 1,
      command_type: command.type,
      aggregate_type: command.aggregateType,
      aggregate_id: command.aggregateId,
      author_user_id: actor.userId,
      base_version: null,
      depends_on: [],
      occurred_at: command.occurredAt,
      client_created_at: command.occurredAt,
      captured_offline: offline,
      backdated_reason: null,
      attachment_ids: [],
      payload: command.payload,
    },
    {
      authenticatedUserId: actor.userId,
      authenticatedDeviceId: actor.deviceId,
      transport: offline ? 'SYNC_PUSH' : 'ONLINE_API',
    },
  );
}
