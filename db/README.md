# `db/` — migrations et seeds (MySQL, ADR-023)

Schéma versionné en SQL brut ([`dbmate`](https://github.com/amacneil/dbmate)), rejoué à
l'identique en local, en CI et en production. Source de vérité du schéma :
[`docs/03-data/dictionnaire/`](../docs/03-data/dictionnaire/README.md). Toute divergence
entre une migration et le dictionnaire est un bug — corriger le dictionnaire d'abord si le
besoin a changé, puis la migration, dans le même commit (règle R8, `CLAUDE.md`).

## 0. Quel serveur MySQL

| Environnement | Serveur | Port |
|---|---|---|
| Production | MySQL managé chez Hostinger (ADR-023, ADR-024) | fourni par l'hébergeur |
| CI (GitHub Actions) | Conteneur MySQL officiel (`.github/workflows/ci.yml`) | 3306 |
| Poste de développement Windows | **MySQL Community Server 8.4** installé à part (`C:\Program Files\MySQL\MySQL Server 8.4`, configuration `my.ini` hors dépôt) | **3307** |

Le projet **n'utilise pas le MySQL de XAMPP** : c'est un MariaDB 10.4, incompatible avec le
schéma (collation `utf8mb4_0900_as_cs`, contraintes `CHECK` appliquées, colonnes générées,
`SKIP LOCKED`). Le dépôt se trouve sous `C:\xampp\htdocs` pour des raisons d'emplacement
seulement ; XAMPP n'intervient ni dans l'exécution ni dans les tests. Comme le MariaDB de XAMPP
occupe le port 3306 sur ce poste, le MySQL 8.4 écoute sur 3307 : remplacer `3306` par `3307`
dans les URL ci-dessous et dans `apps/server/.env`. Démarrage, dans une fenêtre laissée
ouverte :

```powershell
& "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqld.exe" --defaults-file="<chemin du my.ini>" --console
```

**Fuseau (ADR-016, ADR-023).** Les connexions du serveur (`createDatabase`) et du paquet `db`
(seeds, tests : `connectUtc`, `poolUtc`, `seeds/connection.ts`) travaillent en **UTC**, quel que soit
le fuseau de la machine : le pilote mysql2 convertit les `Date` en UTC (`timezone: 'Z'`) et chaque
session passe en `time_zone = '+00:00'` (`CURRENT_TIMESTAMP`, `NOW()`). dbmate, `kysely-codegen` et les
clients `mysql` en ligne de commande gardent le fuseau du serveur MySQL : sans effet sur les données
(les migrations n'écrivent aucun horodatage hors valeurs par défaut). Sans ce réglage (avant le
12/10/2026), un poste réglé sur l'Afrique de l'Ouest (UTC+1) stockait l'heure locale : horodatages
décalés d'une heure, jour métier faux entre 22:00 et 23:00 UTC (23:00 à minuit à Douala). Une colonne
`DATE` s'écrit depuis la chaîne du jour (`AAAA-MM-JJ`) et se relit par ses composantes UTC. Une base locale
créée avant ce correctif garde ces horodatages en heure locale ; la vérification du chaînage d'audit
(`audit.chain.verify_daily`) y voit une rupture sur les entrées antérieures. Recréer alors la base
locale (migrations puis seeds) plutôt que de corriger les lignes (le journal d'audit est immuable).

## 1. Deux utilisateurs MySQL

| Utilisateur | Rôle | Utilisé par |
|---|---|---|
| **admin** (ex. `root` en local/CI, un identifiant admin fourni par l'hébergeur en production) | Exécute les migrations : DDL complet **et** `GRANT`/`REVOKE` sur `gic_app` | `dbmate` uniquement |
| **`gic_app`** | Utilisateur applicatif, privilèges minimaux par table (`SELECT`/`INSERT`/`UPDATE`/`DELETE` selon la politique de suppression, jamais `DELETE` sur une table `IMMUABLE`/`ANNULATION`/`DESACTIVATION`/`VERSIONNEMENT` — [`03-historisation-suppression.md`](../docs/03-data/03-historisation-suppression.md) §4, INV-GLO-05) | Le serveur (`apps/server`, à partir de P0-06) |

Les migrations accordent les privilèges de `gic_app` par table (`GRANT ... TO 'gic_app'@'%'`)
mais **ne créent jamais cet utilisateur ni son mot de passe** : la création est un geste
d'environnement, hors dépôt (le mot de passe est un secret — `ADR-024` §Secrets). Avant la
toute première migration d'un environnement :

```sql
CREATE USER 'gic_app'@'%' IDENTIFIED BY '<mot de passe, hors dépôt>';
```

En local, un utilisateur `mysql_native_password` suffit. `gic_app@'%'` (et non `@'localhost'`)
pour que le conteneur/processus serveur, qui ne partage pas toujours l'hôte exact de MySQL,
puisse se connecter.

## 2. Exécuter les migrations

```bash
export DATABASE_URL="mysql://<admin>:<mot de passe>@127.0.0.1:3306/gic_agropelc_dev"
pnpm run db:migrate        # applique les migrations en attente sur DATABASE_URL
pnpm run db:rollback       # annule la dernière migration appliquée
pnpm run db:migrate:test   # identique à db:migrate ; le nom distinct documente l'intention
                            # (pointer DATABASE_URL vers la base de test avant de l'appeler)
```

`db:migrate` et `db:migrate:test` exécutent la même commande (`dbmate up`) : c'est
`DATABASE_URL`, positionné par l'appelant avant d'invoquer le script, qui détermine la base
ciblée — exactement le contrat déjà utilisé par `.github/workflows/ci.yml` (job `test`, qui
positionne `DATABASE_URL` sur la base de test puis appelle `db:migrate:test`).

`dbmate` lit nativement `DATABASE_URL` ; `--migrations-dir`/`--schema-file` sont déjà fixés
dans les scripts de [`package.json`](package.json) (les valeurs par défaut de `dbmate`
supposent une exécution depuis la racine du dépôt, pas depuis `db/`).

## 3. Prérequis MySQL : utilisateur admin et déclencheurs

Les déclencheurs (`CREATE TRIGGER`) exigent soit le privilège `SUPER`, soit
`log_bin_trust_function_creators = 1` dès que la journalisation binaire (`log_bin`) est
active — ce qui est le cas par défaut sur une installation MySQL standard (paquet APT
Ubuntu, ex.) et pas garanti sur toute image `mysql:8.0` :

```sql
SET GLOBAL log_bin_trust_function_creators = 1;
```

`.github/workflows/ci.yml` (job `test`) l'exécute systématiquement avant les migrations,
avec la création de `gic_app` (§1) — les deux dans la même étape, avant `db:migrate:test`.

## 4. Nouvelle migration

```bash
pnpm --filter @gic/db run new -- nom_de_la_migration
```

Convention de fichier : `-- migrate:up transaction:false` / `-- migrate:down
transaction:false` (le DDL MySQL 8 est atomique par instruction, pas transactionnel de
bout en bout — `docs/05-architecture/04-deploiement.md` §4). Pas de pseudo-commande
`DELIMITER` : c'est une commande du client interactif `mysql`, sans effet (et en erreur de
syntaxe) via une connexion pilotée par un driver comme `dbmate`/`mysql2` — les instructions
`CREATE TRIGGER ... BEGIN ... END;` s'écrivent avec un simple point-virgule final.

`SIGNAL ... SET MESSAGE_TEXT = '...'` est limité à **128 caractères** par MySQL (erreur
« Data too long for condition item 'MESSAGE_TEXT' » sinon, détectée seulement à
l'exécution du déclencheur, pas à la création) : formuler les messages de blocage
(immuabilité, suppression interdite) de façon concise, quitte à renvoyer vers le
dictionnaire plutôt que d'énumérer les colonnes en cause dans le message.

Une migration qui ajoute une clé étrangère différée sur une table créée par un **autre**
fichier de migration (cas des références croisées `identity` ↔ `organization`, voir les
en-têtes de [`migrations/20260924100100_create_identity_core.sql`](migrations/20260924100100_create_identity_core.sql)
et [`migrations/20260924100200_create_organization.sql`](migrations/20260924100200_create_organization.sql))
doit retirer cette contrainte explicitement dans sa propre section `migrate:down`
(`ALTER TABLE ... DROP FOREIGN KEY ...`) avant de supprimer ses propres tables : `DROP
TABLE` avec `FOREIGN_KEY_CHECKS=0` ne nettoie pas la définition de la table qui porte la
contrainte, qui référencerait sinon une table absente au prochain `up`.

## 5. Seeds

```bash
export DATABASE_URL="mysql://<admin>:<mot de passe>@127.0.0.1:3306/gic_agropelc_dev"
pnpm run db:seed
```

Rôles, permissions et portées (matrice RBAC, [`docs/07-security-rbac/01-rbac.md`](../docs/07-security-rbac/01-rbac.md)),
emplacements virtuels (BR-ADM-010) et paramètres système par défaut
(`organization.system_settings`, BR-ADM-015) — source de vérité dans [`seeds/rbac-data.ts`](seeds/rbac-data.ts),
[`seeds/virtual-locations.ts`](seeds/virtual-locations.ts) et [`seeds/system-settings.ts`](seeds/system-settings.ts),
exécutés par [`seeds/run.ts`](seeds/run.ts) (`tsx`, pas de compilation préalable).
Idempotent : chaque étape vérifie l'existant par clé naturelle (`code`, `location_type`,
`key`) avant d'écrire, donc rejouable sans effet destructif ni doublon. `identity.
role_permissions` fait exception : reconstruite en entier à chaque exécution (upsert),
puisque ce fichier **est** la source de vérité courante de la matrice, pas seulement son
état initial — modifier une portée accordée se fait en éditant `rbac-data.ts`, pas en
écrivant une migration.

`identity.role_permissions.limits`/`identity.permissions.supported_scopes` etc. utilisent
`CAST(? AS JSON)` avec un paramètre `JSON.stringify`-é côté Node : `mysql2` n'encode pas
automatiquement une valeur JS pour une colonne `JSON`.

### Données de démonstration (développement local)

```bash
pnpm run demo:data
```

[`apps/server/scripts/demo-data.ts`](../apps/server/scripts/demo-data.ts) prépare la base de
`apps/server/.env` (`SERVER_DATABASE_URL`, hôte local exigé, refus si `NODE_ENV=production`)
pour parcourir la PWA :

- un **compte de démonstration** qui détient tous les rôles métier (globaux, de site et de zone) ;
  identifiant : le téléphone `DEMO_PHONE` du script, affiché en fin d'exécution. **Aucun mot de passe
  n'est écrit dans le code** : lancé dans un terminal, le script demande de le choisir (saisie masquée,
  8 caractères minimum ; pour un compte existant, Entrée conserve l'actuel). Sans terminal interactif, il
  lit `DEMO_PASSWORD` dans l'environnement (fichier local non suivi, par exemple `apps/server/.env`), ou
  conserve le mot de passe d'un compte existant ;
- zone, ferme, magasin central, point de vente configuré, unités, canaux, produits, prix actifs,
  caisses, clients (dont un à crédit), fournisseur, stock, transfert expédié et bon de commande
  envoyé (à réceptionner à l'écran), session de caisse ouverte, ventes et commande à livrer.

Tout passe par les vraies commandes (pipeline, audit, flux de synchronisation), sauf le stock initial
(`recordStockMove`, comme les tests) et le compte (insertion directe, comme `db:create-local-admin`).
Rejouable : chaque référentiel est retrouvé par son code, chaque étape d'activité n'est jouée que si sa
trace manque. Un navigateur qui se connecte crée un appareil **en attente** : il lit, mais ce qu'il
enregistre attend son approbation (BR-ADM-005, AV-228 : renvoyé, puis appliqué une fois l'appareil
approuvé). Se connecter une première fois, **relancer le script** (il approuve les appareils en attente
du compte), puis recharger la page. Un compte qui cumule tous les
rôles reste soumis à la séparation des tâches (validation par un autre utilisateur) et au pointage du
commercial terrain : ses ventes sans « prise de service » portent l'indicateur `OUT_OF_SESSION`.


### Mise en service : premier appareil d'administration (AV-254, MP-06)

Sur une installation neuve, personne ne peut approuver depuis l'application le premier téléphone de
l'administrateur. Après sa première connexion, ce téléphone affiche son **code court** (bandeau « appareil
en attente d'approbation »). Sur le serveur, l'installateur lance :

```bash
pnpm run db:approve-device -- 7KQ2
```

La commande lit `SERVER_DATABASE_URL` (en local, `apps/server/.env`), refuse un code mal formé, un appareil
inconnu, un appareil qui n'est pas en attente ou connecté par un non-administrateur, puis approuve
l'appareil au nom de l'utilisateur système et l'écrit dans le journal d'audit. Les appareils suivants
s'approuvent dans l'application (écran Appareils).

## 6. Tests

`pnpm --filter @gic/db run test` (intégration, MySQL réel — voir
[`tests/`](tests/)) vérifie les contraintes, colonnes générées et déclencheurs
d'immuabilité créés par ces migrations, contre `DATABASE_URL` déjà migré. Pas de test
unitaire pur ici : le SQL n'a de sens qu'exécuté contre un vrai moteur (`09-non-functional/
03-plan-de-tests.md`).
