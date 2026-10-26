/**
 * `sales.commercial.inactivity_check` (P9-07 ; BR-TER-013, D13 §7.1 `INACTIVE_COMMERCIAL`, AV-359,
 * ADR-061 §2, §3) : chaque jour à 08:00, publie un événement `InactiveCommercialDetected` par commercial
 * sans **aucune** activité le jour ouvré précédent, puis le marqueur de fin de passe.
 *
 * - **Activité** (BR-TER-013) : une prise de service, une visite enregistrée ou une vente le jour
 *   examiné. Une session dont la dérogation est refusée, une visite annulée et un simple appel ne
 *   comptent pas.
 * - **Jours ouvrés** (`sales.commercial_working_days`, numéros ISO, lundi à samedi par défaut) : un jour
 *   examiné non ouvré ne publie **rien, pas même le marqueur** ; les alertes ouvertes persistent
 *   jusqu'au prochain jour ouvré examiné.
 * - **Population** : utilisateurs actifs affectés avant le jour examiné à un rôle de
 *   `sales.inactive_commercial_role_codes` (`COMMERCIAL_TERRAIN` par défaut, AV-394).
 * - Lectures seules par les API publiques de `fieldwork` et `crm` ; les ventes sont à `sales`.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  addBusinessDays,
  businessDayEndUtc,
  businessDayOf,
  businessDayStartUtc,
  isoWeekdayOfBusinessDay,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  detectionPassId,
  passSlotOf,
  publishDetectionEvent,
  publishPassCompleted,
} from '../../../../platform/events/detection-events.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { toBin, fromBin } from '../../../../platform/kysely/uuid-columns.js';
import { listVisits } from '../../../crm/application/public/index.js';
import { listWorkSessions } from '../../../fieldwork/application/public/index.js';
import { userFullNames } from '../../../identity/application/public/index.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import { trackedCommercialsAt } from './commercial-population.js';

export const INACTIVE_COMMERCIAL_JOB_TYPE = 'sales.commercial.inactivity_check';
export const COMMERCIAL_WORKING_DAYS_KEY = 'sales.commercial_working_days';
export const INACTIVE_COMMERCIAL_ROLES_KEY = 'sales.inactive_commercial_role_codes';
const DEFAULT_WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5, 6];
const DEFAULT_ROLE_CODES: readonly string[] = ['COMMERCIAL_TERRAIN'];
const VISIT_PAGE = 500;

const listSetting = (value: unknown): readonly string[] | null =>
  Array.isArray(value) ? value.map((item) => String(item).trim()).filter((s) => s !== '') : null;

/** Jours ouvrés ISO : valeurs 1 à 7 ; une liste vide ou invalide retombe sur le défaut. */
export function workingDaysOf(value: unknown): readonly number[] {
  const parsed = listSetting(value)
    ?.map((item) => Number(item))
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  return parsed !== undefined && parsed !== null && parsed.length > 0
    ? parsed
    : DEFAULT_WORKING_DAYS;
}

export function roleCodesOf(value: unknown): readonly string[] {
  const parsed = listSetting(value);
  return parsed !== null && parsed.length > 0 ? parsed : DEFAULT_ROLE_CODES;
}

/** Utilisateurs ayant eu une activité le jour métier examiné (prise de service, visite, vente). */
export async function activeUserIdsOn(
  uow: UnitOfWork,
  userIds: readonly string[],
  day: string,
): Promise<Set<string>> {
  const active = new Set<string>();
  if (userIds.length === 0) return active;
  const fromUtc = businessDayStartUtc(day);
  const toUtc = businessDayEndUtc(day);

  for (const session of await listWorkSessions(uow, { userIds, fromUtc, toUtc })) {
    if (session.overrideStatus !== 'REJECTED') active.add(session.userId);
  }

  let beforeId: string | undefined;
  for (;;) {
    const page = await listVisits(uow, {
      userIds,
      fromUtc,
      toUtc,
      limit: VISIT_PAGE,
      ...(beforeId !== undefined ? { beforeId } : {}),
    });
    for (const visit of page.items) {
      if (visit.status === 'RECORDED') active.add(visit.userId);
    }
    if (page.nextCursor === null) break;
    beforeId = page.nextCursor;
  }

  const ids = userIds.map(toBin);
  const sold = await uow
    .selectFrom('sales_sales')
    .select(['seller_user_id', 'commercial_user_id'])
    .where('business_date', '=', new Date(`${day}T00:00:00.000Z`))
    .where('status', '<>', 'CANCELLED')
    .where((eb) => eb.or([eb('seller_user_id', 'in', ids), eb('commercial_user_id', 'in', ids)]))
    .execute();
  for (const sale of sold) {
    active.add(fromBin(sale.seller_user_id));
    if (sale.commercial_user_id !== null) active.add(fromBin(sale.commercial_user_id));
  }
  return active;
}

@Injectable()
export class InactiveCommercialJob implements OnModuleInit {
  private readonly logger = new Logger(InactiveCommercialJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(INACTIVE_COMMERCIAL_JOB_TYPE, async (uow, payload) => {
      const now = this.clock.now();
      // Le jour examiné est la veille du **créneau planifié** (rattrapage après une interruption : la veille
      // du créneau manqué, non celle de l'exécution) ; sans créneau lisible, la veille de l'instant courant.
      const slot = new Date(passSlotOf(payload, now));
      const examinedDay = addBusinessDays(
        businessDayOf(Number.isNaN(slot.getTime()) ? now : slot),
        -1,
      );
      const setting = (key: string) =>
        currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at: now });
      const workingDays = workingDaysOf(await setting(COMMERCIAL_WORKING_DAYS_KEY));
      if (!workingDays.includes(isoWeekdayOfBusinessDay(examinedDay))) {
        // Jour non ouvré : aucune alerte levée ni résolue (le marqueur résoudrait celle de la veille).
        this.logger.log(`Jour non ouvré ${examinedDay} : suivi des commerciaux sans objet.`);
        return;
      }
      const passId = detectionPassId('INACTIVE_COMMERCIAL', passSlotOf(payload, now));
      const roleCodes = roleCodesOf(await setting(INACTIVE_COMMERCIAL_ROLES_KEY));
      const tracked = await trackedCommercialsAt(uow, {
        roleCodes,
        dayStart: businessDayStartUtc(examinedDay),
      });
      const active = await activeUserIdsOn(
        uow,
        tracked.map((commercial) => commercial.userId),
        examinedDay,
      );
      const inactive = tracked.filter((commercial) => !active.has(commercial.userId));
      const names = await userFullNames(
        uow,
        inactive.map((commercial) => commercial.userId),
      );
      let published = 0;
      for (const commercial of inactive) {
        const inserted = await publishDetectionEvent(uow, this.idGenerator, {
          eventType: 'InactiveCommercialDetected',
          producerModule: 'sales',
          aggregateType: 'USER',
          aggregateId: commercial.userId,
          occurredAt: now,
          passId,
          payload: {
            user_id: commercial.userId,
            user_label: names.get(commercial.userId) ?? null,
            inactive_day: examinedDay,
            business_day: examinedDay,
            role_code: commercial.roleCode,
            ...(commercial.zoneId !== null ? { zone_id: commercial.zoneId } : {}),
          },
        });
        if (inserted) published += 1;
      }
      await publishPassCompleted(uow, {
        producerModule: 'sales',
        alertType: 'INACTIVE_COMMERCIAL',
        passId,
        businessDay: examinedDay,
        occurredAt: now,
      });
      this.logger.log(
        `Commerciaux sans activité le ${examinedDay} : ${published} sur ${tracked.length}.`,
      );
    });
  }
}
