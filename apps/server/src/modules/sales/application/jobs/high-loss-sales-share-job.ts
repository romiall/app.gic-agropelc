/**
 * `sales.losses.sales_share_check` (P9-08 ; D13 §7.1 `HIGH_LOSS` : « valeur des pertes d'un emplacement sur
 * 1 jour ≥ … ou ≥ 5 % des ventes du jour » ; AV-406, AV-455). Part « % du CA » de l'alerte, dans `sales`
 * parce que le CA est sa donnée (ADR-071 §2) ; le seuil absolu est publié par `inventory` à chaque perte.
 *
 * - **Jours examinés** : les deux derniers jours métier **clos** (la veille et l'avant-veille) : le CA du
 *   jour n'est connu qu'une fois le jour fini, et les faits saisis hors ligne arrivent après coup. Un
 *   emplacement n'est publié qu'**une fois par jour métier** (l'identité de passe est le jour examiné,
 *   jamais le créneau de la tâche) : la deuxième lecture du même jour ne l'incrémente pas.
 * - **Dénominateur** : le CA net du **site** du jour (ventes − annulations appliquées, tous emplacements du
 *   site) ; une perte d'un emplacement qui ne vend pas (poulailler, magasin d'intrants) se compare ainsi à
 *   l'activité de son site. Sans vente ce jour-là, la part n'est pas définie : seul le seuil absolu joue.
 * - **Pertes** : celles de `inventory.dayLossByLocation` (déclarations constatées, en attente, non
 *   justifiées, en annulation) ; la mortalité n'y entre pas (`HIGH_MORTALITY`, AV-453).
 * - **Ce que le seuil absolu a déjà signalé n'est pas republié** : une perte qui atteint le seuil absolu du
 *   site a déjà levé l'alerte à la déclaration (`HighLossDetected`, même définition du cumul) ; la republier
 *   le lendemain ferait renaître une alerte que le responsable a résolue ou écartée (AV-404). La part du CA
 *   ne couvre donc que les pertes **sous** le seuil absolu.
 * - **Règles à la date du jour examiné** : le pourcentage et le seuil absolu sont lus à la fin du jour
 *   examiné (comme le fait `inventory` à la déclaration), pas à la date de la tâche.
 * - **Même alerte que le seuil absolu** (emplacement × jour) : les deux événements portent les mêmes clés
 *   de message ; la valeur au coût (`loss_value_xaf`) reste un champ protégé du rendu (RC-05).
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  addBusinessDays,
  businessDayEndUtc,
  businessDayOf,
  highLossAlertXafOrDefault,
  highLossSalesPctOrDefault,
  isHighLossAbsolute,
  isHighLossSalesShare,
  lossSalesSharePct,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  compositeSubjectId,
  detectionPassId,
  publishDetectionEvent,
} from '../../../../platform/events/detection-events.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import { dayLossByLocation } from '../../../inventory/application/public/index.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import { soldByLocation } from '../public/distribution-metrics.js';

export const HIGH_LOSS_SALES_SHARE_JOB_TYPE = 'sales.losses.sales_share_check';
export const HIGH_LOSS_SALES_PCT_KEY = 'sales.high_loss_alert_sales_pct';
/** Seuil absolu d'`inventory` (lu ici seulement pour ne pas republier ce qu'il a déjà signalé). */
export const HIGH_LOSS_ABSOLUTE_KEY = 'inventory.high_loss_alert_xaf';

/**
 * Jours métier clos examinés à chaque passe (la veille et l'avant-veille : faits saisis après coup).
 * Constante de planification, non paramétrable (AV-455) : une perte synchronisée plus tard n'est plus
 * examinée.
 */
export const SALES_SHARE_LOOKBACK_DAYS = 2;

type SettingReader = Parameters<typeof currentSettingValue>[0];

@Injectable()
export class HighLossSalesShareJob implements OnModuleInit {
  private readonly logger = new Logger(HighLossSalesShareJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(HIGH_LOSS_SALES_SHARE_JOB_TYPE, async (uow) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      // Règles lues à la fin du jour examiné, une fois par (site, jour).
      const rules = new Map<string, { pct: number; absoluteXaf: number }>();
      let published = 0;
      let examined = 0;

      for (let back = 1; back <= SALES_SHARE_LOOKBACK_DAYS; back += 1) {
        const day = addBusinessDays(today, -back);
        const rulesAt = new Date(businessDayEndUtc(day).getTime() - 1);
        const losses = await dayLossByLocation(uow, {
          businessDay: day,
          excludeCategories: ['MORTALITE'],
        });
        if (losses.length === 0) continue;
        examined += losses.length;

        const siteIds = [...new Set(losses.map((line) => line.siteId))];
        const sold = await soldByLocation(uow, { siteIds, period: { fromDay: day, toDay: day } });
        const salesBySite = new Map<string, number>();
        for (const line of sold) {
          salesBySite.set(line.siteId, (salesBySite.get(line.siteId) ?? 0) + line.netXaf);
        }
        const names = new Map<string, string>(
          (
            await uow
              .selectFrom('organization_locations')
              .select(['id', 'name'])
              .where(
                'id',
                'in',
                losses.map((line) => toBin(line.locationId)),
              )
              .execute()
          ).map((row) => [fromBin(row.id), row.name]),
        );

        for (const loss of losses) {
          const ruleKey = `${loss.siteId}|${day}`;
          let rule = rules.get(ruleKey);
          if (rule === undefined) {
            rule = {
              pct: highLossSalesPctOrDefault(
                await siteThenGlobal(uow, HIGH_LOSS_SALES_PCT_KEY, loss.siteId, rulesAt),
              ),
              absoluteXaf: highLossAlertXafOrDefault(
                await siteThenGlobal(uow, HIGH_LOSS_ABSOLUTE_KEY, loss.siteId, rulesAt),
              ),
            };
            rules.set(ruleKey, rule);
          }
          // Déjà signalée par le seuil absolu, à la déclaration : ne pas faire renaître l'alerte.
          if (isHighLossAbsolute({ valueXaf: loss.valueXaf, thresholdXaf: rule.absoluteXaf })) {
            continue;
          }
          const salesNetXaf = salesBySite.get(loss.siteId) ?? 0;
          if (!isHighLossSalesShare({ lossValueXaf: loss.valueXaf, salesNetXaf, pct: rule.pct })) {
            continue;
          }
          const payload: Record<string, unknown> = {
            location_id: loss.locationId,
            business_day: day,
            location_label: names.get(loss.locationId) ?? loss.locationId,
            site_id: loss.siteId,
            loss_quantity: loss.quantityBase,
            loss_value_xaf: loss.valueXaf,
            declarations: loss.declarations,
            cause: 'SALES_SHARE',
            share_pct: lossSalesSharePct(loss.valueXaf, salesNetXaf),
            threshold_pct: rule.pct,
            sales_net_xaf: salesNetXaf,
          };
          const inserted = await publishDetectionEvent(uow, this.idGenerator, {
            eventType: 'HighLossSalesShareDetected',
            producerModule: 'sales',
            aggregateType: 'LOSS_DAY',
            aggregateId: compositeSubjectId('HIGH_LOSS', payload),
            occurredAt: now,
            // Identité = le jour examiné : au plus un événement par emplacement et par jour.
            passId: detectionPassId('HIGH_LOSS', day, 'SALES_SHARE'),
            payload,
          });
          if (inserted) published += 1;
        }
      }
      this.logger.log(
        `Pertes rapportées au CA (${today}) : ${published} signalée(s) sur ${examined} emplacement(s)-jour examiné(s).`,
      );
    });
  }
}

/** Réglage du site, à défaut global, à une date (règle 8 : paramètre ; le repli est celui du domaine). */
async function siteThenGlobal(
  uow: SettingReader,
  key: string,
  siteId: string,
  at: Date,
): Promise<unknown> {
  const bySite = await currentSettingValue(uow, { key, scopeType: 'SITE', scopeId: siteId, at });
  if (bySite !== undefined) return bySite;
  return currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at });
}
