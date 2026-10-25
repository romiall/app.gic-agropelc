// Pièces d'argent : bon de vente, reçu d'encaissement, bon de décaissement, remise de fonds, feuille de caisse, journal.
// Libellés et codes : référentiels de l'application (db/seeds/finance-references.ts, glossaire).
import { avecSouche, standard, champ, rang, cases, lignes, montant, lettres, signatures, bloc, section, note, souche, report, reportSouche, dateHeure, esc } from './lib.mjs'

export const MOYENS = ['Espèces', 'Orange Money', 'MTN Mobile Money', 'Virement bancaire', 'Chèque']
const EX3 = '① blanc : client — ② rose : comptabilité — ③ jaune : reste dans le carnet (souche complète)'
const ligneRef = (lib = 'Réf. transaction / n° du chèque', span = 24) => champ(lib, span, { aide: 'obligatoire hors espèces' })

// ------------------------------------------------------------------ RE
const RE = {
  code: 'RE', nom: 'Reçu d’encaissement', fmt: 'a5l',
  pages: [avecSouche({
    code: 'RE', titre: 'Reçu d’encaissement', sous: 'Pièce de caisse',
    souchePart: souche({
      champs: [['Date'], ['Reçu de'], ['Montant', { u: 'XAF' }], ['Mode de paiement'], ['Vente / commande n°'], ['Encaissé par']],
      blocs: reportSouche({ numLib: 'N° opération' }),
    }),
    corps: [
      rang(champ('Reçu de (nom ou raison sociale)', 16), champ('Téléphone', 8)),
      rang(champ('Point de vente / site', 10), dateHeure('Date et heure', 14)),
      rang(montant('Montant reçu', 13), champ('Reste dû après ce paiement', 11, { u: 'XAF' })),
      cases('Mode de paiement', MOYENS),
      rang(ligneRef('Réf. transaction / n° du chèque')),
      lettres('Arrêté le présent reçu à la somme de (en lettres)', 24, 1),
      cases('Pour', ['règlement de la vente n° ………', 'acompte sur la commande n° ………', 'autre : ………']),
      signatures([{ t: 'Le client (payeur)', s: 'nom et signature' }, { t: 'Le caissier', s: 'nom et signature' }, { t: 'Cachet', cachet: true, nom: false }], { h: 14 }),
    ].join(''),
    ex: EX3, h: 8.4,
  })],
}

// ------------------------------------------------------------------ BV
const BV = {
  code: 'BV', nom: 'Bon de vente (secours)', fmt: 'a5l',
  pages: [avecSouche({
    code: 'BV', titre: 'Bon de vente', sous: 'Vente de secours — application indisponible',
    souchePart: souche({
      champs: [['Date'], ['Client'], ['Total', { u: 'XAF' }], ['Encaissé', { u: 'XAF' }], ['Mode de paiement'], ['Vendeur']],
      blocs: reportSouche({ numLib: 'N° vente' }),
    }),
    corps: [
      rang(champ('Client (nom ou raison sociale)', 12), champ('Téléphone', 6), cases('', ['client anonyme'], { span: 6 })),
      rang(champ('Point de vente', 8), dateHeure('Date et heure', 10), champ('Vendeur', 6)),
      lignes({
        cols: [{ t: 'Désignation du produit', w: '*' }, { t: 'Unité', w: '15mm' }, { t: 'Quantité', w: '17mm' }, { t: 'Poids (kg)', w: '15mm' }, { t: 'Prix unitaire (XAF)', w: '22mm' }, { t: 'Remise (XAF)', w: '17mm' }, { t: 'Montant (XAF)', w: '24mm' }],
        n: 5, h: 6.2, total: { lib: 'Total à payer (XAF)' },
      }),
      cases('Paiement', MOYENS),
      rang(champ('Montant encaissé', 8, { u: 'XAF' }), champ('Réf. transaction / chèque', 9), champ('Reste dû (crédit)', 7, { u: 'XAF' })),
      signatures([{ t: 'Le client', s: 'nom et signature' }, { t: 'Le vendeur', s: 'nom et signature' }, { t: 'Cachet', cachet: true, nom: false }], { h: 12 }),
    ].join(''),
    ex: EX3,
  })],
}

// ------------------------------------------------------------------ BD
const CATEGORIES = ['Aliment hors stock', 'Vétérinaire', 'Transport', 'Carburant', 'Énergie et eau', 'Main-d’œuvre occasionnelle', 'Entretien', 'Fournitures', 'Divers']
const BD = {
  code: 'BD', nom: 'Bon de décaissement (pièce de caisse)', fmt: 'a5l',
  pages: [avecSouche({
    code: 'BD', titre: 'Bon de décaissement', sous: 'Pièce de caisse — sortie d’argent',
    souchePart: souche({
      champs: [['Date'], ['Bénéficiaire'], ['Montant', { u: 'XAF' }], ['Nature'], ['Caissier']],
      blocs: reportSouche({ numLib: 'N° opération', extra: 'justificatif joint' }),
    }),
    corps: [
      rang(champ('Payé à (bénéficiaire)', 15), champ('Pièce d’identité n°', 9)),
      rang(champ('Caisse / site', 8), dateHeure('Date et heure', 10), champ('Établi par', 6)),
      cases('Nature', ['dépense', 'paiement fournisseur', 'avance fournisseur', 'remboursement client', 'autre']),
      cases('Catégorie', CATEGORIES),
      rang(champ('Objet détaillé de la sortie', 24, { double: true })),
      rang(champ('Imputé à (lot de production, site, PDV)', 13), champ('Facture / bon de commande n°', 11)),
      rang(montant('Montant payé', 11), lettres('En lettres', 13, 1)),
      cases('Justificatifs joints', ['facture', 'reçu', 'bon de livraison', 'aucun (expliquer)']),
      signatures([{ t: 'Le bénéficiaire', s: 'a reçu la somme' }, { t: 'Le caissier', s: 'a payé' }, { t: 'Autorisé par', s: 'visa du responsable' }], { h: 12 }),
    ].join(''),
    ex: EX3,
  })],
}

export const PIECES_CAISSE = [RE, BV, BD]
