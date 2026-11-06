/**
 * Chargement par fichier : stock d'ouverture, comptes de trésorerie et règles de prix (RP-2, AV-517), du CSV à la
 * commande, avec les vrais référentiels de l'appareil (projections posées dans la base locale, comme le serveur les
 * sert). Rien n'est mocké : une ligne du fichier donne la commande que l'écran de saisie aurait produite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isUuidv7 } from '@gic/domain';
import { getDb, type Projection } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from '../sales/fixtures.js';
import { loadSalesReferences } from '../sales/references.js';
import { buildImportRefs } from './context.js';
import { parseCsv, toCsv } from './csv.js';
import { planImport } from './model.js';
import type { ImportRefs } from './refs.js';
import { IMPORT_ENTITIES } from './entities.js';
import {
  CASH_ACCOUNTS_ENTITY,
  OPENING_STOCK_ENTITY,
  PRICE_RULES_ENTITY,
  RP2_ENTITIES,
} from './rp2-entities.js';

/** Instant du contrôle : le 5 novembre 2026 à 11 h, heure de Douala. */
const NOW = new Date('2026-11-05T10:00:00.000Z');
const AWA = '01900000-0000-7000-8000-0000000000e1';
const PAUL = '01900000-0000-7000-8000-0000000000e2';
const MARIE_1 = '01900000-0000-7000-8000-0000000000e3';
const MARIE_2 = '01900000-0000-7000-8000-0000000000e4';
const SITE_2 = '01900000-0000-7000-8000-000000000021';
const ZONE_2 = '01900000-0000-7000-8000-000000000011';
const CATEGORY = '01900000-0000-7000-8000-0000000000c1';
const ANIMAL = '01900000-0000-7000-8000-000000000042';
const LOTTED = '01900000-0000-7000-8000-000000000043';
const OFF = '01900000-0000-7000-8000-000000000044';

const projection = (
  dataset: string,
  entityType: string,
  id: string,
  data: Record<string, unknown>,
): Projection => ({
  key: `${dataset}:${entityType}:${id}`,
  dataset,
  entity_type: entityType,
  entity_id: id,
  scope_type: 'GLOBAL',
  scope_id: null,
  data: { id, ...data },
  seq: 1,
  row_version: 1,
});

const product = (id: string, code: string, extra: Record<string, unknown> = {}) =>
  projection('product', 'PRODUCT', id, {
    code,
    name: code,
    category_id: IDS.zone,
    base_unit_code: 'U',
    is_sellable: true,
    pricing_mode: 'PER_UNIT',
    status: 'ACTIVE',
    stock_family: 'MARCHANDISE',
    lot_tracking: 'NONE',
    ...extra,
  });

async function refsOf(): Promise<ImportRefs> {
  const references = await loadSalesReferences(getDb());
  return buildImportRefs({ references, userId: IDS.user, roles: ['ADMIN'], now: NOW });
}

const plan = async (
  entity: (typeof RP2_ENTITIES)[number],
  rows: readonly Record<string, string>[],
  overrides: Partial<ImportRefs> = {},
) => {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const text = toCsv([keys, ...rows.map((row) => keys.map((key) => row[key] ?? ''))]);
  return planImport(entity, parseCsv(text), { ...(await refsOf()), ...overrides });
};

beforeEach(async () => {
  const db = getDb();
  await db.projections.clear();
  await db.outbox.clear();
  await seedSalesFixtures(db);
  await db.projections.bulkPut([
    // Les produits du jeu d'essai n'ont ni famille ni suivi par lot : les produits de ces essais les portent.
    product(IDS.eggs, 'OEUF'),
    product(IDS.chicken, 'POULET'),
    product(ANIMAL, 'PORC-ENG', { stock_family: 'BIOLOGIQUE', lot_tracking: 'REQUIRED' }),
    product(LOTTED, 'LOT-OBLIG', { lot_tracking: 'REQUIRED' }),
    product(OFF, 'ANCIEN', { status: 'INACTIVE' }),
    projection('catalog', 'UNIT', 'u1', {
      code: 'U',
      name: 'Unité',
      is_count: true,
      is_active: true,
    }),
    projection('catalog', 'UNIT', 'u2', {
      code: 'KG',
      name: 'Kilogramme',
      is_count: false,
      is_active: true,
    }),
    projection('user', 'USER', AWA, { full_name: 'Awa Nde', status: 'ACTIVE' }),
    projection('user', 'USER', PAUL, { full_name: 'Paul Essomba', status: 'ACTIVE' }),
    projection('user', 'USER', MARIE_1, { full_name: 'Marie Dupont', status: 'ACTIVE' }),
    projection('user', 'USER', MARIE_2, { full_name: 'Marie Dupont', status: 'ACTIVE' }),
    projection('zone', 'ZONE', ZONE_2, { parent_id: null, name: 'Littoral', depth: 1 }),
    projection('site', 'SITE', SITE_2, {
      code: 'MAG-DLA',
      name: 'Magasin Douala',
      site_type: 'MAGASIN',
      zone_id: ZONE_2,
      status: 'ACTIVE',
    }),
    projection('customer_category', 'CUSTOMER_CATEGORY', CATEGORY, {
      code: 'GROSSISTE',
      name: 'Grossiste',
      is_active: true,
    }),
  ]);
});

afterEach(async () => {
  const db = getDb();
  await db.projections.clear();
  await db.outbox.clear();
});

describe('Stock d’ouverture (inventory.opening.post)', () => {
  const row = (extra: Record<string, string> = {}) => ({
    site: 'PDV-YDE',
    emplacement: 'PDV-YDE-POS',
    produit: 'OEUF',
    quantite: '1 200',
    cout_unitaire: '1 850',
    ...extra,
  });

  it('les lignes d’un emplacement forment un seul stock d’ouverture, aux identifiants stables', async () => {
    const rows = [row(), row({ produit: 'POULET', quantite: '50,5', cout_unitaire: '3000' })];
    const first = await plan(OPENING_STOCK_ENTITY, rows);
    expect(first.missingColumns).toEqual([]);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]!.status, JSON.stringify(first.rows[0])).toBe('READY');
    const [command] = first.rows[0]!.commands;
    expect(command).toMatchObject({
      commandType: 'inventory.opening.post',
      aggregateType: 'INVENTORY_COUNT',
      payload: {
        locationId: IDS.pos,
        lines: [
          { productId: IDS.eggs, quantityBase: 1200, unitCostXaf: 1850 },
          { productId: IDS.chicken, quantityBase: 50.5, unitCostXaf: 3000 },
        ],
      },
    });
    expect(isUuidv7(command!.aggregateId)).toBe(true);
    // Le même fichier rechargé donne le même identifiant ; un contenu différent, un autre.
    const again = await plan(OPENING_STOCK_ENTITY, rows);
    expect(again.rows[0]!.commands[0]!.aggregateId).toBe(command!.aggregateId);
    const changed = await plan(OPENING_STOCK_ENTITY, [row({ quantite: '1 201' })]);
    expect(changed.rows[0]!.commands[0]!.aggregateId).not.toBe(command!.aggregateId);
  });

  it('un emplacement déjà ouvert (validé, en attente ou dans l’outbox) n’est pas rechargé', async () => {
    const refs = await refsOf();
    const device = refs.slipContext!;
    const withCount = {
      ...refs,
      slipContext: {
        ...device,
        refs: {
          ...device.refs,
          counts: [
            {
              id: 'c1',
              doc_number: 'INV-1',
              location_id: IDS.pos,
              count_type: 'OPENING' as const,
              status: 'PENDING_APPROVAL',
              occurred_at: '2026-11-01T08:00:00.000Z',
              submitted_at: null,
              posted_at: null,
              version: 1,
              lines: [],
            },
          ],
        },
      },
    };
    const result = await planImport(
      OPENING_STOCK_ENTITY,
      parseCsv(toCsv([Object.keys(row()), Object.values(row())])),
      withCount,
    );
    expect(result.rows[0]!.status).toBe('EXISTS');
    // Un inventaire ordinaire du même emplacement n'est pas un stock d'ouverture.
    const ordinary = {
      ...withCount,
      slipContext: {
        ...device,
        refs: {
          ...device.refs,
          counts: [{ ...withCount.slipContext.refs.counts[0]!, count_type: 'FULL' as const }],
        },
      },
    };
    const free = await planImport(
      OPENING_STOCK_ENTITY,
      parseCsv(toCsv([Object.keys(row()), Object.values(row())])),
      ordinary,
    );
    expect(free.rows[0]!.status).toBe('READY');
  });

  describe('emplacement libéré par un stock d’ouverture refusé ou annulé (AV-517 (4))', () => {
    const countOf = (status: string) => ({
      id: 'c-refus',
      doc_number: 'INV-2',
      location_id: IDS.pos,
      count_type: 'OPENING' as const,
      status,
      occurred_at: '2026-11-01T08:00:00.000Z',
      submitted_at: null,
      posted_at: null,
      version: 1,
      lines: [],
    });
    /** Commande de stock d'ouverture restée dans la file de l'appareil (état « synchronisée »). */
    const sentOpening = (aggregateId: string, status = 'SYNCED') => ({
      command_id: `cmd-${aggregateId}`,
      command_type: 'inventory.opening.post',
      aggregate_id: aggregateId,
      status,
      payload: { locationId: IDS.pos, lines: [] },
    });
    const withDevice = async (counts: readonly unknown[], outbox: readonly unknown[]) => {
      const device = (await refsOf()).slipContext!;
      return {
        slipContext: {
          ...device,
          refs: {
            ...device.refs,
            counts: [...device.refs.counts, ...counts],
            outbox: [...device.refs.outbox, ...outbox],
          },
        },
      } as never;
    };

    it('un document refusé ou annulé, connu de l’appareil, libère l’emplacement même si sa commande est « synchronisée »', async () => {
      for (const status of ['REJECTED', 'CANCELLED']) {
        const result = await plan(
          OPENING_STOCK_ENTITY,
          [row()],
          await withDevice([countOf(status)], [sentOpening('c-refus')]),
        );
        expect(result.rows[0]!.status, `${status} : ${JSON.stringify(result.rows[0])}`).toBe(
          'READY',
        );
      }
      // Validé ou en attente : l'emplacement reste pris, la commande de l'outbox ne change rien.
      for (const status of ['POSTED', 'PENDING_APPROVAL']) {
        const result = await plan(
          OPENING_STOCK_ENTITY,
          [row()],
          await withDevice([countOf(status)], [sentOpening('c-refus')]),
        );
        expect(result.rows[0]!.status, status).toBe('EXISTS');
      }
    });

    it('une commande encore seule dans l’outbox (document inconnu) tient l’emplacement ; refusée, elle le rend', async () => {
      const waiting = await plan(
        OPENING_STOCK_ENTITY,
        [row()],
        await withDevice([], [sentOpening('inconnu', 'PENDING_SYNC')]),
      );
      expect(waiting.rows[0]!.status).toBe('EXISTS');
      const refused = await plan(
        OPENING_STOCK_ENTITY,
        [row()],
        await withDevice([], [sentOpening('inconnu', 'REJECTED')]),
      );
      expect(refused.rows[0]!.status).toBe('READY');
    });

    it('le même fichier rechargé après un refus est une nouvelle tentative : un autre identifiant', async () => {
      const first = await plan(OPENING_STOCK_ENTITY, [row()]);
      const retry = await plan(
        OPENING_STOCK_ENTITY,
        [row()],
        await withDevice([countOf('REJECTED')], []),
      );
      expect(retry.rows[0]!.status).toBe('READY');
      expect(retry.rows[0]!.commands[0]!.aggregateId).not.toBe(
        first.rows[0]!.commands[0]!.aggregateId,
      );
      // Deux tentatives refusées de plus : encore un autre identifiant (la liste des documents clos entre dans l'identifiant).
      const second = await plan(
        OPENING_STOCK_ENTITY,
        [row()],
        await withDevice([countOf('REJECTED'), { ...countOf('CANCELLED'), id: 'c-annule' }], []),
      );
      expect(second.rows[0]!.commands[0]!.aggregateId).not.toBe(
        retry.rows[0]!.commands[0]!.aggregateId,
      );
      // Rechargé avec les mêmes documents clos : le même identifiant (aucun doublon par rechargement).
      const again = await plan(
        OPENING_STOCK_ENTITY,
        [row()],
        await withDevice([countOf('REJECTED')], []),
      );
      expect(again.rows[0]!.commands[0]!.aggregateId).toBe(retry.rows[0]!.commands[0]!.aggregateId);
    });
  });

  it('défauts signalés avant le chargement : site, emplacement, produit, quantité, coût, doublon', async () => {
    const issuesOf = async (rows: readonly Record<string, string>[]) => {
      const result = await plan(OPENING_STOCK_ENTITY, rows);
      expect(result.rows[0]!.status).toBe('ERROR');
      return result.rows[0]!.issues.join(' | ');
    };
    expect(await issuesOf([row({ site: 'NULLE-PART' })])).toMatch(/Site inconnu ou inactif/);
    expect(await issuesOf([row({ emplacement: 'INCONNU' })])).toMatch(
      /Emplacement inconnu, virtuel ou inactif/,
    );
    expect(await issuesOf([row({ produit: 'FANTOME' })])).toMatch(/produit inconnu/);
    expect(await issuesOf([row({ produit: 'PORC-ENG' })])).toMatch(/ne se charge pas ici/);
    expect(await issuesOf([row({ produit: 'LOT-OBLIG' })])).toMatch(/ne se charge pas ici/);
    expect(await issuesOf([row({ produit: 'ANCIEN' })])).toMatch(/désactivé/);
    expect(await issuesOf([row({ quantite: '0' })])).toMatch(/quantité invalide/);
    expect(await issuesOf([row({ quantite: '1,2345' })])).toMatch(/quantité invalide/);
    expect(await issuesOf([row({ cout_unitaire: '18,5' })])).toMatch(/coût unitaire invalide/);
    expect(await issuesOf([row(), row({ quantite: '3' })])).toMatch(/figure déjà/);
  });

  it('sans référentiels d’appareil, rien n’est chargeable', async () => {
    const refs = { ...(await refsOf()) };
    const { slipContext: _unused, ...withoutDevice } = refs;
    void _unused;
    const result = await planImport(
      OPENING_STOCK_ENTITY,
      parseCsv(toCsv([Object.keys(row()), Object.values(row())])),
      withoutDevice,
    );
    expect(result.rows[0]!.status).toBe('ERROR');
    expect(result.rows[0]!.issues[0]).toMatch(/référentiels de l’appareil/);
  });
});

describe('Comptes de trésorerie (finance.cash_account.create)', () => {
  const pdv = (extra: Record<string, string> = {}) => ({
    code: 'caisse-akwa',
    nom: 'Caisse du point de vente Yaoundé',
    type: 'Caisse PDV',
    site: 'PDV-YDE',
    responsable: 'Awa Nde',
    ...extra,
  });

  it('une caisse de PDV, une caisse personnelle, un compte mobile : la charge de l’écran du serveur', async () => {
    const result = await plan(CASH_ACCOUNTS_ENTITY, [
      pdv(),
      {
        code: 'CAISSE-PAUL',
        nom: 'Caisse de Paul',
        type: 'Caisse personnelle',
        titulaire: 'Paul Essomba',
        responsable: 'awa nde',
      },
      {
        code: 'MOMO',
        nom: 'Compte marchand Mobile Money',
        type: 'mobile money',
        responsable: 'Awa Nde',
        reference_externe: '+237 677 00 00 00',
      },
    ]);
    expect(result.rows.map((entry) => [entry.key, entry.status])).toEqual([
      ['CAISSE-AKWA', 'READY'],
      ['CAISSE-PAUL', 'READY'],
      ['MOMO', 'READY'],
    ]);
    expect(result.rows[0]!.commands[0]).toMatchObject({
      commandType: 'finance.cash_account.create',
      aggregateType: 'CASH_ACCOUNT',
      payload: {
        code: 'CAISSE-AKWA',
        name: 'Caisse du point de vente Yaoundé',
        accountType: 'CAISSE_PDV',
        siteId: IDS.site,
        responsibleUserId: AWA,
      },
    });
    expect(result.rows[1]!.commands[0]!.payload).toMatchObject({
      accountType: 'CAISSE_UTILISATEUR',
      holderUserId: PAUL,
      responsibleUserId: AWA,
    });
    expect(result.rows[1]!.commands[0]!.payload).not.toHaveProperty('siteId');
    expect(result.rows[2]!.commands[0]!.payload).toMatchObject({
      accountType: 'MOBILE_MONEY',
      externalRef: '+237 677 00 00 00',
    });
    expect(isUuidv7(result.rows[0]!.commands[0]!.aggregateId)).toBe(true);
  });

  it('défauts signalés : type, site, titulaire, responsable ambigu ou inconnu, caisse de site déjà prise, code déjà connu', async () => {
    const issuesOf = async (extra: Record<string, string>, overrides: Partial<ImportRefs> = {}) => {
      const result = await plan(CASH_ACCOUNTS_ENTITY, [pdv(extra)], overrides);
      expect(result.rows[0]!.status).toBe('ERROR');
      return result.rows[0]!.issues.join(' | ');
    };
    expect(await issuesOf({ type: 'tiroir' })).toMatch(/Type inconnu/);
    expect(await issuesOf({ site: '' })).toMatch(/Site obligatoire pour une caisse PDV/);
    expect(await issuesOf({ site: 'AILLEURS' })).toMatch(/Site inconnu ou inactif/);
    expect(await issuesOf({ type: 'Caisse utilisateur' })).toMatch(/Titulaire obligatoire/);
    expect(await issuesOf({ responsable: 'Marie Dupont' })).toMatch(
      /Plusieurs utilisateurs actifs/,
    );
    expect(await issuesOf({ responsable: 'Inconnu' })).toMatch(/Responsable inconnu ou inactif/);
    expect(await issuesOf({ responsable: '' })).toMatch(/Responsable obligatoire/);

    const refs = await refsOf();
    const device = refs.slipContext!;
    const withAccounts = {
      slipContext: {
        ...device,
        refs: {
          ...device.refs,
          cashAccounts: [
            {
              id: 'a1',
              code: 'CAISSE-EXISTANTE',
              name: 'Caisse',
              account_type: 'CAISSE_PDV',
              site_id: IDS.site,
              holder_user_id: null,
              responsible_user_id: AWA,
              status: 'ACTIVE',
            },
          ],
        },
      },
    };
    expect(await issuesOf({}, withAccounts)).toMatch(/déjà une caisse de PDV active/);
    // Un compte de même code est déjà connu : il n'est pas rechargé.
    const known = await plan(
      CASH_ACCOUNTS_ENTITY,
      [{ code: 'CAISSE-EXISTANTE', nom: 'Banque', type: 'Banque', responsable: 'Awa Nde' }],
      withAccounts,
    );
    expect(known.rows[0]!.status).toBe('EXISTS');
  });
});

describe('Règles de prix (pricing.rule.draft)', () => {
  const rule = (extra: Record<string, string> = {}) => ({
    code: 'oeuf-gen',
    produit: 'OEUF',
    prix: '1 850',
    debut: '10/11/2026',
    ...extra,
  });

  it('un brouillon complet : portées, palier, période en heure de Douala', async () => {
    const result = await plan(PRICE_RULES_ENTITY, [
      rule(),
      rule({
        code: 'OEUF-GROS',
        site: 'MAG-DLA',
        zone: 'Littoral',
        categorie_client: 'grossiste',
        canal: 'pdv',
        quantite_min: '30',
        priorite: '10',
        fin: '31/12/2026',
        note: 'Prix de gros',
      }),
    ]);
    expect(result.rows.map((entry) => [entry.key, entry.status, entry.issues])).toEqual([
      ['OEUF-GEN', 'READY', []],
      ['OEUF-GROS', 'READY', []],
    ]);
    expect(result.rows[0]!.commands[0]).toMatchObject({
      commandType: 'pricing.rule.draft',
      aggregateType: 'PRICE_RULE',
      payload: {
        code: 'OEUF-GEN',
        productId: IDS.eggs,
        unitPriceXaf: 1850,
        pricingUnitCode: 'U',
        priority: 0,
        // Le 10/11 à 0 h à Douala (UTC+1) est le 9/11 à 23 h UTC.
        validFrom: '2026-11-09T23:00:00.000Z',
      },
    });
    expect(result.rows[0]!.commands[0]!.payload).not.toHaveProperty('validTo');
    expect(result.rows[1]!.commands[0]!.payload).toMatchObject({
      siteId: SITE_2,
      zoneId: ZONE_2,
      customerCategoryId: CATEGORY,
      channelCode: 'PDV',
      minQuantity: 30,
      priority: 10,
      validTo: '2026-12-30T23:00:00.000Z',
      notes: 'Prix de gros',
    });
  });

  it('défauts signalés : produit, prix, début passé, fin avant le début, portées inconnues, site hors de la zone', async () => {
    const issuesOf = async (extra: Record<string, string>) => {
      const result = await plan(PRICE_RULES_ENTITY, [rule(extra)]);
      expect(result.rows[0]!.status).toBe('ERROR');
      return result.rows[0]!.issues.join(' | ');
    };
    expect(await issuesOf({ produit: 'FANTOME' })).toMatch(/Produit inconnu/);
    expect(await issuesOf({ produit: 'ANCIEN' })).toMatch(/désactivé ou non vendable/);
    expect(await issuesOf({ prix: '0' })).toMatch(/Prix invalide/);
    expect(await issuesOf({ prix: '18,5' })).toMatch(/Prix invalide/);
    expect(await issuesOf({ debut: '01/11/2026' })).toMatch(/au plus tôt demain/);
    // Le jour même est refusé aussi : le début serait déjà passé à l'activation (refusée au-delà de cinq minutes).
    expect(await issuesOf({ debut: '05/11/2026' })).toMatch(/au plus tôt demain/);
    expect(await issuesOf({ debut: 'bientôt' })).toMatch(/Début invalide/);
    expect(await issuesOf({ debut: '' })).toMatch(/Début de validité obligatoire/);
    expect(await issuesOf({ fin: '09/11/2026' })).toMatch(/doit suivre le début/);
    expect(await issuesOf({ site: 'NULLE-PART' })).toMatch(/Site inconnu ou inactif/);
    expect(await issuesOf({ zone: 'Atlantide' })).toMatch(/Zone inconnue ou inactive/);
    expect(await issuesOf({ categorie_client: 'Fantôme' })).toMatch(/Catégorie de client inconnue/);
    expect(await issuesOf({ unite: 'ZZZ' })).toMatch(/Unité inconnue/);
    expect(await issuesOf({ quantite_min: '-3' })).toMatch(/Quantité minimale invalide/);
    expect(await issuesOf({ priorite: 'haute' })).toMatch(/Priorité invalide/);
    // Le site Douala n'est pas dans la zone Centre.
    expect(await issuesOf({ site: 'MAG-DLA', zone: 'Centre' })).toMatch(
      /n’appartient pas à la zone/,
    );
  });

  it('le même fichier rechargé redonne les mêmes identifiants (aucun brouillon en double)', async () => {
    const first = await plan(PRICE_RULES_ENTITY, [rule()]);
    const second = await plan(PRICE_RULES_ENTITY, [rule()]);
    expect(second.rows[0]!.commands[0]!.aggregateId).toBe(first.rows[0]!.commands[0]!.aggregateId);
  });

  it('un début de demain est chargeable : c’est le plus tôt qu’une règle puisse encore être activée', async () => {
    const result = await plan(PRICE_RULES_ENTITY, [rule({ debut: '06/11/2026' })]);
    expect(result.rows[0]!.status, JSON.stringify(result.rows[0])).toBe('READY');
  });

  it('un fichier corrigé n’est jamais pris pour le rejeu du premier : autre identifiant, brouillon déjà chargé signalé', async () => {
    const first = await plan(PRICE_RULES_ENTITY, [rule()]);
    const corrected = await plan(PRICE_RULES_ENTITY, [rule({ prix: '1 900' })]);
    const [original] = first.rows[0]!.commands;
    // Le contenu entre dans l'identifiant : le serveur juge le code pris (`CODE_EXISTS`) au lieu de « rejouer » le premier.
    expect(corrected.rows[0]!.commands[0]!.aggregateId).not.toBe(original!.aggregateId);

    // Le premier brouillon est parti depuis cet appareil (file d'envoi, même accepté) : …
    const device = (await refsOf()).slipContext!;
    const sent = (status: string) => ({
      command_id: 'd1',
      command_type: 'pricing.rule.draft',
      aggregate_id: original!.aggregateId,
      status,
      payload: original!.payload,
    });
    const withDraft = (status: string) => ({
      slipContext: {
        ...device,
        refs: { ...device.refs, outbox: [...device.refs.outbox, sent(status)] },
      },
    });
    // … le même fichier rechargé est reconnu (rien n'est renvoyé) …
    const same = await plan(PRICE_RULES_ENTITY, [rule()], withDraft('SYNCED') as never);
    expect(same.rows[0]!.status).toBe('EXISTS');
    // … le fichier corrigé est signalé, avec le conseil d'abandonner le brouillon ou de changer de code …
    const changed = await plan(
      PRICE_RULES_ENTITY,
      [rule({ prix: '1 900' })],
      withDraft('SYNCED') as never,
    );
    expect(changed.rows[0]!.status).toBe('ERROR');
    expect(changed.rows[0]!.issues.join(' ')).toMatch(
      /déjà chargé depuis cet appareil avec un autre contenu/,
    );
    // … sauf si le premier envoi a été refusé : plus rien ne bloque la correction.
    const afterRefusal = await plan(
      PRICE_RULES_ENTITY,
      [rule({ prix: '1 900' })],
      withDraft('REJECTED') as never,
    );
    expect(afterRefusal.rows[0]!.status).toBe('READY');
  });
});

describe('Registre des types chargeables', () => {
  it('trois types de plus, aux rôles de leurs écrans de saisie', () => {
    const ids = IMPORT_ENTITIES.map((entity) => entity.id);
    for (const entity of RP2_ENTITIES) expect(ids).toContain(entity.id);
    expect(OPENING_STOCK_ENTITY.roles).toEqual(['ADMIN', 'FINANCE']);
    expect(CASH_ACCOUNTS_ENTITY.roles).toEqual(['ADMIN', 'FINANCE']);
    expect(PRICE_RULES_ENTITY.roles).toEqual(['RESP_COMMERCIAL', 'DIRECTION']);
  });
});
