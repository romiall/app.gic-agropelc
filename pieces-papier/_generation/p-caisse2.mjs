// Pièces d'argent (suite) : remise de fonds, feuille journalière de caisse, journal des encaissements, facture.
import { avecSouche, standard, champ, rang, cases, lignes, montant, lettres, signatures, bloc, section, note, souche, reportSouche, report, dateHeure, espace } from './lib.mjs'
import { MOYENS } from './p-caisse.mjs'

const EX3 = '① blanc : client — ② rose : comptabilité — ③ jaune : reste dans le carnet (souche complète)'
const EX2 = '① blanc : Finance / comptabilité — ② jaune : reste dans le bloc'

// ------------------------------------------------------------------ RF
const RF = {
  code: 'RF', nom: 'Bordereau de remise de fonds', fmt: 'a5l',
  pages: [avecSouche({
    code: 'RF', titre: 'Remise de fonds', sous: 'Bordereau — envoi puis réception',
    souchePart: souche({
      champs: [['Date d’envoi'], ['Remis à'], ['Montant envoyé', { u: 'XAF' }], ['Vers (compte)'], ['Remettant']],
      blocs: reportSouche({ numLib: 'N° remise' }),
    }),
    corps: [
      rang(champ('Remettant (nom, fonction)', 14), champ('Site / caisse d’origine', 10)),
      rang(champ('Destinataire (nom, fonction)', 14), champ('Site / compte de destination', 10)),
      cases('De', ['caisse du PDV', 'caisse d’un utilisateur', 'caisse centrale', 'mobile money']),
      cases('Vers', ['caisse centrale', 'banque (dépôt n° ………)']),
      rang(champ('Session de caisse n° / période', 12), dateHeure('Envoyé le', 12)),
      rang(montant('Montant envoyé', 11), lettres('En lettres', 13, 1)),
      section('À remplir à la réception par le destinataire'),
      rang(dateHeure('Reçu le', 12), champ('Montant reçu', 12, { u: 'XAF' })),
      rang(champ('Écart (envoyé − reçu)', 9, { u: 'XAF' }), champ('Motif de l’écart', 15)),
      signatures([{ t: 'Le remettant', s: 'a envoyé', }, { t: 'Le destinataire', s: 'a reçu et compté' }, { t: 'Cachet', cachet: true, nom: false }], { h: 12 }),
    ].join(''),
    ex: EX3,
  })],
}

// ------------------------------------------------------------------ FJC
// Journal chronologique de la caisse : une ligne par opération, entrée ou sortie (décision de la Direction : pas de comptage par coupures ; même feuille pour la caisse d'un commercial).
const FJC = {
  code: 'FJC', nom: 'Feuille journalière de caisse', fmt: 'a4p',
  pages: [standard({
    fmt: 'a4p', code: 'FJC', titre: 'Feuille journalière de caisse', sous: 'Journal chronologique des entrées et des sorties', numLib: 'Feuille N°', marges: { mh: 12 },
    corps: [
      rang(champ('Site / point de vente', 8), cases('Caisse', ['du PDV', 'du commercial', 'centrale'], { span: 11 }), champ('Jour', 5, { aide: '…/…/20…' })),
      rang(champ('Caissier(ère) ou commercial', 7), champ('Contrôleur(se)', 7), champ('Session n°', 4), champ('Fonds d’ouverture compté', 6, { u: 'XAF' })),
      lignes({
        cols: [{ t: 'Heure', w: '12mm' }, { t: 'N° de la pièce (RE, BV, BD, RF…)', w: '30mm' }, { t: 'Client, bénéficiaire ou objet', w: '*' }, { t: 'Mode E O M V C', w: '14mm' }, { t: 'ENTRÉE (XAF)', w: '27mm' }, { t: 'SORTIE (XAF)', w: '27mm' }],
        n: 28, h: 5.3, total: { lib: 'Totaux de la journée', span: 5 },
      }),
      `<div class="rang" style="align-items:start">
        <div class="c12" style="display:grid;gap:.6mm;--h:6.1mm">
          ${section('Rapprochement des espèces')}
          ${champ('Fonds d’ouverture compté', 12, { u: 'XAF' })}
          ${champ('+ Entrées en espèces', 12, { u: 'XAF' })}
          ${champ('− Sorties en espèces (remises de fonds comprises)', 12, { u: 'XAF' })}
          ${champ('= Solde théorique des espèces', 12, { u: 'XAF' })}
        </div>
        <div class="c12" style="display:grid;gap:.6mm;--h:6.1mm">
          ${section('Contrôle')}
          ${champ('Espèces comptées', 12, { u: 'XAF' })}
          ${champ('ÉCART  (compté − théorique)', 12, { u: 'XAF' })}
          ${champ('Motif de l’écart', 12)}
          ${champ('Entrées hors espèces (O, M, V, C)', 12, { u: 'XAF' })}
        </div></div>`,
      signatures([{ t: 'Le caissier', s: 'a compté et clôturé' }, { t: 'Le contrôleur', s: 'a vérifié' }, { t: 'Finance', s: 'écart : ☐ validé  ☐ à justifier' }], { h: 10.5 }),
      report({ extra: '' }),
    ].join(''),
    ex: EX2, mention: 'Mode : E espèces · O Orange Money · M MTN Mobile Money · V virement · C chèque. L’argent qui entre s’écrit dans ENTRÉE, celui qui sort dans SORTIE. Une feuille par caisse et par jour ; tout écart est écrit et justifié, jamais effacé.',
  })],
}

// ------------------------------------------------------------------ JE
const JE = {
  code: 'JE', nom: 'Journal des encaissements', fmt: 'a4p',
  pages: [standard({
    fmt: 'a4p', code: 'JE', titre: 'Journal des encaissements', sous: 'Registre — une ligne par encaissement', numLib: 'Page N°', marges: { mh: 12, mg: 14 }, annule: false,
    mention: 'Reconstitué chaque jour à partir des reçus d’encaissement et des bons de vente — ne jamais laisser de ligne vide entre deux écritures',
    corps: [
      rang(champ('Site / point de vente', 10), champ('Période du', 6, { aide: '…/…/20…' }), champ('au', 4, { aide: '…/…/20…' }), champ('Tenu par', 4)),
      lignes({
        cols: [{ t: 'Date', w: '15mm' }, { t: 'N° pièce (RE / BV)', w: '23mm' }, { t: 'Client / objet (vente ou commande n°)', w: '*' }, { t: 'Espèces', w: '20mm' }, { t: 'Orange Money', w: '20mm' }, { t: 'MTN MoMo', w: '20mm' }, { t: 'Virement', w: '20mm' }, { t: 'Chèque', w: '18mm' }, { t: 'Total (XAF)', w: '22mm' }],
        n: 30, h: 6.3,
        total: [{ lib: 'Total de la page', span: 4 }, { lib: 'Report des pages précédentes', span: 4 }, { lib: 'Total à reporter', span: 4 }],
      }),
    ].join(''),
  })],
}

// ------------------------------------------------------------------ FA
const blanc = (c = '') => `<span class="blanc ${c}"></span>`
const FA = {
  code: 'FA', nom: 'Facture (modèle provisoire)', fmt: 'a4p', legal: true,
  pages: [standard({
    fmt: 'a4p', code: 'FA', titre: 'Facture', sous: 'Modèle provisoire — conformité à valider (comptable, DGI)', numLib: 'Facture N°', marges: { mh: 12 },
    corps: [
      rang(champ('Date d’émission', 8, { aide: 'jj / mm / aaaa' }), champ('Échéance', 7, { aide: 'jj / mm / aaaa' }), champ('Bon de vente / commande n°', 9)),
      bloc('Client', [
        rang(champ('Nom ou raison sociale', 15), champ('NIU du client', 9, { aide: 'si assujetti' })),
        rang(champ('Adresse', 15), champ('Téléphone', 9)),
      ].join('<div style="height:1mm"></div>')),
      lignes({ cols: [{ t: 'Désignation', w: '*' }, { t: 'Unité', w: '17mm' }, { t: 'Quantité', w: '19mm' }, { t: 'Prix unitaire HT (XAF)', w: '30mm' }, { t: 'TVA (taux %)', w: '17mm' }, { t: 'Montant HT (XAF)', w: '30mm' }], n: 14, h: 6.8 }),
      `<div class="rang" style="align-items:start">
        <div class="c13" style="display:grid;gap:1.4mm">
          ${cases('Régime de TVA', ['TVA applicable', 'opération exonérée de TVA'])}
          ${champ('Mention d’exonération / observations', 13, { double: true })}
          ${note('Coordonnées de règlement<br>Banque ' + blanc('l') + '<br>Compte n° ' + blanc('l') + '<br>Mobile money ' + blanc('l'))}
        </div>
        <div class="c11" style="display:grid;gap:.4mm">
          ${champ('Total HT', 11, { u: 'XAF' })}${champ('TVA', 11, { u: 'XAF' })}${champ('Total TTC', 11, { u: 'XAF' })}${champ('Acompte déjà reçu', 11, { u: 'XAF' })}${champ('NET À PAYER', 11, { u: 'XAF' })}
        </div></div>`,
      lettres('Arrêtée la présente facture à la somme de (en lettres)', 24, 2),
      signatures([{ t: 'Le vendeur', s: 'nom, signature et cachet' }, { t: 'Le client', s: 'bon pour accord — nom et signature' }], { h: 16 }),
    ].join(''),
    ex: EX3, mention: 'Facture numérotée en continu — les mentions légales et le taux de TVA sont à valider avec le comptable avant impression',
  })],
}

export const PIECES_CAISSE2 = [RF, FJC, JE, FA]
