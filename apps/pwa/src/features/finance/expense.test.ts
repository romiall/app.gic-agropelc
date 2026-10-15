import { describe, expect, it } from 'vitest';
import { expenseRecordPayloadSchema } from '@gic/contracts';
import type { OutboxCommand } from '../../storage/db.js';
import type {
  ApprovalRequestData,
  CashAccountData,
  ControlPolicyData,
  ExpenseCategoryData,
  ExpenseData,
  RoleAssignmentData,
  SettingData,
  SiteData,
  ZoneData,
} from '../sales/types.js';
import {
  awaitsReceiptPhoto,
  canCancelOwnExpense,
  defaultExpenseSite,
  expensePaymentState,
  receiptToAttach,
  reviewStillPending,
  DEFAULT_EXPENSE_THRESHOLDS,
  expenseAccounts,
  expenseCategoryChoices,
  expenseImputations,
  expenseIssues,
  expensePayload,
  expensePolicyAvailable,
  expensePreview,
  expenseSites,
  expenseThresholds,
  imputationCostObject,
  myExpenses,
  type ExpenseImputation,
} from './expense.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const USER = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';
const ZONE = '01900000-0000-7000-8000-000000000010';
const SUB_ZONE = '01900000-0000-7000-8000-000000000011';
const OTHER_ZONE = '01900000-0000-7000-8000-000000000012';
const PDV = '01900000-0000-7000-8000-000000000020';
const FARM = '01900000-0000-7000-8000-000000000021';
const FAR = '01900000-0000-7000-8000-000000000022';
const CLOSED_SITE = '01900000-0000-7000-8000-000000000023';
const CATEGORY = '01900000-0000-7000-8000-0000000000c1';
const ACCOUNT = '01900000-0000-7000-8000-0000000000b0';

const setting = (key: string, value: unknown, validFrom = '2026-01-01T00:00:00.000Z') =>
  ({
    id: `${key}-${validFrom}`,
    key,
    value,
    scope_type: 'GLOBAL',
    scope_id: null,
    valid_from: validFrom,
  }) satisfies SettingData;

const policy = (overrides: Partial<ControlPolicyData> = {}): ControlPolicyData => ({
  id: 'p1',
  code: 'EXPENSE_DEFAULT',
  version: 1,
  operation_type: 'EXPENSE',
  requires_approval: true,
  approver_permission: 'finance.expense.approve',
  valid_from: '2026-01-01T00:00:00.000Z',
  valid_to: null,
  ...overrides,
});

const category = (overrides: Partial<ExpenseCategoryData> = {}): ExpenseCategoryData => ({
  id: CATEGORY,
  code: 'TRANSPORT',
  label: 'Transport',
  default_cost_type: null,
  allowed_on_pos: true,
  is_system: false,
  is_active: true,
  version: 1,
  ...overrides,
});

const site = (id: string, name: string, overrides: Partial<SiteData> = {}): SiteData => ({
  id,
  code: name.toUpperCase(),
  name,
  site_type: 'POINT_DE_VENTE',
  zone_id: ZONE,
  status: 'ACTIVE',
  ...overrides,
});

const zones = new Map<string, Pick<ZoneData, 'parent_id'>>([
  [ZONE, { parent_id: null }],
  [SUB_ZONE, { parent_id: ZONE }],
  [OTHER_ZONE, { parent_id: null }],
]);

const sites = new Map<string, SiteData>([
  [PDV, site(PDV, 'Yaoundé')],
  [FARM, site(FARM, 'Obala', { site_type: 'FERME', zone_id: SUB_ZONE })],
  [FAR, site(FAR, 'Douala', { zone_id: OTHER_ZONE })],
  [CLOSED_SITE, site(CLOSED_SITE, 'Ancien', { status: 'INACTIVE' })],
]);

const assignment = (overrides: Partial<RoleAssignmentData> = {}): RoleAssignmentData => ({
  id: 'a1',
  user_id: USER,
  scope_type: 'SITE',
  scope_site_id: PDV,
  scope_zone_id: null,
  valid_from: '2026-01-01T00:00:00.000Z',
  valid_to: null,
  revoked_at: null,
  ...overrides,
});

const account = (overrides: Partial<CashAccountData> = {}): CashAccountData => ({
  id: ACCOUNT,
  code: 'CAISSE-PDV-YDE',
  name: 'Caisse du PDV',
  account_type: 'CAISSE_PDV',
  site_id: PDV,
  holder_user_id: null,
  responsible_user_id: OTHER,
  balance_xaf: 20_000,
  status: 'ACTIVE',
  ...overrides,
});

const names = (list: readonly SiteData[]) => list.map((entry) => entry.name);

describe('dépenses sur l’appareil (ECR-FIN-02, P8E-03)', () => {
  it('seuils : paramètres globaux visibles, sinon les défauts du registre (AV-058)', () => {
    expect(expenseThresholds([], NOW)).toEqual(DEFAULT_EXPENSE_THRESHOLDS);
    expect(
      expenseThresholds(
        [
          setting('finance.expense_approval_threshold_xaf', 80_000),
          setting('finance.expense_photo_threshold_xaf', 5_000),
          setting('finance.pos_expense_max_xaf', 30_000),
          // Version future : pas encore en vigueur.
          setting('finance.expense_photo_threshold_xaf', 1, '2026-12-01T00:00:00.000Z'),
        ],
        NOW,
      ),
    ).toEqual({ approvalXaf: 80_000, photoXaf: 5_000, posCapXaf: 30_000 });
    // Valeur illisible ou négative : le défaut, comme le serveur.
    expect(
      expenseThresholds(
        [
          setting('finance.expense_approval_threshold_xaf', '80000'),
          setting('finance.expense_photo_threshold_xaf', -1),
        ],
        NOW,
      ),
    ).toEqual(DEFAULT_EXPENSE_THRESHOLDS);
  });

  it('politique : en vigueur, demande une validation et nomme un approbateur (AV-264) ; aucune servie : supposée', () => {
    expect(expensePolicyAvailable([], NOW)).toBe(true);
    expect(expensePolicyAvailable([policy()], NOW)).toBe(true);
    expect(expensePolicyAvailable([policy({ requires_approval: false })], NOW)).toBe(false);
    expect(expensePolicyAvailable([policy({ approver_permission: null })], NOW)).toBe(false);
    expect(expensePolicyAvailable([policy({ valid_to: '2026-10-10T12:00:00.000Z' })], NOW)).toBe(
      false,
    );
    expect(expensePolicyAvailable([policy({ valid_from: '2026-10-11T00:00:00.000Z' })], NOW)).toBe(
      false,
    );
    expect(expensePolicyAvailable([policy({ operation_type: 'LOSS_DECLARATION' })], NOW)).toBe(
      false,
    );
  });

  it('catégories : actives, hors catégorie système ; à la caisse du PDV, permises au PDV', () => {
    const list = [
      category(),
      category({ id: 'vet', label: 'Vétérinaire', allowed_on_pos: false }),
      category({ id: 'sys', label: 'Non justifiée', is_system: true }),
      category({ id: 'off', label: 'Ancienne', is_active: false }),
    ];
    expect(expenseCategoryChoices(list, false).map((entry) => entry.id)).toEqual([CATEGORY, 'vet']);
    expect(expenseCategoryChoices(list, true).map((entry) => entry.id)).toEqual([CATEGORY]);
  });

  it('sites : ceux des affectations en vigueur ; tous sans affectation connue, ou pour une affectation globale (AV-301)', () => {
    const input = { userId: USER, sites, zones, now: NOW };
    // Aucune affectation servie : tous les sites actifs.
    expect(names(expenseSites({ ...input, assignments: [] }))).toEqual([
      'Douala',
      'Obala',
      'Yaoundé',
    ]);
    expect(names(expenseSites({ ...input, assignments: [assignment()] }))).toEqual(['Yaoundé']);
    // Zone : ses sites et ceux de ses sous-zones.
    expect(
      names(
        expenseSites({
          ...input,
          assignments: [
            assignment({ scope_type: 'ZONE', scope_site_id: null, scope_zone_id: ZONE }),
          ],
        }),
      ),
    ).toEqual(['Obala', 'Yaoundé']);
    expect(
      names(
        expenseSites({
          ...input,
          assignments: [assignment(), assignment({ id: 'a2', scope_type: 'GLOBAL' })],
        }),
      ),
    ).toEqual(['Douala', 'Obala', 'Yaoundé']);
    expect(
      names(expenseSites({ ...input, assignments: [assignment({ scope_type: 'TEAM' })] })),
    ).toHaveLength(3);
    // Affectation d'un autre, retirée, échue ou future : ignorée.
    expect(
      names(
        expenseSites({
          ...input,
          assignments: [
            assignment(),
            assignment({ id: 'x', user_id: OTHER, scope_site_id: FAR }),
            assignment({ id: 'r', scope_site_id: FARM, revoked_at: '2026-10-01T00:00:00.000Z' }),
            assignment({ id: 'e', scope_site_id: FARM, valid_to: '2026-10-10T12:00:00.000Z' }),
            assignment({ id: 'f', scope_site_id: FARM, valid_from: '2026-10-11T00:00:00.000Z' }),
          ],
        }),
      ),
    ).toEqual(['Yaoundé']);
  });

  it('site proposé : celui de la caisse s’il est permis, sinon le seul site, sinon un choix', () => {
    const two = [site(PDV, 'Yaoundé'), site(FARM, 'Obala')];
    expect(defaultExpenseSite(two, account())).toBe(PDV);
    expect(defaultExpenseSite(two, account({ site_id: FAR }))).toBe('');
    expect(defaultExpenseSite(two, account({ site_id: null }))).toBe('');
    expect(defaultExpenseSite([site(FARM, 'Obala')], undefined)).toBe(FARM);
    expect(defaultExpenseSite(two, undefined)).toBe('');
  });

  it('caisses : actives, sans détenteur ou à l’utilisateur', () => {
    const list = [
      account(),
      account({ id: 'mine', name: 'Ma caisse', holder_user_id: USER }),
      account({ id: 'theirs', name: 'Sa caisse', holder_user_id: OTHER }),
      account({ id: 'off', name: 'Fermée', status: 'INACTIVE' }),
    ];
    expect(expenseAccounts(list, USER).map((entry) => entry.id)).toEqual([ACCOUNT, 'mine']);
  });

  it('imputations : directe du site d’abord ; ferme : frais généraux et lots ouverts du site', () => {
    expect(expenseImputations({ site: undefined, lots: [], batches: [] })).toEqual([]);
    expect(
      expenseImputations({ site: sites.get(PDV), lots: [], batches: [] }).map((entry) => entry.key),
    ).toEqual(['SITE', 'NONE']);
    const options = expenseImputations({
      site: sites.get(FARM),
      lots: [
        { id: 'l2', lot_code: 'LOT-B', site_id: FARM, status: 'ACTIVE' },
        { id: 'l1', lot_code: 'LOT-A', site_id: FARM, status: 'PLANNED' },
        { id: 'l3', lot_code: 'LOT-C', site_id: FARM, status: 'CLOSED' },
        { id: 'l4', lot_code: 'LOT-D', site_id: PDV, status: 'ACTIVE' },
      ],
      batches: [
        { id: 'b1', batch_code: 'INC-1', site_id: FARM, status: 'INCUBATING' },
        { id: 'b2', batch_code: 'INC-2', site_id: FARM, status: 'CANCELLED' },
      ],
    });
    expect(options.map((entry) => entry.key)).toEqual([
      'SITE',
      'NONE',
      'OVERHEAD:VOLAILLE',
      'OVERHEAD:PORC',
      'PRODUCTION_LOT:l1',
      'PRODUCTION_LOT:l2',
      'INCUBATION_BATCH:b1',
    ]);
  });

  it('objet de coût : site, frais généraux d’une espèce, lot, lot d’incubation, ou aucun', () => {
    const of = (imputation: ExpenseImputation) => imputationCostObject(imputation, FARM);
    expect(of({ key: 'SITE', kind: 'SITE' })).toEqual({ type: 'SITE', id: FARM });
    expect(of({ key: 'NONE', kind: 'NONE' })).toBeUndefined();
    expect(of({ key: 'OVERHEAD:PORC', kind: 'OVERHEAD', speciesGroup: 'PORC' })).toEqual({
      type: 'SITE',
      id: FARM,
      speciesGroup: 'PORC',
    });
    expect(
      of({ key: 'PRODUCTION_LOT:l1', kind: 'PRODUCTION_LOT', id: 'l1', code: 'LOT-A' }),
    ).toEqual({ type: 'PRODUCTION_LOT', id: 'l1' });
    expect(
      of({ key: 'INCUBATION_BATCH:b1', kind: 'INCUBATION_BATCH', id: 'b1', code: 'INC-1' }),
    ).toEqual({ type: 'INCUBATION_BATCH', id: 'b1' });
  });

  it('champs à compléter : catégorie, montant entier positif, objet, site, caisse si payée', () => {
    const complete = {
      category: category(),
      amountXaf: 2_000,
      description: 'Moto-taxi',
      siteId: PDV,
      paidNow: true,
      account: account(),
    };
    expect(expenseIssues(complete)).toEqual([]);
    expect(
      expenseIssues({
        category: undefined,
        amountXaf: null,
        description: '  ',
        siteId: '',
        paidNow: true,
        account: undefined,
      }),
    ).toEqual(['CATEGORY', 'AMOUNT', 'DESCRIPTION', 'SITE', 'ACCOUNT']);
    expect(expenseIssues({ ...complete, amountXaf: 0 })).toEqual(['AMOUNT']);
    expect(expenseIssues({ ...complete, paidNow: false, account: undefined })).toEqual([]);
  });

  it('aperçu : motifs de revue et statut par les règles partagées (ADR-042 §6, comparaisons strictes)', () => {
    const base = {
      category: category(),
      amountXaf: 10_000,
      paidNow: true,
      paidFromPos: true,
      thresholds: DEFAULT_EXPENSE_THRESHOLDS,
      hasPhoto: false,
      costObject: 'OPEN' as const,
      policyAvailable: true,
    };
    // Au seuil : ni justificatif ni validation.
    expect(expensePreview(base)).toEqual({ reasons: [], status: 'PAID', photoRequired: false });
    // Au-delà du seuil du justificatif, sans photo : validation a posteriori.
    expect(expensePreview({ ...base, amountXaf: 10_001 })).toEqual({
      reasons: ['ATTACHMENT_MISSING'],
      status: 'PAID_PENDING_APPROVAL',
      photoRequired: true,
    });
    expect(expensePreview({ ...base, amountXaf: 10_001, hasPhoto: true }).status).toBe('PAID');
    // Plafond du PDV et validation au-delà de 50 000.
    expect(
      expensePreview({ ...base, amountXaf: 50_001, hasPhoto: true, paidFromPos: true }).reasons,
    ).toEqual(['POS_CAP_EXCEEDED']);
    expect(
      expensePreview({ ...base, amountXaf: 50_001, hasPhoto: true, paidFromPos: false }),
    ).toMatchObject({ reasons: [], status: 'PAID_PENDING_APPROVAL' });
    expect(
      expensePreview({
        ...base,
        amountXaf: 50_001,
        hasPhoto: true,
        paidNow: false,
        paidFromPos: false,
      }).status,
    ).toBe('PENDING_APPROVAL');
    // Sans politique : aucune validation, même au-delà du seuil (AV-264).
    expect(
      expensePreview({
        ...base,
        amountXaf: 60_000,
        hasPhoto: true,
        paidFromPos: false,
        policyAvailable: false,
      }).status,
    ).toBe('PAID');
    // Catégorie non permise au PDV.
    expect(
      expensePreview({ ...base, category: category({ allowed_on_pos: false }) }).reasons,
    ).toEqual(['CATEGORY_NOT_ALLOWED_ON_POS']);
  });

  it('charge utile conforme au contrat : payée, à payer, imputée, champs nettoyés', () => {
    const paid = expensePayload({
      categoryId: CATEGORY,
      amountXaf: 2_000,
      description: '  Moto-taxi  ',
      payeeName: ' Jean ',
      supplierId: '',
      siteId: PDV,
      imputation: { key: 'SITE', kind: 'SITE' },
      paidNow: true,
      accountId: ACCOUNT,
    });
    expect(paid).toEqual({
      categoryId: CATEGORY,
      amountXaf: 2_000,
      description: 'Moto-taxi',
      payeeName: 'Jean',
      siteId: PDV,
      costObject: { type: 'SITE', id: PDV },
      paidNow: true,
      paidFromAccountId: ACCOUNT,
    });
    expect(expenseRecordPayloadSchema.safeParse(paid).success).toBe(true);
    const toPay = expensePayload({
      categoryId: CATEGORY,
      amountXaf: 9_000,
      description: 'Aliment',
      payeeName: '',
      supplierId: '01900000-0000-7000-8000-0000000000aa',
      siteId: FARM,
      imputation: { key: 'OVERHEAD:VOLAILLE', kind: 'OVERHEAD', speciesGroup: 'VOLAILLE' },
      paidNow: false,
      accountId: ACCOUNT,
    });
    expect(toPay).toEqual({
      categoryId: CATEGORY,
      amountXaf: 9_000,
      description: 'Aliment',
      supplierId: '01900000-0000-7000-8000-0000000000aa',
      siteId: FARM,
      costObject: { type: 'SITE', id: FARM, speciesGroup: 'VOLAILLE' },
      paidNow: false,
    });
    expect(expenseRecordPayloadSchema.safeParse(toPay).success).toBe(true);
    expect(
      expensePayload({
        categoryId: CATEGORY,
        amountXaf: 500,
        description: 'Divers',
        payeeName: '',
        supplierId: '',
        siteId: PDV,
        imputation: { key: 'NONE', kind: 'NONE' },
        paidNow: false,
        accountId: '',
      }),
    ).not.toHaveProperty('costObject');
  });
});

describe('mes dépenses (jeu `cash` et saisies de l’appareil)', () => {
  const served = (overrides: Partial<ExpenseData> = {}): ExpenseData => ({
    id: 'e-served',
    doc_number: 'DEP-PDV-YDE-2026-000001',
    local_ref: null,
    site_id: PDV,
    category_id: CATEGORY,
    amount_xaf: 2_000,
    payee_name: null,
    description: 'Moto-taxi',
    cost_object_type: 'SITE',
    cost_object_id: PDV,
    species_group: null,
    paid_now: true,
    paid_from_account_id: ACCOUNT,
    status: 'PAID',
    review_reasons: [],
    occurred_at: '2026-10-10T09:00:00.000Z',
    version: 1,
    ...overrides,
  });
  const command = (overrides: Partial<OutboxCommand>): OutboxCommand => ({
    command_id: 'c1',
    device_seq: 1,
    command_type: 'finance.expense.record',
    command_version: 1,
    author_user_id: USER,
    aggregate_type: 'EXPENSE',
    aggregate_id: 'e-local',
    base_version: null,
    depends_on: [],
    occurred_at: '2026-10-10T11:00:00.000Z',
    client_created_at: '2026-10-10T11:00:00.000Z',
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload: {
      categoryId: CATEGORY,
      amountXaf: 3_500,
      description: 'Carburant',
      siteId: PDV,
      paidNow: false,
    },
    status: 'LOCAL_ONLY',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
    ...overrides,
  });
  const request = (overrides: Partial<ApprovalRequestData> = {}): ApprovalRequestData => ({
    id: 'r1',
    operation_type: 'EXPENSE',
    subject_type: 'EXPENSE',
    subject_id: 'e-rejected',
    status: 'REJECTED',
    decided_at: '2026-10-10T10:00:00.000Z',
    decision_comment: 'Reçu illisible',
    ...overrides,
  });

  it('servies et saisies en vol, de la plus récente à la plus ancienne ; refusées et autres auteurs exclus', () => {
    const views = myExpenses({
      expenses: [
        served(),
        served({
          id: 'e-rejected',
          doc_number: 'DEP-PDV-YDE-2026-000002',
          status: 'REJECTED',
          occurred_at: '2026-10-10T08:00:00.000Z',
        }),
      ],
      outbox: [
        command({}),
        // Acceptée, pas encore relue : numéro et statut renvoyés par le serveur.
        command({
          command_id: 'c2',
          aggregate_id: 'e-accepted',
          occurred_at: '2026-10-10T10:30:00.000Z',
          status: 'SYNCED',
          synced_at: '2026-10-10T10:31:00.000Z',
          server_refs: { docNumber: 'DEP-PDV-YDE-2026-000003', status: 'PENDING_APPROVAL' },
        }),
        command({ command_id: 'c3', aggregate_id: 'e-refused', status: 'REJECTED' }),
        command({ command_id: 'c4', aggregate_id: 'e-other', author_user_id: OTHER }),
        // Déjà servie : la fiche du jeu `cash` l'emporte.
        command({ command_id: 'c5', aggregate_id: 'e-served' }),
        command({
          command_id: 'c6',
          command_type: 'finance.expense.cancel',
          aggregate_id: 'e-served',
          payload: { reason: 'Erreur' },
        }),
      ],
      cashPulledAt: '2026-10-10T10:00:00.000Z',
      approvalRequests: [
        request(),
        request({ id: 'r2', subject_id: 'e-served', status: 'PENDING' }),
      ],
      userId: USER,
    });
    expect(views.map((view) => view.id)).toEqual([
      'e-local',
      'e-accepted',
      'e-served',
      'e-rejected',
    ]);
    expect(views[0]).toMatchObject({
      docNumber: null,
      status: null,
      servedStatus: null,
      recordWaiting: true,
      paidNow: false,
      amountXaf: 3_500,
    });
    expect(views[1]).toMatchObject({
      docNumber: 'DEP-PDV-YDE-2026-000003',
      status: 'PENDING_APPROVAL',
      servedStatus: null,
      recordWaiting: false,
    });
    expect(views[2]).toMatchObject({
      status: 'PAID',
      cancelling: 'WAITING',
      rejectionComment: null,
    });
    expect(views[3]).toMatchObject({ status: 'REJECTED', rejectionComment: 'Reçu illisible' });
  });

  it('tablette partagée : les fiches servies d’un autre détenteur ne sont pas montrées (ADR-037 §5)', () => {
    const input = {
      expenses: [served()],
      outbox: [command({ author_user_id: USER })],
      cashPulledAt: undefined,
      approvalRequests: [request({ subject_id: 'e-served' })],
      userId: USER,
    };
    expect(myExpenses({ ...input, servedOwner: USER }).map((view) => view.id)).toEqual([
      'e-local',
      'e-served',
    ]);
    // Données tirées par un autre utilisateur : seules ses propres saisies.
    expect(myExpenses({ ...input, servedOwner: OTHER }).map((view) => view.id)).toEqual([
      'e-local',
    ]);
    // Détenteur inconnu (jamais tiré) : rien à cacher.
    expect(myExpenses(input).map((view) => view.id)).toEqual(['e-local', 'e-served']);
  });

  it('ligne de paiement, motifs encore à revoir, justificatif à joindre ou à remplacer', () => {
    expect(expensePaymentState({ status: 'PAID', paidFromAccountId: ACCOUNT })).toBe('PAID_FROM');
    // Payée après coup par la Finance : `paid_now` reste faux, le compte fait foi.
    expect(
      expensePaymentState({ status: 'PAID_PENDING_APPROVAL', paidFromAccountId: ACCOUNT }),
    ).toBe('PAID_FROM');
    expect(expensePaymentState({ status: null, paidFromAccountId: null })).toBe('TO_PAY');
    expect(expensePaymentState({ status: 'RECORDED', paidFromAccountId: null })).toBe('TO_PAY');
    expect(expensePaymentState({ status: 'APPROVED', paidFromAccountId: null })).toBe('TO_PAY');
    expect(expensePaymentState({ status: 'PENDING_APPROVAL', paidFromAccountId: null })).toBe(
      'TO_PAY_AFTER_APPROVAL',
    );
    expect(expensePaymentState({ status: 'REJECTED', paidFromAccountId: null })).toBeNull();
    expect(expensePaymentState({ status: 'CANCELLED', paidFromAccountId: null })).toBeNull();
    expect(reviewStillPending('PENDING_APPROVAL')).toBe(true);
    expect(reviewStillPending('PAID_PENDING_APPROVAL')).toBe(true);
    expect(reviewStillPending('PAID')).toBe(false);
    expect(reviewStillPending(null)).toBe(false);
    const [view] = myExpenses({
      expenses: [served({ status: 'PAID' })],
      outbox: [],
      cashPulledAt: undefined,
      approvalRequests: [],
      userId: USER,
    });
    expect(receiptToAttach(view!, false)).toBe(false);
    expect(receiptToAttach(view!, true)).toBe(true);
    expect(
      receiptToAttach(
        { ...view!, servedStatus: 'PENDING_APPROVAL', reviewReasons: ['ATTACHMENT_MISSING'] },
        false,
      ),
    ).toBe(true);
    for (const status of ['CANCELLED', 'REJECTED', 'PAID_REJECTED']) {
      expect(receiptToAttach({ ...view!, servedStatus: status }, true)).toBe(false);
    }
    // Saisie pas encore relue : sa photo part avec elle.
    expect(receiptToAttach({ ...view!, servedStatus: null }, true)).toBe(false);
  });

  it('annulation par l’auteur : dépense servie non payée, sans annulation en cours ; justificatif attendu', () => {
    const [view] = myExpenses({
      expenses: [served({ status: 'PENDING_APPROVAL', review_reasons: ['ATTACHMENT_MISSING'] })],
      outbox: [],
      cashPulledAt: undefined,
      approvalRequests: [],
      userId: USER,
    });
    expect(canCancelOwnExpense(view!)).toBe(true);
    expect(awaitsReceiptPhoto(view!)).toBe(true);
    expect(canCancelOwnExpense({ ...view!, servedStatus: 'PAID' })).toBe(false);
    // SM-EXPENSE : enregistrée, en attente ou approuvée, toujours non payée.
    for (const status of ['RECORDED', 'PENDING_APPROVAL', 'APPROVED']) {
      expect(canCancelOwnExpense({ ...view!, servedStatus: status }), status).toBe(true);
    }
    for (const status of ['PAID_PENDING_APPROVAL', 'REJECTED', 'PAID_REJECTED', 'CANCELLED']) {
      expect(canCancelOwnExpense({ ...view!, servedStatus: status }), status).toBe(false);
    }
    expect(canCancelOwnExpense({ ...view!, cancelling: 'SENT' })).toBe(false);
    expect(canCancelOwnExpense({ ...view!, servedStatus: null, status: 'RECORDED' })).toBe(false);
    expect(awaitsReceiptPhoto({ ...view!, reviewReasons: ['POS_CAP_EXCEEDED'] })).toBe(false);
    expect(awaitsReceiptPhoto({ ...view!, servedStatus: 'PAID' })).toBe(false);
  });
});
