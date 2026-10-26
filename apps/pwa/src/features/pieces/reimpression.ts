/**
 * Marqueur local de réimpression (AV-310) : la date de la première impression d'une pièce sur cet
 * appareil. Une impression suivante porte la mention « DUPLICATA ». Ni un autre appareil ni le
 * serveur n'en savent rien : c'est une commodité de l'appareil, jamais une preuve.
 */
const PREFIXE = 'gic.piece.imprimee.';

export function premiereImpression(cle: string): string | null {
  try {
    return globalThis.localStorage?.getItem(PREFIXE + cle) ?? null;
  } catch {
    return null;
  }
}

export function noterImpression(cle: string, quand: Date): void {
  try {
    if (globalThis.localStorage?.getItem(PREFIXE + cle)) return;
    globalThis.localStorage?.setItem(PREFIXE + cle, quand.toISOString());
  } catch {
    // Stockage indisponible (navigation privée) : pas de mention de réimpression.
  }
}
