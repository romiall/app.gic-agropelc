/**
 * Clés de traduction françaises (UX-10 : interface en français, libellés courts, verbes
 * d'action). Langue unique pour l'instant (AV-079, aucun impact sur la stack) : i18next reste
 * en place dès P0 pour éviter une réécriture si d'autres langues sont ajoutées plus tard.
 */
export const fr = {
  app: {
    name: 'GIC AGROPELC',
  },
  auth: {
    login_title: 'Connexion',
    phone_label: 'Téléphone',
    password_label: 'Mot de passe',
    submit: 'Se connecter',
    submitting: 'Connexion…',
    error_invalid_credentials: 'Identifiants invalides.',
    error_offline: 'Pas de réseau : la première connexion doit se faire en ligne.',
    error_locked: 'Trop de tentatives : réessayez plus tard.',
    pin_setup_title: 'Choisir un code PIN',
    pin_setup_help: 'Ce code à 6 chiffres déverrouillera l’application hors ligne.',
    pin_confirm_title: 'Confirmer le code PIN',
    pin_label: 'Code PIN (6 chiffres)',
    pin_confirm_label: 'Confirmer le code PIN',
    pin_mismatch: 'Les deux codes ne correspondent pas.',
    pin_submit: 'Valider',
    unlock_title: 'Déverrouiller',
    unlock_help: 'Saisissez votre code PIN.',
    unlock_submit: 'Déverrouiller',
    pin_error_attempts: '{{count}} tentative restante',
    pin_error_attempts_other: '{{count}} tentatives restantes',
    pin_wiped: 'Trop d’échecs : reconnexion en ligne obligatoire.',
    logout: 'Se déconnecter',
    logout_confirm_pending:
      'Des opérations sont en attente d’envoi ({{count}}). Se déconnecter quand même ?',
    logout_confirm: 'Se déconnecter ?',
  },
  home: {
    title: 'Accueil',
    empty_message: 'Aucune action pour le moment.',
  },
  sync: {
    screen_title: 'Synchronisation',
    force_sync: 'Forcer la synchronisation',
    syncing: 'Synchronisation…',
    pending_operations: 'Opérations en attente',
    no_pending: 'Aucune opération en attente.',
    attention_operations: 'Opérations à examiner',
    diagnostic_title: 'Diagnostic',
    diagnostic_help:
      'Enregistre un paramètre de test (organization.setting.set) pour vérifier que le pipeline fonctionne, en ligne comme hors ligne.',
    diagnostic_submit: 'Tester la synchronisation',
    diagnostic_enqueued: 'Commande de test ajoutée à la file (statut : {{status}}).',
    badge: {
      synced: 'Synchronisé',
      pending: '{{count}} opération en attente',
      pending_other: '{{count}} opérations en attente',
      attention: '{{count}} opération à examiner',
      attention_other: '{{count}} opérations à examiner',
      offline_since: 'Hors ligne depuis {{hours}} h',
      offline_unknown: 'Hors ligne',
    },
    status: {
      LOCAL_ONLY: 'En attente d’envoi',
      PENDING_SYNC: 'En attente d’envoi',
      SYNCING: 'Envoi en cours',
      SYNCED: 'Synchronisé',
      SYNCED_WITH_WARNING: 'Synchronisé (avertissement)',
      CONFLICT: 'Conflit',
      REJECTED: 'Rejeté',
    },
  },
} as const;
