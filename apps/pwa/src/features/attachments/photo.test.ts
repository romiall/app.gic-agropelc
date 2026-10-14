import { describe, expect, it, vi } from 'vitest';
import {
  PHOTO_MAX_BYTES,
  PHOTO_MAX_SIDE_PX,
  PHOTO_TARGET_BYTES,
  PhotoError,
  preparePhoto,
  scaledSize,
  sha256Hex,
  type PhotoCodec,
} from './photo.js';

const NOW = new Date('2026-10-14T09:00:00.000Z');

/** Codec simulé : la taille rendue dépend de la qualité et de la surface demandées. */
function codec(sizeOf: (width: number, height: number, quality: number) => number) {
  const close = vi.fn();
  const encode = vi.fn(async (_image: unknown, width: number, height: number, quality: number) => {
    const bytes = new Uint8Array(sizeOf(width, height, quality));
    bytes.set([0xff, 0xd8, 0xff]);
    return new Blob([bytes], { type: 'image/jpeg' });
  });
  const value: PhotoCodec = {
    decode: async () => ({ width: 4000, height: 3000, source: null, close }),
    encode,
  };
  return { value, encode, close };
}

describe('Photo jointe : recodage sur l’appareil (MP-10, ADR-012)', () => {
  it('côté long ramené à 1 280 px, proportions gardées, jamais agrandie', () => {
    expect(scaledSize(4000, 3000)).toEqual({ width: PHOTO_MAX_SIDE_PX, height: 960 });
    expect(scaledSize(3000, 4000)).toEqual({ width: 960, height: PHOTO_MAX_SIDE_PX });
    expect(scaledSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('première qualité suffisante : une seule version, à 1 280 px et 0,7 ; empreinte du résultat', async () => {
    const fake = codec(() => 300 * 1024);
    const photo = await preparePhoto(new Blob(['x']), fake.value, () => NOW);
    expect(fake.encode).toHaveBeenCalledTimes(1);
    expect(fake.encode).toHaveBeenCalledWith(expect.anything(), 1280, 960, 0.7);
    expect(photo).toMatchObject({
      mimeType: 'image/jpeg',
      sizeBytes: 300 * 1024,
      capturedAt: NOW.toISOString(),
    });
    expect(photo.sha256).toBe(await sha256Hex(photo.bytes));
    expect(photo.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.close).toHaveBeenCalled();
  });

  it('qualité baissée par paliers, puis dimensions réduites, jusqu’à la taille visée', async () => {
    // Trop lourde à 1 280 px quelle que soit la qualité ; passe une fois réduite.
    const fake = codec((width, _height, quality) =>
      width >= 1280 ? 600 * 1024 : quality >= 0.6 ? 500 * 1024 : 350 * 1024,
    );
    const photo = await preparePhoto(new Blob(['x']), fake.value, () => NOW);
    expect(fake.encode.mock.calls.map((call) => [call[1], call[3]])).toEqual([
      [1280, 0.7],
      [1280, 0.6],
      [1280, 0.5],
      [1280, 0.4],
      [1024, 0.7],
      [1024, 0.6],
      [1024, 0.5],
    ]);
    expect(photo.sizeBytes).toBe(350 * 1024);
    expect(photo.sizeBytes).toBeLessThanOrEqual(PHOTO_TARGET_BYTES);
  });

  it('jamais sous la taille visée : la plus petite version, si le serveur l’accepte ; sinon TOO_LARGE', async () => {
    const heavy = codec((width) => 450 * 1024 + width);
    const photo = await preparePhoto(new Blob(['x']), heavy.value, () => NOW);
    expect(photo.sizeBytes).toBeGreaterThan(PHOTO_TARGET_BYTES);
    expect(photo.sizeBytes).toBe(
      Math.min(...heavy.encode.mock.calls.map((call) => 450 * 1024 + call[1])),
    );

    const tooLarge = codec(() => PHOTO_MAX_BYTES + 1);
    await expect(preparePhoto(new Blob(['x']), tooLarge.value, () => NOW)).rejects.toMatchObject({
      code: 'TOO_LARGE',
    });
  });

  it('image illisible (format non pris en charge) : UNSUPPORTED', async () => {
    const unreadable: PhotoCodec = {
      decode: async () => {
        throw new Error('decode');
      },
      encode: async () => new Blob(),
    };
    const error = await preparePhoto(new Blob(['x']), unreadable, () => NOW).catch((e) => e);
    expect(error).toBeInstanceOf(PhotoError);
    expect(error.code).toBe('UNSUPPORTED');
  });
});
