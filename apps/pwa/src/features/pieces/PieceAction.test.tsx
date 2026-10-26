import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EXEMPLE_RE } from './exemples.js';
import { PieceAction } from './PieceAction.js';
import { noterImpression } from './reimpression.js';

describe('Voir et imprimer une pièce (REQ-301, REQ-302)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it('ouvre la pièce remplie dans un cadre, avec le bouton « Imprimer »', async () => {
    render(<PieceAction cle="RE:1" demande={() => ({ code: 'RE', donnees: EXEMPLE_RE })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Voir la pièce' }));
    const cadre = screen.getByTitle(/RE/);
    expect(cadre.getAttribute('srcdoc')).toContain(EXEMPLE_RE.numero!);
    expect(screen.getByRole('button', { name: 'Imprimer' })).toBeTruthy();
    expect(screen.queryByText(/duplicata/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Masquer la pièce' }));
    expect(screen.queryByTitle(/RE/)).toBeNull();
  });

  it('une pièce déjà imprimée sur cet appareil sera réimprimée en duplicata', async () => {
    noterImpression('RE:2', new Date('2026-10-25T09:00:00Z'));
    render(<PieceAction cle="RE:2" demande={() => ({ code: 'RE', donnees: EXEMPLE_RE })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Voir la pièce' }));
    expect(screen.getByText(/25\/10\/2026/)).toBeTruthy();
    // L'aperçu porte déjà la mention : l'impression part directement du clic.
    expect(screen.getByTitle(/RE/).getAttribute('srcdoc')).toContain('Duplicata');
  });

  it('données absentes ou incohérentes : un message, pas une erreur de l’écran', async () => {
    render(
      <>
        <PieceAction cle="a" libelle="Pièce A" demande={() => null} />
        <PieceAction
          cle="b"
          libelle="Pièce B"
          demande={() => {
            throw new Error('incohérent');
          }}
        />
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Pièce A' }));
    await userEvent.click(screen.getByRole('button', { name: 'Pièce B' }));
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });
});
