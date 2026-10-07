import { describe, expect, it } from 'vitest';
import {
  HOME_SEVERITIES,
  HOME_TONES,
  HOME_UNITS,
  homeActionSchema,
  homeKpiSchema,
  homeResponseSchema,
  homeSignalSchema,
} from './home.js';

const kpi = {
  code: 'CA_JOUR',
  label: 'Chiffre d’affaires du jour',
  value: 125_000,
  unit: 'XAF',
  detail: '12 ventes',
  delta: { label: '+8 % sur hier', direction: 'up', tone: 'good' },
  series: [
    { day: '2026-10-06', value: 115_000 },
    { day: '2026-10-07', value: 125_000 },
  ],
  tone: 'neutral',
} as const;

const response = {
  generatedAt: '2026-10-07T08:00:00.000Z',
  businessDay: '2026-10-07',
  user: { fullName: 'Awa Ngo', roles: ['RESP_COMMERCIAL'] },
  signals: [
    {
      code: 'APPROVALS_PENDING',
      severity: 'WARNING',
      title: 'Validations en attente',
      detail: null,
      count: 3,
      action: { label: 'Voir', route: null },
    },
  ],
  sections: [
    {
      role: 'RESP_COMMERCIAL',
      roleLabel: 'Responsable commercial',
      scopeLabel: 'Votre équipe',
      actions: [
        { code: 'NEW_ORDER', label: 'Nouvelle commande', hint: null, route: null, primary: true },
      ],
      kpis: [kpi],
      activity: [
        {
          code: 'RECENT_SALES',
          title: 'Ventes récentes',
          items: [
            {
              id: 'VTE-1',
              at: '2026-10-07T07:30:00.000Z',
              label: 'VTE-DLA-2026-000001',
              detail: 'Restaurant du port',
              amountXaf: 9500,
              tone: 'neutral',
            },
          ],
        },
      ],
    },
  ],
};

describe('accueil par rôle (GET /api/v1/home)', () => {
  it('énumérations closes', () => {
    expect(HOME_TONES).toEqual(['neutral', 'good', 'warn', 'bad']);
    expect(HOME_UNITS).toContain('XAF');
    expect(HOME_SEVERITIES).toEqual(['CRITICAL', 'WARNING', 'INFO']);
  });

  it('accepte une réponse complète, une valeur indisponible et l’absence de courbe', () => {
    expect(homeResponseSchema.parse(response)).toEqual(response);
    expect(
      homeKpiSchema.safeParse({ ...kpi, value: null, delta: null, series: null }).success,
    ).toBe(true);
  });

  it('refuse une unité, un ton ou une gravité inconnus', () => {
    expect(homeKpiSchema.safeParse({ ...kpi, unit: 'EUR' }).success).toBe(false);
    expect(homeKpiSchema.safeParse({ ...kpi, tone: 'rouge' }).success).toBe(false);
    expect(homeSignalSchema.safeParse({ ...response.signals[0], severity: 'URGENT' }).success).toBe(
      false,
    );
  });

  it('refuse un jour métier mal formé et un compte négatif', () => {
    expect(homeResponseSchema.safeParse({ ...response, businessDay: '07/10/2026' }).success).toBe(
      false,
    );
    expect(homeSignalSchema.safeParse({ ...response.signals[0], count: -1 }).success).toBe(false);
    expect(
      homeKpiSchema.safeParse({ ...kpi, series: [{ day: '2026-10-7', value: 1 }] }).success,
    ).toBe(false);
  });

  it('refuse une action sans libellé', () => {
    expect(
      homeActionSchema.safeParse({ code: 'X', label: '', hint: null, route: null, primary: false })
        .success,
    ).toBe(false);
  });
});
