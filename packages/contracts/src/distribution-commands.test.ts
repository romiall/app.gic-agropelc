import { describe, expect, it } from 'vitest';
import {
  allocationGrantPayloadSchema,
  allocationIncreasePayloadSchema,
  allocationReleasePayloadSchema,
  allocationRevokePayloadSchema,
  cashSessionClosePayloadSchema,
  cashSessionForceClosePayloadSchema,
  cashSessionOpenPayloadSchema,
  cashSessionValidatePayloadSchema,
  cashTransferCancelPayloadSchema,
  cashTransferReceivePayloadSchema,
  cashTransferSendPayloadSchema,
} from './distribution-commands.js';

const A = '0198c3a0-1111-7aaa-8bbb-000000000001';
const B = '0198c3a0-2222-7aaa-8bbb-000000000002';
const C = '0198c3a0-3333-7aaa-8bbb-000000000003';
const D = '0198c3a0-4444-7aaa-8bbb-000000000004';

describe('sessions de caisse', () => {
  it('ouverture : compte, fonds compté entier ≥ 0', () => {
    expect(
      cashSessionOpenPayloadSchema.safeParse({ cashAccountId: A, countedXaf: 20_000 }).success,
    ).toBe(true);
    expect(
      cashSessionOpenPayloadSchema.safeParse({ cashAccountId: A, countedXaf: 0 }).success,
    ).toBe(true);
    for (const countedXaf of [-1, 10.5, Number.NaN, '20000']) {
      expect(cashSessionOpenPayloadSchema.safeParse({ cashAccountId: A, countedXaf }).success).toBe(
        false,
      );
    }
    expect(
      cashSessionOpenPayloadSchema.safeParse({ cashAccountId: 'pas-un-uuid', countedXaf: 1 })
        .success,
    ).toBe(false);
  });

  it('clôture : ne porte que le montant compté — l’écart n’est jamais fourni par l’appareil', () => {
    const parsed = cashSessionClosePayloadSchema.parse({ countedXaf: 193_000, varianceXaf: -500 });
    expect(parsed).toEqual({ countedXaf: 193_000 });
    expect(cashSessionClosePayloadSchema.safeParse({}).success).toBe(false);
  });

  it('clôture forcée : motif obligatoire', () => {
    expect(cashSessionForceClosePayloadSchema.safeParse({ countedXaf: 5 }).success).toBe(false);
    expect(
      cashSessionForceClosePayloadSchema.safeParse({ countedXaf: 5, reason: '  ' }).success,
    ).toBe(false);
    expect(
      cashSessionForceClosePayloadSchema.safeParse({ countedXaf: 5, reason: 'Oubli de clôture' })
        .success,
    ).toBe(true);
  });

  it('validation : motif facultatif (exigé par le serveur quand un écart existe)', () => {
    expect(cashSessionValidatePayloadSchema.safeParse({}).success).toBe(true);
    expect(cashSessionValidatePayloadSchema.safeParse({ reason: 'Fonds initial' }).success).toBe(
      true,
    );
  });
});

describe('remises de fonds', () => {
  const valid = { fromAccountId: A, toAccountId: B, amountXaf: 173_000 };

  it('envoi : montant strictement positif, comptes distincts', () => {
    expect(cashTransferSendPayloadSchema.safeParse(valid).success).toBe(true);
    expect(cashTransferSendPayloadSchema.safeParse({ ...valid, amountXaf: 0 }).success).toBe(false);
    expect(cashTransferSendPayloadSchema.safeParse({ ...valid, toAccountId: A }).success).toBe(
      false,
    );
  });

  it('porteur : utilisateur connu ou nom libre', () => {
    expect(cashTransferSendPayloadSchema.safeParse({ ...valid, carrierUserId: C }).success).toBe(
      true,
    );
    expect(
      cashTransferSendPayloadSchema.safeParse({ ...valid, carrierName: 'Moto-taxi Paul' }).success,
    ).toBe(true);
    expect(cashTransferSendPayloadSchema.safeParse({ ...valid, carrierUserId: 'x' }).success).toBe(
      false,
    );
  });

  it('réception : montant reçu entier ≥ 0 (un zéro est un constat, pas une erreur)', () => {
    expect(cashTransferReceivePayloadSchema.safeParse({ receivedXaf: 170_000 }).success).toBe(true);
    expect(cashTransferReceivePayloadSchema.safeParse({ receivedXaf: 0 }).success).toBe(true);
    expect(cashTransferReceivePayloadSchema.safeParse({ receivedXaf: -1 }).success).toBe(false);
  });

  it('annulation : motif obligatoire', () => {
    expect(cashTransferCancelPayloadSchema.safeParse({}).success).toBe(false);
    expect(cashTransferCancelPayloadSchema.safeParse({ reason: 'Erreur de montant' }).success).toBe(
      true,
    );
  });
});

describe('quotas d’appareil', () => {
  const grant = {
    holderUserId: A,
    holderDeviceId: B,
    locationId: C,
    productId: D,
    quantityBase: 40,
  };

  it('octroi : couple, emplacement, produit et quantité strictement positive à trois décimales au plus', () => {
    expect(allocationGrantPayloadSchema.safeParse(grant).success).toBe(true);
    expect(allocationGrantPayloadSchema.safeParse({ ...grant, quantityBase: 0.001 }).success).toBe(
      true,
    );
    for (const quantityBase of [0, -1, 1.2345, Number.POSITIVE_INFINITY, 100_000_000_000]) {
      expect(allocationGrantPayloadSchema.safeParse({ ...grant, quantityBase }).success).toBe(
        false,
      );
    }
  });

  it('validité : une date, ou une durée, pas les deux ; à défaut, fin du jour métier', () => {
    expect(
      allocationGrantPayloadSchema.safeParse({ ...grant, validUntil: '2026-10-08T23:00:00.000Z' })
        .success,
    ).toBe(true);
    expect(allocationGrantPayloadSchema.safeParse({ ...grant, validityHours: 8 }).success).toBe(
      true,
    );
    expect(
      allocationGrantPayloadSchema.safeParse({
        ...grant,
        validUntil: '2026-10-08T23:00:00.000Z',
        validityHours: 8,
      }).success,
    ).toBe(false);
    expect(allocationGrantPayloadSchema.safeParse({ ...grant, validUntil: 'demain' }).success).toBe(
      false,
    );
    expect(allocationGrantPayloadSchema.safeParse({ ...grant, validityHours: 0 }).success).toBe(
      false,
    );
    expect(
      allocationGrantPayloadSchema.safeParse({ ...grant, validityHours: 24 * 31 + 1 }).success,
    ).toBe(false);
  });

  it('lot facultatif et indicatif', () => {
    expect(allocationGrantPayloadSchema.safeParse({ ...grant, lotId: A }).success).toBe(true);
  });

  it('augmentation, révocation et libération', () => {
    expect(allocationIncreasePayloadSchema.safeParse({ quantityBase: 5 }).success).toBe(true);
    expect(allocationIncreasePayloadSchema.safeParse({ quantityBase: 0 }).success).toBe(false);
    expect(allocationRevokePayloadSchema.safeParse({ reason: 'Appareil perdu' }).success).toBe(
      true,
    );
    expect(allocationRevokePayloadSchema.safeParse({}).success).toBe(false);
    // La libération déclare le reste : zéro est un reste valide.
    expect(allocationReleasePayloadSchema.safeParse({ remainingBase: 0 }).success).toBe(true);
    expect(allocationReleasePayloadSchema.safeParse({ remainingBase: 8.5 }).success).toBe(true);
    expect(allocationReleasePayloadSchema.safeParse({ remainingBase: -1 }).success).toBe(false);
    expect(allocationReleasePayloadSchema.safeParse({ remainingBase: 1.0001 }).success).toBe(false);
  });
});
