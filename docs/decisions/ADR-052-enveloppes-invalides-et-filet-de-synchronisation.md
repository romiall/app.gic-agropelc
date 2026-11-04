# ADR-052 — Enveloppes de commande invalides refusées sur l'appareil, UUIDv7 exigé à la connexion, filet de synchronisation toutes les 5 minutes

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; AV-498 et AV-499 ouverts avec leur défaut)
- **Date** : 04/11/2026
- **Précise** : ADR-002 (UUIDv7), ADR-006 (rien ne disparaît), ADR-021 (logique partagée), ADR-037 (synchronisation durcie)
- **Questions liées** : AV-498, AV-499 ; [`02-synchronisation.md`](../06-offline-sync/02-synchronisation.md) §3.1 et §4

## Contexte

Constaté en ligne le 04/11/2026 par un diagnostic en lecture seule (`deploy/hostinger/diag-sync.mjs`) : l'approbation des
appareils restait « en attente » même après « Forcer la synchronisation ». Le serveur était sain (aucune commande en
échec, approbations appliquées en moins de 10 s quand elles arrivaient), mais aucune commande de l'appareil de l'Admin
n'était arrivée depuis le 02/11 à 21 h 32 : chaque cycle, le serveur refusait le lot entier (`HTTP 400 VALIDATION_ERROR`,
127 refus).

Le serveur valide un lot **en bloc** (`pushRequestSchema`, UUIDv7 pour l'appareil, la commande, l'auteur et l'agrégat) : une
seule enveloppe invalide fait refuser les 50 commandes. Or douze appareils de test, enrôlés le 02/11 avec des UUIDv4, étaient
affichés à l'Admin, qui pouvait les approuver ou les refuser : ces décisions produisaient une enveloppe invalide.
La connexion acceptait n'importe quel UUID, alors que le jeton d'accès refuse déjà un identifiant d'appareil qui n'est pas
un UUIDv7. Le moteur de l'appareil traitait toute erreur HTTP comme « serveur joignable, nouvel essai » : la commande
empoisonnée restait en tête de file et bloquait toutes les suivantes, sans message pour l'utilisateur.

Le besoin voisin, exprimé le même jour : des opérations saisies hors ligne ne doivent pas rester des jours sur l'appareil
parce que personne n'a rouvert l'écran.

## Décision

1. **Vérification locale avant l'envoi** (`apps/pwa/src/sync/envelope.ts`) : chaque enveloppe du lot est validée avec le
   schéma partagé du serveur (`rawCommandEnvelopeSchema`, `@gic/contracts`). Celle qui échouerait passe à `REJECTED` sur
   l'appareil, avec un motif en français sans le contenu de l'opération, ainsi que les commandes qui en dépendent (le
   serveur ne recevrait jamais leur dépendance). Elles restent dans la file, visibles et « classables » (rien ne disparaît,
   BR-SYN-009). Le reste du lot part. Un lot refusé en bloc alors que chaque enveloppe est valide (version de
   l'application plus ancienne que le serveur, identifiant d'appareil non conforme) ne peut pas être attribué à une commande :
   il n'est pas modifié, et le détail du serveur est consigné dans la console de l'appareil.
2. **Connexion** : `device_id` doit être un UUIDv7 (même règle que le jeton, le lot et les agrégats). Un autre UUID est
   refusé par `400 VALIDATION_ERROR` et n'enrôle aucun appareil.
3. **Lecture des appareils** : un appareil dont l'identifiant n'est pas un UUIDv7 est rendu avec `commandable: false` et
   toutes ses actions à faux ; l'écran Appareils l'explique et ne propose aucune décision.
4. **Filet de synchronisation** (`SyncEngine`, `heartbeatMs`, 5 min) : si aucun cycle n'a eu lieu depuis 5 min — onglet
   masqué, donc sans cycle périodique (NFR-09) —, un cycle part, pourvu que `navigator.onLine` soit vrai. Chaque cycle,
   d'où qu'il vienne, repousse le filet ; il ne double donc jamais la cadence de 30 s du premier plan. Le cycle juge
   lui-même de la joignabilité réelle du serveur.
5. **Identifiants des écrans de RP-4** : la revue contradictoire du 04/11 a trouvé une seconde source d'enveloppes
   invalides, en ligne depuis le 03/11 : cinq envois (note de direction, règle d'alerte, accusé de notification, vue
   sauvegardée, export) fabriquaient leur `aggregate_id` avec `crypto.randomUUID()` (UUIDv4). Ils utilisent maintenant
   `idGenerator` (UUIDv7) et une règle ESLint interdit `crypto.randomUUID()` dans `apps/pwa/src`. On ne sait pas
   laquelle des deux sources a empoisonné la file de l'Admin ; la vérification locale guérit les deux.
6. **Livraison** : `build-bundle.ps1` refuse de construire le paquet sans `sw.js` (la livraison du 03/11 est partie
   sans) ou depuis un arbre de travail aux fichiers suivis modifiés (`-AllowDirty` pour passer outre) : une autre session
   peut avoir des changements non commités dans le même dossier. Livrer depuis une copie propre (`git worktree add
   --detach`).
7. **Mise à jour à la demande** (AV-505) : un bandeau « nouvelle version disponible » (`UpdateBanner`) annonce la
   version qui attend et offre « Mettre à jour maintenant », avec le nombre d'opérations en attente (elles restent dans
   la base locale et partent après la mise à jour : le serveur accepte les commandes de la version précédente,
   BR-SYN-016). L'activation automatique après vidage de la file est inchangée. Sans le bandeau, un appareil à la file
   bloquée ne recevait la correction qu'après une fermeture complète de l'application.
8. **Refus en bloc signalé** (AV-506) : un lot que le serveur refuse (HTTP 400) sans qu'une commande soit désignée
   laisse un témoin sur l'appareil (`SyncMeta.push_refusal`) qu'affiche un bandeau d'alerte avec le code et le numéro de
   corrélation, effacé au premier envoi lu par le serveur. Le journal du serveur nomme désormais la méthode, le chemin
   sans paramètres, l'appareil, l'utilisateur pseudonymisé et, pour une requête mal formée, le motif rendu à l'appelant
   (`refusalLogEntry`).
9. **Numéros refusés sur l'appareil déclarés** (AV-507) : l'appareil déclare à l'envoi les `device_seq` de ses commandes
   refusées avant l'envoi (`skipped_device_seqs`, 200 au plus par envoi) ; le serveur les garde en plages
   (`sync_device_sync_state.declared_skips`) et le détecteur `sync.devices.seq_gap_check` les retire des plages
   manquantes : plus d'alerte critique `DEVICE_SEQ_GAP` pour un trou qui n'est pas une perte.

## Alternatives étudiées

- **Renvoyer le lot commande par commande après un 400** : écarté. Un 400 qui tient à l'appareil ou à l'auteur (et non à
  une commande) ferait refuser *toute* la file à tort ; seule une enveloppe désignée par la validation locale est refusée.
- **Accepter les UUID non v7 pour les appareils déjà enrôlés** : écarté, contraire à ADR-002 ; le jeton les refuse déjà.
- **Synchroniser sans application ouverte (Background Sync, Periodic Background Sync, service worker)** : impossible tant
  que la session est protégée par le PIN : le jeton de rafraîchissement n'est utilisable qu'après déverrouillage (la clé
  de la session locale en dérive). À rouvrir seulement avec un arbitrage de sécurité (jeton de synchronisation distinct,
  de portée réduite). Le serveur signale déjà à l'Admin tout appareil sans synchronisation depuis plus de 24 h.
- **Rendre la durée du filet paramétrable** (`sync.heartbeat_minutes`) : reporté ; c'est une cadence technique de la
  PWA comme les 30 s de AV-319, pas un seuil métier (AV-498).

## Conséquences

- Un appareil dont la file est **déjà** bloquée reçoit la correction en trois temps : le nouveau service worker attend
  (`registerType: 'prompt'`) et ne s'active pas tant que la file n'est pas vidée (`tryApplyPendingUpdate`), et la nouvelle
  version n'est cherchée qu'à une navigation. Ouvrir l'application, saisir le code PIN, ne rien saisir d'autre et attendre
  environ 2 minutes (le nouveau service worker se télécharge) ; la fermer complètement (toutes les fenêtres et tous les
  onglets ; sur téléphone, la retirer des applications récentes) ; la rouvrir. Le premier cycle refuse alors la commande
  empoisonnée et la file repart.
- Une commande refusée sur l'appareil n'est jamais envoyée : son `device_seq` manque au serveur, qui lève une alerte
  critique `DEVICE_SEQ_GAP` environ 24 h après le premier envoi réussi de l'appareil (BR-SYN-003). **Tant que
  l'appareil n'a pas la version qui déclare ces numéros (décision 9, livrée après la mise en ligne du 04/11/2026)**, cette
  alerte est attendue pour l'appareil de l'Admin : vérifier que le nombre de numéros manquants (`missing_from` à
  `missing_to`) correspond aux commandes refusées, puis la clore (`communication.alert.resolve`). Avec la version qui
  les déclare, y compris pour les refus d'une version antérieure, elle ne se lève plus.
- Un lot refusé en bloc par le serveur alors que chaque enveloppe est valide (cas qu'aucune donnée plausible ne
  déclenche) repart toutes les ~130 s ; l'utilisateur en est averti par le bandeau (décision 8) et le journal du serveur
  dit d'où il vient.
- Les douze appareils de test déjà en base restent `PENDING` tant qu'ils ne sont pas refusés (aucune commande ne peut
  les viser). Une commande d'installation les refuse, comme `db:approve-device` approuve le premier appareil
  (`bootstrap-legacy-device-cleanup.ts`, `deploy/hostinger/block-legacy-devices.mjs` : liste par défaut, `--apply`
  pour écrire ; même transition que « Refuser », acteur système, audit `identity.device.block`). Lancée en ligne le
  04/11/2026 avec l'accord du porteur : les douze appareils (`TestScript`, enrôlés le 02/11) sont refusés.
- Les essais d'envoi de la PWA utilisent des identifiants d'utilisateur UUIDv7, comme en production.
- Le filet ne couvre pas l'application fermée ou gelée par le système (téléphone en veille) : la synchronisation reprend
  à l'ouverture. Non vérifié sur téléphone.
