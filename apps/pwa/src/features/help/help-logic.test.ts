import { describe, expect, it } from 'vitest';
import { ROUTES } from '../../app/screens.js';
import { JOURNEYS } from './content/index.js';
import { canDo, helpFor, journeysFor, rolesOfScreen, viewOf } from './help-logic.js';

describe('helpFor : la page d’aide d’un chemin', () => {
  it('route fixe', () => {
    expect(helpFor(ROUTES.productionLots)?.title).toBe('Lots de production');
    expect(helpFor('/production/nouveau-lot')?.title).toBe('Nouveau lot et entrée d’animaux');
  });

  it('route à paramètre, et la route fixe voisine l’emporte', () => {
    expect(helpFor('/production/lots/abc-123')?.title).toBe('Saisie du jour');
    expect(helpFor('/ventes/nouvelle')?.title).toBe('Nouvelle vente');
    expect(helpFor('/ventes/abc')?.title).toBe('Détail d’une vente');
    expect(helpFor('/clients/nouveau')?.title).toBe('Nouveau prospect');
    expect(helpFor('/clients/abc')?.title).toBe('Fiche client');
    expect(helpFor('/clients/abc/echange')?.title).toBe('Noter un échange');
    expect(helpFor('/stock/receptions/sans-document')?.title).toBe('Réception sans document');
    expect(helpFor('/stock/receptions/abc')?.title).toBe('Réception d’un transfert');
    expect(helpFor('/achats/receptions/sans-bon')?.title).toBe('Réception sans bon de commande');
    expect(helpFor('/achats/receptions/abc')?.title).toBe('Réception d’un bon de commande');
    expect(helpFor('/commandes/abc/livrer')?.title).toBe('Livrer une commande');
  });

  it('barre oblique finale ignorée ; route inconnue : rien', () => {
    expect(helpFor('/production/lots/')?.title).toBe('Lots de production');
    expect(helpFor('/dev/composants')).toBeUndefined();
    expect(helpFor('/')?.title).toBe('Accueil');
  });
});

describe('viewOf : ce que le profil peut faire, et ce qui demande un autre rôle', () => {
  const lots = helpFor(ROUTES.productionLots)!;
  const labels = (actions: readonly { readonly label: string }[]) => actions.map((a) => a.label);

  it('l’Administrateur peut créer un lot et faire entrer les animaux (AV-524)', () => {
    const view = viewOf(lots, ['ADMIN']);
    expect(view.accessible).toBe(true);
    expect(labels(view.doable)).toEqual(
      expect.arrayContaining([
        'Créer un lot',
        'Faire entrer les animaux dans un lot',
        'Consulter la fiche d’un lot',
      ]),
    );
  });

  it('le responsable de ferme saisit mais ne crée pas de lot : l’action est « réservée » et nomme les rôles', () => {
    const view = viewOf(lots, ['RESP_FERME']);
    expect(labels(view.doable)).toContain('Saisir la journée d’un lot');
    expect(labels(view.doable)).not.toContain('Créer un lot');
    const reserved = view.reserved.find((entry) => entry.action.label === 'Créer un lot');
    expect(reserved?.roles).toEqual(['RESP_PRODUCTION', 'ADMIN']);
  });

  it('rôles inconnus de l’appareil : tout est proposé, le serveur revérifie', () => {
    const view = viewOf(lots, []);
    expect(view.reserved).toEqual([]);
    expect(view.accessible).toBe(true);
  });

  it('une page réservée à d’autres profils le dit', () => {
    const view = viewOf(helpFor(ROUTES.organization)!, ['MAGASINIER']);
    expect(view.accessible).toBe(false);
  });

  it('une page ouverte à tous l’est pour tout profil', () => {
    const home = helpFor(ROUTES.home)!;
    expect(rolesOfScreen(home)).toBe('ALL');
    expect(canDo('ALL', ['VENDEUR_PDV'])).toBe(true);
    expect(viewOf(home, ['VENDEUR_PDV']).accessible).toBe(true);
  });
});

describe('journeysFor', () => {
  it('les parcours écrits pour un rôle du profil viennent d’abord', () => {
    const { mine, others } = journeysFor(JOURNEYS, ['VENDEUR_PDV']);
    expect(mine.map((journey) => journey.id)).toContain('pos');
    expect(others.map((journey) => journey.id)).not.toContain('pos');
    expect(mine.length + others.length).toBe(JOURNEYS.length);
  });

  it('l’Administrateur reçoit le parcours de mise en route et celui du lot', () => {
    const { mine } = journeysFor(JOURNEYS, ['ADMIN']);
    expect(mine.map((journey) => journey.id)).toEqual(expect.arrayContaining(['setup', 'lot']));
  });
});
