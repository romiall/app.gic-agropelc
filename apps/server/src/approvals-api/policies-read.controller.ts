/**
 * Lecture des politiques de contrôle (RP-1, ECR-ADM-07 ; UC-ADM-14 ; BR-ADM-016) : `GET /approvals/policies`.
 *
 * Droit : `approvals.policy.manage` (Direction et Admin, portée `ALL`, 01-rbac.md §5.1), le même que la commande
 * `approvals.policy.set` : on ne lit ici que ce que l'on peut régler. Sans filtre, les politiques en vigueur
 * (type d'opération, puis code) ; avec `code`, toutes les versions de ce code, la plus récente d'abord
 * (historique). `approver_permissions` : les permissions d'approbation du catalogue, les choix de l'approbateur.
 * La `condition` de la politique est rendue telle quelle, jamais interprétée (dictionnaire `approvals`).
 */
import { Controller, Get, HttpCode, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Clock, IdGenerator } from '@gic/domain';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import {
  listApprovalPermissions,
  userFullNames,
} from '../modules/identity/application/public/index.js';
import { listPolicies } from '../modules/approvals/application/public/index.js';
import { parseOrThrow, ReadAccess } from '../read-api/read-access.js';

const POLICY_MANAGE = 'approvals.policy.manage';

const policiesQuerySchema = z.object({ code: z.string().min(1).max(40).optional() });

@Controller('api/v1')
export class PoliciesReadController {
  private readonly access: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    this.access = new ReadAccess(db, { clock, idGenerator }, POLICY_MANAGE);
  }

  @Get('approvals/policies')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(POLICY_MANAGE)
  async policies(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(policiesQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.access.requirePermission(request, now, { type: 'CONTROL_POLICY' });
    const policies = await listPolicies(this.db, {
      at: now,
      ...(query.code !== undefined ? { code: query.code } : {}),
    });
    const names = await userFullNames(
      this.db,
      policies.map((policy) => policy.createdBy),
    );
    return {
      policies: policies.map((policy) => ({
        ...policy,
        createdByName: names.get(policy.createdBy) ?? null,
      })),
      approver_permissions: await listApprovalPermissions(this.db),
    };
  }
}
