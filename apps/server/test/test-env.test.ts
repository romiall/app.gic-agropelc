/**
 * Les essais d'intégration ne se rabattent sur le `.env` local que s'il vise une base jetable (voir test-env.ts) :
 * la base de développement ne reçoit jamais la suite. Pas de base, pas de réseau.
 */
import { describe, expect, it } from 'vitest';
import { databaseNameOf, isDisposableDatabaseUrl } from './test-env.js';

describe('base cible des essais', () => {
  it('lit le nom de la base dans l’URL', () => {
    expect(databaseNameOf('mysql://gic_app:secret@127.0.0.1:3307/gic_agropelc_test')).toBe(
      'gic_agropelc_test',
    );
    expect(databaseNameOf('mysql://gic_app:p%40ss@127.0.0.1:3307/gic_agropelc_rp?x=1')).toBe(
      'gic_agropelc_rp',
    );
    expect(databaseNameOf('pas une url')).toBe('');
  });

  it('accepte les bases jetables, refuse la base de développement et toute autre', () => {
    expect(isDisposableDatabaseUrl('mysql://u:p@127.0.0.1:3307/gic_agropelc_test')).toBe(true);
    expect(isDisposableDatabaseUrl('mysql://u:p@127.0.0.1:3307/gic_agropelc_rp')).toBe(true);
    expect(isDisposableDatabaseUrl('mysql://u:p@127.0.0.1:3307/gic_agropelc_dev')).toBe(false);
    expect(isDisposableDatabaseUrl('mysql://u:p@127.0.0.1:3307/gic_agropelc')).toBe(false);
    expect(isDisposableDatabaseUrl('mysql://u:p@127.0.0.1:3307/gic_agropelc_test_prod')).toBe(
      false,
    );
    expect(isDisposableDatabaseUrl('')).toBe(false);
  });
});
