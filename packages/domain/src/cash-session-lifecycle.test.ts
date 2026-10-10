import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CASH_FORCED_VARIANCE_IMPUTATION_DEFAULT,
  CASH_SESSION_CLOSE_BEFORE_OPEN_DEFAULT,
  CASH_SESSION_PREVIOUS_DAY_OVERLAP_DEFAULT,
  cashSessionOpenLongerThan,
  cashVarianceImputedUser,
  countsInOpeningBalance,
  normalizedSessionsPerDay,
  planCashSessionClose,
  planCashSessionOpen,
  sessionStatusAfterClose,
  type ExistingCashSession,
} from './cash-session-lifecycle.js';
import { cashSessionWindowsOverlap } from './cash-session.js';

const at = (iso: string) => new Date(iso);

const open = (id: string, openedAt: string): ExistingCashSession => ({
  id,
  openedAt: at(openedAt),
  closedAt: null,
  status: 'OPEN',
});
const closed = (
  id: string,
  openedAt: string,
  closedAt: string,
  status: 'PENDING_VALIDATION' | 'VALIDATED' = 'VALIDATED',
): ExistingCashSession => ({ id, openedAt: at(openedAt), closedAt: at(closedAt), status });

describe('planCashSessionOpen : ouverture (AV-154, ADR-032 §2 et §8)', () => {
  it('sans session : création à l’heure saisie', () => {
    expect(
      planCashSessionOpen({
        openedAt: at('2026-10-08T07:00:00Z'),
        capturedOffline: false,
        sessions: [],
        maxSessionsPerDay: 1,
      }),
    ).toEqual({
      kind: 'CREATE',
      openedAt: at('2026-10-08T07:00:00Z'),
      shiftedFrom: null,
      shiftedAfterSessionId: null,
    });
  });

  it('session ouverte : refus CASH_SESSION_ALREADY_OPEN en ligne, fusion hors ligne', () => {
    const sessions = [open('S1', '2026-10-08T07:00:00Z')];
    const base = { openedAt: at('2026-10-08T07:05:00Z'), sessions, maxSessionsPerDay: 1 };
    expect(planCashSessionOpen({ ...base, capturedOffline: false })).toEqual({
      kind: 'REJECT',
      code: 'CASH_SESSION_ALREADY_OPEN',
      targetSessionId: 'S1',
    });
    expect(planCashSessionOpen({ ...base, capturedOffline: true })).toEqual({
      kind: 'MERGE',
      targetSessionId: 'S1',
      reason: 'OPEN_SESSION_EXISTS',
      earlierThanTarget: false,
      consideredOpenedAt: at('2026-10-08T07:05:00Z'),
    });
  });

  it('dans la fenêtre d’une session close du même jour : CASH_SESSION_OVERLAP en ligne, fusion hors ligne', () => {
    const sessions = [closed('S1', '2026-10-08T07:00:00Z', '2026-10-08T17:00:00Z')];
    const base = { openedAt: at('2026-10-08T10:00:00Z'), sessions, maxSessionsPerDay: 2 };
    expect(planCashSessionOpen({ ...base, capturedOffline: false })).toMatchObject({
      kind: 'REJECT',
      code: 'CASH_SESSION_OVERLAP',
      targetSessionId: 'S1',
    });
    expect(planCashSessionOpen({ ...base, capturedOffline: true })).toMatchObject({
      kind: 'MERGE',
      targetSessionId: 'S1',
      reason: 'OVERLAPS_CLOSED_SESSION',
      earlierThanTarget: false,
    });
  });

  it('exactement à la clôture d’une session : aucun chevauchement (fenêtres demi-ouvertes)', () => {
    const sessions = [closed('S1', '2026-10-08T07:00:00Z', '2026-10-08T12:00:00Z')];
    expect(
      planCashSessionOpen({
        openedAt: at('2026-10-08T12:00:00Z'),
        capturedOffline: false,
        sessions,
        maxSessionsPerDay: 2,
      }),
    ).toMatchObject({ kind: 'CREATE', openedAt: at('2026-10-08T12:00:00Z') });
  });

  it('AV-170 : ouverture plus ancienne que la session qu’elle chevauche, fusion dans la plus ancienne en cause', () => {
    const sessions = [
      open('S2', '2026-10-08T08:05:00Z'),
      closed('S0', '2026-10-07T07:00:00Z', '2026-10-07T18:00:00Z'),
    ];
    expect(
      planCashSessionOpen({
        openedAt: at('2026-10-08T07:58:00Z'),
        capturedOffline: true,
        sessions,
        maxSessionsPerDay: 1,
      }),
    ).toEqual({
      kind: 'MERGE',
      targetSessionId: 'S2',
      reason: 'OPEN_SESSION_EXISTS',
      earlierThanTarget: true,
      consideredOpenedAt: at('2026-10-08T07:58:00Z'),
    });
    // Ouverture antérieure à une session close puis à une ouverte : la plus ancienne en cause.
    const twoLater = [
      open('S3', '2026-10-08T14:00:00Z'),
      closed('S2', '2026-10-08T08:00:00Z', '2026-10-08T13:00:00Z'),
    ];
    expect(
      planCashSessionOpen({
        openedAt: at('2026-10-08T07:00:00Z'),
        capturedOffline: true,
        sessions: twoLater,
        maxSessionsPerDay: 5,
      }),
    ).toMatchObject({
      kind: 'MERGE',
      targetSessionId: 'S2',
      reason: 'OVERLAPS_CLOSED_SESSION',
      earlierThanTarget: true,
    });
  });

  it('AV-154 : session de la veille encore ouverte, l’ouverture du jour hors ligne y est fusionnée', () => {
    const sessions = [open('S0', '2026-10-07T07:00:00Z')];
    expect(
      planCashSessionOpen({
        openedAt: at('2026-10-08T07:30:00Z'),
        capturedOffline: true,
        sessions,
        maxSessionsPerDay: 1,
      }),
    ).toMatchObject({ kind: 'MERGE', targetSessionId: 'S0', reason: 'OPEN_SESSION_EXISTS' });
  });

  it('AV-171 (SHIFT, défaut) : session de la veille close d’office après l’heure saisie, ouverture décalée à sa clôture', () => {
    expect(CASH_SESSION_PREVIOUS_DAY_OVERLAP_DEFAULT).toBe('SHIFT');
    const sessions = [
      closed('S0', '2026-10-07T07:00:00Z', '2026-10-08T09:00:00Z', 'PENDING_VALIDATION'),
    ];
    const base = {
      openedAt: at('2026-10-08T06:30:00Z'),
      capturedOffline: true,
      sessions,
      maxSessionsPerDay: 1,
    };
    expect(planCashSessionOpen(base)).toEqual({
      kind: 'CREATE',
      openedAt: at('2026-10-08T09:00:00Z'),
      shiftedFrom: at('2026-10-08T06:30:00Z'),
      shiftedAfterSessionId: 'S0',
    });
    // Mode MERGE : fusion dans la session close (la journée reste sans session).
    expect(planCashSessionOpen({ ...base, previousDayOverlap: 'MERGE' })).toMatchObject({
      kind: 'MERGE',
      targetSessionId: 'S0',
      reason: 'OVERLAPS_CLOSED_SESSION',
      earlierThanTarget: false,
    });
    // En ligne, jamais de décalage : refus.
    expect(planCashSessionOpen({ ...base, capturedOffline: false })).toMatchObject({
      kind: 'REJECT',
      code: 'CASH_SESSION_OVERLAP',
    });
  });

  it('AV-171 : après le décalage, une autre session du jour en cause reçoit la fusion', () => {
    const sessions = [
      closed('S0', '2026-10-07T07:00:00Z', '2026-10-08T09:00:00Z', 'PENDING_VALIDATION'),
      open('S1', '2026-10-08T09:30:00Z'),
    ];
    expect(
      planCashSessionOpen({
        openedAt: at('2026-10-08T06:30:00Z'),
        capturedOffline: true,
        sessions,
        maxSessionsPerDay: 1,
      }),
    ).toEqual({
      kind: 'MERGE',
      targetSessionId: 'S1',
      reason: 'OPEN_SESSION_EXISTS',
      earlierThanTarget: true,
      consideredOpenedAt: at('2026-10-08T09:00:00Z'),
    });
    // Décalage puis limite du jour atteinte par une session close du même jour.
    const limited = [
      closed('S0', '2026-10-07T07:00:00Z', '2026-10-08T09:00:00Z', 'PENDING_VALIDATION'),
      closed('S1', '2026-10-08T09:00:00Z', '2026-10-08T09:20:00Z'),
    ];
    expect(
      planCashSessionOpen({
        openedAt: at('2026-10-08T06:30:00Z'),
        capturedOffline: true,
        sessions: limited,
        maxSessionsPerDay: 1,
      }),
    ).toMatchObject({
      kind: 'MERGE',
      targetSessionId: 'S1',
      reason: 'OVERLAPS_CLOSED_SESSION',
    });
  });

  it('session close du même jour couvrant l’heure saisie : jamais de décalage', () => {
    const sessions = [closed('S1', '2026-10-08T06:00:00Z', '2026-10-08T09:00:00Z')];
    expect(
      planCashSessionOpen({
        openedAt: at('2026-10-08T07:00:00Z'),
        capturedOffline: true,
        sessions,
        maxSessionsPerDay: 3,
      }),
    ).toMatchObject({ kind: 'MERGE', targetSessionId: 'S1' });
  });

  it('limite du jour métier (Africa/Douala) : refus en ligne, fusion dans la plus ancienne du jour hors ligne', () => {
    // 22:30 UTC = 23:30 à Douala, même jour métier que 07:00 UTC.
    const sessions = [
      closed('S2', '2026-10-08T12:00:00Z', '2026-10-08T13:00:00Z'),
      closed('S1', '2026-10-08T07:00:00Z', '2026-10-08T11:00:00Z'),
    ];
    const base = { openedAt: at('2026-10-08T22:30:00Z'), sessions, maxSessionsPerDay: 2 };
    expect(planCashSessionOpen({ ...base, capturedOffline: false })).toEqual({
      kind: 'REJECT',
      code: 'CASH_SESSION_DAILY_LIMIT',
      targetSessionId: 'S1',
    });
    expect(planCashSessionOpen({ ...base, capturedOffline: true })).toMatchObject({
      kind: 'MERGE',
      targetSessionId: 'S1',
      reason: 'DAILY_LIMIT_REACHED',
      earlierThanTarget: false,
    });
    // 23:00 UTC = minuit à Douala : jour suivant, création.
    expect(
      planCashSessionOpen({
        ...base,
        openedAt: at('2026-10-08T23:00:00Z'),
        capturedOffline: false,
      }),
    ).toMatchObject({ kind: 'CREATE' });
    // Limite à 3 : création.
    expect(
      planCashSessionOpen({ ...base, maxSessionsPerDay: 3, capturedOffline: false }),
    ).toMatchObject({ kind: 'CREATE' });
  });

  it('une limite invalide ou inférieure à 1 vaut 1', () => {
    expect(normalizedSessionsPerDay(0)).toBe(1);
    expect(normalizedSessionsPerDay(-3)).toBe(1);
    expect(normalizedSessionsPerDay(Number.NaN)).toBe(1);
    expect(normalizedSessionsPerDay(2.7)).toBe(2);
    const sessions = [closed('S1', '2026-10-08T07:00:00Z', '2026-10-08T08:00:00Z')];
    expect(
      planCashSessionOpen({
        openedAt: at('2026-10-08T09:00:00Z'),
        capturedOffline: false,
        sessions,
        maxSessionsPerDay: 0,
      }),
    ).toMatchObject({ kind: 'REJECT', code: 'CASH_SESSION_DAILY_LIMIT' });
  });

  it('propriété : un plan CREATE ne chevauche jamais une session existante (filet de la base jamais atteint)', () => {
    const base = Date.UTC(2026, 9, 8, 0, 0, 0);
    const hour = 3_600_000;
    const sessionArb = fc
      .tuple(fc.integer({ min: 0, max: 96 }), fc.option(fc.integer({ min: 0, max: 30 })))
      .map(([start, length]) => ({ start, length }));
    fc.assert(
      fc.property(
        fc.array(sessionArb, { maxLength: 6 }),
        fc.integer({ min: 0, max: 120 }),
        fc.boolean(),
        fc.integer({ min: 1, max: 4 }),
        fc.constantFrom('SHIFT' as const, 'MERGE' as const),
        (raw, openHour, offline, maxPerDay, mode) => {
          // Construit des fenêtres disjointes (comme la base les garantit), au plus une ouverte, la dernière.
          const sessions: ExistingCashSession[] = [];
          let cursor = 0;
          raw
            .sort((a, b) => a.start - b.start)
            .forEach((item, index) => {
              const start = Math.max(item.start, cursor);
              const isLast = index === raw.length - 1;
              const length = item.length;
              if (isLast && length === null) {
                sessions.push({
                  id: `S${index}`,
                  openedAt: new Date(base + start * hour),
                  closedAt: null,
                  status: 'OPEN',
                });
                return;
              }
              const end = start + (length ?? 1);
              sessions.push({
                id: `S${index}`,
                openedAt: new Date(base + start * hour),
                closedAt: new Date(base + end * hour),
                status: 'VALIDATED',
              });
              cursor = end;
            });
          const plan = planCashSessionOpen({
            openedAt: new Date(base + openHour * hour),
            capturedOffline: offline,
            sessions,
            maxSessionsPerDay: maxPerDay,
            previousDayOverlap: mode,
          });
          if (plan.kind === 'CREATE') {
            const window = { openedAt: plan.openedAt, closedAt: null };
            expect(sessions.some((session) => cashSessionWindowsOverlap(window, session))).toBe(
              false,
            );
            expect(plan.openedAt.getTime()).toBeGreaterThanOrEqual(base + openHour * hour);
          } else if (plan.kind === 'REJECT') {
            expect(offline).toBe(false);
          } else {
            expect(offline).toBe(true);
            expect(sessions.some((session) => session.id === plan.targetSessionId)).toBe(true);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('countsInOpeningBalance : solde du registre à l’ouverture (ADR-032 §4)', () => {
  const opening = at('2026-10-08T07:00:00Z');
  it('avant l’ouverture : oui ; après : non', () => {
    expect(
      countsInOpeningBalance(
        { occurredAt: at('2026-10-08T06:59:59Z'), movementType: 'CUSTOMER_PAYMENT' },
        opening,
      ),
    ).toBe(true);
    expect(
      countsInOpeningBalance(
        { occurredAt: at('2026-10-08T07:00:01Z'), movementType: 'SESSION_VARIANCE' },
        opening,
      ),
    ).toBe(false);
  });
  it('à l’instant exact : l’écart de la clôture précédente oui, un encaissement non', () => {
    expect(
      countsInOpeningBalance({ occurredAt: opening, movementType: 'SESSION_VARIANCE' }, opening),
    ).toBe(true);
    expect(
      countsInOpeningBalance({ occurredAt: opening, movementType: 'CUSTOMER_PAYMENT' }, opening),
    ).toBe(false);
  });
});

describe('planCashSessionClose : clôture (SM-CASH-SESSION, ADR-032 §8)', () => {
  const session = { openedAt: at('2026-10-08T07:00:00Z'), status: 'OPEN' as const };

  it('session ouverte : clôture à l’heure saisie, borne d’ouverture incluse', () => {
    expect(
      planCashSessionClose({
        session,
        closedAt: at('2026-10-08T18:00:00Z'),
        capturedOffline: false,
      }),
    ).toEqual({ kind: 'CLOSE', closedAt: at('2026-10-08T18:00:00Z'), clampedFrom: null });
    expect(
      planCashSessionClose({ session, closedAt: session.openedAt, capturedOffline: true }),
    ).toMatchObject({ kind: 'CLOSE' });
  });

  it('session déjà close : refus en ligne, observation hors ligne', () => {
    for (const status of ['PENDING_VALIDATION', 'VALIDATED'] as const) {
      const done = { ...session, status };
      expect(
        planCashSessionClose({
          session: done,
          closedAt: at('2026-10-08T18:00:00Z'),
          capturedOffline: false,
        }),
      ).toEqual({ kind: 'REJECT', code: 'CASH_SESSION_NOT_OPEN' });
      expect(
        planCashSessionClose({
          session: done,
          closedAt: at('2026-10-08T18:00:00Z'),
          capturedOffline: true,
        }),
      ).toEqual({ kind: 'OBSERVE', reason: 'ALREADY_CLOSED' });
    }
  });

  it('AV-172 : clôture datée avant l’ouverture — refus en ligne, observation hors ligne (défaut) ou clôture ramenée', () => {
    expect(CASH_SESSION_CLOSE_BEFORE_OPEN_DEFAULT).toBe('OBSERVE');
    const early = at('2026-10-08T06:00:00Z');
    expect(planCashSessionClose({ session, closedAt: early, capturedOffline: false })).toEqual({
      kind: 'REJECT',
      code: 'CASH_SESSION_CLOSE_BEFORE_OPEN',
    });
    expect(planCashSessionClose({ session, closedAt: early, capturedOffline: true })).toEqual({
      kind: 'OBSERVE',
      reason: 'CLOSE_BEFORE_OPEN',
    });
    expect(
      planCashSessionClose({
        session,
        closedAt: early,
        capturedOffline: true,
        beforeOpen: 'CLOSE_AT_OPENING',
      }),
    ).toEqual({ kind: 'CLOSE', closedAt: session.openedAt, clampedFrom: early });
  });
});

describe('sessionStatusAfterClose (AV-057, AV-156)', () => {
  it('écarts nuls : validée d’office', () => {
    expect(
      sessionStatusAfterClose({
        openingVarianceXaf: 0,
        closingVarianceXaf: 0,
        toleranceXaf: 0,
        forced: false,
      }),
    ).toEqual({ status: 'VALIDATED', autoValidated: true });
  });
  it('écart d’ouverture seul : à valider', () => {
    expect(
      sessionStatusAfterClose({
        openingVarianceXaf: 20_000,
        closingVarianceXaf: 0,
        toleranceXaf: 0,
        forced: false,
      }),
    ).toEqual({ status: 'PENDING_VALIDATION', autoValidated: false });
  });
  it('écart de clôture dans la tolérance : validée d’office ; au-delà : à valider', () => {
    expect(
      sessionStatusAfterClose({
        openingVarianceXaf: 0,
        closingVarianceXaf: -500,
        toleranceXaf: 1000,
        forced: false,
      }).status,
    ).toBe('VALIDATED');
    expect(
      sessionStatusAfterClose({
        openingVarianceXaf: 0,
        closingVarianceXaf: -1001,
        toleranceXaf: 1000,
        forced: false,
      }).status,
    ).toBe('PENDING_VALIDATION');
  });
  it('clôture forcée : toujours à valider, même sans écart', () => {
    expect(
      sessionStatusAfterClose({
        openingVarianceXaf: 0,
        closingVarianceXaf: 0,
        toleranceXaf: 0,
        forced: true,
      }),
    ).toEqual({ status: 'PENDING_VALIDATION', autoValidated: false });
  });
  it('tolérance négative : erreur de domaine (celle de statusAfterClose)', () => {
    expect(() =>
      sessionStatusAfterClose({
        openingVarianceXaf: 0,
        closingVarianceXaf: 0,
        toleranceXaf: -1,
        forced: false,
      }),
    ).toThrow(expect.objectContaining({ code: 'TOLERANCE_INVALID' }));
  });
});

describe('cashSessionOpenLongerThan (BR-DIS-006, borne stricte)', () => {
  const opened = at('2026-10-08T07:00:00Z');
  it('plus de 24 h : oui ; exactement 24 h ou moins : non', () => {
    expect(cashSessionOpenLongerThan(opened, at('2026-10-09T07:00:00.001Z'), 24)).toBe(true);
    expect(cashSessionOpenLongerThan(opened, at('2026-10-09T07:00:00Z'), 24)).toBe(false);
    expect(cashSessionOpenLongerThan(opened, at('2026-10-09T06:59:00Z'), 24)).toBe(false);
    expect(cashSessionOpenLongerThan(opened, at('2026-10-08T19:30:00Z'), 12)).toBe(true);
  });
  it('seuil invalide : erreur de domaine', () => {
    expect(() => cashSessionOpenLongerThan(opened, opened, 0)).toThrow(
      expect.objectContaining({ code: 'THRESHOLD_INVALID' }),
    );
    expect(() => cashSessionOpenLongerThan(opened, opened, Number.NaN)).toThrow(
      expect.objectContaining({ code: 'THRESHOLD_INVALID' }),
    );
  });
});

describe('cashVarianceImputedUser (AV-155, AV-173)', () => {
  const base = { openedBy: 'OUVREUR', closedBy: 'CLOTUREUR' };
  it('ouverture : l’ouvreur ; clôture ordinaire : le clôtureur', () => {
    expect(cashVarianceImputedUser({ ...base, kind: 'OPENING', forced: false })).toBe('OUVREUR');
    expect(cashVarianceImputedUser({ ...base, kind: 'CLOSING', forced: false })).toBe('CLOTUREUR');
  });
  it('clôture forcée : l’ouvreur par défaut, sinon selon le mode', () => {
    expect(CASH_FORCED_VARIANCE_IMPUTATION_DEFAULT).toBe('OPENER');
    expect(cashVarianceImputedUser({ ...base, kind: 'CLOSING', forced: true })).toBe('OUVREUR');
    expect(cashVarianceImputedUser({ ...base, kind: 'CLOSING', forced: true }, 'FORCER')).toBe(
      'CLOTUREUR',
    );
    expect(cashVarianceImputedUser({ ...base, kind: 'CLOSING', forced: true }, 'NONE')).toBeNull();
  });
});
