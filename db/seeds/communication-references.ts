/**
 * Règles d'alerte semées (P9-03 ; D13 §7.1 ; BR-NOT-001 ; ADR-061 ; AV-352, AV-363, AV-367) : une règle
 * par type du catalogue, avec la gravité par défaut, les rôles destinataires, le mode de résolution et
 * l'escalade de D13. Les seuils ne sont pas des règles : ce sont des paramètres système (AV-350).
 *
 * Ce paquet n'importe pas `@gic/domain` : le catalogue y est dupliqué sous forme de données, et un test
 * du serveur (`communication-seed.test.ts`) vérifie l'égalité avec `ALERT_CATALOG`. Ce seed ne réécrit
 * jamais une règle existante : un administrateur peut l'avoir modifiée (`communication.alert_rule.set`).
 */
export interface AlertRuleSeed {
  readonly alertType: string;
  readonly enabled: boolean;
  readonly severity: 'INFO' | 'WARNING' | 'CRITICAL';
  readonly recipientRoles: readonly string[];
  readonly resolutionMode: 'AUTO' | 'MANUAL';
  readonly escalationHours: number | null;
  readonly escalationRoles: readonly string[];
}

const DIRECTION = ['DIRECTION'] as const;

function rule(
  alertType: string,
  severity: AlertRuleSeed['severity'],
  recipientRoles: readonly string[],
  resolutionMode: AlertRuleSeed['resolutionMode'],
  options: { readonly escalationHours?: number; readonly enabled?: boolean } = {},
): AlertRuleSeed {
  return {
    alertType,
    enabled: options.enabled ?? true,
    severity,
    recipientRoles,
    resolutionMode,
    escalationHours: options.escalationHours ?? null,
    escalationRoles: DIRECTION,
  };
}

/** 36 règles : les 30 types de D13 §7.1 puis les 6 ajoutés par AV-352. */
export const ALERT_RULES: readonly AlertRuleSeed[] = [
  rule('STOCK_LOW', 'WARNING', ['MAGASINIER', 'VENDEUR_PDV'], 'AUTO'),
  rule('STOCK_OUT', 'CRITICAL', ['MAGASINIER', 'VENDEUR_PDV', 'RESP_COMMERCIAL'], 'AUTO', {
    escalationHours: 4,
  }),
  rule('POS_REPLENISH', 'WARNING', ['MAGASINIER', 'VENDEUR_PDV'], 'AUTO'),
  rule('STOCK_NEGATIVE', 'CRITICAL', ['RESP_FERME', 'MAGASINIER', 'DIRECTION'], 'MANUAL', {
    escalationHours: 4,
  }),
  rule('HIGH_LOSS', 'CRITICAL', ['RESP_FERME', 'MAGASINIER', 'DIRECTION'], 'MANUAL', {
    escalationHours: 4,
  }),
  rule('HIGH_MORTALITY', 'CRITICAL', ['RESP_PRODUCTION', 'DIRECTION'], 'MANUAL', {
    escalationHours: 4,
  }),
  rule('DAILY_ENTRY_MISSING', 'WARNING', ['RESP_FERME', 'RESP_PRODUCTION'], 'AUTO'),
  rule('STANDARD_COST_MISSING', 'WARNING', ['ADMIN'], 'AUTO'),
  rule('RECEIPT_INCOMPLETE', 'WARNING', ['RESP_ACHATS'], 'AUTO'),
  rule('INVENTORY_VARIANCE', 'WARNING', ['RESP_FERME', 'MAGASINIER', 'FINANCE'], 'MANUAL'),
  rule('OVERDUE_RECEIVABLE', 'WARNING', ['RESP_COMMERCIAL', 'FINANCE'], 'AUTO'),
  rule('CASH_VARIANCE', 'WARNING', ['FINANCE'], 'MANUAL', { escalationHours: 4 }),
  rule('CASH_HOLDING_HIGH', 'WARNING', ['FINANCE'], 'AUTO'),
  rule('CASH_SESSION_OPEN_LONG', 'WARNING', ['FINANCE'], 'AUTO'),
  rule('CASH_TRANSFER_NOT_RECEIVED', 'WARNING', ['FINANCE'], 'AUTO'),
  rule('SYNC_ERROR', 'WARNING', ['ADMIN'], 'AUTO'),
  rule('SYNC_STALE', 'WARNING', ['ADMIN'], 'AUTO'),
  rule('DEVICE_SEQ_GAP', 'CRITICAL', ['ADMIN', 'DIRECTION'], 'MANUAL', { escalationHours: 4 }),
  rule('CLOCK_SKEW', 'WARNING', ['ADMIN'], 'AUTO'),
  rule('INACTIVE_COMMERCIAL', 'WARNING', ['RESP_COMMERCIAL'], 'AUTO'),
  rule('CHECKIN_SUSPICIOUS', 'WARNING', ['RESP_COMMERCIAL'], 'MANUAL'),
  rule('PRICE_MISMATCH', 'INFO', ['RESP_COMMERCIAL'], 'MANUAL'),
  rule('DUPLICATE_SUSPECTED', 'WARNING', ['FINANCE'], 'MANUAL'),
  rule('APPROVAL_PENDING_LONG', 'WARNING', ['DIRECTION'], 'AUTO'),
  rule('TRANSFER_NOT_RECEIVED', 'WARNING', ['MAGASINIER'], 'AUTO'),
  rule('TRANSFER_UNMATCHED', 'WARNING', ['MAGASINIER', 'RESP_FERME'], 'MANUAL'),
  rule('LOT_EXPIRING', 'WARNING', ['MAGASINIER'], 'AUTO'),
  rule('ATTACHMENT_MISSING', 'WARNING', [], 'AUTO'),
  // P10 : source absente, règle semée désactivée (AV-352).
  rule('KOMMO_SYNC_FAILED', 'WARNING', ['ADMIN'], 'MANUAL', { enabled: false }),
  rule('AUDIT_CHAIN_BROKEN', 'CRITICAL', ['ADMIN', 'DIRECTION'], 'MANUAL', { escalationHours: 4 }),
  // AV-352 : types ajoutés au catalogue de D13.
  rule('ALLOCATION_EXPIRED', 'WARNING', ['MAGASINIER', 'RESP_FERME'], 'AUTO'),
  rule('ALLOCATION_REVOCATION_PENDING', 'WARNING', ['MAGASINIER', 'RESP_FERME'], 'AUTO'),
  rule('SALE_UNDELIVERED', 'WARNING', ['RESP_COMMERCIAL'], 'AUTO'),
  rule('CONSUMER_FAILED', 'WARNING', ['ADMIN'], 'AUTO'),
  rule(
    'LEDGER_MISMATCH',
    'CRITICAL',
    ['RESP_FERME', 'MAGASINIER', 'DIRECTION', 'ADMIN'],
    'MANUAL',
    {
      escalationHours: 4,
    },
  ),
  rule('CASH_MISMATCH', 'CRITICAL', ['FINANCE', 'DIRECTION'], 'MANUAL', { escalationHours: 4 }),
];
