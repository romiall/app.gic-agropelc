# `db/` — migrations et seeds (MySQL, ADR-023)

Schéma versionné en SQL brut ([`dbmate`](https://github.com/amacneil/dbmate)), rejoué à
l'identique en local, en CI et en production. Source de vérité du schéma :
[`docs/03-data/dictionnaire/`](../docs/03-data/dictionnaire/README.md). Toute divergence
entre une migration et le dictionnaire est un bug — corriger le dictionnaire d'abord si le
besoin a changé, puis la migration, dans le même commit (règle R8, `CLAUDE.md`).

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

## 5. Tests

`pnpm --filter @gic/db run test` (intégration, MySQL réel — voir
[`tests/`](tests/)) vérifie les contraintes, colonnes générées et déclencheurs
d'immuabilité créés par ces migrations, contre `DATABASE_URL` déjà migré. Pas de test
unitaire pur ici : le SQL n'a de sens qu'exécuté contre un vrai moteur (`09-non-functional/
03-plan-de-tests.md`).
