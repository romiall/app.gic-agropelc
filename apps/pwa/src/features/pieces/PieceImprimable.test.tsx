/**
 * Impression d'une pièce : l'en-tête, les coordonnées de règlement, le régime de TVA et la mention d'exonération de la
 * facture suivent les paramètres `company.*` reçus par l'appareil, en direct (AV-324, AV-451) — une synchronisation qui
 * arrive pendant que la pièce est ouverte la met à jour d'un seul tenant, sans laisser un en-tête neuf au-dessus
 * d'anciennes coordonnées de règlement.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { getDb, type Projection } from '../../storage/db.js';
import type { DemandePiece } from './demande.js';
import { EXEMPLE_BV, EXEMPLE_FA } from './exemples.js';
import { PieceImprimable } from './PieceImprimable.js';

const setting = (
  key: string,
  value: unknown,
  validFrom = '2026-01-01T00:00:00.000Z',
): Projection => ({
  key: `me:SETTING:${key}`,
  dataset: 'me',
  entity_type: 'SETTING',
  entity_id: key,
  scope_type: 'GLOBAL',
  scope_id: null,
  data: {
    id: key,
    key,
    value,
    scope_type: 'GLOBAL',
    scope_id: null,
    valid_from: validFrom,
  },
  seq: 1,
  row_version: 1,
});

/** Facture sans coordonnées de règlement ni régime : ce que prépare l'écran de la vente avant les paramètres. */
const FACTURE: DemandePiece = {
  code: 'FA',
  donnees: {
    ...EXEMPLE_FA,
    regimeTva: null,
    mentionExoneration: null,
    banque: null,
    compte: null,
    mobileMoney: null,
  },
};

const html = () => screen.getByTitle(/FA/).getAttribute('srcdoc') ?? '';

describe('Impression : paramètres de la société relus en direct', () => {
  beforeEach(async () => {
    await getDb().projections.clear();
  });
  afterEach(async () => {
    cleanup();
    await getDb().projections.clear();
  });

  it('sans paramètre reçu : l’en-tête d’origine, rien de coché ni de renseigné sur la facture', async () => {
    render(<PieceImprimable demande={FACTURE} cle="FA:1" />);
    await waitFor(() => expect(html()).toContain('GIC AGROPELC'));
    expect(html()).not.toContain('class="o coche"');
    expect(html()).not.toContain('Afriland First Bank');
  });

  it('un paramètre reçu pendant que la pièce est ouverte met à jour l’en-tête ET les coordonnées de la facture', async () => {
    render(<PieceImprimable demande={FACTURE} cle="FA:2" />);
    await waitFor(() => expect(html()).toContain('GIC AGROPELC'));

    await act(async () => {
      await getDb().projections.bulkPut([
        setting('company.legal_name', 'GIC AGROPELC SARL'),
        setting('company.bank', 'Afriland First Bank'),
        setting('company.vat_regime', 'VAT_EXEMPT'),
        setting('company.vat_exemption_mention', 'Vente exonérée'),
      ]);
    });
    await waitFor(() => expect(html()).toContain('GIC AGROPELC SARL'));
    expect(html()).toContain('Afriland First Bank');
    expect(html()).toContain('<span class="o coche">opération exonérée de TVA</span>');
    expect(html()).toContain('Vente exonérée');

    // Puis une nouvelle valeur : tout bouge ensemble.
    await act(async () => {
      await getDb().projections.put(setting('company.bank', 'BICEC', '2026-02-01T00:00:00.000Z'));
    });
    await waitFor(() => expect(html()).toContain('BICEC'));
    expect(html()).not.toContain('Afriland First Bank');
  });

  it('les pièces autres que la facture ne portent que l’en-tête', async () => {
    await getDb().projections.put(setting('company.bank', 'Afriland First Bank'));
    render(<PieceImprimable demande={{ code: 'BV', donnees: EXEMPLE_BV }} cle="BV:1" />);
    await waitFor(() =>
      expect(screen.getByTitle(/BV/).getAttribute('srcdoc')).toContain('GIC AGROPELC'),
    );
    expect(screen.getByTitle(/BV/).getAttribute('srcdoc')).not.toContain('Afriland First Bank');
  });
});
