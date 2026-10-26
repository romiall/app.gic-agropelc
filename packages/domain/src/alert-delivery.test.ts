import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ESCALATION_HOURS,
  DEFAULT_PUSH_GROUP_MINUTES,
  NOTIFICATION_BODY_MAX,
  escalationDueAt,
  escalationTitle,
  groupedPushBody,
  isEscalationDue,
  notificationChannelsFor,
  pushGroupDecision,
} from './alert-delivery.js';

const T0 = new Date('2026-10-14T08:00:00.000Z');
const plus = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);

describe('canaux par gravité (BR-NOT-004, AV-364)', () => {
  it('INFO : centre d’alertes seulement ; WARNING : in-app ; CRITICAL : in-app et push', () => {
    expect(notificationChannelsFor('INFO')).toEqual([]);
    expect(notificationChannelsFor('WARNING')).toEqual(['IN_APP']);
    expect(notificationChannelsFor('CRITICAL')).toEqual(['IN_APP', 'WEB_PUSH']);
  });
});

describe('regroupement des push (D13 §14, AV-366)', () => {
  it('le premier push d’un couple part', () => {
    expect(pushGroupDecision({ lastPushAt: null, now: T0, groupMinutes: 15 })).toEqual({
      send: true,
    });
  });

  it('un push dans le créneau est retenu et indique le créneau suivant', () => {
    expect(pushGroupDecision({ lastPushAt: T0, now: plus(T0, 14), groupMinutes: 15 })).toEqual({
      send: false,
      nextSlotAt: plus(T0, 15),
    });
  });

  it('à l’instant exact du créneau suivant, le push part', () => {
    expect(pushGroupDecision({ lastPushAt: T0, now: plus(T0, 15), groupMinutes: 15 })).toEqual({
      send: true,
    });
  });

  it('un créneau invalide retombe sur la valeur par défaut de 15 minutes', () => {
    for (const groupMinutes of [0, -5, Number.NaN]) {
      expect(pushGroupDecision({ lastPushAt: T0, now: plus(T0, 10), groupMinutes })).toMatchObject({
        send: false,
        nextSlotAt: plus(T0, DEFAULT_PUSH_GROUP_MINUTES),
      });
    }
  });
});

describe('escalade (BR-NOT-005, ADR-062 §7)', () => {
  const critical = {
    status: 'OPEN' as const,
    severity: 'CRITICAL' as const,
    criticalSince: T0,
    escalatedAt: null,
  };

  it('échéance = critical_since + escalation_hours ; défaut 4 h', () => {
    expect(escalationDueAt(T0, 6)).toEqual(plus(T0, 360));
    expect(escalationDueAt(T0, 0)).toEqual(plus(T0, DEFAULT_ESCALATION_HOURS * 60));
  });

  it('due à l’échéance exacte, pas avant', () => {
    expect(isEscalationDue(critical, 4, plus(T0, 239))).toBe(false);
    expect(isEscalationDue(critical, 4, plus(T0, 240))).toBe(true);
  });

  it('jamais deux fois, jamais après une prise en compte ou une résolution', () => {
    const late = plus(T0, 600);
    expect(isEscalationDue({ ...critical, escalatedAt: plus(T0, 250) }, 4, late)).toBe(false);
    expect(isEscalationDue({ ...critical, status: 'ACKNOWLEDGED' }, 4, late)).toBe(false);
    expect(isEscalationDue({ ...critical, status: 'RESOLVED' }, 4, late)).toBe(false);
  });

  it('ne concerne que les alertes critiques, mesurées depuis le relèvement', () => {
    const late = plus(T0, 600);
    expect(isEscalationDue({ ...critical, severity: 'WARNING' }, 4, late)).toBe(false);
    expect(isEscalationDue({ ...critical, criticalSince: null }, 4, late)).toBe(false);
    // Relevée à CRITICAL tard : l'échéance part du relèvement, pas de la première détection.
    expect(isEscalationDue({ ...critical, criticalSince: plus(T0, 500) }, 4, late)).toBe(false);
  });
});

describe('textes des notifications (ADR-062 §6, §7 ; AV-366)', () => {
  it('l’escalade est un autre message que la levée', () => {
    expect(escalationTitle('Perte anormale')).toBe('Escalade : Perte anormale');
  });

  it('le push d’un nouveau créneau compte les alertes tues, au pluriel quand il le faut', () => {
    expect(groupedPushBody('Stock bas', 0)).toBe('Stock bas');
    expect(groupedPushBody('Stock bas', -2)).toBe('Stock bas');
    expect(groupedPushBody('Stock bas', Number.NaN)).toBe('Stock bas');
    expect(groupedPushBody('Stock bas', 1)).toBe('Stock bas (+1 autre alerte de ce type)');
    expect(groupedPushBody('Stock bas', 3)).toBe('Stock bas (+3 autres alertes de ce type)');
  });

  it('le corps regroupé ne dépasse jamais la colonne, le décompte est conservé', () => {
    const body = 'x'.repeat(NOTIFICATION_BODY_MAX);
    const grouped = groupedPushBody(body, 12);
    expect(grouped).toHaveLength(NOTIFICATION_BODY_MAX);
    expect(grouped.endsWith('(+12 autres alertes de ce type)')).toBe(true);
  });
});
