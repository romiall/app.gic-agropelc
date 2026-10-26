/**
 * Document imprimable d'une pièce : feuille de style de la charte (copie exacte du papier), compléments
 * de l'application, polices libres embarquées et format de page `@page` de la pièce. Le document est
 * autonome (aucun appel réseau autre que les fichiers pré-cachés), donc imprimable hors ligne.
 */
import charte from './charte.css?raw';
import valeurs from './valeurs.css?raw';
import texte400 from '@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff2?url';
import texte600 from '@fontsource/noto-sans/files/noto-sans-latin-600-normal.woff2?url';
import texte700 from '@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff2?url';
import titre600 from '@fontsource/barlow-semi-condensed/files/barlow-semi-condensed-latin-600-normal.woff2?url';
import titre700 from '@fontsource/barlow-semi-condensed/files/barlow-semi-condensed-latin-700-normal.woff2?url';
import logo from './assets/logo-gic.png';
import { DIMENSIONS, esc } from './gabarit.js';
import type { PieceRendue } from './piece.js';

/** Logo de la charte (couleur), servi par le service worker. */
export const LOGO_PIECES: string = logo;

const police = (famille: string, poids: number, url: string) =>
  `@font-face{font-family:"${famille}";font-weight:${poids};font-style:normal;font-display:block;size-adjust:${famille === 'GIC Texte' ? '94%' : '100%'};src:url("${url}") format("woff2")}`;

const POLICES = [
  police('GIC Texte', 400, texte400),
  police('GIC Texte', 600, texte600),
  police('GIC Texte', 700, texte700),
  police('GIC Titre', 600, titre600),
  police('GIC Titre', 700, titre700),
].join('\n');

/** Document HTML complet d'une pièce. `base` : origine des fichiers (iframe `srcdoc`). */
export function documentPiece(piece: PieceRendue, base = ''): string {
  const [w, h] = DIMENSIONS[piece.fmt];
  const baseTag = base ? `<base href="${esc(base)}">` : '';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'">${baseTag}<title>${esc(piece.code)} — ${esc(piece.titre)}</title><style>${POLICES}\n${charte}\n${valeurs}\n@page{size:${w}mm ${h}mm;margin:0}</style></head><body data-pages="${piece.pages.length}">${piece.pages.join('\n')}</body></html>`;
}
