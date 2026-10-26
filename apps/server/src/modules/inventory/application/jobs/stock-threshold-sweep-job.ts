/**
 * `inventory.alerts.stock_threshold_sweep` (P9-08 ; D13 §7.1 ; AV-405 : « passe horaire en filet » ;
 * AV-452 : réapprovisionnement) : trois passes de détection d'état sur les seuils actifs, dans une seule
 * transaction et une seule lecture (`stockThresholdsOf`, trois requêtes quel que soit le nombre de
 * seuils) — `STOCK_LOW`, `STOCK_OUT` et `POS_REPLENISH`.
 *
 * - **Filet des transitions** : une transition sur mouvement (`recordStockMove`) ou un changement de
 *   seuil (`inventory.threshold.set`) lève et résout au fil de l'eau ; ce filet corrige ce qu'elles ont
 *   manqué (instantané perimé d'une transaction concurrente, règle d'alerte activée après coup, seuil
 *   créé sur un stock déjà vide) : chaque couple dans l'état est publié (`breached` vrai) avec l'identité
 *   de la passe, puis le marqueur de fin de passe **résout** les alertes que la passe ne revoit plus.
 * - **Réapprovisionnement** : un point de vente (`POS`) dont la suggestion « cible − disponible − transit
 *   entrant » est positive (`BELOW_TARGET`, D13 littéral) ou, selon `inventory.replenish_alert_scope`, sous
 *   son minimum (`BELOW_MINIMUM`). Pas d'événement sur mouvement : le transit entrant change la suggestion
 *   sans aucun mouvement du PDV, la passe horaire est donc la seule source (latence d'une heure au plus).
 * - **Identité de passe** : (type, créneau planifié) ; un rejeu du même créneau republie les mêmes
 *   identifiants d'événement (aucun doublon, aucun numéro de séquence consommé).
 *
 * Course passe / mouvement : un mouvement validé après l'instantané de la passe et avant son marqueur
 * peut voir son alerte résolue à tort jusqu'à la transition suivante ou à la passe suivante (une heure au
 * plus) ; la fenêtre est celle d'une transaction de quelques requêtes (AV-405).
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  businessDayOf,
  needsReplenishment,
  posReplenishScopeOrDefault,
  stockLevelOfState,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  detectionPassId,
  passSlotOf,
  publishPassCompleted,
} from '../../../../platform/events/detection-events.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import {
  currentSettingValue,
  findPosConfigBySalesLocation,
} from '../../../organization/application/public/index.js';
import { stockThresholdsOf } from '../public/document-query.js';
import {
  locationAlertInfos,
  productAlertLabel,
  publishReplenishmentSuggested,
  publishStockLevelEvent,
} from '../inventory-alert-events.js';

export const STOCK_THRESHOLD_SWEEP_JOB_TYPE = 'inventory.alerts.stock_threshold_sweep';

export const REPLENISH_ALERT_SCOPE_KEY = 'inventory.replenish_alert_scope';

/** Emplacements lus par requête de `stockThresholdsOf` (liste `IN`). */
const LOCATION_CHUNK = 200;

@Injectable()
export class StockThresholdSweepJob implements OnModuleInit {
  private readonly logger = new Logger(StockThresholdSweepJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(STOCK_THRESHOLD_SWEEP_JOB_TYPE, async (uow, payload) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const slot = passSlotOf(payload, now);
      const deps = { idGenerator: this.idGenerator, clock: this.clock };
      const lowPass = detectionPassId('STOCK_LOW', slot);
      const outPass = detectionPassId('STOCK_OUT', slot);
      const replenishPass = detectionPassId('POS_REPLENISH', slot);

      const locationRows = await uow
        .selectFrom('inventory_stock_thresholds')
        .select('location_id')
        .distinct()
        .where('is_active', '=', 1)
        .execute();
      const locationIds = locationRows.map((row) => fromBin(row.location_id));
      const statuses = [];
      for (let offset = 0; offset < locationIds.length; offset += LOCATION_CHUNK) {
        statuses.push(
          ...(await stockThresholdsOf(uow, {
            locationIds: locationIds.slice(offset, offset + LOCATION_CHUNK),
          })),
        );
      }
      const locations = await locationAlertInfos(uow, locationIds);
      const scope = posReplenishScopeOrDefault(
        await currentSettingValue(uow, {
          key: REPLENISH_ALERT_SCOPE_KEY,
          scopeType: 'GLOBAL',
          scopeId: null,
          at: now,
        }),
      );
      const productLabels = new Map<string, string>();
      const labelOf = async (productId: string): Promise<string> => {
        const known = productLabels.get(productId);
        if (known !== undefined) return known;
        const label = await productAlertLabel(uow, productId);
        productLabels.set(productId, label);
        return label;
      };

      let low = 0;
      let out = 0;
      let replenish = 0;
      for (const status of statuses) {
        const location = locations.get(status.locationId);
        const level = stockLevelOfState(status.state);
        if (level !== null) {
          const inserted = await publishStockLevelEvent(uow, deps, {
            locationId: status.locationId,
            productId: status.productId,
            level,
            breached: true,
            available: status.qtyAvailable,
            thresholdQty: status.minQtyBase,
            targetQty: status.targetQtyBase,
            locationLabel: location?.name ?? status.locationId,
            productLabel: await labelOf(status.productId),
            siteId: location?.siteId ?? null,
            businessDay: today,
            occurredAt: now,
            passId: level === 'LOW' ? lowPass : outPass,
          });
          if (inserted) {
            if (level === 'LOW') low += 1;
            else out += 1;
          }
        }
        if (
          location?.locationType === 'POS' &&
          needsReplenishment({
            scope,
            state: status.state,
            suggestedQty: status.suggestedQty,
          })
        ) {
          const config = await findPosConfigBySalesLocation(uow, status.locationId);
          const sourceId = config?.replenishmentSourceLocationId ?? null;
          const sourceLabel =
            sourceId === null
              ? null
              : ((await locationAlertInfos(uow, [sourceId])).get(sourceId)?.name ?? null);
          const inserted = await publishReplenishmentSuggested(uow, deps, {
            locationId: status.locationId,
            productId: status.productId,
            locationLabel: location.name,
            productLabel: await labelOf(status.productId),
            suggestedQuantity: status.suggestedQty,
            available: status.qtyAvailable,
            minQuantity: status.minQtyBase,
            targetQuantity: status.targetQtyBase,
            inTransitIn: status.qtyInTransitIn,
            siteId: location.siteId,
            sourceLocationId: sourceId,
            sourceLocationLabel: sourceLabel,
            businessDay: today,
            occurredAt: now,
            passId: replenishPass,
          });
          if (inserted) replenish += 1;
        }
      }

      // Les trois passes ont vu tous les seuils actifs : ce qu'elles ne revoient pas n'est plus vrai.
      for (const [alertType, passId] of [
        ['STOCK_LOW', lowPass],
        ['STOCK_OUT', outPass],
        ['POS_REPLENISH', replenishPass],
      ] as const) {
        await publishPassCompleted(uow, {
          producerModule: 'inventory',
          alertType,
          passId,
          businessDay: today,
          occurredAt: now,
        });
      }
      this.logger.log(
        `Seuils de stock (${today}) : ${statuses.length} seuil(s) actif(s), ${low} bas, ` +
          `${out} en rupture, ${replenish} réapprovisionnement(s) à prévoir.`,
      );
    });
  }
}
