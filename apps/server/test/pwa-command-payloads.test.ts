/**
 * Conformité des charges de commande : toutes celles que les écrans d'administration, de supervision et de pilotage
 * de la PWA fabriquent (organisation, réglages, politiques, appareils, comptes, réaffectation des clients, conflits de
 * synchronisation, alertes, notes, vues et exports d'analyse : RP-1, RP-3, RP-4 et MP) sont **acceptées par le
 * schéma que le serveur enregistre pour ce type de commande, sans qu'aucun champ soit ignoré en silence**.
 *
 * Le second point est le piège : un schéma Zod écarte sans bruit un champ qu'il ne connaît pas, de sorte qu'une
 * charge au nom de champ erroné est « acceptée » et n'écrit rien. L'essai compare donc la charge fabriquée à la
 * charge lue par le serveur : toute clef perdue en route est un défaut de l'écran. Il passe par le registre de
 * l'application complète (le même que celui du pipeline), pas par une copie des schémas.
 *
 * Les écrans sont rejoués dans le vrai pipeline, avec leur effet en base, par `pwa-organization-commands.test.ts`
 * (organisation, réglages, politiques) ; ici, le filet couvre tous les types, y compris ceux dont l'effet métier
 * demande un état difficile à poser (conflit de synchronisation, alerte levée par un détecteur).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { rawCommandEnvelopeSchema } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import {
  COMMAND_HANDLER_REGISTRY,
  type CommandHandlerRegistry,
} from '../src/platform/sync/command-handler-registry.provider.js';
import { closeTestDb, freshUuid } from './helpers.js';
import {
  EMPTY_LOCATION_FORM,
  EMPTY_POS_FORM,
  EMPTY_SITE_FORM,
  EMPTY_TEAM_FORM,
  EMPTY_ZONE_FORM,
  locationCreateCommand,
  locationDeactivateCommand,
  locationUpdateCommand,
  posConfigureCommand,
  siteCloseCommand,
  siteCreateCommand,
  siteUpdateCommand,
  teamAssignCommand,
  teamCloseCommand,
  teamCreateCommand,
  teamRemoveCommand,
  zoneActiveCommand,
  zoneCreateCommand,
  zoneFormOf,
  zoneMoveCommand,
  zoneUpdateCommand,
  type TeamView,
  type ZoneView,
} from '../../pwa/src/features/organization/organization.js';
import {
  productEditFormOf,
  productUpdatePayload,
  standardCostPayload,
  type ProductView,
} from '../../pwa/src/features/catalog/catalog.js';
import { campaignPayload } from '../../pwa/src/features/pricing/campaign.js';
import {
  EMPTY_LOT_OPENING,
  lotOpeningPayload,
} from '../../pwa/src/features/production/lot-opening.js';
import { policyCommand, settingCommand } from '../../pwa/src/features/settings/settings.js';
import { commandOf, type DeviceAction } from '../../pwa/src/features/devices/devices.js';
import {
  grantPayload,
  revokePayload,
  statusCommand,
  updatePayload,
} from '../../pwa/src/features/users/users.js';
import {
  CONFLICT_RESOLUTIONS,
  conflictCommandOf,
} from '../../pwa/src/features/sync/sync-conflicts.js';
import { reassignPayload } from '../../pwa/src/features/crm/reassign.js';
import { profileOf, profilePatch } from '../../pwa/src/features/crm/profile.js';
import { EMPTY_VISIT, visitPayload } from '../../pwa/src/features/crm/visit.js';
import { reportPayload } from '../../pwa/src/features/crm/weekly-report.js';
import {
  emptyLine,
  emptySheet,
  recordPayload,
} from '../../pwa/src/features/presence/presence-form.js';
import type { CustomerData } from '../../pwa/src/features/sales/types.js';

/** Compte sans profil : le point de départ d'une première modification du profil. */
const EMPTY_CUSTOMER: CustomerData = {
  id: 'c',
  stage: 'PROSPECT',
  display_name: 'Compte',
  contact_name: null,
  category_id: null,
  phone_primary: null,
  address_text: null,
  zone_id: 'z',
  owner_user_id: null,
  home_site_id: null,
  merged_into_id: null,
  credit_allowed: false,
  credit_limit_xaf: null,
  payment_terms_days: null,
  outstanding_xaf: 0,
  version: 1,
};
import {
  buildAlertAckPayload,
  buildAlertDismissPayload,
  buildAlertResolvePayload,
  buildAlertRuleSetPayload,
  buildNotificationReadPayload,
} from '../../pwa/src/features/communication/alerts.js';
import {
  buildNoteAckPayload,
  buildNoteArchivePayload,
  buildNoteSaveOrPublishPayload,
} from '../../pwa/src/features/communication/notes.js';
import {
  buildViewDeletePayload,
  buildViewSetDefaultPayload,
  buildViewSharePayload,
} from '../../pwa/src/features/analytics/explorer.js';

interface Sample {
  readonly label: string;
  readonly commandType: string;
  readonly payload: unknown;
}

/** Clefs de `input` absentes de `output` : ce que le schéma du serveur a écarté sans rien dire. */
function droppedKeys(input: unknown, output: unknown, path = '$'): string[] {
  if (Array.isArray(input)) {
    if (!Array.isArray(output)) return [`${path} (tableau perdu)`];
    return input.flatMap((item, index) => droppedKeys(item, output[index], `${path}[${index}]`));
  }
  if (input !== null && typeof input === 'object') {
    if (output === null || typeof output !== 'object') return [`${path} (objet perdu)`];
    const out = output as Record<string, unknown>;
    return Object.entries(input as Record<string, unknown>).flatMap(([key, value]) => {
      if (value === undefined) return [];
      if (!(key in out)) return [`${path}.${key}`];
      return droppedKeys(value, out[key], `${path}.${key}`);
    });
  }
  return [];
}

/** Retire le `ok` des constructeurs de charge qui valident avant de rendre la commande. */
function built<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result as Extract<T, { ok: true }>;
}

function samples(): Sample[] {
  const id = () => freshUuid();
  const zone: ZoneView = {
    id: id(),
    parentId: id(),
    code: 'ZV1',
    name: 'Douala',
    level: 'VILLE',
    depth: 1,
    geofence: { lat: 4.05, lng: 9.76, radiusM: 1500 },
    maxGpsAccuracyM: 50,
    isActive: true,
  };
  const fromOrg = (label: string, c: { commandType: string; payload: unknown }): Sample => ({
    label,
    commandType: c.commandType,
    payload: c.payload,
  });
  const siteId = id();
  const userId = id();
  const teamId = id();
  const team: TeamView = {
    id: teamId,
    code: 'T1',
    name: 'Équipe',
    managerUserId: userId,
    managerName: 'Responsable',
    isActive: true,
    members: [],
  };
  const product: ProductView = {
    id: id(),
    code: 'OEUF',
    name: 'Œufs',
    categoryId: id(),
    stockFamily: 'PRODUCTION_COMMERCIALISABLE',
    baseUnitCode: 'U',
    lotTracking: 'OPTIONAL',
    isSellable: true,
    isPurchasable: false,
    isProducible: true,
    isConsumable: false,
    pricingMode: 'PER_UNIT',
    species: null,
    status: 'ACTIVE',
  };

  const org: Sample[] = [
    fromOrg(
      'organisation : site (tous les champs)',
      siteCreateCommand(
        {
          ...EMPTY_SITE_FORM,
          code: 'S1',
          name: 'Site',
          zoneId: zone.id,
          address: 'Rue 1',
          openedOn: '2026-10-01',
        },
        siteId,
      ),
    ),
    fromOrg(
      'organisation : site (champs facultatifs absents)',
      siteCreateCommand({ ...EMPTY_SITE_FORM, code: 'S2', name: 'Site 2', zoneId: zone.id }, id()),
    ),
    fromOrg(
      'organisation : mise à jour d’un site',
      siteUpdateCommand(siteId, { name: 'N', address: 'A' }, 'B'),
    ),
    fromOrg('organisation : fermeture d’un site', siteCloseCommand(siteId)),
    fromOrg(
      'organisation : emplacement',
      locationCreateCommand(
        siteId,
        {
          ...EMPTY_LOCATION_FORM,
          code: 'E1',
          name: 'Magasin',
          capacity: '100',
          parentLocationId: id(),
        },
        id(),
      ),
    ),
    fromOrg(
      'organisation : emplacement mobile confié',
      locationCreateCommand(
        siteId,
        {
          ...EMPTY_LOCATION_FORM,
          code: 'E2',
          name: 'Sacoche',
          locationType: 'MOBILE',
          custodianUserId: userId,
        },
        id(),
      ),
    ),
    fromOrg(
      'organisation : mise à jour d’un emplacement',
      locationUpdateCommand(id(), { name: 'N', capacity: '5' }),
    ),
    fromOrg('organisation : désactivation d’un emplacement', locationDeactivateCommand(id())),
    fromOrg(
      'organisation : zone avec géorepère',
      zoneCreateCommand(
        {
          ...EMPTY_ZONE_FORM,
          code: 'Z1',
          name: 'Zone',
          parentId: id(),
          lat: '4.05',
          lng: '9.76',
          radiusM: '1500',
          maxGpsAccuracyM: '50',
        },
        id(),
      ),
    ),
    fromOrg(
      'organisation : réglage du géorepère d’une zone',
      zoneUpdateCommand(zone, { ...zoneFormOf(zone), radiusM: '2000', maxGpsAccuracyM: '80' })!,
    ),
    fromOrg(
      'organisation : retrait du géorepère d’une zone',
      zoneUpdateCommand(zone, { ...zoneFormOf(zone), lat: '', lng: '', radiusM: '' })!,
    ),
    fromOrg('organisation : désactivation d’une zone', zoneActiveCommand(zone, false)),
    fromOrg('organisation : déplacement d’une zone (AV-515)', zoneMoveCommand(zone, id())),
    fromOrg('organisation : zone remise à la racine (AV-515)', zoneMoveCommand(zone, '')),
    fromOrg(
      'organisation : fermeture d’une équipe (AV-515)',
      teamCloseCommand(team, 'Réorganisation'),
    ),
    fromOrg(
      'organisation : fermeture d’une équipe sans motif (AV-515)',
      teamCloseCommand(team, ' '),
    ),
    fromOrg(
      'organisation : équipe',
      teamCreateCommand(
        { ...EMPTY_TEAM_FORM, code: 'T1', name: 'Équipe', managerUserId: userId },
        teamId,
      ),
    ),
    fromOrg('organisation : affectation à une équipe', teamAssignCommand(teamId, userId, id())),
    fromOrg('organisation : retrait d’une équipe', teamRemoveCommand(userId, id())),
    fromOrg(
      'organisation : point de vente partagé',
      posConfigureCommand(siteId, {
        ...EMPTY_POS_FORM,
        salesLocationId: id(),
        replenishmentSourceLocationId: id(),
        openingHours: 'Lun-Sam',
      }),
    ),
    fromOrg(
      'organisation : point de vente à appareil désigné',
      posConfigureCommand(siteId, {
        salesLocationId: id(),
        replenishmentSourceLocationId: '',
        custodyMode: 'EXCLUSIVE_DEVICE',
        designatedDeviceId: id(),
        openingHours: '',
      }),
    ),
    fromOrg(
      'réglages : valeur globale',
      settingCommand(
        { key: 'k', value: { a: 1 }, siteId: null, reason: 'R', isClientVisible: true },
        id(),
      ),
    ),
    fromOrg(
      'réglages : valeur d’un site',
      settingCommand({ key: 'k', value: 3, siteId, reason: '', isClientVisible: false }, id()),
    ),
    fromOrg(
      'politiques : avec validation',
      policyCommand(
        {
          id: id(),
          code: 'P',
          version: 1,
          operationType: 'LOSS_DECLARATION',
          condition: { minAmountXaf: 100 },
          requiresPhoto: false,
          requiresComment: false,
          requiresApproval: false,
          approverPermission: null,
          approverScope: null,
          status: 'ACTIVE',
          validFrom: '2026-10-01T00:00:00.000Z',
          validTo: null,
          createdAt: '2026-10-01T00:00:00.000Z',
          createdByName: null,
        },
        {
          requiresPhoto: true,
          requiresComment: true,
          requiresApproval: true,
          approverPermission: 'org.structure.manage',
          approverScope: 'SITE',
        },
        id(),
      ),
    ),
  ];

  const actions: DeviceAction[] = ['APPROVE', 'REFUSE', 'BLOCK', 'UNBLOCK', 'LOST', 'RETIRE'];
  const devices: Sample[] = [
    ...actions.map((action) =>
      fromOrg(`appareils : ${action}`, commandOf(action, { reason: 'Motif de l’essai' })),
    ),
    fromOrg(
      'appareils : rattachement à un site',
      commandOf('DESIGNATE', { reason: '', designation: { isShared: true, siteId } }),
    ),
    fromOrg(
      'appareils : rattachement retiré',
      commandOf('DESIGNATE', { reason: '', designation: { isShared: false, siteId: '' } }),
    ),
  ];

  const users: Sample[] = [
    fromOrg('comptes : suspension', statusCommand('SUSPEND', 'Motif')),
    fromOrg('comptes : désactivation', statusCommand('DEACTIVATE', 'Motif')),
    fromOrg('comptes : réactivation', statusCommand('REACTIVATE', '')),
    {
      label: 'comptes : modification du nom, du numéro et de l’adresse (AV-515)',
      commandType: 'identity.user.update',
      payload: updatePayload(
        { fullName: 'Awa Nde-Bell', phone: '690 00 00 02', email: '' },
        { fullName: 'Awa Nde', phone: '+237690000001', email: 'awa@gic-agropelc.test' },
      ),
    },
    {
      label: 'comptes : retrait d’un rôle',
      commandType: 'identity.role_assignment.revoke',
      payload: revokePayload('Motif'),
    },
    ...(['GLOBAL', 'SITE', 'ZONE', 'TEAM'] as const).map((scopeType): Sample => ({
      label: `comptes : ajout d’un rôle (${scopeType})`,
      commandType: 'identity.role_assignment.grant',
      payload: grantPayload(userId, { roleId: id(), scopeType, siteId, zoneId: zone.id, teamId }),
    })),
  ];

  const sync: Sample[] = [
    ...CONFLICT_RESOLUTIONS.map((resolution) =>
      fromOrg(
        `conflits : ${resolution}`,
        conflictCommandOf({
          mode: 'RESOLVE',
          resolution,
          comment: 'Régularisé',
          refsText: `${id()}, ${id()}`,
        }),
      ),
    ),
    fromOrg(
      'conflits : classement',
      conflictCommandOf({
        mode: 'DISMISS',
        resolution: 'KEEP_SERVER',
        comment: 'Sans suite',
        refsText: '',
      }),
    ),
    {
      label: 'clients : réaffectation',
      commandType: 'crm.customer.reassign',
      payload: reassignPayload(userId, 'Départ du commercial'),
    },
    // Profil commercial du client (PP-D, AV-316) : les cinq champs passent le schéma sans qu'aucun soit écarté.
    {
      label: 'clients : profil commercial',
      commandType: 'crm.customer.update',
      payload: {
        patch: profilePatch(
          {
            interestProductId: id(),
            potentialQtyText: '12,5',
            potentialUnitCode: 'KG',
            usualPaymentMethodCode: 'MOBILE_MONEY_MTN',
            creditRequested: true,
          },
          { ...profileOf(EMPTY_CUSTOMER) },
        ),
      },
    },
    // Visite avec veille marché (PP-D, AV-315) : aucun champ du relevé ne doit être écarté par le schéma.
    {
      label: 'visite : veille marché',
      commandType: 'crm.visit.record',
      payload: visitPayload({
        ...EMPTY_VISIT,
        customerId: id(),
        outcomeId: id(),
        notes: 'Veille du jour',
        marketWatch: [
          {
            key: 'a',
            watchType: 'COMPETITOR',
            sourceName: 'Ferme Abena',
            productId: id(),
            unitCode: 'KG',
            priceText: '2 900',
          },
          {
            key: 'b',
            watchType: 'SUPPLIER',
            sourceName: 'Provenderie du Littoral',
            productId: '',
            unitCode: '',
            priceText: '',
          },
        ],
      }),
    },
    // Présence du personnel (fiche PT) et bilan hebdomadaire (fiche BH) : PP-E, AV-313, AV-314.
    {
      label: 'présence : feuille hebdomadaire',
      commandType: 'fieldwork.presence.record',
      payload: recordPayload({
        ...emptySheet('2026-11-02', 'a'),
        siteId: id(),
        paperRef: '000042',
        responsibleName: 'Joseph Ngo Bayiha',
        lines: [
          {
            ...emptyLine('a'),
            personName: 'Paul Essomba',
            personRole: 'Ouvrier',
            missionLabel: 'Poulailler B2',
            days: [
              { arrival: '07:00', departure: '16:00', absence: '' },
              { arrival: '', departure: '', absence: 'M' },
              ...emptyLine('b').days.slice(2),
            ],
          },
        ],
      }),
    },
    {
      label: 'présence : annulation de la feuille',
      commandType: 'fieldwork.presence.cancel',
      payload: { comment: 'Feuille saisie deux fois' },
    },
    {
      label: 'bilan hebdomadaire : rédaction',
      commandType: 'crm.weekly_report.submit',
      payload: reportPayload('2026-11-02', {
        successes: 'Deux commandes',
        difficulties: 'Route coupée',
        needs: 'Plateaux',
        priorities: 'Relancer Mboppi',
        marketInfo: 'Concurrent à 2 500',
      }),
    },
    {
      label: 'bilan hebdomadaire : vu par le responsable',
      commandType: 'crm.weekly_report.review',
      payload: { comment: 'Bon rythme' },
    },
  ];

  const comm: Sample[] = [
    built(buildAlertAckPayload('Vu')),
    built(buildAlertAckPayload()),
    built(buildAlertResolvePayload('Réglé')),
    built(buildAlertDismissPayload('Sans objet')),
    built(buildNotificationReadPayload({ notificationIds: [id()] })),
    built(buildNotificationReadPayload({ all: true })),
    built(
      buildAlertRuleSetPayload({
        alertType: 'JOB_FAILED',
        enabled: true,
        severity: 'CRITICAL',
        escalationHours: 4,
      }),
    ),
    built(buildNoteAckPayload('READ')),
    built(buildNoteAckPayload('ACKNOWLEDGE')),
    built(buildNoteArchivePayload('Périmée')),
    built(
      buildNoteSaveOrPublishPayload(
        {
          title: 'Titre',
          body: 'Corps',
          category: 'INFORMATION',
          requiresAck: true,
          expiresAtDate: '2026-12-01',
          audience: [{ type: 'ALL' }],
        } as never,
        'PUBLISH',
      ),
    ),
    built(
      buildNoteSaveOrPublishPayload(
        {
          title: 'Titre',
          body: 'Corps',
          category: 'PRIX',
          requiresAck: false,
          expiresAtDate: '',
          audience: [{ type: 'ALL' }],
        } as never,
        'DRAFT',
      ),
    ),
    built(buildViewSharePayload(['DIRECTION'])),
    built(buildViewSetDefaultPayload('DIRECTION')),
    built(buildViewSetDefaultPayload(null)),
    built(buildViewDeletePayload()),
  ].map((command, index): Sample => ({
    label: `communication et analyse n° ${index + 1} : ${command.commandType}`,
    commandType: command.commandType,
    payload: command.payload,
  }));

  // Catalogue et prix (AV-516) : produit modifié, coût standard daté, campagne commerciale.
  const catalog: Sample[] = [
    {
      label: 'catalogue : produit modifié (AV-516)',
      commandType: 'catalog.product.update',
      payload: productUpdatePayload(product, {
        ...productEditFormOf(product),
        name: 'Œufs frais',
        categoryId: id(),
        isPurchasable: true,
      }),
    },
    {
      label: 'catalogue : coût standard avec motif (AV-516)',
      commandType: 'catalog.product_standard_cost.set',
      payload: standardCostPayload(product.id, '1 650', 'Nouvelle ration'),
    },
    {
      label: 'catalogue : coût standard sans motif (AV-516)',
      commandType: 'catalog.product_standard_cost.set',
      payload: standardCostPayload(product.id, '0', ''),
    },
    {
      label: 'prix : campagne commerciale (AV-516)',
      commandType: 'pricing.campaign.create',
      payload: campaignPayload({
        code: 'RENTREE',
        name: 'Rentrée scolaire',
        from: '2026-10-15T08:00',
        to: '2026-10-31T18:00',
      }),
    },
    {
      label: 'prix : abandon d’un brouillon (AV-516)',
      commandType: 'pricing.rule.cancel',
      payload: {},
    },
  ];

  // Chargements par fichier de la reprise (AV-517, `features/import/rp2-entities.ts`) : les clefs de ces charges sont
  // celles que le contrôle du fichier fabrique (essai de `rp2-entities.test.ts`) ; le serveur doit les lire toutes.
  const loading: Sample[] = [
    {
      label: 'chargement : stock d’ouverture (AV-517)',
      commandType: 'inventory.opening.post',
      payload: {
        locationId: id(),
        lines: [
          { productId: id(), quantityBase: 1200, unitCostXaf: 1850 },
          { productId: id(), quantityBase: 50.5, unitCostXaf: 3000 },
        ],
      },
    },
    {
      label: 'chargement : reprise d’un lot en cours (ADR-069)',
      commandType: 'production.lot_opening.post',
      payload: lotOpeningPayload({
        ...EMPTY_LOT_OPENING,
        lotType: 'PONDEUSE',
        productId: id(),
        mainLocationId: id(),
        placedOn: '2026-10-05',
        quantityText: '4 800',
        valueText: '5 760 000',
        supplierId: id(),
        strain: 'Lohmann',
        avgWeightText: '1250,5',
        notes: 'Bande reprise',
      }),
    },
    {
      label: 'chargement : caisse de point de vente (AV-517)',
      commandType: 'finance.cash_account.create',
      payload: {
        code: 'CAISSE-AKWA',
        name: 'Caisse du point de vente Akwa',
        accountType: 'CAISSE_PDV',
        siteId,
        responsibleUserId: userId,
        externalRef: '+237 677 00 00 00',
      },
    },
    {
      label: 'chargement : caisse personnelle (AV-517)',
      commandType: 'finance.cash_account.create',
      payload: {
        code: 'CAISSE-PAUL',
        name: 'Caisse de Paul',
        accountType: 'CAISSE_UTILISATEUR',
        holderUserId: userId,
        responsibleUserId: userId,
      },
    },
    {
      label: 'chargement : règle de prix en brouillon (AV-517)',
      commandType: 'pricing.rule.draft',
      payload: {
        code: 'OEUF-GROS',
        productId: id(),
        unitPriceXaf: 1850,
        pricingUnitCode: 'U',
        zoneId: id(),
        siteId,
        customerCategoryId: id(),
        channelCode: 'PDV',
        minQuantity: 30,
        priority: 10,
        validFrom: '2026-11-09T23:00:00.000Z',
        validTo: '2026-12-30T23:00:00.000Z',
        notes: 'Prix de gros',
      },
    },
  ];

  return [...org, ...devices, ...users, ...catalog, ...loading, ...sync, ...comm];
}

describe('charges de commande fabriquées par la PWA : le schéma du serveur les accepte, sans rien perdre', () => {
  let moduleRef: TestingModule;
  let registry: CommandHandlerRegistry;
  const all = samples();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    registry = moduleRef.get<CommandHandlerRegistry>(COMMAND_HANDLER_REGISTRY);
  });

  afterAll(async () => {
    await moduleRef?.close();
    await closeTestDb();
  });

  const envelopeOf = (sample: Sample) => ({
    command_id: freshUuid(),
    device_seq: 1,
    command_type: sample.commandType,
    command_version: 1,
    author_user_id: freshUuid(),
    aggregate_type: 'ESSAI',
    aggregate_id: freshUuid(),
    base_version: null,
    depends_on: [],
    occurred_at: new Date().toISOString(),
    client_created_at: new Date().toISOString(),
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    payload: sample.payload,
  });

  it('la liste couvre bien tous les écrans visés (garde contre une liste vide ou tronquée)', () => {
    expect(all.length).toBeGreaterThan(55);
    const types = new Set(all.map((sample) => sample.commandType));
    for (const required of [
      'organization.site.create',
      'organization.pos.configure',
      'approvals.policy.set',
      'identity.device.designate',
      'identity.role_assignment.grant',
      'identity.user.update',
      'organization.zone.move',
      'organization.team.close',
      'catalog.product.update',
      'catalog.product_standard_cost.set',
      'pricing.campaign.create',
      'pricing.rule.cancel',
      'sync.conflict.resolve',
      'crm.customer.reassign',
      'crm.visit.record',
      'crm.customer.update',
      'fieldwork.presence.record',
      'fieldwork.presence.cancel',
      'crm.weekly_report.submit',
      'crm.weekly_report.review',
      'communication.alert_rule.set',
      'communication.note.publish',
      'analytics.view.share',
    ]) {
      expect(types.has(required), required).toBe(true);
    }
  });

  it('le détecteur voit un champ ignoré par le serveur (témoin : il ne doit pas rester muet)', () => {
    const sample: Sample = {
      label: 'témoin',
      commandType: 'organization.site.close',
      payload: { champInconnu: 1 },
    };
    const parsed = registry.parse(envelopeOf(sample));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(droppedKeys(sample.payload, parsed.envelope.payload)).toEqual(['$.champInconnu']);
    }
  });

  for (const sample of samples()) {
    it(`${sample.label} (${sample.commandType})`, () => {
      const envelope = envelopeOf(sample);
      expect(rawCommandEnvelopeSchema.safeParse(envelope).success).toBe(true);
      expect(
        registry.isVersionSupported(sample.commandType, 1),
        `type de commande inconnu du serveur : ${sample.commandType}`,
      ).toBe(true);
      const parsed = registry.parse(envelope);
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      if (!parsed.ok) return;
      expect(
        droppedKeys(sample.payload, parsed.envelope.payload),
        `champs ignorés en silence par le serveur pour ${sample.commandType}`,
      ).toEqual([]);
    });
  }
});
