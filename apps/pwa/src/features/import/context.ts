/**
 * Ce que le contrôle d'un fichier sait de l'application (RP-2, PP-C ; AV-072, AV-508) : les référentiels de
 * l'appareil et les créations encore dans l'outbox, ramenés aux listes plates de `ImportRefs`. Une création en
 * attente occupe déjà son code, comme à l'écran de saisie correspondant (`pendingCatalogCodes`,
 * `pendingSupplierCodes`) : un second envoi du même code serait refusé par le serveur.
 */
import { DomainError, normalizePhone } from '@gic/domain';
import { pendingCatalogCodes } from '../catalog/catalog.js';
import { DEFAULT_COUNTRY_CODE, prospectZoneOptions } from '../crm/prospect.js';
import { FLAG_PAPER_REF, FLAG_PAPER_SLIP, FLAG_SLIP_TYPE } from '../pieces/report-commands.js';
import { pendingSupplierCodes } from '../procurement/suppliers.js';
import type { SalesReferences } from '../sales/references.js';
import { sellingLocations } from '../sales/sale-form.js';
import { settingValue } from '../sales/stock.js';
import type { ImportRefs } from './refs.js';

/** Rôles dont les comptes clients leur sont rattachés : aucun site de rattachement à nommer (BR-CRM-003). */
const COMMERCIAL_ROLES: readonly string[] = [
  'RESP_COMMERCIAL',
  'COMMERCIAL_TERRAIN',
  'COMMERCIAL_SEDENTAIRE',
];

export interface ImportContextInput {
  readonly references: SalesReferences;
  readonly userId: string;
  /** Rôles de l'utilisateur connus de l'appareil (vide : inconnus). */
  readonly roles: readonly string[];
  readonly now: Date;
}

const codeOf = (payload: unknown): string =>
  String((payload as { readonly code?: unknown }).code ?? '')
    .trim()
    .toUpperCase();

function phoneOf(payload: unknown, countryCode: string): string | null {
  const raw = (payload as { readonly phonePrimary?: unknown }).phonePrimary;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return normalizePhone(raw.trim(), countryCode);
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}

export function buildImportRefs({
  references,
  userId,
  roles,
  now,
}: ImportContextInput): ImportRefs {
  // Les créations refusées par le serveur n'occupent plus rien.
  const live = references.outbox.filter((command) => command.status !== 'REJECTED');

  const pendingCategoryIds = new Map<string, string>();
  for (const command of live) {
    if (command.command_type !== 'catalog.product_category.create') continue;
    const code = codeOf(command.payload);
    if (code !== '') pendingCategoryIds.set(code, command.aggregate_id);
  }

  const ownSite = (() => {
    const location = sellingLocations(references, userId)[0];
    return location?.site_id ? references.sites.get(location.site_id) : undefined;
  })();
  const phoneCountryCode = String(
    settingValue(references.settings, 'crm.phone_default_country_code', ownSite?.id, now) ??
      DEFAULT_COUNTRY_CODE,
  );

  const pendingCustomerPhones = new Set<string>();
  for (const command of live) {
    if (command.command_type !== 'crm.customer.create') continue;
    const phone = phoneOf(command.payload, phoneCountryCode);
    if (phone !== null) pendingCustomerPhones.add(phone);
  }

  // Un commercial est le titulaire des comptes qu'il charge ; sans rôle commercial, ils se rattachent à un site.
  const commercial = roles.some((role) => COMMERCIAL_ROLES.includes(role));
  const homeSiteRequired = !commercial;

  // Pièces papier déjà reportées depuis l'appareil (type et numéro portés par les indices locaux de la commande).
  const reportedSlips = new Set<string>();
  for (const command of live) {
    const flags = command.local_flags ?? [];
    if (!flags.includes(FLAG_PAPER_SLIP)) continue;
    const type = flags
      .find((flag) => flag.startsWith(FLAG_SLIP_TYPE))
      ?.slice(FLAG_SLIP_TYPE.length);
    const ref = flags.find((flag) => flag.startsWith(FLAG_PAPER_REF))?.slice(FLAG_PAPER_REF.length);
    if (type && ref) reportedSlips.add(`${type}|${ref}`);
  }

  return {
    authorUserId: userId,
    unitCodes: new Set(
      [...references.units.values()].filter((unit) => unit.is_active).map((unit) => unit.code),
    ),
    categories: references.productCategories
      .filter((category) => category.is_active !== false && category.is_active !== 0)
      .map(({ id, code, name }) => ({ id, code, name })),
    pendingCategoryIds,
    productCodes: new Set([
      ...references.products.map((product) => product.code),
      ...pendingCatalogCodes(references.outbox).products,
    ]),
    supplierCodes: new Set([
      ...[...references.suppliers.values()].map((supplier) => supplier.code),
      ...pendingSupplierCodes(references.outbox),
    ]),
    zones: prospectZoneOptions(references.zones),
    sites: [...references.sites.values()]
      .filter((site) => site.status === 'ACTIVE')
      .map(({ id, code, name }) => ({ id, code, name })),
    ...(homeSiteRequired && ownSite ? { defaultHomeSiteId: ownSite.id } : {}),
    homeSiteRequired,
    customerCategories: references.customerCategories.map(({ id, code, name }) => ({
      id,
      code,
      name,
    })),
    customers: references.customers,
    pendingCustomerPhones,
    phoneCountryCode,
    slipContext: { refs: references, userId, roles: roles.length > 0 ? roles : null, now },
    reportedSlips,
  };
}
