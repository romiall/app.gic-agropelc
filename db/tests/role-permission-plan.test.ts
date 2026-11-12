import { describe, expect, it } from 'vitest';
import { planRolePermissionSeed, rolePermissionKey } from '../seeds/role-permission-plan.js';

// ADR-072 (Q28) : la graine ne revient jamais sur un droit changé dans l'application.
describe('graine des droits des rôles et changements faits dans l’application', () => {
  const grants = [
    { roleCode: 'DIRECTION', permissionCode: 'finance.expense.approve' },
    { roleCode: 'DIRECTION', permissionCode: 'identity.role.manage' },
    { roleCode: 'RESP_FERME', permissionCode: 'finance.expense.approve' },
  ];
  const ids: Record<string, string> = { DIRECTION: 'aa01', RESP_FERME: 'bb02' };

  it('un couple (rôle, permission) changé dans l’application est laissé tel quel ; les autres sont posés', () => {
    const plan = planRolePermissionSeed(
      grants,
      (roleCode) => ids[roleCode]!,
      new Set([rolePermissionKey('AA01', 'finance.expense.approve')]),
    );
    expect(plan.kept).toEqual([grants[0]]);
    expect(plan.toWrite).toEqual([grants[1], grants[2]]);
  });

  it('la clé ignore la casse de l’identifiant hexadécimal du rôle', () => {
    expect(rolePermissionKey('aa01', 'x')).toBe(rolePermissionKey('AA01', 'x'));
  });

  it('sans changement dans l’application, tout est posé', () => {
    const plan = planRolePermissionSeed(grants, (roleCode) => ids[roleCode]!, new Set());
    expect(plan.kept).toEqual([]);
    expect(plan.toWrite).toEqual(grants);
  });
});
