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
  participant DB as MySQL
  A->>S: POST /sync/push {device_id, batch_id, device_sent_at, commands[≤50]}
  S->>S: auth (session de l'auteur), appareil ACTIVE, version supportée
  loop pour chaque commande, dans l'ordre de device_seq
    S->>DB: SELECT command_inbox WHERE command_id
    alt déjà connue (réglée)
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
| Ordre | Croissant de `device_seq` ; le serveur traite **séquentiellement** les commandes d'un lot, trié par `device_seq`. Un lot n'a qu'un auteur, celui de la session qui l'envoie (une commande d'un autre auteur est rejetée `FORBIDDEN`, sans effet sur les autres, INV-SYN-05). Sur une tablette partagée le compteur est commun à l'appareil : les lots de deux auteurs s'entrecroisent, l'ordre garanti est celui de chaque couple (appareil, auteur) (INV-SYN-04 reformulé) et rien ne doit dépendre de l'ordre d'arrivée entre auteurs |
| Opérations en attente | `pending_by_author` (facultatif) : ce qui reste dans la file de l'appareil **après** le lot, par auteur. Le serveur en tire le total (ligne `_device` de `sync.device_sync_state`) et une ligne par auteur ; absent, rien n'est supposé (BR-DIS-014 n'y lit pas « tout est synchronisé ») |
| Dépendances | Une commande dont une dépendance est inconnue du serveur, ou reçue mais pas encore réglée (`RECEIVED`, `FAILED_RETRYABLE`), reçoit `RETRY_LATER` (`DEPENDENCY_PENDING`) ; si la dépendance est rejetée, elle reçoit `REJECTED` (`DEPENDENCY_REJECTED`) ; une dépendance réglée sans être appliquée (`CONFLICT`, quarantaine) laisse passer la dépendante (la faire attendre la bloquerait pour toujours) |
| Arrêt du lot | Après un **rejet** ou un **conflit** : aucun, chaque commande a son propre résultat ; un rejet n'arrête que les commandes qui en dépendent. Après une commande **à renvoyer** (`RETRY_LATER` : dépendance pas encore appliquée, erreur transitoire) : les commandes suivantes du lot ne sont ni traitées ni enregistrées, elles reçoivent `RETRY_LATER` (`PRECEDING_COMMAND_PENDING`) et l'appareil les renvoie dans l'ordre (INV-SYN-04 ; P5-21, AV-210). Exception : une commande à renvoyer depuis plus de `sync.retry_hold_minutes` (30 min) après sa première réception reçoit `RETRY_LATER` (`COMMAND_STALLED`) — toujours à renvoyer, jamais perdue — et ne suspend plus la suite ; le signal `SYNC_COMMAND_STALLED` est ouvert pour l'Admin (AV-217) |
| Réponse | `results[]` : `command_id`, `status` (`APPLIED`, `APPLIED_WITH_WARNINGS`, `CONFLICT`, `REJECTED`, `RETRY_LATER`), `server_refs` (numéros, identifiants), `warnings[]`, `error{code, message_fr}`, `conflict_id` ; `server_time` ; `clock_skew_ms` |
| Délai de traitement | Délai maximal côté serveur de 25 s par lot ; les commandes non traitées dans ce délai ne sont ni traitées ni enregistrées et reçoivent `RETRY_LATER` (`SERVER_BUSY`), dans l'ordre (appliqué depuis la revue de P5-21) |

### 3.2 Algorithme serveur (par commande)

```text
1. Si command_id ∈ command_inbox :
     si payload_hash différent → REJECTED COMMAND_ID_REUSED + alerte de sécurité
     si la commande est réglée → renvoyer le résultat enregistré (même statut)
     si elle est à reprendre (FAILED_RETRYABLE, ou RECEIVED réclamée depuis plus de 120 s : claimed_at) →
       la réclamer : attempts + 1, claimed_at = maintenant, à condition que (statut, attempts) n'ait pas
       changé (un seul renvoi simultané la traite) ; reprendre en 2b avec ce numéro de tentative
     si elle est en cours de traitement (RECEIVED réclamée récemment) → RETRY_LATER SERVER_BUSY
2. Insérer command_inbox (RECEIVED, tentative 1, claimed_at) — la clé primaire garantit l'unicité ;
     un envoi simultané qui la trouve déjà prise → RETRY_LATER SERVER_BUSY
   Toute écriture qui conclut l'inbox (étapes 2b à 7) est conditionnée à (RECEIVED, ce numéro de
   tentative) : si un autre traitement l'a reprise entre-temps, celui-ci répond RETRY_LATER SERVER_BUSY
   sans rien écrire ni affirmer
2b. Dépendance (depends_on) inconnue, ou reçue mais pas encore réglée (RECEIVED, FAILED_RETRYABLE) →
     inbox = FAILED_RETRYABLE, RETRY_LATER DEPENDENCY_PENDING (reprise au renvoi) ;
     dépendance REJECTED → REJECTED DEPENDENCY_REJECTED ; dépendance CONFLICT (quarantaine) → la suite
3. Contrôles d'authenticité :
     appareil ACTIVE, ou bloqué après occurred_at → sinon CONFLICT DEVICE_REVOKED (quarantaine) ;
     fait daté dans une période hors service close → quarantaine même si l'appareil est redevenu ACTIVE
     (AV-212) ; appareil PENDING → RETRY_LATER DEVICE_PENDING (AV-228)
     utilisateur actif à occurred_at → sinon CONFLICT USER_DEACTIVATED
     occurred_at ≤ now + tolérance (`sync.occurred_at_future_tolerance_minutes`, 5 min par défaut,
       AV-226 ; après correction de l'écart s'il est négatif : seule une horloge en avance est excusée)
       → sinon REJECTED OCCURRED_AT_FUTURE
     fenêtre rétroactive (AV-078) → sinon REJECTED BACKDATE_EXCEEDED ou exigence de justification
     command_version supportée → sinon REJECTED UNSUPPORTED_VERSION
4. RBAC évalué à occurred_at (BR-ADM-004) → sinon REJECTED FORBIDDEN (audit DENIED)
5. Validation du schéma et des règles de validité → sinon REJECTED <CODE_METIER>
6. BEGIN
     ligne d'inbox verrouillée (FOR UPDATE) : toujours (RECEIVED, ce numéro de tentative) ? sinon
       ROLLBACK et RETRY_LATER SERVER_BUSY (un renvoi l'a reprise) ; un renvoi qui veut la reprendre
       pendant cette transaction attend son COMMIT, puis sa réclamation échoue
     gestionnaire métier : effets, contrôles d'état
       - intention sur état partagé + base_version obsolète → fusion automatique ou CONFLICT VERSION_CONFLICT
       - fait accompli + état incompatible → application + conflit informatif (APPLIED_WITH_WARNINGS)
       - rejet métier → ROLLBACK de toute écriture du gestionnaire, inbox = REJECTED
     audit_log, domain_events, change_feed, command_inbox = APPLIED(_WITH_WARNINGS), result
   COMMIT
7. En cas d'erreur transitoire (verrou, délai) : ROLLBACK, inbox = FAILED_RETRYABLE, réponse RETRY_LATER
   (2b et 7) Première réception il y a plus de sync.retry_hold_minutes → code COMMAND_STALLED au lieu de
   DEPENDENCY_PENDING / SERVER_BUSY, signal SYNC_COMMAND_STALLED ouvert une fois (fermé quand elle se
   règle) (AV-217)
8. Après une réponse RETRY_LATER (sauf COMMAND_STALLED), les commandes suivantes du lot reçoivent
   RETRY_LATER PRECEDING_COMMAND_PENDING sans être traitées ni enregistrées (AV-210) ; au-delà de 25 s de
   traitement du lot, RETRY_LATER SERVER_BUSY, sans être traitées ni enregistrées (§3.1)
9. Restes de l'appareil (sync.device_sync_state) : déclarés par l'appareil, plus les commandes du lot
   que le serveur n'a pas réglées (RETRY_LATER), à l'auteur du lot (BR-DIS-014)
```

### 3.3 Catalogue des codes de résultat de synchronisation

| Code | Statut | Retentable | Signification |
|---|---|---|---|
| `COMMAND_ID_REUSED` | REJECTED | Non | Même identifiant, contenu différent |
| `DEVICE_REVOKED` | CONFLICT | Non | Appareil bloqué, perdu, retiré ou refusé avant `occurred_at`, ou `occurred_at` dans une période hors service close (AV-212) |
| `DEVICE_PENDING` | RETRY_LATER | Oui | Appareil en attente d'approbation : appliquée au renvoi qui suit l'approbation (AV-228) |
| `USER_DEACTIVATED` | CONFLICT | Non | Utilisateur désactivé avant `occurred_at` |
| `SESSION_EXPIRED` | (HTTP 401) | Oui, après rafraîchissement | Session de l'auteur à renouveler |
| `OCCURRED_AT_FUTURE` | REJECTED | Non | Horodatage dans le futur |
| `BACKDATE_EXCEEDED` | REJECTED | Non | Hors fenêtre rétroactive |
| `JUSTIFICATION_REQUIRED` | REJECTED | Non (ressaisie) | Saisie rétroactive > 24 h sans motif |
| `UNSUPPORTED_VERSION` | REJECTED | Non (mise à jour de l'application) | Version de commande trop ancienne |
| `FORBIDDEN` / `FORBIDDEN_SCOPE` | REJECTED | Non | Droit absent à `occurred_at` |
| `VALIDATION_ERROR:<détail>` | REJECTED | Non | Donnée invalide (codes métier des domaines) |
| `VERSION_CONFLICT` | CONFLICT | Non | Modification concurrente non fusionnable |
| `TRANSFER_RETURN_CONFLICT` | CONFLICT | Non | Quarantaine (P5-16, AV-180) : réception d'un transfert retourné, retour d'un transfert reçu ou dont une réception sans document attend l'expédition ; aucun mouvement |
| `TRANSFER_OVER_RECEIVED` | CONFLICT (hors ligne) / REJECTED (en ligne) | Non | Seconde réception d'un transfert déjà reçu, ou réception avec document d'un transfert qu'une réception sans document attend (quarantaine hors ligne) ; réception supérieure à l'expédié, sans document comprise, refusée en ligne |
| `BLIND_RECEIPT_NOT_ALLOWED`, `TRANSFER_ID_TAKEN`, `UNIT_INVALID`, `LOT_REQUIRED` | REJECTED | Non | Réception sans document refusée en ligne (P5-16) : destination non exclusive (`CUSTODY_DEVICE_MISMATCH` hors ligne, raison `LOCATION_NOT_EXCLUSIVE`), identifiant déjà pris, unité inconnue, lot manquant d'un produit suivi par lot |
| `DEPENDENCY_PENDING` | RETRY_LATER | Oui | Dépendance non reçue, ou reçue mais pas encore réglée (`RECEIVED`, `FAILED_RETRYABLE`) ; une dépendance en quarantaine (`CONFLICT`) est réglée (AV-210) |
| `PRECEDING_COMMAND_PENDING` | RETRY_LATER | Oui | Une commande précédente du lot doit d'abord être renvoyée : celle-ci n'a pas été traitée (INV-SYN-04, AV-210) |
| `DEPENDENCY_REJECTED` | REJECTED | Non | Dépendance rejetée |
| `SERVER_BUSY` | RETRY_LATER | Oui | Erreur transitoire ; commande en cours de traitement par une autre requête ; délai du lot dépassé |
| `COMMAND_STALLED` | RETRY_LATER | Oui | À renvoyer depuis plus de `sync.retry_hold_minutes` après sa première réception (dépendance qui n'arrive pas, erreur répétée) : ne suspend plus la suite du lot ; signal `SYNC_COMMAND_STALLED` pour l'Admin (AV-217) |
| `COMMAND_DISCARDED` | REJECTED | Non | Commande bloquée **écartée** par la résolution de son signal `SYNC_COMMAND_STALLED` (`sync.conflict.resolve`, `KEEP_SERVER` ou `COMPENSATE`) : jamais appliquée après coup, même si sa cause disparaît (P5-23, AV-225) |
| Avertissements | APPLIED_WITH_WARNINGS | — | `STOCK_NEGATIVE`, `PRICE_MISMATCH`, `DUPLICATE_CUSTOMER`, `CREDIT_OVER_LIMIT`, `PRODUCT_INACTIVE`, `ALLOCATION_REVOKED_CONSUMED`, `ALLOCATION_RELEASE_MISMATCH`, `ALLOCATION_EXCEEDED`, `ALLOCATION_OVERCOMMITTED`, `CUSTODY_DEVICE_MISMATCH`, `ORDER_OVER_FULFILMENT`, `CANCEL_WINDOW_EXCEEDED`, `CANCEL_SESSION_CLOSED` (annulation directe dans le délai dont la session de caisse d'un encaissement de la vente est close ou absente à l'heure de l'annulation : transformée en demande, BR-VEN-028, P5-14), `CLOCK_SUSPECT`, `RECEIPT_QUARANTINED`, `PAYMENT_SUSPECT_DUPLICATE`, `LOT_CLOSED`, `TRANSFER_UNMATCHED` (réception sans document appliquée et non encore rapprochée, P5-16 ; le conflit de délai est ouvert plus tard par la tâche `inventory.transfers.unmatched_sweep`), `TRANSFER_OVER_RECEIVED` (réception hors ligne au-delà de l'expédié, appliquée, BR-STK-021, P5-16), `VERSION_CONFLICT` (collision de champs d'un compte client, fusionnée automatiquement ; conflit informatif — matrice des conflits), `OVER_RECEIPT` (réception hors ligne au-delà du reliquat, P6-05), `RECEIPT_PHOTO_MISSING` (réception d'achat au-delà du seuil de photo, sans photo : appliquée et signalée au Resp. achats, AV-246, MP-04), `INCUBATION_BALANCE_ADJUSTED` (éclosion hors ligne complétée en œufs non éclos, P7-08), `ANONYMOUS_UNPAID` (vente anonyme hors ligne non intégralement payée, AV-137, P4-04), `LOT_NOT_SELLABLE` (animaux vendus depuis un lot qui n'était pas « en vente », BR-PRD-010, P4-04), `PRICE_OVERRIDE_EXCEEDS_LIMIT` (dérogation de prix au-delà du plafond ou sans prix catalogue : validation `PRICE_OVERRIDE` demandée, P4-04), `CASH_SESSION_CONCURRENT_OPEN` (ouverture de caisse hors ligne fusionnée dans une session existante ou décalée après la session de la veille close depuis, AV-154, AV-167, AV-168, P5-12), `CASH_SESSION_CONCURRENT_CLOSE` (clôture de caisse hors ligne d'une session qui n'est plus ouverte, ou datée avant son ouverture : comptage conservé comme observation, AV-169, P5-12), `CASH_ACCOUNT_INACTIVE` (ouverture hors ligne d'une caisse désactivée depuis, P5-12), `CASH_SESSION_SITE_CLOSED` (ouverture hors ligne sur un site fermé depuis, P5-12), `CASH_SESSION_CLOSE_BEFORE_MOVEMENTS` (clôture hors ligne datée avant un mouvement déjà enregistré : appliquée, jamais validée d'office, AV-171, P5-12), `CASH_NEGATIVE` (envoi de remise hors ligne qui rend une caisse négative, BR-FIN-012, P5-15), `CASH_TRANSFER_PAIR_NOT_ALLOWED` (envoi hors ligne entre deux types de comptes non admis, AV-158, P5-15), `CASH_TRANSFER_DISCREPANCY` (montant reçu différent de l'envoi : validation `CASH_TRANSFER_DISCREPANCY` demandée, P5-15), `CASH_TRANSFER_RECEIVED_AFTER_CANCEL`, `CASH_TRANSFER_CANCEL_AFTER_RECEIVE`, `CASH_TRANSFER_RECEIVED_TWICE` (courses hors ligne d'une remise conservées en observation, sans mouvement, AV-173, P5-15), `CASH_SESSION_MISSING` (encaissement en espèces au PDV saisi hors ligne sans session couvrant son heure, appliqué, BR-DIS-005, AV-184, P5-14) |

## 4. Reprise et attente progressive (appareil)

| Situation | Politique |
|---|---|
| Pas de réseau | Aucun envoi ; écoute des événements `online` et tentative toutes les 60 s quand l'application est au premier plan |
| Échec réseau ou HTTP 5xx, 429 | Attente `min(15 min, 5 s × 2^n) ± 20 %` (gigue), n = tentatives consécutives ; remise à zéro au premier succès |
| HTTP 401 | Rafraîchissement du jeton, puis nouvel envoi ; échec → demande de reconnexion (l'outbox est conservée) |
| `RETRY_LATER` par commande | La commande reste `PENDING_SYNC` ; elle est renvoyée au lot suivant |
| `REJECTED` / `CONFLICT` | Pas de nouvel envoi automatique (BR-SYN-009) |
| Nombre de tentatives | Illimité pour les erreurs transitoires ; au-delà de 20 tentatives en échec, l'alerte locale « problème de synchronisation » s'affiche et le serveur voit `SYNC_STALE`. Côté serveur, une commande à renvoyer depuis plus de `sync.retry_hold_minutes` est signalée (`COMMAND_STALLED`, `SYNC_COMMAND_STALLED`) et ne retient plus la file (AV-217) ; un `RETRY_LATER` partout dans un lot ne se renvoie pas aussitôt |

## 5. Pull

### 5.1 Flux de changements

Chaque écriture serveur ajoute des lignes à `sync.change_feed` (dans la même transaction) :

- `dataset`, `entity_type`, `entity_id`, `change_type` (`UPSERT`, `DELETE`, `SCOPE_EXIT`), `scope_type`, `scope_id`, `row_version`, `seq` ;
- une ligne par **périmètre destinataire** concerné. Exemple : une vente au PDV P ajoute une ligne `SITE:P` dans le jeu `sales_recent` et une ligne `LOCATION:emplacement` dans le jeu `stock` pour le solde modifié.

### 5.2 Requête

`GET /api/v1/sync/pull?dataset=stock&cursor=123456&limit=500`

Le serveur calcule les périmètres de l'appareil : utilisateur, appareil, sites, zones, équipe, emplacements (depuis les affectations de rôle actives). Il renvoie les changements `seq > cursor` dont `(scope_type, scope_id)` ∈ périmètres. Pour le jeu `production` (P7-12), les sites du périmètre sont les **fermes** qu'atteint `production.lot.read` : toutes pour une portée `ALL` ou une affectation globale (Responsable production), la ferme ou les fermes de la zone sinon ; le site d'une affectation sans ce droit (magasinier d'une ferme) n'y donne pas accès. Même règle en P4-11 pour les lignes `SITE` des jeux `sales_recent` (`sales.sale.read`) et `cash` (`finance.cash.read`), tous types de site ; les lignes `LOCATION` du jeu `orders` ne vont qu'aux emplacements des sites qu'atteint `sales.order.read` (un commercial `OWN` reçoit ses commandes par ses lignes `USER`, jamais celles des autres par l'emplacement). Un module dont les écritures sont nombreuses publie en fin de commande : `sales` part de ce que la commande a écrit (`command_id`) et suit les liens commande ↔ ventes ↔ encaissements (P4-11). Pour chaque `UPSERT`, il lit **l'état courant** de l'entité (projection de synchronisation, colonnes utiles seulement). Le flux ne stocke pas de copie des données. Pour un appareil connu, chaque pull enregistre `last_pull_at` sur les lignes `_device` et `_a:<auteur>` de `sync.device_sync_state` (état technique, P5-19, AV-202 : fraîcheur) ; `last_push_at` et `pending_reported` n'y sont pas touchés.

Réponse : `changes[]` (entité, type de changement, `row_version`, données), `next_cursor`, `has_more`.

### 5.3 Sortie de périmètre et suppressions (tombstones)

| Cas | Émission | Effet sur l'appareil |
|---|---|---|
| Client réaffecté de A vers B | `SCOPE_EXIT` pour `USER:A`, `UPSERT` pour `USER:B` | A retire le compte localement, **sauf** si une commande en attente le référence (conservé jusqu'à `SYNCED`) |
| Produit désactivé | `DELETE` (jeu `catalog`) | Masqué à la saisie ; conservé pour l'affichage des opérations passées |
| Règle tarifaire terminée | `DELETE` (jeu `pricing`) après `valid_to` | Retirée du moteur local |
| Emplacement retiré du périmètre (changement de rôle) | `SCOPE_EXIT` des soldes de l'emplacement | Soldes supprimés localement |
| Quota libéré ou révoqué ; session de caisse validée ; remise reçue, close ou annulée (P5-18, AV-193) | `SCOPE_EXIT` (jeux `allocations`, `cash`) | Retiré localement |
| Version d'un paramètre visible remplacée ; politique retirée (P5-18, AV-196) | `DELETE` (jeux `me`, `policies`) | Seule la version en vigueur reste sur l'appareil |
| Appareil désigné d'un PDV changé (P5-18, AV-195) | `UPSERT` de `POINT_OF_SALE` (jeu `org`) et de l'emplacement de vente, sans `SCOPE_EXIT` | L'ancien appareil apprend qu'il n'est plus désigné |
| Suppression physique | N'existe pas pour les données métier (ADR-006) | — |

### 5.4 Chargement initial et nouveau chargement

1. Le serveur fixe `high_water = max(change_feed.seq)` **avant** de lire les données.
2. Il renvoie un instantané paginé du jeu pour le périmètre.
3. Le curseur de l'appareil est posé à `high_water`. Les changements survenus pendant le chargement seront renvoyés en double : ils sont idempotents grâce à `row_version`.
4. Un nouveau chargement est exigé si `cursor < min(seq disponible)` (flux purgé après 60 jours), ou si le schéma du jeu change de version.

**Implémentation actuelle (P0 à P5)** : il n'y a pas d'instantané séparé. Un appareil neuf lit le flux depuis `cursor = 0` ; chaque ligne projette l'état **courant** de son entité. Depuis P5-18 (RISK-23), le pull **dédoublonne chaque page** : seule la dernière ligne de chaque (type d'entité, entité, portée) y est servie — les précédentes projetteraient le même état courant ou seraient annulées par une sortie plus récente ; un quota consommé quarante fois n'occupe ainsi qu'une ligne. Entre deux pages, une entité peut encore revenir (sans effet). Les référentiels semés sont publiés une fois par le seed : la purge du flux (BR-SYN-015), quand elle sera codée, exigera l'instantané ci-dessus ou une republication (AV-196). **Curseur retenu** (P5-23, AV-198) : `seq` est attribué à l'insertion, pas à la validation ; une ligne validée après une ligne de numéro supérieur serait sautée par un curseur posé sur le dernier numéro lu. `next_cursor` ne dépasse donc jamais un **trou récent** de la numérotation : un numéro absent suivi d'une ligne écrite il y a moins de `sync.pull_settle_seconds` (120 s) peut encore se remplir ; au-delà, il est tenu pour une transaction annulée. La page est servie entière ; ses lignes au-delà du curseur le sont de nouveau au pull suivant (sans effet : état courant) ; `has_more` est faux tant que le curseur est retenu. L'âge est jugé par l'horloge de la base (`recorded_at`). Risque résiduel : une transaction plus longue que la fenêtre. La position des consommateurs d'événements suit la même règle.

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

**Traitement manuel (P5-17, SM-CONFLICT).** `sync.conflict.resolve` et `sync.conflict.dismiss`, en ligne seulement, sont une **clôture administrative tracée** : décision (`ACCEPT_CLIENT`, `KEEP_SERVER`, `MERGE`, `COMPENSATE`), motif et références des documents de régularisation. Le serveur ne rejoue aucune commande en quarantaine et ne crée aucun document ; la commande reste `CONFLICT` dans l'inbox (AV-190). La file `GET /sync/conflicts` montre à chaque utilisateur les conflits dont le rôle propriétaire est l'un des siens, dans la portée de `sync.conflict.resolve` sur le site et l'auteur de la commande d'origine (AV-191). **DÉDUIT** (AV-190 à AV-192 ; **À VALIDER**).

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
| Capture | Recodage sur l'appareil en JPEG (1 280 px de grand côté, qualité 0,7 puis par paliers, ≤ 400 Ko ; métadonnées EXIF retirées) ; calcul du SHA-256 ; stockage local, non chiffré pour l'instant comme la file des opérations (AV-287) |
| Métadonnées | Commande **séparée** `attachments.attachment.register`, placée juste avant l'opération dans la file, **sans** `depends_on` (un refus de la pièce ne fait jamais refuser le fait, BR-SYN-007) → `attachments.attachments` `PENDING_UPLOAD`. Une réception **cite** sa photo dans `attachment_ids` ; une perte ou une mortalité la rattache par son propriétaire (`STOCK_LOSS`), sans la citer (ADR-046) ; une dépense ou une facture fournisseur cite son justificatif (`EXPENSE`, `SUPPLIER_INVOICE`, ADR-047 §3) |
| Upload | Une fois l'enregistrement accepté : `POST /api/v1/attachments/{id}/upload-session` → octets déjà reçus et taille de morceau recommandée (256 Ko ; l'appareil envoie 128 Ko) ; `PUT` par morceau avec `Content-Range` ; reprise à l'offset retourné ; par l'auteur seul ; finalisation → vérification du SHA-256 et de la signature du fichier → `AVAILABLE`, sinon `QUARANTINED` ; une pièce qui n'accepte plus d'octets rend son statut (`details.upload_status`) |
| Priorité | Après le push des commandes ; plus petites d'abord ; budget d'octets par cycle (la priorité des pièces exigées par une validation n'est pas encore faite) ; une coupure pendant une pièce la reporte et laisse le tirage se faire |
| Échec | Nouvel essai avec attente progressive ; refus définitif seulement sur un code d'erreur connu du serveur ; après 7 jours → `MISSING` et alerte (SM-ATTACHMENT, P9, AV-290) |
| Suppression locale | Octets retirés après `AVAILABLE` confirmé, ou quand la pièce est refusée ; la fiche reste (pas de miniature conservée) |

## 9. Horloge

- À chaque push : `clock_skew_ms = server_time − device_sent_at` (latence négligée, la précision recherchée étant la minute).
- |écart| > seuil (`sync.clock_skew_flag_minutes`, 5 min par défaut, lu une fois par lot à l'heure serveur de la réception ; P5-23, AV-216) : indicateur `clock_suspect` sur les commandes du lot, décision figée dans l'inbox (`sync_command_inbox.clock_suspect`) et relue par tous les documents (`[STD-ORIGIN]`), alerte `CLOCK_SKEW`, et message à l'utilisateur « l'heure de votre téléphone est incorrecte ». L'écart est borné à ±2 147 483 647 ms (AV-227).
- `occurred_at` n'est **jamais** corrigé silencieusement (ADR-016). Les rapports peuvent afficher une version corrigée (`occurred_at + skew`) pour les opérations marquées, avec mention.
- Contrôle de date future (INV-GLO-02) : `occurred_at + min(0, skew)` — seule une horloge **en avance** à l'envoi est excusée ; une horloge en retard à l'envoi (qui a reculé depuis la saisie) ne rend jamais future une date qui ne l'était pas (revue de P5-21).

## 10. États visibles par l'utilisateur

| État affiché | Condition | Action proposée |
|---|---|---|
| « Synchronisé » (vert) | Outbox vide ; dernier pull < 15 min | — |
| « n opérations en attente » (orange) | Outbox non vide, sans erreur | « Synchroniser maintenant » |
| « Hors ligne depuis X h » (gris) | Pas de réseau | Informatif ; bandeaux au-delà de 24 h et 48 h |
| « n opérations à vérifier » (rouge) | Au moins un `REJECTED` non pris en compte ou un `CONFLICT` | Liste ECR-SYN-01 avec explication métier et action |
| « Lecture seule » (rouge) | Autonomie dépassée (AV-009) | « Se connecter pour continuer » |
| « Mise à jour requise » | `UNSUPPORTED_VERSION` | Recharger l'application (après envoi de l'outbox) |
