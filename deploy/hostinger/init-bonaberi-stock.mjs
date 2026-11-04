/**
 * Initialisation du site de Bonabéri, du catalogue et du stock de poulets (15 000 têtes/pièces).
 *
 * Débloque la prise de commandes et la saisie des ventes pour le responsable commercial et les
 * commerciaux conformément aux règles métier (BR-VEN-017, BR-DIS-005, ADR-028, ADR-031) :
 * 1. Unités de base et de conditionnement (TETE, PIECE, KG, PLATEAU, SAC)
 * 2. Canaux de vente (POINT_DE_VENTE, DIRECT, SEDENTAIRE, TERRAIN)
 * 3. Catégories de produits (VOLAILLE, OEUFS, PORCS, ALIMENTS)
 * 4. Produits (POULET-CHAIR, POULET-VIF, OEUF-PLT, PORC-CHARC, PONDEUSE)
 * 5. Règles de prix actives pour chaque produit
 * 6. Site Bonabéri (SITE-BONA / BONABERI au centre équestre, zone DOUALA-BONABERI)
 * 7. Emplacements physiques :
 *    - POS-BONA : Entrepôt Bonabéri - Point de vente (type POS, garde SHARED)
 *    - MAG-BONA : Entrepôt Bonabéri - Magasin (type STORE, garde SHARED)
 * 8. Comptes de trésorerie (Caisse centrale, Caisse Bonabéri, Caisse Dessiri, MoMo, Banque)
 * 9. Stock initial de 15 000 poulets à Bonabéri (via recordStockMove OPENING_BALANCE)
 * 10. Rôle COMMERCIAL_SEDENTAIRE global accordé au responsable commercial en complément de
 *     RESP_COMMERCIAL pour lui permettre de vendre depuis tout stock sans restriction
 * 11. Aucune approbation d'appareil : elle se fait dans l'écran Appareils (ECR-ADM-05) ou avec
 *     approve-device.mjs, appareil par appareil (SM-DEVICE, BR-ADM-005). Ce script ne touche pas à
 *     l'état des appareils (un balayage de tous les appareils en attente approuvait aussi des appareils
 *     inconnus et sans trace d'audit : retiré le 04/11/2026).
 *
 * Toutes les écritures passent par les vraies commandes du pipeline et les fonctions de domaine
 * pour garantir l'intégrité de l'audit et du flux de synchronisation (sync_change_feed).
 * Les valeurs métier ci-dessous (quantités, coût et prix de départ, droits du responsable commercial)
 * sont des défauts de mise en service à faire valider par le porteur : AV-500.
 *
 * Usage, SUR LE SERVEUR, dans le dossier de l'application :
 *   node --env-file=.env init-bonaberi-stock.mjs [--dry-run]
 * Avec --dry-run, rien n'est écrit : les lectures ont lieu, chaque écriture est seulement annoncée.
 */
import { DefaultQueryCompiler } from 'kysely';
import { SystemClock, Uuidv7Generator } from '@gic/domain';
import { installMariaDbCompat } from './mariadb-compat.mjs';
import { createDatabase } from './dist/platform/kysely/database.js';
import { fromBin, toBin } from './dist/platform/kysely/uuid-columns.js';
import { CommandHandlerRegistry } from './dist/platform/sync/command-handler-registry.js';
import { CommandPipelineService } from './dist/commands/command-pipeline.service.js';
import { registerReferenceCommands } from './dist/modules/catalog/application/commands/reference-commands.js';
import { registerProductCommands } from './dist/modules/catalog/application/commands/product-commands.js';
import { registerSiteCommands } from './dist/modules/organization/application/commands/site-commands.js';
import { registerLocationCommands } from './dist/modules/organization/application/commands/location-commands.js';
import { registerPricingCommands } from './dist/modules/pricing/application/commands/pricing-commands.js';
import { registerAccountCommands } from './dist/modules/finance/application/commands/account-commands.js';
import { recordStockMove } from './dist/modules/inventory/application/public/record-move.js';
import { virtualLocationId } from './dist/modules/inventory/application/public/virtual-locations.js';
import { insertRoleAssignment } from './dist/modules/identity/application/role-assignment-writer.js';
import { invalidateUser } from './dist/modules/identity/application/rbac/rbac-cache.js';

const dryRun = process.argv.includes('--dry-run');

const url = process.env.SERVER_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('SERVER_DATABASE_URL ou DATABASE_URL non définie (lancer avec --env-file=.env).');
  process.exit(2);
}

installMariaDbCompat(DefaultQueryCompiler);
const { db, pool } = createDatabase(url);

const clock = new SystemClock();
const idGenerator = new Uuidv7Generator(clock);
const registry = new CommandHandlerRegistry();

registerReferenceCommands(registry);
registerProductCommands(registry, idGenerator);
registerSiteCommands(registry);
registerLocationCommands(registry);
registerPricingCommands(registry);
registerAccountCommands(registry);

const pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

let seq = Date.now() % 1_000_000_000;

async function sendCommand(actor, command) {
  const id = command.aggregateId ?? idGenerator.newId();
  if (dryRun) {
    console.log(`    (simulé) ${command.type} sur ${id}`);
    return { id, result: { status: 'DRY_RUN' } };
  }
  const now = new Date().toISOString();
  seq += 1;
  const result = await pipeline.handle(
    {
      command_id: idGenerator.newId(),
      device_seq: seq,
      command_version: 1,
      command_type: command.type,
      aggregate_type: command.aggregateType,
      aggregate_id: id,
      author_user_id: actor.userId,
      base_version: null,
      depends_on: [],
      occurred_at: now,
      client_created_at: now,
      captured_offline: false,
      backdated_reason: null,
      attachment_ids: [],
      payload: command.payload,
    },
    {
      authenticatedUserId: actor.userId,
      authenticatedDeviceId: actor.deviceId,
      transport: 'ONLINE_API',
    },
  );

  if (result.status !== 'APPLIED' && result.status !== 'APPLIED_WITH_WARNINGS') {
    throw new Error(`Échec de ${command.type} : ${JSON.stringify(result)}`);
  }
  return { id, result };
}

async function run() {
  console.log('== Initialisation Bonabéri, Catalogue & Stock ==');
  if (dryRun)
    console.log('(Mode --dry-run : aucune écriture, chaque écriture est seulement annoncée)');

  // 1. Recherche de l'administrateur et de son appareil
  const admin = await db
    .selectFrom('identity_users')
    .select(['id', 'email', 'full_name'])
    .where('email', '=', 'admin@gic-agropelc.com')
    .executeTakeFirst();
  if (!admin) throw new Error('Utilisateur admin@gic-agropelc.com introuvable.');

  const adminId = fromBin(admin.id);
  console.log(`Administrateur : ${admin.full_name} (${adminId})`);

  const device = await db
    .selectFrom('identity_devices')
    .select(['id', 'short_code'])
    .where('enrolled_by_user_id', '=', admin.id)
    .where('status', '=', 'ACTIVE')
    .executeTakeFirst();
  if (!device) throw new Error('Aucun appareil actif pour l’administrateur.');

  const deviceId = fromBin(device.id);
  console.log(`Appareil admin actif : ${device.short_code} (${deviceId})`);

  const actor = { userId: adminId, deviceId };

  // 2. Recherche du responsable commercial
  const manager = await db
    .selectFrom('identity_users')
    .select(['id', 'email', 'full_name'])
    .where('email', '=', 'dessiri.d@gic-agropelc.com')
    .executeTakeFirst();
  if (!manager) throw new Error('Responsable commercial dessiri.d@gic-agropelc.com introuvable.');

  const managerId = fromBin(manager.id);
  console.log(`Responsable commercial : ${manager.full_name} (${managerId})`);

  // 3. Unités
  console.log('\n--- 1. Unités ---');
  const units = [
    { code: 'TETE', name: 'Tête', isCount: true },
    { code: 'PIECE', name: 'Pièce', isCount: true },
    { code: 'KG', name: 'Kilogramme', isCount: false },
    { code: 'PLATEAU', name: 'Plateau de 30 œufs', isCount: true },
    { code: 'SAC', name: 'Sac', isCount: true },
  ];
  for (const u of units) {
    const exists = await db
      .selectFrom('catalog_units')
      .select('code')
      .where('code', '=', u.code)
      .executeTakeFirst();
    if (!exists) {
      await sendCommand(actor, {
        type: 'catalog.unit.create',
        aggregateType: 'UNIT',
        payload: u,
      });
      console.log(`  + Unité créée : ${u.code} (${u.name})`);
    } else {
      console.log(`  = Unité déjà présente : ${u.code}`);
    }
  }

  // 4. Canaux de vente
  console.log('\n--- 2. Canaux de vente ---');
  const channels = [
    { code: 'POINT_DE_VENTE', name: 'Point de vente' },
    { code: 'DIRECT', name: 'Vente directe' },
    { code: 'SEDENTAIRE', name: 'Commercial sédentaire' },
    { code: 'TERRAIN', name: 'Commercial terrain' },
  ];
  for (const c of channels) {
    const exists = await db
      .selectFrom('catalog_sales_channels')
      .select('code')
      .where('code', '=', c.code)
      .executeTakeFirst();
    if (!exists) {
      await sendCommand(actor, {
        type: 'catalog.sales_channel.create',
        aggregateType: 'SALES_CHANNEL',
        payload: c,
      });
      console.log(`  + Canal créé : ${c.code} (${c.name})`);
    } else {
      console.log(`  = Canal déjà présent : ${c.code}`);
    }
  }

  // 5. Catégories de produits
  console.log('\n--- 3. Catégories de produits ---');
  const categories = [
    { code: 'VOLAILLE', name: 'Volaille' },
    { code: 'OEUFS', name: 'Œufs' },
    { code: 'PORCS', name: 'Porcs' },
    { code: 'ALIMENTS', name: 'Aliments et intrants' },
  ];
  const categoryIds = new Map();
  for (const cat of categories) {
    const existing = await db
      .selectFrom('catalog_product_categories')
      .select('id')
      .where('code', '=', cat.code)
      .executeTakeFirst();
    if (existing) {
      categoryIds.set(cat.code, fromBin(existing.id));
      console.log(`  = Catégorie déjà présente : ${cat.code}`);
    } else {
      const { id } = await sendCommand(actor, {
        type: 'catalog.product_category.create',
        aggregateType: 'PRODUCT_CATEGORY',
        payload: cat,
      });
      categoryIds.set(cat.code, id);
      console.log(`  + Catégorie créée : ${cat.code} (${id})`);
    }
  }

  // 6. Produits du catalogue
  console.log('\n--- 4. Produits ---');
  const products = [
    {
      code: 'POULET-CHAIR',
      name: 'Poulet de chair',
      categoryId: categoryIds.get('VOLAILLE'),
      stockFamily: 'PRODUCTION_COMMERCIALISABLE',
      baseUnitCode: 'PIECE',
      isSellable: true,
      isProducible: true,
    },
    {
      code: 'POULET-VIF',
      name: 'Poulet de chair vif',
      categoryId: categoryIds.get('VOLAILLE'),
      stockFamily: 'BIOLOGIQUE',
      baseUnitCode: 'TETE',
      species: 'POULET_CHAIR',
      isSellable: true,
    },
    {
      code: 'OEUF-PLT',
      name: 'Œufs de table (plateau de 30)',
      categoryId: categoryIds.get('OEUFS'),
      stockFamily: 'PRODUCTION_COMMERCIALISABLE',
      baseUnitCode: 'PLATEAU',
      isSellable: true,
      isProducible: true,
    },
    {
      code: 'PORC-CHARC',
      name: 'Porc charcutier',
      categoryId: categoryIds.get('PORCS'),
      stockFamily: 'BIOLOGIQUE',
      baseUnitCode: 'TETE',
      species: 'PORC',
      isSellable: true,
    },
    {
      code: 'PONDEUSE',
      name: 'Poule pondeuse de réforme',
      categoryId: categoryIds.get('VOLAILLE'),
      stockFamily: 'BIOLOGIQUE',
      baseUnitCode: 'TETE',
      species: 'PONDEUSE',
      isSellable: true,
    },
  ];

  const productIds = new Map();
  for (const prod of products) {
    const existing = await db
      .selectFrom('catalog_products')
      .select('id')
      .where('code', '=', prod.code)
      .executeTakeFirst();
    if (existing) {
      productIds.set(prod.code, fromBin(existing.id));
      console.log(`  = Produit déjà présent : ${prod.code}`);
    } else {
      const { id } = await sendCommand(actor, {
        type: 'catalog.product.create',
        aggregateType: 'PRODUCT',
        payload: prod,
      });
      productIds.set(prod.code, id);
      console.log(`  + Produit créé : ${prod.code} (${prod.name})`);
    }
  }

  // 7. Tarifs
  console.log('\n--- 5. Règles de prix ---');
  const priceRules = [
    {
      code: 'PRIX-POULET-CHAIR',
      productCode: 'POULET-CHAIR',
      unitPriceXaf: 3500,
      pricingUnitCode: 'PIECE',
    },
    {
      code: 'PRIX-POULET-VIF',
      productCode: 'POULET-VIF',
      unitPriceXaf: 3000,
      pricingUnitCode: 'TETE',
    },
    {
      code: 'PRIX-OEUF-PLT',
      productCode: 'OEUF-PLT',
      unitPriceXaf: 2500,
      pricingUnitCode: 'PLATEAU',
    },
    {
      code: 'PRIX-PORC-CHARC',
      productCode: 'PORC-CHARC',
      unitPriceXaf: 85000,
      pricingUnitCode: 'TETE',
    },
    {
      code: 'PRIX-PONDEUSE',
      productCode: 'PONDEUSE',
      unitPriceXaf: 3000,
      pricingUnitCode: 'TETE',
    },
  ];

  for (const pr of priceRules) {
    const existing = await db
      .selectFrom('pricing_price_rules')
      .select(['id', 'status'])
      .where('code', '=', pr.code)
      .executeTakeFirst();
    if (existing && existing.status === 'ACTIVE') {
      console.log(`  = Prix déjà actif : ${pr.code}`);
    } else {
      let ruleId = existing ? fromBin(existing.id) : undefined;
      const productId = productIds.get(pr.productCode);
      if (!ruleId) {
        const { id } = await sendCommand(actor, {
          type: 'pricing.rule.draft',
          aggregateType: 'PRICE_RULE',
          payload: {
            code: pr.code,
            productId,
            unitPriceXaf: pr.unitPriceXaf,
            pricingUnitCode: pr.pricingUnitCode,
            validFrom: new Date(Date.now() - 60_000).toISOString(),
          },
        });
        ruleId = id;
      } else {
        // Mettre à jour la date d'effet du brouillon pour respecter la fenêtre de 5 min
        if (dryRun) console.log(`    (simulé) date d'effet du brouillon ${pr.code}`);
        else
          await db
            .updateTable('pricing_price_rules')
            .set({ valid_from: new Date(Date.now() - 60_000) })
            .where('id', '=', existing.id)
            .execute();
      }
      await sendCommand(actor, {
        type: 'pricing.rule.activate',
        aggregateType: 'PRICE_RULE',
        aggregateId: ruleId,
        payload: {},
      });
      console.log(
        `  + Règle de prix active : ${pr.code} (${pr.unitPriceXaf} XAF / ${pr.pricingUnitCode})`,
      );
    }
  }

  // 8. Site Bonabéri
  console.log('\n--- 6. Site Bonabéri ---');
  const bonaberiZone = await db
    .selectFrom('organization_zones')
    .select('id')
    .where('code', '=', 'DOUALA-BONABERI')
    .executeTakeFirst();
  if (!bonaberiZone) throw new Error('Zone DOUALA-BONABERI introuvable.');

  const bonaberiZoneId = fromBin(bonaberiZone.id);

  let siteBonaberiId;
  const existingSite = await db
    .selectFrom('organization_sites')
    .select('id')
    .where('code', '=', 'BONABERI')
    .executeTakeFirst();
  if (existingSite) {
    siteBonaberiId = fromBin(existingSite.id);
    console.log(`  = Site déjà présent : BONABERI (${siteBonaberiId})`);
  } else {
    const { id } = await sendCommand(actor, {
      type: 'organization.site.create',
      aggregateType: 'SITE',
      payload: {
        code: 'BONABERI',
        name: 'Site Bonabéri - Centre équestre',
        siteType: 'MAGASIN',
        zoneId: bonaberiZoneId,
        address: 'Centre équestre, Bonabéri, Douala',
      },
    });
    siteBonaberiId = id;
    console.log(`  + Site créé : BONABERI (${siteBonaberiId})`);
  }

  // 9. Emplacements de Bonabéri
  console.log('\n--- 7. Emplacements physiques ---');
  let posLocationId;
  const existingPos = await db
    .selectFrom('organization_locations')
    .select('id')
    .where('site_id', '=', toBin(siteBonaberiId))
    .where('code', '=', 'POS-BONA')
    .executeTakeFirst();
  if (existingPos) {
    posLocationId = fromBin(existingPos.id);
    console.log(`  = Emplacement POS déjà présent : POS-BONA (${posLocationId})`);
  } else {
    const { id } = await sendCommand(actor, {
      type: 'organization.location.create',
      aggregateType: 'LOCATION',
      payload: {
        siteId: siteBonaberiId,
        code: 'POS-BONA',
        name: 'Entrepôt Bonabéri - Point de vente',
        locationType: 'POS',
        custodyMode: 'SHARED',
      },
    });
    posLocationId = id;
    console.log(`  + Emplacement POS créé : POS-BONA (${posLocationId})`);
  }

  let storeLocationId;
  const existingStore = await db
    .selectFrom('organization_locations')
    .select('id')
    .where('site_id', '=', toBin(siteBonaberiId))
    .where('code', '=', 'MAG-BONA')
    .executeTakeFirst();
  if (existingStore) {
    storeLocationId = fromBin(existingStore.id);
    console.log(`  = Emplacement STORE déjà présent : MAG-BONA (${storeLocationId})`);
  } else {
    const { id } = await sendCommand(actor, {
      type: 'organization.location.create',
      aggregateType: 'LOCATION',
      payload: {
        siteId: siteBonaberiId,
        code: 'MAG-BONA',
        name: 'Entrepôt Bonabéri - Magasin',
        locationType: 'STORE',
        custodyMode: 'SHARED',
      },
    });
    storeLocationId = id;
    console.log(`  + Emplacement STORE créé : MAG-BONA (${storeLocationId})`);
  }

  // 10. Comptes de trésorerie
  console.log('\n--- 8. Comptes de trésorerie ---');
  const cashAccounts = [
    {
      code: 'CAISSE-CENTRALE',
      name: 'Caisse centrale',
      accountType: 'CAISSE_CENTRALE',
      responsibleUserId: adminId,
    },
    {
      code: 'CAISSE-BONA',
      name: 'Caisse Bonabéri',
      accountType: 'CAISSE_PDV',
      siteId: siteBonaberiId,
      responsibleUserId: adminId,
    },
    {
      code: 'CAISSE-DESSIRI',
      name: 'Caisse commerciale - Dessiri',
      accountType: 'CAISSE_UTILISATEUR',
      holderUserId: managerId,
      responsibleUserId: managerId,
    },
    {
      code: 'MOMO-GIC',
      name: 'Mobile Money GIC',
      accountType: 'MOBILE_MONEY',
      responsibleUserId: adminId,
    },
    {
      code: 'BANQUE-GIC',
      name: 'Compte bancaire GIC AGROPELC',
      accountType: 'BANQUE',
      responsibleUserId: adminId,
    },
  ];

  for (const ca of cashAccounts) {
    const existing = await db
      .selectFrom('finance_cash_accounts')
      .select('id')
      .where('code', '=', ca.code)
      .executeTakeFirst();
    if (existing) {
      console.log(`  = Compte déjà présent : ${ca.code}`);
    } else {
      await sendCommand(actor, {
        type: 'finance.cash_account.create',
        aggregateType: 'CASH_ACCOUNT',
        payload: ca,
      });
      console.log(`  + Compte créé : ${ca.code} (${ca.name})`);
    }
  }

  // 11. Stock initial de 15 000 poulets à Bonabéri
  console.log('\n--- 9. Stock de 15 000 poulets à Bonabéri ---');
  const openingVirtualLocationId = await virtualLocationId(db, 'V_OPENING');

  const stockMoveDeps = { idGenerator };
  const productsWithInitialStock = [
    {
      productCode: 'POULET-CHAIR',
      quantity: 15000,
      unitCost: 2000,
    },
    {
      productCode: 'POULET-VIF',
      quantity: 15000,
      unitCost: 2000,
    },
  ];

  for (const item of productsWithInitialStock) {
    const prodId = productIds.get(item.productCode);
    const existingBalance = await db
      .selectFrom('inventory_stock_balances')
      .select('qty_on_hand')
      .where('location_id', '=', toBin(posLocationId))
      .where('product_id', '=', toBin(prodId))
      .executeTakeFirst();

    if (existingBalance && Number(existingBalance.qty_on_hand) > 0) {
      console.log(
        `  = Solde de stock existant pour ${item.productCode} : ${existingBalance.qty_on_hand}`,
      );
    } else {
      let lotId = null;
      if (item.productCode === 'POULET-VIF') {
        // Créer un lot de traçabilité pour le produit biologique (BR-STK-050)
        lotId = idGenerator.newId();
        if (!dryRun)
          await db
            .insertInto('inventory_stock_lots')
            .values({
              id: toBin(lotId),
              lot_code: 'LOT-BONA-VIF-01',
              product_id: toBin(prodId),
              origin_type: 'PRODUCTION_LOT',
              fifo_rank_at: new Date(Date.now() - 3600_000),
              status: 'OPEN',
              sellable_from_rearing: 1,
              created_by: toBin(adminId),
            })
            .execute();
        console.log(
          `  + Lot de stock ${dryRun ? '(simulé) ' : ''}créé pour ${item.productCode} : LOT-BONA-VIF-01 (${lotId})`,
        );
      }

      if (!dryRun)
        await db.transaction().execute(async (trx) => {
          await recordStockMove(trx, stockMoveDeps, {
            productId: prodId,
            lotId,
            quantityBase: item.quantity,
            fromLocationId: openingVirtualLocationId,
            toLocationId: posLocationId,
            moveType: 'OPENING_BALANCE',
            declaredUnitCostXaf: item.unitCost,
            occurredAt: new Date(Date.now() - 3600_000),
            sourceDocType: 'INVENTORY_COUNT',
            sourceDocId: idGenerator.newId(),
            createdBy: adminId,
            allowNegative: false,
          });
        });
      console.log(
        `  + Mouvement OPENING_BALANCE enregistré : 15 000 unités de ${item.productCode} sur POS-BONA.`,
      );
    }
  }

  // 12. Octroi du rôle COMMERCIAL_SEDENTAIRE global au responsable commercial
  console.log('\n--- 10. Droits du responsable commercial ---');
  const roleSedentaire = await db
    .selectFrom('identity_roles')
    .select('id')
    .where('code', '=', 'COMMERCIAL_SEDENTAIRE')
    .executeTakeFirst();

  if (roleSedentaire) {
    const existingAssignment = await db
      .selectFrom('identity_user_role_assignments')
      .select('id')
      .where('user_id', '=', toBin(managerId))
      .where('role_id', '=', roleSedentaire.id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    if (existingAssignment) {
      console.log('  = Rôle COMMERCIAL_SEDENTAIRE déjà attribué à Dessiri.');
    } else if (dryRun) {
      console.log('  + (simulé) Rôle COMMERCIAL_SEDENTAIRE (GLOBAL) attribué à Dessiri.');
    } else {
      await db.transaction().execute(async (trx) => {
        const refusal = await insertRoleAssignment(trx, {
          assignmentId: idGenerator.newId(),
          userId: managerId,
          roleId: fromBin(roleSedentaire.id),
          scopeType: 'GLOBAL',
          validFrom: new Date(Date.now() - 3600_000),
          createdBy: adminId,
        });
        if (refusal)
          throw new Error(`Refus affectation rôle : ${refusal.code} - ${refusal.message}`);
      });
      invalidateUser(managerId);
      console.log('  + Rôle COMMERCIAL_SEDENTAIRE (GLOBAL) attribué à Dessiri.');
    }
  }

  // 13. Appareils : aucune approbation ici (SM-DEVICE, BR-ADM-005). Le script annonce seulement ce qui attend.
  console.log('\n--- 11. Appareils en attente (non modifiés) ---');
  const pendingDevices = await db
    .selectFrom('identity_devices')
    .select(['short_code'])
    .where('status', '=', 'PENDING')
    .execute();
  if (pendingDevices.length === 0) {
    console.log('  = Aucun appareil en attente d’approbation.');
  } else {
    console.log(
      `  ${pendingDevices.length} appareil(s) en attente (${pendingDevices.map((d) => d.short_code).join(', ')}) : ` +
        'à approuver ou refuser un par un dans l’écran Appareils, ou avec approve-device.mjs.',
    );
  }

  console.log(
    dryRun
      ? '\n== Simulation terminée : rien n’a été écrit. =='
      : '\n== Tout a été initialisé avec succès ! ==',
  );
}

try {
  await run();
} catch (error) {
  console.error('\nERREUR FATALE :', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
