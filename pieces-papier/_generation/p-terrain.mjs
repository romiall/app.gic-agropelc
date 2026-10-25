// Commercial et terrain : prise de commande, visite, pointage ; registre des carnets.
// Alignement : sales.order.* (commande client), crm.visit.* (résultats de visite du référentiel), fieldwork.* (session de travail).
import { avecSouche, standard, champ, rang, cases, lignes, montant, lettres, signatures, bloc, section, note, notes, souche, reportSouche, report, dateHeure } from './lib.mjs'

const D = { aide: 'jj / mm / aaaa' }
const EX3 = '① blanc : client — ② rose : comptabilité — ③ jaune : reste dans le carnet (souche complète)'
const EX2 = '① blanc : transmis — ② jaune : reste dans le bloc'

// ------------------------------------------------------------------ CC
const CC = {
  code: 'CC', nom: 'Bon de commande client', fmt: 'a5l',
  pages: [avecSouche({
    code: 'CC', titre: 'Bon de commande client', sous: 'Prise de commande sur le terrain',
    souchePart: souche({ champs: [['Date'], ['Client'], ['Total', { u: 'XAF' }], ['Acompte', { u: 'XAF' }], ['Commercial']], blocs: reportSouche({ numLib: 'N° commande' }) }),
    corps: [
      rang(champ('Client (nom ou raison sociale)', 15), champ('Téléphone', 9)),
      rang(champ('Adresse de livraison / repère', 15), champ('Livraison souhaitée le', 9, D)),
      rang(champ('Zone / marché', 8), dateHeure('Date et heure', 10), champ('Commercial', 6)),
      lignes({ cols: [{ t: 'Désignation', w: '*' }, { t: 'Unité', w: '15mm' }, { t: 'Quantité', w: '18mm' }, { t: 'Prix convenu (XAF)', w: '24mm' }, { t: 'Montant (XAF)', w: '26mm' }], n: 4, h: 6.4, total: { lib: 'Total de la commande (XAF)' } }),
      rang(champ('Acompte versé', 8, { u: 'XAF' }), cases('Mode', ['espèces', 'mobile money', 'autre'], { span: 16 })),
      signatures([{ t: 'Le client', s: 'accepte la commande' }, { t: 'Le commercial' }, { t: 'Cachet', cachet: true, nom: false }], { h: 13 }),
    ].join(''),
    ex: EX3, mention: 'Commande client : ne vaut ni facture ni reçu et ne fait pas sortir de stock — l’acompte fait l’objet d’un reçu d’encaissement',
  })],
}

// ------------------------------------------------------------------ VC
// Rubriques « profil commercial » et « veille marché » reprises de l'Excel commercial (décisions de la Direction).
const VC = {
  code: 'VC', nom: 'Fiche de visite commerciale', fmt: 'a5p',
  pages: [standard({
    fmt: 'a5p', code: 'VC', titre: 'Fiche de visite', sous: 'Visite et prospection', numLib: 'Fiche N°', marges: { mh: 12 }, annule: false, h: 6.6,
    corps: [
      rang(champ('Commercial', 12), champ('Zone / marché', 12)),
      rang(champ('Date', 8, D), champ('Arrivée à', 8, { aide: '…h…' }), champ('Départ à', 8, { aide: '…h…' })),
      cases('Compte client', ['client existant', 'nouveau prospect']),
      rang(champ('Nom du client / entreprise', 16), champ('Téléphone', 8)),
      rang(champ('Personne rencontrée (fonction)', 13), champ('Adresse / repère', 11)),
      section('Profil commercial du client'),
      rang(champ('Produit d’intérêt', 12), champ('Potentiel par jour (quantité, unité)', 12)),
      rang(cases('Paiement habituel', ['espèces', 'mobile money', 'virement', 'crédit'], { span: 16 }), cases('Différé demandé', ['oui', 'non'], { span: 8 })),
      section('Veille marché'),
      rang(champ('Fournisseur ou concurrent actuel', 13), champ('Produit', 11)),
      rang(champ('Prix constaté chez lui', 12, { u: 'XAF' }), champ('Unité', 12)),
      cases('Résultat de la visite', ['commande prise', 'vente réalisée sur place', 'à relancer', 'pas intéressé', 'client absent', 'autre']),
      champ('Commentaire (obligatoire si « autre »)', 24, { haut: true }),
      rang(champ('Prochaine action', 16), champ('Le', 8, D)),
      report({ extra: '' }),
    ].join(''),
    mention: 'Une fiche par visite — une commande prise donne un bon de commande client, une vente sur place un bon de vente',
  })],
}

// ------------------------------------------------------------------ BH
const zone = (h) => `<div class="lignes-fond" style="height:${h}mm"></div>`
const BH = {
  code: 'BH', nom: 'Bilan hebdomadaire du commercial', fmt: 'a5p',
  pages: [standard({
    fmt: 'a5p', code: 'BH', titre: 'Bilan hebdomadaire', sous: 'Commercial — synthèse de la semaine', numLib: 'Fiche N°', marges: { mh: 12 }, annule: false, h: 6.4,
    corps: [
      rang(champ('Commercial', 12), champ('Semaine du', 6, { aide: '…/…/20…' }), champ('au', 6, { aide: '…/…/20…' })),
      section('Chiffres de la semaine (relevés sur les fiches ou calculés par l’application)'),
      rang(champ('Visites sur place', 8), champ('Nouveaux prospects', 8), champ('Nouveaux clients', 8)),
      rang(champ('CA réalisé', 8, { u: 'XAF' }), champ('Encaissé', 8, { u: 'XAF' }), champ('Casses et pertes', 8, { u: 'XAF' })),
      section('Réussites de la semaine'), zone(11),
      section('Difficultés rencontrées'), zone(11),
      section('Besoins et demandes à la direction'), zone(11),
      section('Priorités de la semaine suivante'), zone(11),
      section('Informations du marché (concurrents, prix)'), zone(11),
      bloc('Réservé au responsable', [cases('Vu par le responsable', ['oui']), champ('Commentaire', 24)].join(''), 'plein'),
      signatures([{ t: 'Le commercial' }, { t: 'Le responsable', s: 'visa' }], { h: 11 }),
    ].join(''),
    mention: 'Une fiche par semaine — les chiffres se recoupent avec les visites, commandes et encaissements de l’application',
  })],
}

// ------------------------------------------------------------------ PT
const PT = {
  code: 'PT', nom: 'Fiche de présence et de pointage', fmt: 'a4l',
  pages: [standard({
    fmt: 'a4l', code: 'PT', titre: 'Présence et pointage', sous: 'Solution de secours du pointage numérique', numLib: 'Feuille N°', annule: false, marges: { mh: 11 },
    corps: [
      rang(champ('Site / zone déclarée', 10), champ('Semaine du', 6, { aide: '…/…/20…' }), champ('au', 4, { aide: '…/…/20…' }), champ('Responsable', 4)),
      lignes({
        n: 14, h: 7.6,
        cols: [{ t: 'Nom et prénom', w: '*' }, { t: 'Fonction', w: '24mm' }, { t: 'Zone / mission', w: '28mm' },
          ...['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'].flatMap((j) => [{ t: `${j} arrivée`, w: '11.5mm' }, { t: `${j} départ`, w: '11.5mm' }]),
          { t: 'Total heures', w: '14mm' }, { t: 'Visa', w: '13mm' }],
      }),
      note('<b>Codes d’absence</b> (à écrire dans la case « arrivée ») : A absent — M maladie — C congé — R repos — MI mission hors zone. Heures au format 07 h 45. Une session de travail terrain = une arrivée et un départ ; un pointage refusé ou imprécis est signalé au responsable.'),
      signatures([{ t: 'Le responsable du site', s: 'a vérifié la semaine' }, { t: 'La Direction', s: 'visa' }], { h: 12 }),
    ].join(''),
    mention: 'Chaque ligne se reporte comme une session de travail : zone déclarée, heure de début, heure de fin',
  })],
}

// ------------------------------------------------------------------ RC
const RC = {
  code: 'RC', nom: 'Registre de suivi des carnets', fmt: 'a4l',
  pages: [standard({
    fmt: 'a4l', code: 'RC', titre: 'Registre de suivi des carnets', sous: 'Remise, retour et pièces annulées', numLib: 'Page N°', marges: { mg: 15 }, annule: false,
    corps: [
      rang(champ('Tenu par (responsable des carnets)', 12), champ('Site', 12)),
      lignes({
        numerote: false, n: 15, h: 6.8,
        cols: [{ t: 'Carnet n°', w: '15mm' }, { t: 'Type de pièce (code)', w: '21mm' }, { t: 'N° de début', w: '20mm' }, { t: 'N° de fin', w: '20mm' }, { t: 'Remis le', w: '16mm' }, { t: 'Remis à (nom)', w: '*' }, { t: 'Site / PDV', w: '24mm' }, { t: 'Signature du preneur', w: '26mm' }, { t: 'Retourné le', w: '16mm' }, { t: 'Pièces utilisées', w: '15mm' }, { t: 'Pièces annulées (n°)', w: '26mm' }, { t: 'Non utilisées', w: '15mm' }, { t: 'Visa contrôle', w: '14mm' }],
      }),
      note('<b>Règle :</b> un carnet est remis contre signature ; il est rendu terminé, avec toutes ses souches et ses pièces annulées. Un carnet perdu ou volé est signalé le jour même. Les numéros ne se réutilisent jamais.'),
    ].join(''),
    mention: 'Registre à cotation continue — une ligne par carnet remis',
  })],
}

export const PIECES_TERRAIN = [CC, VC, BH, PT, RC]
