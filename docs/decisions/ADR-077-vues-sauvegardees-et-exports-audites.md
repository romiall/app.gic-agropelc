# ADR-077 — Vues sauvegardées, partage sans droit supplémentaire et exports audités (CSV, XLSX)

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; applique BR-ANA-007, BR-ANA-008, UC-ANA-04 et 05, AT-046 ; les choix métier sont AV-432 à AV-435, défauts paramétrables)
- **Date** : 14/10/2026 (numéro provisoire de la plage 070 à 079 ; révisé le même jour après la revue adverse de la conception)
- **Précise** : [ADR-074](ADR-074-couche-semantique-et-explorateur.md)
- **Questions liées** : AV-067, AV-432 à AV-435

## Contexte

Une analyse se sauvegarde (filtres, colonnes, regroupements, agrégats, tri), se partage et s'exporte. Un partage ne donne aucun droit supplémentaire : chaque lecteur la voit restreinte à son propre périmètre (BR-ANA-007). Tout export est audité : utilisateur, jeu, filtres, colonnes, nombre de lignes, format (BR-ANA-008). AT-046 : l'export de ventes d'un responsable commercial est limité à son équipe et audité. Le dictionnaire donne `analytics.saved_views` et `analytics.export_jobs` (`QUEUED`, `RUNNING`, `DONE`, `FAILED`, `EXPIRED`, fichier valable 24 h, purgé à 30 jours, ligne conservée).

Faits du code :
- aucune bibliothèque XLSX n'est installée ;
- le port de stockage (`ChunkStorage`) n'offre que `uploadedBytes`, `appendChunk` (strictement séquentiel, contrôle de décalage) et `readAll` ; l'adaptateur local n'a pas de suppression ;
- `JobRunner` exécute le gestionnaire d'une tâche dans **une** transaction, sous un point de sauvegarde : un gestionnaire qui lève voit ses écritures annulées (donc un `FAILED` écrit avant le `throw` disparaît), puis la tâche est rejouée (5 essais) ; il n'existe pas de statut `RUNNING` visible hors de cette transaction ;
- le worker traite en série consommateurs et tâches (`worker.service.ts`) ;
- les commandes d'écriture passent par le pipeline idempotent (`command_id`) et le journal d'audit.

## Décision

1. **Vues sauvegardées = commandes en ligne** : `analytics.view.save` (création et mise à jour par le propriétaire), `analytics.view.share` (rôles destinataires), `analytics.view.delete`, `analytics.view.set_default` (vue par défaut d'un rôle, réservée à `analytics.view.share`). Sans permission nouvelle : la sauvegarde exige `analytics.explore`, le partage `analytics.view.share` (AV-435). Aucune n'est admise hors ligne (UC-ANA-04). La suppression d'une vue est physique et auditée : objet de confort, non métier (dictionnaire).
2. **Lectures des vues** : `GET /analytics/views` (vues propres et vues partagées avec un rôle de l'utilisateur, vue par défaut du rôle ; **état d'exécutabilité** `OK`, `OUTDATED` ou `UNAVAILABLE` calculé contre le catalogue et les droits du lecteur, sans données), `GET /analytics/views/{id}` ; l'**exécution** d'une vue est `POST /analytics/query` avec `view_id`, qui revalide la définition contre le catalogue et contre les droits de **l'exécutant** (jamais ceux du propriétaire, BR-ANA-007). Un champ disparu rend la vue `OUTDATED` (erreur explicite, jamais de réécriture silencieuse) ; une vue dont le jeu n'est pas lisible par le lecteur est listée comme indisponible, sans ses données.
3. **Exports = file de tâches** : `analytics.export.request` (permission `analytics.export`, AV-435) crée une ligne `QUEUED` avec la définition **telle que validée à la demande** (le catalogue est figé par sa version) ; la tâche `analytics.export.run` la prend et **revalide les droits du demandeur à l'instant du calcul**. Contraintes de la plateforme :
   - **le gestionnaire ne lève jamais pour un échec métier** (droit retiré, limite de lignes ou de durée, définition obsolète) : il écrit `FAILED` et `error_code` et rend normalement ; il ne lève que pour une erreur technique à rejouer ;
   - il n'y a pas de `RUNNING` visible tant que la tâche tient une transaction ; `RUNNING` n'est posé que si l'implémentation l'écrit dans une transaction courte séparée avant le calcul ;
   - un export qui lit plus de 100 000 lignes termine `FAILED` avec `QUERY_LIMIT_EXCEEDED`, jamais `DONE` avec un fichier tronqué ;
   - le fichier est écrit sous la clé `exports/<id de l'export>` ; un rejeu supprime d'abord le fichier partiel ; la purge supprime aussi les fichiers sans ligne `DONE` ;
   - la tâche, longue (jusqu'à `analytics.export_max_seconds`, 120), est **isolée** du consommateur d'alertes (ADR-078 §3).
   La limite d'export est 100 000 lignes (NFR-13) ; les exports sont toujours asynchrones, un seul chemin à tester et à auditer (AV-433).
4. **Formats** : CSV (UTF-8 avec BOM, séparateur `;`, point décimal, dates ISO, entêtes en libellés français) et XLSX (écrit par un module interne `xlsx-writer.ts`, OOXML minimal : une feuille, types numériques, dates ; archive zip par `node:zlib` et CRC-32, sans dépendance). Toute cellule texte commençant par `=`, `+`, `-` ou `@` est préfixée d'une apostrophe (injection de formules).
5. **Port de stockage étendu** : `ChunkStorage` reçoit `delete(key)` (adaptateur local et test) ; l'écriture d'un export est séquentielle par morceaux (`appendChunk`), la lecture est en flux par morceaux. Ajout de plateforme signalé au suivi §3.
6. **Téléchargement et lectures d'état** :
   - `GET /analytics/exports` et `GET /analytics/exports/{id}` (statut, `error_code`, `row_count`, `expires_at`) et `GET /analytics/exports/{id}/download` sont **réservés au demandeur** ; refusés après 24 h (`EXPIRED`) ;
   - **aucun autre rôle ne télécharge**, titulaire de `audit.log.read` compris : le fichier n'est pas nécessaire à l'audit, qui lit la ligne `export_jobs` (jeu, filtres, colonnes, nombre de lignes) ; ouvrir le fichier d'un autre élargirait le périmètre et les mesures protégées par une voie latérale (BR-ANA-007, RC-05) ;
   - chaque téléchargement écrit une ligne d'audit (`AnalyticsExportDownloaded`, acteur, appareil).
7. **Audit (BR-ANA-008)** : la demande, la fin et le téléchargement d'un export écrivent une ligne d'audit (acteur, appareil, jeu, filtres, dimensions, mesures, format, nombre de lignes, durée) et les événements `AnalyticsExportRequested` et `AnalyticsExportCompleted` ; la fin déclenche une notification in-app au demandeur par le consommateur de `communication` (graphe : `analytics` n'importe pas `communication`, ADR-070). Un refus de droit est audité (RC-09).
8. **Mesures protégées** : une définition qui nomme coût, marge, valeur de stock ou toute valeur au coût exige `inventory.valuation.read` à la demande **et** au calcul (ADR-074 §7) ; un export financier exige donc les deux droits (AV-434).
9. **Événement de partage** : `SavedViewShared` (identifiant de la vue, rôles) pour l'audit ; aucune notification n'est envoyée aux rôles.

## Alternatives écartées

- **Exports synchrones sous un seuil** : deux chemins à tester et à auditer ; la tâche unique suffit pour NFR-13.
- **Bibliothèque XLSX** : dépendance et licence à valider ; un écrivain minimal (une feuille, sans style) couvre le besoin.
- **URL signée publique** : durée de vie, révocation et fuite à gérer ; l'authentification du demandeur est déjà là.
- **Téléchargement par `audit.log.read`** : l'administrateur détient ce droit sans `analytics.export` ni `inventory.valuation.read` ; il lirait un export de marge produit par la Direction.
- **Droits du propriétaire de la vue pour l'exécution** : élargirait la portée d'un lecteur par partage, ce que BR-ANA-007 interdit.

## Conséquences

- L'export est reproductible : la définition, la version du catalogue et l'instant sont dans la ligne et l'audit.
- Un export en `FAILED` est visible du demandeur avec son motif (droit retiré, limite, durée), jamais en silence.

## Tests

Partage sans droit supplémentaire (AT-046 : responsable commercial, export limité à son équipe), vue obsolète, vue d'un jeu illisible, listage et exécution par `view_id` ; export : cycle de vie, droit retiré entre la demande et le calcul (`FAILED` conservé, pas de rejeu), limite de lignes (`FAILED`, pas de fichier tronqué) et de durée, rejeu après interruption (fichier partiel supprimé), injection de formule, CSV et XLSX relus (lecteur de référence dans le test seulement), **téléchargement d'autrui refusé (un administrateur sur un export de marge)**, expiration, audit (une ligne à la demande, une à la fin, une par téléchargement), `ChunkStorage.delete`.
