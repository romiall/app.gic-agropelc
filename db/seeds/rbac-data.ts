// STUB TEMPORAIRE — remplacé par la matrice RBAC réelle (docs/07-security-rbac/01-rbac.md)
// avant la fin de P0-05. Sert uniquement à valider la mécanique de seeds/run.ts.
export interface RoleSeed {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly allowedScopeTypes: readonly string[];
}

export interface PermissionSeed {
  readonly code: string;
  readonly module: string;
  readonly description: string;
  readonly supportedScopes: readonly string[];
  readonly isApproval: boolean;
  readonly isSensitive: boolean;
}

export interface RolePermissionSeed {
  readonly roleCode: string;
  readonly permissionCode: string;
  readonly maxScope: string;
  readonly limits?: Record<string, unknown>;
}

export interface RoleDiscountSetting {
  readonly key: string;
  readonly value: number;
  readonly ref: string;
}

export const ROLES: readonly RoleSeed[] = [
  { code: 'ADMIN', name: 'Administrateur', description: 'stub', allowedScopeTypes: ['GLOBAL'] },
];

export const PERMISSIONS: readonly PermissionSeed[] = [
  {
    code: 'identity.user.create',
    module: 'identity',
    description: 'stub',
    supportedScopes: ['ALL'],
    isApproval: false,
    isSensitive: true,
  },
];

export const ROLE_PERMISSIONS: readonly RolePermissionSeed[] = [
  { roleCode: 'ADMIN', permissionCode: 'identity.user.create', maxScope: 'ALL' },
];

export const ROLE_DISCOUNT_SETTINGS: readonly RoleDiscountSetting[] = [];
