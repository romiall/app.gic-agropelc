/**
 * Diagnostic des taches planifiees et de l'organisation en ligne, EN LECTURE SEULE : la session de base est ouverte
 * en lecture seule (aucune ecriture possible) et le script ne contient que des SELECT. Sert a comprendre pourquoi la
 * sonde GET /health/ready rapporte des taches en echec (failed_jobs), a verifier que l'ordonnanceur tourne la nuit
 * (hebergement mutualise : un seul processus Passenger pour l'API, le worker et la PWA), a lire l'etat de
 * l'organisation (sites, zones, geoperes) et a savoir si le script d'initialisation de Bonaberi a deja tourne.
 *
 * Aucun mot de passe, jeton, adresse e-mail ni numero de telephone n'est affiche (masquage de la sortie) ; la charge
 * utile (payload) des taches n'est jamais lue ; le message d'erreur d'une tache est tronque a 240 caracteres.
 * Seule variable d'environnement affichee : TRUST_PROXY (nombre ou booleen, pas un secret).
 *
 * Usage, sur le serveur, dans le dossier de l'application, sans rien y copier (le script arrive par l'entree standard) :
 *   ssh ... "cd ~/domains/gic-agropelc.com/nodejs-app && node --env-file=.env --input-type=module -" < diag-jobs.mjs
 * Fichier ASCII volontairement.
 */

/** Masque ce qui ne doit jamais sortir du serveur : URL de base, jetons, secrets, e-mails, numeros camerounais. */
export function mask(text) {
  return String(text)
    .replace(/mysql:\/\/[^\s"']+/gi, 'mysql://[masque]')
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[jeton]')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [masque]')
    .replace(
      /(authorization|password|passwd|pwd|secret|token|jeton|mot de passe|api[_-]?key)(["']?\s*[:=]\s*|\s+)(?!(?:bearer|basic)\s)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1$2[masque]',
    )
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[courriel]')
    .replace(/\+?\(?237\)?[\s.-]?[26](?:[\s.-]?\d){8}/g, '[numero]')
    .replace(/(?<![\d.:-])[26](?:[ .]?\d){8}(?![\d.:-])/g, '[numero]');
}

function cell(value) {
  if (value === null || value === undefined) return '-';
  if (value instanceof Date) return value.toISOString();
  return mask(String(value).replace(/\s+/g, ' ').trim());
}

function printRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log('  (aucune ligne)');
    return;
  }
  for (const row of rows) {
    console.log(
      '  ' +
        Object.entries(row)
          .map(([key, value]) => key + '=' + cell(value))
          .join(' | '),
    );
  }
}

async function main() {
  const url = process.env.SERVER_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('SERVER_DATABASE_URL (ou DATABASE_URL) absent du .env.');

  const { createPool } = await import('mysql2');
  const pool = createPool({ uri: url, timezone: 'Z', dateStrings: true, connectionLimit: 1 });
  const conn = await new Promise((resolve, reject) =>
    pool.getConnection((error, c) => (error ? reject(error) : resolve(c))),
  );
  const run = (sql) =>
    new Promise((resolve, reject) =>
      conn.query(sql, (error, rows) => (error ? reject(error) : resolve(rows))),
    );

  // Lecture seule imposee par la base elle-meme, heures en UTC (comme les connexions du serveur).
  await run("SET time_zone = '+00:00'");
  await run('SET SESSION TRANSACTION READ ONLY');
  await run('START TRANSACTION READ ONLY');

  async function section(title, sql) {
    console.log('\n== ' + title);
    try {
      printRows(await run(sql));
    } catch (error) {
      console.log(
        '  ECHEC de la lecture : ' + cell(error instanceof Error ? error.message : error),
      );
    }
  }

  console.log('== Reglage de l adresse du proxy (TRUST_PROXY)');
  console.log(
    '  TRUST_PROXY = ' + (process.env.TRUST_PROXY ? mask(process.env.TRUST_PROXY) : '(absent)'),
  );

  await section(
    'Base (version, heure UTC)',
    'SELECT VERSION() AS version, NOW(6) AS maintenant_utc',
  );

  await section(
    'Ordonnanceur : derniere echeance deposee par type (un ordonnanceur qui tourne la nuit a une echeance recente)',
    `SELECT job_type, schedule_kind AS genre, interval_seconds AS intervalle_s, local_time AS heure_locale,
            last_enqueued_at AS derniere_echeance_deposee, next_run_at AS prochaine
       FROM platform_job_schedules ORDER BY job_type`,
  );
  await section(
    'Taches des 48 dernieres heures, par type et par etat',
    `SELECT job_type, status, COUNT(*) AS nb, MAX(run_at) AS derniere_echeance, MAX(attempts) AS essais_max
       FROM platform_jobs
      WHERE run_at > UTC_TIMESTAMP() - INTERVAL 48 HOUR
      GROUP BY job_type, status ORDER BY job_type, status`,
  );
  await section(
    'Taches en echec des 24 dernieres heures, par type et par erreur (240 caracteres, masquee)',
    `SELECT job_type, COUNT(*) AS nb, MIN(run_at) AS premiere, MAX(run_at) AS derniere,
            MAX(attempts) AS essais_max, LEFT(COALESCE(last_error, ''), 240) AS erreur
       FROM platform_jobs
      WHERE status = 'FAILED' AND run_at > UTC_TIMESTAMP() - INTERVAL 24 HOUR
      GROUP BY job_type, LEFT(COALESCE(last_error, ''), 240) ORDER BY nb DESC LIMIT 20`,
  );
  await section(
    'Echecs par jour (depuis quand ils durent ; les taches terminees sont purgees apres 30 jours)',
    `SELECT DATE(run_at) AS jour, COUNT(*) AS nb, COUNT(DISTINCT job_type) AS types
       FROM platform_jobs WHERE status = 'FAILED'
      GROUP BY DATE(run_at) ORDER BY jour DESC LIMIT 10`,
  );
  await section(
    'Taches en attente et deja dues (retard de l ordonnanceur ou du worker)',
    `SELECT job_type, COUNT(*) AS nb, MIN(run_at) AS plus_ancienne
       FROM platform_jobs WHERE status = 'PENDING' AND run_at <= UTC_TIMESTAMP()
      GROUP BY job_type ORDER BY plus_ancienne LIMIT 15`,
  );

  await section(
    'Sites (code, nom, type, etat)',
    'SELECT code, LEFT(name, 60) AS nom, site_type, status FROM organization_sites ORDER BY code LIMIT 40',
  );
  await section(
    'Zones : nombre total et nombre avec georepere (point et rayon)',
    `SELECT COUNT(*) AS zones, SUM(geofence_lat IS NOT NULL AND geofence_lng IS NOT NULL AND geofence_radius_m IS NOT NULL) AS avec_georepere,
            SUM(is_active) AS actives FROM organization_zones`,
  );
  await section(
    'Emplacements par type',
    'SELECT location_type, COUNT(*) AS nb FROM organization_locations GROUP BY location_type ORDER BY nb DESC',
  );

  await section(
    "Script d'initialisation de Bonaberi : produits, regles de prix, stock des emplacements POS-BONA et MAG-BONA",
    `SELECT code, LEFT(name, 40) AS nom, stock_family, status
       FROM catalog_products WHERE code IN ('POULET-CHAIR','POULET-VIF','OEUF-PLT','PORC-CHARC','PONDEUSE') ORDER BY code`,
  );
  await section(
    'Regles de prix PRIX-% (nombre)',
    "SELECT COUNT(*) AS regles FROM pricing_price_rules WHERE code LIKE 'PRIX-%'",
  );
  await section(
    'Stock sur POS-BONA et MAG-BONA (quantite en main, tous lots confondus)',
    `SELECT l.code AS emplacement, p.code AS produit, SUM(b.qty_on_hand) AS quantite
       FROM inventory_stock_balances b
       JOIN organization_locations l ON l.id = b.location_id
       JOIN catalog_products p ON p.id = b.product_id
      WHERE l.code IN ('POS-BONA', 'MAG-BONA')
      GROUP BY l.code, p.code ORDER BY l.code, p.code`,
  );

  await run('ROLLBACK');
  conn.release();
  pool.end();
}

// Appele directement (ou par l'entree standard) : lance le diagnostic ; importe (essai) : rien ne s'execute.
if (!process.env.DIAG_JOBS_NO_RUN) {
  main().catch((error) => {
    console.error('Echec du diagnostic : ' + mask(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  });
}
