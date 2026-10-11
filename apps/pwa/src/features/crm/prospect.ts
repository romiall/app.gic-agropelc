/**
 * Création d'un compte prospect (ECR-CRM-02, UC-CRM-01) : contrôles faits sur l'appareil avant
 * l'envoi de `crm.customer.create`, comme le serveur les fera. Logique pure.
 *
 * - Téléphone ou position GPS obligatoire pour retrouver le compte (BR-CRM-002).
 * - Téléphone normalisé au format E.164 (`normalizePhone`, indicatif par défaut du paramètre
 *   `crm.phone_default_country_code`, 237 à défaut : les paramètres semés ne sont pas servis, S-07).
 * - Doublon de téléphone principal (BR-CRM-006) cherché dans les comptes de l'appareil : en ligne le
 *   serveur refuse, hors ligne il crée le compte en le marquant doublon (fusion ensuite).
 * - Sources de prospect : liste du référentiel semé, que le serveur ne publie pas (besoin S-15).
 */
import { DomainError, normalizePhone } from '@gic/domain';
import type { CustomerData, ZoneData } from '../sales/types.js';

export const DEFAULT_COUNTRY_CODE = '237';

/** Codes semés (`crm_lead_sources`), hors `KOMMO` réservé à l'intégration. */
export const LEAD_SOURCES = [
  'PROSPECTION_TERRAIN',
  'VISITE_SPONTANEE',
  'RECOMMANDATION',
  'RESEAU_SOCIAL',
  'AUTRE',
] as const;

export const CUSTOMER_TYPES = ['PARTICULIER', 'ENTREPRISE'] as const;

/** Zone proposée pour un prospect : active (ZONE_INVALID sinon), libellée par son chemin. */
export interface ZoneOption {
  readonly id: string;
  readonly label: string;
}

/** Zones actives, libellées « ville › quartier » pour lever les homonymes, par libellé. */
/** Libellé « ville › quartier » d'une zone : son chemin depuis la racine (garde contre un cycle). */
export function zonePathLabel(zones: ReadonlyMap<string, ZoneData>, zone: ZoneData): string {
  const names = [zone.name];
  const seen = new Set([zone.id]);
  let parent = zone.parent_id ? zones.get(zone.parent_id) : undefined;
  while (parent && !seen.has(parent.id)) {
    names.unshift(parent.name);
    seen.add(parent.id);
    parent = parent.parent_id ? zones.get(parent.parent_id) : undefined;
  }
  return names.join(' › ');
}

export function prospectZoneOptions(zones: ReadonlyMap<string, ZoneData>): ZoneOption[] {
  const active = (zone: ZoneData) => zone.is_active !== false && zone.is_active !== 0;
  return [...zones.values()]
    .filter(active)
    .map((zone) => ({ id: zone.id, label: zonePathLabel(zones, zone) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
}

export interface Position {
  readonly lat: number;
  readonly lng: number;
  readonly accuracyM: number | null;
}

export interface ProspectDraft {
  readonly displayName: string;
  readonly phone: string;
  readonly position: Position | null;
  readonly zoneId: string;
  readonly sourceCode: string;
  readonly customerType: (typeof CUSTOMER_TYPES)[number];
  readonly contactName: string;
  readonly businessActivity: string;
  readonly addressText: string;
  readonly categoryId: string;
}

export type ProspectIssue =
  | 'NAME_REQUIRED'
  | 'PHONE_OR_POSITION_REQUIRED'
  | 'PHONE_INVALID'
  | 'ZONE_REQUIRED'
  | 'SOURCE_REQUIRED';

export interface ProspectCheck {
  readonly issues: readonly ProspectIssue[];
  readonly normalizedPhone: string | null;
  /** Compte de l'appareil qui a déjà ce téléphone principal. */
  readonly duplicateOf: CustomerData | null;
}

function normalized(raw: string, countryCode: string): string | null {
  try {
    return normalizePhone(raw, countryCode);
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}

export function checkProspect(
  draft: ProspectDraft,
  customers: readonly CustomerData[],
  countryCode: string,
): ProspectCheck {
  const issues: ProspectIssue[] = [];
  if (!draft.displayName.trim()) issues.push('NAME_REQUIRED');
  if (!draft.zoneId) issues.push('ZONE_REQUIRED');
  if (!draft.sourceCode) issues.push('SOURCE_REQUIRED');
  const phone = draft.phone.trim();
  let normalizedPhone: string | null = null;
  if (phone) {
    normalizedPhone = normalized(phone, countryCode);
    if (normalizedPhone === null) issues.push('PHONE_INVALID');
  } else if (draft.position === null) {
    issues.push('PHONE_OR_POSITION_REQUIRED');
  }
  const duplicateOf =
    normalizedPhone === null
      ? null
      : (customers.find(
          (customer) =>
            customer.merged_into_id === null &&
            customer.phone_primary !== null &&
            normalized(customer.phone_primary, countryCode) === normalizedPhone,
        ) ?? null);
  return { issues, normalizedPhone, duplicateOf };
}

const optionalText = (value: string): string | undefined => {
  const text = value.trim();
  return text ? text : undefined;
};

/** Charge utile de `crm.customer.create` (jamais de chaîne vide : champ omis). */
export function prospectPayload(draft: ProspectDraft, extra: { readonly homeSiteId?: string }) {
  const phone = optionalText(draft.phone);
  return {
    displayName: draft.displayName.trim(),
    customerType: draft.customerType,
    zoneId: draft.zoneId,
    sourceCode: draft.sourceCode,
    ...(phone ? { phonePrimary: phone } : { phonePrimary: null }),
    ...(draft.position ? { position: draft.position } : {}),
    ...(optionalText(draft.contactName) ? { contactName: draft.contactName.trim() } : {}),
    ...(optionalText(draft.businessActivity)
      ? { businessActivity: draft.businessActivity.trim() }
      : {}),
    ...(optionalText(draft.addressText) ? { addressText: draft.addressText.trim() } : {}),
    ...(draft.categoryId ? { categoryId: draft.categoryId } : {}),
    ...(extra.homeSiteId ? { homeSiteId: extra.homeSiteId } : {}),
  };
}
