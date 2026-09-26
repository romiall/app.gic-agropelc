/**
 * Règles partagées du compte client (D02-CRM) : normalisation du téléphone (BR-CRM-006 : unicité
 * du téléphone **normalisé**, contrôle local hors ligne puis serveur) et fusion champ par champ
 * d'un compte modifié sur deux appareils (matrice des conflits, ligne « prospect modifié sur deux
 * appareils »). Pur, identique sur l'appareil et le serveur (ADR-021).
 */
import { DomainError } from './errors.js';

const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * Normalise un téléphone saisi sur le terrain en E.164 (conventions §2, type `phone`) : retire
 * espaces et séparateurs, `00` → `+`, et préfixe l'indicatif par défaut d'un numéro national
 * (DÉDUIT : GIC opère au Cameroun, numéros nationaux à 9 chiffres ; l'indicatif est un paramètre
 * de l'appelant). `PHONE_INVALID` si le résultat n'est pas un E.164 valide.
 */
export function normalizePhone(raw: string, defaultCountryCode: string): string {
  let value = raw.trim().replace(/[\s.\-()/]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (!value.startsWith('+')) {
    if (!/^[0-9]+$/.test(value)) {
      throw new DomainError('Téléphone invalide.', 'PHONE_INVALID');
    }
    // Déjà international sans « + » (ex. 237 6XX XX XX XX) : indicatif + au moins 8 chiffres.
    value =
      value.startsWith(defaultCountryCode) && value.length >= defaultCountryCode.length + 8
        ? `+${value}`
        : `+${defaultCountryCode}${value.replace(/^0+/, '')}`;
  }
  if (!E164.test(value)) {
    throw new DomainError('Téléphone invalide (format E.164 attendu).', 'PHONE_INVALID');
  }
  return value;
}

/** Dernière écriture connue d'un champ du compte : version de la ligne et heure métier. */
export interface FieldVersion {
  readonly version: number;
  readonly occurredAt: string;
}

export interface FieldCollision {
  readonly field: string;
  readonly clientValue: unknown;
  readonly serverValue: unknown;
  readonly winner: 'CLIENT' | 'SERVER';
}

/** Égalité de valeur d'un champ : identité, ou même contenu pour une valeur composée (ex. la
 * position `{ lat, lng, accuracyM }`, construite dans un ordre de clés fixe par l'appelant). */
function sameFieldValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * Matrice des conflits (compte client modifié sur deux appareils) : si les champs modifiés par
 * l'appareil n'ont pas été modifiés côté serveur depuis `baseVersion`, ils sont appliqués. Pour un
 * champ modifié des deux côtés, la valeur de `occurred_at` la plus récente l'emporte et l'autre
 * est rapportée comme collision (conflit informatif `VERSION_CONFLICT`). Sans `baseVersion`
 * (écriture en ligne sur l'état courant), tout le patch s'applique.
 */
export function mergeFieldPatch(input: {
  readonly patch: Readonly<Record<string, unknown>>;
  readonly baseVersion: number | null;
  readonly clientOccurredAt: Date;
  readonly fieldVersions: Readonly<Record<string, FieldVersion>>;
  readonly currentValues: Readonly<Record<string, unknown>>;
}): { readonly applied: Record<string, unknown>; readonly collisions: readonly FieldCollision[] } {
  const applied: Record<string, unknown> = {};
  const collisions: FieldCollision[] = [];
  for (const [field, clientValue] of Object.entries(input.patch)) {
    const serverWrite = input.fieldVersions[field];
    const changedSinceBase =
      input.baseVersion !== null &&
      serverWrite !== undefined &&
      serverWrite.version > input.baseVersion;
    if (!changedSinceBase) {
      applied[field] = clientValue;
      continue;
    }
    const serverValue = input.currentValues[field];
    if (sameFieldValue(serverValue, clientValue)) continue; // même valeur des deux côtés : rien à trancher
    const clientWins =
      input.clientOccurredAt.getTime() > new Date(serverWrite.occurredAt).getTime();
    if (clientWins) applied[field] = clientValue;
    collisions.push({ field, clientValue, serverValue, winner: clientWins ? 'CLIENT' : 'SERVER' });
  }
  return { applied, collisions };
}
