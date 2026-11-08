/**
 * Chargement de catégories, de produits et de fournisseurs par fichier (RP-2 ; AV-072, AV-508) : le contrôle avant
 * chargement reprend celui des écrans de saisie, les commandes sont celles que ces écrans envoient, les identifiants
 * sont stables.
 */
import { isUuidv7 } from '@gic/domain';
import { describe, expect, it } from 'vitest';
import { ROLE_SETS } from '../../app/screens.js';
import { parseCsv } from './csv.js';
import {
  CATEGORIES_ENTITY,
  CUSTOMERS_ENTITY,
  IMPORT_ENTITIES,
  PRODUCTS_ENTITY,
  SUPPLIERS_ENTITY,
} from './entities.js';
import { authorImportId } from './ids.js';
import { exampleRow, planImport, templateRows, type ImportEntity } from './model.js';
import { EMPTY_IMPORT_REFS, type ImportRefs } from './refs.js';
import { toCsv } from './csv.js';

/** Utilisateur qui charge : les identifiants dérivés d'un chargement lui sont propres (`authorImportId`). */
const AUTHOR = '01900000-0000-7000-8000-0000000000aa';

const refs = (overrides: Partial<ImportRefs> = {}): ImportRefs => ({
  ...EMPTY_IMPORT_REFS,
  authorUserId: AUTHOR,
  unitCodes: new Set(['KG', 'PIECE']),
  categories: [{ id: '01900000-0000-7000-8000-0000000000c1', code: 'VOLAILLE', name: 'Volaille' }],
  ...overrides,
});

const plan = (entity: ImportEntity, text: string, context: ImportRefs = refs()) =>
  planImport(entity, parseCsv(text), context);

describe('catégories de produit', () => {
  it('une ligne valide devient la commande de l’écran, sous un identifiant stable', async () => {
    const result = await plan(CATEGORIES_ENTITY, 'Code;Nom\nOEUFS;Œufs\n');
    expect(result.counts).toEqual({ READY: 1, EXISTS: 0, ERROR: 0, DUPLICATE_IN_FILE: 0 });
    const [command] = result.rows[0]!.commands;
    expect(command).toMatchObject({
      commandType: 'catalog.product_category.create',
      aggregateType: 'PRODUCT_CATEGORY',
      payload: { code: 'OEUFS', name: 'Œufs' },
    });
    expect(command!.aggregateId).toBe(await authorImportId(AUTHOR, 'category', 'OEUFS'));
    expect(isUuidv7(command!.aggregateId)).toBe(true);
    // Le code est normalisé en majuscules, comme à l'écran.
    const lower = await plan(CATEGORIES_ENTITY, 'code;nom\noeufs;Œufs');
    expect(lower.rows[0]!.commands[0]!.payload).toMatchObject({ code: 'OEUFS' });
  });

  it('deux auteurs qui chargent le même fichier n’écrivent jamais le même agrégat', async () => {
    const mine = await plan(CATEGORIES_ENTITY, 'code;nom\nOEUFS;Œufs');
    const theirs = await plan(
      CATEGORIES_ENTITY,
      'code;nom\nOEUFS;Œufs',
      refs({ authorUserId: '01900000-0000-7000-8000-0000000000ab' }),
    );
    expect(theirs.rows[0]!.commands[0]!.aggregateId).not.toBe(
      mine.rows[0]!.commands[0]!.aggregateId,
    );
  });

  it('une catégorie déjà présente n’est pas rechargée ; une en attente non plus', async () => {
    const result = await plan(
      CATEGORIES_ENTITY,
      'code;nom\nVOLAILLE;Volaille\nPORCS;Porcs\nOEUFS;Œufs',
      refs({ pendingCategoryIds: new Map([['PORCS', '01900000-0000-7000-8000-0000000000c2']]) }),
    );
    expect(result.rows.map((row) => row.status)).toEqual(['EXISTS', 'EXISTS', 'READY']);
    expect(result.rows[0]!.commands).toEqual([]);
  });

  it('code invalide ou nom manquant : une erreur en français par ligne', async () => {
    const result = await plan(CATEGORIES_ENTITY, 'code;nom\nmauvais code!;Volaille\nOEUFS;');
    expect(result.rows.map((row) => row.status)).toEqual(['ERROR', 'ERROR']);
    expect(result.rows[0]!.issues[0]).toMatch(/Code invalide/);
    expect(result.rows[1]!.issues).toEqual(['Nom obligatoire.']);
  });

  it('la catégorie parente existe, précède dans le fichier, ou manque', async () => {
    const result = await plan(
      CATEGORIES_ENTITY,
      'code;nom;parent\nPOULETS;Poulets;VOLAILLE\nPONDEUSES;Pondeuses;POULETS\nORPHELINE;Orpheline;INCONNUE\nAVANT;Avant;APRES\nAPRES;Après;',
    );
    expect(result.rows.map((row) => row.status)).toEqual([
      'READY',
      'READY',
      'ERROR',
      'ERROR',
      'READY',
    ]);
    expect(result.rows[0]!.commands[0]!.payload).toMatchObject({
      parentId: '01900000-0000-7000-8000-0000000000c1',
    });
    expect(result.rows[1]!.commands[0]!.payload).toMatchObject({
      parentId: await authorImportId(AUTHOR, 'category', 'POULETS'),
    });
    expect(result.rows[2]!.issues[0]).toMatch(/INCONNUE.*inconnue/);
    // Un parent placé plus bas dans le fichier n'est pas encore connu de la ligne qui le cite.
    expect(result.rows[3]!.issues[0]).toMatch(/APRES/);
  });

  it('deux lignes du même code : la seconde est signalée, une seule commande', async () => {
    const result = await plan(CATEGORIES_ENTITY, 'code;nom\nOEUFS;Œufs\nOEUFS;Œufs bis');
    expect(result.rows.map((row) => row.status)).toEqual(['READY', 'DUPLICATE_IN_FILE']);
    expect(result.rows[1]!.issues[0]).toMatch(/ligne 2/);
    expect(result.rows[1]!.commands).toEqual([]);
  });
});

describe('produits', () => {
  const HEADER = 'code;nom;categorie;unite_de_base';

  it('une ligne minimale prend les défauts de l’écran : marchandise, vendable, prix à l’unité', async () => {
    const result = await plan(PRODUCTS_ENTITY, `${HEADER}\nP1;Poulet de chair;VOLAILLE;KG`);
    expect(result.rows[0]!.status).toBe('READY');
    const [command] = result.rows[0]!.commands;
    expect(command).toMatchObject({
      commandType: 'catalog.product.create',
      aggregateType: 'PRODUCT',
      payload: {
        code: 'P1',
        name: 'Poulet de chair',
        categoryId: '01900000-0000-7000-8000-0000000000c1',
        stockFamily: 'MARCHANDISE',
        baseUnitCode: 'KG',
        lotTracking: 'NONE',
        expiryTracking: false,
        isSellable: true,
        isPurchasable: false,
        isProducible: false,
        isConsumable: false,
        pricingMode: 'PER_UNIT',
      },
    });
    expect(command!.payload).not.toHaveProperty('species');
    expect(command!.aggregateId).toBe(await authorImportId(AUTHOR, 'product', 'P1'));
  });

  it('reconnaît les en-têtes d’Excel (accents, majuscules, alias) et les valeurs en français', async () => {
    const result = await plan(
      PRODUCTS_ENTITY,
      'Code;Nom;Catégorie;Unité de base;Famille de stock;Suivi de lot;Vendable;Achetable;Mode de prix;Espèce\n' +
        'POULET-VIF;Poulet vif;volaille;kg;biologique;obligatoire;Oui;non;au poids;Poulet de chair',
    );
    expect(result.rows[0]!.issues).toEqual([]);
    expect(result.rows[0]!.commands[0]!.payload).toMatchObject({
      code: 'POULET-VIF',
      stockFamily: 'BIOLOGIQUE',
      lotTracking: 'REQUIRED',
      isSellable: true,
      isPurchasable: false,
      pricingMode: 'PER_WEIGHT',
      species: 'POULET_CHAIR',
    });
  });

  it('catégorie ou unité inconnue, espèce manquante, service suivi par lot : une erreur claire par défaut', async () => {
    const result = await plan(
      PRODUCTS_ENTITY,
      `${HEADER};famille_de_stock;suivi_de_lot;espece\n` +
        'A;A;INCONNUE;KG;;;\n' +
        'B;B;VOLAILLE;LITRE;;;\n' +
        'C;C;VOLAILLE;KG;BIOLOGIQUE;OPTIONAL;\n' +
        'D;D;VOLAILLE;KG;SERVICE;REQUIRED;\n' +
        'E;E;VOLAILLE;KG;BIOLOGIQUE;NONE;PORC',
    );
    expect(result.rows.map((row) => row.status)).toEqual([
      'ERROR',
      'ERROR',
      'ERROR',
      'ERROR',
      'ERROR',
    ]);
    expect(result.rows[0]!.issues[0]).toMatch(/Catégorie « INCONNUE » inconnue/);
    expect(result.rows[1]!.issues[0]).toMatch(/Unité « LITRE » inconnue/);
    expect(result.rows[2]!.issues).toContain('Espèce obligatoire pour un produit biologique.');
    expect(result.rows[3]!.issues).toContain('Un service ne se suit pas par lot.');
    expect(result.rows[4]!.issues).toContain(
      'Un produit biologique se suit par lot (facultatif ou obligatoire).',
    );
  });

  it('valeurs hors liste : oui/non, famille, suivi, mode de prix, espèce', async () => {
    const result = await plan(
      PRODUCTS_ENTITY,
      `${HEADER};vendable;famille_de_stock;suivi_de_lot;mode_de_prix;espece\n` +
        'A;A;VOLAILLE;KG;peut-etre;truc;machin;bidule;chose',
    );
    const issues = result.rows[0]!.issues.join(' | ');
    expect(issues).toMatch(/Vendable : répondre par oui ou non/);
    expect(issues).toMatch(/Famille de stock invalide/);
    expect(issues).toMatch(/Suivi de lot invalide/);
    expect(issues).toMatch(/Mode de prix invalide/);
    expect(issues).toMatch(/Espèce invalide/);
  });

  it('un produit déjà présent (ou en attente) n’est pas rechargé', async () => {
    const result = await plan(
      PRODUCTS_ENTITY,
      `${HEADER}\nP1;Poulet;VOLAILLE;KG\nP2;Œufs;VOLAILLE;PIECE`,
      refs({ productCodes: new Set(['P1']) }),
    );
    expect(result.rows.map((row) => row.status)).toEqual(['EXISTS', 'READY']);
  });

  it('une catégorie dont la création attend est citée par l’identifiant de CETTE création, jamais un identifiant recalculé', async () => {
    // Créée par l'écran du catalogue (identifiant tiré au hasard) : le produit doit viser cet identifiant-là.
    const fromCatalogScreen = '01900000-0000-7000-8000-0000000000c9';
    const result = await plan(
      PRODUCTS_ENTITY,
      `${HEADER}\nP1;Œufs;OEUFS;PIECE`,
      refs({ pendingCategoryIds: new Map([['OEUFS', fromCatalogScreen]]) }),
    );
    expect(result.rows[0]!.commands[0]!.payload).toMatchObject({ categoryId: fromCatalogScreen });
    expect(fromCatalogScreen).not.toBe(await authorImportId(AUTHOR, 'category', 'OEUFS'));
  });

  it('une catégorie ni connue ni en attente : la ligne est refusée, les catégories se chargent avant les produits', async () => {
    const result = await plan(PRODUCTS_ENTITY, `${HEADER}\nP1;Œufs;OEUFS;PIECE`, refs());
    expect(result.rows[0]!.status).toBe('ERROR');
    expect(result.rows[0]!.issues[0]).toMatch(/à charger avant les produits/);
  });
});

describe('fournisseurs', () => {
  it('une ligne complète devient la commande de l’écran', async () => {
    const result = await plan(
      SUPPLIERS_ENTITY,
      'Code;Nom;Contact;Téléphone;E-mail;Adresse;Numéro fiscal;Délai de paiement (jours);Notes\n' +
        'F-PROV;Provenderie du Littoral;M. Nkoulou;+237 677 12 34 56;contact@prov.cm;Bonabéri;M0123;30;Livre le mardi',
    );
    expect(result.rows[0]!.issues).toEqual([]);
    const [command] = result.rows[0]!.commands;
    expect(command).toMatchObject({
      commandType: 'procurement.supplier.create',
      aggregateType: 'SUPPLIER',
      payload: {
        code: 'F-PROV',
        name: 'Provenderie du Littoral',
        contactName: 'M. Nkoulou',
        phone: '+237 677 12 34 56',
        email: 'contact@prov.cm',
        address: 'Bonabéri',
        taxId: 'M0123',
        paymentTermsDays: 30,
        notes: 'Livre le mardi',
      },
    });
    expect(command!.aggregateId).toBe(await authorImportId(AUTHOR, 'supplier', 'F-PROV'));
  });

  it('e-mail ou délai invalides : erreurs ; code déjà pris : déjà présent', async () => {
    const result = await plan(
      SUPPLIERS_ENTITY,
      'code;nom;email;delai_de_paiement\nA;A;pas-un-courriel;\nB;B;;4000\nC;C;;\nD;D;;',
      refs({ supplierCodes: new Set(['C']) }),
    );
    expect(result.rows.map((row) => row.status)).toEqual(['ERROR', 'ERROR', 'EXISTS', 'READY']);
    expect(result.rows[0]!.issues).toEqual(['Adresse e-mail invalide.']);
    expect(result.rows[1]!.issues[0]).toMatch(/Délai de paiement invalide/);
  });
});

describe('clients', () => {
  const ZONE_BONABERI = '01900000-0000-7000-8000-0000000000a1';
  const ZONE_AKWA = '01900000-0000-7000-8000-0000000000a2';
  const zoned = (overrides: Partial<ImportRefs> = {}) =>
    refs({
      zones: [
        { id: ZONE_BONABERI, label: 'Douala › Bonabéri' },
        { id: ZONE_AKWA, label: 'Douala › Akwa' },
        { id: '01900000-0000-7000-8000-0000000000a3', label: 'Yaoundé › Akwa' },
      ],
      customerCategories: [
        { id: '01900000-0000-7000-8000-0000000000b1', code: 'RESTAURATION', name: 'Restauration' },
      ],
      ...overrides,
    });
  const existing = (phone: string) => ({
    id: '01900000-0000-7000-8000-0000000000e1',
    stage: 'CLIENT',
    display_name: 'Déjà là',
    contact_name: null,
    category_id: null,
    phone_primary: phone,
    address_text: null,
    zone_id: ZONE_BONABERI,
    owner_user_id: null,
    home_site_id: null,
    merged_into_id: null,
    credit_allowed: false,
    credit_limit_xaf: null,
    payment_terms_days: null,
    outstanding_xaf: 0,
    version: 1,
  });

  it('une ligne complète devient la commande de l’écran, téléphone normalisé, identifiant stable', async () => {
    const result = await plan(
      CUSTOMERS_ENTITY,
      'Nom;Téléphone;Zone;Source;Type de client;Contact;Activité;Adresse;Catégorie;Latitude;Longitude\n' +
        'Restaurant du marché;677 12 34 56;Douala › Bonabéri;recommandation;entreprise;Mme Abena;Restauration;Marché Bonabéri;restauration;4,0511;9,7679',
      zoned(),
    );
    expect(result.rows[0]!.issues).toEqual([]);
    const [command] = result.rows[0]!.commands;
    expect(command).toMatchObject({
      commandType: 'crm.customer.create',
      aggregateType: 'CUSTOMER',
      payload: {
        displayName: 'Restaurant du marché',
        customerType: 'ENTREPRISE',
        zoneId: ZONE_BONABERI,
        sourceCode: 'RECOMMANDATION',
        phonePrimary: '+237677123456',
        position: { lat: 4.0511, lng: 9.7679, accuracyM: null },
        contactName: 'Mme Abena',
        businessActivity: 'Restauration',
        addressText: 'Marché Bonabéri',
        categoryId: '01900000-0000-7000-8000-0000000000b1',
      },
    });
    expect(command!.aggregateId).toBe(await authorImportId(AUTHOR, 'customer', '+237677123456'));
  });

  it('la source, le type et la position ont des défauts ; le même numéro écrit autrement est le même client', async () => {
    const result = await plan(
      CUSTOMERS_ENTITY,
      'nom;telephone;zone\nA;677123456;Bonabéri\nB;+237 677 123 456;Bonabéri',
      zoned(),
    );
    expect(result.rows[0]!.commands[0]!.payload).toMatchObject({
      sourceCode: 'AUTRE',
      customerType: 'ENTREPRISE',
    });
    expect(result.rows.map((row) => row.status)).toEqual(['READY', 'DUPLICATE_IN_FILE']);
  });

  it('un client déjà connu de l’appareil, ou dont la création attend, n’est pas rechargé', async () => {
    const result = await plan(
      CUSTOMERS_ENTITY,
      'nom;telephone;zone\nA;677123456;Bonabéri\nB;699000111;Bonabéri\nC;655000222;Bonabéri',
      zoned({
        customers: [existing('+237677123456')],
        pendingCustomerPhones: new Set(['+237699000111']),
      }),
    );
    expect(result.rows.map((row) => row.status)).toEqual(['EXISTS', 'EXISTS', 'READY']);
  });

  it('la zone : chemin complet, nom unique, nom ambigu, inconnue ou absente', async () => {
    const result = await plan(
      CUSTOMERS_ENTITY,
      'nom;telephone;zone\nA;677000001;Douala › Akwa\nB;677000002;Bonabéri\nC;677000003;Akwa\nD;677000004;Mars\nE;677000005;',
      zoned(),
    );
    expect(result.rows.map((row) => row.status)).toEqual([
      'READY',
      'READY',
      'ERROR',
      'ERROR',
      'ERROR',
    ]);
    expect(result.rows[0]!.commands[0]!.payload).toMatchObject({ zoneId: ZONE_AKWA });
    expect(result.rows[1]!.commands[0]!.payload).toMatchObject({ zoneId: ZONE_BONABERI });
    expect(result.rows[2]!.issues[0]).toMatch(/ambiguë/);
    expect(result.rows[3]!.issues[0]).toMatch(/inconnue/);
    expect(result.rows[4]!.issues).toEqual(['Zone obligatoire.']);
  });

  it('téléphone invalide, ni téléphone ni position, source, type, catégorie et position invalides', async () => {
    const result = await plan(
      CUSTOMERS_ENTITY,
      'nom;telephone;zone;source;type;categorie;latitude;longitude\n' +
        'A;12;Bonabéri;;;;;\n' +
        'B;;Bonabéri;;;;;\n' +
        'C;677000003;Bonabéri;mystere;;;;\n' +
        'D;677000004;Bonabéri;;robot;;;\n' +
        'E;677000005;Bonabéri;;;inconnue;;\n' +
        'F;677000006;Bonabéri;;;;95;9\n' +
        'G;677000007;Bonabéri;;;;4;\n' +
        ';677000008;Bonabéri;;;;;',
      zoned(),
    );
    expect(result.rows.map((row) => row.status)).toEqual(Array(8).fill('ERROR'));
    expect(result.rows[0]!.issues).toEqual(['Téléphone invalide.']);
    expect(result.rows[1]!.issues[0]).toMatch(/Téléphone ou position/);
    expect(result.rows[2]!.issues[0]).toMatch(/Source invalide/);
    expect(result.rows[3]!.issues[0]).toMatch(/Type de client invalide/);
    expect(result.rows[4]!.issues[0]).toMatch(/Catégorie de client « inconnue » inconnue/);
    expect(result.rows[5]!.issues[0]).toMatch(/Position invalide/);
    expect(result.rows[6]!.issues[0]).toMatch(/Position invalide/);
    expect(result.rows[7]!.issues).toEqual(['Nom obligatoire.']);
  });

  it('sans téléphone mais avec une position : accepté, clé tirée du nom et de la zone', async () => {
    const result = await plan(
      CUSTOMERS_ENTITY,
      'nom;zone;latitude;longitude\nBoutique sans numéro;Bonabéri;4.05;9.76',
      zoned(),
    );
    expect(result.rows[0]!.status).toBe('READY');
    expect(result.rows[0]!.commands[0]!.payload).toMatchObject({
      phonePrimary: null,
      position: { lat: 4.05, lng: 9.76, accuracyM: null },
    });
    expect(result.rows[0]!.key).toBe(`boutique_sans_numero|${ZONE_BONABERI}`);
  });

  describe('site de rattachement (BR-CRM-003)', () => {
    const SITE_BONABERI = '01900000-0000-7000-8000-0000000000d1';
    const SITE_AKWA = '01900000-0000-7000-8000-0000000000d2';
    const sited = (overrides: Partial<ImportRefs> = {}) =>
      zoned({
        sites: [
          { id: SITE_BONABERI, code: 'DLA-BON', name: 'Magasin Bonabéri' },
          { id: SITE_AKWA, code: 'DLA-AKW', name: 'Magasin Akwa' },
          { id: '01900000-0000-7000-8000-0000000000d3', code: 'YDE-AKW', name: 'Magasin Akwa' },
        ],
        ...overrides,
      });
    const file = 'nom;telephone;zone;site\n';

    it('le site nommé par son code ou son nom part dans la commande', async () => {
      const result = await plan(
        CUSTOMERS_ENTITY,
        `${file}A;677000001;Bonabéri;dla-bon\nB;677000002;Bonabéri;Magasin Bonabéri`,
        sited({ homeSiteRequired: true }),
      );
      expect(result.rows.map((row) => row.status)).toEqual(['READY', 'READY']);
      for (const row of result.rows) {
        expect(row.commands[0]!.payload).toMatchObject({ homeSiteId: SITE_BONABERI });
      }
    });

    it('un site inconnu ou dont le nom est porté par deux sites est signalé', async () => {
      const result = await plan(
        CUSTOMERS_ENTITY,
        `${file}A;677000001;Bonabéri;Mars\nB;677000002;Bonabéri;Magasin Akwa`,
        sited({ homeSiteRequired: true }),
      );
      expect(result.rows[0]!.issues).toEqual(['Site « Mars » inconnu.']);
      expect(result.rows[1]!.issues[0]).toMatch(/ambigu/);
    });

    it('sans colonne : le site du point de vente de l’utilisateur, ou une erreur s’il en faut un', async () => {
      const csv = 'nom;telephone;zone\nA;677000001;Bonabéri';
      const withDefault = await plan(
        CUSTOMERS_ENTITY,
        csv,
        sited({ homeSiteRequired: true, defaultHomeSiteId: SITE_AKWA }),
      );
      expect(withDefault.rows[0]!.commands[0]!.payload).toMatchObject({ homeSiteId: SITE_AKWA });

      const without = await plan(CUSTOMERS_ENTITY, csv, sited({ homeSiteRequired: true }));
      expect(without.rows[0]!.status).toBe('ERROR');
      expect(without.rows[0]!.issues[0]).toMatch(/Site de rattachement obligatoire/);
    });

    it('un commercial n’a pas besoin de site : le compte lui est rattaché', async () => {
      const result = await plan(
        CUSTOMERS_ENTITY,
        'nom;telephone;zone\nA;677000001;Bonabéri',
        sited({ homeSiteRequired: false }),
      );
      expect(result.rows[0]!.status).toBe('READY');
      expect(result.rows[0]!.commands[0]!.payload).not.toHaveProperty('homeSiteId');
    });
  });
});

describe('contrôle d’un fichier', () => {
  it('colonne obligatoire absente : rien n’est chargeable, la colonne est nommée', async () => {
    const result = await plan(PRODUCTS_ENTITY, 'code;nom\nP1;Poulet');
    expect(result.missingColumns).toEqual(['Catégorie', 'Unité de base']);
    expect(result.rows).toEqual([]);
  });

  it('colonnes inconnues ou répétées : ignorées et listées au rapport', async () => {
    const result = await plan(CATEGORIES_ENTITY, 'code;nom;couleur;Code\nOEUFS;Œufs;jaune;AUTRE');
    expect(result.unknownColumns).toEqual(['couleur', 'Code']);
    expect(result.rows[0]!.commands[0]!.payload).toMatchObject({ code: 'OEUFS' });
  });

  it('un fichier vide n’a ni ligne ni colonne manquante à signaler hors obligatoires', async () => {
    const result = await plan(CATEGORIES_ENTITY, '');
    expect(result.rows).toEqual([]);
    expect(result.missingColumns).toEqual(['Code', 'Nom']);
  });

  it('le fichier modèle ne contient que l’en-tête : rien de chargeable si on l’oublie dans le fichier rempli', () => {
    for (const entity of IMPORT_ENTITIES) {
      const rows = templateRows(entity);
      expect(rows, entity.id).toHaveLength(1);
      expect(rows[0], entity.id).toEqual(entity.columns.map((column) => column.label));
    }
  });

  it('chaque exemple de l’aide des colonnes est une ligne que le contrôle accepte (garde contre un exemple refusé)', async () => {
    for (const entity of IMPORT_ENTITIES) {
      // Les pièces papier se contrôlent avec les référentiels d'un appareil (emplacements, produits, comptes) :
      // leur fichier modèle est gardé dans `slips.test.ts`, colonne par colonne.
      if (entity.id === 'slips') continue;
      // Stock d'ouverture, comptes de trésorerie et règles de prix se contrôlent contre les référentiels d'un
      // appareil : leur exemple est gardé dans `rp2-entities.test.ts` ; celui des lots repris, dans
      // `lot-opening-entity.test.ts`.
      if (['opening_stock', 'cash_accounts', 'price_rules', 'lot_opening'].includes(entity.id))
        continue;
      // L'exemple de produit cite la catégorie VOLAILLE (qui doit exister) ; celui des catégories la crée.
      // Celui de la présence nomme un site de l'application (« Ferme de Bonabéri »).
      const context =
        entity.id === 'categories'
          ? refs({ categories: [] })
          : entity.id === 'presence'
            ? refs({
                sites: [
                  {
                    id: '01900000-0000-7000-8000-0000000000b1',
                    code: 'BONABERI',
                    name: 'Ferme de Bonabéri',
                  },
                ],
              })
            : refs({
                zones: [{ id: '01900000-0000-7000-8000-0000000000a1', label: 'Douala › Bonabéri' }],
              });
      const rows = [templateRows(entity)[0]!, exampleRow(entity)];
      expect(rows[0]).toHaveLength(entity.columns.length);
      const result = await planImport(entity, parseCsv(toCsv(rows)), context);
      expect(result.missingColumns, entity.id).toEqual([]);
      expect(result.unknownColumns, entity.id).toEqual([]);
      expect(
        result.rows.map((row) => [row.status, row.issues]),
        entity.id,
      ).toEqual([['READY', []]]);
    }
  });

  it('les types sont proposés dans l’ordre de chargement : catégories, produits, règles de prix, stock d’ouverture, lots repris, fournisseurs, clients, comptes de trésorerie, pièces, présence', () => {
    expect(IMPORT_ENTITIES.map((entity) => entity.id)).toEqual([
      'categories',
      'products',
      'price_rules',
      'opening_stock',
      'lot_opening',
      'suppliers',
      'customers',
      'cash_accounts',
      'slips',
      'presence',
    ]);
  });

  it('le menu ne propose le chargement qu’à des rôles qui peuvent charger au moins un type (garde contre une dérive)', () => {
    const union = new Set(IMPORT_ENTITIES.flatMap((entity) => entity.roles));
    for (const role of ROLE_SETS.dataImport) {
      expect(union.has(role), role).toBe(true);
    }
  });
});

describe('défauts du fichier lui-même', () => {
  it('une valeur plus longue que le serveur ne l’accepte est refusée avant le chargement', async () => {
    const long = 'x'.repeat(201);
    const category = await plan(CATEGORIES_ENTITY, `code;nom\nOEUFS;${long}`);
    expect(category.rows[0]!.status).toBe('ERROR');
    expect(category.rows[0]!.issues.join(' ')).toMatch(
      /« Nom » : 200 caractères au plus \(201 saisis\)/,
    );

    const supplier = await plan(
      SUPPLIERS_ENTITY,
      `code;nom;telephone\n${'F'.repeat(41)};Provenderie;${'6'.repeat(21)}`,
    );
    const issues = supplier.rows[0]!.issues.join(' ');
    expect(supplier.rows[0]!.status).toBe('ERROR');
    expect(issues).toMatch(/« Code » : 40 caractères au plus \(41 saisis\)/);
    expect(issues).toMatch(/« Téléphone » : 20 caractères au plus \(21 saisis\)/);

    // À la limite : accepté.
    const edge = await plan(CATEGORIES_ENTITY, `code;nom\nOEUFS;${'x'.repeat(200)}`);
    expect(edge.rows[0]!.status).toBe('READY');
  });

  it('une ligne en erreur ne réserve pas son code et ne fournit pas sa catégorie aux lignes suivantes', async () => {
    const result = await plan(
      CATEGORIES_ENTITY,
      `code;nom;parent\nPARENT;${'x'.repeat(201)};\nENFANT;Enfant;PARENT\nPARENT;Parent corrigé;`,
    );
    // La première ligne est refusée (nom trop long) : elle ne fournit pas PARENT, et la 4e n'est pas un doublon.
    expect(result.rows.map((row) => row.status)).toEqual(['ERROR', 'ERROR', 'READY']);
    expect(result.rows[1]!.issues[0]).toMatch(/Catégorie parente « PARENT » inconnue/);
  });

  it('une cellule au-delà de l’en-tête (séparateur dans une valeur) est signalée, la ligne n’est pas chargée', async () => {
    // « Œufs; frais; gros » : un point-virgule dans la valeur, non entre guillemets, ajoute deux cellules.
    const result = await plan(
      CATEGORIES_ENTITY,
      'code;nom\nOEUFS;Œufs; frais; gros\nPORCS;Porcs\n',
    );
    expect(result.rows.map((row) => row.status)).toEqual(['ERROR', 'READY']);
    expect(result.rows[0]!.issues.join(' ')).toMatch(
      /Ligne 2 : 2 cellule\(s\) au-delà des colonnes de l’en-tête/,
    );
  });

  it('un guillemet jamais refermé rend le fichier entier non chargeable, avec la ligne où il s’ouvre', async () => {
    const result = await plan(CATEGORIES_ENTITY, 'code;nom\nOEUFS;"Œufs\nVOLAILLE;Volaille\n');
    expect(result.rows).toEqual([]);
    expect(result.fileIssues).toHaveLength(1);
    expect(result.fileIssues[0]).toMatch(/guillemet s’ouvre à la ligne 2/);
    // Un fichier sain n’a aucun défaut de fichier.
    expect((await plan(CATEGORIES_ENTITY, 'code;nom\nOEUFS;Œufs\n')).fileIssues).toEqual([]);
  });

  it('des séparateurs en fin de ligne (colonnes vides d’un tableur) ne sont pas des colonnes à signaler', async () => {
    const result = await plan(CATEGORIES_ENTITY, 'code;nom;;;\nOEUFS;Œufs;;;\n');
    expect(result.unknownColumns).toEqual([]);
    expect(result.rows.map((row) => row.status)).toEqual(['READY']);
    // Une vraie colonne inconnue reste signalée.
    expect(
      (await plan(CATEGORIES_ENTITY, 'code;nom;;couleur\nOEUFS;Œufs;;rouge\n')).unknownColumns,
    ).toEqual(['couleur']);
  });

  it('une colonne « Prix » ou « Lot » n’est plus prise pour le mode de prix ou le suivi de lot', async () => {
    const result = await plan(
      PRODUCTS_ENTITY,
      'code;nom;categorie;unite_de_base;prix;lot\nP1;Poulet;VOLAILLE;KG;3500;L-42\n',
    );
    expect(result.unknownColumns).toEqual(['prix', 'lot']);
    expect(result.rows[0]!.status).toBe('READY');
    expect(result.rows[0]!.commands[0]!.payload).toMatchObject({
      pricingMode: 'PER_UNIT',
      lotTracking: 'NONE',
    });
  });
});
