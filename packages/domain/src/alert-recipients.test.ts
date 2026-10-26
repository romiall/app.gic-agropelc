import { describe, expect, it } from 'vitest';
import {
  FALLBACK_RECIPIENT_ROLE,
  effectiveRecipientRoles,
  mergeRecipients,
  planRecipients,
  recipientsToAdd,
  type RecipientCandidate,
} from './alert-recipients.js';

const user = (id: string, origin: RecipientCandidate['origin'], roleCode: string | null = null) =>
  ({ userId: id, origin, roleCode }) satisfies RecipientCandidate;

describe('rôles effectifs d’une levée (AV-393)', () => {
  const catalogRoles = ['FINANCE'];

  it('règle jamais modifiée : le déclencheur a ses propres rôles', () => {
    expect(
      effectiveRecipientRoles({
        ruleRoles: ['FINANCE'],
        catalogRoles,
        triggerRoles: ['RESP_COMMERCIAL'],
      }),
    ).toEqual(['RESP_COMMERCIAL']);
  });

  it('règle modifiée par un administrateur : elle vaut pour tout le type', () => {
    expect(
      effectiveRecipientRoles({
        ruleRoles: ['FINANCE', 'DIRECTION'],
        catalogRoles,
        triggerRoles: ['RESP_COMMERCIAL'],
      }),
    ).toEqual(['FINANCE', 'DIRECTION']);
  });

  it('l’ordre et les doublons de la règle ne comptent pas pour savoir si elle a été modifiée', () => {
    expect(
      effectiveRecipientRoles({
        ruleRoles: ['B', 'A', 'A'],
        catalogRoles: ['A', 'B'],
        triggerRoles: ['C'],
      }),
    ).toEqual(['C']);
  });

  it('même nombre de rôles mais contenu différent : la règle a été modifiée', () => {
    expect(
      effectiveRecipientRoles({
        ruleRoles: ['A', 'C'],
        catalogRoles: ['A', 'B'],
        triggerRoles: ['D'],
      }),
    ).toEqual(['A', 'C']);
  });

  it('une règle plus petite que le catalogue est une modification', () => {
    expect(
      effectiveRecipientRoles({
        ruleRoles: ['A'],
        catalogRoles: ['A', 'B'],
        triggerRoles: ['C'],
      }),
    ).toEqual(['A']);
  });
});

describe('fusion et repli (ADR-062 §1)', () => {
  it('un utilisateur n’a qu’une ligne : la première origine l’emporte, l’ordre est stable', () => {
    const merged = mergeRecipients([
      user('u1', 'RULE', 'MAGASINIER'),
      user('u2', 'RULE', 'MAGASINIER'),
      user('u1', 'OWNER'),
      user('u3', 'TEAM_MANAGER'),
      user('u2', 'APPROVER'),
    ]);
    expect(merged).toEqual([
      user('u1', 'RULE', 'MAGASINIER'),
      user('u2', 'RULE', 'MAGASINIER'),
      user('u3', 'TEAM_MANAGER'),
    ]);
  });

  it('à défaut de tout destinataire, la Direction reçoit, marquée « repli »', () => {
    const plan = planRecipients({
      primary: [],
      fallback: [user('d1', 'RULE', FALLBACK_RECIPIENT_ROLE), user('d1', 'RULE', 'DIRECTION')],
    });
    expect(plan.fallbackUsed).toBe(true);
    expect(plan.recipients).toEqual([user('d1', 'FALLBACK', FALLBACK_RECIPIENT_ROLE)]);
  });

  it('un seul destinataire principal suffit : pas de repli', () => {
    const plan = planRecipients({
      primary: [user('u1', 'OWNER')],
      fallback: [user('d1', 'RULE', 'DIRECTION')],
    });
    expect(plan).toEqual({ recipients: [user('u1', 'OWNER')], fallbackUsed: false });
  });

  it('personne nulle part : liste vide, repli signalé', () => {
    expect(planRecipients({ primary: [], fallback: [] })).toEqual({
      recipients: [],
      fallbackUsed: true,
    });
  });

  it('une occurrence suivante n’ajoute que les destinataires manquants', () => {
    const planned = [user('u1', 'RULE', 'MAGASINIER'), user('u2', 'RULE', 'MAGASINIER')];
    expect(recipientsToAdd(planned, new Set(['u1']))).toEqual([planned[1]]);
    expect(recipientsToAdd(planned, new Set(['u1', 'u2']))).toEqual([]);
    expect(recipientsToAdd([], new Set(['u1']))).toEqual([]);
  });
});
