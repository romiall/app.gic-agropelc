import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { fetchAttachmentContent } from '../../sync/attachment-content.js';
import { ServerPhoto } from './PhotoViews.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/attachment-content.js', () => ({ fetchAttachmentContent: vi.fn() }));

function renderPhoto() {
  return render(
    <MemoryRouter>
      <ServerPhoto attachmentId="01900000-0000-7000-8000-0000000000f1" alt="Bon de livraison" />
    </MemoryRouter>,
  );
}

describe('Photo lue sur le serveur : pièce archivée (AV-539)', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(fetchAttachmentContent).mockReset();
  });

  it('dit où retrouver la photo vidée du serveur, sans image cassée ni « Réessayer »', async () => {
    vi.mocked(fetchAttachmentContent).mockResolvedValue({
      ok: false,
      reason: 'ARCHIVED',
      archived: {
        archivedAt: '2026-11-08T10:00:00.000Z',
        reference: 'RC-2026-000123',
        volumeFileName: 'GIC-photos_2026-09_RECEPTION_20261108.zip',
        entryPath: 'RECEPTION/2026-09/RC-2026-000123_20260910-101530_0000a1b2.jpg',
      },
    });
    const user = userEvent.setup();
    renderPhoto();
    await user.click(screen.getByRole('button', { name: 'Voir la photo' }));
    expect(
      await screen.findByText(
        /Photo archivée le .*2026.* : elle n’est plus sur le serveur\. Cherchez-la dans l’archive de l’entreprise, par sa référence RC-2026-000123\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull();
  });

  it('sans détails du serveur : le message général', async () => {
    vi.mocked(fetchAttachmentContent).mockResolvedValue({ ok: false, reason: 'ARCHIVED' });
    const user = userEvent.setup();
    renderPhoto();
    await user.click(screen.getByRole('button', { name: 'Voir la photo' }));
    expect(
      await screen.findByText(
        'Photo archivée : elle n’est plus sur le serveur. Cherchez-la dans l’archive de l’entreprise.',
      ),
    ).toBeInTheDocument();
  });

  it('une autre panne reste réessayable', async () => {
    vi.mocked(fetchAttachmentContent).mockResolvedValue({ ok: false, reason: 'ERROR' });
    const user = userEvent.setup();
    renderPhoto();
    await user.click(screen.getByRole('button', { name: 'Voir la photo' }));
    expect(await screen.findByText('Photo indisponible pour le moment.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument();
  });
});
