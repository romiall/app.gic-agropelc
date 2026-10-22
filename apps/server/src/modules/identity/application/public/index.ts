/**
 * API publique du module `identity` (01-architecture-logicielle.md §3, règle 1) : seul
 * point d'import autorisé depuis un autre module (`commands/`, transport, per
 * .dependency-cruiser.cjs). Portée P0-06 (coutures RC-01/RC-02) — P0-09 complète ce module
 * (utilisateurs, appareils, sessions, `/auth/*`), P0-10 l'évaluation complète des portées
 * (`evaluateAccess`) — sans déplacer les exports déjà stabilisés.
 */
export {
  ACCESS_TOKEN_TTL_MS,
  exportKeyPairToPem,
  generateEphemeralKeyPair,
  loadKeyPairFromPem,
  signAccessToken,
  verifyAccessToken,
} from './jwt.js';
export type { AccessTokenClaims, JwtKeyPair, VerifyAccessTokenResult } from './jwt.js';

export { checkDeviceActive } from './device-check.js';
export type { DeviceCheckResult } from './device-check.js';

export { checkUserActive } from './user-check.js';
export type { UserCheckResult } from './user-check.js';

export {
  hasPermissionAt,
  evaluateAccess,
  evaluateAccessLimits,
  listConfinementAt,
} from './rights-check.js';
export {
  activeZoneAssignmentsAt,
  activeSiteAssignmentsAt,
  activeRoleCodesAt,
  activeRoleAssignmentsAt,
} from './assignment-query.js';
export type { ActiveAssignment } from './assignment-query.js';
export type {
  AccessResult,
  EvaluateAccessInput,
  ListConfinement,
  ResourceLocator,
} from './rights-check.js';

export { deviceUserCounts, userFullName, userFullNames } from './user-summary.js';
// MP-08 (ECR-ADM-04 partiel) : lecture des comptes pour `GET /users`.
export { USER_STATUSES, listUsersPage } from './user-query.js';
export type { UserStatus, UserSummary } from './user-query.js';
export type { DeviceUserCounts } from './user-summary.js';

// MP-06 (ECR-ADM-05 ; AV-247, AV-258 à AV-260) : lecture des appareils et portée partagée par la lecture
// et les commandes `identity.device.*`.
export { DEVICE_STATUSES, findDevice, listDevicesPage } from './device-query.js';
export type { DeviceStatus, DeviceSummary } from './device-query.js';
export {
  deviceInScope,
  deviceResourceLocators,
  enrollerLocators,
  isSelfApproval,
  locatorsInScope,
  siteInScope,
  withDesignatedSite,
} from './device-scope.js';
export type { DeviceScopeAnchor } from './device-scope.js';
export { pendingDeviceApprovalsFor } from './pending-device-approvals.js';
export type { PendingDeviceApprovals } from './pending-device-approvals.js';

// P9-19 : rôles actifs désignés par le partage d'une vue sauvegardée.
export { unknownRoleCodes } from './role-codes.js';
