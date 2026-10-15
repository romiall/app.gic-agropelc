/**
 * P9-07 : ce qui compte comme « activité » d'un commercial pour l'alerte `INACTIVE_COMMERCIAL`
 * (BR-TER-013, AV-409, AV-444) et lecture de ses deux réglages. Test unitaire : les API publiques de
 * `fieldwork` (prises de service) et de `crm` (visites) sont simulées, la lecture des ventes est un
 * `uow` factice ; le détecteur complet, la population suivie et le marqueur sont éprouvés par
 * `sales-acceptance.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/fieldwork/application/public/index.js', () => ({
  listWorkSessions: vi.fn(),
}));
vi.mock('../src/modules/crm/application/public/index.js', () => ({
  listVisits: vi.fn(),
}));

import { listVisits } from '../src/modules/crm/application/public/index.js';
import { listWorkSessions } from '../src/modules/fieldwork/application/public/index.js';
import {
  activeUserIdsOn,
  roleCodesOf,
  workingDaysOf,
} from '../src/modules/sales/application/jobs/inactive-commercial-job.js';

const U1 = '0192a000-0000-7000-8000-000000000001';
const U2 = '0192a000-0000-7000-8000-000000000002';
const U3 = '0192a000-0000-7000-8000-000000000003';
const U4 = '0192a000-0000-7000-8000-000000000004';
const U5 = '0192a000-0000-7000-8000-000000000005';

const bin = (uuid: string) => Buffer.from(uuid.replace(/-/g, ''), 'hex');

let saleRows: { seller_user_id: Buffer; commercial_user_id: Buffer | null }[] = [];
let saleQueries = 0;
const uow = {
  selectFrom: () => {
    const chain = {
      select: () => chain,
      where: () => chain,
      execute: async () => {
        saleQueries += 1;
        return saleRows;
      },
    };
    return chain;
  },
};

const page = (items: { userId: string; status: string }[], nextCursor: string | null = null) => ({
  items,
  nextCursor,
});

const activeOn = (userIds: string[]) => activeUserIdsOn(uow as never, userIds, '2026-10-20');

describe('activeUserIdsOn : prise de service, visite, vente', () => {
  beforeEach(() => {
    saleRows = [];
    saleQueries = 0;
    vi.mocked(listWorkSessions).mockReset().mockResolvedValue([]);
    vi.mocked(listVisits)
      .mockReset()
      .mockResolvedValue(page([]) as never);
  });

  it('personne à suivre : aucune lecture', async () => {
    expect([...(await activeOn([]))]).toEqual([]);
    expect(listWorkSessions).not.toHaveBeenCalled();
    expect(listVisits).not.toHaveBeenCalled();
    expect(saleQueries).toBe(0);
  });

  it('une prise de service compte, sauf dérogation refusée', async () => {
    vi.mocked(listWorkSessions).mockResolvedValue([
      { userId: U1, overrideStatus: 'NONE' },
      { userId: U2, overrideStatus: 'APPROVED' },
      { userId: U3, overrideStatus: 'REJECTED' },
    ] as never);
    const active = await activeOn([U1, U2, U3, U4]);
    expect([...active].sort()).toEqual([U1, U2]);
    // La plage lue est exactement le jour métier examiné (minuit local = 23:00 UTC la veille).
    const [, filter] = vi.mocked(listWorkSessions).mock.calls[0]!;
    expect((filter as { fromUtc: Date }).fromUtc.toISOString()).toBe('2026-10-19T23:00:00.000Z');
    expect((filter as { toUtc: Date }).toUtc.toISOString()).toBe('2026-10-20T23:00:00.000Z');
  });

  it('une visite enregistrée compte (toutes les pages), une visite annulée non', async () => {
    vi.mocked(listVisits)
      .mockResolvedValueOnce(
        page(
          [
            { userId: U1, status: 'RECORDED' },
            { userId: U2, status: 'CANCELLED' },
          ],
          'curseur-2',
        ) as never,
      )
      .mockResolvedValueOnce(page([{ userId: U3, status: 'RECORDED' }]) as never);
    const active = await activeOn([U1, U2, U3, U4]);
    expect([...active].sort()).toEqual([U1, U3]);
    expect(listVisits).toHaveBeenCalledTimes(2);
    expect(vi.mocked(listVisits).mock.calls[1]![1]).toMatchObject({ beforeId: 'curseur-2' });
  });

  it('une vente compte pour son vendeur et pour le commercial attributaire', async () => {
    saleRows = [
      { seller_user_id: bin(U1), commercial_user_id: null },
      { seller_user_id: bin(U5), commercial_user_id: bin(U2) },
    ];
    const active = await activeOn([U1, U2, U3]);
    expect([...active].sort()).toEqual([U1, U2, U5].sort());
    expect(saleQueries).toBe(1);
  });
});

describe('réglages : jours ouvrés et rôles suivis', () => {
  it('jours ouvrés ISO : valeurs 1 à 7 ; vide ou invalide : lundi à samedi', () => {
    expect(workingDaysOf(['1', '2', 3, '7'])).toEqual([1, 2, 3, 7]);
    expect(workingDaysOf(['0', '8', 'x', 2.5])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(workingDaysOf([])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(workingDaysOf('1,2')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(workingDaysOf(null)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rôles suivis : liste de codes ; vide ou invalide : COMMERCIAL_TERRAIN', () => {
    expect(roleCodesOf(['COMMERCIAL_TERRAIN', ' RESP_COMMERCIAL '])).toEqual([
      'COMMERCIAL_TERRAIN',
      'RESP_COMMERCIAL',
    ]);
    expect(roleCodesOf([])).toEqual(['COMMERCIAL_TERRAIN']);
    expect(roleCodesOf(['', '  '])).toEqual(['COMMERCIAL_TERRAIN']);
    expect(roleCodesOf('RESP_COMMERCIAL')).toEqual(['COMMERCIAL_TERRAIN']);
    expect(roleCodesOf(undefined)).toEqual(['COMMERCIAL_TERRAIN']);
  });
});
