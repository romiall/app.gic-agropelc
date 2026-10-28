#!/usr/bin/env bash
# Vérification finale d'une phase : base neuve, migrations, seed, puis toutes les suites une seule fois.
# Prérequis : MySQL 8.4 démarré sur le port 3307 (voir reprise/prompt-reprise-p9.md) ; `db/.env` présent.
# Après ce script, rejouer les essais d'analyse en seconde passe : cd apps/server && npx vitest run test/analytics-*.test.ts
# Usage : final_suite.sh <base>
set -uo pipefail
DB="${1:-gic_agropelc_p9v}"
REPO=/c/xampp/htdocs/app.gic-agropelc
SCRATCH="${TMPDIR:-/tmp}"
cd "$REPO"
set -a; . db/.env; set +a
ROOT_URL="${DATABASE_URL%/*}"
APP_URL="${SERVER_DATABASE_URL%/*}"
echo "### base : $DB — commit $(git rev-parse --short HEAD) + arbre de travail"

cat > "$SCRATCH/create_db.cjs" <<EOF
const mysql = require('C:/xampp/htdocs/app.gic-agropelc/db/node_modules/mysql2/promise');
(async () => {
  const c = await mysql.createConnection('${ROOT_URL}');
  const row = { cs: 'utf8mb4', co: 'utf8mb4_0900_as_cs' };
  await c.query('DROP DATABASE IF EXISTS \`${DB}\`');
  await c.query('CREATE DATABASE \`${DB}\` CHARACTER SET ' + row.cs + ' COLLATE ' + row.co);
  await c.end();
  console.log('base créée', row.cs, row.co);
})().catch((e) => { console.error(e); process.exit(1); });
EOF
node "$SCRATCH/create_db.cjs" || { echo "ECHEC création de la base"; exit 1; }

export DATABASE_URL="$ROOT_URL/$DB"
export SERVER_DATABASE_URL="$APP_URL/$DB"
run() { local name="$1"; shift; echo "### $name"; local t0=$SECONDS; "$@" > "/tmp/final_$name.log" 2>&1; local rc=$?; echo "    code $rc en $((SECONDS-t0)) s"; sed 's/\x1b\[[0-9;]*m//g' "/tmp/final_$name.log" | grep -E "Test Files|Tests  |FAIL|error TS|✖|problems?|violations|Errors  |Unhandled|identifiant|orpheline|lien relatif|aucun" | head -25; }
run migrations bash -c "cd db && npx dbmate --no-dump-schema --migrations-dir ./migrations up"
run seed bash -c "cd db && npx tsx seeds/run.ts"
run format bash -c "git diff --name-only HEAD | grep -v 'quickstart.sh\|SessionDetail.tsx' | xargs -I{} sh -c 'test -f \"{}\" && echo \"{}\"' | xargs pnpm exec prettier --check; git ls-files --others --exclude-standard apps db packages docs | xargs pnpm exec prettier --check"
run typecheck pnpm run typecheck
run lint npx eslint apps packages db
run domaine bash -c "cd packages/domain && npx vitest run"
run contrats bash -c "cd packages/contracts && npx vitest run"
run pwa bash -c "cd apps/pwa && npx vitest run"
run base bash -c "cd db && npx vitest run"
run serveur bash -c "cd apps/server && npx vitest run"
run frontieres pnpm run check:boundaries
run docs python -I docs/_tools/check_refs.py
echo "### TERMINÉ"
