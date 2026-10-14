import { describe, expect, it } from 'vitest';
import {
  alertItemSchema,
  alertListResponseSchema,
  alertRuleItemSchema,
  alertRuleListResponseSchema,
  alertSummarySchema,
  noteAcknowledgementsResponseSchema,
  noteItemSchema,
  noteListResponseSchema,
  notificationListResponseSchema,
} from './communication-reads.js';
import {
  analyticsQueryResponseSchema,
  dashboardBlockSchema,
  dashboardResponseSchema,
  exportJobSchema,
  kpiSnapshotSchema,
  savedViewSchema,
} from './analytics-reads.js';

const A = '0198c3a0-1111-7aaa-8bbb-000000000001';
const B = '0198c3a0-2222-7aaa-8bbb-000000000002';
const T = '2026-10-14T08:00:00.000Z';

const alert = {
  id: A,
  alertType: 'OVERDUE_RECEIVABLE',
  nature: 'STATE',
  severity: 'WARNING',
  status: 'OPEN',
  title: 'Créance échue',
  message: 'Vente : VTE-1 ; Jours de retard : 13',
  subjectType: 'SALE',
  subjectId: B,
  siteId: A,
  zoneId: null,
  ownerUserId: B,
  actionScreen: 'ECR-FIN-01',
  occurrences: 3,
  firstDetectedAt: T,
  lastDetectedAt: T,
  criticalSince: null,
  escalatedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  resolvedAt: null,
  resolvedBy: null,
  resolutionComment: null,
  visibility: ['RECIPIENT'],
  payload: { doc_number: 'VTE-1' },
};

describe('lectures de communication', () => {
  it('alerte : forme complète, au moins une raison de visibilité', () => {
    expect(alertItemSchema.safeParse(alert).success).toBe(true);
    expect(alertItemSchema.safeParse({ ...alert, visibility: [] }).success).toBe(false);
    expect(alertItemSchema.safeParse({ ...alert, severity: 'FATAL' }).success).toBe(false);
    expect(alertItemSchema.safeParse({ ...alert, occurrences: 0 }).success).toBe(false);
    expect(alertItemSchema.safeParse({ ...alert, alertType: 'NOPE' }).success).toBe(false);
  });

  it('liste et résumé', () => {
    expect(alertListResponseSchema.safeParse({ items: [alert], nextCursor: null }).success).toBe(
      true,
    );
    expect(
      alertSummarySchema.safeParse({
        open: 3,
        acknowledged: 1,
        bySeverity: { INFO: 0, WARNING: 3, CRITICAL: 1 },
        truncated: false,
        computedAt: T,
      }).success,
    ).toBe(true);
    expect(
      alertSummarySchema.safeParse({
        open: -1,
        acknowledged: 0,
        bySeverity: { INFO: 0, WARNING: 0, CRITICAL: 0 },
        truncated: false,
        computedAt: T,
      }).success,
    ).toBe(false);
  });

  it('règle d’alerte : réglages et ce que le catalogue admet', () => {
    const rule = {
      alertType: 'HIGH_LOSS',
      nature: 'EVENT',
      enabled: true,
      severity: 'CRITICAL',
      severitiesAdmitted: ['WARNING', 'CRITICAL'],
      recipientRoles: ['RESP_FERME', 'DIRECTION'],
      resolutionMode: 'MANUAL',
      resolutionModesAdmitted: ['AUTO', 'MANUAL'],
      escalationHours: 4,
      escalationApplicable: true,
      escalationRoles: ['DIRECTION'],
      sourceAvailable: true,
      version: 2,
      updatedAt: T,
      updatedBy: null,
    };
    expect(alertRuleItemSchema.parse(rule)).toEqual(rule);
    expect(alertRuleListResponseSchema.parse({ items: [rule] }).items).toHaveLength(1);
    expect(() => alertRuleItemSchema.parse({ ...rule, escalationHours: 0 })).toThrow();
    expect(() => alertRuleItemSchema.parse({ ...rule, escalationHours: 200 })).toThrow();
    expect(() => alertRuleItemSchema.parse({ ...rule, alertType: 'INCONNU' })).toThrow();
    expect(() => alertRuleItemSchema.parse({ ...rule, severitiesAdmitted: [] })).toThrow();
  });

  it('notifications et notes', () => {
    expect(
      notificationListResponseSchema.safeParse({
        items: [
          {
            id: A,
            channel: 'IN_APP',
            title: 'Rupture de stock',
            body: 'Produit : Poulet',
            link: null,
            alertId: B,
            noteId: null,
            createdAt: T,
            deliveredAt: null,
            readAt: null,
          },
        ],
        unreadCount: 1,
        nextCursor: null,
      }).success,
    ).toBe(true);
    const note = {
      id: A,
      title: 'Prix',
      body: 'Nouveau prix',
      category: 'PRIX',
      relatedEntityType: null,
      relatedEntityId: null,
      requiresAck: true,
      status: 'PUBLISHED',
      publishedAt: T,
      expiresAt: null,
      authorUserId: B,
      readAt: null,
      acknowledgedAt: null,
    };
    expect(noteItemSchema.safeParse(note).success).toBe(true);
    expect(noteItemSchema.safeParse({ ...note, status: 'DELETED' }).success).toBe(false);
    expect(
      noteListResponseSchema.safeParse({
        items: [note],
        pendingAcknowledgements: 1,
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      noteAcknowledgementsResponseSchema.safeParse({
        noteId: A,
        audienceSize: 40,
        read: 30,
        acknowledged: 25,
        missing: [{ userId: B, fullName: 'Awa N.' }],
      }).success,
    ).toBe(true);
  });
});

describe('lectures d’analytics', () => {
  const period = { code: 'WEEK', fromDay: '2026-10-12', toDay: '2026-10-18', days: 7 };
  const freshness = { computedAt: T, devicesInScope: 12, staleDevices: 2, staleAfterHours: 2 };

  it('requête : colonnes, lignes, totaux nuls pour une mesure non additive', () => {
    const response = {
      dataset: 'f_sales_line',
      catalogVersion: 1,
      period,
      columns: [
        { name: 'commercial_user_id', label: 'Commercial', kind: 'dimension', dimensionType: 'id' },
        { name: 'revenue', label: "Chiffre d'affaires", kind: 'measure', unit: 'xaf' },
      ],
      rows: [
        {
          values: { commercial_user_id: A, revenue: 250_000 },
          source: { type: 'SALE', id: B, route: `/sales/${B}` },
        },
      ],
      rowCount: 1,
      totals: null,
      freshness,
    };
    expect(analyticsQueryResponseSchema.safeParse(response).success).toBe(true);
    expect(analyticsQueryResponseSchema.safeParse({ ...response, columns: [] }).success).toBe(
      false,
    );
  });

  it('bloc de tableau : valeur masquée à null, bloc indisponible isolé, valeurs par défaut', () => {
    const block = dashboardBlockSchema.parse({
      code: 'VENTES',
      title: 'Ventes',
      kpis: [
        {
          code: 'KPI-COM-08',
          label: "Chiffre d'affaires",
          unit: 'xaf',
          value: 1_250_000,
          previousValue: 900_000,
          variationPct: 38.9,
        },
        { code: 'KPI-STK-02', label: 'Valeur du stock', unit: 'xaf', value: null },
      ],
    });
    expect(block.details).toEqual([]);
    expect(block.unavailable).toBeNull();
    const unavailable = dashboardBlockSchema.parse({
      code: 'FINANCES',
      title: 'Finances',
      kpis: [],
      unavailable: { reason: 'FORBIDDEN' },
    });
    expect(unavailable.unavailable).toEqual({ reason: 'FORBIDDEN' });
    expect(
      dashboardBlockSchema.safeParse({
        code: 'VENTES',
        title: 'Ventes',
        kpis: [{ code: 'ca', label: 'CA', unit: 'xaf', value: 1 }],
      }).success,
    ).toBe(false);
  });

  it('tableau, instantané, vue, export', () => {
    expect(
      dashboardResponseSchema.safeParse({
        code: 'direction',
        period,
        previousPeriod: { ...period, fromDay: '2026-10-05', toDay: '2026-10-11' },
        blocks: [],
        freshness,
        computedAt: T,
      }).success,
    ).toBe(true);
    expect(
      kpiSnapshotSchema.safeParse({
        scopeKey: 'commercial',
        periodKey: 'WEEK',
        computedAt: T,
        kpis: [],
      }).success,
    ).toBe(true);
    expect(
      kpiSnapshotSchema.safeParse({
        scopeKey: 'commercial',
        periodKey: 'YEAR',
        computedAt: T,
        kpis: [],
      }).success,
    ).toBe(false);
    expect(
      savedViewSchema.safeParse({
        id: A,
        name: 'Ventes de la semaine',
        dataset: 'f_sales_line',
        definition: { dataset: 'f_sales_line', measures: ['revenue'] },
        catalogVersion: 1,
        ownerUserId: B,
        sharedWithRoles: ['RESP_COMMERCIAL'],
        isDefaultForRole: null,
        executability: 'OK',
        updatedAt: T,
      }).success,
    ).toBe(true);
    expect(
      exportJobSchema.safeParse({
        id: A,
        dataset: 'f_sales_line',
        format: 'CSV',
        status: 'FAILED',
        rowCount: null,
        errorCode: 'QUERY_LIMIT_EXCEEDED',
        createdAt: T,
        finishedAt: T,
        expiresAt: T,
      }).success,
    ).toBe(true);
  });
});
