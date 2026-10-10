import { describe, expect, it } from 'vitest';
import {
  BLIND_RECEIPT_MAX_LINES,
  receivedQuantitySchema,
  transferBlindReceivePayloadSchema,
  transferReturnToSourcePayloadSchema,
} from './stock-transfer-commands.js';

const FROM = '01890a5d-ac96-774b-bcce-b302099a8057';
const TO = '01890a5d-ac96-774b-bcce-b302099a8058';
const P1 = '01890a5d-ac96-774b-bcce-b302099a8059';
const P2 = '01890a5d-ac96-774b-bcce-b302099a805a';

const line = (productId = P1, receivedQtyBase = 58) => ({
  productId,
  unitCode: 'PLATEAU',
  receivedQtyBase,
});

describe('inventory.transfer.receive sans document (BR-STK-024)', () => {
  it('réception minimale valide, lot indicatif et notes facultatifs', () => {
    expect(
      transferBlindReceivePayloadSchema.safeParse({
        fromLocationId: FROM,
        toLocationId: TO,
        lines: [line()],
      }).success,
    ).toBe(true);
    expect(
      transferBlindReceivePayloadSchema.safeParse({
        fromLocationId: FROM,
        toLocationId: TO,
        lines: [{ ...line(), lotId: P2 }, line(P2, 0.125)],
        notes: 'Livré par le camion de 7 h',
      }).success,
    ).toBe(true);
  });

  it('source = destination refusée', () => {
    const parsed = transferBlindReceivePayloadSchema.safeParse({
      fromLocationId: FROM,
      toLocationId: FROM,
      lines: [line()],
    });
    expect(parsed.success).toBe(false);
  });

  it('produit en double refusé', () => {
    expect(
      transferBlindReceivePayloadSchema.safeParse({
        fromLocationId: FROM,
        toLocationId: TO,
        lines: [line(), line()],
      }).success,
    ).toBe(false);
  });

  it('quantité nulle, négative, à quatre décimales ou au-delà de numeric(14,3) refusée', () => {
    for (const quantity of [0, -1, 1.0005, 100_000_000_000]) {
      expect(
        transferBlindReceivePayloadSchema.safeParse({
          fromLocationId: FROM,
          toLocationId: TO,
          lines: [line(P1, quantity)],
        }).success,
      ).toBe(false);
    }
  });

  it('transferId refusé (strict) : c’est la réception avec document', () => {
    expect(
      transferBlindReceivePayloadSchema.safeParse({
        transferId: FROM,
        fromLocationId: FROM,
        toLocationId: TO,
        lines: [line()],
      }).success,
    ).toBe(false);
    expect(
      transferBlindReceivePayloadSchema.safeParse({
        fromLocationId: FROM,
        toLocationId: TO,
        lines: [{ ...line(), unitCost: 10 }],
      }).success,
    ).toBe(false);
  });

  it('lignes vides ou au-delà du maximum refusées', () => {
    expect(
      transferBlindReceivePayloadSchema.safeParse({
        fromLocationId: FROM,
        toLocationId: TO,
        lines: [],
      }).success,
    ).toBe(false);
    const many = Array.from({ length: BLIND_RECEIPT_MAX_LINES + 1 }, (_, i) =>
      line(`01890a5d-ac96-774b-bcce-${String(i).padStart(12, '0')}`),
    );
    expect(
      transferBlindReceivePayloadSchema.safeParse({
        fromLocationId: FROM,
        toLocationId: TO,
        lines: many,
      }).success,
    ).toBe(false);
  });
});

describe('inventory.transfer.return_to_source (BR-STK-025)', () => {
  it('motif obligatoire, au plus 500 caractères, champ inconnu refusé', () => {
    expect(
      transferReturnToSourcePayloadSchema.safeParse({ transferId: FROM, reason: 'Camion en panne' })
        .success,
    ).toBe(true);
    expect(
      transferReturnToSourcePayloadSchema.safeParse({ transferId: FROM, reason: '   ' }).success,
    ).toBe(false);
    expect(transferReturnToSourcePayloadSchema.safeParse({ transferId: FROM }).success).toBe(false);
    expect(
      transferReturnToSourcePayloadSchema.safeParse({ transferId: FROM, reason: 'x'.repeat(501) })
        .success,
    ).toBe(false);
    expect(
      transferReturnToSourcePayloadSchema.safeParse({ transferId: FROM, reason: 'ok', lines: [] })
        .success,
    ).toBe(false);
  });
});

describe('quantité reçue d’une réception avec document', () => {
  it('zéro et décimales permis ; négatif, infini, quatre décimales et au-delà de numeric(14,3) refusés', () => {
    for (const quantity of [0, 8, 0.125, 99_999_999_999.999]) {
      expect(receivedQuantitySchema.safeParse(quantity).success, String(quantity)).toBe(true);
    }
    for (const quantity of [
      -1,
      1.0005,
      100_000_000_000,
      5e11,
      Number.POSITIVE_INFINITY,
      Number.NaN,
    ]) {
      expect(receivedQuantitySchema.safeParse(quantity).success, String(quantity)).toBe(false);
    }
  });
});
