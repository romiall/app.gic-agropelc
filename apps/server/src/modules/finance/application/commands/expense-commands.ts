/**
 * Dépenses (P8-05 ; ADR-042 ; SM-EXPENSE ; D09 BR-FIN-020 à 022, D05 BR-DIS-013 ; AV-058, AV-264 à
 * AV-270) : enregistrement (`finance.expense.record`, hors ligne admis), paiement d'une dépense à
 * payer (`finance.expense.pay`, en ligne), annulation d'une dépense non payée (`finance.expense.cancel`,
 * en ligne). Les décisions `EXPENSE` sont dans `expense-decisions.ts`.
 *
 * - **Seuils** (AV-058) : validation et justificatif au-delà des paramètres, comparaisons strictes ;
 *   la politique `EXPENSE` dit qui approuve ; sans politique, aucune validation (AV-264).
 * - **Caisse de PDV** (BR-DIS-013, AV-266, AV-267) : catégorie permise au PDV, plafond, session ouverte
 *   qui couvre l'heure de la dépense, comme un encaissement en espèces (P5-14) : refus précoce sur une
 *   lecture simple, puis contrôle repris sous le verrou du compte (`recordCashMovement`).
 * - **Hors ligne** (BR-SYN-007, ADR-042 §6, AV-265) : jamais de refus pour une raison d'état métier ;
 *   une règle que seul le serveur peut juger place la dépense en validation a posteriori (motifs dans
 *   `review_reasons`, avertissement `EXPENSE_REVIEW_REQUIRED`) ; caisse négative `CASH_NEGATIVE`,
 *   session manquante `CASH_SESSION_MISSING` (conflits informatifs pour la Finance). En ligne, les mêmes
 *   règles refusent la commande.
 * - **Coût** (BR-FIN-022, ADR-042 §8) : écriture par l'API d'`inventory` dès l'enregistrement sans
 *   validation, sinon à l'approbation ; contrepassée à l'annulation (garde des frais généraux déjà
 *   répartis, `OVERHEAD_ALREADY_ALLOCATED`).
 * - **Verrous** (ADR-038, ADR-043 §9) : dépense (document), compte (dans `recordCashMovement`), session
 *   (partagé), demande, compteur ; une dépense neuve n'est qu'insérée.
 */
import {
  EXPENSE_REVIEW_ERROR_CODES,
  businessDayOf,
  expensePhotoRequired,
  expenseRequiresApproval,
  expenseReviewReasons,
  expenseStatusAtRecord,
  expenseTransition,
  type ExpenseCostObjectState,
  type ExpenseReviewReason,
  type ExpenseStatus,
  type IdGenerator,
} from '@gic/domain';
import {
  expenseCancelPayloadSchema,
  expensePayPayloadSchema,
  expenseRecordPayloadSchema,
  type ExpenseCancelPayload,
  type ExpensePayPayload,
  type ExpenseRecordPayload,
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
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { evaluateAccess } from '../../../identity/application/public/index.js';
import {
  cancelApprovalRequest,
  requestApproval,
} from '../../../approvals/application/public/index.js';
import {
  lockOverheadPool,
  lotCostObjectStatus,
  overheadPeriodOf,
  siteOverheadMonthAllocated,
} from '../../../inventory/application/public/index.js';
import { findSupplier } from '../../../procurement/application/public/index.js';
import { recordCashMovement } from '../public/cash-movements.js';
import { findCashAccount } from '../public/cash-accounts.js';
import { findCashSessionCovering } from '../public/cash-sessions.js';
import type { CashAccountSummary } from '../public/cash-accounts.js';
import {
  CASH_ACCOUNT_FORBIDDEN,
  canActOnCashAccount,
  financeBusinessRejection,
  loadSiteRef,
  rejected,
} from '../cash-transfer-support.js';
import {
  EXPENSE_APPROVE_PERMISSION,
  EXPENSE_DOC_TYPE,
  EXPENSE_PAY_PERMISSION,
  EXPENSE_RECORD_PERMISSION,
  expensePolicy,
  expenseSettingsAt,
  insertExpenseEvent,
  loadExpense,
  loadExpenseCategory,
  reverseExpenseCost,
  writeExpenseCost,
  type ExpenseCategoryRow,
} from '../expense-support.js';
import { emitExpenseChange } from '../sync-changes.js';

type Uow = Transaction<DB>;
type Envelope<P> = Parameters<CommandHandler<P>>[1];

const REVIEW_MESSAGES: Readonly<Record<ExpenseReviewReason, string>> = {
  CATEGORY_INACTIVE: 'Catégorie de dépense désactivée ou réservée au système.',
  CATEGORY_NOT_ALLOWED_ON_POS:
    'Cette catégorie de dépense n’est pas permise sur la caisse d’un point de vente (BR-DIS-013).',
  POS_CAP_EXCEEDED:
    'Montant au-delà du plafond d’une dépense payée par la caisse du point de vente (BR-DIS-013).',
  ATTACHMENT_MISSING: 'Justificatif exigé au-delà du seuil : joindre la photo du reçu (AV-058).',
  COST_OBJECT_CLOSED: 'Le lot imputé est clos : la dépense ne peut plus lui être imputée.',
};

const sessionRequired = (closed: boolean): CommandHandlerOutcome =>
  rejected(
    'CASH_SESSION_REQUIRED',
    closed
      ? 'La session de caisse qui couvre cette heure est close : ouvrir la caisse avant de payer en espèces.'
      : 'Aucune session de caisse ouverte sur ce point de vente : ouvrir la caisse avant de payer en espèces (BR-DIS-005).',
  );

/** Portée de l'auteur sur le site de la dépense (et la propriété `OWN` : l'auteur). */
async function allowedOnSite(
  uow: Uow,
  input: {
    readonly userId: string;
    readonly permissionCode: string;
    readonly siteId: string;
    readonly ownerUserId: string;
    readonly at: Date;
  },
): Promise<boolean> {
  const access = await evaluateAccess(uow, {
    userId: input.userId,
    permissionCode: input.permissionCode,
    occurredAt: input.at,
    resource: { siteId: input.siteId, ownerUserId: input.ownerUserId },
  });
  return access.allowed;
}

export function registerExpenseCommands(
  registry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  const deps = { idGenerator };

  // --- finance.expense.record --------------------------------------------------------------------

  const record: CommandHandler<ExpenseRecordPayload> = async (uow, envelope) => {
    const existing = await uow
      .selectFrom('finance_expenses')
      .select(['doc_number', 'status'])
      .where('id', '=', toBin(envelope.aggregate_id))
      .executeTakeFirst();
    // Même agrégat déjà enregistré (autre `command_id`) : sans effet, numéro existant (R5).
    if (existing) {
      return {
        status: 'APPLIED',
        serverRefs: { docNumber: existing.doc_number, status: existing.status },
      };
    }
    try {
      return await recordExpense(uow, envelope);
    } catch (error) {
      return financeBusinessRejection(error);
    }
  };

  async function costObjectState(
    uow: Uow,
    costObject: ExpenseRecordPayload['costObject'],
  ): Promise<ExpenseCostObjectState | 'UNKNOWN'> {
    if (costObject === undefined) return 'NONE';
    if (costObject.type === 'SITE') {
      return (await loadSiteRef(uow, costObject.id)) ? 'OPEN' : 'UNKNOWN';
    }
    return lotCostObjectStatus(uow, {
      costObjectType: costObject.type,
      costObjectId: costObject.id,
    });
  }

  async function recordExpense(
    uow: Uow,
    envelope: Envelope<ExpenseRecordPayload>,
  ): Promise<CommandHandlerOutcome> {
    const p = envelope.payload;
    const expenseId = envelope.aggregate_id;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const offline = envelope.captured_offline;

    // Validité et autorisation : seuls motifs de refus d'un fait accompli (BR-SYN-007).
    const category = await loadExpenseCategory(uow, p.categoryId);
    if (!category) return rejected('EXPENSE_CATEGORY_UNKNOWN', 'Catégorie de dépense inconnue.');
    const site = await loadSiteRef(uow, p.siteId);
    if (!site) return rejected('NOT_FOUND', 'Site de la dépense introuvable.');
    if (
      !(await allowedOnSite(uow, {
        userId: author,
        permissionCode: EXPENSE_RECORD_PERMISSION,
        siteId: site.id,
        ownerUserId: author,
        at,
      }))
    ) {
      return rejected('FORBIDDEN_SCOPE', 'Site de la dépense hors de votre périmètre.');
    }
    if (p.supplierId !== undefined && !(await findSupplier(uow, p.supplierId))) {
      return rejected('NOT_FOUND', 'Fournisseur inconnu.');
    }
    const objectState = await costObjectState(uow, p.costObject);
    if (objectState === 'UNKNOWN') {
      return rejected(
        'COST_OBJECT_UNKNOWN',
        'Objet de coût inconnu (lot, lot d’incubation ou site).',
      );
    }
    // Revue de P8-14 (ADR-042 §8) : un site comme objet de coût est le site de la dépense, dont la
    // portée vient d'être vérifiée ; des frais généraux d'une espèce se répartissent sur une ferme.
    if (p.costObject?.type === 'SITE') {
      if (p.costObject.id.toLowerCase() !== site.id) {
        return rejected(
          'COST_OBJECT_INVALID',
          'Les frais d’un site s’imputent au site de la dépense.',
        );
      }
      if (p.costObject.speciesGroup !== undefined && site.siteType !== 'FERME') {
        return rejected(
          'SITE_NOT_FARM',
          'Les frais généraux d’une espèce se saisissent sur une ferme.',
        );
      }
    }
    let account: CashAccountSummary | undefined;
    if (p.paidNow) {
      account = await findCashAccount(uow, p.paidFromAccountId!);
      if (!account) return rejected('CASH_ACCOUNT_INVALID', 'Compte de trésorerie inconnu.');
      if (
        !(await canActOnCashAccount(uow, {
          userId: author,
          at,
          account,
          permissionCode: EXPENSE_RECORD_PERMISSION,
        }))
      ) {
        return CASH_ACCOUNT_FORBIDDEN;
      }
    }
    const paidFromPos = account?.accountType === 'CAISSE_PDV';

    const settings = await expenseSettingsAt(uow, at);
    const reasons = expenseReviewReasons({
      category,
      amountXaf: p.amountXaf,
      paidFromPos,
      posCapXaf: settings.posCapXaf,
      photoThresholdXaf: settings.photoThresholdXaf,
      hasAttachment: envelope.attachment_ids.length > 0,
      costObject: objectState,
    });
    if (!offline && reasons.length > 0) {
      const reason = reasons[0]!;
      return rejected(EXPENSE_REVIEW_ERROR_CODES[reason], REVIEW_MESSAGES[reason]);
    }
    // P5-14 (BR-DIS-005) : en ligne, refus précoce sur une lecture simple, repris sous le verrou du compte.
    if (paidFromPos && !offline) {
      const covering = await findCashSessionCovering(uow, account!.id, at);
      if (covering?.status !== 'OPEN') return sessionRequired(covering !== null);
    }

    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const policy = await expensePolicy(uow, at, offline ? origin.receivedAt : undefined);
    const status = expenseStatusAtRecord({
      paidNow: p.paidNow,
      overThreshold: expenseRequiresApproval(p.amountXaf, settings.approvalThresholdXaf),
      reviewReasonCount: reasons.length,
      policyAvailable: policy !== undefined,
    });

    const warnings = new Set<WarningCode>();
    let localRef = p.localRef ?? null;
    if (localRef !== null && origin.deviceId !== null) {
      const taken = await uow
        .selectFrom('finance_expenses')
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

    // Décaissement (fait accompli hors ligne, BR-FIN-012) : le compte est verrouillé ici.
    const movement = p.paidNow
      ? await recordCashMovement(uow, deps, {
          cashAccountId: account!.id,
          direction: 'OUT',
          amountXaf: p.amountXaf,
          movementType: 'EXPENSE',
          sourceDocType: 'EXPENSE',
          sourceDocId: expenseId,
          occurredAt: at,
          createdBy: author,
          ...(origin.deviceId !== null ? { createdDeviceId: origin.deviceId } : {}),
          commandId: envelope.command_id,
          capturedOffline: offline,
          allowNegative: offline,
        })
      : null;
    // Contrôle repris sous le verrou du compte (une clôture validée entre-temps, P5-14).
    if (movement !== null && paidFromPos && !offline && movement.cashSessionId === null) {
      return sessionRequired(true);
    }

    // ADR-038 : la demande (rang N11) précède le compteur de numéros (N12).
    let approvalRequestId: string | null = null;
    if (status === 'PENDING_APPROVAL' || status === 'PAID_PENDING_APPROVAL') {
      approvalRequestId = idGenerator.newId();
      await requestApproval(uow, {
        requestId: approvalRequestId,
        operationType: 'EXPENSE',
        subjectType: 'EXPENSE',
        subjectId: expenseId,
        subjectSummary: `Dépense ${category.label} — ${p.amountXaf} XAF — ${site.code}`,
        siteId: site.id,
        zoneId: site.zoneId,
        amountXaf: p.amountXaf,
        requestedBy: author,
        requestedAt: at,
        policyId: policy!.id,
        policyVersion: policy!.version,
        // BR-ADM-020 : l'approbateur attend le justificatif exigé.
        ...(expensePhotoRequired(p.amountXaf, settings.photoThresholdXaf) &&
        envelope.attachment_ids.length > 0
          ? { requiredAttachmentIds: envelope.attachment_ids }
          : {}),
      });
    }

    const year = Number(businessDayOf(at).slice(0, 4));
    const docNumber = await documentSequences.next(uow, {
      docType: EXPENSE_DOC_TYPE,
      siteId: site.id,
      codeSite: site.code,
      year,
    });

    await uow
      .insertInto('finance_expenses')
      .values({
        id: toBin(expenseId),
        doc_number: docNumber,
        local_ref: localRef,
        site_id: toBin(site.id),
        category_id: toBin(category.id),
        amount_xaf: p.amountXaf,
        payee_name: p.payeeName ?? null,
        supplier_id: toBinOrNull(p.supplierId ?? null),
        description: p.description,
        cost_object_type: p.costObject?.type ?? null,
        cost_object_id: toBinOrNull(p.costObject?.id ?? null),
        species_group: p.costObject?.speciesGroup ?? null,
        paid_now: p.paidNow ? 1 : 0,
        paid_from_account_id: toBinOrNull(account?.id ?? null),
        paid_at: movement !== null ? at : null,
        paid_by: movement !== null ? toBin(author) : null,
        cash_movement_id: toBinOrNull(movement?.movementId ?? null),
        status,
        review_reasons: reasons.length > 0 ? jsonValue([...reasons]) : null,
        approval_request_id: toBinOrNull(approvalRequestId),
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

    const expense = {
      id: expenseId,
      docNumber,
      amountXaf: p.amountXaf,
      costObjectType: p.costObject?.type ?? null,
      costObjectId: p.costObject?.id ?? null,
      speciesGroup: p.costObject?.speciesGroup ?? null,
      occurredAt: at,
    };
    // BR-FIN-022 : coût dès l'enregistrement s'il n'attend aucune validation.
    if (status === 'RECORDED' || status === 'PAID') {
      await writeExpenseCost(uow, deps, {
        expense,
        categoryCostType: category.defaultCostType,
        createdBy: author,
      });
    }
    await emitExpenseChange(uow, expenseId);
    await insertExpenseEvent(uow, idGenerator, {
      eventType: 'ExpenseRecorded',
      expenseId,
      occurredAt: at,
      commandId: envelope.command_id,
      payload: {
        docNumber,
        categoryCode: category.code,
        amountXaf: p.amountXaf,
        status,
        siteId: site.id,
      },
    });
    if (movement !== null) {
      await insertExpenseEvent(uow, idGenerator, {
        eventType: 'ExpensePaid',
        expenseId,
        occurredAt: at,
        commandId: envelope.command_id,
        payload: { docNumber, amountXaf: p.amountXaf, cashAccountId: account!.id },
      });
    }

    if (movement?.negativeBalance) {
      await recordConflict(uow, {
        id: idGenerator.newId(),
        commandId: envelope.command_id,
        conflictType: 'CASH_NEGATIVE',
        entityType: 'CASH_ACCOUNT',
        entityId: account!.id,
        siteId: account!.siteId,
        ownerRole: 'FINANCE',
        applied: true,
        details: {
          expenseId,
          docNumber,
          movementId: movement.movementId,
          amountXaf: p.amountXaf,
          balanceAfterXaf: movement.balanceAfterXaf,
        },
      });
      warnings.add('CASH_NEGATIVE');
    }
    // AV-267 : hors ligne, espèces de PDV sans session couvrant l'heure → conflit informatif.
    if (movement !== null && paidFromPos && offline && movement.cashSessionId === null) {
      await recordConflict(uow, {
        id: idGenerator.newId(),
        commandId: envelope.command_id,
        conflictType: 'CASH_SESSION_MISSING',
        entityType: 'EXPENSE',
        entityId: expenseId,
        siteId: site.id,
        ownerRole: 'FINANCE',
        applied: true,
        details: {
          cashAccountId: account!.id,
          amountXaf: p.amountXaf,
          occurredAt: at.toISOString(),
          deviceId: origin.deviceId,
          docNumber,
        },
      });
      warnings.add('CASH_SESSION_MISSING');
    }
    if (reasons.length > 0) warnings.add('EXPENSE_REVIEW_REQUIRED');

    const serverRefs = {
      docNumber,
      status,
      ...(approvalRequestId !== null ? { approvalRequestId } : {}),
    };
    const audit = {
      after: {
        status,
        docNumber,
        categoryId: category.id,
        amountXaf: p.amountXaf,
        siteId: site.id,
        paidNow: p.paidNow,
        paidFromAccountId: account?.id ?? null,
        costObject: p.costObject ?? null,
        reviewReasons: reasons,
        approvalRequestId,
        localRef,
        movementId: movement?.movementId ?? null,
      },
    };
    return warnings.size > 0
      ? { status: 'APPLIED_WITH_WARNINGS', warnings: [...warnings], serverRefs, audit }
      : { status: 'APPLIED', serverRefs, audit };
  }

  // --- finance.expense.pay -----------------------------------------------------------------------

  const pay: CommandHandler<ExpensePayPayload> = async (uow, envelope) => {
    if (envelope.captured_offline) {
      return rejected('ONLINE_REQUIRED', 'Le paiement d’une dépense à payer se fait en ligne.');
    }
    try {
      return await payExpense(uow, envelope);
    } catch (error) {
      return financeBusinessRejection(error);
    }
  };

  async function payExpense(
    uow: Uow,
    envelope: Envelope<ExpensePayPayload>,
  ): Promise<CommandHandlerOutcome> {
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const expense = await loadExpense(uow, envelope.aggregate_id, { lock: 'update' });
    if (!expense) return rejected('NOT_FOUND', 'Dépense introuvable.');
    if (
      expense.status === 'PAID' &&
      expense.paidFromAccountId === envelope.payload.paidFromAccountId
    ) {
      return { status: 'APPLIED', serverRefs: { docNumber: expense.docNumber, status: 'PAID' } }; // rejeu
    }
    const next = expenseTransition(expense.status, 'PAY');
    if (
      !(await allowedOnSite(uow, {
        userId: author,
        permissionCode: EXPENSE_PAY_PERMISSION,
        siteId: expense.siteId,
        ownerUserId: expense.createdBy,
        at,
      }))
    ) {
      return rejected('FORBIDDEN_SCOPE', 'Dépense hors de votre périmètre.');
    }
    const account = await findCashAccount(uow, envelope.payload.paidFromAccountId);
    if (!account) return rejected('CASH_ACCOUNT_INVALID', 'Compte de trésorerie inconnu.');
    if (
      !(await canActOnCashAccount(uow, {
        userId: author,
        at,
        account,
        permissionCode: EXPENSE_PAY_PERMISSION,
      }))
    ) {
      return CASH_ACCOUNT_FORBIDDEN;
    }
    const category = (await loadExpenseCategory(uow, expense.categoryId)) as ExpenseCategoryRow;
    if (account.accountType === 'CAISSE_PDV') {
      const settings = await expenseSettingsAt(uow, at);
      if (!category.allowedOnPos) {
        return rejected(
          EXPENSE_REVIEW_ERROR_CODES.CATEGORY_NOT_ALLOWED_ON_POS,
          REVIEW_MESSAGES.CATEGORY_NOT_ALLOWED_ON_POS,
        );
      }
      if (expense.amountXaf > settings.posCapXaf) {
        return rejected(
          EXPENSE_REVIEW_ERROR_CODES.POS_CAP_EXCEEDED,
          REVIEW_MESSAGES.POS_CAP_EXCEEDED,
        );
      }
      const covering = await findCashSessionCovering(uow, account.id, at);
      if (covering?.status !== 'OPEN') return sessionRequired(covering !== null);
    }
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const movement = await recordCashMovement(uow, deps, {
      cashAccountId: account.id,
      direction: 'OUT',
      amountXaf: expense.amountXaf,
      movementType: 'EXPENSE',
      sourceDocType: 'EXPENSE',
      sourceDocId: expense.id,
      occurredAt: at,
      createdBy: author,
      ...(origin.deviceId !== null ? { createdDeviceId: origin.deviceId } : {}),
      commandId: envelope.command_id,
      capturedOffline: false,
      allowNegative: false,
    });
    if (account.accountType === 'CAISSE_PDV' && movement.cashSessionId === null)
      return sessionRequired(true);
    await uow
      .updateTable('finance_expenses')
      .set({
        status: next,
        paid_from_account_id: toBin(account.id),
        paid_at: at,
        paid_by: toBin(author),
        cash_movement_id: toBin(movement.movementId),
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(expense.id))
      .execute();
    await emitExpenseChange(uow, expense.id);
    await insertExpenseEvent(uow, idGenerator, {
      eventType: 'ExpensePaid',
      expenseId: expense.id,
      occurredAt: at,
      commandId: envelope.command_id,
      payload: {
        docNumber: expense.docNumber,
        amountXaf: expense.amountXaf,
        cashAccountId: account.id,
      },
    });
    return {
      status: 'APPLIED',
      serverRefs: { docNumber: expense.docNumber, status: next },
      audit: {
        before: { status: expense.status },
        after: { status: next, paidFromAccountId: account.id, movementId: movement.movementId },
      },
    };
  }

  // --- finance.expense.cancel --------------------------------------------------------------------

  const cancel: CommandHandler<ExpenseCancelPayload> = async (uow, envelope) => {
    if (envelope.captured_offline) {
      return rejected('ONLINE_REQUIRED', 'L’annulation d’une dépense se fait en ligne.');
    }
    try {
      return await cancelExpense(uow, envelope);
    } catch (error) {
      return financeBusinessRejection(error);
    }
  };

  async function cancelExpense(
    uow: Uow,
    envelope: Envelope<ExpenseCancelPayload>,
  ): Promise<CommandHandlerOutcome> {
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const expense = await loadExpense(uow, envelope.aggregate_id, { lock: 'update' });
    if (!expense) return rejected('NOT_FOUND', 'Dépense introuvable.');
    if (expense.status === 'CANCELLED') {
      return {
        status: 'APPLIED',
        serverRefs: { docNumber: expense.docNumber, status: 'CANCELLED' },
      };
    }
    const next: ExpenseStatus = expenseTransition(expense.status, 'CANCEL');
    // SM-EXPENSE : l'auteur (`finance.expense.record`), ou un approbateur (`finance.expense.approve`).
    const allowed =
      expense.createdBy === author
        ? await allowedOnSite(uow, {
            userId: author,
            permissionCode: EXPENSE_RECORD_PERMISSION,
            siteId: expense.siteId,
            ownerUserId: expense.createdBy,
            at,
          })
        : await allowedOnSite(uow, {
            userId: author,
            permissionCode: EXPENSE_APPROVE_PERMISSION,
            siteId: expense.siteId,
            ownerUserId: expense.createdBy,
            at,
          });
    if (!allowed) {
      return rejected('FORBIDDEN_SCOPE', 'Seul l’auteur ou un approbateur annule cette dépense.');
    }
    // Coût déjà écrit (enregistrée sans validation, ou approuvée) : contrepassé à la date de la dépense,
    // sauf si le mois de frais généraux de l'espèce est déjà réparti (ADR-026).
    if (expense.status === 'RECORDED' || expense.status === 'APPROVED') {
      // Masse du mois de l'espèce verrouillée avant la garde (A7, ADR-038 rang N2b) : une répartition
      // concurrente se termine avant elle, ou attend la fin de cette annulation.
      if (expense.costObjectType === 'SITE' && expense.speciesGroup !== null) {
        await lockOverheadPool(uow, {
          siteId: expense.costObjectId!,
          speciesGroup: expense.speciesGroup,
          period: overheadPeriodOf(expense.occurredAt),
        });
      }
      if (
        expense.costObjectType === 'SITE' &&
        expense.speciesGroup !== null &&
        (await siteOverheadMonthAllocated(uow, {
          siteId: expense.costObjectId!,
          speciesGroup: expense.speciesGroup,
          at: expense.occurredAt,
        }))
      ) {
        return rejected(
          'OVERHEAD_ALREADY_ALLOCATED',
          'Le mois de frais généraux de cette espèce est déjà réparti entre les lots : la dépense ne peut plus être annulée (ADR-026).',
        );
      }
      await reverseExpenseCost(uow, deps, { expense, createdBy: author });
    }
    if (expense.approvalRequestId !== null) {
      await cancelApprovalRequest(uow, {
        requestId: expense.approvalRequestId,
        cancelledBy: author,
      });
    }
    await uow
      .updateTable('finance_expenses')
      .set({
        status: next,
        cancel_reason: envelope.payload.reason,
        cancelled_by: toBin(author),
        cancelled_at: at,
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(expense.id))
      .execute();
    await emitExpenseChange(uow, expense.id);
    return {
      status: 'APPLIED',
      serverRefs: { docNumber: expense.docNumber, status: next },
      audit: {
        before: { status: expense.status },
        after: { status: next, reason: envelope.payload.reason },
      },
    };
  }

  registry.register({
    commandType: 'finance.expense.record',
    version: 1,
    payloadSchema: expenseRecordPayloadSchema,
    permissionCode: EXPENSE_RECORD_PERMISSION,
    handler: record,
  });
  registry.register({
    commandType: 'finance.expense.pay',
    version: 1,
    payloadSchema: expensePayPayloadSchema,
    permissionCode: EXPENSE_PAY_PERMISSION,
    handler: pay,
  });
  registry.register({
    commandType: 'finance.expense.cancel',
    version: 1,
    payloadSchema: expenseCancelPayloadSchema,
    permissionCode: EXPENSE_RECORD_PERMISSION,
    handler: cancel,
  });
}
