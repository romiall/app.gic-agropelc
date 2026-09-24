# D14 — Synchronisation (SYN)

> Module de code : `sync` (serveur) + couche de synchronisation de la PWA (client).
> Spécification technique complète : [`../../06-offline-sync/`](../../06-offline-sync/). Décisions : ADR-001, ADR-007, ADR-016.
> Ce fichier décrit le **comportement fonctionnel** visible par les utilisateurs et les règles métier de la synchronisation.

---

## 1. Objectif

Remonter vers le serveur, **sans perte ni doublon**, toutes les opérations saisies sur les appareils, quel que soit l'état du réseau (CM §36–§39). Garantir à l'utilisateur de savoir si son travail est bien parti, et donner à la direction une vision fiable de ce qui est remonté ou non.

## 2. Acteurs

Tous les utilisateurs d'appareils, `ADMIN` (supervision, conflits techniques), responsables métier (conflits métier de leur domaine), `system`.

## 3. Principales entités

| Entité | Support | Rôle |
|---|---|---|
| Commande locale (outbox) | IndexedDB de l'appareil | Opération en attente d'envoi |
| Commande reçue (inbox) | `sync.command_inbox` | Réception idempotente et résultat |
| Conflit | `sync.sync_conflicts` | Situation à résoudre, avec décision tracée |
| Flux de changements | `sync.change_feed` | Changements à télécharger, par périmètre |
| État de synchronisation d'un appareil | `sync.device_sync_state` | Curseurs, dernière synchronisation, séquence, écart d'horloge |

## 4. Cas d'usage

| ID | Cas d'usage | Mécanisme | Acteur | Hors ligne |
|---|---|---|---|---|
| UC-SYN-01 | Envoyer les opérations en attente | `POST /api/v1/sync/push` (automatique) | Appareil | n/a |
| UC-SYN-02 | Recevoir les changements de son périmètre | `GET /api/v1/sync/pull` (automatique) | Appareil | n/a |
| UC-SYN-03 | Initialiser un appareil (chargement initial) | `POST /api/v1/sync/bootstrap` | Appareil | Non |
| UC-SYN-04 | Voir l'état de synchronisation et les opérations en attente, rejetées ou en conflit | ECR-SYN-01 | Tous | **Oui** |
| UC-SYN-05 | Relancer manuellement la synchronisation | bouton « Synchroniser » | Tous | n/a |
| UC-SYN-06 | Accuser réception d'une opération rejetée, puis ressaisir si besoin | local | Auteur | **Oui** |
| UC-SYN-07 | Résoudre un conflit | `sync.conflict.resolve` | ADMIN, responsable concerné | Non |
| UC-SYN-08 | Superviser les appareils (fraîcheur, erreurs, trous de séquence, horloge) | ECR-SYN-02 | ADMIN, DIRECTION | Non |

## 5. Entrées

Commandes créées sur les appareils ; changements serveur ; décisions de résolution.

## 6. Sorties

Résultats par commande (numéros officiels, identifiants, avertissements), données de périmètre à jour sur les appareils, conflits, alertes de synchronisation, indicateurs de fraîcheur.

## 7. Règles métier

| ID | Règle | Statut |
|---|---|---|
| BR-SYN-001 | **Chemin d'écriture unique** : toute écriture, en ligne ou hors ligne, est une commande identifiée par un UUIDv7 généré à la création (`command_id`). En ligne, la commande part immédiatement ; hors ligne, elle attend dans l'outbox. | D (ADR-007) |
| BR-SYN-002 | **Idempotence** : le serveur n'applique qu'une fois un `command_id`. Un renvoi du même identifiant avec le même contenu renvoie le résultat enregistré. Le même identifiant avec un contenu différent (empreinte différente) est rejeté (`COMMAND_ID_REUSED`) et produit une alerte de sécurité. | C (PM §29 ; INV-SYN-01) |
| BR-SYN-003 | Chaque appareil numérote ses commandes par une séquence strictement croissante (`device_seq`). Un trou non comblé après 24 h lève `DEVICE_SEQ_GAP`, signe possible de perte de données ou de suppression locale. | D (PM §37 « synchronisation falsifiée ») |
| BR-SYN-004 | Le serveur applique les commandes d'un appareil **dans l'ordre de `device_seq`**. Une commande qui dépend d'une autre (`depends_on`) attend son application. Si la dépendance est rejetée, la commande dépendante est rejetée avec `DEPENDENCY_REJECTED`. | D |
| BR-SYN-005 | États côté appareil : `LOCAL_ONLY` (brouillon non soumis), `PENDING_SYNC`, `SYNCING`, `SYNCED`, `SYNCED_WITH_WARNING`, `CONFLICT`, `REJECTED`. | C (PM §5) / D (`SYNCED_WITH_WARNING`) |
| BR-SYN-006 | Résultats côté serveur. `APPLIED` → `SYNCED`. `APPLIED_WITH_WARNINGS` : appliquée, avec anomalie ou conflit informatif ouvert → `SYNCED_WITH_WARNING`. `CONFLICT` : non appliquée, en attente d'une décision humaine → `CONFLICT`. `REJECTED` : refus définitif, sans effet → `REJECTED`. `RETRY_LATER` : erreur transitoire → reste `PENDING_SYNC` avec attente progressive. | D |
| BR-SYN-007 | Une opération constatant un **fait physique ou financier accompli** (vente, encaissement, perte, réception, expédition, consommation, collecte) n'est **jamais rejetée pour une raison d'état métier** : stock insuffisant, prix changé, allocation révoquée, produit désactivé. Elle est appliquée avec avertissement et conflit à résoudre. Elle ne peut être rejetée ou mise en conflit que pour une raison d'**authenticité, d'autorisation ou de validité** : appareil révoqué, utilisateur désactivé avant `occurred_at`, données invalides. | D (C-08 ; CM §40) |
| BR-SYN-008 | Une opération d'**intention** sur un état partagé (modifier une commande, changer une étape de pipeline, réaffecter) utilise la concurrence optimiste (`base_version`). Si la version a changé, le serveur applique une fusion automatique quand la règle du type le permet ; sinon il produit `CONFLICT`. | C (PM §29, §30) |
| BR-SYN-009 | Quand une commande est `REJECTED` ou `CONFLICT`, l'appareil **annule ses effets locaux** (ex. le stock local est rétabli), conserve l'opération visible avec le motif, en clair, jusqu'à ce que l'utilisateur en prenne connaissance, et propose une action (ressaisir, contacter le responsable). | D (UX CM §3) |
| BR-SYN-010 | Déclencheurs de synchronisation : ouverture de l'application, retour du réseau, après chaque commande si en ligne, toutes les 5 minutes quand l'application est ouverte et en ligne, bouton manuel, synchronisation en arrière-plan si le navigateur la supporte. | D (CM §36) |
| BR-SYN-011 | Le serveur mesure l'**écart d'horloge** de l'appareil à chaque envoi (heure serveur − heure d'envoi de l'appareil). Au-delà de 5 minutes, les commandes du lot portent l'indicateur `clock_suspect` et l'alerte `CLOCK_SKEW` est levée. Une commande dont `occurred_at` dépasse de plus de 5 minutes l'heure serveur (après correction de l'écart mesuré) est rejetée (`OCCURRED_AT_FUTURE`). | C (CM §38) / D (ADR-016) |
| BR-SYN-012 | `occurred_at` ne peut précéder `client_created_at` que dans la fenêtre de saisie rétroactive (AV-078). Au-delà de 24 h, une justification est obligatoire. | AV-078 |
| BR-SYN-013 | Une commande en outbox n'est **jamais** supprimée automatiquement tant qu'elle n'est pas `SYNCED`, ou `REJECTED` et prise en compte. La déconnexion d'un utilisateur ayant des commandes en attente est déconseillée (avertissement) mais n'efface rien. | C (CM §40) |
| BR-SYN-014 | Sur un appareil partagé, chaque commande garde son auteur. Les commandes d'un utilisateur sont envoyées avec **la session de cet utilisateur**. Si sa session a expiré, elles attendent sa prochaine connexion sur l'appareil, et une alerte est levée après 24 h. | D (AV-007) |
| BR-SYN-015 | Le téléchargement est **incrémental** par jeu de données, avec curseur. Un appareil dont le curseur est plus ancien que la rétention du flux de changements (60 jours) doit refaire un chargement initial du jeu concerné. | D (PM §29) |
| BR-SYN-016 | Une nouvelle version de l'application doit pouvoir envoyer les commandes créées par la version précédente : chaque commande porte `command_version`, et le serveur accepte au moins la version N-1 pendant 30 jours après la publication de N. | D |
| BR-SYN-017 | La résolution de chaque type de conflit revient à un rôle défini dans la matrice des conflits. Toute résolution est tracée : décision, auteur, motif, effets compensatoires éventuels. | C (PM §30) |
| BR-SYN-018 | L'utilisateur voit en permanence : « Synchronisé » ; « n opérations en attente » ; « Erreur : n opérations à vérifier » ; « Hors ligne depuis X h ». | C (PM §29 « états utilisateur ») |

## 8. Validations

Voir la spécification de l'enveloppe de commande et des erreurs dans [`../../06-offline-sync/02-synchronisation.md`](../../06-offline-sync/02-synchronisation.md) : appareil actif, session valide, séquence, version de commande supportée, empreinte, taille du lot.

## 9. Dépendances

ADM (appareils, sessions, RBAC) ; toutes les commandes de tous les modules transitent par la synchronisation.

## 10. Événements produits

`CommandApplied` (technique, non publié aux modules), `CommandRejected`, `SyncConflictDetected`, `SyncConflictResolved`, `DeviceSequenceGapDetected`, `ClockSkewDetected`, `DeviceSyncStale`.

## 11. Événements consommés

`DeviceBlocked`, `UserDeactivated` (mise en quarantaine des commandes concernées) ; tous les changements de données publiés dans le flux de changements par les modules.

## 12. Fonctionnement hors ligne

C'est l'objet même du domaine. Hors ligne prolongé : autonomie maximale (AV-009, défaut 7 jours) ; bandeau d'avertissement à partir de 48 h ; alertes serveur `SYNC_STALE` après 24 h. Détail dans [`../../06-offline-sync/01-architecture-offline.md`](../../06-offline-sync/01-architecture-offline.md) §8.

## 13. Permissions

La synchronisation de ses propres commandes est implicite pour tout utilisateur actif sur un appareil actif. `sync.monitor.read` (supervision), `sync.conflict.resolve` (portée selon le domaine du conflit).

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Coupure au milieu d'un envoi | Idempotence : l'appareil renvoie le lot ; les commandes déjà appliquées renvoient leur résultat enregistré. |
| Appareil réinitialisé avec des commandes non envoyées | Perte locale irréversible ; détectée par le trou de séquence (BR-SYN-003) ; enquête et régularisation par inventaire. |
| Saturation du stockage local | Alerte locale à 80 % du quota ; purge des données de consultation les plus anciennes, **jamais** de l'outbox. |
| Serveur indisponible | `RETRY_LATER` avec attente progressive ; l'activité continue hors ligne. |
