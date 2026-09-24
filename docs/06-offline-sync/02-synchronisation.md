# Stratégie de synchronisation (Livrable n°7, partie 2)

> Section 19 du format final (PM §48). Décision : ADR-007. Règles fonctionnelles : D14 (BR-SYN-*). Invariants : INV-SYN-*.

---

## 1. Vue d'ensemble

Trois flux indépendants :

1. **Push** : l'appareil envoie ses **commandes** (intentions d'écriture), le serveur les applique de manière idempotente et renvoie un résultat par commande.
2. **Pull** : l'appareil télécharge, par jeu de données, les **changements** de son périmètre depuis son curseur.
3. **Pièces jointes** : upload séparé, par morceaux et reprenable, des fichiers référencés par les commandes.

```mermaid
sequenceDiagram
  participant A as Appareil
  participant S as API /sync
  participant H as Gestionnaires de commandes
  participant DB as PostgreSQL
  A->>S: POST /sync/push {device_id, batch_id, device_sent_at, commands[≤50]}
  S->>S: auth (session de l'auteur), appareil ACTIVE, version supportée
  loop pour chaque commande, dans l'ordre de device_seq
    S->>DB: SELECT command_inbox WHERE command_id
    alt déjà connue
      S-->>A: résultat enregistré (idempotence)
    else nouvelle
      S->>H: dispatch(command)
      H->>DB: BEGIN ; RBAC à occurred_at ; validations ; effets ; audit ; domain_events ; change_feed ; inbox=APPLIED ; COMMIT
      H-->>S: résultat
    end
  end
  S-->>A: {results[], server_time, clock_skew_ms}
  A->>S: GET /sync/pull?dataset=…&cursor=…
  S-->>A: {changes[], next_cursor, has_more}
  A->>S: PUT /attachments/{id} (morceaux, reprise par offset)
```

## 2. Enveloppe de commande

```json
{
  "command_id": "0192f6c4-7c1a-7cc2-9b1e-4b2f0c8e5a11",
  "device_seq": 1834,
  "command_type": "sales.sale.record",
  "command_version": 1,
  "author_user_id": "…",
  "aggregate_type": "SALE",
  "aggregate_id": "0192f6c4-7c19-…",
  "base_version": null,
  "depends_on": [],
  "occurred_at": "2026-09-24T10:47:12.410Z",
  "client_created_at": "2026-09-24T10:47:15.002Z",
  "captured_offline": true,
  "backdated_reason": null,
  "attachment_ids": [],
  "payload": { "…": "spécifique au type (schéma versionné)" }
}
```

Règles :

- `payload` porte les identifiants (UUIDv7) des entités créées par la commande : vente, lignes, encaissement. Le serveur les utilise tels quels après contrôle (identifiants §1.3).
- `payload` ne porte **jamais** de valeur que le serveur doit déterminer : coût unitaire, numéro officiel, lot définitif, attribution, conversion. Le prix appliqué est une **déclaration du fait** (ce que le client a payé) : il est accepté et comparé au prix résolu par le serveur.
- Chaque `command_type` a un **schéma de validation versionné**, partagé entre appareil et serveur (ADR-021).
- `payload_hash` = SHA-256 de la sérialisation canonique de l'enveloppe, hors champs de transport. Il est calculé par le serveur (INV-SYN-02).

## 3. Push

### 3.1 Protocole

| Élément | Règle |
|---|---|
| Lot | ≤ 50 commandes et ≤ 256 Ko compressés (gzip) ; les commandes d'un même auteur sont groupées (session de l'auteur, BR-SYN-014) |
| Ordre | Croissant de `device_seq` ; le serveur traite **séquentiellement** les commandes d'un appareil, sous verrou consultatif par appareil (INV-SYN-04) |
| Dépendances | Une commande dont une dépendance n'est pas encore connue du serveur reçoit `RETRY_LATER` (`DEPENDENCY_PENDING`) ; si la dépendance est rejetée, elle reçoit `REJECTED` (`DEPENDENCY_REJECTED`) |
| Arrêt du lot | Aucune : chaque commande a son propre résultat ; un rejet n'arrête que les commandes qui en dépendent |
| Réponse | `results[]` : `command_id`, `status` (`APPLIED`, `APPLIED_WITH_WARNINGS`, `CONFLICT`, `REJECTED`, `RETRY_LATER`), `server_refs` (numéros, identifiants), `warnings[]`, `error{code, message_fr}`, `conflict_id` ; `server_time` ; `clock_skew_ms` |
| Délai de traitement | Délai maximal côté serveur de 25 s par lot ; les commandes non traitées dans ce délai reçoivent `RETRY_LATER` |

### 3.2 Algorithme serveur (par commande)

```text
1. Si command_id ∈ command_inbox :
     si payload_hash identique → renvoyer le résultat enregistré (même statut)
     sinon → REJECTED COMMAND_ID_REUSED + alerte de sécurité
2. Insérer command_inbox (RECEIVED) — la clé primaire garantit l'unicité même en concurrence
3. Contrôles d'authenticité :
     appareil ACTIVE, ou bloqué après occurred_at → sinon CONFLICT DEVICE_REVOKED (quarantaine)
     utilisateur actif à occurred_at → sinon CONFLICT USER_DEACTIVATED
     occurred_at ≤ now + 5 min (après correction de l'écart) → sinon REJECTED OCCURRED_AT_FUTURE
     fenêtre rétroactive (AV-078) → sinon REJECTED BACKDATE_EXCEEDED ou exigence de justification
     command_version supportée → sinon REJECTED UNSUPPORTED_VERSION
4. RBAC évalué à occurred_at (BR-ADM-004) → sinon REJECTED FORBIDDEN (audit DENIED)
5. Validation du schéma et des règles de validité → sinon REJECTED <CODE_METIER>
6. BEGIN
     gestionnaire métier : effets, contrôles d'état
       - intention sur état partagé + base_version obsolète → fusion automatique ou CONFLICT VERSION_CONFLICT
       - fait accompli + état incompatible → application + conflit informatif (APPLIED_WITH_WARNINGS)
     audit_log, domain_events, change_feed, command_inbox = APPLIED(_WITH_WARNINGS), result
   COMMIT
7. En cas d'erreur transitoire (verrou, délai) : ROLLBACK, inbox = FAILED_RETRYABLE, réponse RETRY_LATER
```

### 3.3 Catalogue des codes de résultat de synchronisation

| Code | Statut | Retentable | Signification |
|---|---|---|---|
| `COMMAND_ID_REUSED` | REJECTED | Non | Même identifiant, contenu différent |
| `DEVICE_REVOKED` | CONFLICT | Non | Appareil bloqué ou perdu avant `occurred_at` |
| `USER_DEACTIVATED` | CONFLICT | Non | Utilisateur désactivé avant `occurred_at` |
| `SESSION_EXPIRED` | (HTTP 401) | Oui, après rafraîchissement | Session de l'auteur à renouveler |
| `OCCURRED_AT_FUTURE` | REJECTED | Non | Horodatage dans le futur |
| `BACKDATE_EXCEEDED` | REJECTED | Non | Hors fenêtre rétroactive |
| `JUSTIFICATION_REQUIRED` | REJECTED | Non (ressaisie) | Saisie rétroactive > 24 h sans motif |
| `UNSUPPORTED_VERSION` | REJECTED | Non (mise à jour de l'application) | Version de commande trop ancienne |
| `FORBIDDEN` / `FORBIDDEN_SCOPE` | REJECTED | Non | Droit absent à `occurred_at` |
| `VALIDATION_ERROR:<détail>` | REJECTED | Non | Donnée invalide (codes métier des domaines) |
| `VERSION_CONFLICT` | CONFLICT | Non | Modification concurrente non fusionnable |
| `DEPENDENCY_PENDING` | RETRY_LATER | Oui | Dépendance non reçue |
| `DEPENDENCY_REJECTED` | REJECTED | Non | Dépendance rejetée |
| `SERVER_BUSY` | RETRY_LATER | Oui | Erreur transitoire |
| Avertissements | APPLIED_WITH_WARNINGS | — | `STOCK_NEGATIVE`, `PRICE_MISMATCH`, `DUPLICATE_CUSTOMER`, `CREDIT_OVER_LIMIT`, `PRODUCT_INACTIVE`, `ALLOCATION_REVOKED_CONSUMED`, `ORDER_OVER_FULFILMENT`, `CANCEL_WINDOW_EXCEEDED`, `CLOCK_SUSPECT`, `RECEIPT_QUARANTINED`, `PAYMENT_SUSPECT_DUPLICATE`, `LOT_CLOSED`, `TRANSFER_UNMATCHED` |

## 4. Reprise et attente progressive (appareil)

| Situation | Politique |
|---|---|
| Pas de réseau | Aucun envoi ; écoute des événements `online` et tentative toutes les 60 s quand l'application est au premier plan |
| Échec réseau ou HTTP 5xx, 429 | Attente `min(15 min, 5 s × 2^n) ± 20 %` (gigue), n = tentatives consécutives ; remise à zéro au premier succès |
| HTTP 401 | Rafraîchissement du jeton, puis nouvel envoi ; échec → demande de reconnexion (l'outbox est conservée) |
| `RETRY_LATER` par commande | La commande reste `PENDING_SYNC` ; elle est renvoyée au lot suivant |
| `REJECTED` / `CONFLICT` | Pas de nouvel envoi automatique (BR-SYN-009) |
| Nombre de tentatives | Illimité pour les erreurs transitoires ; au-delà de 20 tentatives en échec, l'alerte locale « problème de synchronisation » s'affiche et le serveur voit `SYNC_STALE` |

## 5. Pull

### 5.1 Flux de changements

Chaque écriture serveur ajoute des lignes à `sync.change_feed` (dans la même transaction) :

- `dataset`, `entity_type`, `entity_id`, `change_type` (`UPSERT`, `DELETE`, `SCOPE_EXIT`), `scope_type`, `scope_id`, `row_version`, `seq` ;
- une ligne par **périmètre destinataire** concerné. Exemple : une vente au PDV P ajoute une ligne `SITE:P` dans le jeu `sales_recent` et une ligne `LOCATION:emplacement` dans le jeu `stock` pour le solde modifié.

### 5.2 Requête

`GET /api/v1/sync/pull?dataset=stock&cursor=123456&limit=500`

Le serveur calcule les périmètres de l'appareil : utilisateur, appareil, sites, zones, équipe, emplacements (depuis les affectations de rôle actives). Il renvoie les changements `seq > cursor` dont `(scope_type, scope_id)` ∈ périmètres. Pour chaque `UPSERT`, il lit **l'état courant** de l'entité (projection de synchronisation, colonnes utiles seulement). Le flux ne stocke pas de copie des données.

Réponse : `changes[]` (entité, type de changement, `row_version`, données), `next_cursor`, `has_more`.

### 5.3 Sortie de périmètre et suppressions (tombstones)

| Cas | Émission | Effet sur l'appareil |
|---|---|---|
| Client réaffecté de A vers B | `SCOPE_EXIT` pour `USER:A`, `UPSERT` pour `USER:B` | A retire le compte localement, **sauf** si une commande en attente le référence (conservé jusqu'à `SYNCED`) |
| Produit désactivé | `DELETE` (jeu `catalog`) | Masqué à la saisie ; conservé pour l'affichage des opérations passées |
| Règle tarifaire terminée | `DELETE` (jeu `pricing`) après `valid_to` | Retirée du moteur local |
| Emplacement retiré du périmètre (changement de rôle) | `SCOPE_EXIT` des soldes de l'emplacement | Soldes supprimés localement |
| Suppression physique | N'existe pas pour les données métier (ADR-006) | — |

### 5.4 Chargement initial et nouveau chargement

1. Le serveur fixe `high_water = max(change_feed.seq)` **avant** de lire les données.
2. Il renvoie un instantané paginé du jeu pour le périmètre.
3. Le curseur de l'appareil est posé à `high_water`. Les changements survenus pendant le chargement seront renvoyés en double : ils sont idempotents grâce à `row_version`.
4. Un nouveau chargement est exigé si `cursor < min(seq disponible)` (flux purgé après 60 jours), ou si le schéma du jeu change de version.

## 6. Détection et résolution des conflits

| Mécanisme | Usage |
|---|---|
| **Ajout seul** (aucun conflit possible) | Faits : ventes, encaissements, pertes, visites, pointages, collectes, mouvements. Deux faits concurrents coexistent ; seuls les **effets d'état** (solde) peuvent entrer en conflit (matrice) |
| **Concurrence optimiste** (`base_version`) | Intentions sur un état partagé : commande client, compte client, étape de pipeline, lot (statut) |
| **Fusion champ par champ** | Compte client : si les champs modifiés par l'appareil n'ont pas été modifiés côté serveur depuis `base_version`, fusion automatique ; sinon `VERSION_CONFLICT` sur les seuls champs en collision |
| **Serveur autoritaire** | Affectations (titulaire, rôles), paramètres, règles : jamais modifiés hors ligne |
| **Conflit informatif** | Fait appliqué + conflit ouvert pour revue (`STOCK_NEGATIVE`, `PRICE_MISMATCH`…) |
| **Quarantaine** | Commande non appliquée (`CONFLICT`) pour les motifs d'authenticité (appareil révoqué, utilisateur désactivé) ou d'intention non fusionnable |

Le détail par entité est dans [`03-matrice-conflits.md`](03-matrice-conflits.md). Le « dernier écrit gagne » n'est **jamais** la règle par défaut (PM §30).

## 7. Versions

| Version | Portée | Usage |
|---|---|---|
| `version` (entité) | Ligne modifiable | Concurrence optimiste (`base_version` des commandes) |
| `row_version` | Ligne synchronisée | Ordre et déduplication côté appareil |
| `command_version` | Type de commande | Compatibilité N-1 (BR-SYN-016) |
| Version du schéma local | Base IndexedDB | Migrations locales à la mise à jour de l'application |
| Version d'un jeu de données | Jeu | Force un nouveau chargement si la forme change |

## 8. Pièces jointes et photos

| Étape | Règle |
|---|---|
| Capture | Compression sur l'appareil (1 280 px de grand côté, qualité 0,7, ≤ 400 Ko) ; calcul du SHA-256 ; stockage local chiffré |
| Métadonnées | Envoyées **dans** la commande (`attachment_ids`) → `attachments.attachments` `PENDING_UPLOAD` |
| Upload | `POST /api/v1/attachments/{id}/upload-session` → URL et taille de morceau (256 Ko) ; `PUT` par morceau avec `Content-Range` ; reprise à l'offset retourné par `HEAD` ; finalisation → vérification du SHA-256 et du type MIME → `AVAILABLE` |
| Priorité | Après le push des commandes ; plus petites d'abord ; pièces requises pour une validation en premier |
| Échec | Nouvel essai avec attente progressive ; après 7 jours → `MISSING` et alerte (SM-ATTACHMENT) |
| Suppression locale | Après `AVAILABLE` confirmé ; miniature conservée 7 jours |

## 9. Horloge

- À chaque push : `clock_skew_ms = server_time − device_sent_at` (latence négligée, la précision recherchée étant la minute).
- |écart| > 5 min : indicateur `clock_suspect` sur les commandes du lot, alerte `CLOCK_SKEW`, et message à l'utilisateur « l'heure de votre téléphone est incorrecte ».
- `occurred_at` n'est **jamais** corrigé silencieusement (ADR-016). Les rapports peuvent afficher une version corrigée (`occurred_at + skew`) pour les opérations marquées, avec mention.

## 10. États visibles par l'utilisateur

| État affiché | Condition | Action proposée |
|---|---|---|
| « Synchronisé » (vert) | Outbox vide ; dernier pull < 15 min | — |
| « n opérations en attente » (orange) | Outbox non vide, sans erreur | « Synchroniser maintenant » |
| « Hors ligne depuis X h » (gris) | Pas de réseau | Informatif ; bandeaux au-delà de 24 h et 48 h |
| « n opérations à vérifier » (rouge) | Au moins un `REJECTED` non pris en compte ou un `CONFLICT` | Liste ECR-SYN-01 avec explication métier et action |
| « Lecture seule » (rouge) | Autonomie dépassée (AV-009) | « Se connecter pour continuer » |
| « Mise à jour requise » | `UNSUPPORTED_VERSION` | Recharger l'application (après envoi de l'outbox) |
