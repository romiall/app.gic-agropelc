# ADR-063 — Notes de direction : publication immuable, audience, accusés hors ligne

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; applique BR-NOT-006, BR-NOT-007, UC-NOT-05 et 06, AT-048 ; les choix métier sont AV-369 et AV-370, défauts paramétrables)
- **Date** : 14/10/2026 (numéro provisoire 073 de la plage 070 à 079, renuméroté ADR-063 à l'intégration du 26/10/2026 ; révisé le même jour après la revue adverse de la conception)
- **Précise** : [ADR-062](ADR-062-destinataires-notifications-push-et-escalade.md)
- **Questions liées** : AV-066, AV-369, AV-370

## Contexte

La Direction diffuse des notes ciblées (prix, instruction, procédure, information ; CM §43) à une audience (tous, rôles, sites, zones, utilisateurs). Une note ne porte aucun effet métier (BR-NOT-007) : elle peut **référencer** un objet (une règle tarifaire) sans le modifier. Elle est immuable une fois publiée (BR-NOT-006) ; on la retire par archivage ou on publie une note corrective. Une note peut exiger un accusé de lecture, lisible et accusable hors ligne (UC-NOT-06, AT-048). Le dictionnaire donne trois tables (`internal_notes`, `note_audiences`, `note_acknowledgements`) et un statut `DRAFT`, `PUBLISHED`, `ARCHIVED`.

Faits : la spécification de synchronisation donne au jeu `comms` la portée `USER` ; le flux n'admet que `GLOBAL`, `SITE`, `ZONE`, `TEAM`, `USER`, `DEVICE`, `LOCATION` ; un type d'audience `ROLE` n'est pas une portée du flux. Le modèle relationnel classe `internal_notes` en transaction : pas de suppression physique (INV-GLO-03) ; la table de suppression technique (`03-historisation-suppression.md` §3) n'en liste aucune ligne libre.

## Décision

1. **Cycle** : `DRAFT` → `PUBLISHED` → `ARCHIVED`.
   - Le brouillon n'est visible que de son auteur ; il se crée et se modifie (`communication.note.save_draft`, permission `comm.note.publish`). Un brouillon abandonné passe à `ARCHIVED` : rien n'est supprimé physiquement.
   - La publication (`communication.note.publish`) fige titre, corps, catégorie, audience, référence, expiration et option d'accusé ; **plus aucune colonne de la note ni aucune ligne de son audience** n'est modifiable, en base comme en commande : les déclencheurs d'immuabilité couvrent `internal_notes` et `note_audiences` (INSERT, UPDATE et DELETE refusés dès que la note n'est plus `DRAFT`). L'archivage est un changement de statut.
2. **Publication** : réservée à `comm.note.publish` (Direction). Validations (D13 §8) : titre et corps non vides, audience non vide, expiration postérieure à la publication. Une note corrective est une **nouvelle** note qui référence l'ancienne (`related_entity_type = 'INTERNAL_NOTE'`). La clé primaire de l'audience n'admet pas de colonne nulle : `audience_ref` vaut `'*'` pour `ALL`.
3. **Audience et lecture en ligne** : la note est visible d'un utilisateur si une ligne d'audience le désigne — `ALL`, un de ses rôles actifs, un de ses sites ou zones d'affectation (avec descendantes), ou lui-même ; l'audience est évaluée **à la lecture** (`GET /notes`, `GET /notes/{id}`), de sorte qu'une affectation postérieure à la publication voit la note.
4. **Notification et jeu hors ligne : audience résolue à la publication.** À la publication, le résolveur (ADR-062 §2) calcule les utilisateurs touchés ; chacun reçoit une notification `IN_APP` et **une ligne de flux en portée `USER`** du jeu `comms`. Un utilisateur affecté après la publication voit la note en ligne (§3) mais ne la reçoit pas par le flux tant qu'elle n'est pas republiée (limite assumée, AV-369 ; un consommateur des affectations pourra la lever).
5. **Accusé** : `communication.note.acknowledge` (permission `comm.note.read`) écrit `note_acknowledgements` (`read_at`, `acknowledged_at`, `command_id`), idempotent par (note, utilisateur), admis hors ligne. L'accusé d'une note **archivée ou expirée depuis** la lecture hors ligne est enregistré à sa date de fait, jamais rejeté (BR-SYN-007). Une note à accusé requis reste dans le centre de notes tant que l'accusé manque.
6. **Suivi pour la Direction** : `GET /notes/{id}/acknowledgements` (audience résolue, lus, accusés, manquants) sous `comm.note.publish`.
7. **Aucun effet métier** : le module ne publie aucun événement que `pricing` ou un autre module consomme ; `InternalNotePublished` et `InternalNoteAcknowledged` servent la synchronisation et l'audit. La note automatique à l'activation d'une règle tarifaire est facultative et désactivée par défaut (AV-370).

## Alternatives écartées

- **Note modifiable après publication avec historique** : un lecteur qui a accusé une version ne sait plus ce qu'il a accusé ; la note corrective garde la trace.
- **Audience figée en liste d'utilisateurs en base** : une affectation arrivée après la publication n'aurait pas la consigne en ligne ; l'évaluation à la lecture la donne sans réécrire la note.
- **Lignes de flux `GLOBAL`, `SITE` ou `ZONE`** : un seul type de portée (`USER`) garde le jeu `comms` aligné sur ses destinataires ; un rôle n'est pas une portée du flux.
- **Suppression physique du brouillon** : une table de transaction n'en admet pas (INV-GLO-03).

## Révision P9-11 (1/3 : commandes)

- **Une seule règle d'audience (précise le §3).** Qui une ligne touche est décidé par une fonction pure du domaine (`note-audience.ts`, AV-426), partagée par la lecture en ligne, l'accusé et la résolution à la publication : l'audience est développée en ensembles (rôles, utilisateurs, sites, zones) puis comparée aux affectations actives de l'utilisateur. `SITE` touche les affectations de ce site et celles d'une zone qui le couvre ; `ZONE` celles de la zone, de ses ancêtres, de ses descendantes et de leurs sites ; `GLOBAL` et `TEAM` ne correspondent ni à l'un ni à l'autre. Le module `communication` ne lit aucune table d'`identity` ni d'`organization` : il passe par le port `NoteAudienceResolver`, dont l'adaptateur de `communication-api/` charge les données et laisse la règle décider.
- **Commandes (AV-427, AV-428).** `save_draft`, `publish` et `archive` sont en ligne seulement ; la publication crée-et-publie ou publie le brouillon avec le contenu de la commande, à l'instant du serveur, après contrôle de l'expiration et des références (rôle actif, site, zone, utilisateur ; note corrective existante). Le brouillon et son audience sont écrits d'abord, la publication est le dernier acte (les déclencheurs de la base l'imposent aussi). L'accusé est jugé à la date du fait : il ne rejette jamais une note archivée ou expirée depuis, et n'enregistre pas un utilisateur que l'audience ne touchait pas à cette date.
- **Notifications de la note (précise le §4).** Une notification `IN_APP` de nature `NOTE` par utilisateur touché à la publication, l'auteur excepté ; la source est l'événement `InternalNotePublished` (un rejeu ne double rien). Elles servent aussi de trace de l'audience résolue pour le flux hors ligne (P9-12). Lire ou accuser une note marque lues ses notifications.
- **Événements (précise le §7).** `InternalNoteArchived` s'ajoute à `InternalNotePublished` et `InternalNoteAcknowledged` : un retrait doit atteindre les appareils (jeu `comms`).
- **Lectures (précise les §3, §5 et §6 ; AV-429).** Le centre de notes d'un lecteur liste les notes publiées et non expirées que la règle d'audience désigne **à l'instant de la lecture** (les 500 plus récentes examinées, avec les 500 plus récentes des notes à accusé requis non accusées : une note à accuser n'en sort pas parce que d'autres l'ont dépassée), avec l'état du lecteur, le compteur des accusés attendus sur ce balayage et un indicateur `truncated` quand un plafond est atteint ; la gestion (`comm.note.publish`) liste toutes les notes avec leur audience mais les seuls brouillons du lecteur ; la fiche d'un lecteur est une note publiée qui le touche, même expirée (jamais un brouillon ni une note archivée) ; le suivi des accusés résout l'audience maintenant, l'auteur excepté. Tout refus de visibilité est un 404 opaque audité.
- **Exécution.** Les trois commandes de rédaction et l'accusé s'exécutent en lecture validée : aucun verrou d'intervalle n'est posé sur une clé absente, la clé primaire de la note et de la ligne d'accusé arbitre deux créations simultanées.

## Révision (P9-25, revue adverse, 28/10/2026)

- **Retrait d'une note (NT-6).** Retirer une note marque lues ses notifications non lues (`read_at` = date du retrait) et les sort du jeu `comms` : `read_at` signifie désormais « n'attend plus l'utilisateur », même sans lecture, et la purge à 90 jours après lecture s'applique à ces lignes (AV-471).
- **Suivi des accusés.** `GET /notes/{id}/acknowledgements` rend `missingTotal` (nombre exact) et `truncated` (coupure à 1 000 noms) ; le suivi n'est pas paginé (AV-429).
- **Limite.** Le retrait verrouille la note puis ses notifications, alors que `communication.notification.read` verrouille par l'index `(user_id, read_at)` : un interblocage possible est converti en `RETRY_LATER`, même schéma qu'entre accusé et lecture.

## Tests

Immuabilité (commande et base, y compris les lignes d'audience ; mutation sur le déclencheur), audience en ligne (tous, rôle, site, zone avec descendantes, utilisateur ; affectation postérieure), lignes de flux par utilisateur résolu (pull réel : un utilisateur hors audience ne reçoit rien), expiration, archivage, accusé idempotent et hors ligne (AT-048), accusé d'une note archivée depuis, note corrective, brouillon abandonné, aucune écriture hors `communication_*` (BR-NOT-007).
