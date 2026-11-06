import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { GuideScreen } from './GuideScreen.js';
import { normalize } from './help-logic.js';

vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
  }),
}));

const USER = '01900000-0000-7000-8000-000000000001';

async function rememberRoles(roles: string[]) {
  await getDb().navigation.put({
    user_id: USER,
    roles,
    sections: [],
    saved_at: '2026-11-06T09:00:00.000Z',
  });
}

function renderGuide() {
  return render(
    <MemoryRouter initialEntries={['/aide']}>
      <GuideScreen />
    </MemoryRouter>,
  );
}

describe('Guide et aide (AV-525)', () => {
  beforeEach(async () => {
    await getDb().navigation.clear();
  });
  afterEach(async () => {
    cleanup();
    await getDb().navigation.clear();
  });

  it('normalize : sans accents ni ligature', () => {
    expect(normalize('Œufs à couver')).toBe('oeufs a couver');
  });

  it('annonce le profil et met d’abord les parcours de son rôle', async () => {
    await rememberRoles(['ADMIN']);
    renderGuide();
    expect(
      await screen.findByText('Vous êtes connecté avec le profil : Administrateur.'),
    ).toBeInTheDocument();
    const journeys = within(screen.getByRole('region', { name: 'Parcours de bout en bout' }));
    const titles = journeys
      .getAllByText(/./, { selector: 'summary > span' })
      .map((node) => node.textContent);
    expect(titles[0]).toBe('Mettre l’application en route');
    expect(titles).toContain('Démarrer et conduire un lot d’élevage');
  });

  it('une page réservée à un autre profil est marquée, une page ouverte ne l’est pas', async () => {
    await rememberRoles(['MAGASINIER']);
    renderGuide();
    await screen.findByText('Vous êtes connecté avec le profil : Magasinier.');
    const pages = within(screen.getByRole('region', { name: 'Les pages, par domaine' }));
    const organization = pages.getByText('Organisation').closest('li')!;
    expect(within(organization).getByText('Autre profil')).toBeInTheDocument();
    const stock = pages.getByText('Stock par emplacement').closest('li')!;
    expect(within(stock).queryByText('Autre profil')).not.toBeInTheDocument();
  });

  it('la recherche filtre parcours, pages et questions, sans tenir compte des accents', async () => {
    await rememberRoles(['RESP_FERME']);
    const user = userEvent.setup();
    renderGuide();
    await user.type(await screen.findByLabelText('Chercher dans le guide'), 'MIRAGE');
    const journeys = within(screen.getByRole('region', { name: 'Parcours de bout en bout' }));
    expect(journeys.getByText('Collecter les œufs et faire éclore')).toBeInTheDocument();
    expect(journeys.queryByText('Mettre l’application en route')).not.toBeInTheDocument();
    const pages = within(screen.getByRole('region', { name: 'Les pages, par domaine' }));
    expect(pages.getByText('Incubations')).toBeInTheDocument();
    expect(pages.queryByText('Fournisseurs')).not.toBeInTheDocument();
    // « œufs » se trouve aussi par « oeufs » (accents et ligature ignorés).
    await user.clear(screen.getByLabelText('Chercher dans le guide'));
    await user.type(screen.getByLabelText('Chercher dans le guide'), 'oeufs');
    expect(screen.getByText('Collecter les œufs et faire éclore')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Chercher dans le guide'));
    await user.type(screen.getByLabelText('Chercher dans le guide'), 'zzzzzz');
    expect(await screen.findByText('Rien ne correspond à cette recherche.')).toBeInTheDocument();
  });
});
