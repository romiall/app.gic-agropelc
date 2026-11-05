#!/usr/bin/env bash
# Purge planifiee des alertes closes (AV-470 ; commande d'exploitation `db:purge-alerts`). Execute SUR LE SERVEUR par
# une tache cron hebdomadaire (voir README.md, section "Operations planifiees").
#
# La purge exige normalement un role de maintenance (gic_maintenance, MAINTENANCE_DATABASE_URL, jamais de repli sur la
# connexion de l'application). L'hebergement n'a qu'un seul utilisateur de base : la connexion de maintenance est ici
# celle du .env (DATABASE_URL), lue dans le processus de la purge seulement, jamais ecrite ni affichee.
# La duree de conservation vient du parametre communication.alert_retention_days (plancher de 730 jours).
#
# Sortie : une ligne par passe (nombre d'alertes supprimees) ; code non nul si la purge echoue.
# Fichier ASCII volontairement.
set -euo pipefail
APP="${APP_DIR:-$HOME/domains/gic-agropelc.com/nodejs-app}"
LOG="${PURGE_LOG:-$HOME/backups_db/purge-alerts.log}"
export PATH=/opt/alt/alt-nodejs22/root/usr/bin:$PATH

cd "$APP"
[ -f .env ] || { echo "ECHEC : $APP/.env introuvable" >&2; exit 1; }
[ -f dist/purge-alerts.js ] || { echo "ECHEC : dist/purge-alerts.js introuvable (livraison incomplete ?)" >&2; exit 1; }
mkdir -p "$(dirname "$LOG")"

# La purge se fait par lots : relancer tant qu'elle dit qu'il reste des alertes (dix passes au plus par execution).
for pass in 1 2 3 4 5 6 7 8 9 10; do
  out="$(MAINTENANCE_DATABASE_URL="$(node --env-file=.env -e 'process.stdout.write(process.env.DATABASE_URL || "")')" node dist/purge-alerts.js)" \
    || { printf '%s ECHEC passe %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$pass" >> "$LOG"; echo "ECHEC : la purge a echoue (passe $pass)" >&2; exit 1; }
  echo "$out"
  printf '%s passe %s : %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$pass" "$out" >> "$LOG"
  case "$out" in
    *"relancer la commande"*) ;;
    *) break ;;
  esac
done
if [ "$(wc -l < "$LOG")" -gt 500 ]; then tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
