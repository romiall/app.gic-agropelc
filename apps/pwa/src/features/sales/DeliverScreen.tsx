/**
 * ECR-VEN-04 « LIVRER une commande » : quantités remises au client, ligne par ligne, en unité de
 * base, plafonnées à ce qui est vendu et pas encore livré (déduction faite des livraisons de
 * l'appareil en attente) ; nom de la personne qui reçoit et observations facultatifs. Commande
 * `sales.order.fulfil` (agrégat `DELIVERY_NOTE`), utilisable hors ligne. Une livraison ne consomme pas
 * le stock de l'emplacement : la marchandise vendue l'a quitté à la confirmation (ADR-028 §1).
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ROUTES } from '../../app/screens.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { CommandResult } from './CommandResult.js';
import { PieceAction } from '../pieces/PieceAction.js';
import { demandeBonLivraison, type LivraisonSaisie } from '../pieces/adaptateurs-ventes.js';
import { formatQuantity, unitLabel } from './format.js';
import { openOrders, type OrderView } from './open-orders.js';
import { useSalesReferences } from './references.js';
import { MAX_COMMENT_LENGTH, MAX_RECIPIENT_LENGTH } from './sale-form.js';
import { submitCommand } from './submit.js';

/** Saisie décimale ≥ 0 (virgule ou point, 3 décimales au plus) ; `null` si invalide. */
function parseDelivered(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (normalized === '') return 0;
  if (!/^\d+(\.\d{1,3})?$/.test(normalized)) return null;
  return Number(normalized);
}

export function DeliverScreen() {
  const { t } = useTranslation();
  const { orderId } = useParams();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  /** Saisie par ligne ; absente : quantité à livrer (préremplissage). */
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [recipient, setRecipient] = useState('');
  const [notes, setNotes] = useState('');
  const [submitted, setSubmitted] = useState<{
    commandId: string;
    doc: string;
    order: OrderView;
    delivery: Omit<LivraisonSaisie, 'numero'>;
  }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  // Le résultat reste affiché même si la livraison complète fait sortir la commande du jeu `orders`.
  if (submitted) {
    return (
      <section className="sale">
        <h1>{t('orders.deliver.title', { doc: submitted.doc })}</h1>
        <CommandResult commandId={submitted.commandId} messages="orders.deliver.result">
          {/* Bon de livraison (lot PP) : numéro officiel dès que le serveur l'a attribué. */}
          <PieceAction
            cle={`BL:${submitted.commandId}`}
            demande={() =>
              demandeBonLivraison(
                submitted.order,
                {
                  ...submitted.delivery,
                  numero:
                    refs.outbox.find((c) => c.command_id === submitted.commandId)?.server_refs
                      ?.docNumber ?? null,
                },
                refs,
              )
            }
          />
          <Link
            to={orderId ? ROUTES.order(orderId) : ROUTES.orders}
            className="action action-compact"
          >
            <span className="action-label">{t('orders.deliver.back_to_order')}</span>
          </Link>
        </CommandResult>
      </section>
    );
  }

  const order = openOrders(refs).find((candidate) => candidate.id === orderId);
  const back = (
    <Link to={orderId ? ROUTES.order(orderId) : ROUTES.orders} className="back-link">
      {t('orders.deliver.back_to_order')}
    </Link>
  );
  if (!order) {
    return (
      <section className="sale">
        {back}
        <p className="alert alert-error">{t('orders.detail.not_found')}</p>
      </section>
    );
  }
  const doc = order.docNumber ?? t('sales.pending_number');

  const deliverable = order.lines.filter(
    (line): line is typeof line & { id: string } => line.id !== null && line.toDeliverBase > 0,
  );
  const entries = deliverable.map((line) => {
    const text = quantities[line.id] ?? String(line.toDeliverBase);
    const value = parseDelivered(text);
    const valid = value !== null && value <= line.toDeliverBase;
    return { line, text, value: valid ? value : null };
  });
  const errors = entries
    .filter((entry) => entry.value === null)
    .map((entry) =>
      t('orders.deliver.error_quantity', {
        product: entry.line.productName,
        max: formatQuantity(entry.line.toDeliverBase),
      }),
    );
  const toSend = entries.filter((entry) => entry.value !== null && entry.value > 0);
  if (errors.length === 0 && deliverable.length > 0 && toSend.length === 0) {
    errors.push(t('orders.deliver.error_empty'));
  }
  const ready = deliverable.length > 0 && errors.length === 0 && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'sales.order.fulfil',
        aggregateType: 'DELIVERY_NOTE',
        // Commande encore dans l'outbox : la livraison attend son application.
        ...(order.commandId ? { dependsOn: [order.commandId] } : {}),
        payload: {
          orderId: order.id,
          ...(recipient.trim() ? { recipientName: recipient.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          lines: toSend.map((entry) => ({
            orderLineId: entry.line.id,
            quantityBase: entry.value ?? 0,
          })),
        },
      });
      setSubmitted({
        commandId: command.command_id,
        doc,
        order,
        delivery: {
          occurredAt: command.occurred_at,
          auteurId: userId,
          recuPar: recipient.trim() || null,
          observations: notes.trim() || null,
          lignes: toSend.map((entry) => ({
            orderLineId: entry.line.id ?? '',
            quantityBase: entry.value ?? 0,
          })),
        },
      });
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale">
      {back}
      <h1>{t('orders.deliver.title', { doc })}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('orders.deliver.offline_banner')}
        </p>
      ) : null}
      {deliverable.length === 0 ? (
        <p className="home-muted">{t('orders.deliver.nothing')}</p>
      ) : (
        <>
          <p className="home-muted">{t('orders.deliver.hint')}</p>
          <ul className="line-list">
            {entries.map(({ line, text }) => {
              const product = refs.products.find((candidate) => candidate.id === line.productId);
              const unit = product?.base_unit_code ?? '';
              return (
                <li key={line.id} className="line-card" aria-label={line.productName}>
                  <div className="line-head">
                    <strong>{line.productName}</strong>
                    <small>
                      {t('orders.deliver.line_max', {
                        quantity: formatQuantity(line.toDeliverBase),
                        unit: unitLabel(unit, line.toDeliverBase, refs.units),
                      })}
                    </small>
                  </div>
                  <div className="field">
                    <label htmlFor={`deliver-${line.id}`}>
                      {t('orders.deliver.quantity_label', { unit: unitLabel(unit, 1, refs.units) })}
                    </label>
                    <input
                      id={`deliver-${line.id}`}
                      className="text-input"
                      inputMode="decimal"
                      value={text}
                      onChange={(event) =>
                        setQuantities((current) => ({ ...current, [line.id]: event.target.value }))
                      }
                    />
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="field">
            <label htmlFor="deliver-recipient">{t('orders.deliver.recipient_label')}</label>
            <input
              id="deliver-recipient"
              className="text-input"
              maxLength={MAX_RECIPIENT_LENGTH}
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="deliver-notes">{t('orders.deliver.notes_label')}</label>
            <textarea
              id="deliver-notes"
              className="text-input"
              rows={2}
              maxLength={MAX_COMMENT_LENGTH}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          {errors.map((message) => (
            <p key={message} className="error-message" role="alert">
              {message}
            </p>
          ))}
          {saveError ? (
            <p className="alert alert-error" role="alert">
              {t('sales.error_local_save')}
            </p>
          ) : null}
          <button
            type="button"
            className="btn-block submit-sale"
            disabled={!ready}
            onClick={() => void submit()}
          >
            {busy ? t('sales.submitting') : t('orders.deliver.submit')}
          </button>
        </>
      )}
    </section>
  );
}
