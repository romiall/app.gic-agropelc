/**
 * Jeu de données de test des écrans de vente (réservé aux tests) : projections telles que les sert le
 * serveur, posées directement dans la base locale.
 */
import type { GicDatabase, Projection } from '../../storage/db.js';

export const IDS = {
  user: '01900000-0000-7000-8000-000000000001',
  zone: '01900000-0000-7000-8000-000000000010',
  site: '01900000-0000-7000-8000-000000000020',
  pos: '01900000-0000-7000-8000-000000000030',
  mobile: '01900000-0000-7000-8000-000000000031',
  eggs: '01900000-0000-7000-8000-000000000040',
  chicken: '01900000-0000-7000-8000-000000000041',
  trayUnit: '01900000-0000-7000-8000-000000000050',
  ruleEggs: '01900000-0000-7000-8000-000000000060',
  ruleChicken: '01900000-0000-7000-8000-000000000061',
  customer: '01900000-0000-7000-8000-000000000070',
  reason: '01900000-0000-7000-8000-000000000080',
  cash: '01900000-0000-7000-8000-000000000090',
  momo: '01900000-0000-7000-8000-000000000091',
} as const;

type Row = Omit<Projection, 'key' | 'seq' | 'row_version'> & { readonly key?: string };

function row(
  dataset: string,
  entityType: string,
  entityId: string,
  data: Record<string, unknown>,
  scope: { readonly type: string; readonly id: string | null } = { type: 'GLOBAL', id: null },
): Projection {
  const base: Row = {
    dataset,
    entity_type: entityType,
    entity_id: entityId,
    scope_type: scope.type,
    scope_id: scope.id,
    data,
  };
  const key =
    entityType === 'STOCK_BALANCE'
      ? `${dataset}:${entityType}:${scope.id}:${entityId}`
      : `${dataset}:${entityType}:${entityId}`;
  return { ...base, key, seq: 1, row_version: 1 };
}

export function stockRow(locationId: string, productId: string, onHand: string): Projection {
  return row(
    'stock',
    'STOCK_BALANCE',
    productId,
    {
      location_id: locationId,
      product_id: productId,
      qty_on_hand: onHand,
      qty_reserved: '0',
      qty_allocated: '0',
      lots: [],
    },
    { type: 'LOCATION', id: locationId },
  );
}

export async function seedSalesFixtures(
  db: GicDatabase,
  options: { readonly posCustody?: 'SHARED' | 'EXCLUSIVE_USER' } = {},
): Promise<void> {
  await db.projections.bulkPut([
    row('zone', 'ZONE', IDS.zone, { id: IDS.zone, parent_id: null, name: 'Centre', depth: 1 }),
    row('site', 'SITE', IDS.site, {
      id: IDS.site,
      code: 'PDV-YDE',
      name: 'PDV Yaoundé',
      site_type: 'POINT_DE_VENTE',
      zone_id: IDS.zone,
      status: 'ACTIVE',
    }),
    row('location', 'LOCATION', IDS.pos, {
      id: IDS.pos,
      site_id: IDS.site,
      code: 'PDV-YDE-POS',
      name: 'Comptoir Yaoundé',
      location_type: 'POS',
      is_virtual: false,
      custody_mode: options.posCustody ?? 'SHARED',
      custodian_user_id: options.posCustody === 'EXCLUSIVE_USER' ? IDS.user : null,
      designated_device_id: null,
      status: 'ACTIVE',
    }),
    row('product', 'PRODUCT', IDS.eggs, {
      id: IDS.eggs,
      code: 'OEUF',
      name: 'Œufs de table',
      category_id: IDS.zone,
      base_unit_code: 'U',
      is_sellable: true,
      pricing_mode: 'PER_UNIT',
      status: 'ACTIVE',
    }),
    row('product', 'PRODUCT', IDS.chicken, {
      id: IDS.chicken,
      code: 'POULET',
      name: 'Poulet de chair',
      category_id: IDS.zone,
      base_unit_code: 'U',
      is_sellable: true,
      pricing_mode: 'PER_UNIT',
      status: 'ACTIVE',
    }),
    row('product_unit', 'PRODUCT_UNIT', IDS.trayUnit, {
      id: IDS.trayUnit,
      product_id: IDS.eggs,
      unit_code: 'PLATEAU',
      factor_to_base: '30.000000',
      is_sales_unit: true,
      is_purchase_unit: false,
      is_count_unit: false,
      is_active: true,
    }),
    row('price_rule', 'PRICE_RULE', IDS.ruleEggs, {
      id: IDS.ruleEggs,
      code: 'PRX-OEUF',
      version: 1,
      product_id: IDS.eggs,
      unit_price_xaf: 100,
      pricing_unit_code: 'U',
      zone_id: null,
      site_id: null,
      customer_category_id: null,
      channel_code: null,
      min_quantity: null,
      commercial_campaign_id: null,
      priority: 0,
      specificity: 0,
      valid_from: '2026-01-01T00:00:00.000Z',
      valid_to: null,
      status: 'ACTIVE',
    }),
    row('price_rule', 'PRICE_RULE', IDS.ruleChicken, {
      id: IDS.ruleChicken,
      code: 'PRX-POULET',
      version: 1,
      product_id: IDS.chicken,
      unit_price_xaf: 3500,
      pricing_unit_code: 'U',
      zone_id: null,
      site_id: IDS.site,
      customer_category_id: null,
      channel_code: null,
      min_quantity: null,
      commercial_campaign_id: null,
      priority: 0,
      specificity: 32,
      valid_from: '2026-01-01T00:00:00.000Z',
      valid_to: null,
      status: 'ACTIVE',
    }),
    stockRow(IDS.pos, IDS.eggs, '300'),
    stockRow(IDS.pos, IDS.chicken, '4'),
    row(
      'customers',
      'CUSTOMER',
      IDS.customer,
      {
        id: IDS.customer,
        stage: 'CUSTOMER',
        display_name: 'Boutique Mvog-Mbi',
        contact_name: 'Mme Ngo',
        category_id: null,
        phone_primary: '+237 699 11 22 33',
        zone_id: IDS.zone,
        owner_user_id: IDS.user,
        home_site_id: IDS.site,
        merged_into_id: null,
        credit_allowed: true,
        credit_limit_xaf: 50000,
        payment_terms_days: 30,
        outstanding_xaf: 12000,
        version: 1,
      },
      { type: 'USER', id: IDS.user },
    ),
    row('reason_code', 'REASON_CODE', IDS.reason, {
      id: IDS.reason,
      category: 'PRICE_OVERRIDE',
      code: 'FIDELITE',
      label: 'Client fidèle',
      loss_category: null,
      requires_comment: false,
      is_active: true,
    }),
    row('catalog', 'PAYMENT_METHOD', IDS.cash, {
      id: IDS.cash,
      code: 'ESPECES',
      label: 'Espèces',
      requires_reference: false,
      default_account_type: 'CAISSE_UTILISATEUR',
      is_active: true,
      version: 1,
    }),
    row('catalog', 'PAYMENT_METHOD', IDS.momo, {
      id: IDS.momo,
      code: 'MOBILE_MONEY_ORANGE',
      label: 'Orange Money',
      requires_reference: true,
      default_account_type: 'MOBILE_MONEY',
      is_active: true,
      version: 1,
    }),
  ]);
}

/** Appareil des tests (jeton de session) et caisse du PDV. */
export const DEVICE_ID = '01900000-0000-7000-8000-0000000000d0';
export const POS_CASH_ACCOUNT = '01900000-0000-7000-8000-0000000000b0';
export const ALLOCATION_ID = '01900000-0000-7000-8000-0000000000b1';
export const CASH_SESSION_ID = '01900000-0000-7000-8000-0000000000b2';
export const CASH_TRANSFER_ID = '01900000-0000-7000-8000-0000000000b3';

/** Quota actif de l'utilisateur des tests sur cet appareil (jeu `allocations`, ligne `DEVICE`). */
export function allocationRow(overrides: Record<string, unknown> = {}): Projection {
  const data = {
    id: ALLOCATION_ID,
    location_id: IDS.pos,
    product_id: IDS.eggs,
    lot_id: null,
    holder_user_id: IDS.user,
    holder_device_id: DEVICE_ID,
    quantity_granted: '40.000',
    quantity_remaining: '40.000',
    valid_until: '2026-10-10T22:59:59.999Z',
    status: 'ACTIVE',
    revocation_pending: false,
    version: 1,
    ...overrides,
  };
  return row('allocations', 'STOCK_ALLOCATION', data.id as string, data, {
    type: 'DEVICE',
    id: data.holder_device_id as string,
  });
}

/** Caisse du PDV (jeu `cash`, ligne `SITE`). */
export function posCashAccountRow(overrides: Record<string, unknown> = {}): Projection {
  const data = {
    id: POS_CASH_ACCOUNT,
    code: 'CAISSE-PDV-YDE',
    name: 'Caisse du PDV de Yaoundé',
    account_type: 'CAISSE_PDV',
    site_id: IDS.site,
    holder_user_id: null,
    responsible_user_id: IDS.user,
    balance_xaf: 20_000,
    status: 'ACTIVE',
    version: 3,
    ...overrides,
  };
  return row('cash', 'CASH_ACCOUNT', data.id as string, data, { type: 'SITE', id: IDS.site });
}

/** Session de caisse ouverte du PDV (jeu `cash`, ligne `SITE`). */
export function cashSessionRow(overrides: Record<string, unknown> = {}): Projection {
  const data = {
    id: CASH_SESSION_ID,
    cash_account_id: POS_CASH_ACCOUNT,
    site_id: IDS.site,
    business_date: '2026-10-10',
    status: 'OPEN',
    opened_by: IDS.user,
    opened_at: '2026-10-10T06:00:00.000Z',
    opening_counted_xaf: 20_000,
    opening_expected_xaf: 20_000,
    opening_variance_xaf: 0,
    closed_by: null,
    closed_at: null,
    closing_counted_xaf: null,
    closing_expected_xaf: null,
    variance_xaf: null,
    current_expected_xaf: null,
    current_variance_xaf: null,
    force_closed: false,
    version: 1,
    ...overrides,
  };
  return row('cash', 'CASH_SESSION', data.id as string, data, { type: 'SITE', id: IDS.site });
}

/** Remise de fonds envoyée depuis la caisse du PDV (jeu `cash`). */
export function cashTransferRow(overrides: Record<string, unknown> = {}): Projection {
  const data = {
    id: CASH_TRANSFER_ID,
    doc_number: 'RMF-YDE-2026-000001',
    local_ref: null,
    from_account_id: POS_CASH_ACCOUNT,
    to_account_id: IDS.momo,
    amount_sent_xaf: 150_000,
    amount_received_xaf: null,
    status: 'SENT',
    sent_by: IDS.user,
    sent_at: '2026-10-10T17:00:00.000Z',
    carrier_user_id: null,
    carrier_name: 'Paul',
    received_at: null,
    version: 1,
    ...overrides,
  };
  return row('cash', 'CASH_TRANSFER', data.id as string, data, { type: 'SITE', id: IDS.site });
}

/** Configuration du PDV du site (jeu `org`, ligne `SITE`, clé = le site). */
export function pointOfSaleRow(overrides: Record<string, unknown> = {}): Projection {
  const data = {
    site_id: IDS.site,
    sales_location_id: IDS.pos,
    replenishment_source_location_id: null,
    custody_mode: 'SHARED',
    designated_device_id: null,
    opening_hours: null,
    version: 1,
    ...overrides,
  };
  return row('org', 'POINT_OF_SALE', data.site_id as string, data, { type: 'SITE', id: IDS.site });
}

/** Paramètre visible de l'appareil (jeu `me`, ligne `GLOBAL`, portée dans la donnée). */
export function meSettingRow(
  key: string,
  value: unknown,
  scope: { readonly type: string; readonly id: string | null } = { type: 'GLOBAL', id: null },
  validFrom = '2026-01-01T00:00:00.000Z',
): Projection {
  const id = `${key}:${scope.type}:${scope.id ?? ''}:${validFrom}`;
  return row('me', 'SETTING', id, {
    id,
    key,
    value,
    scope_type: scope.type,
    scope_id: scope.id,
    valid_from: validFrom,
  });
}

export const SALE_ID = '01900000-0000-7000-8000-0000000000a1';

/** Vente servie par le serveur (jeu `sales_recent`), payée en partie par un client identifié. */
export function saleRow(overrides: Record<string, unknown> = {}): Projection {
  return row(
    'sales_recent',
    'SALE',
    SALE_ID,
    {
      id: SALE_ID,
      doc_number: 'VTE-2026-000123',
      local_ref: null,
      sale_type: 'DIRECT',
      order_id: null,
      status: 'CONFIRMED',
      payment_status: 'PARTIALLY_PAID',
      customer_id: IDS.customer,
      site_id: IDS.site,
      from_location_id: IDS.pos,
      channel_code: 'POINT_DE_VENTE',
      seller_user_id: IDS.user,
      commercial_user_id: null,
      total_xaf: 7000,
      discount_total_xaf: 0,
      cancelled_xaf: 0,
      net_total_xaf: 7000,
      amount_paid_xaf: 5000,
      balance_due_xaf: 2000,
      due_date: '2026-11-09',
      flags: [],
      captured_offline: false,
      occurred_at: '2026-10-10T08:50:00.000Z',
      version: 1,
      lines: [
        {
          id: '01900000-0000-7000-8000-0000000000b1',
          line_no: 1,
          order_line_id: null,
          product_id: IDS.chicken,
          product_name: 'Poulet de chair',
          quantity: 2,
          unit_code: 'U',
          quantity_base: 2,
          unit_price_xaf: 3500,
          discount_xaf: 0,
          line_total_xaf: 7000,
          cancelled_quantity_base: 0,
          cancelled_xaf: 0,
          delivered_quantity_base: 2,
        },
      ],
      payments: [],
      ...overrides,
    },
    { type: 'USER', id: IDS.user },
  );
}

export const ORDER_ID = '01900000-0000-7000-8000-0000000000e1';
export const ORDER_LINE_ID = '01900000-0000-7000-8000-0000000000e2';

/** Commande confirmée (jeu `orders`) : 10 commandés, 6 vendus, 2 livrés ; acompte versé. */
export function orderRow(overrides: Record<string, unknown> = {}): Projection {
  return row(
    'orders',
    'SALES_ORDER',
    ORDER_ID,
    {
      id: ORDER_ID,
      doc_number: 'CMD-2026-000045',
      local_ref: null,
      status: 'PARTIALLY_FULFILLED',
      site_id: IDS.site,
      customer_id: IDS.customer,
      commercial_user_id: IDS.user,
      created_by: IDS.user,
      channel_code: 'SEDENTAIRE',
      fulfilment_location_id: IDS.pos,
      requested_delivery_date: '2026-10-12',
      delivery_address: 'Marché Mvog-Mbi',
      total_estimated_xaf: 35000,
      advance_paid_xaf: 5000,
      occurred_at: '2026-10-09T10:00:00.000Z',
      version: 3,
      lines: [
        {
          id: ORDER_LINE_ID,
          line_no: 1,
          product_id: IDS.chicken,
          product_name: 'Poulet de chair',
          quantity: 10,
          unit_code: 'U',
          quantity_base: 10,
          withdrawn_quantity_base: 0,
          sold_quantity_base: 6,
          delivered_quantity_base: 2,
          quoted_unit_price_xaf: 3500,
          line_total_xaf: 35000,
        },
      ],
      ...overrides,
    },
    { type: 'USER', id: IDS.user },
  );
}
