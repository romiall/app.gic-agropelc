/**
 * ECR-APP-04 « RÉCEPTIONNER » (magasinier, responsable de ferme ; WF-J3 étape 2). Bons de commande
 * à recevoir sur les emplacements de l'appareil, puis réception ligne par ligne : livré, rejeté avec
 * motif, accepté ; lot fournisseur et péremption ; numéro du bon de livraison (doublon détecté par
 * le serveur). Commande `procurement.receipt.record` (agrégat `GOODS_RECEIPT`), utilisable hors
 * ligne ; l'accepté entre aussitôt au disponible local, sauf une réception annoncée en quarantaine.
 * Réceptions des 30 derniers jours listées.
 */
import { useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PieceAction } from '../pieces/PieceAction.js';
import { demandeBonReception } from '../pieces/adaptateurs-achats.js';
import { businessDayOf } from '@gic/domain';
import { ROUTES } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDay, formatMoment } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney, formatQuantity, unitLabel } from '../sales/format.js';
import { useSalesReferences, type SalesReferences } from '../sales/references.js';
import { submitCommand, useOutboxCommand } from '../sales/submit.js';
import { hasUsablePhoto, photoAttachment, useOwnerPhotos } from '../attachments/attachments.js';
import type { PreparedPhoto } from '../attachments/photo.js';
import { PhotoField } from '../attachments/PhotoField.js';
import { AttachPhoto, PhotoStatus } from '../attachments/PhotoViews.js';
import type { PurchaseOrderData } from '../sales/types.js';
import {
  checkReceiptLine,
  duplicateDeliveryNote,
  EMPTY_LINE,
  inFlightAccepted,
  localRemaining,
  MAX_DELIVERY_NOTE_REF,
  MAX_LOT_REF,
  MAX_OBSERVATIONS,
  receiptLocations,
  receiptPayload,
  receiptSettings,
  receivableOrders,
  type ReceiptLineDraft,
} from './receipt.js';

interface FormProps {
  readonly refs: SalesReferences;
  readonly userId: string;
  readonly online: boolean;
  readonly order: PurchaseOrderData;
  readonly onDone: (commandId: string, receiptId: string) => void;
}

const RECEIPT_PHOTO = { kind: 'DELIVERY_NOTE', ownerType: 'GOODS_RECEIPT' } as const;

/**
 * Réceptions saisies par l'utilisateur sur cet appareil : leur photo se joint ou se reprend ici ;
 * `true` si le serveur a signalé la photo manquante (AV-246).
 */
function ownReceipts(refs: SalesReferences, userId: string): ReadonlyMap<string, boolean> {
  return new Map(
    refs.outbox
      .filter(
        (command) =>
          command.command_type === 'procurement.receipt.record' &&
          command.author_user_id === userId,
      )
      .map((command) => [
        command.aggregate_id,
        (command.warnings ?? []).includes('RECEIPT_PHOTO_MISSING'),
      ]),
  );
}

/**
 * Photo d'une réception : à joindre (badge « photo manquante ») si le serveur l'a signalée manquante
 * ou si la photo prise a été refusée, tant qu'aucune photo n'est reçue ou en route (AV-285, AV-290) ;
 * sinon son état.
 */
function ReceiptPhotoBlock({
  receiptId,
  userId,
  missing,
}: {
  readonly receiptId: string;
  readonly userId: string;
  readonly missing: boolean;
}) {
  const { t } = useTranslation();
  const photos = useOwnerPhotos(receiptId, userId);
  if (photos === undefined) return null;
  const refused = photos.some((photo) => photo.state === 'REFUSED');
  if (hasUsablePhoto(photos) || !(missing || refused)) {
    return <PhotoStatus ownerId={receiptId} userId={userId} />;
  }
  return (
    <span className="receipt-photo">
      <span className="badge badge-warn">{t('photo.missing_badge')}</span>
      <AttachPhoto
        userId={userId}
        target={{ ...RECEIPT_PHOTO, cited: false, ownerId: receiptId }}
        label={t('photo.attach_receipt')}
      />
    </span>
  );
}

/** Résultat d'une réception : état de sa photo, ou photo à joindre si elle manque (AV-285). */
function ReceiptPhotoResult({
  commandId,
  receiptId,
  userId,
}: {
  readonly commandId: string;
  readonly receiptId: string;
  readonly userId: string;
}) {
  const command = useOutboxCommand(commandId);
  return (
    <ReceiptPhotoBlock
      receiptId={receiptId}
      userId={userId}
      missing={(command?.warnings ?? []).includes('RECEIPT_PHOTO_MISSING')}
    />
  );
}

function ReceiptForm({ refs, userId, online, order, onDone }: FormProps) {
  const { t } = useTranslation();
  const [locationChoice, setLocationChoice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ReceiptLineDraft>>({});
  const [deliveryNote, setDeliveryNote] = useState('');
  const [observations, setObservations] = useState('');
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const locationId = useId();
  const noteId = useId();
  const observationsId = useId();

  const { tolerancePct, offlineOverMode, photoThresholdXaf } = receiptSettings(
    refs.settings,
    clock.now(),
  );
  const locations = receiptLocations(refs.locations, order);
  // Sans emplacement de livraison connu, aucun emplacement n'est choisi à la place du magasinier.
  const location =
    locations.find((candidate) => candidate.id === locationChoice) ??
    locations.find((candidate) => candidate.id === order.delivery_location_id);
  const inFlight = inFlightAccepted(refs.outbox, refs.procurementPulledAt);
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const reasons = refs.reasonCodes.filter((reason) => reason.category === 'REJECTION');
  const rows = [...order.lines]
    .filter((line) => line.status !== 'CANCELLED')
    .sort((a, b) => a.line_no - b.line_no)
    .map((line) => {
      const pending = inFlight.get(line.id) ?? 0;
      const remaining = localRemaining(line, pending);
      const draft = drafts[line.id] ?? {
        ...EMPTY_LINE,
        deliveredText: remaining > 0 ? formatQuantity(remaining).replace(/\s/g, '') : '',
      };
      return {
        line,
        draft,
        remaining,
        product: products.get(line.product_id),
        check: checkReceiptLine(line, draft, pending, tolerancePct),
      };
    });
  const delivered = rows.filter((row) => row.check.delivered !== null);
  const over = rows.filter((row) => row.check.over > 0);
  const duplicateNote = duplicateDeliveryNote(
    order.supplier_id,
    deliveryNote,
    refs.goodsReceipts,
    refs.outbox,
    refs.procurementPulledAt,
  );
  const commentRequired = rows.some(
    (row) =>
      row.check.rejected > 0 &&
      reasons.find((reason) => reason.id === row.draft.reasonId)?.requires_comment === true,
  );
  // Motif de rejet qui exige un commentaire : précisé dans les observations (pas de commentaire par
  // ligne dans le contrat).
  const commentMissing = commentRequired && observations.trim() === '';
  const ready =
    location !== undefined &&
    delivered.length > 0 &&
    rows.every((row) => row.check.issues.length === 0) &&
    !commentMissing &&
    !(online && over.length > 0) &&
    !preparing &&
    !busy;

  const update = (lineId: string, base: ReceiptLineDraft, patch: Partial<ReceiptLineDraft>) =>
    setDrafts((current) => ({ ...current, [lineId]: { ...base, ...patch } }));

  const submit = async () => {
    if (!ready || !location) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'procurement.receipt.record',
        aggregateType: 'GOODS_RECEIPT',
        // Photo du bon citée par la réception : « photo présente » (BR-APP-014, ADR-046).
        ...(photo
          ? { attachments: [photoAttachment(photo, { ...RECEIPT_PHOTO, cited: true })] }
          : {}),
        // Quarantaine prévisible (bon de livraison déjà reçu, ou dépassement hors ligne en mode
        // quarantaine) : rien n'entre au disponible local.
        ...(duplicateNote || (!online && over.length > 0 && offlineOverMode === 'QUARANTINE')
          ? { localFlags: ['EXPECTED_QUARANTINE'] }
          : {}),
        payload: receiptPayload({
          order,
          locationId: location.id,
          deliveryNoteRef: deliveryNote,
          observations,
          lines: rows,
        }),
      });
      onDone(command.command_id, command.aggregate_id);
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  if (locations.length === 0) {
    return <p className="alert alert-error">{t('purchase_receipt.no_location')}</p>;
  }

  return (
    <>
      <div className="field">
        <label htmlFor={locationId}>{t('purchase_receipt.location_label')}</label>
        <select
          id={locationId}
          className="text-input"
          value={location?.id ?? ''}
          onChange={(event) => setLocationChoice(event.target.value)}
        >
          {location === undefined ? (
            <option value="">{t('purchase_receipt.location_placeholder')}</option>
          ) : null}
          {locations.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={noteId}>{t('purchase_receipt.delivery_note_label')}</label>
        <input
          id={noteId}
          className="text-input"
          maxLength={MAX_DELIVERY_NOTE_REF}
          value={deliveryNote}
          onChange={(event) => setDeliveryNote(event.target.value)}
        />
        <p className="home-muted">{t('purchase_receipt.delivery_note_hint')}</p>
        {duplicateNote ? (
          <p className="text-warn" role="status">
            {t('purchase_receipt.duplicate_note')}
          </p>
        ) : null}
      </div>

      <ul className="line-list">
        {rows.map(({ line, draft, remaining, product, check }) => {
          const unit = product?.base_unit_code ?? line.unit_code;
          const name = product?.name ?? line.product_id;
          const tracked = product !== undefined && product.lot_tracking !== 'NONE';
          return (
            <li key={line.id} className="line-card" aria-label={name}>
              <div className="line-head">
                <strong>{name}</strong>
                <span>
                  {t('purchase_receipt.remaining', {
                    quantity: formatQuantity(remaining),
                    unit: unitLabel(unit, remaining),
                  })}
                </span>
              </div>
              <div className="line-fields">
                <div className="field">
                  <label htmlFor={`delivered-${line.id}`}>
                    {t('purchase_receipt.delivered_label', { unit: unitLabel(unit) })}
                  </label>
                  <input
                    id={`delivered-${line.id}`}
                    className="text-input"
                    inputMode="decimal"
                    value={draft.deliveredText}
                    onChange={(event) =>
                      update(line.id, draft, { deliveredText: event.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor={`rejected-${line.id}`}>
                    {t('purchase_receipt.rejected_label', { unit: unitLabel(unit) })}
                  </label>
                  <input
                    id={`rejected-${line.id}`}
                    className="text-input"
                    inputMode="decimal"
                    value={draft.rejectedText}
                    onChange={(event) =>
                      update(line.id, draft, { rejectedText: event.target.value })
                    }
                  />
                </div>
              </div>
              {check.delivered !== null && check.issues.length === 0 ? (
                <p className="home-muted">
                  {t('purchase_receipt.accepted', {
                    quantity: formatQuantity(check.accepted),
                    unit: unitLabel(unit, check.accepted),
                  })}
                </p>
              ) : null}
              {check.rejected > 0 ? (
                reasons.length === 0 ? (
                  <p className="error-message">{t('purchase_receipt.no_reason')}</p>
                ) : (
                  <div className="field">
                    <label htmlFor={`reason-${line.id}`}>
                      {t('purchase_receipt.reason_label')}
                    </label>
                    <select
                      id={`reason-${line.id}`}
                      className="text-input"
                      value={draft.reasonId}
                      onChange={(event) => update(line.id, draft, { reasonId: event.target.value })}
                    >
                      <option value="">{t('purchase_receipt.reason_placeholder')}</option>
                      {reasons.map((reason) => (
                        <option key={reason.id} value={reason.id}>
                          {reason.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )
              ) : null}
              {tracked ? (
                <div className="line-fields">
                  <div className="field">
                    <label htmlFor={`lot-${line.id}`}>{t('purchase_receipt.lot_label')}</label>
                    <input
                      id={`lot-${line.id}`}
                      className="text-input"
                      maxLength={MAX_LOT_REF}
                      value={draft.lotRef}
                      onChange={(event) => update(line.id, draft, { lotRef: event.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`expiry-${line.id}`}>
                      {t('purchase_receipt.expiry_label')}
                    </label>
                    <input
                      id={`expiry-${line.id}`}
                      type="date"
                      className="text-input"
                      value={draft.expiryDate}
                      onChange={(event) =>
                        update(line.id, draft, { expiryDate: event.target.value })
                      }
                    />
                  </div>
                </div>
              ) : null}
              {check.issues.map((issue) => (
                <p key={issue} className="error-message">
                  {t(`purchase_receipt.issue.${issue}`)}
                </p>
              ))}
              {check.over > 0 ? (
                online ? (
                  <p className="error-message" role="alert">
                    {t('purchase_receipt.over_online', {
                      quantity: formatQuantity(check.over),
                      unit: unitLabel(unit, check.over),
                    })}
                  </p>
                ) : (
                  <p className="text-warn">
                    {t(
                      offlineOverMode === 'QUARANTINE'
                        ? 'purchase_receipt.over_offline'
                        : 'purchase_receipt.over_offline_apply',
                      { quantity: formatQuantity(check.over), unit: unitLabel(unit, check.over) },
                    )}
                  </p>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="field">
        <label htmlFor={observationsId}>
          {commentRequired
            ? t('purchase_receipt.observations_required_label')
            : t('purchase_receipt.observations_label')}
        </label>
        <textarea
          id={observationsId}
          className="text-input"
          rows={2}
          maxLength={MAX_OBSERVATIONS}
          value={observations}
          aria-required={commentRequired}
          aria-invalid={commentMissing}
          aria-describedby={commentMissing ? `${observationsId}-error` : undefined}
          onChange={(event) => setObservations(event.target.value)}
        />
        {commentMissing ? (
          <p id={`${observationsId}-error`} className="error-message">
            {t('purchase_receipt.comment_required')}
          </p>
        ) : null}
      </div>
      <PhotoField
        label={t('photo.receipt_label')}
        hint={t('photo.receipt_hint', { threshold: formatMoney(photoThresholdXaf) })}
        value={photo}
        onChange={setPhoto}
        onBusyChange={setPreparing}
      />
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
        {busy ? t('sales.submitting') : t('purchase_receipt.submit')}
      </button>
    </>
  );
}

export function ReceiptScreen() {
  const { t } = useTranslation();
  const { orderId } = useParams();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [submitted, setSubmitted] = useState<{
    commandId: string;
    orderId: string;
    receiptId: string;
  }>();

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.purchase_receipt')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const today = businessDayOf(clock.now());
  const orders = receivableOrders(refs.purchaseOrders);
  const supplierName = (id: string) =>
    refs.suppliers.get(id)?.name ?? t('purchase_receipt.supplier_unknown');
  const back = (
    <Link to={ROUTES.purchaseReceipts} className="back-link">
      {t('purchase_receipt.back')}
    </Link>
  );

  if (orderId) {
    if (submitted && submitted.orderId === orderId) {
      return (
        <section className="sale">
          {back}
          <h1>{t('nav.screens.purchase_receipt')}</h1>
          <CommandResult commandId={submitted.commandId} messages="purchase_receipt.result" />
          <ReceiptPhotoResult
            commandId={submitted.commandId}
            receiptId={submitted.receiptId}
            userId={userId}
          />
        </section>
      );
    }
    const order = orders.find((candidate) => candidate.id === orderId);
    return (
      <section className="sale">
        {back}
        <h1>
          {order
            ? t('purchase_receipt.order_title', { doc: order.doc_number })
            : t('nav.screens.purchase_receipt')}
        </h1>
        {!online ? (
          <p className="home-banner" role="status">
            {t('purchase_receipt.offline_banner')}
          </p>
        ) : null}
        {order ? (
          <>
            <p className="home-muted">{supplierName(order.supplier_id)}</p>
            <ReceiptForm
              refs={refs}
              userId={userId}
              online={online}
              order={order}
              onDone={(commandId, receiptId) =>
                setSubmitted({ commandId, orderId: order.id, receiptId })
              }
            />
          </>
        ) : (
          <p className="alert alert-error">{t('purchase_receipt.not_found')}</p>
        )}
      </section>
    );
  }

  const recent = [...refs.goodsReceipts].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  const own = ownReceipts(refs, userId);
  return (
    <section className="sale">
      <h1>{t('nav.screens.purchase_receipt')}</h1>
      <section className="sale-block" aria-labelledby="purchase-orders-title">
        <h2 id="purchase-orders-title">{t('purchase_receipt.orders_title')}</h2>
        {orders.length === 0 ? (
          <p className="home-muted">{t('purchase_receipt.no_order')}</p>
        ) : (
          <ul className="doc-list">
            {orders.map((order) => (
              <li key={order.id}>
                <Link
                  to={ROUTES.purchaseReceipt(order.id)}
                  className="doc-row"
                  aria-label={t('purchase_receipt.open', { doc: order.doc_number })}
                >
                  <span className="doc-main">
                    <strong>{order.doc_number}</strong>
                    <small>
                      {supplierName(order.supplier_id)}
                      {order.expected_delivery_date
                        ? ` · ${t('purchase_receipt.expected', {
                            date: formatBusinessDay(order.expected_delivery_date),
                          })}`
                        : ''}
                    </small>
                  </span>
                  <span className="doc-side">
                    <span className="badge badge-info">
                      {t(`purchase_receipt.order_status.${order.status}`, {
                        defaultValue: order.status,
                      })}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="sale-block" aria-labelledby="purchase-receipts-title">
        <h2 id="purchase-receipts-title">{t('purchase_receipt.recent_title')}</h2>
        {recent.length === 0 ? (
          <p className="home-muted">{t('purchase_receipt.no_receipt')}</p>
        ) : (
          <ul className="receipt-lines">
            {recent.map((receipt) => (
              <li key={receipt.id}>
                <span>
                  <strong>{receipt.doc_number}</strong>
                  <small>{supplierName(receipt.supplier_id)}</small>
                </span>
                <span>
                  {t(`purchase_receipt.status.${receipt.status}`, { defaultValue: receipt.status })}
                  <small>{formatMoment(receipt.occurred_at, today)}</small>
                </span>
                {own.has(receipt.id) ? (
                  <ReceiptPhotoBlock
                    receiptId={receipt.id}
                    userId={userId}
                    missing={own.get(receipt.id) === true}
                  />
                ) : null}
                {/* Bon de réception (lot PP). Réceptionnaire connu pour une réception de l'appareil.
                    Une réception en quarantaine ou refusée n'est pas comptabilisée : pas de bon. */}
                {receipt.status !== 'QUARANTINED' && receipt.status !== 'REJECTED' ? (
                  <PieceAction
                    cle={`BR:${receipt.id}`}
                    annulee={receipt.status === 'CANCELLED'}
                    demande={() =>
                      demandeBonReception(receipt, refs, own.has(receipt.id) ? userId : null)
                    }
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
