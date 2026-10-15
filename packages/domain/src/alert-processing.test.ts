import { describe, expect, it } from 'vitest';
import { ALERT_PASS_COMPLETED_EVENT, ALERT_TYPES, alertDefinitionOf } from './alerts.js';
import {
  alertFromEvent,
  alertTriggerEventTypes,
  alertPassId,
  alertPassIdPrefix,
  alertsResolvedByPass,
  applyAlertCommand,
  isAlertTriggerEvent,
  type AlertEventInput,
  type AlertRaiseAction,
} from './alert-processing.js';

const AT = new Date('2026-10-14T08:00:00.000Z');
const SALE = '0191a3f0-0000-7000-8000-000000000001';
const SESSION = '0191a3f0-0000-7000-8000-000000000002';
const SITE = '0191a3f0-0000-7000-8000-0000000000aa';
const LOCATION = '0191a3f0-0000-7000-8000-0000000000b1';
const PRODUCT = '0191a3f0-0000-7000-8000-0000000000c1';

function event(
  eventType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): AlertEventInput {
  return { eventId: 'e1', eventType, aggregateId, occurredAt: AT, payload };
}

function raise(input: AlertEventInput): AlertRaiseAction {
  const result = alertFromEvent(input);
  const action = result.actions.find((a): a is AlertRaiseAction => a.kind === 'RAISE');
  if (action === undefined) throw new Error(`Aucune levée pour ${input.eventType}`);
  return action;
}

describe('alertFromEvent — événements déjà publiés par les phases précédentes', () => {
  it('ReceivableOverdue (P4-09) lève OVERDUE_RECEIVABLE sur la vente, propriétaire = commercial', () => {
    const action = raise(
      event('ReceivableOverdue', SALE, {
        sale_id: SALE,
        doc_number: 'VTE-2026-000123',
        customer_id: 'c1',
        commercial_user_id: 'AAAAAAAA-0000-7000-8000-000000000001',
        site_id: SITE,
        due_date: '2026-10-01',
        days_overdue: 13,
        balance_due_xaf: 45_000,
        business_day: '2026-10-14',
        pass_id: 'pass-1',
      }),
    );
    expect(action).toMatchObject({
      alertType: 'OVERDUE_RECEIVABLE',
      subjectType: 'SALE',
      subjectKey: SALE,
      dedupKey: `OVERDUE_RECEIVABLE:${SALE}`,
      severity: 'WARNING',
      declaredSeverity: null,
      siteId: SITE,
      zoneId: null,
      ownerUserIds: ['aaaaaaaa-0000-7000-8000-000000000001'],
      recipientRoles: ['RESP_COMMERCIAL', 'FINANCE'],
      actionScreen: 'ECR-FIN-01',
      businessDay: '2026-10-14',
      passId: 'pass-1',
    });
  });

  it('CashVarianceDetected : gravité de l’événement, écart nul ignoré (P5-12)', () => {
    const critical = raise(
      event('CashVarianceDetected', SESSION, {
        session_id: SESSION,
        site_id: SITE,
        phase: 'CLOSING',
        variance_xaf: -12_000,
        severity: 'CRITICAL',
      }),
    );
    expect(critical.alertType).toBe('CASH_VARIANCE');
    expect(critical.severity).toBe('CRITICAL');
    expect(critical.declaredSeverity).toBe('CRITICAL');
    expect(critical.recipientRoles).toEqual(['FINANCE']);

    const warning = raise(
      event('CashVarianceDetected', SESSION, { variance_xaf: 500, severity: 'WARNING' }),
    );
    expect(warning.severity).toBe('WARNING');

    const zero = alertFromEvent(event('CashVarianceDetected', SESSION, { variance_xaf: 0 }));
    expect(zero.actions).toEqual([]);
  });

  it('CashSessionClosed validée d’office résout l’alerte d’écart ; clôture à valider : aucune résolution (P9-07)', () => {
    const auto = alertFromEvent(
      event('CashSessionClosed', SESSION, { variance_xaf: 0, auto_validated: true }),
    );
    expect(auto.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'RESOLVE', alertType: 'CASH_VARIANCE' }),
      ]),
    );
    const pending = alertFromEvent(
      event('CashSessionClosed', SESSION, { variance_xaf: 500, auto_validated: false }),
    );
    expect(
      pending.actions.filter((a) => a.kind === 'RESOLVE' && a.alertType === 'CASH_VARIANCE'),
    ).toEqual([]);
  });

  it('CashVarianceDetected : un écart toléré est un constat, pas une alerte (P9-07)', () => {
    const tolerated = alertFromEvent(
      event('CashVarianceDetected', SESSION, { variance_xaf: -300, tolerated: true }),
    );
    expect(tolerated.actions).toEqual([]);
    const notTolerated = raise(
      event('CashVarianceDetected', SESSION, { variance_xaf: -300, tolerated: false }),
    );
    expect(notTolerated.alertType).toBe('CASH_VARIANCE');
    // Charge utile sans drapeau (événements antérieurs, ajustements) : alerte levée.
    expect(raise(event('CashVarianceDetected', SESSION, { variance_xaf: -300 })).alertType).toBe(
      'CASH_VARIANCE',
    );
  });

  it('une gravité hors des gravités admises du type retombe sur la gravité par défaut', () => {
    const action = raise(
      event('CashVarianceDetected', SESSION, { variance_xaf: 10, severity: 'INFO' }),
    );
    expect(action.severity).toBe('WARNING');
    expect(action.declaredSeverity).toBeNull();
  });

  it('CashSessionOpenLongDetected lève ; CashSessionClosed résout le même sujet', () => {
    const raised = raise(
      event('CashSessionOpenLongDetected', SESSION, {
        session_id: SESSION,
        opened_by: 'U1',
        site_id: SITE,
        hours_open: 30,
      }),
    );
    expect(raised.alertType).toBe('CASH_SESSION_OPEN_LONG');
    expect(raised.ownerUserIds).toEqual(['u1']);

    const closed = alertFromEvent(event('CashSessionClosed', SESSION, { session_id: SESSION }));
    expect(closed.actions).toEqual([
      {
        kind: 'RESOLVE',
        alertType: 'CASH_SESSION_OPEN_LONG',
        subjectKey: SESSION,
        dedupKey: `CASH_SESSION_OPEN_LONG:${SESSION}`,
        reason: 'CONDITION_CLEARED',
        occurredAt: AT,
      },
    ]);
  });

  it('CashSessionValidated résout l’écart de caisse (SM-ALERT, validation de la Finance)', () => {
    const result = alertFromEvent(event('CashSessionValidated', SESSION, {}));
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ kind: 'RESOLVE', alertType: 'CASH_VARIANCE' });
  });

  it('remise non reçue : levée par CashTransferUnreceived, résolue par la réception ou l’annulation', () => {
    const raised = raise(
      event('CashTransferUnreceived', SALE, { transfer_id: SALE, sent_by: 'U9', site_id: SITE }),
    );
    expect(raised.alertType).toBe('CASH_TRANSFER_NOT_RECEIVED');
    for (const type of [
      'finance.cash_transfer.receive',
      'finance.cash_transfer.cancel',
      'finance.cash_transfer.close_discrepancy',
    ]) {
      const result = alertFromEvent(event(type, SALE, {}));
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toMatchObject({
        kind: 'RESOLVE',
        alertType: 'CASH_TRANSFER_NOT_RECEIVED',
      });
    }
  });

  it('StockTransferUnmatched (P5-16), AllocationExpired et AllocationRevocationPending (P5-08)', () => {
    expect(raise(event('StockTransferUnmatched', SALE, { transfer_id: SALE })).alertType).toBe(
      'TRANSFER_UNMATCHED',
    );
    const expired = raise(
      event('AllocationExpired', SALE, { allocation_id: SALE, holder_user_id: 'H1' }),
    );
    expect(expired).toMatchObject({ alertType: 'ALLOCATION_EXPIRED', ownerUserIds: ['h1'] });
    expect(
      raise(event('AllocationRevocationPending', SALE, { allocation_id: SALE })).alertType,
    ).toBe('ALLOCATION_REVOCATION_PENDING');
    expect(alertFromEvent(event('inventory.allocation.release', SALE, {})).actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'RESOLVE', alertType: 'ALLOCATION_EXPIRED' }),
        expect.objectContaining({ kind: 'RESOLVE', alertType: 'ALLOCATION_REVOCATION_PENDING' }),
      ]),
    );
  });
});

describe('alertFromEvent — sujet composite, transitions et passes', () => {
  it('seuil de stock : STOCK_LOW et STOCK_OUT lèvent et se résolvent par niveau, sans se confondre', () => {
    const payload = { location_id: LOCATION, product_id: PRODUCT, site_id: SITE };
    const low = raise(
      event('StockThresholdBreached', LOCATION, { ...payload, level: 'LOW', breached: true }),
    );
    expect(low).toMatchObject({
      alertType: 'STOCK_LOW',
      subjectType: 'STOCK_POSITION',
      subjectKey: `STOCK_POSITION:${LOCATION}:${PRODUCT}`,
      severity: 'WARNING',
    });
    const out = raise(
      event('StockThresholdBreached', LOCATION, { ...payload, level: 'OUT', breached: true }),
    );
    expect(out.alertType).toBe('STOCK_OUT');
    expect(out.severity).toBe('CRITICAL');

    const cleared = alertFromEvent(
      event('StockThresholdBreached', LOCATION, { ...payload, level: 'LOW', breached: false }),
    );
    expect(cleared.actions).toHaveLength(1);
    expect(cleared.actions[0]).toMatchObject({ kind: 'RESOLVE', alertType: 'STOCK_LOW' });
  });

  it('une partie de sujet manquante : aucune alerte, un constat SUBJECT_MISSING', () => {
    const result = alertFromEvent(
      event('StockThresholdBreached', LOCATION, {
        level: 'LOW',
        breached: true,
        location_id: LOCATION,
      }),
    );
    expect(result.actions).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'SUBJECT_MISSING', alertType: 'STOCK_LOW' }),
    ]);
  });

  it('une résolution sans sujet exploitable est un constat, pas une exception', () => {
    const result = alertFromEvent(
      event('StockThresholdBreached', LOCATION, { level: 'OUT', breached: false }),
    );
    expect(result.actions).toEqual([]);
    expect(result.issues[0]).toMatchObject({ code: 'SUBJECT_MISSING', alertType: 'STOCK_OUT' });
  });

  it('DUPLICATE_SUSPECTED : un producteur, des rôles propres à son déclencheur', () => {
    expect(raise(event('PaymentFlaggedDuplicate', SALE, {})).recipientRoles).toEqual(['FINANCE']);
    expect(raise(event('CustomerDuplicateSuspected', SALE, {})).recipientRoles).toEqual([
      'RESP_COMMERCIAL',
    ]);
    expect(raise(event('GoodsReceiptQuarantined', SALE, {})).recipientRoles).toEqual([
      'RESP_ACHATS',
    ]);
  });

  it('HIGH_LOSS : deux producteurs (seuil absolu et part du CA), même sujet emplacement × jour', () => {
    const payload = { location_id: LOCATION, business_day: '2026-10-14', loss_value_xaf: 80_000 };
    const absolute = raise(event('HighLossDetected', LOCATION, payload));
    const share = raise(event('HighLossSalesShareDetected', LOCATION, payload));
    expect(absolute.dedupKey).toBe(share.dedupKey);
    expect(absolute.dedupKey).toBe(`HIGH_LOSS:LOSS_DAY:${LOCATION}:2026-10-14`);
  });

  it('marqueur de passe : type d’alerte connu et identité de passe obligatoires', () => {
    const ok = alertFromEvent(
      event(ALERT_PASS_COMPLETED_EVENT, 'ignored', {
        alert_type: 'OVERDUE_RECEIVABLE',
        pass_id: 'pass-9',
        business_day: '2026-10-14',
      }),
    );
    expect(ok.actions).toEqual([
      {
        kind: 'PASS_COMPLETED',
        alertType: 'OVERDUE_RECEIVABLE',
        passId: 'pass-9',
        scope: null,
        businessDay: '2026-10-14',
        occurredAt: AT,
      },
    ]);
    const scoped = alertFromEvent(
      event(ALERT_PASS_COMPLETED_EVENT, 'ignored', {
        alert_type: 'ATTACHMENT_MISSING',
        pass_id: 'ATTACHMENT_MISSING:EXPENSE:slot',
        scope: 'EXPENSE',
      }),
    );
    expect(scoped.actions[0]).toMatchObject({ kind: 'PASS_COMPLETED', scope: 'EXPENSE' });
    for (const payload of [
      { alert_type: 'NOPE', pass_id: 'p' },
      { alert_type: 'OVERDUE_RECEIVABLE' },
      { alert_type: 'OVERDUE_RECEIVABLE', pass_id: '  ' },
    ]) {
      const bad = alertFromEvent(event(ALERT_PASS_COMPLETED_EVENT, 'x', payload));
      expect(bad.actions).toEqual([]);
      expect(bad.issues[0]).toMatchObject({ code: 'PASS_MARKER_INVALID' });
    }
  });

  it('un événement étranger aux alertes ne produit rien', () => {
    expect(alertFromEvent(event('sales.sale.record', SALE, {}))).toEqual({
      actions: [],
      issues: [],
    });
    expect(isAlertTriggerEvent('sales.sale.record')).toBe(false);
  });

  it('chaque déclencheur du catalogue est reconnu par le consommateur', () => {
    const known = new Set(alertTriggerEventTypes());
    expect(known.has(ALERT_PASS_COMPLETED_EVENT)).toBe(true);
    for (const type of ALERT_TYPES) {
      const definition = alertDefinitionOf(type);
      for (const trigger of [...definition.raisedBy, ...definition.resolvedBy]) {
        expect(known.has(trigger.eventType)).toBe(true);
        expect(isAlertTriggerEvent(trigger.eventType)).toBe(true);
      }
    }
  });
});

describe('applyAlertCommand (SM-ALERT)', () => {
  const event_ = alertDefinitionOf('HIGH_LOSS');
  const state = alertDefinitionOf('OVERDUE_RECEIVABLE');

  it('prise en compte : OPEN → ACKNOWLEDGED, sans effet ensuite ou sur une alerte close (BR-SYN-007)', () => {
    expect(
      applyAlertCommand({ status: 'OPEN', command: 'ACKNOWLEDGE', definition: event_ }),
    ).toEqual({
      ok: true,
      changed: true,
      status: 'ACKNOWLEDGED',
    });
    expect(
      applyAlertCommand({ status: 'ACKNOWLEDGED', command: 'ACKNOWLEDGE', definition: event_ }),
    ).toMatchObject({ ok: true, changed: false, reason: 'ALREADY_ACKNOWLEDGED' });
    for (const status of ['RESOLVED', 'DISMISSED'] as const) {
      expect(
        applyAlertCommand({ status, command: 'ACKNOWLEDGE', definition: event_ }),
      ).toMatchObject({ ok: true, changed: false, status, reason: 'ALREADY_CLOSED' });
    }
  });

  it('résolution d’une alerte d’événement : commentaire obligatoire', () => {
    expect(
      applyAlertCommand({ status: 'OPEN', command: 'RESOLVE', definition: event_, text: '  ' }),
    ).toMatchObject({ ok: false, code: 'ALERT_COMMENT_REQUIRED' });
    expect(
      applyAlertCommand({
        status: 'ACKNOWLEDGED',
        command: 'RESOLVE',
        definition: event_,
        text: 'Perte régularisée',
      }),
    ).toEqual({ ok: true, changed: true, status: 'RESOLVED' });
  });

  it('une alerte d’état ne se résout pas à la main et ne s’écarte pas (AV-404)', () => {
    expect(
      applyAlertCommand({ status: 'OPEN', command: 'RESOLVE', definition: state, text: 'ok' }),
    ).toMatchObject({ ok: false, code: 'ALERT_RESOLVE_NOT_ALLOWED' });
    expect(
      applyAlertCommand({ status: 'OPEN', command: 'DISMISS', definition: state, text: 'bruit' }),
    ).toMatchObject({ ok: false, code: 'ALERT_DISMISS_NOT_ALLOWED' });
    // …mais la prise en compte et la résolution automatique restent possibles.
    expect(
      applyAlertCommand({ status: 'OPEN', command: 'ACKNOWLEDGE', definition: state }),
    ).toMatchObject({ ok: true, status: 'ACKNOWLEDGED' });
    expect(
      applyAlertCommand({ status: 'ACKNOWLEDGED', command: 'AUTO_RESOLVE', definition: state }),
    ).toEqual({ ok: true, changed: true, status: 'RESOLVED' });
  });

  it('écart d’une alerte d’événement : motif obligatoire', () => {
    expect(
      applyAlertCommand({ status: 'OPEN', command: 'DISMISS', definition: event_ }),
    ).toMatchObject({ ok: false, code: 'ALERT_REASON_REQUIRED' });
    expect(
      applyAlertCommand({
        status: 'OPEN',
        command: 'DISMISS',
        definition: event_,
        text: 'Faux positif',
      }),
    ).toEqual({ ok: true, changed: true, status: 'DISMISSED' });
  });

  it('une alerte à résolution manuelle peut être résolue par l’événement qui termine sa condition', () => {
    const variance = alertDefinitionOf('CASH_VARIANCE');
    expect(
      applyAlertCommand({ status: 'OPEN', command: 'AUTO_RESOLVE', definition: variance }),
    ).toEqual({ ok: true, changed: true, status: 'RESOLVED' });
  });
});

describe('alertsResolvedByPass (ADR-071 §3)', () => {
  const open = [
    { id: 'a1', alertType: 'OVERDUE_RECEIVABLE', status: 'OPEN', lastPassId: 'old' },
    { id: 'a2', alertType: 'OVERDUE_RECEIVABLE', status: 'ACKNOWLEDGED', lastPassId: 'new' },
    { id: 'a3', alertType: 'OVERDUE_RECEIVABLE', status: 'OPEN', lastPassId: null },
    { id: 'a4', alertType: 'OVERDUE_RECEIVABLE', status: 'RESOLVED', lastPassId: 'old' },
    { id: 'a5', alertType: 'SALE_UNDELIVERED', status: 'OPEN', lastPassId: 'old' },
  ] as const;

  it('résout les alertes d’état ouvertes du type que la passe n’a pas revues, jamais par l’horloge', () => {
    expect(alertsResolvedByPass(open, { alertType: 'OVERDUE_RECEIVABLE', passId: 'new' })).toEqual([
      'a1',
      'a3',
    ]);
  });

  it('ne résout rien pour une alerte d’événement ou à résolution manuelle, même ouverte', () => {
    const manual = [
      { id: 'm1', alertType: 'HIGH_LOSS', status: 'OPEN', lastPassId: 'old' },
      { id: 'm2', alertType: 'CASH_VARIANCE', status: 'OPEN', lastPassId: null },
    ] as const;
    expect(alertsResolvedByPass(manual, { alertType: 'HIGH_LOSS', passId: 'p' })).toEqual([]);
    expect(alertsResolvedByPass(manual, { alertType: 'CASH_VARIANCE', passId: 'p' })).toEqual([]);
  });

  it('passe à portée : ne résout que les alertes levées par une passe de la même portée', () => {
    const scoped = [
      {
        id: 's1',
        alertType: 'ATTACHMENT_MISSING',
        status: 'OPEN',
        lastPassId: 'ATTACHMENT_MISSING:EXPENSE:t1',
      },
      {
        id: 's2',
        alertType: 'ATTACHMENT_MISSING',
        status: 'OPEN',
        lastPassId: 'ATTACHMENT_MISSING:EXPENSE:t2',
      },
      {
        id: 's3',
        alertType: 'ATTACHMENT_MISSING',
        status: 'OPEN',
        lastPassId: 'ATTACHMENT_MISSING:GOODS_RECEIPT:t1',
      },
      { id: 's4', alertType: 'ATTACHMENT_MISSING', status: 'OPEN', lastPassId: null },
    ] as const;
    expect(
      alertsResolvedByPass(scoped, {
        alertType: 'ATTACHMENT_MISSING',
        passId: 'ATTACHMENT_MISSING:EXPENSE:t2',
        scope: 'EXPENSE',
      }),
    ).toEqual(['s1']);
    expect(
      alertsResolvedByPass(scoped, {
        alertType: 'ATTACHMENT_MISSING',
        passId: 'ATTACHMENT_MISSING:GOODS_RECEIPT:t2',
        scope: 'GOODS_RECEIPT',
      }),
    ).toEqual(['s3']);
  });

  it('identité de passe : type, portée et créneau, plafonnée à 64 sans entamer le début', () => {
    expect(alertPassId('OVERDUE_RECEIVABLE', 'slot')).toBe('OVERDUE_RECEIVABLE:slot');
    expect(alertPassId('ATTACHMENT_MISSING', 's', 'EXPENSE')).toBe('ATTACHMENT_MISSING:EXPENSE:s');
    const long = alertPassId('ATTACHMENT_MISSING', 'x'.repeat(100), 'EXPENSE');
    expect(long).toHaveLength(64);
    expect(long.startsWith(alertPassIdPrefix('ATTACHMENT_MISSING', 'EXPENSE'))).toBe(true);
  });

  it('une passe rejouée (même identité) ne résout pas ce qu’elle a déjà revu', () => {
    expect(alertsResolvedByPass(open, { alertType: 'OVERDUE_RECEIVABLE', passId: 'old' })).toEqual([
      'a2',
      'a3',
    ]);
  });
});

describe('alertFromEvent — alertes de stock (P9-08)', () => {
  const LOT = '0191a3f0-0000-7000-8000-0000000000d1';
  const SITE_B = '0191a3f0-0000-7000-8000-0000000000bb';
  const resolved = (type: string, aggregateId: string, payload: Record<string, unknown> = {}) =>
    alertFromEvent(event(type, aggregateId, payload)).actions.filter(
      (a) => a.kind === 'RESOLVE',
    ) as readonly { kind: 'RESOLVE'; alertType: string; subjectKey: string }[];

  it('réception sans document : le rapprochement tardif résout, le retour à la source ne résout pas', () => {
    const raised = raise(event('StockTransferUnmatched', SALE, { transfer_id: SALE }));
    expect(raised).toMatchObject({ alertType: 'TRANSFER_UNMATCHED', subjectKey: SALE });
    expect(resolved('BlindReceiptMatched', SALE).map((a) => a.alertType)).toEqual([
      'TRANSFER_UNMATCHED',
    ]);
    // `inventory.transfer.return_to_source` ne porte que l'expédition : il résout seulement le
    // transfert non reçu, jamais la réception sans document.
    expect(resolved('inventory.transfer.return_to_source', SALE).map((a) => a.alertType)).toEqual([
      'TRANSFER_NOT_RECEIVED',
    ]);
  });

  it('quota à régulariser : la levée du blocage résout cette alerte et pas celle de l’échéance', () => {
    expect(resolved('AllocationRevocationCleared', SALE).map((a) => a.alertType)).toEqual([
      'ALLOCATION_REVOCATION_PENDING',
    ]);
    expect(
      resolved('inventory.allocation.release', SALE)
        .map((a) => a.alertType)
        .sort(),
    ).toEqual(['ALLOCATION_EXPIRED', 'ALLOCATION_REVOCATION_PENDING']);
  });

  it('lot bientôt périmé : un sujet par lot, par site et par produit', () => {
    const base = { lot_id: LOT, business_day: '2026-10-15' };
    const a = raise(
      event('LotExpiringDetected', LOT, { ...base, site_id: SITE, product_id: PRODUCT }),
    );
    const otherSite = raise(
      event('LotExpiringDetected', LOT, { ...base, site_id: SITE_B, product_id: PRODUCT }),
    );
    const otherProduct = raise(
      event('LotExpiringDetected', LOT, { ...base, site_id: SITE, product_id: LOCATION }),
    );
    expect(a.subjectKey).toBe(`STOCK_LOT:${LOT}:${SITE}:${PRODUCT}`);
    expect(a.dedupKey).not.toBe(otherSite.dedupKey);
    expect(a.dedupKey).not.toBe(otherProduct.dedupKey);
    expect(a.siteId).toBe(SITE);
    const missing = alertFromEvent(
      event('LotExpiringDetected', LOT, { lot_id: LOT, site_id: SITE }),
    );
    expect(missing.actions).toEqual([]);
    expect(missing.issues).toEqual([
      expect.objectContaining({ code: 'SUBJECT_MISSING', alertType: 'LOT_EXPIRING' }),
    ]);
  });

  it('écart du registre : sujet par site et par jour, `GLOBAL` pour une anomalie sans site', () => {
    const site = raise(
      event('LedgerMismatchDetected', SITE, {
        site_key: SITE,
        site_id: SITE,
        business_day: '2026-10-15',
        mismatches: 3,
      }),
    );
    expect(site).toMatchObject({
      alertType: 'LEDGER_MISMATCH',
      subjectKey: `LEDGER_RECONCILIATION:${SITE}:2026-10-15`,
      siteId: SITE,
      severity: 'CRITICAL',
    });
    const global = raise(
      event('LedgerMismatchDetected', SITE, {
        site_key: 'GLOBAL',
        business_day: '2026-10-15',
        mismatches: 1,
      }),
    );
    expect(global.subjectKey).toBe('LEDGER_RECONCILIATION:global:2026-10-15');
    expect(global.siteId).toBeNull();
    // Sans clé de site, aucune alerte n'est levée : l'anomalie ne se perd pas en silence, elle devient
    // un constat de l'événement.
    const none = alertFromEvent(
      event('LedgerMismatchDetected', SITE, { business_day: '2026-10-15', mismatches: 1 }),
    );
    expect(none.actions).toEqual([]);
    expect(none.issues[0]).toMatchObject({ code: 'SUBJECT_MISSING' });
  });

  it('écart d’inventaire : levé par la soumission, résolu par la comptabilisation du même inventaire', () => {
    const COUNT = '0191a3f0-0000-7000-8000-0000000000e1';
    expect(raise(event('InventoryVarianceDetected', COUNT, { count_id: COUNT })).subjectKey).toBe(
      COUNT,
    );
    expect(resolved('InventoryAdjusted', COUNT).map((a) => [a.alertType, a.subjectKey])).toEqual([
      ['INVENTORY_VARIANCE', COUNT],
    ]);
  });

  it('transfert non reçu : levé par la passe, résolu par les commandes de réception, d’annulation, de refus ou de retour', () => {
    expect(raise(event('StockTransferNotReceived', SALE, { transfer_id: SALE })).alertType).toBe(
      'TRANSFER_NOT_RECEIVED',
    );
    for (const command of [
      'inventory.transfer.receive',
      'inventory.transfer.cancel',
      'inventory.transfer.decline',
      'inventory.transfer.return_to_source',
      // L'expédition rapprochée d'une réception sans document (immédiat ou tardif) : sujet = l'expédition.
      'TransferMatchedByBlindReceipt',
    ]) {
      expect(resolved(command, SALE).map((a) => a.alertType)).toContain('TRANSFER_NOT_RECEIVED');
    }
  });

  it('solde négatif : seul un événement `negative` vrai lève ; réapprovisionnement : sujet PDV × produit', () => {
    const payload = { location_id: LOCATION, product_id: PRODUCT, site_id: SITE };
    expect(
      alertFromEvent(event('StockNegativeDetected', LOCATION, { ...payload, negative: false }))
        .actions,
    ).toEqual([]);
    expect(
      raise(event('StockNegativeDetected', LOCATION, { ...payload, negative: true })),
    ).toMatchObject({
      alertType: 'STOCK_NEGATIVE',
      subjectKey: `STOCK_POSITION:${LOCATION}:${PRODUCT}`,
      severity: 'CRITICAL',
    });
    expect(raise(event('ReplenishmentSuggested', LOCATION, payload))).toMatchObject({
      alertType: 'POS_REPLENISH',
      subjectKey: `POS_PRODUCT:${LOCATION}:${PRODUCT}`,
    });
  });
});
