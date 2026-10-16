/**
 * Détection d'alertes de production **sur fait** (P9-09 ; D13 §7.1 ; ADR-071 §2, §3 ; AV-406, AV-121 ;
 * AV-461) : l'événement est publié dans la transaction du fait accompli, par le module propriétaire de
 * la donnée, sans jamais en faire échouer la commande (BR-SYN-007) — aucune fonction de ce fichier ne
 * lève sur une donnée (réglage invalide, libellé absent, effectif nul).
 *
 * `HIGH_MORTALITY` — D13 : « mortalité journalière > 0,5 % de l'effectif ou > 20 têtes ».
 * - **Cumul** : les morts du jour métier **du fait** (jamais celui de la synchronisation) d'un lot de
 *   production, validées ou en attente de validation (l'alerte précède la décision, D07 §14). Une saisie
 *   antidatée alimente l'alerte du jour du fait sans toucher à celle d'aujourd'hui.
 * - **Effectif de référence** : l'effectif en élevage au début du jour métier (précédent du taux de
 *   ponte, AV-116) ; pour un lot mis en place le jour même, l'effectif après la saisie plus les morts du
 *   jour ; sans effectif positif, seul le seuil absolu s'applique et le taux est omis (AV-461).
 * - **Seuils** : `production.high_mortality_alert_pct` et `production.high_mortality_alert_heads`
 *   (site, à défaut global ; repli 0,5 et 20 : un fait antidaté avant la date d'effet du réglage lit un
 *   réglage absent) ; comparaisons strictes (`packages/domain/src/production-alerts.ts`).
 * - **Cadence** : un événement par saisie tant que le cumul du jour reste au seuil ; l'alerte (un
 *   sujet lot × jour) compte les occurrences, et une alerte résolue renaît à la saisie suivante (AV-404).
 * - **Date de l'événement** : l'instant serveur (AV-457) — l'escalade de 4 h se compte depuis la
 *   détection, jamais depuis une date d'appareil ancienne ; le jour métier reste celui du fait.
 */
import {
  businessDayEndUtc,
  businessDayOf,
  businessDayStartUtc,
  highMortalityAlertHeadsOrDefault,
  highMortalityAlertPctOrDefault,
  highMortalityCause,
  highMortalityRatePct,
  mortalityReferenceHeadcount,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import {
  compositeSubjectId,
  publishDetectionEvent,
} from '../../../platform/events/detection-events.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import {
  lotHeadcount,
  productionLotMortalityByDay,
} from '../../inventory/application/public/index.js';
import { currentSettingValue } from '../../organization/application/public/index.js';

const PRODUCER = 'production';

/** Dépendances d'une publication : le générateur d'identifiants et, si l'appelant l'a, l'horloge. */
export interface ProductionAlertDeps {
  readonly idGenerator: IdGenerator;
  readonly clock?: Clock | undefined;
}

/** Réglage du site, à défaut global (règle 8 : aucun seuil codé en dur ; repli au domaine). */
export async function siteThenGlobalSetting(
  uow: UnitOfWork,
  key: string,
  siteId: string | null,
  at: Date,
): Promise<unknown> {
  if (siteId !== null) {
    const bySite = await currentSettingValue(uow, { key, scopeType: 'SITE', scopeId: siteId, at });
    if (bySite !== undefined) return bySite;
  }
  return currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at });
}

export interface HighMortalityInput {
  readonly lotId: string;
  readonly lotLabel: string;
  readonly siteId: string;
  /** Lot de stock de traçabilité du lot de production (effectif en élevage). */
  readonly stockLotId: string;
  readonly lossId: string;
  /** Instant du fait (jour métier du cumul et des règles). */
  readonly occurredAt: Date;
  readonly commandId: string;
  readonly capturedOffline: boolean;
}

/**
 * `HIGH_MORTALITY` : à appeler après l'enregistrement de la déclaration de mortalité (le cumul lu inclut
 * la saisie courante). Publie `HighMortalityDetected` si le cumul du jour du fait atteint un seuil.
 * Retourne `true` si un événement a été publié.
 */
export async function signalHighMortality(
  uow: UnitOfWork,
  deps: ProductionAlertDeps,
  input: HighMortalityInput,
): Promise<boolean> {
  const businessDay = businessDayOf(input.occurredAt);
  const dayStart = businessDayStartUtc(businessDay);
  const lines = await productionLotMortalityByDay(uow, {
    productionLotId: input.lotId,
    fromUtc: dayStart,
    toUtc: businessDayEndUtc(businessDay),
  });
  // Les lignes sont groupées par jour métier : l'intervalle d'un jour n'en contient qu'une.
  const heads = lines.reduce((sum, line) => sum + line.countedQuantity + line.pendingQuantity, 0);
  if (!(heads > 0)) return false;

  const pct = highMortalityAlertPctOrDefault(
    await siteThenGlobalSetting(
      uow,
      'production.high_mortality_alert_pct',
      input.siteId,
      input.occurredAt,
    ),
  );
  const headsThreshold = highMortalityAlertHeadsOrDefault(
    await siteThenGlobalSetting(
      uow,
      'production.high_mortality_alert_heads',
      input.siteId,
      input.occurredAt,
    ),
  );
  // Effectif en élevage juste avant le début du jour ; repli (lot mis en place le jour même) : l'effectif
  // à l'instant du fait plus les morts du jour déjà sorties de l'élevage.
  const startOfDay = await lotHeadcount(uow, {
    lotId: input.stockLotId,
    scope: 'REARING',
    at: new Date(dayStart.getTime() - 1),
  });
  const referenceHeadcount = mortalityReferenceHeadcount({
    startOfDayHeadcount: startOfDay,
    fallbackHeadcount:
      startOfDay > 0
        ? 0
        : (await lotHeadcount(uow, {
            lotId: input.stockLotId,
            scope: 'REARING',
            at: input.occurredAt,
          })) + heads,
  });
  const cause = highMortalityCause({ heads, referenceHeadcount, pct, headsThreshold });
  if (cause === null) return false;

  const ratePct = highMortalityRatePct(heads, referenceHeadcount);
  const payload: Record<string, unknown> = {
    lot_id: input.lotId,
    lot_label: input.lotLabel,
    business_day: businessDay,
    site_id: input.siteId,
    heads: Math.round(heads),
    rate_pct: ratePct,
    reference_headcount: referenceHeadcount,
    cause,
    threshold_pct: pct,
    threshold_heads: headsThreshold,
    last_loss_id: input.lossId,
    captured_offline: input.capturedOffline,
  };
  return publishDetectionEvent(uow, deps.idGenerator, {
    eventType: 'HighMortalityDetected',
    producerModule: PRODUCER,
    aggregateType: 'LOT_DAY',
    aggregateId: compositeSubjectId('HIGH_MORTALITY', payload),
    occurredAt: deps.clock?.now() ?? new Date(),
    commandId: input.commandId,
    payload,
  });
}
