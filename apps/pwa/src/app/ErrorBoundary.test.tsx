import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary.js';

function Broken(): never {
  throw new Error('panne');
}

describe('ErrorBoundary', () => {
  it('une erreur d’affichage montre un message et un bouton de rechargement, pas un écran blanc', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary resetKey="/ventes/nouvelle">
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Un problème est survenu sur cet écran.');
    expect(screen.getByRole('button', { name: 'Recharger l’application' })).toBeInTheDocument();
  });

  it('sans erreur : affiche l’écran', () => {
    render(
      <ErrorBoundary resetKey="/">
        <p>Accueil</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('Accueil')).toBeInTheDocument();
  });
});
