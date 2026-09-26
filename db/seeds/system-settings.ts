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
  /** Seuil numérique, ou liste de codes (ex. rôles commerciaux, P3-04). */
  readonly value: number | readonly string[];
  readonly isClientVisible: boolean;
  /** Référence documentaire (AV/BR) pour la traçabilité de la valeur par défaut. */
  readonly ref: string;
}

// is_client_visible : DÉDUIT au cas par cas — vrai pour les seuils qui gouvernent un
// comportement de l'appareil hors ligne (géorepère, précision GPS, autonomie, distance de
// visite), faux pour les seuils d'approbation et les paramètres purement serveur, jamais
// interrogés par la PWA (dictionnaire : « Téléchargé sur les appareils »).
export const SYSTEM_SETTINGS: readonly SystemSettingSeed[] = [
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
  { key: 'sync.clock_skew_flag_minutes', value: 5, isClientVisible: false, ref: 'BR-SYN-011' },
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
  { key: 'pricing.stale_rules_hours', value: 24, isClientVisible: false, ref: 'AV-063' },
  { key: 'finance.cash_holding_max_xaf', value: 200_000, isClientVisible: false, ref: 'D09 §14' },
  {
    key: 'finance.supplier_payment_approval_xaf',
    value: 500_000,
    isClientVisible: false,
    ref: 'AV-055',
  },
  {
    key: 'procurement.po_approval_threshold_xaf',
    value: 500_000,
    isClientVisible: false,
    ref: 'AV-051',
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
  { key: 'analytics.freshness_warning_hours', value: 2, isClientVisible: false, ref: 'BR-ANA-005' },
  // pricing.max_discount_pct.<ROLE> (AV-026, 0/5/15 selon le rôle) : voir
  // ROLE_DISCOUNT_SETTINGS dans rbac-data.ts, dérivé de la matrice RBAC plutôt que
  // dupliqué ici (le rôle doit exister avant que sa clé de remise ait un sens).
] as const;
