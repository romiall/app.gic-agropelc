/**
 * Profil commercial du client (PP-D ; AV-316) : lecture du profil enregistré, contrôle de la saisie, commande
 * limitée à ce qui a changé, et modifications de l'appareil montrées aussitôt.
 */
import { describe, expect, it } from 'vitest';
import type { OutboxCommand } from '../../storage/db.js';
import type { CustomerData } from '../sales/types.js';
import {
  checkProfile,
  parseProfileQty,
  pendingProfileEdits,
  profileOf,
  profilePatch,
  withPendingProfile,
  type ProfileDraft,
} from './profile.js';

const CUSTOMER_ID = '01900000-0000-7000-8000-0000000000e1';
const PRODUCT_ID = '01900000-0000-7000-8000-0000000000e2';

function customer(overrides: Partial<CustomerData> = {}): CustomerData {
  return {
    id: CUSTOMER_ID,
    stage: 'PROSPECT',
    display_name: 'Alimentation Essos',
    contact_name: null,
    category_id: null,
    phone_primary: '+237677000001',
    address_text: null,
    zone_id: 'zone',
    owner_user_id: null,
    home_site_id: null,
    merged_into_id: null,
    credit_allowed: false,
    credit_limit_xaf: null,
    payment_terms_days: null,
    outstanding_xaf: 0,
    version: 3,
    ...overrides,
  };
}

function update(
  seq: number,
  patch: Record<string, unknown>,
  overrides: Partial<OutboxCommand> = {},
): OutboxCommand {
  return {
    command_id: `cmd-${seq}`,
    device_seq: seq,
    command_type: 'crm.customer.update',
    command_version: 1,
    author_user_id: 'user',
    aggregate_type: 'CUSTOMER',
    aggregate_id: CUSTOMER_ID,
    base_version: 3,
    depends_on: [],
    occurred_at: '2026-11-04T09:00:00.000Z',
    client_created_at: '2026-11-04T09:00:00.000Z',
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    payload: { patch },
    status: 'LOCAL_ONLY',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
    ...overrides,
  };
}

describe('profileOf', () => {
  it('un compte sans profil donne un brouillon vide, sans demande de crédit', () => {
    expect(profileOf(customer())).toEqual({
      interestProductId: '',
      potentialQtyText: '',
      potentialUnitCode: '',
      usualPaymentMethodCode: '',
      creditRequested: false,
    });
  });

  it('un profil enregistré se lit avec la virgule décimale française', () => {
    expect(
      profileOf(
        customer({
          interest_product_id: PRODUCT_ID,
          potential_qty_per_day: 12.5,
          potential_unit_code: 'PLATEAU',
          usual_payment_method_code: 'MOBILE_MONEY_MTN',
          credit_requested: true,
        }),
      ),
    ).toEqual({
      interestProductId: PRODUCT_ID,
      potentialQtyText: '12,5',
      potentialUnitCode: 'PLATEAU',
      usualPaymentMethodCode: 'MOBILE_MONEY_MTN',
      creditRequested: true,
    });
  });
});

describe('contrôle de la saisie', () => {
  it('quantité : vide = aucun potentiel, virgule ou point, trois décimales au plus', () => {
    expect(parseProfileQty('')).toBeNull();
    expect(parseProfileQty('  ')).toBeNull();
    expect(parseProfileQty('12,5')).toBe(12.5);
    expect(parseProfileQty('0.125')).toBe(0.125);
    expect(parseProfileQty('1 000')).toBe(1000);
    for (const bad of ['-1', '1,2345', 'abc', '1e3', '100000000000']) {
      expect(parseProfileQty(bad), bad).toBeUndefined();
    }
  });

  it('un potentiel exige son unité ; sans potentiel, l’unité seule est acceptée', () => {
    const base: ProfileDraft = profileOf(customer());
    expect(checkProfile({ ...base, potentialQtyText: '5' })).toEqual(['UNIT_REQUIRED']);
    expect(checkProfile({ ...base, potentialQtyText: '5', potentialUnitCode: 'KG' })).toEqual([]);
    expect(checkProfile({ ...base, potentialQtyText: 'x', potentialUnitCode: 'KG' })).toEqual([
      'QTY_INVALID',
    ]);
    expect(checkProfile({ ...base, potentialUnitCode: 'KG' })).toEqual([]);
  });
});

describe('profilePatch', () => {
  const before = profileOf(
    customer({
      interest_product_id: PRODUCT_ID,
      potential_qty_per_day: 10,
      potential_unit_code: 'KG',
      usual_payment_method_code: 'ESPECES',
    }),
  );

  it('rien n’a changé : aucune commande à envoyer', () => {
    expect(profilePatch(before, before)).toEqual({});
  });

  it('seul ce qui change part, un champ vidé part à null', () => {
    expect(
      profilePatch(
        { ...before, usualPaymentMethodCode: '', creditRequested: true, potentialQtyText: '12,5' },
        before,
      ),
    ).toEqual({ usualPaymentMethodCode: null, creditRequested: true, potentialQtyPerDay: 12.5 });
  });

  it('retirer le produit et le potentiel', () => {
    expect(
      profilePatch(
        { ...before, interestProductId: '', potentialQtyText: '', potentialUnitCode: '' },
        before,
      ),
    ).toEqual({ interestProductId: null, potentialQtyPerDay: null, potentialUnitCode: null });
  });
});

describe('modifications de l’appareil pas encore relues', () => {
  it('sont montrées aussitôt, dans l’ordre de l’appareil, sur le seul compte visé', () => {
    const other = customer({ id: 'autre', display_name: 'Autre' });
    const outbox = [
      update(2, { creditRequested: true }),
      update(1, {
        potentialQtyPerDay: 8,
        potentialUnitCode: 'KG',
        usualPaymentMethodCode: 'ESPECES',
      }),
      update(3, { potentialQtyPerDay: 9 }),
      // Une modification d'un autre champ du compte n'est pas du profil.
      update(4, { displayName: 'Autre nom' }),
    ];
    const [shown, untouched] = withPendingProfile([customer(), other], outbox, undefined);
    expect(shown).toMatchObject({
      potential_qty_per_day: 9,
      potential_unit_code: 'KG',
      usual_payment_method_code: 'ESPECES',
      credit_requested: true,
      display_name: 'Alimentation Essos',
    });
    expect(untouched).toBe(other);
  });

  it('une modification refusée par le serveur, ou déjà relue, ne compte plus', () => {
    const rejected = update(1, { creditRequested: true }, { status: 'REJECTED' });
    const synced = update(
      2,
      { usualPaymentMethodCode: 'ESPECES' },
      { status: 'SYNCED', synced_at: '2026-11-04T09:00:30.000Z' },
    );
    // Le jeu `customers` a été tiré après l'acceptation : le serveur sert déjà la valeur.
    expect(pendingProfileEdits([rejected, synced], '2026-11-04T09:05:00.000Z').size).toBe(0);
    // Tiré avant : la valeur n'est pas encore sur l'appareil, la modification reste montrée.
    expect(pendingProfileEdits([synced], '2026-11-04T09:00:00.000Z').size).toBe(1);
  });
});
