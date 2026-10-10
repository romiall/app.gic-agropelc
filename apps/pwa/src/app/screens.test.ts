import { describe, expect, it } from 'vitest';
import { ROUTES, routeOfAction, SCREENS, screensForRoles } from './screens.js';

describe('app/screens — registre et navigation par rôle', () => {
  it('une route fournie par le serveur l’emporte ; à défaut, celle de l’écran livré', () => {
    expect(routeOfAction({ code: 'SYNC_STATUS', route: null })).toBe(ROUTES.sync);
    expect(routeOfAction({ code: 'SYNC_STATUS', route: '/autre' })).toBe('/autre');
  });

  it('une action sans écran livré reste sans route (affichée « Bientôt »)', () => {
    expect(routeOfAction({ code: 'CONTROL_TOWER', route: null })).toBeNull();
  });

  it('propose les écrans de tous les rôles de l’utilisateur, et les écrans communs à tous', () => {
    const common = screensForRoles([]).map((screen) => screen.id);
    expect(common).toEqual(expect.arrayContaining(['ECR-ADM-03', 'ECR-SYN-01']));
    for (const screen of SCREENS) {
      if (screen.roles === 'ALL') continue;
      expect(screensForRoles([...screen.roles]).map((s) => s.id)).toContain(screen.id);
      expect(screensForRoles(['ROLE_INCONNU']).map((s) => s.id)).not.toContain(screen.id);
    }
  });

  it('chaque code d’action ne mène qu’à un seul écran, et chaque chemin est unique', () => {
    const codes = SCREENS.flatMap((screen) => screen.actionCodes);
    expect(new Set(codes).size).toBe(codes.length);
    const paths = SCREENS.map((screen) => screen.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
