/**
 * Règles pures de l'écran ECR-CRM-06 « Réaffectation de clients » (RP-3 ; UC-CRM-04 ; `crm.customer.reassign`).
 * Filtres, recherche, titulaires éligibles et validation de la commande de réaffectation.
 */
import type { UserData } from '../sales/types.js';

export const REASSIGN_REASON_MAX = 500;
export const CUSTOMERS_PATH = '/api/v1/customers';
export const ACTIVE_USERS_PATH = '/api/v1/users?status=ACTIVE';

export type ReassignStageFilter = 'ALL' | 'PROSPECT' | 'CUSTOMER';

export const REASSIGN_STAGE_FILTERS: readonly ReassignStageFilter[] = [
  'ALL',
  'PROSPECT',
  'CUSTOMER',
];

export interface ReassignCustomerView {
  readonly id: string;
  readonly stage: string;
  readonly customerType: string;
  readonly displayName: string;
  readonly contactName: string | null;
  readonly phonePrimary: string | null;
  readonly zoneId: string;
  readonly ownerUserId: string | null;
  readonly homeSiteId: string | null;
}

export interface CommercialUserOption {
  readonly id: string;
  readonly fullName: string;
  readonly phone: string | null;
}

export interface OnlineUserRow {
  readonly id: string;
  readonly fullName: string;
  readonly phone?: string | null;
  readonly status: string;
  readonly roles?: readonly string[];
}

export interface OnlineTeamRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly managerUserId: string;
  readonly managerName: string | null;
  readonly isActive: boolean;
  readonly members: readonly {
    readonly membershipId: string;
    readonly userId: string;
    readonly since: string;
    readonly fullName: string | null;
  }[];
}

const COMMERCIAL_ROLES = new Set([
  'RESP_COMMERCIAL',
  'COMMERCIAL_TERRAIN',
  'COMMERCIAL_SEDENTAIRE',
]);

/**
 * Fusionne les comptes lus en ligne (`GET /users`), les membres d'équipe (`GET /teams`) et les comptes
 * synchronisés (`refs.users`) pour construire la liste des titulaires proposés et le dictionnaire des noms.
 */
export function buildOwnerCatalog(
  onlineUsers: readonly OnlineUserRow[],
  onlineTeams: readonly OnlineTeamRow[],
  localUsers: readonly UserData[],
): {
  readonly namesById: ReadonlyMap<string, string>;
  readonly options: readonly CommercialUserOption[];
} {
  const names = new Map<string, string>();
  const phones = new Map<string, string | null>();
  const eligibleIds = new Set<string>();

  for (const local of localUsers) {
    names.set(local.id, local.full_name);
    if (local.status === 'ACTIVE') eligibleIds.add(local.id);
  }
  for (const team of onlineTeams) {
    if (team.managerName) names.set(team.managerUserId, team.managerName);
    if (team.isActive) eligibleIds.add(team.managerUserId);
    for (const member of team.members) {
      if (member.fullName) names.set(member.userId, member.fullName);
      if (team.isActive) eligibleIds.add(member.userId);
    }
  }
  for (const user of onlineUsers) {
    names.set(user.id, user.fullName);
    if (user.phone !== undefined) phones.set(user.id, user.phone);
    if (user.status !== 'ACTIVE') {
      eligibleIds.delete(user.id);
      continue;
    }
    const roles = user.roles ?? [];
    if (roles.length === 0 || roles.some((role) => COMMERCIAL_ROLES.has(role))) {
      eligibleIds.add(user.id);
    }
  }

  const options: CommercialUserOption[] = [...eligibleIds]
    .map((id) => ({
      id,
      fullName: names.get(id) ?? id,
      phone: phones.get(id) ?? null,
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, 'fr'));

  return { namesById: names, options };
}

export function filterReassignCustomers(
  customers: readonly ReassignCustomerView[],
  filter: {
    readonly stage: ReassignStageFilter;
    readonly ownerFilter: string;
    readonly query: string;
  },
): ReassignCustomerView[] {
  const q = filter.query.trim().toLowerCase();
  return customers
    .filter((customer) => {
      if (customer.stage === 'LOST') return false;
      if (filter.stage !== 'ALL' && customer.stage !== filter.stage) return false;
      if (filter.ownerFilter === 'UNASSIGNED') {
        if (customer.ownerUserId !== null) return false;
      } else if (filter.ownerFilter !== 'ALL' && customer.ownerUserId !== filter.ownerFilter) {
        return false;
      }
      if (!q) return true;
      return (
        customer.displayName.toLowerCase().includes(q) ||
        (customer.contactName?.toLowerCase().includes(q) ?? false) ||
        (customer.phonePrimary?.toLowerCase().includes(q) ?? false)
      );
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'fr'));
}

export type ReassignProblem = 'OWNER_REQUIRED' | 'SAME_OWNER' | 'REASON_REQUIRED';

export function reassignProblem(
  currentOwnerUserId: string | null,
  newOwnerUserId: string,
  reason: string,
): ReassignProblem | null {
  if (!newOwnerUserId.trim()) return 'OWNER_REQUIRED';
  if (currentOwnerUserId !== null && currentOwnerUserId === newOwnerUserId) return 'SAME_OWNER';
  if (!reason.trim()) return 'REASON_REQUIRED';
  return null;
}

export function reassignPayload(newOwnerUserId: string, reason: string) {
  return {
    newOwnerUserId: newOwnerUserId.trim(),
    reason: reason.trim(),
  };
}
