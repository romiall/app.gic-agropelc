/**
 * Pièces papier (lot PP, ADR-048) : fidélité aux fichiers du porteur, rendu de chaque pièce,
 * marques (duplicata, annulée), pagination, et adaptateurs des données des écrans.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SalesReferences } from '../sales/references.js';
import type { SaleView } from '../sales/recent-sales.js';
import type { OrderView } from '../sales/open-orders.js';
import type { CustomerPaymentData } from '../sales/types.js';
import charte from './charte.css?raw';
import { demandeBonDeVente, demandeBonLivraison, numeroImprime } from './adaptateurs-ventes.js';
import { demandeFeuilleCaisse, demandeJournalEncaissements } from './adaptateurs-finance.js';
import { lundiDe } from './adaptateurs-stock.js';
import type { DemandePiece } from './demande.js';
import { documentPiece } from './document.js';
import * as X from './exemples.js';
import { dateHeurePiece, lettreMoyen, moyenPiece, xafPiece } from './format.js';
import { esc } from './gabarit.js';
import { IDENTITE } from './identite.js';
import { rendrePiece } from './registre.js';

// Les tests se lancent depuis apps/pwa (vitest) : la racine du dépôt est deux niveaux plus haut.
const racine = (chemin: string) => resolve(process.cwd(), '../..', chemin);
const CTX = { logo: 'data:image/png;base64,' };

const DEMANDES: readonly DemandePiece[] = [
  { code: 'BV', donnees: X.EXEMPLE_BV },
  { code: 'RE', donnees: X.EXEMPLE_RE },
  { code: 'BD', donnees: X.EXEMPLE_BD },
  { code: 'RF', donnees: X.EXEMPLE_RF },
  { code: 'FJC', donnees: X.EXEMPLE_FJC },
  { code: 'JE', donnees: X.EXEMPLE_JE },
  { code: 'FA', donnees: X.EXEMPLE_FA },
  { code: 'CC', donnees: X.EXEMPLE_CC },
  { code: 'BL', donnees: X.EXEMPLE_BL },
  { code: 'DA', donnees: X.EXEMPLE_DA },
  { code: 'BC', donnees: X.EXEMPLE_BC },
  { code: 'BR', donnees: X.EXEMPLE_BR },
  { code: 'BT', donnees: X.EXEMPLE_BT },
  { code: 'FP', donnees: X.EXEMPLE_FP },
  { code: 'FI', donnees: X.EXEMPLE_FI },
  { code: 'FL', donnees: X.EXEMPLE_FL },
];

describe('fidélité aux fichiers du porteur (REQ-303)', () => {
  it('la charte est la copie exacte de pieces-papier/charte/pieces.css', () => {
    expect(charte).toBe(readFileSync(racine('pieces-papier/charte/pieces.css'), 'utf8'));
  });

  it("l'identité est celle de pieces-papier/charte/identite.json", () => {
    const json = JSON.parse(
      readFileSync(racine('pieces-papier/charte/identite.json'), 'utf8'),
    ) as Record<string, unknown>;
    for (const [cle, valeur] of Object.entries(IDENTITE)) expect(json[cle]).toBe(valeur);
    // `_aide` et `validation_comptable_facture` pilotent le générateur du porteur, pas l'en-tête.
    const pilotage = new Set(['_aide', 'validation_comptable_facture']);
    for (const cle of Object.keys(json).filter((k) => !pilotage.has(k))) {
      expect(IDENTITE).toHaveProperty(cle);
    }
  });
});

describe('rendu des pièces', () => {
  it.each(DEMANDES.map((d) => [d.code, d] as const))(
    '%s : une feuille au moins, numéro écrit',
    (_, d) => {
      const piece = rendrePiece(d, CTX);
      expect(piece.code).toBe(d.code);
      expect(piece.pages.length).toBeGreaterThan(0);
      const numero = (d.donnees as { numero?: string | null }).numero;
      if (numero) expect(piece.pages[0]).toContain(esc(numero));
      const html = documentPiece(piece);
      expect(html).toContain('@page');
      expect(html).not.toContain('undefined');
    },
  );

  it('marques : tampon « Annulée » et case cochée, « Duplicata » avec sa date', () => {
    const piece = rendrePiece(
      { code: 'BV', donnees: X.EXEMPLE_BV },
      { ...CTX, marques: { annulee: true, duplicata: '27/10/2026' } },
    );
    expect(piece.pages[0]).toContain('tampon annulee');
    expect(piece.pages[0]).toContain('annule coche');
    expect(piece.pages[0]).toContain('réimprimé le 27/10/2026');
    const simple = rendrePiece({ code: 'BV', donnees: X.EXEMPLE_BV }, CTX);
    expect(simple.pages[0]).not.toContain('tampon');
  });

  it('pagination : les lignes au-delà du gabarit passent sur une feuille suivante', () => {
    const ligne = X.EXEMPLE_BV.lignes[0]!;
    const lignes = Array.from({ length: 40 }, () => ligne);
    const piece = rendrePiece({ code: 'BV', donnees: { ...X.EXEMPLE_BV, lignes } }, CTX);
    expect(piece.pages.length).toBeGreaterThan(1);
    expect(piece.pages[0]).toContain(`page 1/${piece.pages.length}`);
  });

  it('les valeurs saisies sont échappées', () => {
    const piece = rendrePiece(
      { code: 'BV', donnees: { ...X.EXEMPLE_BV, client: '<script>x</script>' } },
      CTX,
    );
    expect(piece.pages[0]).not.toContain('<script>');
    expect(piece.pages[0]).toContain('&lt;script&gt;');
  });
});

describe('formats de la pièce', () => {
  it('date et heure à Douala, montants en XAF entiers, moyens de paiement', () => {
    expect(dateHeurePiece('2026-10-26T13:05:00Z')).toBe('26/10/2026 à 14 h 05');
    expect(xafPiece(1250000)).toMatch(/^1\s250\s000$/);
    expect(moyenPiece('MOBILE_MONEY_ORANGE')).toBe('Orange Money');
    expect(moyenPiece('chèque')).toBe('Chèque');
    expect(moyenPiece('INCONNU')).toBeNull();
    expect(lettreMoyen('ESPECES')).toBe('E');
  });
  it('numéro imprimé : officiel, sinon local, sinon « EN ATTENTE »', () => {
    expect(numeroImprime('VTE-1', 'L-1')).toBe('VTE-1');
    expect(numeroImprime(null, 'L-1')).toBe('L-1');
    expect(numeroImprime(null)).toBe('EN ATTENTE');
  });
  it('lundi de la semaine', () => {
    expect(lundiDe('2026-10-26')).toBe('2026-10-26');
    expect(lundiDe('2026-11-01')).toBe('2026-10-26');
    expect(lundiDe('2026-10-31')).toBe('2026-10-26');
  });
});

/** Référentiels vides : chaque test n'y pose que ce qu'il lit. */
function refs(partiel: Partial<SalesReferences> = {}): SalesReferences {
  return {
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
    cashAccounts: [],
    cashTransferTargets: [],
    expenseCategories: [],
    ...partiel,
  } as unknown as SalesReferences;
}

const VENTE: SaleView = {
  id: 'v1',
  docNumber: null,
  status: 'RECORDED',
  paymentStatus: null,
  occurredAt: '2026-10-26T08:00:00Z',
  customerId: null,
  sellerUserId: 'u1',
  fromLocationId: 'l1',
  siteId: null,
  netTotalXaf: 10000,
  amountPaidXaf: 6000,
  balanceDueXaf: 4000,
  capturedOffline: true,
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

describe('adaptateurs', () => {
  it('bon de vente saisi hors ligne : moyens et référence pris dans la commande en attente', () => {
    const d = demandeBonDeVente(
      VENTE,
      refs({
        users: [{ id: 'u1', full_name: 'Aïcha Mbarga' }],
        locations: [{ id: 'l1', name: 'PDV Bonabéri' }],
        outbox: [
          {
            command_id: 'c1',
            payload: {
              payments: [
                { methodCode: 'ESPECES', amountXaf: 1000 },
                { methodCode: 'MOBILE_MONEY_MTN', amountXaf: 5000, reference: 'MP123' },
              ],
            },
          },
        ],
      } as unknown as Partial<SalesReferences>),
    );
    expect(d.code).toBe('BV');
    if (d.code !== 'BV') return;
    expect(d.donnees.numero).toBe('EN ATTENTE');
    expect(d.donnees.anonyme).toBe(true);
    expect(d.donnees.vendeur).toBe('Aïcha Mbarga');
    expect(d.donnees.pointDeVente).toBe('PDV Bonabéri');
    expect(d.donnees.moyens).toEqual(['Espèces', 'MTN Mobile Money']);
    expect(d.donnees.reference).toBe('MP123');
    expect(d.donnees.resteDu).toBe(4000);
  });

  it('bon de livraison : reste à livrer après cette livraison, livraison complète', () => {
    const commande = {
      id: 'o1',
      docNumber: 'CMD-1',
      customerId: 'k1',
      deliveryAddress: null,
      lines: [
        {
          id: 'a',
          productName: 'Œufs',
          quantity: 10,
          unitCode: 'PLATEAU_30',
          orderedBase: 300,
          deliveredBase: 60,
          deliveringBase: 0,
        },
        {
          id: 'b',
          productName: 'Poulet',
          quantity: 5,
          unitCode: 'TETE',
          orderedBase: 5,
          deliveredBase: 0,
          deliveringBase: 0,
        },
      ],
    } as unknown as OrderView;
    const livraison = {
      numero: null,
      occurredAt: '2026-10-26T10:00:00Z',
      auteurId: null,
      recuPar: 'M. Ngo',
      observations: null,
      lignes: [{ orderLineId: 'a', quantityBase: 90 }],
    };
    const d = demandeBonLivraison(commande, livraison, refs());
    if (d.code !== 'BL') throw new Error('BL attendu');
    expect(d.donnees.lignes).toHaveLength(1);
    expect(d.donnees.lignes[0]).toMatchObject({ commandee: '10', livree: '3', reste: '5' });
    expect(d.donnees.complete).toBe(false);
    const tout = demandeBonLivraison(
      commande,
      {
        ...livraison,
        lignes: [
          { orderLineId: 'a', quantityBase: 240 },
          { orderLineId: 'b', quantityBase: 5 },
        ],
      },
      refs(),
    );
    if (tout.code !== 'BL') throw new Error('BL attendu');
    expect(tout.donnees.complete).toBe(true);
  });

  it('feuille de caisse : solde théorique et écart d’une caisse en espèces', () => {
    const d = demandeFeuilleCaisse({
      compteId: 'k',
      jour: '2026-10-26',
      mouvements: [
        {
          occurredAt: '2026-10-26T15:00:00Z',
          direction: 'OUT',
          montant: 2000,
          piece: 'DEP-1',
          libelle: 'Dépense',
          moyen: null,
        },
        {
          occurredAt: '2026-10-26T08:00:00Z',
          direction: 'IN',
          montant: 10000,
          piece: 'ENC-1',
          libelle: 'Encaissement',
          moyen: 'ESPECES',
        },
        {
          occurredAt: '2026-10-26T09:00:00Z',
          direction: 'IN',
          montant: 5000,
          piece: 'ENC-2',
          libelle: 'Encaissement',
          moyen: 'MOBILE_MONEY_ORANGE',
        },
      ],
      session: { numero: 'SES-1', fondsOuverture: 1000, especesComptees: 8500, caissierId: null },
      refs: refs({
        cashAccounts: [
          {
            id: 'k',
            name: 'Caisse PDV',
            account_type: 'CAISSE_PDV',
            site_id: null,
            holder_user_id: null,
          },
        ],
      } as unknown as Partial<SalesReferences>),
    });
    if (d.code !== 'FJC') throw new Error('FJC attendu');
    expect(d.donnees.lignes.map((l) => l.piece)).toEqual(['ENC-1', 'ENC-2', 'DEP-1']);
    expect(d.donnees.entreesEspeces).toBe(10000);
    expect(d.donnees.sortiesEspeces).toBe(2000);
    expect(d.donnees.soldeTheorique).toBe(9000);
    expect(d.donnees.ecart).toBe(-500);
    expect(d.donnees.entreesHorsEspeces).toBe(5000);
    expect(d.donnees.caisse).toBe('du PDV');
  });

  it('journal des encaissements : une colonne par mode, encaissements annulés exclus', () => {
    const paiement = (id: string, mode: string, montant: number, status = 'ACTIVE') =>
      ({
        id,
        doc_number: id,
        status,
        customer_id: null,
        site_id: 's',
        payment_method_code: mode,
        amount_xaf: montant,
        external_reference: null,
        received_by_user_id: 'u',
        unallocated_xaf: 0,
        occurred_at: `2026-10-2${id.length}T08:00:00Z`,
      }) as CustomerPaymentData;
    const d = demandeJournalEncaissements({
      paiements: [
        paiement('E1', 'CHEQUE', 300),
        paiement('E22', 'ESPECES', 100),
        paiement('X', 'ESPECES', 9, 'CANCELLED'),
      ],
      site: 'Douala',
      du: '2026-10-20',
      au: '2026-10-26',
      tenuPar: null,
      refs: refs(),
    });
    if (d.code !== 'JE') throw new Error('JE attendu');
    expect(d.donnees.lignes.map((l) => l.parMode)).toEqual([
      [null, null, null, null, 300],
      [100, null, null, null, null],
    ]);
  });
});
