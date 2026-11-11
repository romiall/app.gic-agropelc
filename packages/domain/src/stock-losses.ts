/**
 * Validation d'une perte de stock hors mortalité (D06 BR-STK-031 et BR-STK-032 ; AV-037, tranché par le porteur le
 * 08/11/2026 : questionnaire de clôture, Q50 A). La règle se lit dans la `condition` de la politique de contrôle
 * `LOSS_DECLARATION` en vigueur ; la mortalité suit sa propre politique (`MORTALITY`, `mortalityRequiresApproval`).
 *
 * Forme de la condition : `{ alwaysCategories, thresholdCategories, thresholdXaf }` — catégories toujours validées,
 * catégories validées à partir d'une valeur (XAF, au coût courant de la sortie), et ce seuil. Politique par défaut
 * semée (`LOSS_DECLARATION_DEFAULT`) : destruction, perte inexpliquée et vol suspecté toujours ; casse, détérioration
 * et produit impropre à partir de 25 000 XAF. Une politique qui exige la validation sans porter cette forme valide
 * toute perte (comportement d'avant la décision).
 */

/** Règle de validation d'une perte, lue dans la condition d'une politique `LOSS_DECLARATION`. */
export interface LossApprovalRule {
  /** Catégories toujours validées, quelle que soit la valeur. */
  readonly alwaysCategories: readonly string[];
  /** Catégories validées à partir de `thresholdXaf`. */
  readonly thresholdCategories: readonly string[];
  /** Seuil de valeur (XAF, inclus) des catégories à seuil. */
  readonly thresholdXaf: number;
}

const stringList = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * Règle portée par la condition d'une politique ; `null` si la condition ne nomme aucune catégorie (toute perte est
 * alors validée). Un seuil absent, négatif ou non numérique vaut 0 : la catégorie est validée dès le premier franc,
 * jamais exemptée par erreur de saisie.
 */
export function lossApprovalRuleOf(condition: unknown): LossApprovalRule | null {
  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) return null;
  const fields = condition as Record<string, unknown>;
  if (!('alwaysCategories' in fields) && !('thresholdCategories' in fields)) return null;
  const threshold = Number(fields['thresholdXaf']);
  return {
    alwaysCategories: stringList(fields['alwaysCategories']),
    thresholdCategories: stringList(fields['thresholdCategories']),
    thresholdXaf: Number.isFinite(threshold) && threshold > 0 ? threshold : 0,
  };
}

/**
 * Une perte hors mortalité d'une politique qui exige la validation est-elle soumise à validation ? Sans règle
 * (`null`) : toujours. Sinon : toujours pour une catégorie de `alwaysCategories`, à partir du seuil (valeur ≥ seuil)
 * pour une catégorie de `thresholdCategories`, jamais pour une autre catégorie.
 */
export function lossRequiresApproval(input: {
  readonly category: string;
  /** Valeur de la perte au coût courant de la sortie (XAF). */
  readonly valueXaf: number;
  readonly rule: LossApprovalRule | null;
}): boolean {
  const { rule } = input;
  if (rule === null) return true;
  if (rule.alwaysCategories.includes(input.category)) return true;
  if (rule.thresholdCategories.includes(input.category)) {
    return Math.abs(input.valueXaf) >= rule.thresholdXaf;
  }
  return false;
}

/** La règle a-t-elle besoin de la valeur de la perte pour décider (catégorie à seuil) ? */
export function lossApprovalNeedsValue(category: string, rule: LossApprovalRule | null): boolean {
  return rule !== null && rule.thresholdCategories.includes(category);
}
