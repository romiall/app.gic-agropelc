// Fichiers d'impression des carnets et du registre des encaissements : numéros imprimés dans le fichier.
//   node pieces-papier/_generation/carnets.mjs BL BC FA JE        (carnet n° 1 : pièces 000001 à 000050 ; registre n° 1 : 100 pages)
//   node pieces-papier/_generation/carnets.mjs BL --carnet=2      (carnet n° 2 : pièces 000051 à 000100)
//   options : --jeux=50 (jeux par carnet)  --pages=100 (pages du registre)  --force (facture non validée)
// Un carnet = une couverture (face avant, numéros du carnet imprimés), N jeux numérotés (zone « N° » et souche, même numéro),
// un dos (règles d'usage) ; une planche par page : format fini + 8 mm de marge technique, traits de coupe, légende.
// Le registre = une couverture, 100 pages (numéro de page, numéro de chaque ligne continu : 000001 à 003000), un dos.
// Sorties : pdf/carnets/CODE-carnet-NN-AAAAAA-BBBBBB.pdf  et  pdf/carnets/JE-registre-NN-pages-001-100.pdf
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { PIECES } from './pieces.mjs'
import { ID, RACINE, SLUG, DIM, planche } from './lib.mjs'
import { COUV, couvFace, couvDos, couvRegistre, couvRegistreDos } from './p-papeterie.mjs'
import { JE_LIGNES, pageRegistre } from './p-caisse2.mjs'

const require = createRequire('C:/xampp/htdocs/app.gic-agropelc/apps/pwa/package.json')
let pw
try { pw = require('playwright') } catch { pw = require('@playwright/test') }

const args = process.argv.slice(2)
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v = '1'] = a.slice(2).split('='); return [k, v] }))
const cibles = args.filter((a) => !a.startsWith('--'))
const CARNET = Number(flags.carnet ?? 1)
const JEUX = Number(flags.jeux ?? 50)
const PAGES = Number(flags.pages ?? 100)
const FORCE = 'force' in flags
const MM = 96 / 25.4
const ENCRES = 'Vert #3A6351 + Orange #C8780A (+ noir texte)'
const p6 = (n) => String(n).padStart(6, '0')
const p3 = (n) => String(n).padStart(3, '0')
const p2 = (n) => String(n).padStart(2, '0')
const rendre = (html, logo) => html.replaceAll('{{LOGO}}', logo)

if (!Number.isInteger(CARNET) || CARNET < 1) { console.error('--carnet doit être un entier ≥ 1'); process.exit(2) }

// ---- composition d'un fichier : liste de { html, legende } -> HTML d'impression ----
function document_(titre, [w, h], planches) {
  const W = w + 2 * SLUG, H = h + 2 * SLUG
  return {
    W, H,
    html: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${titre}</title><link rel="stylesheet" href="../charte/pieces.css"><style>@page{size:${W}mm ${H}mm;margin:0}</style></head><body class="impression" data-pages="${planches.length}">${planches.map((p) => planche(p.html, w, h, p.legende)).join('\n')}</body></html>`,
  }
}

function carnet(code) {
  const piece = PIECES.find((p) => p.code === code)
  if (!piece || !COUV[code]) throw new Error(`${code} : pas un carnet connu (${Object.keys(COUV).join(', ')})`)
  if (piece.legal && ID.validation_comptable_facture !== true && !FORCE) throw new Error(`${code} : pièce légale non validée par le comptable (charte/identite.json) — ou --force`)
  const [w, h] = DIM[piece.fmt]
  const debut = (CARNET - 1) * JEUX + 1, fin = CARNET * JEUX
  const taille = `${w}×${h} mm`
  const planches = []
  planches.push({
    html: rendre(couvFace(code, COUV[code], { carnet: String(CARNET), de: p6(debut), a: p6(fin) }), '../charte/logo-couleur.png'),
    legende: `GIC AGROPELC · ${code} · couverture (face avant) du carnet n° ${CARNET} · ${taille} · carton 250 à 300 g · impression en couleur · numéros imprimés dans ce fichier : ne rien numéroter`,
  })
  const logo = piece.couleur ? '../charte/logo-couleur.png' : '../charte/logo-2-encres.png'
  for (let k = 0; k < JEUX; k++) {
    const n = debut + k
    planches.push({
      html: rendre(piece.pages[0], logo).replaceAll('{{N}}', p6(n)),
      legende: `GIC AGROPELC · ${code} · ${piece.nom} · carnet n° ${CARNET} · jeu ${k + 1}/${JEUX} · n° ${p6(n)} · ${taille} · encres : ${ENCRES} · numéro imprimé (zone N° et souche) : ne pas numéroter`,
    })
  }
  planches.push({
    html: rendre(couvDos(piece.fmt), '../charte/logo-couleur.png'),
    legende: `GIC AGROPELC · ${code} · dos du carnet n° ${CARNET} (règles d'usage) · ${taille} · carton 250 à 300 g · impression en couleur`,
  })
  return { nom: `${code}-carnet-${p2(CARNET)}-${p6(debut)}-${p6(fin)}`, dim: [w, h], titre: `${code} — ${piece.nom} — carnet n° ${CARNET} (${p6(debut)} à ${p6(fin)})`, planches, attendu: JEUX + 2 }
}

function registre() {
  const [w, h] = DIM.a4p
  const decalage = (CARNET - 1) * PAGES * JE_LIGNES // les numéros de ligne se poursuivent d'un registre à l'autre
  const ligneDe = decalage + 1, ligneA = decalage + PAGES * JE_LIGNES
  const taille = `${w}×${h} mm`
  const planches = []
  planches.push({
    html: rendre(couvRegistre({ registre: String(CARNET), pageDe: p3(1), pageA: p3(PAGES), ligneDe: p6(ligneDe), ligneA: p6(ligneA) }), '../charte/logo-couleur.png'),
    legende: `GIC AGROPELC · JE · couverture du registre des encaissements n° ${CARNET} · ${taille} · carton 250 à 300 g · impression en couleur · numéros imprimés dans ce fichier : ne rien numéroter`,
  })
  for (let p = 1; p <= PAGES; p++) {
    const debut = ligneDe + (p - 1) * JE_LIGNES
    planches.push({
      html: rendre(pageRegistre({ page: p, debut }), '../charte/logo-2-encres.png').replaceAll('{{N}}', p3(p)),
      legende: `GIC AGROPELC · JE · registre n° ${CARNET} · page ${p3(p)}/${p3(PAGES)} · lignes ${p6(debut)} à ${p6(debut + JE_LIGNES - 1)} · ${taille} · reliure ${p % 2 ? 'à gauche' : 'à droite (recto verso)'} · encres : ${ENCRES} · numéros imprimés : ne pas numéroter`,
    })
  }
  planches.push({
    html: rendre(couvRegistreDos(), '../charte/logo-couleur.png'),
    legende: `GIC AGROPELC · JE · dos du registre des encaissements n° ${CARNET} (règles d'usage) · ${taille} · carton 250 à 300 g · impression en couleur`,
  })
  return { nom: `JE-registre-${p2(CARNET)}-pages-${p3(1)}-${p3(PAGES)}`, dim: [w, h], titre: `JE — Registre des encaissements n° ${CARNET} (pages ${p3(1)} à ${p3(PAGES)}, lignes ${p6(ligneDe)} à ${p6(ligneA)})`, planches, attendu: PAGES + 2 }
}

const codes = cibles.length ? cibles : ['BL', 'BC', 'FA', 'JE']
const fichiers = codes.map((c) => (c === 'JE' ? registre() : carnet(c)))

const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'
const browser = await (async () => { try { return await pw.chromium.launch() } catch { return await pw.chromium.launch({ executablePath: exe }) } })()
const sortie = join(RACINE, 'pdf', 'carnets')
mkdirSync(sortie, { recursive: true })
let ko = 0
for (const f of fichiers) {
  const { html, W, H } = document_(f.titre, f.dim, f.planches)
  const tmp = join(RACINE, '_generation', 'tmp-carnet.html')
  writeFileSync(tmp, html)
  const page = await browser.newPage({ viewport: { width: Math.ceil(W * MM), height: Math.ceil(H * MM) } })
  await page.goto(pathToFileURL(tmp).href)
  await page.evaluate(() => document.fonts.ready)
  // contrôles : police, contenu qui dépasse la zone utile, texte qui sort de la feuille
  const problemes = await page.evaluate(() => {
    const out = []
    if (!document.fonts.check('12px Bahnschrift')) out.push('police Bahnschrift introuvable')
    document.querySelectorAll('.feuille').forEach((fe, i) => {
      const corps = fe.querySelector('.corps')
      if (corps && corps.scrollHeight > corps.clientHeight + 1) out.push(`planche ${i + 1} : le contenu dépasse la zone utile de ${Math.round((corps.scrollHeight - corps.clientHeight) / 3.78 * 10) / 10} mm`)
      const fr = fe.getBoundingClientRect()
      fe.querySelectorAll('.cadre *').forEach((el) => {
        if (el.closest('.perfo')) return
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) return
        if (r.right > fr.right + 0.5 || r.bottom > fr.bottom + 0.5 || r.left < fr.left - 0.5 || r.top < fr.top - 0.5) out.push(`planche ${i + 1} : ${el.tagName.toLowerCase()}.${el.className} sort de la feuille`)
      })
    })
    return [...new Set(out)].slice(0, 12)
  })
  const pdf = await page.pdf({ width: `${W}mm`, height: `${H}mm`, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: false })
  writeFileSync(join(sortie, `${f.nom}.pdf`), pdf)
  await page.close()
  unlinkSync(tmp)
  const nb = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length
  if (nb !== f.attendu) problemes.push(`${nb} page(s) PDF au lieu de ${f.attendu}`)
  if (problemes.length) ko++
  console.log(`${problemes.length ? 'À CORRIGER' : 'ok        '} ${f.nom}.pdf  ${nb} pages  (${(pdf.length / 1048576).toFixed(1)} Mo)`)
  for (const p of problemes) console.log('           - ' + p)
}
await browser.close()
try { execFileSync('python', ['-I', join(RACINE, '_generation', 'ajuster_pdf.py')], { stdio: 'inherit' }) } catch { console.log('(ajustement PDF non fait : python + pypdf requis)') }
process.exitCode = ko ? 1 : 0
