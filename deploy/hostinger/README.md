# Mise en ligne sur Hostinger (`app.gic-agropelc.com`)

Ce dossier reprend, sous forme de scripts versionnés, la procédure faite à la main le 26 et le 27/10/2026 depuis Anti-Gravity. Il ne contient **aucun secret** : la clé SSH reste dans `%USERPROFILE%\.ssh`, le fichier `.env` reste sur le serveur.

## Utilisation

Depuis la racine du dépôt, dans PowerShell (une seule ligne) :

```powershell
powershell -ExecutionPolicy Bypass -File deploy\hostinger\deploy.ps1
```

- `-BuildOnly` construit le paquet sans rien envoyer (`%TEMP%\gic-app-bundle.tar.gz`, taille et empreinte affichées).
- `-SkipBuild` réutilise la construction existante ; `-NoDbBackup` ignore la sauvegarde de la base (à n'utiliser qu'après une sauvegarde faite dans hPanel).
- `node deploy/hostinger/migrate.mjs --dry-run --since 20261201090600` affiche, sans connexion, le SQL que le serveur exécuterait pour les migrations plus récentes que la version donnée.
- `node deploy/hostinger/test-mariadb-compat.mjs` compile des requêtes Kysely sans base et vérifie que la couche de compatibilité MariaDB réécrit bien `CAST(? AS JSON)` et `FOR SHARE` (à relancer si Kysely est mis à jour).

## Ce que fait la mise à jour

1. Construction locale (`pnpm run build` : paquets partagés, serveur, PWA), compilation des semis en CommonJS, assemblage du paquet.
2. Envoi par `scp`, puis `remote-update.sh` sur le serveur :
   1. extraction du paquet dans `releases/<horodatage>/new` ;
   2. sauvegarde de la base (`mysqldump`) dans `~/backups_db/gic-<horodatage>.sql.gz` ;
   3. mise en place des nouveaux fichiers ; **l'ancienne version est gardée** dans `releases/<horodatage>/previous` ;
   4. **contrôle de compatibilité SQL** (`compat-check.mjs`) sur la base réelle, dans une table temporaire : écriture et relecture d'une colonne JSON avec le vrai `jsonValue` du code construit, verrous en partage et en écriture ; un échec annule la mise en ligne avant toute migration ;
   5. migrations (`migrate.mjs`, seulement celles qui ne sont pas dans `schema_migrations`) ;
   6. semis (réglages, règles d'alerte, droits : idempotents) ;
   7. redémarrage de Passenger (`tmp/restart.txt`) ;
   8. contrôle : `/health/ready` et la page d'accueil répondent 200 ; la route de connexion répond 401 à un identifiant fictif (une erreur 5xx annule la mise en ligne) ; les erreurs que le serveur a écrites dans `stderr.log` depuis le redémarrage sont comptées et affichées en avertissement.
3. En cas d'échec à l'une de ces étapes, le script **remet l'ancienne version** et la redémarre. Les migrations déjà appliquées restent (elles sont écrites pour rester compatibles avec la version précédente) ; la sauvegarde de la base reste dans `~/backups_db`.

Seules les cinq dernières livraisons sont gardées dans `releases/`.

## Retour arrière manuel

```bash
cd ~/domains/gic-agropelc.com/nodejs-app
# remplacer chaque élément de releases/<id>/previous (dist, pwa, seeds-dist, db, server.js, migrate.mjs,
# package.json, node_modules/@gic/domain, node_modules/@gic/contracts) à sa place, puis :
touch tmp/restart.txt
# base : gunzip -c ~/backups_db/gic-<id>.sql.gz | mysql ... (identifiants du .env, jamais dans une commande partagée)
```

## L'environnement en ligne (relevé le 30/10/2026)

| Élément | Valeur |
|---|---|
| Hébergement | Hostinger mutualisé (CloudLinux), accès SSH `u720123645@145.79.20.169`, port `65002`, clé `gic_agropelc_deploy` |
| Application | `~/domains/gic-agropelc.com/nodejs-app` ; Passenger via `~/domains/gic-agropelc.com/public_html/app/.htaccess` (`PassengerStartupFile server.js`, redémarrage par `tmp/restart.txt`) |
| Node | 22 (`/opt/alt/alt-nodejs22/root/usr/bin`) |
| Démarrage | `server.js` : API Nest/Fastify + worker (tâches et consommateurs d'événements) dans le même processus, et service des fichiers de la PWA (`pwa/`) avec repli sur `index.html` ; seules les routes `/api/*` et `/health*` vont à l'API |
| Base | MariaDB 11.8 de l'hébergement, **un seul utilisateur** de base ; la chaîne de connexion est dans le `.env` du serveur |
| Dépendances d'exécution | `package.json` du serveur (celles de `apps/server/package.json`, sans les paquets `@gic/*`, installés dans `node_modules/@gic/`) ; `npm install` n'est relancé que si elles changent |

Variables du `.env` du serveur (valeurs jamais versionnées) : `NODE_ENV`, `PORT`, `HOST`, `TRUST_PROXY`, `TOKIO_WORKER_THREADS`, `UV_THREADPOOL_SIZE`, `ATTACHMENTS_STORAGE_DIR`, `DATABASE_URL`, `SERVER_DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`.

## Adaptations à MariaDB et à l'hébergement

- Les lignes `GRANT` / `REVOKE` vers `gic_app` sont retirées des migrations (`migrate.mjs`) : l'hébergement n'a qu'un utilisateur.
- `DROP CHECK` devient `DROP CONSTRAINT` (syntaxe MariaDB).
- Dans les semis compilés, `CAST(? AS JSON)` devient `JSON_EXTRACT(?, '$')` (MariaDB ne connaît pas `CAST(… AS JSON)`).
- `dbmate` n'existe pas en ligne : `migrate.mjs` écrit dans la même table `schema_migrations`.
- **À l'exécution** (`mariadb-compat.mjs`, installé par `server.js` avant la création de l'application) : `CAST(? AS JSON)` devient `JSON_EXTRACT(?, '$')` (toute écriture d'une colonne JSON passe par `jsonValue()` : audit, événements, journal des commandes, tâches, alertes) et `FOR SHARE` devient `LOCK IN SHARE MODE` (plus de vingt-cinq lectures verrouillantes : caisse, quotas, coûts, transferts). La réécriture se fait à la compilation des requêtes Kysely : le code source et son comportement sous MySQL 8.4 ne changent pas, la suite d'essais n'est pas concernée. Essai local : `test-mariadb-compat.mjs` ; essai sur la vraie base avant chaque redémarrage : `compat-check.mjs` (AV-485).

## Correctifs propres à la mise en ligne (non versionnés dans le code source)

- **Connexion par adresse e-mail.** Depuis le 27/10/2026 le code compilé en ligne accepte une adresse e-mail dans le champ de connexion (`phone` jusqu'à 200 caractères, repli sur `identity_users.email`). Ce correctif n'existe pas dans `apps/server/src/modules/identity/api/auth.controller.ts` : `build-bundle.ps1` le **réapplique au code construit** et s'arrête si le code a changé. À intégrer proprement dans le code source (avec ses essais) quand le porteur le décide ; il faudra alors supprimer ce bloc.
- L'approbation automatique de l'appareil `admin`, essayée le 27/10/2026, n'est plus en ligne (le fichier a été remplacé). Le premier appareil d'un administrateur s'approuve avec `approve-device.mjs`, l'équivalent en ligne de `pnpm run db:approve-device` (qui demande `tsx`, absent de l'hébergement) : sur le serveur, dans le dossier de l'application, `node --env-file=.env approve-device.mjs <code court>`. Le code de 4 caractères s'affiche sur l'appareil en attente après la première connexion ; l'utilisateur qui l'a connecté doit être administrateur.

## Points d'attention

- Les mots de passe de base de données et de messagerie qui ont circulé dans les journaux d'Anti-Gravity (`~/.gemini/antigravity/brain/*/.system_generated/`) sont à changer **par le porteur lui-même** (le site n'est pas encore utilisé) ; aucun agent n'y touche, et aucun script de ce dossier n'en contient.
- La base de l'hébergement ne semble pas dédiée à GIC (l'historique montre des tables d'un site WordPress dans la même base, à confirmer) : préférer une base propre à GIC dès que l'hébergement le permet.
- Colonnes JSON : `compat-check.mjs` les relit **en objets** sur la base de l'hébergement, comme sous MySQL 8.4 (constaté le 30/10/2026) : aucun écart à ce sujet. Il afficherait « colonne JSON relue en texte » si cela changeait (le code qui lit une colonne JSON sans l'analyser s'en trouverait faussé : limites des droits, drapeaux, charges utiles). D'autres écarts de MariaDB restent possibles : à surveiller dans `stderr.log` et `console.log` (AV-485).
- Lire les erreurs du serveur : `~/domains/gic-agropelc.com/nodejs-app/stderr.log` (journal de Nest, erreurs de l'ordonnanceur) et `console.log` (une ligne JSON par erreur de l'API, avec le `correlation_id` renvoyé au client).
- Le premier démarrage après une mise à jour peut lever l'alerte `JOB_FAILED` si des tâches du serveur sont déjà passées `FAILED` dans les dernières 24 heures : c'est le comportement voulu (AV-469).

## Journal des mises en ligne

| Date | Livraison | Commit | Contenu | Résultat |
|---|---|---|---|---|
| 26 et 27/10/2026 | à la main (Anti-Gravity) | état du 26/10 | installation initiale | en ligne |
| 30/10/2026 | `20261030-134330` | `ec29ea7` | clôture de P9 (P9-25, P9-26), P9-27 ; migrations `20261201090700` et `20261202090000` ; 8 nouveaux réglages et règle d'alerte `JOB_FAILED` semés | en ligne ; `GET /health/ready` répond 200 avec la sonde en secondes ; sauvegarde `~/backups_db/gic-20261030-134330.sql.gz`, ancienne version dans `releases/20261030-134330/previous` |
| 30/10/2026 (15 h 17, heure locale) | `20261030-151740` | `b8458e5` | correctif de compatibilité MariaDB (`mariadb-compat.mjs`, `compat-check.mjs`, route de connexion contrôlée), `approve-device.mjs` ; aucune migration, semis sans changement | en ligne ; contrôle de compatibilité SQL passé sur la vraie base ; aucune erreur écrite par le serveur après le redémarrage, ordonnanceur compris ; sauvegarde `~/backups_db/gic-20261030-151740.sql.gz`, ancienne version dans `releases/20261030-151740/previous` |

Première utilisation du kit : le script distant a tout réussi, mais `deploy.ps1` a affiché un échec à la fin (code 127, dû à un retour chariot ajouté par PowerShell à la fin du texte envoyé) ; corrigé depuis (`tr -d '\r'` côté serveur).

**Défaut constaté le 30/10/2026 après cette mise en ligne** : la connexion répondait « service momentanément indisponible » (erreur 500, `You have an error in your SQL syntax … near 'JSON)'` dans `console.log`, 13:08 UTC) et l'ordonnanceur échouait toutes les 3 secondes (1 908 erreurs dans `stderr.log`, depuis le 27/10). Cause : MariaDB refuse `CAST(? AS JSON)` et `FOR SHARE`, que le code serveur emploie, et le kit n'adaptait que les semis et les migrations ; l'installation du 27/10 portait un correctif manuel sur l'audit, effacé par la mise à jour, et l'ordonnanceur échouait déjà depuis cette installation. Correctif : `mariadb-compat.mjs` et `compat-check.mjs` (ci-dessus), en ligne depuis la livraison `20261030-151740`.
