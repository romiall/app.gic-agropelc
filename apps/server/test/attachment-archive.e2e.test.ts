/**
 * Archive des photos jointes de bout en bout (AV-539, ADR-070) : vraie base d'essai, vrais documents propriétaires
 * (réceptions, dépenses, pertes, mortalité, factures), vrai stockage de fichiers (dossier temporaire), câblage HTTP
 * réel (NestJS + Fastify, `app.inject`).
 *
 * La base d'essai est partagée et persistante : chaque exécution choisit une **année lointaine au hasard** pour son
 * horloge figée et ses périodes, si bien que ni les photos d'un autre essai ni celles d'une exécution précédente de
 * celui-ci ne tombent dans ses périodes. Les assertions ne portent que sur les identifiants créés ici.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { FixedClock, isSafeArchivePath } from '@gic/domain';
import type { ArchiveView } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { registerRawBodyParser } from '../src/platform/http/register-raw-body-parser.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { CHUNK_STORAGE } from '../src/platform/storage/chunk-storage.provider.js';
import { LocalFsChunkStorage } from '../src/platform/storage/local-fs-chunk-storage.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import {
  type JwtKeyPair,
  signAccessToken,
} from '../src/modules/identity/application/public/jwt.js';
import {
  AttachmentArchiveService,
  type DownloadStream,
} from '../src/attachments-api/archive/archive-service.js';
import { signArchiveTicket } from '../src/attachments-api/archive/archive-ticket.js';
import { attachmentStorageKey } from '../src/modules/attachments/application/commands/attachment-commands.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestLocation,
  insertTestProduct,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
  signTestAccessToken,
} from './helpers.js';
import { readStoredZip } from './zip-reader.js';

/** Année de cette exécution (périodes uniques dans la base partagée). */
const YEAR = 2100 + Math.floor(Math.random() * 7000);
const DAY_MS = 86_400_000;
/** Instant de l'année de l'essai : mois 1 à 12, jour, heure, minute, seconde, milliseconde (UTC). */
const at = (month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): Date =>
  new Date(Date.UTC(YEAR, month - 1, day, hour, minute, second, ms));
const NOW = at(11, 1, 10);
const CUTOFF = new Date(NOW.getTime() - 30 * DAY_MS); // 1er octobre + 1 jour, 10 h
const EXPORT = 'attachments.archive.export';
const PURGE = 'attachments.archive.purge';
const SINCE = new Date('1980-01-01T00:00:00.000Z');

const clock = new FixedClock(NOW);

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function jpeg(size: number): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(size)]);
}

function pdf(size: number): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(size)]);
}

async function ensurePermission(trx: UnitOfWork, code: string): Promise<void> {
  const known = await trx
    .selectFrom('identity_permissions')
    .select('code')
    .where('code', '=', code)
    .executeTakeFirst();
  if (known) return;
  await trx
    .insertInto('identity_permissions')
    .values({
      code,
      module: 'attachments',
      description: 'Permission de test',
      supported_scopes: '["ALL"]',
    })
    .execute();
}

describe(`archive des photos jointes (AV-539, ADR-070) — année d'essai ${YEAR}`, () => {
  let app: NestFastifyApplication;
  let storage: LocalFsChunkStorage;
  let storageDir: string;
  let service: AttachmentArchiveService;
  let jwtKeys: JwtKeyPair;

  // acteurs
  let admin: string;
  let adminToken: string;
  let adminDevice: string;
  let adminSession: string;
  let exportOnlyToken: string;
  let nobody: string;
  let nobodyToken: string;
  let nobodyDevice: string;
  let nobodySession: string;

  // monde
  let site: string;
  let store: string;
  let product: string;
  let supplier: string;
  let expenseCategory: string;

  beforeAll(async () => {
    process.env.SERVER_DATABASE_URL ??=
      'mysql://gic_app:gic_app_password@127.0.0.1:3306/gic_agropelc_test';
    storageDir = await mkdtemp(join(tmpdir(), 'gic-archive-test-'));
    storage = new LocalFsChunkStorage(storageDir);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .overrideProvider(CHUNK_STORAGE)
      .useValue(storage)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerRawBodyParser(app);
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    service = app.get(AttachmentArchiveService);
    jwtKeys = app.get<JwtKeyPair>(JWT_KEYS);

    await db.transaction().execute(async (trx) => {
      await ensurePermission(trx, EXPORT);
      await ensurePermission(trx, PURGE);
      await ensurePermission(trx, 'attachments.attachment.manage');
    });

    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    adminDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));
    adminSession = freshUuid();
    adminToken = await signTestAccessToken(
      jwtKeys.privateKey,
      { sub: admin, device_id: adminDevice, session_id: adminSession },
      NOW,
    );
    await db.transaction().execute(async (trx) => {
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, EXPORT, admin);
      await grantTestPermission(trx, role, PURGE, admin);
      await assignTestRole(trx, admin, role, admin, { validFrom: SINCE });
    });

    const exportOnly = await db.transaction().execute((trx) => insertTestUser(trx));
    const exportOnlyDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, exportOnly, { status: 'ACTIVE' }));
    exportOnlyToken = await signTestAccessToken(
      jwtKeys.privateKey,
      { sub: exportOnly, device_id: exportOnlyDevice, session_id: freshUuid() },
      NOW,
    );
    await db.transaction().execute(async (trx) => {
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, EXPORT, admin);
      await assignTestRole(trx, exportOnly, role, admin, { validFrom: SINCE });
    });

    nobody = await db.transaction().execute((trx) => insertTestUser(trx));
    nobodyDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, nobody, { status: 'ACTIVE' }));
    nobodySession = freshUuid();
    nobodyToken = await signTestAccessToken(
      jwtKeys.privateKey,
      { sub: nobody, device_id: nobodyDevice, session_id: nobodySession },
      NOW,
    );
    await db.transaction().execute(async (trx) => {
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, 'attachments.attachment.manage', admin, {
        maxScope: 'OWN',
      });
      await assignTestRole(trx, nobody, role, admin, { validFrom: SINCE });
    });

    await db.transaction().execute(async (trx) => {
      const zone = await insertTestZone(trx, admin);
      site = await insertTestSite(trx, admin, zone);
      store = await insertTestLocation(trx, admin, site, { locationType: 'STORE' });
      product = await insertTestProduct(trx, admin);
      supplier = freshUuid();
      await trx
        .insertInto('procurement_suppliers')
        .values({
          id: toBin(supplier),
          code: `F-${supplier.slice(-10)}`,
          name: 'Couvoir du Wouri',
          supplied_categories: JSON.stringify([]),
          status: 'ACTIVE',
          created_by: toBin(admin),
        })
        .execute();
      expenseCategory = freshUuid();
      await trx
        .insertInto('finance_expense_categories')
        .values({
          id: toBin(expenseCategory),
          code: `CAT-${expenseCategory.slice(-12)}`,
          label: 'Frais divers',
          created_by: toBin(admin),
        })
        .execute();
    });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
    await rm(storageDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------------------------------------------
  // Fabriques
  // -------------------------------------------------------------------------------------------------------------

  const docSuffix = () => freshUuid().replace(/-/g, '').slice(-10).toUpperCase();

  async function receipt(
    status: string,
    over: { bl?: string | null; localRef?: string | null } = {},
  ): Promise<string> {
    const id = freshUuid();
    await db
      .insertInto('procurement_goods_receipts')
      .values({
        id: toBin(id),
        doc_number: `RC-T-${docSuffix()}`,
        local_ref: over.localRef ?? null,
        site_id: toBin(site),
        supplier_id: toBin(supplier),
        location_id: toBin(store),
        received_by: toBin(admin),
        supplier_delivery_note_ref: over.bl ?? null,
        status,
        occurred_at: new Date(NOW.getTime() - 40 * DAY_MS),
        created_by: toBin(admin),
      })
      .execute();
    return id;
  }

  async function setReceiptStatus(id: string, status: string): Promise<void> {
    await db
      .updateTable('procurement_goods_receipts')
      .set({ status })
      .where('id', '=', toBin(id))
      .execute();
  }

  async function expense(status: string, localRef: string | null = null): Promise<string> {
    const id = freshUuid();
    await db
      .insertInto('finance_expenses')
      .values({
        id: toBin(id),
        doc_number: `DEP-T-${docSuffix()}`,
        local_ref: localRef,
        site_id: toBin(site),
        category_id: toBin(expenseCategory),
        amount_xaf: 5_000,
        description: 'Achat de petit matériel',
        paid_now: false,
        status,
        occurred_at: new Date(NOW.getTime() - 40 * DAY_MS),
        created_by: toBin(admin),
      })
      .execute();
    return id;
  }

  async function loss(category: string, status: string): Promise<string> {
    const id = freshUuid();
    await db
      .insertInto('inventory_loss_declarations')
      .values({
        id: toBin(id),
        doc_number: `PERTE-T-${docSuffix()}`,
        site_id: toBin(site),
        location_id: toBin(store),
        product_id: toBin(product),
        quantity_base: '1',
        unit_code: 'TETE',
        quantity: '1',
        category,
        declared_by: toBin(admin),
        status,
        unit_cost_xaf: 0,
        value_xaf: 0,
        ...(category === 'MORTALITE' ? { production_lot_id: toBin(freshUuid()) } : {}),
        occurred_at: new Date(NOW.getTime() - 40 * DAY_MS),
        created_by: toBin(admin),
      })
      .execute();
    return id;
  }

  async function invoice(status: 'PAID' | 'APPROVED'): Promise<string> {
    const id = freshUuid();
    await db
      .insertInto('finance_supplier_invoices')
      .values({
        id: toBin(id),
        doc_number: `FF-T-${docSuffix()}`,
        supplier_id: toBin(supplier),
        supplier_invoice_ref: `FAC-${docSuffix()}`,
        invoice_date: at(8, 1),
        due_date: at(9, 1),
        total_xaf: 10_000,
        paid_xaf: status === 'PAID' ? 10_000 : 0,
        status,
        approved_by: toBin(admin),
        approved_at: new Date(NOW.getTime() - 50 * DAY_MS),
        occurred_at: new Date(NOW.getTime() - 50 * DAY_MS),
        created_by: toBin(admin),
      })
      .execute();
    return id;
  }

  async function pendingApproval(subjectType: string, subjectId: string): Promise<void> {
    await db
      .insertInto('approvals_approval_requests')
      .values({
        id: toBin(freshUuid()),
        operation_type: 'RECEIPT_VALUE',
        subject_type: subjectType,
        subject_id: toBin(subjectId),
        subject_summary: 'Réception à valider',
        requested_by: toBin(admin),
        requested_at: new Date(NOW.getTime() - 40 * DAY_MS),
        status: 'PENDING',
        created_by: toBin(admin),
      })
      .execute();
  }

  interface Photo {
    readonly id: string;
    readonly bytes: Buffer;
    readonly sha256: string;
    readonly ownerType: string;
    readonly ownerId: string;
  }

  async function photo(
    ownerType: string,
    ownerId: string,
    receivedAt: Date,
    options: {
      readonly bytes?: Buffer;
      readonly mime?: string;
      readonly kind?: string;
      readonly skipFile?: boolean;
    } = {},
  ): Promise<Photo> {
    const bytes = options.bytes ?? jpeg(600 + Math.floor(Math.random() * 900));
    const id = freshUuid();
    await db
      .insertInto('attachments_attachments')
      .values({
        id: toBin(id),
        owner_type: ownerType,
        owner_id: toBin(ownerId),
        kind: options.kind ?? 'PHOTO',
        mime_type: options.mime ?? 'image/jpeg',
        size_bytes: bytes.length,
        sha256: sha256(bytes),
        storage_key: attachmentStorageKey(id),
        upload_status: 'AVAILABLE',
        uploaded_bytes: bytes.length,
        captured_at: new Date(receivedAt.getTime() - 5 * 60_000),
        occurred_at: new Date(receivedAt.getTime() - 5 * 60_000),
        received_at: receivedAt,
        created_by: toBin(admin),
      })
      .execute();
    if (options.skipFile !== true) await storage.appendChunk(attachmentStorageKey(id), 0, bytes);
    return { id, bytes, sha256: sha256(bytes), ownerType, ownerId };
  }

  const call = (
    token: string | undefined,
    method: 'GET' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(payload !== undefined ? { payload } : {}),
    });

  const keyPath = (id: string) => join(storageDir, attachmentStorageKey(id));

  async function archiveRows(archiveId: string) {
    return db
      .selectFrom('attachments_archive_items')
      .select([
        'attachment_id',
        'state',
        'release_reason',
        'entry_path',
        'volume_id',
        'resolved_at',
      ])
      .where('archive_id', '=', toBin(archiveId))
      .execute();
  }

  async function auditActions(archiveId: string): Promise<string[]> {
    const rows = await db
      .selectFrom('audit_audit_log')
      .select(['action', 'result'])
      .where('entity_type', '=', 'ATTACHMENT_ARCHIVE')
      .where('entity_id', '=', toBin(archiveId))
      .orderBy('seq')
      .execute();
    return rows.map((row) => `${row.action}:${row.result}`);
  }

  async function volumeRow(volumeId: string) {
    return db
      .selectFrom('attachments_archive_volumes')
      .selectAll()
      .where('id', '=', toBin(volumeId))
      .executeTakeFirstOrThrow();
  }

  async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const value = await read();
      if (done(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return read();
  }

  /** Billet puis téléchargement ; un volume est téléchargé à la fois (`429` le temps que le précédent se règle). */
  async function download(archive: ArchiveView, volumeId: string) {
    const ticket = await call(
      adminToken,
      'POST',
      `/api/v1/attachment-archives/${archive.id}/volumes/${volumeId}/ticket`,
    );
    expect(ticket.statusCode, ticket.body).toBe(200);
    const { url } = ticket.json() as { url: string };
    expect(url.startsWith('/api/v1/attachment-archives/download?ticket=')).toBe(true);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await app.inject({ method: 'GET', url });
      if (response.statusCode !== 429) return response;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return app.inject({ method: 'GET', url });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Droits
  // -------------------------------------------------------------------------------------------------------------

  it('réservé à l’administrateur : sans jeton 401, sans droit 403 audité, le vidage exige son propre droit', async () => {
    expect((await call(undefined, 'GET', '/api/v1/attachment-archives/catalog')).statusCode).toBe(
      401,
    );
    for (const [method, url, payload] of [
      ['GET', '/api/v1/attachment-archives/catalog', undefined],
      ['GET', '/api/v1/attachment-archives', undefined],
      [
        'POST',
        '/api/v1/attachment-archives',
        { granularity: 'QUARTER', periodStart: `${YEAR}-07-01` },
      ],
    ] as const) {
      const response = await call(nobodyToken, method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    const denied = await db
      .selectFrom('audit_audit_log')
      .select('action')
      .where('actor_user_id', '=', toBin(nobody))
      .where('entity_type', '=', 'ATTACHMENT_ARCHIVE')
      .execute();
    expect(denied.length).toBeGreaterThanOrEqual(3);
    expect(denied.every((row) => row.action === 'access.denied')).toBe(true);

    const purge = await call(
      exportOnlyToken,
      'POST',
      `/api/v1/attachment-archives/${freshUuid()}/purge`,
      { confirm: true },
    );
    expect(purge.statusCode).toBe(403);
    // un droit d'export suffit au catalogue
    expect(
      (await call(exportOnlyToken, 'GET', '/api/v1/attachment-archives/catalog')).statusCode,
    ).toBe(200);
  });

  it('refuse un corps mal formé et un vidage sans confirmation (400), une archive inconnue (404)', async () => {
    const bad = await call(adminToken, 'POST', '/api/v1/attachment-archives', {
      granularity: 'WEEK',
      periodStart: `${YEAR}-07-01`,
    });
    expect(bad.statusCode).toBe(400);
    const notStart = await call(adminToken, 'POST', '/api/v1/attachment-archives', {
      granularity: 'QUARTER',
      periodStart: `${YEAR}-08-01`,
    });
    expect(notStart.statusCode).toBe(400);
    const noConfirm = await call(
      adminToken,
      'POST',
      `/api/v1/attachment-archives/${freshUuid()}/purge`,
      {},
    );
    expect(noConfirm.statusCode).toBe(400);
    expect(
      (await call(adminToken, 'GET', '/api/v1/attachment-archives/not-a-uuid')).statusCode,
    ).toBe(400);
    expect(
      (await call(adminToken, 'GET', `/api/v1/attachment-archives/${freshUuid()}`)).statusCode,
    ).toBe(404);
  });

  // -------------------------------------------------------------------------------------------------------------
  // Parcours principal : le troisième trimestre de l'année d'essai
  // -------------------------------------------------------------------------------------------------------------

  describe('troisième trimestre : plan, téléchargement, vérification, vidage', () => {
    const photos: Record<string, Photo> = {};
    let r5: string;
    let archive: ArchiveView;

    const purgeNow = (body: Record<string, unknown> = { confirm: true }) =>
      call(adminToken, 'POST', `/api/v1/attachment-archives/${archive.id}/purge`, body);

    beforeAll(async () => {
      // Fermées : archivables.
      const r1 = await receipt('POSTED', { bl: '..\\..\\Windows\\BL 12/A', localRef: '=CMD|x' });
      r5 = await receipt('POSTED');
      const e1 = await expense('REJECTED', 'DEP papier 7');
      const l1 = await loss('CASSE', 'RECORDED');
      const l2 = await loss('MORTALITE', 'APPROVED');
      const i1 = await invoice('PAID');
      photos.r1 = await photo('GOODS_RECEIPT', r1, at(9, 10, 9, 15, 30), { kind: 'DELIVERY_NOTE' });
      photos.r1b = await photo('GOODS_RECEIPT', r1, at(9, 10, 9, 15, 30), {
        kind: 'DELIVERY_NOTE',
      });
      photos.r5 = await photo('GOODS_RECEIPT', r5, at(9, 19, 11), { kind: 'DELIVERY_NOTE' });
      photos.e1 = await photo('EXPENSE', e1, at(8, 5, 7), {
        kind: 'RECEIPT',
        mime: 'image/webp',
        bytes: Buffer.concat([Buffer.from('RIFF....WEBP'), randomBytes(700)]),
      });
      photos.l1 = await photo('STOCK_LOSS', l1, at(9, 15, 8, 30));
      photos.l2 = await photo('STOCK_LOSS', l2, at(7, 20, 16, 45, 10));
      photos.i1 = await photo('SUPPLIER_INVOICE', i1, at(9, 17, 13), {
        kind: 'INVOICE',
        mime: 'application/pdf',
        bytes: pdf(900),
      });
      // Gardées : opération ouverte, validation en attente, document inconnu.
      const r2 = await receipt('POSTED_PENDING_REVIEW');
      const e2 = await expense('RECORDED');
      const r3 = await receipt('POSTED');
      await pendingApproval('GOODS_RECEIPT', r3);
      photos.r2 = await photo('GOODS_RECEIPT', r2, at(9, 11, 9), { kind: 'DELIVERY_NOTE' });
      photos.e2 = await photo('EXPENSE', e2, at(9, 12, 9), { kind: 'RECEIPT' });
      photos.r3 = await photo('GOODS_RECEIPT', r3, at(9, 13, 9), { kind: 'DELIVERY_NOTE' });
      photos.unknown = await photo('STOCK_LOSS', freshUuid(), at(9, 14, 9));
      // Fichier absent du disque.
      const r4 = await receipt('POSTED');
      photos.absent = await photo('GOODS_RECEIPT', r4, at(9, 18, 9), {
        kind: 'DELIVERY_NOTE',
        skipFile: true,
      });
    });

    it('le catalogue compte ce qui est sur le serveur, ce qui est assez ancien et ce qui est récent', async () => {
      const response = await call(
        adminToken,
        'GET',
        '/api/v1/attachment-archives/catalog?granularity=QUARTER',
      );
      expect(response.statusCode, response.body).toBe(200);
      const catalog = response.json() as {
        settings: {
          minAgeDays: number;
          volumeMaxMb: number;
          defaultGranularity: string;
          retentionYears: number;
        };
        server: { files: number };
        periods: {
          label: string;
          onServer: { files: number };
          olderThanMinAge: { files: number };
          recent: { files: number };
          archived: { files: number };
          planId: string | null;
        }[];
      };
      expect(catalog.settings).toMatchObject({
        minAgeDays: 30,
        volumeMaxMb: 512,
        defaultGranularity: 'QUARTER',
        retentionYears: 5,
      });
      expect(catalog.server.files).toBeGreaterThanOrEqual(12);
      const t3 = catalog.periods.find((period) => period.label === `${YEAR}-T3`)!;
      expect(t3.onServer.files).toBe(12);
      expect(t3.olderThanMinAge.files).toBe(12);
      expect(t3.recent.files).toBe(0);
      expect(t3.archived.files).toBe(0);
      expect(t3.planId).toBeNull();
      const months = (
        await call(adminToken, 'GET', '/api/v1/attachment-archives/catalog?granularity=MONTH')
      ).json() as {
        periods: { label: string; onServer: { files: number } }[];
      };
      expect(months.periods.find((period) => period.label === `${YEAR}-07`)!.onServer.files).toBe(
        1,
      );
      expect(months.periods.find((period) => period.label === `${YEAR}-08`)!.onServer.files).toBe(
        1,
      );
      expect(months.periods.find((period) => period.label === `${YEAR}-09`)!.onServer.files).toBe(
        10,
      );
    });

    it('prépare le plan : un volume par mois et par catégorie, opérations ouvertes et fichier absent écartés', async () => {
      const response = await call(adminToken, 'POST', '/api/v1/attachment-archives', {
        granularity: 'QUARTER',
        periodStart: `${YEAR}-07-01`,
      });
      expect(response.statusCode, response.body).toBe(201);
      archive = (response.json() as { archive: ArchiveView }).archive;

      expect(archive).toMatchObject({
        granularity: 'QUARTER',
        status: 'READY',
        files: 7,
        keptOpen: 4,
        absent: 1,
        minAgeDays: 30,
        allDelivered: false,
        period: { start: `${YEAR}-07-01`, end: `${YEAR}-10-01`, label: `${YEAR}-T3` },
      });
      expect(archive.cutoffAt).toBe(CUTOFF.toISOString());
      expect(
        archive.volumes.map((volume) => `${volume.month}/${volume.category}/${volume.files}`),
      ).toEqual([
        `${YEAR}-07/MORTALITE/1`,
        `${YEAR}-08/DEPENSE/1`,
        `${YEAR}-09/RECEPTION/3`,
        `${YEAR}-09/PERTE/1`,
        `${YEAR}-09/FACTURE_FOURNISSEUR/1`,
      ]);
      for (const volume of archive.volumes) {
        expect(volume.fileName).toMatch(
          new RegExp(`^GIC-photos_${YEAR}-\\d\\d_[A-Z_]+_${YEAR}1101\\.zip$`),
        );
        expect(volume.zipBytes).toBeGreaterThan(volume.filesBytes);
        expect(volume.deliveries).toBe(0);
        expect(volume.planned).toBe(volume.files);
      }

      // Le plan est listé, avec ses volumes, parmi les archives récentes.
      const list = (await call(adminToken, 'GET', '/api/v1/attachment-archives')).json() as {
        archives: ArchiveView[];
      };
      expect(list.archives.find((candidate) => candidate.id === archive.id)!.volumes).toHaveLength(
        5,
      );

      // Trace en base : chaque photo du plan, avec son chemin sûr, son empreinte et sa date de soumission.
      const rows = await db
        .selectFrom('attachments_archive_items as i')
        .innerJoin('attachments_attachments as a', 'a.id', 'i.attachment_id')
        .select([
          'i.attachment_id as id',
          'i.entry_path as entry_path',
          'i.sha256 as sha256',
          'i.reference as reference',
          'i.secondary_reference as secondary',
          'i.state as state',
          'a.upload_status as status',
        ])
        .where('i.archive_id', '=', toBin(archive.id))
        .execute();
      expect(rows).toHaveLength(7);
      const byId = new Map(rows.map((row) => [fromBin(row.id), row]));
      for (const row of rows) {
        expect(isSafeArchivePath(row.entry_path), row.entry_path).toBe(true);
        expect(row.state).toBe('PLANNED');
        expect(row.status).toBe('AVAILABLE');
      }
      expect(byId.get(photos.r1!.id)!.entry_path).toMatch(
        new RegExp(
          `^RECEPTION/${YEAR}-09/RC-T-[A-Z0-9]+_Windows-BL-12-A_CMD-x_${YEAR}0910-101530_[0-9a-f]{8}\\.jpg$`,
        ),
      );
      expect(byId.get(photos.e1!.id)!.entry_path).toMatch(
        new RegExp(
          `^DEPENSE/${YEAR}-08/DEP-T-[A-Z0-9]+_DEP-papier-7_${YEAR}0805-080000_[0-9a-f]{8}\\.webp$`,
        ),
      );
      expect(byId.get(photos.i1!.id)!.entry_path).toMatch(
        new RegExp(
          `^FACTURE_FOURNISSEUR/${YEAR}-09/FF-T-[A-Z0-9]+_FAC-[A-Z0-9]+_${YEAR}0917-140000_[0-9a-f]{8}\\.pdf$`,
        ),
      );
      expect(byId.get(photos.l2!.id)!.entry_path).toMatch(
        new RegExp(`^MORTALITE/${YEAR}-07/PERTE-T-[A-Z0-9]+_${YEAR}0720-174510_[0-9a-f]{8}\\.jpg$`),
      );
      expect(byId.get(photos.l1!.id)!.entry_path).toMatch(new RegExp(`^PERTE/${YEAR}-09/`));
      // les photos écartées ne sont dans aucun plan
      for (const kept of [photos.r2, photos.e2, photos.r3, photos.unknown, photos.absent]) {
        expect(byId.has(kept!.id)).toBe(false);
      }
      expect(await auditActions(archive.id)).toContain('attachments.archive.created:SUCCESS');
    });

    it('refuse un second plan pour la même période, et ne reprend pas dans un mois les photos du plan vivant', async () => {
      const again = await call(adminToken, 'POST', '/api/v1/attachment-archives', {
        granularity: 'QUARTER',
        periodStart: `${YEAR}-07-01`,
      });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({
        error: { code: 'ARCHIVE_PERIOD_IN_PROGRESS', details: { archive_id: archive.id } },
      });
      const month = await call(adminToken, 'POST', '/api/v1/attachment-archives', {
        granularity: 'MONTH',
        periodStart: `${YEAR}-09-01`,
      });
      expect(month.statusCode).toBe(409);
      expect(month.json()).toMatchObject({ error: { code: 'ARCHIVE_NOTHING_TO_ARCHIVE' } });
    });

    it('refuse de vider tant qu’un volume n’est pas téléchargé en entier', async () => {
      const response = await purgeNow();
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: 'ARCHIVE_NOT_DOWNLOADED', details: { volumes: expect.any(Array) } },
      });
      expect(
        (response.json() as { error: { details: { volumes: unknown[] } } }).error.details.volumes,
      ).toHaveLength(5);
      // rien n'a bougé
      for (const key of [photos.r1, photos.e1, photos.l1]) {
        expect((await stat(keyPath(key!.id))).size).toBe(key!.bytes.length);
      }
    });

    it('un billet ne sert qu’à télécharger : refusé comme jeton d’accès, falsifié, échu ou sans droit il est refusé', async () => {
      const volume = archive.volumes[0]!;
      const ticket = await call(
        adminToken,
        'POST',
        `/api/v1/attachment-archives/${archive.id}/volumes/${volume.id}/ticket`,
      );
      const { url } = ticket.json() as { url: string };
      const token = new URL(url, 'http://localhost').searchParams.get('ticket')!;
      const get = (ticketValue: string) =>
        app.inject({
          method: 'GET',
          url: `/api/v1/attachment-archives/download?ticket=${ticketValue}`,
        });

      // billet utilisé comme jeton d'accès
      expect((await call(token, 'GET', '/api/v1/attachment-archives/catalog')).statusCode).toBe(
        401,
      );
      // jeton d'accès utilisé comme billet
      expect((await get(adminToken)).statusCode).toBe(401);
      // billet falsifié
      const forged = `${token.slice(0, -4)}${token.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
      const forgedResponse = await get(forged);
      expect(forgedResponse.statusCode).toBe(401);
      expect(forgedResponse.json()).toMatchObject({ error: { code: 'ARCHIVE_TICKET_INVALID' } });
      // billet échu (10 minutes)
      clock.advance(11 * 60_000);
      const expired = await get(token);
      expect(expired.statusCode).toBe(401);
      expect(expired.json()).toMatchObject({ error: { code: 'ARCHIVE_TICKET_INVALID' } });
      clock.setTo(NOW);
      // volume inconnu
      const wrongVolume = await signArchiveTicket(
        jwtKeys.privateKey,
        { volumeId: freshUuid(), userId: admin, deviceId: adminDevice, sessionId: adminSession },
        NOW,
      );
      expect((await get(wrongVolume.token)).statusCode).toBe(404);
      // session qui n'existe pas (billet signé de la bonne clé, mais pour une session inconnue)
      const noSession = await signArchiveTicket(
        jwtKeys.privateKey,
        { volumeId: volume.id, userId: admin, deviceId: adminDevice, sessionId: freshUuid() },
        NOW,
      );
      expect((await get(noSession.token)).statusCode).toBe(401);
      // compte sans droit d'export : refus audité, rien n'est ouvert
      const noRight = await signArchiveTicket(
        jwtKeys.privateKey,
        { volumeId: volume.id, userId: nobody, deviceId: nobodyDevice, sessionId: nobodySession },
        NOW,
      );
      const forbidden = await get(noRight.token);
      expect(forbidden.statusCode).toBe(403);
      const denied = await db
        .selectFrom('audit_audit_log')
        .select('action')
        .where('actor_user_id', '=', toBin(nobody))
        .where('entity_id', '=', toBin(volume.id))
        .execute();
      expect(denied.map((row) => row.action)).toEqual(['access.denied']);
      expect((await volumeRow(volume.id)).deliveries).toBe(0);
    });

    it('un seul téléchargement de volume à la fois (429), la place se libère au règlement', async () => {
      const volume = archive.volumes[0]!;
      const ticket = await signArchiveTicket(
        jwtKeys.privateKey,
        { volumeId: volume.id, userId: admin, deviceId: adminDevice, sessionId: adminSession },
        NOW,
      );
      const first = await service.openDownload(ticket.token);
      await expect(service.openDownload(ticket.token)).rejects.toMatchObject({
        status: 429,
        code: 'ARCHIVE_BUSY',
      });
      first.stream.destroy();
      await first.settle(false); // interrompu : enregistré comme tel, sans compter une livraison
      const row = await volumeRow(volume.id);
      expect(row.deliveries).toBe(0);
      expect(row.aborted_deliveries).toBe(1);
      const third = await service.openDownload(ticket.token);
      third.stream.destroy();
      await third.settle(false);
      expect((await volumeRow(volume.id)).aborted_deliveries).toBe(2);
    });

    it('deux demandes simultanées : une seule obtient la place, l’autre reçoit 429', async () => {
      const volume = archive.volumes[0]!;
      const ticket = await signArchiveTicket(
        jwtKeys.privateKey,
        { volumeId: volume.id, userId: admin, deviceId: adminDevice, sessionId: adminSession },
        NOW,
      );
      const before = (await volumeRow(volume.id)).aborted_deliveries;
      const outcomes = await Promise.allSettled([
        service.openDownload(ticket.token),
        service.openDownload(ticket.token),
      ]);
      const granted = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(granted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
        status: 429,
        code: 'ARCHIVE_BUSY',
      });
      const winner = (granted[0] as PromiseFulfilledResult<DownloadStream>).value;
      winner.stream.destroy();
      await winner.settle(false);
      expect((await volumeRow(volume.id)).aborted_deliveries).toBe(before + 1);
      // La place est rendue : une nouvelle demande est de nouveau acceptée.
      const next = await service.openDownload(ticket.token);
      next.stream.destroy();
      await next.settle(false);
    });

    it('télécharge chaque volume : ZIP exact, noms sûrs, manifeste, octets identiques, empreinte enregistrée', async () => {
      const wanted = new Map(Object.values(photos).map((p) => [p.id, p]));
      for (const volume of archive.volumes) {
        const response = await download(archive, volume.id);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers['content-type']).toBe('application/zip');
        expect(response.headers['content-disposition']).toBe(
          `attachment; filename="${volume.fileName}"`,
        );
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(Number(response.headers['content-length'])).toBe(volume.zipBytes);
        const body = response.rawPayload;
        expect(body.length).toBe(volume.zipBytes);

        const zip = readStoredZip(body);
        expect(zip.comment).toBe(`GIC AGROPELC - plan ${archive.id} - volume ${volume.seq}/5`);
        const names = zip.entries.map((entry) => entry.path);
        expect(names.slice(0, 2)).toEqual(['LISEZMOI.txt', 'MANIFESTE.csv']);
        expect(names.every((name) => isSafeArchivePath(name))).toBe(true);
        expect(zip.entries.length).toBe(volume.files + 2);

        const manifest = zip.entries[1]!.data.toString('utf8');
        expect(manifest.charCodeAt(0)).toBe(0xfeff);
        const lines = manifest.slice(1).trimEnd().split('\r\n');
        expect(lines).toHaveLength(volume.files + 1);

        const rows = await db
          .selectFrom('attachments_archive_items')
          .select(['attachment_id', 'entry_path', 'sha256'])
          .where('volume_id', '=', toBin(volume.id))
          .execute();
        for (const row of rows) {
          const entry = zip.entries.find((candidate) => candidate.path === row.entry_path)!;
          expect(entry, row.entry_path).toBeDefined();
          const original = wanted.get(fromBin(row.attachment_id))!;
          expect(entry.data.equals(original.bytes)).toBe(true);
          expect(sha256(entry.data)).toBe(row.sha256);
          expect(
            lines.some((line) => line.includes(row.entry_path) && line.includes(row.sha256)),
          ).toBe(true);
        }

        // La livraison complète est enregistrée une fois la réponse terminée, avec l'empreinte des octets envoyés.
        const settled = await waitFor(
          () => volumeRow(volume.id),
          (row) => row.deliveries === 1,
        );
        expect(settled.deliveries).toBe(1);
        expect(settled.zip_sha256).toBe(sha256(body));
        expect(settled.first_delivered_at).not.toBeNull();
        expect(settled.last_delivered_by).not.toBeNull();
      }
      const view = (
        await call(adminToken, 'GET', `/api/v1/attachment-archives/${archive.id}`)
      ).json() as {
        archive: ArchiveView;
      };
      expect(view.archive.allDelivered).toBe(true);
      const actions = await auditActions(archive.id);
      expect(
        actions.filter((a) => a === 'attachments.archive.volume_downloaded:SUCCESS'),
      ).toHaveLength(5);
      // un second téléchargement du même volume rend les mêmes octets (volume déterministe)
      const again = await download(archive, archive.volumes[2]!.id);
      expect(sha256(again.rawPayload)).toBe(view.archive.volumes[2]!.zipSha256);
      await waitFor(
        () => volumeRow(archive.volumes[2]!.id),
        (row) => row.deliveries === 2,
      );
    });

    it('le texte d’accompagnement dit où chercher et combien de temps garder', async () => {
      const response = await download(archive, archive.volumes[0]!.id);
      const readme = readStoredZip(response.rawPayload).entries[0]!.data.toString('utf8');
      expect(readme).toContain(`${YEAR}-T3`);
      expect(readme).toContain(`A conserver 5 ans, jusqu'au ${YEAR + 5}-11-01 au moins`);
      expect(readme).toContain('MORTALITE');
      expect(readme).toContain(
        `Get-FileHash .\\GIC-photos_${YEAR}-07_MORTALITE_${YEAR}1101.zip -Algorithm SHA256`,
      );
      await waitFor(
        () => volumeRow(archive.volumes[0]!.id),
        (row) => row.deliveries === 2,
      );
    });

    it('vérifie le fichier rangé par son empreinte : la bonne est reconnue, une autre refusée et auditée', async () => {
      const view = (
        await call(adminToken, 'GET', `/api/v1/attachment-archives/${archive.id}`)
      ).json() as {
        archive: ArchiveView;
      };
      const target = view.archive.volumes[1]!;
      const verify = (sha: string) =>
        call(
          adminToken,
          'POST',
          `/api/v1/attachment-archives/${archive.id}/volumes/${target.id}/verify`,
          {
            sha256: sha,
          },
        );
      const wrong = await verify('a'.repeat(64));
      expect(wrong.statusCode).toBe(409);
      expect(wrong.json()).toMatchObject({ error: { code: 'ARCHIVE_HASH_MISMATCH' } });
      expect((await volumeRow(target.id)).verified_at).toBeNull();
      expect((await verify('xyz')).statusCode).toBe(400);

      const right = await verify(target.zipSha256!);
      expect(right.statusCode, right.body).toBe(200);
      expect(
        (right.json() as { volume: { verifiedAt: string | null } }).volume.verifiedAt,
      ).not.toBeNull();
      const actions = await auditActions(archive.id);
      expect(actions).toContain('attachments.archive.volume_verified:SUCCESS');
      expect(actions).toContain('attachments.archive.volume_verified:FAILED');
    });

    it('vide l’espace : fichiers supprimés, lignes intactes, opération rouverte libérée, trace et audit', async () => {
      // Entre le plan et le vidage, la réception de la photo `r5` revient en quarantaine : sa photo doit rester.
      await setReceiptStatus(r5, 'QUARANTINED');

      const response = await purgeNow();
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as {
        archive: ArchiveView;
        result: {
          purged: number;
          bytesFreed: number;
          released: { OPEN_OPERATION: number; CHANGED: number; TOO_RECENT: number };
          alreadyAbsent: number;
          remaining: number;
          volumesResolved: number;
          volumesVerified: number;
        };
      };
      expect(body.result).toMatchObject({
        purged: 6,
        released: { OPEN_OPERATION: 1, CHANGED: 0, TOO_RECENT: 0 },
        alreadyAbsent: 0,
        remaining: 0,
        volumesResolved: 5,
        volumesVerified: 1,
      });
      const freed = [photos.r1, photos.r1b, photos.e1, photos.l1, photos.l2, photos.i1].reduce(
        (sum, p) => sum + p!.bytes.length,
        0,
      );
      expect(body.result.bytesFreed).toBe(freed);
      expect(body.archive.status).toBe('COMPLETED');

      // fichiers
      for (const gone of [photos.r1, photos.r1b, photos.e1, photos.l1, photos.l2, photos.i1]) {
        await expect(stat(keyPath(gone!.id))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      for (const kept of [photos.r5, photos.r2, photos.e2, photos.r3, photos.unknown]) {
        expect((await stat(keyPath(kept!.id))).size).toBe(kept!.bytes.length);
      }
      // lignes d'origine : toutes toujours AVAILABLE, rien de supprimé
      const statuses = await db
        .selectFrom('attachments_attachments')
        .select('upload_status')
        .where(
          'id',
          'in',
          Object.values(photos).map((p) => toBin(p.id)),
        )
        .execute();
      expect(statuses).toHaveLength(Object.keys(photos).length);
      expect(statuses.every((row) => row.upload_status === 'AVAILABLE')).toBe(true);

      // trace
      const rows = await archiveRows(archive.id);
      expect(rows.filter((row) => row.state === 'PURGED')).toHaveLength(6);
      const released = rows.filter((row) => row.state === 'RELEASED');
      expect(released).toHaveLength(1);
      expect(fromBin(released[0]!.attachment_id)).toBe(photos.r5!.id);
      expect(released[0]!.release_reason).toBe('OPEN_OPERATION');
      const actions = await auditActions(archive.id);
      expect(actions.filter((a) => a === 'attachments.archive.purged:SUCCESS')).toHaveLength(5);
    });

    it('un plan vidé ne se vide ni ne se télécharge plus', async () => {
      const again = await purgeNow();
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: { code: 'ARCHIVE_NOT_READY' } });
      const ticket = await call(
        adminToken,
        'POST',
        `/api/v1/attachment-archives/${archive.id}/volumes/${archive.volumes[0]!.id}/ticket`,
      );
      expect(ticket.statusCode).toBe(409);
      // et le catalogue le compte désormais comme archivé
      const catalog = (
        await call(adminToken, 'GET', '/api/v1/attachment-archives/catalog?granularity=QUARTER')
      ).json() as {
        periods: { label: string; archived: { files: number }; onServer: { files: number } }[];
      };
      const t3 = catalog.periods.find((period) => period.label === `${YEAR}-T3`)!;
      expect(t3.archived.files).toBe(6);
      expect(t3.onServer.files).toBe(6);
    });

    it('une photo vidée répond 410 avec de quoi la retrouver ; une photo gardée se lit comme avant', async () => {
      const gone = await call(adminToken, 'GET', `/api/v1/attachments/${photos.r1!.id}/content`);
      expect(gone.statusCode).toBe(410);
      const error = (gone.json() as { error: { code: string; details: Record<string, string> } })
        .error;
      expect(error.code).toBe('ATTACHMENT_ARCHIVED');
      expect(error.details.archived_at).toBe(NOW.toISOString());
      expect(error.details.volume_file_name).toBe(
        archive.volumes.find((volume) => volume.category === 'RECEPTION')!.fileName,
      );
      expect(error.details.entry_path).toMatch(new RegExp(`^RECEPTION/${YEAR}-09/RC-T-`));
      expect(error.details.reference).toMatch(/^RC-T-/);

      const kept = await call(adminToken, 'GET', `/api/v1/attachments/${photos.r5!.id}/content`);
      expect(kept.statusCode).toBe(200);
      expect(kept.rawPayload.equals(photos.r5!.bytes)).toBe(true);
      // les validations qui comptent la pièce reçue continuent de la juger reçue (statut inchangé)
      const row = await db
        .selectFrom('attachments_attachments')
        .select('upload_status')
        .where('id', '=', toBin(photos.r1!.id))
        .executeTakeFirstOrThrow();
      expect(row.upload_status).toBe('AVAILABLE');
    });

    it('un fichier parti avant l’écriture de l’état est lui aussi expliqué par son plan (410, jamais une erreur serveur)', async () => {
      // Plan en cours sur une autre période, dont le fichier disparaît sans que l'état soit écrit.
      const r = await receipt('POSTED');
      const stray = await photo('GOODS_RECEIPT', r, at(3, 5, 9), { kind: 'DELIVERY_NOTE' });
      const created = await call(adminToken, 'POST', '/api/v1/attachment-archives', {
        granularity: 'MONTH',
        periodStart: `${YEAR}-03-01`,
      });
      expect(created.statusCode, created.body).toBe(201);
      const plan = (created.json() as { archive: ArchiveView }).archive;
      await rm(keyPath(stray.id));
      const response = await call(adminToken, 'GET', `/api/v1/attachments/${stray.id}/content`);
      expect(response.statusCode).toBe(410);
      expect(response.json()).toMatchObject({ error: { code: 'ATTACHMENT_ARCHIVED' } });
      await call(adminToken, 'POST', `/api/v1/attachment-archives/${plan.id}/cancel`);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  // La règle des 30 jours, au trimestre qui la franchit (quatrième trimestre)
  // -------------------------------------------------------------------------------------------------------------

  describe('quatrième trimestre : les photos de moins de 30 jours restent toujours', () => {
    it('inclut ce qui a plus de 30 jours (à la milliseconde), exclut ce qui a exactement 30 jours ou moins', async () => {
      const owners = await Promise.all(Array.from({ length: 5 }, () => receipt('POSTED')));
      const old = await photo('GOODS_RECEIPT', owners[0]!, at(10, 1, 8));
      const justOlder = await photo('GOODS_RECEIPT', owners[1]!, new Date(CUTOFF.getTime() - 1));
      const boundary = await photo('GOODS_RECEIPT', owners[2]!, new Date(CUTOFF.getTime()));
      const justYounger = await photo('GOODS_RECEIPT', owners[3]!, new Date(CUTOFF.getTime() + 1));
      const recent = await photo('GOODS_RECEIPT', owners[4]!, at(10, 25, 8));

      const catalog = (
        await call(adminToken, 'GET', '/api/v1/attachment-archives/catalog?granularity=QUARTER')
      ).json() as {
        periods: { label: string; recent: { files: number }; olderThanMinAge: { files: number } }[];
      };
      const q4 = catalog.periods.find((period) => period.label === `${YEAR}-T4`)!;
      expect(q4.recent.files).toBe(3);
      expect(q4.olderThanMinAge.files).toBe(2);

      const created = await call(adminToken, 'POST', '/api/v1/attachment-archives', {
        granularity: 'QUARTER',
        periodStart: `${YEAR}-10-01`,
      });
      expect(created.statusCode, created.body).toBe(201);
      const plan = (created.json() as { archive: ArchiveView }).archive;
      const planned = (await archiveRows(plan.id)).map((row) => fromBin(row.attachment_id)).sort();
      expect(planned).toEqual([old.id, justOlder.id].sort());
      for (const excluded of [boundary, justYounger, recent])
        expect(planned).not.toContain(excluded.id);

      // rien n'est livré : le vidage est refusé et rien n'est supprimé, ni les anciennes ni les récentes
      const refused = await call(
        adminToken,
        'POST',
        `/api/v1/attachment-archives/${plan.id}/purge`,
        { confirm: true },
      );
      expect(refused.statusCode).toBe(409);
      for (const stays of [boundary, justYounger, recent, old, justOlder]) {
        expect((await stat(keyPath(stays.id))).size).toBe(stays.bytes.length);
      }

      // annulation : photos libérées, période de nouveau disponible
      const cancelled = await call(
        adminToken,
        'POST',
        `/api/v1/attachment-archives/${plan.id}/cancel`,
      );
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect((cancelled.json() as { archive: ArchiveView }).archive.status).toBe('CANCELLED');
      const rows = await archiveRows(plan.id);
      expect(
        rows.every((row) => row.state === 'RELEASED' && row.release_reason === 'ARCHIVE_CANCELLED'),
      ).toBe(true);
      expect(await auditActions(plan.id)).toContain('attachments.archive.cancelled:SUCCESS');
      const recreated = await call(adminToken, 'POST', '/api/v1/attachment-archives', {
        granularity: 'QUARTER',
        periodStart: `${YEAR}-10-01`,
      });
      expect(recreated.statusCode, recreated.body).toBe(201);
      const second = (recreated.json() as { archive: ArchiveView }).archive;
      expect(second.id).not.toBe(plan.id);
      await call(adminToken, 'POST', `/api/v1/attachment-archives/${second.id}/cancel`);
      // une archive annulée ne se télécharge plus
      const ticket = await call(
        adminToken,
        'POST',
        `/api/v1/attachment-archives/${plan.id}/volumes/${plan.volumes[0]!.id}/ticket`,
      );
      expect(ticket.statusCode).toBe(409);
      expect(ticket.json()).toMatchObject({ error: { code: 'ARCHIVE_NOT_READY' } });
    });

    it('une période sans rien d’archivable est refusée avec ce qui reste et pourquoi', async () => {
      const r = await receipt('POSTED_PENDING_REVIEW');
      await photo('GOODS_RECEIPT', r, at(1, 10, 9));
      const response = await call(adminToken, 'POST', '/api/v1/attachment-archives', {
        granularity: 'MONTH',
        periodStart: `${YEAR}-01-01`,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: 'ARCHIVE_NOTHING_TO_ARCHIVE', details: { kept_open: 1, absent: 0 } },
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  // Fichier altéré : le téléchargement échoue, rien n'est compté livré, le vidage reste refusé
  // -------------------------------------------------------------------------------------------------------------

  describe('deuxième trimestre : un fichier altéré ou manquant sur le disque', () => {
    it('interrompt la réponse, compte l’abandon, ne compte aucune livraison et refuse le vidage', async () => {
      const r = await receipt('POSTED');
      const victim = await photo('GOODS_RECEIPT', r, at(5, 10, 9), { kind: 'DELIVERY_NOTE' });
      const created = await call(adminToken, 'POST', '/api/v1/attachment-archives', {
        granularity: 'QUARTER',
        periodStart: `${YEAR}-04-01`,
      });
      expect(created.statusCode, created.body).toBe(201);
      const plan = (created.json() as { archive: ArchiveView }).archive;
      const volume = plan.volumes[0]!;

      // même taille, autres octets : l'empreinte enregistrée ne correspond plus
      await writeFile(keyPath(victim.id), randomBytes(victim.bytes.length));
      const response = await Promise.race([
        download(plan, volume.id).catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 15_000)),
      ]);
      // Si une réponse a été rendue malgré tout, elle n'est jamais un ZIP exact et valide.
      if (response && response.statusCode === 200) {
        expect(() => readStoredZip(response.rawPayload)).toThrow();
      }
      const row = await waitFor(
        () => volumeRow(volume.id),
        (value) => value.aborted_deliveries === 1,
      );
      expect(row.deliveries).toBe(0);
      expect(row.aborted_deliveries).toBe(1);
      expect(row.zip_sha256).toBeNull();
      const actions = await auditActions(plan.id);
      expect(actions).toContain('attachments.archive.volume_download_aborted:FAILED');
      expect(actions).not.toContain('attachments.archive.volume_downloaded:SUCCESS');

      const purge = await call(adminToken, 'POST', `/api/v1/attachment-archives/${plan.id}/purge`, {
        confirm: true,
      });
      expect(purge.statusCode).toBe(409);
      expect(purge.json()).toMatchObject({ error: { code: 'ARCHIVE_NOT_DOWNLOADED' } });
      // le fichier altéré est toujours là : rien n'a été supprimé
      expect((await readFile(keyPath(victim.id))).length).toBe(victim.bytes.length);
      await call(adminToken, 'POST', `/api/v1/attachment-archives/${plan.id}/cancel`);
    });

    it('un fichier manquant empêche de fabriquer le volume (409), sans rien livrer', async () => {
      const r = await receipt('POSTED');
      const lost = await photo('GOODS_RECEIPT', r, at(6, 10, 9), { kind: 'DELIVERY_NOTE' });
      const created = await call(adminToken, 'POST', '/api/v1/attachment-archives', {
        granularity: 'MONTH',
        periodStart: `${YEAR}-06-01`,
      });
      expect(created.statusCode, created.body).toBe(201);
      const plan = (created.json() as { archive: ArchiveView }).archive;
      await rm(keyPath(lost.id));
      const response = await download(plan, plan.volumes[0]!.id);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'ARCHIVE_VOLUME_INCOMPLETE' } });
      expect((await volumeRow(plan.volumes[0]!.id)).deliveries).toBe(0);
      await call(adminToken, 'POST', `/api/v1/attachment-archives/${plan.id}/cancel`);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  // Reprise et rejeu du vidage
  // -------------------------------------------------------------------------------------------------------------

  describe('février : vidage d’un volume à la fois, reprise après un fichier déjà parti, rejeu', () => {
    it('vérifie seulement ce qui a été livré, vide un volume puis solde l’autre sans rien refaire', async () => {
      const r = await receipt('POSTED');
      const e = await expense('REJECTED');
      const forReceipt = await photo('GOODS_RECEIPT', r, at(2, 6, 9), { kind: 'DELIVERY_NOTE' });
      const forExpense = await photo('EXPENSE', e, at(2, 7, 9), { kind: 'RECEIPT' });
      const created = await call(adminToken, 'POST', '/api/v1/attachment-archives', {
        granularity: 'MONTH',
        periodStart: `${YEAR}-02-01`,
      });
      expect(created.statusCode, created.body).toBe(201);
      const plan = (created.json() as { archive: ArchiveView }).archive;
      expect(plan.volumes.map((volume) => volume.category)).toEqual(['RECEPTION', 'DEPENSE']);
      const receiptVolume = plan.volumes[0]!;
      const expenseVolume = plan.volumes[1]!;
      const base = `/api/v1/attachment-archives/${plan.id}`;

      // Rien n'a été livré : il n'y a pas d'empreinte à comparer.
      const early = await call(adminToken, 'POST', `${base}/volumes/${receiptVolume.id}/verify`, {
        sha256: 'a'.repeat(64),
      });
      expect(early.statusCode).toBe(409);
      expect(early.json()).toMatchObject({ error: { code: 'ARCHIVE_NOT_DOWNLOADED' } });

      for (const volume of plan.volumes) {
        const response = await download(plan, volume.id);
        expect(response.statusCode).toBe(200);
        await waitFor(
          () => volumeRow(volume.id),
          (row) => row.deliveries === 1,
        );
      }
      // La vérification se rejoue : même résultat, même réponse.
      const sha = (await volumeRow(receiptVolume.id)).zip_sha256!;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const verified = await call(
          adminToken,
          'POST',
          `${base}/volumes/${receiptVolume.id}/verify`,
          { sha256: sha },
        );
        expect(verified.statusCode, verified.body).toBe(200);
      }

      // Le fichier de la dépense est déjà parti (vidage interrompu avant l'écriture de l'état).
      await rm(keyPath(forExpense.id));

      // Un volume inconnu du plan est refusé avant toute suppression.
      const unknown = await call(adminToken, 'POST', `${base}/purge`, {
        confirm: true,
        volumeIds: [freshUuid()],
      });
      expect(unknown.statusCode).toBe(404);
      expect((await stat(keyPath(forReceipt.id))).size).toBe(forReceipt.bytes.length);

      // Premier vidage : le seul volume des réceptions.
      const first = await call(adminToken, 'POST', `${base}/purge`, {
        confirm: true,
        volumeIds: [receiptVolume.id],
      });
      expect(first.statusCode, first.body).toBe(200);
      const firstBody = first.json() as {
        archive: ArchiveView;
        result: {
          purged: number;
          alreadyAbsent: number;
          volumesResolved: number;
          volumesVerified: number;
          remaining: number;
        };
      };
      expect(firstBody.result).toMatchObject({
        purged: 1,
        alreadyAbsent: 0,
        volumesResolved: 1,
        volumesVerified: 1,
        remaining: 0,
      });
      expect(firstBody.archive.status).toBe('READY');
      await expect(stat(keyPath(forReceipt.id))).rejects.toMatchObject({ code: 'ENOENT' });

      // Second vidage (tous les volumes) : le volume soldé n'est pas retouché, l'autre solde le fichier déjà parti.
      const second = await call(adminToken, 'POST', `${base}/purge`, { confirm: true });
      expect(second.statusCode, second.body).toBe(200);
      const secondBody = second.json() as {
        archive: ArchiveView;
        result: {
          purged: number;
          alreadyAbsent: number;
          bytesFreed: number;
          volumesResolved: number;
        };
      };
      expect(secondBody.result).toMatchObject({
        purged: 1,
        alreadyAbsent: 1,
        bytesFreed: 0,
        volumesResolved: 1,
      });
      expect(secondBody.archive.status).toBe('COMPLETED');
      expect(
        secondBody.archive.volumes.find((volume) => volume.id === expenseVolume.id)!.purged,
      ).toBe(1);

      // Deux lignes d'audit de vidage, une par volume ; les lignes d'origine sont intactes (jamais supprimées).
      const actions = await auditActions(plan.id);
      expect(
        actions.filter((action) => action === 'attachments.archive.purged:SUCCESS'),
      ).toHaveLength(2);
      const rows = await db
        .selectFrom('attachments_attachments')
        .select('upload_status')
        .where('id', 'in', [toBin(forReceipt.id), toBin(forExpense.id)])
        .execute();
      expect(rows.map((row) => row.upload_status)).toEqual(['AVAILABLE', 'AVAILABLE']);

      // Rejeu : un plan terminé ne se vide plus, et la période n'a plus rien à archiver.
      const replay = await call(adminToken, 'POST', `${base}/purge`, { confirm: true });
      expect(replay.statusCode).toBe(409);
      expect(replay.json()).toMatchObject({ error: { code: 'ARCHIVE_NOT_READY' } });
      const again = await call(adminToken, 'POST', '/api/v1/attachment-archives', {
        granularity: 'MONTH',
        periodStart: `${YEAR}-02-01`,
      });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: { code: 'ARCHIVE_NOTHING_TO_ARCHIVE' } });
    });
  });

  it('un jeton d’accès signé de la même clé n’est jamais accepté comme billet', async () => {
    const foreign = await signAccessToken(
      jwtKeys.privateKey,
      { sub: admin, device_id: adminDevice, session_id: adminSession },
      NOW,
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/attachment-archives/download?ticket=${foreign}`,
        })
      ).statusCode,
    ).toBe(401);
  });
});
