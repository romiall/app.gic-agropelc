import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { createTestDb, type GicDatabase } from '../storage/db.js';
import { clearSessionRuntime, setSessionRuntime } from '../features/auth/session-runtime.js';
import {
  ATTACHMENT_REGISTER_COMMAND,
  enqueueAttachment,
  enqueueCommand,
  type NewAttachment,
} from './outbox.js';
import {
  pendingAttachments,
  runAttachmentUploadCycle,
  UPLOAD_CHUNK_BYTES,
} from './attachment-upload.js';

const clock = new FixedClock(new Date('2026-10-14T09:00:00.000Z'));
const idGenerator = new Uuidv7Generator(clock);
const USER = 'user-1';

function photo(size: number, overrides: Partial<NewAttachment> = {}): NewAttachment {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff]);
  return {
    kind: 'DELIVERY_NOTE',
    ownerType: 'GOODS_RECEIPT',
    cited: true,
    mimeType: 'image/jpeg',
    bytes: bytes.buffer,
    sha256: 'a'.repeat(64),
    capturedAt: clock.now().toISOString(),
    ...overrides,
  };
}

interface ServerPiece {
  status: string;
  received: number;
  readonly size: number;
}

/** Faux serveur des pièces : `POST …/upload-session`, `PUT …/content` (ordre strict des octets). */
function fakeServer(options: { readonly quarantine?: boolean } = {}) {
  const pieces = new Map<string, ServerPiece>();
  const calls: { method: string; id: string; range?: string }[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const id = /attachments\/([^/]+)\//.exec(url)?.[1] ?? '';
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method,
      id,
      ...(headers['content-range'] ? { range: headers['content-range'] } : {}),
    });
    const piece = pieces.get(id);
    if (!piece) return json(404, { error: { code: 'NOT_FOUND' } });
    if (piece.status !== 'PENDING_UPLOAD') {
      return json(409, { error: { code: 'CONFLICT', details: { upload_status: piece.status } } });
    }
    if (method === 'POST') return json(200, { uploaded_bytes: piece.received, chunk_size: 262144 });
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers['content-range'] ?? '');
    const start = Number(match?.[1]);
    const end = Number(match?.[2]);
    if (start !== piece.received) {
      return json(409, {
        error: { code: 'UPLOAD_OFFSET_MISMATCH', details: { uploaded_bytes: piece.received } },
      });
    }
    expect((init?.body as ArrayBuffer).byteLength).toBe(end - start + 1);
    piece.received = end + 1;
    if (piece.received === piece.size)
      piece.status = options.quarantine ? 'QUARANTINED' : 'AVAILABLE';
    return json(200, { uploaded_bytes: piece.received, upload_status: piece.status });
  });
  vi.stubGlobal('fetch', fetchStub);
  return { pieces, calls, fetchStub };
}

describe('Photos jointes : file et envoi (MP-10, ADR-046)', () => {
  let db: GicDatabase;

  beforeEach(async () => {
    db = createTestDb(`test-attachments-${Math.random()}`);
    setSessionRuntime({
      userId: USER,
      deviceId: 'device-1',
      deviceStatus: 'ACTIVE',
      refreshToken: 'refresh-token',
      accessToken: 'valid-access-token',
      accessTokenExpiresAt: Date.now() + 60_000,
      pinKey: {} as CryptoKey,
    });
  });

  afterEach(async () => {
    clearSessionRuntime();
    vi.unstubAllGlobals();
    await db.delete();
  });

  const enqueueWith = (attachments: readonly NewAttachment[]) =>
    enqueueCommand(
      db,
      { clock, idGenerator },
      {
        authorUserId: USER,
        commandType: 'procurement.receipt.record',
        commandVersion: 1,
        aggregateType: 'GOODS_RECEIPT',
        payload: {},
        capturedOffline: true,
        attachments,
      },
    );

  /** Enregistrement accepté par le serveur (la pièce y existe, en attente d'octets). */
  const accept = async (server: ReturnType<typeof fakeServer>, attachmentId: string) => {
    const file = await db.attachmentFiles.get(attachmentId);
    await db.outbox.update(file!.register_command_id, { status: 'SYNCED' });
    server.pieces.set(attachmentId, {
      status: 'PENDING_UPLOAD',
      received: 0,
      size: file!.size_bytes,
    });
  };

  it('enregistrement juste avant l’opération, sans dépendance ; citée par la réception, propriétaire = l’opération', async () => {
    const receipt = await enqueueWith([photo(1000)]);
    const [register, main] = await db.outbox.orderBy('device_seq').toArray();
    expect(main!.command_id).toBe(receipt.command_id);
    expect(register).toMatchObject({
      command_type: ATTACHMENT_REGISTER_COMMAND,
      aggregate_type: 'ATTACHMENT',
      depends_on: [],
      device_seq: main!.device_seq - 1,
      payload: {
        ownerType: 'GOODS_RECEIPT',
        ownerId: receipt.aggregate_id,
        kind: 'DELIVERY_NOTE',
        mimeType: 'image/jpeg',
        sizeBytes: 1000,
        sha256: 'a'.repeat(64),
      },
    });
    expect(main!.depends_on).toEqual([]);
    expect(main!.attachment_ids).toEqual([register!.aggregate_id]);
    expect(await db.attachmentFiles.get(register!.aggregate_id)).toMatchObject({
      status: 'QUEUED',
      owner_id: receipt.aggregate_id,
      register_command_id: register!.command_id,
      author_user_id: USER,
    });
    expect((await db.attachmentBlobs.get(register!.aggregate_id))?.bytes.byteLength).toBe(1000);

    // Rattachée par son propriétaire (perte) : non citée par l'opération.
    const loss = await enqueueWith([
      photo(10, { kind: 'PHOTO', ownerType: 'STOCK_LOSS', cited: false }),
    ]);
    expect(loss.attachment_ids).toEqual([]);

    // Jointe après coup : la seule commande d'enregistrement, pour le document donné.
    const later = await enqueueAttachment(
      db,
      { clock, idGenerator },
      {
        authorUserId: USER,
        capturedOffline: false,
        attachment: { ...photo(10), cited: false, ownerId: receipt.aggregate_id },
      },
    );
    const last = await db.outbox.orderBy('device_seq').last();
    expect(last).toMatchObject({
      command_type: ATTACHMENT_REGISTER_COMMAND,
      aggregate_id: later,
      payload: { ownerId: receipt.aggregate_id },
    });
    expect(await pendingAttachments(db, USER)).toEqual({ count: 3, bytes: 1020 });
  });

  it('envoi par morceaux après l’acceptation de l’enregistrement ; reçue : octets retirés', async () => {
    const server = fakeServer();
    const size = UPLOAD_CHUNK_BYTES + 500;
    await enqueueWith([photo(size)]);
    const [file] = await db.attachmentFiles.toArray();

    // Enregistrement pas encore accepté : rien ne part.
    expect(await runAttachmentUploadCycle(db, { clock, userId: USER })).toEqual({
      outcome: 'NOTHING_TO_UPLOAD',
      sent: 0,
    });
    expect(server.fetchStub).not.toHaveBeenCalled();

    await accept(server, file!.attachment_id);
    expect(await runAttachmentUploadCycle(db, { clock, userId: USER })).toEqual({
      outcome: 'UPLOADED',
      sent: 1,
    });
    expect(server.calls.map((call) => [call.method, call.range])).toEqual([
      ['POST', undefined],
      ['PUT', `bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${size}`],
      ['PUT', `bytes ${UPLOAD_CHUNK_BYTES}-${size - 1}/${size}`],
    ]);
    expect(await db.attachmentFiles.get(file!.attachment_id)).toMatchObject({
      status: 'SENT',
      uploaded_bytes: size,
    });
    expect(await db.attachmentBlobs.get(file!.attachment_id)).toBeUndefined();
    expect(await pendingAttachments(db, USER)).toEqual({ count: 0, bytes: 0 });
  });

  it('reprise à l’offset du serveur, recalage sur un décalage ; empreinte refusée : QUARANTINED', async () => {
    const server = fakeServer({ quarantine: true });
    const size = UPLOAD_CHUNK_BYTES * 2;
    await enqueueWith([photo(size)]);
    const [file] = await db.attachmentFiles.toArray();
    await accept(server, file!.attachment_id);
    server.pieces.get(file!.attachment_id)!.received = UPLOAD_CHUNK_BYTES;
    // L'appareil croyait en être à 0 : le serveur annonce l'offset, l'envoi reprend là.
    await runAttachmentUploadCycle(db, { clock, userId: USER });
    expect(server.calls.filter((call) => call.method === 'PUT').map((call) => call.range)).toEqual([
      `bytes ${UPLOAD_CHUNK_BYTES}-${size - 1}/${size}`,
    ]);
    expect((await db.attachmentFiles.get(file!.attachment_id))?.status).toBe('QUARANTINED');
    expect(await db.attachmentBlobs.get(file!.attachment_id)).toBeUndefined();
  });

  it('décalage annoncé par le serveur au milieu de l’envoi : reprise à son offset', async () => {
    const server = fakeServer();
    const size = UPLOAD_CHUNK_BYTES * 2;
    await enqueueWith([photo(size)]);
    const [file] = await db.attachmentFiles.toArray();
    await accept(server, file!.attachment_id);
    // Le serveur ne rend son offset qu'à la session, puis en reçoit davantage par ailleurs.
    const original = server.fetchStub.getMockImplementation()!;
    server.fetchStub.mockImplementationOnce(async (input, init) => {
      const response = await original(input, init);
      server.pieces.get(file!.attachment_id)!.received = UPLOAD_CHUNK_BYTES;
      return response;
    });
    await runAttachmentUploadCycle(db, { clock, userId: USER });
    expect(server.calls.filter((call) => call.method === 'PUT').map((call) => call.range)).toEqual([
      `bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${size}`,
      `bytes ${UPLOAD_CHUNK_BYTES}-${size - 1}/${size}`,
    ]);
    expect((await db.attachmentFiles.get(file!.attachment_id))?.status).toBe('SENT');
  });

  it('enregistrement refusé : photo refusée, octets retirés, rien n’est envoyé ; autre auteur : ignorée', async () => {
    const server = fakeServer();
    await enqueueWith([photo(100)]);
    const [file] = await db.attachmentFiles.toArray();
    await db.outbox.update(file!.register_command_id, {
      status: 'REJECTED',
      last_error: { code: 'VALIDATION_ERROR', message_fr: 'Type refusé.' },
    });
    await runAttachmentUploadCycle(db, { clock, userId: USER });
    expect(await db.attachmentFiles.get(file!.attachment_id)).toMatchObject({
      status: 'REFUSED',
      last_error: 'Type refusé.',
    });
    expect(await db.attachmentBlobs.get(file!.attachment_id)).toBeUndefined();

    const other = await enqueueCommand(
      db,
      { clock, idGenerator },
      {
        authorUserId: 'user-2',
        commandType: 'inventory.loss.declare',
        commandVersion: 1,
        aggregateType: 'STOCK_LOSS',
        payload: {},
        capturedOffline: true,
        attachments: [photo(100, { kind: 'PHOTO', ownerType: 'STOCK_LOSS', cited: false })],
      },
    );
    const otherFile = await db.attachmentFiles.where('owner_id').equals(other.aggregate_id).first();
    await accept(server, otherFile!.attachment_id);
    expect((await runAttachmentUploadCycle(db, { clock, userId: USER })).outcome).toBe(
      'NOTHING_TO_UPLOAD',
    );
    expect(server.fetchStub).not.toHaveBeenCalled();
  });

  it('déjà reçue (409 rendant AVAILABLE) : SENT ; pièce inconnue (404) : nouvel essai plus tard ; réseau absent : interrompu, pièce reportée, rien de perdu', async () => {
    const server = fakeServer();
    await enqueueWith([photo(50)]);
    await enqueueWith([photo(60)]);
    const [first, second] = await db.attachmentFiles.orderBy('attachment_id').toArray();
    await accept(server, first!.attachment_id);
    server.pieces.get(first!.attachment_id)!.status = 'AVAILABLE';
    await db.outbox.update(second!.register_command_id, { status: 'SYNCED' });
    // Second : enregistrement accepté mais pièce encore inconnue du serveur (404).
    const result = await runAttachmentUploadCycle(db, { clock, userId: USER });
    expect(result).toEqual({ outcome: 'UPLOADED', sent: 1 });
    expect((await db.attachmentFiles.get(first!.attachment_id))?.status).toBe('SENT');
    const postponed = await db.attachmentFiles.get(second!.attachment_id);
    expect(postponed).toMatchObject({ status: 'QUEUED', attempts: 1, last_error: 'NOT_FOUND' });
    expect(postponed!.next_attempt_at! > clock.now().toISOString()).toBe(true);
    // Avant l'heure du nouvel essai : rien ne part.
    server.fetchStub.mockClear();
    expect((await runAttachmentUploadCycle(db, { clock, userId: USER })).outcome).toBe(
      'NOTHING_TO_UPLOAD',
    );
    expect(server.fetchStub).not.toHaveBeenCalled();

    await db.attachmentFiles.update(second!.attachment_id, { next_attempt_at: null });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await runAttachmentUploadCycle(db, { clock, userId: USER })).toEqual({
      outcome: 'INTERRUPTED',
      sent: 0,
    });
    expect(await db.attachmentBlobs.get(second!.attachment_id)).toBeDefined();
    expect(await db.attachmentFiles.get(second!.attachment_id)).toMatchObject({
      status: 'QUEUED',
      last_error: 'OFFLINE',
    });
  });

  it('revue de MP-10 : refus définitif seulement sur un code connu du serveur ; une réponse sans code est réessayée', async () => {
    await enqueueWith([photo(40)]);
    await enqueueWith([photo(45)]);
    const [first, second] = (await db.attachmentFiles.toArray()).sort(
      (a, b) => a.size_bytes - b.size_bytes,
    );
    for (const file of [first!, second!]) {
      await db.outbox.update(file.register_command_id, { status: 'SYNCED' });
    }
    // Pare-feu : 403 sans corps JSON pour la première ; serveur : 400 VALIDATION_ERROR pour la seconde.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes(first!.attachment_id)
          ? new Response('<html>refusé</html>', { status: 403 })
          : new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR' } }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            }),
      ),
    );
    await runAttachmentUploadCycle(db, { clock, userId: USER });
    expect(await db.attachmentFiles.get(first!.attachment_id)).toMatchObject({
      status: 'QUEUED',
      attempts: 1,
    });
    expect(await db.attachmentBlobs.get(first!.attachment_id)).toBeDefined();
    expect(await db.attachmentFiles.get(second!.attachment_id)).toMatchObject({
      status: 'REFUSED',
      last_error: 'VALIDATION_ERROR',
    });
  });
});
