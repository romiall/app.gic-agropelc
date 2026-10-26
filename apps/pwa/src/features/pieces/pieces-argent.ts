/**
 * Pièces d'argent remplies par l'application : bon de vente (BV), reçu d'encaissement (RE), bon de
 * décaissement (BD), remise de fonds (RF), feuille journalière de caisse (FJC), journal des
 * encaissements (JE), facture (FA). Rubriques, ordre et dimensions : ceux de
 * `pieces-papier/_generation/p-caisse.mjs` et `p-caisse2.mjs`, à l'identique.
 */
import { amountXafInFrenchWords } from '@gic/domain';
import {
  bloc,
  cases,
  champ,
  type Contexte,
  dateHeure,
  lettres,
  lignes,
  montant,
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
import { MOYENS, xafPiece } from './format.js';
import type { PieceRendue } from './piece.js';

const EX3 =
  '① blanc : client — ② rose : comptabilité — ③ jaune : reste dans le carnet (souche complète)';
const EX2 = '① blanc : Finance / comptabilité — ② jaune : reste dans le bloc';
/** Marges de la pièce à souche du carnet (`avecSouche`). */
const SOUCHE = { mg: 9 } as const;

const enLettres = (m: number | null | undefined): string | null =>
  m === null || m === undefined ? null : amountXafInFrenchWords(Math.max(0, Math.round(m)));
const ligneRef = (lib: string, span = 24, v?: Valeur) =>
  champ(lib, span, v ? { v } : { aide: 'obligatoire hors espèces' });

/** Saisie de l'opération dans l'application (cartouche « Report dans l'application »). */
export interface Saisie {
  readonly le?: string | null;
  readonly par?: string | null;
  readonly numero?: string | null;
}

// ------------------------------------------------------------------ BV
export interface LigneVente {
  readonly designation: string;
  readonly unite: string;
  readonly quantite: string | null;
  readonly poidsKg?: string | null;
  readonly prixUnitaire: number | null;
  readonly remise: number | null;
  readonly montant: number | null;
}

export interface DonneesBV {
  readonly numero: string | null;
  readonly client: string | null;
  readonly telephone: string | null;
  readonly anonyme: boolean;
  readonly pointDeVente: string | null;
  readonly dateHeure: string | null;
  readonly vendeur: string | null;
  readonly lignes: readonly LigneVente[];
  readonly total: number | null;
  /** Moyens de paiement cochés (libellés de `MOYENS`). */
  readonly moyens: readonly string[];
  readonly encaisse: number | null;
  readonly reference: string | null;
  readonly resteDu: number | null;
}

export function bonDeVente(d: DonneesBV, ctx: Contexte): PieceRendue {
  const N = 5;
  const feuilles = paginer(d.lignes, N);
  const pages = feuilles.map((lot, i) => {
    const derniere = i === feuilles.length - 1;
    return standard({
      fmt: 'a5l',
      code: 'BV',
      titre: 'Bon de vente',
      sous: 'Vente de secours — application indisponible',
      marges: SOUCHE,
      n: d.numero,
      page: numeroPage(i, feuilles.length),
      ctx,
      corps: [
        rang(
          champ('Client (nom ou raison sociale)', 12, { v: d.client }),
          champ('Téléphone', 6, { v: d.telephone }),
          cases('', ['client anonyme'], { span: 6, coche: d.anonyme ? ['client anonyme'] : [] }),
        ),
        rang(
          champ('Point de vente', 8, { v: d.pointDeVente }),
          dateHeure('Date et heure', 10, d.dateHeure),
          champ('Vendeur', 6, { v: d.vendeur }),
        ),
        lignes({
          cols: [
            { t: 'Désignation du produit', w: '*' },
            { t: 'Unité', w: '15mm', al: 'c' },
            { t: 'Quantité', w: '17mm', al: 'r' },
            { t: 'Poids (kg)', w: '15mm', al: 'r' },
            { t: 'Prix unitaire (XAF)', w: '22mm', al: 'r' },
            { t: 'Remise (XAF)', w: '17mm', al: 'r' },
            { t: 'Montant (XAF)', w: '24mm', al: 'r' },
          ],
          n: N,
          h: 6.2,
          premierNumero: i * N + 1,
          rows: lot.map((l) => [
            l.designation,
            l.unite,
            l.quantite,
            l.poidsKg ?? null,
            xafPiece(l.prixUnitaire),
            l.remise ? xafPiece(l.remise) : null,
            xafPiece(l.montant),
          ]),
          total: { lib: 'Total à payer (XAF)', v: derniere ? [xafPiece(d.total)] : [] },
        }),
        cases('Paiement', MOYENS, { coche: d.moyens }),
        rang(
          champ('Montant encaissé', 8, { u: 'XAF', v: xafPiece(d.encaisse), num: true }),
          champ('Réf. transaction / chèque', 9, { v: d.reference }),
          champ('Reste dû (crédit)', 7, { u: 'XAF', v: xafPiece(d.resteDu), num: true }),
        ),
        signatures(
          [
            { t: 'Le client', s: 'nom et signature', v: d.anonyme ? null : d.client },
            { t: 'Le vendeur', s: 'nom et signature', v: d.vendeur },
            { t: 'Cachet', cachet: true, nom: false },
          ],
          { h: 12 },
        ),
      ].join(''),
      ex: EX3,
    });
  });
  return { code: 'BV', titre: 'Bon de vente', fmt: 'a5l', pages };
}

// ------------------------------------------------------------------ RE
export type ObjetEncaissement = 'vente' | 'acompte' | 'autre';

export interface DonneesRE {
  readonly numero: string | null;
  readonly recuDe: string | null;
  readonly telephone: string | null;
  readonly site: string | null;
  readonly dateHeure: string | null;
  readonly montant: number | null;
  readonly resteDu: number | null;
  readonly moyen: string | null;
  readonly reference: string | null;
  readonly objet: ObjetEncaissement | null;
  /** Numéro de la vente ou de la commande réglée, ou objet libre (« autre »). */
  readonly objetNumero: string | null;
  readonly caissier: string | null;
}

export function recuEncaissement(d: DonneesRE, ctx: Contexte): PieceRendue {
  const vente = 'règlement de la vente n° ………';
  const acompte = 'acompte sur la commande n° ………';
  const autre = 'autre : ………';
  const avec = (gabarit: string) =>
    d.objetNumero ? gabarit.replace('………', d.objetNumero) : gabarit;
  const options = [
    d.objet === 'vente' ? avec(vente) : vente,
    d.objet === 'acompte' ? avec(acompte) : acompte,
    d.objet === 'autre' ? avec(autre) : autre,
  ];
  const coche =
    d.objet === null ? [] : [options[d.objet === 'vente' ? 0 : d.objet === 'acompte' ? 1 : 2]!];
  const page = standard({
    fmt: 'a5l',
    code: 'RE',
    titre: 'Reçu d’encaissement',
    sous: 'Pièce de caisse',
    marges: SOUCHE,
    n: d.numero,
    h: 8.4,
    ctx,
    corps: [
      rang(
        champ('Reçu de (nom ou raison sociale)', 16, { v: d.recuDe }),
        champ('Téléphone', 8, { v: d.telephone }),
      ),
      rang(
        champ('Point de vente / site', 10, { v: d.site }),
        dateHeure('Date et heure', 14, d.dateHeure),
      ),
      rang(
        montant('Montant reçu', 13, xafPiece(d.montant)),
        champ('Reste dû après ce paiement', 11, { u: 'XAF', v: xafPiece(d.resteDu), num: true }),
      ),
      cases('Mode de paiement', MOYENS, { coche: d.moyen ? [d.moyen] : [] }),
      rang(ligneRef('Réf. transaction / n° du chèque', 24, d.reference)),
      lettres('Arrêté le présent reçu à la somme de (en lettres)', 24, 1, enLettres(d.montant)),
      cases('Pour', options, { coche }),
      signatures(
        [
          { t: 'Le client (payeur)', s: 'nom et signature', v: d.recuDe },
          { t: 'Le caissier', s: 'nom et signature', v: d.caissier },
          { t: 'Cachet', cachet: true, nom: false },
        ],
        { h: 14 },
      ),
    ].join(''),
    ex: EX3,
  });
  return { code: 'RE', titre: 'Reçu d’encaissement', fmt: 'a5l', pages: [page] };
}

// ------------------------------------------------------------------ BD
export const NATURES_BD = [
  'dépense',
  'paiement fournisseur',
  'avance fournisseur',
  'remboursement client',
  'autre',
] as const;
export const CATEGORIES_BD = [
  'Aliment hors stock',
  'Vétérinaire',
  'Transport',
  'Carburant',
  'Énergie et eau',
  'Main-d’œuvre occasionnelle',
  'Entretien',
  'Fournitures',
  'Divers',
] as const;
export const JUSTIFICATIFS_BD = [
  'facture',
  'reçu',
  'bon de livraison',
  'aucun (expliquer)',
] as const;

export interface DonneesBD {
  readonly numero: string | null;
  readonly beneficiaire: string | null;
  readonly pieceIdentite: string | null;
  readonly caisse: string | null;
  readonly dateHeure: string | null;
  readonly etabliPar: string | null;
  readonly nature: (typeof NATURES_BD)[number] | null;
  /** Catégorie du référentiel : cochée si elle figure sur la pièce, sinon écrite dans l'objet. */
  readonly categorie: string | null;
  readonly objet: string | null;
  readonly imputeA: string | null;
  readonly factureOuBc: string | null;
  readonly montant: number | null;
  readonly justificatifs: readonly string[];
  readonly autorisePar: string | null;
}

export function bonDecaissement(d: DonneesBD, ctx: Contexte): PieceRendue {
  const categorie = CATEGORIES_BD.find((c) => c.toLowerCase() === d.categorie?.toLowerCase());
  const objet =
    !categorie && d.categorie ? [d.categorie, d.objet].filter(Boolean).join(' — ') : d.objet;
  const page = standard({
    fmt: 'a5l',
    code: 'BD',
    titre: 'Bon de décaissement',
    sous: 'Pièce de caisse — sortie d’argent',
    marges: SOUCHE,
    n: d.numero,
    ctx,
    corps: [
      rang(
        champ('Payé à (bénéficiaire)', 15, { v: d.beneficiaire }),
        champ('Pièce d’identité n°', 9, { v: d.pieceIdentite }),
      ),
      rang(
        champ('Caisse / site', 8, { v: d.caisse }),
        dateHeure('Date et heure', 10, d.dateHeure),
        champ('Établi par', 6, { v: d.etabliPar }),
      ),
      cases('Nature', NATURES_BD, { coche: d.nature ? [d.nature] : [] }),
      cases('Catégorie', CATEGORIES_BD, { coche: categorie ? [categorie] : [] }),
      rang(champ('Objet détaillé de la sortie', 24, { double: true, v: objet })),
      rang(
        champ('Imputé à (lot de production, site, PDV)', 13, { v: d.imputeA }),
        champ('Facture / bon de commande n°', 11, { v: d.factureOuBc }),
      ),
      rang(
        montant('Montant payé', 11, xafPiece(d.montant)),
        lettres('En lettres', 13, 1, enLettres(d.montant)),
      ),
      cases('Justificatifs joints', JUSTIFICATIFS_BD, { coche: d.justificatifs }),
      signatures(
        [
          { t: 'Le bénéficiaire', s: 'a reçu la somme', v: d.beneficiaire },
          { t: 'Le caissier', s: 'a payé', v: d.etabliPar },
          { t: 'Autorisé par', s: 'visa du responsable', v: d.autorisePar },
        ],
        { h: 12 },
      ),
    ].join(''),
    ex: EX3,
  });
  return { code: 'BD', titre: 'Bon de décaissement', fmt: 'a5l', pages: [page] };
}

// ------------------------------------------------------------------ RF
export const ORIGINES_RF = [
  'caisse du PDV',
  'caisse d’un utilisateur',
  'caisse centrale',
  'mobile money',
] as const;
export const DESTINATIONS_RF = ['caisse centrale', 'banque (dépôt n° ………)'] as const;

export interface DonneesRF {
  readonly numero: string | null;
  readonly remettant: string | null;
  readonly origine: string | null;
  readonly destinataire: string | null;
  readonly destination: string | null;
  readonly de: (typeof ORIGINES_RF)[number] | null;
  readonly vers: 'caisse centrale' | 'banque' | null;
  readonly depot: string | null;
  readonly session: string | null;
  readonly envoyeLe: string | null;
  readonly montantEnvoye: number | null;
  readonly recuLe: string | null;
  readonly montantRecu: number | null;
  readonly ecart: number | null;
  readonly motifEcart: string | null;
}

export function remiseDeFonds(d: DonneesRF, ctx: Contexte): PieceRendue {
  const banque = d.depot ? `banque (dépôt n° ${d.depot})` : DESTINATIONS_RF[1];
  const page = standard({
    fmt: 'a5l',
    code: 'RF',
    titre: 'Remise de fonds',
    sous: 'Bordereau — envoi puis réception',
    marges: SOUCHE,
    n: d.numero,
    ctx,
    corps: [
      rang(
        champ('Remettant (nom, fonction)', 14, { v: d.remettant }),
        champ('Site / caisse d’origine', 10, { v: d.origine }),
      ),
      rang(
        champ('Destinataire (nom, fonction)', 14, { v: d.destinataire }),
        champ('Site / compte de destination', 10, { v: d.destination }),
      ),
      cases('De', ORIGINES_RF, { coche: d.de ? [d.de] : [] }),
      cases('Vers', [DESTINATIONS_RF[0], banque], {
        coche:
          d.vers === 'caisse centrale' ? [DESTINATIONS_RF[0]] : d.vers === 'banque' ? [banque] : [],
      }),
      rang(
        champ('Session de caisse n° / période', 12, { v: d.session }),
        dateHeure('Envoyé le', 12, d.envoyeLe),
      ),
      rang(
        montant('Montant envoyé', 11, xafPiece(d.montantEnvoye)),
        lettres('En lettres', 13, 1, enLettres(d.montantEnvoye)),
      ),
      section('À remplir à la réception par le destinataire'),
      rang(
        dateHeure('Reçu le', 12, d.recuLe),
        champ('Montant reçu', 12, { u: 'XAF', v: xafPiece(d.montantRecu), num: true }),
      ),
      rang(
        champ('Écart (envoyé − reçu)', 9, {
          u: 'XAF',
          v: d.ecart === null ? null : xafPiece(d.ecart),
          num: true,
        }),
        champ('Motif de l’écart', 15, { v: d.motifEcart }),
      ),
      signatures(
        [
          { t: 'Le remettant', s: 'a envoyé', v: d.remettant },
          { t: 'Le destinataire', s: 'a reçu et compté', v: d.destinataire },
          { t: 'Cachet', cachet: true, nom: false },
        ],
        { h: 12 },
      ),
    ].join(''),
    ex: EX3,
  });
  return { code: 'RF', titre: 'Remise de fonds', fmt: 'a5l', pages: [page] };
}

// ------------------------------------------------------------------ FJC
export interface LigneJournalCaisse {
  readonly heure: string | null;
  readonly piece: string | null;
  readonly libelle: string | null;
  readonly mode: string | null;
  readonly entree: number | null;
  readonly sortie: number | null;
}

export interface DonneesFJC {
  readonly numero: string | null;
  readonly site: string | null;
  readonly caisse: 'du PDV' | 'du commercial' | 'centrale' | null;
  readonly jour: string | null;
  readonly caissier: string | null;
  readonly controleur: string | null;
  readonly session: string | null;
  readonly fondsOuverture: number | null;
  readonly lignes: readonly LigneJournalCaisse[];
  /** Rapprochement des espèces : connu seulement pour une caisse en espèces. */
  readonly entreesEspeces: number | null;
  readonly sortiesEspeces: number | null;
  readonly soldeTheorique: number | null;
  readonly especesComptees: number | null;
  readonly ecart: number | null;
  readonly motifEcart: string | null;
  readonly entreesHorsEspeces: number | null;
  readonly saisie?: Saisie;
}

export function feuilleJournaliereCaisse(d: DonneesFJC, ctx: Contexte): PieceRendue {
  const N = 28;
  const feuilles = paginer(d.lignes, N);
  const totalEntrees = d.lignes.reduce((s, l) => s + (l.entree ?? 0), 0);
  const totalSorties = d.lignes.reduce((s, l) => s + (l.sortie ?? 0), 0);
  const x = (m: number | null) => xafPiece(m);
  const pages = feuilles.map((lot, i) => {
    const derniere = i === feuilles.length - 1;
    const pageEntrees = lot.reduce((s, l) => s + (l.entree ?? 0), 0);
    const pageSorties = lot.reduce((s, l) => s + (l.sortie ?? 0), 0);
    return standard({
      fmt: 'a4p',
      code: 'FJC',
      titre: 'Feuille journalière de caisse',
      sous: 'Journal chronologique des entrées et des sorties',
      numLib: 'Feuille N°',
      marges: { mh: 12 },
      n: d.numero,
      page: numeroPage(i, feuilles.length),
      ctx,
      corps: [
        rang(
          champ('Site / point de vente', 8, { v: d.site }),
          cases('Caisse', ['du PDV', 'du commercial', 'centrale'], {
            span: 11,
            coche: d.caisse ? [d.caisse] : [],
          }),
          champ('Jour', 5, d.jour ? { v: d.jour } : { aide: '…/…/20…' }),
        ),
        rang(
          champ('Caissier(ère) ou commercial', 7, { v: d.caissier }),
          champ('Contrôleur(se)', 7, { v: d.controleur }),
          champ('Session n°', 4, { v: d.session }),
          champ('Fonds d’ouverture compté', 6, { u: 'XAF', v: x(d.fondsOuverture), num: true }),
        ),
        lignes({
          cols: [
            { t: 'Heure', w: '12mm', al: 'c' },
            { t: 'N° de la pièce (RE, BV, BD, RF…)', w: '30mm' },
            { t: 'Client, bénéficiaire ou objet', w: '*' },
            { t: 'Mode E O M V C', w: '14mm', al: 'c' },
            { t: 'ENTRÉE (XAF)', w: '27mm', al: 'r' },
            { t: 'SORTIE (XAF)', w: '27mm', al: 'r' },
          ],
          n: N,
          h: 5.3,
          premierNumero: i * N + 1,
          rows: lot.map((l) => [l.heure, l.piece, l.libelle, l.mode, x(l.entree), x(l.sortie)]),
          total: {
            lib: derniere ? 'Totaux de la journée' : 'Totaux de la feuille',
            span: 5,
            v: derniere ? [x(totalEntrees), x(totalSorties)] : [x(pageEntrees), x(pageSorties)],
          },
        }),
        `<div class="rang" style="align-items:start">
        <div class="c12" style="display:grid;gap:.6mm;--h:6.1mm">
          ${section('Rapprochement des espèces')}
          ${champ('Fonds d’ouverture compté', 12, { u: 'XAF', v: x(d.fondsOuverture), num: true })}
          ${champ('+ Entrées en espèces', 12, { u: 'XAF', v: x(d.entreesEspeces), num: true })}
          ${champ('− Sorties en espèces (remises de fonds comprises)', 12, { u: 'XAF', v: x(d.sortiesEspeces), num: true })}
          ${champ('= Solde théorique des espèces', 12, { u: 'XAF', v: x(d.soldeTheorique), num: true })}
        </div>
        <div class="c12" style="display:grid;gap:.6mm;--h:6.1mm">
          ${section('Contrôle')}
          ${champ('Espèces comptées', 12, { u: 'XAF', v: x(d.especesComptees), num: true })}
          ${champ('ÉCART  (compté − théorique)', 12, { u: 'XAF', v: d.ecart === null ? null : signe(d.ecart), num: true })}
          ${champ('Motif de l’écart', 12, { v: d.motifEcart })}
          ${champ('Entrées hors espèces (O, M, V, C)', 12, { u: 'XAF', v: x(d.entreesHorsEspeces), num: true })}
        </div></div>`,
        signatures(
          [
            { t: 'Le caissier', s: 'a compté et clôturé', v: d.caissier },
            { t: 'Le contrôleur', s: 'a vérifié', v: d.controleur },
            { t: 'Finance', s: 'écart : ☐ validé  ☐ à justifier' },
          ],
          { h: 10.5 },
        ),
        report({ extra: '', saisiLe: d.saisie?.le, par: d.saisie?.par, numero: d.saisie?.numero }),
      ].join(''),
      ex: EX2,
      mention:
        'Mode : E espèces · O Orange Money · M MTN Mobile Money · V virement · C chèque. L’argent qui entre s’écrit dans ENTRÉE, celui qui sort dans SORTIE. Une feuille par caisse et par jour ; tout écart est écrit et justifié, jamais effacé.',
    });
  });
  return { code: 'FJC', titre: 'Feuille journalière de caisse', fmt: 'a4p', pages };
}

/** Écart signé : « +1 500 » ou « −2 000 ». */
function signe(m: number): string {
  const abs = xafPiece(Math.abs(m)) ?? '0';
  return m > 0 ? `+${abs}` : m < 0 ? `−${abs}` : abs;
}

// ------------------------------------------------------------------ JE
export interface LigneJournalEncaissements {
  readonly date: string | null;
  readonly piece: string | null;
  readonly objet: string | null;
  /** Montant par colonne de mode, dans l'ordre : espèces, Orange, MTN, virement, chèque. */
  readonly parMode: readonly [
    number | null,
    number | null,
    number | null,
    number | null,
    number | null,
  ];
}

export interface DonneesJE {
  readonly numero: string | null;
  readonly site: string | null;
  readonly du: string | null;
  readonly au: string | null;
  readonly tenuPar: string | null;
  readonly lignes: readonly LigneJournalEncaissements[];
}

export function journalEncaissements(d: DonneesJE, ctx: Contexte): PieceRendue {
  const N = 30;
  const feuilles = paginer(d.lignes, N);
  const somme = (ls: readonly LigneJournalEncaissements[]) =>
    [0, 1, 2, 3, 4].map((k) => ls.reduce((s, l) => s + (l.parMode[k] ?? 0), 0));
  const avecTotal = (cols: number[]) =>
    [...cols, cols.reduce((a, b) => a + b, 0)].map((m) => xafPiece(m));
  let reporte = [0, 0, 0, 0, 0];
  const pages = feuilles.map((lot, i) => {
    const page = somme(lot);
    const cumul = page.map((m, k) => m + reporte[k]!);
    const html = standard({
      fmt: 'a4p',
      code: 'JE',
      titre: 'Journal des encaissements',
      sous: 'Registre — une ligne par encaissement',
      numLib: 'Page N°',
      marges: { mh: 12, mg: 14 },
      annule: false,
      n: d.numero
        ? feuilles.length > 1
          ? `${d.numero}-${i + 1}`
          : d.numero
        : feuilles.length > 1
          ? String(i + 1)
          : null,
      ctx,
      mention:
        'Reconstitué chaque jour à partir des reçus d’encaissement et des bons de vente — ne jamais laisser de ligne vide entre deux écritures',
      corps: [
        rang(
          champ('Site / point de vente', 10, { v: d.site }),
          champ('Période du', 6, d.du ? { v: d.du } : { aide: '…/…/20…' }),
          champ('au', 4, d.au ? { v: d.au } : { aide: '…/…/20…' }),
          champ('Tenu par', 4, { v: d.tenuPar }),
        ),
        lignes({
          cols: [
            { t: 'Date', w: '15mm', al: 'c' },
            { t: 'N° pièce (RE / BV)', w: '23mm' },
            { t: 'Client / objet (vente ou commande n°)', w: '*' },
            { t: 'Espèces', w: '20mm', al: 'r' },
            { t: 'Orange Money', w: '20mm', al: 'r' },
            { t: 'MTN MoMo', w: '20mm', al: 'r' },
            { t: 'Virement', w: '20mm', al: 'r' },
            { t: 'Chèque', w: '18mm', al: 'r' },
            { t: 'Total (XAF)', w: '22mm', al: 'r' },
          ],
          n: N,
          h: 6.3,
          premierNumero: i * N + 1,
          rows: lot.map((l) => {
            const total = l.parMode.reduce<number>((s, m) => s + (m ?? 0), 0);
            return [
              l.date,
              l.piece,
              l.objet,
              ...l.parMode.map((m) => (m ? xafPiece(m) : null)),
              xafPiece(total),
            ];
          }),
          total: [
            { lib: 'Total de la page', span: 4, v: avecTotal(page) },
            { lib: 'Report des pages précédentes', span: 4, v: avecTotal(reporte) },
            { lib: 'Total à reporter', span: 4, v: avecTotal(cumul) },
          ],
        }),
      ].join(''),
    });
    reporte = cumul;
    return html;
  });
  return { code: 'JE', titre: 'Journal des encaissements', fmt: 'a4p', pages };
}

// ------------------------------------------------------------------ FA
export interface LigneFacture {
  readonly designation: string;
  readonly unite: string;
  readonly quantite: string | null;
  readonly prixUnitaireHt: number | null;
  readonly tauxTva: string | null;
  readonly montantHt: number | null;
}

export interface DonneesFA {
  readonly numero: string | null;
  readonly dateEmission: string | null;
  readonly echeance: string | null;
  readonly venteOuCommande: string | null;
  readonly client: string | null;
  readonly niuClient: string | null;
  readonly adresse: string | null;
  readonly telephone: string | null;
  readonly lignes: readonly LigneFacture[];
  readonly regimeTva: 'TVA applicable' | 'opération exonérée de TVA' | null;
  readonly mentionExoneration: string | null;
  readonly totalHt: number | null;
  readonly tva: number | null;
  readonly totalTtc: number | null;
  readonly acompte: number | null;
  readonly netAPayer: number | null;
  readonly banque: string | null;
  readonly compte: string | null;
  readonly mobileMoney: string | null;
  readonly vendeur: string | null;
}

export function facture(d: DonneesFA, ctx: Contexte): PieceRendue {
  const N = 14;
  const feuilles = paginer(d.lignes, N);
  const blanc = (v: string | null) =>
    v ? `<span class="val">${esc2(v)}</span>` : '<span class="blanc l"></span>';
  const x = (m: number | null) => ({ u: 'XAF', v: xafPiece(m), num: true });
  const pages = feuilles.map((lot, i) => {
    const derniere = i === feuilles.length - 1;
    return standard({
      fmt: 'a4p',
      code: 'FA',
      titre: 'Facture',
      // Modèle validé par le comptable (porteur, 26/10/2026) : la mention « modèle provisoire » du
      // gabarit n'est pas imprimée.
      sous: '',
      numLib: 'Facture N°',
      marges: { mh: 12 },
      n: d.numero,
      page: numeroPage(i, feuilles.length),
      ctx,
      corps: [
        rang(
          champ(
            'Date d’émission',
            8,
            d.dateEmission ? { v: d.dateEmission } : { aide: 'jj / mm / aaaa' },
          ),
          champ('Échéance', 7, d.echeance ? { v: d.echeance } : { aide: 'jj / mm / aaaa' }),
          champ('Bon de vente / commande n°', 9, { v: d.venteOuCommande }),
        ),
        bloc(
          'Client',
          [
            rang(
              champ('Nom ou raison sociale', 15, { v: d.client }),
              champ(
                'NIU du client',
                9,
                d.niuClient ? { v: d.niuClient } : { aide: 'si assujetti' },
              ),
            ),
            rang(champ('Adresse', 15, { v: d.adresse }), champ('Téléphone', 9, { v: d.telephone })),
          ].join('<div style="height:1mm"></div>'),
        ),
        lignes({
          cols: [
            { t: 'Désignation', w: '*' },
            { t: 'Unité', w: '17mm', al: 'c' },
            { t: 'Quantité', w: '19mm', al: 'r' },
            { t: 'Prix unitaire HT (XAF)', w: '30mm', al: 'r' },
            { t: 'TVA (taux %)', w: '17mm', al: 'c' },
            { t: 'Montant HT (XAF)', w: '30mm', al: 'r' },
          ],
          n: N,
          h: 6.8,
          premierNumero: i * N + 1,
          rows: lot.map((l) => [
            l.designation,
            l.unite,
            l.quantite,
            xafPiece(l.prixUnitaireHt),
            l.tauxTva,
            xafPiece(l.montantHt),
          ]),
        }),
        `<div class="rang" style="align-items:start">
        <div class="c13" style="display:grid;gap:1.4mm">
          ${cases('Régime de TVA', ['TVA applicable', 'opération exonérée de TVA'], { coche: d.regimeTva ? [d.regimeTva] : [] })}
          ${champ('Mention d’exonération / observations', 13, { double: true, v: d.mentionExoneration })}
          ${note(`Coordonnées de règlement<br>Banque ${blanc(d.banque)}<br>Compte n° ${blanc(d.compte)}<br>Mobile money ${blanc(d.mobileMoney)}`)}
        </div>
        <div class="c11" style="display:grid;gap:.4mm">
          ${champ('Total HT', 11, derniere ? x(d.totalHt) : { u: 'XAF' })}${champ('TVA', 11, derniere ? x(d.tva) : { u: 'XAF' })}${champ('Total TTC', 11, derniere ? x(d.totalTtc) : { u: 'XAF' })}${champ('Acompte déjà reçu', 11, derniere ? x(d.acompte) : { u: 'XAF' })}${champ('NET À PAYER', 11, derniere ? x(d.netAPayer) : { u: 'XAF' })}
        </div></div>`,
        lettres(
          'Arrêtée la présente facture à la somme de (en lettres)',
          24,
          2,
          derniere ? enLettres(d.netAPayer) : null,
        ),
        signatures(
          [
            { t: 'Le vendeur', s: 'nom, signature et cachet', v: d.vendeur },
            { t: 'Le client', s: 'bon pour accord — nom et signature', v: d.client },
          ],
          { h: 16 },
        ),
      ].join(''),
      ex: EX3,
      mention: 'Facture numérotée en continu',
    });
  });
  return { code: 'FA', titre: 'Facture', fmt: 'a4p', pages };
}

const esc2 = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
