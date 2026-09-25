/**
 * Démonstration NFR-02 (« fonctionne sans réseau après installation ») au niveau du
 * squelette applicatif : installe le service worker (premier chargement en ligne), puis
 * recharge entièrement hors ligne. Le pipeline métier complet (connexion, synchronisation)
 * est couvert par les tests d'intégration serveur (`apps/server/test/sync-*`) et les tests
 * unitaires du moteur de synchronisation (`src/sync/*.test.ts`) — ce test-ci vérifie
 * seulement ce qu'eux ne peuvent pas : que le navigateur sert la coquille depuis le cache du
 * service worker, sans aucune requête réseau.
 */
import { expect, test } from '@playwright/test';

test.describe('Coquille applicative hors ligne (NFR-02)', () => {
  test('manifeste installable (nom, icônes, mode autonome) référencé par la page', async ({
    page,
  }) => {
    await page.goto('/');
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestHref).toBeTruthy();

    const manifest = await page.evaluate(async (href) => {
      const response = await fetch(href as string);
      return response.json();
    }, manifestHref);

    expect(manifest.name).toBe('GIC AGROPELC');
    expect(manifest.display).toBe('standalone');
    expect(manifest.lang).toBe('fr');
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  test('après un premier chargement en ligne, l’application se recharge entièrement hors ligne', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();

    // `navigator.serviceWorker.ready` : l'enregistrement initial a un worker actif pour ce
    // périmètre — mais cette toute première page n'est jamais elle-même « contrôlée »
    // (`.controller` reste `null` tant qu'aucune navigation n'a eu lieu après l'activation,
    // en l'absence de `clientsClaim()`). Un premier rechargement, encore en ligne, obtient
    // ce contrôle et précache la coquille avant la coupure réseau ci-dessous.
    await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true));
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    await context.setOffline(true);
    await page.reload();

    await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();
    await expect(page.getByLabel('Téléphone')).toBeVisible();
    await expect(page.getByLabel('Mot de passe')).toBeVisible();
  });
});
