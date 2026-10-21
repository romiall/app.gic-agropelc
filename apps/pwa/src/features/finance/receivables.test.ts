import { describe, expect, it } from 'vitest';
import type { CustomerData } from '../sales/types.js';
import {
  canonicalCustomer,
  CUSTOMER_NAME_MAX_PAGES,
  CUSTOMER_NAME_PATHS,
  customerDirectory,
  customersToName,
  groupReceivables,
  matchesView,
  notDueXaf,
  ownerOf,
  RECEIVABLES_PATH,
  sortGroups,
  summarizeLines,
  telHref,
  USER_NAME_MAX_PAGES,
  USER_NAME_PATH,
  type ReceivableItem,
} from './receivables.js';

function item(over: Partial<ReceivableItem>): ReceivableItem {
  return {
    saleId: 's',
    docNumber: 'VTE-2026-000001',
    customerId: 'c1',
    siteId: 'site',
    commercialUserId: null,
    sellerUserId: 'seller',
    zoneId: 'zone',
    occurredAt: '2026-09-01T10:00:00.000Z',
    dueDate: '2026-10-01',
    netTotalXaf: 1000,
    amountPaidXaf: 0,
    balanceDueXaf: 1000,
    daysOverdue: 9,
    overdue: true,
    bucket: '0-30',
    resource: { ownerUserId: 'seller', siteId: 'site', zoneId: 'zone' },
    ...over,
  };
}

const notDue = item({
  saleId: 'n',
  dueDate: '2026-10-20',
  daysOverdue: 0,
  overdue: false,
  bucket: '0-30',
  balanceDueXaf: 300,
});
const late = item({ saleId: 'l', balanceDueXaf: 1000 });
const later = item({
  saleId: 'm',
  dueDate: '2026-08-01',
  daysOverdue: 70,
  bucket: '61-90',
  balanceDueXaf: 2000,
});
const oldest = item({
  saleId: 'o',
  dueDate: '2026-05-01',
  daysOverdue: 162,
  bucket: '>90',
  balanceDueXaf: 50,
});

describe('créances (ECR-FIN-01, P8E-09)', () => {
  it('vues : toutes, échues, à échoir ; une tranche ne prend que l’échu', () => {
    expect(matchesView(notDue, 'ALL')).toBe(true);
    expect(matchesView(notDue, 'OVERDUE')).toBe(false);
    expect(matchesView(notDue, 'NOT_DUE')).toBe(true);
    // Non échue, elle porte pourtant la tranche « 0-30 » : elle n'y est pas rangée.
    expect(matchesView(notDue, '0-30')).toBe(false);
    expect(matchesView(late, '0-30')).toBe(true);
    expect(matchesView(late, 'OVERDUE')).toBe(true);
    expect(matchesView(late, 'NOT_DUE')).toBe(false);
    expect(matchesView(later, '61-90')).toBe(true);
    expect(matchesView(later, '31-60')).toBe(false);
    expect(matchesView(item({ bucket: '31-60' }), '31-60')).toBe(true);
    expect(matchesView(item({ bucket: '31-60', overdue: false }), '31-60')).toBe(false);
    expect(matchesView(oldest, '>90')).toBe(true);
  });

  it('synthèse d’une sélection : même règle que le serveur, seul l’échu dans les tranches', () => {
    const summary = summarizeLines([notDue, late, later, oldest]);
    expect(summary).toEqual({
      totalXaf: 3350,
      overdueXaf: 3050,
      count: 4,
      buckets: { '0-30': 1000, '31-60': 0, '61-90': 2000, '>90': 50 },
    });
    expect(notDueXaf(summary)).toBe(300);
    expect(summarizeLines([])).toEqual({
      totalXaf: 0,
      overdueXaf: 0,
      count: 0,
      buckets: { '0-30': 0, '31-60': 0, '61-90': 0, '>90': 0 },
    });
  });

  it('titulaire : commercial attributaire, à défaut vendeur', () => {
    expect(ownerOf(item({ commercialUserId: 'com' }))).toBe('com');
    expect(ownerOf(item({ commercialUserId: null }))).toBe('seller');
  });

  it('compte conservé : fusions successives suivies, boucle arrêtée', () => {
    const alias = new Map([
      ['a', 'b'],
      ['b', 'c'],
      ['x', 'y'],
      ['y', 'x'],
    ]);
    expect(canonicalCustomer('a', alias)).toBe('c');
    expect(canonicalCustomer('c', alias)).toBe('c');
    expect(canonicalCustomer('z', alias)).toBe('z');
    expect(canonicalCustomer('x', alias)).toBe('y');
  });

  it('regroupement : dû, échu, nombre en retard, plus fort retard, plus ancienne échéance', () => {
    const groups = groupReceivables([notDue, late, item({ ...later, customerId: 'c2' })], (line) =>
      String(line.customerId),
    );
    expect(groups).toEqual([
      {
        key: 'c1',
        lines: [notDue, late],
        balanceXaf: 1300,
        overdueXaf: 1000,
        overdueCount: 1,
        maxDaysOverdue: 9,
        oldestDueDate: '2026-10-01',
      },
      {
        key: 'c2',
        lines: [item({ ...later, customerId: 'c2' })],
        balanceXaf: 2000,
        overdueXaf: 2000,
        overdueCount: 1,
        maxDaysOverdue: 70,
        oldestDueDate: '2026-08-01',
      },
    ]);
    // Rien d'échu : aucun retard.
    expect(groupReceivables([notDue], () => 'k')[0]).toMatchObject({
      overdueXaf: 0,
      overdueCount: 0,
      maxDaysOverdue: 0,
    });
  });

  it('tri des groupes : échu, puis dû, puis nom, puis clé', () => {
    const group = (key: string, overdueXaf: number, balanceXaf: number) => ({
      key,
      lines: [],
      balanceXaf,
      overdueXaf,
      overdueCount: 0,
      maxDaysOverdue: 0,
      oldestDueDate: '2026-10-01',
    });
    const names: Record<string, string> = { a: 'Zoé', b: 'Ange', c: 'Ange', d: 'Bruno' };
    expect(
      sortGroups(
        [
          group('d', 10, 10),
          group('c', 0, 5),
          group('b', 0, 5),
          group('a', 0, 5),
          group('e', 0, 9),
        ],
        (key) => names[key] ?? key,
      ).map((g) => g.key),
    ).toEqual(['d', 'e', 'b', 'c', 'a']);
    // L'échu passe avant le dû : 5 échus sur 5 dus avant 100 dus à échoir.
    expect(
      sortGroups([group('x', 0, 100), group('y', 5, 5)], (key) => key).map((g) => g.key),
    ).toEqual(['y', 'x']);
  });

  it('annuaire des clients : appareil d’abord, comptes fusionnés lus en ligne', () => {
    const local = [
      { id: 'c1', display_name: 'Boutique', phone_primary: '+237 6', merged_into_id: null },
    ] as CustomerData[];
    const directory = customerDirectory(local, new Map([['old', 'c1']]), [
      { id: 'c1', displayName: 'Autre nom', phonePrimary: null, mergedIntoId: null },
      { id: 'c2', displayName: 'Restaurant', phonePrimary: null, mergedIntoId: null },
      { id: 'old', displayName: 'Ancien', phonePrimary: null, mergedIntoId: 'c2' },
      { id: 'abs', displayName: 'Absorbé', phonePrimary: '1', mergedIntoId: 'c2' },
    ]);
    expect(directory.cards.get('c1')).toEqual({
      name: 'Boutique',
      phone: '+237 6',
      onDevice: true,
    });
    expect(directory.cards.get('c2')).toEqual({ name: 'Restaurant', phone: null, onDevice: false });
    // La fusion connue de l'appareil n'est pas remplacée par la lecture en ligne.
    expect(directory.alias.get('old')).toBe('c1');
    expect(directory.alias.get('abs')).toBe('c2');
    expect(directory.alias.has('c2')).toBe(false);
  });

  it('clients à nommer en ligne : inconnus de l’appareil, comptes conservés, triés, sans doublon', () => {
    const local = customerDirectory(
      [{ id: 'c1', display_name: 'Boutique', phone_primary: null } as CustomerData],
      new Map([['old', 'c1']]),
      [],
    );
    expect(
      customersToName(
        [
          item({ customerId: 'c3' }),
          item({ customerId: 'c1' }),
          item({ customerId: 'old' }),
          item({ customerId: null }),
          item({ customerId: 'c2' }),
          item({ customerId: 'c3' }),
        ],
        local,
      ),
    ).toEqual(['c2', 'c3']);
    expect(customersToName([item({ customerId: 'c1' })], local)).toEqual([]);
  });

  it('chemins et lien d’appel', () => {
    expect(RECEIVABLES_PATH).toBe('/api/v1/receivables');
    expect(CUSTOMER_NAME_PATHS).toEqual([
      '/api/v1/customers?limit=200',
      '/api/v1/customers?stage=MERGED&limit=200',
    ]);
    expect(CUSTOMER_NAME_MAX_PAGES).toBe(10);
    expect(USER_NAME_PATH).toBe('/api/v1/users?limit=200');
    expect(USER_NAME_MAX_PAGES).toBe(5);
    expect(telHref('+237 699 11-22.33')).toBe('tel:+237699112233');
  });
});
