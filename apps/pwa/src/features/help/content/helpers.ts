/** Constructeurs courts du contenu de l'aide (AV-525) : lisent mieux qu'un littéral d'objet par action. */
import type { HelpAction, HelpKind, HelpLink } from '../help-types.js';

type ActionExtras = Omit<HelpAction, 'label' | 'what' | 'kind'>;

/** Une action de la page : nature, libellé, ce qu'elle fait ; rôles, écran cible et réseau en option. */
export const act = (
  kind: HelpKind,
  label: string,
  what: string,
  extras: ActionExtras = {},
): HelpAction => ({ kind, label, what, ...extras });

/** Une étape suivante : où aller et pourquoi. */
export const go = (label: string, to: string, why: string): HelpLink => ({ label, to, why });
