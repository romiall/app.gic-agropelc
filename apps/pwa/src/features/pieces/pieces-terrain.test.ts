/**
 * Pièces de terrain PT, BH et VC (PP-E ; REQ-306, REQ-307, REQ-308) : fidélité aux gabarits du porteur, rendu des valeurs
 * et adaptateurs des données de l'application.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatWorkedMinutes } from '@gic/domain';
import { describe, expect, it } from 'vitest';
import { documentPiece } from './document.js';
import type { SalesReferences } from '../sales/references.js';
import type { CustomerData, VisitData } from '../sales/types.js';
import { demandeBilan, demandePresence, demandeVisite } from './adaptateurs-terrain.js';
import * as X from './exemples.js';
import { rendrePiece } from './registre.js';
import type { DemandePiece } from './demande.js';
import type { DonneesBH, DonneesPT, DonneesVC } from './pieces-terrain.js';

const CTX = { logo: 'data:image/png;base64,' };
// Les essais se lancent depuis apps/pwa (vitest) : la racine du dépôt est deux niveaux plus haut.
const gabarit = (code: string) =>
  readFileSync(resolve(process.cwd(), '../..', `pieces-papier/gabarits/${code}.html`), 'utf8');

/**
 * Étiquettes d'un gabarit ou d'une pièce rendue, dans l'ordre du document : rubriques, titres de colonnes, titres de
 * section et cases à cocher (cochées ou non).
 */
function etiquettes(html: string): string[] {
  return [
    ...html.matchAll(
      /class="lib">([^<]+)<|<th>([^<]+)<|titre-section">([^<]+)<|<span class="o(?: coche)?">([^<]+)</g,
    ),
  ].map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4])!.trim());
}

describe('fidélité aux gabarits du porteur : PT, BH, VC', () => {
  it.each([
    ['PT', { code: 'PT', donnees: X.EXEMPLE_PT }],
    ['BH', { code: 'BH', donnees: X.EXEMPLE_BH }],
    ['VC', { code: 'VC', donnees: X.EXEMPLE_VC }],
  ] as const)(
    '%s : chaque rubrique du gabarit figure sur la pièce rendue, dans l’ordre du gabarit',
    (code, demande) => {
      const rendu = etiquettes(rendrePiece(demande as DemandePiece, CTX).pages.join(''));
      const attendues = etiquettes(gabarit(code));
      expect(attendues.length).toBeGreaterThan(8);
      let curseur = 0;
      for (const etiquette of attendues) {
        // « commence par » : la pièce peut compléter un titre de section (« Veille marché (1 relevé sur 2) »).
        const position = rendu.findIndex(
          (rendue, index) => index >= curseur && rendue.startsWith(etiquette),
        );
        expect(position, `${code} : « ${etiquette} » à sa place`).toBeGreaterThanOrEqual(0);
        curseur = position + 1;
      }
    },
  );

  it('PT : A4 paysage, quatorze lignes par feuille, une feuille suivante au-delà', () => {
    const ligne = X.EXEMPLE_PT.lignes[0]!;
    const quinze = Array.from({ length: 15 }, () => ligne);
    const piece = rendrePiece({ code: 'PT', donnees: { ...X.EXEMPLE_PT, lignes: quinze } }, CTX);
    expect(piece.fmt).toBe('a4l');
    expect(piece.pages).toHaveLength(2);
    expect(piece.pages[0]).toContain('page 1/2');
    const numeros = [...piece.pages[1]!.matchAll(/<td class="n">(\d+)<\/td>/g)].map((m) => m[1]);
    expect(numeros[0]).toBe('15');
  });

  it('BH et VC : A5 portrait, une seule feuille', () => {
    expect(rendrePiece({ code: 'BH', donnees: X.EXEMPLE_BH }, CTX)).toMatchObject({ fmt: 'a5p' });
    expect(rendrePiece({ code: 'VC', donnees: X.EXEMPLE_VC }, CTX)).toMatchObject({ fmt: 'a5p' });
    expect(rendrePiece({ code: 'VC', donnees: X.EXEMPLE_VC }, CTX).pages).toHaveLength(1);
  });

  it('les totaux de l’exemple PT sont ceux que calcule l’application (l’aperçu ne diffère pas de la sortie réelle)', () => {
    const minutes = (heure: string): number => {
      const [, heures, reste] = /^(\d+) h(?: (\d+))?$/.exec(heure)!;
      return Number(heures) * 60 + Number(reste ?? 0);
    };
    for (const ligne of X.EXEMPLE_PT.lignes) {
      const somme = ligne.jours.reduce(
        (total, jour) =>
          jour.arrivee && jour.depart && /\d/.test(jour.arrivee)
            ? total + minutes(jour.depart) - minutes(jour.arrivee)
            : total,
        0,
      );
      expect(ligne.total, ligne.nom).toBe(formatWorkedMinutes(somme));
    }
  });

  it('un texte plus long que sa zone le dit au pied de la fiche : rien n’est coupé sans prévenir', () => {
    const mention = 'voir le texte complet dans l’application';
    const page = (demande: DemandePiece) => rendrePiece(demande, CTX).pages[0]!;
    expect(page({ code: 'BH', donnees: X.EXEMPLE_BH })).not.toContain(mention);
    const long = 'Retards de livraison chez le fournisseur. '.repeat(12);
    expect(page({ code: 'BH', donnees: { ...X.EXEMPLE_BH, difficultes: long } })).toContain(
      mention,
    );
    // Quatre lignes courtes dépassent aussi les trois lignes de la zone.
    expect(page({ code: 'BH', donnees: { ...X.EXEMPLE_BH, besoins: 'a\nb\nc\nd' } })).toContain(
      mention,
    );
    expect(
      page({ code: 'BH', donnees: { ...X.EXEMPLE_BH, commentaire: 'Très bien. '.repeat(20) } }),
    ).toContain(mention);
    expect(page({ code: 'VC', donnees: X.EXEMPLE_VC })).not.toContain(mention);
    expect(
      page({ code: 'VC', donnees: { ...X.EXEMPLE_VC, commentaire: 'Visite longue. '.repeat(20) } }),
    ).toContain(mention);
  });

  it('BH : « Vu par le responsable » coché seulement quand le bilan est vu, textes échappés', () => {
    const vu = rendrePiece({ code: 'BH', donnees: X.EXEMPLE_BH }, CTX).pages[0]!;
    expect(vu).toContain('class="o coche">oui');
    const nonVu = rendrePiece(
      { code: 'BH', donnees: { ...X.EXEMPLE_BH, vu: false, reussites: '<b>x</b>' } },
      CTX,
    ).pages[0]!;
    expect(nonVu).not.toContain('class="o coche">oui');
    expect(nonVu).not.toContain('<b>x</b>');
    expect(nonVu).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('VC : un seul relevé s’écrit sur la fiche ; le nombre de relevés figure au titre de la section', () => {
    const deux = rendrePiece({ code: 'VC', donnees: X.EXEMPLE_VC }, CTX).pages[0]!;
    expect(deux).toContain('Veille marché (1 relevé sur 2)');
    expect(deux).toContain('Concurrent de Mboppi');
    expect(deux).not.toContain('Grossiste Deido');
    const un = rendrePiece(
      { code: 'VC', donnees: { ...X.EXEMPLE_VC, veille: X.EXEMPLE_VC.veille.slice(0, 1) } },
      CTX,
    ).pages[0]!;
    expect(un).toContain('>Veille marché<');
  });

  it('les trois pièces s’impriment en document complet', () => {
    for (const demande of [
      { code: 'PT', donnees: X.EXEMPLE_PT },
      { code: 'BH', donnees: X.EXEMPLE_BH },
      { code: 'VC', donnees: X.EXEMPLE_VC },
    ] as const) {
      const html = documentPiece(rendrePiece(demande as DemandePiece, CTX));
      expect(html).toContain('@page');
      expect(html).not.toContain('undefined');
    }
  });
});

describe('adaptateur PT : feuille de présence reportée', () => {
  const feuille = {
    weekStart: '2026-11-02',
    paperRef: '000042',
    responsibleName: 'Joseph Ngo Bayiha',
    lines: [
      {
        personName: 'Paul Essomba',
        personRole: 'Ouvrier',
        missionLabel: 'Poulailler B2',
        days: [
          { date: '2026-11-02', arrival: '07:00', departure: '16:00', absenceCode: null },
          { date: '2026-11-03', arrival: null, departure: null, absenceCode: 'M' },
          { date: '2026-11-04', arrival: '07:15', departure: '15:30', absenceCode: null },
          { date: '2026-11-08', arrival: '07:00', departure: '12:00', absenceCode: null },
        ],
      },
    ],
  };

  it('heures écrites « 07 h 00 », code d’absence dans la case arrivée, semaine du lundi au samedi', () => {
    const demande = demandePresence(feuille, 'Ferme de Bonabéri');
    expect(demande.code).toBe('PT');
    const d = demande.donnees as DonneesPT;
    expect(d).toMatchObject({
      numero: '000042',
      site: 'Ferme de Bonabéri',
      semaineDu: '02/11/2026',
      semaineAu: '07/11/2026',
      responsable: 'Joseph Ngo Bayiha',
    });
    expect(d.lignes[0]!.jours[0]).toEqual({ arrivee: '07 h 00', depart: '16 h 00' });
    expect(d.lignes[0]!.jours[1]).toEqual({ arrivee: 'M', depart: null });
    expect(d.lignes[0]!.jours[3]).toEqual({ arrivee: null, depart: null });
  });

  it('le total d’heures recoupe les cases imprimées : le dimanche relevé n’y entre pas', () => {
    const d = demandePresence(feuille, null).donnees as DonneesPT;
    // 9 h + 8 h 15 = 17 h 15 (la maladie ne compte pas, le dimanche 08/11 n'est pas sur la fiche).
    expect(d.lignes[0]!.total).toBe('17 h 15');
  });

  it('une personne sans heure complète n’a pas de total', () => {
    const sans = {
      ...feuille,
      lines: [
        {
          ...feuille.lines[0]!,
          days: [{ date: '2026-11-02', arrival: '07:00', departure: null, absenceCode: null }],
        },
      ],
    };
    const d = demandePresence(sans, null).donnees as DonneesPT;
    expect(d.lignes[0]!.total).toBeNull();
  });
});

describe('adaptateur BH : bilan hebdomadaire', () => {
  const bilan = {
    weekStart: '2026-10-26',
    successes: 'Deux commandes',
    difficulties: null,
    needs: null,
    priorities: 'Relancer Mboppi',
    marketInfo: null,
    status: 'REVIEWED',
    managerComment: 'Bien',
  };
  const chiffres = {
    visits: 14,
    newProspects: 5,
    newCustomers: 2,
    salesXaf: 1_250_000,
    collectedXaf: 980_000,
    lossDeclarations: 1,
    lossValueXaf: 12_500,
  };

  it('chiffres calculés écrits en francs entiers, semaine du lundi au dimanche, vu et commentaire', () => {
    const d = demandeBilan(bilan, { commercial: 'Aïcha Mbarga', chiffres }).donnees as DonneesBH;
    expect(d).toMatchObject({
      commercial: 'Aïcha Mbarga',
      semaineDu: '26/10/2026',
      semaineAu: '01/11/2026',
      visites: '14',
      prospects: '5',
      clients: '2',
      ca: '1 250 000',
      encaisse: '980 000',
      pertes: '12 500',
      reussites: 'Deux commandes',
      difficultes: null,
      priorites: 'Relancer Mboppi',
      vu: true,
      commentaire: 'Bien',
    });
  });

  it('sans chiffres (hors ligne) ou sans droit de valorisation : cases vierges, jamais un zéro inventé', () => {
    const hors = demandeBilan(bilan, { commercial: null, chiffres: null }).donnees as DonneesBH;
    expect([hors.visites, hors.ca, hors.encaisse, hors.pertes]).toEqual([null, null, null, null]);
    const sansCout = demandeBilan(bilan, {
      commercial: null,
      chiffres: { ...chiffres, lossValueXaf: null },
    }).donnees as DonneesBH;
    expect(sansCout.pertes).toBeNull();
    expect(sansCout.ca).toBe('1 250 000');
  });

  it('un bilan non vu n’est pas coché', () => {
    const d = demandeBilan(
      { ...bilan, status: 'SUBMITTED', managerComment: null },
      { commercial: null, chiffres: null },
    ).donnees as DonneesBH;
    expect(d.vu).toBe(false);
  });
});

describe('adaptateur VC : fiche de visite', () => {
  const refs = {
    reasonCodes: [
      {
        id: 'r1',
        category: 'VISIT_OUTCOME',
        code: 'COMMANDE_PRISE',
        label: 'Commande prise',
        loss_category: null,
        requires_comment: false,
        is_active: true,
      },
      {
        id: 'r2',
        category: 'VISIT_OUTCOME',
        code: 'SPECIAL',
        label: 'Spécial',
        loss_category: null,
        requires_comment: false,
        is_active: true,
      },
    ],
    products: [{ id: 'p1', name: 'Œufs de table' }],
    units: new Map([
      ['PLATEAU', { id: 'u1', code: 'PLATEAU', name: 'plateau', is_count: true, is_active: true }],
    ]),
    zones: new Map([['z1', { id: 'z1', parent_id: null, name: 'Akwa', depth: 1 }]]),
    users: [{ id: 'u-1', full_name: 'Aïcha Mbarga', status: 'ACTIVE' }],
  } as unknown as Pick<SalesReferences, 'reasonCodes' | 'products' | 'units' | 'zones' | 'users'>;
  const visite = {
    id: 'v1',
    customer_id: 'c1',
    user_id: 'u-1',
    outcome_reason_code_id: 'r1',
    notes: 'Première livraison vendredi',
    next_action_at: '2026-11-06',
    next_action_note: 'Appeler',
    market_watch: [
      {
        watch_type: 'COMPETITOR',
        source_name: 'Mboppi',
        product_id: 'p1',
        unit_code: 'PLATEAU',
        observed_price_xaf: 2500,
      },
    ],
    flags: [],
    status: 'RECORDED',
    occurred_at: '2026-11-04T08:15:00.000Z',
  } as VisitData;
  const client = {
    id: 'c1',
    stage: 'PROSPECT',
    display_name: 'Restaurant Le Palmier',
    contact_name: 'M. Tchoua',
    phone_primary: '+237677123456',
    address_text: 'Rue Joss',
    zone_id: 'z1',
    interest_product_id: 'p1',
    potential_qty_per_day: 40,
    potential_unit_code: 'PLATEAU',
    usual_payment_method_code: 'MOBILE_MONEY_MTN',
    credit_requested: false,
  } as unknown as CustomerData;

  it('rubriques de la visite, profil commercial et veille repris du compte et de la visite', () => {
    const d = demandeVisite(visite, client, { refs }).donnees as DonneesVC;
    expect(d).toMatchObject({
      commercial: 'Aïcha Mbarga',
      zone: 'Akwa',
      date: '04/11/2026',
      arrivee: '09 h 15',
      compte: 'nouveau prospect',
      client: 'Restaurant Le Palmier',
      personne: 'M. Tchoua',
      produitInteret: 'Œufs de table',
      potentiel: '40 plateau',
      paiement: 'mobile money',
      differe: 'non',
      resultat: 'commande prise',
      commentaire: 'Première livraison vendredi',
      prochaineAction: 'Appeler',
      prochaineActionLe: '06/11/2026',
    });
    expect(d.veille).toEqual([
      { source: 'Mboppi', produit: 'Œufs de table', prix: '2 500', unite: 'plateau' },
    ]);
  });

  it('un résultat inconnu de la fiche est coché « autre » ; un compte déjà client est « client existant »', () => {
    const autre = demandeVisite(
      { ...visite, outcome_reason_code_id: 'r2' },
      { ...client, stage: 'CUSTOMER' },
      { refs },
    ).donnees as DonneesVC;
    expect(autre.resultat).toBe('autre');
    expect(autre.compte).toBe('client existant');
  });

  it('le stade du jour de la visite prime sur le stade actuel du compte ; un compte perdu ne coche aucune case', () => {
    // Prospect converti depuis la visite : la fiche de sa visite reste « nouveau prospect ».
    const converti = demandeVisite(
      { ...visite, customer_stage_at_visit: 'PROSPECT' },
      { ...client, stage: 'CUSTOMER' },
      { refs },
    ).donnees as DonneesVC;
    expect(converti.compte).toBe('nouveau prospect');
    // Visite d'un client devenu perdu : « client existant » au jour de la visite.
    const perdu = demandeVisite(
      { ...visite, customer_stage_at_visit: 'CUSTOMER' },
      { ...client, stage: 'LOST' },
      { refs },
    ).donnees as DonneesVC;
    expect(perdu.compte).toBe('client existant');
    // Visite saisie sur l'appareil (pas encore de stade figé) d'un compte perdu : ni l'un ni l'autre.
    const sansStade = demandeVisite(visite, { ...client, stage: 'LOST' }, { refs })
      .donnees as DonneesVC;
    expect(sansStade.compte).toBeNull();
  });

  it('« Différé demandé : non » n’est une réponse que si le profil dit autre chose', () => {
    const vide = {
      ...client,
      interest_product_id: null,
      potential_qty_per_day: null,
      potential_unit_code: null,
      usual_payment_method_code: null,
      credit_requested: false,
    } as unknown as CustomerData;
    const differe = (compte: CustomerData) =>
      (demandeVisite(visite, compte, { refs }).donnees as DonneesVC).differe;
    expect(differe(vide)).toBeNull();
    expect(differe({ ...vide, credit_requested: true })).toBe('oui');
    expect(differe({ ...vide, interest_product_id: 'p1' })).toBe('non');
  });

  it('chaque résultat de visite semé coche sa case ; seul « autre » tombe dans « autre »', () => {
    const seed = readFileSync(
      resolve(process.cwd(), '../..', 'db/seeds/crm-references.ts'),
      'utf8',
    );
    const codes = [...seed.matchAll(/category: 'VISIT_OUTCOME', code: '([A-Z_]+)'/g)].map(
      (match) => match[1]!,
    );
    expect(codes).toHaveLength(6);
    for (const code of codes) {
      const semee = { ...refs, reasonCodes: [{ ...refs.reasonCodes[0]!, code }] } as typeof refs;
      const resultat = (demandeVisite(visite, client, { refs: semee }).donnees as DonneesVC)
        .resultat;
      expect(resultat, code).not.toBeNull();
      if (code !== 'AUTRE') expect(resultat, code).not.toBe('autre');
    }
  });

  it('profil non renseigné : cases vierges (ni crédit demandé ni moyen de paiement inventés)', () => {
    const nu = {
      ...client,
      interest_product_id: null,
      potential_qty_per_day: null,
      potential_unit_code: null,
      usual_payment_method_code: null,
      credit_requested: undefined,
    } as unknown as CustomerData;
    const d = demandeVisite({ ...visite, market_watch: [] }, nu, { refs }).donnees as DonneesVC;
    expect([d.produitInteret, d.potentiel, d.paiement, d.differe]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(d.veille).toEqual([]);
  });
});
