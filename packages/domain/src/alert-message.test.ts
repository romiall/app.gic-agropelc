import { describe, expect, it } from 'vitest';
import { ALERT_TYPES, alertDefinitionOf } from './alerts.js';
import { alertCarriesProtectedValue, renderAlertMessage } from './alert-message.js';

describe('renderAlertMessage (ADR-071 §11, AV-440)', () => {
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

  it('alertCarriesProtectedValue : vrai seulement si la charge utile porte une valeur protégée', () => {
    expect(alertCarriesProtectedValue('HIGH_LOSS', payload)).toBe(true);
    expect(alertCarriesProtectedValue('HIGH_LOSS', { location_label: 'x' })).toBe(false);
    expect(alertCarriesProtectedValue('OVERDUE_RECEIVABLE', payload)).toBe(false);
  });
});
