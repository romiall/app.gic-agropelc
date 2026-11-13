/**
 * Aide contextuelle (AV-525, ADR-058) : le contenu couvre toutes les pages de l'application et reste d'accord
 * avec le registre des écrans — une page ajoutée sans aide, un lien mort ou un rôle inconnu font échouer
 * l'essai, pour que l'aide ne se périme pas en silence.
 */
import { describe, expect, it } from 'vitest';
import { matchPath } from 'react-router-dom';
import { ROLE_SETS, ROUTES, SCREENS } from '../../app/screens.js';
import { FAQ, JOURNEYS, SCREEN_HELP } from './content/index.js';
import { ROLE_LABELS } from './help-types.js';

/** Routes de l'application : motifs de `ROUTES` (les fabriques de liens ne sont pas des routes). */
const PATTERNS: readonly string[] = Object.values(ROUTES).flatMap((value) =>
  typeof value === 'string' ? [value] : [],
);

const isKnownRoute = (target: string): boolean =>
  PATTERNS.some(
    (pattern) => matchPath({ path: pattern, end: true }, target.split('?')[0]!) !== null,
  );

describe('Aide : couverture des pages', () => {
  it('chaque route de l’application a une page d’aide, et une seule', () => {
    const helped = SCREEN_HELP.map((help) => help.path);
    expect([...PATTERNS].filter((path) => !helped.includes(path))).toEqual([]);
    expect(helped.filter((path, index) => helped.indexOf(path) !== index)).toEqual([]);
    // Aucune page d'aide ne décrit une route qui n'existe pas.
    expect(helped.filter((path) => !PATTERNS.includes(path))).toEqual([]);
  });

  it('chaque écran du registre a sa page d’aide et ne redéfinit pas ses rôles', () => {
    for (const screen of SCREENS) {
      const help = SCREEN_HELP.find((candidate) => candidate.path === screen.path);
      expect(help, `${screen.id} (${screen.path}) sans aide`).toBeDefined();
      expect(
        help?.roles,
        `${screen.id} : les rôles de l’aide viennent du registre`,
      ).toBeUndefined();
    }
  });

  it('une page de détail, sans entrée au registre, porte ses propres rôles', () => {
    for (const help of SCREEN_HELP) {
      if (SCREENS.some((screen) => screen.path === help.path)) continue;
      expect(help.roles, `${help.path} : rôles de la page de détail`).toBeDefined();
    }
  });

  it('chaque page dit à quoi elle sert et ce qu’on y fait, sans libellé d’action en double', () => {
    for (const help of SCREEN_HELP) {
      expect(help.title.trim().length, help.path).toBeGreaterThan(0);
      expect(help.purpose.trim().length, `${help.path} : à quoi sert la page`).toBeGreaterThan(20);
      expect(help.actions.length, `${help.path} : actions`).toBeGreaterThan(0);
      const labels = help.actions.map((action) => action.label);
      expect(new Set(labels).size, `${help.path} : libellés d’action en double`).toBe(
        labels.length,
      );
      for (const action of help.actions) {
        expect(action.what.trim().length, `${help.path} › ${action.label}`).toBeGreaterThan(5);
      }
    }
  });

  it('les liens (actions, étapes suivantes) mènent à des routes qui existent', () => {
    for (const help of SCREEN_HELP) {
      for (const action of help.actions) {
        if (action.to) expect(isKnownRoute(action.to), `${help.path} › ${action.label}`).toBe(true);
      }
      for (const link of help.next ?? []) {
        expect(isKnownRoute(link.to), `${help.path} › ${link.label}`).toBe(true);
      }
    }
  });

  it('les rôles cités sont des rôles de l’application', () => {
    const known = new Set(Object.keys(ROLE_LABELS));
    const check = (where: string, roles: readonly string[] | 'ALL' | undefined) => {
      if (roles === undefined || roles === 'ALL') return;
      for (const role of roles) expect(known.has(role), `${where} : rôle ${role}`).toBe(true);
    };
    for (const help of SCREEN_HELP) {
      check(help.path, help.roles);
      for (const action of help.actions) check(`${help.path} › ${action.label}`, action.roles);
    }
    for (const journey of JOURNEYS) {
      check(journey.id, journey.roles);
      for (const step of journey.steps) check(`${journey.id} › ${step.label}`, step.roles);
    }
  });
});

describe('Aide : parcours et questions', () => {
  it('chaque parcours a un identifiant unique et des étapes qui mènent à des routes qui existent', () => {
    const ids = JOURNEYS.map((journey) => journey.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const journey of JOURNEYS) {
      expect(journey.steps.length, journey.id).toBeGreaterThan(1);
      for (const step of journey.steps) {
        expect(isKnownRoute(step.to), `${journey.id} › ${step.label} (${step.to})`).toBe(true);
      }
    }
  });

  it('une étape sans rôles propres suit l’écran du registre qu’elle ouvre', () => {
    for (const journey of JOURNEYS) {
      for (const step of journey.steps) {
        if (step.roles) continue;
        const known = SCREENS.some((screen) => screen.path === step.to);
        expect(known, `${journey.id} › ${step.label} : écran du registre ou rôles explicites`).toBe(
          true,
        );
      }
    }
  });

  it('les questions fréquentes ont une réponse', () => {
    expect(FAQ.length).toBeGreaterThan(3);
    for (const item of FAQ) expect(item.answer.length).toBeGreaterThan(40);
  });
});

describe('Aide : la ferme (décision du porteur, AV-524)', () => {
  const help = (path: string) => SCREEN_HELP.find((candidate) => candidate.path === path)!;

  it('la création et l’entrée d’un lot sont décrites pour l’Administrateur et le responsable de production', () => {
    expect(ROLE_SETS.lotSetup).toEqual(expect.arrayContaining(['ADMIN', 'RESP_PRODUCTION']));
    const lots = help(ROUTES.productionLots);
    const create = lots.actions.find((action) => action.label === 'Créer un lot')!;
    expect(create.roles).toEqual(ROLE_SETS.lotSetup);
    expect(create.to).toBe(ROUTES.lotSetup);
  });

  it('les corrections de la ferme sont décrites : fiche du lot, collecte d’œufs', () => {
    const labels = (path: string) => help(path).actions.map((action) => action.label);
    expect(labels(ROUTES.lotSheet)).toEqual(
      expect.arrayContaining([
        'Clôturer le lot',
        'Annuler un lot planifié',
        'Annuler une entrée ou une pesée',
      ]),
    );
    expect(labels(ROUTES.eggCollection)).toContain('Annuler une collecte saisie par erreur');
  });
});
