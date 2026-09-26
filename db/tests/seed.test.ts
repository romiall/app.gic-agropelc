// Teste seeds/run.ts en l'exécutant réellement (processus séparé, même commande que
// `pnpm run db:seed`) : contrairement aux autres fichiers de ce dossier, ce test écrit
// réellement dans DATABASE_URL (le seed n'a pas vocation à être annulé — withRollback,
// helpers.ts, ne convient pas ici) et vérifie l'idempotence par une seconde exécution
// réelle, pas une simulation.
//
// Décomptes de rôles/octrois toujours filtrés par `is_system = TRUE` (jamais un COUNT(*)
// brut) : depuis P0-06, apps/server/test crée aussi, réellement (même raison : pas de
// rollback possible sur des tables en ajout renforcé), des rôles de test — non-`is_system`
// par construction (insertTestRole, apps/server/test/helpers.ts). `identity_permissions`
// n'a pas besoin du même traitement : le seed déprécie déjà tout code hors catalogue
// (seedPermissions, seeds/run.ts), ce qui neutralise les permissions de test au passage.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import {
  PERMISSIONS,
  ROLE_DISCOUNT_SETTINGS,
  ROLE_PERMISSIONS,
  ROLES,
} from '../seeds/rbac-data.js';
import { VIRTUAL_LOCATIONS } from '../seeds/virtual-locations.js';
import { SYSTEM_SETTINGS } from '../seeds/system-settings.js';
import { LEAD_SOURCES, PIPELINE_STEPS } from '../seeds/crm-references.js';

const dbRoot = fileURLToPath(new URL('..', import.meta.url));

function runSeed(): void {
  // `execSync` (commande unique) plutôt que `execFileSync('npx', [...])` : sous Windows,
  // `npx` résout vers `npx.cmd` (shim npm), que Node ne peut exécuter directement sans
  // passer par un shell (limitation documentée de `child_process` sur Windows) — sans
  // cela, `execFileSync` échoue en ENOENT (spawn direct, pas de résolution de l'extension).
  // `execSync` route toujours par un shell, donc pas de bascule `shell: true` séparée ici
  // (qui, combinée à un tableau d'arguments, déclenche l'avertissement DEP0190). Sans
  // incidence sur POSIX (commande figée, aucune entrée utilisateur interpolée). Bug
  // d'environnement local (première exécution native Windows de cette suite), sans
  // rapport avec P2-04.
  execSync('npx tsx seeds/run.ts', { cwd: dbRoot, env: process.env, stdio: 'pipe' });
}

describe('seed P0-05 (db/seeds/run.ts)', () => {
  let conn: mysql.Connection;

  beforeAll(async () => {
    runSeed();
    conn = await mysql.createConnection(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await conn.end();
  });

  it('crée exactement les 11 rôles, 118 permissions et 483 octrois attendus', async () => {
    const [[roles]] = await conn.query<mysql.RowDataPacket[][]>(
      'SELECT COUNT(*) AS c FROM identity_roles WHERE is_system = TRUE',
    );
    expect((roles as unknown as { c: number }).c).toBe(ROLES.length);
    expect(ROLES.length).toBe(11);

    const [[permissions]] = await conn.query<mysql.RowDataPacket[][]>(
      'SELECT COUNT(*) AS c FROM identity_permissions WHERE deprecated_at IS NULL',
    );
    expect((permissions as unknown as { c: number }).c).toBe(PERMISSIONS.length);
    expect(PERMISSIONS.length).toBe(119); // + inventory.loss.read (AV-094, P2)

    const [[grants]] = await conn.query<mysql.RowDataPacket[][]>(
      `SELECT COUNT(*) AS c FROM identity_role_permissions rp
       JOIN identity_roles r ON r.id = rp.role_id
       WHERE r.is_system = TRUE`,
    );
    expect((grants as unknown as { c: number }).c).toBe(ROLE_PERMISSIONS.length);
    expect(ROLE_PERMISSIONS.length).toBe(491); // + 8 octrois inventory.loss.read (AV-094)
  });

  it('crée les 9 emplacements virtuels (BR-ADM-010)', async () => {
    const [[locations]] = await conn.query<mysql.RowDataPacket[][]>(
      'SELECT COUNT(*) AS c FROM organization_locations WHERE is_virtual = TRUE',
    );
    expect((locations as unknown as { c: number }).c).toBe(VIRTUAL_LOCATIONS.length);
    expect(VIRTUAL_LOCATIONS.length).toBe(9);
  });

  it('crée les référentiels CRM par défaut (AV-011, AV-018), KOMMO en source système', async () => {
    // Filtré par code : les tests serveur créent aussi leurs propres étapes et sources.
    const [steps] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT code FROM crm_pipeline_steps WHERE code IN (?) AND is_active = TRUE',
      [PIPELINE_STEPS.map((s) => s.code)],
    );
    expect(steps).toHaveLength(PIPELINE_STEPS.length);
    const [sources] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT code, is_system FROM crm_lead_sources WHERE code IN (?)',
      [LEAD_SOURCES.map((s) => s.code)],
    );
    expect(sources).toHaveLength(LEAD_SOURCES.length);
    expect(sources.find((s) => s.code === 'KOMMO')?.is_system).toBe(1);
  });

  it('crée au moins les paramètres système par défaut documentés', async () => {
    const [[settings]] = await conn.query<mysql.RowDataPacket[][]>(
      "SELECT COUNT(*) AS c FROM organization_system_settings WHERE scope_type = 'GLOBAL' AND scope_id IS NULL",
    );
    expect((settings as unknown as { c: number }).c).toBeGreaterThanOrEqual(
      SYSTEM_SETTINGS.length + ROLE_DISCOUNT_SETTINGS.length,
    );
  });

  it('exécute le bootstrap identity_users une seule fois (auto-référencé)', async () => {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT HEX(id) AS id, HEX(created_by) AS created_by FROM identity_users WHERE is_system = TRUE',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.created_by).toBe(rows[0]!.id);
  });

  it('accorde le plafond de remise attendu à chaque rôle commercial (RC-06, AV-026)', async () => {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT r.code AS role_code, rp.max_scope, rp.limits
       FROM identity_role_permissions rp
       JOIN identity_roles r ON r.id = rp.role_id
       WHERE rp.permission_code = 'sales.price.override'
       ORDER BY r.code`,
    );
    const byRole = new Map(rows.map((row) => [row.role_code as string, row]));

    expect(byRole.get('RESP_COMMERCIAL')?.limits).toEqual({ max_discount_pct: 15 });
    expect(byRole.get('COMMERCIAL_TERRAIN')?.limits).toEqual({ max_discount_pct: 5 });
    expect(byRole.get('COMMERCIAL_SEDENTAIRE')?.limits).toEqual({ max_discount_pct: 5 });
    expect(byRole.get('RESP_FERME')?.limits).toEqual({ max_discount_pct: 5 });
    // VENDEUR_PDV : 0 % documenté par absence d'octroi, jamais une ligne à limits nuls.
    expect(byRole.get('VENDEUR_PDV')).toBeUndefined();

    // organization_system_settings.pricing.max_discount_pct.<ROLE> doit rester cohérent
    // avec les mêmes limits (seule source : ROLE_DISCOUNT_SETTINGS, dérivée des mêmes
    // valeurs — ce test vérifie que les deux chemins d'écriture restent synchronisés).
    for (const setting of ROLE_DISCOUNT_SETTINGS) {
      const roleCode = setting.key.replace('pricing.max_discount_pct.', '');
      const grant = byRole.get(roleCode);
      expect(grant?.limits).toEqual({ max_discount_pct: setting.value });
    }
  });

  it("marque identity.device.approve comme permission d'approbation", async () => {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT is_approval FROM identity_permissions WHERE code = ?',
      ['identity.device.approve'],
    );
    expect(rows[0]?.is_approval).toBe(1);
  });

  it('est idempotent : une seconde exécution ne modifie aucun décompte', async () => {
    runSeed();

    const [[roles]] = await conn.query<mysql.RowDataPacket[][]>(
      'SELECT COUNT(*) AS c FROM identity_roles WHERE is_system = TRUE',
    );
    expect((roles as unknown as { c: number }).c).toBe(ROLES.length);

    const [[permissions]] = await conn.query<mysql.RowDataPacket[][]>(
      'SELECT COUNT(*) AS c FROM identity_permissions WHERE deprecated_at IS NULL',
    );
    expect((permissions as unknown as { c: number }).c).toBe(PERMISSIONS.length);

    const [[grants]] = await conn.query<mysql.RowDataPacket[][]>(
      `SELECT COUNT(*) AS c FROM identity_role_permissions rp
       JOIN identity_roles r ON r.id = rp.role_id
       WHERE r.is_system = TRUE`,
    );
    expect((grants as unknown as { c: number }).c).toBe(ROLE_PERMISSIONS.length);

    const [[users]] = await conn.query<mysql.RowDataPacket[][]>(
      'SELECT COUNT(*) AS c FROM identity_users WHERE is_system = TRUE',
    );
    expect((users as unknown as { c: number }).c).toBe(1);

    const [[locations]] = await conn.query<mysql.RowDataPacket[][]>(
      'SELECT COUNT(*) AS c FROM organization_locations WHERE is_virtual = TRUE',
    );
    expect((locations as unknown as { c: number }).c).toBe(VIRTUAL_LOCATIONS.length);
  });
});
