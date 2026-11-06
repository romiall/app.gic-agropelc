/**
 * ECR-APP-04, réception SANS bon de commande (UC-APP-07 ; BR-APP-011, AV-519) : le magasinier ou le
 * responsable de ferme choisit le fournisseur, l'emplacement et les produits achetables, et déclare le
 * prix unitaire de chaque ligne (exigé sans bon). Même commande que sur un bon de commande
 * (`procurement.receipt.record`, agrégat `GOODS_RECEIPT`), sans `purchaseOrderId` : le serveur la
 * comptabilise et la soumet à la revue du responsable des achats. L'accepté entre aussitôt au disponible
 * local, sauf un bon de livraison déjà reçu (quarantaine, BR-APP-012). Utilisable hors ligne.
 */
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActionBar,
  Banner,
  Button,
  Field,
  Input,
  Select,
  Textarea,
} from '../../components/ui/index.js';
import { formatQuantity, unitLabel } from '../sales/format.js';
import type { SalesReferences } from '../sales/references.js';
import { submitCommand } from '../sales/submit.js';
import { photoAttachment } from '../attachments/attachments.js';
import type { PreparedPhoto } from '../attachments/photo.js';
import { PhotoField } from '../attachments/PhotoField.js';
import {
  checkFreeLine,
  emptyFreeLine,
  freeReceiptLocations,
  freeReceiptPayload,
  freeReceiptSuppliers,
  type FreeLineDraft,
} from './free-receipt.js';
import {
  duplicateDeliveryNote,
  MAX_DELIVERY_NOTE_REF,
  MAX_LOT_REF,
  MAX_OBSERVATIONS,
  RECEIPT_PHOTO,
  receiptSettings,
} from './receipt.js';
import { purchasableProducts } from './request.js';
import { clock } from '../../platform/composition.js';
import { expenseSites } from '../finance/expense.js';
import { formatMoney } from '../sales/format.js';

/** Au plus autant de lignes que le serveur en accepte (`lines.max(200)`). */
const MAX_LINES = 200;

export function FreeReceiptForm({
  refs,
  userId,
  onDone,
}: {
  readonly refs: SalesReferences;
  readonly userId: string;
  readonly onDone: (commandId: string, receiptId: string) => void;
}) {
  const { t } = useTranslation();
  const [supplierId, setSupplierId] = useState('');
  const [locationId, setLocationId] = useState('');
  const keys = useRef(1);
  const [drafts, setDrafts] = useState<readonly FreeLineDraft[]>(() => [emptyFreeLine('1')]);
  const [deliveryNote, setDeliveryNote] = useState('');
  const [observations, setObservations] = useState('');
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const observationsErrorId = useId();

  const { photoThresholdXaf } = receiptSettings(refs.settings, clock.now());
  const suppliers = freeReceiptSuppliers(refs.suppliers);
  // Emplacements des seuls sites de l'utilisateur, d'après ses affectations (comme les sites d'une dépense, AV-301).
  const mySites = new Set(
    expenseSites({
      assignments: refs.roleAssignments,
      userId,
      sites: refs.sites,
      zones: refs.zones,
      now: clock.now(),
    }).map((site) => site.id),
  );
  const locations = freeReceiptLocations(refs.locations, mySites);
  const catalog = purchasableProducts(refs.products);
  const productById = new Map(refs.products.map((product) => [product.id, product]));
  const reasons = refs.reasonCodes.filter((reason) => reason.category === 'REJECTION');
  const rows = drafts.map((draft) => ({
    draft,
    product: productById.get(draft.productId),
    check: checkFreeLine(draft),
  }));
  const delivered = rows.filter((row) => row.check.delivered !== null);
  const duplicateNote =
    supplierId !== '' &&
    duplicateDeliveryNote(
      supplierId,
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
  const commentMissing = commentRequired && observations.trim() === '';
  const ready =
    supplierId !== '' &&
    locationId !== '' &&
    delivered.length > 0 &&
    rows.every((row) => row.check.issues.length === 0) &&
    !commentMissing &&
    !preparing &&
    !busy;

  const update = (key: string, patch: Partial<FreeLineDraft>) =>
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
    );
  const add = () => {
    keys.current += 1;
    const key = String(keys.current);
    setDrafts((current) =>
      current.length >= MAX_LINES ? current : [...current, emptyFreeLine(key)],
    );
  };
  const remove = (key: string) =>
    setDrafts((current) =>
      current.length > 1 ? current.filter((draft) => draft.key !== key) : current,
    );

  const submit = async () => {
    if (!ready) return;
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
        // Bon de livraison déjà reçu : quarantaine prévisible, rien n'entre au disponible local.
        ...(duplicateNote ? { localFlags: ['EXPECTED_QUARANTINE'] } : {}),
        payload: freeReceiptPayload({
          supplierId,
          locationId,
          deliveryNoteRef: deliveryNote,
          observations,
          lines: rows.flatMap((row) =>
            row.product ? [{ product: row.product, draft: row.draft, check: row.check }] : [],
          ),
        }),
      });
      onDone(command.command_id, command.aggregate_id);
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  if (suppliers.length === 0) {
    return <Banner tone="bad">{t('purchase_receipt.free_no_supplier')}</Banner>;
  }
  if (locations.length === 0) {
    return <Banner tone="bad">{t('purchase_receipt.free_no_location')}</Banner>;
  }
  if (catalog.length === 0) {
    return <Banner tone="bad">{t('purchase_receipt.free_no_product')}</Banner>;
  }

  return (
    <div className="proc-form">
      <Banner tone="info" role="status">
        {t('purchase_receipt.free_review_notice')}
      </Banner>
      <Field label={t('purchase_receipt.supplier_label')}>
        {(control) => (
          <Select
            {...control}
            value={supplierId}
            onChange={(event) => setSupplierId(event.target.value)}
          >
            <option value="">{t('purchase_receipt.supplier_placeholder')}</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('purchase_receipt.location_label')}>
        {(control) => (
          <Select
            {...control}
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
          >
            <option value="">{t('purchase_receipt.location_placeholder')}</option>
            {locations.map((candidate) => {
              // Deux sites peuvent avoir un emplacement de même nom : le site est dit à côté.
              const siteName = candidate.site_id
                ? refs.sites.get(candidate.site_id)?.name
                : undefined;
              return (
                <option key={candidate.id} value={candidate.id}>
                  {siteName ? `${candidate.name} — ${siteName}` : candidate.name}
                </option>
              );
            })}
          </Select>
        )}
      </Field>
      <Field
        label={t('purchase_receipt.delivery_note_label')}
        hint={t('purchase_receipt.delivery_note_hint')}
      >
        {(control) => (
          <Input
            {...control}
            maxLength={MAX_DELIVERY_NOTE_REF}
            value={deliveryNote}
            onChange={(event) => setDeliveryNote(event.target.value)}
          />
        )}
      </Field>
      {duplicateNote ? (
        <Banner tone="warn" role="status">
          {t('purchase_receipt.duplicate_note')}
        </Banner>
      ) : null}

      <ul className="line-list">
        {rows.map(({ draft, product, check }, index) => {
          const name = t('purchase_receipt.free_line_n', { n: index + 1 });
          const unit = product
            ? unitLabel(product.base_unit_code)
            : t('purchase_receipt.free_unit_unknown');
          const tracked = product !== undefined && product.lot_tracking !== 'NONE';
          return (
            <li key={draft.key} className="line-card" aria-label={name}>
              <div className="proc-line">
                <div className="line-head">
                  <strong>{product?.name ?? name}</strong>
                  {drafts.length > 1 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('purchase_receipt.free_remove_line', { n: index + 1 })}
                      onClick={() => remove(draft.key)}
                    >
                      {t('purchase_receipt.free_remove')}
                    </Button>
                  ) : null}
                </div>
                <Field label={t('purchase_receipt.free_product_label')}>
                  {(control) => (
                    <Select
                      {...control}
                      value={draft.productId}
                      onChange={(event) => update(draft.key, { productId: event.target.value })}
                    >
                      <option value="">{t('purchase_receipt.free_product_placeholder')}</option>
                      {catalog.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <div className="line-fields">
                  <Field label={t('purchase_receipt.delivered_label', { unit })}>
                    {(control) => (
                      <Input
                        {...control}
                        inputMode="decimal"
                        value={draft.deliveredText}
                        onChange={(event) =>
                          update(draft.key, { deliveredText: event.target.value })
                        }
                      />
                    )}
                  </Field>
                  <Field label={t('purchase_receipt.rejected_label', { unit })}>
                    {(control) => (
                      <Input
                        {...control}
                        inputMode="decimal"
                        value={draft.rejectedText}
                        onChange={(event) =>
                          update(draft.key, { rejectedText: event.target.value })
                        }
                      />
                    )}
                  </Field>
                </div>
                {check.delivered !== null && !check.issues.includes('QUANTITY_INVALID') ? (
                  <p className="muted">
                    {t('purchase_receipt.accepted', {
                      quantity: formatQuantity(check.accepted),
                      unit: product ? unitLabel(product.base_unit_code, check.accepted) : unit,
                    })}
                  </p>
                ) : null}
                {check.rejected > 0 ? (
                  reasons.length === 0 ? (
                    <p className="field-error">{t('purchase_receipt.no_reason')}</p>
                  ) : (
                    <Field label={t('purchase_receipt.reason_label')}>
                      {(control) => (
                        <Select
                          {...control}
                          value={draft.reasonId}
                          onChange={(event) => update(draft.key, { reasonId: event.target.value })}
                        >
                          <option value="">{t('purchase_receipt.reason_placeholder')}</option>
                          {reasons.map((reason) => (
                            <option key={reason.id} value={reason.id}>
                              {reason.label}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  )
                ) : null}
                <Field label={t('purchase_receipt.free_unit_cost_label', { unit })}>
                  {(control) => (
                    <Input
                      {...control}
                      inputMode="numeric"
                      value={draft.unitCostText}
                      onChange={(event) => update(draft.key, { unitCostText: event.target.value })}
                    />
                  )}
                </Field>
                {check.unitCostXaf !== null && check.delivered !== null ? (
                  <p className="muted">
                    {t('purchase_receipt.free_line_value', {
                      amount: formatMoney(check.unitCostXaf * check.accepted),
                    })}
                  </p>
                ) : null}
                {tracked ? (
                  <div className="line-fields">
                    <Field label={t('purchase_receipt.lot_label')}>
                      {(control) => (
                        <Input
                          {...control}
                          maxLength={MAX_LOT_REF}
                          value={draft.lotRef}
                          onChange={(event) => update(draft.key, { lotRef: event.target.value })}
                        />
                      )}
                    </Field>
                    <Field label={t('purchase_receipt.expiry_label')}>
                      {(control) => (
                        <Input
                          {...control}
                          type="date"
                          value={draft.expiryDate}
                          onChange={(event) =>
                            update(draft.key, { expiryDate: event.target.value })
                          }
                        />
                      )}
                    </Field>
                  </div>
                ) : null}
                {check.issues.map((issue) => (
                  <p key={issue} className="field-error">
                    {t(`purchase_receipt.issue.${issue}`)}
                  </p>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      <Button variant="outline" disabled={drafts.length >= MAX_LINES} onClick={add}>
        {t('purchase_receipt.free_add_line')}
      </Button>

      <Field
        label={
          commentRequired
            ? t('purchase_receipt.observations_required_label')
            : t('purchase_receipt.observations_label')
        }
      >
        {(control) => (
          <Textarea
            {...control}
            rows={2}
            maxLength={MAX_OBSERVATIONS}
            value={observations}
            aria-required={commentRequired}
            aria-invalid={commentMissing}
            aria-describedby={commentMissing ? observationsErrorId : undefined}
            onChange={(event) => setObservations(event.target.value)}
          />
        )}
      </Field>
      {commentMissing ? (
        <p id={observationsErrorId} className="field-error">
          {t('purchase_receipt.comment_required')}
        </p>
      ) : null}
      <PhotoField
        label={t('photo.receipt_label')}
        hint={t('photo.receipt_hint', { threshold: formatMoney(photoThresholdXaf) })}
        value={photo}
        onChange={setPhoto}
        onBusyChange={setPreparing}
      />
      {saveError ? <Banner tone="bad">{t('sales.error_local_save')}</Banner> : null}
      <ActionBar>
        <Button
          size="lg"
          className="submit-sale"
          disabled={!ready}
          loading={busy}
          onClick={() => void submit()}
        >
          {busy ? t('sales.submitting') : t('purchase_receipt.submit')}
        </Button>
      </ActionBar>
    </div>
  );
}
