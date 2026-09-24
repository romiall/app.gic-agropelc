# Journal d'audit — spécification (PM §18)

> Règles fonctionnelles : D12 (BR-AUD-*). Table : `audit.audit_log` ([dictionnaire](../03-data/dictionnaire/11-audit-sync-integrations-platform.md)). Invariants : INV-AUD-01, INV-AUD-02, INV-GLO-04.

---

## 1. Distinction des journaux

| Journal | Finalité | Contenu | Consommateurs | Rétention |
|---|---|---|---|---|
| **Audit** (`audit.audit_log`) | Responsabilité, preuve, enquête | Qui, quoi, quand (réel et serveur), où, appareil, avant et après, validation, motif, résultat | Direction, Admin, Finance | 10 ans (AV-074) |
| **Événements métier** (`platform.domain_events`) | Réactions entre modules (alertes, Kommo, projections) | Fait métier et données minimum | Worker, modules | 13 mois + archive |
| **Commandes reçues** (`sync.command_inbox`) | Idempotence, rejeu, diagnostic de synchronisation | Enveloppe brute et résultat | Module `sync`, support | 13 mois + archive |
| **Logs techniques** | Diagnostic d'exploitation | Requêtes, erreurs, performances | Équipe technique | 30 jours |

## 2. Contenu d'une entrée (PM §18)

| Exigence PM §18 | Colonne |
|---|---|
| Utilisateur | `actor_user_id`, `actor_roles` |
| Action | `action` |
| Entité, identifiant | `entity_type`, `entity_id` |
| Ancienne valeur | `before` (champs modifiés seulement) |
| Nouvelle valeur | `after` |
| Date réelle | `occurred_at` |
| Date serveur | `recorded_at` |
| Appareil | `device_id` |
| En ligne / hors ligne | `captured_offline` |
| IP | `ip` |
| Synchronisation | `command_id`, `sync_delay_ms`, `clock_skew_ms` |
| Validation | `approval_request_id` (et l'entrée d'audit de la décision) |
| Raison | `reason` |
| Résultat | `result` (`SUCCESS`, `DENIED`, `FAILED`, `QUARANTINED`) |

## 3. Actions auditées

Toutes les commandes des modules métier (BR-AUD-003), avec le code d'action = type de commande. Plus les actions techniques suivantes :

| Action | Déclencheur |
|---|---|
| `auth.login.succeeded`, `auth.login.failed`, `auth.pin.locked`, `auth.token.reuse_detected`, `auth.session.revoked` | Authentification |
| `audit.log.read` | Consultation du journal (avec filtres) |
| `analytics.export.requested`, `analytics.export.downloaded` | Exports |
| `access.denied` | Tout refus d'autorisation (IDOR, permission absente) |
| `system.job.<nom>` | Actions du système (clôtures automatiques, rapprochements, escalades) |
| `sync.command.quarantined`, `sync.sequence_gap`, `sync.clock_skew` | Anomalies de synchronisation |
| `integration.kommo.webhook_rejected` | Webhook non authentifié |

## 4. Informations immuables (PM §18 « quelles informations doivent être immuables »)

| Catégorie | Informations immuables | Garantie |
|---|---|---|
| Responsabilité | Auteur, appareil, `occurred_at`, `command_id`, `captured_offline` de toute transaction | INV-GLO-01 (déclencheur) |
| Faits | Mouvements de stock, de trésorerie, de coûts, de quotas ; affectations de paiement (sauf désactivation datée) | INV-STK-04, INV-FIN-01 |
| Documents confirmés | Lignes, quantités, prix, attribution d'une vente confirmée ; réception comptabilisée ; perte déclarée (hors décision) | INV-VEN-02, INV-VEN-05, INV-VEN-10 |
| Décisions | Demande de validation décidée ; session de caisse validée ; règle tarifaire active ; politique versionnée | SM-APPROVAL, INV-FIN-05, INV-PRX-01 |
| Identité d'acquisition | Acquéreur d'un client | INV-CRM-01 |
| Audit | Tout le journal | INV-AUD-01 |

## 5. Chaînage et intégrité

```text
canon(e) = JSON canonique (clés triées, sans espaces) de :
  {seq, id, occurred_at, recorded_at, actor_user_id, actor_roles, device_id, action,
   entity_type, entity_id, before_hash, after_hash, reason_hash, result, command_id}
  où *_hash = SHA-256 du contenu (permet la pseudonymisation sans casser la chaîne)
row_hash(e) = SHA-256(prev_hash ‖ canon(e))
prev_hash(e) = row_hash(e précédente) ; première entrée : 64 zéros
```

- Écriture : dans la transaction métier. L'ordre et le chaînage sont garantis par un verrou consultatif global d'audit, tenu seulement le temps de calculer le hachage et d'insérer (quelques millisecondes). Si le verrou devient un point de contention (> 50 écritures/s soutenues), on passe à un chaînage **par partition mensuelle et par module**, ce qui garde la vérifiabilité.
- Vérification : tâche quotidienne qui recalcule la chaîne des entrées du jour, plus une vérification hebdomadaire complète du mois courant. Toute rupture → `AUDIT_CHAIN_BROKEN` (critique).
- Ancrage externe : le `row_hash` de la dernière entrée de chaque jour est exporté vers un stockage objet en écriture unique (verrou d'objet), ce qui empêche une réécriture complète de la chaîne par un administrateur de base.

## 6. Accès et consultation

- Permission `audit.log.read` (Direction, Admin, Finance), dans la portée du rôle. La Finance est limitée aux entités financières.
- Historique d'un document : chaque écran de document affiche son historique d'audit filtré (auteur, décisions), dans la portée de lecture du document.
- Toute consultation du journal est elle-même auditée (BR-AUD-009).

## 7. Données personnelles et pseudonymisation

Sur demande légitime d'effacement (AV-073), procédure auditée et approuvée par la Direction :

1. Remplacement des valeurs personnelles dans `before` et `after` par un jeton.
2. Conservation des empreintes (`before_hash`, `after_hash`) : la chaîne reste vérifiable.
3. Les transactions métier restent (pseudonymisation du compte client, pas de suppression).

## 8. Volume et performance

- Estimation : environ 20 000 entrées par jour (H-06), soit environ 7,3 millions par an, environ 3 Go par an compressés.
- Partitionnement mensuel ; index par entité, acteur, action, site, appareil ; archivage froid après 24 mois ; restauration d'une partition archivée en moins de 24 h.
