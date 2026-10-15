/**
 * Catalogue déclaratif des alertes (P9 ; D13 §7.1 ; ADR-071, ADR-072 ; AV-400 à AV-412, AV-438 à AV-442).
 *
 * Une seule définition par type, exécutée à l'identique par le consommateur `communication.alerts`, par
 * les détecteurs des modules propriétaires (qui y lisent les noms d'événements et les champs attendus)
 * et par les tests : gravité, nature (état ou événement), module détecteur, sujet, déclencheurs,
 * résolveurs, destinataires, champs protégés (valeurs au coût, RC-05) et gabarit du message.
 *
 * Aucune entrée-sortie : les fonctions de traitement d'un événement sont dans `alert-processing.ts`, la
 * livraison (canaux, regroupement, escalade) dans `alert-delivery.ts`.
 */

export const ALERT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/** Statuts d'une alerte ouverte (portée de l'unicité INV-NOT-01 : une alerte ouverte par type et sujet). */
export const OPEN_ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED'] as const;

/**
 * Nature : `STATE` (stock faible, créance échue : la condition dure et disparaît) ou `EVENT` (perte
 * anormale, doublon suspect : un fait ponctuel, traité à la main). BR-NOT-003.
 */
export const ALERT_NATURES = ['STATE', 'EVENT'] as const;
export type AlertNature = (typeof ALERT_NATURES)[number];

/** `AUTO` : le système résout quand la condition disparaît ; `MANUAL` : un destinataire résout. */
export const ALERT_RESOLUTION_MODES = ['AUTO', 'MANUAL'] as const;
export type AlertResolutionMode = (typeof ALERT_RESOLUTION_MODES)[number];

/** Module qui porte la donnée et publie l'événement (ADR-071 §2 : le placement suit le graphe). */
export const ALERT_DETECTOR_MODULES = [
  'sales',
  'finance',
  'inventory',
  'production',
  'procurement',
  'approvals',
  'crm',
  'fieldwork',
  'sync',
  'audit',
  'communication',
  'integrations',
] as const;
export type AlertDetectorModule = (typeof ALERT_DETECTOR_MODULES)[number];

/** Types d'alerte : les 30 de D13 §7.1 puis les 6 ajoutés par AV-402. */
export const ALERT_TYPES = [
  'STOCK_LOW',
  'STOCK_OUT',
  'POS_REPLENISH',
  'STOCK_NEGATIVE',
  'HIGH_LOSS',
  'HIGH_MORTALITY',
  'DAILY_ENTRY_MISSING',
  'STANDARD_COST_MISSING',
  'RECEIPT_INCOMPLETE',
  'INVENTORY_VARIANCE',
  'OVERDUE_RECEIVABLE',
  'CASH_VARIANCE',
  'CASH_HOLDING_HIGH',
  'CASH_SESSION_OPEN_LONG',
  'CASH_TRANSFER_NOT_RECEIVED',
  'SYNC_ERROR',
  'SYNC_STALE',
  'DEVICE_SEQ_GAP',
  'CLOCK_SKEW',
  'INACTIVE_COMMERCIAL',
  'CHECKIN_SUSPICIOUS',
  'PRICE_MISMATCH',
  'DUPLICATE_SUSPECTED',
  'APPROVAL_PENDING_LONG',
  'TRANSFER_NOT_RECEIVED',
  'TRANSFER_UNMATCHED',
  'LOT_EXPIRING',
  'ATTACHMENT_MISSING',
  'KOMMO_SYNC_FAILED',
  'AUDIT_CHAIN_BROKEN',
  // AV-402
  'ALLOCATION_EXPIRED',
  'ALLOCATION_REVOCATION_PENDING',
  'SALE_UNDELIVERED',
  'CONSUMER_FAILED',
  'LEDGER_MISMATCH',
  'CASH_MISMATCH',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** Événement porté par le marqueur de fin de passe d'un détecteur d'état (ADR-071 §3). */
export const ALERT_PASS_COMPLETED_EVENT = 'AlertDetectionPassCompleted';

/** Charge utile d'un événement de déclenchement : champs en `snake_case`, valeurs JSON. */
export type AlertEventPayload = Readonly<Record<string, unknown>>;

export interface AlertTrigger {
  /** `event_type` stocké : nom logique du catalogue d'événements ou type de commande du pipeline. */
  readonly eventType: string;
  /** Condition sur la charge utile (absente : toujours). */
  readonly when?: (payload: AlertEventPayload) => boolean;
  /** Rôles destinataires propres à ce déclencheur (absent : ceux du type). */
  readonly recipientRoles?: readonly string[];
}

export type AlertFieldKind = 'text' | 'xaf' | 'quantity' | 'integer' | 'date' | 'hours';

export interface AlertMessageField {
  readonly key: string;
  readonly label: string;
  readonly kind?: AlertFieldKind;
  /** Valeur au coût (RC-05, BR-ANA-004) : jamais rendue sans `inventory.valuation.read` (AV-440). */
  readonly protected?: boolean;
}

export interface AlertTypeDefinition {
  readonly code: AlertType;
  readonly nature: AlertNature;
  readonly detectorModule: AlertDetectorModule;
  readonly defaultSeverity: AlertSeverity;
  /** Gravités qu'un événement peut porter pour ce type (AV-401). */
  readonly severities: readonly AlertSeverity[];
  readonly resolution: AlertResolutionMode;
  readonly subjectType: string;
  /** Champs composant un sujet composite (ADR-071 §5) ; absent : l'agrégat de l'événement. */
  readonly subjectParts?: readonly string[];
  /** Écran d'action (`ECR-…`), D13 BR-NOT-001. */
  readonly actionScreen: string | null;
  readonly recipientRoles: readonly string[];
  /** Champs de la charge utile désignant le ou les propriétaires (origine `OWNER`). */
  readonly ownerFields: readonly string[];
  /** Le responsable de l'équipe du propriétaire est destinataire (origine `TEAM_MANAGER`). */
  readonly teamManager: boolean;
  /** Les approbateurs de la politique sont destinataires (origine `APPROVER`). */
  readonly approvers: boolean;
  /** Délai d'escalade par défaut en heures (alerte `CRITICAL`, BR-NOT-005) ; `null` : sans escalade. */
  readonly escalationHours: number | null;
  readonly raisedBy: readonly AlertTrigger[];
  /** Événements qui terminent la condition (résolution `CONDITION_CLEARED`). */
  readonly resolvedBy: readonly AlertTrigger[];
  /** Clés `system_settings` lues par le détecteur (règle 8). */
  readonly settings: readonly string[];
  readonly messageTitle: string;
  readonly messageFields: readonly AlertMessageField[];
  /** Faux : la donnée source ou la phase n'existe pas encore ; la règle est semée désactivée. */
  readonly sourceAvailable: boolean;
}

const blank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

function def(definition: AlertTypeDefinition): AlertTypeDefinition {
  return definition;
}

const bool =
  (key: string, expected: boolean) =>
  (payload: AlertEventPayload): boolean =>
    payload[key] === expected;
const level =
  (expected: string, breached: boolean) =>
  (payload: AlertEventPayload): boolean =>
    payload['level'] === expected && payload['breached'] === breached;
const nonZero =
  (key: string) =>
  (payload: AlertEventPayload): boolean =>
    typeof payload[key] === 'number' && payload[key] !== 0;

const nonZeroUntolerated =
  (key: string) =>
  (payload: AlertEventPayload): boolean =>
    nonZero(key)(payload) && payload['tolerated'] !== true;

export const ALERT_CATALOG: Readonly<Record<AlertType, AlertTypeDefinition>> = {
  STOCK_LOW: def({
    code: 'STOCK_LOW',
    nature: 'STATE',
    detectorModule: 'inventory',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'STOCK_POSITION',
    subjectParts: ['location_id', 'product_id'],
    actionScreen: 'ECR-STK-01',
    recipientRoles: ['MAGASINIER', 'VENDEUR_PDV'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'StockThresholdBreached', when: level('LOW', true) }],
    resolvedBy: [{ eventType: 'StockThresholdBreached', when: level('LOW', false) }],
    settings: [],
    messageTitle: 'Stock faible',
    messageFields: [
      { key: 'location_label', label: 'Emplacement' },
      { key: 'product_label', label: 'Produit' },
      { key: 'available', label: 'Disponible', kind: 'quantity' },
      { key: 'threshold', label: 'Minimum', kind: 'quantity' },
    ],
    sourceAvailable: true,
  }),
  STOCK_OUT: def({
    code: 'STOCK_OUT',
    nature: 'STATE',
    detectorModule: 'inventory',
    defaultSeverity: 'CRITICAL',
    severities: ['CRITICAL'],
    resolution: 'AUTO',
    subjectType: 'STOCK_POSITION',
    subjectParts: ['location_id', 'product_id'],
    actionScreen: 'ECR-STK-01',
    recipientRoles: ['MAGASINIER', 'VENDEUR_PDV', 'RESP_COMMERCIAL'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: 4,
    raisedBy: [{ eventType: 'StockThresholdBreached', when: level('OUT', true) }],
    resolvedBy: [{ eventType: 'StockThresholdBreached', when: level('OUT', false) }],
    settings: [],
    messageTitle: 'Rupture de stock',
    messageFields: [
      { key: 'location_label', label: 'Emplacement' },
      { key: 'product_label', label: 'Produit' },
      { key: 'available', label: 'Disponible', kind: 'quantity' },
    ],
    sourceAvailable: true,
  }),
  POS_REPLENISH: def({
    code: 'POS_REPLENISH',
    nature: 'STATE',
    detectorModule: 'inventory',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'POS_PRODUCT',
    subjectParts: ['location_id', 'product_id'],
    actionScreen: 'ECR-DIS-03',
    recipientRoles: ['MAGASINIER', 'VENDEUR_PDV'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'ReplenishmentSuggested' }],
    resolvedBy: [],
    settings: [],
    messageTitle: 'Réapprovisionnement à prévoir',
    messageFields: [
      { key: 'location_label', label: 'Point de vente' },
      { key: 'product_label', label: 'Produit' },
      { key: 'suggested_quantity', label: 'Quantité suggérée', kind: 'quantity' },
    ],
    sourceAvailable: true,
  }),
  STOCK_NEGATIVE: def({
    code: 'STOCK_NEGATIVE',
    nature: 'EVENT',
    detectorModule: 'inventory',
    defaultSeverity: 'CRITICAL',
    severities: ['CRITICAL'],
    resolution: 'MANUAL',
    subjectType: 'STOCK_POSITION',
    subjectParts: ['location_id', 'product_id'],
    actionScreen: 'ECR-STK-07',
    recipientRoles: ['RESP_FERME', 'MAGASINIER', 'DIRECTION'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: 4,
    raisedBy: [{ eventType: 'StockNegativeDetected', when: bool('negative', true) }],
    resolvedBy: [],
    settings: [],
    messageTitle: 'Solde de stock négatif',
    messageFields: [
      { key: 'location_label', label: 'Emplacement' },
      { key: 'product_label', label: 'Produit' },
      { key: 'balance', label: 'Solde', kind: 'quantity' },
    ],
    sourceAvailable: true,
  }),
  HIGH_LOSS: def({
    code: 'HIGH_LOSS',
    nature: 'EVENT',
    detectorModule: 'inventory',
    defaultSeverity: 'CRITICAL',
    severities: ['CRITICAL'],
    resolution: 'MANUAL',
    subjectType: 'LOSS_DAY',
    subjectParts: ['location_id', 'business_day'],
    actionScreen: 'ECR-STK-07',
    recipientRoles: ['RESP_FERME', 'MAGASINIER', 'DIRECTION'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: 4,
    // Seuil absolu : `inventory` ; part des ventes du jour : `sales` (ADR-071 §2, AV-406).
    raisedBy: [{ eventType: 'HighLossDetected' }, { eventType: 'HighLossSalesShareDetected' }],
    resolvedBy: [],
    settings: ['inventory.high_loss_alert_xaf', 'sales.high_loss_alert_sales_pct'],
    messageTitle: 'Pertes anormales',
    messageFields: [
      { key: 'location_label', label: 'Emplacement' },
      { key: 'business_day', label: 'Jour', kind: 'date' },
      { key: 'loss_quantity', label: 'Quantité perdue', kind: 'quantity' },
      { key: 'loss_value_xaf', label: 'Valeur perdue', kind: 'xaf', protected: true },
    ],
    sourceAvailable: true,
  }),
  HIGH_MORTALITY: def({
    code: 'HIGH_MORTALITY',
    nature: 'EVENT',
    detectorModule: 'production',
    defaultSeverity: 'CRITICAL',
    severities: ['CRITICAL'],
    resolution: 'MANUAL',
    subjectType: 'PRODUCTION_LOT',
    actionScreen: 'ECR-PRD-03',
    recipientRoles: ['RESP_PRODUCTION', 'DIRECTION'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: 4,
    raisedBy: [{ eventType: 'HighMortalityDetected' }],
    resolvedBy: [],
    settings: ['production.high_mortality_alert_pct', 'production.high_mortality_alert_heads'],
    messageTitle: 'Mortalité élevée',
    messageFields: [
      { key: 'lot_label', label: 'Lot' },
      { key: 'heads', label: 'Têtes mortes', kind: 'integer' },
      { key: 'rate_pct', label: 'Taux du jour (%)' },
    ],
    sourceAvailable: true,
  }),
  DAILY_ENTRY_MISSING: def({
    code: 'DAILY_ENTRY_MISSING',
    nature: 'STATE',
    detectorModule: 'production',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'PRODUCTION_LOT',
    actionScreen: 'ECR-PRD-02',
    recipientRoles: ['RESP_FERME', 'RESP_PRODUCTION'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'DailyEntryMissing' }],
    resolvedBy: [{ eventType: 'production.daily.record' }],
    settings: [],
    messageTitle: 'Saisie du jour manquante',
    messageFields: [
      { key: 'lot_label', label: 'Lot' },
      { key: 'missing_day', label: 'Jour manquant', kind: 'date' },
    ],
    sourceAvailable: true,
  }),
  STANDARD_COST_MISSING: def({
    code: 'STANDARD_COST_MISSING',
    nature: 'STATE',
    detectorModule: 'production',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'PRODUCT',
    subjectParts: ['product_id'],
    actionScreen: 'ECR-PRX-01',
    recipientRoles: ['ADMIN'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'StandardCostMissing' }],
    resolvedBy: [{ eventType: 'StandardCostSet' }],
    settings: [],
    messageTitle: 'Coût standard manquant',
    messageFields: [
      { key: 'product_label', label: 'Produit' },
      { key: 'entry_day', label: 'Entrée en stock', kind: 'date' },
    ],
    sourceAvailable: true,
  }),
  RECEIPT_INCOMPLETE: def({
    code: 'RECEIPT_INCOMPLETE',
    nature: 'STATE',
    detectorModule: 'procurement',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'PURCHASE_ORDER',
    actionScreen: 'ECR-APP-03',
    recipientRoles: ['RESP_ACHATS'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'ReceiptIncompleteDetected' }],
    resolvedBy: [{ eventType: 'procurement.order.close_remaining' }],
    settings: ['procurement.receipt_incomplete_alert_days'],
    messageTitle: 'Réception incomplète',
    messageFields: [
      { key: 'doc_number', label: 'Bon de commande' },
      { key: 'supplier_label', label: 'Fournisseur' },
      { key: 'days_late', label: 'Jours de retard', kind: 'integer' },
      { key: 'rejected', label: 'Quantité rejetée', kind: 'quantity' },
    ],
    sourceAvailable: true,
  }),
  INVENTORY_VARIANCE: def({
    code: 'INVENTORY_VARIANCE',
    nature: 'EVENT',
    detectorModule: 'inventory',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'MANUAL',
    subjectType: 'INVENTORY_COUNT',
    actionScreen: 'ECR-STK-05',
    recipientRoles: ['RESP_FERME', 'MAGASINIER', 'FINANCE'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'InventoryVarianceDetected' }],
    resolvedBy: [{ eventType: 'InventoryAdjusted' }],
    settings: [],
    messageTitle: "Écart d'inventaire à valider",
    messageFields: [
      { key: 'location_label', label: 'Emplacement' },
      { key: 'variance_quantity', label: 'Écart net', kind: 'quantity' },
      { key: 'variance_value_xaf', label: 'Valeur de l’écart', kind: 'xaf', protected: true },
    ],
    sourceAvailable: true,
  }),
  OVERDUE_RECEIVABLE: def({
    code: 'OVERDUE_RECEIVABLE',
    nature: 'STATE',
    detectorModule: 'sales',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'SALE',
    actionScreen: 'ECR-FIN-01',
    recipientRoles: ['RESP_COMMERCIAL', 'FINANCE'],
    ownerFields: ['commercial_user_id'],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'ReceivableOverdue' }],
    resolvedBy: [],
    settings: [],
    messageTitle: 'Créance échue',
    messageFields: [
      { key: 'doc_number', label: 'Vente' },
      { key: 'days_overdue', label: 'Jours de retard', kind: 'integer' },
      { key: 'balance_due_xaf', label: 'Solde dû', kind: 'xaf' },
    ],
    sourceAvailable: true,
  }),
  CASH_VARIANCE: def({
    code: 'CASH_VARIANCE',
    nature: 'EVENT',
    detectorModule: 'finance',
    defaultSeverity: 'WARNING',
    severities: ['WARNING', 'CRITICAL'],
    resolution: 'MANUAL',
    subjectType: 'CASH_SESSION',
    actionScreen: 'ECR-FIN-05',
    recipientRoles: ['FINANCE'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: 4,
    // P9-07 : un écart dans la tolérance (`tolerated`) est un constat, pas une alerte : la validation
    // d'office n'émet pas `CashSessionValidated`, l'alerte ne pourrait jamais se résoudre.
    raisedBy: [{ eventType: 'CashVarianceDetected', when: nonZeroUntolerated('variance_xaf') }],
    // Validée par la Finance, ou validée d'office à la clôture (écarts dans la tolérance : aucun
    // `CashSessionValidated`, mais `CashSessionClosed` porte `auto_validated`) ; la tolérance peut avoir
    // changé entre l'ouverture (alerte levée) et la clôture.
    resolvedBy: [
      { eventType: 'CashSessionValidated' },
      { eventType: 'CashSessionClosed', when: bool('auto_validated', true) },
    ],
    settings: ['finance.cash_variance_critical_xaf', 'finance.cash_variance_tolerance_xaf'],
    messageTitle: 'Écart de caisse',
    messageFields: [
      { key: 'variance_xaf', label: 'Écart', kind: 'xaf' },
      { key: 'phase', label: 'Phase' },
      { key: 'expected_xaf', label: 'Attendu', kind: 'xaf' },
      { key: 'counted_xaf', label: 'Compté', kind: 'xaf' },
    ],
    sourceAvailable: true,
  }),
  CASH_HOLDING_HIGH: def({
    code: 'CASH_HOLDING_HIGH',
    nature: 'STATE',
    detectorModule: 'finance',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'CASH_ACCOUNT',
    actionScreen: 'ECR-FIN-05',
    recipientRoles: ['FINANCE'],
    ownerFields: ['holder_user_id'],
    teamManager: true,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'CashHoldingHighDetected' }],
    resolvedBy: [],
    settings: ['finance.cash_holding_max_xaf', 'finance.cash_holding_max_days'],
    messageTitle: 'Encaisse élevée ou sans remise',
    messageFields: [
      { key: 'holder_label', label: 'Détenteur' },
      { key: 'balance_xaf', label: 'Solde', kind: 'xaf' },
      { key: 'days_without_transfer', label: 'Jours sans remise', kind: 'integer' },
    ],
    sourceAvailable: true,
  }),
  CASH_SESSION_OPEN_LONG: def({
    code: 'CASH_SESSION_OPEN_LONG',
    nature: 'STATE',
    detectorModule: 'finance',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'CASH_SESSION',
    actionScreen: 'ECR-FIN-05',
    recipientRoles: ['FINANCE'],
    ownerFields: ['opened_by'],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'CashSessionOpenLongDetected' }],
    resolvedBy: [{ eventType: 'CashSessionClosed' }],
    settings: ['finance.cash_session_force_close_hours'],
    messageTitle: 'Session de caisse ouverte depuis trop longtemps',
    messageFields: [
      { key: 'opened_at', label: 'Ouverte le', kind: 'date' },
      { key: 'hours_open', label: 'Heures ouverte', kind: 'hours' },
    ],
    sourceAvailable: true,
  }),
  CASH_TRANSFER_NOT_RECEIVED: def({
    code: 'CASH_TRANSFER_NOT_RECEIVED',
    nature: 'STATE',
    detectorModule: 'finance',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'CASH_TRANSFER',
    actionScreen: 'ECR-FIN-07',
    recipientRoles: ['FINANCE'],
    ownerFields: ['sent_by'],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'CashTransferUnreceived' }],
    resolvedBy: [
      { eventType: 'finance.cash_transfer.receive' },
      { eventType: 'finance.cash_transfer.cancel' },
      { eventType: 'finance.cash_transfer.close_discrepancy' },
    ],
    settings: ['finance.cash_transfer_unreceived_hours'],
    messageTitle: 'Remise de fonds non reçue',
    messageFields: [
      { key: 'doc_number', label: 'Remise' },
      { key: 'amount_sent_xaf', label: 'Montant envoyé', kind: 'xaf' },
      { key: 'hours_elapsed', label: 'Heures écoulées', kind: 'hours' },
    ],
    sourceAvailable: true,
  }),
  SYNC_ERROR: def({
    code: 'SYNC_ERROR',
    nature: 'STATE',
    detectorModule: 'sync',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'DEVICE_ERROR',
    subjectParts: ['device_id', 'error_code'],
    actionScreen: 'ECR-SYN-03',
    recipientRoles: ['ADMIN'],
    ownerFields: ['user_id'],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'SyncErrorDetected' }],
    resolvedBy: [],
    settings: ['sync.error_alert_window_hours'],
    messageTitle: 'Erreurs de synchronisation',
    messageFields: [
      { key: 'device_label', label: 'Appareil' },
      { key: 'error_code', label: 'Code' },
      { key: 'occurrences', label: 'Occurrences', kind: 'integer' },
    ],
    sourceAvailable: true,
  }),
  SYNC_STALE: def({
    code: 'SYNC_STALE',
    nature: 'STATE',
    detectorModule: 'sync',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'DEVICE',
    actionScreen: 'ECR-SYN-02',
    recipientRoles: ['ADMIN'],
    ownerFields: ['user_id'],
    teamManager: true,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'DeviceSyncStale' }],
    resolvedBy: [],
    settings: ['sync.stale_hours'],
    messageTitle: 'Appareil sans synchronisation',
    messageFields: [
      { key: 'device_label', label: 'Appareil' },
      { key: 'last_sync_at', label: 'Dernière synchronisation', kind: 'date' },
      { key: 'hours_since', label: 'Heures', kind: 'hours' },
    ],
    sourceAvailable: true,
  }),
  DEVICE_SEQ_GAP: def({
    code: 'DEVICE_SEQ_GAP',
    nature: 'EVENT',
    detectorModule: 'sync',
    defaultSeverity: 'CRITICAL',
    severities: ['CRITICAL'],
    resolution: 'MANUAL',
    subjectType: 'DEVICE',
    actionScreen: 'ECR-SYN-02',
    recipientRoles: ['ADMIN', 'DIRECTION'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: 4,
    raisedBy: [{ eventType: 'DeviceSequenceGapDetected' }],
    resolvedBy: [],
    settings: [],
    messageTitle: 'Trou de séquence non comblé',
    messageFields: [
      { key: 'device_label', label: 'Appareil' },
      { key: 'missing_from', label: 'Première séquence manquante', kind: 'integer' },
      { key: 'missing_to', label: 'Dernière séquence manquante', kind: 'integer' },
    ],
    sourceAvailable: true,
  }),
  CLOCK_SKEW: def({
    code: 'CLOCK_SKEW',
    nature: 'STATE',
    detectorModule: 'sync',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'DEVICE',
    actionScreen: 'ECR-SYN-02',
    recipientRoles: ['ADMIN'],
    ownerFields: ['user_id'],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'ClockSkewDetected' }],
    resolvedBy: [],
    settings: ['sync.clock_skew_flag_minutes'],
    messageTitle: "Horloge d'appareil décalée",
    messageFields: [
      { key: 'device_label', label: 'Appareil' },
      { key: 'skew_minutes', label: 'Écart (minutes)', kind: 'integer' },
    ],
    sourceAvailable: true,
  }),
  INACTIVE_COMMERCIAL: def({
    code: 'INACTIVE_COMMERCIAL',
    nature: 'STATE',
    detectorModule: 'sales',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'USER',
    actionScreen: 'ECR-TER-02',
    recipientRoles: ['RESP_COMMERCIAL'],
    ownerFields: ['user_id'],
    teamManager: true,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'InactiveCommercialDetected' }],
    resolvedBy: [],
    settings: ['sales.commercial_working_days', 'sales.inactive_commercial_role_codes'],
    messageTitle: 'Commercial sans activité',
    messageFields: [
      { key: 'user_label', label: 'Commercial' },
      { key: 'inactive_day', label: 'Jour sans activité', kind: 'date' },
    ],
    sourceAvailable: true,
  }),
  CHECKIN_SUSPICIOUS: def({
    code: 'CHECKIN_SUSPICIOUS',
    nature: 'EVENT',
    detectorModule: 'fieldwork',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'MANUAL',
    subjectType: 'CHECKIN',
    actionScreen: 'ECR-TER-02',
    recipientRoles: ['RESP_COMMERCIAL'],
    ownerFields: ['user_id'],
    teamManager: true,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'CheckInSuspicious' }],
    resolvedBy: [],
    settings: [],
    messageTitle: 'Pointage suspect',
    messageFields: [
      { key: 'user_label', label: 'Commercial' },
      { key: 'flags', label: 'Signaux' },
      { key: 'distance_m', label: 'Distance (m)', kind: 'integer' },
    ],
    sourceAvailable: true,
  }),
  PRICE_MISMATCH: def({
    code: 'PRICE_MISMATCH',
    nature: 'EVENT',
    detectorModule: 'sales',
    defaultSeverity: 'INFO',
    severities: ['INFO'],
    resolution: 'MANUAL',
    subjectType: 'SALE',
    actionScreen: 'ECR-VEN-05',
    recipientRoles: ['RESP_COMMERCIAL'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'PriceMismatchDetected' }],
    resolvedBy: [],
    settings: [],
    messageTitle: 'Prix différent du prix en vigueur',
    messageFields: [
      { key: 'doc_number', label: 'Vente' },
      { key: 'product_label', label: 'Produit' },
      { key: 'applied_price_xaf', label: 'Prix appliqué', kind: 'xaf' },
      { key: 'expected_price_xaf', label: 'Prix en vigueur', kind: 'xaf' },
    ],
    sourceAvailable: true,
  }),
  DUPLICATE_SUSPECTED: def({
    code: 'DUPLICATE_SUSPECTED',
    nature: 'EVENT',
    detectorModule: 'sales',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'MANUAL',
    subjectType: 'DUPLICATE_CANDIDATE',
    actionScreen: null,
    recipientRoles: ['FINANCE'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    // Trois producteurs (ADR-071 §2) : encaissement (`sales`), compte client (`crm`), réception (`procurement`).
    raisedBy: [
      { eventType: 'PaymentFlaggedDuplicate', recipientRoles: ['FINANCE'] },
      { eventType: 'CustomerDuplicateSuspected', recipientRoles: ['RESP_COMMERCIAL'] },
      { eventType: 'GoodsReceiptQuarantined', recipientRoles: ['RESP_ACHATS'] },
    ],
    // La décision de la Finance sur un encaissement en doublon ferme aussi l'alerte (P9-07).
    resolvedBy: [{ eventType: 'PaymentDuplicateDecided' }],
    settings: [],
    messageTitle: 'Doublon suspecté',
    messageFields: [
      { key: 'kind', label: 'Objet' },
      { key: 'reference', label: 'Référence' },
    ],
    sourceAvailable: true,
  }),
  APPROVAL_PENDING_LONG: def({
    code: 'APPROVAL_PENDING_LONG',
    nature: 'STATE',
    detectorModule: 'approvals',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'APPROVAL_REQUEST',
    actionScreen: 'ECR-ADM-08',
    recipientRoles: ['DIRECTION'],
    ownerFields: [],
    teamManager: false,
    approvers: true,
    escalationHours: null,
    raisedBy: [{ eventType: 'ApprovalPendingLong' }],
    resolvedBy: [
      { eventType: 'approvals.request.approve' },
      { eventType: 'approvals.request.reject' },
      { eventType: 'approvals.request.withdraw' },
    ],
    settings: ['approvals.pending_long_hours'],
    messageTitle: 'Validation en attente depuis trop longtemps',
    messageFields: [
      { key: 'operation_label', label: 'Opération' },
      { key: 'hours_pending', label: 'Heures en attente', kind: 'hours' },
    ],
    sourceAvailable: true,
  }),
  TRANSFER_NOT_RECEIVED: def({
    code: 'TRANSFER_NOT_RECEIVED',
    nature: 'STATE',
    detectorModule: 'inventory',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'STOCK_TRANSFER',
    actionScreen: 'ECR-STK-03',
    recipientRoles: ['MAGASINIER'],
    ownerFields: ['sender_user_id', 'recipient_user_id'],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'StockTransferNotReceived' }],
    resolvedBy: [
      { eventType: 'inventory.transfer.receive' },
      { eventType: 'inventory.transfer.cancel' },
      { eventType: 'inventory.transfer.decline' },
      { eventType: 'inventory.transfer.return_to_source' },
    ],
    settings: ['inventory.transfer_not_received_hours'],
    messageTitle: 'Transfert expédié non reçu',
    messageFields: [
      { key: 'doc_number', label: 'Transfert' },
      { key: 'hours_elapsed', label: 'Heures écoulées', kind: 'hours' },
    ],
    sourceAvailable: true,
  }),
  TRANSFER_UNMATCHED: def({
    code: 'TRANSFER_UNMATCHED',
    nature: 'EVENT',
    detectorModule: 'inventory',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'MANUAL',
    subjectType: 'STOCK_TRANSFER',
    actionScreen: 'ECR-STK-03',
    recipientRoles: ['MAGASINIER', 'RESP_FERME'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'StockTransferUnmatched' }],
    resolvedBy: [{ eventType: 'inventory.transfer.return_to_source' }],
    settings: ['inventory.transfer_unmatched_hours'],
    messageTitle: 'Réception sans document non rapprochée',
    messageFields: [
      { key: 'transfer_id', label: 'Réception' },
      { key: 'hours', label: 'Heures', kind: 'hours' },
    ],
    sourceAvailable: true,
  }),
  LOT_EXPIRING: def({
    code: 'LOT_EXPIRING',
    nature: 'STATE',
    detectorModule: 'inventory',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'STOCK_LOT',
    actionScreen: 'ECR-STK-01',
    recipientRoles: ['MAGASINIER'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'LotExpiringDetected' }],
    resolvedBy: [],
    settings: ['inventory.lot_expiring_days'],
    messageTitle: 'Lot bientôt périmé',
    messageFields: [
      { key: 'product_label', label: 'Produit' },
      { key: 'expiry_date', label: 'Péremption', kind: 'date' },
      { key: 'quantity', label: 'Quantité', kind: 'quantity' },
    ],
    sourceAvailable: true,
  }),
  ATTACHMENT_MISSING: def({
    code: 'ATTACHMENT_MISSING',
    nature: 'STATE',
    detectorModule: 'finance',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'DOCUMENT',
    actionScreen: null,
    recipientRoles: [],
    ownerFields: ['author_user_id'],
    teamManager: true,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'AttachmentMissingDetected' }],
    resolvedBy: [],
    settings: [
      'attachments.missing_alert_days',
      'attachments.missing_alert_horizon_days',
      'finance.expense_photo_threshold_xaf',
    ],
    messageTitle: 'Pièce justificative non reçue',
    messageFields: [
      { key: 'document_label', label: 'Document' },
      { key: 'days_missing', label: 'Jours sans pièce', kind: 'integer' },
    ],
    sourceAvailable: true,
  }),
  KOMMO_SYNC_FAILED: def({
    code: 'KOMMO_SYNC_FAILED',
    nature: 'EVENT',
    detectorModule: 'integrations',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'MANUAL',
    subjectType: 'INTEGRATION_MESSAGE',
    actionScreen: 'ECR-KOM-01',
    recipientRoles: ['ADMIN'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'KommoSyncFailed' }],
    resolvedBy: [],
    settings: [],
    messageTitle: "Échec d'un message Kommo",
    messageFields: [{ key: 'message_id', label: 'Message' }],
    // P10 : règle semée désactivée jusqu'à la phase d'intégration.
    sourceAvailable: false,
  }),
  AUDIT_CHAIN_BROKEN: def({
    code: 'AUDIT_CHAIN_BROKEN',
    nature: 'EVENT',
    detectorModule: 'audit',
    defaultSeverity: 'CRITICAL',
    severities: ['CRITICAL'],
    resolution: 'MANUAL',
    subjectType: 'AUDIT_PARTITION',
    subjectParts: ['partition'],
    actionScreen: 'ECR-AUD-01',
    recipientRoles: ['ADMIN', 'DIRECTION'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: 4,
    raisedBy: [{ eventType: 'AuditChainBroken' }],
    resolvedBy: [],
    settings: [],
    messageTitle: "Chaîne du journal d'audit rompue",
    messageFields: [
      { key: 'partition', label: 'Partition' },
      { key: 'position', label: 'Position', kind: 'integer' },
    ],
    sourceAvailable: true,
  }),
  ALLOCATION_EXPIRED: def({
    code: 'ALLOCATION_EXPIRED',
    nature: 'STATE',
    detectorModule: 'inventory',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'STOCK_ALLOCATION',
    actionScreen: 'ECR-STK-06',
    recipientRoles: ['MAGASINIER', 'RESP_FERME'],
    ownerFields: ['holder_user_id'],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'AllocationExpired' }],
    resolvedBy: [
      { eventType: 'inventory.allocation.release' },
      { eventType: 'inventory.allocation.revoke' },
    ],
    settings: [],
    messageTitle: 'Quota échu à libérer',
    messageFields: [
      { key: 'product_label', label: 'Produit' },
      { key: 'remaining', label: 'Reste', kind: 'quantity' },
      { key: 'valid_until', label: 'Échéance', kind: 'date' },
    ],
    sourceAvailable: true,
  }),
  ALLOCATION_REVOCATION_PENDING: def({
    code: 'ALLOCATION_REVOCATION_PENDING',
    nature: 'STATE',
    detectorModule: 'inventory',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'STOCK_ALLOCATION',
    actionScreen: 'ECR-STK-06',
    recipientRoles: ['MAGASINIER', 'RESP_FERME'],
    ownerFields: ['holder_user_id'],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'AllocationRevocationPending' }],
    resolvedBy: [
      { eventType: 'inventory.allocation.release' },
      { eventType: 'inventory.allocation.revoke' },
    ],
    settings: [],
    messageTitle: 'Quota à régulariser',
    messageFields: [
      { key: 'product_label', label: 'Produit' },
      { key: 'remaining', label: 'Reste', kind: 'quantity' },
      { key: 'reason', label: 'Motif' },
    ],
    sourceAvailable: true,
  }),
  SALE_UNDELIVERED: def({
    code: 'SALE_UNDELIVERED',
    nature: 'STATE',
    detectorModule: 'sales',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'SALE',
    actionScreen: 'ECR-VEN-03',
    recipientRoles: ['RESP_COMMERCIAL'],
    ownerFields: ['commercial_user_id', 'seller_user_id'],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'SaleUndeliveredDetected' }],
    resolvedBy: [],
    settings: ['sales.undelivered_alert_days'],
    messageTitle: 'Vente confirmée non livrée',
    messageFields: [
      { key: 'doc_number', label: 'Vente' },
      { key: 'days_undelivered', label: 'Jours sans livraison', kind: 'integer' },
    ],
    sourceAvailable: true,
  }),
  CONSUMER_FAILED: def({
    code: 'CONSUMER_FAILED',
    nature: 'STATE',
    detectorModule: 'communication',
    defaultSeverity: 'WARNING',
    severities: ['WARNING'],
    resolution: 'AUTO',
    subjectType: 'EVENT_CONSUMER',
    subjectParts: ['consumer_name'],
    actionScreen: 'ECR-SYN-02',
    recipientRoles: ['ADMIN'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: null,
    raisedBy: [{ eventType: 'ConsumerFailureDetected' }],
    resolvedBy: [],
    settings: ['communication.consumer_lag_alert_seconds'],
    messageTitle: "Consommateur d'événements en échec",
    messageFields: [
      { key: 'consumer_name', label: 'Consommateur' },
      { key: 'failed_events', label: 'Événements sautés', kind: 'integer' },
      { key: 'lag_seconds', label: 'Retard (s)', kind: 'integer' },
    ],
    sourceAvailable: true,
  }),
  LEDGER_MISMATCH: def({
    code: 'LEDGER_MISMATCH',
    nature: 'EVENT',
    detectorModule: 'inventory',
    defaultSeverity: 'CRITICAL',
    severities: ['CRITICAL'],
    resolution: 'MANUAL',
    subjectType: 'LEDGER_RECONCILIATION',
    subjectParts: ['site_id', 'business_day'],
    actionScreen: 'ECR-STK-07',
    recipientRoles: ['RESP_FERME', 'MAGASINIER', 'DIRECTION', 'ADMIN'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: 4,
    raisedBy: [{ eventType: 'LedgerMismatchDetected' }],
    resolvedBy: [],
    settings: [],
    messageTitle: 'Écart de réconciliation du registre de stock',
    messageFields: [
      { key: 'business_day', label: 'Jour', kind: 'date' },
      { key: 'mismatches', label: 'Écarts', kind: 'integer' },
    ],
    sourceAvailable: true,
  }),
  CASH_MISMATCH: def({
    code: 'CASH_MISMATCH',
    nature: 'EVENT',
    detectorModule: 'finance',
    defaultSeverity: 'CRITICAL',
    severities: ['CRITICAL'],
    resolution: 'MANUAL',
    subjectType: 'CASH_RECONCILIATION',
    subjectParts: ['cash_account_id', 'business_day'],
    actionScreen: 'ECR-FIN-05',
    recipientRoles: ['FINANCE', 'DIRECTION'],
    ownerFields: [],
    teamManager: false,
    approvers: false,
    escalationHours: 4,
    raisedBy: [{ eventType: 'CashMismatchDetected' }],
    resolvedBy: [],
    settings: [],
    messageTitle: 'Écart de réconciliation de la trésorerie',
    messageFields: [
      { key: 'business_day', label: 'Jour', kind: 'date' },
      { key: 'account_label', label: 'Compte' },
      { key: 'sections_label', label: 'Rubriques' },
      { key: 'breaches', label: 'Écarts', kind: 'integer' },
      { key: 'difference_xaf', label: 'Différence', kind: 'xaf' },
    ],
    sourceAvailable: true,
  }),
};

export function isAlertType(value: unknown): value is AlertType {
  return typeof value === 'string' && (ALERT_TYPES as readonly string[]).includes(value);
}

export function alertDefinitionOf(type: AlertType): AlertTypeDefinition {
  return ALERT_CATALOG[type];
}

export function isAlertSeverity(value: unknown): value is AlertSeverity {
  return typeof value === 'string' && (ALERT_SEVERITIES as readonly string[]).includes(value);
}

const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

/** Ordre des gravités : `INFO` < `WARNING` < `CRITICAL`. */
export function compareAlertSeverity(a: AlertSeverity, b: AlertSeverity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

/**
 * Gravité d'une alerte ouverte après une nouvelle occurrence (AV-401) : une occurrence plus grave relève
 * l'alerte, aucune ne l'abaisse tant qu'elle est ouverte.
 */
export function raisedSeverity(current: AlertSeverity, incoming: AlertSeverity): AlertSeverity {
  return compareAlertSeverity(incoming, current) > 0 ? incoming : current;
}

/** Clé de déduplication : `<type>:<sujet>` (INV-NOT-01, ADR-071 §6). */
export function alertDedupKey(type: AlertType, subjectKey: string): string {
  return `${type}:${subjectKey}`;
}

/**
 * Clé de sujet d'un type donné : l'identifiant de l'agrégat de l'événement, ou le nom canonique du
 * sujet composite (`TYPE_DE_SUJET:partie1:partie2`, ADR-071 §5). `undefined` si une partie manque.
 */
export function alertSubjectKey(
  definition: AlertTypeDefinition,
  aggregateId: string,
  payload: AlertEventPayload,
): string | undefined {
  if (definition.subjectParts === undefined) {
    return blank(aggregateId) ? undefined : aggregateId.toLowerCase();
  }
  const parts: string[] = [];
  for (const key of definition.subjectParts) {
    const value = payload[key];
    if (blank(value) || (typeof value !== 'string' && typeof value !== 'number')) return undefined;
    parts.push(String(value).toLowerCase());
  }
  return `${definition.subjectType}:${parts.join(':')}`;
}

/** Types dont la règle est semée activée (source disponible). */
export function enabledByDefault(type: AlertType): boolean {
  return ALERT_CATALOG[type].sourceAvailable;
}
