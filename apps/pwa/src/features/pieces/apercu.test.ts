/**
 * Aperçu de contrôle visuel : avec `PIECES_APERCU_DIR`, écrit le document HTML de chaque pièce
 * d'exemple dans ce dossier, pour une comparaison à l'œil (ou par capture) avec
 * `pieces-papier/apercu/*.png`. Sans la variable, le test ne fait rien.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { documentPiece, LOGO_PIECES } from './document.js';
import * as X from './exemples.js';
import * as A from './pieces-argent.js';
import * as O from './pieces-operations.js';

const DIR = process.env.PIECES_APERCU_DIR;

describe.runIf(Boolean(DIR))('aperçu des pièces (contrôle visuel)', () => {
  it('écrit les documents', () => {
    mkdirSync(DIR!, { recursive: true });
    const ctx = { logo: LOGO_PIECES };
    const pieces = [
      A.bonDeVente(X.EXEMPLE_BV, ctx),
      A.recuEncaissement(X.EXEMPLE_RE, ctx),
      A.bonDecaissement(X.EXEMPLE_BD, ctx),
      A.remiseDeFonds(X.EXEMPLE_RF, ctx),
      A.feuilleJournaliereCaisse(X.EXEMPLE_FJC, ctx),
      A.journalEncaissements(X.EXEMPLE_JE, ctx),
      A.facture(X.EXEMPLE_FA, ctx),
      O.bonCommandeClient(X.EXEMPLE_CC, ctx),
      O.bonLivraison(X.EXEMPLE_BL, ctx),
      O.demandeAchat(X.EXEMPLE_DA, ctx),
      O.bonCommandeFournisseur(X.EXEMPLE_BC, ctx),
      O.bonReception(X.EXEMPLE_BR, ctx),
      O.bonTransfert(X.EXEMPLE_BT, ctx),
      O.fichePerte(X.EXEMPLE_FP, ctx),
      O.ficheInventaire(X.EXEMPLE_FI, ctx),
      O.ficheSuiviLot(X.EXEMPLE_FL, ctx),
    ];
    for (const p of pieces) writeFileSync(join(DIR!, `${p.code}.html`), documentPiece(p));
  });
});
