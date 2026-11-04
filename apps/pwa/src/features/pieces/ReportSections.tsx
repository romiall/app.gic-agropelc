/**
 * Champs propres à chaque type de pièce de l'écran de report (ECR-PIE-01 ; PP-B, REQ-303, AV-501 à
 * AV-504) : ce que le serveur exige de la commande correspondante, ni plus ni moins. Les choix viennent
 * des référentiels de l'appareil (emplacements, comptes, produits, clients, moyens de paiement…), jamais
 * de codes écrits en dur ; la résolution et les défauts sont dans `report-form.ts`.
 */
import { useTranslation } from 'react-i18next';
import {
  Banner,
  Button,
  Field,
  Input,
  Section,
  Select,
  Textarea,
} from '../../components/ui/index.js';
import { ownAccounts, sourceAccounts, targetsFor, transferPairs } from '../cash/transfers.js';
import { receivableOrders, receiptLocations } from '../procurement/receipt.js';
import { CustomerPicker } from '../sales/CustomerPicker.js';
import { formatMoney, formatQuantity, unitLabel } from '../sales/format.js';
import { PaymentFields } from '../sales/PaymentFields.js';
import type { SalesReferences } from '../sales/references.js';
import { saleUnitsOf, type DraftLine } from '../sales/sale-form.js';
import type { LocationData, ProductData } from '../sales/types.js';
import { DEVICE_LOSS_CATEGORIES, lossReasons, type LossCategory } from '../stock/loss.js';
import { destinations } from '../stock/transfer.js';
import { blankLine } from './report-lines.js';
import {
  deliverableOrders,
  locationChoices,
  previewTotal,
  slipLocations,
  slipPaymentMethod,
  type SlipContext,
  type SlipForm,
} from './report-form.js';

interface SectionProps {
  readonly form: SlipForm;
  readonly patch: (change: Partial<SlipForm>) => void;
  readonly context: SlipContext;
}

// --- Briques communes -----------------------------------------------------------------------------

function LocationField(props: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly LocationData[];
  readonly onChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Field label={props.label}>
      {(ctrl) => (
        <Select {...ctrl} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
          <option value="">{t('piece.choose_location', 'Choisir un emplacement…')}</option>
          {props.options.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function SiteField(props: {
  readonly label: string;
  readonly refs: SalesReferences;
  readonly value: string;
  readonly optional?: boolean;
  readonly onChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Field label={props.label} optional={props.optional ?? false}>
      {(ctrl) => (
        <Select {...ctrl} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
          <option value="">{t('piece.choose_site', 'Choisir un site…')}</option>
          {[...props.refs.sites.values()]
            .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
            .map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
        </Select>
      )}
    </Field>
  );
}

/** Lignes d'une pièce : produit, unité, quantité, prix inscrit (ou prix d'achat) ou poids pesé. */
function LinesEditor(props: {
  readonly lines: readonly DraftLine[];
  readonly onChange: (lines: readonly DraftLine[]) => void;
  readonly refs: SalesReferences;
  readonly products: readonly ProductData[];
  /** `sale` : unité de vente au choix ; `base` : unité de base du produit. */
  readonly units: 'sale' | 'base';
  readonly priceLabel?: string;
  readonly weighed?: boolean;
  readonly single?: boolean;
}) {
  const { t } = useTranslation();
  const { lines, onChange, refs, products } = props;
  const rows = props.single ? lines.slice(0, 1) : lines;
  const update = (key: string, change: Partial<DraftLine>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...change } : line)));
  return (
    <div className="report-fields">
      <ul className="report-lines">
        {rows.map((line) => {
          const product = products.find((entry) => entry.id === line.productId);
          const unitChoices = product && props.units === 'sale' ? saleUnitsOf(product, refs) : [];
          return (
            <li key={line.key} className="report-line">
              <div className="report-line-grid">
                <Field label={t('piece.f_product', 'Produit')}>
                  {(ctrl) => (
                    <Select
                      {...ctrl}
                      value={line.productId}
                      onChange={(e) => {
                        const next = products.find((entry) => entry.id === e.target.value);
                        update(line.key, {
                          productId: e.target.value,
                          unitCode: next?.base_unit_code ?? '',
                          weightText: '',
                        });
                      }}
                    >
                      <option value="">{t('piece.choose_product', 'Choisir un produit…')}</option>
                      {products.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                {unitChoices.length > 1 ? (
                  <Field label={t('piece.f_unit', 'Unité')}>
                    {(ctrl) => (
                      <Select
                        {...ctrl}
                        value={line.unitCode}
                        onChange={(e) => update(line.key, { unitCode: e.target.value })}
                      >
                        {unitChoices.map((unit) => (
                          <option key={unit.unitCode} value={unit.unitCode}>
                            {unitLabel(unit.unitCode)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                ) : null}
                <Field
                  label={t('piece.f_quantity', 'Quantité')}
                  unit={
                    product && props.units === 'base' ? unitLabel(product.base_unit_code) : null
                  }
                >
                  {(ctrl) => (
                    <Input
                      {...ctrl}
                      inputMode="decimal"
                      value={line.quantityText}
                      onChange={(e) => update(line.key, { quantityText: e.target.value })}
                    />
                  )}
                </Field>
                {props.weighed && product?.pricing_mode === 'PER_WEIGHT' ? (
                  <Field label={t('piece.f_weight', 'Poids pesé (kg)')}>
                    {(ctrl) => (
                      <Input
                        {...ctrl}
                        inputMode="decimal"
                        value={line.weightText}
                        onChange={(e) => update(line.key, { weightText: e.target.value })}
                      />
                    )}
                  </Field>
                ) : null}
                {props.priceLabel ? (
                  <Field label={props.priceLabel}>
                    {(ctrl) => (
                      <Input
                        {...ctrl}
                        inputMode="numeric"
                        value={line.priceText ?? ''}
                        onChange={(e) =>
                          update(line.key, {
                            priceText: e.target.value === '' ? null : e.target.value,
                          })
                        }
                      />
                    )}
                  </Field>
                ) : null}
              </div>
              {!props.single && lines.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onChange(lines.filter((entry) => entry.key !== line.key))}
                >
                  {t('piece.remove_line', 'Retirer la ligne')}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {!props.single ? (
        <Button
          type="button"
          variant="tonal"
          size="sm"
          onClick={() => onChange([...lines, blankLine()])}
        >
          {t('piece.add_line', 'Ajouter une ligne')}
        </Button>
      ) : null}
    </div>
  );
}

/** Motif de la dérogation de prix (catégorie `PRICE_OVERRIDE`), exigé si le prix inscrit diffère du catalogue. */
function OverrideReasonField({ form, patch, context }: SectionProps) {
  const { t } = useTranslation();
  const reasons = context.refs.reasonCodes.filter(
    (reason) => reason.category === 'PRICE_OVERRIDE' && reason.is_active,
  );
  return (
    <Field
      label={t('piece.override_reason', 'Motif si le prix inscrit diffère du prix catalogue')}
      optional
    >
      {(ctrl) => (
        <Select
          {...ctrl}
          value={form.overrideReasonId}
          onChange={(e) => patch({ overrideReasonId: e.target.value })}
        >
          <option value="">{t('piece.no_override', 'Aucun (prix catalogue)')}</option>
          {reasons.map((reason) => (
            <option key={reason.id} value={reason.id}>
              {reason.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

const sellable = (refs: SalesReferences, perUnitOnly = false): ProductData[] =>
  refs.products
    .filter(
      (product) =>
        product.is_sellable &&
        product.status === 'ACTIVE' &&
        (!perUnitOnly || product.pricing_mode === 'PER_UNIT'),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

const purchasable = (refs: SalesReferences): ProductData[] =>
  refs.products
    .filter((product) => product.status === 'ACTIVE' && product.is_purchasable === true)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

const physical = (refs: SalesReferences): ProductData[] =>
  refs.products
    .filter((product) => product.status === 'ACTIVE' && product.stock_family !== 'SERVICE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

// --- BV, CC, RE -----------------------------------------------------------------------------------

function SaleFields(props: SectionProps) {
  const { t } = useTranslation();
  const { form, patch, context } = props;
  const { refs, userId } = context;
  const total = previewTotal(form, context);
  return (
    <Section title={t('piece.section_bv', 'Détails du bon de vente (BV)')}>
      <div className="report-fields">
        <LocationField
          label={t('piece.f_sale_location', 'Emplacement de vente')}
          value={form.locationId}
          options={locationChoices('BV', refs, userId)}
          onChange={(locationId) => patch({ locationId })}
        />
        <CustomerPicker
          customers={refs.customers}
          value={form.customerId}
          onChange={(customerId) => patch({ customerId })}
          allowAnonymous
        />
        <LinesEditor
          lines={form.lines}
          onChange={(lines) => patch({ lines })}
          refs={refs}
          products={sellable(refs)}
          units="sale"
          priceLabel={t('piece.price_written', 'Prix unitaire inscrit (XAF)')}
          weighed
        />
        <OverrideReasonField {...props} />
        <p className="report-total">
          {t('piece.total', 'Total')} : {total === null ? '—' : formatMoney(total)}
        </p>
        <PaymentFields
          methods={refs.paymentMethods}
          accounts={refs.cashAccounts}
          method={slipPaymentMethod(refs, form.payment)}
          value={form.payment}
          amountLabel={t('piece.amount_paid', 'Montant réglé (XAF)')}
          amountPlaceholder={String(total ?? 0)}
          onChange={(payment) => patch({ payment })}
        />
        <p className="field-hint">
          {t(
            'piece.credit_hint',
            'Saisissez 0 pour une vente à crédit (un client est alors obligatoire).',
          )}
        </p>
      </div>
    </Section>
  );
}

function OrderFields(props: SectionProps) {
  const { t } = useTranslation();
  const { form, patch, context } = props;
  const { refs, userId } = context;
  const customer = form.customerId
    ? refs.customers.find((entry) => entry.id === form.customerId)
    : undefined;
  const total = previewTotal(form, context);
  const locations = locationChoices('CC', refs, userId).sort(
    (a, b) =>
      Number(b.site_id === customer?.home_site_id) - Number(a.site_id === customer?.home_site_id),
  );
  return (
    <Section title={t('piece.section_cc', 'Détails de la commande client (CC)')}>
      <div className="report-fields">
        <CustomerPicker
          customers={refs.customers}
          value={form.customerId}
          onChange={(customerId) => patch({ customerId })}
          allowAnonymous={false}
        />
        <LocationField
          label={t('piece.f_order_location', 'Emplacement de préparation')}
          value={form.locationId}
          options={locations}
          onChange={(locationId) => patch({ locationId })}
        />
        <LinesEditor
          lines={form.lines}
          onChange={(lines) => patch({ lines })}
          refs={refs}
          products={sellable(refs, true)}
          units="sale"
          priceLabel={t('piece.price_written', 'Prix unitaire inscrit (XAF)')}
        />
        <OverrideReasonField {...props} />
        <p className="report-total">
          {t('piece.total', 'Total')} : {total === null ? '—' : formatMoney(total)}
        </p>
        <div className="report-grid-2">
          <Field label={t('piece.delivery_date', 'Livraison souhaitée')} optional>
            {(ctrl) => (
              <Input
                {...ctrl}
                type="date"
                value={form.requestedDeliveryDate}
                onChange={(e) => patch({ requestedDeliveryDate: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('piece.delivery_address', 'Adresse de livraison')} optional>
            {(ctrl) => (
              <Input
                {...ctrl}
                maxLength={1000}
                value={form.deliveryAddress}
                onChange={(e) => patch({ deliveryAddress: e.target.value })}
              />
            )}
          </Field>
        </div>
      </div>
    </Section>
  );
}

function PaymentSlipFields({ form, patch, context }: SectionProps) {
  const { t } = useTranslation();
  const { refs } = context;
  const customer = form.customerId
    ? refs.customers.find((entry) => entry.id === form.customerId)
    : undefined;
  return (
    <Section title={t('piece.section_re', 'Détails du reçu d’encaissement (RE)')}>
      <div className="report-fields">
        <CustomerPicker
          customers={refs.customers}
          value={form.customerId}
          onChange={(customerId) => patch({ customerId })}
          allowAnonymous={false}
        />
        <PaymentFields
          methods={refs.paymentMethods}
          accounts={refs.cashAccounts}
          method={slipPaymentMethod(refs, form.payment)}
          value={form.payment}
          amountLabel={t('piece.amount_collected', 'Montant encaissé (XAF)')}
          amountPlaceholder=""
          onChange={(payment) => patch({ payment })}
        />
        <SiteField
          label={t('piece.collect_site', 'Site de l’encaissement')}
          refs={refs}
          value={form.siteId}
          optional={Boolean(customer?.home_site_id)}
          onChange={(siteId) => patch({ siteId })}
        />
      </div>
    </Section>
  );
}

// --- BL -------------------------------------------------------------------------------------------

function DeliveryFields({ form, patch, context }: SectionProps) {
  const { t } = useTranslation();
  const { refs } = context;
  const orders = deliverableOrders(refs);
  const order = orders.find((entry) => entry.id === form.orderId);
  return (
    <Section title={t('piece.section_bl', 'Détails du bon de livraison (BL)')}>
      <div className="report-fields">
        {orders.length === 0 ? (
          <Banner tone="info">
            {t(
              'piece.no_order',
              'Aucune commande confirmée à livrer sur cet appareil. Reportez d’abord la commande client (CC) et laissez-la se synchroniser.',
            )}
          </Banner>
        ) : null}
        <Field label={t('piece.order', 'Commande livrée')}>
          {(ctrl) => (
            <Select
              {...ctrl}
              value={form.orderId}
              onChange={(e) => patch({ orderId: e.target.value, quantities: {} })}
            >
              <option value="">{t('piece.choose_order', 'Choisir une commande…')}</option>
              {orders.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.docNumber ?? t('piece.pending_number', 'En attente de numéro')} —{' '}
                  {refs.customers.find((customer) => customer.id === entry.customerId)
                    ?.display_name ?? ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {order ? (
          <ul className="report-lines">
            {order.lines
              .filter((line) => line.id !== null && line.toDeliverBase > 0)
              .map((line) => (
                <li key={line.id} className="report-line">
                  <Field
                    label={`${line.productName} — ${t('piece.left_to_deliver', 'reste à livrer')} ${formatQuantity(line.toDeliverBase)}`}
                  >
                    {(ctrl) => (
                      <Input
                        {...ctrl}
                        inputMode="decimal"
                        value={form.quantities[line.id as string] ?? String(line.toDeliverBase)}
                        onChange={(e) =>
                          patch({
                            quantities: { ...form.quantities, [line.id as string]: e.target.value },
                          })
                        }
                      />
                    )}
                  </Field>
                </li>
              ))}
          </ul>
        ) : null}
        <div className="report-grid-2">
          <Field label={t('piece.recipient', 'Reçu par')} optional>
            {(ctrl) => (
              <Input
                {...ctrl}
                maxLength={200}
                value={form.recipient}
                onChange={(e) => patch({ recipient: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('piece.f_notes', 'Observations')} optional>
            {(ctrl) => (
              <Input
                {...ctrl}
                maxLength={2000}
                value={form.notes}
                onChange={(e) => patch({ notes: e.target.value })}
              />
            )}
          </Field>
        </div>
      </div>
    </Section>
  );
}

// --- BD, RF ---------------------------------------------------------------------------------------

function ExpenseFields({ form, patch, context }: SectionProps) {
  const { t } = useTranslation();
  const { refs, userId } = context;
  const categories = refs.expenseCategories
    .filter((category) => category.is_active && !category.is_system)
    .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  return (
    <Section title={t('piece.section_bd', 'Détails du bon de décaissement (BD)')}>
      <div className="report-fields">
        <div className="report-grid-2">
          <Field label={t('piece.category', 'Catégorie de dépense')}>
            {(ctrl) => (
              <Select
                {...ctrl}
                value={form.categoryId}
                onChange={(e) => patch({ categoryId: e.target.value })}
              >
                <option value="">{t('piece.choose_category', 'Choisir une catégorie…')}</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <SiteField
            label={t('piece.f_site', 'Site')}
            refs={refs}
            value={form.siteId}
            onChange={(siteId) => patch({ siteId })}
          />
        </div>
        <div className="report-grid-2">
          <Field label={t('piece.f_amount_out', 'Montant décaissé (XAF)')}>
            {(ctrl) => (
              <Input
                {...ctrl}
                inputMode="numeric"
                value={form.amountText}
                onChange={(e) => patch({ amountText: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('piece.paid_from', 'Compte payeur')}>
            {(ctrl) => (
              <Select
                {...ctrl}
                value={form.accountId}
                onChange={(e) => patch({ accountId: e.target.value })}
              >
                <option value="">{t('piece.choose_account', 'Choisir le compte…')}</option>
                {ownAccounts(refs.cashAccounts, userId).map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label={t('piece.f_payee', 'Bénéficiaire')} optional>
          {(ctrl) => (
            <Input
              {...ctrl}
              maxLength={120}
              value={form.payeeName}
              onChange={(e) => patch({ payeeName: e.target.value })}
            />
          )}
        </Field>
        <Field label={t('piece.f_expense_object', 'Objet de la dépense')}>
          {(ctrl) => (
            <Textarea
              {...ctrl}
              rows={2}
              maxLength={1000}
              value={form.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          )}
        </Field>
      </div>
    </Section>
  );
}

function CashTransferFields({ form, patch, context }: SectionProps) {
  const { t } = useTranslation();
  const { refs, userId, now } = context;
  const pairs = transferPairs(refs.settings, now);
  const sources = sourceAccounts(refs.cashAccounts, refs.cashTransferTargets, pairs, userId);
  const source = sources.find((account) => account.id === form.accountId);
  const targets = source ? targetsFor(source, refs.cashTransferTargets, pairs) : [];
  return (
    <Section title={t('piece.section_rf', 'Détails de la remise de fonds (RF)')}>
      <div className="report-fields">
        <div className="report-grid-2">
          <Field label={t('piece.f_source_account', 'Caisse source')}>
            {(ctrl) => (
              <Select
                {...ctrl}
                value={form.accountId}
                onChange={(e) => patch({ accountId: e.target.value, toAccountId: '' })}
              >
                <option value="">{t('piece.choose_source', 'Choisir la caisse source…')}</option>
                {sources.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('piece.destination', 'Destination')}>
            {(ctrl) => (
              <Select
                {...ctrl}
                value={form.toAccountId}
                onChange={(e) => patch({ toAccountId: e.target.value })}
              >
                <option value="">{t('piece.choose_destination', 'Choisir la destination…')}</option>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="report-grid-2">
          <Field label={t('piece.f_amount_transfer', 'Montant remis (XAF)')}>
            {(ctrl) => (
              <Input
                {...ctrl}
                inputMode="numeric"
                value={form.amountText}
                onChange={(e) => patch({ amountText: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('piece.carrier', 'Porteur de l’argent')} optional>
            {(ctrl) => (
              <Input
                {...ctrl}
                maxLength={120}
                value={form.carrierName}
                onChange={(e) => patch({ carrierName: e.target.value })}
              />
            )}
          </Field>
        </div>
        <Field label={t('piece.f_comment', 'Commentaire')} optional>
          {(ctrl) => (
            <Input
              {...ctrl}
              maxLength={500}
              value={form.notes}
              onChange={(e) => patch({ notes: e.target.value })}
            />
          )}
        </Field>
      </div>
    </Section>
  );
}

// --- BR -------------------------------------------------------------------------------------------

function ReceiptFields({ form, patch, context }: SectionProps) {
  const { t } = useTranslation();
  const { refs, userId } = context;
  const orders = receivableOrders(refs.purchaseOrders);
  const order = orders.find((entry) => entry.id === form.orderId);
  const locations = order
    ? receiptLocations(refs.locations, order)
    : slipLocations(refs, userId).filter((location) => location.site_id !== null);
  const chosen = locations.find((location) => location.id === form.locationId);
  const override = order !== undefined && chosen !== undefined && chosen.site_id !== order.site_id;
  return (
    <Section title={t('piece.section_br', 'Détails du bon de réception (BR)')}>
      <div className="report-fields">
        <Field label={t('piece.purchase_order', 'Bon de commande reçu')}>
          {(ctrl) => (
            <Select
              {...ctrl}
              value={form.orderId}
              onChange={(e) => patch({ orderId: e.target.value, quantities: {} })}
            >
              <option value="">{t('piece.no_purchase_order', 'Sans bon de commande')}</option>
              {orders.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.doc_number} — {refs.suppliers.get(entry.supplier_id)?.name ?? ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {!order ? (
          <>
            <Banner tone="info">
              {t(
                'piece.receipt_without_po',
                'Une réception sans bon de commande est mise en revue par le responsable des achats.',
              )}
            </Banner>
            <Field label={t('piece.supplier', 'Fournisseur')}>
              {(ctrl) => (
                <Select
                  {...ctrl}
                  value={form.supplierId}
                  onChange={(e) => patch({ supplierId: e.target.value })}
                >
                  <option value="">{t('piece.choose_supplier', 'Choisir un fournisseur…')}</option>
                  {[...refs.suppliers.values()]
                    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
                    .map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.name}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          </>
        ) : null}
        <LocationField
          label={t('piece.f_receipt_location', 'Emplacement de réception')}
          value={form.locationId}
          options={locations}
          onChange={(locationId) => patch({ locationId })}
        />
        {override ? (
          <Banner tone="warn">
            {t(
              'piece.receipt_override',
              'Emplacement hors du site du bon de commande : le responsable des achats devra valider la réception. Précisez le motif dans les observations (AV-096).',
            )}
          </Banner>
        ) : null}
        {order ? (
          <ul className="report-lines">
            {order.lines.map((line) => (
              <li key={line.id} className="report-line">
                <Field
                  label={`${refs.products.find((product) => product.id === line.product_id)?.name ?? ''} — ${t('piece.left_to_receive', 'reste à recevoir')} ${formatQuantity(Number(line.remaining_qty_base))}`}
                  unit={unitLabel(line.unit_code)}
                >
                  {(ctrl) => (
                    <Input
                      {...ctrl}
                      inputMode="decimal"
                      value={form.quantities[line.id] ?? ''}
                      onChange={(e) =>
                        patch({ quantities: { ...form.quantities, [line.id]: e.target.value } })
                      }
                    />
                  )}
                </Field>
              </li>
            ))}
          </ul>
        ) : (
          <LinesEditor
            lines={form.lines}
            onChange={(lines) => patch({ lines })}
            refs={refs}
            products={purchasable(refs)}
            units="base"
            priceLabel={t('piece.unit_cost', 'Prix d’achat unitaire (XAF)')}
          />
        )}
        <div className="report-grid-2">
          <Field label={t('piece.supplier_note', 'N° du bon de livraison du fournisseur')} optional>
            {(ctrl) => (
              <Input
                {...ctrl}
                maxLength={60}
                value={form.deliveryNoteRef}
                onChange={(e) => patch({ deliveryNoteRef: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('piece.f_notes', 'Observations')} optional>
            {(ctrl) => (
              <Input
                {...ctrl}
                maxLength={4000}
                value={form.notes}
                onChange={(e) => patch({ notes: e.target.value })}
              />
            )}
          </Field>
        </div>
      </div>
    </Section>
  );
}

// --- BT, FP ---------------------------------------------------------------------------------------

function StockTransferFields({ form, patch, context }: SectionProps) {
  const { t } = useTranslation();
  const { refs, userId } = context;
  const sources = slipLocations(refs, userId);
  return (
    <Section title={t('piece.section_bt', 'Détails du bon de transfert (BT)')}>
      <div className="report-fields">
        <div className="report-grid-2">
          <LocationField
            label={t('piece.from_location', 'Emplacement de départ')}
            value={form.locationId}
            options={sources}
            onChange={(locationId) => patch({ locationId, toLocationId: '' })}
          />
          <LocationField
            label={t('piece.to_location', 'Emplacement d’arrivée')}
            value={form.toLocationId}
            options={form.locationId ? destinations(refs.locations, form.locationId) : []}
            onChange={(toLocationId) => patch({ toLocationId })}
          />
        </div>
        <LinesEditor
          lines={form.lines}
          onChange={(lines) => patch({ lines })}
          refs={refs}
          products={physical(refs)}
          units="sale"
        />
        <div className="report-grid-2">
          <Field label={t('piece.carrier_name', 'Transporteur')} optional>
            {(ctrl) => (
              <Input
                {...ctrl}
                maxLength={200}
                value={form.carrierName}
                onChange={(e) => patch({ carrierName: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('piece.f_notes', 'Observations')} optional>
            {(ctrl) => (
              <Input
                {...ctrl}
                maxLength={1900}
                value={form.notes}
                onChange={(e) => patch({ notes: e.target.value })}
              />
            )}
          </Field>
        </div>
      </div>
    </Section>
  );
}

function LossFields({ form, patch, context }: SectionProps) {
  const { t } = useTranslation();
  const { refs, userId } = context;
  const reasons = form.lossCategory ? lossReasons(refs.reasonCodes, form.lossCategory) : [];
  return (
    <Section title={t('piece.section_fp', 'Détails de la fiche de perte (FP)')}>
      <div className="report-fields">
        <LocationField
          label={t('piece.f_location', 'Emplacement')}
          value={form.locationId}
          options={slipLocations(refs, userId)}
          onChange={(locationId) => patch({ locationId })}
        />
        <LinesEditor
          lines={form.lines}
          onChange={(lines) => patch({ lines })}
          refs={refs}
          products={physical(refs)}
          units="sale"
          single
        />
        <div className="report-grid-2">
          <Field label={t('loss.category_label', 'Nature de la perte')}>
            {(ctrl) => (
              <Select
                {...ctrl}
                value={form.lossCategory}
                onChange={(e) =>
                  patch({ lossCategory: e.target.value as LossCategory | '', lossReasonId: '' })
                }
              >
                <option value="">{t('piece.choose_category', 'Choisir une catégorie…')}</option>
                {DEVICE_LOSS_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {t(`loss.categories.${category}`, category)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('loss.reason_label', 'Motif')} optional>
            {(ctrl) => (
              <Select
                {...ctrl}
                value={form.lossReasonId}
                onChange={(e) => patch({ lossReasonId: e.target.value })}
              >
                <option value="">{t('piece.no_reason', 'Aucun motif précisé')}</option>
                {reasons.map((reason) => (
                  <option key={reason.id} value={reason.id}>
                    {reason.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label={t('loss.comment_label', 'Commentaire')} optional>
          {(ctrl) => (
            <Textarea
              {...ctrl}
              rows={2}
              maxLength={1900}
              value={form.notes}
              onChange={(e) => patch({ notes: e.target.value })}
            />
          )}
        </Field>
      </div>
    </Section>
  );
}

/** Champs du type de pièce choisi. */
export function SlipFields(props: SectionProps) {
  switch (props.form.slipType) {
    case 'BV':
      return <SaleFields {...props} />;
    case 'CC':
      return <OrderFields {...props} />;
    case 'RE':
      return <PaymentSlipFields {...props} />;
    case 'BL':
      return <DeliveryFields {...props} />;
    case 'BD':
      return <ExpenseFields {...props} />;
    case 'RF':
      return <CashTransferFields {...props} />;
    case 'BR':
      return <ReceiptFields {...props} />;
    case 'BT':
      return <StockTransferFields {...props} />;
    case 'FP':
      return <LossFields {...props} />;
  }
}
