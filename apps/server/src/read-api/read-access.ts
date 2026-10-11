/**
 * Boîte à outils des lectures HTTP (P5-17), extraite du patron de P4-10 (`finance-read.controller.ts`,
 * `sales-read.controller.ts`) pour les contrôleurs de P5 : validation des paramètres (400
 * `VALIDATION_ERROR`), droit (403 `FORBIDDEN`, refus audité), portée par ressource (`evaluateAccess`,
 * RC-04), document hors portée ou inconnu (404 `NOT_FOUND` audité, existence opaque, RC-07). Couche de
 * transport : importe l'API publique d'`identity` ; aucun module n'importe ce fichier.
 */
import { z } from 'zod';
import type { Clock, IdGenerator } from '@gic/domain';
import type { Database } from '../platform/kysely/database.provider.js';
import { ApiError } from '../platform/http/api-error.exception.js';
import { recordDenied } from '../audit/record-denied.js';
import type { AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import {
  evaluateAccess,
  hasPermissionAt,
  listConfinementAt,
  type ListConfinement,
  type ResourceLocator,
} from '../modules/identity/application/public/index.js';
import { toBin } from '../platform/kysely/uuid-columns.js';

export const uuidParam = z.string().uuid();
/** Jour métier `AAAA-MM-JJ` existant au calendrier (une date impossible donne 400, jamais 500). */
export const businessDateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ.')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, 'Date inexistante.');
export const idParamSchema = z.object({ id: uuidParam });

export function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `Paramètres de requête invalides : ${parsed.error.issues.map((i) => i.message).join(' ; ')}`,
    );
  }
  return parsed.data;
}

/** Période `from`/`to` en jours métier : `to` antérieur à `from` ⇒ 400. */
export function assertPeriod(from: string | undefined, to: string | undefined): void {
  if (from !== undefined && to !== undefined && to < from) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Période invalide.');
  }
}

export interface DeniedEntity {
  readonly type: string;
  readonly id?: string;
}

/** Décision de lecture pour une permission donnée (une instance par permission et par contrôleur). */
export class ReadAccess {
  constructor(
    private readonly db: Database,
    private readonly deps: { readonly clock: Clock; readonly idGenerator: IdGenerator },
    readonly permissionCode: string,
  ) {}

  async deny(
    request: AuthenticatedRequest,
    now: Date,
    entity: DeniedEntity,
    reason: 'NO_PERMISSION' | 'OUT_OF_SCOPE',
  ): Promise<never> {
    const auth = request.auth!;
    await recordDenied(this.db, this.deps, {
      occurredAt: now,
      actorUserId: auth.sub,
      actorRoles: [],
      deviceId: auth.device_id,
      action: 'access.denied',
      entityType: entity.type,
      entityId: entity.id ?? null,
      reason:
        reason === 'NO_PERMISSION'
          ? `Permission manquante : ${this.permissionCode}.`
          : `Hors portée : ${this.permissionCode}.`,
      errorCode: reason === 'NO_PERMISSION' ? 'FORBIDDEN' : 'NOT_FOUND',
    });
    if (reason === 'NO_PERMISSION') {
      throw new ApiError(403, 'FORBIDDEN', 'Droit insuffisant pour cette consultation.');
    }
    throw new ApiError(404, 'NOT_FOUND', 'Ressource introuvable.');
  }

  async requirePermission(
    request: AuthenticatedRequest,
    now: Date,
    entity: DeniedEntity,
  ): Promise<void> {
    if (!(await hasPermissionAt(this.db, toBin(request.auth!.sub), this.permissionCode, now))) {
      await this.deny(request, now, entity, 'NO_PERMISSION');
    }
  }

  /** La ressource est-elle dans la portée d'un octroi actif de la permission ? */
  async allows(
    request: AuthenticatedRequest,
    now: Date,
    resource: ResourceLocator,
  ): Promise<boolean> {
    return (
      await evaluateAccess(this.db, {
        userId: request.auth!.sub,
        permissionCode: this.permissionCode,
        occurredAt: now,
        resource,
      })
    ).allowed;
  }

  /** Portée `ALL` : toute ressource est visible (aucun filtre à appliquer). */
  allowsAll(request: AuthenticatedRequest, now: Date): Promise<boolean> {
    return this.allows(request, now, {});
  }

  /** Pré-filtre sûr d'une liste (sites, titulaires) ; `null` : aucun pré-filtre possible. */
  confinement(request: AuthenticatedRequest, now: Date): Promise<ListConfinement | null> {
    return listConfinementAt(this.db, request.auth!.sub, this.permissionCode, now);
  }

  /** Fiche : ressource absente ou hors portée ⇒ 404 audité. */
  async requireVisible<T>(
    request: AuthenticatedRequest,
    now: Date,
    entity: DeniedEntity,
    item: T | null | undefined,
    resourceOf: (item: T) => ResourceLocator | Promise<ResourceLocator>,
  ): Promise<T> {
    if (item === null || item === undefined) return this.deny(request, now, entity, 'OUT_OF_SCOPE');
    if (!(await this.allows(request, now, await resourceOf(item)))) {
      return this.deny(request, now, entity, 'OUT_OF_SCOPE');
    }
    return item;
  }
}
