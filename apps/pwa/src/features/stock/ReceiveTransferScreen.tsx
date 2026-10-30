/**
 * ECR-STK-03 « RECEVOIR un transfert » (destinataires). Liste des transferts expédiés vers les
 * emplacements de l'appareil (jeu `transfers`), puis saisie des quantités reçues ligne par ligne, en
 * unité de base, préremplies à l'expédié ; un écart peut porter un motif `TRANSFER_DISCREPANCY` (liste
 * vide admise). Commande `inventory.transfer.receive` avec document (agrégat `STOCK_TRANSFER`,
 * identifiant du transfert), utilisable hors ligne : la marchandise reçue s'ajoute aussitôt au
 * disponible local. Un reçu supérieur à l'expédié est refusé en ligne (`TRANSFER_OVER_RECEIVED`) et
 * signalé hors ligne. Une réception déjà saisie sur l'appareil n'est pas proposée une seconde fois
 * (le serveur mettrait la seconde en quarantaine). La réception sans document (P5-16) n'est pas
 * proposée par ce lot.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ActionBar, Button, PageHeader } from '../../components/ui/index.js';
import { PieceAction } from '../pieces/PieceAction.js';
import { demandeBonTransfert } from '../pieces/adaptateurs-stock.js';
import { businessDayOf } from '@gic/domain';
import { ROUTES } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatMoment } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatQuantity, unitLabel } from '../sales/format.js';
import { useSalesReferences, type SalesReferences } from '../sales/references.js';
import { incomingTransfers, parseReceived } from './receive.js';
import { submitCommand } from '../sales/submit.js';
import type { StockTransferData } from '../sales/types.js';

function ReceiveForm({
  transfer,
  refs,
  userId,
  online,
  onDone,
}: {
  readonly transfer: StockTransferData;
  readonly refs: SalesReferences;
  readonly userId: string;
  readonly online: boolean;
  readonly onDone: (commandId: string) => void;
}) {
  const { t } = useTranslation();
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const discrepancyReasons = refs.reasonCodes.filter(
    (reason) => reason.category === 'TRANSFER_DISCREPANCY',
  );
  const lines = transfer.lines
    .filter((line) => Number(line.dispatched_qty_base ?? 0) > 0)
    .map((line) => {
      const dispatched = Number(line.dispatched_qty_base ?? 0);
      const text = quantities[line.id] ?? String(dispatched);
      const received = parseReceived(text);
      return { line, dispatched, text, received };
    });
  const invalid = lines.some((entry) => entry.received === null);
  const over = lines.some((entry) => entry.received !== null && entry.received > entry.dispatched);
  const ready = lines.length > 0 && !invalid && !(online && over) && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'inventory.transfer.receive',
        aggregateType: 'STOCK_TRANSFER',
        aggregateId: transfer.id,
        payload: {
          transferId: transfer.id,
          lines: lines.map((entry) => ({
            transferLineId: entry.line.id,
            receivedQtyBase: entry.received ?? 0,
            ...(reasons[entry.line.id] && (entry.received ?? 0) < entry.dispatched
              ? { discrepancyReasonCodeId: reasons[entry.line.id] }
              : {}),
          })),
        },
      });
      onDone(command.command_id);
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="home-muted">{t('receive.hint')}</p>
      <ul className="line-list">
        {lines.map(({ line, dispatched, text, received }) => {
          const product = products.get(line.product_id);
          const unit = product?.base_unit_code ?? line.unit_code;
          const short = received !== null && received < dispatched;
          return (
            <li key={line.id} className="line-card" aria-label={product?.name ?? line.product_id}>
              <div className="line-head">
                <strong>{product?.name ?? line.product_id}</strong>
                <small>
                  {t('receive.dispatched', {
                    quantity: formatQuantity(dispatched),
                    unit: unitLabel(unit, dispatched),
                  })}
                </small>
              </div>
              <div className="field">
                <label htmlFor={`receive-${line.id}`}>
                  {t('receive.received_label', { unit: unitLabel(unit) })}
                </label>
                <input
                  id={`receive-${line.id}`}
                  className="text-input"
                  inputMode="decimal"
                  value={text}
                  onChange={(event) =>
                    setQuantities((current) => ({ ...current, [line.id]: event.target.value }))
                  }
                />
              </div>
              {received === null ? (
                <p className="error-message">{t('receive.quantity_invalid')}</p>
              ) : null}
              {short ? (
                <p className="text-warn">
                  {t('receive.short', {
                    quantity: formatQuantity(dispatched - (received ?? 0)),
                    unit: unitLabel(unit, dispatched - (received ?? 0)),
                  })}
                </p>
              ) : null}
              {short && discrepancyReasons.length > 0 ? (
                <div className="field">
                  <label htmlFor={`reason-${line.id}`}>{t('receive.reason_label')}</label>
                  <select
                    id={`reason-${line.id}`}
                    className="text-input"
                    value={reasons[line.id] ?? ''}
                    onChange={(event) =>
                      setReasons((current) => ({ ...current, [line.id]: event.target.value }))
                    }
                  >
                    <option value="">{t('receive.reason_placeholder')}</option>
                    {discrepancyReasons.map((reason) => (
                      <option key={reason.id} value={reason.id}>
                        {reason.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {over ? (
        <p className={online ? 'error-message' : 'text-warn'} role="alert">
          {t(online ? 'receive.over_online' : 'receive.over_offline')}
        </p>
      ) : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t('sales.error_local_save')}
        </p>
      ) : null}
      <ActionBar>
        <Button size="lg" className="submit-sale" disabled={!ready} onClick={() => void submit()}>
          {busy ? t('sales.submitting') : t('receive.submit')}
        </Button>
      </ActionBar>
    </>
  );
}

export function ReceiveTransferScreen() {
  const { t } = useTranslation();
  const { transferId } = useParams();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  // Résultat attaché au transfert reçu : il ne s'affiche plus une fois revenu à la liste.
  const [submitted, setSubmitted] = useState<{
    commandId: string;
    doc: string;
    transferId: string;
  }>();

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <PageHeader title={t('nav.screens.receive')} />
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  if (submitted && submitted.transferId === transferId) {
    return (
      <section className="sale">
        <PageHeader title={t('receive.title', { doc: submitted.doc })} />
        <CommandResult commandId={submitted.commandId} messages="receive.result">
          <Link to={ROUTES.receive} className="action action-compact">
            <span className="action-label">{t('receive.back')}</span>
          </Link>
        </CommandResult>
      </section>
    );
  }

  const locations = new Map(refs.locations.map((location) => [location.id, location]));
  const incoming = incomingTransfers(refs);
  const today = businessDayOf(clock.now());

  if (transferId) {
    const entry = incoming.find((candidate) => candidate.transfer.id === transferId);
    const back = (
      <Link to={ROUTES.receive} className="back-link">
        {t('receive.back')}
      </Link>
    );
    if (!entry || entry.receiving) {
      return (
        <section className="sale">
          {back}
          <p className="alert alert-error">
            {t(entry?.receiving ? 'receive.already_receiving' : 'receive.not_found')}
          </p>
        </section>
      );
    }
    const { transfer } = entry;
    return (
      <section className="sale">
        <PageHeader
          title={t('receive.title', { doc: transfer.doc_number })}
          backTo={ROUTES.receive}
          backLabel={t('receive.back')}
        />
        <p className="receipt-meta">
          {t('receive.route', {
            from: locations.get(transfer.from_location_id)?.name ?? '',
            to: locations.get(transfer.to_location_id)?.name ?? '',
          })}
          {transfer.carrier_name ? ` · ${transfer.carrier_name}` : ''}
        </p>
        {/* Bon de transfert (lot PP). */}
        <PieceAction
          cle={`BT:${transfer.id}`}
          demande={() => demandeBonTransfert(transfer, refs)}
        />
        {!online ? (
          <p className="home-banner" role="status">
            {t('receive.offline_banner')}
          </p>
        ) : null}
        <ReceiveForm
          transfer={transfer}
          refs={refs}
          userId={userId}
          online={online}
          onDone={(commandId) =>
            setSubmitted({ commandId, doc: transfer.doc_number, transferId: transfer.id })
          }
        />
      </section>
    );
  }

  return (
    <section className="sale">
      <div className="screen-head">
        <PageHeader title={t('nav.screens.receive')} />
        <Link to={ROUTES.blindReceipt} className="action action-compact">
          <span className="action-label">{t('blind.title')}</span>
        </Link>
      </div>
      <p className="home-muted">{t('receive.list_hint')}</p>
      {incoming.length === 0 ? (
        <p className="home-muted">{t('receive.empty')}</p>
      ) : (
        <ul className="doc-list">
          {incoming.map(({ transfer, receiving }) => (
            <li key={transfer.id}>
              <Link
                to={ROUTES.receiveOne(transfer.id)}
                className="doc-row"
                aria-label={t('receive.open', { doc: transfer.doc_number })}
              >
                <span className="doc-main">
                  <strong>{transfer.doc_number}</strong>
                  <small>
                    {t('receive.from', {
                      from: locations.get(transfer.from_location_id)?.name ?? '',
                    })}
                    {transfer.dispatched_at
                      ? ` · ${formatMoment(transfer.dispatched_at, today)}`
                      : ''}
                  </small>
                </span>
                <span className="doc-side">
                  <span className={`badge badge-${receiving ? 'info' : 'warn'}`}>
                    {t(receiving ? 'receive.receiving' : 'receive.to_receive')}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
