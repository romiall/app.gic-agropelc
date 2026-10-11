/**
 * ECR-APP-01 « Fournisseurs » (responsable des achats ; en ligne ; CM §26, D08) : logique pure.
 *
 * - Liste lue sur `GET /suppliers` (tous statuts) ; création (`procurement.supplier.create`),
 *   modification (`.update`, champs changés seulement), désactivation et réactivation.
 * - Le code est unique (`uq_procurement_suppliers_code`) : un doublon n'est pas refusé proprement par
 *   le serveur mais renvoyé sans fin (S-30) ; il est contrôlé ici contre la liste lue.
 * - Une fiche ne s'efface pas champ par champ : la modification n'envoie que des valeurs non vides
 *   (le serveur ne sait pas remettre un champ à vide). Adresse et note ne sont pas servies par la
 *   lecture : laissées vides, elles ne changent pas.
 */

/** Fournisseur renvoyé par `GET /api/v1/suppliers`. */
export interface SupplierView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly suppliedCategories: readonly string[];
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly taxId: string | null;
  readonly paymentTermsDays: number | null;
  readonly status: string;
}

export interface SupplierForm {
  readonly code: string;
  readonly name: string;
  readonly suppliedCategories: readonly string[];
  readonly contactName: string;
  readonly phone: string;
  readonly email: string;
  readonly address: string;
  readonly taxId: string;
  readonly paymentTermsText: string;
  readonly notes: string;
}

export const EMPTY_SUPPLIER: SupplierForm = {
  code: '',
  name: '',
  suppliedCategories: [],
  contactName: '',
  phone: '',
  email: '',
  address: '',
  taxId: '',
  paymentTermsText: '',
  notes: '',
};

export const SUPPLIER_LIMITS = {
  code: 40,
  name: 200,
  contactName: 200,
  phone: 20,
  email: 200,
  address: 2000,
  taxId: 40,
  notes: 2000,
} as const;

export type SupplierIssue =
  'CODE_REQUIRED' | 'CODE_TAKEN' | 'NAME_REQUIRED' | 'EMAIL_INVALID' | 'TERMS_INVALID';

/** Adresse électronique au format attendu par le serveur (contrôle simple, sans espace). */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function checkSupplier(
  form: SupplierForm,
  options: { readonly creating: boolean; readonly takenCodes: ReadonlySet<string> },
): SupplierIssue[] {
  const issues: SupplierIssue[] = [];
  const code = form.code.trim();
  if (options.creating) {
    if (!code) issues.push('CODE_REQUIRED');
    else if (options.takenCodes.has(code)) issues.push('CODE_TAKEN');
  }
  if (!form.name.trim()) issues.push('NAME_REQUIRED');
  if (form.email.trim() && !EMAIL.test(form.email.trim())) issues.push('EMAIL_INVALID');
  if (form.paymentTermsText.trim() && !/^\d{1,5}$/.test(form.paymentTermsText.trim())) {
    issues.push('TERMS_INVALID');
  }
  return issues;
}

const text = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const terms = (value: string): number | undefined => {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : undefined;
};

export function createPayload(form: SupplierForm) {
  const optional = {
    contactName: text(form.contactName),
    phone: text(form.phone),
    email: text(form.email),
    address: text(form.address),
    taxId: text(form.taxId),
    paymentTermsDays: terms(form.paymentTermsText),
    notes: text(form.notes),
  };
  return {
    code: form.code.trim(),
    name: form.name.trim(),
    ...(form.suppliedCategories.length > 0
      ? { suppliedCategories: [...form.suppliedCategories] }
      : {}),
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
  };
}

/** Formulaire prérempli depuis la fiche lue (adresse et note non servies : vides). */
export function formOf(supplier: SupplierView): SupplierForm {
  return {
    code: supplier.code,
    name: supplier.name,
    suppliedCategories: [...supplier.suppliedCategories],
    contactName: supplier.contactName ?? '',
    phone: supplier.phone ?? '',
    email: supplier.email ?? '',
    address: '',
    taxId: supplier.taxId ?? '',
    paymentTermsText: supplier.paymentTermsDays === null ? '' : String(supplier.paymentTermsDays),
    notes: '',
  };
}

/** Charge utile de `procurement.supplier.update` : seulement les champs changés et non vides. */
export function updatePayload(supplier: SupplierView, form: SupplierForm) {
  const changed: Record<string, unknown> = {};
  const name = form.name.trim();
  if (name && name !== supplier.name) changed.name = name;
  const categories = [...form.suppliedCategories].sort();
  if (categories.join('|') !== [...supplier.suppliedCategories].sort().join('|')) {
    changed.suppliedCategories = categories;
  }
  const fields: readonly [string, string | undefined, string | null][] = [
    ['contactName', text(form.contactName), supplier.contactName],
    ['phone', text(form.phone), supplier.phone],
    ['email', text(form.email), supplier.email],
    ['taxId', text(form.taxId), supplier.taxId],
  ];
  for (const [key, value, previous] of fields) {
    if (value !== undefined && value !== previous) changed[key] = value;
  }
  const days = terms(form.paymentTermsText);
  if (days !== undefined && days !== supplier.paymentTermsDays) changed.paymentTermsDays = days;
  const address = text(form.address);
  if (address !== undefined) changed.address = address;
  const notes = text(form.notes);
  if (notes !== undefined) changed.notes = notes;
  return changed;
}
