/**
 * Portée d'un appareil (MP-06 ; AV-247, AV-260 tranchés par le porteur le 13/10/2026), partagée par la
 * lecture `GET /devices` et par les commandes `identity.device.*` : un décideur voit ou décide un appareil
 * si l'une de ses ressources est dans la portée de sa permission (`evaluateAccess`) :
 * - l'utilisateur qui l'a connecté (`enrolled_by_user_id`), comme titulaire : portée `TEAM` (ses équipes) ;
 * - chacun des sites de ses affectations actives `SITE`, et les sites des zones de ses affectations
 *   `ZONE` : portée `SITE` (le responsable du site de cet utilisateur) ;
 * - le site de rattachement de l'appareil (`designated_site_id`, AV-260 : la tablette d'un PDV relève du
 *   responsable de ce site, quel que soit l'utilisateur qui l'a connectée).
 * Une portée `ALL` voit tout (Admin, Direction). Un appareil dont l'utilisateur n'a ni équipe, ni site, ni
 * zone, et qui n'est rattaché à aucun site, ne relève que des portées `ALL`.
 *
 * AV-258 : nul ne s'approuve soi-même — l'utilisateur qui a connecté un appareil n'approuve ni ne
 * débloque cet appareil, sauf l'Admin.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { listSiteIdsInZones } from '../../../organization/application/public/index.js';
import type { ResourceLocator } from '../rbac/scope-evaluation.js';
import { activeRoleAssignmentsAt, activeRoleCodesAt } from './assignment-query.js';
import { evaluateAccess } from './rights-check.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Ce qui situe un appareil pour la portée. */
export interface DeviceScopeAnchor {
  readonly enrolledByUserId: string;
  readonly designatedSiteId: string | null;
}

/**
 * Ressources tirées de l'utilisateur qui a connecté l'appareil, à `at` : lui-même comme titulaire, puis
 * lui-même sur chacun des sites de ses affectations `SITE` et des zones de ses affectations `ZONE`.
 */
export async function enrollerLocators(
  executor: Executor,
  enrolledByUserId: string,
  at: Date,
): Promise<readonly ResourceLocator[]> {
  const sites = new Set<string>();
  const zones: string[] = [];
  for (const assignment of await activeRoleAssignmentsAt(executor, enrolledByUserId, at)) {
    if (assignment.scopeSiteId) sites.add(assignment.scopeSiteId);
    if (assignment.scopeZoneId) zones.push(assignment.scopeZoneId);
  }
  for (const siteId of await listSiteIdsInZones(executor, zones)) sites.add(siteId);
  return [
    { ownerUserId: enrolledByUserId },
    ...[...sites].map((siteId) => ({ ownerUserId: enrolledByUserId, siteId })),
  ];
}

/** Ajoute le site de rattachement de l'appareil (AV-260). */
export function withDesignatedSite(
  locators: readonly ResourceLocator[],
  designatedSiteId: string | null,
): readonly ResourceLocator[] {
  return designatedSiteId === null ? locators : [...locators, { siteId: designatedSiteId }];
}

/** Ressources d'un appareil, à `at` : la première dans la portée suffit. */
export async function deviceResourceLocators(
  executor: Executor,
  device: DeviceScopeAnchor,
  at: Date,
): Promise<readonly ResourceLocator[]> {
  return withDesignatedSite(
    await enrollerLocators(executor, device.enrolledByUserId, at),
    device.designatedSiteId,
  );
}

/** L'une des ressources est-elle dans la portée de `permissionCode` pour `userId`, à `at` ? */
export async function locatorsInScope(
  executor: Executor,
  input: {
    readonly userId: string;
    readonly permissionCode: string;
    readonly at: Date;
    readonly locators: readonly ResourceLocator[];
  },
): Promise<boolean> {
  for (const resource of input.locators) {
    const result = await evaluateAccess(executor, {
      userId: input.userId,
      permissionCode: input.permissionCode,
      occurredAt: input.at,
      resource,
    });
    if (result.allowed) return true;
    if (result.reason === 'NO_PERMISSION') return false;
  }
  return false;
}

/** L'appareil est-il dans la portée de `permissionCode` pour `userId`, à `at` ? */
export async function deviceInScope(
  executor: Executor,
  input: {
    readonly userId: string;
    readonly permissionCode: string;
    readonly at: Date;
    readonly device: DeviceScopeAnchor;
  },
): Promise<boolean> {
  return locatorsInScope(executor, {
    userId: input.userId,
    permissionCode: input.permissionCode,
    at: input.at,
    locators: await deviceResourceLocators(executor, input.device, input.at),
  });
}

/** Un site cible (rattachement) est-il dans la portée de `permissionCode` (AV-259) ? */
export async function siteInScope(
  executor: Executor,
  input: {
    readonly userId: string;
    readonly permissionCode: string;
    readonly at: Date;
    readonly siteId: string;
  },
): Promise<boolean> {
  const result = await evaluateAccess(executor, {
    userId: input.userId,
    permissionCode: input.permissionCode,
    occurredAt: input.at,
    resource: { siteId: input.siteId },
  });
  return result.allowed;
}

/**
 * AV-258 : l'auteur approuve (ou débloque) un appareil qu'il a lui-même connecté, sans être Admin.
 */
export async function isSelfApproval(
  executor: Executor,
  input: { readonly authorUserId: string; readonly enrolledByUserId: string; readonly at: Date },
): Promise<boolean> {
  if (input.authorUserId !== input.enrolledByUserId) return false;
  return !(await activeRoleCodesAt(executor, input.authorUserId, input.at)).includes('ADMIN');
}
