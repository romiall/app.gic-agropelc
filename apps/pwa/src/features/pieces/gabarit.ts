/**
 * Briques des pièces papier GIC AGROPELC, remplies par l'application (lot PP, REQ-301, ADR-048).
 *
 * Portage fidèle de `pieces-papier/_generation/lib.mjs` : même balisage, mêmes classes, mêmes
 * dimensions, pour que `charte.css` (copie exacte de `pieces-papier/charte/pieces.css`) donne la même
 * mise en page que le gabarit. La seule différence est la valeur écrite dans chaque case (`v`) :
 * une case sans valeur reste la ligne vierge du papier, à compléter à la main. Chaque fonction
 * renvoie une chaîne HTML ; tout texte venu des données passe par `esc`.
 */
import { IDENTITE } from './identite.js';

/** Valeur d'une case : absente, la case reste vierge. */
export type Valeur = string | number | null | undefined;

export const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const present = (v: Valeur): v is string | number => v !== null && v !== undefined && v !== '';
const val = (v: string, cls = '') =>
  v ? `<span class="val">${esc(v)}</span>` : `<span class="blanc ${cls}"></span>`;

// ---- en-tête ------------------------------------------------------------
export function entete({
  numero = true,
  numLib = 'N°',
  n = null,
  logo,
}: {
  numero?: boolean;
  numLib?: string;
  n?: Valeur;
  logo: string;
}): string {
  const id = IDENTITE;
  const forme = id.forme_juridique ? `<div class="forme">${esc(id.forme_juridique)}</div>` : '';
  const nv = present(n) ? String(n) : '';
  // Un numéro officiel `VTE-SITE-2026-000123` est plus long que les six chiffres du carnet.
  const long = nv.length > 8 ? ' long' : '';
  return `<header class="entete">
  <img class="logo" src="${esc(logo)}" alt="GIC AGROPELC">
  <div class="identite">
    <div class="raison">${esc(id.raison_sociale)}</div>${forme}
    <div class="coord"><b>Siège</b>${val(id.siege, 'l')}<b>BP</b>${val(id.bp, 's')}<b>Tél</b>${val(id.telephones)}</div>
    <div class="coord"><b>RCCM / Autorisation</b>${val(id.rccm, 'l')}</div>
    <div class="coord"><b>NIU</b>${val(id.niu)}${id.regime_fiscal ? `<b>Régime</b>${esc(id.regime_fiscal)}` : ''}</div>
  </div>
  ${numero ? `<div class="numero"><span class="n-lib">${esc(numLib)}</span><span class="n-val${long}">${esc(nv)}</span></div>` : ''}
</header>`;
}

export const bandeau = (titre: string, sous = ''): string =>
  `<div class="bandeau"><h1>${esc(titre)}</h1>${sous ? `<span class="sous">${esc(sous)}</span>` : ''}</div>`;

// ---- champs -------------------------------------------------------------
export interface OptionsChamp {
  readonly aide?: string;
  readonly u?: string;
  readonly haut?: boolean;
  readonly double?: boolean;
  /** Valeur écrite sur la ligne ; l'aide (« …/…/20… ») disparaît quand la valeur est connue. */
  readonly v?: Valeur;
  /** Valeur numérique : alignée à droite, contre l'unité. */
  readonly num?: boolean;
}

export function champ(lib: string, span = 12, o: OptionsChamp = {}): string {
  const cls = ['champ', o.haut && 'haut', o.double && 'double'].filter(Boolean).join(' ');
  const v = present(o.v)
    ? `<span class="v${o.num ? ' num' : ''}">${esc(o.v)}</span>`
    : o.aide
      ? `<span class="aide">${esc(o.aide)}</span>`
      : '';
  return `<div class="${cls} c${span}"><span class="lib">${esc(lib)}</span>${v}${o.u ? `<span class="u">${esc(o.u)}</span>` : ''}</div>`;
}

export const rang = (...x: string[]): string => `<div class="rang">${x.join('')}</div>`;

export const dateHeure = (lib = 'Date et heure de l’opération', span = 10, v?: Valeur): string =>
  present(v)
    ? champ(lib, span, { v })
    : `<div class="champ c${span}"><span class="lib">${esc(lib)}</span><span class="aide">le …… / …… / 20…… à …… h ……</span></div>`;

/**
 * Cases à cocher. `coche` : libellés cochés (comparés au libellé de l'option) ; `autre` : texte écrit
 * à côté de l'option « autre : » (`…`).
 */
export function cases(
  lib: string,
  options: readonly string[],
  o: { carre?: boolean; span?: number; coche?: readonly string[]; autre?: Valeur } = {},
): string {
  const coche = new Set(o.coche ?? []);
  const opts = options
    .map((t) => {
      if (t === '…') {
        const fait = present(o.autre);
        return `<span class="o autre${fait ? ' coche' : ''}">autre :${fait ? `<span class="vo">${esc(o.autre)}</span>` : ''}</span>`;
      }
      return `<span class="o${coche.has(t) ? ' coche' : ''}">${esc(t)}</span>`;
    })
    .join('');
  return `<div class="cases ${o.carre ? 'carre' : ''} ${o.span ? `c${o.span}` : ''}">${lib ? `<span class="lib">${esc(lib)}</span>` : ''}${opts}</div>`;
}

export interface Colonne {
  readonly t: string;
  readonly w?: string;
  /** Alignement de la valeur : `r` à droite (montants, quantités), `c` centré. */
  readonly al?: 'l' | 'c' | 'r';
  readonly u?: string;
  readonly g?: boolean;
}

export interface Total {
  readonly lib: string;
  readonly span?: number;
  readonly u?: string;
  /** Valeurs des cellules qui suivent le libellé, dans l'ordre. */
  readonly v?: readonly Valeur[];
}

/**
 * Tableau de lignes. `n` lignes sont toujours dessinées, comme sur le papier ; `rows` en remplit les
 * premières (une valeur par colonne, sans la colonne N°).
 */
export function lignes({
  cols,
  n = 6,
  h = 7,
  numerote = true,
  total = null,
  entete2 = null,
  prefill = null,
  rows = [],
  premierNumero = 1,
}: {
  cols: readonly Colonne[];
  n?: number;
  h?: number;
  numerote?: boolean;
  total?: Total | readonly Total[] | null;
  entete2?: readonly string[] | null;
  prefill?: readonly string[] | null;
  rows?: readonly (readonly Valeur[])[];
  premierNumero?: number;
}): string {
  const all: (Colonne & { n?: boolean })[] = numerote
    ? [{ t: 'N°', w: '7mm', n: true }, ...cols]
    : [...cols];
  const colgroup = all
    .map((c) => `<col style="${c.w && c.w !== '*' ? `width:${c.w}` : ''}">`)
    .join('');
  const th = all.map((c) => `<th>${esc(c.t)}</th>`).join('');
  const th2 = entete2
    ? `<tr>${all.map((_, i) => `<th class="s2">${esc(entete2[i] ?? '')}</th>`).join('')}</tr>`
    : '';
  const decal = numerote ? 1 : 0;
  const corps = Array.from({ length: n }, (_, i) => {
    const row = rows[i];
    return `<tr>${all
      .map((c, k) => {
        if (c.n) return `<td class="n">${premierNumero + i}</td>`;
        if (prefill && k === decal) return `<td class="pre">${prefill[i] ?? ''}</td>`;
        const v = row?.[k - decal];
        if (present(v)) {
          // Texte : deux lignes au plus dans la hauteur de la ligne, jamais une ligne qui grandit.
          const t = (c.al ?? 'l') === 'l' ? `<span class="t2">${esc(v)}</span>` : esc(v);
          return `<td class="val ${c.al ?? 'l'}${c.g ? ' grise' : ''}">${t}</td>`;
        }
        return `<td class="${c.u ? 'u' : ''} ${c.g ? 'grise' : ''}">${c.u ? esc(c.u) : ''}</td>`;
      })
      .join('')}</tr>`;
  }).join('');
  let tot = '';
  const totaux = total ? (Array.isArray(total) ? total : [total]) : [];
  for (const tt of totaux as Total[]) {
    const spanLib = tt.span ?? all.length - 1;
    const cells = all
      .slice(spanLib)
      .map((_, i) => {
        const v = tt.v?.[i];
        if (present(v)) return `<td class="val r">${esc(v)}</td>`;
        return i === 0 ? `<td class="u">${tt.u ?? ''}</td>` : '<td></td>';
      })
      .join('');
    tot += `<tr class="total"><td class="lib" colspan="${spanLib}">${esc(tt.lib)}</td>${cells}</tr>`;
  }
  return `<table class="lignes" style="--hl:${h}mm"><colgroup>${colgroup}</colgroup><thead><tr>${th}</tr>${th2}</thead><tbody>${corps}${tot}</tbody></table>`;
}

export const montant = (lib = 'Montant', span = 10, v?: Valeur): string =>
  `<div class="montant c${span}"><span class="lib">${esc(lib)}</span><span class="zone">${present(v) ? esc(v) : ''}</span><span class="dev">XAF</span></div>`;

export const lettres = (
  lib = 'Arrêté à la somme de (en lettres)',
  span = 24,
  lines = 2,
  v?: Valeur,
): string => {
  const ecrit = present(v) ? `<span class="v">${esc(v)}</span>` : '';
  return `<div class="lettres c${span}" style="height:calc(var(--h) * ${lines === 1 ? 1.5 : 2.3})"><span class="lib">${esc(lib)}</span><div class="reglet">${ecrit}</div>${lines === 1 ? '' : '<div class="reglet"></div>'}</div>`;
};

export interface Signature {
  readonly t: string;
  readonly s?: string;
  readonly cachet?: boolean;
  readonly nom?: false;
  /** Nom écrit après « Nom : ». */
  readonly v?: Valeur;
}

export function signatures(
  items: readonly (string | Signature)[],
  { h = 15, cols }: { h?: number; cols?: number } = {},
): string {
  const n = cols ?? items.length;
  const html = items
    .map((it) => {
      const o: Signature = typeof it === 'string' ? { t: it } : it;
      const nom =
        o.nom === false
          ? ''
          : `<span class="nom">Nom : ${present(o.v) ? `<span class="v">${esc(o.v)}</span>` : ''}</span>`;
      return `<div class="sign ${o.cachet ? 'cachet' : ''}" style="height:${h}mm"><span class="t">${esc(o.t)}</span>${o.s ? `<span class="s">${esc(o.s)}</span>` : ''}<span class="zone"></span>${nom}</div>`;
    })
    .join('');
  return `<div class="signatures" style="grid-template-columns:repeat(${n},1fr)">${html}</div>`;
}

export const bloc = (titre: string, contenu: string, cls = ''): string =>
  `<div class="bloc ${cls}"><span class="t">${esc(titre)}</span>${contenu}</div>`;
export const section = (t: string): string => `<div class="titre-section">${esc(t)}</div>`;
/** Note : `t` est du HTML de confiance (texte fixe du gabarit), jamais une donnée. */
export const note = (t: string): string => `<div class="note">${t}</div>`;

/** Cartouche « Report dans l'application » : rempli avec la saisie de l'opération quand elle est connue. */
export function report({
  saisiPar = true,
  extra = '',
  saisiLe,
  par,
  numero,
}: {
  saisiPar?: boolean;
  extra?: string;
  saisiLe?: Valeur;
  par?: Valeur;
  numero?: Valeur;
} = {}): string {
  const f = (v: Valeur, vide: string) => (present(v) ? `<span class="v">${esc(v)}</span>` : vide);
  return `<div class="report"><span class="t">Report dans<br>l’application</span>
  <span class="f">Saisi le ${f(saisiLe, '<i class="s"></i>/<i class="s"></i>/20<i class="s"></i> à <i class="s"></i>h<i class="s"></i>')}</span>
  ${saisiPar ? `<span class="f">par ${f(par, '<i class="l"></i>')}</span>` : ''}
  <span class="f">N° opération ${f(numero, '<i class="l"></i>')}</span>${extra}
  <span class="f o">photo jointe</span></div>`;
}

// ---- pied ---------------------------------------------------------------
export function pied({
  ex = '',
  mention = 'Pièce numérotée : ne pas détacher sans l’annuler — conserver tous les exemplaires',
  code,
  v = '1.0',
  annule = true,
  annulee = false,
  page = null,
}: {
  ex?: string;
  mention?: string;
  code: string;
  v?: string;
  annule?: boolean;
  annulee?: boolean;
  page?: string | null;
}): string {
  const coche = annule
    ? `<span class="annule${annulee ? ' coche' : ''}">PIÈCE ANNULÉE</span><br>`
    : '';
  const pg = page ? `<span class="page">${esc(page)}</span>` : '';
  return `<footer class="pied"><div class="ex">${ex ? `<b>Exemplaires :</b> ${ex}<br>` : ''}${esc(mention)}</div><div class="ref">${coche}${pg}Modèle GIC-${esc(code)} · v${v} · 10/2026</div></footer>`;
}

// ---- feuille ------------------------------------------------------------
export type Format = 'a4p' | 'a4l' | 'a5p' | 'a5l' | 'a6l' | 't3a4';

/** Dimensions en mm (largeur, hauteur), celles de `build.mjs`. */
export const DIMENSIONS: Readonly<Record<Format, readonly [number, number]>> = {
  a4p: [210, 297],
  a4l: [297, 210],
  a5p: [148, 210],
  a5l: [210, 148],
  a6l: [148, 105],
  t3a4: [210, 99],
};

export interface Marges {
  readonly mh?: number;
  readonly md?: number;
  readonly mb?: number;
  readonly mg?: number;
}

/** Mentions apposées sur chaque feuille d'une pièce imprimée par l'application. */
export interface Tampons {
  /** Réimpression : date de la réimpression (AV-310). */
  readonly duplicata?: string | null;
  /** Opération annulée par contre-écriture (ADR-006). */
  readonly annulee?: boolean;
}

function tampons(t: Tampons): string {
  let html = '';
  if (t.annulee) html += '<div class="tampon annulee"><span>Annulée</span></div>';
  if (t.duplicata)
    html += `<div class="tampon"><span>Duplicata<small>réimprimé le ${esc(t.duplicata)}</small></span></div>`;
  return html;
}

export function feuille({
  fmt,
  marges = {},
  interieur,
  reperes = true,
  marques = {},
}: {
  fmt: Format;
  marges?: Marges;
  interieur: string;
  reperes?: boolean;
  marques?: Tampons;
}): string {
  const m = { mh: 8, md: 8, mb: 7, mg: 8, ...marges };
  const style = `--mh:${m.mh}mm;--md:${m.md}mm;--mb:${m.mb}mm;--mg:${m.mg}mm`;
  return `<section class="feuille ${fmt}" data-couleur="0"><div class="cadre" style="${style}">${interieur}</div>${reperes ? '<div class="reperes"><i></i><i></i><i></i><i></i></div>' : ''}${tampons(marques)}</section>`;
}

/** Ce que chaque pièce reçoit de l'application, en plus de ses données. */
export interface Contexte {
  /** URL du logo (pré-caché par le service worker, donc disponible hors ligne). */
  readonly logo: string;
  readonly marques?: Tampons;
}

/**
 * Corps standard : en-tête, bandeau, contenu, pied. Une pièce à souche du carnet s'imprime aussi
 * ainsi : la souche n'a de sens que dans le carnet (D1), le corps occupe la feuille. Les marges sont
 * celles du gabarit (`avecSouche` : 9 mm à gauche).
 */
export function standard({
  fmt,
  code,
  titre,
  sous = '',
  corps,
  ex = '',
  mention,
  marges,
  numero = true,
  numLib = 'N°',
  annule = true,
  h = null,
  n,
  page = null,
  ctx,
}: {
  fmt: Format;
  code: string;
  titre: string;
  sous?: string;
  corps: string;
  ex?: string;
  mention?: string;
  marges?: Marges;
  numero?: boolean;
  numLib?: string;
  annule?: boolean;
  h?: number | null;
  n?: Valeur;
  page?: string | null;
  ctx: Contexte;
}): string {
  const interieur = `${entete({ numero, numLib, n, logo: ctx.logo })}${bandeau(titre, sous)}<div class="corps"${h ? ` style="--h:${h}mm"` : ''}>${corps}</div>${pied(
    {
      ex,
      ...(mention ? { mention } : {}),
      code,
      annule,
      annulee: ctx.marques?.annulee ?? false,
      page,
    },
  )}`;
  return feuille({ fmt, ...(marges ? { marges } : {}), interieur, marques: ctx.marques ?? {} });
}

/**
 * Découpe des lignes en pages : `n` lignes par feuille, comme sur le papier. Une pièce sans ligne
 * donne une feuille (vierge de lignes).
 */
export function paginer<T>(items: readonly T[], n: number): T[][] {
  if (items.length === 0) return [[]];
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += n) pages.push(items.slice(i, i + n));
  return pages;
}

/** « page 1/2 » seulement quand la pièce tient sur plusieurs feuilles. */
export const numeroPage = (i: number, total: number): string | null =>
  total > 1 ? `page ${i + 1}/${total}` : null;
