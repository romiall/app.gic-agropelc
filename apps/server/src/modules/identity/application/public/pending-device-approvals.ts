/**
 * Appareils en attente qu'un décideur peut approuver (MP-06 ; AV-247, AV-258, décisions du porteur du
 * 13/10/2026) : alimente le signal `DEVICES_PENDING` de l'accueil des responsables, qui approuvent comme
 * l'Admin dans leur portée. Même règle que la commande `identity.device.approve` : appareil dans la portée
 * de la permission (`deviceInScope`), sauf l'appareil que le décideur a lui-même connecté (sauf l'Admin).
 *
 * Les appareils en attente sont peu nombreux (un par personne qui se connecte pour la première fois) ; la
 * lecture s'arrête au-delà de `PAGE_SIZE × MAX_PAGES` et le signale (`capped`).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import type { ResourceLocator } from '../rbac/scope-evaluation.js';
import { listDevicesPage } from './device-query.js';
import {
  enrollerLocators,
  isSelfApproval,
  locatorsInScope,
  withDesignatedSite,
} from './device-scope.js';
import { hasPermissionAt } from './rights-check.js';

type Executor = Kysely<DB> | Transaction<DB>;

const DEVICE_APPROVE = 'identity.device.approve';
const PAGE_SIZE = 200;
const MAX_PAGES = 5;

export interface PendingDeviceApprovals {
  readonly count: number;
  /** Lecture arrêtée avant la fin : `count` est un minimum. */
  readonly capped: boolean;
}

export async function pendingDeviceApprovalsFor(
  executor: Executor,
  input: { readonly userId: string; readonly at: Date },
): Promise<PendingDeviceApprovals> {
  if (!(await hasPermissionAt(executor, toBin(input.userId), DEVICE_APPROVE, input.at))) {
    return { count: 0, capped: false };
  }
  const enrollers = new Map<string, Promise<readonly ResourceLocator[]>>();
  let count = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const read = await listDevicesPage(executor, {
      status: 'PENDING',
      ...(cursor !== undefined ? { beforeId: cursor } : {}),
      limit: PAGE_SIZE,
    });
    for (const device of read.items) {
      let locators = enrollers.get(device.enrolledByUserId);
      if (!locators) {
        locators = enrollerLocators(executor, device.enrolledByUserId, input.at);
        enrollers.set(device.enrolledByUserId, locators);
      }
      const inScope = await locatorsInScope(executor, {
        userId: input.userId,
        permissionCode: DEVICE_APPROVE,
        at: input.at,
        locators: withDesignatedSite(await locators, device.designatedSiteId),
      });
      if (!inScope) continue;
      const self = await isSelfApproval(executor, {
        authorUserId: input.userId,
        enrolledByUserId: device.enrolledByUserId,
        at: input.at,
      });
      if (!self) count += 1;
    }
    if (read.nextCursor === null) return { count, capped: false };
    cursor = read.nextCursor;
  }
  return { count, capped: true };
}
