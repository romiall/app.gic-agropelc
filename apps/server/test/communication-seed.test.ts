// Règles d'alerte semées et paramètres des détecteurs (P9-03 ; D13 §7.1 ; ADR-071 §8 ; AV-400, AV-402) :
// le seed (`db/seeds/communication-references.ts`, sans dépendance au domaine) doit rester égal au
// catalogue du domaine (`ALERT_CATALOG`), et chaque seuil cité par le catalogue doit exister dans les
// paramètres système semés. Aucune base de données : la dérive est une erreur de dépôt, pas d'exécution.
import { describe, expect, it } from 'vitest';
import { ALERT_CATALOG, ALERT_TYPES, DEFAULT_ESCALATION_HOURS } from '@gic/domain';
import { ALERT_RULES } from '../../../db/seeds/communication-references.js';
import { ROLES } from '../../../db/seeds/rbac-data.js';
import { SYSTEM_SETTINGS } from '../../../db/seeds/system-settings.js';

const ROLE_CODES = new Set(ROLES.map((role) => role.code));
const SETTING_KEYS = new Set(SYSTEM_SETTINGS.map((setting) => setting.key));

describe('règles d’alerte semées = catalogue du domaine', () => {
  it('une règle par type du catalogue, dans le même ordre, sans doublon', () => {
    expect(ALERT_RULES.map((rule) => rule.alertType)).toEqual([...ALERT_TYPES]);
    expect(new Set(ALERT_RULES.map((rule) => rule.alertType)).size).toBe(ALERT_RULES.length);
  });

  it.each(ALERT_RULES.map((rule) => [rule.alertType, rule] as const))(
    '%s : gravité, destinataires, résolution et escalade du catalogue',
    (_type, rule) => {
      const definition = ALERT_CATALOG[rule.alertType as keyof typeof ALERT_CATALOG];
      expect(rule.severity).toBe(definition.defaultSeverity);
      expect([...rule.recipientRoles]).toEqual([...definition.recipientRoles]);
      expect(rule.resolutionMode).toBe(definition.resolution);
      expect(rule.escalationHours).toBe(definition.escalationHours);
      // Seule la règle sans source disponible est semée désactivée.
      expect(rule.enabled).toBe(definition.sourceAvailable);
    },
  );

  it('les rôles destinataires et d’escalade existent', () => {
    for (const rule of ALERT_RULES) {
      for (const role of [...rule.recipientRoles, ...rule.escalationRoles]) {
        expect(ROLE_CODES.has(role), `${rule.alertType} : rôle ${role}`).toBe(true);
      }
      if (rule.escalationHours !== null) {
        expect(rule.escalationRoles.length).toBeGreaterThan(0);
      }
    }
    // Les rôles cités par un déclencheur propre existent aussi.
    for (const type of ALERT_TYPES) {
      for (const trigger of ALERT_CATALOG[type].raisedBy) {
        for (const role of trigger.recipientRoles ?? []) {
          expect(ROLE_CODES.has(role), `${type} : rôle ${role}`).toBe(true);
        }
      }
    }
  });

  it('le délai d’escalade par défaut du domaine est celui du seed (BR-NOT-005)', () => {
    for (const rule of ALERT_RULES) {
      if (rule.escalationHours !== null)
        expect(rule.escalationHours).toBe(DEFAULT_ESCALATION_HOURS);
    }
  });
});

describe('paramètres des détecteurs', () => {
  it('chaque seuil cité par le catalogue est un paramètre système semé (règle 8 de CLAUDE.md)', () => {
    for (const type of ALERT_TYPES) {
      for (const key of ALERT_CATALOG[type].settings) {
        expect(SETTING_KEYS.has(key), `${type} : paramètre ${key} absent du seed`).toBe(true);
      }
    }
  });

  it('les durées de rétention et le regroupement des push sont semés (ADR-078 §8, AV-416)', () => {
    for (const key of [
      'communication.push_group_minutes',
      'communication.consumer_lag_alert_seconds',
      'communication.alert_retention_days',
      'communication.notification_retention_days',
    ]) {
      expect(SETTING_KEYS.has(key), key).toBe(true);
    }
    const value = (key: string) => SYSTEM_SETTINGS.find((setting) => setting.key === key)?.value;
    expect(value('communication.push_group_minutes')).toBe(15);
    expect(value('communication.alert_retention_days')).toBe(730);
    expect(value('communication.notification_retention_days')).toBe(90);
    expect(value('approvals.pending_long_hours')).toBe(24);
    expect(value('attachments.missing_alert_days')).toBe(7);
    expect(value('procurement.receipt_incomplete_alert_days')).toBe(2);
  });

  it('aucune clé de paramètre en double', () => {
    expect(SETTING_KEYS.size).toBe(SYSTEM_SETTINGS.length);
  });
});
