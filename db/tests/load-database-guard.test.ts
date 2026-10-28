/**
 * Garde du jeu de charge (P9-25, PF-10) : le générateur n'écrit que dans une base dont le nom se termine
 * par `_load` (les ventes sont immuables et fausseraient les invariants de P4 et de P8). Exception à la
 * règle des essais de ce dossier : garde pure, sans base ni `DATABASE_URL` (n'importe pas `helpers.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  LOAD_DATABASE_SUFFIX,
  assertLoadDatabase,
  isLoadDatabase,
} from '../load/load-database-guard.js';

describe('garde du jeu de charge', () => {
  it('accepte une base dédiée, casse ignorée', () => {
    for (const name of ['gic_agropelc_p9_load', 'gic_agropelc_load', 'GIC_P9_LOAD', 'x_load']) {
      expect(isLoadDatabase(name), name).toBe(true);
      expect(() => assertLoadDatabase(name), name).not.toThrow();
    }
  });

  it('refuse les bases du dépôt', () => {
    for (const name of [
      'gic_agropelc_dev',
      'gic_agropelc_test',
      'gic_agropelc_p9b',
      'gic_agropelc_p9m',
      'gic_agropelc_base',
    ]) {
      expect(isLoadDatabase(name), name).toBe(false);
      expect(() => assertLoadDatabase(name), name).toThrow();
    }
  });

  it('refuse les quasi-suffixes et le suffixe sans préfixe', () => {
    for (const name of [
      'gic_agropelc_workload',
      'gic_agropelc_loader',
      'gic_load_test',
      'load',
      '_load',
    ]) {
      expect(isLoadDatabase(name), name).toBe(false);
      expect(() => assertLoadDatabase(name), name).toThrow();
    }
  });

  it('refuse une connexion sans base (null, undefined, chaîne vide)', () => {
    for (const name of [null, undefined, '']) {
      expect(isLoadDatabase(name)).toBe(false);
      expect(() => assertLoadDatabase(name)).toThrow(/n’est pas dédiée/);
    }
  });

  it('le message nomme la base refusée et le suffixe exigé', () => {
    expect(() => assertLoadDatabase('gic_agropelc_dev')).toThrow(/gic_agropelc_dev/);
    expect(() => assertLoadDatabase('gic_agropelc_dev')).toThrow(LOAD_DATABASE_SUFFIX);
    expect(() => assertLoadDatabase(null)).toThrow(/\(aucune\)/);
  });
});
