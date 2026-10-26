/**
 * Données des pièces d'argent de la Finance : bon de décaissement (BD) d'une dépense ou d'un
 * paiement fournisseur, remise de fonds (RF), feuille journalière de caisse (FJC) d'un compte,
 * journal des encaissements (JE). Fonctions pures, sur les données déjà lues par l'écran.
 */
import type { SalesReferences } from '../sales/references.js';
import type { CustomerPaymentData } from '../sales/types.js';
import type { ExpenseView } from '../finance/expense.js';
import type { TransferView } from '../cash/transfers.js';
import type { DemandePiece } from './demande.js';
import { client, nomUtilisateur, numeroImprime } from './adaptateurs-ventes.js';
import { dateHeurePiece, datePiece, heurePiece, lettreMoyen, moyenPiece } from './format.js';
import type { DonneesRF, LigneJournalCaisse, LigneJournalEncaissements } from './pieces-argent.js';
import { ORIGINES_RF } from './pieces-argent.js';

type Refs = Pick<
  SalesReferences,
  | 'users'
  | 'sites'
  | 'cashAccounts'
  | 'cashTransferTargets'
  | 'expenseCategories'
  | 'customers'
  | 'customerAlias'
>;

const nomCompte = (refs: Refs, id: string | null | undefined): string | null => {
  if (!id) return null;
  return (
    refs.cashAccounts.find((a) => a.id === id)?.name ??
    refs.cashTransferTargets.find((a) => a.id === id)?.name ??
    null
  );
};
const typeCompte = (refs: Refs, id: string): string | null =>
  refs.cashAccounts.find((a) => a.id === id)?.account_type ??
  refs.cashTransferTargets.find((a) => a.id === id)?.account_type ??
  null;

/** Dépense : `imputation` est le libellé déjà calculé par l'écran (lot, site, PDV…). */
export function demandeDecaissementDepense(
  depense: ExpenseView,
  refs: Refs,
  auteurId: string,
  imputation: string | null,
): DemandePiece {
  const categorie = refs.expenseCategories.find((c) => c.id === depense.categoryId)?.label ?? null;
  const caisse = depense.paidFromAccountId
    ? nomCompte(refs, depense.paidFromAccountId)
    : (refs.sites.get(depense.siteId)?.name ?? null);
  return {
    code: 'BD',
    donnees: {
      numero: numeroImprime(depense.docNumber),
      beneficiaire: depense.payeeName,
      pieceIdentite: null,
      caisse,
      dateHeure: dateHeurePiece(depense.occurredAt),
      etabliPar: nomUtilisateur(refs, auteurId),
      nature: 'dépense',
      categorie,
      objet: depense.description,
      imputeA: imputation,
      factureOuBc: null,
      montant: depense.amountXaf,
      justificatifs: [],
      autorisePar: null,
    },
  };
}

/** Paiement fournisseur (lu en ligne) : nature « paiement » ou « avance » selon son affectation. */
export interface PaiementFournisseur {
  readonly docNumber: string | null;
  readonly fournisseur: string | null;
  readonly compteId: string | null;
  readonly occurredAt: string;
  readonly creePar: string | null;
  readonly decidePar: string | null;
  readonly montant: number;
  readonly avance: boolean;
  readonly factures: readonly string[];
  readonly moyen: string | null;
  readonly reference: string | null;
}

export function demandeDecaissementFournisseur(p: PaiementFournisseur, refs: Refs): DemandePiece {
  const moyen = moyenPiece(p.moyen);
  const objet = [
    moyen ? `Règlement par ${moyen.toLowerCase()}` : null,
    p.reference ? `réf. ${p.reference}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return {
    code: 'BD',
    donnees: {
      numero: numeroImprime(p.docNumber),
      beneficiaire: p.fournisseur,
      pieceIdentite: null,
      caisse: nomCompte(refs, p.compteId),
      dateHeure: dateHeurePiece(p.occurredAt),
      etabliPar: nomUtilisateur(refs, p.creePar),
      nature: p.avance ? 'avance fournisseur' : 'paiement fournisseur',
      categorie: null,
      objet: objet || null,
      imputeA: null,
      factureOuBc: p.factures.join(', ') || null,
      montant: p.montant,
      justificatifs: p.factures.length > 0 ? ['facture'] : [],
      autorisePar: nomUtilisateur(refs, p.decidePar),
    },
  };
}

function origine(refs: Refs, compteId: string): DonneesRF['de'] {
  switch (typeCompte(refs, compteId)) {
    case 'CAISSE_PDV':
      return ORIGINES_RF[0];
    case 'CAISSE_UTILISATEUR':
      return ORIGINES_RF[1];
    case 'CAISSE_CENTRALE':
      return ORIGINES_RF[2];
    case 'MOBILE_MONEY':
      return ORIGINES_RF[3];
    default:
      return null;
  }
}

export function demandeRemiseDeFonds(
  remise: TransferView,
  refs: Refs,
  reception: { readonly recuLe: string | null; readonly montantRecu: number | null } | null,
): DemandePiece {
  const destinationType = typeCompte(refs, remise.toAccountId);
  const recu = reception?.montantRecu ?? remise.receivingXaf;
  return {
    code: 'RF',
    donnees: {
      numero: numeroImprime(remise.docNumber),
      remettant: nomUtilisateur(refs, remise.sentBy),
      origine: nomCompte(refs, remise.fromAccountId),
      destinataire: remise.carrierName,
      destination: nomCompte(refs, remise.toAccountId),
      de: origine(refs, remise.fromAccountId),
      vers:
        destinationType === 'BANQUE'
          ? 'banque'
          : destinationType === 'CAISSE_CENTRALE'
            ? 'caisse centrale'
            : null,
      depot: null,
      session: null,
      envoyeLe: dateHeurePiece(remise.sentAt),
      montantEnvoye: remise.amountSentXaf,
      recuLe: reception?.recuLe ? dateHeurePiece(reception.recuLe) : null,
      montantRecu: recu ?? null,
      ecart: recu === null || recu === undefined ? null : remise.amountSentXaf - recu,
      motifEcart: null,
    },
  };
}

/** Mouvement d'un compte de trésorerie (lecture en ligne `GET /cash-accounts/{id}/movements`). */
export interface MouvementCompte {
  readonly occurredAt: string;
  readonly direction: 'IN' | 'OUT';
  readonly montant: number;
  readonly piece: string | null;
  readonly libelle: string | null;
  readonly moyen: string | null;
}

/**
 * Feuille journalière d'un compte pour un jour métier (D4, D5) : une ligne par mouvement, dans
 * l'ordre chronologique. Le rapprochement des espèces n'est rempli que pour un compte en espèces
 * dont la session (fonds compté, comptage) est connue ; sinon il reste à remplir à la main.
 */
export function demandeFeuilleCaisse(input: {
  readonly compteId: string;
  readonly jour: string;
  readonly mouvements: readonly MouvementCompte[];
  readonly session: {
    readonly numero: string | null;
    readonly fondsOuverture: number | null;
    readonly especesComptees: number | null;
    readonly caissierId: string | null;
  } | null;
  readonly refs: Refs;
}): DemandePiece {
  const { refs, compteId, session } = input;
  const compte = refs.cashAccounts.find((a) => a.id === compteId);
  const especes = compte ? compte.account_type.startsWith('CAISSE') : false;
  const tries = [...input.mouvements].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const lignes: LigneJournalCaisse[] = tries.map((m) => ({
    heure: heurePiece(m.occurredAt),
    piece: m.piece,
    libelle: m.libelle,
    mode: lettreMoyen(m.moyen) ?? (especes ? 'E' : null),
    entree: m.direction === 'IN' ? m.montant : null,
    sortie: m.direction === 'OUT' ? m.montant : null,
  }));
  const somme = (pred: (l: LigneJournalCaisse) => boolean, k: 'entree' | 'sortie') =>
    lignes.filter(pred).reduce((s, l) => s + (l[k] ?? 0), 0);
  const estEspeces = (l: LigneJournalCaisse) => l.mode === 'E';
  const entreesEspeces = especes ? somme(estEspeces, 'entree') : null;
  const sortiesEspeces = especes ? somme(estEspeces, 'sortie') : null;
  const fonds = session?.fondsOuverture ?? null;
  const theorique =
    especes && fonds !== null ? fonds + (entreesEspeces ?? 0) - (sortiesEspeces ?? 0) : null;
  const comptees = session?.especesComptees ?? null;
  const caisse =
    compte?.account_type === 'CAISSE_PDV'
      ? 'du PDV'
      : compte?.account_type === 'CAISSE_UTILISATEUR'
        ? 'du commercial'
        : compte?.account_type === 'CAISSE_CENTRALE'
          ? 'centrale'
          : null;
  return {
    code: 'FJC',
    donnees: {
      numero: null,
      site: compte?.site_id
        ? (refs.sites.get(compte.site_id)?.name ?? compte.name)
        : (compte?.name ?? null),
      caisse,
      jour: datePiece(`${input.jour}T12:00:00Z`),
      caissier: nomUtilisateur(refs, session?.caissierId ?? compte?.holder_user_id ?? null),
      controleur: null,
      session: session?.numero ?? null,
      fondsOuverture: fonds,
      lignes,
      entreesEspeces,
      sortiesEspeces,
      soldeTheorique: theorique,
      especesComptees: comptees,
      ecart: theorique !== null && comptees !== null ? comptees - theorique : null,
      motifEcart: null,
      entreesHorsEspeces: somme((l) => l.mode !== null && l.mode !== 'E', 'entree'),
    },
  };
}

const COLONNE: Readonly<Record<string, number>> = {
  Espèces: 0,
  'Orange Money': 1,
  'MTN Mobile Money': 2,
  'Virement bancaire': 3,
  Chèque: 4,
};

/** Journal des encaissements d'une période : une ligne par encaissement, au montant de son mode. */
export function demandeJournalEncaissements(input: {
  readonly paiements: readonly CustomerPaymentData[];
  readonly site: string | null;
  readonly du: string;
  readonly au: string;
  readonly tenuPar: string | null;
  readonly refs: Refs;
}): DemandePiece {
  const lignes: LigneJournalEncaissements[] = [...input.paiements]
    .filter((p) => p.status !== 'CANCELLED')
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
    .map((p) => {
      const parMode: [number | null, number | null, number | null, number | null, number | null] = [
        null,
        null,
        null,
        null,
        null,
      ];
      const moyen = moyenPiece(p.payment_method_code);
      const k = moyen ? COLONNE[moyen] : undefined;
      if (k !== undefined) parMode[k] = p.amount_xaf;
      const c = client(input.refs, p.customer_id);
      return {
        date: datePiece(p.occurred_at)?.slice(0, 5) ?? null,
        piece: p.doc_number,
        objet: c?.display_name ?? null,
        parMode,
      };
    });
  return {
    code: 'JE',
    donnees: {
      numero: null,
      site: input.site,
      du: datePiece(`${input.du}T12:00:00Z`),
      au: datePiece(`${input.au}T12:00:00Z`),
      tenuPar: input.tenuPar,
      lignes,
    },
  };
}
