# Identifiants, types et conventions de colonnes

> Répond au PM §26 (stratégie d'identification) et fixe les conventions communes à toutes les tables du dictionnaire. Décisions : ADR-002 (identifiants), ADR-013 (monnaie et quantités), ADR-016 (temps).

---

## 1. Stratégie d'identification

### 1.1 Exigence

Le fonctionnement hors ligne impose de **créer une entité sans demander d'identifiant au serveur** (PM §26 ; REQ-201, REQ-202). Une vente créée hors ligne à 11:47 doit avoir, dès 11:47, un identifiant définitif, référençable par les lignes, les paiements et les pièces jointes créés dans la même opération.

### 1.2 Options étudiées

| Option | Génération hors ligne | Ordre temporel (localité d'index) | Stockage PostgreSQL | Fuite d'information | Verdict |
|---|---|---|---|---|---|
| UUID v4 | Oui | Non : insertions aléatoires, index B-tree fragmentés | `uuid` natif, 16 octets | Aucune | Écarté : fragmentation des index sur les tables volumineuses (registres) |
| **UUID v7** | Oui | **Oui** (48 bits de temps en tête) | `uuid` natif, 16 octets | Horodatage de création approximatif | **Retenu** |
| ULID | Oui | Oui | Pas de type natif : `bytea` ou `text` (26 caractères), conversions | Horodatage | Écarté : pas de type natif, outillage moins standard |
| Identifiant numérique séquentiel | **Non** sans serveur (ou plages pré-allouées fragiles) | Oui | `bigint` | Volume d'activité | Écarté comme clé primaire ; conservé pour des séquences serveur (§1.4) |

### 1.3 Décision

1. **Clé primaire de toute table métier : UUIDv7**, généré par le client (appareil) pour les entités créées sur l'appareil, par le serveur sinon.
2. Le serveur **n'accepte pas aveuglément** un UUID client. Il vérifie :
   - le format (version 7) ;
   - l'absence de collision (clé primaire) ;
   - que l'horodatage embarqué n'est pas plus de 24 h dans le futur par rapport à la réception (protection contre les identifiants forgés).

   L'horodatage embarqué **n'est jamais** utilisé comme heure métier : c'est `occurred_at` qui fait foi (ADR-016).
3. L'identifiant d'une **commande de synchronisation** (`command_id`) est aussi un UUIDv7, distinct de l'identifiant de l'entité créée. Une commande peut créer plusieurs entités (vente + lignes + encaissement), chacune avec son UUID fourni par le client.

### 1.4 Identifiants lisibles par les humains

| Identifiant | Attribué par | Format | Usage |
|---|---|---|---|
| **Référence locale** (`local_ref`) | Appareil, hors ligne | `{CODE_APPAREIL}-{seq6}`, ex. `PDV2-000184` ; séquence par appareil | Reçu remis au client hors ligne, recherche immédiate |
| **Numéro officiel** (`doc_number`) | Serveur, à l'application | `{TYPE}-{CODE_SITE}-{AAAA}-{seq6}`, ex. `VTE-MBP-2026-000731` (AV-077) | Document de référence ; compteur par (type, site, année) sans trou en conditions normales |
| **Séquence d'appareil** (`device_seq`) | Appareil | Entier strictement croissant | Ordre d'application et détection de trous (INV-SYN-03) |
| **Séquence de flux** (`change_feed.seq`) | Serveur | `bigserial` | Curseur de téléchargement incrémental |
| **Séquence d'audit** (`audit_log.seq`) | Serveur | `bigserial` | Ordre et chaînage |
| **Codes de référentiel** (`code`) | Humain (Admin) | `UPPER_SNAKE_CASE` ou code court, unique | Produits, sites, zones, motifs |

Préfixes `{TYPE}` : `VTE` vente, `CMD` commande client, `TRF` transfert, `PRT` perte, `INV` inventaire, `DA` demande d'achat, `BC` bon de commande, `REC` réception, `ENC` encaissement, `DEP` dépense, `FF` facture fournisseur, `PF` paiement fournisseur, `RMF` remise de fonds, `LOT` lot de production, `INC` lot d'incubation.

## 2. Types logiques

| Type logique | Type PostgreSQL | Règle |
|---|---|---|
| `uuid` | `uuid` | UUIDv7 |
| `code` | `varchar(40)` | `UPPER_SNAKE_CASE` ou alphanumérique, unique dans son référentiel |
| `label` | `varchar(200)` | Texte d'affichage |
| `text` | `text` | Texte libre (commentaires), longueur applicative ≤ 2 000 |
| `phone` | `varchar(20)` | E.164 normalisé (`+2376XXXXXXXX`) |
| `money_xaf` | `bigint` | Francs CFA entiers ; ≥ 0 sauf mention contraire (INV-GLO-06) |
| `qty` | `numeric(14,3)` | Quantité en unité de base ; entière pour les unités comptées (BR-CAT-003) |
| `rate` | `numeric(7,4)` | Taux (0,1925 = 19,25 %) |
| `ts` | `timestamptz` | Stocké en UTC ; affiché en `Africa/Douala` |
| `date` | `date` | Date métier (jour de Douala) |
| `lat`, `lng` | `numeric(9,6)` | WGS84 ; précision ≈ 0,1 m |
| `meters` | `numeric(8,1)` | Distances, précisions GPS |
| `enum(...)` | `text` + `CHECK (col IN (...))` | Plutôt que le type `ENUM` natif : ajouter une valeur ne demande qu'une migration simple |
| `json` | `jsonb` | Réservé aux charges techniques (commandes, événements, audit avant/après, définitions de vues). **Jamais** pour une donnée métier interrogée ou contrainte. |

## 3. Blocs de colonnes standard

Le dictionnaire référence ces blocs au lieu de les répéter. Un bloc s'applique **intégralement**.

### 3.1 `[STD-ID]`

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `id` | uuid | Non | fourni (client) ou `uuidv7()` (serveur) | Clé primaire |

### 3.2 `[STD-AUDIT]` — toute table modifiable

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `created_at` | ts | Non | `now()` | Insertion serveur |
| `created_by` | uuid → `identity.users` | Non | — | Auteur (utilisateur ou `system`) |
| `updated_at` | ts | Non | `now()` | Dernière modification serveur |
| `updated_by` | uuid → `identity.users` | Oui | — | Auteur de la dernière modification |
| `version` | int | Non | 1 | Concurrence optimiste, incrémentée à chaque modification |

### 3.3 `[STD-ORIGIN]` — toute ligne créée par une commande d'appareil

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `occurred_at` | ts | Non | — | **Heure métier réelle** (CM §38) |
| `client_created_at` | ts | Oui | — | Horloge de l'appareil à la saisie |
| `received_at` | ts | Oui | — | Réception de la commande par le serveur |
| `command_id` | uuid | Oui | — | Commande de synchronisation d'origine (idempotence, audit) ; unique sur les tables racines |
| `created_device_id` | uuid → `identity.devices` | Oui | — | Appareil d'origine (nul pour les opérations serveur) |
| `captured_offline` | boolean | Non | false | Saisie sans réseau |
| `clock_suspect` | boolean | Non | false | Écart d'horloge au-delà du seuil (BR-SYN-011) |
| `backdated_reason` | text | Oui | — | Justification de saisie rétroactive (> 24 h, AV-078) |

`applied_at` n'est pas répété sur chaque ligne : c'est `created_at` pour la ligne créée, et `sync.command_inbox.applied_at` pour la commande.

### 3.4 `[STD-DOC]` — document numéroté

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `doc_number` | varchar(40) | Non | attribué à l'insertion | Numéro officiel (unique) |
| `local_ref` | varchar(20) | Oui | — | Référence locale d'appareil ; unique avec `created_device_id` |
| `site_id` | uuid → `organization.sites` | Non | — | Site de rattachement (numérotation, RBAC, analyse) |

### 3.5 `[STD-CANCEL]` — document annulable par contre-écriture

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `cancelled_at` | ts | Oui | — | Heure métier de l'annulation |
| `cancelled_by` | uuid → users | Oui | — | Auteur |
| `cancel_reason_code_id` | uuid → `catalog.reason_codes` | Oui | — | Motif |
| `cancel_comment` | text | Oui | — | Commentaire |
| `cancel_approval_request_id` | uuid → `approvals.approval_requests` | Oui | — | Validation |

`CHECK` : les colonnes d'annulation sont renseignées si et seulement si le statut est un statut annulé.

## 4. Conventions de contraintes

| Convention | Règle |
|---|---|
| Clés étrangères | `ON DELETE RESTRICT` partout. Aucune suppression en cascade sur des données métier. |
| Références inter-modules | Clé étrangère **autorisée** vers les tables d'un module dont on dépend (graphe des dépendances), **en lecture**. Aucune écriture inter-schémas (INV-GLO-05). |
| Références polymorphes | `subject_type` (code) + `subject_id` (uuid), sans clé étrangère, validées par le module propriétaire (voir le modèle conceptuel §4.9) |
| Unicités partielles | `CREATE UNIQUE INDEX … WHERE status IN (...)`, pour les règles « au plus un actif » |
| Contraintes d'exclusion | `EXCLUDE USING gist` (extension `btree_gist`) pour les périodes non chevauchantes (affectations de titulaire, appartenances d'équipe) |
| Immuabilité | Déclencheur `BEFORE UPDATE` refusant la modification des colonnes immuables (liste blanche des colonnes modifiables par table) ; `BEFORE DELETE` refusant la suppression sur les tables protégées |
| Nommage | `pk_<table>`, `fk_<table>_<col>`, `uq_<table>_<cols>`, `ck_<table>_<règle>`, `ix_<table>_<cols>` |

## 5. Temps (ADR-016)

| Instant | Colonne | Source | Usage |
|---|---|---|---|
| Heure réelle de l'opération | `occurred_at` | Appareil (déclarée ; défaut = horloge appareil) | Rapports, performances, caisses, soldes à date, CA |
| Création sur l'appareil | `client_created_at` | Horloge de l'appareil | Détection de saisie rétroactive |
| Envoi du lot | `device_sent_at` (inbox) | Horloge de l'appareil | Calcul de l'écart d'horloge |
| Réception serveur | `received_at` | Horloge serveur (NTP) | Délai de synchronisation |
| Application | `applied_at` (inbox), `created_at` (ligne) | Horloge serveur | Ordre de valorisation, audit |

Jour métier = `(occurred_at AT TIME ZONE 'Africa/Douala')::date`. Les index analytiques utilisent une colonne générée `business_date` sur les tables volumineuses (ventes, mouvements).
