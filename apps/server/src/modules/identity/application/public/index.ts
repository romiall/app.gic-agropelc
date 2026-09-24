/**
 * API publique du module `identity` (01-architecture-logicielle.md §3, règle 1) : seul
 * point d'import autorisé depuis un autre module (`commands/`, transport, per
 * .dependency-cruiser.cjs). Portée P0-06 (coutures RC-01/RC-02) — P0-09 complète ce module
 * (utilisateurs, appareils, sessions, `/auth/*`) sans déplacer ces exports.
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

export { hasPermissionAt } from './rights-check.js';
