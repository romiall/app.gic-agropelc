// Papeterie de marque : papier à en-tête, blocs-notes, couvertures de carnet. Impression en couleur (numérique) : logo couleur.
import { ID, esc, feuille, champ, rang, cases, lignes, section, note, signatures, bandeau } from './lib.mjs'

const blanc = (c = '') => `<span class="blanc ${c}"></span>`
const v = (x, c = '') => (x ? esc(x) : blanc(c))

// ------------------------------------------------------------------ EL : papier à en-tête
const EL = {
  code: 'EL', nom: 'Papier à en-tête', fmt: 'a4p', couleur: true,
  pages: [feuille({
    fmt: 'a4p', couleur: true, marges: { mh: 10, md: 14, mb: 10, mg: 14 }, reperes: false,
    interieur: `<header class="entete" style="height:30mm;align-items:flex-start;gap:5mm;border-bottom:.7mm solid var(--orange);padding-bottom:3mm">
      <img class="logo" src="{{LOGO}}" alt="GIC AGROPELC" style="height:27mm">
      <div class="identite" style="padding-top:2mm;text-align:right">
        <div class="raison" style="font-size:17pt">${esc(ID.raison_sociale)}</div>
        ${ID.forme_juridique ? `<div class="forme" style="font-size:8pt">${esc(ID.forme_juridique)}</div>` : ''}
        <div class="coord" style="font-size:8pt;margin-top:2mm"><b>Siège</b>${v(ID.siege, 'l')} <b>BP</b>${v(ID.bp, 's')}</div>
        <div class="coord" style="font-size:8pt"><b>Tél</b>${v(ID.telephones)} <b>E-mail</b>${v(ID.email)}</div>
      </div></header>
      <div style="flex:1"></div>
      <footer class="pied" style="border-top:.6mm solid var(--vert);font-size:7pt;justify-content:center;gap:8mm;padding-top:1.6mm">
        <span><b style="color:var(--vert)">RCCM</b> ${v(ID.rccm)}</span><span><b style="color:var(--vert)">NIU</b> ${v(ID.niu)}</span><span><b style="color:var(--vert)">Banque</b> ${v(ID.banque)}</span><span><b style="color:var(--vert)">Compte</b> ${v(ID.compte_bancaire)}</span>
      </footer>`,
  })],
}

// ------------------------------------------------------------------ blocs-notes (A5 portrait)
const enteteNote = (titre, sousTitre = '') => `<header class="entete" style="height:15mm;gap:3mm"><img class="logo" src="{{LOGO}}" alt="" style="height:13mm">
  <div class="identite"><div class="raison" style="font-size:9.5pt">${esc(ID.raison_sociale)}</div>${titre ? `<div class="forme" style="font-size:7.5pt;font-weight:600;letter-spacing:.06em;text-transform:uppercase">${esc(titre)}</div>` : ''}</div>
  <div class="note" style="text-align:right;white-space:nowrap;font-size:7pt">Date : …… / …… / 20……<br>${sousTitre}</div></header><div style="height:.6mm;background:var(--orange);margin-bottom:1.6mm"></div>`
const piedNote = (t) => `<footer class="pied" style="font-size:5.6pt;margin-top:1mm"><div>${esc(t)}</div><div class="ref">GIC AGROPELC · Bloc-notes · 10/2026</div></footer>`
const A5 = { mh: 9, md: 10, mb: 8, mg: 12 }

const BNG = {
  code: 'BN-G', nom: 'Bloc-notes général', fmt: 'a5p', couleur: true,
  pages: [feuille({ fmt: 'a5p', couleur: true, marges: A5, reperes: false,
    interieur: `${enteteNote('Notes', 'Page n° ……')}<div class="lignes-fond" style="flex:1;min-height:0"></div>${piedNote('Bloc de 50 feuilles collées en tête')}` })],
}

const BNR = {
  code: 'BN-R', nom: 'Bloc-notes de réunion', fmt: 'a5p', couleur: true,
  pages: [feuille({ fmt: 'a5p', couleur: true, marges: A5, reperes: false,
    interieur: `${enteteNote('Compte rendu de réunion')}
    <div class="corps" style="--h:6.6mm;gap:1mm;padding-top:0">
      ${rang(champ('Objet de la réunion', 24))}
      ${rang(champ('Lieu', 9), champ('Début', 7, { aide: '…h…' }), champ('Fin', 8, { aide: '…h…' }))}
      ${rang(champ('Animée par', 12), champ('Secrétaire de séance', 12))}
      ${section('Participants (nom, fonction)')}
      <div class="rang" style="--h:6.2mm">${[0, 1, 2, 3, 4, 5].map(() => champ('', 12)).join('')}</div>
      ${section('Ordre du jour')}
      <div class="lignes-fond" style="height:21mm"></div>
      ${section('Discussions et décisions')}
      <div class="lignes-fond souple" style="flex:1;min-height:20mm"></div>
      ${lignes({ cols: [{ t: 'Action à mener', w: '*' }, { t: 'Responsable', w: '30mm' }, { t: 'Échéance', w: '20mm' }], n: 3, h: 6 })}
      ${rang(champ('Prochaine réunion le', 14, { aide: '…/…/20…' }), champ('à', 10, { aide: '…h…' }))}
    </div>${piedNote('Compte rendu — à diffuser aux participants')}` })],
}

const BNT = {
  code: 'BN-T', nom: 'Bloc-notes terrain', fmt: 'a5p', couleur: true,
  pages: [feuille({ fmt: 'a5p', couleur: true, marges: A5, reperes: false,
    interieur: `${enteteNote('Notes de terrain')}
    <div class="corps" style="--h:6.6mm;gap:1.2mm;padding-top:0">
      ${rang(champ('Auteur', 12), champ('Zone / lieu', 12))}
      ${cases('Nature', ['visite', 'prospection', 'inspection de site', 'livraison', 'autre'])}
      ${rang(champ('Personne ou site rencontré', 24))}
      ${section('Notes')}
      <div class="lignes-fond souple" style="flex:1;min-height:30mm"></div>
      ${lignes({ cols: [{ t: 'À faire / relances', w: '*' }, { t: 'Pour le', w: '24mm' }], n: 3, h: 6 })}
    </div>${piedNote('Les visites et commandes se reportent ensuite sur la fiche de visite ou le bon de commande client')}` })],
}

// ------------------------------------------------------------------ couvertures de carnet
const COUV = {
  BV: ['Carnet de bons de vente', 'Vente de secours — application indisponible', 'a5l', '50 jeux de 3 feuillets autocopiants'],
  RE: ['Carnet de reçus d’encaissement', 'Pièces de caisse numérotées', 'a5l', '50 jeux de 3 feuillets autocopiants'],
  BD: ['Carnet de bons de décaissement', 'Pièces de caisse — sorties d’argent', 'a5l', '50 jeux de 3 feuillets autocopiants'],
  RF: ['Carnet de remises de fonds', 'Bordereaux d’envoi et de réception', 'a5l', '50 jeux de 3 feuillets autocopiants'],
  BL: ['Carnet de bons de livraison', 'Remise des produits aux clients', 'a5l', '50 jeux de 3 feuillets autocopiants'],
  CC: ['Carnet de bons de commande client', 'Prise de commande sur le terrain', 'a5l', '50 jeux de 3 feuillets autocopiants'],
  BC: ['Carnet de bons de commande fournisseur', 'Engagement d’achat', 'a4p', '50 jeux de 3 feuillets autocopiants'],
  BR: ['Carnet de bons de réception', 'Marchandises, intrants, animaux', 'a4p', '50 jeux de 3 feuillets autocopiants'],
  BT: ['Carnet de bons de transfert de stock', 'Expédition et réception entre emplacements', 'a4p', '50 jeux de 3 feuillets autocopiants'],
  FA: ['Carnet de factures', 'Modèle provisoire — à valider avant impression', 'a4p', '50 jeux de 3 feuillets autocopiants'],
}
const couvFace = (code, [titre, sous, fmt, jeux]) => feuille({ fmt, couleur: true, reperes: false, marges: { mh: 0, md: 0, mb: 0, mg: 0 },
  interieur: `<div class="cv"><div class="haut"><img src="{{LOGO}}" alt="GIC AGROPELC"></div>
  <div class="titre"><h1>${esc(titre)}</h1><p>${esc(sous)}</p></div>
  <div class="bas">
    <div class="serie"><span>Carnet n°</span><span class="zone" style="min-width:28mm"></span><span>Pièces n°</span><span class="zone"></span><span>à n°</span><span class="zone"></span></div>
    <div class="serie" style="font-weight:400;color:var(--encre)"><span>Site : ${blanc('l')}</span><span>Remis à : ${blanc('l')}</span><span>Le : ${blanc()}</span></div>
    <div class="note" style="text-align:center;font-size:7.5pt">${esc(jeux)} · ① blanc ② rose ③ jaune (reste dans le carnet) · modèle GIC-${code}</div>
  </div></div>` })
const couvDos = (fmt) => feuille({ fmt, couleur: true, reperes: false, marges: { mh: 12, md: 14, mb: 12, mg: 14 },
  interieur: `<div class="titre-section" style="font-size:9pt;margin-bottom:4mm">Règles d’usage de ce carnet</div><div class="regles"><ol>
  <li><b>Écrire au stylo à bille, en appuyant fort, en majuscules lisibles :</b> l’écriture se copie sur tous les feuillets.</li>
  <li><b>Utiliser les pièces dans l’ordre des numéros</b>, sans en sauter aucune. Les numéros ne se réutilisent jamais.</li>
  <li><b>Une pièce erronée ne s’arrache jamais :</b> la barrer, écrire « ANNULÉ », cocher « pièce annulée » et garder tous ses feuillets dans le carnet.</li>
  <li><b>Remettre le feuillet blanc</b> à la personne concernée ; <b>le jaune reste dans le carnet</b> (souche complète).</li>
  <li><b>Reporter chaque pièce dans l’application dès son rétablissement</b>, de préférence sous 24 heures et dans les délais fixés par l’application (une saisie tardive demande une justification), puis écrire le n° d’opération sur la souche.</li>
  <li><b>Photographier la pièce</b> et la joindre dans l’application : la photo est la pièce justificative numérique.</li>
  <li><b>Un carnet terminé est rendu au responsable</b> avec toutes ses souches et ses pièces annulées, et conservé pendant la durée légale.</li>
  <li><b>Un carnet perdu ou volé est signalé le jour même</b> au responsable des carnets.</li></ol></div>
  <div style="flex:1"></div><div class="note" style="text-align:center">${esc(ID.raison_sociale)} — pièce justificative des opérations enregistrées dans l’application</div>` })

const CVA5 = { code: 'CV-A5L', nom: 'Couvertures de carnet A5 paysage', fmt: 'a5l', couleur: true, pages: [...['BV', 'RE', 'BD', 'RF', 'BL', 'CC'].map((c) => couvFace(c, COUV[c])), couvDos('a5l')] }
const CVA4 = { code: 'CV-A4P', nom: 'Couvertures de carnet A4 portrait', fmt: 'a4p', couleur: true, pages: [...['BC', 'BR', 'BT', 'FA'].map((c) => couvFace(c, COUV[c])), couvDos('a4p')] }

export const PIECES_PAPETERIE = [EL, BNG, BNR, BNT, CVA5, CVA4]
