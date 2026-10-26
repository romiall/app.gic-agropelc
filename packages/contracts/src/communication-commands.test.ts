import { describe, expect, it } from 'vitest';
import {
  COMMUNICATION_COMMAND_TYPES,
  NOTE_AUDIENCE_MAX,
  NOTIFICATIONS_READ_MAX,
  alertAcknowledgePayloadSchema,
  alertDismissPayloadSchema,
  alertResolvePayloadSchema,
  alertRuleSetPayloadSchema,
  noteAcknowledgePayloadSchema,
  noteArchivePayloadSchema,
  noteDraftSavePayloadSchema,
  notePublishPayloadSchema,
  notificationReadPayloadSchema,
  pushSubscribePayloadSchema,
  pushUnsubscribePayloadSchema,
} from './communication-commands.js';
import { commandTypeSchema } from './command-envelope.js';

const A = '0198c3a0-1111-7aaa-8bbb-000000000001';
const B = '0198c3a0-2222-7aaa-8bbb-000000000002';

describe('alertes', () => {
  it('prise en compte : commentaire facultatif ; résolution : commentaire obligatoire ; écart : motif', () => {
    expect(alertAcknowledgePayloadSchema.safeParse({}).success).toBe(true);
    expect(alertAcknowledgePayloadSchema.safeParse({ comment: 'Vu' }).success).toBe(true);
    expect(alertResolvePayloadSchema.safeParse({}).success).toBe(false);
    expect(alertResolvePayloadSchema.safeParse({ comment: '   ' }).success).toBe(false);
    expect(alertResolvePayloadSchema.safeParse({ comment: 'Régularisé' }).success).toBe(true);
    expect(alertDismissPayloadSchema.safeParse({ reason: 'Faux positif' }).success).toBe(true);
    expect(alertDismissPayloadSchema.safeParse({}).success).toBe(false);
    expect(alertResolvePayloadSchema.safeParse({ comment: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('règles d’alerte', () => {
  it('au moins un champ à modifier ; le type d’alerte est du catalogue', () => {
    expect(alertRuleSetPayloadSchema.safeParse({ alertType: 'STOCK_LOW' }).success).toBe(false);
    expect(
      alertRuleSetPayloadSchema.safeParse({ alertType: 'STOCK_LOW', enabled: false }).success,
    ).toBe(true);
    expect(
      alertRuleSetPayloadSchema.safeParse({ alertType: 'NOT_A_TYPE', enabled: true }).success,
    ).toBe(false);
  });

  it('gravité, mode de résolution, délai d’escalade (1 à 168 h) et rôles', () => {
    expect(
      alertRuleSetPayloadSchema.safeParse({
        alertType: 'HIGH_LOSS',
        severity: 'CRITICAL',
        resolutionMode: 'MANUAL',
        escalationHours: 4,
        escalationRoles: ['DIRECTION'],
        recipientRoles: ['RESP_FERME', 'DIRECTION'],
      }).success,
    ).toBe(true);
    for (const bad of [
      { severity: 'FATAL' },
      { escalationHours: 0 },
      { escalationHours: 169 },
      { escalationHours: 1.5 },
      { recipientRoles: [] },
      { recipientRoles: ['direction'] },
      { resolutionMode: 'NEVER' },
    ]) {
      expect(alertRuleSetPayloadSchema.safeParse({ alertType: 'HIGH_LOSS', ...bad }).success).toBe(
        false,
      );
    }
    // Retirer l'escalade : `null` est un changement.
    expect(
      alertRuleSetPayloadSchema.safeParse({ alertType: 'HIGH_LOSS', escalationHours: null })
        .success,
    ).toBe(true);
  });
});

describe('notifications et abonnement push', () => {
  it('marquer lues : des identifiants, ou toutes — jamais les deux ni aucun', () => {
    expect(notificationReadPayloadSchema.safeParse({ notificationIds: [A, B] }).success).toBe(true);
    expect(notificationReadPayloadSchema.safeParse({ all: true }).success).toBe(true);
    expect(notificationReadPayloadSchema.safeParse({}).success).toBe(false);
    expect(
      notificationReadPayloadSchema.safeParse({ notificationIds: [A], all: true }).success,
    ).toBe(false);
    expect(notificationReadPayloadSchema.safeParse({ notificationIds: [] }).success).toBe(false);
    expect(notificationReadPayloadSchema.safeParse({ all: false }).success).toBe(false);
    const tooMany = Array.from({ length: NOTIFICATIONS_READ_MAX + 1 }, () => A);
    expect(notificationReadPayloadSchema.safeParse({ notificationIds: tooMany }).success).toBe(
      false,
    );
  });

  it('abonnement Web Push : point de terminaison URL et clés', () => {
    const subscription = {
      endpoint: 'https://push.example.org/send/abc',
      keys: { p256dh: 'BPk', auth: 'sec' },
    };
    expect(pushSubscribePayloadSchema.safeParse(subscription).success).toBe(true);
    expect(
      pushSubscribePayloadSchema.safeParse({ ...subscription, endpoint: 'pas une url' }).success,
    ).toBe(false);
    expect(pushSubscribePayloadSchema.safeParse({ endpoint: subscription.endpoint }).success).toBe(
      false,
    );
    expect(
      pushUnsubscribePayloadSchema.safeParse({ endpoint: subscription.endpoint }).success,
    ).toBe(true);
  });
});

describe('notes de direction', () => {
  const note = {
    title: 'Nouveau prix du poulet',
    body: 'À partir de lundi, le poulet vif passe à 3 500 XAF le kilo.',
    category: 'PRIX',
    requiresAck: true,
    audience: [
      { type: 'ROLE', ref: 'VENDEUR_PDV' },
      { type: 'SITE', ref: A },
    ],
  };

  it('publication : audience non vide, catégories du dictionnaire, accusé requis explicite', () => {
    expect(notePublishPayloadSchema.safeParse(note).success).toBe(true);
    expect(notePublishPayloadSchema.safeParse({ ...note, audience: [] }).success).toBe(false);
    expect(notePublishPayloadSchema.safeParse({ ...note, category: 'RUMEUR' }).success).toBe(false);
    expect(notePublishPayloadSchema.safeParse({ ...note, title: '  ' }).success).toBe(false);
    const withoutAck: Record<string, unknown> = { ...note };
    delete withoutAck['requiresAck'];
    expect(notePublishPayloadSchema.safeParse(withoutAck).success).toBe(false);
  });

  it('audience : « tous » sans référence, les autres avec référence valide', () => {
    expect(
      notePublishPayloadSchema.safeParse({ ...note, audience: [{ type: 'ALL' }] }).success,
    ).toBe(true);
    for (const entry of [
      { type: 'ROLE' },
      { type: 'ROLE', ref: 'vendeur' },
      { type: 'SITE', ref: 'pas-un-uuid' },
      { type: 'USER', ref: 'x' },
      { type: 'GROUP', ref: A },
    ]) {
      expect(notePublishPayloadSchema.safeParse({ ...note, audience: [entry] }).success).toBe(
        false,
      );
    }
    const tooMany = Array.from({ length: NOTE_AUDIENCE_MAX + 1 }, () => ({ type: 'ALL' as const }));
    expect(notePublishPayloadSchema.safeParse({ ...note, audience: tooMany }).success).toBe(false);
  });

  it('référence : le type et l’identifiant de l’objet vont ensemble', () => {
    expect(
      notePublishPayloadSchema.safeParse({
        ...note,
        relatedEntityType: 'PRICE_RULE',
        relatedEntityId: A,
      }).success,
    ).toBe(true);
    expect(
      notePublishPayloadSchema.safeParse({ ...note, relatedEntityType: 'PRICE_RULE' }).success,
    ).toBe(false);
    expect(notePublishPayloadSchema.safeParse({ ...note, relatedEntityId: A }).success).toBe(false);
    expect(noteDraftSavePayloadSchema.safeParse(note).success).toBe(true);
    expect(
      noteDraftSavePayloadSchema.safeParse({ ...note, relatedEntityType: 'PRICE_RULE' }).success,
    ).toBe(false);
  });

  it('expiration : un instant avec décalage', () => {
    expect(
      notePublishPayloadSchema.safeParse({ ...note, expiresAt: '2026-11-01T00:00:00.000Z' })
        .success,
    ).toBe(true);
    expect(notePublishPayloadSchema.safeParse({ ...note, expiresAt: 'demain' }).success).toBe(
      false,
    );
  });

  it('archivage : motif obligatoire ; accusé : par défaut un accusé', () => {
    expect(noteArchivePayloadSchema.safeParse({}).success).toBe(false);
    expect(
      noteArchivePayloadSchema.safeParse({ reason: 'Remplacée par une note corrective' }).success,
    ).toBe(true);
    expect(noteAcknowledgePayloadSchema.parse({})).toEqual({ kind: 'ACKNOWLEDGE' });
    expect(noteAcknowledgePayloadSchema.parse({ kind: 'READ' })).toEqual({ kind: 'READ' });
    expect(noteAcknowledgePayloadSchema.safeParse({ kind: 'IGNORE' }).success).toBe(false);
  });
});

describe('types de commande', () => {
  it('respectent la forme <module>.<agrégat>.<verbe> du registre', () => {
    for (const type of Object.values(COMMUNICATION_COMMAND_TYPES)) {
      expect(commandTypeSchema.safeParse(type).success).toBe(true);
      expect(type.startsWith('communication.')).toBe(true);
    }
  });
});
