/**
 * Aperçu de contrôle visuel : avec `PIECES_APERCU_DIR`, écrit le document HTML de chaque pièce
 * d'exemple dans ce dossier, pour une comparaison à l'œil (ou par capture) avec
 * `pieces-papier/apercu/*.png`. Sans la variable, le test ne fait rien.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { documentPiece, LOGO_PIECES } from './document.js';
import { EXEMPLE_BV } from './exemples.js';
import { bonDeVente } from './pieces-argent.js';

const DIR = process.env.PIECES_APERCU_DIR;

describe.runIf(Boolean(DIR))('aperçu des pièces (contrôle visuel)', () => {
  it('écrit les documents', () => {
    mkdirSync(DIR!, { recursive: true });
    const ctx = { logo: LOGO_PIECES };
    const pieces = [bonDeVente(EXEMPLE_BV, ctx)];
    for (const p of pieces) writeFileSync(join(DIR!, `${p.code}.html`), documentPiece(p));
  });
});
