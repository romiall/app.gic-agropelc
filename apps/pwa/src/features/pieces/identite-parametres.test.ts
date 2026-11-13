/**
 * Identité de la société et régime de TVA lus des paramètres de l'appareil (AV-324 (a), AV-451 (c)) : les valeurs
 * de départ sont celles du dossier du porteur, un paramètre présent les remplace (même vide : ligne pointillée),
 * et la facture coche la case du régime et écrit la mention d'exonération et les coordonnées de règlement.
 */
import { describe, expect, it } from 'vitest';
import {
  COMPANY_IDENTITY_SETTINGS,
  COMPANY_VAT_MENTION_SETTING,
  COMPANY_VAT_REGIME_SETTING,
} from '@gic/contracts';
import type { SaleView } from '../sales/recent-sales.js';
import type { SalesReferences } from '../sales/references.js';
import type { SettingData } from '../sales/types.js';
import { demandeFacture } from './adaptateurs-ventes.js';
import * as X from './exemples.js';
import { IDENTITE } from './identite.js';
import { identiteDepuisParametres, tvaDepuisParametres } from './identite-parametres.js';
import { rendrePiece } from './registre.js';

const NOW = new Date('2026-11-05T09:00:00.000Z');
const LOGO = { logo: 'data:image/png;base64,' };

const parametre = (
  key: string,
  value: unknown,
  validFrom = '2026-11-01T00:00:00.000Z',
): SettingData => ({
  id: `s-${key}-${validFrom}`,
  key,
  value,
  scope_type: 'GLOBAL',
  scope_id: null,
  valid_from: validFrom,
});

const VENTE = {
  id: 'v1',
  docNumber: 'VTE-1',
  status: 'CONFIRMED',
  paymentStatus: null,
  occurredAt: '2026-10-26T08:00:00Z',
  customerId: null,
  sellerUserId: 'u1',
  fromLocationId: 'l1',
  siteId: null,
  netTotalXaf: 10000,
  amountPaidXaf: 6000,
  balanceDueXaf: 4000,
  capturedOffline: false,
  flags: [],
  lines: [
    {
      productId: 'p1',
      productName: 'Plateau de 30 œufs',
      quantity: 4,
      unitCode: 'PLATEAU_30',
      unitPriceXaf: 2500,
      discountXaf: 0,
      lineTotalXaf: 10000,
      cancelledXaf: 0,
    },
  ],
  commandId: 'c1',
  rejection: null,
  cancellationPending: false,
} as unknown as SaleView;

const refs = (settings: readonly SettingData[]): SalesReferences =>
  ({
    users: [],
    customers: [],
    customerAlias: new Map(),
    locations: [],
    sites: new Map(),
    units: new Map(),
    sales: [],
    payments: [],
    outbox: [],
    zones: new Map(),
    products: [],
    settings,
  }) as unknown as SalesReferences;

describe('identité de la société lue des paramètres (AV-324 (a))', () => {
  it('chaque rubrique de l’identité a son paramètre', () => {
    expect(Object.keys(COMPANY_IDENTITY_SETTINGS).sort()).toEqual(Object.keys(IDENTITE).sort());
  });

  it('sans paramètre sur l’appareil, ce sont les valeurs du dossier du porteur', () => {
    expect(identiteDepuisParametres([], NOW)).toEqual(IDENTITE);
    expect(identiteDepuisParametres(undefined, NOW)).toEqual(IDENTITE);
  });

  it('un paramètre présent remplace la valeur, même vide (ligne pointillée) ; les autres rubriques restent', () => {
    const identite = identiteDepuisParametres(
      [
        parametre('company.legal_name', '  GIC AGROPELC SARL '),
        parametre('company.head_office', 'Douala, Akwa'),
        parametre('company.po_box', ''),
      ],
      NOW,
    );
    expect(identite.raison_sociale).toBe('GIC AGROPELC SARL');
    expect(identite.siege).toBe('Douala, Akwa');
    expect(identite.bp).toBe('');
    expect(identite.niu).toBe(IDENTITE.niu);
    expect(identite.telephones).toBe(IDENTITE.telephones);
  });

  it('une valeur qui n’est pas du texte est ignorée ; la version en vigueur passe avant une version à venir', () => {
    const identite = identiteDepuisParametres(
      [
        parametre('company.niu', 12345),
        parametre('company.phones', '+237 600 000 000', '2026-10-01T00:00:00.000Z'),
        parametre('company.phones', '+237 611 111 111', '2026-11-02T00:00:00.000Z'),
        parametre('company.phones', '+237 622 222 222', '2026-12-01T00:00:00.000Z'),
      ],
      NOW,
    );
    expect(identite.niu).toBe(IDENTITE.niu);
    expect(identite.telephones).toBe('+237 611 111 111');
  });

  it('sans version en vigueur (datée d’avance ou horloge en retard), la plus récente reçue vaut mieux que les valeurs d’origine', () => {
    // Le serveur retire de l'appareil la version remplacée dès que la nouvelle arrive : il ne reste que celle-là.
    const identite = identiteDepuisParametres(
      [parametre('company.city', 'Yaoundé', '2026-12-01T00:00:00.000Z')],
      NOW,
    );
    expect(identite.ville).toBe('Yaoundé');
    expect(identite.niu).toBe(IDENTITE.niu);
    // Plusieurs versions toutes à venir : la plus récente.
    expect(
      identiteDepuisParametres(
        [
          parametre('company.city', 'Bafoussam', '2026-12-05T00:00:00.000Z'),
          parametre('company.city', 'Yaoundé', '2026-12-01T00:00:00.000Z'),
        ],
        NOW,
      ).ville,
    ).toBe('Bafoussam');
  });

  it('l’en-tête de chaque pièce imprime l’identité des paramètres ; une rubrique vide reste la ligne pointillée', () => {
    const identite = identiteDepuisParametres(
      [
        parametre('company.legal_name', 'GIC AGROPELC SARL'),
        parametre('company.head_office', 'Douala, Akwa'),
        parametre('company.po_box', ''),
        parametre('company.tax_system', 'Régime du réel'),
      ],
      NOW,
    );
    const piece = rendrePiece({ code: 'BV', donnees: X.EXEMPLE_BV }, { ...LOGO, identite });
    const entete = piece.pages[0]!.slice(0, piece.pages[0]!.indexOf('</header>'));
    expect(entete).toContain('GIC AGROPELC SARL');
    expect(entete).toContain('<span class="val">Douala, Akwa</span>');
    expect(entete).toContain('Régime</b>Régime du réel');
    // La boîte postale vidée : plus de valeur imprimée, la ligne du papier reste à compléter à la main.
    expect(entete).not.toContain('7633 Douala');
    expect(entete).toContain('<b>BP</b><span class="blanc s"></span>');
    // Sans contexte d'identité : les valeurs de départ, comme avant.
    const defaut = rendrePiece({ code: 'BV', donnees: X.EXEMPLE_BV }, LOGO);
    expect(defaut.pages[0]).toContain('7633 Douala');
  });
});

describe('régime de TVA et coordonnées de règlement de la facture (AV-451 (c))', () => {
  it('par défaut, rien n’est coché et la mention reste en pointillés', () => {
    expect(tvaDepuisParametres([], NOW)).toEqual({ regime: null, mention: null });
    expect(tvaDepuisParametres(undefined, NOW)).toEqual({ regime: null, mention: null });
    expect(
      tvaDepuisParametres(
        [
          parametre(COMPANY_VAT_REGIME_SETTING, 'NOT_SET'),
          parametre(COMPANY_VAT_MENTION_SETTING, '  '),
        ],
        NOW,
      ),
    ).toEqual({ regime: null, mention: null });
  });

  it('le régime choisi et la mention sont lus des paramètres', () => {
    expect(
      tvaDepuisParametres(
        [
          parametre(COMPANY_VAT_REGIME_SETTING, 'VAT_EXEMPT'),
          parametre(COMPANY_VAT_MENTION_SETTING, ' Exonéré en vertu de l’article 128 du CGI '),
        ],
        NOW,
      ),
    ).toEqual({
      regime: 'opération exonérée de TVA',
      mention: 'Exonéré en vertu de l’article 128 du CGI',
    });
    expect(
      tvaDepuisParametres([parametre(COMPANY_VAT_REGIME_SETTING, 'VAT_APPLICABLE')], NOW).regime,
    ).toBe('TVA applicable');
    expect(
      tvaDepuisParametres([parametre(COMPANY_VAT_REGIME_SETTING, 'INCONNU')], NOW).regime,
    ).toBeNull();
  });

  it('la facture sans paramètre garde les cases à cocher à la main et les coordonnées de règlement vierges', () => {
    const d = demandeFacture(VENTE, refs([]), NOW);
    if (d.code !== 'FA') throw new Error('FA attendu');
    expect(d.donnees).toMatchObject({
      regimeTva: null,
      mentionExoneration: null,
      banque: null,
      compte: null,
      mobileMoney: null,
    });
    const page = rendrePiece(d, LOGO).pages[0]!;
    expect(page).not.toContain('class="o coche"');
  });

  it('la facture coche le régime et écrit la mention, la banque, le compte et le mobile money des paramètres', () => {
    const d = demandeFacture(
      VENTE,
      refs([
        parametre(COMPANY_VAT_REGIME_SETTING, 'VAT_EXEMPT'),
        parametre(COMPANY_VAT_MENTION_SETTING, 'Vente exonérée'),
        parametre('company.bank', 'Afriland First Bank'),
        parametre('company.bank_account', '10005 00001 12345678901 23'),
        parametre('company.mobile_money', '681 121 644'),
      ]),
      NOW,
    );
    if (d.code !== 'FA') throw new Error('FA attendu');
    expect(d.donnees).toMatchObject({
      regimeTva: 'opération exonérée de TVA',
      mentionExoneration: 'Vente exonérée',
      banque: 'Afriland First Bank',
      compte: '10005 00001 12345678901 23',
      mobileMoney: '681 121 644',
    });
    const page = rendrePiece(d, LOGO).pages[0]!;
    expect(page).toContain('<span class="o coche">opération exonérée de TVA</span>');
    expect(page).toContain('<span class="o">TVA applicable</span>');
    expect(page).toContain('Vente exonérée');
    expect(page).toContain('Afriland First Bank');
  });
});
