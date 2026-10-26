/**
 * Écriture des valeurs sur une pièce : montants en francs entiers sans devise (la colonne ou l'unité
 * dit « XAF »), dates et heures du fuseau métier `Africa/Douala` (ADR-016), comme on les écrirait
 * à la main sur le carnet.
 */
const ZONE = 'Africa/Douala';
const ENTIER = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const QUANTITE = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });
const espaces = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

/** « 50 000 » ; `null` : case vierge. */
export function xafPiece(montant: number | null | undefined): string | null {
  if (montant === null || montant === undefined || !Number.isFinite(montant)) return null;
  return espaces(ENTIER.format(Math.round(montant)));
}

/** « 1 250,5 ». */
export function quantitePiece(q: number | null | undefined): string | null {
  if (q === null || q === undefined || !Number.isFinite(q)) return null;
  return espaces(QUANTITE.format(q || 0));
}

function parties(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('fr-FR', {
    timeZone: ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { j: get('day'), m: get('month'), a: get('year'), h: get('hour'), mi: get('minute') };
}

/** « 26/10/2026 à 14 h 05 ». */
export function dateHeurePiece(iso: string | null | undefined): string | null {
  const p = iso ? parties(iso) : null;
  return p ? `${p.j}/${p.m}/${p.a} à ${p.h} h ${p.mi}` : null;
}

/** « 26/10/2026 ». */
export function datePiece(iso: string | null | undefined): string | null {
  const p = iso ? parties(iso) : null;
  return p ? `${p.j}/${p.m}/${p.a}` : null;
}

/** « 26/10/2026 » depuis un jour métier `AAAA-MM-JJ` (aucun décalage de fuseau). */
export function jourPiece(jour: string | null | undefined): string | null {
  const m = jour ? /^(\d{4})-(\d{2})-(\d{2})/.exec(jour) : null;
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/** « 14 h 05 ». */
export function heurePiece(iso: string | null | undefined): string | null {
  const p = iso ? parties(iso) : null;
  return p ? `${p.h} h ${p.mi}` : null;
}

/** Libellés des moyens de paiement imprimés sur les pièces (référentiel `finance.payment_methods`). */
export const MOYENS = [
  'Espèces',
  'Orange Money',
  'MTN Mobile Money',
  'Virement bancaire',
  'Chèque',
] as const;

const MOYEN_PAR_CODE: Readonly<Record<string, (typeof MOYENS)[number]>> = {
  ESPECES: 'Espèces',
  MOBILE_MONEY_ORANGE: 'Orange Money',
  MOBILE_MONEY_MTN: 'MTN Mobile Money',
  VIREMENT: 'Virement bancaire',
  CHEQUE: 'Chèque',
};

/** Libellé de la case d'un moyen de paiement (code du référentiel ou libellé), sinon `null`. */
export function moyenPiece(codeOuLibelle: string | null | undefined): string | null {
  if (!codeOuLibelle) return null;
  return (
    MOYEN_PAR_CODE[codeOuLibelle] ??
    MOYENS.find((m) => m.toLowerCase() === codeOuLibelle.toLowerCase()) ??
    null
  );
}

/** Lettre de la colonne « Mode E O M V C » de la feuille de caisse. */
export function lettreMoyen(codeOuLibelle: string | null | undefined): string | null {
  const m = moyenPiece(codeOuLibelle);
  if (!m) return null;
  const lettres: Readonly<Record<string, string>> = {
    Espèces: 'E',
    'Orange Money': 'O',
    'MTN Mobile Money': 'M',
    'Virement bancaire': 'V',
    Chèque: 'C',
  };
  return lettres[m] ?? null;
}
