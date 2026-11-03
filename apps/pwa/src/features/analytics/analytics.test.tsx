import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { AnalyticsExplorerScreen } from './AnalyticsExplorerScreen.js';
import {
  CommercialDashboardScreen,
  DirectionDashboardScreen,
  FinanceDashboardScreen,
  ProductionDashboardScreen,
  StockDashboardScreen,
} from './RoleDashboardScreen.js';
import {
  buildExplorerDrillDownUrl,
  dashboardPath,
  findProjectedSnapshot,
  formatMetricValue,
  formatVariationPct,
} from './dashboards.js';
import {
  buildExportRequestPayload,
  buildViewDeletePayload,
  buildViewSavePayload,
  buildViewSetDefaultPayload,
  buildViewSharePayload,
  defaultDefinitionForDataset,
  parseDefinitionFromSearch,
} from './explorer.js';

vi.mock('../sync/sync-engine-instance.js', () => ({ getSyncEngine: () => undefined }));
vi.mock('../../sync/api-client.js', () => ({ authorizedRequest: vi.fn() }));
vi.mock('../auth/AuthContext.js', () => ({
  useAuth: () => ({
    state: {
      status: 'unlocked',
      userId: '01900000-0000-7000-8000-000000000001',
      deviceStatus: 'ACTIVE',
    },
  }),
}));

const USER_ID = '01900000-0000-7000-8000-000000000001';

describe('Analytique & Pilotage (ECR-ANA-01 à 06)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.navigation.put({
      user_id: USER_ID,
      full_name: 'Directeur Général',
      roles: ['DIRECTION'],
      sections: [],
      saved_at: '2026-10-15T08:00:00.000Z',
    });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    vi.mocked(authorizedRequest).mockReset();
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.navigation.clear();
  });

  it('fonctions pures des tableaux de bord : chemins, formatage, drill-down et instantanés hors ligne', () => {
    expect(dashboardPath('direction', 'MONTH')).toBe(
      '/api/v1/analytics/dashboards/direction?period=MONTH',
    );
    expect(formatMetricValue(125000, 'xaf')).toContain('125 000 F CFA');
    expect(formatMetricValue(12.5, 'pct')).toContain('12,5 %');
    expect(formatMetricValue(null, 'xaf')).toBe('—');
    expect(formatVariationPct(8.4)).toBe('+8,4 %');

    const snapshot = findProjectedSnapshot(
      [
        {
          scope_key: 'direction',
          period_key: 'MONTH',
          computed_at: '2026-10-15T10:00:00.000Z',
          kpis: [
            {
              code: 'KPI-DIR-CA-NET',
              label: 'CA net consolidé',
              unit: 'xaf',
              value: 4500000,
            },
          ],
        },
      ],
      'direction',
      'MONTH',
    );
    expect(snapshot?.kpis).toHaveLength(1);
    expect(snapshot?.kpis[0]?.value).toBe(4500000);

    const def = {
      dataset: 'sales',
      period: { code: 'MONTH' as const },
      dimensions: ['site_id'],
      measures: ['revenue_net_xaf'],
      filters: [],
      sort: [],
    };
    const url = buildExplorerDrillDownUrl('/pilotage/explorateur', def);
    const parsed = parseDefinitionFromSearch(url.slice(url.indexOf('?')));
    expect(parsed?.dataset).toBe('sales');
    expect(parsed?.measures).toEqual(['revenue_net_xaf']);
  });

  it('fonctions pures de l’explorateur : définition par défaut, vues sauvegardées et exports', () => {
    const def = defaultDefinitionForDataset({
      code: 'sales',
      label: 'Ventes',
      temporality: 'FLOW',
      dimensions: [{ name: 'site_id', label: 'Site', type: 'id' }],
      measures: [
        {
          name: 'cost_xaf',
          label: 'Coût',
          aggregate: 'SUM',
          unit: 'xaf',
          additive: true,
          forbidden: true,
        },
        {
          name: 'revenue_net_xaf',
          label: 'CA net',
          aggregate: 'SUM',
          unit: 'xaf',
          additive: true,
          forbidden: false,
        },
      ],
    });
    expect(def.measures).toEqual(['revenue_net_xaf']);

    expect(
      buildViewSavePayload({
        name: 'Ventes par site',
        definition: def,
        catalogVersion: 1,
      }).ok,
    ).toBe(true);
    expect(buildViewSharePayload(['FINANCE']).ok).toBe(true);
    expect(buildViewSetDefaultPayload('DIRECTION').ok).toBe(true);
    expect(buildViewDeletePayload().ok).toBe(true);
    expect(
      buildExportRequestPayload({
        definition: def,
        format: 'CSV',
        catalogVersion: 1,
      }).ok,
    ).toBe(true);
  });

  it('affiche les 5 tableaux de bord par rôle (ECR-ANA-01 à 05)', async () => {
    vi.mocked(authorizedRequest).mockImplementation((_db, path) => {
      const target = String(path);
      const ok = (data: unknown) => Promise.resolve({ ok: true, data }) as never;
      if (target.startsWith('/api/v1/analytics/dashboards/')) {
        return ok({
          code: 'direction',
          period: {
            code: 'MONTH',
            fromDay: '2026-10-01',
            toDay: '2026-10-31',
            days: 31,
          },
          previousPeriod: {
            code: 'MONTH',
            fromDay: '2026-09-01',
            toDay: '2026-09-30',
            days: 30,
          },
          blocks: [
            {
              code: 'VENTES',
              title: 'Activité commerciale',
              kpis: [
                {
                  code: 'KPI-DIR-CA-NET',
                  label: 'Chiffre d’affaires net',
                  unit: 'xaf',
                  value: 2500000,
                  variationPct: 12.5,
                },
              ],
              details: [{ label: 'Bonabéri', value: 2500000, unit: 'xaf' }],
              unavailable: null,
            },
          ],
          freshness: {
            computedAt: '2026-10-15T10:00:00.000Z',
            devicesInScope: 4,
            staleDevices: 0,
            staleAfterHours: 24,
          },
          computedAt: '2026-10-15T10:00:00.000Z',
        });
      }
      return ok({});
    });

    for (const Component of [
      DirectionDashboardScreen,
      CommercialDashboardScreen,
      StockDashboardScreen,
      ProductionDashboardScreen,
      FinanceDashboardScreen,
    ]) {
      render(
        <MemoryRouter>
          <Component />
        </MemoryRouter>,
      );
      expect(await screen.findByText('Chiffre d’affaires net')).toBeTruthy();
      cleanup();
    }
  });

  it('affiche ECR-ANA-06 (explorateur) et permet d’exécuter une analyse et de demander un export CSV', async () => {
    vi.mocked(authorizedRequest).mockImplementation((_db, path) => {
      const target = String(path);
      const ok = (data: unknown) => Promise.resolve({ ok: true, data }) as never;
      if (target === '/api/v1/analytics/catalog') {
        return ok({
          version: 1,
          datasets: [
            {
              code: 'sales',
              label: 'Ventes',
              temporality: 'FLOW',
              dimensions: [{ name: 'site_id', label: 'Site', type: 'id' }],
              measures: [
                {
                  name: 'revenue_net_xaf',
                  label: 'CA net',
                  aggregate: 'SUM',
                  unit: 'xaf',
                  additive: true,
                  forbidden: false,
                },
              ],
            },
          ],
        });
      }
      if (target === '/api/v1/analytics/views') {
        return ok({ views: [] });
      }
      if (target === '/api/v1/analytics/exports') {
        return ok({ exports: [] });
      }
      if (target === '/api/v1/analytics/query') {
        return ok({
          dataset: 'sales',
          catalogVersion: 1,
          period: {
            code: 'MONTH',
            fromDay: '2026-10-01',
            toDay: '2026-10-31',
            days: 31,
          },
          columns: [
            { name: 'site_id', label: 'Site', kind: 'dimension', dimensionType: 'id' },
            { name: 'revenue_net_xaf', label: 'CA net', kind: 'measure', unit: 'xaf' },
          ],
          rows: [{ values: { site_id: 'Bonabéri', revenue_net_xaf: 950000 } }],
          rowCount: 1,
          totals: { revenue_net_xaf: 950000 },
          freshness: {
            computedAt: '2026-10-15T10:00:00.000Z',
            devicesInScope: 2,
            staleDevices: 0,
            staleAfterHours: 24,
          },
          scopeTruncated: false,
        });
      }
      return ok({});
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AnalyticsExplorerScreen />
      </MemoryRouter>,
    );

    const runBtn = await screen.findByRole('button', { name: /Exécuter l’analyse/i });
    await user.click(runBtn);
    expect(await screen.findByText('Bonabéri')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Exporter CSV/i }));
    const outbox = await getDb().outbox.toArray();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.command_type).toBe('analytics.export.request');
  });
});
