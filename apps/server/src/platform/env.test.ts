import { describe, expect, it } from 'vitest';
import { loadEnv, trustProxyOption } from './env.js';

const BASE = { SERVER_DATABASE_URL: 'mysql://gic_app:x@127.0.0.1:3306/db' };

describe('trustProxyOption (AV-297, MP-11)', () => {
  it('absent, vide ou false : aucun proxy de confiance', () => {
    expect(trustProxyOption(undefined)).toBe(false);
    expect(trustProxyOption('')).toBe(false);
    expect(trustProxyOption('FALSE')).toBe(false);
    expect(loadEnv(BASE).TRUST_PROXY).toBeUndefined();
  });

  it('true, nombre de proxys, ou liste d’adresses et de plages', () => {
    expect(trustProxyOption('true')).toBe(true);
    const twoHops = trustProxyOption('2') as (address: string, hop: number) => boolean;
    expect([0, 1, 2].map((hop) => twoHops('203.0.113.7', hop))).toEqual([true, true, false]);
    expect(trustProxyOption('10.0.0.1, 192.168.0.0/16,')).toEqual(['10.0.0.1', '192.168.0.0/16']);
    expect(loadEnv({ ...BASE, TRUST_PROXY: ' 1 ' }).TRUST_PROXY).toBe('1');
  });
});

describe('loadEnv (01-architecture-logicielle.md §7 « Configuration »)', () => {
  it('applique les valeurs par défaut hors production', () => {
    const env = loadEnv(BASE);
    expect(env).toMatchObject({ NODE_ENV: 'development', PORT: 3000, HOST: '0.0.0.0' });
  });

  it('rejette une configuration sans SERVER_DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(/Configuration invalide/);
  });

  it('accepte development/test sans clés JWT (paire éphémère, jwt-keys.provider.ts)', () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'development' })).not.toThrow();
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'test' })).not.toThrow();
  });

  it('refuse la production sans JWT_PRIVATE_KEY/JWT_PUBLIC_KEY (aucune clé éphémère en production)', () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'production' })).toThrow(
      /JWT_PRIVATE_KEY et JWT_PUBLIC_KEY sont obligatoires en production/,
    );
  });

  it('accepte la production avec les deux clés JWT fournies', () => {
    expect(() =>
      loadEnv({ ...BASE, NODE_ENV: 'production', JWT_PRIVATE_KEY: 'pk', JWT_PUBLIC_KEY: 'pub' }),
    ).not.toThrow();
  });

  it('VAPID_* : absentes par défaut (Web Push désactivé), lues et nettoyées quand elles sont posées (AV-536)', () => {
    const absent = loadEnv(BASE);
    expect(absent.VAPID_PUBLIC_KEY).toBeUndefined();
    expect(absent.VAPID_PRIVATE_KEY).toBeUndefined();
    expect(absent.VAPID_SUBJECT).toBeUndefined();
    expect(
      loadEnv({
        ...BASE,
        VAPID_PUBLIC_KEY: ' pub ',
        VAPID_PRIVATE_KEY: ' priv ',
        VAPID_SUBJECT: ' mailto:porteur@example.org ',
      }),
    ).toMatchObject({
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
      VAPID_SUBJECT: 'mailto:porteur@example.org',
    });
    // Posées mais vides (modèle d’environnement non rempli) : pas d’erreur de démarrage, canal désactivé.
    expect(() => loadEnv({ ...BASE, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' })).not.toThrow();
  });

  it('ATTACHMENTS_STORAGE_DIR : répertoire temporaire système par défaut (AV-091), surchargeable', () => {
    expect(loadEnv(BASE).ATTACHMENTS_STORAGE_DIR).toMatch(/gic-attachments$/);
    expect(
      loadEnv({ ...BASE, ATTACHMENTS_STORAGE_DIR: '/srv/attachments' }).ATTACHMENTS_STORAGE_DIR,
    ).toBe('/srv/attachments');
  });
});
