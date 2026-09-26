/**
 * `inventory.threshold.set` (dictionnaire `inventory.stock_thresholds` ; AV-040, seuils de
 * réapprovisionnement par emplacement × produit). Même patron de versionnement que
 * `approvals.policy.set` (policy-commands.ts) : jamais d'UPDATE sur un seuil existant — chaque
 * `set` désactive l'éventuel seuil actif précédent pour la même paire (`location_id`,
 * `product_id`) puis insère un nouvel enregistrement actif, dans la même transaction.
 * `active_key` (colonne générée, migration P2-02) garantit au plus un seuil actif par paire
 * même en cas de concurrence réelle (contrainte UNIQUE, filet de sécurité).
 */
import { z } from 'zod';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';
import { recordChanges } from '../../../../platform/sync/change-feed.js';
import { stockThresholdChange } from '../sync-changes.js';

const setPayloadSchema = z
  .object({
    locationId: z.string().uuid(),
    productId: z.string().uuid(),
    minQtyBase: z.number().nonnegative(),
    targetQtyBase: z.number().nonnegative(),
  })
  .superRefine((data, ctx) => {
    if (data.targetQtyBase < data.minQtyBase) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'targetQtyBase doit être supérieur ou égal à minQtyBase (CK, dictionnaire).',
      });
    }
  });
type SetPayload = z.infer<typeof setPayloadSchema>;

const set: CommandHandler<SetPayload> = async (uow, envelope) => {
  const id = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('inventory_stock_thresholds')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' }; // rejeu idempotent (même précédent que policy-commands.ts).

  const { locationId, productId, minQtyBase, targetQtyBase } = envelope.payload;

  const previous = await uow
    .selectFrom('inventory_stock_thresholds')
    .select('id')
    .where('location_id', '=', toBin(locationId))
    .where('product_id', '=', toBin(productId))
    .where('is_active', '=', 1)
    .execute();

  await uow
    .updateTable('inventory_stock_thresholds')
    .set({
      is_active: toDbBool(false),
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('location_id', '=', toBin(locationId))
    .where('product_id', '=', toBin(productId))
    .where('is_active', '=', 1)
    .execute();

  await uow
    .insertInto('inventory_stock_thresholds')
    .values({
      id,
      location_id: toBin(locationId),
      product_id: toBin(productId),
      min_qty_base: String(minQtyBase),
      target_qty_base: String(targetQtyBase),
      is_active: toDbBool(true),
      created_by: toBin(envelope.author_user_id),
    })
    .execute();

  // Jeu `stock` (P2-06) : le seuil désactivé est ré-émis aussi (projection `is_active =
  // false`), pour que l'appareil le retire au lieu de garder deux seuils pour la paire.
  await recordChanges(uow, [
    ...previous.map((row) => stockThresholdChange(fromBin(row.id), locationId)),
    stockThresholdChange(envelope.aggregate_id, locationId),
  ]);

  return { status: 'APPLIED' };
};

export function registerThresholdCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'inventory.threshold.set',
    version: 1,
    payloadSchema: setPayloadSchema,
    permissionCode: 'inventory.threshold.manage',
    handler: set,
  });
}
