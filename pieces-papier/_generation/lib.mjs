// Composants HTML des pièces papier GIC AGROPELC (voir charte/pieces.css).
// Chaque fonction renvoie une chaîne HTML. Les jetons {{N}} et {{LOGO}} sont remplacés au rendu
// (aperçu : numéro d'exemple et logo couleur ; impression : zone de numérotation vide, logo 2 encres).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ICI = dirname(fileURLToPath(import.meta.url))
export const RACINE = join(ICI, '..')
export const ID = JSON.parse(readFileSync(join(RACINE, 'charte', 'identite.json'), 'utf8'))

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const val = (v, cls = '') => (v ? `<span class="val">${esc(v)}</span>` : `<span class="blanc ${cls}"></span>`)

// ---- en-tête ----------------------------------------------------------
export function entete({ numero = true, numLib = 'N°' } = {}) {
  const forme = ID.forme_juridique ? `<div class="forme">${esc(ID.forme_juridique)}</div>` : ''
  return `<header class="entete">
  <img class="logo" src="{{LOGO}}" alt="GIC AGROPELC">
  <div class="identite">
    <div class="raison">${esc(ID.raison_sociale)}</div>${forme}
    <div class="coord"><b>Siège</b>${val(ID.siege, 'l')}<b>BP</b>${val(ID.bp, 's')}<b>Tél</b>${val(ID.telephones)}</div>
    <div class="coord"><b>RCCM / Autorisation</b>${val(ID.rccm, 'l')}</div>
    <div class="coord"><b>NIU</b>${val(ID.niu)}${ID.regime_fiscal ? `<b>Régime</b>${esc(ID.regime_fiscal)}` : ''}</div>
  </div>
  ${numero ? `<div class="numero"><span class="n-lib">${esc(numLib)}</span><span class="n-val">{{N}}</span></div>` : ''}
</header>`
}
export const bandeau = (titre, sous = '') => `<div class="bandeau"><h1>${esc(titre)}</h1>${sous ? `<span class="sous">${esc(sous)}</span>` : ''}</div>`

// ---- champs -----------------------------------------------------------
// champ('Client', 12) ; options : { aide:'jj/mm/aaaa', u:'XAF', haut:true, double:true }
export function champ(lib, span = 12, o = {}) {
  const cls = ['champ', o.haut && 'haut', o.double && 'double'].filter(Boolean).join(' ')
  return `<div class="${cls} c${span}"><span class="lib">${esc(lib)}</span>${o.aide ? `<span class="aide">${esc(o.aide)}</span>` : ''}${o.u ? `<span class="u">${esc(o.u)}</span>` : ''}</div>`
}
export const rang = (...x) => `<div class="rang">${x.join('')}</div>`
export const dateHeure = (lib = 'Date et heure de l’opération', span = 10) =>
  `<div class="champ c${span}"><span class="lib">${esc(lib)}</span><span class="aide">le …… / …… / 20…… à …… h ……</span></div>`

export function cases(lib, options, o = {}) {
  const opts = options.map((t) => (t === '…' ? `<span class="o autre">autre :</span>` : `<span class="o">${esc(t)}</span>`)).join('')
  return `<div class="cases ${o.carre ? 'carre' : ''} ${o.span ? 'c' + o.span : ''}">${lib ? `<span class="lib">${esc(lib)}</span>` : ''}${opts}</div>`
}

// lignes({ cols:[{t:'Désignation', w:'*', al:'l'|'c'|'r', u:'XAF'}], n:6, h:7, total:{lib:'TOTAL', cols:[idx...]} })
export function lignes({ cols, n = 6, h = 7, numerote = true, total = null, entete2 = null, prefill = null }) {
  const all = numerote ? [{ t: 'N°', w: '7mm', n: true }, ...cols] : cols
  const colgroup = all.map((c) => `<col style="${c.w && c.w !== '*' ? `width:${c.w}` : ''}">`).join('')
  const th = all.map((c) => `<th>${esc(c.t)}</th>`).join('')
  const th2 = entete2 ? `<tr>${all.map((c, i) => `<th class="s2">${esc(entete2[i] ?? '')}</th>`).join('')}</tr>` : ''
  const rows = Array.from({ length: n }, (_, i) =>
    `<tr>${all.map((c, k) => (c.n ? `<td class="n">${i + 1}</td>` : (prefill && k === (numerote ? 1 : 0)) ? `<td class="pre">${prefill[i] ?? ''}</td>` : `<td class="${c.u ? 'u' : ''} ${c.g ? 'grise' : ''}">${c.u ? esc(c.u) : ''}</td>`)).join('')}</tr>`
  ).join('')
  let tot = ''
  const totaux = total ? (Array.isArray(total) ? total : [total]) : []
  for (const tt of totaux) {
    const spanLib = tt.span ?? all.length - 1
    const cells = all.slice(spanLib).map((c, i) => (i === 0 ? `<td class="u">${tt.u ?? ''}</td>` : '<td></td>')).join('')
    tot += `<tr class="total"><td class="lib" colspan="${spanLib}">${esc(tt.lib)}</td>${cells}</tr>`
  }
  return `<table class="lignes" style="--hl:${h}mm"><colgroup>${colgroup}</colgroup><thead><tr>${th}</tr>${th2}</thead><tbody>${rows}${tot}</tbody></table>`
}

export const montant = (lib = 'Montant', span = 10) => `<div class="montant c${span}"><span class="lib">${esc(lib)}</span><span class="zone"></span><span class="dev">XAF</span></div>`
export const lettres = (lib = 'Arrêté à la somme de (en lettres)', span = 24, lines = 2) =>
  `<div class="lettres c${span}" style="height:calc(var(--h) * ${lines === 1 ? 1.5 : 2.3})"><span class="lib">${esc(lib)}</span><div class="reglet"></div>${lines === 1 ? '' : '<div class="reglet"></div>'}</div>`

export function signatures(items, { h = 15, cols } = {}) {
  const n = cols ?? items.length
  const html = items
    .map((it) => {
      const o = typeof it === 'string' ? { t: it } : it
      return `<div class="sign ${o.cachet ? 'cachet' : ''}" style="height:${h}mm"><span class="t">${esc(o.t)}</span>${o.s ? `<span class="s">${esc(o.s)}</span>` : ''}<span class="zone"></span>${o.nom === false ? '' : `<span class="nom">Nom : </span>`}</div>`
    })
    .join('')
  return `<div class="signatures" style="grid-template-columns:repeat(${n},1fr)">${html}</div>`
}

export const bloc = (titre, contenu, cls = '') => `<div class="bloc ${cls}"><span class="t">${esc(titre)}</span>${contenu}</div>`
export const section = (t) => `<div class="titre-section">${esc(t)}</div>`
export const note = (t) => `<div class="note">${t}</div>`
export const notes = (n, cls = 'ligne-note') => Array.from({ length: n }, () => `<div class="${cls}"></div>`).join('')
export const espace = (mm) => `<div style="height:${mm}mm"></div>`

export function report({ saisiPar = true, extra = '' } = {}) {
  return `<div class="report"><span class="t">Report dans<br>l’application</span>
  <span class="f">Saisi le <i class="s"></i>/<i class="s"></i>/20<i class="s"></i> à <i class="s"></i>h<i class="s"></i></span>
  ${saisiPar ? `<span class="f">par <i class="l"></i></span>` : ''}
  <span class="f">N° opération <i class="l"></i></span>${extra}
  <span class="f o">photo jointe</span></div>`
}

export function reportSouche({ numLib = 'N° opération', extra = 'photo jointe' } = {}) {
  return `<div class="report"><span class="t">Report dans l’application</span>
  <span class="f">saisi le <i></i></span><span class="f">par <i></i></span><span class="f">${esc(numLib)} <i></i></span><span class="f o">${esc(extra)}</span></div>`
}

// ---- pied -------------------------------------------------------------
export function pied({ ex = '', mention = 'Pièce numérotée : ne pas détacher sans l’annuler — conserver tous les exemplaires', code, v = '1.0', annule = true } = {}) {
  return `<footer class="pied"><div class="ex">${ex ? `<b>Exemplaires :</b> ${ex}<br>` : ''}${esc(mention)}</div><div class="ref">${annule ? '<span class="annule">PIÈCE ANNULÉE</span><br>' : ''}Modèle GIC-${esc(code)} · v${v} · 10/2026</div></footer>`
}

// ---- souche ------------------------------------------------------------
// souche({ titre:'Souche', champs:[['Date',..],...], cases:[...] })
export function souche({ champs = [], blocs = '' }) {
  const rows = champs.map(([lib, o]) => `<div class="champ">${`<span class="lib">${esc(lib)}</span>`}${o?.u ? `<span class="u">${esc(o.u)}</span>` : ''}</div>`).join('')
  return `<aside class="souche"><span class="perfo">✂</span>
  <div class="ent"><img src="{{LOGO}}" alt=""><div class="t">Souche</div></div>
  <div class="n"><small>N°</small>{{N}}</div>
  ${rows}${blocs}
  <div class="petit">Reste dans le carnet · détacher le corps le long du pointillé</div></aside>`
}

// ---- feuille ------------------------------------------------------------
// opts.fmt : a4p | a4l | a5p | a5l | a6l | t3a4 ; opts.marges : { mh, md, mb, mg } (mm)
export function feuille({ fmt, marges = {}, interieur, reperes = true, couleur = false, filigrane = '' }) {
  const m = { mh: 8, md: 8, mb: 7, mg: 8, ...marges }
  const style = `--mh:${m.mh}mm;--md:${m.md}mm;--mb:${m.mb}mm;--mg:${m.mg}mm`
  return `<section class="feuille ${fmt}" data-couleur="${couleur ? 1 : 0}"><div class="cadre${interieur.souche ? ' souche-gauche' : ''}" style="${style}">${interieur.html ?? interieur}</div>${reperes ? '<div class="reperes"><i></i><i></i><i></i><i></i></div>' : ''}${filigrane ? `<div class="filigrane"><span>${esc(filigrane)}</span></div>` : ''}</section>`
}

// corps standard (sans souche) : en-tête, bandeau, contenu, pied
export function standard({ fmt, code, titre, sous = '', corps, ex = '', mention, marges, numero = true, numLib = 'N°', annule = true, h = null, couleur = false }) {
  const interieur = `${entete({ numero, numLib })}${bandeau(titre, sous)}<div class="corps"${h ? ` style="--h:${h}mm"` : ''}>${corps}</div>${pied({ ex, mention, code, annule })}`
  return feuille({ fmt, marges, interieur, couleur })
}

// pièce à souche gauche (A5 paysage)
export function avecSouche({ fmt = 'a5l', code, titre, sous = '', corps, souchePart, ex = '', mention, marges = { mg: 9 }, annule = true, h = null }) {
  const droite = `<div class="corps-souche">${entete({ numero: true })}${bandeau(titre, sous)}<div class="corps"${h ? ` style="--h:${h}mm"` : ''}>${corps}</div>${pied({ ex, mention, code, annule })}</div>`
  return feuille({ fmt, marges, interieur: { souche: true, html: `${souchePart}${droite}` } })
}
