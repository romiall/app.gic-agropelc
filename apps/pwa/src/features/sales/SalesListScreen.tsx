/**
 * Ventes récentes (accès à ECR-VEN-05) : les ventes des 7 derniers jours connues de l'appareil, dont
 * celles saisies sur l'appareil et pas encore acceptées par le serveur, la plus récente d'abord.
 * Utilisable hors ligne. Depuis le signal « ventes du jour signalées » de l'accueil (`?anomalies=1`,
 * AV-255) : les seules ventes du jour non annulées qui portent un drapeau, comme le compte du serveur.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PieceAction } from '../pieces/PieceAction.js';
import {
  demandeJournalEncaissements,
  encaissementsDuJournal,
} from '../pieces/adaptateurs-finance.js';
import { businessDayOf } from '@gic/domain';
import { clock } from '../../platform/composition.js';
import { ROUTES } from '../../app/screens.js';
import { formatMoment } from '../home/format-home.js';
import { formatMoney } from './format.js';
import { recentSales, saleStatusTone, type SaleView } from './recent-sales.js';
import { rootCustomerId, useSalesReferences } from './references.js';

/** Vente du jour, non annulée, signalée par le serveur (définition du signal `SALES_FLAGGED`). */
function flaggedToday(sale: SaleView, today: string): boolean {
  return (
    sale.flags.length > 0 &&
    sale.status !== 'CANCELLED' &&
    businessDayOf(new Date(sale.occurredAt)) === today
  );
}

export function SalesListScreen() {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const [searchParams] = useSearchParams();
  const [flaggedOnly, setFlaggedOnly] = useState(searchParams.get('anomalies') === '1');

  if (!refs) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.sales')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const today = businessDayOf(clock.now());
  const customers = new Map(refs.customers.map((customer) => [customer.id, customer]));
  const all = recentSales(refs);
  const sales = flaggedOnly ? all.filter((sale) => flaggedToday(sale, today)) : all;
  const flagLabels = (flags: readonly string[]) =>
    flags.map((flag) => t(`sales.detail.flag.${flag}`, { defaultValue: flag })).join(', ');

  return (
    <section className="sale">
      <div className="screen-head">
        <h1>{t('nav.screens.sales')}</h1>
        <Link to={ROUTES.newSale} className="action action-primary action-compact">
          <span className="action-label">{t('nav.screens.new_sale')}</span>
        </Link>
      </div>
      {flaggedOnly ? (
        <p className="home-banner" role="status">
          {t('sales.list.flagged_banner', { count: sales.length })}{' '}
          <button type="button" className="secondary" onClick={() => setFlaggedOnly(false)}>
            {t('sales.list.show_all')}
          </button>
        </p>
      ) : (
        <p className="home-muted">{t('sales.list.window_hint')}</p>
      )}
      {sales.length === 0 ? (
        <p className="home-muted">
          {flaggedOnly ? t('sales.list.flagged_empty') : t('sales.list.empty')}
        </p>
      ) : (
        <ul className="doc-list">
          {sales.map((sale) => {
            const customerName = sale.customerId
              ? (customers.get(rootCustomerId(refs.customerAlias, sale.customerId))?.display_name ??
                t('sales.list.unknown_customer'))
              : t('sales.list.anonymous');
            const doc = sale.docNumber ?? t('sales.pending_number');
            return (
              <li key={sale.id}>
                <Link
                  to={ROUTES.sale(sale.id)}
                  aria-label={t('sales.list.open', { doc })}
                  className="doc-row"
                >
                  <span className="doc-main">
                    <strong>{doc}</strong>
                    <small>
                      {formatMoment(sale.occurredAt, today)} · {customerName}
                    </small>
                    {sale.flags.length > 0 ? (
                      <small className="text-warn">
                        {t('sales.list.flags', { flags: flagLabels(sale.flags) })}
                      </small>
                    ) : null}
                  </span>
                  <span className="doc-side">
                    <strong>{formatMoney(sale.netTotalXaf)}</strong>
                    <span className={`badge badge-${saleStatusTone(sale.status)}`}>
                      {sale.status === 'CONFIRMED' && sale.paymentStatus
                        ? t(`sales.payment_status.${sale.paymentStatus}`)
                        : t(`sales.status.${sale.status}`)}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {/* Journal des encaissements (lot PP, JE) : les encaissements servis à l'appareil (7 jours). */}
      {refs.payments.length > 0 ? (
        <PieceAction
          cle={journalKey(refs.payments)}
          libelle={t('piece.receipts_journal')}
          demande={() => {
            const { du, au } = journalPeriod(refs.payments);
            const sites = new Set(refs.payments.map((payment) => payment.site_id));
            const site = sites.size === 1 ? (refs.sites.get([...sites][0]!)?.name ?? null) : null;
            return demandeJournalEncaissements({
              paiements: refs.payments,
              site,
              du,
              au,
              tenuPar: null,
              refs,
            });
          }}
        />
      ) : null}
    </section>
  );
}

/** Période couverte par les encaissements servis : du premier au dernier jour métier. */
/**
 * Clé de réimpression du journal : sa période et son contenu. Un journal qui a reçu un encaissement
 * depuis la dernière impression est une autre feuille, pas un duplicata.
 */
function journalKey(
  payments: readonly {
    readonly occurred_at: string;
    readonly status: string;
    readonly amount_xaf: number;
  }[],
) {
  const { du, au } = journalPeriod(payments);
  const active = encaissementsDuJournal(payments);
  const total = active.reduce((sum, payment) => sum + payment.amount_xaf, 0);
  return `JE:${du}:${au}:${active.length}:${total}`;
}

function journalPeriod(payments: readonly { readonly occurred_at: string }[]) {
  const days = payments.map((payment) => businessDayOf(new Date(payment.occurred_at))).sort();
  return { du: days[0] ?? '', au: days[days.length - 1] ?? '' };
}
