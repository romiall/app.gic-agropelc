/**
 * Mouvements d'un compte de trésorerie (ECR-FIN-05 ; `GET /cash-accounts/{id}/movements`) : du plus
 * récent au plus ancien, par pages de 50 ; les plus anciens sont chargés à la demande et rattachés à
 * la première page lue (une relecture repart de la plus récente). Une dépense ou un paiement
 * fournisseur s'ouvre depuis sa ligne (P8E-04, AV-300).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner, Button, SkeletonRows } from '../../components/ui/index.js';
import { formatDateTime } from '../home/format-home.js';
import { formatMoney } from '../sales/format.js';
import { readPath, useOnlineRead } from '../sales/online-read.js';
import { MovementDocument } from './MovementDocument.js';
import { businessDayOf } from '@gic/domain';
import { clock } from '../../platform/composition.js';
import { useSalesReferences } from '../sales/references.js';
import { PieceAction } from '../pieces/PieceAction.js';
import { demandeFeuilleCaisse } from '../pieces/adaptateurs-finance.js';
import type { CashMovementItem, CashMovementsPage } from './treasury.js';

/** Taille d'une page de mouvements (défaut du serveur). */
const MOVEMENTS_PAGE = 50;

interface Older {
  /** Première page à laquelle ces pages se rattachent. */
  readonly base: CashMovementsPage;
  readonly items: readonly CashMovementItem[];
  readonly next: string | null;
  readonly loading: boolean;
  readonly failed: boolean;
}

export function AccountMovements({
  accountId,
  online,
  reloadKey,
}: {
  readonly accountId: string;
  readonly online: boolean;
  readonly reloadKey: string;
}) {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const today = businessDayOf(clock.now());
  const path = `/api/v1/cash-accounts/${accountId}/movements?limit=${MOVEMENTS_PAGE}`;
  const read = useOnlineRead<CashMovementsPage>(
    path,
    (key) => readPath<CashMovementsPage>(key),
    online,
    reloadKey,
  );
  const [older, setOlder] = useState<Older | null>(null);
  const first = read.data;
  const extra = older && older.base === first ? older : null;
  const items = [...(first?.movements ?? []), ...(extra?.items ?? [])];
  const next = extra ? extra.next : (first?.next_cursor ?? null);
  const todayItems = items.filter((m) => businessDayOf(new Date(m.occurredAt)) === today);

  const loadMore = async () => {
    if (!first || !next) return;
    const base = first;
    setOlder({ base, items: extra?.items ?? [], next, loading: true, failed: false });
    const result = await readPath<CashMovementsPage>(`${path}&cursor=${encodeURIComponent(next)}`);
    setOlder((current) => {
      if (!current || current.base !== base) return current;
      return result.ok
        ? {
            base,
            items: [...current.items, ...result.data.movements],
            next: result.data.next_cursor,
            loading: false,
            failed: false,
          }
        : { ...current, loading: false, failed: true };
    });
  };

  // Relecture en échec : annoncée avec « Réessayer », les mouvements d'avant restant affichés.
  const failure = read.failed ? (
    <Banner
      tone="bad"
      role="alert"
      action={
        <Button variant="outline" size="sm" onClick={read.retry}>
          {t('distribution.retry')}
        </Button>
      }
    >
      {t(first ? 'treasury.movements_failed_stale' : 'treasury.movements_failed')}
    </Banner>
  ) : null;
  if (!first) {
    if (failure) return failure;
    return <SkeletonRows rows={2} />;
  }
  return (
    <div className="tre-movements">
      {failure}
      {read.stale && !read.failed ? (
        <p className="home-muted" role="status">
          {t('treasury.refreshing')}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="home-muted">{t('treasury.movements_empty')}</p>
      ) : (
        <ul className="tre-moves">
          {items.map((movement) => {
            const date = formatDateTime(movement.occurredAt);
            const amount = `${movement.direction === 'OUT' ? '−' : '+'}${formatMoney(movement.amountXaf)}`;
            return (
              <li key={movement.id} className="tre-move">
                <span className="tre-move-text">
                  {t('treasury.movement_line', {
                    date,
                    type: t(`treasury.movement_type.${movement.movementType}`, {
                      defaultValue: movement.movementType,
                    }),
                    amount,
                  })}
                  {movement.isReversal ? ` ${t('treasury.reversal')}` : ''}
                </span>
                <MovementDocument
                  movement={movement}
                  label={t('treasury.movement_document_label', { date, amount })}
                  online={online}
                />
              </li>
            );
          })}
        </ul>
      )}
      {extra?.failed ? (
        <Banner tone="bad" role="alert">
          {t('treasury.movements_failed')}
        </Banner>
      ) : null}
      {/* Feuille journalière de caisse (lot PP, D4) : mouvements du jour métier, offerte seulement
          quand ils sont tous chargés (dernière page atteinte, ou un mouvement d'un jour antérieur
          chargé). La clé porte le contenu : une feuille complétée depuis n'est pas un duplicata. */}
      {refs && (!next || items.some((m) => businessDayOf(new Date(m.occurredAt)) < today)) ? (
        <PieceAction
          cle={`FJC:${accountId}:${today}:${todayItems.length}:${todayItems.reduce(
            (sum, m) => sum + (m.direction === 'IN' ? m.amountXaf : -m.amountXaf),
            0,
          )}`}
          libelle={t('piece.cash_sheet_today')}
          demande={() =>
            demandeFeuilleCaisse({
              compteId: accountId,
              jour: today,
              session: null,
              refs,
              mouvements: todayItems.map((m) => ({
                occurredAt: m.occurredAt,
                direction: m.direction,
                montant: m.amountXaf,
                piece: null,
                libelle: t(`treasury.movement_type.${m.movementType}`, {
                  defaultValue: m.movementType,
                }),
                moyen: null,
              })),
            })
          }
        />
      ) : null}
      {next ? (
        <div className="result-actions">
          <Button
            variant="outline"
            size="sm"
            disabled={extra?.loading === true}
            onClick={() => void loadMore()}
          >
            {t('treasury.movements_more')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
