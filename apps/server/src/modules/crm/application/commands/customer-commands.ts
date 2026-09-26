/**
 * Commandes du compte client (D02-CRM ; SM-CUSTOMER ; dictionnaire 04-crm-fieldwork) :
 * `crm.customer.create`, `.update`, `.set_pipeline_step`, `.mark_lost`, `.reopen`, `.reassign`,
 * `.merge`, `.set_credit_terms`.
 *
 * - Création (fait accompli hors ligne) : acquéreur = créateur ou commercial désigné, titulaire =
 *   l'acquéreur s'il a un rôle commercial, sinon rattachement au site (BR-CRM-003). Doublon de
 *   téléphone : refusé en ligne, sans divulguer le compte hors périmètre ; hors ligne, le compte
 *   est enregistré, rattaché au compte existant (`duplicate_of_id`) avec le conflit informatif
 *   `DUPLICATE_CUSTOMER`, résolu par la fusion (BR-CRM-006).
 * - Modification (intention avec `base_version`) : fusion champ par champ (`mergeFieldPatch`) ;
 *   une collision sur un même champ garde la valeur la plus récente et ouvre un conflit
 *   informatif `VERSION_CONFLICT` pour le titulaire (matrice des conflits). Valeurs avant et après
 *   journalisées (BR-CRM-021).
 * - Étape de pipeline : deux changements concurrents gardent l'étape la plus récente, l'autre
 *   reste dans l'historique (SM-CUSTOMER).
 * - Fusion : le compte conservé est le plus anciennement acquis, dont l'acquéreur est ainsi
 *   retenu sans toucher à l'acquéreur immuable (BR-CRM-007, INV-CRM-01) ; la chaîne de fusion
 *   est aplatie (INV-CRM-05).
 */
import { z } from 'zod';
import { sql, type Updateable } from 'kysely';
import { mergeFieldPatch, type FieldCollision, type IdGenerator } from '@gic/domain';
import type { CrmCustomers } from '../../../../platform/kysely/schema.generated.js';
import type {
  CommandHandler,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import { recordConflict, resolveOpenConflicts } from '../../../../platform/sync/conflicts.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import {
  fromBin,
  fromBinOrNull,
  toBin,
  toBinOrNull,
} from '../../../../platform/kysely/uuid-columns.js';
import {
  activeSiteAssignmentsAt,
  checkUserActive,
} from '../../../identity/application/public/index.js';
import { findReasonCode } from '../../../catalog/application/public/index.js';
import {
  CUSTOMER_MERGED,
  CUSTOMER_NOT_FOUND,
  FORBIDDEN_SCOPE,
  catchDomain,
  customerResource,
  fieldVersionsOf,
  firstActiveStepId,
  hasCommercialRoleAt,
  isActiveCustomerCategory,
  isActiveLeadSource,
  isActiveSite,
  isActiveZone,
  isAllowed,
  lockCustomer,
  normalizePhoneAt,
  recordStageChange,
  rejected,
  type CustomerRow,
  type Uow,
} from './shared.js';

const positionSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().nonnegative().nullable().optional(),
});

/** Champs modifiables d'un compte (création et `crm.customer.update`). */
const customerFields = {
  displayName: z.string().trim().min(1).max(200),
  customerType: z.enum(['PARTICULIER', 'ENTREPRISE']),
  contactName: z.string().trim().max(200).nullable(),
  businessActivity: z.string().trim().max(200).nullable(),
  categoryId: z.string().uuid().nullable(),
  phonePrimary: z.string().trim().min(1).max(30).nullable(),
  phoneSecondary: z.string().trim().min(1).max(30).nullable(),
  email: z.string().trim().email().max(200).nullable(),
  addressText: z.string().trim().max(2000).nullable(),
  zoneId: z.string().uuid(),
  position: positionSchema.nullable(),
  sourceCode: z.string().trim().min(1).max(40),
};
type FieldName = keyof typeof customerFields;
const FIELD_NAMES = Object.keys(customerFields) as FieldName[];

const createPayloadSchema = z
  .object({
    displayName: customerFields.displayName,
    customerType: customerFields.customerType.optional(),
    contactName: customerFields.contactName.optional(),
    businessActivity: customerFields.businessActivity.optional(),
    categoryId: customerFields.categoryId.optional(),
    phonePrimary: customerFields.phonePrimary.optional(),
    phoneSecondary: customerFields.phoneSecondary.optional(),
    email: customerFields.email.optional(),
    addressText: customerFields.addressText.optional(),
    zoneId: customerFields.zoneId,
    position: customerFields.position.optional(),
    sourceCode: customerFields.sourceCode,
    /** Commercial désigné par un responsable comme acquéreur (BR-CRM-003). */
    acquiredByUserId: z.string().uuid().optional(),
    /** Site de rattachement d'un compte sans titulaire (vendeur de PDV). */
    homeSiteId: z.string().uuid().optional(),
  })
  .refine((p) => (p.phonePrimary ?? null) !== null || (p.position ?? null) !== null, {
    message: 'Téléphone ou position GPS requis pour retrouver le compte (BR-CRM-002).',
  });
type CreatePayload = z.infer<typeof createPayloadSchema>;

const updatePayloadSchema = z.object({
  patch: z
    .object(customerFields)
    .partial()
    .refine((patch) => Object.keys(patch).length > 0, { message: 'Aucun champ à modifier.' }),
});
type UpdatePayload = z.infer<typeof updatePayloadSchema>;

const stepPayloadSchema = z.object({ stepId: z.string().uuid() });
const lostPayloadSchema = z.object({
  reasonCodeId: z.string().uuid(),
  comment: z.string().trim().min(1).max(2000).optional(),
});
const reopenPayloadSchema = z.object({ comment: z.string().trim().min(1).max(2000).optional() });
const reassignPayloadSchema = z.object({
  newOwnerUserId: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
});
const mergePayloadSchema = z.object({ intoCustomerId: z.string().uuid() });
const creditPayloadSchema = z.object({
  creditAllowed: z.boolean(),
  creditLimitXaf: z.number().int().nonnegative().nullable(),
  paymentTermsDays: z.number().int().min(0).max(3650).nullable(),
});

const STAGE_TRANSITION_INVALID = (messageFr: string) =>
  rejected('STAGE_TRANSITION_INVALID', messageFr);

interface Position {
  readonly lat: number;
  readonly lng: number;
  readonly accuracyM: number | null;
}

/** Position dans un ordre de clés fixe (comparaison par contenu, `mergeFieldPatch`). */
function positionOf(input: {
  lat: number;
  lng: number;
  accuracyM?: number | null | undefined;
}): Position {
  return { lat: input.lat, lng: input.lng, accuracyM: input.accuracyM ?? null };
}

/** Valeurs courantes comparables d'un compte, par champ. */
function currentValuesOf(customer: CustomerRow): Record<FieldName, unknown> {
  return {
    displayName: customer.display_name,
    customerType: customer.customer_type,
    contactName: customer.contact_name,
    businessActivity: customer.business_activity,
    categoryId: fromBinOrNull(customer.category_id),
    phonePrimary: customer.phone_primary,
    phoneSecondary: customer.phone_secondary,
    email: customer.email,
    addressText: customer.address_text,
    zoneId: fromBin(customer.zone_id),
    position:
      customer.lat === null || customer.lng === null
        ? null
        : positionOf({
            lat: Number(customer.lat),
            lng: Number(customer.lng),
            accuracyM: customer.geo_accuracy_m === null ? null : Number(customer.geo_accuracy_m),
          }),
    sourceCode: customer.source_code,
  };
}

function columnsOf(field: FieldName, value: unknown): Updateable<CrmCustomers> {
  switch (field) {
    case 'displayName':
      return { display_name: value as string };
    case 'customerType':
      return { customer_type: value as string };
    case 'contactName':
      return { contact_name: value as string | null };
    case 'businessActivity':
      return { business_activity: value as string | null };
    case 'categoryId':
      return { category_id: toBinOrNull(value as string | null) };
    case 'phonePrimary':
      return { phone_primary: value as string | null };
    case 'phoneSecondary':
      return { phone_secondary: value as string | null };
    case 'email':
      return { email: value as string | null };
    case 'addressText':
      return { address_text: value as string | null };
    case 'zoneId':
      return { zone_id: toBin(value as string) };
    case 'position': {
      const position = value as Position | null;
      return position === null
        ? { lat: null, lng: null, geo_accuracy_m: null }
        : {
            lat: String(position.lat),
            lng: String(position.lng),
            geo_accuracy_m: position.accuracyM === null ? null : String(position.accuracyM),
          };
    }
    case 'sourceCode':
      return { source_code: value as string };
  }
}

/** Référentiels d'un ensemble de champs saisis (zone, source, catégorie) ; `undefined` si valides. */
async function checkReferences(
  uow: Uow,
  fields: {
    zoneId?: string | undefined;
    sourceCode?: string | undefined;
    categoryId?: string | null | undefined;
  },
) {
  if (fields.zoneId !== undefined && !(await isActiveZone(uow, fields.zoneId))) {
    return rejected('ZONE_INVALID', 'Zone inexistante ou inactive.');
  }
  if (fields.sourceCode !== undefined && !(await isActiveLeadSource(uow, fields.sourceCode))) {
    return rejected('REFERENCE_INVALID', 'Source inconnue ou inactive.');
  }
  if (
    fields.categoryId !== undefined &&
    fields.categoryId !== null &&
    !(await isActiveCustomerCategory(uow, fields.categoryId))
  ) {
    return rejected('REFERENCE_INVALID', 'Catégorie de client inconnue ou inactive.');
  }
  return undefined;
}

/** Autre compte détenant ce téléphone parmi les comptes uniques (INV-CRM-03). */
async function phoneHolder(
  uow: Uow,
  phone: string,
  exceptId?: Buffer,
): Promise<CustomerRow | undefined> {
  return uow
    .selectFrom('crm_customers')
    .selectAll()
    .where('phone_key', '=', phone)
    .$if(exceptId !== undefined, (qb) => qb.where('id', '<>', exceptId!))
    .executeTakeFirst();
}

function withVersions(
  customer: CustomerRow,
  fields: readonly string[],
  occurredAt: Date,
): ReturnType<typeof jsonValue> {
  const versions: Record<string, { version: number; occurredAt: string }> = {
    ...fieldVersionsOf(customer),
  };
  for (const field of fields) {
    versions[field] = { version: customer.version + 1, occurredAt: occurredAt.toISOString() };
  }
  return jsonValue(versions);
}

function buildHandlers(idGenerator: IdGenerator) {
  const create: CommandHandler<CreatePayload> = async (uow, envelope) => {
    const customerId = envelope.aggregate_id;
    const replay = await uow
      .selectFrom('crm_customers')
      .select('id')
      .where('id', '=', toBin(customerId))
      .executeTakeFirst();
    if (replay) return { status: 'APPLIED' }; // rejeu sous un autre command_id

    const p = envelope.payload;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const invalid = await checkReferences(uow, p);
    if (invalid) return invalid;

    const phones = await catchDomain(async () => ({
      primary: p.phonePrimary ? await normalizePhoneAt(uow, p.phonePrimary, at) : null,
      secondary: p.phoneSecondary ? await normalizePhoneAt(uow, p.phoneSecondary, at) : null,
    }));
    if ('rejected' in phones) return phones.rejected;

    // BR-CRM-003 : acquéreur = créateur, ou commercial désigné par un responsable.
    const acquiredBy = p.acquiredByUserId ?? author;
    const acquirerIsCommercial = await hasCommercialRoleAt(uow, acquiredBy, at);
    if (acquiredBy !== author) {
      const active = await checkUserActive(uow, toBin(acquiredBy), at);
      if (!active.ok || !acquirerIsCommercial) {
        return rejected(
          'ASSIGNEE_INVALID',
          "Le commercial désigné n'est pas un commercial actif (BR-CRM-003).",
        );
      }
    }
    const ownerId = acquirerIsCommercial ? acquiredBy : null;
    let homeSiteId = p.homeSiteId ?? null;
    if (ownerId === null && homeSiteId === null) {
      const sites = await activeSiteAssignmentsAt(uow, author, at);
      if (sites.length === 1) homeSiteId = sites[0]!;
    }
    if (ownerId === null && homeSiteId === null) {
      return rejected(
        'HOME_SITE_REQUIRED',
        'Compte sans titulaire : site de rattachement requis (BR-CRM-003).',
      );
    }
    if (homeSiteId !== null && !(await isActiveSite(uow, homeSiteId))) {
      return rejected('REFERENCE_INVALID', 'Site de rattachement inconnu ou inactif.');
    }
    const resource = {
      ...(ownerId !== null ? { ownerUserId: ownerId } : {}),
      ...(homeSiteId !== null ? { siteId: homeSiteId } : {}),
      zoneId: p.zoneId,
    };
    if (!(await isAllowed(uow, author, 'crm.customer.create', at, resource))) {
      return FORBIDDEN_SCOPE;
    }

    const stepId = await firstActiveStepId(uow);
    if (!stepId) {
      return rejected(
        'PIPELINE_NOT_CONFIGURED',
        'Aucune étape de pipeline active (crm.pipeline.configure).',
      );
    }

    // BR-CRM-006 : doublon de téléphone.
    let duplicateOf: CustomerRow | undefined;
    if (phones.value.primary !== null) {
      duplicateOf = await phoneHolder(uow, phones.value.primary);
      if (duplicateOf && !envelope.captured_offline) {
        // RC-07 : rien n'est révélé d'un compte hors périmètre.
        const readable = await isAllowed(
          uow,
          author,
          'crm.customer.read',
          at,
          await customerResource(uow, duplicateOf, at),
        );
        return rejected(
          'DUPLICATE_CUSTOMER',
          readable
            ? 'Ce téléphone appartient déjà à un compte de votre périmètre.'
            : 'Compte existant, suivi par un autre commercial.',
        );
      }
    }

    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const position = p.position ? positionOf(p.position) : null;
    await uow
      .insertInto('crm_customers')
      .values({
        id: toBin(customerId),
        stage: 'PROSPECT',
        pipeline_step_id: stepId,
        customer_type: p.customerType ?? 'PARTICULIER',
        display_name: p.displayName,
        contact_name: p.contactName ?? null,
        business_activity: p.businessActivity ?? null,
        category_id: toBinOrNull(p.categoryId ?? null),
        phone_primary: phones.value.primary,
        phone_secondary: phones.value.secondary,
        email: p.email ?? null,
        address_text: p.addressText ?? null,
        zone_id: toBin(p.zoneId),
        lat: position === null ? null : String(position.lat),
        lng: position === null ? null : String(position.lng),
        geo_accuracy_m:
          position === null || position.accuracyM === null ? null : String(position.accuracyM),
        source_code: p.sourceCode,
        acquired_by_user_id: toBin(acquiredBy),
        acquired_at: at,
        owner_user_id: toBinOrNull(ownerId),
        home_site_id: toBinOrNull(homeSiteId),
        duplicate_of_id: duplicateOf ? duplicateOf.id : null,
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
    if (ownerId !== null) {
      await uow
        .insertInto('crm_customer_assignments')
        .values({
          id: toBin(idGenerator.newId()),
          customer_id: toBin(customerId),
          user_id: toBin(ownerId),
          valid_from: at,
          assigned_by: toBin(author),
          command_id: toBin(envelope.command_id),
        })
        .execute();
    }
    await recordStageChange(uow, {
      id: idGenerator.newId(),
      customerId: toBin(customerId),
      fromStage: null,
      toStage: 'PROSPECT',
      fromStepId: null,
      toStepId: stepId,
      occurredAt: at,
      actorUserId: author,
      commandId: envelope.command_id,
    });

    if (duplicateOf) {
      await recordConflict(uow, {
        id: idGenerator.newId(),
        commandId: envelope.command_id,
        conflictType: 'DUPLICATE_CUSTOMER',
        entityType: 'CUSTOMER',
        entityId: customerId,
        siteId: homeSiteId,
        ownerRole: 'RESP_COMMERCIAL',
        applied: true,
        details: {
          existingCustomerId: fromBin(duplicateOf.id),
          phone: phones.value.primary,
          resolution: 'crm.customer.merge (BR-CRM-007)',
        },
      });
      return { status: 'APPLIED_WITH_WARNINGS', warnings: ['DUPLICATE_CUSTOMER'] };
    }
    return { status: 'APPLIED' };
  };

  const update: CommandHandler<UpdatePayload> = async (uow, envelope) => {
    const customer = await lockCustomer(uow, envelope.aggregate_id);
    if (!customer) return CUSTOMER_NOT_FOUND;
    if (customer.stage === 'MERGED') return CUSTOMER_MERGED;
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    if (
      !(await isAllowed(
        uow,
        author,
        'crm.customer.update',
        at,
        await customerResource(uow, customer, at),
      ))
    ) {
      return FORBIDDEN_SCOPE;
    }

    const patch = envelope.payload.patch;
    const invalid = await checkReferences(uow, patch);
    if (invalid) return invalid;
    const normalized = await catchDomain(async () => {
      const values: Partial<Record<FieldName, unknown>> = {};
      for (const field of FIELD_NAMES) {
        if (!(field in patch)) continue;
        const value = patch[field];
        if ((field === 'phonePrimary' || field === 'phoneSecondary') && typeof value === 'string') {
          values[field] = await normalizePhoneAt(uow, value, at);
        } else if (field === 'position' && value !== null && value !== undefined) {
          values[field] = positionOf(value as { lat: number; lng: number; accuracyM?: number });
        } else {
          values[field] = value ?? null;
        }
      }
      return values;
    });
    if ('rejected' in normalized) return normalized.rejected;

    const current = currentValuesOf(customer);
    const merge = mergeFieldPatch({
      patch: normalized.value,
      baseVersion: envelope.base_version,
      clientOccurredAt: at,
      fieldVersions: fieldVersionsOf(customer),
      currentValues: current,
    });
    const appliedFields = Object.keys(merge.applied) as FieldName[];

    // Unicité du téléphone et « retrouvable » (INV-CRM-03, BR-CRM-002) sur l'état résultant.
    const newPhone = merge.applied.phonePrimary;
    if (typeof newPhone === 'string' && newPhone !== customer.phone_primary) {
      if (await phoneHolder(uow, newPhone, customer.id)) {
        return rejected('DUPLICATE_CUSTOMER', 'Ce téléphone appartient déjà à un autre compte.');
      }
    }
    const resulting = { ...current, ...merge.applied };
    if (resulting.phonePrimary === null && resulting.position === null) {
      return rejected(
        'CUSTOMER_NOT_FINDABLE',
        'Téléphone ou position GPS requis pour retrouver le compte (BR-CRM-002).',
      );
    }

    if (appliedFields.length > 0) {
      let columns: Updateable<CrmCustomers> = {};
      for (const field of appliedFields) {
        columns = { ...columns, ...columnsOf(field, merge.applied[field]) };
      }
      await uow
        .updateTable('crm_customers')
        .set({
          ...columns,
          field_versions: withVersions(customer, appliedFields, at),
          updated_by: toBin(author),
          version: sql`version + 1`,
        })
        .where('id', '=', customer.id)
        .execute();
    }
    const audit = {
      before: Object.fromEntries(appliedFields.map((field) => [field, current[field]])),
      after: merge.applied,
    };
    if (merge.collisions.length > 0) {
      await recordCollisions(uow, idGenerator, customer, envelope, merge.collisions);
      return { status: 'APPLIED_WITH_WARNINGS', warnings: ['VERSION_CONFLICT'], audit };
    }
    return { status: 'APPLIED', audit };
  };

  const setPipelineStep: CommandHandler<z.infer<typeof stepPayloadSchema>> = async (
    uow,
    envelope,
  ) => {
    const customer = await lockCustomer(uow, envelope.aggregate_id);
    if (!customer) return CUSTOMER_NOT_FOUND;
    if (customer.stage === 'MERGED') return CUSTOMER_MERGED;
    if (customer.stage !== 'PROSPECT') {
      return STAGE_TRANSITION_INVALID('Seul un prospect a une étape de pipeline (BR-CRM-001).');
    }
    const step = await uow
      .selectFrom('crm_pipeline_steps')
      .select(['id', 'is_active'])
      .where('id', '=', toBin(envelope.payload.stepId))
      .executeTakeFirst();
    if (!step || !step.is_active) return STAGE_TRANSITION_INVALID('Étape inconnue ou inactive.');
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    if (
      !(await isAllowed(
        uow,
        author,
        'crm.customer.update',
        at,
        await customerResource(uow, customer, at),
      ))
    ) {
      return FORBIDDEN_SCOPE;
    }

    // Étape en vigueur à `occurred_at` (dernier changement antérieur), à défaut l'étape courante.
    const previous = await uow
      .selectFrom('crm_customer_stage_history')
      .select('to_step_id')
      .where('customer_id', '=', customer.id)
      .where('to_step_id', 'is not', null)
      .where('occurred_at', '<=', at)
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const fromStepId = previous?.to_step_id ?? customer.pipeline_step_id;
    if (fromStepId !== null && fromStepId.equals(step.id)) return { status: 'APPLIED' };
    await recordStageChange(uow, {
      id: idGenerator.newId(),
      customerId: customer.id,
      fromStage: 'PROSPECT',
      toStage: 'PROSPECT',
      fromStepId,
      toStepId: step.id,
      occurredAt: at,
      actorUserId: author,
      commandId: envelope.command_id,
    });
    // Changements concurrents : l'étape la plus récente (occurred_at) reste l'étape courante.
    const latest = fieldVersionsOf(customer).pipelineStepId;
    if (latest === undefined || at.getTime() >= new Date(latest.occurredAt).getTime()) {
      await uow
        .updateTable('crm_customers')
        .set({
          pipeline_step_id: step.id,
          field_versions: withVersions(customer, ['pipelineStepId'], at),
          updated_by: toBin(author),
          version: sql`version + 1`,
        })
        .where('id', '=', customer.id)
        .execute();
    }
    return { status: 'APPLIED' };
  };

  const markLost: CommandHandler<z.infer<typeof lostPayloadSchema>> = async (uow, envelope) => {
    const customer = await lockCustomer(uow, envelope.aggregate_id);
    if (!customer) return CUSTOMER_NOT_FOUND;
    if (customer.stage === 'MERGED') return CUSTOMER_MERGED;
    if (customer.stage !== 'PROSPECT') {
      return STAGE_TRANSITION_INVALID('Seul un prospect peut être marqué perdu (SM-CUSTOMER).');
    }
    const reason = await findReasonCode(uow, envelope.payload.reasonCodeId);
    if (!reason || !reason.isActive || reason.category !== 'PROSPECT_LOST') {
      return rejected(
        'REFERENCE_INVALID',
        'Motif de perte inconnu ou inactif (catégorie PROSPECT_LOST, BR-CRM-009).',
      );
    }
    if (reason.requiresComment && envelope.payload.comment === undefined) {
      return rejected('COMMENT_REQUIRED', 'Ce motif exige un commentaire.');
    }
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    if (
      !(await isAllowed(
        uow,
        author,
        'crm.customer.mark_lost',
        at,
        await customerResource(uow, customer, at),
      ))
    ) {
      return FORBIDDEN_SCOPE;
    }
    await uow
      .updateTable('crm_customers')
      .set({
        stage: 'LOST',
        lost_reason_code_id: toBin(reason.id),
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', customer.id)
      .execute();
    await recordStageChange(uow, {
      id: idGenerator.newId(),
      customerId: customer.id,
      fromStage: 'PROSPECT',
      toStage: 'LOST',
      fromStepId: customer.pipeline_step_id,
      toStepId: null,
      occurredAt: at,
      actorUserId: author,
      reasonCodeId: reason.id,
      commandId: envelope.command_id,
    });
    return { status: 'APPLIED' };
  };

  const reopen: CommandHandler<z.infer<typeof reopenPayloadSchema>> = async (uow, envelope) => {
    const customer = await lockCustomer(uow, envelope.aggregate_id);
    if (!customer) return CUSTOMER_NOT_FOUND;
    if (customer.stage === 'MERGED') return CUSTOMER_MERGED;
    if (customer.stage !== 'LOST') {
      return STAGE_TRANSITION_INVALID('Seul un compte perdu peut être rouvert (SM-CUSTOMER).');
    }
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    if (
      !(await isAllowed(
        uow,
        author,
        'crm.customer.mark_lost',
        at,
        await customerResource(uow, customer, at),
      ))
    ) {
      return FORBIDDEN_SCOPE;
    }
    const stepId = await firstActiveStepId(uow);
    if (!stepId) {
      return rejected('PIPELINE_NOT_CONFIGURED', 'Aucune étape de pipeline active.');
    }
    await uow
      .updateTable('crm_customers')
      .set({
        stage: 'PROSPECT',
        pipeline_step_id: stepId,
        lost_reason_code_id: null,
        field_versions: withVersions(customer, ['pipelineStepId'], at),
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', customer.id)
      .execute();
    await recordStageChange(uow, {
      id: idGenerator.newId(),
      customerId: customer.id,
      fromStage: 'LOST',
      toStage: 'PROSPECT',
      fromStepId: customer.pipeline_step_id,
      toStepId: stepId,
      occurredAt: at,
      actorUserId: author,
      commandId: envelope.command_id,
    });
    return { status: 'APPLIED' };
  };

  const reassign: CommandHandler<z.infer<typeof reassignPayloadSchema>> = async (uow, envelope) => {
    const customer = await lockCustomer(uow, envelope.aggregate_id);
    if (!customer) return CUSTOMER_NOT_FOUND;
    if (customer.stage === 'MERGED') return CUSTOMER_MERGED;
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    const newOwner = envelope.payload.newOwnerUserId;
    const current = await uow
      .selectFrom('crm_customer_assignments')
      .selectAll()
      .where('customer_id', '=', customer.id)
      .where('valid_to', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    const currentOwner = current ? fromBin(current.user_id) : null;
    if (newOwner === currentOwner) {
      return rejected('ASSIGNEE_INVALID', 'Ce commercial est déjà titulaire du compte.');
    }
    const active = await checkUserActive(uow, toBin(newOwner), at);
    if (!active.ok || !(await hasCommercialRoleAt(uow, newOwner, at))) {
      return rejected(
        'ASSIGNEE_INVALID',
        'Le nouveau titulaire doit être un utilisateur actif avec un rôle commercial.',
      );
    }
    // Droit de réaffecter sur le compte ET sur le nouveau titulaire (portée de l'opération, RC-04).
    const resource = await customerResource(uow, customer, at);
    const target = { ...resource, ownerUserId: newOwner };
    if (
      !(await isAllowed(uow, author, 'crm.customer.reassign', at, resource)) ||
      !(await isAllowed(uow, author, 'crm.customer.reassign', at, target))
    ) {
      return FORBIDDEN_SCOPE;
    }
    if (current && at.getTime() < current.valid_from.getTime()) {
      return rejected(
        'ASSIGNMENT_OVERLAP',
        "La réaffectation ne peut précéder l'affectation en cours (INV-CRM-02).",
      );
    }
    if (current) {
      await uow
        .updateTable('crm_customer_assignments')
        .set({ valid_to: at })
        .where('id', '=', current.id)
        .execute();
    }
    await uow
      .insertInto('crm_customer_assignments')
      .values({
        id: toBin(idGenerator.newId()),
        customer_id: customer.id,
        user_id: toBin(newOwner),
        valid_from: at,
        assigned_by: toBin(author),
        reason: envelope.payload.reason,
        command_id: toBin(envelope.command_id),
      })
      .execute();
    await uow
      .updateTable('crm_customers')
      .set({ owner_user_id: toBin(newOwner), updated_by: toBin(author), version: sql`version + 1` })
      .where('id', '=', customer.id)
      .execute();
    return {
      status: 'APPLIED',
      audit: {
        before: { ownerUserId: currentOwner },
        after: { ownerUserId: newOwner, reason: envelope.payload.reason },
      },
    };
  };

  const merge: CommandHandler<z.infer<typeof mergePayloadSchema>> = async (uow, envelope) => {
    const absorbedId = envelope.aggregate_id;
    const keptId = envelope.payload.intoCustomerId;
    if (absorbedId === keptId) {
      return rejected('MERGE_INVALID', 'Un compte ne peut pas être fusionné avec lui-même.');
    }
    // Verrous dans un ordre stable (identifiant) : deux fusions croisées ne s'interbloquent pas.
    const [firstId, secondId] = absorbedId < keptId ? [absorbedId, keptId] : [keptId, absorbedId];
    const first = await lockCustomer(uow, firstId);
    const second = await lockCustomer(uow, secondId);
    const absorbed = firstId === absorbedId ? first : second;
    const kept = firstId === absorbedId ? second : first;
    if (!absorbed || !kept) return CUSTOMER_NOT_FOUND;
    if (absorbed.stage === 'MERGED' || kept.stage === 'MERGED') {
      return rejected('MERGE_INVALID', 'Compte déjà fusionné.');
    }
    if (kept.acquired_at.getTime() > absorbed.acquired_at.getTime()) {
      return rejected(
        'MERGE_INVALID',
        'Le compte conservé doit être le plus anciennement acquis : son acquéreur est retenu (BR-CRM-007).',
      );
    }
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    if (
      !(await isAllowed(
        uow,
        author,
        'crm.customer.merge',
        at,
        await customerResource(uow, absorbed, at),
      )) ||
      !(await isAllowed(
        uow,
        author,
        'crm.customer.merge',
        at,
        await customerResource(uow, kept, at),
      ))
    ) {
      return FORBIDDEN_SCOPE;
    }

    // Compte absorbé : MERGED, titulaire clos, historique.
    const absorbedAssignment = await uow
      .selectFrom('crm_customer_assignments')
      .select(['id', 'valid_from'])
      .where('customer_id', '=', absorbed.id)
      .where('valid_to', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (absorbedAssignment) {
      await uow
        .updateTable('crm_customer_assignments')
        .set({
          valid_to:
            at.getTime() < absorbedAssignment.valid_from.getTime()
              ? absorbedAssignment.valid_from
              : at,
        })
        .where('id', '=', absorbedAssignment.id)
        .execute();
    }
    await uow
      .updateTable('crm_customers')
      .set({
        stage: 'MERGED',
        merged_into_id: kept.id,
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', absorbed.id)
      .execute();
    await recordStageChange(uow, {
      id: idGenerator.newId(),
      customerId: absorbed.id,
      fromStage: absorbed.stage,
      toStage: 'MERGED',
      fromStepId: absorbed.pipeline_step_id,
      toStepId: null,
      occurredAt: at,
      actorUserId: author,
      causeRef: keptId,
      commandId: envelope.command_id,
    });

    // INV-CRM-05 : chaîne aplatie — ce qui pointait vers l'absorbé pointe vers le conservé.
    await uow
      .updateTable('crm_customers')
      .set({ merged_into_id: kept.id, version: sql`version + 1` })
      .where('merged_into_id', '=', absorbed.id)
      .execute();
    await uow
      .updateTable('crm_customers')
      .set({ duplicate_of_id: kept.id, version: sql`version + 1` })
      .where('duplicate_of_id', '=', absorbed.id)
      .where('id', '<>', kept.id)
      .execute();

    // Compte conservé : il n'est plus un doublon en attente ; conversion portée par l'absorbé.
    const keptChanges: Updateable<CrmCustomers> = {};
    if (kept.duplicate_of_id !== null && kept.duplicate_of_id.equals(absorbed.id)) {
      keptChanges.duplicate_of_id = null;
    }
    if (absorbed.stage === 'CUSTOMER' && absorbed.converted_at !== null) {
      if (kept.stage !== 'CUSTOMER') {
        keptChanges.stage = 'CUSTOMER';
        keptChanges.converted_at = absorbed.converted_at;
        keptChanges.first_sale_id = absorbed.first_sale_id;
        await recordStageChange(uow, {
          id: idGenerator.newId(),
          customerId: kept.id,
          fromStage: kept.stage,
          toStage: 'CUSTOMER',
          fromStepId: kept.pipeline_step_id,
          toStepId: null,
          occurredAt: at,
          actorUserId: author,
          causeRef: absorbedId,
          commandId: envelope.command_id,
        });
      } else if (
        kept.converted_at === null ||
        absorbed.converted_at.getTime() < kept.converted_at.getTime()
      ) {
        keptChanges.converted_at = absorbed.converted_at;
        keptChanges.first_sale_id = absorbed.first_sale_id;
      }
    }
    if (
      absorbed.last_sale_at !== null &&
      (kept.last_sale_at === null || absorbed.last_sale_at.getTime() > kept.last_sale_at.getTime())
    ) {
      keptChanges.last_sale_at = absorbed.last_sale_at;
    }
    if (Object.keys(keptChanges).length > 0) {
      await uow
        .updateTable('crm_customers')
        .set({ ...keptChanges, updated_by: toBin(author), version: sql`version + 1` })
        .where('id', '=', kept.id)
        .execute();
    }

    await resolveOpenConflicts(uow, {
      conflictType: 'DUPLICATE_CUSTOMER',
      entityType: 'CUSTOMER',
      entityIds: [absorbedId, keptId],
      resolution: 'MERGE',
      resolvedBy: author,
      resolvedAt: at,
      refs: [keptId],
    });
    return {
      status: 'APPLIED',
      audit: {
        before: { stage: absorbed.stage, ownerUserId: fromBinOrNull(absorbed.owner_user_id) },
        after: { stage: 'MERGED', mergedIntoId: keptId },
      },
    };
  };

  const setCreditTerms: CommandHandler<z.infer<typeof creditPayloadSchema>> = async (
    uow,
    envelope,
  ) => {
    const customer = await lockCustomer(uow, envelope.aggregate_id);
    if (!customer) return CUSTOMER_NOT_FOUND;
    if (customer.stage === 'MERGED') return CUSTOMER_MERGED;
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    if (
      !(await isAllowed(
        uow,
        author,
        'crm.customer.credit_manage',
        at,
        await customerResource(uow, customer, at),
      ))
    ) {
      return FORBIDDEN_SCOPE;
    }
    const p = envelope.payload;
    await uow
      .updateTable('crm_customers')
      .set({
        credit_allowed: p.creditAllowed ? 1 : 0,
        credit_limit_xaf: p.creditLimitXaf,
        payment_terms_days: p.paymentTermsDays,
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', customer.id)
      .execute();
    return {
      status: 'APPLIED',
      audit: {
        before: {
          creditAllowed: Boolean(customer.credit_allowed),
          creditLimitXaf:
            customer.credit_limit_xaf === null ? null : Number(customer.credit_limit_xaf),
          paymentTermsDays: customer.payment_terms_days,
        },
        after: p,
      },
    };
  };

  return { create, update, setPipelineStep, markLost, reopen, reassign, merge, setCreditTerms };
}

/** Collisions de champs : conflit informatif pour le titulaire (matrice des conflits). */
async function recordCollisions(
  uow: Uow,
  idGenerator: IdGenerator,
  customer: CustomerRow,
  envelope: { command_id: string; base_version: number | null },
  collisions: readonly FieldCollision[],
): Promise<void> {
  await recordConflict(uow, {
    id: idGenerator.newId(),
    commandId: envelope.command_id,
    conflictType: 'VERSION_CONFLICT',
    entityType: 'CUSTOMER',
    entityId: fromBin(customer.id),
    siteId: fromBinOrNull(customer.home_site_id),
    ownerRole: 'TITULAIRE',
    applied: true,
    details: {
      baseVersion: envelope.base_version,
      serverVersion: customer.version,
      collisions,
    },
  });
}

export function registerCustomerCommands(
  registry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
): void {
  const handlers = buildHandlers(idGenerator);
  registry.register({
    commandType: 'crm.customer.create',
    version: 1,
    payloadSchema: createPayloadSchema,
    permissionCode: 'crm.customer.create',
    handler: handlers.create,
  });
  registry.register({
    commandType: 'crm.customer.update',
    version: 1,
    payloadSchema: updatePayloadSchema,
    permissionCode: 'crm.customer.update',
    handler: handlers.update,
  });
  registry.register({
    commandType: 'crm.customer.set_pipeline_step',
    version: 1,
    payloadSchema: stepPayloadSchema,
    permissionCode: 'crm.customer.update',
    handler: handlers.setPipelineStep,
  });
  registry.register({
    commandType: 'crm.customer.mark_lost',
    version: 1,
    payloadSchema: lostPayloadSchema,
    permissionCode: 'crm.customer.mark_lost',
    handler: handlers.markLost,
  });
  registry.register({
    commandType: 'crm.customer.reopen',
    version: 1,
    payloadSchema: reopenPayloadSchema,
    permissionCode: 'crm.customer.mark_lost',
    handler: handlers.reopen,
  });
  registry.register({
    commandType: 'crm.customer.reassign',
    version: 1,
    payloadSchema: reassignPayloadSchema,
    permissionCode: 'crm.customer.reassign',
    handler: handlers.reassign,
  });
  registry.register({
    commandType: 'crm.customer.merge',
    version: 1,
    payloadSchema: mergePayloadSchema,
    permissionCode: 'crm.customer.merge',
    handler: handlers.merge,
  });
  registry.register({
    commandType: 'crm.customer.set_credit_terms',
    version: 1,
    payloadSchema: creditPayloadSchema,
    permissionCode: 'crm.customer.credit_manage',
    handler: handlers.setCreditTerms,
  });
}
