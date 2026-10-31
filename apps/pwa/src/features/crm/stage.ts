/**
 * Présentation du stade d'un compte (lot L5) : ton de la pastille. Aucune logique métier ici : le stade
 * lui-même vient du jeu `customers`.
 */
import type { BadgeTone } from '../../components/ui/index.js';

export function stageTone(stage: string): BadgeTone {
  switch (stage) {
    case 'CUSTOMER':
      return 'brand';
    case 'PROSPECT':
      return 'info';
    default:
      return 'muted';
  }
}
