/** Une pièce rendue : ses feuilles HTML, prêtes à être posées dans un document imprimable. */
import type { Format } from './gabarit.js';

export interface PieceRendue {
  /** Code de la pièce papier (BV, RE, BD…). */
  readonly code: string;
  readonly titre: string;
  readonly fmt: Format;
  /** Une chaîne `<section class="feuille">` par feuille. */
  readonly pages: readonly string[];
}
