// Rendu des pièces papier GIC AGROPELC.
//   node pieces-papier/_generation/build.mjs RE BV      (certaines pièces)
//   node pieces-papier/_generation/build.mjs all        (toutes)
//   options : --force (PDF d'impression d'une pièce légale même si RCCM/NIU vides)  --scale=2  --no-png
// Sorties : gabarits/CODE.html + CODE-impression.html, pdf/CODE.pdf (aperçu 1:1, logo couleur),
//           pdf/CODE-impression.pdf (traits de coupe, logo 2 encres, zone de numérotation vide), apercu/CODE-pN.png
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { PIECES } from './pieces.mjs'
import { ID, RACINE } from './lib.mjs'

const require = createRequire('C:/xampp/htdocs/app.gic-agropelc/apps/pwa/package.json')
let pw
try { pw = require('playwright') } catch { pw = require('@playwright/test') }

const args = process.argv.slice(2)
const flags = args.filter((a) => a.startsWith('--'))
const cibles = args.filter((a) => !a.startsWith('--'))
const FORCE = flags.includes('--force')
const SCALE = Number((flags.find((f) => f.startsWith('--scale=')) ?? '--scale=2').split('=')[1])
const PNG = !flags.includes('--no-png')
const MM = 96 / 25.4
const SLUG = 8 // mm autour de la feuille en impression (traits de coupe, légende)

const DIM = { a4p: [210, 297], a4l: [297, 210], a5p: [148, 210], a5l: [210, 148], a6l: [148, 105], t3a4: [210, 99] }
const ENCRES = 'Vert #3A6351 + Orange #C8780A (+ noir texte)'

for (const d of ['gabarits', 'pdf', 'apercu']) mkdirSync(join(RACINE, d), { recursive: true })
const liste = cibles.length === 0 || cibles[0] === 'all' ? PIECES : PIECES.filter((p) => cibles.includes(p.code))
if (liste.length === 0) { console.error('Aucune pièce : codes connus =', PIECES.map((p) => p.code).join(' ')); process.exit(2) }

function document_(piece, mode) {
  const [w, h] = DIM[piece.fmt]
  const imp = mode === 'impression'
  const logo = imp && !piece.couleur ? '../charte/logo-2-encres.png' : '../charte/logo-couleur.png'
  const num = imp ? '' : '000001'
  const fil = !imp && piece.legal ? '<div class="filigrane"><span>MODÈLE PROVISOIRE</span></div>' : ''
  let pages = piece.pages.map((p) => p.replaceAll('{{LOGO}}', logo).replaceAll('{{N}}', num))
  if (fil) pages = pages.map((p) => p.replace(/<\/section>$/, `${fil}</section>`))
  if (imp) {
    const W = w + 2 * SLUG, H = h + 2 * SLUG
    const marks = [[0, SLUG, 'h'], [0, SLUG + h, 'h'], [W - 5, SLUG, 'h'], [W - 5, SLUG + h, 'h'], [SLUG, 0, 'v'], [SLUG + w, 0, 'v'], [SLUG, H - 5, 'v'], [SLUG + w, H - 5, 'v']]
      .map(([x, y, t]) => `<i class="coupe ${t}" style="left:${x}mm;top:${y}mm"></i>`).join('')
    const leg = `<div class="legende-planche">GIC AGROPELC · ${piece.code} · ${piece.nom} · ${w}×${h} mm · fonds perdus : aucun aplat ne touche le bord · encres : ${ENCRES} · numérotation typographique à poser sur la zone N°</div>`
    pages = pages.map((p) => `<div class="planche" style="width:${W}mm;height:${H}mm;--slug:${SLUG}mm">${marks}${p}${leg}</div>`)
  }
  const [pw_, ph_] = imp ? [w + 2 * SLUG, h + 2 * SLUG] : [w, h]
  return {
    html: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${piece.code} — ${piece.nom}</title><link rel="stylesheet" href="../charte/pieces.css"><style>@page{size:${pw_}mm ${ph_}mm;margin:0}</style></head><body class="${imp ? 'impression' : ''}" data-pages="${piece.pages.length}">${pages.join('\n')}</body></html>`,
    pw: pw_, ph: ph_,
  }
}

const CONTROLE = () => {
  const out = []
  document.querySelectorAll('.feuille').forEach((f, i) => {
    const corps = f.querySelector('.corps')
    if (corps && corps.scrollHeight > corps.clientHeight + 1) out.push(`feuille ${i + 1} : le contenu dépasse la zone utile de ${Math.round((corps.scrollHeight - corps.clientHeight) / 3.78 * 10) / 10} mm`)
    const fr = f.getBoundingClientRect()
    f.querySelectorAll('.cadre *').forEach((el) => {
      if (el.closest('.perfo,.souche::after')) return
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return
      if (r.right > fr.right + 0.5 || r.bottom > fr.bottom + 0.5 || r.left < fr.left - 0.5 || r.top < fr.top - 0.5) out.push(`feuille ${i + 1} : ${el.tagName.toLowerCase()}.${el.className} sort de la feuille`)
    })
    f.querySelectorAll('.champ .lib, .sign .t, th, .cases .o, .bandeau h1').forEach((el) => {
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).whiteSpace !== 'normal') out.push(`feuille ${i + 1} : texte tronqué « ${el.textContent.trim().slice(0, 30)} »`)
    })
  })
  if (!document.fonts.check('12px Bahnschrift')) out.push('police Bahnschrift introuvable')
  return out
}

const lancer = async () => {
  const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'
  try { return await pw.chromium.launch() } catch { return await pw.chromium.launch({ executablePath: exe }) }
}
const browser = await lancer()
const rapport = []

for (const piece of liste) {
  const ligne = { code: piece.code, nom: piece.nom, fmt: piece.fmt, pages: piece.pages.length, problemes: [] }
  for (const mode of ['apercu', 'impression']) {
    if (mode === 'impression' && piece.legal && ID.validation_comptable_facture !== true && !FORCE) {
      ligne.problemes.push('PDF d’impression non produit (volontaire) : la facture n’est pas validée par le comptable — passer validation_comptable_facture à true dans charte/identite.json, ou --force')
      continue
    }
    const { html, pw: W, ph: H } = document_(piece, mode)
    const fichier = join(RACINE, 'gabarits', mode === 'apercu' ? `${piece.code}.html` : `${piece.code}-impression.html`)
    writeFileSync(fichier, html)
    const page = await browser.newPage({ viewport: { width: Math.ceil(W * MM), height: Math.ceil(H * MM) }, deviceScaleFactor: SCALE })
    await page.goto(pathToFileURL(fichier).href)
    await page.evaluate(() => document.fonts.ready)
    if (mode === 'apercu') {
      ligne.problemes.push(...(await page.evaluate(CONTROLE)))
      if (PNG) {
        const feuilles = page.locator('.feuille')
        const n = await feuilles.count()
        for (let i = 0; i < n; i++) await feuilles.nth(i).screenshot({ path: join(RACINE, 'apercu', `${piece.code}-p${i + 1}.png`) })
      }
    }
    const pdf = await page.pdf({ width: `${W}mm`, height: `${H}mm`, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: false })
    writeFileSync(join(RACINE, 'pdf', mode === 'apercu' ? `${piece.code}.pdf` : `${piece.code}-impression.pdf`), pdf)
    const nb = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length
    if (nb !== piece.pages.length) ligne.problemes.push(`${mode} : ${nb} page(s) PDF au lieu de ${piece.pages.length}`)
    await page.close()
  }
  rapport.push(ligne)
}
await browser.close()

try { execFileSync('python', ['-I', join(RACINE, '_generation', 'ajuster_pdf.py')], { stdio: 'inherit' }) } catch { console.log('(ajustement PDF non fait : python + pypdf requis)') }
let ko = 0
for (const l of rapport) {
  const etat = l.problemes.length ? 'À CORRIGER' : 'ok'
  if (l.problemes.length) ko++
  console.log(`${etat.padEnd(10)} ${l.code.padEnd(6)} ${l.fmt.padEnd(5)} ${l.pages}p  ${l.nom}`)
  for (const p of l.problemes) console.log('           - ' + p)
}
console.log(`${rapport.length} pièce(s), ${ko} avec remarque(s)`)
process.exitCode = ko ? 1 : 0
