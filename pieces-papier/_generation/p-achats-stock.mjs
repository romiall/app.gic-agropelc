// Achats, réception, stock, livraison, production.
// Champs alignés sur les commandes de l'application : procurement.* (DA, BC, réception), inventory.* (transfert, perte, inventaire),
// sales.delivery (livraison), production.* (saisie du jour).
import { avecSouche, standard, champ, rang, cases, lignes, montant, lettres, signatures, bloc, section, note, notes, souche, reportSouche, report, dateHeure } from './lib.mjs'

const EX_FOURN = '① blanc : fournisseur — ② rose : comptabilité — ③ jaune : reste dans le carnet (souche complète)'
const EX3 = '① blanc : destinataire — ② rose : comptabilité / magasin — ③ jaune : reste dans le carnet (souche complète)'
const EX2 = '① blanc : transmis — ② jaune : reste dans le bloc'
const D = { aide: 'jj / mm / aaaa' }

// ------------------------------------------------------------------ DA
const DA = {
  code: 'DA', nom: 'Demande d’achat', fmt: 'a4p',
  pages: [standard({
    fmt: 'a4p', code: 'DA', titre: 'Demande d’achat', sous: 'Document interne — soumis à validation', numLib: 'DA N°', marges: { mh: 12 },
    corps: [
      rang(champ('Site demandeur', 9), champ('Demandeur (nom, fonction)', 9), champ('Date de la demande', 6, D)),
      rang(champ('Besoin attendu pour le', 8, D), champ('Lot de production / budget concerné', 16)),
      champ('Justification du besoin (obligatoire)', 24, { double: true }),
      lignes({ cols: [{ t: 'Produit / désignation', w: '*' }, { t: 'Unité', w: '18mm' }, { t: 'Quantité', w: '20mm' }, { t: 'Prix unitaire estimé (XAF)', w: '30mm' }, { t: 'Montant estimé (XAF)', w: '30mm' }, { t: 'Observations', w: '34mm' }], n: 10, h: 7, total: { lib: 'Total estimé (XAF)', span: 5 } }),
      bloc('Décision — réservé à la validation', [cases('Décision', ['approuvée', 'rejetée', 'à compléter']), champ('Motif de la décision', 24), champ('Bon de commande n° (si approuvée)', 12)].join('<div style="height:1mm"></div>'), 'plein'),
      signatures([{ t: 'Le demandeur' }, { t: 'Responsable du site', s: 'visa' }, { t: 'Achats / Direction', s: 'décision' }], { h: 14 }),
      report({ extra: '' }),
    ].join(''),
    ex: EX2, mention: 'Pièce numérotée — la demande d’achat n’engage aucun achat : seul le bon de commande engage GIC AGROPELC',
  })],
}

// ------------------------------------------------------------------ BC
const BC = {
  code: 'BC', nom: 'Bon de commande fournisseur', fmt: 'a4p',
  pages: [standard({
    fmt: 'a4p', code: 'BC', titre: 'Bon de commande fournisseur', sous: 'Engagement d’achat', numLib: 'BC N°', marges: { mh: 12 },
    corps: [
      rang(champ('Fournisseur (nom ou raison sociale)', 16), champ('NIU / RCCM du fournisseur', 8)),
      rang(champ('Adresse, ville', 16), champ('Téléphone', 8)),
      rang(champ('Date de la commande', 7, D), champ('Livraison attendue le', 7, D), champ('Demande d’achat n°', 10)),
      rang(champ('Lieu de livraison (site, emplacement)', 14), champ('Établi par (achats)', 10)),
      lignes({ cols: [{ t: 'Produit / désignation', w: '*' }, { t: 'Unité', w: '17mm' }, { t: 'Quantité commandée', w: '24mm' }, { t: 'Prix unitaire (XAF)', w: '30mm' }, { t: 'Montant (XAF)', w: '32mm' }], n: 11, h: 7, total: { lib: 'Total de la commande (XAF)' } }),
      cases('Prix', ['hors taxes', 'TVA incluse']),
      cases('Paiement', ['comptant', 'à la livraison', 'à 30 jours', 'avance de ……… %', 'autre']),
      note('Ce bon engage GIC AGROPELC sur les produits, quantités et prix indiqués. <b>Il ne prouve ni la livraison ni le paiement</b> : la livraison est constatée par un bon de réception, le règlement par un bon de décaissement ou une preuve de virement.'),
      signatures([{ t: 'Établi par', s: 'achats' }, { t: 'Approuvé par', s: 'Direction / Finance si au-delà du seuil' }, { t: 'Le fournisseur', s: 'bon pour accord — cachet' }], { h: 16 }),
    ].join(''),
    ex: EX_FOURN, mention: 'Bon de commande numéroté — à rappeler sur le bon de livraison et la facture du fournisseur',
  })],
}

// ------------------------------------------------------------------ BR
const BR = {
  code: 'BR', nom: 'Bon de réception', fmt: 'a4p',
  pages: [standard({
    fmt: 'a4p', code: 'BR', titre: 'Bon de réception', sous: 'Marchandises, intrants, animaux — livré, rejeté, accepté', numLib: 'BR N°', marges: { mh: 12 },
    corps: [
      rang(champ('Fournisseur', 14), champ('Bon de commande n° (ou « sans BC »)', 10)),
      rang(champ('Bon de livraison du fournisseur n°', 12), champ('Transporteur / véhicule', 12)),
      rang(champ('Site / emplacement de réception', 9), champ('Date et heure de réception', 9, { aide: '…/…/20… à …h…' }), champ('Réceptionnaire', 6)),
      lignes({ cols: [{ t: 'Produit', w: '*' }, { t: 'Unité', w: '14mm' }, { t: 'Commandé', w: '17mm' }, { t: 'Livré', w: '16mm' }, { t: 'Rejeté', w: '16mm' }, { t: 'Accepté (livré − rejeté)', w: '20mm', g: true }, { t: 'Motif du rejet', w: '30mm' }, { t: 'N° de lot fournisseur', w: '24mm' }, { t: 'Péremption', w: '20mm' }], n: 9, h: 7 }),
      cases('Constat', ['conforme', 'réserves (voir observations)', 'refus total']),
      cases('Photo du bon de livraison', ['jointe dans l’application', 'indisponible (expliquer)']),
      champ('Observations (avaries, retards, écarts, état des animaux)', 24, { double: true }),
      note('<b>Seule la quantité acceptée entre en stock.</b> Réception sans bon de commande, dépassement du commandé ou rejet : en informer le responsable des achats. La photo du bon de livraison est exigée dans les cas fixés par les paramètres de l’application.'),
      signatures([{ t: 'Le réceptionnaire', s: 'a compté et accepté' }, { t: 'Le livreur / fournisseur', s: 'a livré' }, { t: 'Responsable du site', s: 'visa' }], { h: 14 }),
      report({ extra: '' }),
    ].join(''),
    ex: EX3, mention: 'Bon de réception numéroté — joindre le bon de livraison du fournisseur à l’exemplaire conservé',
  })],
}

// ------------------------------------------------------------------ BL
const BL = {
  code: 'BL', nom: 'Bon de livraison (client)', fmt: 'a5l',
  pages: [avecSouche({
    code: 'BL', titre: 'Bon de livraison', sous: 'Remise des produits au client',
    souchePart: souche({ champs: [['Date'], ['Client'], ['Commande n°'], ['Livré par'], ['Reçu par']], blocs: reportSouche({ numLib: 'N° livraison', extra: 'signature photographiée' }) }),
    corps: [
      rang(champ('Client', 14), champ('Téléphone', 10)),
      rang(champ('Adresse de livraison', 16), champ('Commande client n°', 8)),
      rang(dateHeure('Livré le', 13), champ('Livré par (nom)', 11)),
      lignes({ cols: [{ t: 'Désignation', w: '*' }, { t: 'Unité', w: '15mm' }, { t: 'Quantité commandée', w: '21mm' }, { t: 'Livrée ce jour', w: '21mm' }, { t: 'Reste à livrer', w: '21mm' }], n: 5, h: 6.4 }),
      rang(cases('Livraison', ['complète', 'partielle (le reste sera livré)'], { span: 13 }), champ('Observations', 11)),
      signatures([{ t: 'Le client / réceptionnaire', s: 'a reçu les produits en bon état' }, { t: 'Le livreur' }, { t: 'Cachet', cachet: true, nom: false }], { h: 13 }),
    ].join(''),
    ex: EX3, mention: 'Une livraison partielle = un bon de livraison — le reste à livrer reste dû',
  })],
}

// ------------------------------------------------------------------ BT
const BT = {
  code: 'BT', nom: 'Bon de transfert de stock', fmt: 'a4p',
  pages: [standard({
    fmt: 'a4p', code: 'BT', titre: 'Bon de transfert de stock', sous: 'Expédition puis réception entre deux emplacements', numLib: 'BT N°', marges: { mh: 12 },
    corps: [
      cases('Nature', ['transfert entre sites', 'réapprovisionnement d’un PDV', 'affectation de stock à un vendeur', 'retour vers la source', 'autre']),
      rang(champ('Expédié de (emplacement d’origine)', 12), champ('Vers (emplacement de destination)', 12)),
      rang(champ('Expédié le', 7, { aide: '…/…/20… à …h…' }), champ('Expéditeur (nom)', 8), champ('Transporteur / véhicule', 9)),
      lignes({ cols: [{ t: 'Produit', w: '*' }, { t: 'Lot / n° de lot', w: '24mm' }, { t: 'Unité', w: '14mm' }, { t: 'Quantité expédiée', w: '22mm' }, { t: 'Quantité reçue', w: '22mm', g: true }, { t: 'Écart', w: '16mm', g: true }, { t: 'Motif de l’écart', w: '34mm', g: true }], n: 9, h: 6.8 }),
      section('À remplir à la réception par le destinataire'),
      rang(champ('Reçu le', 7, { aide: '…/…/20… à …h…' }), champ('Réceptionnaire (nom)', 9), cases('Constat', ['conforme', 'écart à justifier', 'refus'], { span: 8 })),
      champ('Observations', 24, { double: true }),
      note('<b>Un écart de transfert est une perte en transit à justifier</b> (produit, quantité, cause). Animaux vivants, œufs ou viande : joindre le document sanitaire de transport s’il est exigé (à vérifier auprès du service vétérinaire).'),
      signatures([{ t: 'L’expéditeur', s: 'a remis' }, { t: 'Le transporteur', s: 'a convoyé' }, { t: 'Le destinataire', s: 'a reçu et compté' }], { h: 15 }),
      report({ extra: '' }),
    ].join(''),
    ex: EX3, mention: 'Bon de transfert numéroté — l’exemplaire jaune de l’expéditeur reste dans le carnet jusqu’à la réception confirmée',
  })],
}

// ------------------------------------------------------------------ FP
const FP = {
  code: 'FP', nom: 'Fiche de perte / consommation', fmt: 'a5p',
  pages: [standard({
    fmt: 'a5p', code: 'FP', titre: 'Fiche de perte', sous: 'ou consommation d’intrant', numLib: 'Fiche N°', marges: { mh: 12 },
    corps: [
      cases('Nature', ['perte (déclaration de perte)', 'consommation d’intrant']),
      rang(champ('Site / emplacement', 12), champ('Déclarant (nom)', 12)),
      rang(champ('Date et heure du constat', 24, { aide: '…/…/20… à …h…' })),
      cases('Catégorie', ['mortalité', 'casse', 'détérioration', 'impropre à la vente', 'destruction', 'inexpliquée', 'vol suspecté', 'écart de transfert']),
      lignes({ cols: [{ t: 'Produit', w: '*' }, { t: 'Unité', w: '14mm' }, { t: 'Quantité', w: '18mm' }, { t: 'Lot de production / lot de stock', w: '32mm' }], n: 7, h: 6.8 }),
      champ('Cause, circonstances (obligatoire si inexpliquée ou vol suspecté)', 24, { double: true }),
      champ('Imputé à, si consommation (lot de production, site, PDV)', 24),
      champ('Personne responsable, si identifiée', 24),
      cases('Photo', ['prise (à joindre dans l’application)', 'pas de photo']),
      signatures([{ t: 'Le déclarant' }, { t: 'Responsable du site' }, { t: 'Validation', s: 'si requise' }], { h: 13 }),
      report({ extra: '' }),
    ].join(''),
    ex: EX2, mention: 'Une mortalité se rattache toujours à un lot de production — la photo est jointe si la politique de contrôle l’exige',
  })],
}

// ------------------------------------------------------------------ FI
const FI = {
  code: 'FI', nom: 'Fiche d’inventaire', fmt: 'a4p',
  pages: [standard({
    fmt: 'a4p', code: 'FI', titre: 'Fiche d’inventaire', sous: 'Comptage physique d’un emplacement', numLib: 'Fiche N°', marges: { mh: 12 }, annule: false,
    corps: [
      rang(champ('Emplacement compté', 9), champ('Date et heure du comptage', 8, { aide: '…/…/20… à …h…' }), champ('Compteur 1', 7)),
      rang(cases('Type', ['périodique', 'd’ouverture', 'tournant / surprise'], { span: 16 }), champ('Compteur 2', 8)),
      lignes({ cols: [{ t: 'Produit', w: '*' }, { t: 'Lot', w: '22mm' }, { t: 'Unité', w: '14mm' }, { t: 'Stock théorique (reporté après comptage)', w: '28mm', g: true }, { t: 'Stock physique compté', w: '24mm' }, { t: 'Écart', w: '18mm', g: true }, { t: 'Motif de l’écart', w: '38mm' }], n: 21, h: 6.4 }),
      note('<b>Comptage à l’aveugle :</b> écrire le stock physique avant de connaître le stock théorique. L’écart est justifié, jamais effacé ; au-delà du seuil d’approbation, la validation du responsable est demandée.'),
      signatures([{ t: 'Compteur 1' }, { t: 'Compteur 2' }, { t: 'Responsable de l’emplacement' }], { h: 13 }),
      report({ extra: '' }),
    ].join(''),
    ex: '', mention: 'Une fiche par emplacement et par comptage — conserver avec le rapport de régularisation',
  })],
}

// ------------------------------------------------------------------ FL
const JOURS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'].map((j) => `${j} <span style="font-weight:400;color:var(--gris)">…/…</span>`)
const FL = {
  code: 'FL', nom: 'Fiche de suivi de lot (saisie du jour)', fmt: 'a4l',
  pages: [standard({
    fmt: 'a4l', code: 'FL', titre: 'Suivi de lot de production', sous: 'Saisie du jour — une ligne par jour', numLib: 'Fiche N°', annule: false, marges: { mh: 11 },
    corps: [
      rang(champ('Lot de production n°', 8), cases('Type de lot', ['poulet de chair', 'pondeuse', 'porc d’engraissement', 'autre'], { span: 16 })),
      rang(champ('Bâtiment / case', 8), champ('Semaine du', 6, { aide: '…/…/20…' }), champ('au', 4, { aide: '…/…/20…' }), champ('Effectif en début de semaine', 6)),
      lignes({
        numerote: false, prefill: JOURS, h: 10.6, n: 7,
        cols: [{ t: 'Jour', w: '27mm' }, { t: 'Mortalité : nombre', w: '15mm' }, { t: 'Mortalité : cause', w: '23mm' }, { t: 'Aliment : produit', w: '28mm' }, { t: 'Aliment : quantité (kg)', w: '17mm' }, { t: 'Pesée : échantillon', w: '16mm' }, { t: 'Pesée : poids moyen (g)', w: '17mm' }, { t: 'Œufs collectés', w: '15mm' }, { t: 'Œufs cassés', w: '13mm' }, { t: 'Œufs non conformes', w: '16mm' }, { t: 'Œufs commerciali-sables', w: '19mm' }, { t: 'Œufs à couver', w: '13mm' }, { t: 'Observations (santé, vaccin, incident)', w: '*' }, { t: 'Visa', w: '12mm' }],
        total: { lib: 'Total de la semaine', span: 1 },
      }),
      champ('Traitements, vaccins, événements marquants de la semaine', 24, { double: true }),
      signatures([{ t: 'Responsable du bâtiment' }, { t: 'Chef d’exploitation / vétérinaire' }], { h: 12 }),
      report({ extra: '' }),
    ].join(''),
    mention: 'Chaque ligne se reporte comme une saisie du jour du lot : mortalité, aliment, pesée, collecte d’œufs, observation',
  })],
}

export const PIECES_ACHATS_STOCK = [DA, BC, BR, BL, BT, FP, FI, FL]
