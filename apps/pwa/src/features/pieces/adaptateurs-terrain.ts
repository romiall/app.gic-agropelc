/**
 * Adaptateurs des pièces de terrain (PP-E ; REQ-306, REQ-307, REQ-308) : de ce que l'application détient (feuille de
 * présence reportée, bilan hebdomadaire et ses chiffres calculés, visite et compte du client) aux rubriques de la fiche
 * PT, de la fiche BH et de la fiche VC. Aucune donnée n'est inventée : une rubrique inconnue reste une case vierge.
 */
import {
  addBusinessDays,
  businessDayOf,
  formatWorkedMinutes,
  isPresenceAbsenceCode,
  totalWorkedMinutes,
  weekDaysOf,
  type PresenceDay,
  type WeeklyFigures,
} from '@gic/domain';
import type { SalesReferences } from '../sales/references.js';
import type { CustomerData, VisitData } from '../sales/types.js';
import type { DemandePiece } from './demande.js';
import { heurePiece, jourPiece, moyenPiece, xafPiece } from './format.js';
import {
  JOURS_PT,
  type RESULTATS_VC,
  type DonneesVC,
  type JourPresence,
  type LignePresence,
  type ReleveVeille,
} from './pieces-terrain.js';

// ------------------------------------------------------------------ PT
/** Feuille de présence reportée, dans la forme de `GET /staff-presence` (champs utiles à la pièce). */
export interface FeuillePresence {
  readonly weekStart: string;
  readonly paperRef: string | null;
  readonly responsibleName: string | null;
  readonly lines: readonly {
    readonly personName: string;
    readonly personRole: string | null;
    readonly missionLabel: string | null;
    readonly days: readonly {
      readonly date: string;
      readonly arrival: string | null;
      readonly departure: string | null;
      readonly absenceCode: string | null;
    }[];
  }[];
}

/** « 07:45 » écrit « 07 h 45 », comme sur la fiche. */
const heureFiche = (hhmm: string | null): string | null => (hhmm ? hhmm.replace(':', ' h ') : null);

/**
 * Fiche PT d'une feuille reportée. La fiche papier couvre du lundi au samedi : le dimanche, s'il a été relevé, se lit dans
 * l'application et n'entre pas dans le « Total heures » imprimé (celui-ci doit se recouper avec les cases visibles).
 */
export function demandePresence(feuille: FeuillePresence, nomSite: string | null): DemandePiece {
  const jours = weekDaysOf(feuille.weekStart);
  const lignes: LignePresence[] = feuille.lines.map((ligne) => {
    const imprimes: PresenceDay[] = [];
    const cases: JourPresence[] = JOURS_PT.map((_, index) => {
      const jour = ligne.days.find((d) => d.date === jours[index]);
      if (!jour) return { arrivee: null, depart: null };
      if (isPresenceAbsenceCode(jour.absenceCode)) {
        imprimes.push({ date: jour.date, absenceCode: jour.absenceCode });
        // Le code d'absence s'écrit dans la case « arrivée » (légende de la fiche).
        return { arrivee: jour.absenceCode, depart: null };
      }
      imprimes.push({ date: jour.date, arrival: jour.arrival, departure: jour.departure });
      return { arrivee: heureFiche(jour.arrival), depart: heureFiche(jour.departure) };
    });
    const minutes = totalWorkedMinutes(imprimes);
    return {
      nom: ligne.personName,
      fonction: ligne.personRole,
      mission: ligne.missionLabel,
      jours: cases,
      total: minutes > 0 ? formatWorkedMinutes(minutes) : null,
    };
  });
  return {
    code: 'PT',
    donnees: {
      numero: feuille.paperRef,
      site: nomSite,
      semaineDu: jourPiece(feuille.weekStart),
      semaineAu: jourPiece(jours[5]),
      responsable: feuille.responsibleName,
      lignes,
    },
  };
}

// ------------------------------------------------------------------ BH
/** Bilan hebdomadaire lu du serveur (champs utiles à la pièce). */
export interface BilanSource {
  readonly weekStart: string;
  readonly successes: string | null;
  readonly difficulties: string | null;
  readonly needs: string | null;
  readonly priorities: string | null;
  readonly marketInfo: string | null;
  readonly status: string;
  readonly managerComment: string | null;
}

const entier = (n: number | undefined): string | null => (n === undefined ? null : String(n));

/** Fiche BH d'un bilan ; les chiffres viennent du calcul de l'application (`null` : case vierge, hors ligne par exemple). */
export function demandeBilan(
  bilan: BilanSource,
  contexte: { readonly commercial: string | null; readonly chiffres: WeeklyFigures | null },
): DemandePiece {
  const c = contexte.chiffres;
  return {
    code: 'BH',
    donnees: {
      numero: null,
      commercial: contexte.commercial,
      semaineDu: jourPiece(bilan.weekStart),
      semaineAu: jourPiece(addBusinessDays(bilan.weekStart, 6)),
      visites: entier(c?.visits),
      prospects: entier(c?.newProspects),
      clients: entier(c?.newCustomers),
      ca: xafPiece(c?.salesXaf),
      encaisse: xafPiece(c?.collectedXaf),
      pertes: xafPiece(c?.lossValueXaf),
      reussites: bilan.successes,
      difficultes: bilan.difficulties,
      besoins: bilan.needs,
      priorites: bilan.priorities,
      marche: bilan.marketInfo,
      vu: bilan.status === 'REVIEWED',
      commentaire: bilan.managerComment,
    },
  };
}

// ------------------------------------------------------------------ VC
const RESULTAT_PAR_CODE: Readonly<Record<string, (typeof RESULTATS_VC)[number]>> = {
  COMMANDE_PRISE: 'commande prise',
  VENTE_REALISEE: 'vente réalisée sur place',
  A_RELANCER: 'à relancer',
  PAS_INTERESSE: 'pas intéressé',
  ABSENT: 'client absent',
  AUTRE: 'autre',
};

/** Case « Paiement habituel » : le moyen du référentiel, regroupé comme les quatre cases de la fiche. */
function paiementVc(code: string | null | undefined): DonneesVC['paiement'] {
  const moyen = moyenPiece(code);
  if (moyen === 'Espèces') return 'espèces';
  if (moyen === 'Orange Money' || moyen === 'MTN Mobile Money') return 'mobile money';
  if (moyen === 'Virement bancaire') return 'virement';
  return null;
}

/** Quantité et unité du potentiel par jour, écrites comme à la main (« 50 plateaux »). */
function potentielVc(client: CustomerData, unites: SalesReferences['units']): string | null {
  const quantite = client.potential_qty_per_day;
  if (quantite === null || quantite === undefined) return null;
  const code = client.potential_unit_code;
  const unite = code ? (unites.get(code)?.name ?? code) : '';
  return `${String(quantite).replace('.', ',')} ${unite}`.trim();
}

export interface ContexteVisite {
  readonly refs: Pick<SalesReferences, 'reasonCodes' | 'products' | 'units' | 'zones' | 'users'>;
}

/**
 * Fiche VC d'une visite, avec le profil commercial du client et la veille marché. La fiche papier n'a de place que pour un
 * relevé : le premier s'écrit, le nombre de relevés figure au titre de la section quand il y en a d'autres.
 */
export function demandeVisite(
  visite: VisitData,
  client: CustomerData,
  contexte: ContexteVisite,
): DemandePiece {
  const { refs } = contexte;
  const code = refs.reasonCodes.find((r) => r.id === visite.outcome_reason_code_id)?.code;
  const produit = (id: string | null | undefined) =>
    id ? (refs.products.find((p) => p.id === id)?.name ?? null) : null;
  const veille: ReleveVeille[] = (visite.market_watch ?? []).map((ligne) => ({
    source: ligne.source_name,
    produit: produit(ligne.product_id),
    prix: xafPiece(ligne.observed_price_xaf),
    unite: ligne.unit_code ? (refs.units.get(ligne.unit_code)?.name ?? ligne.unit_code) : null,
  }));
  const jour = businessDayOf(new Date(visite.occurred_at));
  // Le stade du jour de la visite (figé par le serveur) prime sur le stade actuel : un prospect converti depuis reste
  // « nouveau prospect » sur la fiche de sa visite. Une visite saisie sur l'appareil n'en porte pas encore : le stade
  // actuel fait alors foi. Un compte perdu ou fusionné ne coche aucune case.
  const stade = visite.customer_stage_at_visit ?? client.stage;
  const produitInteret = produit(client.interest_product_id);
  const potentiel = potentielVc(client, refs.units);
  const paiement = paiementVc(client.usual_payment_method_code);
  // La demande de crédit est un booléen toujours renseigné (faux par défaut) : « non » n'est une réponse que si le profil
  // dit autre chose ; un profil resté vide laisse la case vierge.
  const profilRenseigne = produitInteret !== null || potentiel !== null || paiement !== null;
  return {
    code: 'VC',
    donnees: {
      numero: null,
      commercial: refs.users.find((u) => u.id === visite.user_id)?.full_name ?? null,
      zone: refs.zones.get(client.zone_id)?.name ?? null,
      date: jourPiece(jour),
      arrivee: heurePiece(visite.occurred_at),
      depart: null,
      compte:
        stade === 'PROSPECT' ? 'nouveau prospect' : stade === 'CUSTOMER' ? 'client existant' : null,
      client: client.display_name,
      telephone: client.phone_primary,
      personne: client.contact_name,
      adresse: client.address_text,
      produitInteret,
      potentiel,
      paiement,
      differe:
        client.credit_requested === true
          ? 'oui'
          : client.credit_requested === false && profilRenseigne
            ? 'non'
            : null,
      veille,
      resultat: code ? (RESULTAT_PAR_CODE[code] ?? 'autre') : null,
      commentaire: visite.notes,
      prochaineAction: visite.next_action_note,
      prochaineActionLe: jourPiece(visite.next_action_at),
    },
  };
}
