// Assemble DOSSIER-DE-VALIDATION.pdf (guide, cadre légal, cahier des charges, une page par pièce) et CAHIER-DES-CHARGES-IMPRIMEUR.pdf.
//   node pieces-papier/_generation/documents.mjs      (après build.mjs all : les aperçus PNG doivent exister)
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { PIECES } from './pieces.mjs'
import { RACINE, esc } from './lib.mjs'

const require = createRequire('C:/xampp/htdocs/app.gic-agropelc/apps/pwa/package.json')
let pw; try { pw = require('playwright') } catch { pw = require('@playwright/test') }

// ---- mini convertisseur Markdown (sous-ensemble utilisé par nos documents) ----
const inline = (t) => esc(t)
  .replace(/&lt;(https?:\/\/[^\s&]+?)&gt;/g, '<a href="$1">$1</a>')
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/(^|[\s(«])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
function md(src) {
  const L = src.replace(/\r/g, '').split('\n'); const out = []; let i = 0
  while (i < L.length) {
    const l = L[i]
    if (/^```/.test(l)) { const buf = []; i++; while (i < L.length && !/^```/.test(L[i])) buf.push(esc(L[i++])); i++; out.push(`<pre>${buf.join('\n')}</pre>`); continue }
    const h = l.match(/^(#{1,3}) (.*)/); if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue }
    if (/^\|/.test(l)) {
      const rows = []; while (i < L.length && /^\|/.test(L[i])) rows.push(L[i++])
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const head = cells(rows[0]); const body = rows.slice(2).map(cells)
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`); continue
    }
    if (/^> /.test(l)) { const buf = []; while (i < L.length && /^> /.test(L[i])) buf.push(L[i++].slice(2)); out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`); continue }
    if (/^\s*(- |\d+\. )/.test(l)) {
      const stack = []; const emit = []
      while (i < L.length && /^\s*(- |\d+\. )/.test(L[i])) {
        const m = L[i].match(/^(\s*)(- |\d+\. )(.*)/); const ind = m[1].length; const tag = m[2] === '- ' ? 'ul' : 'ol'
        while (stack.length && stack[stack.length - 1].ind > ind) emit.push(`</li></${stack.pop().tag}>`)
        if (!stack.length || stack[stack.length - 1].ind < ind) { stack.push({ ind, tag }); emit.push(`<${tag}><li>`) } else emit.push('</li><li>')
        emit.push(inline(m[3])); i++
      }
      while (stack.length) emit.push(`</li></${stack.pop().tag}>`)
      out.push(emit.join('')); continue
    }
    if (l.trim() === '') { i++; continue }
    const buf = []; while (i < L.length && L[i].trim() !== '' && !/^(#|\||> |\s*- |\s*\d+\. |```)/.test(L[i])) buf.push(L[i++])
    out.push(`<p>${inline(buf.join(' '))}</p>`)
  }
  return out.join('\n')
}

const CSS = `
@page { size: A4; margin: 14mm 13mm 16mm 13mm; }
* { box-sizing: border-box; } body { font: 9pt/1.4 "Segoe UI", Calibri, Arial, sans-serif; color: #15211b; -webkit-print-color-adjust: exact; }
h1 { font: 700 19pt/1.15 "Bahnschrift","Segoe UI",sans-serif; color: #3a6351; margin: 0 0 4mm; border-bottom: .8mm solid #c8780a; padding-bottom: 2mm; }
h2 { font: 700 12.5pt/1.2 "Bahnschrift","Segoe UI",sans-serif; color: #3a6351; margin: 6mm 0 2mm; break-after: avoid; }
h3 { font: 700 10pt "Segoe UI"; color: #2b4b3d; margin: 4mm 0 1.4mm; break-after: avoid; }
p { margin: 0 0 2.2mm; } ul, ol { margin: 0 0 2.4mm; padding-left: 5.5mm; } li { margin-bottom: .8mm; }
code { font: 8pt Consolas, monospace; background: #eef3f0; padding: 0 1mm; border-radius: .6mm; } pre { font: 8pt Consolas, monospace; background: #eef3f0; padding: 2mm 3mm; border-left: 1mm solid #3a6351; white-space: pre-wrap; }
blockquote { margin: 2mm 0; padding: 2mm 4mm; border-left: 1mm solid #c8780a; background: #fbf6ec; font-style: italic; }
table { width: 100%; border-collapse: collapse; margin: 2mm 0 3.4mm; font-size: 7.4pt; line-height: 1.28; break-inside: auto; }
tr { break-inside: avoid; } th { background: #3a6351; color: #fff; text-align: left; padding: 1.2mm 1.6mm; font-weight: 600; }
td { border: .3pt solid #9db5a9; padding: 1mm 1.6mm; vertical-align: top; } tbody tr:nth-child(even) td { background: #f4f8f6; }
a { color: #3a6351; word-break: break-all; }
.doc { break-before: page; } .doc:first-of-type { break-before: auto; }
.garde { height: 255mm; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; break-after: page; }
.garde img { width: 92mm; } .garde h1 { border: 0; font-size: 26pt; margin-top: 12mm; } .garde .sub { font-size: 12pt; color: #2b4b3d; } .garde .filet { width: 60mm; height: 1mm; background: #c8780a; margin: 6mm 0; }
.garde .note { margin-top: 14mm; font-size: 8.4pt; color: #5f6d66; max-width: 140mm; }
.piece { break-before: page; } .piece h2 { margin-top: 0; } .piece .cap { font-size: 8pt; margin-bottom: 3mm; } .piece img { display: block; max-width: 100%; max-height: 222mm; width: auto; margin: 0 auto 3mm; border: .3pt solid #9db5a9; }
.piece .duo { display: flex; gap: 4mm; } .piece .duo img { max-width: 49%; max-height: 200mm; margin: 0; }
`
const FORMAT = { a4p: 'A4 portrait · 210 × 297 mm', a4l: 'A4 paysage · 297 × 210 mm', a5p: 'A5 portrait · 148 × 210 mm', a5l: 'A5 paysage · 210 × 148 mm' }
const SUPPORT = {
  BV: ['Carnet à souche, 3 feuillets autocopiants, 50 jeux', 'Enregistre une vente quand l’application est indisponible. Souche à gauche : numéro, date, client, total, encaissé, report.'],
  RE: ['Carnet à souche, 3 feuillets autocopiants, 50 jeux', 'Prouve qu’un client a payé : montant en chiffres et en lettres, moyen de paiement, vente ou commande réglée, reste dû.'],
  BD: ['Carnet à souche, 3 feuillets autocopiants, 50 jeux', 'Justifie toute sortie d’argent : nature, catégorie de dépense, objet, imputation, justificatifs, trois signatures.'],
  RF: ['Carnet à souche, 3 feuillets autocopiants, 50 jeux', 'Bordereau d’envoi puis de réception d’argent entre deux caisses ou vers la banque, avec écart.'],
  FJC: ['Bloc, 2 feuillets autocopiants (blanc, jaune), 50 jeux', 'Journal chronologique de la caisse (PDV, commercial ou centrale) : 28 lignes, une opération par ligne, entrée ou sortie ; rapprochement des espèces et écart.'],
  JE: ['Registre relié, 100 pages numérotées', 'Récapitule les encaissements par mode de paiement, 30 lignes par page ; reconstitué depuis les reçus et bons de vente.'],
  FA: ['Carnet, 3 feuillets autocopiants, 50 jeux — MODÈLE PROVISOIRE', 'À valider avec le comptable avant tout usage : mentions légales, TVA, mode d’émission.'],
  DA: ['Bloc, 2 feuillets autocopiants, 50 jeux', 'Exprime un besoin d’achat ; la justification est obligatoire ; la décision se note sur la pièce.'],
  BC: ['Carnet, 3 feuillets autocopiants, 50 jeux', 'Engage l’achat auprès d’un fournisseur ; ne prouve ni la livraison ni le paiement.'],
  BR: ['Carnet, 3 feuillets autocopiants, 50 jeux', 'Constate livré, rejeté, accepté, lot fournisseur, péremption ; seul l’accepté entre en stock.'],
  BL: ['Carnet à souche, 3 feuillets autocopiants, 50 jeux', 'Prouve la remise des produits au client ; livraison partielle et reste à livrer.'],
  BT: ['Carnet, 3 feuillets autocopiants, 50 jeux', 'Trace l’envoi entre deux emplacements ; la moitié basse se remplit à la réception, avec les écarts.'],
  FP: ['Bloc, 2 feuillets autocopiants, 50 jeux', 'Déclare une perte (mortalité, casse, inexpliquée…) ou une consommation d’intrant, avec responsable et photo.'],
  FI: ['Bloc de 100 feuilles', 'Comptage physique d’un emplacement, à l’aveugle ; l’écart se justifie après coup.'],
  FL: ['Bloc de 50 feuilles', 'Une ligne par jour et par lot : mortalité, aliment, pesée, collecte d’œufs, observations.'],
  BH: ['Bloc de 50 feuilles', 'Synthèse de la semaine du commercial : chiffres, réussites, difficultés, besoins, priorités, informations du marché, visa du responsable.'],
  CC: ['Carnet à souche, 3 feuillets autocopiants, 50 jeux', 'Prise de commande sur le terrain, avec acompte ; ne vaut ni facture ni reçu.'],
  VC: ['Bloc de 100 feuilles', 'Visite ou prospection : client, profil commercial, veille sur les prix du marché, résultat codé comme dans l’application, prochaine action.'],
  PT: ['Bloc de 50 feuilles', 'Présence hebdomadaire : arrivée et départ par jour, zone, codes d’absence ; secours du pointage numérique.'],
  RC: ['Registre relié, 100 pages numérotées', 'Suivi des carnets : plages de numéros, remise contre signature, retour, pièces annulées.'],
  EL: ['Ramettes en couleur', 'Papier à en-tête : logo, coordonnées, RCCM, NIU, banque en pied de page.'],
  'BN-G': ['Bloc-notes 50 feuilles, dos carton', 'Notes générales, lignes discrètes, date en haut.'],
  'BN-R': ['Bloc-notes 50 feuilles, dos carton', 'Réunion : participants, ordre du jour, décisions, actions avec responsable et échéance.'],
  'BN-T': ['Bloc-notes 50 feuilles, dos carton', 'Terrain : nature (visite, prospection, inspection…), notes, relances.'],
  'CV-A5L': ['Couvertures carton 250 à 300 g, couleur', 'Face avant (titre, plage de numéros, site, responsable) et dos (huit règles d’usage). Six faces avant pour les carnets A5.'],
  'CV-A4P': ['Couvertures carton 250 à 300 g, couleur', 'Quatre faces avant pour les carnets A4 (BC, BR, BT, FA) et un dos commun.'],
}
const lire = (f) => readFileSync(join(RACINE, f), 'utf8')
const img = (f) => `<img src="${pathToFileURL(join(RACINE, 'apercu', f)).href}">`

const garde = `<div class="garde"><img src="${pathToFileURL(join(RACINE, 'charte', 'logo-couleur.png')).href}"><div class="filet"></div><h1>Pièces papier</h1><div class="sub">Dossier de validation — version 1.0 — 20 octobre 2026</div>
<div class="note">25 pièces à imprimer : carnets à souches, blocs, registres, papeterie. Contenu : note de présentation (formats, procédure de secours, décisions demandées), cadre légal avec ses points à valider, cahier des charges pour l’imprimeur, puis une page par pièce.<br><br>À l’attention de la Direction, du responsable administratif, du promoteur et de l’imprimeur ; à soumettre au comptable avant impression.</div></div>`

const cahierHtml = md(lire('CAHIER-DES-CHARGES-IMPRIMEUR.md'))
const pages = PIECES.map((p) => {
  const [support, usage] = SUPPORT[p.code]
  const visuel = p.pages.length > 1 ? `<div class="duo">${img(`${p.code}-p1.png`)}${img(`${p.code}-p${p.pages.length}.png`)}</div>` : img(`${p.code}-p1.png`)
  return `<section class="piece"><h2>${esc(p.code)} — ${esc(p.nom)}</h2><div class="cap"><b>Format :</b> ${FORMAT[p.fmt]} &nbsp;·&nbsp; <b>Support :</b> ${esc(support)}<br>${esc(usage)}</div>${visuel}</section>`
}).join('\n')

const page = (titre, corps, extra = '') => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${titre}</title><style>${CSS}</style></head><body>${extra}${corps}</body></html>`
const dossier = page('Pièces papier — dossier de validation',
  `<div class="doc">${md(lire('NOTE-DE-PRESENTATION.md'))}</div><div class="doc">${md(lire('REGLEMENTATION.md'))}</div><div class="doc">${cahierHtml}</div>${pages}`, garde)

const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'
let browser; try { browser = await pw.chromium.launch() } catch { browser = await pw.chromium.launch({ executablePath: exe }) }
async function pdf(html, sortie, pied) {
  const f = join(RACINE, '_generation', 'tmp-doc.html'); writeFileSync(f, html)
  const p = await browser.newPage(); await p.goto(pathToFileURL(f).href)
  await p.pdf({ path: join(RACINE, sortie), format: 'A4', printBackground: true, displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: `<div style="width:100%;font:7pt Segoe UI;color:#5f6d66;padding:0 13mm;display:flex;justify-content:space-between"><span>GIC AGROPELC — ${pied}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>` })
  await p.close(); unlinkSync(f)
}
await pdf(dossier, 'DOSSIER-DE-VALIDATION.pdf', 'Pièces papier — dossier de validation v1.0')
await pdf(page('Cahier des charges imprimeur', `<div>${cahierHtml}</div>`), 'CAHIER-DES-CHARGES-IMPRIMEUR.pdf', 'Cahier des charges imprimeur v1.0')
await browser.close()
console.log('DOSSIER-DE-VALIDATION.pdf et CAHIER-DES-CHARGES-IMPRIMEUR.pdf produits')
