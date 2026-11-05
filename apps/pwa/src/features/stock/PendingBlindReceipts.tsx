/**
 * Réceptions sans document en attente de rapprochement (ECR-STK-03, AV-520 ; BR-STK-024) : celles de
 * l'emplacement choisi que le serveur n'a pas rapprochées d'une expédition. La personne peut en rapprocher une à la
 * main d'un transfert expédié de la même paire (`inventory.transfer.match_blind`) ou l'annuler si elle a été saisie
 * par erreur (`inventory.transfer.cancel_blind`, motif exigé). Les deux commandes se font **en ligne seulement** :
 * le serveur contrôle les produits, le statut et la marchandise encore présente à la destination.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatBusinessDay } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatQuantity, unitLabel } from '../sales/format.js';
import type { SalesReferences } from '../sales/references.js';
import { saveErrorKey, submitCommand } from '../sales/submit.js';
import type { StockTransferData } from '../sales/types.js';
import {
  cancelBlindPayload,
  matchBlindPayload,
  matchCandidates,
  MAX_CANCEL_BLIND_REASON,
  pendingBlindReceipts,
} from './receive.js';

type Open = { readonly receiptId: string; readonly mode: 'MATCH' | 'CANCEL' };

export function PendingBlindReceipts({
  refs,
  userId,
  destinationId,
  online,
}: {
  readonly refs: SalesReferences;
  readonly userId: string;
  readonly destinationId: string;
  readonly online: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Open | null>(null);
  const [transferChoice, setTransferChoice] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastCommand, setLastCommand] = useState<string>();
  const choiceId = useId();
  const reasonId = useId();

  const receipts = pendingBlindReceipts(refs.transfers, destinationId);
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const locationName = (id: string) =>
    refs.locations.find((location) => location.id === id)?.name ?? t('ledger.unknown_place');
  if (receipts.length === 0 && lastCommand === undefined) return null;

  const send = async (receipt: StockTransferData, mode: Open['mode']) => {
    setBusy(true);
    setSaveError(null);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType:
          mode === 'MATCH' ? 'inventory.transfer.match_blind' : 'inventory.transfer.cancel_blind',
        aggregateType: 'STOCK_TRANSFER',
        aggregateId: receipt.id,
        payload: mode === 'MATCH' ? matchBlindPayload(transferChoice) : cancelBlindPayload(reason),
      });
      setLastCommand(command.command_id);
      setOpen(null);
      setTransferChoice('');
      setReason('');
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale-block" aria-labelledby="blind-pending-title">
      <h2 id="blind-pending-title">{t('blind.pending_title')}</h2>
      <p className="home-muted">{t('blind.pending_hint')}</p>
      {!online ? (
        <p className="text-warn" role="status">
          {t('blind.pending_online_only')}
        </p>
      ) : null}
      {lastCommand !== undefined ? (
        <CommandResult commandId={lastCommand} messages="blind.pending_result" />
      ) : null}
      <ul className="receipt-lines">
        {receipts.map((receipt) => {
          const candidates = matchCandidates(refs.transfers, receipt);
          const isOpen = open?.receiptId === receipt.id;
          return (
            <li key={receipt.id} aria-label={receipt.doc_number}>
              <div>
                <strong>{receipt.doc_number}</strong>{' '}
                <span className="home-muted">
                  {t('blind.pending_item', {
                    source: locationName(receipt.from_location_id),
                    date: formatBusinessDay(receipt.occurred_at.slice(0, 10)),
                  })}
                </span>
                <ul>
                  {receipt.lines.map((line) => {
                    const product = products.get(line.product_id);
                    const quantity = Number(line.received_qty_base ?? 0);
                    return (
                      <li key={line.id}>
                        {formatQuantity(quantity)}{' '}
                        {unitLabel(product?.base_unit_code ?? line.unit_code, quantity)}{' '}
                        {product?.name ?? line.product_id}
                      </li>
                    );
                  })}
                </ul>
              </div>
              {isOpen && open.mode === 'MATCH' ? (
                <div className="field">
                  {candidates.length === 0 ? (
                    <p className="text-warn">{t('blind.match_none')}</p>
                  ) : (
                    <>
                      <label htmlFor={choiceId}>{t('blind.match_choose')}</label>
                      <select
                        id={choiceId}
                        className="text-input"
                        value={transferChoice}
                        onChange={(event) => setTransferChoice(event.target.value)}
                      >
                        <option value="">{t('blind.match_placeholder')}</option>
                        {candidates.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.doc_number}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={busy || !online || transferChoice === ''}
                        onClick={() => void send(receipt, 'MATCH')}
                      >
                        {t('blind.match_confirm')}
                      </button>
                    </>
                  )}
                </div>
              ) : null}
              {isOpen && open.mode === 'CANCEL' ? (
                <div className="field">
                  <label htmlFor={reasonId}>{t('blind.cancel_reason_label')}</label>
                  <textarea
                    id={reasonId}
                    className="text-input"
                    rows={2}
                    maxLength={MAX_CANCEL_BLIND_REASON}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <button
                    type="button"
                    disabled={busy || !online || reason.trim() === ''}
                    onClick={() => void send(receipt, 'CANCEL')}
                  >
                    {t('blind.cancel_confirm')}
                  </button>
                </div>
              ) : null}
              {!isOpen ? (
                <div className="result-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={!online}
                    onClick={() => {
                      setOpen({ receiptId: receipt.id, mode: 'MATCH' });
                      setTransferChoice('');
                    }}
                  >
                    {t('blind.pending_match')}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={!online}
                    onClick={() => {
                      setOpen({ receiptId: receipt.id, mode: 'CANCEL' });
                      setReason('');
                    }}
                  >
                    {t('blind.pending_cancel')}
                  </button>
                </div>
              ) : (
                <button type="button" className="secondary" onClick={() => setOpen(null)}>
                  {t('blind.pending_close')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {saveError !== null ? (
        <p className="alert alert-error" role="alert">
          {t(saveError)}
        </p>
      ) : null}
    </section>
  );
}
