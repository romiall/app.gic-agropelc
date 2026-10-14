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
import { businessDayOf, businessDayStartUtc, type IdGenerator } from '@gic/domain';
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

/**
 * Masse mensuelle des frais généraux d'une ferme : (site, espèce, mois métier `AAAA-MM`) — correctif
 * A7 (revue de P8, ADR-038 rang N2b). Elle est lue par la répartition (`production.overhead.allocate`,
 * part estimée à la clôture d'un lot), puis répartie ; une saisie ne se contrepasse que tant que le mois
 * n'est pas réparti. Toute transaction qui écrit ou garde cette masse prend d'abord son verrou.
 */
export interface OverheadPoolKey {
  readonly siteId: string;
  readonly speciesGroup: SpeciesGroup;
  readonly period: string;
}

/** Mois métier (Africa/Douala) d'un instant, `AAAA-MM`. */
export function overheadPeriodOf(at: Date): string {
  return businessDayOf(at).slice(0, 7);
}

/**
 * Verrou exclusif de la masse (site, espèce, mois), tenu jusqu'à la fin de la transaction. La ligne est
 * garantie par un upsert sans effet qui prend son verrou d'écriture (ADR-038 §3), jamais par un
 * `SELECT … FOR UPDATE` sur une clé absente. Rang N2b : après les documents racines (une saisie, une
 * dépense), avant tout autre rang ; plusieurs masses se verrouillent par `lockOverheadPools` (ordre
 * croissant). Une lecture simple de la transaction peut précéder le verrou : la masse et la garde
 * « mois déjà réparti » se relisent donc par une lecture verrouillante, qui rend les lignes validées.
 */
export async function lockOverheadPool(uow: Transaction<DB>, key: OverheadPoolKey): Promise<void> {
  await uow
    .insertInto('inventory_overhead_pool_locks')
    .values({
      site_id: toBin(key.siteId),
      species_group: key.speciesGroup,
      period: key.period,
    })
    .onDuplicateKeyUpdate({ period: key.period })
    .execute();
}

/** Plusieurs masses, verrouillées dans un ordre unique (site, espèce, mois) : aucun cycle entre elles. */
export async function lockOverheadPools(
  uow: Transaction<DB>,
  keys: readonly OverheadPoolKey[],
): Promise<void> {
  const unique = new Map(
    keys.map((key) => [`${key.siteId}|${key.speciesGroup}|${key.period}`, key] as const),
  );
  for (const id of [...unique.keys()].sort()) {
    await lockOverheadPool(uow, unique.get(id)!);
  }
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
  // Toute écriture de la masse des frais généraux d'une ferme passe sous le verrou de sa masse
  // mensuelle (A7) : elle ne s'intercale jamais dans une répartition ou une annulation du mois.
  if (
    input.costObjectType === 'SITE' &&
    input.costType === 'FRAIS_GENERAUX' &&
    input.speciesGroup !== undefined
  ) {
    await lockOverheadPool(uow, {
      siteId: input.costObjectId,
      speciesGroup: input.speciesGroup,
      period: overheadPeriodOf(input.occurredAt),
    });
  }
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
    /**
     * Lecture verrouillante (`FOR SHARE`) : rend les écritures validées jusqu'ici, et non l'instantané
     * de la transaction. Pour la masse d'un mois réparti sous `lockOverheadPool` (A7).
     */
    readonly current?: boolean;
  },
): Promise<CostObjectBalance> {
  const query = executor
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
    );
  const row = await (filter.current === true ? query.forShare() : query).executeTakeFirstOrThrow();
  const debitXaf = Number(row.debit);
  const creditXaf = Number(row.credit);
  return { debitXaf, creditXaf, netXaf: debitXaf - creditXaf };
}

/**
 * État d'un lot de production ou d'un lot d'incubation, objet de coût d'une dépense (P8-05,
 * ADR-042 §8) : `finance` n'importe pas `production` ; l'état est porté par le lot de stock de
 * traçabilité (origine `PRODUCTION_LOT` ou `INCUBATION_BATCH`), clos par `production` à la clôture
 * du lot (INV-PRD-02). `UNKNOWN` : aucun lot de stock de cette origine.
 */
export async function lotCostObjectStatus(
  executor: Kysely<DB> | Transaction<DB>,
  input: {
    readonly costObjectType: 'PRODUCTION_LOT' | 'INCUBATION_BATCH';
    readonly costObjectId: string;
  },
): Promise<'OPEN' | 'CLOSED' | 'UNKNOWN'> {
  const row = await executor
    .selectFrom('inventory_stock_lots')
    .select('status')
    .where('origin_type', '=', input.costObjectType)
    .where('origin_id', '=', toBin(input.costObjectId))
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (!row) return 'UNKNOWN';
  return row.status === 'OPEN' ? 'OPEN' : 'CLOSED';
}

/**
 * Le mois métier (Africa/Douala) contenant `at` a-t-il déjà été réparti entre les lots pour cette
 * ferme et cette espèce (crédit `ALLOCATION` du site, ADR-026) ? Garde de l'annulation d'une
 * dépense de frais généraux (P8-05), comme celle d'une saisie `inventory.overhead.cancel`.
 * Lecture verrouillante (A7) : l'appelant tient `lockOverheadPool` de ce mois ; la lecture rend les
 * répartitions validées avant le verrou, et non l'instantané de sa transaction.
 */
export async function siteOverheadMonthAllocated(
  executor: Kysely<DB> | Transaction<DB>,
  input: { readonly siteId: string; readonly speciesGroup: SpeciesGroup; readonly at: Date },
): Promise<boolean> {
  const day = businessDayOf(input.at);
  const [year, month] = day.split('-').map(Number) as [number, number];
  const start = businessDayStartUtc(`${year}-${String(month).padStart(2, '0')}-01`);
  const next =
    month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const row = await executor
    .selectFrom('inventory_cost_entries')
    .select('id')
    .where('cost_object_type', '=', 'SITE')
    .where('cost_object_id', '=', toBin(input.siteId))
    .where('source_type', '=', 'ALLOCATION')
    .where('species_group', '=', input.speciesGroup)
    .where('occurred_at', '>=', start)
    .where('occurred_at', '<', businessDayStartUtc(next))
    .forShare()
    .executeTakeFirst();
  return row !== undefined;
}
