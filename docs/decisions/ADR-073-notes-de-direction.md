# ADR-073 — Notes de direction : publication immuable, audience, accusés hors ligne

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; applique BR-NOT-006, BR-NOT-007, UC-NOT-05 et 06, AT-048 ; les choix métier sont AV-419 et AV-420, défauts paramétrables)
- **Date** : 14/10/2026 (numéro provisoire de la plage 070 à 079 ; révisé le même jour après la revue adverse de la conception)
- **Précise** : [ADR-072](ADR-072-destinataires-notifications-push-et-escalade.md)
- **Questions liées** : AV-066, AV-419, AV-420

## Contexte

La Direction diffuse des notes ciblées (prix, instruction, procédure, information ; CM §43) à une audience (tous, rôles, sites, zones, utilisateurs). Une note ne porte aucun effet métier (BR-NOT-007) : elle peut **référencer** un objet (une règle tarifaire) sans le modifier. Elle est immuable une fois publiée (BR-NOT-006) ; on la retire par archivage ou on publie une note corrective. Une note peut exiger un accusé de lecture, lisible et accusable hors ligne (UC-NOT-06, AT-048). Le dictionnaire donne trois tables (`internal_notes`, `note_audiences`, `note_acknowledgements`) et un statut `DRAFT`, `PUBLISHED`, `ARCHIVED`.

Faits : la spécification de synchronisation donne au jeu `comms` la portée `USER` ; le flux n'admet que `GLOBAL`, `SITE`, `ZONE`, `TEAM`, `USER`, `DEVICE`, `LOCATION` ; un type d'audience `ROLE` n'est pas une portée du flux. Le modèle relationnel classe `internal_notes` en transaction : pas de suppression physique (INV-GLO-03) ; la table de suppression technique (`03-historisation-suppression.md` §3) n'en liste aucune ligne libre.

## Décision

1. **Cycle** : `DRAFT` → `PUBLISHED` → `ARCHIVED`.
   - Le brouillon n'est visible que de son auteur ; il se crée et se modifie (`communication.note.save_draft`, permission `comm.note.publish`). Un brouillon abandonné passe à `ARCHIVED` : rien n'est supprimé physiquement.
   - La publication (`communication.note.publish`) fige titre, corps, catégorie, audience, référence, expiration et option d'accusé ; **plus aucune colonne de la note ni aucune ligne de son audience** n'est modifiable, en base comme en commande : les déclencheurs d'immuabilité couvrent `internal_notes` et `note_audiences` (INSERT, UPDATE et DELETE refusés dès que la note n'est plus `DRAFT`). L'archivage est un changement de statut.
2. **Publication** : réservée à `comm.note.publish` (Direction). Validations (D13 §8) : titre et corps non vides, audience non vide, expiration postérieure à la publication. Une note corrective est une **nouvelle** note qui référence l'ancienne (`related_entity_type = 'INTERNAL_NOTE'`). La clé primaire de l'audience n'admet pas de colonne nulle : `audience_ref` vaut `'*'` pour `ALL`.
3. **Audience et lecture en ligne** : la note est visible d'un utilisateur si une ligne d'audience le désigne — `ALL`, un de ses rôles actifs, un de ses sites ou zones d'affectation (avec descendantes), ou lui-même ; l'audience est évaluée **à la lecture** (`GET /notes`, `GET /notes/{id}`), de sorte qu'une affectation postérieure à la publication voit la note.
4. **Notification et jeu hors ligne : audience résolue à la publication.** À la publication, le résolveur (ADR-072 §2) calcule les utilisateurs touchés ; chacun reçoit une notification `IN_APP` et **une ligne de flux en portée `USER`** du jeu `comms`. Un utilisateur affecté après la publication voit la note en ligne (§3) mais ne la reçoit pas par le flux tant qu'elle n'est pas republiée (limite assumée, AV-419 ; un consommateur des affectations pourra la lever).
5. **Accusé** : `communication.note.acknowledge` (permission `comm.note.read`) écrit `note_acknowledgements` (`read_at`, `acknowledged_at`, `command_id`), idempotent par (note, utilisateur), admis hors ligne. L'accusé d'une note **archivée ou expirée depuis** la lecture hors ligne est enregistré à sa date de fait, jamais rejeté (BR-SYN-007). Une note à accusé requis reste dans le centre de notes tant que l'accusé manque.
6. **Suivi pour la Direction** : `GET /notes/{id}/acknowledgements` (audience résolue, lus, accusés, manquants) sous `comm.note.publish`.
7. **Aucun effet métier** : le module ne publie aucun événement que `pricing` ou un autre module consomme ; `InternalNotePublished` et `InternalNoteAcknowledged` servent la synchronisation et l'audit. La note automatique à l'activation d'une règle tarifaire est facultative et désactivée par défaut (AV-420).

## Alternatives écartées

- **Note modifiable après publication avec historique** : un lecteur qui a accusé une version ne sait plus ce qu'il a accusé ; la note corrective garde la trace.
- **Audience figée en liste d'utilisateurs en base** : une affectation arrivée après la publication n'aurait pas la consigne en ligne ; l'évaluation à la lecture la donne sans réécrire la note.
- **Lignes de flux `GLOBAL`, `SITE` ou `ZONE`** : un seul type de portée (`USER`) garde le jeu `comms` aligné sur ses destinataires ; un rôle n'est pas une portée du flux.
- **Suppression physique du brouillon** : une table de transaction n'en admet pas (INV-GLO-03).

## Tests

Immuabilité (commande et base, y compris les lignes d'audience ; mutation sur le déclencheur), audience en ligne (tous, rôle, site, zone avec descendantes, utilisateur ; affectation postérieure), lignes de flux par utilisateur résolu (pull réel : un utilisateur hors audience ne reçoit rien), expiration, archivage, accusé idempotent et hors ligne (AT-048), accusé d'une note archivée depuis, note corrective, brouillon abandonné, aucune écriture hors `communication_*` (BR-NOT-007).
