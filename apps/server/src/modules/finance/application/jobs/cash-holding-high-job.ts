/**
 * `finance.cash_holdings.high_check` (P9-07 ; D09 §14 : « solde > plafond **ou** aucune remise depuis
 * plus de 3 jours » ; D13 `CASH_HOLDING_HIGH` ; AV-447). Passe de détection à identité (ADR-071 §3) :
 * publie un événement `CashHoldingHighDetected` par compte de **caisse utilisateur** actif dont le solde
 * dépasse le plafond (`finance.cash_holding_max_xaf`) ou dont l'espèce détenue n'a pas fait l'objet d'une
 * remise depuis plus de `finance.cash_holding_max_days` jours métier, puis le marqueur de fin de passe :
 * l'alerte d'état se résout seule quand le compte n'est plus revu (remise envoyée, solde retombé, compte
 * inactif).
 *
 * - **Référence de la durée** (AV-447, défaut) : la plus récente de l'envoi de la dernière remise non
 *   annulée et de l'entrée de l'espèce encore détenue (FIFO : les remises consomment les plus anciennes
 *   entrées, `cashHeldSince`). Un compte vidé puis réalimenté n'est donc pas signalé « sans remise depuis
 *   trois semaines » dès sa première entrée.
 * - **Détenteur** : propriétaire de l'alerte (`holder_user_id`) ; le responsable de son équipe est
 *   destinataire (`teamManager`), la Finance par son rôle.
 * - La tâche est horaire : la remise doit fermer l'alerte dans l'heure, sans événement de résolution
 *   (l'identifiant du sujet d'une remise n'est pas le compte). Un événement par compte et par passe ;
 *   le compteur d'occurrences compte des heures, sans renotification. Aucune écriture métier.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  assessCashHolding,
  businessDayOf,
  businessDaysBetween,
  cashHeldSince,
  cashHoldingThresholdFrom,
  DEFAULT_CASH_HOLDING_MAX_DAYS,
  DEFAULT_CASH_HOLDING_MAX_XAF,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { sql } from 'kysely';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import { fromBin, fromBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
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
import { userFullNames } from '../../../identity/application/public/index.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';

export const CASH_HOLDING_HIGH_JOB_TYPE = 'finance.cash_holdings.high_check';

/** Entrées lues par compte pour dater l'espèce détenue (une caisse personnelle en compte peu). */
const INFLOW_PAGE = 200;

@Injectable()
export class CashHoldingHighJob implements OnModuleInit {
  private readonly logger = new Logger(CashHoldingHighJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(CASH_HOLDING_HIGH_JOB_TYPE, async (uow, payload) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const passId = detectionPassId('CASH_HOLDING_HIGH', passSlotOf(payload, now));
      // Caisse personnelle sans site : seuils globaux (une valeur absente ou invalide revient au défaut,
      // jamais à une désactivation silencieuse ; 0 désactive explicitement le critère).
      const threshold = async (key: string, fallback: number) =>
        cashHoldingThresholdFrom(
          await currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at: now }),
          fallback,
        );
      const maxXaf = await threshold('finance.cash_holding_max_xaf', DEFAULT_CASH_HOLDING_MAX_XAF);
      const maxDays = await threshold(
        'finance.cash_holding_max_days',
        DEFAULT_CASH_HOLDING_MAX_DAYS,
      );

      // Caisses personnelles actives portant des espèces : une page (quelques dizaines de comptes).
      const accounts = await uow
        .selectFrom('finance_cash_accounts')
        .select(['id', 'code', 'holder_user_id', 'site_id', 'balance_xaf', 'created_at'])
        .where('account_type', '=', 'CAISSE_UTILISATEUR')
        .where('status', '=', 'ACTIVE')
        .where('balance_xaf', '>', 0)
        .orderBy('id')
        .execute();
      let published = 0;
      if (accounts.length > 0) {
        const lastSent = new Map<string, Date>();
        const transfers = await uow
          .selectFrom('finance_cash_transfers')
          .select(['from_account_id', sql<Date>`MAX(sent_at)`.as('last_sent_at')])
          .where(
            'from_account_id',
            'in',
            accounts.map((account) => account.id),
          )
          .where('status', '<>', 'CANCELLED')
          .groupBy('from_account_id')
          .execute();
        for (const row of transfers) lastSent.set(fromBin(row.from_account_id), row.last_sent_at);

        const holderIds = accounts.flatMap((account) =>
          account.holder_user_id === null ? [] : [fromBin(account.holder_user_id)],
        );
        const names = await userFullNames(uow, holderIds);

        for (const account of accounts) {
          const accountId = fromBin(account.id);
          const balance = Number(account.balance_xaf);
          // Entrées les plus récentes d'abord : l'espèce détenue en est composée (FIFO).
          const inflows = await uow
            .selectFrom('finance_cash_movements')
            .select(['occurred_at', 'amount_xaf'])
            .where('cash_account_id', '=', account.id)
            .where('direction', '=', 'IN')
            .orderBy('occurred_at', 'desc')
            .orderBy('id', 'desc')
            .limit(INFLOW_PAGE)
            .execute();
          const heldSince =
            cashHeldSince(
              balance,
              inflows.map((row) => ({
                occurredAt: new Date(row.occurred_at),
                amountXaf: Number(row.amount_xaf),
              })),
            ) ?? new Date(account.created_at);
          const lastTransferAt = lastSent.get(accountId) ?? null;
          const lastTransfer = lastTransferAt === null ? null : new Date(lastTransferAt);
          // Une remise plus récente que l'entrée de l'espèce détenue est la référence (D09 §14 : « aucune
          // remise depuis plus de N jours ») ; sinon, l'espèce détenue est entrée après la dernière remise.
          const referenceAt =
            lastTransfer !== null && lastTransfer > heldSince ? lastTransfer : heldSince;
          const daysWithoutTransfer = Math.max(
            0,
            businessDaysBetween(businessDayOf(referenceAt), today),
          );
          const reason = assessCashHolding({
            balanceXaf: balance,
            daysWithoutTransfer,
            maxXaf,
            maxDays,
          });
          if (reason === null) continue;
          const holderId = fromBinOrNull(account.holder_user_id);
          const inserted = await publishDetectionEvent(uow, this.idGenerator, {
            eventType: 'CashHoldingHighDetected',
            producerModule: 'finance',
            aggregateType: 'CASH_ACCOUNT',
            aggregateId: accountId,
            occurredAt: now,
            passId,
            payload: {
              account_id: accountId,
              cash_account_id: accountId,
              account_code: account.code,
              holder_user_id: holderId,
              holder_label:
                holderId === null ? account.code : (names.get(holderId) ?? account.code),
              balance_xaf: balance,
              days_without_transfer: daysWithoutTransfer,
              last_transfer_at: lastTransfer === null ? null : lastTransfer.toISOString(),
              held_since: heldSince.toISOString(),
              reference_at: referenceAt.toISOString(),
              threshold_xaf: maxXaf,
              threshold_days: maxDays,
              reason,
              site_id: fromBinOrNull(account.site_id),
              business_day: today,
            },
          });
          if (inserted) published += 1;
        }
      }
      // Passe complète, même sans compte en dépassement : l'alerte d'un compte revenu dans les limites
      // (remise envoyée) est résolue à cette passe.
      await publishPassCompleted(uow, {
        producerModule: 'finance',
        alertType: 'CASH_HOLDING_HIGH',
        passId,
        businessDay: today,
        occurredAt: now,
      });
      this.logger.log(
        `Encaisses élevées ou sans remise (plafond ${maxXaf} XAF, ${maxDays} j ; ${today}) : ${published}.`,
      );
    });
  }
}
