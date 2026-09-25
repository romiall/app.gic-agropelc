#!/usr/bin/env bash
# GIC AGROPELC — installation et démarrage local en une seule commande.
#
# Prérequis (à installer soi-même avant de lancer ce script) :
#   - Node.js 20.11 à 22.x, pnpm >= 9 (`corepack enable` suffit en général)
#   - Un serveur MySQL 8 déjà démarré, accessible en local, avec un compte admin capable
#     de créer des bases/utilisateurs (par défaut : root, sans mot de passe, 127.0.0.1:3306
#     — ajuster MYSQL_ROOT_USER/MYSQL_ROOT_PASSWORD/MYSQL_HOST/MYSQL_PORT sinon).
#
# Usage :
#   git clone --branch claude/affectionate-maxwell-qvgrzq https://github.com/romiall/app.gic-agropelc.git
#   cd app.gic-agropelc
#   ./quickstart.sh
#
# Le script installe, migre, seed, crée un compte administrateur local, construit les
# paquets, puis démarre le serveur API et la PWA. Il reste actif (logs à l'écran) tant
# qu'on ne fait pas Ctrl-C — les deux processus s'arrêtent alors proprement.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

MYSQL_ROOT_USER="${MYSQL_ROOT_USER:-root}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-}"
MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
DB_NAME="${DB_NAME:-gic_agropelc_dev}"
APP_DB_PASSWORD="${APP_DB_PASSWORD:-dev_local_password}"
ADMIN_PHONE="${ADMIN_PHONE:-+237600000001}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-ChangeMe123!}"
SERVER_PORT="${SERVER_PORT:-3000}"
# Port de la PWA non paramétrable ici : fixé dans apps/pwa/vite.config.ts (`server.port`),
# et le transfert d'un `--port` CLI à travers deux niveaux de scripts pnpm imbriqués
# (`pnpm run pwa:dev -- --port N`) insère un `--` supplémentaire que Vite interprète mal
# (constaté en testant ce script) — modifier vite.config.ts si un autre port est nécessaire.
PWA_PORT=5173

MYSQL_ROOT_ARGS=(--protocol=TCP -h"$MYSQL_HOST" -P"$MYSQL_PORT" -u"$MYSQL_ROOT_USER")
if [ -n "$MYSQL_ROOT_PASSWORD" ]; then
  MYSQL_ROOT_ARGS+=(-p"$MYSQL_ROOT_PASSWORD")
fi

echo "==> [1/7] Dépendances (pnpm install)"
pnpm install

echo "==> [2/7] Base '$DB_NAME' et utilisateur applicatif gic_app"
mysql "${MYSQL_ROOT_ARGS[@]}" -e "
  SET GLOBAL log_bin_trust_function_creators = 1;
  CREATE DATABASE IF NOT EXISTS ${DB_NAME};
  CREATE USER IF NOT EXISTS 'gic_app'@'%' IDENTIFIED BY '${APP_DB_PASSWORD}';
  GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO 'gic_app'@'%';
  FLUSH PRIVILEGES;
"

ROOT_URL_NO_PASS="mysql://${MYSQL_ROOT_USER}@${MYSQL_HOST}:${MYSQL_PORT}"
if [ -n "$MYSQL_ROOT_PASSWORD" ]; then
  export DATABASE_URL="mysql://${MYSQL_ROOT_USER}:${MYSQL_ROOT_PASSWORD}@${MYSQL_HOST}:${MYSQL_PORT}/${DB_NAME}"
else
  export DATABASE_URL="${ROOT_URL_NO_PASS}/${DB_NAME}"
fi
export SERVER_DATABASE_URL="mysql://gic_app:${APP_DB_PASSWORD}@${MYSQL_HOST}:${MYSQL_PORT}/${DB_NAME}"

echo "==> [3/7] Migrations (dbmate)"
pnpm run db:migrate

echo "==> [4/7] Seed (11 rôles, permissions, paramètres système — idempotent)"
pnpm run db:seed

echo "==> [5/7] Compte administrateur local (téléphone/mot de passe imprimés à la fin)"
pnpm run db:create-local-admin -- "$ADMIN_PHONE" "$ADMIN_PASSWORD"

echo "==> [6/7] Build (packages partagés + PWA)"
pnpm run build

echo "==> [7/7] Démarrage du serveur API et de la PWA"
LOG_DIR="$(mktemp -d)"
CLEANED_UP=0
cleanup() {
  [ "$CLEANED_UP" = "1" ] && return
  CLEANED_UP=1
  echo ""
  echo "Arrêt..."
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "${PWA_PID:-}" ] && kill "$PWA_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

PORT="$SERVER_PORT" HOST=0.0.0.0 SERVER_DATABASE_URL="$SERVER_DATABASE_URL" \
  pnpm run server:dev > "$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!

echo -n "Attente du serveur API (http://localhost:${SERVER_PORT}/health)"
for _ in $(seq 1 30); do
  if curl -sSf "http://localhost:${SERVER_PORT}/health" > /dev/null 2>&1; then
    echo " OK"
    break
  fi
  echo -n "."
  sleep 1
done

pnpm run pwa:dev > "$LOG_DIR/pwa.log" 2>&1 &
PWA_PID=$!

echo -n "Attente de la PWA (http://localhost:${PWA_PORT})"
for _ in $(seq 1 30); do
  if curl -sSf "http://localhost:${PWA_PORT}/" > /dev/null 2>&1; then
    echo " OK"
    break
  fi
  echo -n "."
  sleep 1
done

echo ""
echo "======================================================================"
echo " Application disponible : http://localhost:${PWA_PORT}"
echo " API                    : http://localhost:${SERVER_PORT} (GET /health)"
echo ""
echo " Connexion :"
echo "   Téléphone    : ${ADMIN_PHONE}"
echo "   Mot de passe : ${ADMIN_PASSWORD}"
echo ""
echo " Logs : $LOG_DIR/server.log , $LOG_DIR/pwa.log"
echo " Ctrl-C pour arrêter le serveur API et la PWA."
echo "======================================================================"

wait "$SERVER_PID" "$PWA_PID"
