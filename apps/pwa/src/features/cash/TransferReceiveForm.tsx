/**
 * Réception d'une remise de fonds (`finance.cash_transfer.receive`) : le montant envoyé est connu, le
 * reçu est compté et saisi (0 si rien n'est arrivé, AV-175) ; l'écart (reçu − envoyé) est annoncé
 * avant confirmation : il part en validation de la Finance, sans second mouvement (ADR-032 §7).
 * Partagé par l'écran des remises (AV-239) et la trésorerie (ECR-FIN-05).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '../sales/format.js';
import { parseXaf } from '../sales/sale-form.js';
import { MAX_TRANSFER_COMMENT } from './transfers.js';

export function TransferReceiveForm({
  sentXaf,
  busy,
  onSubmit,
  onClose,
}: {
  readonly sentXaf: number;
  readonly busy: boolean;
  readonly onSubmit: (receivedXaf: number, comment: string) => void;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [comment, setComment] = useState('');
  const ids = { amount: useId(), issue: useId(), preview: useId(), comment: useId() };
  // Focus porté sur le montant compté à l'ouverture du formulaire.
  const amountRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    amountRef.current?.focus();
  }, []);
  const received = parseXaf(text);
  const issue = text.trim() !== '' && received === null;
  const gap = received === null ? null : received - sentXaf;
  return (
    <div className="field">
      <label htmlFor={ids.amount}>{t('cash_transfer.received_label')}</label>
      <input
        id={ids.amount}
        ref={amountRef}
        className="text-input"
        inputMode="numeric"
        autoComplete="off"
        value={text}
        aria-invalid={issue}
        aria-describedby={issue ? ids.issue : gap !== null ? ids.preview : undefined}
        onChange={(event) => setText(event.target.value)}
      />
      {issue ? (
        <p id={ids.issue} className="error-message">
          {t('cash_transfer.received_invalid')}
        </p>
      ) : gap === null ? null : (
        <p id={ids.preview} className={gap === 0 ? 'home-muted' : 'text-warn'} role="status">
          {received === 0
            ? t('cash_transfer.lost')
            : gap === 0
              ? t('cash_transfer.match')
              : t('cash_transfer.discrepancy', {
                  amount: `${gap > 0 ? '+' : ''}${formatMoney(gap)}`,
                })}
        </p>
      )}
      <label htmlFor={ids.comment}>{t('cash_transfer.comment_label')}</label>
      <textarea
        id={ids.comment}
        className="text-input"
        rows={2}
        maxLength={MAX_TRANSFER_COMMENT}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
      />
      <div className="result-actions">
        <button
          type="button"
          disabled={busy || received === null}
          onClick={() => (received === null ? undefined : onSubmit(received, comment))}
        >
          {t('cash_transfer.receive_submit', { amount: formatMoney(received ?? 0) })}
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          {t('cash_transfer.close_form')}
        </button>
      </div>
    </div>
  );
}
