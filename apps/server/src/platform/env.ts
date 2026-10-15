/**
 * Configuration technique par variables d'environnement (01-architecture-logicielle.md §7
 * « Configuration » : « paramètres techniques en variables d'environnement ; secrets dans
 * le gestionnaire de secrets »). Aucun secret par défaut en production : `JWT_PRIVATE_KEY`
 * absente est tolérée seulement hors production (voir identity/jwt.ts).
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  // Connexion applicative (rôle `gic_app`, privilèges minimaux par table) — distincte de
  // `DATABASE_URL` (rôle admin, migrations : db/README.md §1). Voir apps/server/.env.example.
  SERVER_DATABASE_URL: z.string().min(1),
  // Paire ES256 (jose), format PEM (07-security-rbac/02-securite.md §3). Optionnelles hors
  // production : une paire éphémère est générée au démarrage si absentes (identity/jwt.ts).
  JWT_PRIVATE_KEY: z.string().min(1).optional(),
  JWT_PUBLIC_KEY: z.string().min(1).optional(),
  // Émulateur local de stockage objet (AV-091, SECONDAIRE/OUVERT : « aucun impact sur P0 à
  // P3 » — fournisseur S3-compatible réel différé à la phase de déploiement). Répertoire des
  // pièces jointes en cours d'upload (platform/storage/local-fs-chunk-storage.ts). Hors de
  // l'arbre du dépôt par défaut (répertoire temporaire système) : aucun fichier de
  // développement ou de test à exclure par .gitignore.
  ATTACHMENTS_STORAGE_DIR: z
    .string()
    .min(1)
    .default(() => join(tmpdir(), 'gic-attachments')),
  // Proxy de confiance devant l'API (AV-297, MP-11 ; CDN de 04-deploiement §2) : `true`, nombre de
  // proxys, ou liste d'adresses ou de plages séparées par des virgules. Absent : aucun, l'adresse
  // d'un appareil est celle de la connexion TCP (comptage des échecs de connexion par adresse,
  // 02-securite §2). Derrière un proxy non déclaré, tous les appareils auraient son adresse.
  TRUST_PROXY: z.string().trim().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Option `trustProxy` de Fastify tirée de `TRUST_PROXY` (AV-297). Un nombre de proxys devient une
 * fonction de confiance par saut (les `n` plus proches), forme que le typage de l'adaptateur accepte.
 */
export function trustProxyOption(
  value: string | undefined,
): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (value === undefined || value === '' || value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return (_address: string, hop: number) => hop < hops;
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `Configuration invalide : ${parsed.error.issues.map((i) => `${i.path.join('.')} — ${i.message}`).join('; ')}`,
    );
  }
  if (
    parsed.data.NODE_ENV === 'production' &&
    (!parsed.data.JWT_PRIVATE_KEY || !parsed.data.JWT_PUBLIC_KEY)
  ) {
    throw new Error(
      'JWT_PRIVATE_KEY et JWT_PUBLIC_KEY sont obligatoires en production (aucune clé éphémère hors développement/test).',
    );
  }
  return parsed.data;
}
