/**
 * Catalogue des paramètres système (`organization.system_settings`, BR-ADM-015 ; RP-1, ECR-ADM-07, AV-490) :
 * pour chaque clé semée, la forme de sa valeur (entier, nombre, oui/non, choix, liste, jours de la semaine,
 * objet), son unité, ses bornes et la possibilité de la surcharger pour un site. L'écran des paramètres s'en
 * sert pour grouper, libeller et contrôler la saisie ; `validateSettingValue` est pur et sans entrée-sortie,
 * donc utilisable à l'identique sur l'appareil et sur le serveur (ADR-021).
 *
 * Source de vérité des clés et de leurs défauts : `db/seeds/system-settings.ts` (un essai du serveur vérifie
 * que chaque clé semée figure ici). Les libellés français sont côté PWA (`settings.label.<clé, points en _>`).
 * Une clé hors catalogue reste lisible et modifiable comme un objet JSON (écran : « Autres »).
 */

import {
  COMPANY_IDENTITY_MAX_LENGTH,
  COMPANY_IDENTITY_SETTINGS,
  COMPANY_VAT_MENTION_MAX_LENGTH,
  COMPANY_VAT_MENTION_SETTING,
  COMPANY_VAT_REGIMES,
  COMPANY_VAT_REGIME_SETTING,
  type CompanyIdentityField,
} from './company-identity.js';

export type SettingKind =
  'int' | 'number' | 'bool' | 'text' | 'choice' | 'list' | 'weekdays' | 'json';

export type SettingUnit =
  'xaf' | 'pct' | 'hours' | 'days' | 'minutes' | 'seconds' | 'ms' | 'm' | 'kmh' | 'heads' | 'rows';

/** Domaines de l'écran : sept métiers, la société (en-tête des pièces) puis les réglages techniques. */
export type SettingGroup =
  | 'sales'
  | 'finance'
  | 'procurement'
  | 'inventory'
  | 'production'
  | 'field'
  | 'control'
  | 'company'
  | 'technical';

export const SETTING_GROUPS: readonly SettingGroup[] = [
  'sales',
  'finance',
  'procurement',
  'inventory',
  'production',
  'field',
  'control',
  'company',
  'technical',
];

export interface SettingDef {
  readonly kind: SettingKind;
  readonly group: SettingGroup;
  readonly unit?: SettingUnit;
  readonly min?: number;
  readonly max?: number;
  /** Longueur maximale d'un `text`, en caractères (place disponible sur la pièce imprimée). */
  readonly maxLength?: number;
  /** Valeurs admises d'un `choice`. */
  readonly options?: readonly string[];
  /** Le serveur lit ce réglage « du site, à défaut global » : une version propre à un site a un effet. */
  readonly site?: true;
}

const int = (group: SettingGroup, min: number, extra: Partial<SettingDef> = {}): SettingDef => ({
  kind: 'int',
  group,
  min,
  ...extra,
});

const pct = (group: SettingGroup, extra: Partial<SettingDef> = {}): SettingDef => ({
  kind: 'number',
  group,
  unit: 'pct',
  min: 0,
  max: 100,
  ...extra,
});

const xaf = (group: SettingGroup, extra: Partial<SettingDef> = {}): SettingDef =>
  int(group, 0, { unit: 'xaf', ...extra });

const hours = (group: SettingGroup, min = 1, extra: Partial<SettingDef> = {}): SettingDef =>
  int(group, min, { unit: 'hours', ...extra });

const days = (group: SettingGroup, min = 1, extra: Partial<SettingDef> = {}): SettingDef =>
  int(group, min, { unit: 'days', ...extra });

const minutes = (group: SettingGroup, min = 0, extra: Partial<SettingDef> = {}): SettingDef =>
  int(group, min, { unit: 'minutes', ...extra });

const seconds = (group: SettingGroup, min = 0, extra: Partial<SettingDef> = {}): SettingDef =>
  int(group, min, { unit: 'seconds', ...extra });

const list = (group: SettingGroup): SettingDef => ({ kind: 'list', group });
const flag = (group: SettingGroup, extra: Partial<SettingDef> = {}): SettingDef => ({
  kind: 'bool',
  group,
  ...extra,
});
const text = (group: SettingGroup, maxLength?: number): SettingDef => ({
  kind: 'text',
  group,
  ...(maxLength !== undefined ? { maxLength } : {}),
});
const choice = (
  group: SettingGroup,
  options: readonly string[],
  extra: Partial<SettingDef> = {},
): SettingDef => ({ kind: 'choice', group, options, ...extra });
const weekdays = (group: SettingGroup): SettingDef => ({ kind: 'weekdays', group });
const json = (group: SettingGroup): SettingDef => ({ kind: 'json', group });

/** Préfixe des plafonds de remise par rôle : `pricing.max_discount_pct.<RÔLE>` (AV-026). */
export const DISCOUNT_SETTING_PREFIX = 'pricing.max_discount_pct.';

export const SETTING_CATALOG: Readonly<Record<string, SettingDef>> = {
  // Ventes, clients et prix
  'crm.inactive_after_days': days('sales'),
  'crm.visit.max_distance_m': int('sales', 0, { unit: 'm' }),
  'crm.phone_default_country_code': int('sales', 1, { max: 999 }),
  'crm.commercial_role_codes': list('sales'),
  'sales.direct_cancel_minutes': minutes('sales'),
  'sales.default_payment_terms_days': days('sales', 0),
  // AV-511 : exiger la vente payée en entier avant de livrer une commande (vrai par défaut). Une commande
  // elle-même n'est jamais conditionnée par l'argent.
  'sales.delivery_requires_full_payment': flag('sales', { site: true }),
  // AV-512 : livrer à crédit un client autorisé au crédit, dans son plafond (vrai par défaut) ; faux, tout client
  // paie d'abord.
  'sales.delivery_on_credit_allowed': flag('sales', { site: true }),
  'sales.receivables_delivered_only': flag('sales'),
  'sales.duplicate_payment_window_minutes': minutes('sales'),
  'sales.offline_over_allocation_allowed': flag('sales', { site: true }),
  'sales.offline_unallocated_sale_signal': choice('sales', ['WHEN_ALLOCATED', 'ALWAYS', 'NEVER'], {
    site: true,
  }),
  'sales.undelivered_alert_days': days('sales'),
  'sales.high_loss_alert_sales_pct': pct('sales', { site: true }),
  'sales.commercial_working_days': weekdays('sales'),
  'sales.inactive_commercial_role_codes': list('sales'),
  'pricing.stale_rules_hours': hours('sales'),
  // Caisse et finance
  'finance.cash_holding_max_xaf': xaf('finance'),
  'finance.cash_sessions_per_day_max': int('finance', 0, { site: true }),
  // AV-509 : exiger une caisse ouverte pour encaisser des espèces au PDV (faux par défaut).
  'finance.cash_session_required': flag('finance', { site: true }),
  // AV-510 : exiger une caisse ouverte pour payer une dépense ou un fournisseur en espèces depuis la caisse
  // d'un PDV (vrai par défaut : la décision d'AV-509 ne vaut que pour les ventes).
  'finance.cash_session_required_for_payouts': flag('finance', { site: true }),
  'finance.cash_session_force_close_hours': hours('finance', 1, { site: true }),
  'finance.cash_variance_critical_xaf': xaf('finance', { site: true }),
  'finance.cash_variance_tolerance_xaf': xaf('finance', { site: true }),
  'finance.cash_transfer_unreceived_hours': hours('finance'),
  'finance.cash_holding_max_days': days('finance'),
  'finance.cash_transfer_allowed_pairs': json('finance'),
  'finance.cash_transfer_series_code': text('finance'),
  'finance.supplier_payment_approval_xaf': xaf('finance'),
  'finance.expense_approval_threshold_xaf': xaf('finance'),
  'finance.expense_photo_threshold_xaf': xaf('finance'),
  'finance.pos_expense_max_xaf': xaf('finance'),
  'finance.invoice_match_qty_tolerance_pct': pct('finance'),
  'finance.invoice_match_price_tolerance_xaf': xaf('finance'),
  'finance.invoice_without_po_mode': choice('finance', ['REVIEW', 'APPROVE']),
  'finance.supplier_advance_allowed': flag('finance'),
  'finance.supplier_series_code': text('finance'),
  // Achats
  'procurement.po_approval_threshold_xaf': xaf('procurement'),
  'procurement.receipt_over_tolerance_pct': pct('procurement'),
  'procurement.offline_over_receipt_mode': choice('procurement', [
    'QUARANTINE',
    'APPLY_WITH_REVIEW',
  ]),
  'procurement.receipt_photo_threshold_xaf': xaf('procurement'),
  'procurement.receipt_incomplete_alert_days': days('procurement'),
  // Stock
  'inventory.count_approval_threshold_xaf': xaf('inventory'),
  'inventory.transfer_unmatched_hours': hours('inventory', 1, { site: true }),
  'inventory.blind_receipt_match_mode': choice('inventory', ['SUBSET', 'EXACT'], { site: true }),
  'inventory.high_loss_alert_xaf': xaf('inventory', { site: true }),
  'inventory.transfer_not_received_hours': hours('inventory', 1, { site: true }),
  'inventory.lot_expiring_days': days('inventory'),
  'inventory.replenish_alert_scope': choice('inventory', ['BELOW_TARGET', 'BELOW_MINIMUM']),
  // Production
  'production.egg_grade_product_codes': list('production'),
  'production.hatching_egg_product_code': text('production'),
  'production.egg_shelf_life_days': days('production', 0),
  'production.slaughter_shelf_life_days': days('production', 0),
  'production.incubation_durations': json('production'),
  'production.slaughterable_lot_types': list('production'),
  'production.high_mortality_alert_pct': pct('production', { site: true }),
  'production.high_mortality_alert_heads': int('production', 0, { unit: 'heads', site: true }),
  'production.daily_entry_working_days': weekdays('production'),
  'production.standard_cost_alert_lookback_days': days('production'),
  // Terrain et hors ligne
  'fieldwork.geofence_radius_m': int('field', 50, { unit: 'm', max: 5000 }),
  'fieldwork.max_gps_accuracy_m': { kind: 'number', group: 'field', unit: 'm', min: 1 },
  'fieldwork.override_min_attempts': int('field', 1),
  'fieldwork.override_min_minutes': minutes('field'),
  'fieldwork.suspicion_max_speed_kmh': { kind: 'number', group: 'field', unit: 'kmh', min: 1 },
  'fieldwork.suspicion_repeated_accuracy_count': int('field', 1),
  'offline.max_autonomy_hours': hours('field'),
  'offline.warning_hours': hours('field', 0),
  // Validations et contrôles
  'sync.backdate_max_hours': hours('control', 0),
  'sync.justification_after_hours': hours('control', 0),
  'approvals.pending_long_hours': hours('control'),
  'attachments.missing_alert_days': days('control'),
  'attachments.missing_alert_horizon_days': days('control'),
  'audit.finance_entity_types': list('control'),
  // Réglages techniques : synchronisation, plateforme, communication, analyse
  'sync.clock_skew_flag_minutes': minutes('technical', 1),
  'sync.occurred_at_future_tolerance_minutes': minutes('technical'),
  'sync.retry_hold_minutes': minutes('technical'),
  'sync.pull_settle_seconds': seconds('technical'),
  'sync.pull_record_grain_seconds': seconds('technical'),
  'sync.stale_hours': hours('technical'),
  'sync.error_alert_window_hours': hours('technical'),
  'sync.error_alert_excluded_codes': list('technical'),
  'sync.stale_horizon_days': days('technical', 0),
  'sync.seq_gap_alert_hours': hours('technical'),
  'platform.job_lag_alert_seconds': seconds('technical', 1),
  'platform.failed_jobs_window_hours': hours('technical'),
  'identity.device_bound_to_enroller': flag('control'),
  'platform.job_retention_days': days('technical'),
  'platform.consumer_failure_retention_days': days('technical'),
  'sync.change_feed_retention_days': days('technical'),
  'communication.push_group_minutes': minutes('technical'),
  'communication.consumer_lag_alert_seconds': seconds('technical', 1),
  'communication.consumer_failure_window_hours': hours('technical'),
  'communication.direct_notification_disabled_types': list('technical'),
  'communication.alert_retention_days': days('technical'),
  'communication.notification_retention_days': days('technical'),
  'analytics.freshness_warning_hours': hours('technical'),
  'analytics.dashboard_max_period_days': days('technical'),
  'analytics.query_max_rows': int('technical', 1, { unit: 'rows' }),
  'analytics.query_max_execution_ms': int('technical', 1, { unit: 'ms' }),
  'analytics.query_max_period_days': days('technical'),
  'analytics.query_max_concurrent_per_user': int('technical', 1),
  'analytics.query_max_concurrent_global': int('technical', 0),
  'analytics.scope_max_candidates': int('technical', 1),
  'analytics.pending_approvals_count_cap': int('technical', 1),
  'analytics.snapshot_active_days': days('technical'),
  'analytics.snapshot_batch_size': int('technical', 1),
  'analytics.snapshot_time_budget_seconds': seconds('technical', 1),
  'analytics.export_max_rows': int('technical', 1, { unit: 'rows' }),
  'analytics.export_max_seconds': seconds('technical', 1),
  'analytics.export_file_hours': hours('technical'),
  'analytics.export_max_pending_per_user': int('technical', 1),
  'analytics.export_file_retention_days': days('technical'),
  'analytics.query_log_retention_days': days('technical'),
  'analytics.export_abandon_hours': hours('technical'),
  'analytics.export_download_revalidate_rights': flag('technical'),
  // Société (AV-324 (a), AV-451 (c)) : identité imprimée sur les pièces papier ; texte libre, vide permis (la
  // rubrique s'imprime alors en pointillés, à compléter à la main).
  // Chaque rubrique a une longueur maximale : la place de l'en-tête est fixe.
  ...Object.fromEntries(
    (Object.entries(COMPANY_IDENTITY_SETTINGS) as [CompanyIdentityField, string][]).map(
      ([field, key]) => [key, text('company', COMPANY_IDENTITY_MAX_LENGTH[field])],
    ),
  ),
  [COMPANY_VAT_REGIME_SETTING]: choice('company', COMPANY_VAT_REGIMES),
  [COMPANY_VAT_MENTION_SETTING]: text('company', COMPANY_VAT_MENTION_MAX_LENGTH),
};

/** Plafond de remise d'un rôle : pourcentage de 0 à 100. */
const DISCOUNT_DEF: SettingDef = pct('sales');

/** Définition d'une clé, ou `undefined` hors catalogue (écran : « Autres », valeur JSON). */
export function settingDefOf(key: string): SettingDef | undefined {
  if (key.startsWith(DISCOUNT_SETTING_PREFIX) && key.length > DISCOUNT_SETTING_PREFIX.length) {
    return DISCOUNT_DEF;
  }
  return SETTING_CATALOG[key];
}

/** Jours de la semaine d'un réglage `weekdays` : numéros ISO en texte, 1 = lundi. */
export const WEEKDAY_VALUES: readonly string[] = ['1', '2', '3', '4', '5', '6', '7'];

export type SettingProblem =
  | 'TYPE'
  | 'NOT_INTEGER'
  | 'MIN'
  | 'MAX'
  | 'LENGTH'
  | 'OPTION'
  | 'EMPTY_ITEM'
  | 'WEEKDAY'
  | 'JSON_OBJECT';

/**
 * Contrôle d'une valeur typée contre la définition de sa clé ; `null` : valide. La valeur est celle qui sera
 * écrite (nombre, booléen, texte, liste de textes, objet), jamais le texte saisi.
 */
export function validateSettingValue(def: SettingDef, value: unknown): SettingProblem | null {
  switch (def.kind) {
    case 'int':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'TYPE';
      if (def.kind === 'int' && !Number.isInteger(value)) return 'NOT_INTEGER';
      if (def.min !== undefined && value < def.min) return 'MIN';
      if (def.max !== undefined && value > def.max) return 'MAX';
      return null;
    }
    case 'bool':
      return typeof value === 'boolean' ? null : 'TYPE';
    case 'text':
      if (typeof value !== 'string') return 'TYPE';
      return def.maxLength !== undefined && value.length > def.maxLength ? 'LENGTH' : null;
    case 'choice':
      return typeof value === 'string' && (def.options ?? []).includes(value) ? null : 'OPTION';
    case 'list': {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return 'TYPE';
      return value.some((item: string) => item.trim() === '') ? 'EMPTY_ITEM' : null;
    }
    case 'weekdays': {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return 'TYPE';
      return value.every((item: string) => WEEKDAY_VALUES.includes(item)) ? null : 'WEEKDAY';
    }
    case 'json':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? null
        : 'JSON_OBJECT';
  }
}
