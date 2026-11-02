/**
 * ECR-ADM-07 « Paramètres et politiques de contrôle » (RP-1 ; UC-ADM-13, UC-ADM-14 ; BR-ADM-015, BR-ADM-016 ;
 * AV-490 à AV-494) : logique pure de l'écran.
 *
 * Paramètres : `GET /organization/settings/current` (version en vigueur de chaque clé et de chaque surcharge de
 * site), `GET /organization/settings?key=` (historique d'une clé), commande `organization.setting.set` (droit
 * `org.settings.manage`, Direction et Admin). Chaque révision ajoute une version datée, jamais une réécriture.
 * La forme de chaque valeur vient du catalogue partagé (`@gic/contracts`) ; une clé hors catalogue se règle en JSON.
 *
 * Politiques : `GET /approvals/policies` et commande `approvals.policy.set` (droit `approvals.policy.manage`) :
 * photo, commentaire, validation, approbateur et portée ; la `condition` (JSON) est conservée telle quelle.
 */
import {
  DISCOUNT_SETTING_PREFIX,
  SETTING_GROUPS,
  WEEKDAY_VALUES,
  settingDefOf,
  validateSettingValue,
  type SettingDef,
  type SettingGroup,
  type SettingProblem,
} from '@gic/contracts';
import { parseDecimal } from '../admin/parse.js';

export const SETTINGS_PATH = '/api/v1/organization/settings/current';
export const settingHistoryPath = (key: string) =>
  `/api/v1/organization/settings?key=${encodeURIComponent(key)}`;
export const POLICIES_PATH = '/api/v1/approvals/policies';
export const policyHistoryPath = (code: string) =>
  `${POLICIES_PATH}?code=${encodeURIComponent(code)}`;

export const REASON_MAX = 500;

export type SettingScope = 'GLOBAL' | 'SITE' | 'ZONE' | 'ROLE';

export interface SettingVersionView {
  readonly id: string;
  readonly key: string;
  readonly value: unknown;
  readonly scopeType: SettingScope;
  readonly scopeId: string | null;
  readonly validFrom: string;
  readonly isClientVisible: boolean;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly createdByName: string | null;
}

/** Une clé avec sa version globale et ses surcharges (par site, zone ou rôle). */
export interface SettingRow {
  readonly key: string;
  readonly def: SettingDef | undefined;
  readonly global: SettingVersionView | undefined;
  readonly overrides: readonly SettingVersionView[];
}

export type DisplayGroup = SettingGroup | 'other';

export interface SettingGroupView {
  readonly group: DisplayGroup;
  readonly rows: readonly SettingRow[];
}

/** Domaine d'une clé : celui du catalogue, sinon « autres ». */
export function groupOf(key: string): DisplayGroup {
  return settingDefOf(key)?.group ?? 'other';
}

/** Nom du rôle d'une clé de remise (`pricing.max_discount_pct.<RÔLE>`), sinon `null`. */
export function discountRoleOf(key: string): string | null {
  return key.startsWith(DISCOUNT_SETTING_PREFIX) ? key.slice(DISCOUNT_SETTING_PREFIX.length) : null;
}

/** Clé i18n du libellé (`settings.label.<clé, points remplacés par des tirets bas>`). */
export function labelKeyOf(key: string): string {
  const role = discountRoleOf(key);
  return `settings.label.${role !== null ? 'pricing_max_discount_pct' : key.replaceAll('.', '_')}`;
}

/** Regroupe les versions en vigueur par domaine (ordre du catalogue, « autres » à la fin), clés triées. */
export function groupSettings(
  versions: readonly SettingVersionView[],
  options: { readonly includeTechnical: boolean },
): SettingGroupView[] {
  const byKey = new Map<string, SettingVersionView[]>();
  for (const version of versions) {
    byKey.set(version.key, [...(byKey.get(version.key) ?? []), version]);
  }
  const rows: SettingRow[] = [...byKey.entries()]
    .map(([key, list]) => ({
      key,
      def: settingDefOf(key),
      global: list.find((version) => version.scopeType === 'GLOBAL'),
      overrides: list.filter((version) => version.scopeType !== 'GLOBAL'),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const order: readonly DisplayGroup[] = [...SETTING_GROUPS, 'other'];
  return order
    .filter((group) => options.includeTechnical || group !== 'technical')
    .map((group) => ({ group, rows: rows.filter((row) => groupOf(row.key) === group) }))
    .filter((view) => view.rows.length > 0);
}

/** Recherche locale : clé ou libellé contenant le texte. */
export function matchesSetting(row: SettingRow, label: string, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return row.key.toLowerCase().includes(needle) || label.toLowerCase().includes(needle);
}

/* --- Saisie d'une valeur ------------------------------------------------------------------------------- */

export interface SettingDraft {
  /** Texte saisi (nombre, texte, choix, liste une valeur par ligne, JSON). */
  readonly text: string;
  readonly flag: boolean;
  /** Jours cochés d'un réglage `weekdays`. */
  readonly days: readonly string[];
}

/** Saisie de départ : la valeur en vigueur. */
export function draftOf(def: SettingDef | undefined, value: unknown): SettingDraft {
  const days = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
  if (def === undefined || def.kind === 'json') {
    return { text: JSON.stringify(value ?? null, null, 2), flag: false, days: [] };
  }
  switch (def.kind) {
    case 'bool':
      return { text: '', flag: value === true, days: [] };
    case 'list':
      return { text: days.join('\n'), flag: false, days: [] };
    case 'weekdays':
      return { text: '', flag: false, days };
    case 'int':
    case 'number':
    case 'text':
    case 'choice':
      return {
        text: typeof value === 'string' || typeof value === 'number' ? String(value) : '',
        flag: false,
        days: [],
      };
  }
}

export type DraftResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly problem: SettingProblem | 'PARSE' };

/** Valeur à écrire d'après la saisie, contrôlée contre le catalogue (hors catalogue : tout JSON valide). */
export function valueOfDraft(def: SettingDef | undefined, draft: SettingDraft): DraftResult {
  if (def === undefined) {
    try {
      return { ok: true, value: JSON.parse(draft.text) as unknown };
    } catch {
      return { ok: false, problem: 'PARSE' };
    }
  }
  let value: unknown;
  switch (def.kind) {
    case 'int':
    case 'number': {
      const parsed = parseDecimal(draft.text);
      if (parsed === null) return { ok: false, problem: 'TYPE' };
      value = parsed;
      break;
    }
    case 'bool':
      value = draft.flag;
      break;
    case 'text':
    case 'choice':
      value = draft.text.trim();
      break;
    case 'list':
      value = draft.text
        .split(/\r?\n|,/)
        .map((item) => item.trim())
        .filter((item) => item !== '');
      break;
    case 'weekdays':
      value = WEEKDAY_VALUES.filter((day) => draft.days.includes(day));
      break;
    case 'json':
      try {
        value = JSON.parse(draft.text) as unknown;
      } catch {
        return { ok: false, problem: 'PARSE' };
      }
      break;
  }
  const problem = validateSettingValue(def, value);
  return problem === null ? { ok: true, value } : { ok: false, problem };
}

/** Deux valeurs JSON identiques (une révision sans changement n'est pas envoyée). */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface SettingCommandInput {
  readonly key: string;
  readonly value: unknown;
  /** `null` : portée globale ; sinon l'identifiant du site. */
  readonly siteId: string | null;
  readonly reason: string;
  /** Visibilité sur les appareils de la version remplacée : une révision ne la fait jamais perdre. */
  readonly isClientVisible: boolean;
}

/**
 * `organization.setting.set` : une nouvelle version (identifiant frais). `isClientVisible` reprend celui de la
 * version en vigueur : omis, il vaudrait « faux » et la valeur ne descendrait plus sur les appareils.
 */
export function settingCommand(input: SettingCommandInput, settingId: string) {
  return {
    commandType: 'organization.setting.set',
    aggregateType: 'SETTING',
    aggregateId: settingId,
    payload: {
      key: input.key,
      value: input.value,
      scopeType: input.siteId === null ? 'GLOBAL' : 'SITE',
      ...(input.siteId !== null ? { scopeId: input.siteId } : {}),
      isClientVisible: input.isClientVisible,
      ...(input.reason.trim() ? { reason: input.reason.trim() } : {}),
    } satisfies Record<string, unknown>,
  };
}

/** Visibilité à reporter : celle de la version globale, à défaut de toute version de la clé. */
export function visibilityOf(row: SettingRow): boolean {
  return (row.global ?? row.overrides[0])?.isClientVisible ?? false;
}

/* --- Politiques de contrôle ---------------------------------------------------------------------------- */

export const APPROVER_SCOPES = ['ALL', 'ZONE', 'SITE', 'TEAM'] as const;
export type ApproverScope = (typeof APPROVER_SCOPES)[number];

export interface PolicyView {
  readonly id: string;
  readonly code: string;
  readonly version: number;
  readonly operationType: string;
  readonly condition: unknown;
  readonly requiresPhoto: boolean;
  readonly requiresComment: boolean;
  readonly requiresApproval: boolean;
  readonly approverPermission: string | null;
  readonly approverScope: string | null;
  readonly status: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly createdAt: string;
  readonly createdByName: string | null;
}

export interface ApproverPermissionView {
  readonly code: string;
  readonly description: string;
}

export interface PolicyForm {
  readonly requiresPhoto: boolean;
  readonly requiresComment: boolean;
  readonly requiresApproval: boolean;
  readonly approverPermission: string;
  readonly approverScope: ApproverScope;
}

export function policyFormOf(policy: PolicyView): PolicyForm {
  return {
    requiresPhoto: policy.requiresPhoto,
    requiresComment: policy.requiresComment,
    requiresApproval: policy.requiresApproval,
    approverPermission: policy.approverPermission ?? '',
    approverScope: (APPROVER_SCOPES as readonly string[]).includes(policy.approverScope ?? '')
      ? (policy.approverScope as ApproverScope)
      : 'ALL',
  };
}

/** Une validation exige un approbateur (contrainte du dictionnaire `approvals.control_policies`). */
export function policyProblem(form: PolicyForm): 'APPROVER' | null {
  return form.requiresApproval && form.approverPermission === '' ? 'APPROVER' : null;
}

export function policyChanged(policy: PolicyView, form: PolicyForm): boolean {
  const next = policyFormOf(policy);
  if (form.requiresPhoto !== next.requiresPhoto) return true;
  if (form.requiresComment !== next.requiresComment) return true;
  if (form.requiresApproval !== next.requiresApproval) return true;
  return (
    form.requiresApproval &&
    (form.approverPermission !== next.approverPermission ||
      form.approverScope !== next.approverScope)
  );
}

/**
 * `approvals.policy.set` : même code et même type d'opération, `condition` inchangée, nouvelle version active
 * (l'ancienne est retirée par le serveur). Sans validation, aucun approbateur n'est envoyé.
 */
export function policyCommand(policy: PolicyView, form: PolicyForm, policyId: string) {
  return {
    commandType: 'approvals.policy.set',
    aggregateType: 'CONTROL_POLICY',
    aggregateId: policyId,
    payload: {
      code: policy.code,
      operationType: policy.operationType,
      condition: (typeof policy.condition === 'object' && policy.condition !== null
        ? policy.condition
        : {}) as Record<string, unknown>,
      requiresPhoto: form.requiresPhoto,
      requiresComment: form.requiresComment,
      requiresApproval: form.requiresApproval,
      ...(form.requiresApproval
        ? { approverPermission: form.approverPermission, approverScope: form.approverScope }
        : {}),
    } satisfies Record<string, unknown>,
  };
}
