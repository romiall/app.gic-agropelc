# Prompt de reprise — fin de P9 (état au 28/10/2026)

> Pour une **nouvelle discussion** Claude Code sur le poste du porteur (Windows, `C:\xampp\htdocs\app.gic-agropelc`, branche `claude/brave-pasteur-c7q4y7`). La discussion précédente était devenue trop longue : **ne relis pas son historique**, tout l'utile est ici. Lis d'abord `CLAUDE.md` (§ 3 règles absolues, section « Reprise depuis GitHub »), puis ce fichier, qui prime sur elle pour l'état au 28/10/2026.

## 1. Où en est le dépôt

- Branche locale `claude/brave-pasteur-c7q4y7` = fusion `2e865a4` (MP-13 vérifié + P9 intégrée + pièces papier PP-A) **puis les commits du 28/10** (`git log 2e865a4..HEAD`). **Rien n'est poussé** : `origin/main` est à `53be622`. Branches distantes utiles : `claude/mp13-verification` (PR #3 ouverte, CI verte), `claude/p9-integration` (`d2a7156`, CI verte), `claude/project-thread-x9pv0r` (`9603104`, CI rouge, probablement faute des correctifs de CI de mp13, absents de cette branche).
- Le dépôt GitHub est public (`romiall/app.gic-agropelc`, renommé en `…com` puis redirigé). Remote `dotcom` en doublon : `git remote remove dotcom`. **Ne pousse que sur demande explicite du porteur**, par branche `claude/…` jamais directement sur `main` ; commandes à lui donner en **un seul bloc**, sans accents (PowerShell).

## 2. Fait le 28/10 : écrit, JAMAIS compilé ni exécuté

- **Revue adverse de P9 complète** (cinq domaines, 39 constats, aucun BLOQUANT, 14 MAJEUR, 25 MINEUR), consignée dans `docs/10-development-plan/23-revue-p9-constats.md` (§ 2 à 6 ; § 7 = traitement). Les PLAUSIBLE ne sont pas démontrés.
- **Correctifs EX-1 à EX-8 des exports écrits** (voir § 7 de ce fichier de constats) et leurs essais. **AV-460** créé (droits revérifiés au téléchargement, défaut paramétrable, à confirmer par le porteur) ; réglages `analytics.export_abandon_hours` (24) et `analytics.export_download_revalidate_rights` (true) semés.
- Fichiers touchés (code, essais, schéma ; à relire si la compilation échoue) :
```
 M apps/server/src/analytics-api/analytics-exports.controller.ts
 M apps/server/src/modules/analytics/application/commands/export-commands.ts
 M apps/server/src/modules/analytics/application/exports/export-settings.ts
 M apps/server/src/modules/analytics/application/exports/export-store.ts
 M apps/server/src/modules/analytics/application/exports/run-export.ts
 M apps/server/src/modules/analytics/application/exports/xlsx-writer.ts
 M apps/server/src/modules/analytics/application/exports/zip-writer.ts
 M apps/server/src/modules/analytics/application/maintenance/purge.ts
 M apps/server/src/modules/analytics/application/public/index.ts
 M apps/server/src/modules/identity/application/public/index.ts
 M apps/server/src/platform/storage/chunk-storage.ts
 M apps/server/src/platform/storage/local-fs-chunk-storage.ts
 M apps/server/test/analytics-export-pipeline.test.ts
 M apps/server/test/analytics-export-writers.test.ts
 M apps/server/test/analytics-views-exports.e2e.test.ts
 M db/seeds/system-settings.ts
?? apps/server/src/modules/analytics/application/exports/export-download-rights.ts
?? apps/server/src/modules/identity/application/public/user-lock.ts
```
- Points de vigilance à la compilation : `ChunkStorage.listKeys` est une **méthode ajoutée au port** (tout double d'essai du port doit la porter) ; `buildXlsx` et `zipArchive` sont devenus **asynchrones** (tous les appelants et essais doivent `await`) ; `abandonedExports` et `expiredExportsCreatedBetween` n'existent plus (remplacés par `lockAbandonedExports` et `exportFileStates`) ; `ExportSettings` porte deux champs de plus ; `identity` exporte `lockUserById`.

## 3. À faire, dans l'ordre (coder TOUT avant de vérifier, une seule vérification complète)

1. **Traiter les constats** de `23-revue-p9-constats.md` (§ 2 à 6). Pour chacun : le rejouer contre le code, puis corriger ou le classer « réfuté / laissé » avec la raison dans le § 7. Commencer par les 14 MAJEUR (CONFIRMÉ d'abord) :
- **EP-1** (CONFIRMÉ) — AV-375, défaut (a) annoncé comme implémenté : dimension zone_path et filtre de zone incluant les sous-zones. Le code n'en a rien.… `packages/domain/src/analytics-catalog.ts:109-457 ; compile-exploration`
- **NT-1** (CONFIRMÉ) — Le re-rendu de la valeur protégée à la lecture ne couvre que le canal IN_APP ; GET /notifications?channel=WEB_PUSH rend le texte stocké.… `apps/server/src/modules/communication/application/public/notification-`
- **NT-2** (CONFIRMÉ) — Le lecteur NOTE du jeu comms sert titre et corps à toute personne notifiée ou ayant un accusé, sans réévaluer l'audience ni comm.note.read.… `apps/server/src/sync/communication-projections.ts:128-182 ; commands/n`
- **PF-1** (CONFIRMÉ) — Les purges de la communication (alertes à 2 ans, notifications lues à 90 jours, abonnements push révoqués ou 410) n'existent pas, alors que l'ADR-068 §8 et AV-387 (défaut… `db/seeds/system-settings.ts:406-411 ; ADR-068 §8 ; AV-387 ; db/migrati`
- **TB-1** (CONFIRMÉ) — Le bloc COMMERCIAL ignore `scope.siteIds` : `portfolioHealth` ne reçoit qu'un filtre par titulaires, donc tout le portefeuille est compté dès que l'étendue est faite de s… `apps/server/src/analytics-api/dashboards/dashboard-blocks.ts:583-593 ;`
- **TB-2** (CONFIRMÉ) — La republication « de la date seule toutes les heures » ne se déclenche jamais avec la cadence de 15 minutes : `computed_at` est écrasé à chaque passe, puis comparé à lui… `apps/server/src/modules/analytics/application/snapshots/snapshot-store`
- **TB-4** (CONFIRMÉ) — Le tableau `distribution` n'a aucun instantané : la tâche ne boucle que sur `ROLE_DASHBOARD_CODES`, alors que l'ADR-066 §5 et AV-380 visent chaque tableau dont l'utilisat… `apps/server/src/analytics-api/dashboards/dashboard-builder.ts:26-28 ; `
- **EP-2** (PLAUSIBLE) — Aucun plafond global d'explorations simultanées : chacune épingle une connexion du pool partagé (10 par défaut, file illimitée) jusqu'à 15 s, et 30 s avec la requête de t… `run-exploration.ts:98-136 ; platform/kysely/database.ts:25 (createPool`
- **NT-3** (PLAUSIBLE) — critical_since vient de occurred_at de l'événement, alors que destinataires et notifications sont datés du traitement : le délai de 4 h peut être déjà écoulé à la premièr… `alerts/alert-store.ts:185,252 ; events/alerts-consumer.ts:82 ; notific`
- **NT-4** (PLAUSIBLE) — Aucune garde autour de sender.send : une exception de l'adaptateur annule tout le lot (livraisons et révocations déjà faites) et bloque l'envoi.… `notifications/push-dispatch.ts:67-119 ; notifications/web-push.ts:33-3`
- **PF-2** (PLAUSIBLE) — La voie longue peut verrouiller des tâches courtes. La réclamation filtre sur `job_type` (non indexé) en `FOR UPDATE SKIP LOCKED` sous l'isolement par défaut (REPEATABLE… `apps/server/src/platform/jobs/job-runner.ts:59-76 ; job-lanes.ts ; wor`
- **PF-3** (PLAUSIBLE) — Les passes de détection par pages avec tâches de continuation (`analytics.pass_page_size` = 500, marqueur par la dernière page) ne sont pas implémentées, et aucun AV ni r… `ADR-068 §3 (l.28) ; modules/inventory/application/jobs/stock-threshold`
- **PF-4** (PLAUSIBLE) — Le seul plafond de charge de l'explorateur est par utilisateur (2). Aucun plafond global, et le pool mysql2 n'a pas de `connectionLimit` (10 par défaut) partagé avec les… `apps/server/src/platform/kysely/database.ts:25 ; modules/analytics/app`
- **TB-3** (PLAUSIBLE) — Une exception sur un seul tableau interrompt tout `refreshSnapshotsOf` : les tableaux suivants ne sont pas rafraîchis et `deleteSnapshotsExcept` (purge du droit perdu) n'… `apps/server/src/analytics-api/jobs/kpi-snapshots-refresh-job.ts:92-110`
   Tout choix métier non couvert devient un AV (numéro **461** et suivants) avec un défaut paramétrable ; aucun seuil en dur (règle 8). Les 25 MINEUR : traiter ceux qui touchent un droit, une valeur protégée ou un seuil ; les autres peuvent être consignés.
2. **Documentation de clôture, dans le même lot** : ADR-067 §5-§6 et ADR-068 §6 (purge par listage du stockage, `SKIP LOCKED`, port `listKeys`, téléchargement revérifié, XLSX asynchrone) ; dictionnaire ; matrice §17.11 ; `21-suivi-p9.md` (P9-15 à P9-24 « vérifié » seulement après l'étape 3) ; `22-demonstration-p9.md` ; ligne P9 du plan §4 ; ligne P9 de `CLAUDE.md` § 1 ; `python docs/_tools/check_refs.py`.
3. **Une seule vérification complète** : démarrer MySQL 8.4 (port **3307**, jamais celui de XAMPP ; `Start-Process` détaché de `C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqld.exe` avec `--defaults-file="C:\Users\SMART\mysql84\my.ini"`, attendre ~35 s, vérifier avec `mysqladmin -P3307 -h127.0.0.1 ping` : « Access denied » veut dire que le serveur est vivant), puis lancer **`bash reprise/final_suite.sh gic_agropelc_p9v`** en arrière-plan (base neuve, migrations, seed, format, types, lint, domaine, contrats, PWA, base, serveur, frontières, références ; ~25 à 30 min ; **ne rien lancer d'autre en parallèle**, le poste a 8 Go). Lire `/tmp/final_<étape>.log` seulement pour les étapes en échec. Puis la **seconde passe** des essais d'analyse (`cd apps/server && npx vitest run test/analytics-*.test.ts`) : **aucun saut accepté**. Corriger tout ce qui échoue, rejouer **seulement** les fichiers en échec.
4. **Commits locaux** (messages en français, préfixe de portée, pied `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), **puis demander** au porteur s'il veut pousser et lui donner le bloc de commandes.

## 4. Décisions à demander au porteur (ne pas les trancher seul)

- **AV-460** : revérifier les droits au téléchargement d'un export (défaut implémenté).
- Le **push** de la fusion locale et de ces commits, et le sort de la PR #3.
- Plus tard : régime de TVA de la facture (AV-451), AV-296, AV-297, AV-320, vérification dans le navigateur et sur téléphone, marge d'un lot pilote (voir `CLAUDE.md`).

## 5. Règles de conduite du porteur

Réponds en français, par points courts, avec un point d'avancement fréquent. **Code toute la phase avant de vérifier** : une seule vérification complète et une seule revue adverse à la fin, ni essai fichier par fichier ni batterie de contrôles intermédiaires (le porteur le répète : cela brûle ses jetons). Une revue qui rend 0 constat avec des agents en échec n'est pas une revue. Prettier depuis la racine, sur des fichiers précis. Écris les scripts d'édition avec l'outil Write ou un heredoc `python -I -` et vérifie les accents. Aucun mot de passe dans le code. Une table n'est écrite que par son module (règle 5). Ne relance pas la revue adverse des cinq domaines : elle est faite (39 constats).
