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

## Ce que fait la mise à jour

1. Construction locale (`pnpm run build` : paquets partagés, serveur, PWA), compilation des semis en CommonJS, assemblage du paquet.
2. Envoi par `scp`, puis `remote-update.sh` sur le serveur :
   1. extraction du paquet dans `releases/<horodatage>/new` ;
   2. sauvegarde de la base (`mysqldump`) dans `~/backups_db/gic-<horodatage>.sql.gz` ;
   3. mise en place des nouveaux fichiers ; **l'ancienne version est gardée** dans `releases/<horodatage>/previous` ;
   4. migrations (`migrate.mjs`, seulement celles qui ne sont pas dans `schema_migrations`) ;
   5. semis (réglages, règles d'alerte, droits : idempotents) ;
   6. redémarrage de Passenger (`tmp/restart.txt`) ;
   7. contrôle : `/health/ready` doit répondre 200 et la page d'accueil aussi.
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

## Correctifs propres à la mise en ligne (non versionnés dans le code source)

- **Connexion par adresse e-mail.** Depuis le 27/10/2026 le code compilé en ligne accepte une adresse e-mail dans le champ de connexion (`phone` jusqu'à 200 caractères, repli sur `identity_users.email`). Ce correctif n'existe pas dans `apps/server/src/modules/identity/api/auth.controller.ts` : `build-bundle.ps1` le **réapplique au code construit** et s'arrête si le code a changé. À intégrer proprement dans le code source (avec ses essais) quand le porteur le décide ; il faudra alors supprimer ce bloc.
- L'approbation automatique de l'appareil `admin`, essayée le 27/10/2026, n'est plus en ligne (le fichier a été remplacé) : la procédure d'installation reste `approve-device`.

## Points d'attention

- Les mots de passe de base de données et de messagerie qui ont circulé dans les journaux d'Anti-Gravity (`~/.gemini/antigravity/brain/*/.system_generated/`) sont à **changer** ; aucun script de ce dossier n'en contient.
- La base de l'hébergement ne semble pas dédiée à GIC (l'historique montre des tables d'un site WordPress dans la même base, à confirmer) : préférer une base propre à GIC dès que l'hébergement le permet.
- Le premier démarrage après une mise à jour peut lever l'alerte `JOB_FAILED` si des tâches du serveur sont déjà passées `FAILED` dans les dernières 24 heures : c'est le comportement voulu (AV-469).
