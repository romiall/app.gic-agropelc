
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
ITEMS="dist pwa seeds-dist db server.js migrate.mjs mariadb-compat.mjs compat-check.mjs approve-device.mjs grant-test-access.mjs package.json node_modules/@gic/domain node_modules/@gic/contracts"
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

echo "== 1/8 Extraction du paquet"
tar -xzf "$BUNDLE" -C "$NEW"
for f in dist pwa pkg-domain pkg-contracts seeds-dist db server.js migrate.mjs mariadb-compat.mjs compat-check.mjs approve-device.mjs grant-test-access.mjs package.json; do
  [ -e "$NEW/$f" ] || fail "$f absent du paquet"
done

echo "== 2/8 Sauvegarde de la base"
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

echo "== 3/8 Mise en place des nouveaux fichiers (ancienne version gardee dans $APP/$PREV)"
for item in $ITEMS; do
  if [ -e "$item" ]; then mkdir -p "$PREV/$(dirname "$item")"; mv "$item" "$PREV/$item"; fi
done
mv "$NEW/dist" dist
mv "$NEW/pwa" pwa
mv "$NEW/seeds-dist" seeds-dist
mv "$NEW/db" db
mv "$NEW/server.js" server.js
mv "$NEW/migrate.mjs" migrate.mjs
mv "$NEW/mariadb-compat.mjs" mariadb-compat.mjs
mv "$NEW/compat-check.mjs" compat-check.mjs
mv "$NEW/approve-device.mjs" approve-device.mjs
mv "$NEW/grant-test-access.mjs" grant-test-access.mjs
mv "$NEW/package.json" package.json
mv "$NEW/pkg-domain" node_modules/@gic/domain
mv "$NEW/pkg-contracts" node_modules/@gic/contracts
if [ ! -f "$PREV/package.json" ] || ! node -e 'const a = require(process.argv[1]).dependencies; const b = require(process.argv[2]).dependencies; process.exit(JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort()) ? 0 : 1)' "$APP/package.json" "$APP/$PREV/package.json"; then
  echo "  dependances d'execution modifiees : npm install"
  npm install --omit=dev --no-audit --no-fund
fi

echo "== 4/8 Controle de compatibilite SQL (base reelle, table temporaire)"
# MariaDB refuse CAST(? AS JSON) et FOR SHARE, que le code serveur emploie : mariadb-compat.mjs les reecrit, ce controle
# le prouve sur la vraie base avant tout redemarrage (la mise en ligne du 30/10/2026 avait casse la connexion sans lui).
node --env-file=.env compat-check.mjs || fail "controle de compatibilite SQL"

echo "== 5/8 Migrations"
node --env-file=.env migrate.mjs --dir ./db/migrations

echo "== 6/8 Semis (reglages, regles d'alerte, droits)"
node --env-file=.env seeds-dist/run.js

echo "== 7/8 Redemarrage"
ERR_LINES="$(wc -l < stderr.log 2>/dev/null || echo 0)"
restart
sleep 6

echo "== 8/8 Controle"
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
# La route de connexion avec un identifiant fictif : 401 attendu (429 si trop d'essais fictifs recents) ; une erreur 5xx
# trahit un defaut de l'API ou de la base que /health/ready ne voit pas.
login="$(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"phone":"controle@example.invalid","password":"controle-fictif","device_id":"00000000-0000-4000-8000-000000000001","platform":"PWA"}' "$URL/api/v1/auth/login" || true)"
case "$login" in
  401|429) ;;
  *) fail "la route de connexion repond HTTP $login (401 attendu pour un identifiant fictif)" ;;
esac
# Erreurs que le serveur a ecrites depuis le redemarrage (l'ordonnanceur tourne toutes les 3 secondes) : avertissement seulement.
sleep 8
new_errors="$(tail -n +$((ERR_LINES + 1)) stderr.log 2>/dev/null | grep -a -c 'ERROR' || true)"
if [ "${new_errors:-0}" != "0" ]; then
  echo "  AVERTISSEMENT : $new_errors erreur(s) ecrite(s) par le serveur depuis le redemarrage (stderr.log), les plus frequentes :"
  tail -n +$((ERR_LINES + 1)) stderr.log | grep -a 'ERROR' | sed -E 's/\x1b\[[0-9;]*m//g; s/^\[Nest\] [0-9]+ +- [0-9\/]+, [0-9:]+ [AP]M +//' | cut -c1-200 | sort | uniq -c | sort -rn | head -5
else
  echo "  aucune erreur ecrite par le serveur depuis le redemarrage"
fi

trap - ERR
rm -f "$BUNDLE"
ls -1dt releases/* 2>/dev/null | tail -n +6 | xargs -r rm -rf
echo "OK : livraison $RELEASE en ligne ($URL)."
echo "Ancienne version : $APP/$PREV"
[ "${NO_DB_BACKUP:-0}" = "1" ] || echo "Sauvegarde de la base : $DUMP"
