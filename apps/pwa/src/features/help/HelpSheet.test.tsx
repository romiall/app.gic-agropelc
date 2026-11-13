import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HelpSheet } from './HelpSheet.js';

function renderSheet(pathname: string, roles: readonly string[]) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <HelpSheet open onClose={() => undefined} pathname={pathname} roles={roles} />
    </MemoryRouter>,
  );
}

describe('Panneau « Aide » d’une page (AV-525)', () => {
  afterEach(cleanup);

  it('l’Administrateur voit tout ce qu’il peut faire sur la liste des lots, sans rien de réservé', () => {
    renderSheet('/production/lots', ['ADMIN']);
    const dialog = within(screen.getByRole('dialog', { name: 'Lots de production' }));
    const can = within(dialog.getByRole('region', { name: 'Ce que vous pouvez faire ici' }));
    expect(can.getByText('Créer un lot')).toBeInTheDocument();
    expect(can.getByText('Faire entrer les animaux dans un lot')).toBeInTheDocument();
    expect(can.getByText('Consulter la fiche d’un lot')).toBeInTheDocument();
    expect(
      dialog.queryByRole('region', { name: 'Réservé à d’autres profils' }),
    ).not.toBeInTheDocument();
    // Les préalables expliquent pourquoi la liste peut être vide.
    expect(dialog.getByText(/Un lot n’apparaît ici qu’une fois actif/)).toBeInTheDocument();
  });

  it('le responsable de ferme voit « Créer un lot » comme réservé, avec les rôles qui le peuvent', () => {
    renderSheet('/production/lots', ['RESP_FERME']);
    const dialog = within(screen.getByRole('dialog', { name: 'Lots de production' }));
    const can = within(dialog.getByRole('region', { name: 'Ce que vous pouvez faire ici' }));
    expect(can.getByText('Saisir la journée d’un lot')).toBeInTheDocument();
    expect(can.queryByText('Créer un lot')).not.toBeInTheDocument();
    const reserved = within(dialog.getByRole('region', { name: 'Réservé à d’autres profils' }));
    expect(reserved.getByText('Créer un lot')).toBeInTheDocument();
    expect(reserved.getAllByText('Profils : Responsable production, Administrateur').length).toBe(
      2,
    );
  });

  it('une page réservée à d’autres profils le dit', () => {
    renderSheet('/administration/organisation', ['MAGASINIER']);
    expect(screen.getByText(/Cette page est réservée à d’autres profils/)).toBeInTheDocument();
  });

  it('le guide complet est à un lien', () => {
    renderSheet('/stock', ['MAGASINIER']);
    expect(screen.getByRole('link', { name: 'Guide complet' })).toHaveAttribute('href', '/aide');
  });

  it('page sans aide écrite : un message, le guide reste proposé', () => {
    renderSheet('/dev/composants', ['ADMIN']);
    expect(screen.getByText(/Pas d’aide écrite pour cette page/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Guide complet' })).toBeInTheDocument();
  });

  it('une page de détail a sa propre aide, ses rôles viennent d’elle', () => {
    renderSheet('/production/lots/01900000-0000-7000-8000-0000000000aa', ['RESP_FERME']);
    const dialog = within(screen.getByRole('dialog', { name: 'Saisie du jour' }));
    expect(dialog.getByText('Déclarer une mortalité')).toBeInTheDocument();
    // « Corriger une erreur » mène à la fiche du lot, que le responsable de ferme n'a pas.
    expect(
      within(dialog.getByRole('region', { name: 'Réservé à d’autres profils' })).getByText(
        'Corriger une erreur',
      ),
    ).toBeInTheDocument();
  });
});
