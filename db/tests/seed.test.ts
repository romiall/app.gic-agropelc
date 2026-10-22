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
import type mysql from 'mysql2/promise';
import { connectUtc } from '../seeds/connection.js';
import {
  PERMISSIONS,
  ROLE_DISCOUNT_SETTINGS,
  ROLE_PERMISSIONS,
  ROLES,
} from '../seeds/rbac-data.js';
import { VIRTUAL_LOCATIONS } from '../seeds/virtual-locations.js';
import { SYSTEM_SETTINGS } from '../seeds/system-settings.js';
import {
  CRM_REASON_CODES,
  CUSTOMER_CATEGORIES,
  LEAD_SOURCES,
  PIPELINE_STEPS,
} from '../seeds/crm-references.js';
import {
  EXPENSE_CATEGORIES,
  FINANCE_CONTROL_POLICIES,
  PAYMENT_METHODS,
} from '../seeds/finance-references.js';
import { CONTROL_POLICIES } from '../seeds/production-references.js';
import { SALES_CONTROL_POLICIES } from '../seeds/sales-references.js';
import { PROCUREMENT_CONTROL_POLICIES } from '../seeds/procurement-references.js';
import { STOCK_FIELDWORK_CONTROL_POLICIES } from '../seeds/stock-fieldwork-references.js';
import { codeEntityId } from '../seeds/code-entity-id.js';

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
    conn = await connectUtc(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await conn.end();
  });

  it('crée exactement les 11 rôles, 124 permissions et 503 octrois attendus', async () => {
    const [[roles]] = await conn.query<mysql.RowDataPacket[][]>(
      'SELECT COUNT(*) AS c FROM identity_roles WHERE is_system = TRUE',
    );
    expect((roles as unknown as { c: number }).c).toBe(ROLES.length);
    expect(ROLES.length).toBe(11);

    const [[permissions]] = await conn.query<mysql.RowDataPacket[][]>(
      'SELECT COUNT(*) AS c FROM identity_permissions WHERE deprecated_at IS NULL',
    );
    expect((permissions as unknown as { c: number }).c).toBe(PERMISSIONS.length);
    expect(PERMISSIONS.length).toBe(124); // + inventory.loss.read (AV-094, P2), production.overhead.allocate (P7-10), sales.payment.reallocate et .refund (P4-08), inventory.allocation.release (AV-162, P5-06), finance.expense_category.manage (AV-270, P8-03)

    const [[grants]] = await conn.query<mysql.RowDataPacket[][]>(
      `SELECT COUNT(*) AS c FROM identity_role_permissions rp
       JOIN identity_roles r ON r.id = rp.role_id
       WHERE r.is_system = TRUE`,
    );
    expect((grants as unknown as { c: number }).c).toBe(ROLE_PERMISSIONS.length);
    // + 8 octrois inventory.loss.read (AV-094) ; + 2 octrois inventory.cost_entry.record
    // (Resp. production, Resp. ferme : frais généraux, AV-103, P7-02) ; + 2 octrois
    // production.overhead.allocate (Resp. production, Finance : répartition, AV-106, P7-10) ;
    // + 2 octrois sales.payment.reallocate et .refund (Finance, P4-08) ;
    // + 2 octrois inventory.allocation.release (Commercial terrain, Vendeur PDV : portée propre, AV-162, P5-06) ;
    // + 1 octroi finance.cash_transfer.record OWN (Resp. commercial : alignement sur la matrice §5.5, P5-15) ;
    // + 2 octrois finance.expense_category.manage (Finance, Administrateur : AV-270, P8-03) ;
    // + 1 octroi finance.expense.record OWN (Resp. commercial : alignement sur la matrice §5.5, P8-03) ;
    // + 1 octroi identity.device.read SITE du Resp. production (AV-261, MP-06).
    expect(ROLE_PERMISSIONS.length).toBe(504);
    expect(
      ROLE_PERMISSIONS.find(
        (grant) =>
          grant.roleCode === 'RESP_COMMERCIAL' && grant.permissionCode === 'finance.expense.record',
      )?.maxScope,
    ).toBe('OWN');
    expect(
      ROLE_PERMISSIONS.find(
        (grant) =>
          grant.roleCode === 'RESP_COMMERCIAL' &&
          grant.permissionCode === 'finance.cash_transfer.record',
      )?.maxScope,
    ).toBe('OWN');
  });

  it('crée les 9 emplacements virtuels globaux (BR-ADM-010 ; « à livrer » est par site, ADR-028)', async () => {
    const [[locations]] = await conn.query<mysql.RowDataPacket[][]>(
      'SELECT COUNT(*) AS c FROM organization_locations WHERE is_virtual = TRUE AND site_id IS NULL',
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

  it('crée les motifs de départ (AV-248) et les cinq catégories de clients (AV-017)', async () => {
    const [reasons] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT category, code, requires_comment FROM catalog_reason_codes
        WHERE category IN ('VISIT_OUTCOME', 'PROSPECT_LOST', 'CANCELLATION') AND is_active = TRUE`,
    );
    for (const seed of CRM_REASON_CODES) {
      const row = reasons.find((r) => r.category === seed.category && r.code === seed.code);
      expect(row, `${seed.category} ${seed.code}`).toBeDefined();
      expect(row!.requires_comment, `${seed.category} ${seed.code}`).toBe(
        seed.requiresComment ? 1 : 0,
      );
    }
    // COMMANDE_PRISE est lu par KPI-COM-12 ; « Autre » exige un commentaire dans chaque catégorie.
    expect(CRM_REASON_CODES.filter((r) => r.code === 'AUTRE' && r.requiresComment)).toHaveLength(3);
    expect(
      CRM_REASON_CODES.some((r) => r.category === 'VISIT_OUTCOME' && r.code === 'COMMANDE_PRISE'),
    ).toBe(true);
    const [categories] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT code FROM catalog_customer_categories WHERE code IN (?) AND is_active = TRUE',
      [CUSTOMER_CATEGORIES.map((c) => c.code)],
    );
    expect(categories).toHaveLength(5);
  });

  it('crée les cinq moyens de paiement (AV-056), référence exigée hors espèces', async () => {
    const [methods] = await conn.query<mysql.RowDataPacket[]>(
      'SELECT code, requires_reference FROM finance_payment_methods WHERE code IN (?) AND is_active = TRUE',
      [PAYMENT_METHODS.map((m) => m.code)],
    );
    expect(methods).toHaveLength(5);
    expect(methods.filter((m) => m.requires_reference === 0).map((m) => m.code)).toEqual([
      'ESPECES',
    ]);
  });

  it('crée les dix catégories de dépense (AV-058, AV-270), NON_JUSTIFIEE système, identifiants UUIDv7', async () => {
    const [categories] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT code, BIN_TO_UUID(id) AS id, default_cost_type, allowed_on_pos, is_system
       FROM finance_expense_categories WHERE code IN (?) ORDER BY code`,
      [EXPENSE_CATEGORIES.map((c) => c.code)],
    );
    expect(categories).toHaveLength(10);
    expect(categories.filter((c) => c.is_system === 1).map((c) => c.code)).toEqual([
      'NON_JUSTIFIEE',
    ]);
    expect(categories.filter((c) => c.allowed_on_pos === 1).map((c) => c.code)).toEqual([
      'CARBURANT',
      'DIVERS',
      'ENTRETIEN',
      'FOURNITURES',
      'TRANSPORT',
    ]);
    expect(categories.find((c) => c.code === 'VETERINAIRE')?.default_cost_type).toBe('VETERINAIRE');
    // ADR-042 §9 : UUIDv7, administrable par commande (l'enveloppe exige un UUIDv7 d'agrégat).
    for (const category of categories) {
      expect(category.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it('crée les politiques de contrôle par défaut, dont celles des achats (AV-294) et du stock et du pointage (AV-318), approbateur du catalogue', async () => {
    const all = [
      ...CONTROL_POLICIES,
      ...SALES_CONTROL_POLICIES,
      ...FINANCE_CONTROL_POLICIES,
      ...PROCUREMENT_CONTROL_POLICIES,
      ...STOCK_FIELDWORK_CONTROL_POLICIES,
    ];
    // MP-12 : sans elles, l'écart d'un transfert reçu, un inventaire au-dessus du seuil et une
    // dérogation de pointage étaient refusés `CONTROL_POLICY_MISSING` sur une base neuve.
    expect(STOCK_FIELDWORK_CONTROL_POLICIES.map((policy) => policy.operationType).sort()).toEqual([
      'CHECKIN_OVERRIDE',
      'INVENTORY_ADJUSTMENT',
      'TRANSFER_DISCREPANCY',
    ]);
    expect(PROCUREMENT_CONTROL_POLICIES.map((policy) => policy.operationType).sort()).toEqual([
      'PURCHASE_ORDER',
      'PURCHASE_REQUEST',
      'RECEIPT_CANCELLATION',
      'RECEIPT_QUARANTINE',
      'RECEIPT_WITHOUT_PO',
    ]);
    const permissions = new Set(PERMISSIONS.map((permission) => permission.code));
    for (const policy of all) {
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT operation_type, approver_permission, approver_scope, requires_approval, valid_from
           FROM approvals_control_policies WHERE code = ?`,
        [policy.code],
      );
      expect(rows, policy.code).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        operation_type: policy.operationType,
        approver_permission: policy.approverPermission,
        approver_scope: policy.approverScope,
        requires_approval: 1,
      });
      // En vigueur depuis toujours : une politique créée ensuite (plus récente) passe devant.
      expect((rows[0]!.valid_from as Date).getUTCFullYear()).toBe(2020);
      expect(permissions.has(policy.approverPermission), policy.approverPermission).toBe(true);
    }
  });

  it('crée au moins les paramètres système par défaut documentés', async () => {
    const [[settings]] = await conn.query<mysql.RowDataPacket[][]>(
      "SELECT COUNT(*) AS c FROM organization_system_settings WHERE scope_type = 'GLOBAL' AND scope_id IS NULL",
    );
    expect((settings as unknown as { c: number }).c).toBeGreaterThanOrEqual(
      SYSTEM_SETTINGS.length + ROLE_DISCOUNT_SETTINGS.length,
    );
  });

  it('sème la caisse sans limite par jour (AV-154) et le pas d’enregistrement du pull (AV-319), en vigueur en base', async () => {
    const seeded = new Map(SYSTEM_SETTINGS.map((setting) => [setting.key, setting]));
    // Un retour accidentel de `finance.cash_sessions_per_day_max` à 1 rétablirait le blocage du PDV
    // après la clôture de sa caisse (vérification des écrans du 13/10/2026, C9) sans que rien ne rougisse.
    expect(seeded.get('finance.cash_sessions_per_day_max')).toMatchObject({
      value: 0,
      isClientVisible: true,
    });
    expect(seeded.get('sync.pull_record_grain_seconds')).toMatchObject({
      value: 60,
      isClientVisible: false,
    });
    for (const key of ['finance.cash_sessions_per_day_max', 'sync.pull_record_grain_seconds']) {
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        "SELECT `value` FROM organization_system_settings WHERE `key` = ? AND scope_type = 'GLOBAL' AND scope_id IS NULL ORDER BY valid_from DESC LIMIT 1",
        [key],
      );
      expect(rows, key).toHaveLength(1);
      expect(rows[0]!.value, key).toBe(seeded.get(key)!.value);
    }
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

  it('publie chaque moyen de paiement dans le flux, sous sa clé dérivée (P4-11, ADR-031)', async () => {
    // Valeur épinglée aussi par apps/server/test (code-entity-id) : les deux calculs concordent.
    expect(codeEntityId('PAYMENT_METHOD', 'ESPECES')).toBe('a54b88b0-36c9-59e3-8d51-3464ef06b112');
    for (const method of PAYMENT_METHODS) {
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS c FROM sync_change_feed
          WHERE dataset = 'catalog' AND entity_type = 'PAYMENT_METHOD' AND scope_type = 'GLOBAL'
            AND entity_id = UNHEX(REPLACE(?, '-', ''))`,
        [codeEntityId('PAYMENT_METHOD', method.code)],
      );
      expect((rows[0] as { c: number }).c).toBeGreaterThanOrEqual(1);
    }
  });

  it('publie les référentiels semés dans le flux, une ligne GLOBAL chacun (P5-18, AV-196)', async () => {
    // Chaque ligne à publier a sa ligne `UPSERT` `GLOBAL` (même requête que publish-references.ts).
    const missing = async (dataset: string, entityType: string, rowsSql: string) => {
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS c FROM (${rowsSql}) r
          WHERE NOT EXISTS (
            SELECT 1 FROM sync_change_feed f
             WHERE f.dataset = ? AND f.entity_type = ? AND f.entity_id = r.id
               AND f.change_type = 'UPSERT' AND f.scope_type = 'GLOBAL')`,
        [dataset, entityType],
      );
      return Number((rows[0] as { c: number }).c);
    };
    expect(await missing('catalog', 'REASON_CODE', 'SELECT id FROM catalog_reason_codes')).toBe(0);
    expect(await missing('catalog', 'PIPELINE_STEP', 'SELECT id FROM crm_pipeline_steps')).toBe(0);
    expect(await missing('catalog', 'LEAD_SOURCE', 'SELECT id FROM crm_lead_sources')).toBe(0);
    // MP-02 (AV-017) : catégories de clients, au jeu du repli générique de leurs commandes.
    expect(
      await missing(
        'customer_category',
        'CUSTOMER_CATEGORY',
        'SELECT id FROM catalog_customer_categories',
      ),
    ).toBe(0);
    expect(
      await missing('catalog', 'EXPENSE_CATEGORY', 'SELECT id FROM finance_expense_categories'),
    ).toBe(0);
    expect(
      await missing(
        'policies',
        'CONTROL_POLICY',
        "SELECT id FROM approvals_control_policies WHERE status = 'ACTIVE'",
      ),
    ).toBe(0);
    expect(
      await missing(
        'location',
        'LOCATION',
        'SELECT id FROM organization_locations WHERE is_virtual = TRUE AND site_id IS NULL',
      ),
    ).toBe(0);
    // Paramètres : la version en vigueur de chaque clé visible du seed.
    for (const setting of SYSTEM_SETTINGS.filter((item) => item.isClientVisible)) {
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS c FROM sync_change_feed f
          WHERE f.dataset = 'me' AND f.entity_type = 'SETTING' AND f.entity_id = (
            SELECT s.id FROM organization_system_settings s
             WHERE s.\`key\` = ? AND s.scope_type = 'GLOBAL'
             ORDER BY s.valid_from DESC, s.created_at DESC LIMIT 1)`,
        [setting.key],
      );
      expect((rows[0] as { c: number }).c, setting.key).toBeGreaterThanOrEqual(1);
    }
    // Étapes et sources semées, par leur code.
    for (const [table, items] of [
      ['crm_pipeline_steps', PIPELINE_STEPS],
      ['crm_lead_sources', LEAD_SOURCES],
    ] as const) {
      for (const item of items) {
        const [rows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT COUNT(*) AS c FROM ${table} t JOIN sync_change_feed f
              ON f.entity_id = t.id AND f.dataset = 'catalog'
           WHERE t.code = ?`,
          [item.code],
        );
        expect((rows[0] as { c: number }).c, item.code).toBeGreaterThanOrEqual(1);
      }
    }
    // Unités et canaux : clé dérivée du code (ADR-031).
    for (const [table, entityType] of [
      ['catalog_units', 'UNIT'],
      ['catalog_sales_channels', 'SALES_CHANNEL'],
    ] as const) {
      const [codes] = await conn.query<mysql.RowDataPacket[]>(`SELECT code FROM ${table}`);
      for (const { code } of codes) {
        const [rows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT COUNT(*) AS c FROM sync_change_feed
            WHERE dataset = 'catalog' AND entity_type = ? AND entity_id = UNHEX(REPLACE(?, '-', ''))`,
          [entityType, codeEntityId(entityType, code as string)],
        );
        expect((rows[0] as { c: number }).c, `${entityType} ${code}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  // Rejoue tout le seed dans un processus séparé : délai propre, plus long que celui du fichier.
  it(
    'est idempotent : une seconde exécution ne modifie aucun décompte',
    { timeout: 60_000 },
    async () => {
      const feedCount = async () => {
        const [rows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT COUNT(*) AS c FROM sync_change_feed
          WHERE dataset IN ('catalog', 'me', 'policies', 'location', 'customer_category')`,
        );
        return Number((rows[0] as { c: number }).c);
      };
      const feedBefore = await feedCount();
      runSeed();
      // P5-18 : la publication des référentiels semés n'ajoute rien à la seconde exécution.
      expect(await feedCount()).toBe(feedBefore);

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
        'SELECT COUNT(*) AS c FROM organization_locations WHERE is_virtual = TRUE AND site_id IS NULL',
      );
      expect((locations as unknown as { c: number }).c).toBe(VIRTUAL_LOCATIONS.length);
    },
  );
});
