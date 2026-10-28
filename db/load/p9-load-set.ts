/**
 * Jeu de charge de P9 (P9-22 ; ADR-068 §5, NFR-12, NFR-13, RISK-13) : un million de lignes de vente (et leurs
 * ventes) sur 366 jours, inséré directement dans `sales_sales` et `sales_sale_lines` à partir des références
 * déjà semées de la base visée (site, emplacement, zone, utilisateur, canal, produits, motif). Hors de la suite par
 * défaut ; lancé à la demande :
 *
 *   export DATABASE_URL=…
 *   pnpm --filter @gic/db load:p9 [ventes] [jours]
 *
 * **Base dédiée seulement** (P9-25, PF-10) : le nom de la base visée doit se terminer par `_load` (refus sinon,
 * `load-database-guard.ts`) ; les ventes sont immuables (déclencheurs), le jeu ne se retire pas, et les balayages
 * d'invariants de P4 et de P8 les verraient. Sans valeur aléatoire : identifiants, montants, produits et ordre se
 * déduisent du numéro de la vente ; les dates, aux dates près, sont relatives au jour de génération (`UTC_DATE()`).
 * Les identifiants portent un préfixe (`F9F9F9F9…` ventes, `E9E9E9E9…` lignes) : le jeu se reconnaît et ne heurte
 * aucune ligne réelle. Relancer le générateur complète sans doubler : les ventes et les lignes déjà présentes sont
 * écartées par un test de présence sur l'identifiant, jamais par `INSERT IGNORE` (toute autre violation de
 * contrainte est une erreur). Chaque paquet (ventes puis lignes) est une transaction ; la fin de l'exécution
 * vérifie le nombre de ventes et de lignes.
 *
 * Volume par défaut : 250 000 ventes de 1 à 4 lignes, soit 625 000 lignes ; `ventes = 400000` approche le million
 * de lignes de l'ADR-068. Les « satellites » lus par les tableaux (encaissements, mouvements) ne sont pas générés :
 * le jeu mesure le chemin le plus lourd, les lignes de vente (`analytics_f_sales_line`).
 */
import type mysql from 'mysql2/promise';
import { connectUtc } from '../seeds/connection.js';
import { assertLoadDatabase } from './load-database-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL non définie (voir db/README.md).');
}

const SALES = Number(process.argv[2] ?? 250_000);
const DAYS = Number(process.argv[3] ?? 366);
const CHUNK = 20_000;
const PRODUCTS = 40;

if (!Number.isInteger(SALES) || SALES < 1 || !Number.isInteger(DAYS) || DAYS < 1) {
  throw new Error('Usage : load:p9 [ventes ≥ 1] [jours ≥ 1].');
}

/** Expressions SQL des identifiants du jeu (`n` : numéro de vente ; `lineNo` : numéro de ligne). */
const saleId = (n: string): string => `UNHEX(CONCAT('F9F9F9F9', LPAD(HEX(${n}), 24, '0')))`;
const lineId = (n: string, lineNo: string): string =>
  `UNHEX(CONCAT('E9E9E9E9', LPAD(HEX(${n} * 10 + ${lineNo}), 24, '0')))`;

const conn = await connectUtc(DATABASE_URL);

async function one<T>(sqlText: string, what: string): Promise<T> {
  const [rows] = await conn.query(sqlText);
  const row = (rows as T[])[0];
  if (row === undefined) throw new Error(`Référence introuvable pour le jeu de charge : ${what}.`);
  return row;
}

try {
  // Garde avant toute écriture : seule une base dédiée (nom en `_load`) reçoit le jeu.
  const [[{ name: database }]] = (await conn.query('SELECT DATABASE() AS name')) as unknown as [
    [{ name: string | null }],
  ];
  assertLoadDatabase(database);
  process.stdout.write(`Base de charge : ${database}\n`);

  // Références : le premier site actif qui a un emplacement physique et une zone, et un utilisateur actif.
  const ref = await one<{ site: Buffer; location: Buffer; zone: Buffer }>(
    `SELECT st.id AS site, lo.id AS location, st.zone_id AS zone
       FROM organization_sites st
       JOIN organization_locations lo ON lo.site_id = st.id AND lo.is_virtual = 0 AND lo.status = 'ACTIVE'
      WHERE st.status = 'ACTIVE' AND st.zone_id IS NOT NULL
      ORDER BY st.id, lo.id LIMIT 1`,
    'site, emplacement et zone actifs',
  );
  const user = await one<{ id: Buffer }>(
    `SELECT id FROM identity_users WHERE status = 'ACTIVE' ORDER BY is_system DESC, id LIMIT 1`,
    'utilisateur actif',
  );
  const channel = await one<{ code: string }>(
    `SELECT code FROM catalog_sales_channels ORDER BY code LIMIT 1`,
    'canal de vente',
  );
  const reason = await one<{ id: Buffer }>(
    `SELECT id FROM catalog_reason_codes ORDER BY id LIMIT 1`,
    'motif (prix libre)',
  );

  await conn.query(`DROP TEMPORARY TABLE IF EXISTS p9_load_products`);
  await conn.query(
    `CREATE TEMPORARY TABLE p9_load_products (idx INT PRIMARY KEY, id BINARY(16) NOT NULL, name VARCHAR(200) NOT NULL, unit VARCHAR(20) NOT NULL)`,
  );
  await conn.query(
    `INSERT INTO p9_load_products (idx, id, name, unit)
     SELECT ROW_NUMBER() OVER (ORDER BY p.id) - 1, p.id, p.name, p.base_unit_code
       FROM catalog_products p WHERE p.status = 'ACTIVE' ORDER BY p.id LIMIT ${PRODUCTS}`,
  );
  const [[{ n: productCount }]] = (await conn.query(
    `SELECT COUNT(*) AS n FROM p9_load_products`,
  )) as unknown as [[{ n: number }]];
  if (productCount === 0) throw new Error('Aucun produit actif pour le jeu de charge.');

  // Début de la plage : DAYS jours se terminant à la date du jour (UTC).
  const [[{ start }]] = (await conn.query(
    `SELECT DATE_SUB(UTC_DATE(), INTERVAL ${DAYS - 1} DAY) AS start`,
  )) as unknown as [[{ start: Date }]];

  await conn.query(`DROP TEMPORARY TABLE IF EXISTS p9_load_numbers`);
  await conn.query(`CREATE TEMPORARY TABLE p9_load_numbers (n INT PRIMARY KEY)`);
  await conn.query(`SET SESSION cte_max_recursion_depth = ${CHUNK + 10}`);

  let created = 0;
  let expectedLines = 0;
  for (let from = 1; from <= SALES; from += CHUNK) {
    const to = Math.min(SALES, from + CHUNK - 1);
    await conn.query(`TRUNCATE TABLE p9_load_numbers`);
    await conn.query(
      `INSERT INTO p9_load_numbers (n)
       WITH RECURSIVE s (n) AS (SELECT ? UNION ALL SELECT n + 1 FROM s WHERE n < ?) SELECT n FROM s`,
      [from, to],
    );
    // Lignes d'abord calculées dans une table de travail, pour que le sous-total de la vente soit la somme exacte
    // de ses lignes (contraintes `ck_sales_sales_total` et `ck_sales_sale_lines_total`).
    await conn.query(`DROP TEMPORARY TABLE IF EXISTS p9_load_lines`);
    await conn.query(
      `CREATE TEMPORARY TABLE p9_load_lines AS
       SELECT x.n, k.k AS line_no, pr.id AS product_id, pr.name AS product_name, pr.unit AS unit,
              (1 + ((x.n + k.k) MOD 5)) AS qty,
              (1000 + ((x.n * 7 + k.k * 13) MOD 40) * 250) AS price
         FROM p9_load_numbers x
         JOIN (SELECT 1 AS k UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4) k
           ON k.k <= 1 + (x.n MOD 4)
         JOIN p9_load_products pr ON pr.idx = (x.n + k.k) MOD ${productCount}`,
    );
    // La table de travail dit ce qui doit exister pour ce paquet, présent ou non.
    const [[{ n: chunkLines }]] = (await conn.query(
      `SELECT COUNT(*) AS n FROM p9_load_lines`,
    )) as unknown as [[{ n: number }]];
    expectedLines += Number(chunkLines);

    // Ventes puis lignes dans une même transaction : une erreur n'en laisse pas la moitié (les lignes
    // validées ne se retirent plus). La table cible figure dans le FROM de premier niveau (anti-jointure sur
    // l'identifiant), jamais dans une sous-requête : MySQL le refuse pour INSERT … SELECT.
    await conn.beginTransaction();
    try {
      const [salesResult] = await conn.query<mysql.ResultSetHeader>(
        `INSERT INTO sales_sales
           (id, doc_number, site_id, sale_type, channel_code, from_location_id, zone_id, seller_user_id,
            status, subtotal_xaf, total_xaf, amount_paid_xaf, occurred_at, created_by)
         SELECT ${saleId('t.n')}, CONCAT('LOAD-', t.n), ?, 'DIRECT', ?, ?, ?, ?,
                'CONFIRMED', t.total, t.total, IF(t.n MOD 3 = 0, 0, t.total),
                TIMESTAMP(DATE_ADD(?, INTERVAL (t.n MOD ${DAYS}) DAY), SEC_TO_TIME(28800 + (t.n MOD 36000))), ?
           FROM (SELECT n, SUM(qty * price) AS total FROM p9_load_lines GROUP BY n) t
           LEFT JOIN sales_sales e ON e.id = ${saleId('t.n')}
          WHERE e.id IS NULL`,
        [ref.site, channel.code, ref.location, ref.zone, user.id, start, user.id],
      );
      const [linesResult] = await conn.query<mysql.ResultSetHeader>(
        `INSERT INTO sales_sale_lines
           (id, sale_id, line_no, product_id, product_name_snapshot, quantity, unit_code, quantity_base,
            pricing_quantity, pricing_unit_code, unit_price_xaf, price_source, override_reason_code_id,
            line_total_xaf, unit_cost_xaf, cost_xaf)
         SELECT ${lineId('l.n', 'l.line_no')}, ${saleId('l.n')}, l.line_no, l.product_id, l.product_name,
                l.qty, l.unit, l.qty, l.qty, l.unit, l.price, 'MANUAL_OVERRIDE', ?,
                l.qty * l.price, ROUND(l.price * 0.6), ROUND(l.qty * l.price * 0.6)
           FROM p9_load_lines l
           LEFT JOIN sales_sale_lines e ON e.id = ${lineId('l.n', 'l.line_no')}
          WHERE e.id IS NULL`,
        [reason.id],
      );
      await conn.commit();
      created += salesResult.affectedRows;
      process.stdout.write(
        `  + ${to}/${SALES} ventes (${salesResult.affectedRows} créées, ${linesResult.affectedRows} lignes)\n`,
      );
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  }

  // Vérification bruyante : le jeu doit être complet (ventes LOAD-1 à LOAD-SALES et toutes leurs lignes).
  // Alias n_sales et n_lines : LINES est un mot réservé de MySQL.
  const [[found]] = (await conn.query(
    `SELECT (SELECT COUNT(*) FROM sales_sales
              WHERE id BETWEEN ${saleId('1')} AND ${saleId(String(SALES))}) AS n_sales,
            (SELECT COUNT(*) FROM sales_sale_lines l
               JOIN sales_sales s ON s.id = l.sale_id
              WHERE s.id BETWEEN ${saleId('1')} AND ${saleId(String(SALES))}) AS n_lines`,
  )) as unknown as [[{ n_sales: number; n_lines: number }]];
  if (Number(found.n_sales) !== SALES || Number(found.n_lines) !== expectedLines) {
    throw new Error(
      `Jeu de charge incomplet : ${found.n_sales} ventes sur ${SALES}, ${found.n_lines} lignes sur ${expectedLines} ; ` +
        `relancer le générateur (une exécution interrompue se complète) ou recréer la base.`,
    );
  }
  process.stdout.write(
    `Jeu de charge P9 : ${found.n_sales} ventes (${created} créées) et ${found.n_lines} lignes sur ${DAYS} jours, ` +
      `${productCount} produits (site, emplacement et zone de référence).\n`,
  );
} finally {
  await conn.end();
}
