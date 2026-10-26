import { describe, expect, it } from 'vitest';
import {
  DIRECT_NOTIFICATION_COMMENT_MAX,
  DIRECT_NOTIFICATION_EVENT_TYPES,
  DirectNotificationPayloadError,
  TRANSFER_DISPATCH_PERMISSION,
  TRANSFER_RECEIVE_PERMISSION,
  disabledDirectNotificationTypes,
  isDirectNotificationEventType,
  planDirectNotification,
  type DirectNotificationEventType,
} from './direct-notifications.js';

const APPROVAL = '01900000-0000-7000-8000-000000000001';
const REQUESTER = '01900000-0000-7000-8000-0000000000a1';
const APPROVER = '01900000-0000-7000-8000-0000000000a2';
const SITE = '01900000-0000-7000-8000-0000000000b1';
const ZONE = '01900000-0000-7000-8000-0000000000b2';
const SITE_B = '01900000-0000-7000-8000-0000000000b3';
const TRANSFER = '01900000-0000-7000-8000-000000000002';

const requested = (extra: Record<string, unknown> = {}) => ({
  approval_id: APPROVAL,
  operation_type: 'EXPENSE',
  requester_user_id: REQUESTER,
  approver_permission: 'finance.expense.approve',
  site_id: SITE,
  zone_id: ZONE,
  ...extra,
});
const decided = (extra: Record<string, unknown> = {}) => ({
  approval_id: APPROVAL,
  operation_type: 'PURCHASE_REQUEST',
  requester_user_id: REQUESTER,
  decided_by: APPROVER,
  ...extra,
});
const plan = (eventType: DirectNotificationEventType, payload: unknown, aggregateId = APPROVAL) =>
  planDirectNotification({ eventType, aggregateId, payload });

describe('types directs', () => {
  it('les six événements retenus, et eux seulement', () => {
    expect([...DIRECT_NOTIFICATION_EVENT_TYPES]).toEqual([
      'ApprovalRequested',
      'ApprovalGranted',
      'ApprovalRejected',
      'StockTransferRequested',
      'StockTransferDispatched',
      'AnalyticsExportCompleted',
    ]);
    for (const type of DIRECT_NOTIFICATION_EVENT_TYPES) {
      expect(isDirectNotificationEventType(type)).toBe(true);
    }
    for (const type of ['AlertRaised', 'InternalNotePublished', 'PurchaseRequestApproved', '']) {
      expect(isDirectNotificationEventType(type)).toBe(false);
    }
  });
});

describe('demande de validation (ApprovalRequested)', () => {
  it('les titulaires de la permission de la politique, sur le périmètre de la demande, le demandeur exclu', () => {
    expect(plan('ApprovalRequested', requested())).toEqual({
      eventType: 'ApprovalRequested',
      audience: {
        kind: 'PERMISSION_HOLDERS',
        permission: 'finance.expense.approve',
        perimeter: { siteId: SITE, zoneId: ZONE, ownerUserIds: [REQUESTER] },
        excludeUserIds: [REQUESTER],
        fallbackToDirection: true,
      },
      title: 'Validation à donner',
      body: 'Dépense : une demande attend votre décision.',
      sourceType: 'APPROVAL_REQUEST',
      sourceId: APPROVAL,
    });
  });

  it('le message ne porte ni résumé ni montant de la demande (RC-05)', () => {
    const result = plan(
      'ApprovalRequested',
      requested({ subject_summary: 'Perte valorisée 540 000 XAF', amount_xaf: 540000 }),
    );
    expect(result!.title + result!.body).not.toMatch(/540|XAF|Perte valorisée/);
  });

  it('un type d’opération inconnu garde son code ; site et zone sont facultatifs', () => {
    const result = plan(
      'ApprovalRequested',
      requested({ operation_type: 'NOUVEAU_TYPE', site_id: null, zone_id: undefined }),
    );
    expect(result!.body).toBe('NOUVEAU_TYPE : une demande attend votre décision.');
    expect(result!.audience).toMatchObject({
      perimeter: { siteId: null, zoneId: null, ownerUserIds: [REQUESTER] },
    });
  });

  it('sans permission d’approbation connue, la politique ne désigne personne : repli sur la Direction', () => {
    for (const absent of [null, undefined, '']) {
      const result = plan('ApprovalRequested', requested({ approver_permission: absent }));
      expect(result!.audience).toMatchObject({
        kind: 'PERMISSION_HOLDERS',
        permission: null,
        fallbackToDirection: true,
      });
    }
  });

  it('une charge incomplète ou mal typée lève, en nommant le champ', () => {
    for (const key of ['operation_type', 'requester_user_id']) {
      const payload = requested({ [key]: undefined });
      expect(() => plan('ApprovalRequested', payload)).toThrow(DirectNotificationPayloadError);
      expect(() => plan('ApprovalRequested', payload)).toThrow(key);
    }
    expect(() => plan('ApprovalRequested', requested({ operation_type: '  ' }))).toThrow(
      'operation_type',
    );
    expect(() => plan('ApprovalRequested', requested({ site_id: 12 }))).toThrow('site_id');
    for (const garbage of [null, 'texte', 12, ['liste']]) {
      expect(() => plan('ApprovalRequested', garbage)).toThrow('objet attendu');
    }
  });
});

describe('décision (ApprovalGranted, ApprovalRejected)', () => {
  it('accordée : le demandeur seul, sans motif', () => {
    expect(plan('ApprovalGranted', decided({ comment: 'Bon pour accord' }))).toEqual({
      eventType: 'ApprovalGranted',
      audience: { kind: 'USERS', userIds: [REQUESTER] },
      title: 'Validation accordée',
      body: 'Votre demande (Demande d’achat) a été approuvée.',
      sourceType: 'APPROVAL_REQUEST',
      sourceId: APPROVAL,
    });
  });

  it('refusée : le demandeur seul, avec le motif', () => {
    expect(plan('ApprovalRejected', decided({ comment: '  Budget épuisé ' }))).toEqual({
      eventType: 'ApprovalRejected',
      audience: { kind: 'USERS', userIds: [REQUESTER] },
      title: 'Validation refusée',
      body: 'Votre demande (Demande d’achat) a été refusée. Motif : Budget épuisé',
      sourceType: 'APPROVAL_REQUEST',
      sourceId: APPROVAL,
    });
  });

  it('refusée sans motif ou avec un motif vide : pas de « Motif »', () => {
    for (const comment of [undefined, null, '', '   ']) {
      expect(plan('ApprovalRejected', decided({ comment }))!.body).toBe(
        'Votre demande (Demande d’achat) a été refusée.',
      );
    }
  });

  it('un motif trop long est tronqué à la limite, ellipse comprise', () => {
    // La limite des trois cents caractères est celle du contrat de l'AV-430.
    expect(DIRECT_NOTIFICATION_COMMENT_MAX).toBe(300);
    const long = 'a'.repeat(DIRECT_NOTIFICATION_COMMENT_MAX + 50);
    const body = plan('ApprovalRejected', decided({ comment: long }))!.body;
    const motif = body.slice(body.indexOf('Motif : ') + 'Motif : '.length);
    expect(motif).toHaveLength(DIRECT_NOTIFICATION_COMMENT_MAX);
    expect(motif.endsWith('…')).toBe(true);
    const exact = 'b'.repeat(DIRECT_NOTIFICATION_COMMENT_MAX);
    expect(plan('ApprovalRejected', decided({ comment: exact }))!.body).toContain(
      `Motif : ${exact}`,
    );
  });

  it('le demandeur qui a décidé lui-même (Direction) n’est pas prévenu de son propre acte', () => {
    for (const type of ['ApprovalGranted', 'ApprovalRejected'] as const) {
      expect(plan(type, decided({ decided_by: REQUESTER }))!.audience).toEqual({
        kind: 'USERS',
        userIds: [],
      });
    }
  });

  it('une charge incomplète ou mal typée lève', () => {
    for (const key of ['operation_type', 'requester_user_id', 'decided_by']) {
      expect(() => plan('ApprovalGranted', decided({ [key]: undefined }))).toThrow(key);
    }
    expect(() => plan('ApprovalRejected', decided({ comment: 5 }))).toThrow('comment');
  });
});

describe('transferts (StockTransferRequested, StockTransferDispatched)', () => {
  const requestedTransfer = (extra: Record<string, unknown> = {}) => ({
    transfer_id: TRANSFER,
    doc_number: 'TRF-FRM-2026-000012',
    from_site_id: SITE,
    to_site_id: SITE_B,
    requested_by: REQUESTER,
    ...extra,
  });
  const dispatchedTransfer = (extra: Record<string, unknown> = {}) => ({
    transfer_id: TRANSFER,
    doc_number: 'TRF-FRM-2026-000012',
    from_site_id: SITE_B,
    to_site_id: SITE,
    dispatched_by: APPROVER,
    ...extra,
  });

  it('demandé : les expéditeurs du site source, le demandeur exclu', () => {
    expect(plan('StockTransferRequested', requestedTransfer(), TRANSFER)).toEqual({
      eventType: 'StockTransferRequested',
      audience: {
        kind: 'PERMISSION_HOLDERS',
        permission: TRANSFER_DISPATCH_PERMISSION,
        perimeter: { siteId: SITE, zoneId: null, ownerUserIds: [] },
        excludeUserIds: [REQUESTER],
        fallbackToDirection: false,
      },
      title: 'Transfert à expédier',
      body: 'Le transfert TRF-FRM-2026-000012 est demandé : à préparer et à expédier.',
      sourceType: 'STOCK_TRANSFER',
      sourceId: TRANSFER,
    });
    expect(TRANSFER_DISPATCH_PERMISSION).toBe('inventory.transfer.dispatch');
  });

  it('expédié : les réceptionnaires du site destinataire, l’expéditeur exclu', () => {
    expect(plan('StockTransferDispatched', dispatchedTransfer(), TRANSFER)).toEqual({
      eventType: 'StockTransferDispatched',
      audience: {
        kind: 'PERMISSION_HOLDERS',
        permission: TRANSFER_RECEIVE_PERMISSION,
        perimeter: { siteId: SITE, zoneId: null, ownerUserIds: [] },
        excludeUserIds: [APPROVER],
        fallbackToDirection: false,
      },
      title: 'Transfert en route',
      body: 'Le transfert TRF-FRM-2026-000012 est expédié vers votre site.',
      sourceType: 'STOCK_TRANSFER',
      sourceId: TRANSFER,
    });
    expect(TRANSFER_RECEIVE_PERMISSION).toBe('inventory.transfer.receive');
  });

  it('chaque événement lit le site de son côté du transfert, et un site inconnu laisse le périmètre vide', () => {
    expect(
      plan('StockTransferRequested', requestedTransfer({ from_site_id: null }))!.audience,
    ).toMatchObject({ perimeter: { siteId: null } });
    expect(
      plan('StockTransferDispatched', dispatchedTransfer({ to_site_id: undefined }))!.audience,
    ).toMatchObject({ perimeter: { siteId: null } });
  });

  it('une charge incomplète lève', () => {
    expect(() => plan('StockTransferRequested', requestedTransfer({ doc_number: '' }))).toThrow(
      'doc_number',
    );
    expect(() =>
      plan('StockTransferRequested', requestedTransfer({ requested_by: undefined })),
    ).toThrow('requested_by');
    expect(() =>
      plan('StockTransferDispatched', dispatchedTransfer({ dispatched_by: undefined })),
    ).toThrow('dispatched_by');
    // Le demandeur n'est pas l'acteur d'une expédition, ni l'inverse.
    expect(() =>
      plan(
        'StockTransferDispatched',
        dispatchedTransfer({ dispatched_by: undefined, requested_by: REQUESTER }),
      ),
    ).toThrow('dispatched_by');
  });
});

describe('désactivation par type (AV-431)', () => {
  it('seule une liste de types connus désactive quelque chose', () => {
    expect([
      ...disabledDirectNotificationTypes(['ApprovalGranted', 'StockTransferDispatched']),
    ]).toEqual(['ApprovalGranted', 'StockTransferDispatched']);
    expect([...disabledDirectNotificationTypes(['Inconnu', 5, null, 'ApprovalRejected'])]).toEqual([
      'ApprovalRejected',
    ]);
    for (const value of [undefined, null, 'ApprovalGranted', 3, { ApprovalGranted: true }, []]) {
      expect(disabledDirectNotificationTypes(value).size).toBe(0);
    }
  });
});

describe('fin d’un export (P9-20 ; ADR-067 §7)', () => {
  const EXPORT = '01900000-0000-7000-8000-000000000003';
  const finished = (extra: Record<string, unknown> = {}) => ({
    export_id: EXPORT,
    requested_by: REQUESTER,
    dataset: 'f_sales_line',
    format: 'CSV',
    status: 'DONE',
    row_count: 120,
    ...extra,
  });

  it('prévient le demandeur seul, de nature EXPORT, sans aucune donnée de l’export', () => {
    const done = plan('AnalyticsExportCompleted', finished(), EXPORT);
    expect(done).toMatchObject({
      eventType: 'AnalyticsExportCompleted',
      kind: 'EXPORT',
      sourceType: 'ANALYTICS_EXPORT',
      sourceId: EXPORT,
      audience: { kind: 'USERS', userIds: [REQUESTER] },
      title: 'Export prêt',
    });
    expect(done.body).not.toMatch(/120|f_sales_line/);
  });

  it('un échec dit pourquoi, en langage clair : limite, droit retiré, catalogue changé, étendue trop large', () => {
    const reason = (errorCode: string | null) =>
      plan(
        'AnalyticsExportCompleted',
        finished({ status: 'FAILED', error_code: errorCode }),
        EXPORT,
      ).body;
    expect(reason('QUERY_LIMIT_EXCEEDED')).toContain('affinez');
    expect(reason('FORBIDDEN')).toContain('droit');
    expect(reason('CATALOG_OUTDATED')).toContain('catalogue');
    expect(reason('SCOPE_TRUNCATED')).toContain('périmètre');
    expect(reason('AUTRE_CODE')).toContain('erreur de production');
    expect(reason(null)).toBe('Votre export n’a pas pu être produit.');
    expect(
      plan(
        'AnalyticsExportCompleted',
        finished({ status: 'FAILED', error_code: 'FORBIDDEN' }),
        EXPORT,
      ).title,
    ).toBe('Export non produit');
  });

  it('une charge fautive lève : demandeur ou statut manquant, statut inconnu', () => {
    expect(() => plan('AnalyticsExportCompleted', { status: 'DONE' }, EXPORT)).toThrow(
      DirectNotificationPayloadError,
    );
    expect(() => plan('AnalyticsExportCompleted', { requested_by: REQUESTER }, EXPORT)).toThrow(
      DirectNotificationPayloadError,
    );
    expect(() => plan('AnalyticsExportCompleted', finished({ status: 'QUEUED' }), EXPORT)).toThrow(
      DirectNotificationPayloadError,
    );
  });

  it('les autres plans ne portent pas de nature particulière (DIRECT par défaut)', () => {
    expect(plan('ApprovalRequested', requested()).kind).toBeUndefined();
  });
});
