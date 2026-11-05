/**
 * Pièces de terrain du CRM et du personnel remplies par l'application (PP-E ; REQ-306, REQ-307, REQ-308, REQ-302) :
 * fiche de présence et de pointage (PT), bilan hebdomadaire du commercial (BH) et fiche de visite (VC, avec le profil
 * commercial du client et la veille marché). Rubriques, ordre et dimensions : ceux de
 * `pieces-papier/_generation/p-terrain.mjs`, à l'identique ; la charte n'est pas touchée.
 */
import {
  bloc,
  cases,
  champ,
  type Contexte,
  esc,
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
import type { PieceRendue } from './piece.js';
import type { Saisie } from './pieces-argent.js';

const S = (v: Valeur) => (v ? { v } : { aide: '…/…/20…' });
const D = (v: Valeur) => (v ? { v } : { aide: 'jj / mm / aaaa' });
const H = (v: Valeur) => (v ? { v } : { aide: '…h…' });

// ------------------------------------------------------------------ PT
/** Jours de la fiche PT : lundi à samedi (le dimanche ne figure pas sur le papier). */
export const JOURS_PT = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'] as const;

/** Un jour d'une personne : heures `07 h 45`, ou le code d'absence dans la case « arrivée » (légende de la fiche). */
export interface JourPresence {
  readonly arrivee: string | null;
  readonly depart: string | null;
}

export interface LignePresence {
  readonly nom: string;
  readonly fonction: string | null;
  readonly mission: string | null;
  /** Six jours, du lundi au samedi ; moins : cases vierges. */
  readonly jours: readonly JourPresence[];
  /** « Total heures », déjà écrit (`7 h 45`). */
  readonly total: string | null;
}

export interface DonneesPT {
  readonly numero: string | null;
  readonly site: string | null;
  readonly semaineDu: string | null;
  readonly semaineAu: string | null;
  readonly responsable: string | null;
  readonly lignes: readonly LignePresence[];
}

export function ficheDePresence(d: DonneesPT, ctx: Contexte): PieceRendue {
  const N = 14;
  const feuilles = paginer(d.lignes, N);
  const pages = feuilles.map((lot, i) =>
    standard({
      fmt: 'a4l',
      code: 'PT',
      titre: 'Présence et pointage',
      sous: 'Solution de secours du pointage numérique',
      numLib: 'Feuille N°',
      annule: false,
      marges: { mh: 11 },
      n: d.numero,
      page: numeroPage(i, feuilles.length),
      ctx,
      corps: [
        rang(
          champ('Site / zone déclarée', 10, { v: d.site }),
          champ('Semaine du', 6, S(d.semaineDu)),
          champ('au', 4, S(d.semaineAu)),
          champ('Responsable', 4, { v: d.responsable }),
        ),
        lignes({
          n: N,
          h: 7.6,
          premierNumero: i * N + 1,
          cols: [
            { t: 'Nom et prénom', w: '*' },
            { t: 'Fonction', w: '24mm' },
            { t: 'Zone / mission', w: '28mm' },
            ...JOURS_PT.flatMap((jour) => [
              { t: `${jour} arrivée`, w: '11.5mm' },
              { t: `${jour} départ`, w: '11.5mm' },
            ]),
            { t: 'Total heures', w: '14mm' },
            { t: 'Visa', w: '13mm' },
          ],
          rows: lot.map((l) => [
            l.nom,
            l.fonction,
            l.mission,
            ...JOURS_PT.flatMap((_, k) => [
              l.jours[k]?.arrivee ?? null,
              l.jours[k]?.depart ?? null,
            ]),
            l.total,
            null,
          ]),
        }),
        note(
          '<b>Codes d’absence</b> (à écrire dans la case « arrivée ») : A absent — M maladie — C congé — R repos — MI mission hors zone. Heures au format 07 h 45. Une session de travail terrain = une arrivée et un départ ; un pointage refusé ou imprécis est signalé au responsable.',
        ),
        signatures(
          [
            { t: 'Le responsable du site', s: 'a vérifié la semaine' },
            { t: 'La Direction', s: 'visa' },
          ],
          { h: 12 },
        ),
      ].join(''),
      mention:
        'Chaque ligne se reporte comme une session de travail : zone déclarée, heure de début, heure de fin',
    }),
  );
  return { code: 'PT', titre: 'Présence et pointage', fmt: 'a4l', pages };
}

// ------------------------------------------------------------------ BH
export interface DonneesBH {
  readonly numero: string | null;
  readonly commercial: string | null;
  readonly semaineDu: string | null;
  readonly semaineAu: string | null;
  /** Chiffres de la semaine, calculés par l'application (jamais saisis) ; `null` : case vierge. */
  readonly visites: string | null;
  readonly prospects: string | null;
  readonly clients: string | null;
  readonly ca: string | null;
  readonly encaisse: string | null;
  readonly pertes: string | null;
  readonly reussites: string | null;
  readonly difficultes: string | null;
  readonly besoins: string | null;
  readonly priorites: string | null;
  readonly marche: string | null;
  /** « Vu par le responsable ». */
  readonly vu: boolean;
  readonly commentaire: string | null;
}

/** Zone à lignes de la fiche (11 mm) : le texte écrit y tient sur trois lignes au plus. */
const zone = (texte: string | null): string =>
  `<div class="lignes-fond" style="height:11mm">${texte ? `<span class="zone-texte">${esc(texte)}</span>` : ''}</div>`;

/** Estimation prudente du nombre de lignes d'un texte dans une zone de `parLigne` caractères par ligne. */
const lignesDuTexte = (texte: string, parLigne: number): number =>
  texte
    .split('\n')
    .reduce((total, ligne) => total + Math.max(1, Math.ceil(ligne.length / parLigne)), 0);

/** Vrai si le texte ne tient probablement pas dans sa zone (la fiche le couperait, l'application le garde en entier). */
const deborde = (texte: string | null | undefined, parLigne: number, maxLignes: number): boolean =>
  texte ? lignesDuTexte(texte, parLigne) > maxLignes : false;

/** Ajoutée au pied de la fiche quand un texte dépasse sa zone : rien n'est coupé sans le dire. */
const SUITE_DANS_L_APPLICATION =
  ' — texte plus long que sa zone : voir le texte complet dans l’application';

export function bilanHebdomadaire(d: DonneesBH, ctx: Contexte): PieceRendue {
  const page = standard({
    fmt: 'a5p',
    code: 'BH',
    titre: 'Bilan hebdomadaire',
    sous: 'Commercial — synthèse de la semaine',
    numLib: 'Fiche N°',
    marges: { mh: 12 },
    annule: false,
    h: 6.4,
    n: d.numero,
    ctx,
    corps: [
      rang(
        champ('Commercial', 12, { v: d.commercial }),
        champ('Semaine du', 6, S(d.semaineDu)),
        champ('au', 6, S(d.semaineAu)),
      ),
      section('Chiffres de la semaine (relevés sur les fiches ou calculés par l’application)'),
      rang(
        champ('Visites sur place', 8, { v: d.visites, num: true }),
        champ('Nouveaux prospects', 8, { v: d.prospects, num: true }),
        champ('Nouveaux clients', 8, { v: d.clients, num: true }),
      ),
      rang(
        champ('CA réalisé', 8, { u: 'XAF', v: d.ca, num: true }),
        champ('Encaissé', 8, { u: 'XAF', v: d.encaisse, num: true }),
        champ('Casses et pertes', 8, { u: 'XAF', v: d.pertes, num: true }),
      ),
      section('Réussites de la semaine'),
      zone(d.reussites),
      section('Difficultés rencontrées'),
      zone(d.difficultes),
      section('Besoins et demandes à la direction'),
      zone(d.besoins),
      section('Priorités de la semaine suivante'),
      zone(d.priorites),
      section('Informations du marché (concurrents, prix)'),
      zone(d.marche),
      bloc(
        'Réservé au responsable',
        [
          cases('Vu par le responsable', ['oui'], { coche: d.vu ? ['oui'] : [] }),
          champ('Commentaire', 24, { v: d.commentaire }),
        ].join(''),
        'plein',
      ),
      signatures([{ t: 'Le commercial' }, { t: 'Le responsable', s: 'visa' }], { h: 11 }),
    ].join(''),
    mention: `Une fiche par semaine — les chiffres se recoupent avec les visites, commandes et encaissements de l’application${
      [d.reussites, d.difficultes, d.besoins, d.priorites, d.marche].some((t) =>
        deborde(t, 95, 3),
      ) || deborde(d.commentaire, 90, 1)
        ? SUITE_DANS_L_APPLICATION
        : ''
    }`,
  });
  return { code: 'BH', titre: 'Bilan hebdomadaire', fmt: 'a5p', pages: [page] };
}

// ------------------------------------------------------------------ VC
export const COMPTES_VC = ['client existant', 'nouveau prospect'] as const;
export const PAIEMENTS_VC = ['espèces', 'mobile money', 'virement', 'crédit'] as const;
export const RESULTATS_VC = [
  'commande prise',
  'vente réalisée sur place',
  'à relancer',
  'pas intéressé',
  'client absent',
  'autre',
] as const;

/** Un relevé de veille marché : la fiche papier n'a de place que pour un seul. */
export interface ReleveVeille {
  readonly source: string | null;
  readonly produit: string | null;
  readonly prix: string | null;
  readonly unite: string | null;
}

export interface DonneesVC {
  readonly numero: string | null;
  readonly commercial: string | null;
  readonly zone: string | null;
  /** « 04/11/2026 ». */
  readonly date: string | null;
  /** « 09 h 15 » : heure de la visite. */
  readonly arrivee: string | null;
  readonly depart: string | null;
  readonly compte: (typeof COMPTES_VC)[number] | null;
  readonly client: string | null;
  readonly telephone: string | null;
  readonly personne: string | null;
  readonly adresse: string | null;
  readonly produitInteret: string | null;
  /** « 50 plateaux ». */
  readonly potentiel: string | null;
  readonly paiement: (typeof PAIEMENTS_VC)[number] | null;
  /** « Différé demandé » : oui, non, ou rien d'écrit. */
  readonly differe: 'oui' | 'non' | null;
  /** Tous les relevés de la visite ; le premier s'écrit dans la fiche, le nombre dit s'il y en a d'autres. */
  readonly veille: readonly ReleveVeille[];
  readonly resultat: (typeof RESULTATS_VC)[number] | null;
  readonly commentaire: string | null;
  readonly prochaineAction: string | null;
  readonly prochaineActionLe: string | null;
  readonly saisie?: Saisie;
}

export function ficheDeVisite(d: DonneesVC, ctx: Contexte): PieceRendue {
  const releve = d.veille[0];
  const autres = d.veille.length - 1;
  const page = standard({
    fmt: 'a5p',
    code: 'VC',
    titre: 'Fiche de visite',
    sous: 'Visite et prospection',
    numLib: 'Fiche N°',
    marges: { mh: 12 },
    annule: false,
    h: 6.6,
    n: d.numero,
    ctx,
    corps: [
      rang(champ('Commercial', 12, { v: d.commercial }), champ('Zone / marché', 12, { v: d.zone })),
      rang(
        champ('Date', 8, D(d.date)),
        champ('Arrivée à', 8, H(d.arrivee)),
        champ('Départ à', 8, H(d.depart)),
      ),
      cases('Compte client', [...COMPTES_VC], { coche: d.compte ? [d.compte] : [] }),
      rang(
        champ('Nom du client / entreprise', 16, { v: d.client }),
        champ('Téléphone', 8, { v: d.telephone }),
      ),
      rang(
        champ('Personne rencontrée (fonction)', 13, { v: d.personne }),
        champ('Adresse / repère', 11, { v: d.adresse }),
      ),
      section('Profil commercial du client'),
      rang(
        champ('Produit d’intérêt', 12, { v: d.produitInteret }),
        champ('Potentiel par jour (quantité, unité)', 12, { v: d.potentiel }),
      ),
      rang(
        cases('Paiement habituel', [...PAIEMENTS_VC], {
          span: 16,
          coche: d.paiement ? [d.paiement] : [],
        }),
        cases('Différé demandé', ['oui', 'non'], { span: 8, coche: d.differe ? [d.differe] : [] }),
      ),
      section(autres > 0 ? `Veille marché (1 relevé sur ${d.veille.length})` : 'Veille marché'),
      rang(
        champ('Fournisseur ou concurrent actuel', 13, { v: releve?.source }),
        champ('Produit', 11, { v: releve?.produit }),
      ),
      rang(
        champ('Prix constaté chez lui', 12, { u: 'XAF', v: releve?.prix, num: true }),
        champ('Unité', 12, { v: releve?.unite }),
      ),
      cases('Résultat de la visite', [...RESULTATS_VC], { coche: d.resultat ? [d.resultat] : [] }),
      champ('Commentaire (obligatoire si « autre »)', 24, { haut: true, v: d.commentaire }),
      rang(
        champ('Prochaine action', 16, { v: d.prochaineAction }),
        champ('Le', 8, D(d.prochaineActionLe)),
      ),
      report({ extra: '', saisiLe: d.saisie?.le, par: d.saisie?.par, numero: d.saisie?.numero }),
    ].join(''),
    mention: `Une fiche par visite — une commande prise donne un bon de commande client, une vente sur place un bon de vente${
      deborde(d.commentaire, 90, 2) || deborde(d.prochaineAction, 60, 1)
        ? SUITE_DANS_L_APPLICATION
        : ''
    }`,
  });
  return { code: 'VC', titre: 'Fiche de visite', fmt: 'a5p', pages: [page] };
}
