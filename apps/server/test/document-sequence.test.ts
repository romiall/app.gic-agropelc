/**
 * Démonstration du critère de sortie P0-08 (numéros sans doublon, INV-GLO-07 ; BR-ADM-021) :
 * verrou de ligne, même motif que `record-audit.test.ts` pour l'audit. Écritures réelles,
 * non annulées (`platform_document_sequences` n'a pas de DELETE accordé à gic_app, comme
 * `audit_audit_log`) : chaque test utilise un `site_id` frais (UUIDv7), jamais en collision
 * entre exécutions.
 */
import { describe, expect, it } from 'vitest';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { db, freshUuid } from './helpers.js';

describe('DocumentSequenceService.next (BR-ADM-021, INV-GLO-07)', () => {
  const service = new DocumentSequenceService();

  it('première allocation pour une clé neuve : seq6 = 000001', async () => {
    const siteId = freshUuid();
    const number = await db
      .transaction()
      .execute((trx) =>
        service.next(trx, { docType: 'TST', siteId, codeSite: 'DLA01', year: 2026 }),
      );
    expect(number).toBe('TST-DLA01-2026-000001');
  });

  it('allocations séquentielles : incrément de un, sans trou', async () => {
    const siteId = freshUuid();
    const input = { docType: 'TST', siteId, codeSite: 'DLA01', year: 2026 };
    const a = await db.transaction().execute((trx) => service.next(trx, input));
    const b = await db.transaction().execute((trx) => service.next(trx, input));
    const c = await db.transaction().execute((trx) => service.next(trx, input));
    expect([a, b, c]).toEqual([
      'TST-DLA01-2026-000001',
      'TST-DLA01-2026-000002',
      'TST-DLA01-2026-000003',
    ]);
  });

  it('compteurs indépendants par (doc_type, site_id, year)', async () => {
    const siteId = freshUuid();
    const a = await db
      .transaction()
      .execute((trx) =>
        service.next(trx, { docType: 'VTE', siteId, codeSite: 'DLA01', year: 2026 }),
      );
    const b = await db
      .transaction()
      .execute((trx) =>
        service.next(trx, { docType: 'CMD', siteId, codeSite: 'DLA01', year: 2026 }),
      );
    const c = await db
      .transaction()
      .execute((trx) =>
        service.next(trx, { docType: 'VTE', siteId, codeSite: 'DLA01', year: 2027 }),
      );
    expect(a).toBe('VTE-DLA01-2026-000001');
    expect(b).toBe('CMD-DLA01-2026-000001');
    expect(c).toBe('VTE-DLA01-2027-000001');
  });

  it('allocations concurrentes sur la même clé : jamais le même numéro, jamais de trou', async () => {
    const siteId = freshUuid();
    const input = { docType: 'TST', siteId, codeSite: 'DLA01', year: 2026 };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => db.transaction().execute((trx) => service.next(trx, input))),
    );
    const seqs = results.map((n) => Number(n.split('-')[3])).sort((x, y) => x - y);
    expect(new Set(seqs).size).toBe(8);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
