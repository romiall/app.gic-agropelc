
# Mise a jour de l'application en ligne (Hostinger : CloudLinux + Passenger). Execute SUR LE SERVEUR par deploy.ps1,
# jamais a la main sans lire README.md. Arguments : $1 = paquet envoye, $2 = identifiant de livraison (horodatage).
# Variables : APP_DIR (defaut ci-dessous), NO_DB_BACKUP=1 pour ignorer la sauvegarde de la base.
# Fichier ASCII volontairement (sortie lisible dans la console Windows). Les fichiers .env ne sont jamais touches.
set -euo pipefail
BUNDLE="$1"
RELEASE="$2"
APP="${APP_DIR:-$HOME/domains/gic-agropelc.com/nodejs-app}"
URL="${PUBLIC_URL:-https://app.gic-agropelc.com}"
export PATH=/opt/alt/alt-nodejs22/root/usr/bin:$PATH
cd "$APP"
[ -f .env ] || { echo "ECHEC : $APP/.env introuvable (ce fichier n'est jamais versionne)."; exit 1; }
[ -f "$BUNDLE" ] || { echo "ECHEC : paquet introuvable ($BUNDLE)."; exit 1; }

PREV="releases/$RELEASE/previous"
NEW="releases/$RELEASE/new"
DUMP="$HOME/backups_db/gic-$RELEASE.sql.gz"
ITEMS="dist pwa seeds-dist db server.js migrate.mjs package.json node_modules/@gic/domain node_modules/@gic/contracts"
mkdir -p "$PREV" "$NEW" "$HOME/backups_db" node_modules/@gic tmp

restart() {
  touch tmp/restart.txt
  pkill -u "$(id -u)" -f "lsnode:$APP" 2>/dev/null || true
}
rollback() {
  trap - ERR
  echo "!! Retour a la version precedente"
  for item in $ITEMS; do
    if [ -e "$PREV/$item" ]; then rm -rf "$item"; mkdir -p "$(dirname "$item")"; mv "$PREV/$item" "$item"; fi
  done
  restart
  echo "Version precedente remise en place. Sauvegarde de la base (si faite) : $DUMP"
}
fail() {
  echo "ECHEC : $*"
  rollback
  exit 1
}
trap rollback ERR

echo "== 1/7 Extraction du paquet"
tar -xzf "$BUNDLE" -C "$NEW"
for f in dist pwa pkg-domain pkg-contracts seeds-dist db server.js migrate.mjs package.json; do
  [ -e "$NEW/$f" ] || fail "$f absent du paquet"
done

echo "== 2/7 Sauvegarde de la base"
if [ "${NO_DB_BACKUP:-0}" = "1" ]; then
  echo "  ignoree (demande explicite)"
else
  DUMPER="$(command -v mysqldump || command -v mariadb-dump || true)"
  [ -n "$DUMPER" ] || fail "mysqldump introuvable : sauvegarder la base dans hPanel (phpMyAdmin, Exporter) puis relancer avec -NoDbBackup"
  CNF="$(mktemp)"
  chmod 600 "$CNF"
  DBNAME="$(node --env-file=.env --input-type=module -e '
import fs from "node:fs";
const u = new URL(process.env.DATABASE_URL);
const esc = (s) => decodeURIComponent(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
fs.writeFileSync(process.argv[1], ["[client]", "user=\"" + esc(u.username) + "\"", "password=\"" + esc(u.password) + "\"", "host=\"" + u.hostname + "\"", "port=" + (u.port || 3306), ""].join("\n"));
console.log(decodeURIComponent(u.pathname.slice(1)));
' "$CNF")"
  "$DUMPER" --defaults-extra-file="$CNF" --single-transaction --skip-lock-tables --routines --triggers "$DBNAME" | gzip > "$DUMP"
  rm -f "$CNF"
  [ -s "$DUMP" ] || fail "sauvegarde vide ($DUMP)"
  echo "  $DUMP ($(du -h "$DUMP" | cut -f1))"
fi

echo "== 3/7 Mise en place des nouveaux fichiers (ancienne version gardee dans $APP/$PREV)"
for item in $ITEMS; do
  if [ -e "$item" ]; then mkdir -p "$PREV/$(dirname "$item")"; mv "$item" "$PREV/$item"; fi
done
mv "$NEW/dist" dist
mv "$NEW/pwa" pwa
mv "$NEW/seeds-dist" seeds-dist
mv "$NEW/db" db
mv "$NEW/server.js" server.js
mv "$NEW/migrate.mjs" migrate.mjs
mv "$NEW/package.json" package.json
mv "$NEW/pkg-domain" node_modules/@gic/domain
mv "$NEW/pkg-contracts" node_modules/@gic/contracts
if [ ! -f "$PREV/package.json" ] || ! node -e 'const a = require(process.argv[1]).dependencies; const b = require(process.argv[2]).dependencies; process.exit(JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort()) ? 0 : 1)' "$APP/package.json" "$APP/$PREV/package.json"; then
  echo "  dependances d'execution modifiees : npm install"
  npm install --omit=dev --no-audit --no-fund
fi

echo "== 4/7 Migrations"
node --env-file=.env migrate.mjs --dir ./db/migrations

echo "== 5/7 Semis (reglages, regles d'alerte, droits)"
node --env-file=.env seeds-dist/run.js

echo "== 6/7 Redemarrage"
restart
sleep 6

echo "== 7/7 Controle"
ok=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  code="$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$URL/health/ready" || true)"
  if [ "$code" = "200" ]; then ok=1; break; fi
  echo "  /health/ready : HTTP $code (essai $i)"
  sleep 5
done
[ "$ok" = "1" ] || fail "/health/ready ne repond pas 200 apres le redemarrage"
index="$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$URL/" || true)"
[ "$index" = "200" ] || fail "la page d'accueil repond HTTP $index"

trap - ERR
rm -f "$BUNDLE"
ls -1dt releases/* 2>/dev/null | tail -n +6 | xargs -r rm -rf
echo "OK : livraison $RELEASE en ligne ($URL)."
echo "Ancienne version : $APP/$PREV"
[ "${NO_DB_BACKUP:-0}" = "1" ] || echo "Sauvegarde de la base : $DUMP"
