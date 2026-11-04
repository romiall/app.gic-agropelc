/**
 * Chargement de données par fichier CSV (RP-2, PP-C ; AV-072, AV-317, AV-508) : modèle commun à tous les types de
 * données chargeables. Chaque type décrit ses colonnes et sait transformer une ligne en commandes du serveur — celles
 * que les écrans de saisie envoient déjà (mêmes contrôles, mêmes charges). Le chargement ne court-circuite rien :
 * chaque ligne devient des commandes idempotentes de l'outbox, validées par le serveur et auditées (règle 3).
 *
 * Contrôle avant chargement (`planImport`) : colonnes manquantes ou inconnues, une issue par ligne (prête, déjà
 * présente, en erreur, doublon dans le fichier). Rien n'est écrit tant que l'utilisateur ne charge pas.
 */
import { normalizeHeaderName, type ParsedCsv } from './csv.js';
import type { ImportRefs } from './refs.js';

export interface ColumnDef {
  /** Nom canonique de la colonne (minuscules, tiret bas) ; l'en-tête du fichier est comparé après normalisation. */
  readonly key: string;
  /** Libellé donné à l'en-tête du fichier modèle. */
  readonly label: string;
  readonly required: boolean;
  /** Valeur d'exemple du fichier modèle. */
  readonly example: string;
  /** Aide à la saisie (valeurs permises, format). */
  readonly hint: string;
  /** Autres noms acceptés pour cette colonne dans le fichier (normalisés). */
  readonly aliases?: readonly string[];
}

export interface PlannedCommand {
  readonly commandType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  /**
   * Fait accompli saisi hors du système (pièce papier reportée, PP-C) : l'heure et le motif d'antidatage sont ceux de
   * la pièce, la commande part « saisie hors ligne » même appareil connecté (BR-SYN-007). Absent : l'heure de la saisie.
   */
  readonly occurredAt?: string;
  readonly backdatedReason?: string | null;
  readonly capturedOffline?: boolean;
  /** Commandes de l'outbox dont l'envoi doit précéder celle-ci (compte ou commande encore en attente). */
  readonly dependsOn?: readonly string[];
  /** Indices locaux, jamais envoyés (registre des carnets). */
  readonly localFlags?: readonly string[];
}

export interface RowOutcome {
  /** Clé de la ligne dans son type (code du produit, téléphone du client…) : sert aux doublons du fichier. */
  readonly key: string;
  readonly issues: readonly string[];
  /** Vrai : la donnée est déjà dans l'application, la ligne n'est pas rechargée. */
  readonly exists?: boolean;
  readonly commands: readonly PlannedCommand[];
  /**
   * Ce que cette ligne crée et que les lignes suivantes du fichier peuvent citer (ex. une catégorie parente) :
   * natures et clés, comme `[{ kind: 'category', key: 'VOLAILLE' }]`.
   */
  readonly provides?: readonly { readonly kind: string; readonly key: string }[];
}

/** Natures et clés créées par les lignes déjà contrôlées du fichier (une ligne ne cite que ce qui la précède). */
export type PlannedKeys = ReadonlyMap<string, ReadonlySet<string>>;

export type RowStatus = 'READY' | 'EXISTS' | 'ERROR' | 'DUPLICATE_IN_FILE';

export interface RowPlan {
  readonly line: number;
  readonly key: string;
  readonly status: RowStatus;
  readonly issues: readonly string[];
  readonly commands: readonly PlannedCommand[];
}

export interface ImportPlan {
  readonly entityId: string;
  readonly rows: readonly RowPlan[];
  /** Colonnes obligatoires absentes du fichier : rien n'est chargeable. */
  readonly missingColumns: readonly string[];
  /** En-têtes du fichier qu'aucune colonne du modèle ne reconnaît : ignorés, listés au rapport (AV-317). */
  readonly unknownColumns: readonly string[];
  readonly counts: Readonly<Record<RowStatus, number>>;
}

/** Une ligne du fichier telle que lue : son numéro et ses cellules rattachées aux colonnes du modèle. */
export interface FileRecord {
  readonly line: number;
  readonly record: Readonly<Record<string, string>>;
}

export interface ImportEntity {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly columns: readonly ColumnDef[];
  /** Ordre de chargement conseillé : les catégories avant les produits qui les citent. */
  readonly order: number;
  /**
   * Rôles qui peuvent charger ce type : ceux de l'écran de saisie correspondant (01-rbac.md). Ils composent l'écran,
   * jamais l'autorisation : le serveur revérifie chaque commande.
   */
  readonly roles: readonly string[];
  planRow(
    record: Readonly<Record<string, string>>,
    refs: ImportRefs,
    planned: PlannedKeys,
  ): Promise<RowOutcome> | RowOutcome;
  /**
   * Types dont un élément tient en plusieurs lignes du fichier (une pièce papier à plusieurs lignes de produit) :
   * clé de regroupement d'une ligne, ou `undefined` pour une ligne isolée. Avec elle, `planGroup` remplace `planRow` :
   * il reçoit toutes les lignes du même élément, dans l'ordre du fichier.
   */
  groupKey?(record: Readonly<Record<string, string>>): string | undefined;
  planGroup?(
    group: readonly FileRecord[],
    refs: ImportRefs,
    planned: PlannedKeys,
  ): Promise<RowOutcome> | RowOutcome;
}

/** Colonnes du fichier rattachées à celles du modèle : `header[i]` → clé canonique, ou `null` si inconnue. */
export function mapHeader(
  entity: ImportEntity,
  header: readonly string[],
): { readonly keys: readonly (string | null)[]; readonly unknown: readonly string[] } {
  const byName = new Map<string, string>();
  for (const column of entity.columns) {
    byName.set(normalizeHeaderName(column.key), column.key);
    byName.set(normalizeHeaderName(column.label), column.key);
    for (const alias of column.aliases ?? []) byName.set(normalizeHeaderName(alias), column.key);
  }
  const seen = new Set<string>();
  const keys: (string | null)[] = [];
  const unknown: string[] = [];
  for (const name of header) {
    const key = byName.get(normalizeHeaderName(name)) ?? null;
    // Une colonne répétée : la première compte, les suivantes sont ignorées et signalées.
    if (key === null || seen.has(key)) {
      keys.push(null);
      unknown.push(name);
    } else {
      keys.push(key);
      seen.add(key);
    }
  }
  return { keys, unknown };
}

/**
 * Éléments à contrôler : une ligne chacun, ou, pour un type groupé, toutes les lignes d'un même élément (réunies à la
 * place de sa première ligne, dans l'ordre du fichier). Une ligne sans clé de regroupement reste seule.
 */
function groupRecords(entity: ImportEntity, records: readonly FileRecord[]): FileRecord[][] {
  if (!entity.groupKey) return records.map((record) => [record]);
  const groups: FileRecord[][] = [];
  const byKey = new Map<string, FileRecord[]>();
  for (const record of records) {
    const key = entity.groupKey(record.record);
    const known = key === undefined ? undefined : byKey.get(key);
    if (known) {
      known.push(record);
    } else {
      const group = [record];
      groups.push(group);
      if (key !== undefined) byKey.set(key, group);
    }
  }
  return groups;
}

/** Contrôle un fichier lu pour un type de données : aucune écriture. */
export async function planImport(
  entity: ImportEntity,
  csv: ParsedCsv,
  refs: ImportRefs,
): Promise<ImportPlan> {
  const { keys, unknown } = mapHeader(entity, csv.header);
  const present = new Set(keys.filter((key): key is string => key !== null));
  const missingColumns = entity.columns
    .filter((column) => column.required && !present.has(column.key))
    .map((column) => column.label);
  const counts: Record<RowStatus, number> = { READY: 0, EXISTS: 0, ERROR: 0, DUPLICATE_IN_FILE: 0 };
  const rows: RowPlan[] = [];
  if (missingColumns.length === 0) {
    const firstLineOf = new Map<string, number>();
    const planned = new Map<string, Set<string>>();
    const records: FileRecord[] = csv.rows.map((row) => {
      const record: Record<string, string> = {};
      keys.forEach((key, index) => {
        if (key !== null) record[key] = row.cells[index] ?? '';
      });
      return { line: row.line, record };
    });
    for (const group of groupRecords(entity, records)) {
      const row = group[0]!;
      const outcome = entity.planGroup
        ? await entity.planGroup(group, refs, planned)
        : await entity.planRow(row.record, refs, planned);
      let status: RowStatus;
      let issues = outcome.issues;
      if (outcome.issues.length > 0) {
        status = 'ERROR';
      } else if (firstLineOf.has(outcome.key)) {
        status = 'DUPLICATE_IN_FILE';
        issues = [`Déjà présent à la ligne ${firstLineOf.get(outcome.key)} du fichier.`];
      } else {
        status = outcome.exists === true ? 'EXISTS' : 'READY';
      }
      if (!firstLineOf.has(outcome.key) && outcome.issues.length === 0) {
        firstLineOf.set(outcome.key, row.line);
        for (const provided of outcome.provides ?? []) {
          const keysOfKind = planned.get(provided.kind) ?? new Set<string>();
          keysOfKind.add(provided.key);
          planned.set(provided.kind, keysOfKind);
        }
      }
      counts[status] += 1;
      rows.push({
        line: row.line,
        key: outcome.key,
        status,
        issues,
        commands: status === 'READY' ? outcome.commands : [],
      });
    }
  }
  return { entityId: entity.id, rows, missingColumns, unknownColumns: unknown, counts };
}

/** Fichier modèle d'un type : l'en-tête et une ligne d'exemple, à remplir dans Excel et à enregistrer en CSV. */
export function templateRows(entity: ImportEntity): string[][] {
  return [entity.columns.map((c) => c.label), entity.columns.map((c) => c.example)];
}

// --- Lecture des valeurs d'une cellule ------------------------------------------------------------------------------

/** Cellule vide ou absente → `undefined`. */
export function cell(record: Readonly<Record<string, string>>, key: string): string | undefined {
  const value = record[key]?.trim();
  return value ? value : undefined;
}

const YES = new Set(['oui', 'o', 'vrai', 'true', '1', 'yes', 'y', 'x']);
const NO = new Set(['non', 'n', 'faux', 'false', '0', 'no']);

/** Oui/non en français ou anglais ; vide → valeur par défaut ; autre chose → `null` (à signaler). */
export function yesNo(value: string | undefined, fallback: boolean): boolean | null {
  if (value === undefined) return fallback;
  const normalized = normalizeHeaderName(value);
  if (YES.has(normalized)) return true;
  if (NO.has(normalized)) return false;
  return null;
}

/** Code de liste : majuscules, tirets bas (« Poulet de chair » → `POULET_DE_CHAIR`). */
export function listCode(value: string): string {
  return normalizeHeaderName(value).toUpperCase();
}

/** Code saisi par l'utilisateur (produit, catégorie, fournisseur) : espaces rognés, majuscules. */
export function entityCode(value: string): string {
  return value.trim().toUpperCase();
}
