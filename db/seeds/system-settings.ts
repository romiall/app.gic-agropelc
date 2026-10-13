/**
 * Paramètres système par défaut (organization.system_settings, BR-ADM-015). Catalogue
 * initial : docs/03-data/dictionnaire/02-organization.md, table « Catalogue initial des
 * clés ». Chaque entrée combinée du dictionnaire (« a / b ») est éclatée en clés
 * indépendantes ici — une ligne `system_settings` par clé (VERSIONNEMENT : ce seed ne
 * réinsère jamais une clé déjà présente pour ne pas créer de version parasite ; voir
 * seeds/run.ts).
 */
export interface SystemSettingSeed {
  readonly key: string;
  /** Seuil numérique, code d'option, ou liste de codes (ex. rôles commerciaux, P3-04). */
  readonly value: number | string | boolean | readonly string[] | Readonly<Record<string, unknown>>;
  readonly isClientVisible: boolean;
  /** Référence documentaire (AV/BR) pour la traçabilité de la valeur par défaut. */
  readonly ref: string;
}

// is_client_visible : DÉDUIT au cas par cas — vrai pour les seuils qui gouvernent un
// comportement de l'appareil hors ligne (géorepère, précision GPS, autonomie, distance de
// visite), faux pour les seuils d'approbation et les paramètres purement serveur, jamais
// interrogés par la PWA (dictionnaire : « Téléchargé sur les appareils »).
export const SYSTEM_SETTINGS: readonly SystemSettingSeed[] = [
  // P7-04 (production). AV-046 : liste ordonnée des produits « calibre » (codes catalogue) —
  // vide tant que les produits GIC ne sont pas saisis (AV-072) ; une collecte ne peut ventiler
  // que ces calibres. Produit des œufs à couver : code catalogue (vide = non paramétré).
  { key: 'production.egg_grade_product_codes', value: [], isClientVisible: true, ref: 'AV-046' },
  {
    key: 'production.hatching_egg_product_code',
    value: '',
    isClientVisible: true,
    ref: 'AV-046, AV-047',
  },
  // AV-122 (décision du 28/09/2026) : péremption du lot d'une collecte = date de collecte + N jours.
  {
    key: 'production.egg_shelf_life_days',
    value: 28,
    isClientVisible: true,
    ref: 'AV-100, AV-122',
  },
  // AV-125 (défaut) : péremption du lot d'un abattage = jour de l'abattage + N jours (frais).
  {
    key: 'production.slaughter_shelf_life_days',
    value: 5,
    isClientVisible: true,
    ref: 'AV-100, AV-125',
  },
  // AV-047 : durées d'incubation par espèce, en jours depuis la mise en incubateur (WF-12).
  {
    key: 'production.incubation_durations',
    value: { POULE: { candlingDay: 7, transferDay: 18, hatchDay: 21 } },
    isClientVisible: true,
    ref: 'AV-047, BR-INC-008',
  },
  // AV-115 (décision du 28/09/2026) : tous les types de lots abattables, volailles et porcs.
  {
    key: 'production.slaughterable_lot_types',
    value: [
      'POULET_CHAIR',
      'PONDEUSE',
      'REPRODUCTEUR_VOLAILLE',
      'PORC_ENGRAISSEMENT',
      'PORC_NAISSAGE',
    ],
    isClientVisible: true,
    ref: 'AV-032, AV-115',
  },
  // AV-121 (défaut) : seuils de l'alerte de mortalité élevée (cumul du jour), découplés de la
  // validation (toujours exigée, AV-048).
  { key: 'production.high_mortality_alert_pct', value: 0.5, isClientVisible: false, ref: 'AV-121' },
  {
    key: 'production.high_mortality_alert_heads',
    value: 20,
    isClientVisible: false,
    ref: 'AV-121',
  },
  { key: 'fieldwork.geofence_radius_m', value: 500, isClientVisible: true, ref: 'CM §10, AV-022' },
  { key: 'fieldwork.max_gps_accuracy_m', value: 150, isClientVisible: true, ref: 'AV-022' },
  { key: 'fieldwork.override_min_attempts', value: 3, isClientVisible: true, ref: 'AV-021' },
  { key: 'fieldwork.override_min_minutes', value: 2, isClientVisible: true, ref: 'AV-021' },
  // BR-TER-010 (P3) : signaux de pointage suspect, calculés par le serveur seulement.
  {
    key: 'fieldwork.suspicion_max_speed_kmh',
    value: 150,
    isClientVisible: false,
    ref: 'BR-TER-010',
  },
  {
    key: 'fieldwork.suspicion_repeated_accuracy_count',
    value: 5,
    isClientVisible: false,
    ref: 'BR-TER-010',
  },
  { key: 'offline.max_autonomy_hours', value: 168, isClientVisible: true, ref: 'AV-009' },
  { key: 'offline.warning_hours', value: 48, isClientVisible: true, ref: 'AV-009' },
  // P5-23 (AV-216) : seuil (minutes, > 0) du drapeau d'horloge suspecte, lu par le service d'envoi à la
  // réception de chaque lot ; décision figée dans l'inbox (`clock_suspect`).
  {
    key: 'sync.clock_skew_flag_minutes',
    value: 5,
    isClientVisible: false,
    ref: 'BR-SYN-011, AV-216',
  },
  // P5-23 (AV-226) : tolérance (minutes, ≥ 0) d'une date de fait postérieure à l'heure serveur, après
  // correction de l'écart d'horloge (INV-GLO-02) ; au-delà, `OCCURRED_AT_FUTURE`.
  {
    key: 'sync.occurred_at_future_tolerance_minutes',
    value: 5,
    isClientVisible: false,
    ref: 'INV-GLO-02, AV-226',
  },
  // P5-21 (revue adverse, AV-217) : au-delà de cette durée depuis sa première réception, une commande
  // à renvoyer (dépendance en attente, erreur transitoire) ne suspend plus la suite de son lot ; elle
  // reste à renvoyer, jamais perdue, et le signal `SYNC_COMMAND_STALLED` est ouvert pour l'Admin.
  { key: 'sync.retry_hold_minutes', value: 30, isClientVisible: false, ref: 'AV-217' },
  // P5-23 (AV-198) : fenêtre de stabilisation de la numérotation du flux — le curseur du pull ne dépasse
  // jamais un numéro absent suivi d'une ligne plus récente (transaction peut-être encore ouverte).
  { key: 'sync.pull_settle_seconds', value: 120, isClientVisible: false, ref: 'AV-198' },
  { key: 'sync.backdate_max_hours', value: 72, isClientVisible: true, ref: 'AV-078' },
  { key: 'sync.justification_after_hours', value: 24, isClientVisible: true, ref: 'AV-078' },
  { key: 'crm.inactive_after_days', value: 30, isClientVisible: false, ref: 'AV-013' },
  { key: 'crm.visit.max_distance_m', value: 500, isClientVisible: true, ref: 'BR-CRM-015' },
  // BR-CRM-006 (P3) : indicatif ajouté à un numéro national saisi sans indicatif (Cameroun,
  // DÉDUIT) — visible de l'appareil, qui normalise aussi pour son contrôle local de doublon.
  { key: 'crm.phone_default_country_code', value: 237, isClientVisible: true, ref: 'BR-CRM-006' },
  // BR-CRM-003, BR-CRM-020 (P3-04) : rôles réputés « commerciaux » — titulaire d'un compte à sa
  // création, seul titulaire possible d'une réaffectation (DÉDUIT : les trois rôles commerciaux
  // du seed RBAC, AV-004).
  {
    key: 'crm.commercial_role_codes',
    value: ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE'],
    isClientVisible: true,
    ref: 'BR-CRM-003',
  },
  { key: 'sales.direct_cancel_minutes', value: 15, isClientVisible: true, ref: 'AV-030' },
  { key: 'sales.default_payment_terms_days', value: 30, isClientVisible: false, ref: 'AV-028' },
  // AV-056 (P4-02) : fenêtre de détection d'un doublon d'encaissement sans référence (même
  // client, même montant) — visible de l'appareil, qui contrôle aussi localement.
  {
    key: 'sales.duplicate_payment_window_minutes',
    value: 10,
    isClientVisible: true,
    ref: 'AV-056',
  },
  // AV-025 (P4-02) : une vente hors ligne peut-elle dépasser l'allocation d'appareil ? Non par
  // défaut (réglable par site) ; lu par l'appareil hors ligne.
  {
    key: 'sales.offline_over_allocation_allowed',
    value: false,
    isClientVisible: true,
    ref: 'AV-025',
  },
  // AV-166 (P5-11) : une vente hors ligne sans quota utilisable (aucun, ou échu) sur un emplacement
  // partagé est appliquée et signalée (`ALLOCATION_EXCEEDED`) : `WHEN_ALLOCATED` (défaut) si
  // l'emplacement porte au moins un quota actif du produit (même épuisé), `ALWAYS`, ou `NEVER` (comportement de
  // P5-09). Réglable par site ; lu par le serveur seul.
  {
    key: 'sales.offline_unallocated_sale_signal',
    value: 'WHEN_ALLOCATED',
    isClientVisible: false,
    ref: 'AV-166',
  },
  // AV-132 (P4-02) : jours au-delà desquels une vente confirmée non livrée est signalée (alerte P9).
  { key: 'sales.undelivered_alert_days', value: 7, isClientVisible: false, ref: 'AV-132' },
  { key: 'pricing.stale_rules_hours', value: 24, isClientVisible: false, ref: 'AV-063' },
  { key: 'finance.cash_holding_max_xaf', value: 200_000, isClientVisible: false, ref: 'D09 §14' },
  // P5-03 (ADR-032, AV-057, AV-153, AV-154, AV-158) : sessions de caisse et remises de fonds.
  // Nombre de sessions par PDV et par jour métier (AV-154) ; lu par l'appareil à l'ouverture.
  { key: 'finance.cash_sessions_per_day_max', value: 1, isClientVisible: true, ref: 'AV-154' },
  // Au-delà de ces heures, une session ouverte est signalée et la Finance peut la clôturer d'office.
  {
    key: 'finance.cash_session_force_close_hours',
    value: 24,
    isClientVisible: false,
    ref: 'D05 §14',
  },
  // Gravité critique de l'alerte d'écart de caisse (D13) ; en dessous, simple avertissement.
  {
    key: 'finance.cash_variance_critical_xaf',
    value: 10_000,
    isClientVisible: false,
    ref: 'D13-NOT',
  },
  // Tolérance d'écart validée d'office (AV-057 : tout écart est validé, donc 0).
  { key: 'finance.cash_variance_tolerance_xaf', value: 0, isClientVisible: false, ref: 'AV-057' },
  // Délai avant d'alerter sur une remise de fonds envoyée et jamais reçue (AV-158).
  {
    key: 'finance.cash_transfer_unreceived_hours',
    value: 48,
    isClientVisible: false,
    ref: 'AV-158',
  },
  // Jours d'encaisse sans remise avant l'alerte CASH_HOLDING_HIGH (D09 §14).
  { key: 'finance.cash_holding_max_days', value: 3, isClientVisible: false, ref: 'D09 §14' },
  // P5-15 (AV-158, À VALIDER) : paires de comptes admises pour une remise de fonds, type source →
  // types destinataires ; lues par l'appareil (même fonction de domaine, `cashTransferPairsFrom`) ;
  // une valeur mal formée revient au défaut du domaine (`DEFAULT_CASH_TRANSFER_PAIRS`).
  {
    key: 'finance.cash_transfer_allowed_pairs',
    value: {
      CAISSE_PDV: ['CAISSE_CENTRALE', 'BANQUE'],
      CAISSE_UTILISATEUR: ['CAISSE_CENTRALE', 'BANQUE'],
      CAISSE_CENTRALE: ['CAISSE_PDV', 'BANQUE'],
      BANQUE: ['CAISSE_CENTRALE'],
      MOBILE_MONEY: ['CAISSE_CENTRALE', 'BANQUE'],
    },
    isClientVisible: true,
    ref: 'AV-158',
  },
  // P5-15 (AV-176) : code de la série globale `RMF-{CODE}-AAAA-nnnnnn` d'une remise entre deux
  // comptes sans site (1 à 10 lettres majuscules ou chiffres, sinon `SIEGE`).
  {
    key: 'finance.cash_transfer_series_code',
    value: 'SIEGE',
    isClientVisible: false,
    ref: 'AV-176',
  },
  {
    key: 'finance.supplier_payment_approval_xaf',
    value: 500_000,
    isClientVisible: false,
    ref: 'AV-055',
  },
  // P8-03 (ADR-060 §2 et §5) : seuils des dépenses, comparaisons strictes ; visibles de l'appareil,
  // qui les applique hors ligne (justificatif, validation annoncée, plafond du PDV).
  {
    key: 'finance.expense_approval_threshold_xaf',
    value: 50_000,
    isClientVisible: true,
    ref: 'AV-058',
  },
  {
    key: 'finance.expense_photo_threshold_xaf',
    value: 10_000,
    isClientVisible: true,
    ref: 'AV-058',
  },
  {
    key: 'finance.pos_expense_max_xaf',
    value: 50_000,
    isClientVisible: true,
    ref: 'AV-353',
  },
  // P8-03 (ADR-061) : rapprochement d'une facture (tolérances nulles, AV-053), facture sans BC
  // (`REVIEW` ou `APPROVE`, AV-358), avances fournisseurs (AV-362), série des documents `FF` et `PF`
  // (1 à 10 lettres majuscules ou chiffres, sinon `SIEGE`).
  {
    key: 'finance.invoice_match_qty_tolerance_pct',
    value: 0,
    isClientVisible: false,
    ref: 'AV-053',
  },
  {
    key: 'finance.invoice_match_price_tolerance_xaf',
    value: 0,
    isClientVisible: false,
    ref: 'AV-053',
  },
  {
    key: 'finance.invoice_without_po_mode',
    value: 'REVIEW',
    isClientVisible: false,
    ref: 'AV-358',
  },
  {
    key: 'finance.supplier_advance_allowed',
    value: true,
    isClientVisible: false,
    ref: 'AV-362',
  },
  {
    key: 'finance.supplier_series_code',
    value: 'SIEGE',
    isClientVisible: false,
    ref: 'AV-176',
  },
  {
    key: 'procurement.po_approval_threshold_xaf',
    value: 500_000,
    isClientVisible: false,
    ref: 'AV-051',
  },
  // P6-02 : acceptation cumulée au-delà du commandé, en pourcentage du commandé (tolérance
  // nulle par défaut ; hors ligne, l'excédent part en revue OVER_RECEIPT, BR-APP-010).
  {
    key: 'procurement.receipt_over_tolerance_pct',
    value: 0,
    isClientVisible: true,
    ref: 'AV-053',
  },
  // AV-095 (P6-05) : réception hors ligne dépassant le reliquat d'un BC — `QUARANTINE`
  // (BR-APP-012, D08 §14 : aucun effet stock jusqu'à décision) ou `APPLY_WITH_REVIEW`
  // (BR-APP-010 : appliquée, excédent tracé en revue).
  {
    key: 'procurement.offline_over_receipt_mode',
    value: 'QUARANTINE',
    isClientVisible: true,
    ref: 'AV-095',
  },
  // BR-APP-014 (P6-02) : photo du bon de livraison exigée pour toute réception sans BC et pour
  // toute réception dont la valeur acceptée atteint ce seuil (AV-037).
  {
    key: 'procurement.receipt_photo_threshold_xaf',
    value: 100_000,
    isClientVisible: true,
    ref: 'BR-APP-014, AV-037',
  },
  {
    key: 'inventory.count_approval_threshold_xaf',
    value: 25_000,
    isClientVisible: false,
    ref: 'AV-039',
  },
  {
    key: 'inventory.transfer_unmatched_hours',
    value: 48,
    isClientVisible: false,
    ref: 'BR-STK-024',
  },
  // P5-16 : règle de rapprochement d'une réception sans document (SUBSET : produits reçus inclus
  // dans les produits expédiés, écart à valider, excédent signalé ; EXACT : identité seule).
  {
    key: 'inventory.blind_receipt_match_mode',
    value: 'SUBSET',
    isClientVisible: false,
    ref: 'AV-177',
  },
  { key: 'analytics.freshness_warning_hours', value: 2, isClientVisible: false, ref: 'BR-ANA-005' },
  // P5-20 (AV-207) : durée maximale d'une période personnalisée d'un tableau de bord, en jours.
  {
    key: 'analytics.dashboard_max_period_days',
    value: 366,
    isClientVisible: false,
    ref: 'AV-207',
  },
  // pricing.max_discount_pct.<ROLE> (AV-026, 0/5/15 selon le rôle) : voir
  // ROLE_DISCOUNT_SETTINGS dans rbac-data.ts, dérivé de la matrice RBAC plutôt que
  // dupliqué ici (le rôle doit exister avant que sa clé de remise ait un sens).
] as const;

/**
 * Révisions d'une valeur par défaut décidée après le premier seed (BR-ADM-015 : jamais de
 * réécriture, une nouvelle version datée). Le seed insère une version `valid_from = maintenant`
 * seulement si la valeur en vigueur diffère **et** si cette révision n'a jamais été appliquée
 * (repère `revision` dans `reason`) : une valeur changée ensuite par un administrateur n'est pas
 * écrasée par une ré-exécution.
 */
export interface SystemSettingRevision {
  readonly revision: string;
  readonly key: string;
  readonly value: SystemSettingSeed['value'];
  readonly isClientVisible: boolean;
}

export const SYSTEM_SETTING_REVISIONS: readonly SystemSettingRevision[] = [
  {
    revision: 'AV-115 (28/09/2026)',
    key: 'production.slaughterable_lot_types',
    value: [
      'POULET_CHAIR',
      'PONDEUSE',
      'REPRODUCTEUR_VOLAILLE',
      'PORC_ENGRAISSEMENT',
      'PORC_NAISSAGE',
    ],
    isClientVisible: true,
  },
];
