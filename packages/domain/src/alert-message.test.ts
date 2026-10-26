import { describe, expect, it } from 'vitest';
import { ALERT_TYPES, alertDefinitionOf } from './alerts.js';
import { alertCarriesProtectedValue, renderAlertMessage } from './alert-message.js';

describe('SYNC_STALE : dernière synchronisation et départ du silence (P9-10, AV-422)', () => {
  const render = (payload: Record<string, unknown>) =>
    renderAlertMessage('SYNC_STALE', payload, { showProtected: false }).message;

  it('appareil déjà contacté, silence compté depuis ce contact : une seule date', () => {
    expect(
      render({
        device_label: 'Tablette Akwa',
        last_sync_at: '2026-10-14T08:00:00.000Z',
        hours_since: 26,
      }),
    ).toBe('Appareil : Tablette Akwa ; Dernière synchronisation : 2026-10-14 ; Heures : 26 h');
  });

  it('appareil jamais contacté : le départ du silence seul, sans fausse « dernière synchronisation »', () => {
    const message = render({
      device_label: 'Tablette Akwa',
      silent_since: '2026-10-13T08:00:00.000Z',
      hours_since: 25,
    });
    expect(message).toBe(
      'Appareil : Tablette Akwa ; Silencieux depuis : 2026-10-13 ; Heures : 25 h',
    );
    expect(message).not.toContain('Dernière synchronisation');
  });

  it('appareil réactivé après son dernier contact : les deux dates, les heures partent de la réactivation', () => {
    expect(
      render({
        device_label: 'Tablette Akwa',
        last_sync_at: '2026-10-01T08:00:00.000Z',
        silent_since: '2026-10-10T08:00:00.000Z',
        hours_since: 30,
      }),
    ).toBe(
      'Appareil : Tablette Akwa ; Dernière synchronisation : 2026-10-01 ; Silencieux depuis : 2026-10-10 ; Heures : 30 h',
    );
  });
});

describe('renderAlertMessage (ADR-061 §11, AV-390)', () => {
  const payload = {
    location_label: 'PDV Bonabéri',
    business_day: '2026-10-14',
    loss_quantity: 12.5,
    loss_value_xaf: 1_250_000,
  };

  it('affiche la valeur au coût au lecteur qui détient inventory.valuation.read', () => {
    const rendered = renderAlertMessage('HIGH_LOSS', payload, { showProtected: true });
    expect(rendered.title).toBe('Pertes anormales');
    expect(rendered.message).toBe(
      'Emplacement : PDV Bonabéri ; Jour : 2026-10-14 ; Quantité perdue : 12,5 ; Valeur perdue : 1 250 000 XAF',
    );
  });

  it('rend un message neutre, sans la valeur, au lecteur sans ce droit', () => {
    const rendered = renderAlertMessage('HIGH_LOSS', payload, { showProtected: false });
    expect(rendered.message).toBe(
      'Emplacement : PDV Bonabéri ; Jour : 2026-10-14 ; Quantité perdue : 12,5',
    );
    expect(rendered.message).not.toContain('XAF');
    expect(rendered.message).not.toContain('1 250 000');
  });

  it('omet les champs absents ou vides et formate chaque nature', () => {
    const rendered = renderAlertMessage(
      'OVERDUE_RECEIVABLE',
      { doc_number: 'VTE-1', days_overdue: 13.9, balance_due_xaf: 45_000.4, extra: 'x' },
      { showProtected: false },
    );
    expect(rendered.message).toBe('Vente : VTE-1 ; Jours de retard : 13 ; Solde dû : 45 000 XAF');

    const empty = renderAlertMessage(
      'OVERDUE_RECEIVABLE',
      { doc_number: '   ' },
      { showProtected: false },
    );
    expect(empty.message).toBe('');
    expect(empty.title).toBe('Créance échue');
  });

  it('dates : jour métier, ou instant converti en jour de Douala', () => {
    const rendered = renderAlertMessage(
      'CASH_SESSION_OPEN_LONG',
      { opened_at: '2026-10-13T23:30:00.000Z', hours_open: 30 },
      { showProtected: false },
    );
    // 23:30 UTC = 00:30 le lendemain à Douala (UTC+1).
    expect(rendered.message).toBe('Ouverte le : 2026-10-14 ; Heures ouverte : 30 h');
    const plain = renderAlertMessage(
      'LOT_EXPIRING',
      { product_label: 'Aliment', expiry_date: '2026-11-02', quantity: 40 },
      { showProtected: false },
    );
    expect(plain.message).toBe('Produit : Aliment ; Péremption : 2026-11-02 ; Quantité : 40');
    const invalid = renderAlertMessage(
      'LOT_EXPIRING',
      { expiry_date: 'pas une date' },
      { showProtected: false },
    );
    expect(invalid.message).toBe('');
  });

  it('valeurs numériques non finies ou de mauvais type : champ omis, jamais « NaN »', () => {
    const rendered = renderAlertMessage(
      'CASH_VARIANCE',
      { variance_xaf: 'abc', phase: 'CLOSING', expected_xaf: Number.NaN, counted_xaf: '15000' },
      { showProtected: false },
    );
    expect(rendered.message).toBe('Phase : CLOSING ; Compté : 15 000 XAF');
  });

  it('un écart négatif garde son signe', () => {
    const rendered = renderAlertMessage(
      'CASH_VARIANCE',
      { variance_xaf: -2500 },
      { showProtected: false },
    );
    expect(rendered.message).toBe('Écart : -2 500 XAF');
  });

  it('les types sans champ protégé se rendent identiquement avec ou sans droit', () => {
    for (const type of ALERT_TYPES) {
      const definition = alertDefinitionOf(type);
      if (definition.messageFields.some((f) => f.protected === true)) continue;
      const sample = Object.fromEntries(definition.messageFields.map((f) => [f.key, 'x']));
      expect(renderAlertMessage(type, sample, { showProtected: true })).toEqual(
        renderAlertMessage(type, sample, { showProtected: false }),
      );
    }
  });

  it('P9-09 : mortalité (taux à la française, champ omis sans effectif de référence) et quarantaine (motif)', () => {
    const mortality = renderAlertMessage(
      'HIGH_MORTALITY',
      { lot_label: 'LOT-7', business_day: '2026-10-26', heads: 25, rate_pct: 2.5 },
      { showProtected: false },
    );
    expect(mortality.title).toBe('Mortalité élevée');
    expect(mortality.message).toBe(
      'Lot : LOT-7 ; Jour : 2026-10-26 ; Têtes mortes : 25 ; Taux du jour (%) : 2,5',
    );
    const withoutRate = renderAlertMessage(
      'HIGH_MORTALITY',
      { lot_label: 'LOT-7', business_day: '2026-10-26', heads: 25, rate_pct: null },
      { showProtected: false },
    );
    expect(withoutRate.message).toBe('Lot : LOT-7 ; Jour : 2026-10-26 ; Têtes mortes : 25');
    const quarantine = renderAlertMessage(
      'DUPLICATE_SUSPECTED',
      { kind: 'Réception', reference: 'REC-1', reason_label: 'Bon de livraison déjà reçu' },
      { showProtected: false },
    );
    expect(quarantine.message).toBe(
      'Objet : Réception ; Référence : REC-1 ; Motif : Bon de livraison déjà reçu',
    );
    // Les autres producteurs n'ont pas de motif : le champ est omis.
    expect(
      renderAlertMessage(
        'DUPLICATE_SUSPECTED',
        { kind: 'Encaissement', reference: 'ENC-1' },
        { showProtected: false },
      ).message,
    ).toBe('Objet : Encaissement ; Référence : ENC-1');
  });

  it('alertCarriesProtectedValue : vrai seulement si la charge utile porte une valeur protégée', () => {
    expect(alertCarriesProtectedValue('HIGH_LOSS', payload)).toBe(true);
    expect(alertCarriesProtectedValue('HIGH_LOSS', { location_label: 'x' })).toBe(false);
    expect(alertCarriesProtectedValue('OVERDUE_RECEIVABLE', payload)).toBe(false);
  });
});
