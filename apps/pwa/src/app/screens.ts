/**
 * Registre des écrans de la PWA et navigation par rôle (ECR-ADM-03, UX-01 ; ADR-036).
 *
 * L'accueil reçoit du serveur, pour chaque rôle, des actions identifiées par un code
 * (`apps/server/src/home-api/role-catalog.ts`). ADR-030 §8 veut que le serveur renseigne la route
 * d'une action dès que son écran existe ; tant qu'il renvoie `route: null`, l'appareil complète la
 * route à partir de ce registre (`routeOfAction`). Une route fournie par le serveur l'emporte
 * toujours. Le registre ne contient que des écrans livrés : une action sans écran reste « Bientôt ».
 *
 * Les rôles de chaque écran suivent l'inventaire de `03-parcours-et-ecrans.md` §3 ; ils servent à
 * composer le menu, jamais à autoriser : le serveur revérifie chaque permission.
 */
import type { HomeAction } from '@gic/contracts';

export const ROUTES = {
  home: '/',
  menu: '/menu',
  sync: '/synchronisation',
  newSale: '/ventes/nouvelle',
  newSaleFor: (customerId: string) => `/ventes/nouvelle?client=${encodeURIComponent(customerId)}`,
  sales: '/ventes',
  salePattern: '/ventes/:saleId',
  sale: (saleId: string) => `/ventes/${saleId}`,
  newOrder: '/commandes/nouvelle',
  newOrderFor: (customerId: string) =>
    `/commandes/nouvelle?client=${encodeURIComponent(customerId)}`,
  orders: '/commandes',
  orderPattern: '/commandes/:orderId',
  order: (orderId: string) => `/commandes/${orderId}`,
  deliverPattern: '/commandes/:orderId/livrer',
  deliver: (orderId: string) => `/commandes/${orderId}/livrer`,
  collect: '/encaisser',
  service: '/service',
  productionLots: '/production/lots',
  dailyEntryPattern: '/production/lots/:lotId',
  dailyEntry: (lotId: string) => `/production/lots/${lotId}`,
  eggCollection: '/production/collecte',
  eggCollectionFor: (lotId: string) => `/production/collecte?lot=${encodeURIComponent(lotId)}`,
  productionOutput: '/production/sortie',
  lotSetup: '/production/nouveau-lot',
  /** ECR-PRD-04 sur la rubrique « Entrée dans un lot », lot déjà choisi (AV-526). */
  lotEntryFor: (lotId: string) => `/production/nouveau-lot?lot=${encodeURIComponent(lotId)}`,
  incubation: '/production/incubation',
  lotSheet: '/production/fiche',
  lotSheetFor: (lotId: string) => `/production/fiche?lot=${encodeURIComponent(lotId)}`,
  productionOutputFor: (lotId: string) => `/production/sortie?lot=${encodeURIComponent(lotId)}`,
  purchaseRequests: '/achats/demandes',
  purchaseReceipts: '/achats/receptions',
  suppliers: '/achats/fournisseurs',
  purchaseOrders: '/achats/bons-de-commande',
  /** ECR-APP-05 (P8E-07) : rapprochement commandé, livré, accepté, facturé, payé. */
  orderMatching: '/achats/rapprochement',
  purchaseReceiptPattern: '/achats/receptions/:orderId',
  purchaseReceipt: (orderId: string) => `/achats/receptions/${orderId}`,
  /** ECR-APP-04, réception sans bon de commande (AV-519) : le segment prend la place de l'identifiant du bon. */
  purchaseReceiptFree: '/achats/receptions/sans-bon',
  priceSimulator: '/prix/simulateur',
  priceRules: '/prix/regles',
  catalog: '/catalogue',
  stock: '/stock',
  stockLedger: '/stock/registre',
  portfolio: '/clients',
  performance: '/objectifs',
  targets: '/objectifs/gestion',
  newProspect: '/clients/nouveau',
  newVisit: '/clients/visite',
  newVisitFor: (customerId: string) => `/clients/visite?client=${encodeURIComponent(customerId)}`,
  customerPattern: '/clients/:customerId',
  customer: (customerId: string) => `/clients/${customerId}`,
  interactionPattern: '/clients/:customerId/echange',
  interaction: (customerId: string) => `/clients/${customerId}/echange`,
  loss: '/stock/perte',
  receive: '/stock/receptions',
  receivePattern: '/stock/receptions/:transferId',
  blindReceipt: '/stock/receptions/sans-document',
  receiveOne: (transferId: string) => `/stock/receptions/${transferId}`,
  count: '/stock/inventaire',
  consumption: '/stock/consommation',
  transfer: '/stock/transferts',
  transferPattern: '/stock/transferts/:transferId',
  transferOne: (transferId: string) => `/stock/transferts/${transferId}`,
  /** Encaissement d'un client ; avec une vente, son reste dû est prérempli et lui est affecté (MP-09). */
  collectFor: (customerId: string, saleId?: string) =>
    `/encaisser?client=${encodeURIComponent(customerId)}` +
    (saleId ? `&vente=${encodeURIComponent(saleId)}` : ''),
  cash: '/caisse',
  cashTransfers: '/caisse/remises',
  treasury: '/finance/tresorerie',
  /** ECR-FIN-02 (P8E-03) : saisie et mes dépenses ; suivi en ligne avec `?vue=suivi`. */
  expenses: '/finance/depenses',
  /** ECR-FIN-03 (P8E-05) : dettes, factures fournisseurs, saisie rapprochée. */
  supplierInvoices: '/finance/factures',
  /** ECR-FIN-04 (P8E-06) : paiements fournisseurs, avances, saisie. */
  supplierPayments: '/finance/paiements',
  /** ECR-FIN-06 (P8E-08) : coûts et marges (période, pertes, lots). */
  costsMargins: '/finance/couts-et-marges',
  /** ECR-FIN-01 (P8E-09) : créances par client ou par titulaire, ancienneté. */
  receivables: '/finance/creances',
  replenish: '/pdv/reapprovisionnement',
  distribution: '/pdv/distribution',
  posHome: '/pdv',
  allocations: '/stock/quotas',
  /** ECR-STK-09 (AV-526) : seuils d'alerte et cibles de réapprovisionnement par emplacement (`inventory.threshold.manage`). */
  thresholds: '/stock/seuils',
  devices: '/administration/appareils',
  approvals: '/validations',
  users: '/administration/utilisateurs',
  /** ECR-ADM-06 (RP-1) : sites, emplacements, zones et géorepères, équipes, points de vente. */
  organization: '/administration/organisation',
  /** ECR-ADM-07 (RP-1) : paramètres versionnés et politiques de contrôle. */
  settings: '/administration/parametres',
  /** ECR-AUD-01 (RP-1) : recherche dans le journal d'audit. */
  audit: '/administration/audit',
  /** ECR-CRM-06 (RP-3) : réaffectation de clients (`crm.customer.reassign`). */
  reassignCustomers: '/clients/reaffecter',
  /** ECR-TER-02 (RP-3) : présences et activité de l'équipe (`fieldwork.session.read`). */
  teamActivity: '/equipe/activite',
  /** ECR-SYN-02 (RP-3) : supervision de la synchronisation (`sync.monitor.read`). */
  syncMonitor: '/synchronisation/supervision',
  /** ECR-SYN-03 (RP-3) : file et résolution des conflits (`sync.conflict.resolve`). */
  syncConflicts: '/synchronisation/conflits',
  /** ECR-NOT-01 (RP-4) : centre d'alertes et de notifications, règles d'alerte. */
  alerts: '/alertes',
  /** ECR-NOT-02 (RP-4) : lecture et accusé des notes de direction. */
  notes: '/notes',
  /** ECR-NOT-03 (RP-4) : publication et suivi des notes de direction (`comm.note.publish`). */
  notesPublish: '/notes/publication',
  /** ECR-ANA-01 (RP-4) : tour de contrôle Direction (`analytics.dashboard.direction`). */
  analyticsDirection: '/pilotage/direction',
  /** ECR-ANA-02 (RP-4) : tableau de bord Commercial (`analytics.dashboard.commercial`). */
  analyticsCommercial: '/pilotage/commercial',
  /** ECR-ANA-03 (RP-4) : tableau de bord Stock & Magasin (`analytics.dashboard.stock`). */
  analyticsStock: '/pilotage/stock',
  /** ECR-ANA-04 (RP-4) : tableau de bord Production (`analytics.dashboard.production`). */
  analyticsProduction: '/pilotage/production',
  /** ECR-ANA-05 (RP-4) : tableau de bord Finance & Trésorerie (`analytics.dashboard.finance`). */
  analyticsFinance: '/pilotage/finance',
  /** ECR-ANA-06 (RP-4) : explorateur analytique, vues sauvegardées & exports (`analytics.explore`). */
  analyticsExplorer: '/pilotage/explorateur',
  /** ECR-PIE-01 (PP-B) : report de pièces papier & registre des carnets (AV-308, AV-312). */
  paperSlipReport: '/pieces/report',
  /** ECR-IMP-01 (RP-2, PP-C) : chargement de données par fichier CSV (AV-072, AV-508). */
  dataImport: '/chargement',
  /** ECR-TER-03 (PP-E) : présence du personnel, report de la fiche PT (AV-313). */
  presence: '/presence',
  /** ECR-CRM-08 (PP-E) : bilan hebdomadaire du commercial et vu du responsable (AV-314). */
  weeklyReport: '/bilan-hebdomadaire',
  /** ECR-HLP-01 (AV-525, ADR-058) : guide de l'application ; chaque page a en plus son aide (bouton « ? »). */
  help: '/aide',
} as const;

/** Rôles qui vendent (`sales.sale.record`, 07-security-rbac/01-rbac.md). */
const SELLER_ROLES = [
  'RESP_COMMERCIAL',
  'COMMERCIAL_TERRAIN',
  'COMMERCIAL_SEDENTAIRE',
  'VENDEUR_PDV',
  'RESP_FERME',
];
/** Rôles qui lisent les ventes (`sales.sale.read`). */
const SALE_READER_ROLES = [...SELLER_ROLES, 'DIRECTION', 'SUPERVISION', 'FINANCE'];

/**
 * Rôles par permission de vente (07-security-rbac/01-rbac.md) : ils décident des écrans et des
 * actions proposés, jamais de l'autorisation, que le serveur revérifie.
 */
export const ROLE_SETS = {
  saleRecord: SELLER_ROLES,
  saleRead: SALE_READER_ROLES,
  orderRead: [
    'DIRECTION',
    'SUPERVISION',
    'RESP_COMMERCIAL',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
    'VENDEUR_PDV',
    'MAGASINIER',
    'FINANCE',
  ],
  /** `sales.price.override` (plafonds RC-06) : le vendeur de PDV n'y a pas droit. */
  priceOverride: [
    'DIRECTION',
    'RESP_COMMERCIAL',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
    'RESP_FERME',
  ],
  orderCreate: ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE'],
  orderCancel: ['DIRECTION', 'RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE'],
  orderFulfil: [
    'RESP_COMMERCIAL',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
    'VENDEUR_PDV',
    'MAGASINIER',
  ],
  /** `crm.customer.create` (01-rbac.md) : commerciaux, vendeur de PDV, responsable de ferme. */
  customerCreate: [
    'RESP_COMMERCIAL',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
    'VENDEUR_PDV',
    'RESP_FERME',
  ],
  /** `crm.customer.update` (01-rbac.md) : responsable commercial (équipe), commerciaux (leurs comptes), vendeur de PDV (site). */
  customerUpdate: ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE', 'VENDEUR_PDV'],
  /** `crm.customer.read` (01-rbac.md) : tous les rôles qui suivent des clients. */
  customerRead: [
    'DIRECTION',
    'SUPERVISION',
    'RESP_COMMERCIAL',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
    'VENDEUR_PDV',
    'RESP_FERME',
    'FINANCE',
  ],
  /** ECR-CRM-05 : commerciaux (`crm.target.read`, 03-parcours-et-ecrans.md §3). */
  performance: ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE'],
  /** ECR-CRM-07 (`crm.target.manage` : direction ALL, responsable commercial TEAM). */
  targets: ['RESP_COMMERCIAL', 'DIRECTION'],
  /** ECR-CRM-06 (`crm.customer.reassign` : responsable commercial TEAM, direction ALL). */
  reassignCustomers: ['RESP_COMMERCIAL', 'DIRECTION'],
  /** ECR-TER-02 (`fieldwork.session.read`, `crm.visit.read` : responsable commercial TEAM, direction et supervision ALL). */
  teamActivity: ['RESP_COMMERCIAL', 'DIRECTION', 'SUPERVISION'],
  /** ECR-CRM-01 : commerciaux et responsable commercial (03-parcours-et-ecrans.md §3). */
  portfolio: ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE'],
  /** ECR-PRX-02 : rédaction (`pricing.rule.draft`) ; activation et fin par la Direction (AV-062). */
  priceRules: ['RESP_COMMERCIAL', 'DIRECTION'],
  /** ECR-PRX-01 : `catalog.product.manage`, `catalog.reference.manage` (01-rbac.md) : administrateur. */
  catalog: ['ADMIN'],
  /** ECR-PRX-03 : responsable commercial, direction et supervision (03-parcours-et-ecrans.md §3.2). */
  priceSimulator: ['RESP_COMMERCIAL', 'DIRECTION', 'SUPERVISION'],
  /** `fieldwork.checkin.perform` (01-rbac.md) : commercial terrain et responsable commercial. */
  fieldwork: ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN'],
  /** `crm.interaction.record` (01-rbac.md) : commerciaux et responsable commercial. */
  interactionRecord: ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE'],
  /** `crm.visit.record` (01-rbac.md) : commercial terrain et responsable commercial. */
  visitRecord: ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN'],
  /**
   * `inventory.loss.declare` : détenteurs de stock. L'Administrateur exerce la ferme et le stock depuis
   * le 06/11/2026 (AV-524, ADR-057) : il figure dans chaque jeu de rôles d'un écran de la ferme et du
   * stock, comme le responsable de production pour les réceptions, les transferts et les inventaires.
   */
  lossDeclare: [
    'COMMERCIAL_TERRAIN',
    'VENDEUR_PDV',
    'RESP_PRODUCTION',
    'RESP_FERME',
    'MAGASINIER',
    'ADMIN',
  ],
  /** ECR-PRD-01 et 02 (`production.daily.record`, jeu `production` des fermes) : production, ferme, administrateur. */
  production: ['RESP_PRODUCTION', 'RESP_FERME', 'ADMIN'],
  /**
   * ECR-PRD-07 (`inventory.transfer.dispatch` SITE pour la ferme, ALL pour la production et l'Admin) :
   * responsable de ferme ; le responsable de production et l'Admin y déclarent en plus le lot prêt à la vente.
   */
  productionOutput: ['RESP_FERME', 'RESP_PRODUCTION', 'ADMIN'],
  /**
   * ECR-PRD-04 (`production.lot.manage`, responsable de production et Admin ; l'entrée relève aussi de
   * `production.daily.record`, mais l'inventaire des écrans réserve l'écran à la production).
   */
  lotSetup: ['RESP_PRODUCTION', 'ADMIN'],
  /** ECR-PRD-06 (`production.incubation.record` : production et Admin ALL, ferme SITE). */
  incubation: ['RESP_FERME', 'RESP_PRODUCTION', 'ADMIN'],
  /** ECR-PRD-03 : responsable de production, direction, supervision et Admin (03-parcours-et-ecrans.md, AV-524, AV-529). */
  lotSheet: ['RESP_PRODUCTION', 'DIRECTION', 'SUPERVISION', 'ADMIN'],
  /** ECR-APP-02 (`procurement.request.create`, 01-rbac.md) : tous les demandeurs et les achats. */
  purchaseRequest: [
    'DIRECTION',
    'RESP_PRODUCTION',
    'RESP_FERME',
    'MAGASINIER',
    'RESP_ACHATS',
    'FINANCE',
    'ADMIN',
  ],
  /**
   * ECR-APP-04 (`procurement.receipt.record`, BC servis par site) : magasinier, responsable de ferme ;
   * le responsable de production et l'Admin y sont aussi (droit `ALL`) : c'est par la réception que les
   * animaux et l'aliment d'un lot entrent à la ferme.
   */
  purchaseReceipt: ['MAGASINIER', 'RESP_FERME', 'RESP_PRODUCTION', 'ADMIN'],
  /** ECR-APP-01 (`procurement.supplier.manage`, 01-rbac.md) : responsable des achats. */
  suppliers: ['RESP_ACHATS'],
  /** ECR-APP-03 (`procurement.order.manage`, 01-rbac.md) : responsable des achats. */
  purchaseOrders: ['RESP_ACHATS'],
  /**
   * ECR-APP-05 (`procurement.order.read`, valeurs et payé selon les droits) : Resp. achats et Finance
   * (inventaire, UC-APP-12), Direction et Supervision en lecture (AV-302, AV-529).
   */
  orderMatching: ['RESP_ACHATS', 'FINANCE', 'DIRECTION', 'SUPERVISION'],
  /**
   * ECR-STK-08 (`inventory.consumption.record`, 01-rbac.md) : magasinier, responsable de ferme, et les
   * autres détenteurs de la permission, vendeur de PDV (emballages, UC-STK-10) et responsable de
   * production ; l'inventaire des écrans (03-parcours-et-ecrans.md) ne cite que les deux premiers.
   */
  consumptionRecord: ['MAGASINIER', 'RESP_FERME', 'VENDEUR_PDV', 'RESP_PRODUCTION', 'ADMIN'],
  /**
   * ECR-STK-05 (`inventory.count.perform`) : magasinier, vendeur de PDV, responsable de ferme, et le
   * responsable de production et l'Admin (droit `ALL`, AV-524).
   */
  countPerform: ['MAGASINIER', 'VENDEUR_PDV', 'RESP_FERME', 'RESP_PRODUCTION', 'ADMIN'],
  /**
   * ECR-STK-07 (`inventory.ledger.read`, 01-rbac.md) : « responsables, direction » de l'inventaire des
   * écrans, magasinier compris (WF-J3 étape 5), supervision et finance ; pas les vendeurs ni les commerciaux.
   * L'Admin le lit depuis AV-524.
   */
  stockLedger: [
    'DIRECTION',
    'SUPERVISION',
    'RESP_COMMERCIAL',
    'RESP_PRODUCTION',
    'RESP_FERME',
    'MAGASINIER',
    'FINANCE',
    'ADMIN',
  ],
  /**
   * ECR-STK-02 (`inventory.transfer.dispatch`) : magasinier et responsable de ferme ; le responsable de
   * production et l'Admin ont le droit en portée `ALL` (AV-524).
   */
  transferDispatch: ['MAGASINIER', 'RESP_FERME', 'RESP_PRODUCTION', 'ADMIN'],
  /** `inventory.transfer.receive` : destinataires de transferts. */
  transferReceive: [
    'COMMERCIAL_TERRAIN',
    'VENDEUR_PDV',
    'RESP_PRODUCTION',
    'RESP_FERME',
    'MAGASINIER',
    'ADMIN',
  ],
  /** `inventory.stock.read` : tous les rôles, l'administrateur compris depuis AV-524. */
  stockRead: [
    'DIRECTION',
    'SUPERVISION',
    'RESP_COMMERCIAL',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
    'VENDEUR_PDV',
    'RESP_PRODUCTION',
    'RESP_FERME',
    'MAGASINIER',
    'RESP_ACHATS',
    'FINANCE',
    'ADMIN',
  ],
  paymentRecord: [
    'RESP_COMMERCIAL',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
    'VENDEUR_PDV',
    'RESP_FERME',
    'FINANCE',
  ],
  /** `finance.cash_session.operate` (VEN SITE, FIN ALL) : ouverture et clôture de la caisse du PDV. */
  cashSessionOperate: ['VENDEUR_PDV', 'FINANCE'],
  /** ECR-DIS-03 : demande de réapprovisionnement du PDV (`inventory.transfer.request`, VEN SITE). */
  replenishRequest: ['VENDEUR_PDV'],
  /** ECR-DIS-01 : accueil du PDV (vendeur du PDV). */
  posHome: ['VENDEUR_PDV'],
  /** `inventory.allocation.release` (CTE, VEN) : libération d'un quota par son détenteur. */
  allocationRelease: ['COMMERCIAL_TERRAIN', 'VENDEUR_PDV'],
  /**
   * `finance.cash_transfer.record` (RCO, CTE, CSE OWN ; VEN SITE ; RFE OWN ; FIN ALL) : remises de
   * fonds, envoi, réception et annulation (UC-FIN-07, AV-239).
   */
  cashTransferRecord: [
    'RESP_COMMERCIAL',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
    'VENDEUR_PDV',
    'RESP_FERME',
    'FINANCE',
  ],
  /**
   * ECR-FIN-05 : `finance.cash.read` ALL et `finance.cash_session.validate` (FIN, DIR) ; la Direction
   * valide et décide, sans recevoir (`finance.cash_transfer.record`) (AV-241).
   */
  treasury: ['FINANCE', 'DIRECTION'],
  /**
   * ECR-FIN-02 (P8E-03, AV-298) : `finance.expense.record` (DIR, RPR, ACH, FIN ALL ; RCO, CTE, CSE, MAG
   * OWN ; VEN, RFE SITE ; jamais l'Admin) : saisie hors ligne et « mes dépenses ».
   */
  expenseRecord: [
    'DIRECTION',
    'RESP_COMMERCIAL',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
    'VENDEUR_PDV',
    'RESP_PRODUCTION',
    'RESP_FERME',
    'MAGASINIER',
    'RESP_ACHATS',
    'FINANCE',
  ],
  /**
   * Suivi des dépenses : `finance.expense.read` au-delà de ses propres dépenses (DIR, RPR, ACH, FIN
   * ALL ; RCO TEAM ; VEN, RFE SITE).
   */
  expenseFollow: [
    'DIRECTION',
    'RESP_PRODUCTION',
    'RESP_ACHATS',
    'FINANCE',
    'RESP_COMMERCIAL',
    'VENDEUR_PDV',
    'RESP_FERME',
  ],
  /** `finance.expense.pay` (FIN) : payer une dépense à payer, en ligne. */
  expensePay: ['FINANCE'],
  /** `finance.expense.approve` (DIR, FIN, RPR) : annuler la dépense d'un autre (SM-EXPENSE). */
  expenseApprove: ['DIRECTION', 'FINANCE', 'RESP_PRODUCTION'],
  /**
   * `finance.supplier_payment.approve` (DIR) : décider d'un paiement fournisseur au-delà du seuil, dans
   * la file des validations (ADR-043, P8E-04).
   */
  supplierPaymentApprove: ['DIRECTION'],
  /** ECR-FIN-03 : `finance.payable.read` (DIR, SUP, ACH, FIN ; ALL, AV-278, AV-529) : dettes et factures (AV-298). */
  payableRead: ['DIRECTION', 'SUPERVISION', 'RESP_ACHATS', 'FINANCE'],
  /** `finance.supplier_invoice.record` (FIN) : saisie d'une facture fournisseur. */
  supplierInvoiceRecord: ['FINANCE'],
  /**
   * `finance.supplier_invoice.approve` (DIR, FIN) : contester, approuver (jamais sa propre facture) ou
   * annuler une facture (ADR-043 §5).
   */
  supplierInvoiceApprove: ['DIRECTION', 'FINANCE'],
  /**
   * ECR-FIN-06 : vue d'ensemble (`finance.payable.read`), pertes, coûts et marges des lots
   * (`inventory.valuation.read`) ; Finance, Direction et Supervision (inventaire, AV-303, AV-529).
   */
  costsMargins: ['FINANCE', 'DIRECTION', 'SUPERVISION'],
  /**
   * ECR-FIN-01 : `sales.receivable.read` (FIN ALL, DIR ALL, SUP ALL, RCO TEAM) ; inventaire, Direction
   * et Supervision (AV-304, AV-529). Les autres détenteurs du droit voient les créances de leurs clients à l'encaissement.
   */
  receivables: ['FINANCE', 'DIRECTION', 'SUPERVISION', 'RESP_COMMERCIAL'],
  /** `finance.supplier_payment.record` (FIN) : saisir un paiement, affecter une avance (ECR-FIN-04). */
  supplierPaymentRecord: ['FINANCE'],
  /**
   * ECR-STK-09 (AV-526) : `inventory.threshold.manage` (DIR et ADM ALL, RPR ALL, RCO ZONE, RFE et MAG SITE) : le minimum
   * d'alerte et la cible de réapprovisionnement d'un produit sur un emplacement.
   */
  thresholdManage: [
    'DIRECTION',
    'RESP_COMMERCIAL',
    'RESP_PRODUCTION',
    'RESP_FERME',
    'MAGASINIER',
    'ADMIN',
  ],
  /** ECR-STK-06 : `inventory.allocation.manage` (DIR, RCO ZONE, RFE SITE, MAG SITE, ADM ALL depuis AV-524). */
  allocationManage: ['DIRECTION', 'RESP_COMMERCIAL', 'RESP_FERME', 'MAGASINIER', 'ADMIN'],
  /** ECR-DIS-04 : `analytics.dashboard.distribution` (DIR, SUP, RCO ZONE, VEN SITE, MAG SITE, FIN). */
  distributionDashboard: [
    'DIRECTION',
    'SUPERVISION',
    'RESP_COMMERCIAL',
    'VENDEUR_PDV',
    'MAGASINIER',
    'FINANCE',
  ],
  /**
   * ECR-ADM-05 : `identity.device.read` (DIR ALL, ADM ALL, RCO TEAM, RPR SITE depuis AV-261, RFE SITE,
   * MAG SITE). Les actions de chaque appareil viennent du serveur (`actions`, BR-ADM-025).
   */
  deviceRead: [
    'DIRECTION',
    'ADMIN',
    'RESP_COMMERCIAL',
    'RESP_PRODUCTION',
    'RESP_FERME',
    'MAGASINIER',
  ],
  /**
   * ECR-ADM-08 : rôles qui détiennent `approvals.request.read` et au moins une permission d'approbation
   * d'une politique (DIR, FIN, RCO, RPR, RFE, MAG, RAC) ; le serveur ne rend que les demandes que chacun
   * peut décider. L'Admin n'approuve aucune opération métier (RC-03).
   */
  /**
   * ECR-ADM-04 partiel (MP-08) : liste des comptes et réinitialisation du mot de passe, pour l'Admin
   * (`identity.user.manage`) ; la lecture `GET /users` sert aussi d'autres rôles, sans menu pour eux.
   */
  userManage: ['ADMIN'],
  /**
   * ECR-ADM-06 (RP-1) : `org.structure.manage` (ADM seul, 01-rbac.md §5.1) ; la Direction lit la structure
   * mais ne la modifie pas, l'inventaire des écrans réserve celui-ci à l'Admin.
   */
  organizationManage: ['ADMIN'],
  /** ECR-ADM-07 (RP-1) : `org.settings.manage` et `approvals.policy.manage` (DIR et ADM, portée ALL). */
  settingsManage: ['DIRECTION', 'ADMIN'],
  /**
   * ECR-AUD-01 (RP-1) : `audit.log.read` (DIR, SUP, ADM, FIN). La Finance n'y voit que les entités financières :
   * le serveur borne la lecture (AV-493).
   */
  auditRead: ['DIRECTION', 'SUPERVISION', 'ADMIN', 'FINANCE'],
  /** ECR-SYN-02 (RP-3) : `sync.monitor.read` (ADM, DIR et SUP, portée ALL). */
  syncMonitor: ['ADMIN', 'DIRECTION', 'SUPERVISION'],
  /**
   * ECR-SYN-03 (RP-3) : `sync.conflict.resolve` (DIR, ADM, FIN, RCO, RPR, RFE, MAG, RAC — rôles propriétaires
   * de la matrice des conflits, 03-matrice-conflits.md).
   */
  syncConflicts: [
    'DIRECTION',
    'ADMIN',
    'FINANCE',
    'RESP_COMMERCIAL',
    'RESP_PRODUCTION',
    'RESP_FERME',
    'MAGASINIER',
    'RESP_ACHATS',
  ],
  approvals: [
    'DIRECTION',
    'FINANCE',
    'RESP_COMMERCIAL',
    'RESP_PRODUCTION',
    'RESP_FERME',
    'MAGASINIER',
    'RESP_ACHATS',
  ],
  /** ECR-NOT-03 (RP-4) : `comm.note.publish` (DIR). */
  notesPublish: ['DIRECTION'],
  /** ECR-ANA-01 (RP-4) : `analytics.dashboard.direction` (DIR, SUP). */
  analyticsDirection: ['DIRECTION', 'SUPERVISION'],
  /** ECR-ANA-02 (RP-4) : `analytics.dashboard.commercial` (RCO, DIR, SUP, FIN, CTE, CSE). */
  analyticsCommercial: [
    'RESP_COMMERCIAL',
    'DIRECTION',
    'SUPERVISION',
    'FINANCE',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
  ],
  /** ECR-ANA-03 (RP-4) : `analytics.dashboard.stock` (MAG, DIR, SUP, RPR, RFE, RAC, FIN, ADM depuis AV-524). */
  analyticsStock: [
    'MAGASINIER',
    'DIRECTION',
    'SUPERVISION',
    'RESP_PRODUCTION',
    'RESP_FERME',
    'RESP_ACHATS',
    'FINANCE',
    'ADMIN',
  ],
  /** ECR-ANA-04 (RP-4) : `analytics.dashboard.production` (RPR, RFE, DIR, SUP, FIN, ADM depuis AV-524). */
  analyticsProduction: ['RESP_PRODUCTION', 'RESP_FERME', 'DIRECTION', 'SUPERVISION', 'FINANCE', 'ADMIN'],
  /** ECR-ANA-05 (RP-4) : `analytics.dashboard.finance` (FIN, DIR, SUP). */
  analyticsFinance: ['FINANCE', 'DIRECTION', 'SUPERVISION'],
  /** ECR-ANA-06 (RP-4) : `analytics.explore` (DIR, SUP, RCO, RPR, RAC, FIN). */
  analyticsExplorer: [
    'DIRECTION',
    'SUPERVISION',
    'RESP_COMMERCIAL',
    'RESP_PRODUCTION',
    'RESP_ACHATS',
    'FINANCE',
  ],
  /** ECR-PIE-01 (PP-B) : report de pièces papier & registre des carnets (AV-308, AV-312). */
  paperSlipReport: [
    'RESP_COMMERCIAL',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
    'VENDEUR_PDV',
    'MAGASINIER',
    'RESP_FERME',
    'RESP_PRODUCTION',
    'RESP_ACHATS',
    'FINANCE',
    'ADMIN',
    'DIRECTION',
  ],
  /**
   * ECR-IMP-01 (RP-2, PP-C) : à qui le menu propose le chargement de données — ceux qui gèrent les données de référence
   * et l'historique : administrateur (catalogue), responsable commercial (clients, pièces), finance et direction
   * (pièces). Ce n'est pas l'autorisation : la route reste ouverte à tout rôle qui peut charger un type (fournisseurs :
   * responsable des achats ; clients : commerciaux, vendeur de PDV, responsable de ferme), l'écran ne propose à chacun que
   * les types de ses droits (`ImportEntity.roles`) et le serveur revérifie chaque commande. Le menu ne s'allonge pas pour
   * les autres : au-delà de 17 entrées il ne déplie plus tous les domaines (UX-01, `EXPAND_ALL_UNTIL`).
   */
  dataImport: ['ADMIN', 'RESP_COMMERCIAL', 'FINANCE', 'DIRECTION'],
  /** ECR-TER-03 (PP-E) : `fieldwork.presence.record` et `.read` (Direction et Admin partout, responsables de site sur leur site). */
  presence: ['ADMIN', 'DIRECTION', 'RESP_PRODUCTION', 'RESP_FERME'],
  /**
   * ECR-CRM-08 (PP-E) : `crm.weekly_report.submit` (commerciaux, pour soi), `.read` et `.review` (responsable commercial
   * pour son équipe, Direction pour tous).
   */
  weeklyReport: ['COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE', 'RESP_COMMERCIAL', 'DIRECTION'],
} as const satisfies Record<string, readonly string[]>;

/** Rôles inconnus de l'appareil (accueil jamais ouvert en ligne) : l'action reste proposée. */
export function holdsAnyRole(held: readonly string[], allowed: readonly string[]): boolean {
  return held.length === 0 || held.some((role) => allowed.includes(role));
}

export type ScreenGroup =
  'general' | 'sales' | 'stock' | 'crm' | 'procurement' | 'production' | 'finance';

export interface ScreenEntry {
  /** Identifiant de l'inventaire des écrans (`ECR-…`), ou code interne pour un écran transverse. */
  readonly id: string;
  readonly path: string;
  /** Clé i18n du libellé (`nav.screens.<labelKey>`). */
  readonly labelKey: string;
  readonly group: ScreenGroup;
  /** Rôles à qui l'écran est proposé ; `ALL` : tout utilisateur. */
  readonly roles: readonly string[] | 'ALL';
  /** Codes d'actions de l'accueil qui mènent à cet écran. */
  readonly actionCodes: readonly string[];
  /** Paramètres ajoutés à la route pour une action donnée (ex. filtre des alertes). */
  readonly actionQuery?: Readonly<Record<string, string>>;
  /** Utilisable sans réseau (colonne « hors ligne » de l'inventaire). */
  readonly offline: boolean;
  /** Codes des signaux de l'accueil qui mènent à cet écran (à défaut d'une route du serveur). */
  readonly signalCodes?: readonly string[];
  /** Paramètres ajoutés à la route pour un signal donné (ex. ventes signalées seules). */
  readonly signalQuery?: Readonly<Record<string, string>>;
}

export const SCREENS: readonly ScreenEntry[] = [
  {
    id: 'ECR-ADM-03',
    path: ROUTES.home,
    labelKey: 'home',
    group: 'general',
    roles: 'ALL',
    actionCodes: [],
    offline: false,
  },
  {
    id: 'ECR-SYN-01',
    path: ROUTES.sync,
    labelKey: 'sync',
    group: 'general',
    roles: 'ALL',
    actionCodes: ['SYNC_STATUS'],
    offline: true,
  },
  {
    id: 'ECR-SYN-02',
    path: ROUTES.syncMonitor,
    labelKey: 'sync_monitor',
    group: 'general',
    roles: ROLE_SETS.syncMonitor,
    actionCodes: [],
    signalCodes: ['DEVICES_STALE'],
    signalQuery: { DEVICES_STALE: '?filtre=STALE' },
    offline: false,
  },
  {
    id: 'ECR-SYN-03',
    path: ROUTES.syncConflicts,
    labelKey: 'sync_conflicts',
    group: 'general',
    roles: ROLE_SETS.syncConflicts,
    actionCodes: [],
    signalCodes: ['SYNC_CONFLICTS'],
    offline: false,
  },
  {
    id: 'ECR-VEN-01',
    path: ROUTES.newSale,
    labelKey: 'new_sale',
    group: 'sales',
    roles: SELLER_ROLES,
    actionCodes: ['NEW_SALE'],
    offline: true,
  },
  {
    id: 'ECR-VEN-02',
    path: ROUTES.newOrder,
    labelKey: 'new_order',
    group: 'sales',
    roles: ROLE_SETS.orderCreate,
    actionCodes: ['NEW_ORDER'],
    offline: true,
  },
  {
    id: 'ECR-VEN-03',
    path: ROUTES.orders,
    labelKey: 'orders',
    group: 'sales',
    roles: ROLE_SETS.orderRead,
    actionCodes: ['FOLLOW_DELIVERIES'],
    offline: true,
  },
  {
    id: 'ECR-VEN-06',
    path: ROUTES.collect,
    labelKey: 'collect',
    group: 'sales',
    roles: ROLE_SETS.paymentRecord,
    // « Encaissements » de la Finance : virements et règlements reçus au siège (01-rbac.md).
    actionCodes: ['PAYMENTS'],
    offline: true,
  },
  {
    id: 'ECR-CRM-01',
    path: ROUTES.portfolio,
    labelKey: 'portfolio',
    group: 'crm',
    roles: ROLE_SETS.portfolio,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-CRM-05',
    path: ROUTES.performance,
    labelKey: 'performance',
    group: 'crm',
    roles: ROLE_SETS.performance,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-CRM-02',
    path: ROUTES.newProspect,
    labelKey: 'new_prospect',
    group: 'crm',
    roles: ROLE_SETS.customerCreate,
    actionCodes: ['NEW_PROSPECT'],
    offline: true,
  },
  {
    id: 'ECR-CRM-07',
    path: ROUTES.targets,
    labelKey: 'targets',
    group: 'crm',
    roles: ROLE_SETS.targets,
    actionCodes: ['TARGETS'],
    offline: false,
  },
  {
    id: 'ECR-CRM-06',
    path: ROUTES.reassignCustomers,
    labelKey: 'reassign_customers',
    group: 'crm',
    roles: ROLE_SETS.reassignCustomers,
    actionCodes: ['REASSIGN'],
    offline: false,
  },
  {
    id: 'ECR-TER-02',
    path: ROUTES.teamActivity,
    labelKey: 'team_activity',
    group: 'crm',
    roles: ROLE_SETS.teamActivity,
    actionCodes: ['TEAM'],
    offline: false,
  },
  {
    id: 'ECR-TER-01',
    path: ROUTES.service,
    labelKey: 'service',
    group: 'crm',
    roles: ROLE_SETS.fieldwork,
    actionCodes: ['START_SERVICE'],
    // MP-09 (constat C10) : le signal « Vous n'avez pas pris service » mène à la prise de service.
    signalCodes: ['SERVICE_NOT_STARTED'],
    offline: true,
  },
  {
    id: 'ECR-CRM-04',
    path: ROUTES.newVisit,
    labelKey: 'new_visit',
    group: 'crm',
    roles: ROLE_SETS.visitRecord,
    actionCodes: ['NEW_VISIT'],
    offline: true,
  },
  {
    id: 'ECR-STK-01',
    path: ROUTES.stock,
    labelKey: 'stock',
    group: 'stock',
    roles: ROLE_SETS.stockRead,
    // « Alertes de stock » du magasinier : l'écran s'ouvre sur les produits sous le seuil.
    actionCodes: ['STOCK_ALERTS'],
    actionQuery: { STOCK_ALERTS: '?alertes=1' },
    offline: true,
  },
  {
    id: 'ECR-STK-02',
    path: ROUTES.transfer,
    labelKey: 'transfer',
    group: 'stock',
    roles: ROLE_SETS.transferDispatch,
    actionCodes: ['TRANSFER'],
    offline: true,
  },
  {
    id: 'ECR-STK-03',
    path: ROUTES.receive,
    labelKey: 'receive',
    group: 'stock',
    roles: ROLE_SETS.transferReceive,
    actionCodes: ['RECEIVE_TRANSFER'],
    offline: true,
  },
  {
    id: 'ECR-STK-04',
    path: ROUTES.loss,
    labelKey: 'loss',
    group: 'stock',
    roles: ROLE_SETS.lossDeclare,
    actionCodes: ['LOSS'],
    offline: true,
  },
  {
    id: 'ECR-STK-05',
    path: ROUTES.count,
    labelKey: 'count',
    group: 'stock',
    roles: ROLE_SETS.countPerform,
    actionCodes: ['COUNT'],
    offline: true,
  },
  {
    id: 'ECR-STK-07',
    path: ROUTES.stockLedger,
    labelKey: 'stock_ledger',
    group: 'stock',
    roles: ROLE_SETS.stockLedger,
    actionCodes: [],
    offline: false,
  },
  {
    id: 'ECR-STK-08',
    path: ROUTES.consumption,
    labelKey: 'consumption',
    group: 'stock',
    roles: ROLE_SETS.consumptionRecord,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-PRX-02',
    path: ROUTES.priceRules,
    labelKey: 'price_rules',
    group: 'sales',
    roles: ROLE_SETS.priceRules,
    // « Tarifs » de la Direction : activer les règles de prix.
    actionCodes: ['PRICES'],
    offline: false,
  },
  {
    id: 'ECR-PRX-03',
    path: ROUTES.priceSimulator,
    labelKey: 'price_simulator',
    group: 'sales',
    roles: ROLE_SETS.priceSimulator,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-PRX-01',
    path: ROUTES.catalog,
    labelKey: 'catalog',
    group: 'general',
    roles: ROLE_SETS.catalog,
    // Aucune action de l'accueil de l'administrateur n'y mène encore (S-26) : menu seulement.
    actionCodes: [],
    offline: false,
  },
  {
    // MP-06 : appareils de la portée (BR-ADM-025), décisions en ligne.
    id: 'ECR-ADM-05',
    path: ROUTES.devices,
    labelKey: 'devices',
    group: 'general',
    roles: ROLE_SETS.deviceRead,
    actionCodes: ['DEVICES'],
    signalCodes: ['DEVICES_PENDING'],
    offline: false,
  },
  {
    // MP-07 : file de validation unifiée (UX-08), décisions en ligne ; « Valider les mortalités » et
    // « Valider les remises » ouvrent la file filtrée par type.
    id: 'ECR-ADM-08',
    path: ROUTES.approvals,
    labelKey: 'approvals',
    group: 'general',
    roles: ROLE_SETS.approvals,
    actionCodes: ['VALIDATIONS', 'MORTALITY', 'DISCOUNTS'],
    actionQuery: {
      MORTALITY: '?types=MORTALITY,ANIMAL_COUNT_ADJUSTMENT',
      DISCOUNTS: '?types=PRICE_OVERRIDE',
    },
    signalCodes: ['APPROVALS_PENDING'],
    offline: false,
  },
  {
    // MP-08 : ECR-ADM-04 partiel — comptes et réinitialisation du mot de passe (AV-252).
    id: 'ECR-ADM-04',
    path: ROUTES.users,
    labelKey: 'users',
    group: 'general',
    roles: ROLE_SETS.userManage,
    actionCodes: ['USERS'],
    offline: false,
  },
  {
    // RP-1 : organisation (sites, emplacements, zones, équipes, points de vente), commandes `organization.*`.
    id: 'ECR-ADM-06',
    path: ROUTES.organization,
    labelKey: 'organization',
    group: 'general',
    roles: ROLE_SETS.organizationManage,
    actionCodes: [],
    offline: false,
  },
  {
    // RP-1 : paramètres système versionnés et politiques de contrôle.
    id: 'ECR-ADM-07',
    path: ROUTES.settings,
    labelKey: 'settings',
    group: 'general',
    roles: ROLE_SETS.settingsManage,
    actionCodes: [],
    offline: false,
  },
  {
    // RP-1 : journal d'audit (recherche), lecture seule.
    id: 'ECR-AUD-01',
    path: ROUTES.audit,
    labelKey: 'audit',
    group: 'general',
    roles: ROLE_SETS.auditRead,
    actionCodes: [],
    offline: false,
  },
  {
    id: 'ECR-APP-02',
    path: ROUTES.purchaseRequests,
    labelKey: 'purchase_request',
    group: 'procurement',
    roles: ROLE_SETS.purchaseRequest,
    // « Demandes d'achat » du responsable des achats.
    actionCodes: ['REQUESTS'],
    offline: true,
  },
  {
    id: 'ECR-APP-01',
    path: ROUTES.suppliers,
    labelKey: 'suppliers',
    group: 'procurement',
    roles: ROLE_SETS.suppliers,
    actionCodes: ['SUPPLIERS'],
    offline: false,
  },
  {
    id: 'ECR-APP-03',
    path: ROUTES.purchaseOrders,
    labelKey: 'purchase_orders',
    group: 'procurement',
    roles: ROLE_SETS.purchaseOrders,
    actionCodes: ['ORDERS'],
    offline: false,
  },
  {
    id: 'ECR-APP-04',
    path: ROUTES.purchaseReceipts,
    labelKey: 'purchase_receipt',
    group: 'procurement',
    roles: ROLE_SETS.purchaseReceipt,
    // « Réceptionner » du magasinier, « Réceptions » du responsable de ferme.
    actionCodes: ['RECEIVE', 'RECEIPTS'],
    offline: true,
  },
  {
    // P8E-07 (ADR-047 §8, AV-302) : « Réceptions » du Resp. achats (suivi, S-27) mène ici.
    id: 'ECR-APP-05',
    path: ROUTES.orderMatching,
    labelKey: 'order_matching',
    group: 'procurement',
    roles: ROLE_SETS.orderMatching,
    actionCodes: ['RECEIPTS'],
    offline: false,
  },
  {
    id: 'ECR-PRD-01',
    path: ROUTES.productionLots,
    labelKey: 'production_lots',
    group: 'production',
    roles: ROLE_SETS.production,
    // « Lots de production » du responsable de production ; « SAISIE DU JOUR » du responsable de
    // ferme, qui choisit le lot dans la liste.
    actionCodes: ['LOTS', 'DAILY_ENTRY'],
    offline: true,
  },
  {
    id: 'ECR-PRD-02',
    path: ROUTES.eggCollection,
    labelKey: 'egg_collection',
    group: 'production',
    roles: ROLE_SETS.production,
    actionCodes: ['EGG_COLLECTION'],
    offline: true,
  },
  {
    id: 'ECR-PRD-03',
    path: ROUTES.lotSheet,
    labelKey: 'lot_sheet',
    group: 'production',
    roles: ROLE_SETS.lotSheet,
    // « Coûts des lots » du responsable de production.
    actionCodes: ['LOT_COSTS'],
    offline: false,
  },
  {
    id: 'ECR-PRD-04',
    path: ROUTES.lotSetup,
    labelKey: 'lot_setup',
    group: 'production',
    roles: ROLE_SETS.lotSetup,
    // « Nouveau lot » du responsable de production et de l'Admin (AV-524).
    actionCodes: ['NEW_LOT'],
    offline: true,
  },
  {
    id: 'ECR-PRD-06',
    path: ROUTES.incubation,
    labelKey: 'incubation',
    group: 'production',
    roles: ROLE_SETS.incubation,
    actionCodes: ['INCUBATIONS'],
    offline: true,
  },
  {
    id: 'ECR-PRD-07',
    path: ROUTES.productionOutput,
    labelKey: 'production_output',
    group: 'production',
    roles: ROLE_SETS.productionOutput,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-STK-09',
    path: ROUTES.thresholds,
    labelKey: 'thresholds',
    group: 'stock',
    roles: ROLE_SETS.thresholdManage,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-STK-06',
    path: ROUTES.allocations,
    labelKey: 'allocations',
    group: 'stock',
    roles: ROLE_SETS.allocationManage,
    actionCodes: [],
    offline: false,
  },
  {
    id: 'ECR-DIS-01',
    path: ROUTES.posHome,
    labelKey: 'pos_home',
    group: 'sales',
    roles: ROLE_SETS.posHome,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-DIS-02',
    path: ROUTES.cash,
    labelKey: 'cash_session',
    group: 'sales',
    roles: ROLE_SETS.cashSessionOperate,
    actionCodes: ['CASH_OPEN', 'CASH_CLOSE'],
    offline: true,
  },
  {
    // Groupe « Finance » depuis P8E-03 (ADR-047 §1).
    id: 'ECR-FIN-05',
    path: ROUTES.treasury,
    labelKey: 'treasury',
    group: 'finance',
    roles: ROLE_SETS.treasury,
    actionCodes: ['CASH_SESSIONS'],
    offline: false,
  },
  {
    // P8E-03 (ADR-047 §2, AV-298) : « + Dépense » des rôles de terrain ; « Dépenses » de la Finance
    // mène au suivi.
    id: 'ECR-FIN-02',
    path: ROUTES.expenses,
    labelKey: 'expenses',
    group: 'finance',
    roles: ROLE_SETS.expenseRecord,
    actionCodes: ['NEW_EXPENSE', 'EXPENSES'],
    actionQuery: { EXPENSES: '?vue=suivi' },
    offline: true,
  },
  {
    // P8E-05 (ADR-047 §4, AV-298) : Finance (saisie, décisions), Direction (décisions), Achats (lecture) ;
    // action « Factures fournisseurs » de l'accueil de la Finance (revue de P8E-10).
    id: 'ECR-FIN-03',
    path: ROUTES.supplierInvoices,
    labelKey: 'supplier_invoices',
    group: 'finance',
    roles: ROLE_SETS.payableRead,
    actionCodes: ['SUPPLIER_INVOICES'],
    offline: false,
  },
  {
    // P8E-06 (ADR-047 §4, AV-298) : Finance (saisie, avances), Direction (annulation d'un décaissé,
    // décision dans la file), Achats (lecture) ; action « Paiements fournisseurs » de l'accueil de la
    // Finance (revue de P8E-10).
    id: 'ECR-FIN-04',
    path: ROUTES.supplierPayments,
    labelKey: 'supplier_payments',
    group: 'finance',
    roles: ROLE_SETS.payableRead,
    actionCodes: ['SUPPLIER_PAYMENTS'],
    offline: false,
  },
  {
    // P8E-09 (ADR-047 §9, AV-304) : « Créances » de l'accueil de la Finance.
    id: 'ECR-FIN-01',
    path: ROUTES.receivables,
    labelKey: 'receivables',
    group: 'finance',
    roles: ROLE_SETS.receivables,
    actionCodes: ['RECEIVABLES'],
    offline: false,
  },
  {
    // P8E-08 (ADR-047 §6, AV-303) : menu seulement, aucune action d'accueil.
    id: 'ECR-FIN-06',
    path: ROUTES.costsMargins,
    labelKey: 'costs_margins',
    group: 'finance',
    roles: ROLE_SETS.costsMargins,
    actionCodes: [],
    offline: false,
  },
  {
    // Remises de fonds sur l'appareil (UC-FIN-07, AV-239) : ECR-FIN-07, créé à l'intégration des écrans de P5.
    id: 'ECR-FIN-07',
    path: ROUTES.cashTransfers,
    labelKey: 'cash_transfers',
    group: 'sales',
    roles: ROLE_SETS.cashTransferRecord,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-DIS-03',
    path: ROUTES.replenish,
    labelKey: 'replenish',
    group: 'stock',
    roles: ROLE_SETS.replenishRequest,
    // S-47 (AV-522) : « Demander un réapprovisionnement » à l'accueil du vendeur de point de vente.
    actionCodes: ['REPLENISH_REQUEST'],
    offline: true,
  },
  {
    id: 'ECR-DIS-04',
    path: ROUTES.distribution,
    labelKey: 'distribution',
    group: 'sales',
    roles: ROLE_SETS.distributionDashboard,
    actionCodes: [],
    offline: false,
  },
  {
    id: 'ECR-VEN-05',
    path: ROUTES.sales,
    labelKey: 'sales',
    group: 'sales',
    roles: SALE_READER_ROLES,
    actionCodes: [],
    offline: true,
    // Ventes du jour signalées (AV-255) : la liste filtrée sur elles.
    signalCodes: ['SALES_FLAGGED'],
    signalQuery: { SALES_FLAGGED: '?anomalies=1' },
  },
  {
    id: 'ECR-NOT-01',
    path: ROUTES.alerts,
    labelKey: 'alerts',
    group: 'general',
    roles: 'ALL',
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-NOT-02',
    path: ROUTES.notes,
    labelKey: 'notes',
    group: 'general',
    roles: 'ALL',
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-NOT-03',
    path: ROUTES.notesPublish,
    labelKey: 'notes_publish',
    group: 'general',
    roles: ROLE_SETS.notesPublish,
    actionCodes: [],
    offline: false,
  },
  {
    id: 'ECR-ANA-01',
    path: ROUTES.analyticsDirection,
    labelKey: 'analytics_direction',
    group: 'general',
    roles: ROLE_SETS.analyticsDirection,
    actionCodes: ['CONTROL_TOWER'],
    offline: true,
  },
  {
    id: 'ECR-ANA-02',
    path: ROUTES.analyticsCommercial,
    labelKey: 'analytics_commercial',
    group: 'crm',
    roles: ROLE_SETS.analyticsCommercial,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-ANA-03',
    path: ROUTES.analyticsStock,
    labelKey: 'analytics_stock',
    group: 'stock',
    roles: ROLE_SETS.analyticsStock,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-ANA-04',
    path: ROUTES.analyticsProduction,
    labelKey: 'analytics_production',
    group: 'production',
    roles: ROLE_SETS.analyticsProduction,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-ANA-05',
    path: ROUTES.analyticsFinance,
    labelKey: 'analytics_finance',
    group: 'finance',
    roles: ROLE_SETS.analyticsFinance,
    actionCodes: [],
    offline: false,
  },
  {
    id: 'ECR-ANA-06',
    path: ROUTES.analyticsExplorer,
    labelKey: 'analytics_explorer',
    group: 'general',
    roles: ROLE_SETS.analyticsExplorer,
    actionCodes: [],
    offline: false,
  },
  {
    id: 'ECR-PIE-01',
    path: ROUTES.paperSlipReport,
    labelKey: 'paper_slip_report',
    group: 'general',
    roles: ROLE_SETS.paperSlipReport,
    actionCodes: ['REPORT_PAPER_SLIP', 'RECORD_PAPER_SLIP'],
    offline: true,
  },
  {
    id: 'ECR-IMP-01',
    path: ROUTES.dataImport,
    labelKey: 'data_import',
    group: 'general',
    roles: ROLE_SETS.dataImport,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-TER-03',
    path: ROUTES.presence,
    labelKey: 'presence',
    group: 'general',
    roles: ROLE_SETS.presence,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-CRM-08',
    path: ROUTES.weeklyReport,
    labelKey: 'weekly_report',
    group: 'crm',
    roles: ROLE_SETS.weeklyReport,
    actionCodes: [],
    offline: true,
  },
  {
    // AV-525 : guide complet (parcours, pages par domaine, questions) ; l'aide de chaque page s'ouvre du « ? ».
    id: 'ECR-HLP-01',
    path: ROUTES.help,
    labelKey: 'help',
    group: 'general',
    roles: 'ALL',
    actionCodes: [],
    offline: true,
  },
];

export const SCREEN_GROUPS: readonly ScreenGroup[] = [
  'sales',
  'stock',
  'crm',
  'procurement',
  'production',
  'finance',
  'general',
];

/**
 * Route d'une action de l'accueil : celle du serveur, à défaut celle de l'écran livré. Avec le rôle
 * de la section, l'écran doit être proposé à ce rôle : une même action peut porter un sens différent
 * d'un rôle à l'autre (`RECEIPTS` : saisir une réception pour le responsable de ferme, suivre les
 * réceptions pour le responsable des achats, écran non livré) et reste alors « Bientôt ».
 */
export function routeOfAction(
  action: Pick<HomeAction, 'code' | 'route'>,
  role?: string,
): string | null {
  if (action.route) return action.route;
  const screen = SCREENS.find(
    (candidate) =>
      candidate.actionCodes.includes(action.code) &&
      (role === undefined || candidate.roles === 'ALL' || candidate.roles.includes(role)),
  );
  return screen ? `${screen.path}${screen.actionQuery?.[action.code] ?? ''}` : null;
}

/**
 * Route d'un signal de l'accueil : celle du serveur, à défaut celle de l'écran livré qui déclare ce
 * signal (`signalCodes`, ADR-036 : la PWA connaît ses écrans, le serveur peut ne renseigner aucune route).
 */
export function routeOfSignal(signal: {
  readonly code: string;
  readonly action?: { readonly route: string | null } | null;
}): string | null {
  if (signal.action?.route) return signal.action.route;
  const screen = SCREENS.find((candidate) => candidate.signalCodes?.includes(signal.code));
  return screen ? `${screen.path}${screen.signalQuery?.[signal.code] ?? ''}` : null;
}

/** Écrans proposés à un utilisateur selon ses rôles, dans l'ordre du registre. */
export function screensForRoles(roles: readonly string[]): ScreenEntry[] {
  const held = new Set(roles);
  return SCREENS.filter(
    (screen) => screen.roles === 'ALL' || screen.roles.some((role) => held.has(role)),
  );
}
