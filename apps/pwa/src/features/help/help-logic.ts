/**
 * Logique de l'aide contextuelle (AV-525, ADR-058) : quelle page d'aide va avec quel chemin, qui peut faire
 * quoi sur la page, quels parcours et quelles pages conviennent à un profil. Pure : aucune lecture de
 * l'appareil, les rôles viennent de l'appelant.
 */
import { matchPath } from 'react-router-dom';
import { screensForRoles, SCREENS, type ScreenEntry } from '../../app/screens.js';
import { SCREEN_HELP } from './content/index.js';
import type { HelpAction, Journey, ScreenHelp } from './help-types.js';

/** Minuscules sans accents : « œufs » se trouve par « oeufs ». */
export const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/œ/gi, 'oe')
    .toLowerCase();

const paramCount = (path: string): number => (path.match(/:/g) ?? []).length;

/** Routes fixes avant routes à paramètre : `/clients/nouveau` avant `/clients/:customerId`. */
const ORDERED: readonly ScreenHelp[] = [...SCREEN_HELP].sort(
  (a, b) => paramCount(a.path) - paramCount(b.path),
);

/** Page d'aide du chemin courant, `undefined` hors registre (écran de développement…). */
export function helpFor(pathname: string): ScreenHelp | undefined {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return ORDERED.find((entry) => matchPath({ path: entry.path, end: true }, clean) !== null);
}

/** Rôles de la page : les siens (écran de détail) ou ceux de son entrée du registre. */
export function rolesOfScreen(help: ScreenHelp): readonly string[] | 'ALL' {
  if (help.roles !== undefined) return help.roles;
  return SCREENS.find((screen) => screen.path === help.path)?.roles ?? 'ALL';
}

/**
 * Le profil peut-il ? Rôles inconnus de l'appareil (accueil jamais ouvert en ligne) : oui, comme partout
 * dans la PWA (`holdsAnyRole`) — le serveur revérifie.
 */
export function canDo(allowed: readonly string[] | 'ALL', held: readonly string[]): boolean {
  if (allowed === 'ALL') return true;
  return held.length === 0 || held.some((role) => allowed.includes(role));
}

export interface HelpView {
  /** La page elle-même est proposée à ce profil. */
  readonly accessible: boolean;
  readonly doable: readonly HelpAction[];
  readonly reserved: readonly { readonly action: HelpAction; readonly roles: readonly string[] }[];
}

/** Sépare les actions de la page : celles du profil, et celles qu'il faut un autre rôle pour faire. */
export function viewOf(help: ScreenHelp, held: readonly string[]): HelpView {
  const screenRoles = rolesOfScreen(help);
  const doable: HelpAction[] = [];
  const reserved: { action: HelpAction; roles: readonly string[] }[] = [];
  for (const action of help.actions) {
    const allowed = action.roles ?? screenRoles;
    if (canDo(allowed, held)) doable.push(action);
    else reserved.push({ action, roles: allowed === 'ALL' ? [] : allowed });
  }
  return { accessible: canDo(screenRoles, held), doable, reserved };
}

/** Parcours d'abord écrits pour l'un des rôles du profil, puis les autres ; ordre d'écriture sinon. */
export function journeysFor(
  journeys: readonly Journey[],
  held: readonly string[],
): { readonly mine: readonly Journey[]; readonly others: readonly Journey[] } {
  const mine = journeys.filter((journey) => journey.roles.some((role) => held.includes(role)));
  const others = journeys.filter((journey) => !mine.includes(journey));
  return { mine, others };
}

/** Pages du registre proposées au profil, par domaine, avec la page d'aide qui les décrit. */
export function pagesForRoles(
  held: readonly string[],
): readonly { readonly screen: ScreenEntry; readonly help: ScreenHelp | undefined }[] {
  return screensForRoles(held).map((screen) => ({
    screen,
    help: SCREEN_HELP.find((entry) => entry.path === screen.path),
  }));
}
