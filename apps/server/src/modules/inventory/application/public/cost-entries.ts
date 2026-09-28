/**
 * Registre de coûts (`inventory.cost_entries`, ADR-015 ; propriété d'`inventory`) : API publique
 * pour les modules qui imputent des coûts — `production` (P7 : mise en place, production
 * transférée au coût standard AV-098, frais généraux et répartition ADR-026) et, plus tard,
 * `finance` (dépenses imputées, P8). Écritures en ajout seul (déclencheurs) ; une correction
 * passe par une écriture inverse (`reversesEntryId`, sens opposé).
 *
 * Une écriture de montant nul n'est pas créée (`CHECK amount_xaf > 0`) : l'appelant reçoit
 * `null` — une consommation ou une production valorisée à 0 XAF reste un fait physique valide
 * (BR-SYN-007), sans ligne de coût.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { IdGenerator } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';

export const COST_OBJECT_TYPES = ['PRODUCTION_LOT', 'INCUBATION_BATCH', 'SITE'] as const;
export type CostObjectType = (typeof COST_OBJECT_TYPES)[number];

export const COST_TYPES = [
  'ANIMAUX',
  'OEUFS',
  'ALIMENT',
  'VETERINAIRE',
  'AUTRE_INTRANT',
  'DEPENSE_DIRECTE',
  'AJUSTEMENT',
  'FRAIS_GENERAUX',
  'PRODUCTION_TRANSFEREE',
] as const;
export type CostType = (typeof COST_TYPES)[number];

export const COST_SOURCE_TYPES = [
  'STOCK_MOVE',
  'EXPENSE',
  'MANUAL',
  'OVERHEAD_ENTRY',
  'ALLOCATION',
  'PRODUCTION',
] as const;
export type CostSourceType = (typeof COST_SOURCE_TYPES)[number];

/** Espèces des frais généraux (AV-104 : jamais mélangées). */
export const SPECIES_GROUPS = ['VOLAILLE', 'PORC'] as const;
export type SpeciesGroup = (typeof SPECIES_GROUPS)[number];

export interface CostEntryInput {
  readonly costObjectType: CostObjectType;
  readonly costObjectId: string;
  readonly costType: CostType;
  readonly amountXaf: number;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly sourceType: CostSourceType;
  readonly sourceId: string;
  readonly occurredAt: Date;
  readonly createdBy: string;
  /** Obligatoire pour `FRAIS_GENERAUX` (CHECK). */
  readonly speciesGroup?: SpeciesGroup;
  readonly reversesEntryId?: string;
  readonly comment?: string;
}

/** Écrit une ligne du registre de coûts ; `null` si le montant est nul (aucune ligne). */
export async function recordCostEntry(
  uow: Transaction<DB>,
  deps: { readonly idGenerator: IdGenerator },
  input: CostEntryInput,
): Promise<string | null> {
  if (!Number.isSafeInteger(input.amountXaf) || input.amountXaf < 0) {
    throw new Error(`Montant de coût invalide : ${input.amountXaf}.`);
  }
  if (input.amountXaf === 0) return null;
  const id = deps.idGenerator.newId();
  await uow
    .insertInto('inventory_cost_entries')
    .values({
      id: toBin(id),
      cost_object_type: input.costObjectType,
      cost_object_id: toBin(input.costObjectId),
      cost_type: input.costType,
      species_group: input.speciesGroup ?? null,
      amount_xaf: input.amountXaf,
      direction: input.direction,
      source_type: input.sourceType,
      source_id: toBin(input.sourceId),
      reverses_entry_id: toBinOrNull(input.reversesEntryId ?? null),
      occurred_at: input.occurredAt,
      created_by: toBin(input.createdBy),
      comment: input.comment ?? null,
    })
    .execute();
  return id;
}

export interface CostObjectBalance {
  readonly debitXaf: number;
  readonly creditXaf: number;
  /** Débits − crédits. */
  readonly netXaf: number;
}

/**
 * Solde d'un objet de coût (débits − crédits), éventuellement jusqu'à `at` inclus et filtré par
 * nature (`costTypes`) ou par espèce (frais généraux d'un site, AV-104).
 */
export async function costObjectBalance(
  executor: Kysely<DB> | Transaction<DB>,
  filter: {
    readonly costObjectType: CostObjectType;
    readonly costObjectId: string;
    readonly at?: Date;
    readonly from?: Date;
    readonly costTypes?: readonly CostType[];
    readonly speciesGroup?: SpeciesGroup;
  },
): Promise<CostObjectBalance> {
  const row = await executor
    .selectFrom('inventory_cost_entries')
    .select([
      sql<string>`COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_xaf ELSE 0 END), 0)`.as(
        'debit',
      ),
      sql<string>`COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_xaf ELSE 0 END), 0)`.as(
        'credit',
      ),
    ])
    .where('cost_object_type', '=', filter.costObjectType)
    .where('cost_object_id', '=', toBin(filter.costObjectId))
    .$if(filter.at !== undefined, (qb) => qb.where('occurred_at', '<=', filter.at!))
    .$if(filter.from !== undefined, (qb) => qb.where('occurred_at', '>=', filter.from!))
    .$if(filter.costTypes !== undefined && filter.costTypes.length > 0, (qb) =>
      qb.where('cost_type', 'in', [...filter.costTypes!]),
    )
    .$if(filter.speciesGroup !== undefined, (qb) =>
      qb.where('species_group', '=', filter.speciesGroup!),
    )
    .executeTakeFirstOrThrow();
  const debitXaf = Number(row.debit);
  const creditXaf = Number(row.credit);
  return { debitXaf, creditXaf, netXaf: debitXaf - creditXaf };
}
