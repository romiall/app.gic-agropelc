import { describe, expect, it } from 'vitest';
import {
  grantableScopes,
  heldScopesCover,
  judgeRolePermissionChange,
  scopeCovers,
} from './role-permissions.js';

const base = {
  roleCode: 'RESP_COMMERCIAL',
  permissionCode: 'finance.expense.approve',
  supportedScopes: ['OWN', 'SITE', 'ZONE', 'ALL'],
} as const;

describe('droits des rôles modifiables dans l’application (ADR-072, Q28)', () => {
  it('portées : ALL couvre tout, une portée se couvre, toute portée couvre OWN, SITE et ZONE ne se couvrent pas', () => {
    expect(scopeCovers('ALL', 'ZONE')).toBe(true);
    expect(scopeCovers('SITE', 'SITE')).toBe(true);
    expect(scopeCovers('TEAM', 'OWN')).toBe(true);
    expect(scopeCovers('SITE', 'ZONE')).toBe(false);
    expect(scopeCovers('OWN', 'SITE')).toBe(false);
    expect(heldScopesCover([], 'OWN')).toBe(false);
  });

  it('on ne donne que ce qu’on a : octroi ou élargissement refusés au-delà de la portée de l’auteur', () => {
    expect(
      judgeRolePermissionChange({
        ...base,
        current: null,
        requested: 'ZONE',
        editorScopes: ['ALL'],
      }),
    ).toEqual({ ok: true, changeType: 'GRANT' });
    expect(
      judgeRolePermissionChange({
        ...base,
        current: null,
        requested: 'ZONE',
        editorScopes: ['SITE'],
      }),
    ).toEqual({ ok: false, refusal: 'NOT_HELD' });
    expect(
      judgeRolePermissionChange({ ...base, current: null, requested: 'OWN', editorScopes: [] }),
    ).toEqual({ ok: false, refusal: 'NOT_HELD' });
    expect(
      judgeRolePermissionChange({
        ...base,
        current: 'OWN',
        requested: 'SITE',
        editorScopes: ['SITE'],
      }),
    ).toEqual({ ok: true, changeType: 'SCOPE' });
  });

  it('on ne retire que ce qu’on aurait pu donner : retrait d’une portée plus large que celle de l’auteur refusé', () => {
    expect(
      judgeRolePermissionChange({
        ...base,
        current: 'ALL',
        requested: null,
        editorScopes: ['SITE'],
      }),
    ).toEqual({ ok: false, refusal: 'NOT_HELD' });
    expect(
      judgeRolePermissionChange({
        ...base,
        current: 'SITE',
        requested: null,
        editorScopes: ['ALL'],
      }),
    ).toEqual({ ok: true, changeType: 'REVOKE' });
    expect(
      judgeRolePermissionChange({
        ...base,
        current: 'ALL',
        requested: 'SITE',
        editorScopes: ['SITE'],
      }),
    ).toEqual({ ok: false, refusal: 'NOT_HELD' });
  });

  it('rôle ADMIN figé, droit de modifier les droits jamais modifiable, portée non admise, aucun changement', () => {
    const all = ['ALL'] as const;
    expect(
      judgeRolePermissionChange({
        ...base,
        roleCode: 'ADMIN',
        current: null,
        requested: 'ALL',
        editorScopes: all,
      }),
    ).toEqual({ ok: false, refusal: 'ROLE_PROTECTED' });
    expect(
      judgeRolePermissionChange({
        ...base,
        permissionCode: 'identity.role.manage',
        current: null,
        requested: 'ALL',
        editorScopes: all,
      }),
    ).toEqual({ ok: false, refusal: 'PERMISSION_PROTECTED' });
    expect(
      judgeRolePermissionChange({ ...base, current: null, requested: 'TEAM', editorScopes: all }),
    ).toEqual({ ok: false, refusal: 'SCOPE_NOT_SUPPORTED' });
    expect(
      judgeRolePermissionChange({ ...base, current: 'SITE', requested: 'SITE', editorScopes: all }),
    ).toEqual({ ok: false, refusal: 'NO_CHANGE' });
    expect(
      judgeRolePermissionChange({ ...base, current: null, requested: null, editorScopes: all }),
    ).toEqual({ ok: false, refusal: 'NO_CHANGE' });
  });

  it('portées proposées par l’éditeur : admises par la permission et couvertes par l’auteur', () => {
    expect(grantableScopes(['OWN', 'SITE', 'ALL'], ['SITE'])).toEqual(['OWN', 'SITE']);
    expect(grantableScopes(['OWN', 'SITE', 'ALL'], ['ALL'])).toEqual(['OWN', 'SITE', 'ALL']);
    expect(grantableScopes(['ALL'], [])).toEqual([]);
  });
});
