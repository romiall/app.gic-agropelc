#!/usr/bin/env bash
# Sauvegarde quotidienne de la base (Hostinger). Execute SUR LE SERVEUR par une tache cron (voir README.md, section
# "Operations planifiees"), jamais a la main sans lire README.md. Aucun secret ici : l'identifiant de base vient du .env
# de l'application, ecrit dans un fichier temporaire (mode 600) que mysqldump lit puis qui est supprime.
#
# Ce que fait le script :
#   1. verrou (une seule sauvegarde a la fois), dossier de destination cree ;
#   2. mysqldump --single-transaction --routines --triggers, compresse, ecrit sous un nom provisoire ;
#   3. controle : archive gzip valide, taille minimale, pied "Dump completed", nombre de tables ; sinon le fichier
#      provisoire est supprime et le script echoue (code non nul : cron envoie le message d'erreur) ;
#   4. le fichier prend son nom definitif gic-daily-AAAAMMJJ-HHMMSS.sql.gz (UTC) ;
#   5. rotation (backup-rotate.mjs) : 14 jours, plus la derniere de chacun des 6 derniers mois, jamais la plus recente ;
#   6. une ligne dans le journal (backup.log, 500 lignes gardees).
# Les sauvegardes de livraison (~/backups_db/gic-<horodatage>.sql.gz) sont dans le dossier parent : jamais touchees.
#
# Variables (toutes facultatives) : APP_DIR, OPS_DIR (ou sont backup-rotate.mjs), BACKUP_DIR, BACKUP_LOG,
# BACKUP_KEEP_DAYS, BACKUP_KEEP_MONTHS, BACKUP_MIN_BYTES, BACKUP_MIN_TABLES, BACKUP_DUMP_ARGS (options de mysqldump en plus, par exemple
# --no-tablespaces sur un MySQL 8 dont le compte n a pas le privilege PROCESS).
# Fichier ASCII volontairement (sortie lisible dans la console Windows).
set -euo pipefail

APP="${APP_DIR:-$HOME/domains/gic-agropelc.com/nodejs-app}"
OPS="${OPS_DIR:-$HOME/gic-ops}"
DEST="${BACKUP_DIR:-$HOME/backups_db/daily}"
LOG="${BACKUP_LOG:-$HOME/backups_db/backup.log}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
KEEP_MONTHS="${BACKUP_KEEP_MONTHS:-6}"
MIN_BYTES="${BACKUP_MIN_BYTES:-20000}"
MIN_TABLES="${BACKUP_MIN_TABLES:-50}"
DUMP_ARGS="${BACKUP_DUMP_ARGS:-}"
export PATH=/opt/alt/alt-nodejs22/root/usr/bin:$PATH

STAMP="$(date -u +%Y%m%d-%H%M%S)"
FINAL="$DEST/gic-daily-$STAMP.sql.gz"
PARTIAL="$FINAL.partial"
CNF=""
LOCK="$DEST/.lock"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }
cleanup() {
  [ -n "$CNF" ] && rm -f "$CNF"
  rm -f "$PARTIAL"
  rmdir "$LOCK" 2>/dev/null || true
}
fail() {
  echo "ECHEC : $*" >&2
  log "ECHEC $*"
  exit 1
}

mkdir -p "$DEST" "$(dirname "$LOG")"
# Verrou : un script reste parfois bloque (reseau) ; au-dela de 3 heures le verrou est considere perime.
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +180 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null || true
    mkdir "$LOCK" 2>/dev/null || fail "verrou impossible a reprendre ($LOCK)"
  else
    echo "Une sauvegarde est deja en cours ($LOCK) : rien a faire."
    exit 0
  fi
fi
trap cleanup EXIT

[ -f "$APP/.env" ] || fail "$APP/.env introuvable (ce fichier n'est jamais versionne)"
DUMPER="$(command -v mysqldump || command -v mariadb-dump || true)"
[ -n "$DUMPER" ] || fail "mysqldump introuvable : sauvegarder la base dans hPanel (phpMyAdmin, Exporter)"

CNF="$(mktemp)"
chmod 600 "$CNF"
cd "$APP"
DBNAME="$(node --env-file=.env --input-type=module -e '
import fs from "node:fs";
const u = new URL(process.env.DATABASE_URL);
const esc = (s) => decodeURIComponent(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
fs.writeFileSync(process.argv[1], ["[client]", "user=\"" + esc(u.username) + "\"", "password=\"" + esc(u.password) + "\"", "host=\"" + u.hostname + "\"", "port=" + (u.port || 3306), ""].join("\n"));
console.log(decodeURIComponent(u.pathname.slice(1)));
' "$CNF")" || fail "lecture de DATABASE_URL impossible"
[ -n "$DBNAME" ] || fail "nom de la base introuvable dans DATABASE_URL"

# --hex-blob : les identifiants BINARY(16) sont ecrits en hexadecimal (un dump en texte sur, restaurable sans perte).
"$DUMPER" --defaults-extra-file="$CNF" --single-transaction --skip-lock-tables --routines --triggers --hex-blob $DUMP_ARGS "$DBNAME" | gzip > "$PARTIAL" \
  || fail "mysqldump a echoue"
rm -f "$CNF"
CNF=""

# Controle du fichier avant de lui donner son nom definitif.
SIZE="$(wc -c < "$PARTIAL" | tr -d ' ')"
[ "${SIZE:-0}" -ge "$MIN_BYTES" ] || fail "sauvegarde trop petite ($SIZE octets, minimum $MIN_BYTES)"
gzip -t "$PARTIAL" || fail "archive gzip invalide"
gzip -dc "$PARTIAL" | tail -n 3 | grep -q "Dump completed" || fail "pied 'Dump completed' absent : le dump est incomplet"
TABLES="$(gzip -dc "$PARTIAL" | grep -c '^CREATE TABLE' || true)"
[ "${TABLES:-0}" -ge "$MIN_TABLES" ] || fail "seulement $TABLES table(s) dans le dump (minimum $MIN_TABLES)"

mv "$PARTIAL" "$FINAL"
echo "OK : $FINAL ($(du -h "$FINAL" | cut -f1), $TABLES tables)"

ROTATION="rotation non faite (backup-rotate.mjs absent de $OPS)"
if [ -f "$OPS/backup-rotate.mjs" ]; then
  ROTATION="$(node "$OPS/backup-rotate.mjs" "$DEST" --keep-days "$KEEP_DAYS" --keep-months "$KEEP_MONTHS" | tail -n 1)"
fi
echo "$ROTATION"
printf '%s\n' "gic-daily-$STAMP.sql.gz" > "$DEST/latest.txt"
log "OK gic-daily-$STAMP.sql.gz $SIZE octets, $TABLES tables ; $ROTATION"
# Le journal ne grossit pas sans fin.
if [ "$(wc -l < "$LOG")" -gt 500 ]; then tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
