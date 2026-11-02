/**
 * ECR-AUD-01 « Journal d'audit » (RP-1 ; REQ-065, REQ-209 ; 07-security-rbac/03-audit.md §6 ; BR-AUD-009 ;
 * AV-493) : logique pure de l'écran. Lecture de `GET /api/v1/audit` (droit `audit.log.read` : Direction, Admin
 * et Finance), la plus récente d'abord, par pages de 50 (`before_seq`). La Finance ne voit que les entités
 * financières : c'est le serveur qui l'impose et qui propose les types d'entité du filtre. Chaque consultation
 * est elle-même inscrite au journal : l'écran n'actualise donc jamais seul.
 */

export const AUDIT_PATH = '/api/v1/audit';
export const ENTITY_TYPES_PATH = '/api/v1/audit/entity-types';
export const ACTORS_PATH = '/api/v1/users?limit=200';
export const PAGE_SIZE = 50;

export type AuditResult = 'SUCCESS' | 'DENIED' | 'FAILED' | 'QUARANTINED';

export interface AuditEntryView {
  readonly seq: number;
  readonly id: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly actorUserId: string;
  readonly actorName: string | null;
  readonly actorRoles: readonly string[];
  readonly deviceId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
  readonly result: AuditResult;
  readonly commandId: string | null;
}

export interface AuditFilters {
  readonly entityType: string;
  readonly entityId: string;
  readonly actorUserId: string;
  readonly action: string;
  /** Jours `AAAA-MM-JJ` (fuseau de Douala) sur l'enregistrement serveur. */
  readonly from: string;
  readonly to: string;
}

export const EMPTY_FILTERS: AuditFilters = {
  entityType: '',
  entityId: '',
  actorUserId: '',
  action: '',
  from: '',
  to: '',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FilterProblem = 'PERIOD' | 'ENTITY_ID';

/** Filtre refusé avant l'envoi : période à l'envers, identifiant d'entité qui n'est pas un UUID. */
export function filterProblem(filters: AuditFilters): FilterProblem | null {
  if (filters.from !== '' && filters.to !== '' && filters.to < filters.from) return 'PERIOD';
  if (filters.entityId.trim() !== '' && !UUID.test(filters.entityId.trim())) return 'ENTITY_ID';
  return null;
}

/** Chemin de lecture d'une page : les filtres non vides, `before_seq` pour les pages plus anciennes. */
export function auditPath(filters: AuditFilters, beforeSeq?: number): string {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (filters.entityType) query.set('entity_type', filters.entityType);
  if (filters.entityId.trim()) query.set('entity_id', filters.entityId.trim());
  if (filters.actorUserId) query.set('actor_user_id', filters.actorUserId);
  if (filters.action.trim()) query.set('action', filters.action.trim());
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  if (beforeSeq !== undefined) query.set('before_seq', String(beforeSeq));
  return `${AUDIT_PATH}?${query.toString()}`;
}

/** Une page pleine laisse supposer des entrées plus anciennes. */
export function mayHaveMore(pageLength: number): boolean {
  return pageLength >= PAGE_SIZE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Champs dont la valeur diffère entre l'avant et l'après (objets seulement), triés. */
export function changedKeys(before: unknown, after: unknown): string[] {
  if (!isRecord(before) && !isRecord(after)) return [];
  const a = isRecord(before) ? before : {};
  const b = isRecord(after) ? after : {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .sort();
}

/** JSON lisible, tronqué pour ne pas alourdir la page. */
export function prettyJson(value: unknown, max = 4000): string {
  if (value === null || value === undefined) return '';
  const text = JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Début d'un identifiant, pour le repérer sans l'écrire en entier. */
export function shortId(id: string | null): string {
  return id ? id.slice(-8) : '';
}
