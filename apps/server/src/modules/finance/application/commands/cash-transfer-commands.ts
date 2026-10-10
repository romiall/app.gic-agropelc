/**
 * Remises de fonds (P5-15 ; D05 BR-DIS-009, D09 BR-FIN-012 et 013, §16 ; SM-CASH-TRANSFER ; ADR-032
 * §1, §2, §7, §8, §10 ; WF-15 ; AV-153, AV-157, AV-158, AV-172 à AV-176). Une seule permission,
 * `finance.cash_transfer.record`, contrôlée sur le compte concerné (AV-158) :
 *
 * - `finance.cash_transfer.send` (hors ligne possible) : sortie `TRANSFER_OUT` du montant envoyé sur
 *   le compte source puis remise `SENT` numérotée `RMF`. En ligne, une caisse physique ne devient
 *   jamais négative (`CASH_INSUFFICIENT`) ; hors ligne, le fait est appliqué avec l'anomalie
 *   `CASH_NEGATIVE` (BR-FIN-012). Paire de comptes non admise : refus en ligne, fait appliqué avec
 *   conflit hors ligne.
 * - `finance.cash_transfer.receive` : entrée `TRANSFER_IN` du montant **reçu** sur le compte
 *   destinataire (aucune pour une réception de 0, AV-175) ; écart = reçu − envoyé ; un écart ouvre la
 *   validation `CASH_TRANSFER_DISCREPANCY`. Le récepteur n'est jamais l'expéditeur (AV-172).
 * - `finance.cash_transfer.cancel` (hors ligne possible, expéditeur seul) : inverse de la sortie,
 *   **daté de l'annulation** (fait physique nouveau, ADR-032 §2, AV-157), remise `CANCELLED`.
 * - Décision `CASH_TRANSFER_DISCREPANCY` (registre des décisions d'`approvals`, ADR-018) :
 *   `DISCREPANCY_PENDING` → `CLOSED` avec imputation (`decisionOption`) et motif
 *   (`decisionData.reason`), **sans aucun mouvement** (ADR-032 §7) ; rejet et retrait refusés (AV-174).
 * - Courses hors ligne (ADR-032 §8, AV-173) : réception après l'annulation, annulation après la
 *   réception, seconde réception — fait conservé comme observation dans un conflit informatif pour la
 *   Finance, aucun mouvement, remise inchangée ; en ligne, refus.
 *
 * Ordre des verrous (ADR-032 §10, D09 §16) : réception, annulation et décision verrouillent la remise,
 * puis le compte (`recordCashMovement`) ; l'envoi verrouille les deux comptes dans l'ordre croissant
 * de leur identifiant, puis le compteur de numéros, puis insère la remise.
 */
import type { IdGenerator } from '@gic/domain';
import {
  checkTransferImputation,
  decideCashTransferAction,
  isAllowedTransferReceiver,
  isAllowedTransferValidator,
  isCashTransferPairAllowed,
  transferDiscrepancyXaf,
  transferStatusAfterReceive,
  DomainError,
} from '@gic/domain';
import {
  cashTransferCancelPayloadSchema,
  cashTransferReceivePayloadSchema,
  cashTransferSendPayloadSchema,
  type CashTransferCancelPayload,
  type CashTransferReceivePayload,
  type CashTransferSendPayload,
  type WarningCode,
} from '@gic/contracts';
import { sql, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import { recordConflict } from '../../../../platform/sync/conflicts.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import {
  fromBin,
  fromBinOrNull,
  toBin,
  toBinOrNull,
} from '../../../../platform/kysely/uuid-columns.js';
import {
  ApprovalDecisionRefused,
  requestApproval,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import { recordCashMovement } from '../public/cash-movements.js';
import { findCashAccount } from '../public/cash-accounts.js';
import {
  CASH_ACCOUNT_FORBIDDEN,
  CASH_TRANSFER_PERMISSION,
  canActOnCashAccount,
  cashTransferPairsAt,
  financeBusinessRejection,
  loadSiteRef,
  lockCashAccounts,
  nextCashTransferNumber,
  rejected,
  transferDiscrepancyPolicy,
} from '../cash-transfer-support.js';

type Uow = Transaction<DB>;
type Envelope<P> = Parameters<CommandHandler<P>>[1];

/** Ligne de remise, verrouillée par la réception, l'annulation et la décision. */
interface TransferRow {
  readonly id: string;
  readonly docNumber: string;
  readonly siteId: string | null;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly amountSentXaf: number;
  readonly amountReceivedXaf: number | null;
  readonly discrepancyXaf: number | null;
  readonly status: string;
  readonly sentBy: string;
  readonly sentAt: Date;
  readonly carrierUserId: string | null;
  readonly carrierName: string | null;
  readonly receivedBy: string | null;
  readonly outMovementId: string;
  readonly approvalRequestId: string | null;
  readonly receiveCommandId: string | null;
  readonly cancelledAt: Date | null;
  readonly cancelledBy: string | null;
}

async function lockTransfer(uow: Uow, transferId: string): Promise<TransferRow | undefined> {
  const row = await uow
    .selectFrom('finance_cash_transfers')
    .selectAll()
    .where('id', '=', toBin(transferId))
    .forUpdate()
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    id: fromBin(row.id),
    docNumber: row.doc_number,
    siteId: fromBinOrNull(row.site_id),
    fromAccountId: fromBin(row.from_account_id),
    toAccountId: fromBin(row.to_account_id),
    amountSentXaf: Number(row.amount_sent_xaf),
    amountReceivedXaf: row.amount_received_xaf === null ? null : Number(row.amount_received_xaf),
    discrepancyXaf: row.discrepancy_xaf === null ? null : Number(row.discrepancy_xaf),
    status: row.status,
    sentBy: fromBin(row.sent_by),
    sentAt: row.sent_at,
    carrierUserId: fromBinOrNull(row.carrier_user_id),
    carrierName: row.carrier_name,
    receivedBy: fromBinOrNull(row.received_by),
    outMovementId: fromBin(row.out_movement_id),
    approvalRequestId: fromBinOrNull(row.approval_request_id),
    receiveCommandId: fromBinOrNull(row.receive_command_id),
    cancelledAt: row.cancelled_at,
    cancelledBy: fromBinOrNull(row.cancelled_by),
  };
}

const NOT_FOUND = rejected('NOT_FOUND', 'Remise de fonds introuvable.');

/** Événement nommé produit par le module (outbox, ADR-011) : consommé par NOT et ANA (P9). */
async function insertFinanceEvent(
  uow: Uow,
  idGenerator: IdGenerator,
  input: {
    readonly eventType: string;
    readonly transferId: string;
    readonly occurredAt: Date;
    readonly commandId: string;
    readonly payload: Record<string, unknown>;
  },
): Promise<void> {
  await uow
    .insertInto('platform_domain_events')
    .values({
      event_id: toBin(idGenerator.newId()),
      event_type: input.eventType,
      producer_module: 'finance',
      aggregate_type: 'CASH_TRANSFER',
      aggregate_id: toBin(input.transferId),
      occurred_at: input.occurredAt,
      payload: jsonValue(input.payload),
      command_id: toBin(input.commandId),
    })
    .execute();
}

export function registerCashTransferCommands(
  registry: CommandHandlerRegistry,
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  const deps = { idGenerator };

  // --- finance.cash_transfer.send ----------------------------------------------------------------------

  const send: CommandHandler<CashTransferSendPayload> = async (uow, envelope) => {
    const existing = await uow
      .selectFrom('finance_cash_transfers')
      .select('doc_number')
      .where('id', '=', toBin(envelope.aggregate_id))
      .executeTakeFirst();
    // Même agrégat déjà envoyé (autre `command_id`) : sans effet, numéro existant (R5).
    if (existing) return { status: 'APPLIED', serverRefs: { docNumber: existing.doc_number } };
    try {
      return await sendTransfer(uow, envelope);
    } catch (error) {
      return financeBusinessRejection(error);
    }
  };

  async function sendTransfer(
    uow: Uow,
    envelope: Envelope<CashTransferSendPayload>,
  ): Promise<CommandHandlerOutcome> {
    const p = envelope.payload;
    const transferId = envelope.aggregate_id;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const offline = envelope.captured_offline;

    const from = await findCashAccount(uow, p.fromAccountId);
    const to = await findCashAccount(uow, p.toAccountId);
    if (!from || !to) return rejected('CASH_ACCOUNT_INVALID', 'Compte de trésorerie inconnu.');

    // AV-158 : paires admises (paramètre lu à `occurred_at`). Hors ligne, l'argent a déjà quitté la
    // caisse : le fait est appliqué, signalé à la Finance (BR-SYN-007).
    const pairAllowed = isCashTransferPairAllowed(
      from.accountType,
      to.accountType,
      await cashTransferPairsAt(uow, at),
    );
    if (!pairAllowed && !offline) {
      return rejected(
        'CASH_TRANSFER_PAIR_NOT_ALLOWED',
        `Remise non admise d’un compte ${from.accountType} vers un compte ${to.accountType} (AV-158).`,
      );
    }
    if (!(await canActOnCashAccount(uow, { userId: author, at, account: from }))) {
      return CASH_ACCOUNT_FORBIDDEN;
    }
    if (p.carrierUserId !== undefined) {
      const carrier = await uow
        .selectFrom('identity_users')
        .select('id')
        .where('id', '=', toBin(p.carrierUserId))
        .executeTakeFirst();
      if (!carrier) return rejected('CASH_TRANSFER_CARRIER_INVALID', 'Porteur inconnu.');
    }

    // Les deux comptes sont verrouillés, dans l'ordre de leur identifiant, avant toute écriture :
    // l'état du destinataire est lu sous verrou (une désactivation concurrente est sérialisée) et
    // deux remises croisées ne s'interbloquent pas.
    const locked = await lockCashAccounts(uow, [from.id, to.id]);
    if (!offline && locked.get(to.id)?.status !== 'ACTIVE') {
      return rejected('CASH_ACCOUNT_INACTIVE', 'Le compte destinataire est désactivé.');
    }

    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const warnings = new Set<WarningCode>();
    let localRef = p.localRef ?? null;
    if (localRef !== null && origin.deviceId !== null) {
      const taken = await uow
        .selectFrom('finance_cash_transfers')
        .select('id')
        .where('created_device_id', '=', toBin(origin.deviceId))
        .where('local_ref', '=', localRef)
        .executeTakeFirst();
      if (taken) {
        if (!offline) {
          return rejected(
            'LOCAL_REF_DUPLICATE',
            'Référence locale déjà utilisée par cet appareil.',
          );
        }
        localRef = null;
        warnings.add('LOCAL_REF_DUPLICATE');
      }
    }

    const movement = await recordCashMovement(uow, deps, {
      cashAccountId: from.id,
      direction: 'OUT',
      amountXaf: p.amountXaf,
      movementType: 'TRANSFER_OUT',
      sourceDocType: 'CASH_TRANSFER',
      sourceDocId: transferId,
      occurredAt: at,
      createdBy: author,
      ...(origin.deviceId !== null ? { createdDeviceId: origin.deviceId } : {}),
      commandId: envelope.command_id,
      capturedOffline: offline,
      // BR-FIN-012 : hors ligne, la sortie est un fait accompli.
      allowNegative: offline,
    });
    const numbering = await nextCashTransferNumber(uow, documentSequences, { from, to, at });

    await uow
      .insertInto('finance_cash_transfers')
      .values({
        id: toBin(transferId),
        doc_number: numbering.docNumber,
        local_ref: localRef,
        site_id: toBinOrNull(numbering.siteId),
        from_account_id: toBin(from.id),
        to_account_id: toBin(to.id),
        amount_sent_xaf: p.amountXaf,
        status: 'SENT',
        sent_by: toBin(author),
        sent_device_id: toBinOrNull(origin.deviceId),
        sent_at: at,
        carrier_user_id: toBinOrNull(p.carrierUserId ?? null),
        carrier_name: p.carrierName ?? null,
        out_movement_id: toBin(movement.movementId),
        occurred_at: at,
        command_id: toBin(envelope.command_id),
        client_created_at: new Date(envelope.client_created_at),
        received_at_server: origin.receivedAt,
        created_device_id: toBinOrNull(origin.deviceId),
        captured_offline: offline ? 1 : 0,
        clock_suspect: origin.clockSuspect ? 1 : 0,
        backdated_reason: envelope.backdated_reason,
        created_by: toBin(author),
      })
      .execute();

    if (movement.negativeBalance) {
      // BR-FIN-012 : anomalie `CASH_NEGATIVE`, conflit appliqué pour la Finance.
      await recordConflict(uow, {
        id: idGenerator.newId(),
        commandId: envelope.command_id,
        conflictType: 'CASH_NEGATIVE',
        entityType: 'CASH_ACCOUNT',
        entityId: from.id,
        siteId: from.siteId,
        ownerRole: 'FINANCE',
        applied: true,
        details: {
          transferId,
          docNumber: numbering.docNumber,
          movementId: movement.movementId,
          amountXaf: p.amountXaf,
          balanceAfterXaf: movement.balanceAfterXaf,
        },
      });
      warnings.add('CASH_NEGATIVE');
    }
    if (!pairAllowed) {
      await recordConflict(uow, {
        id: idGenerator.newId(),
        commandId: envelope.command_id,
        conflictType: 'CASH_TRANSFER_PAIR_NOT_ALLOWED',
        entityType: 'CASH_TRANSFER',
        entityId: transferId,
        siteId: numbering.siteId,
        ownerRole: 'FINANCE',
        applied: true,
        details: {
          docNumber: numbering.docNumber,
          fromAccountId: from.id,
          fromAccountType: from.accountType,
          toAccountId: to.id,
          toAccountType: to.accountType,
          amountXaf: p.amountXaf,
        },
      });
      warnings.add('CASH_TRANSFER_PAIR_NOT_ALLOWED');
    }

    const serverRefs = { docNumber: numbering.docNumber };
    // Le commentaire d'envoi n'a pas de colonne : il est tracé par l'audit (D09 §16).
    const audit = {
      after: {
        status: 'SENT',
        docNumber: numbering.docNumber,
        fromAccountId: from.id,
        toAccountId: to.id,
        amountSentXaf: p.amountXaf,
        carrierUserId: p.carrierUserId ?? null,
        carrierName: p.carrierName ?? null,
        comment: p.comment ?? null,
        localRef,
        outMovementId: movement.movementId,
      },
    };
    return warnings.size > 0
      ? { status: 'APPLIED_WITH_WARNINGS', warnings: [...warnings], serverRefs, audit }
      : { status: 'APPLIED', serverRefs, audit };
  }

  // --- Observation d'une course hors ligne (AV-173) ---------------------------------------------------

  async function observeRace(
    uow: Uow,
    envelope: Envelope<unknown>,
    transfer: TransferRow,
    code:
      | 'CASH_TRANSFER_RECEIVED_AFTER_CANCEL'
      | 'CASH_TRANSFER_CANCEL_AFTER_RECEIVE'
      | 'CASH_TRANSFER_RECEIVED_TWICE',
    observed: Record<string, unknown>,
  ): Promise<CommandHandlerOutcome> {
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    await recordConflict(uow, {
      id: idGenerator.newId(),
      commandId: envelope.command_id,
      conflictType: code,
      entityType: 'CASH_TRANSFER',
      entityId: transfer.id,
      siteId: transfer.siteId,
      ownerRole: 'FINANCE',
      applied: true,
      details: {
        docNumber: transfer.docNumber,
        statusFound: transfer.status,
        amountSentXaf: transfer.amountSentXaf,
        amountReceivedXaf: transfer.amountReceivedXaf,
        receivedBy: transfer.receivedBy,
        cancelledAt: transfer.cancelledAt?.toISOString() ?? null,
        cancelledBy: transfer.cancelledBy,
        observedBy: envelope.author_user_id,
        observedDeviceId: origin.deviceId,
        observedAt: envelope.occurred_at,
        ...observed,
      },
    });
    return {
      status: 'APPLIED_WITH_WARNINGS',
      warnings: [code],
      serverRefs: { docNumber: transfer.docNumber },
      audit: {
        before: { status: transfer.status },
        after: { status: transfer.status, observation: code, ...observed },
      },
    };
  }

  // --- finance.cash_transfer.receive -------------------------------------------------------------------

  const receive: CommandHandler<CashTransferReceivePayload> = async (uow, envelope) => {
    try {
      return await receiveTransfer(uow, envelope);
    } catch (error) {
      return financeBusinessRejection(error);
    }
  };

  async function receiveTransfer(
    uow: Uow,
    envelope: Envelope<CashTransferReceivePayload>,
  ): Promise<CommandHandlerOutcome> {
    const p = envelope.payload;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const offline = envelope.captured_offline;

    const transfer = await lockTransfer(uow, envelope.aggregate_id);
    if (!transfer) return NOT_FOUND;
    if (transfer.receiveCommandId === envelope.command_id) {
      return { status: 'APPLIED', serverRefs: { docNumber: transfer.docNumber } };
    }
    const to = await findCashAccount(uow, transfer.toAccountId);
    if (!to || !(await canActOnCashAccount(uow, { userId: author, at, account: to }))) {
      return CASH_ACCOUNT_FORBIDDEN;
    }
    // AV-172 : séparation des tâches — une règle d'autorisation, appliquée aussi hors ligne.
    if (!isAllowedTransferReceiver(author, transfer.sentBy)) {
      return rejected(
        'CASH_TRANSFER_SELF_RECEIVE',
        'L’expéditeur d’une remise ne peut pas la réceptionner lui-même.',
      );
    }
    const decision = decideCashTransferAction(transfer.status, 'RECEIVE', offline);
    if (decision.kind === 'REJECT') return rejected(decision.code, decision.messageFr);
    if (decision.kind === 'OBSERVE') {
      return observeRace(uow, envelope, transfer, decision.code, {
        receivedXaf: p.receivedXaf,
        comment: p.comment ?? null,
      });
    }
    if (!offline && at.getTime() < transfer.sentAt.getTime()) {
      return rejected(
        'CASH_TRANSFER_BEFORE_SENT',
        'Une remise ne peut pas être reçue avant son envoi.',
      );
    }

    const discrepancyXaf = transferDiscrepancyXaf(transfer.amountSentXaf, p.receivedXaf);
    const status = transferStatusAfterReceive(transfer.amountSentXaf, p.receivedXaf);
    const origin = await loadCommandOrigin(uow, envelope.command_id);

    let inMovementId: string | null = null;
    if (p.receivedXaf > 0) {
      const movement = await recordCashMovement(uow, deps, {
        cashAccountId: to.id,
        direction: 'IN',
        amountXaf: p.receivedXaf,
        movementType: 'TRANSFER_IN',
        sourceDocType: 'CASH_TRANSFER',
        sourceDocId: transfer.id,
        occurredAt: at,
        createdBy: author,
        ...(origin.deviceId !== null ? { createdDeviceId: origin.deviceId } : {}),
        commandId: envelope.command_id,
        capturedOffline: offline,
        allowNegative: true,
      });
      inMovementId = movement.movementId;
    }

    let approvalRequestId: string | null = null;
    if (discrepancyXaf !== 0) {
      const policy = await transferDiscrepancyPolicy(
        uow,
        at,
        offline ? origin.receivedAt : undefined,
      );
      if (!policy) {
        return rejected(
          'CONTROL_POLICY_MISSING',
          'Aucune politique de contrôle CASH_TRANSFER_DISCREPANCY active avec approbateur (approvals.policy.set) : la validation de l’écart est obligatoire.',
        );
      }
      const siteId = transfer.siteId ?? to.siteId;
      const site = siteId !== null ? await loadSiteRef(uow, siteId) : undefined;
      approvalRequestId = idGenerator.newId();
      await requestApproval(uow, {
        requestId: approvalRequestId,
        operationType: 'CASH_TRANSFER_DISCREPANCY',
        subjectType: 'CASH_TRANSFER',
        subjectId: transfer.id,
        subjectSummary:
          `Remise ${transfer.docNumber} : envoyé ${transfer.amountSentXaf} XAF, reçu ` +
          `${p.receivedXaf} XAF, écart ${discrepancyXaf} XAF` +
          (p.comment !== undefined ? ` — ${p.comment}` : ''),
        ...(site ? { siteId: site.id, zoneId: site.zoneId } : {}),
        amountXaf: Math.abs(discrepancyXaf),
        requestedBy: author,
        requestedAt: at,
        policyId: policy.id,
        policyVersion: policy.version,
      });
      await insertFinanceEvent(uow, idGenerator, {
        eventType: 'CashTransferDiscrepancyDetected',
        transferId: transfer.id,
        occurredAt: at,
        commandId: envelope.command_id,
        payload: {
          transfer_id: transfer.id,
          doc_number: transfer.docNumber,
          from_account_id: transfer.fromAccountId,
          to_account_id: transfer.toAccountId,
          amount_sent_xaf: transfer.amountSentXaf,
          amount_received_xaf: p.receivedXaf,
          discrepancy_xaf: discrepancyXaf,
          approval_request_id: approvalRequestId,
          received_by: author,
          site_id: siteId,
        },
      });
    }

    await uow
      .updateTable('finance_cash_transfers')
      .set({
        status,
        amount_received_xaf: p.receivedXaf,
        discrepancy_xaf: discrepancyXaf,
        received_by: toBin(author),
        received_device_id: toBinOrNull(origin.deviceId),
        received_at: at,
        in_movement_id: toBinOrNull(inMovementId),
        approval_request_id: toBinOrNull(approvalRequestId),
        receive_command_id: toBin(envelope.command_id),
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(transfer.id))
      .execute();

    const serverRefs = { docNumber: transfer.docNumber };
    const audit = {
      before: { status: transfer.status },
      after: {
        status,
        amountSentXaf: transfer.amountSentXaf,
        amountReceivedXaf: p.receivedXaf,
        discrepancyXaf,
        inMovementId,
        approvalRequestId,
        comment: p.comment ?? null,
      },
    };
    return discrepancyXaf !== 0
      ? {
          status: 'APPLIED_WITH_WARNINGS',
          warnings: ['CASH_TRANSFER_DISCREPANCY'],
          serverRefs,
          audit,
        }
      : { status: 'APPLIED', serverRefs, audit };
  }

  // --- finance.cash_transfer.cancel --------------------------------------------------------------------

  const cancel: CommandHandler<CashTransferCancelPayload> = async (uow, envelope) => {
    try {
      return await cancelTransfer(uow, envelope);
    } catch (error) {
      return financeBusinessRejection(error);
    }
  };

  async function cancelTransfer(
    uow: Uow,
    envelope: Envelope<CashTransferCancelPayload>,
  ): Promise<CommandHandlerOutcome> {
    const p = envelope.payload;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const offline = envelope.captured_offline;

    const transfer = await lockTransfer(uow, envelope.aggregate_id);
    if (!transfer) return NOT_FOUND;
    // SM-CASH-TRANSFER, AV-172 : l'expéditeur seul annule (règle d'autorisation, hors ligne compris).
    if (author !== transfer.sentBy) {
      return rejected('CASH_TRANSFER_NOT_SENDER', 'Seul l’expéditeur d’une remise peut l’annuler.');
    }
    const from = await findCashAccount(uow, transfer.fromAccountId);
    if (!from || !(await canActOnCashAccount(uow, { userId: author, at, account: from }))) {
      return CASH_ACCOUNT_FORBIDDEN;
    }
    const decision = decideCashTransferAction(transfer.status, 'CANCEL', offline);
    if (decision.kind === 'NOOP') {
      return { status: 'APPLIED', serverRefs: { docNumber: transfer.docNumber } };
    }
    if (decision.kind === 'REJECT') return rejected(decision.code, decision.messageFr);
    if (decision.kind === 'OBSERVE') {
      return observeRace(uow, envelope, transfer, decision.code, { reason: p.reason });
    }
    if (!offline && at.getTime() < transfer.sentAt.getTime()) {
      return rejected(
        'CASH_TRANSFER_BEFORE_SENT',
        'Une remise ne peut pas être annulée avant son envoi.',
      );
    }

    const origin = await loadCommandOrigin(uow, envelope.command_id);
    // Inverse comptable de la sortie (même compte, montant, type et document, sens IN) mais fait
    // physique nouveau, daté de l'annulation : il tombe dans la session couvrant sa propre date
    // (ADR-032 §2, AV-157 (a)), jamais dans celle de l'envoi.
    const reversal = await recordCashMovement(uow, deps, {
      cashAccountId: from.id,
      direction: 'IN',
      amountXaf: transfer.amountSentXaf,
      movementType: 'TRANSFER_OUT',
      sourceDocType: 'CASH_TRANSFER',
      sourceDocId: transfer.id,
      reversesMovementId: transfer.outMovementId,
      occurredAt: at,
      createdBy: author,
      ...(origin.deviceId !== null ? { createdDeviceId: origin.deviceId } : {}),
      commandId: envelope.command_id,
      capturedOffline: offline,
      allowNegative: true,
    });
    await uow
      .updateTable('finance_cash_transfers')
      .set({
        status: 'CANCELLED',
        cancel_reason: p.reason,
        cancelled_by: toBin(author),
        cancelled_at: at,
        cancel_movement_id: toBin(reversal.movementId),
        cancel_command_id: toBin(envelope.command_id),
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(transfer.id))
      .execute();
    return {
      status: 'APPLIED',
      serverRefs: { docNumber: transfer.docNumber },
      audit: {
        before: { status: transfer.status },
        after: { status: 'CANCELLED', reason: p.reason, cancelMovementId: reversal.movementId },
      },
    };
  }

  registry.register({
    commandType: 'finance.cash_transfer.send',
    version: 1,
    payloadSchema: cashTransferSendPayloadSchema,
    permissionCode: CASH_TRANSFER_PERMISSION,
    handler: send,
  });
  registry.register({
    commandType: 'finance.cash_transfer.receive',
    version: 1,
    payloadSchema: cashTransferReceivePayloadSchema,
    permissionCode: CASH_TRANSFER_PERMISSION,
    handler: receive,
  });
  registry.register({
    commandType: 'finance.cash_transfer.cancel',
    version: 1,
    payloadSchema: cashTransferCancelPayloadSchema,
    permissionCode: CASH_TRANSFER_PERMISSION,
    handler: cancel,
  });

  // --- Décision CASH_TRANSFER_DISCREPANCY (ADR-018, ADR-032 §7, AV-174) ---------------------------------

  decisionRegistry.register('CASH_TRANSFER_DISCREPANCY', async (uow, ctx) => {
    const transfer = await lockTransfer(uow, ctx.subjectId);
    if (!transfer) {
      throw new ApprovalDecisionRefused('NOT_FOUND', 'Remise de fonds introuvable.');
    }
    if (transfer.status !== 'DISCREPANCY_PENDING' || transfer.approvalRequestId !== ctx.requestId) {
      throw new ApprovalDecisionRefused(
        'CASH_TRANSFER_STATUS_INVALID',
        'Cette remise n’a pas d’écart en attente pour cette demande.',
      );
    }
    if (ctx.decision === 'REJECTED') {
      // AV-174 : l'écart est déjà dans les livres ; on l'impute, on ne le refuse pas.
      throw new ApprovalDecisionRefused(
        'CASH_TRANSFER_DISCREPANCY_NOT_REJECTABLE',
        'L’écart d’une remise ne se rejette pas : l’approuver en choisissant son imputation et son motif (une erreur de saisie se corrige par une remise de régularisation).',
      );
    }
    if (
      !isAllowedTransferValidator(ctx.decidedBy, {
        sentBy: transfer.sentBy,
        receivedBy: transfer.receivedBy,
        carrierUserId: transfer.carrierUserId,
      })
    ) {
      throw new ApprovalDecisionRefused(
        'CASH_TRANSFER_VALIDATOR_INVOLVED',
        'Le valideur d’un écart de remise n’est ni l’expéditeur, ni le récepteur, ni le porteur.',
      );
    }
    let imputation: string;
    try {
      imputation = checkTransferImputation(ctx.decisionOption, {
        carrierUserId: transfer.carrierUserId,
        carrierName: transfer.carrierName,
      });
    } catch (error) {
      if (error instanceof DomainError)
        throw new ApprovalDecisionRefused(error.code, error.message);
      throw error;
    }
    const reason = ctx.decisionData?.['reason']?.trim() ?? '';
    if (reason === '') {
      throw new ApprovalDecisionRefused(
        'REASON_REQUIRED',
        'Motif de la clôture de l’écart obligatoire (decisionData.reason).',
      );
    }
    // Aucun mouvement de trésorerie : la différence est déjà sortie des livres (ADR-032 §7).
    await uow
      .updateTable('finance_cash_transfers')
      .set({
        status: 'CLOSED',
        imputation,
        closing_reason: reason,
        closed_by: toBin(ctx.decidedBy),
        closed_at: ctx.decidedAt,
        updated_by: toBin(ctx.decidedBy),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(transfer.id))
      .execute();
  });

  // AV-174 : l'écart reste à décider — le récepteur ne retire pas la demande (sinon la remise
  // resterait `DISCREPANCY_PENDING` sans décision possible).
  decisionRegistry.registerWithdrawalGuard('CASH_TRANSFER_DISCREPANCY', async () => {
    throw new ApprovalDecisionRefused(
      'CASH_TRANSFER_DISCREPANCY_NOT_WITHDRAWABLE',
      'La demande de validation d’un écart de remise ne se retire pas : la Finance la décide.',
    );
  });
}
