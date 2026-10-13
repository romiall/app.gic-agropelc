/**
 * Lectures HTTP des appareils (MP-06, ECR-ADM-05 ; 08-api-events/01-architecture-api.md §4.1) :
 * `GET /devices`, `/devices/{id}`. Patron de P4-10 (`read-api/read-access.ts`).
 *
 * Droit : `identity.device.read` (01-rbac.md §5.1). Portée (AV-247, AV-260, décisions du porteur du
 * 13/10/2026) : un appareil est visible si l'utilisateur qui l'a connecté relève des équipes, sites ou zones
 * de la portée, ou si son site de rattachement en relève (`deviceInScope`, la même règle que les
 * commandes) ; une portée `ALL` voit tout. La liste est filtrée élément par élément : une page peut être
 * plus courte que `limit`, suivre `next_cursor` jusqu'à `null`. Hors portée ou inconnu : 404 audité.
 *
 * Chaque appareil porte les actions que le lecteur peut y faire (`actions`), évaluées par le serveur avec
 * la même règle que les commandes, AV-258 compris (nul n'approuve l'appareil qu'il a connecté, sauf
 * l'Admin) ; l'écran n'affiche que celles-là, le serveur revérifie à la commande.
 */
import { Controller, Get, HttpCode, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Clock, IdGenerator } from '@gic/domain';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import {
  DEVICE_STATUSES,
  enrollerLocators,
  evaluateAccess,
  findDevice,
  isSelfApproval,
  listDevicesPage,
  locatorsInScope,
  userFullNames,
  withDesignatedSite,
  type DeviceSummary,
  type ResourceLocator,
} from '../modules/identity/application/public/index.js';
import { deviceFreshness } from '../sync/device-freshness.js';
import { idParamSchema, parseOrThrow, ReadAccess, uuidParam } from '../read-api/read-access.js';

const DEVICE_READ = 'identity.device.read';
const DEVICE_APPROVE = 'identity.device.approve';
const DEVICE_BLOCK = 'identity.device.block';
const DEVICES_DEFAULT_LIMIT = 50;
const DEVICES_MAX_LIMIT = 200;
/** Lectures successives au plus pour remplir une page filtrée par la portée. */
const MAX_SCANS = 10;

type DeviceScope = (permissionCode: string, device: DeviceSummary) => Promise<boolean>;

const devicesQuerySchema = z.object({
  status: z.enum(DEVICE_STATUSES).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  cursor: uuidParam.optional(),
  limit: z.coerce.number().int().positive().max(DEVICES_MAX_LIMIT).optional(),
});

@Controller('api/v1')
export class DevicesReadController {
  private readonly access: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    this.access = new ReadAccess(db, { clock, idGenerator }, DEVICE_READ);
  }

  @Get('devices')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(DEVICE_READ)
  async devices(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(devicesQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.access.requirePermission(request, now, { type: 'DEVICE' });
    const userId = request.auth!.sub;
    const limit = query.limit ?? DEVICES_DEFAULT_LIMIT;
    const scope = this.scopeOf(userId, now);
    const visible: DeviceSummary[] = [];
    let cursor = query.cursor;
    let nextCursor: string | null = null;
    for (let scan = 0; scan < MAX_SCANS; scan++) {
      const page = await listDevicesPage(this.db, {
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
        ...(cursor !== undefined ? { beforeId: cursor } : {}),
        limit,
      });
      let stoppedAt: number | null = null;
      for (const [index, device] of page.items.entries()) {
        if (await scope(DEVICE_READ, device)) {
          visible.push(device);
          if (visible.length === limit) {
            stoppedAt = index;
            break;
          }
        }
      }
      if (stoppedAt !== null) {
        // Page pleine : la suite reprend après le dernier appareil retenu (les suivants de la page lue
        // seront relus, filtrés à nouveau).
        const hasMoreInPage = stoppedAt < page.items.length - 1;
        nextCursor = hasMoreInPage || page.nextCursor !== null ? visible.at(-1)!.id : null;
        break;
      }
      if (page.nextCursor === null) {
        nextCursor = null;
        break;
      }
      cursor = page.nextCursor;
      // Lectures épuisées sans remplir la page : la suite reprend après le dernier lu.
      nextCursor = page.nextCursor;
    }
    return { devices: await this.present(userId, now, scope, visible), next_cursor: nextCursor };
  }

  @Get('devices/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(DEVICE_READ)
  async device(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'DEVICE', id };
    await this.access.requirePermission(request, now, entity);
    const device = await findDevice(this.db, id);
    const userId = request.auth!.sub;
    const scope = this.scopeOf(userId, now);
    if (!device || !(await scope(DEVICE_READ, device))) {
      return this.access.deny(request, now, entity, 'OUT_OF_SCOPE');
    }
    const [presented] = await this.present(userId, now, scope, [device]);
    return { device: presented };
  }

  /**
   * Évaluation de la portée pour une requête (même règle que les commandes, `deviceInScope`) : une portée
   * `ALL` est reconnue une fois par permission ; les ressources de chaque utilisateur qui a connecté un
   * appareil sont lues une fois.
   */
  private scopeOf(userId: string, at: Date): DeviceScope {
    const everything = new Map<string, Promise<boolean>>();
    const enrollers = new Map<string, Promise<readonly ResourceLocator[]>>();
    const hasAll = (permissionCode: string) => {
      let known = everything.get(permissionCode);
      if (!known) {
        known = evaluateAccess(this.db, {
          userId,
          permissionCode,
          occurredAt: at,
          resource: {},
        }).then((result) => result.allowed);
        everything.set(permissionCode, known);
      }
      return known;
    };
    const locatorsOf = async (device: DeviceSummary) => {
      let known = enrollers.get(device.enrolledByUserId);
      if (!known) {
        known = enrollerLocators(this.db, device.enrolledByUserId, at);
        enrollers.set(device.enrolledByUserId, known);
      }
      return withDesignatedSite(await known, device.designatedSiteId);
    };
    return async (permissionCode, device) =>
      (await hasAll(permissionCode)) ||
      locatorsInScope(this.db, {
        userId,
        permissionCode,
        at,
        locators: await locatorsOf(device),
      });
  }

  /** Noms, fraîcheur et actions permises au lecteur. */
  private async present(
    userId: string,
    now: Date,
    scope: DeviceScope,
    devices: readonly DeviceSummary[],
  ) {
    const names = await userFullNames(this.db, [
      ...new Set(
        devices.flatMap((device) => [
          device.enrolledByUserId,
          ...(device.approvedByUserId !== null ? [device.approvedByUserId] : []),
        ]),
      ),
    ]);
    const freshness = new Map(
      (
        await deviceFreshness(this.db, { deviceIds: devices.map((device) => device.id), now })
      ).devices.map((entry) => [entry.deviceId, entry]),
    );
    const presented = [];
    for (const device of devices) {
      const contact = freshness.get(device.id);
      const self = await isSelfApproval(this.db, {
        authorUserId: userId,
        enrolledByUserId: device.enrolledByUserId,
        at: now,
      });
      const approveScope = await scope(DEVICE_APPROVE, device);
      const blockScope = await scope(DEVICE_BLOCK, device);
      presented.push({
        ...device,
        enrolledByName: names.get(device.enrolledByUserId) ?? null,
        approvedByName:
          device.approvedByUserId !== null ? (names.get(device.approvedByUserId) ?? null) : null,
        lastPushAt: contact?.lastPushAt ?? null,
        lastPullAt: contact?.lastPullAt ?? null,
        lastContactAt: contact?.lastContactAt ?? device.lastSeenAt,
        stale: device.status === 'ACTIVE' && (contact?.stale ?? false),
        // Droits du lecteur sur cet appareil, quel que soit son état (l'écran croise avec SM-DEVICE) :
        // approuver et débloquer excluent l'appareil qu'on a connecté soi-même (AV-258, sauf l'Admin) ;
        // rattacher suit la permission d'approbation (le site cible est vérifié à la commande, AV-259).
        actions: {
          approve: approveScope && !self,
          block: blockScope,
          unblock: blockScope && !self,
          designate: approveScope,
        },
      });
    }
    return presented;
  }
}
