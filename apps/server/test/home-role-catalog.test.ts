/** Catalogue des actions d'accueil par rôle (ADR-030) : action « + Dépense » (P8E-02, AV-298). */
import { describe, expect, it } from 'vitest';
import { ROLE_CATALOG } from '../src/home-api/role-catalog.js';

const codesOf = (role: string) => ROLE_CATALOG[role]!.actions.map((action) => action.code);

describe('Accueil : actions par rôle', () => {
  it('« + Dépense » pour les rôles de terrain qui dépensent ; la Finance garde « Dépenses et fournisseurs »', () => {
    for (const role of ['COMMERCIAL_TERRAIN', 'VENDEUR_PDV', 'RESP_FERME']) {
      expect(codesOf(role), role).toContain('NEW_EXPENSE');
    }
    expect(codesOf('FINANCE')).toContain('EXPENSES');
    // Les autres rôles autorisés passent par le menu (AV-298).
    for (const role of ['DIRECTION', 'RESP_PRODUCTION', 'MAGASINIER', 'RESP_ACHATS']) {
      expect(codesOf(role), role).not.toContain('NEW_EXPENSE');
    }
  });

  it('une action au plus une fois par rôle, une seule action principale', () => {
    for (const [role, definition] of Object.entries(ROLE_CATALOG)) {
      const codes = definition.actions.map((action) => action.code);
      expect(new Set(codes).size, role).toBe(codes.length);
      expect(
        definition.actions.filter((action) => action.primary).length,
        role,
      ).toBeLessThanOrEqual(1);
    }
  });
});
