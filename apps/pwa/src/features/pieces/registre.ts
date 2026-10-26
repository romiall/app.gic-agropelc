/** Rendu d'une demande d'impression : le code choisit la pièce du papier. */
import type { DemandePiece } from './demande.js';
import type { Contexte } from './gabarit.js';
import type { PieceRendue } from './piece.js';
import * as A from './pieces-argent.js';
import * as O from './pieces-operations.js';

export function rendrePiece(d: DemandePiece, ctx: Contexte): PieceRendue {
  switch (d.code) {
    case 'BV':
      return A.bonDeVente(d.donnees, ctx);
    case 'RE':
      return A.recuEncaissement(d.donnees, ctx);
    case 'BD':
      return A.bonDecaissement(d.donnees, ctx);
    case 'RF':
      return A.remiseDeFonds(d.donnees, ctx);
    case 'FJC':
      return A.feuilleJournaliereCaisse(d.donnees, ctx);
    case 'JE':
      return A.journalEncaissements(d.donnees, ctx);
    case 'FA':
      return A.facture(d.donnees, ctx);
    case 'CC':
      return O.bonCommandeClient(d.donnees, ctx);
    case 'BL':
      return O.bonLivraison(d.donnees, ctx);
    case 'DA':
      return O.demandeAchat(d.donnees, ctx);
    case 'BC':
      return O.bonCommandeFournisseur(d.donnees, ctx);
    case 'BR':
      return O.bonReception(d.donnees, ctx);
    case 'BT':
      return O.bonTransfert(d.donnees, ctx);
    case 'FP':
      return O.fichePerte(d.donnees, ctx);
    case 'FI':
      return O.ficheInventaire(d.donnees, ctx);
    case 'FL':
      return O.ficheSuiviLot(d.donnees, ctx);
  }
}
