/**
 * Utilitaires communs aux commandes `crm` (D02-CRM ; dictionnaire 04-crm-fieldwork) : chargement
 * et verrouillage d'un compte, titulaire à une date, portée d'autorisation d'un compte (RC-04),
 * « rôle commercial » (BR-CRM-003), paramètres système et historique de stade (BR-CRM-008).
 */
import { sql, type RawBuilder, type Selectable, type Transaction } from 'kysely';
import { DomainError, normalizePhone } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import type { CrmCustomers } from '../../../../platform/kysely/schema.generated.js';
import type { CommandHandlerOutcome } from '../../../../platform/sync/command-handler-registry.js';
import {
  fromBin,
  fromBinOrNull,
  toBin,
  toBinOrNull,
} from '../../../../platform/kysely/uuid-columns.js';
import {
  activeRoleCodesAt,
  evaluateAccess,
  type ResourceLocator,
} from '../../../identity/application/public/index.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';

export type Uow = Transaction<DB>;
export type CustomerRow = Selectable<CrmCustomers>;

export function rejected(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}

export const CUSTOMER_NOT_FOUND = rejected('CUSTOMER_NOT_FOUND', 'Compte client introuvable.');
export const CUSTOMER_MERGED = rejected(
  'CUSTOMER_MERGED',
  'Compte fusionné dans un autre compte : agir sur le compte conservé (BR-CRM-007).',
);
export const FORBIDDEN_SCOPE = rejected(
  'FORBIDDEN_SCOPE',
  'Compte hors de votre périmètre (BR-CRM-024).',
);

/** Compte verrouillé pour la durée de la transaction (`FOR UPDATE`). */
export async function lockCustomer(uow: Uow, customerId: string): Promise<CustomerRow | undefined> {
  return uow
    .selectFrom('crm_customers')
    .selectAll()
    .where('id', '=', toBin(customerId))
    .forUpdate()
    .executeTakeFirst();
}

/** Titulaire du compte à `at` (`crm.customer_assignments`, INV-CRM-02) ; `null` sans titulaire. */
export async function ownerAt(uow: Uow, customerId: Buffer, at: Date): Promise<string | null> {
  const row = await uow
    .selectFrom('crm_customer_assignments')
    .select('user_id')
    .where('customer_id', '=', customerId)
    .where('valid_from', '<=', at)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', at)]))
    .executeTakeFirst();
  return row ? fromBin(row.user_id) : null;
}

/**
 * Ressource d'autorisation d'un compte (RC-04) : titulaire **à `occurred_at`** (« les opérations
 * de l'ancien titulaire à `occurred_at` antérieur restent valides », D02 §12), site de
 * rattachement, zone.
 */
export async function customerResource(
  uow: Uow,
  customer: CustomerRow,
  at: Date,
): Promise<ResourceLocator> {
  const owner = await ownerAt(uow, customer.id, at);
  const siteId = fromBinOrNull(customer.home_site_id);
  return {
    ...(owner !== null ? { ownerUserId: owner } : {}),
    ...(siteId !== null ? { siteId } : {}),
    zoneId: fromBin(customer.zone_id),
  };
}

export async function isAllowed(
  uow: Uow,
  userId: string,
  permissionCode: string,
  at: Date,
  resource: ResourceLocator,
): Promise<boolean> {
  return (await evaluateAccess(uow, { userId, permissionCode, occurredAt: at, resource })).allowed;
}

const DEFAULT_COMMERCIAL_ROLE_CODES = [
  'RESP_COMMERCIAL',
  'COMMERCIAL_TERRAIN',
  'COMMERCIAL_SEDENTAIRE',
];

/**
 * BR-CRM-003 / BR-CRM-020 : « rôle commercial » — un rôle actif à `at` parmi le paramètre
 * `crm.commercial_role_codes` (DÉDUIT, paramétrable ; défaut : les trois rôles commerciaux).
 */
export async function hasCommercialRoleAt(uow: Uow, userId: string, at: Date): Promise<boolean> {
  const setting = await currentSettingValue(uow, {
    key: 'crm.commercial_role_codes',
    scopeType: 'GLOBAL',
    scopeId: null,
    at,
  });
  const codes = Array.isArray(setting)
    ? setting.filter((v): v is string => typeof v === 'string')
    : DEFAULT_COMMERCIAL_ROLE_CODES;
  const roles = await activeRoleCodesAt(uow, userId, at);
  return roles.some((code) => codes.includes(code));
}

/** Téléphone normalisé E.164 (BR-CRM-006) ; indicatif par défaut : paramètre système. */
export async function normalizePhoneAt(uow: Uow, raw: string, at: Date): Promise<string> {
  const setting = await currentSettingValue(uow, {
    key: 'crm.phone_default_country_code',
    scopeType: 'GLOBAL',
    scopeId: null,
    at,
  });
  const countryCode = setting === undefined || setting === null ? '237' : String(setting);
  return normalizePhone(raw, countryCode);
}

/** `DomainError` → rejet métier ; toute autre erreur est relancée (erreur transitoire). */
export async function catchDomain<T>(
  fn: () => Promise<T>,
): Promise<{ readonly value: T } | { readonly rejected: CommandHandlerOutcome }> {
  try {
    return { value: await fn() };
  } catch (error) {
    if (error instanceof DomainError) return { rejected: rejected(error.code, error.message) };
    throw error;
  }
}

/** Première étape active du pipeline (ordre d'affichage, puis code) — AV-011. */
export async function firstActiveStepId(uow: Uow): Promise<Buffer | undefined> {
  const row = await uow
    .selectFrom('crm_pipeline_steps')
    .select('id')
    .where('is_active', '=', 1)
    .orderBy('sort_order', 'asc')
    .orderBy('code', 'asc')
    .limit(1)
    .executeTakeFirst();
  return row?.id;
}

export async function isActiveZone(uow: Uow, zoneId: string): Promise<boolean> {
  const row = await uow
    .selectFrom('organization_zones')
    .select('is_active')
    .where('id', '=', toBin(zoneId))
    .executeTakeFirst();
  return row !== undefined && Boolean(row.is_active);
}

export async function isActiveSite(uow: Uow, siteId: string): Promise<boolean> {
  const row = await uow
    .selectFrom('organization_sites')
    .select('status')
    .where('id', '=', toBin(siteId))
    .executeTakeFirst();
  return row?.status === 'ACTIVE';
}

export async function isActiveLeadSource(uow: Uow, code: string): Promise<boolean> {
  const row = await uow
    .selectFrom('crm_lead_sources')
    .select('is_active')
    .where('code', '=', code)
    .executeTakeFirst();
  return row !== undefined && Boolean(row.is_active);
}

/** Catégorie de client (`catalog.customer_categories`, référentiel partagé lu par clé). */
export async function isActiveCustomerCategory(uow: Uow, categoryId: string): Promise<boolean> {
  const row = await uow
    .selectFrom('catalog_customer_categories')
    .select('is_active')
    .where('id', '=', toBin(categoryId))
    .executeTakeFirst();
  return row !== undefined && Boolean(row.is_active);
}

/** BR-CRM-008 : tout changement de stade ou d'étape est historisé. */
export async function recordStageChange(
  uow: Uow,
  input: {
    readonly id: string;
    readonly customerId: Buffer;
    readonly fromStage: string | null;
    readonly toStage: string;
    readonly fromStepId: Buffer | null;
    readonly toStepId: Buffer | null;
    readonly occurredAt: Date;
    readonly actorUserId: string;
    readonly reasonCodeId?: string | null;
    readonly causeRef?: string | null;
    readonly commandId: string | null;
  },
): Promise<void> {
  await uow
    .insertInto('crm_customer_stage_history')
    .values({
      id: toBin(input.id),
      customer_id: input.customerId,
      from_stage: input.fromStage,
      to_stage: input.toStage,
      from_step_id: input.fromStepId,
      to_step_id: input.toStepId,
      occurred_at: input.occurredAt,
      actor_user_id: toBin(input.actorUserId),
      reason_code_id: toBinOrNull(input.reasonCodeId ?? null),
      cause_ref: toBinOrNull(input.causeRef ?? null),
      command_id: toBinOrNull(input.commandId),
    })
    .execute();
}

/** Dernière écriture connue de chaque champ modifiable (`field_versions`, dictionnaire). */
export function fieldVersionsOf(
  customer: CustomerRow,
): Record<string, { readonly version: number; readonly occurredAt: string }> {
  const raw = customer.field_versions;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, { version: number; occurredAt: string }> = {};
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const { version, occurredAt } = value as { version?: unknown; occurredAt?: unknown };
    if (typeof version === 'number' && typeof occurredAt === 'string') {
      result[field] = { version, occurredAt };
    }
  }
  return result;
}

/**
 * Colonne `DATE` (jour métier, ex. prochaine action, période d'objectif) écrite depuis sa forme
 * `AAAA-MM-JJ` : MySQL convertit la chaîne, sans dépendre du fuseau du processus Node (un `Date`
 * serait converti en heure locale par mysql2).
 */
export function dateColumn(value: string): RawBuilder<Date> {
  return sql<Date>`${value}`;
}

/** Forme `AAAA-MM-JJ` d'une colonne `DATE` lue (mysql2 : minuit local). */
export function formatDateColumn(value: Date | null): string | null {
  if (value === null) return null;
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Droit d'agir sur un compte pour un **fait** saisi (visite, interaction) : la portée évaluée à
 * `occurred_at` (RC-04) ; hors ligne, l'ancien titulaire réaffecté entre-temps reste autorisé —
 * « Postérieures : acceptées (visites, commandes) et attribuées selon BR-CRM-020 » (D02 §12) —
 * s'il détenait le compte avant `occurred_at` et garde la permission sur son propre portefeuille.
 */
export async function canRecordFactOn(
  uow: Uow,
  input: {
    readonly userId: string;
    readonly permissionCode: string;
    readonly at: Date;
    readonly customer: CustomerRow;
    readonly capturedOffline: boolean;
  },
): Promise<boolean> {
  const resource = await customerResource(uow, input.customer, input.at);
  if (await isAllowed(uow, input.userId, input.permissionCode, input.at, resource)) return true;
  if (!input.capturedOffline) return false;
  const formerOwner = await uow
    .selectFrom('crm_customer_assignments')
    .select('id')
    .where('customer_id', '=', input.customer.id)
    .where('user_id', '=', toBin(input.userId))
    .where('valid_from', '<=', input.at)
    .executeTakeFirst();
  if (!formerOwner) return false;
  return isAllowed(uow, input.userId, input.permissionCode, input.at, {
    ...resource,
    ownerUserId: input.userId,
  });
}
