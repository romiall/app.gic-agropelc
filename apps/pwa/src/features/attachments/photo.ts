import { ATTACHMENT_MAX_SIZE_BYTES } from '@gic/contracts';

/**
 * Photo jointe (MP-10 ; ADR-012 point 1, ADR-046) : recodée sur l'appareil en JPEG, côté long ramené à
 * 1 280 px, qualité 0,7 puis par paliers jusqu'à 400 Ko au plus ; empreinte SHA-256 (Web Crypto). Le
 * recodage retire les métadonnées EXIF de la photo d'origine (position, appareil). Le décodage et
 * l'encodage passent par un `PhotoCodec` (navigateur : `createImageBitmap` et canevas), remplaçable
 * dans les tests.
 */

/** Côté long d'une photo envoyée (ADR-012). */
export const PHOTO_MAX_SIDE_PX = 1280;
/** Taille visée d'une photo envoyée (ADR-012) ; le serveur en accepte jusqu'à 5 Mo. */
export const PHOTO_TARGET_BYTES = 400 * 1024;
/** Plafond du serveur (`attachments.attachment.register`, ADR-012). */
export const PHOTO_MAX_BYTES = ATTACHMENT_MAX_SIZE_BYTES;
/** Qualités JPEG essayées dans l'ordre, jusqu'à passer sous la taille visée. */
export const PHOTO_QUALITIES: readonly number[] = [0.7, 0.6, 0.5, 0.4];
/** Réductions successives du côté long si la plus basse qualité ne suffit pas. */
const DOWNSCALE_FACTOR = 0.8;
const MAX_DOWNSCALES = 4;
export const PHOTO_MIME_TYPE = 'image/jpeg';

export type PhotoErrorCode = 'UNSUPPORTED' | 'TOO_LARGE';

export class PhotoError extends Error {
  constructor(readonly code: PhotoErrorCode) {
    super(code);
  }
}

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly source: unknown;
  close?(): void;
}

export interface PhotoCodec {
  decode(file: Blob): Promise<DecodedImage>;
  encode(image: DecodedImage, width: number, height: number, quality: number): Promise<Blob>;
}

export interface PreparedPhoto {
  readonly bytes: ArrayBuffer;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** Instant de la prise ou du choix (ISO 8601). */
  readonly capturedAt: string;
}

/** Dimensions ramenées au côté long `maxSide`, proportions gardées (jamais agrandies). */
export function scaledSize(
  width: number,
  height: number,
  maxSide = PHOTO_MAX_SIDE_PX,
): { readonly width: number; readonly height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height };
  const ratio = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

async function bytesOf(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Response(blob).arrayBuffer();
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Recode une image choisie ou prise en JPEG, sous la taille visée si possible (qualité puis
 * dimensions) ; `UNSUPPORTED` si elle ne se décode pas (format inconnu, HEIC sur Android…),
 * `TOO_LARGE` si elle dépasse encore le plafond du serveur.
 */
export async function preparePhoto(
  file: Blob,
  codec: PhotoCodec,
  now: () => Date,
): Promise<PreparedPhoto> {
  const capturedAt = now().toISOString();
  let image: DecodedImage;
  try {
    image = await codec.decode(file);
  } catch {
    throw new PhotoError('UNSUPPORTED');
  }
  try {
    if (!(image.width > 0 && image.height > 0)) throw new PhotoError('UNSUPPORTED');
    let size = scaledSize(image.width, image.height);
    let best: Blob | undefined;
    // La plus petite version obtenue ; on s'arrête à la première sous la taille visée.
    search: for (let step = 0; step <= MAX_DOWNSCALES; step++) {
      for (const quality of PHOTO_QUALITIES) {
        const encoded = await codec.encode(image, size.width, size.height, quality);
        if (!best || encoded.size < best.size) best = encoded;
        if (encoded.size <= PHOTO_TARGET_BYTES) break search;
      }
      size = {
        width: Math.max(1, Math.round(size.width * DOWNSCALE_FACTOR)),
        height: Math.max(1, Math.round(size.height * DOWNSCALE_FACTOR)),
      };
    }
    if (!best || best.size > PHOTO_MAX_BYTES) throw new PhotoError('TOO_LARGE');
    const bytes = await bytesOf(best);
    return {
      bytes,
      mimeType: PHOTO_MIME_TYPE,
      sizeBytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      capturedAt,
    };
  } finally {
    image.close?.();
  }
}

/** Codec du navigateur : `createImageBitmap` (orientation EXIF appliquée), canevas JPEG. */
export const browserPhotoCodec: PhotoCodec = {
  async decode(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return {
      width: bitmap.width,
      height: bitmap.height,
      source: bitmap,
      close: () => bitmap.close(),
    };
  },
  async encode(image, width, height, quality) {
    const source = image.source as CanvasImageSource;
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new PhotoError('UNSUPPORTED');
      context.drawImage(source, 0, 0, width, height);
      return canvas.convertToBlob({ type: PHOTO_MIME_TYPE, quality });
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new PhotoError('UNSUPPORTED');
    context.drawImage(source, 0, 0, width, height);
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new PhotoError('UNSUPPORTED'))),
        PHOTO_MIME_TYPE,
        quality,
      ),
    );
  },
};
