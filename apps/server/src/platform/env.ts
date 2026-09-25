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
});

export type Env = z.infer<typeof envSchema>;

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
