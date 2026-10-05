/**
 * `finance.recordCashMovement` — registre de trésorerie en ajout seul (D09 §7.2 : BR-FIN-011,
 * BR-FIN-012 ; INV-FIN-01, INV-FIN-02 ; dictionnaire `finance.cash_movements`). Seul point
 * d'écriture de `finance_cash_movements` : les autres modules (`sales` pour les encaissements et
 * les remboursements, plus tard les dépenses et les paiements fournisseurs) l'appellent dans la
 * même transaction que leur propre document.
 *
 * - Tout flux d'argent est un mouvement : compte, sens (`IN`/`OUT`), montant entier > 0, type,
 *   document source, heure métier, session de caisse éventuelle. Le solde du compte
 *   (`cash_accounts.balance_xaf`) est une projection mise à jour dans la même transaction,
 *   ligne de compte verrouillée (INV-FIN-02).
 * - Correction par **mouvement inverse** uniquement (`reversesMovementId`) : sens opposé, même
 *   compte, même montant, même type et même document source que le mouvement corrigé, une seule
 *   fois. Un remboursement partiel n'est pas un inverse : c'est un mouvement `REFUND`.
 * - BR-FIN-012 : en ligne, une sortie ne peut rendre négatif le solde d'une caisse physique
 *   (`CAISSE_*`) ; hors ligne (`allowNegative`), elle est appliquée et le résultat signale
 *   `negativeBalance` pour que l'appelant ouvre l'anomalie `CASH_NEGATIVE` (BR-SYN-007). Les
 *   comptes `MOBILE_MONEY` et `BANQUE` ne sont pas concernés.
 */
import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import type { IdGenerator } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';

export const CASH_MOVEMENT_TYPES = [
  'CUSTOMER_PAYMENT',
  'REFUND',
  'SUPPLIER_PAYMENT',
  'EXPENSE',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'SESSION_VARIANCE',
  'OPENING_BALANCE',
] as const;
export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number];

export const CASH_SOURCE_DOC_TYPES = [
  'CUSTOMER_PAYMENT',
  'SALE_REFUND',
  'SUPPLIER_PAYMENT',
  'EXPENSE',
  'CASH_TRANSFER',
  'CASH_SESSION',
] as const;
export type CashSourceDocType = (typeof CASH_SOURCE_DOC_TYPES)[number];

export type CashDirection = 'IN' | 'OUT';

/**
 * Sens et document source attendus pour chaque type de mouvement (D09 §7.2). DÉDUIT :
 * `OPENING_BALANCE` (solde d'ouverture d'un compte) cite le document `CASH_SESSION`, seul
 * document de trésorerie sans tiers (le dictionnaire ne lui donne pas de document propre).
 */
const MOVEMENT_RULES: Record<
  CashMovementType,
  { readonly directions: readonly CashDirection[]; readonly source: CashSourceDocType }
> = {
  CUSTOMER_PAYMENT: { directions: ['IN'], source: 'CUSTOMER_PAYMENT' },
  REFUND: { directions: ['OUT'], source: 'SALE_REFUND' },
  SUPPLIER_PAYMENT: { directions: ['OUT'], source: 'SUPPLIER_PAYMENT' },
  EXPENSE: { directions: ['OUT'], source: 'EXPENSE' },
  TRANSFER_OUT: { directions: ['OUT'], source: 'CASH_TRANSFER' },
  TRANSFER_IN: { directions: ['IN'], source: 'CASH_TRANSFER' },
  SESSION_VARIANCE: { directions: ['IN', 'OUT'], source: 'CASH_SESSION' },
  OPENING_BALANCE: { directions: ['IN'], source: 'CASH_SESSION' },
};

export class CashMovementError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'CASH_ACCOUNT_INVALID'
      | 'CASH_ACCOUNT_INACTIVE'
      | 'CASH_AMOUNT_INVALID'
      | 'CASH_MOVEMENT_INVALID'
      | 'CASH_REVERSAL_INVALID'
      | 'CASH_INSUFFICIENT',
  ) {
    super(message);
    this.name = 'CashMovementError';
  }
}

export interface RecordCashMovementInput {
  readonly cashAccountId: string;
  readonly direction: CashDirection;
  /** XAF entiers, strictement positifs. */
  readonly amountXaf: number;
  readonly movementType: CashMovementType;
  readonly sourceDocType: CashSourceDocType;
  readonly sourceDocId: string;
  readonly cashSessionId?: string;
  readonly occurredAt: Date;
  readonly createdBy: string;
  readonly createdDeviceId?: string;
  readonly commandId?: string;
  readonly capturedOffline?: boolean;
  /** BR-FIN-012 : hors ligne, une sortie est appliquée même si la caisse devient négative. */
  readonly allowNegative: boolean;
  /** Mouvement corrigé : fait de celui-ci un inverse (sens opposé, même montant). */
  readonly reversesMovementId?: string;
}

export interface RecordedCashMovement {
  readonly movementId: string;
  readonly cashAccountId: string;
  readonly direction: CashDirection;
  readonly amountXaf: number;
  readonly balanceAfterXaf: number;
  /** Hors ligne : le solde d'une caisse physique est devenu négatif (anomalie `CASH_NEGATIVE`). */
  readonly negativeBalance: boolean;
}

export async function recordCashMovement(
  uow: Transaction<DB>,
  deps: { readonly idGenerator: IdGenerator },
  input: RecordCashMovementInput,
): Promise<RecordedCashMovement> {
  if (!Number.isSafeInteger(input.amountXaf) || input.amountXaf <= 0) {
    throw new CashMovementError(
      'Un mouvement de trésorerie porte un montant entier strictement positif (XAF).',
      'CASH_AMOUNT_INVALID',
    );
  }

  // Ligne de compte verrouillée : le solde projeté et le registre évoluent ensemble (INV-FIN-02).
  const account = await uow
    .selectFrom('finance_cash_accounts')
    .select(['account_type', 'status', 'balance_xaf'])
    .where('id', '=', toBin(input.cashAccountId))
    .forUpdate()
    .executeTakeFirst();
  if (!account) {
    throw new CashMovementError('Compte de trésorerie introuvable.', 'CASH_ACCOUNT_INVALID');
  }
  // Un fait accompli hors ligne sur un compte désactivé depuis est appliqué (BR-SYN-007).
  if (account.status !== 'ACTIVE' && !input.capturedOffline) {
    throw new CashMovementError('Compte de trésorerie inactif.', 'CASH_ACCOUNT_INACTIVE');
  }

  if (input.reversesMovementId !== undefined) {
    const original = await uow
      .selectFrom('finance_cash_movements')
      .select([
        'cash_account_id',
        'direction',
        'amount_xaf',
        'movement_type',
        'source_doc_type',
        'source_doc_id',
        'is_reversal',
      ])
      .where('id', '=', toBin(input.reversesMovementId))
      .executeTakeFirst();
    if (!original) {
      throw new CashMovementError('Mouvement corrigé introuvable.', 'CASH_REVERSAL_INVALID');
    }
    const alreadyReversed = await uow
      .selectFrom('finance_cash_movements')
      .select('id')
      .where('reverses_movement_id', '=', toBin(input.reversesMovementId))
      .executeTakeFirst();
    if (
      Boolean(original.is_reversal) ||
      alreadyReversed !== undefined ||
      fromBin(original.cash_account_id) !== input.cashAccountId ||
      Number(original.amount_xaf) !== input.amountXaf ||
      original.direction === input.direction ||
      original.movement_type !== input.movementType ||
      original.source_doc_type !== input.sourceDocType ||
      fromBin(original.source_doc_id) !== input.sourceDocId
    ) {
      throw new CashMovementError(
        'Un inverse porte le même compte, montant, type et document source, en sens opposé, une seule fois (BR-FIN-011).',
        'CASH_REVERSAL_INVALID',
      );
    }
  } else {
    const rule = MOVEMENT_RULES[input.movementType];
    if (!rule.directions.includes(input.direction) || rule.source !== input.sourceDocType) {
      throw new CashMovementError(
        `Un mouvement ${input.movementType} est ${rule.directions.join(' ou ')} et cite le document ${rule.source} (BR-FIN-011).`,
        'CASH_MOVEMENT_INVALID',
      );
    }
  }

  const delta = input.direction === 'IN' ? input.amountXaf : -input.amountXaf;
  const balanceAfterXaf = Number(account.balance_xaf) + delta;
  const physicalCash = account.account_type.startsWith('CAISSE_');
  const negativeBalance = input.direction === 'OUT' && physicalCash && balanceAfterXaf < 0;
  if (negativeBalance && !input.allowNegative) {
    throw new CashMovementError(
      'Solde de caisse insuffisant : une sortie ne peut pas rendre négatif le solde d’une caisse physique (BR-FIN-012).',
      'CASH_INSUFFICIENT',
    );
  }

  const movementId = deps.idGenerator.newId();
  await uow
    .insertInto('finance_cash_movements')
    .values({
      id: toBin(movementId),
      cash_account_id: toBin(input.cashAccountId),
      direction: input.direction,
      amount_xaf: input.amountXaf,
      movement_type: input.movementType,
      source_doc_type: input.sourceDocType,
      source_doc_id: toBin(input.sourceDocId),
      cash_session_id: toBinOrNull(input.cashSessionId ?? null),
      occurred_at: input.occurredAt,
      is_reversal: toDbBool(input.reversesMovementId !== undefined),
      reverses_movement_id: toBinOrNull(input.reversesMovementId ?? null),
      created_by: toBin(input.createdBy),
      created_device_id: toBinOrNull(input.createdDeviceId ?? null),
      command_id: toBinOrNull(input.commandId ?? null),
      captured_offline: toDbBool(input.capturedOffline ?? false),
    })
    .execute();
  await uow
    .updateTable('finance_cash_accounts')
    .set({ balance_xaf: sql`balance_xaf + ${delta}`, version: sql`version + 1` })
    .where('id', '=', toBin(input.cashAccountId))
    .execute();

  return {
    movementId,
    cashAccountId: input.cashAccountId,
    direction: input.direction,
    amountXaf: input.amountXaf,
    balanceAfterXaf,
    negativeBalance,
  };
}
