import { describe, expect, it } from 'vitest';
import { settingDefOf } from '@gic/contracts';
import {
  APPROVER_SCOPES,
  discountRoleOf,
  draftOf,
  groupOf,
  groupSettings,
  labelKeyOf,
  matchesSetting,
  policyChanged,
  policyCommand,
  policyFormOf,
  policyHistoryPath,
  policyProblem,
  sameValue,
  settingCommand,
  settingHistoryPath,
  valueOfDraft,
  visibilityOf,
  type PolicyView,
  type SettingRow,
  type SettingVersionView,
} from './settings.js';

const version = (overrides: Partial<SettingVersionView>): SettingVersionView => ({
  id: 'v1',
  key: 'finance.expense_approval_threshold_xaf',
  value: 50000,
  scopeType: 'GLOBAL',
  scopeId: null,
  validFrom: '2026-10-01T08:00:00.000Z',
  isClientVisible: true,
  reason: null,
  createdAt: '2026-10-01T08:00:00.000Z',
  createdByName: 'Awa Admin',
  ...overrides,
});

describe('Paramètres : domaines, libellés et recherche (ECR-ADM-07)', () => {
  it('domaine d’une clé : celui du catalogue, « autres » hors catalogue, remises par rôle dans les ventes', () => {
    expect(groupOf('finance.expense_approval_threshold_xaf')).toBe('finance');
    expect(groupOf('sync.stale_hours')).toBe('technical');
    expect(groupOf('pricing.max_discount_pct.RESP_COMMERCIAL')).toBe('sales');
    expect(groupOf('rp1.inconnue')).toBe('other');
  });

  it('libellé : clé i18n sans points ; remise par rôle avec le rôle en paramètre', () => {
    expect(labelKeyOf('finance.expense_approval_threshold_xaf')).toBe(
      'settings.label.finance_expense_approval_threshold_xaf',
    );
    expect(labelKeyOf('pricing.max_discount_pct.RESP_FERME')).toBe(
      'settings.label.pricing_max_discount_pct',
    );
    expect(discountRoleOf('pricing.max_discount_pct.RESP_FERME')).toBe('RESP_FERME');
    expect(discountRoleOf('finance.pos_expense_max_xaf')).toBeNull();
  });

  it('regroupe par domaine dans l’ordre du catalogue, techniques repliés, surcharges séparées', () => {
    const versions = [
      version({ id: 'a', key: 'sync.stale_hours', value: 24 }),
      version({ id: 'b', key: 'finance.pos_expense_max_xaf', value: 50000 }),
      version({ id: 'c', key: 'inventory.high_loss_alert_xaf', value: 50000 }),
      version({
        id: 'd',
        key: 'inventory.high_loss_alert_xaf',
        value: 80000,
        scopeType: 'SITE',
        scopeId: 'site-1',
      }),
      version({ id: 'e', key: 'rp1.inconnue', value: { a: 1 } }),
    ];
    const visible = groupSettings(versions, { includeTechnical: false });
    expect(visible.map((view) => view.group)).toEqual(['finance', 'inventory', 'other']);
    const all = groupSettings(versions, { includeTechnical: true });
    expect(all.map((view) => view.group)).toEqual(['finance', 'inventory', 'technical', 'other']);
    const loss = all[1]!.rows[0]!;
    expect(loss.key).toBe('inventory.high_loss_alert_xaf');
    expect(loss.global?.value).toBe(50000);
    expect(loss.overrides.map((entry) => entry.value)).toEqual([80000]);
    expect(loss.def?.site).toBe(true);
    expect(groupSettings([], { includeTechnical: true })).toEqual([]);
  });

  it('recherche : par clé ou par libellé, sans tenir compte de la casse', () => {
    const row: SettingRow = {
      key: 'finance.pos_expense_max_xaf',
      def: settingDefOf('finance.pos_expense_max_xaf'),
      global: version({}),
      overrides: [],
    };
    expect(matchesSetting(row, 'Plafond d’une dépense', '')).toBe(true);
    expect(matchesSetting(row, 'Plafond d’une dépense', 'PLAFOND')).toBe(true);
    expect(matchesSetting(row, 'Plafond d’une dépense', 'pos_expense')).toBe(true);
    expect(matchesSetting(row, 'Plafond d’une dépense', 'remise')).toBe(false);
    expect(settingHistoryPath('a.b c')).toBe('/api/v1/organization/settings?key=a.b%20c');
  });
});

describe('Paramètres : saisie d’une valeur contrôlée contre le catalogue', () => {
  const def = (key: string) => settingDefOf(key);

  it('nombre : virgule décimale, entier, bornes et unité du catalogue', () => {
    const threshold = def('finance.expense_approval_threshold_xaf');
    expect(valueOfDraft(threshold, { text: '60 000', flag: false, days: [] })).toEqual({
      ok: false,
      problem: 'TYPE',
    });
    expect(valueOfDraft(threshold, { text: '60000', flag: false, days: [] })).toEqual({
      ok: true,
      value: 60000,
    });
    expect(valueOfDraft(threshold, { text: '1,5', flag: false, days: [] })).toEqual({
      ok: false,
      problem: 'NOT_INTEGER',
    });
    expect(valueOfDraft(threshold, { text: '-1', flag: false, days: [] })).toEqual({
      ok: false,
      problem: 'MIN',
    });
    const radius = def('fieldwork.geofence_radius_m');
    expect(valueOfDraft(radius, { text: '6000', flag: false, days: [] })).toEqual({
      ok: false,
      problem: 'MAX',
    });
    const pct = def('production.high_mortality_alert_pct');
    expect(valueOfDraft(pct, { text: '0,5', flag: false, days: [] })).toEqual({
      ok: true,
      value: 0.5,
    });
  });

  it('oui/non, choix, liste (une valeur par ligne ou virgule), jours de la semaine', () => {
    expect(
      valueOfDraft(def('finance.supplier_advance_allowed'), { text: '', flag: false, days: [] }),
    ).toEqual({ ok: true, value: false });
    const choice = def('finance.invoice_without_po_mode');
    expect(valueOfDraft(choice, { text: 'APPROVE', flag: false, days: [] })).toEqual({
      ok: true,
      value: 'APPROVE',
    });
    expect(valueOfDraft(choice, { text: 'AUTRE', flag: false, days: [] })).toEqual({
      ok: false,
      problem: 'OPTION',
    });
    expect(
      valueOfDraft(def('crm.commercial_role_codes'), {
        text: 'RESP_COMMERCIAL\n COMMERCIAL_TERRAIN ,,\n',
        flag: false,
        days: [],
      }),
    ).toEqual({ ok: true, value: ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN'] });
    expect(
      valueOfDraft(def('sales.commercial_working_days'), {
        text: '',
        flag: false,
        days: ['6', '1', '3'],
      }),
    ).toEqual({ ok: true, value: ['1', '3', '6'] });
  });

  it('objet JSON : texte invalide ou non objet refusés ; hors catalogue, tout JSON valide', () => {
    const json = def('production.incubation_durations');
    expect(valueOfDraft(json, { text: '{ "POULE": ', flag: false, days: [] })).toEqual({
      ok: false,
      problem: 'PARSE',
    });
    expect(valueOfDraft(json, { text: '[1]', flag: false, days: [] })).toEqual({
      ok: false,
      problem: 'JSON_OBJECT',
    });
    expect(
      valueOfDraft(json, { text: '{"POULE":{"hatchDay":21}}', flag: false, days: [] }),
    ).toEqual({ ok: true, value: { POULE: { hatchDay: 21 } } });
    expect(valueOfDraft(undefined, { text: '[1, 2]', flag: false, days: [] })).toEqual({
      ok: true,
      value: [1, 2],
    });
    expect(valueOfDraft(undefined, { text: '{', flag: false, days: [] })).toEqual({
      ok: false,
      problem: 'PARSE',
    });
  });

  it('saisie de départ : la valeur en vigueur, sous la forme de son type', () => {
    expect(draftOf(def('finance.pos_expense_max_xaf'), 50000).text).toBe('50000');
    expect(draftOf(def('finance.supplier_advance_allowed'), true).flag).toBe(true);
    expect(draftOf(def('crm.commercial_role_codes'), ['A', 'B']).text).toBe('A\nB');
    expect(draftOf(def('sales.commercial_working_days'), ['1', '2']).days).toEqual(['1', '2']);
    expect(draftOf(undefined, { a: 1 }).text).toBe('{\n  "a": 1\n}');
    expect(sameValue(['1'], ['1'])).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('commande : nouvelle version, visibilité sur les appareils reportée, site si précisé', () => {
    expect(
      settingCommand(
        {
          key: 'finance.expense_approval_threshold_xaf',
          value: 60000,
          siteId: null,
          reason: ' Revue annuelle ',
          isClientVisible: true,
        },
        's1',
      ),
    ).toEqual({
      commandType: 'organization.setting.set',
      aggregateType: 'SETTING',
      aggregateId: 's1',
      payload: {
        key: 'finance.expense_approval_threshold_xaf',
        value: 60000,
        scopeType: 'GLOBAL',
        isClientVisible: true,
        reason: 'Revue annuelle',
      },
    });
    expect(
      settingCommand(
        {
          key: 'inventory.high_loss_alert_xaf',
          value: 80000,
          siteId: 'site-1',
          reason: '',
          isClientVisible: false,
        },
        's2',
      ).payload,
    ).toEqual({
      key: 'inventory.high_loss_alert_xaf',
      value: 80000,
      scopeType: 'SITE',
      scopeId: 'site-1',
      isClientVisible: false,
    });
    const row = (global: boolean, visible: boolean): SettingRow => ({
      key: 'k',
      def: undefined,
      global: global ? version({ isClientVisible: visible }) : undefined,
      overrides: [version({ scopeType: 'SITE', scopeId: 's', isClientVisible: !visible })],
    });
    expect(visibilityOf(row(true, true))).toBe(true);
    expect(visibilityOf(row(true, false))).toBe(false);
    // Sans version globale, celle d'une surcharge fait foi.
    expect(visibilityOf(row(false, true))).toBe(false);
  });
});

describe('Politiques de contrôle (AV-494)', () => {
  const policy = (overrides: Partial<PolicyView> = {}): PolicyView => ({
    id: 'p1',
    code: 'EXPENSE_DEFAULT',
    version: 2,
    operationType: 'EXPENSE',
    condition: { category: 'TRANSPORT' },
    requiresPhoto: false,
    requiresComment: false,
    requiresApproval: true,
    approverPermission: 'finance.expense.approve',
    approverScope: 'ALL',
    status: 'ACTIVE',
    validFrom: '2026-10-01T08:00:00.000Z',
    validTo: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    createdByName: 'Awa Admin',
    ...overrides,
  });

  it('formulaire d’une politique, défaut ALL pour une portée absente ou inconnue', () => {
    expect(policyFormOf(policy())).toEqual({
      requiresPhoto: false,
      requiresComment: false,
      requiresApproval: true,
      approverPermission: 'finance.expense.approve',
      approverScope: 'ALL',
    });
    expect(
      policyFormOf(policy({ approverScope: null, approverPermission: null })).approverScope,
    ).toBe('ALL');
    expect(policyFormOf(policy({ approverScope: 'OWN' })).approverScope).toBe('ALL');
    expect(APPROVER_SCOPES).toEqual(['ALL', 'ZONE', 'SITE', 'TEAM']);
    expect(policyHistoryPath('A B')).toBe('/api/v1/approvals/policies?code=A%20B');
  });

  it('une validation exige un approbateur ; changement détecté', () => {
    const current = policy();
    const form = policyFormOf(current);
    expect(policyProblem(form)).toBeNull();
    expect(policyProblem({ ...form, approverPermission: '' })).toBe('APPROVER');
    expect(policyProblem({ ...form, requiresApproval: false, approverPermission: '' })).toBeNull();
    expect(policyChanged(current, form)).toBe(false);
    expect(policyChanged(current, { ...form, requiresPhoto: true })).toBe(true);
    expect(policyChanged(current, { ...form, approverScope: 'SITE' })).toBe(true);
    // Sans validation, l'approbateur et la portée ne comptent plus.
    const free = policy({ requiresApproval: false, approverPermission: null, approverScope: null });
    expect(policyChanged(free, { ...policyFormOf(free), approverScope: 'SITE' })).toBe(false);
  });

  it('commande : même code et même type, condition reprise telle quelle, approbateur seulement si validation', () => {
    const current = policy();
    const form = { ...policyFormOf(current), requiresPhoto: true };
    expect(policyCommand(current, form, 'id-9')).toEqual({
      commandType: 'approvals.policy.set',
      aggregateType: 'CONTROL_POLICY',
      aggregateId: 'id-9',
      payload: {
        code: 'EXPENSE_DEFAULT',
        operationType: 'EXPENSE',
        condition: { category: 'TRANSPORT' },
        requiresPhoto: true,
        requiresComment: false,
        requiresApproval: true,
        approverPermission: 'finance.expense.approve',
        approverScope: 'ALL',
      },
    });
    const dropped = policyCommand(current, { ...form, requiresApproval: false }, 'id-10').payload;
    expect(dropped).not.toHaveProperty('approverPermission');
    expect(dropped).not.toHaveProperty('approverScope');
    expect(policyCommand(policy({ condition: null }), form, 'id-11').payload.condition).toEqual({});
  });
});
