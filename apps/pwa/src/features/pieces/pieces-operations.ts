/**
 * Pièces des opérations de commande, d'achat, de stock et de production remplies par l'application :
 * bon de commande client (CC), bon de livraison (BL), demande d'achat (DA), bon de commande
 * fournisseur (BC), bon de réception (BR), bon de transfert (BT), fiche de perte ou de consommation
 * (FP), fiche d'inventaire (FI), suivi de lot (FL). Rubriques, ordre et dimensions : ceux de
 * `pieces-papier/_generation/p-terrain.mjs` et `p-achats-stock.mjs`, à l'identique.
 */
import {
  bloc,
  cases,
  champ,
  type Contexte,
  dateHeure,
  lignes,
  note,
  numeroPage,
  paginer,
  rang,
  report,
  section,
  signatures,
  standard,
  type Valeur,
} from './gabarit.js';
import { xafPiece } from './format.js';
import type { PieceRendue } from './piece.js';
import type { Saisie } from './pieces-argent.js';

const EX3 =
  '① blanc : client — ② rose : comptabilité — ③ jaune : reste dans le carnet (souche complète)';
const EX3_DEST =
  '① blanc : destinataire — ② rose : comptabilité / magasin — ③ jaune : reste dans le carnet (souche complète)';
const EX_FOURN =
  '① blanc : fournisseur — ② rose : comptabilité — ③ jaune : reste dans le carnet (souche complète)';
const EX2 = '① blanc : transmis — ② jaune : reste dans le bloc';
const SOUCHE = { mg: 9 } as const;
const D = (v: Valeur) => (v ? { v } : { aide: 'jj / mm / aaaa' });
const DH = (v: Valeur) => (v ? { v } : { aide: '…/…/20… à …h…' });
const rep = (s: Saisie | undefined) =>
  report({ extra: '', saisiLe: s?.le, par: s?.par, numero: s?.numero });

// ------------------------------------------------------------------ CC
export interface LigneCommandeClient {
  readonly designation: string;
  readonly unite: string;
  readonly quantite: string | null;
  readonly prixConvenu: number | null;
  readonly montant: number | null;
}

export interface DonneesCC {
  readonly numero: string | null;
  readonly client: string | null;
  readonly telephone: string | null;
  readonly adresse: string | null;
  readonly livraisonSouhaitee: string | null;
  readonly zone: string | null;
  readonly dateHeure: string | null;
  readonly commercial: string | null;
  readonly lignes: readonly LigneCommandeClient[];
  readonly total: number | null;
  readonly acompte: number | null;
  readonly modeAcompte: 'espèces' | 'mobile money' | 'autre' | null;
}

export function bonCommandeClient(d: DonneesCC, ctx: Contexte): PieceRendue {
  const N = 4;
  const feuilles = paginer(d.lignes, N);
  const pages = feuilles.map((lot, i) =>
    standard({
      fmt: 'a5l',
      code: 'CC',
      titre: 'Bon de commande client',
      sous: 'Prise de commande sur le terrain',
      marges: SOUCHE,
      n: d.numero,
      page: numeroPage(i, feuilles.length),
      ctx,
      corps: [
        rang(
          champ('Client (nom ou raison sociale)', 15, { v: d.client }),
          champ('Téléphone', 9, { v: d.telephone }),
        ),
        rang(
          champ('Adresse de livraison / repère', 15, { v: d.adresse }),
          champ('Livraison souhaitée le', 9, D(d.livraisonSouhaitee)),
        ),
        rang(
          champ('Zone / marché', 8, { v: d.zone }),
          dateHeure('Date et heure', 10, d.dateHeure),
          champ('Commercial', 6, { v: d.commercial }),
        ),
        lignes({
          cols: [
            { t: 'Désignation', w: '*' },
            { t: 'Unité', w: '15mm', al: 'c' },
            { t: 'Quantité', w: '18mm', al: 'r' },
            { t: 'Prix convenu (XAF)', w: '24mm', al: 'r' },
            { t: 'Montant (XAF)', w: '26mm', al: 'r' },
          ],
          n: N,
          h: 6.4,
          premierNumero: i * N + 1,
          rows: lot.map((l) => [
            l.designation,
            l.unite,
            l.quantite,
            xafPiece(l.prixConvenu),
            xafPiece(l.montant),
          ]),
          total: {
            lib: 'Total de la commande (XAF)',
            v: i === feuilles.length - 1 ? [xafPiece(d.total)] : [],
          },
        }),
        rang(
          champ('Acompte versé', 8, { u: 'XAF', v: xafPiece(d.acompte), num: true }),
          cases('Mode', ['espèces', 'mobile money', 'autre'], {
            span: 16,
            coche: d.modeAcompte ? [d.modeAcompte] : [],
          }),
        ),
        signatures(
          [
            { t: 'Le client', s: 'accepte la commande', v: d.client },
            { t: 'Le commercial', v: d.commercial },
            { t: 'Cachet', cachet: true, nom: false },
          ],
          { h: 13 },
        ),
      ].join(''),
      ex: EX3,
      mention:
        'Commande client : ne vaut ni facture ni reçu et ne fait pas sortir de stock — l’acompte fait l’objet d’un reçu d’encaissement',
    }),
  );
  return { code: 'CC', titre: 'Bon de commande client', fmt: 'a5l', pages };
}

// ------------------------------------------------------------------ BL
export interface LigneLivraison {
  readonly designation: string;
  readonly unite: string;
  readonly commandee: string | null;
  readonly livree: string | null;
  readonly reste: string | null;
}

export interface DonneesBL {
  readonly numero: string | null;
  readonly client: string | null;
  readonly telephone: string | null;
  readonly adresse: string | null;
  readonly commande: string | null;
  readonly livreLe: string | null;
  readonly livrePar: string | null;
  readonly lignes: readonly LigneLivraison[];
  readonly complete: boolean | null;
  readonly observations: string | null;
  readonly recuPar: string | null;
}

export function bonLivraison(d: DonneesBL, ctx: Contexte): PieceRendue {
  const N = 5;
  const feuilles = paginer(d.lignes, N);
  const complete = 'complète';
  const partielle = 'partielle (le reste sera livré)';
  const pages = feuilles.map((lot, i) =>
    standard({
      fmt: 'a5l',
      code: 'BL',
      titre: 'Bon de livraison',
      sous: 'Remise des produits au client',
      marges: SOUCHE,
      n: d.numero,
      page: numeroPage(i, feuilles.length),
      ctx,
      corps: [
        rang(champ('Client', 14, { v: d.client }), champ('Téléphone', 10, { v: d.telephone })),
        rang(
          champ('Adresse de livraison', 16, { v: d.adresse }),
          champ('Commande client n°', 8, { v: d.commande }),
        ),
        rang(dateHeure('Livré le', 13, d.livreLe), champ('Livré par (nom)', 11, { v: d.livrePar })),
        lignes({
          cols: [
            { t: 'Désignation', w: '*' },
            { t: 'Unité', w: '15mm', al: 'c' },
            { t: 'Quantité commandée', w: '21mm', al: 'r' },
            { t: 'Livrée ce jour', w: '21mm', al: 'r' },
            { t: 'Reste à livrer', w: '21mm', al: 'r' },
          ],
          n: N,
          h: 6.4,
          premierNumero: i * N + 1,
          rows: lot.map((l) => [l.designation, l.unite, l.commandee, l.livree, l.reste]),
        }),
        rang(
          cases('Livraison', [complete, partielle], {
            span: 13,
            coche: d.complete === null ? [] : [d.complete ? complete : partielle],
          }),
          champ('Observations', 11, { v: d.observations }),
        ),
        signatures(
          [
            { t: 'Le client / réceptionnaire', s: 'a reçu les produits en bon état', v: d.recuPar },
            { t: 'Le livreur', v: d.livrePar },
            { t: 'Cachet', cachet: true, nom: false },
          ],
          { h: 13 },
        ),
      ].join(''),
      ex: EX3_DEST,
      mention: 'Une livraison partielle = un bon de livraison — le reste à livrer reste dû',
    }),
  );
  return { code: 'BL', titre: 'Bon de livraison', fmt: 'a5l', pages };
}

// ------------------------------------------------------------------ DA
export interface LigneDemandeAchat {
  readonly designation: string;
  readonly unite: string;
  readonly quantite: string | null;
  readonly prixEstime: number | null;
  readonly montantEstime: number | null;
  readonly observations: string | null;
}

export interface DonneesDA {
  readonly numero: string | null;
  readonly site: string | null;
  readonly demandeur: string | null;
  readonly date: string | null;
  readonly besoinLe: string | null;
  readonly lotOuBudget: string | null;
  readonly justification: string | null;
  readonly lignes: readonly LigneDemandeAchat[];
  readonly totalEstime: number | null;
  readonly decision: 'approuvée' | 'rejetée' | 'à compléter' | null;
  readonly motifDecision: string | null;
  readonly bonDeCommande: string | null;
  readonly decideur: string | null;
  readonly saisie?: Saisie;
}

export function demandeAchat(d: DonneesDA, ctx: Contexte): PieceRendue {
  const N = 10;
  const feuilles = paginer(d.lignes, N);
  const pages = feuilles.map((lot, i) =>
    standard({
      fmt: 'a4p',
      code: 'DA',
      titre: 'Demande d’achat',
      sous: 'Document interne — soumis à validation',
      numLib: 'DA N°',
      marges: { mh: 12 },
      n: d.numero,
      page: numeroPage(i, feuilles.length),
      ctx,
      corps: [
        rang(
          champ('Site demandeur', 9, { v: d.site }),
          champ('Demandeur (nom, fonction)', 9, { v: d.demandeur }),
          champ('Date de la demande', 6, D(d.date)),
        ),
        rang(
          champ('Besoin attendu pour le', 8, D(d.besoinLe)),
          champ('Lot de production / budget concerné', 16, { v: d.lotOuBudget }),
        ),
        champ('Justification du besoin (obligatoire)', 24, { double: true, v: d.justification }),
        lignes({
          cols: [
            { t: 'Produit / désignation', w: '*' },
            { t: 'Unité', w: '18mm', al: 'c' },
            { t: 'Quantité', w: '20mm', al: 'r' },
            { t: 'Prix unitaire estimé (XAF)', w: '30mm', al: 'r' },
            { t: 'Montant estimé (XAF)', w: '30mm', al: 'r' },
            { t: 'Observations', w: '34mm' },
          ],
          n: N,
          h: 7,
          premierNumero: i * N + 1,
          rows: lot.map((l) => [
            l.designation,
            l.unite,
            l.quantite,
            xafPiece(l.prixEstime),
            xafPiece(l.montantEstime),
            l.observations,
          ]),
          total: {
            lib: 'Total estimé (XAF)',
            span: 5,
            v: i === feuilles.length - 1 ? [xafPiece(d.totalEstime)] : [],
          },
        }),
        bloc(
          'Décision — réservé à la validation',
          [
            cases('Décision', ['approuvée', 'rejetée', 'à compléter'], {
              coche: d.decision ? [d.decision] : [],
            }),
            champ('Motif de la décision', 24, { v: d.motifDecision }),
            champ('Bon de commande n° (si approuvée)', 12, { v: d.bonDeCommande }),
          ].join('<div style="height:1mm"></div>'),
          'plein',
        ),
        signatures(
          [
            { t: 'Le demandeur', v: d.demandeur },
            { t: 'Responsable du site', s: 'visa' },
            { t: 'Achats / Direction', s: 'décision', v: d.decideur },
          ],
          { h: 14 },
        ),
        rep(d.saisie),
      ].join(''),
      ex: EX2,
      mention:
        'Pièce numérotée — la demande d’achat n’engage aucun achat : seul le bon de commande engage GIC AGROPELC',
    }),
  );
  return { code: 'DA', titre: 'Demande d’achat', fmt: 'a4p', pages };
}

// ------------------------------------------------------------------ BC
export interface LigneCommandeFournisseur {
  readonly designation: string;
  readonly unite: string;
  readonly quantite: string | null;
  readonly prixUnitaire: number | null;
  readonly montant: number | null;
}

export const PAIEMENTS_BC = [
  'comptant',
  'à la livraison',
  'à 30 jours',
  'avance de ……… %',
  'autre',
] as const;

export interface DonneesBC {
  readonly numero: string | null;
  readonly fournisseur: string | null;
  readonly niuFournisseur: string | null;
  readonly adresse: string | null;
  readonly telephone: string | null;
  readonly date: string | null;
  readonly livraisonAttendue: string | null;
  readonly demandeAchat: string | null;
  readonly lieuLivraison: string | null;
  readonly etabliPar: string | null;
  readonly lignes: readonly LigneCommandeFournisseur[];
  readonly total: number | null;
  readonly prix: 'hors taxes' | 'TVA incluse' | null;
  readonly paiement: (typeof PAIEMENTS_BC)[number] | null;
  readonly approuvePar: string | null;
}

export function bonCommandeFournisseur(d: DonneesBC, ctx: Contexte): PieceRendue {
  const N = 11;
  const feuilles = paginer(d.lignes, N);
  const pages = feuilles.map((lot, i) =>
    standard({
      fmt: 'a4p',
      code: 'BC',
      titre: 'Bon de commande fournisseur',
      sous: 'Engagement d’achat',
      numLib: 'BC N°',
      marges: { mh: 12 },
      n: d.numero,
      page: numeroPage(i, feuilles.length),
      ctx,
      corps: [
        rang(
          champ('Fournisseur (nom ou raison sociale)', 16, { v: d.fournisseur }),
          champ('NIU / RCCM du fournisseur', 8, { v: d.niuFournisseur }),
        ),
        rang(
          champ('Adresse, ville', 16, { v: d.adresse }),
          champ('Téléphone', 8, { v: d.telephone }),
        ),
        rang(
          champ('Date de la commande', 7, D(d.date)),
          champ('Livraison attendue le', 7, D(d.livraisonAttendue)),
          champ('Demande d’achat n°', 10, { v: d.demandeAchat }),
        ),
        rang(
          champ('Lieu de livraison (site, emplacement)', 14, { v: d.lieuLivraison }),
          champ('Établi par (achats)', 10, { v: d.etabliPar }),
        ),
        lignes({
          cols: [
            { t: 'Produit / désignation', w: '*' },
            { t: 'Unité', w: '17mm', al: 'c' },
            { t: 'Quantité commandée', w: '24mm', al: 'r' },
            { t: 'Prix unitaire (XAF)', w: '30mm', al: 'r' },
            { t: 'Montant (XAF)', w: '32mm', al: 'r' },
          ],
          n: N,
          h: 7,
          premierNumero: i * N + 1,
          rows: lot.map((l) => [
            l.designation,
            l.unite,
            l.quantite,
            xafPiece(l.prixUnitaire),
            xafPiece(l.montant),
          ]),
          total: {
            lib: 'Total de la commande (XAF)',
            v: i === feuilles.length - 1 ? [xafPiece(d.total)] : [],
          },
        }),
        cases('Prix', ['hors taxes', 'TVA incluse'], { coche: d.prix ? [d.prix] : [] }),
        cases('Paiement', PAIEMENTS_BC, { coche: d.paiement ? [d.paiement] : [] }),
        note(
          'Ce bon engage GIC AGROPELC sur les produits, quantités et prix indiqués. <b>Il ne prouve ni la livraison ni le paiement</b> : la livraison est constatée par un bon de réception, le règlement par un bon de décaissement ou une preuve de virement.',
        ),
        signatures(
          [
            { t: 'Établi par', s: 'achats', v: d.etabliPar },
            { t: 'Approuvé par', s: 'Direction / Finance si au-delà du seuil', v: d.approuvePar },
            { t: 'Le fournisseur', s: 'bon pour accord — cachet' },
          ],
          { h: 16 },
        ),
      ].join(''),
      ex: EX_FOURN,
      mention:
        'Bon de commande numéroté — à rappeler sur le bon de livraison et la facture du fournisseur',
    }),
  );
  return { code: 'BC', titre: 'Bon de commande fournisseur', fmt: 'a4p', pages };
}

// ------------------------------------------------------------------ BR
export interface LigneReception {
  readonly produit: string;
  readonly unite: string;
  readonly commande: string | null;
  readonly livre: string | null;
  readonly rejete: string | null;
  readonly accepte: string | null;
  readonly motifRejet: string | null;
  readonly lotFournisseur: string | null;
  readonly peremption: string | null;
}

export interface DonneesBR {
  readonly numero: string | null;
  readonly fournisseur: string | null;
  readonly bonDeCommande: string | null;
  readonly bonLivraisonFournisseur: string | null;
  readonly transporteur: string | null;
  readonly emplacement: string | null;
  readonly dateHeure: string | null;
  readonly receptionnaire: string | null;
  readonly lignes: readonly LigneReception[];
  readonly constat: 'conforme' | 'réserves (voir observations)' | 'refus total' | null;
  readonly photo: boolean | null;
  readonly observations: string | null;
  readonly saisie?: Saisie;
}

export function bonReception(d: DonneesBR, ctx: Contexte): PieceRendue {
  const N = 9;
  const feuilles = paginer(d.lignes, N);
  const jointe = 'jointe dans l’application';
  const indispo = 'indisponible (expliquer)';
  const pages = feuilles.map((lot, i) =>
    standard({
      fmt: 'a4p',
      code: 'BR',
      titre: 'Bon de réception',
      sous: 'Marchandises, intrants, animaux — livré, rejeté, accepté',
      numLib: 'BR N°',
      marges: { mh: 12 },
      n: d.numero,
      page: numeroPage(i, feuilles.length),
      ctx,
      corps: [
        rang(
          champ('Fournisseur', 14, { v: d.fournisseur }),
          champ('Bon de commande n° (ou « sans BC »)', 10, { v: d.bonDeCommande }),
        ),
        rang(
          champ('Bon de livraison du fournisseur n°', 12, { v: d.bonLivraisonFournisseur }),
          champ('Transporteur / véhicule', 12, { v: d.transporteur }),
        ),
        rang(
          champ('Site / emplacement de réception', 9, { v: d.emplacement }),
          champ('Date et heure de réception', 9, DH(d.dateHeure)),
          champ('Réceptionnaire', 6, { v: d.receptionnaire }),
        ),
        lignes({
          cols: [
            { t: 'Produit', w: '*' },
            { t: 'Unité', w: '14mm', al: 'c' },
            { t: 'Commandé', w: '17mm', al: 'r' },
            { t: 'Livré', w: '16mm', al: 'r' },
            { t: 'Rejeté', w: '16mm', al: 'r' },
            { t: 'Accepté (livré − rejeté)', w: '20mm', g: true, al: 'r' },
            { t: 'Motif du rejet', w: '30mm' },
            { t: 'N° de lot fournisseur', w: '24mm' },
            { t: 'Péremption', w: '20mm', al: 'c' },
          ],
          n: N,
          h: 7,
          premierNumero: i * N + 1,
          rows: lot.map((l) => [
            l.produit,
            l.unite,
            l.commande,
            l.livre,
            l.rejete,
            l.accepte,
            l.motifRejet,
            l.lotFournisseur,
            l.peremption,
          ]),
        }),
        cases('Constat', ['conforme', 'réserves (voir observations)', 'refus total'], {
          coche: d.constat ? [d.constat] : [],
        }),
        cases('Photo du bon de livraison', [jointe, indispo], {
          coche: d.photo === null ? [] : [d.photo ? jointe : indispo],
        }),
        champ('Observations (avaries, retards, écarts, état des animaux)', 24, {
          double: true,
          v: d.observations,
        }),
        note(
          '<b>Seule la quantité acceptée entre en stock.</b> Réception sans bon de commande, dépassement du commandé ou rejet : en informer le responsable des achats. La photo du bon de livraison est exigée dans les cas fixés par les paramètres de l’application.',
        ),
        signatures(
          [
            { t: 'Le réceptionnaire', s: 'a compté et accepté', v: d.receptionnaire },
            { t: 'Le livreur / fournisseur', s: 'a livré' },
            { t: 'Responsable du site', s: 'visa' },
          ],
          { h: 14 },
        ),
        rep(d.saisie),
      ].join(''),
      ex: EX3_DEST,
      mention:
        'Bon de réception numéroté — joindre le bon de livraison du fournisseur à l’exemplaire conservé',
    }),
  );
  return { code: 'BR', titre: 'Bon de réception', fmt: 'a4p', pages };
}

// ------------------------------------------------------------------ BT
export const NATURES_BT = [
  'transfert entre sites',
  'réapprovisionnement d’un PDV',
  'affectation de stock à un vendeur',
  'retour vers la source',
  'autre',
] as const;

export interface LigneTransfert {
  readonly produit: string;
  readonly lot: string | null;
  readonly unite: string;
  readonly expediee: string | null;
  readonly recue: string | null;
  readonly ecart: string | null;
  readonly motifEcart: string | null;
}

export interface DonneesBT {
  readonly numero: string | null;
  readonly nature: (typeof NATURES_BT)[number] | null;
  readonly origine: string | null;
  readonly destination: string | null;
  readonly expedieLe: string | null;
  readonly expediteur: string | null;
  readonly transporteur: string | null;
  readonly lignes: readonly LigneTransfert[];
  readonly recuLe: string | null;
  readonly receptionnaire: string | null;
  readonly constat: 'conforme' | 'écart à justifier' | 'refus' | null;
  readonly observations: string | null;
  readonly saisie?: Saisie;
}

export function bonTransfert(d: DonneesBT, ctx: Contexte): PieceRendue {
  const N = 9;
  const feuilles = paginer(d.lignes, N);
  const pages = feuilles.map((lot, i) =>
    standard({
      fmt: 'a4p',
      code: 'BT',
      titre: 'Bon de transfert de stock',
      sous: 'Expédition puis réception entre deux emplacements',
      numLib: 'BT N°',
      marges: { mh: 12 },
      n: d.numero,
      page: numeroPage(i, feuilles.length),
      ctx,
      corps: [
        cases('Nature', NATURES_BT, { coche: d.nature ? [d.nature] : [] }),
        rang(
          champ('Expédié de (emplacement d’origine)', 12, { v: d.origine }),
          champ('Vers (emplacement de destination)', 12, { v: d.destination }),
        ),
        rang(
          champ('Expédié le', 7, DH(d.expedieLe)),
          champ('Expéditeur (nom)', 8, { v: d.expediteur }),
          champ('Transporteur / véhicule', 9, { v: d.transporteur }),
        ),
        lignes({
          cols: [
            { t: 'Produit', w: '*' },
            { t: 'Lot / n° de lot', w: '24mm' },
            { t: 'Unité', w: '14mm', al: 'c' },
            { t: 'Quantité expédiée', w: '22mm', al: 'r' },
            { t: 'Quantité reçue', w: '22mm', g: true, al: 'r' },
            { t: 'Écart', w: '16mm', g: true, al: 'r' },
            { t: 'Motif de l’écart', w: '34mm', g: true },
          ],
          n: N,
          h: 6.8,
          premierNumero: i * N + 1,
          rows: lot.map((l) => [
            l.produit,
            l.lot,
            l.unite,
            l.expediee,
            l.recue,
            l.ecart,
            l.motifEcart,
          ]),
        }),
        section('À remplir à la réception par le destinataire'),
        rang(
          champ('Reçu le', 7, DH(d.recuLe)),
          champ('Réceptionnaire (nom)', 9, { v: d.receptionnaire }),
          cases('Constat', ['conforme', 'écart à justifier', 'refus'], {
            span: 8,
            coche: d.constat ? [d.constat] : [],
          }),
        ),
        champ('Observations', 24, { double: true, v: d.observations }),
        note(
          '<b>Un écart de transfert est une perte en transit à justifier</b> (produit, quantité, cause). Animaux vivants, œufs ou viande : joindre le document sanitaire de transport s’il est exigé (à vérifier auprès du service vétérinaire).',
        ),
        signatures(
          [
            { t: 'L’expéditeur', s: 'a remis', v: d.expediteur },
            { t: 'Le transporteur', s: 'a convoyé', v: d.transporteur },
            { t: 'Le destinataire', s: 'a reçu et compté', v: d.receptionnaire },
          ],
          { h: 15 },
        ),
        rep(d.saisie),
      ].join(''),
      ex: EX3_DEST,
      mention:
        'Bon de transfert numéroté — l’exemplaire jaune de l’expéditeur reste dans le carnet jusqu’à la réception confirmée',
    }),
  );
  return { code: 'BT', titre: 'Bon de transfert de stock', fmt: 'a4p', pages };
}

// ------------------------------------------------------------------ FP
export const CATEGORIES_FP = [
  'mortalité',
  'casse',
  'détérioration',
  'impropre à la vente',
  'destruction',
  'inexpliquée',
  'vol suspecté',
  'écart de transfert',
] as const;

export interface LignePerte {
  readonly produit: string;
  readonly unite: string;
  readonly quantite: string | null;
  readonly lot: string | null;
}

export interface DonneesFP {
  readonly numero: string | null;
  readonly nature: 'perte' | 'consommation' | null;
  readonly emplacement: string | null;
  readonly declarant: string | null;
  readonly dateHeure: string | null;
  /** Catégorie : cochée si elle figure sur la fiche, sinon écrite dans la cause. */
  readonly categorie: string | null;
  readonly lignes: readonly LignePerte[];
  readonly cause: string | null;
  readonly imputeA: string | null;
  readonly responsable: string | null;
  readonly photo: boolean | null;
  readonly saisie?: Saisie;
}

export function fichePerte(d: DonneesFP, ctx: Contexte): PieceRendue {
  const N = 7;
  const feuilles = paginer(d.lignes, N);
  const perte = 'perte (déclaration de perte)';
  const conso = 'consommation d’intrant';
  const categorie = CATEGORIES_FP.find((c) => c === d.categorie?.toLowerCase());
  const cause =
    !categorie && d.categorie ? [d.categorie, d.cause].filter(Boolean).join(' — ') : d.cause;
  const prise = 'prise (à joindre dans l’application)';
  const sans = 'pas de photo';
  const pages = feuilles.map((lot, i) =>
    standard({
      fmt: 'a5p',
      code: 'FP',
      titre: 'Fiche de perte',
      sous: 'ou consommation d’intrant',
      numLib: 'Fiche N°',
      marges: { mh: 12 },
      n: d.numero,
      page: numeroPage(i, feuilles.length),
      ctx,
      corps: [
        cases('Nature', [perte, conso], {
          coche: d.nature === 'perte' ? [perte] : d.nature === 'consommation' ? [conso] : [],
        }),
        rang(
          champ('Site / emplacement', 12, { v: d.emplacement }),
          champ('Déclarant (nom)', 12, { v: d.declarant }),
        ),
        rang(champ('Date et heure du constat', 24, DH(d.dateHeure))),
        cases('Catégorie', CATEGORIES_FP, { coche: categorie ? [categorie] : [] }),
        lignes({
          cols: [
            { t: 'Produit', w: '*' },
            { t: 'Unité', w: '14mm', al: 'c' },
            { t: 'Quantité', w: '18mm', al: 'r' },
            { t: 'Lot de production / lot de stock', w: '32mm' },
          ],
          n: N,
          h: 6.8,
          premierNumero: i * N + 1,
          rows: lot.map((l) => [l.produit, l.unite, l.quantite, l.lot]),
        }),
        champ('Cause, circonstances (obligatoire si inexpliquée ou vol suspecté)', 24, {
          double: true,
          v: cause,
        }),
        champ('Imputé à, si consommation (lot de production, site, PDV)', 24, { v: d.imputeA }),
        champ('Personne responsable, si identifiée', 24, { v: d.responsable }),
        cases('Photo', [prise, sans], { coche: d.photo === null ? [] : [d.photo ? prise : sans] }),
        signatures(
          [
            { t: 'Le déclarant', v: d.declarant },
            { t: 'Responsable du site' },
            { t: 'Validation', s: 'si requise' },
          ],
          { h: 13 },
        ),
        rep(d.saisie),
      ].join(''),
      ex: EX2,
      mention:
        'Une mortalité se rattache toujours à un lot de production — la photo est jointe si la politique de contrôle l’exige',
    }),
  );
  return { code: 'FP', titre: 'Fiche de perte', fmt: 'a5p', pages };
}

// ------------------------------------------------------------------ FI
export interface LigneInventaire {
  readonly produit: string;
  readonly lot: string | null;
  readonly unite: string;
  readonly theorique: string | null;
  readonly physique: string | null;
  readonly ecart: string | null;
  readonly motif: string | null;
}

export interface DonneesFI {
  readonly numero: string | null;
  readonly emplacement: string | null;
  readonly dateHeure: string | null;
  readonly compteur1: string | null;
  readonly compteur2: string | null;
  readonly type: 'périodique' | 'd’ouverture' | 'tournant / surprise' | null;
  readonly lignes: readonly LigneInventaire[];
  readonly responsable: string | null;
  readonly saisie?: Saisie;
}

export function ficheInventaire(d: DonneesFI, ctx: Contexte): PieceRendue {
  const N = 21;
  const feuilles = paginer(d.lignes, N);
  const pages = feuilles.map((lot, i) =>
    standard({
      fmt: 'a4p',
      code: 'FI',
      titre: 'Fiche d’inventaire',
      sous: 'Comptage physique d’un emplacement',
      numLib: 'Fiche N°',
      marges: { mh: 12 },
      annule: false,
      n: d.numero,
      page: numeroPage(i, feuilles.length),
      ctx,
      corps: [
        rang(
          champ('Emplacement compté', 9, { v: d.emplacement }),
          champ('Date et heure du comptage', 8, DH(d.dateHeure)),
          champ('Compteur 1', 7, { v: d.compteur1 }),
        ),
        rang(
          cases('Type', ['périodique', 'd’ouverture', 'tournant / surprise'], {
            span: 16,
            coche: d.type ? [d.type] : [],
          }),
          champ('Compteur 2', 8, { v: d.compteur2 }),
        ),
        lignes({
          cols: [
            { t: 'Produit', w: '*' },
            { t: 'Lot', w: '22mm' },
            { t: 'Unité', w: '14mm', al: 'c' },
            { t: 'Stock théorique (reporté après comptage)', w: '28mm', g: true, al: 'r' },
            { t: 'Stock physique compté', w: '24mm', al: 'r' },
            { t: 'Écart', w: '18mm', g: true, al: 'r' },
            { t: 'Motif de l’écart', w: '38mm' },
          ],
          n: N,
          h: 6.4,
          premierNumero: i * N + 1,
          rows: lot.map((l) => [
            l.produit,
            l.lot,
            l.unite,
            l.theorique,
            l.physique,
            l.ecart,
            l.motif,
          ]),
        }),
        note(
          '<b>Comptage à l’aveugle :</b> écrire le stock physique avant de connaître le stock théorique. L’écart est justifié, jamais effacé ; au-delà du seuil d’approbation, la validation du responsable est demandée.',
        ),
        signatures(
          [
            { t: 'Compteur 1', v: d.compteur1 },
            { t: 'Compteur 2', v: d.compteur2 },
            { t: 'Responsable de l’emplacement', v: d.responsable },
          ],
          { h: 13 },
        ),
        rep(d.saisie),
      ].join(''),
      ex: '',
      mention:
        'Une fiche par emplacement et par comptage — conserver avec le rapport de régularisation',
    }),
  );
  return { code: 'FI', titre: 'Fiche d’inventaire', fmt: 'a4p', pages };
}

// ------------------------------------------------------------------ FL
export const TYPES_LOT_FL = [
  'poulet de chair',
  'pondeuse',
  'porc d’engraissement',
  'autre',
] as const;

/** Une ligne par jour, dans l'ordre des colonnes de la fiche (sans le jour). */
export interface JourLot {
  readonly jour: string;
  readonly date: string | null;
  readonly mortaliteNombre: string | null;
  readonly mortaliteCause: string | null;
  readonly alimentProduit: string | null;
  readonly alimentKg: string | null;
  readonly peseeEchantillon: string | null;
  readonly peseePoidsMoyenG: string | null;
  readonly oeufsCollectes: string | null;
  readonly oeufsCasses: string | null;
  readonly oeufsNonConformes: string | null;
  readonly oeufsCommercialisables: string | null;
  readonly oeufsACouver: string | null;
  readonly observations: string | null;
}

export interface DonneesFL {
  readonly numero: string | null;
  readonly lot: string | null;
  readonly typeLot: (typeof TYPES_LOT_FL)[number] | null;
  readonly batiment: string | null;
  readonly semaineDu: string | null;
  readonly au: string | null;
  readonly effectifDebut: string | null;
  /** Les sept jours, du lundi au dimanche (jour sans saisie : valeurs nulles). */
  readonly jours: readonly JourLot[];
  readonly totaux: readonly Valeur[];
  readonly evenements: string | null;
  readonly saisie?: Saisie;
}

export const JOURS_SEMAINE = [
  'Lundi',
  'Mardi',
  'Mercredi',
  'Jeudi',
  'Vendredi',
  'Samedi',
  'Dimanche',
] as const;

export function ficheSuiviLot(d: DonneesFL, ctx: Contexte): PieceRendue {
  const prefill = JOURS_SEMAINE.map((j, i) => {
    const date = d.jours[i]?.date;
    return `${j} <span style="font-weight:400;color:var(--gris)">${date ? date.slice(0, 5).replace(/[<>&]/g, '') : '…/…'}</span>`;
  });
  const page = standard({
    fmt: 'a4l',
    code: 'FL',
    titre: 'Suivi de lot de production',
    sous: 'Saisie du jour — une ligne par jour',
    numLib: 'Fiche N°',
    annule: false,
    marges: { mh: 11 },
    n: d.numero,
    ctx,
    corps: [
      rang(
        champ('Lot de production n°', 8, { v: d.lot }),
        cases('Type de lot', TYPES_LOT_FL, { span: 16, coche: d.typeLot ? [d.typeLot] : [] }),
      ),
      rang(
        champ('Bâtiment / case', 8, { v: d.batiment }),
        champ('Semaine du', 6, d.semaineDu ? { v: d.semaineDu } : { aide: '…/…/20…' }),
        champ('au', 4, d.au ? { v: d.au } : { aide: '…/…/20…' }),
        champ('Effectif en début de semaine', 6, { v: d.effectifDebut, num: true }),
      ),
      lignes({
        numerote: false,
        prefill,
        h: 10.6,
        n: 7,
        cols: [
          { t: 'Jour', w: '27mm' },
          { t: 'Mortalité : nombre', w: '15mm', al: 'r' },
          { t: 'Mortalité : cause', w: '23mm' },
          { t: 'Aliment : produit', w: '28mm' },
          { t: 'Aliment : quantité (kg)', w: '17mm', al: 'r' },
          { t: 'Pesée : échantillon', w: '16mm', al: 'r' },
          { t: 'Pesée : poids moyen (g)', w: '17mm', al: 'r' },
          { t: 'Œufs collectés', w: '15mm', al: 'r' },
          { t: 'Œufs cassés', w: '13mm', al: 'r' },
          { t: 'Œufs non conformes', w: '16mm', al: 'r' },
          { t: 'Œufs commerciali-sables', w: '19mm', al: 'r' },
          { t: 'Œufs à couver', w: '13mm', al: 'r' },
          { t: 'Observations (santé, vaccin, incident)', w: '*' },
          { t: 'Visa', w: '12mm' },
        ],
        rows: d.jours.map((j) => [
          null,
          j.mortaliteNombre,
          j.mortaliteCause,
          j.alimentProduit,
          j.alimentKg,
          j.peseeEchantillon,
          j.peseePoidsMoyenG,
          j.oeufsCollectes,
          j.oeufsCasses,
          j.oeufsNonConformes,
          j.oeufsCommercialisables,
          j.oeufsACouver,
          j.observations,
          null,
        ]),
        total: { lib: 'Total de la semaine', span: 1, v: d.totaux },
      }),
      champ('Traitements, vaccins, événements marquants de la semaine', 24, {
        double: true,
        v: d.evenements,
      }),
      signatures([{ t: 'Responsable du bâtiment' }, { t: 'Chef d’exploitation / vétérinaire' }], {
        h: 12,
      }),
      rep(d.saisie),
    ].join(''),
    mention:
      'Chaque ligne se reporte comme une saisie du jour du lot : mortalité, aliment, pesée, collecte d’œufs, observation',
  });
  return { code: 'FL', titre: 'Suivi de lot de production', fmt: 'a4l', pages: [page] };
}
