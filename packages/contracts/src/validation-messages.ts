/**
 * Messages de validation en français (S-37, P5-23). Le pipeline joignait les messages bruts de zod
 * (« Invalid email », « Number must be less than or equal to 3650 ») au refus `VALIDATION_ERROR`,
 * montrés tels quels à l'utilisateur. Chaque constat est traduit ici d'après son code et son chemin ;
 * un constat `custom` garde son message, déjà rédigé en français par le schéma qui le pose.
 * Partagé par le serveur et l'appareil (ADR-021) : une saisie refusée sur la tablette dit la même
 * chose qu'au serveur.
 */
import type { z } from 'zod';

const TYPE_NAMES: Readonly<Record<string, string>> = {
  string: 'un texte',
  number: 'un nombre',
  integer: 'un nombre entier',
  float: 'un nombre décimal',
  boolean: 'un booléen',
  object: 'un objet',
  array: 'une liste',
  date: 'une date',
  bigint: 'un grand entier',
  null: 'la valeur nulle',
  undefined: 'aucune valeur',
};

function typeName(type: string): string {
  return TYPE_NAMES[type] ?? type;
}

function fieldOf(issue: z.ZodIssue): string {
  return issue.path.length > 0 ? `« ${issue.path.join('.')} » : ` : '';
}

function bound(value: number | bigint): string {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

/** Message français d'un constat de validation, précédé du champ concerné. */
export function describeIssueFr(issue: z.ZodIssue): string {
  const field = fieldOf(issue);
  switch (issue.code) {
    case 'invalid_type':
      if (issue.received === 'undefined') return `${field}champ obligatoire.`;
      if (issue.expected === 'integer') return `${field}nombre entier attendu.`;
      return `${field}${typeName(issue.expected)} attendu, ${typeName(issue.received)} reçu.`;
    case 'invalid_string': {
      const validation = issue.validation;
      if (validation === 'email') return `${field}adresse électronique invalide.`;
      if (validation === 'uuid') return `${field}identifiant invalide (UUID attendu).`;
      if (validation === 'datetime')
        return `${field}date et heure invalides (format ISO 8601 attendu).`;
      if (validation === 'date') return `${field}date invalide (AAAA-MM-JJ attendu).`;
      if (validation === 'url') return `${field}adresse web invalide.`;
      return `${field}format invalide.`;
    }
    case 'too_small':
      if (issue.type === 'string') {
        return Number(issue.minimum) <= 1
          ? `${field}texte vide.`
          : `${field}au moins ${bound(issue.minimum)} caractères.`;
      }
      if (issue.type === 'array') return `${field}au moins ${bound(issue.minimum)} élément(s).`;
      return issue.inclusive
        ? `${field}valeur trop petite (au moins ${bound(issue.minimum)}).`
        : `${field}valeur trop petite (strictement plus de ${bound(issue.minimum)}).`;
    case 'too_big':
      if (issue.type === 'string') return `${field}au plus ${bound(issue.maximum)} caractères.`;
      if (issue.type === 'array') return `${field}au plus ${bound(issue.maximum)} élément(s).`;
      return issue.inclusive
        ? `${field}valeur trop grande (au plus ${bound(issue.maximum)}).`
        : `${field}valeur trop grande (strictement moins de ${bound(issue.maximum)}).`;
    case 'invalid_enum_value':
      return `${field}valeur inconnue « ${String(issue.received)} » (attendu : ${issue.options.map(String).join(', ')}).`;
    case 'invalid_literal':
      return `${field}valeur inattendue (attendu : ${String(issue.expected)}).`;
    case 'unrecognized_keys':
      return `${field}champ(s) inconnu(s) : ${issue.keys.join(', ')}.`;
    case 'invalid_union':
    case 'invalid_union_discriminator':
      return `${field}valeur invalide.`;
    case 'invalid_date':
      return `${field}date invalide.`;
    case 'not_multiple_of':
      return `${field}doit être un multiple de ${bound(issue.multipleOf)}.`;
    case 'not_finite':
      return `${field}nombre fini attendu.`;
    case 'custom':
      return field.length > 0 && !issue.message.startsWith('«')
        ? `${field}${issue.message}`
        : issue.message;
    default:
      return `${field}${issue.message}`;
  }
}

/** Constats joints par « ; » (forme du détail de `VALIDATION_ERROR`). */
export function describeIssuesFr(issues: readonly z.ZodIssue[]): string {
  return issues.map(describeIssueFr).join(' ; ');
}
