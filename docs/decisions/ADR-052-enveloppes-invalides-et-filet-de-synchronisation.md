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

- Un appareil dont la file est **déjà** bloquée ne reçoit la correction qu'après fermeture complète de l'application : le
  nouveau service worker attend (`registerType: 'prompt'`) et ne s'active pas tant que la file n'est pas vidée
  (`tryApplyPendingUpdate`). À la réouverture, le premier cycle refuse la commande empoisonnée et la file repart.
- Les douze appareils de test déjà en base restent `PENDING` tant qu'ils ne sont pas refusés ou retirés (écriture en
  ligne à faire avec l'accord du porteur ; aucune commande ne peut les viser).
- Les essais d'envoi de la PWA utilisent des identifiants d'utilisateur UUIDv7, comme en production.
- Le filet ne couvre pas l'application fermée ou gelée par le système (téléphone en veille) : la synchronisation reprend
  à l'ouverture. Non vérifié sur téléphone.
