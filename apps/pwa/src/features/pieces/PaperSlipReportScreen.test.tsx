import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaperSlipReportScreen } from './PaperSlipReportScreen.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));

// Mocks
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '018f0000-0000-7000-0000-000000000001',
    },
  }),
}));

vi.mock('../sales/references.js', () => ({
  useSalesReferences: () => ({
    sites: [{ id: 'site-1', name: 'Magasin Central' }],
    customers: [{ id: 'cust-1', name: 'Hôtel Hilton', phonePrimary: '+237699001122' }],
    products: [{ id: 'prod-1', name: 'Poulet de chair vif' }],
    cashAccounts: [{ id: 'cash-1', name: 'Caisse Bonabéri' }],
  }),
}));

vi.mock('./report-submit.js', () => ({
  loadReportedSlipsFromDb: vi.fn().mockResolvedValue([
    {
      commandId: 'cmd-1',
      slipType: 'BV',
      paperSlipRef: 'BV-0010',
      occurredAt: '2026-11-03T10:00:00Z',
      submittedAt: '2026-11-03T10:05:00Z',
      authorUserId: '018f0000-0000-7000-0000-000000000001',
      description: 'BV BV-0010',
      amountXaf: 15000,
      status: 'SYNCED',
      hasAttachment: false,
    },
    {
      commandId: 'cmd-2',
      slipType: 'BV',
      paperSlipRef: 'BV-0011',
      occurredAt: '2026-11-03T11:00:00Z',
      submittedAt: '2026-11-03T11:05:00Z',
      authorUserId: '018f0000-0000-7000-0000-000000000001',
      description: 'BV BV-0011',
      amountXaf: 20000,
      status: 'SYNCED',
      hasAttachment: false,
    },
  ]),
  submitPaperSlipReport: vi.fn().mockResolvedValue({ status: 'SYNCED' }),
}));

vi.mock('../../storage/db.js', () => ({
  getDb: () => ({
    outbox: {
      toArray: vi.fn().mockResolvedValue([]),
    },
  }),
}));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (fn: () => unknown) => {
    // Rend 2 pièces pour les tests
    return [
      {
        commandId: 'cmd-1',
        slipType: 'BV',
        paperSlipRef: 'BV-0010',
        occurredAt: '2026-11-03T10:00:00Z',
        submittedAt: '2026-11-03T10:05:00Z',
        authorUserId: '018f0000-0000-7000-0000-000000000001',
        description: 'Vente 5 poulets',
        amountXaf: 15000,
        status: 'SYNCED',
        hasAttachment: false,
      },
      {
        commandId: 'cmd-2',
        slipType: 'BV',
        paperSlipRef: 'BV-0011',
        occurredAt: '2026-11-03T11:00:00Z',
        submittedAt: '2026-11-03T11:05:00Z',
        authorUserId: '018f0000-0000-7000-0000-000000000001',
        description: 'Vente 8 poulets',
        amountXaf: 24000,
        status: 'SYNCED',
        hasAttachment: false,
      },
    ];
  },
}));

describe('PaperSlipReportScreen (PP-B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('affiche le titre de l’écran et le formulaire de report', () => {
    render(<PaperSlipReportScreen />);
    expect(screen.getByText(/Reporter une pièce papier/i)).toBeInTheDocument();
    expect(screen.getByText(/Saisie du report/i)).toBeInTheDocument();
    expect(screen.getByText(/Registre des carnets/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Numéro de la pièce/i)).toBeInTheDocument();
  });

  it('alerte en temps réel si un doublon de référence est saisi', async () => {
    render(<PaperSlipReportScreen />);
    const refInput = screen.getByLabelText(/Numéro de la pièce/i);

    // BV-0010 existe déjà dans le mock
    fireEvent.change(refInput, { target: { value: 'BV-0010' } });

    await waitFor(() => {
      expect(screen.getByText(/Numéro déjà saisi/i)).toBeInTheDocument();
    });
  });

  it('alerte en temps réel si un saut dans la numérotation est détecté', async () => {
    render(<PaperSlipReportScreen />);
    const refInput = screen.getByLabelText(/Numéro de la pièce/i);

    // Max dans le mock est 11 -> saisir 15 doit détecter un saut
    fireEvent.change(refInput, { target: { value: 'BV-0015' } });

    await waitFor(() => {
      expect(screen.getByText(/Saut détecté/i)).toBeInTheDocument();
    });
  });

  it('bascule vers l’onglet Registre des carnets et affiche les KPIs', async () => {
    render(<PaperSlipReportScreen />);
    const registerTab = screen.getByRole('radio', { name: /Registre des carnets/i });
    fireEvent.click(registerTab);

    await waitFor(() => {
      expect(screen.getByText(/Total reporté/i)).toBeInTheDocument();
      expect(screen.getByText(/Plage \(Min - Max\)/i)).toBeInTheDocument();
      expect(screen.getByText(/Sauts détectés/i)).toBeInTheDocument();
    });
  });
});
