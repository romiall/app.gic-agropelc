import { describe, expect, it } from 'vitest';
import {
  ALERT_CATALOG,
  ALERT_DETECTOR_MODULES,
  ALERT_TYPES,
  alertDedupKey,
  alertDefinitionOf,
  alertSubjectKey,
  compareAlertSeverity,
  enabledByDefault,
  isAlertSeverity,
  isAlertType,
  raisedSeverity,
} from './alerts.js';

/** Les trente types de D13 §7.1, dans l'ordre du catalogue. */
const D13_TYPES = [
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
];

describe('catalogue des alertes (D13 §7.1, AV-402)', () => {
  it('porte les trente types de D13 puis les six ajoutés, sans doublon', () => {
    expect(ALERT_TYPES.slice(0, 30)).toEqual(D13_TYPES);
    expect(ALERT_TYPES.slice(30)).toEqual([
      'ALLOCATION_EXPIRED',
      'ALLOCATION_REVOCATION_PENDING',
      'SALE_UNDELIVERED',
      'CONSUMER_FAILED',
      'LEDGER_MISMATCH',
      'CASH_MISMATCH',
    ]);
    expect(new Set(ALERT_TYPES).size).toBe(ALERT_TYPES.length);
    expect(Object.keys(ALERT_CATALOG).sort()).toEqual([...ALERT_TYPES].sort());
  });

  it.each(ALERT_TYPES)('%s : définition cohérente', (type) => {
    const definition = alertDefinitionOf(type);
    expect(definition.code).toBe(type);
    expect(definition.severities).toContain(definition.defaultSeverity);
    expect(ALERT_DETECTOR_MODULES).toContain(definition.detectorModule);
    expect(definition.raisedBy.length).toBeGreaterThan(0);
    expect(definition.messageTitle.length).toBeGreaterThan(0);
    expect(definition.messageFields.length).toBeGreaterThan(0);
    // Un type critique escalade (BR-NOT-005) ; un type non critique n'escalade pas.
    if (definition.severities.includes('CRITICAL')) {
      expect(definition.escalationHours).toBe(4);
    } else {
      expect(definition.escalationHours).toBeNull();
    }
    // Un destinataire au moins : rôle, propriétaire, responsable ou approbateur (D13 §14 : repli Direction).
    const hasRecipient =
      definition.recipientRoles.length > 0 ||
      definition.ownerFields.length > 0 ||
      definition.teamManager ||
      definition.approvers ||
      definition.raisedBy.every((trigger) => (trigger.recipientRoles?.length ?? 0) > 0);
    expect(hasRecipient).toBe(true);
    // Les noms de champs du message sont uniques ; une valeur protégée est un montant (RC-05).
    const keys = definition.messageFields.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const field of definition.messageFields) {
      if (field.protected === true) expect(field.kind).toBe('xaf');
    }
    // Un sujet composite a au moins une partie ; un sujet d'agrégat n'en déclare pas.
    if (definition.subjectParts !== undefined) {
      expect(definition.subjectParts.length).toBeGreaterThan(0);
    }
  });

  it('une alerte d’état se résout seule ; une alerte d’événement se traite à la main (BR-NOT-003)', () => {
    for (const type of ALERT_TYPES) {
      const definition = alertDefinitionOf(type);
      if (definition.nature === 'STATE') expect(definition.resolution).toBe('AUTO');
    }
    expect(alertDefinitionOf('HIGH_LOSS').nature).toBe('EVENT');
    expect(alertDefinitionOf('OVERDUE_RECEIVABLE').nature).toBe('STATE');
  });

  it('valeurs au coût : seules la perte et l’écart d’inventaire portent un champ protégé', () => {
    const withProtected = ALERT_TYPES.filter((type) =>
      alertDefinitionOf(type).messageFields.some((field) => field.protected === true),
    );
    expect(withProtected).toEqual(['HIGH_LOSS', 'INVENTORY_VARIANCE']);
  });

  it('placement des détecteurs imposé par le graphe (ADR-071 §2)', () => {
    expect(alertDefinitionOf('INACTIVE_COMMERCIAL').detectorModule).toBe('sales');
    expect(alertDefinitionOf('OVERDUE_RECEIVABLE').detectorModule).toBe('sales');
    expect(alertDefinitionOf('HIGH_MORTALITY').detectorModule).toBe('production');
    expect(alertDefinitionOf('APPROVAL_PENDING_LONG').detectorModule).toBe('approvals');
    expect(alertDefinitionOf('CONSUMER_FAILED').detectorModule).toBe('communication');
  });

  it('seule la règle Kommo est semée désactivée (P10)', () => {
    expect(ALERT_TYPES.filter((type) => !enabledByDefault(type))).toEqual(['KOMMO_SYNC_FAILED']);
  });

  it('le type d’alerte est reconnu strictement', () => {
    expect(isAlertType('STOCK_LOW')).toBe(true);
    expect(isAlertType('stock_low')).toBe(false);
    expect(isAlertType(42)).toBe(false);
    expect(isAlertSeverity('CRITICAL')).toBe(true);
    expect(isAlertSeverity('FATAL')).toBe(false);
  });
});

describe('gravité et clés', () => {
  it('ordonne INFO < WARNING < CRITICAL', () => {
    expect(compareAlertSeverity('INFO', 'WARNING')).toBeLessThan(0);
    expect(compareAlertSeverity('CRITICAL', 'WARNING')).toBeGreaterThan(0);
    expect(compareAlertSeverity('WARNING', 'WARNING')).toBe(0);
  });

  it('une occurrence plus grave relève l’alerte, aucune ne l’abaisse (AV-401)', () => {
    expect(raisedSeverity('WARNING', 'CRITICAL')).toBe('CRITICAL');
    expect(raisedSeverity('CRITICAL', 'WARNING')).toBe('CRITICAL');
    expect(raisedSeverity('INFO', 'INFO')).toBe('INFO');
  });

  it('clé de déduplication : <type>:<sujet> (INV-NOT-01)', () => {
    expect(alertDedupKey('OVERDUE_RECEIVABLE', 'abc')).toBe('OVERDUE_RECEIVABLE:abc');
  });

  it('sujet : l’agrégat (en minuscules) ou le sujet composite dans l’ordre des parties', () => {
    const sale = alertDefinitionOf('OVERDUE_RECEIVABLE');
    expect(alertSubjectKey(sale, 'AAAA-BBBB', {})).toBe('aaaa-bbbb');
    expect(alertSubjectKey(sale, '  ', {})).toBeUndefined();

    const stock = alertDefinitionOf('STOCK_LOW');
    expect(alertSubjectKey(stock, 'ignored', { location_id: 'L1', product_id: 'P1' })).toBe(
      'STOCK_POSITION:l1:p1',
    );
    expect(alertSubjectKey(stock, 'ignored', { location_id: 'L1' })).toBeUndefined();
    expect(
      alertSubjectKey(stock, 'ignored', { location_id: '', product_id: 'P1' }),
    ).toBeUndefined();
    expect(
      alertSubjectKey(stock, 'ignored', { location_id: { x: 1 }, product_id: 'P1' }),
    ).toBeUndefined();
  });

  it('un sujet composite accepte une partie numérique (jour, position)', () => {
    const audit = alertDefinitionOf('AUDIT_CHAIN_BROKEN');
    expect(alertSubjectKey(audit, 'x', { partition: 7 })).toBe('AUDIT_PARTITION:7');
  });
});
