import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS,
  PAGE_SIZE,
  auditPath,
  changedKeys,
  filterProblem,
  mayHaveMore,
  prettyJson,
  shortId,
} from './audit.js';

describe('Journal d’audit : filtres et lecture (ECR-AUD-01)', () => {
  it('chemin de lecture : les seuls filtres renseignés, page de 50, page plus ancienne par before_seq', () => {
    expect(auditPath(EMPTY_FILTERS)).toBe(`/api/v1/audit?limit=${PAGE_SIZE}`);
    const filters = {
      entityType: 'SALE',
      entityId: ' 01900000-0000-7000-8000-0000000000a1 ',
      actorUserId: '01900000-0000-7000-8000-0000000000b1',
      action: ' sales.sale.record ',
      from: '2026-10-01',
      to: '2026-10-31',
    };
    const query = new URLSearchParams(auditPath(filters, 120).split('?')[1]);
    expect(Object.fromEntries(query)).toEqual({
      limit: '50',
      entity_type: 'SALE',
      entity_id: '01900000-0000-7000-8000-0000000000a1',
      actor_user_id: '01900000-0000-7000-8000-0000000000b1',
      action: 'sales.sale.record',
      from: '2026-10-01',
      to: '2026-10-31',
      before_seq: '120',
    });
  });

  it('défauts de filtre refusés avant l’envoi : période à l’envers, identifiant qui n’est pas un UUID', () => {
    expect(filterProblem(EMPTY_FILTERS)).toBeNull();
    expect(filterProblem({ ...EMPTY_FILTERS, from: '2026-10-02', to: '2026-10-01' })).toBe(
      'PERIOD',
    );
    expect(filterProblem({ ...EMPTY_FILTERS, from: '2026-10-01', to: '2026-10-01' })).toBeNull();
    expect(filterProblem({ ...EMPTY_FILTERS, from: '2026-10-02' })).toBeNull();
    expect(filterProblem({ ...EMPTY_FILTERS, entityId: 'pas-un-uuid' })).toBe('ENTITY_ID');
    expect(
      filterProblem({ ...EMPTY_FILTERS, entityId: '01900000-0000-7000-8000-0000000000A1' }),
    ).toBeNull();
  });

  it('une page pleine laisse supposer des entrées plus anciennes', () => {
    expect(mayHaveMore(PAGE_SIZE)).toBe(true);
    expect(mayHaveMore(PAGE_SIZE - 1)).toBe(false);
    expect(mayHaveMore(0)).toBe(false);
  });

  it('champs modifiés entre l’avant et l’après, triés ; rien si ce ne sont pas des objets', () => {
    expect(changedKeys({ status: 'A', name: 'x' }, { status: 'B', name: 'x', note: 1 })).toEqual([
      'note',
      'status',
    ]);
    expect(changedKeys(null, { a: 1 })).toEqual(['a']);
    expect(changedKeys({ a: 1 }, null)).toEqual(['a']);
    expect(changedKeys(null, null)).toEqual([]);
    expect(changedKeys('a', 'b')).toEqual([]);
    expect(changedKeys([1], [2])).toEqual([]);
  });

  it('JSON lisible tronqué, identifiant raccourci', () => {
    expect(prettyJson(null)).toBe('');
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyJson({ texte: 'x'.repeat(100) }, 20)).toHaveLength(21);
    expect(prettyJson({ texte: 'x'.repeat(100) }, 20).endsWith('…')).toBe(true);
    expect(shortId('01900000-0000-7000-8000-0000000000a1')).toBe('000000a1');
    expect(shortId(null)).toBe('');
  });
});
