/**
 * Profil commercial du client (PP-D ; REQ-308, AV-316) : logique pure. Le produit qui intéresse le client, la
 * quantité qu'il peut écouler par jour (avec son unité) et sa façon habituelle de payer sont trois champs du compte ;
 * la demande de paiement différé du commercial (`creditRequested`) est à part de la décision du responsable
 * (`credit_allowed`, AV-028). Ils se modifient par `crm.customer.update` comme les autres champs du compte : la
 * commande ne porte que ce qui a changé (fusion champ par champ d'un compte modifié sur deux appareils).
 */
import type { OutboxCommand } from '../../storage/db.js';
import { stillInFlight } from '../sales/pending.js';
import type { CustomerData } from '../sales/types.js';

/** Champs du profil dans une commande `crm.customer.update` (charge utile du serveur). */
export const PROFILE_FIELDS = [
  'interestProductId',
  'potentialQtyPerDay',
  'potentialUnitCode',
  'usualPaymentMethodCode',
  'creditRequested',
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** Le profil en cours de saisie : des textes, vides quand rien n'est renseigné. */
export interface ProfileDraft {
  readonly interestProductId: string;
  readonly potentialQtyText: string;
  readonly potentialUnitCode: string;
  readonly usualPaymentMethodCode: string;
  readonly creditRequested: boolean;
}

/** Profil enregistré d'un compte, tel que l'écran le montre et le propose à la modification. */
export function profileOf(customer: CustomerData): ProfileDraft {
  const qty = customer.potential_qty_per_day;
  return {
    interestProductId: customer.interest_product_id ?? '',
    potentialQtyText: qty === null || qty === undefined ? '' : String(qty).replace('.', ','),
    potentialUnitCode: customer.potential_unit_code ?? '',
    usualPaymentMethodCode: customer.usual_payment_method_code ?? '',
    creditRequested: customer.credit_requested === true,
  };
}

/**
 * Quantité par jour saisie : décimale positive ou nulle, trois décimales au plus (virgule ou point). Vide : `null`
 * (aucun potentiel). Invalide : `undefined`.
 */
export function parseProfileQty(text: string): number | null | undefined {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (normalized === '') return null;
  if (!/^\d+(\.\d{1,3})?$/.test(normalized)) return undefined;
  const value = Number(normalized);
  return value <= 99_999_999_999 ? value : undefined;
}

export type ProfileIssue = 'QTY_INVALID' | 'UNIT_REQUIRED';

export function checkProfile(draft: ProfileDraft): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const qty = parseProfileQty(draft.potentialQtyText);
  if (qty === undefined) issues.push('QTY_INVALID');
  else if (qty !== null && draft.potentialUnitCode === '') issues.push('UNIT_REQUIRED');
  return issues;
}

/** Ce qui a changé par rapport au profil enregistré, au format de la commande ; vide si rien n'a changé. */
export function profilePatch(draft: ProfileDraft, before: ProfileDraft): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (draft.interestProductId !== before.interestProductId) {
    patch['interestProductId'] = draft.interestProductId === '' ? null : draft.interestProductId;
  }
  if (draft.potentialQtyText.trim() !== before.potentialQtyText.trim()) {
    patch['potentialQtyPerDay'] = parseProfileQty(draft.potentialQtyText) ?? null;
  }
  if (draft.potentialUnitCode !== before.potentialUnitCode) {
    patch['potentialUnitCode'] = draft.potentialUnitCode === '' ? null : draft.potentialUnitCode;
  }
  if (draft.usualPaymentMethodCode !== before.usualPaymentMethodCode) {
    patch['usualPaymentMethodCode'] =
      draft.usualPaymentMethodCode === '' ? null : draft.usualPaymentMethodCode;
  }
  if (draft.creditRequested !== before.creditRequested) {
    patch['creditRequested'] = draft.creditRequested;
  }
  return patch;
}

/** Modifications de profil de l'appareil pas encore relues du serveur, par compte (commande `crm.customer.update`). */
export function pendingProfileEdits(
  outbox: readonly OutboxCommand[],
  pulledAt: string | undefined,
): ReadonlyMap<string, readonly Record<string, unknown>[]> {
  const byCustomer = new Map<string, Record<string, unknown>[]>();
  const edits = outbox
    .filter(
      (command) =>
        command.command_type === 'crm.customer.update' && stillInFlight(command, pulledAt),
    )
    .sort((a, b) => a.device_seq - b.device_seq);
  for (const command of edits) {
    const patch = (command.payload as { patch?: Record<string, unknown> }).patch;
    if (!patch || !PROFILE_FIELDS.some((field) => field in patch)) continue;
    const list = byCustomer.get(command.aggregate_id) ?? [];
    list.push(patch);
    byCustomer.set(command.aggregate_id, list);
  }
  return byCustomer;
}

/**
 * Comptes dont le profil montre aussitôt les modifications saisies sur l'appareil et pas encore relues : le
 * commercial qui vient de noter le potentiel d'un client le revoit tel quel, hors ligne comme en ligne.
 */
export function withPendingProfile(
  customers: readonly CustomerData[],
  outbox: readonly OutboxCommand[],
  pulledAt: string | undefined,
): CustomerData[] {
  const edits = pendingProfileEdits(outbox, pulledAt);
  if (edits.size === 0) return [...customers];
  return customers.map((customer) => {
    const patches = edits.get(customer.id);
    if (!patches) return customer;
    let next: CustomerData = customer;
    for (const patch of patches) {
      if ('interestProductId' in patch) {
        next = {
          ...next,
          interest_product_id: (patch['interestProductId'] as string | null) ?? null,
        };
      }
      if ('potentialQtyPerDay' in patch) {
        next = {
          ...next,
          potential_qty_per_day: (patch['potentialQtyPerDay'] as number | null) ?? null,
        };
      }
      if ('potentialUnitCode' in patch) {
        next = {
          ...next,
          potential_unit_code: (patch['potentialUnitCode'] as string | null) ?? null,
        };
      }
      if ('usualPaymentMethodCode' in patch) {
        next = {
          ...next,
          usual_payment_method_code: (patch['usualPaymentMethodCode'] as string | null) ?? null,
        };
      }
      if ('creditRequested' in patch) {
        next = { ...next, credit_requested: patch['creditRequested'] === true };
      }
    }
    return next;
  });
}
