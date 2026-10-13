/**
 * P8-07 : factures fournisseurs (ADR-061 ; SM-SUPPLIER-INVOICE ; WF-09 ; BR-FIN-030, BR-FIN-031 ;
 * AV-053, AV-358 à AV-360) — rapprochement sous le verrou du BC, quantités facturées écrites par
 * `procurement` à l'approbation, écart et décision `INVOICE_MISMATCH` (façade et demande), contestation,
 * avoir par annulation et facture rectificative de même référence, refus (doublon, hors ligne,
 * référence étrangère, facture payée).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerSupplierInvoiceCommands } from '../src/modules/finance/application/commands/supplier-invoice-commands.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestUser,
  insertTestZone,
  neutralizePolicy,
} from './helpers.js';
import {
  codeOf,
  eventsOf,
  newActor,
  newPosSite,
  tx,
  type Actor,
} from './cash-transfer-fixtures.js';
import { invoicedOf, newOrder, newReceiptLine, newSupplier } from './supplier-ledger-fixtures.js';

const DAY = '2026-10-09';
const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00.000Z`;
const NOW = at('23:00');

describe('P8-07 : factures fournisseurs', { timeout: 60_000 }, () => {
  let pipeline: CommandPipelineService;
  let root: Actor;
  let zoneId: string;
  let fin1: Actor;
  let fin2: Actor;
  let dir: Actor;
  let policyId: string;
  let deviceSeq = 0;

  const run = (
    actor: Actor,
    type: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: { readonly offline?: boolean } = {},
  ): Promise<CommandResult> =>
    pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: type,
        aggregate_type: type.startsWith('approvals.policy')
          ? 'CONTROL_POLICY'
          : type.startsWith('approvals.')
            ? 'APPROVAL_REQUEST'
            : 'SUPPLIER_INVOICE',
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: options.offline ?? false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: options.offline ? 'SYNC_PUSH' : 'ONLINE_API',
      },
    );

  const invoiceRow = (id: string) =>
    db
      .selectFrom('finance_supplier_invoices')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirst();
  const requestOf = async (id: string) =>
    db
      .selectFrom('approvals_approval_requests')
      .select(['id', 'status'])
      .where('subject_id', '=', toBin(id))
      .where('operation_type', '=', 'INVOICE_MISMATCH')
      .executeTakeFirst();

  /** Scénario WF-09 : BC de 100 sacs à 15 000, 95 acceptés. */
  async function wf09() {
    const siteId = await newPosSite(root.userId, zoneId);
    const supplierId = await newSupplier(root.userId, { paymentTermsDays: 30 });
    const order = await newOrder({
      createdBy: root.userId,
      siteId,
      supplierId,
      lines: [{ ordered: 100, priceXaf: 15_000, accepted: 95 }],
      occurredAt: at('08:00', '2026-10-01'),
    });
    return { siteId, supplierId, order, poLineId: order.lineIds[0]! };
  }
  const invoicePayload = (
    s: Awaited<ReturnType<typeof wf09>>,
    quantity: number,
    ref = `F-${freshUuid().slice(-8)}`,
  ) => ({
    supplierId: s.supplierId,
    supplierInvoiceRef: ref,
    invoiceDate: '2026-10-08',
    purchaseOrderId: s.order.orderId,
    printedTotalXaf: quantity * 15_000,
    lines: [
      {
        poLineId: s.poLineId,
        description: 'Aliment démarrage, sac de 50 kg',
        quantity,
        unitPriceXaf: 15_000,
        lineTotalXaf: quantity * 15_000,
      },
    ],
  });
  const recordInvoice = async (actor: Actor, payload: unknown, occurredAt = at('10:00')) => {
    const id = freshUuid();
    const result = await run(actor, 'finance.supplier_invoice.record', id, occurredAt, payload);
    return { id, result };
  };

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    const idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
    registerSupplierInvoiceCommands(
      registry,
      decisions,
      idGenerator,
      new DocumentSequenceService(),
    );
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    root = await tx(async (trx) => {
      const userId = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
      const role = await insertTestRole(trx, userId);
      await grantTestPermission(trx, role, 'approvals.policy.manage', userId);
      await assignTestRole(trx, userId, role, userId);
      zoneId = await insertTestZone(trx, userId);
      return { userId, deviceId };
    });
    fin1 = await newActor('FINANCE', root.userId);
    fin2 = await newActor('FINANCE', root.userId);
    dir = await newActor('DIRECTION', root.userId);
    policyId = freshUuid();
    const policy = await run(root, 'approvals.policy.set', policyId, at('00:00'), {
      code: `INV-TEST-${policyId.slice(-12)}`,
      operationType: 'INVOICE_MISMATCH',
      requiresApproval: true,
      approverPermission: 'finance.supplier_invoice.approve',
      approverScope: 'ALL',
      validFrom: at('00:00'),
      validTo: at('00:00', '2026-10-10'),
    });
    expect(policy.status, JSON.stringify(policy)).toBe('APPLIED');
  });

  afterAll(async () => {
    await neutralizePolicy(policyId);
    await closeTestDb();
  });

  it('conforme (95 pour 95 acceptés) : APPROVED, facturé écrit sur le BC, numéro FF, échéance au délai du fournisseur', async () => {
    const s = await wf09();
    const { id, result } = await recordInvoice(fin1, invoicePayload(s, 95));
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const row = await invoiceRow(id);
    expect(row).toMatchObject({
      status: 'APPROVED',
      total_xaf: 1_425_000,
      paid_xaf: 0,
      mismatch_details: null,
    });
    expect(row!.doc_number).toMatch(/^FF-[A-Z0-9]{1,10}-2026-\d{6}$/);
    expect(row!.due_date.toISOString().slice(0, 10)).toBe('2026-11-07');
    expect(fromBin(row!.approved_by!)).toBe(fin1.userId);
    expect(await invoicedOf(s.poLineId)).toBe(95);
    expect(await requestOf(id)).toBeUndefined();
    expect(
      (await eventsOf(id))
        .map((event) => event.eventType)
        .filter((type) => type.startsWith('Supplier')),
    ).toEqual(['SupplierInvoiceRecorded', 'SupplierInvoiceApproved']);
    // Le facturé cumulé compte : une seconde facture d'un sac dépasse l'accepté.
    const second = await recordInvoice(fin1, invoicePayload(s, 1));
    expect((await invoiceRow(second.id))?.status).toBe('MISMATCH');
  });

  it('WF-09 : 98 facturés pour 95 acceptés → MISMATCH, contestation, avoir par annulation, rectificative de même référence → APPROVED', async () => {
    const s = await wf09();
    const ref = `F-${freshUuid().slice(-8)}`;
    const first = await recordInvoice(fin1, invoicePayload(s, 98, ref));
    const row = await invoiceRow(first.id);
    expect(row).toMatchObject({ status: 'MISMATCH', total_xaf: 1_470_000 });
    expect(row!.mismatch_details).toEqual([
      {
        reason: 'QUANTITY_ABOVE_ACCEPTED',
        lineIndex: null,
        poLineId: s.poLineId,
        expected: 95,
        actual: 98,
      },
    ]);
    expect(await invoicedOf(s.poLineId)).toBe(0);
    const request = await requestOf(first.id);
    expect(request?.status).toBe('PENDING');
    expect((await eventsOf(first.id, 'SupplierInvoiceMismatchDetected')).length).toBe(1);

    expect(
      codeOf(
        await run(fin2, 'finance.supplier_invoice.dispute', first.id, at('11:00'), {
          reason: '3 sacs rejetés',
        }),
      ),
    ).toBe('APPLIED');
    expect((await invoiceRow(first.id))?.status).toBe('DISPUTED');
    expect((await requestOf(first.id))?.status).toBe('CANCELLED');
    // Même référence tant que la facture contestée vit : doublon.
    expect(codeOf((await recordInvoice(fin1, invoicePayload(s, 95, ref))).result)).toBe(
      'INVOICE_DUPLICATE',
    );
    expect(
      codeOf(
        await run(fin2, 'finance.supplier_invoice.cancel', first.id, at('12:00'), {
          reason: 'Avoir de 3 sacs',
        }),
      ),
    ).toBe('APPLIED');
    expect(await invoiceRow(first.id)).toMatchObject({
      status: 'CANCELLED',
      cancel_reason: 'Avoir de 3 sacs',
    });
    const corrected = await recordInvoice(fin1, invoicePayload(s, 95, ref), at('13:00'));
    expect((await invoiceRow(corrected.id))?.status).toBe('APPROVED');
    expect(await invoicedOf(s.poLineId)).toBe(95);
  });

  it('écart accepté par la Direction (demande) puis annulation de la facture approuvée : facturé ajouté puis retiré', async () => {
    const s = await wf09();
    const { id } = await recordInvoice(fin1, invoicePayload(s, 98));
    const request = await requestOf(id);
    const approve = (actor: Actor) =>
      run(actor, 'approvals.request.approve', fromBin(request!.id), at('14:00'), {
        requestId: fromBin(request!.id),
        comment: 'Trois sacs livrés hors bon',
      });
    expect(codeOf(await approve(fin1))).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(codeOf(await approve(dir))).toBe('APPLIED');
    expect((await invoiceRow(id))?.status).toBe('APPROVED');
    expect(await invoicedOf(s.poLineId)).toBe(98);
    expect(
      codeOf(
        await run(fin2, 'finance.supplier_invoice.cancel', id, at('15:00'), {
          reason: 'Avoir total',
        }),
      ),
    ).toBe('APPLIED');
    expect(await invoicedOf(s.poLineId)).toBe(0);
  });

  it('façade finance.supplier_invoice.approve : décide la demande ; contestée : approbation directe, jamais par son auteur', async () => {
    const s = await wf09();
    const viaRequest = await recordInvoice(fin1, invoicePayload(s, 96));
    expect(
      codeOf(
        await run(fin2, 'finance.supplier_invoice.approve', viaRequest.id, at('14:00'), {
          reason: 'Accord fournisseur',
        }),
      ),
    ).toBe('APPLIED');
    expect((await requestOf(viaRequest.id))?.status).toBe('APPROVED');
    expect((await invoiceRow(viaRequest.id))?.status).toBe('APPROVED');
    expect(await invoicedOf(s.poLineId)).toBe(96);

    const s2 = await wf09();
    const disputed = await recordInvoice(fin1, invoicePayload(s2, 97));
    await run(fin2, 'finance.supplier_invoice.dispute', disputed.id, at('11:00'), {
      reason: 'À vérifier',
    });
    expect(
      codeOf(
        await run(fin1, 'finance.supplier_invoice.approve', disputed.id, at('12:00'), {
          reason: 'Vérifié',
        }),
      ),
    ).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(
      codeOf(
        await run(dir, 'finance.supplier_invoice.approve', disputed.id, at('12:00'), {
          reason: 'Vérifié',
        }),
      ),
    ).toBe('APPLIED');
    expect(await invoiceRow(disputed.id)).toMatchObject({
      status: 'APPROVED',
      approval_reason: 'Vérifié',
    });
    expect(await invoicedOf(s2.poLineId)).toBe(97);
  });

  it('demande rejetée → DISPUTED ; retrait refusé ; facture payée : annulation refusée', async () => {
    const s = await wf09();
    const { id } = await recordInvoice(fin1, invoicePayload(s, 99));
    const request = await requestOf(id);
    const requestId = fromBin(request!.id);
    expect(
      codeOf(await run(fin1, 'approvals.request.withdraw', requestId, at('11:00'), { requestId })),
    ).toBe('INVOICE_NOT_WITHDRAWABLE');
    expect(
      codeOf(
        await run(dir, 'approvals.request.reject', requestId, at('11:00'), {
          requestId,
          comment: 'Prix non conforme',
        }),
      ),
    ).toBe('APPLIED');
    expect((await invoiceRow(id))?.status).toBe('DISPUTED');

    const s2 = await wf09();
    const paid = await recordInvoice(fin1, invoicePayload(s2, 10));
    await db
      .updateTable('finance_supplier_invoices')
      .set({ status: 'PARTIALLY_PAID', paid_xaf: 1_000 })
      .where('id', '=', toBin(paid.id))
      .execute();
    expect(
      codeOf(
        await run(fin2, 'finance.supplier_invoice.cancel', paid.id, at('12:00'), { reason: 'x' }),
      ),
    ).toBe('INVOICE_HAS_PAYMENTS');
  });

  it('refus : hors ligne, fournisseur inconnu, ligne de réception étrangère ; facture sans BC mise en revue (AV-358)', async () => {
    const s = await wf09();
    expect(
      codeOf(
        await run(
          fin1,
          'finance.supplier_invoice.record',
          freshUuid(),
          at('10:00'),
          invoicePayload(s, 95),
          { offline: true },
        ),
      ),
    ).toBe('ONLINE_REQUIRED');
    expect(
      codeOf(
        (await recordInvoice(fin1, { ...invoicePayload(s, 95), supplierId: freshUuid() })).result,
      ),
    ).toBe('NOT_FOUND');
    const other = await wf09();
    const foreignReceiptLine = await newReceiptLine({
      createdBy: root.userId,
      siteId: other.siteId,
      supplierId: other.supplierId,
      order: other.order,
      poLineId: other.poLineId,
      delivered: 95,
      rejected: 0,
      unitCostXaf: 15_000,
      occurredAt: at('08:00', '2026-10-05'),
    });
    const payload = invoicePayload(s, 95);
    expect(
      codeOf(
        (
          await recordInvoice(fin1, {
            ...payload,
            lines: [{ ...payload.lines[0], receiptLineId: foreignReceiptLine }],
          })
        ).result,
      ),
    ).toBe('PO_LINE_MISMATCH');
    // Ligne de réception d'un autre fournisseur, citée sans ligne de BC : refus par le fournisseur.
    expect(
      codeOf(
        (
          await recordInvoice(fin1, {
            supplierId: s.supplierId,
            supplierInvoiceRef: `R-${freshUuid().slice(-8)}`,
            invoiceDate: '2026-10-08',
            lines: [
              { description: 'Sacs', receiptLineId: foreignReceiptLine, lineTotalXaf: 15_000 },
            ],
          })
        ).result,
      ),
    ).toBe('PO_LINE_MISMATCH');
    const service = await recordInvoice(fin1, {
      supplierId: s.supplierId,
      supplierInvoiceRef: `T-${freshUuid().slice(-8)}`,
      invoiceDate: '2026-10-08',
      dueDate: '2026-10-20',
      lines: [{ description: 'Transport des sacs', lineTotalXaf: 25_000 }],
    });
    expect(await invoiceRow(service.id)).toMatchObject({
      status: 'MISMATCH',
      mismatch_details: [
        {
          reason: 'NO_PURCHASE_ORDER',
          lineIndex: null,
          poLineId: null,
          expected: null,
          actual: null,
        },
      ],
    });
    expect((await invoiceRow(service.id))!.due_date.toISOString().slice(0, 10)).toBe('2026-10-20');
  });
});
