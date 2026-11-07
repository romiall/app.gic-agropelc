#!/usr/bin/env bash
# Sauvegarde de la base (Hostinger), UNE TOUS LES DEUX JOURS, cinq copies au plus (decision du porteur du 07/11/2026).
# Execute SUR LE SERVEUR par une tache cron (voir README.md, section "Operations planifiees"), jamais a la main sans
# lire README.md. Aucun secret ici : l'identifiant de base vient du .env de l'application, ecrit dans un fichier
# temporaire (mode 600) que mysqldump lit puis qui est supprime.
#
# Frequence : le cron peut passer CHAQUE NUIT ; le script ne sauvegarde que si la derniere sauvegarde a plus de
# BACKUP_MIN_INTERVAL_HOURS (44 h par defaut), donc une nuit sur deux. Une nuit en echec est reprise des la nuit
# suivante (un cron "un jour sur deux" attendrait deux jours de plus). BACKUP_FORCE=1 ignore ce delai (essai a la main).
#
# Ce que fait le script :
#   0. rien a faire si la derniere sauvegarde est recente (voir ci-dessus) ;
#   1. verrou (une seule sauvegarde a la fois), dossier de destination cree ;
#   2. mysqldump --single-transaction --routines --triggers, compresse, ecrit sous un nom provisoire ;
#   3. controle : archive gzip valide, taille minimale, pied "Dump completed", nombre de tables ; sinon le fichier
#      provisoire est supprime et le script echoue (code non nul : cron envoie le message d'erreur) ;
#   4. le fichier prend son nom definitif gic-daily-AAAAMMJJ-HHMMSS.sql.gz (UTC), latest.txt et une ligne OK du journal
#      (backup.log, 500 lignes gardees) sont ecrits : la sauvegarde existe, quoi qu'il arrive ensuite ;
#   5. rotation (backup-rotate.mjs --keep-last 5) : les cinq plus recentes sont gardees, la plus ancienne est supprimee
#      apres chaque ajout (cinq copies = dix jours d'historique) ; son echec (code non nul, sortie inattendue) est
#      journalise ECHEC et fait echouer le script : la derniere ligne du journal est lue par pull-backups.ps1, qui
#      s'arrete alors au lieu de "reussir" en silence.
# Les sauvegardes de livraison (~/backups_db/gic-<horodatage>.sql.gz) sont dans le dossier parent : jamais touchees ici
# (remote-update.sh en garde cinq).
# Le dump contient toutes les donnees de GIC (comptes, mots de passe haches, ventes) : umask 077, dossier en 700.
#
# Variables (toutes facultatives) : APP_DIR, OPS_DIR (ou sont backup-rotate.mjs), BACKUP_DIR, BACKUP_LOG,
# BACKUP_KEEP_LAST (5), BACKUP_MIN_INTERVAL_HOURS (44), BACKUP_FORCE (0), BACKUP_MIN_BYTES, BACKUP_MIN_TABLES,
# BACKUP_DUMP_ARGS (options de mysqldump en plus, par exemple --no-tablespaces sur un MySQL 8 dont le compte n a pas
# le privilege PROCESS).
# Fichier ASCII volontairement (sortie lisible dans la console Windows).
set -euo pipefail
umask 077

APP="${APP_DIR:-$HOME/domains/gic-agropelc.com/nodejs-app}"
OPS="${OPS_DIR:-$HOME/gic-ops}"
DEST="${BACKUP_DIR:-$HOME/backups_db/daily}"
LOG="${BACKUP_LOG:-$HOME/backups_db/backup.log}"
KEEP_LAST="${BACKUP_KEEP_LAST:-5}"
MIN_INTERVAL_HOURS="${BACKUP_MIN_INTERVAL_HOURS:-44}"
FORCE="${BACKUP_FORCE:-0}"
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
chmod 700 "$DEST" 2>/dev/null || true

# Reglages numeriques : une valeur absurde est un echec journalise, pas un comportement imprevu.
case "$KEEP_LAST" in ''|*[!0-9]*|0) fail "BACKUP_KEEP_LAST doit etre un entier superieur ou egal a 1 ($KEEP_LAST)" ;; esac
case "$MIN_INTERVAL_HOURS" in ''|*[!0-9]*) fail "BACKUP_MIN_INTERVAL_HOURS doit etre un entier ($MIN_INTERVAL_HOURS)" ;; esac

# Une sauvegarde tous les deux jours : rien a faire tant que la derniere a moins de MIN_INTERVAL_HOURS (date du fichier,
# ecrit a la fin de la sauvegarde). Aucune ligne de journal : backup.log ne garde que les sauvegardes et les echecs, et sa
# derniere ligne reste celle que pull-backups.ps1 lit.
if [ "$FORCE" != "1" ] && [ "$MIN_INTERVAL_HOURS" -gt 0 ]; then
  LAST_BACKUP="$(ls -1 "$DEST" 2>/dev/null | grep -E '^gic-daily-[0-9]{8}-[0-9]{6}\.sql\.gz$' | sort | tail -n 1 || true)"
  if [ -n "$LAST_BACKUP" ] && [ -n "$(find "$DEST/$LAST_BACKUP" -maxdepth 0 -mmin "-$((MIN_INTERVAL_HOURS * 60))" 2>/dev/null)" ]; then
    echo "Derniere sauvegarde ($LAST_BACKUP) de moins de ${MIN_INTERVAL_HOURS} h : rien a faire (BACKUP_FORCE=1 pour forcer)."
    exit 0
  fi
fi

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
# La sauvegarde existe : latest.txt et la ligne OK sont ecrits AVANT la rotation, dont un echec ne les efface pas.
printf '%s\n' "gic-daily-$STAMP.sql.gz" > "$DEST/latest.txt"
log "OK gic-daily-$STAMP.sql.gz $SIZE octets, $TABLES tables"

# Le journal ne grossit pas sans fin.
trim_log() { if [ "$(wc -l < "$LOG")" -gt 500 ]; then tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi; }

if [ -f "$OPS/backup-rotate.mjs" ]; then
  # Un code non nul de la rotation (sous `set -e`, l'affectation aurait tue le script sans une ligne de journal) ou une
  # sortie qui ne commence pas par "rotation :" (script muet) sont des echecs journalises.
  ROTATION="$(node "$OPS/backup-rotate.mjs" "$DEST" --keep-last "$KEEP_LAST" | tail -n 1)" \
    || { trim_log; fail "rotation en echec (backup-rotate.mjs) ; la sauvegarde $FINAL existe"; }
  case "$ROTATION" in
    "rotation :"*) ;;
    *) trim_log; fail "sortie inattendue de backup-rotate.mjs : '$ROTATION' ; la sauvegarde $FINAL existe" ;;
  esac
  echo "$ROTATION"
  log "ROTATION $ROTATION"
else
  echo "rotation non faite (backup-rotate.mjs absent de $OPS)"
  log "ROTATION non faite (backup-rotate.mjs absent de $OPS)"
fi
trim_log
