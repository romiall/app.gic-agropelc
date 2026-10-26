/**
 * `inventory.ledger.reconcile_daily` (P2-07 ; stratégie stock §3.1, INV-STK-01 et INV-STK-03 :
 * « un job quotidien compare la projection au registre et lève `LEDGER_MISMATCH` »).
 *
 * P9-08 (AV-352, AV-409) : un écart n'est plus un **échec de tâche** mais une alerte. Pour chaque site
 * touché, la tâche publie `LedgerMismatchDetected` (sujet : site × jour métier) dans la transaction du
 * `JobRunner`, journalise l'erreur et **se termine en succès** — l'échec de tâche, qui annulerait les
 * événements publiés, ne porte plus l'écart. Les anomalies sans site (conservation d'un produit sur tous
 * les emplacements) sont regroupées sous la clé `GLOBAL` : l'alerte n'a pas de site et n'est vue que des
 * portées globales (Direction, Administrateur).
 *
 * - **Identité** : (type, créneau) : un rejeu du même créneau ne republie rien. Le sujet de l'alerte est
 *   (site, jour métier) : une anomalie qui persiste lève une **nouvelle** alerte chaque jour métier (même
 *   principe qu'AV-398 pour la trésorerie) ; le compteur d'occurrences ne compte que les passes du même
 *   jour. Une alerte résolue puis une anomalie toujours présente du même jour en crée une nouvelle (AV-354).
 * - La correction n'est jamais automatique : `rebuildStockBalances` reste une procédure de maintenance
 *   déclenchée par un responsable après analyse de l'écart.
 * - La charge utile porte les nombres par catégorie et un échantillon **borné** (pas de volume non borné
 *   dans le JSON) ; le journal reprend les compteurs et, par site, le même échantillon.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { businessDayOf, type Clock, type IdGenerator } from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  compositeSubjectId,
  detectionPassId,
  passSlotOf,
  publishDetectionEvent,
} from '../../../../platform/events/detection-events.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { verifyStockLedger, type LedgerVerification } from '../public/ledger-reconciliation.js';
import {
  verifyTransferTransit,
  type TransferTransitBreach,
  type TransferTransitVerification,
} from '../public/transfer-transit.js';

export const LEDGER_RECONCILIATION_JOB_TYPE = 'inventory.ledger.reconcile_daily';

/** Clé de sujet d'une anomalie sans site (conservation par produit, emplacement virtuel global). */
export const LEDGER_GLOBAL_SITE_KEY = 'GLOBAL';

/** Nombre d'écarts détaillés par catégorie dans le journal et dans l'échantillon de l'événement. */
const DETAILED_MISMATCHES = 5;

/** Une rupture d'INV-STK-08 dans le message d'échec : quel transfert, quel produit, quel écart. */
function describeTransitBreach(breach: TransferTransitBreach): string {
  return (
    `transfert ${breach.transferId} produit ${breach.productId ?? '-'} : ${breach.reason}, ` +
    `attendu ${breach.expectedQty} ≠ constaté ${breach.actualQty}`
  );
}

/** Anomalies du registre d'un site (ou `GLOBAL`) : nombres par catégorie et échantillon borné. */
export interface SiteLedgerAnomalies {
  readonly siteKey: string;
  readonly siteId: string | null;
  readonly breakdown: {
    balances: number;
    conservation: number;
    to_deliver: number;
    settlement: number;
    allocation: number;
    overcommit: number;
    negative: number;
    transit: number;
  };
  readonly sample: string[];
}

type Breakdown = SiteLedgerAnomalies['breakdown'];

/** Site de chaque emplacement donné (`null` : emplacement global ou inconnu). */
async function sitesOfLocations(
  uow: UnitOfWork,
  locationIds: readonly string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const ids = [...new Set(locationIds.map((id) => id.toLowerCase()))];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const rows = await uow
      .selectFrom('organization_locations')
      .select(['id', 'site_id'])
      .where(
        'id',
        'in',
        ids.slice(offset, offset + 500).map((id) => toBin(id)),
      )
      .execute();
    for (const row of rows) result.set(fromBin(row.id), fromBinOrNull(row.site_id));
  }
  return result;
}

/**
 * Regroupe les anomalies de la vérification par site (D06, AV-409) : un solde, un « à livrer », un
 * dépassement de quotas, un négatif → le site de l'emplacement ; une vente au règlement incohérent → celui
 * de l'emplacement du mouvement d'origine ; un quota → celui de son emplacement ; un transit → le site du
 * transfert ; la conservation d'un produit → global.
 */
export async function ledgerAnomaliesBySite(
  uow: UnitOfWork,
  ledger: LedgerVerification,
  transit: TransferTransitVerification,
): Promise<readonly SiteLedgerAnomalies[]> {
  const groups = new Map<string, SiteLedgerAnomalies>();
  const groupOf = (siteId: string | null): SiteLedgerAnomalies => {
    const key = siteId ?? LEDGER_GLOBAL_SITE_KEY;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        siteKey: key,
        siteId,
        breakdown: {
          balances: 0,
          conservation: 0,
          to_deliver: 0,
          settlement: 0,
          allocation: 0,
          overcommit: 0,
          negative: 0,
          transit: 0,
        },
        sample: [],
      };
      groups.set(key, group);
    }
    return group;
  };
  const note = (
    siteId: string | null,
    category: keyof Breakdown,
    detail: string,
    perCategory: Map<string, number>,
  ): void => {
    const group = groupOf(siteId);
    group.breakdown[category] += 1;
    const key = `${group.siteKey}|${category}`;
    const count = perCategory.get(key) ?? 0;
    perCategory.set(key, count + 1);
    if (count < DETAILED_MISMATCHES) group.sample.push(detail);
  };

  const sites = await sitesOfLocations(uow, [
    ...ledger.mismatches.map((m) => m.locationId),
    ...ledger.toDeliverBreaches.map((b) => b.locationId),
    ...ledger.overcommitBreaches.map((b) => b.locationId),
    ...ledger.negativeBreaches.map((b) => b.locationId),
  ]);

  // Ventes au règlement incohérent : emplacement du mouvement d'origine.
  const moveLocation = new Map<string, string>();
  const originIds = [...new Set(ledger.settlementBreaches.map((b) => b.originMoveId))];
  for (let offset = 0; offset < originIds.length; offset += 500) {
    const rows = await uow
      .selectFrom('inventory_stock_moves')
      .select(['id', 'from_location_id'])
      .where(
        'id',
        'in',
        originIds.slice(offset, offset + 500).map((id) => toBin(id)),
      )
      .execute();
    for (const row of rows) moveLocation.set(fromBin(row.id), fromBin(row.from_location_id));
  }
  // Quotas : emplacement du quota.
  const allocationLocation = new Map<string, string>();
  const allocationIds = [...new Set(ledger.allocationBreaches.map((b) => b.allocationId))];
  for (let offset = 0; offset < allocationIds.length; offset += 500) {
    const rows = await uow
      .selectFrom('inventory_stock_allocations')
      .select(['id', 'location_id'])
      .where(
        'id',
        'in',
        allocationIds.slice(offset, offset + 500).map((id) => toBin(id)),
      )
      .execute();
    for (const row of rows) allocationLocation.set(fromBin(row.id), fromBin(row.location_id));
  }
  const extraSites = await sitesOfLocations(uow, [
    ...moveLocation.values(),
    ...allocationLocation.values(),
  ]);
  for (const [id, siteId] of extraSites) sites.set(id, siteId);
  // Transferts : site du transfert.
  const transferSite = new Map<string, string | null>();
  const transferIds = [...new Set(transit.breaches.map((b) => b.transferId))];
  for (let offset = 0; offset < transferIds.length; offset += 500) {
    const rows = await uow
      .selectFrom('inventory_stock_transfers')
      .select(['id', 'site_id'])
      .where(
        'id',
        'in',
        transferIds.slice(offset, offset + 500).map((id) => toBin(id)),
      )
      .execute();
    for (const row of rows) transferSite.set(fromBin(row.id), fromBinOrNull(row.site_id));
  }

  const siteOfLocation = (locationId: string): string | null =>
    sites.get(locationId.toLowerCase()) ?? null;
  const counted = new Map<string, number>();
  for (const m of ledger.mismatches) {
    note(
      siteOfLocation(m.locationId),
      'balances',
      `emplacement ${m.locationId} produit ${m.productId} lot ${m.lotId ?? '-'} : ` +
        `projection ${m.projectedQty} ≠ registre ${m.ledgerQty}`,
      counted,
    );
  }
  for (const b of ledger.conservationBreaches) {
    note(
      null,
      'conservation',
      `produit ${b.productId} : somme des soldes ${b.totalQty} ≠ 0`,
      counted,
    );
  }
  for (const b of ledger.toDeliverBreaches) {
    note(
      siteOfLocation(b.locationId),
      'to_deliver',
      `emplacement « à livrer » ${b.locationId} produit ${b.productId} : solde négatif ${b.qty}`,
      counted,
    );
  }
  for (const b of ledger.settlementBreaches) {
    const location = moveLocation.get(b.originMoveId);
    note(
      location === undefined ? null : siteOfLocation(location),
      'settlement',
      `vente d'origine ${b.originMoveId} : ${b.reason} (origine ${b.originQuantity}, rattaché ${b.settledQuantity})`,
      counted,
    );
  }
  for (const b of ledger.allocationBreaches) {
    const location = allocationLocation.get(b.allocationId);
    note(
      location === undefined ? null : siteOfLocation(location),
      'allocation',
      `quota ${b.allocationId} : ${b.reason} (reste ${b.remaining})`,
      counted,
    );
  }
  for (const b of ledger.overcommitBreaches) {
    note(
      siteOfLocation(b.locationId),
      'overcommit',
      `emplacement ${b.locationId} produit ${b.productId} : quotas ${b.allocatedRemaining} > stock ${b.stockOnHand}`,
      counted,
    );
  }
  for (const b of ledger.negativeBreaches) {
    note(
      siteOfLocation(b.locationId),
      'negative',
      `emplacement ${b.locationId} produit ${b.productId} lot ${b.lotKey} : solde ${b.qtyOnHand} sans conflit STOCK_NEGATIVE`,
      counted,
    );
  }
  for (const b of transit.breaches) {
    note(transferSite.get(b.transferId) ?? null, 'transit', describeTransitBreach(b), counted);
  }
  return [...groups.values()].sort((a, b) => a.siteKey.localeCompare(b.siteKey));
}

@Injectable()
export class LedgerReconciliationJob implements OnModuleInit {
  private readonly logger = new Logger(LedgerReconciliationJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(LEDGER_RECONCILIATION_JOB_TYPE, async (uow, payload) => {
      const result = await verifyStockLedger(uow);
      // INV-STK-08 (P5-16) : transit soldé des transferts clos, réception sans document comprise.
      const transit = await verifyTransferTransit(uow);
      if (result.ok && transit.ok) {
        this.logger.log(
          `Registre de stock réconcilié : ${result.balancesChecked} solde(s), ` +
            `${transit.transfersChecked} transfert(s) clos, aucun écart.`,
        );
        return;
      }

      const now = this.clock.now();
      const today = businessDayOf(now);
      const passId = detectionPassId('LEDGER_MISMATCH', passSlotOf(payload, now));
      const sites = await ledgerAnomaliesBySite(uow, result, transit);
      let published = 0;
      for (const site of sites) {
        const total = Object.values(site.breakdown).reduce((sum, count) => sum + count, 0);
        const eventPayload: Record<string, unknown> = {
          site_key: site.siteKey,
          site_id: site.siteId,
          business_day: today,
          mismatches: total,
          breakdown: site.breakdown,
          balances_checked: result.balancesChecked,
          sample: site.sample,
        };
        const inserted = await publishDetectionEvent(uow, this.idGenerator, {
          eventType: 'LedgerMismatchDetected',
          producerModule: 'inventory',
          aggregateType: 'LEDGER_RECONCILIATION',
          aggregateId: compositeSubjectId('LEDGER_MISMATCH', eventPayload),
          occurredAt: now,
          passId,
          payload: eventPayload,
        });
        if (inserted) published += 1;
      }
      // Le message d'échec d'avant P9 reste dans le journal (signal d'exploitation si la règle d'alerte
      // est désactivée ou le consommateur en retard), suivi de l'échantillon borné de chaque site.
      this.logger.error(
        `LEDGER_MISMATCH : ${result.mismatches.length} solde(s) en écart, ` +
          `${result.conservationBreaches.length} produit(s) hors conservation, ` +
          `${result.toDeliverBreaches.length} solde(s) « à livrer » négatif(s), ` +
          `${result.settlementBreaches.length} vente(s) au règlement incohérent, ` +
          `${result.allocationBreaches.length} quota(s) au registre incohérent, ` +
          `${result.overcommitBreaches.length} emplacement(s) dont les quotas dépassent le stock sans conflit, ` +
          `${result.negativeBreaches.length} solde(s) négatif(s) sans conflit, ` +
          `${transit.breaches.length} transfert(s) clos au transit non soldé ` +
          `— ${sites.length} site(s) concerné(s), ${published} alerte(s) publiée(s).`,
      );
      for (const site of sites) {
        this.logger.error(`LEDGER_MISMATCH site ${site.siteKey} : ${site.sample.join(' ; ')}`);
      }
    });
  }
}
