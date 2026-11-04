/**
 * Chargement du `.env` local par les essais d'intégration du serveur.
 *
 * Les essais mutent la base (écritures, horloges avancées qui polluent à jamais les paramètres immuables) : ils ne
 * tournent que sur une base jetable. Sans `SERVER_DATABASE_URL` posée, le fichier `apps/server/.env` n'est donc chargé
 * que s'il vise une base dont le nom finit par `_test` ou `_rp` ; il vise d'ordinaire `gic_agropelc_dev`, la base de
 * développement, qui ne doit jamais recevoir la suite (ADR-052, revue du 04/11/2026). Dans tous les autres cas, rien
 * n'est chargé et les essais s'arrêtent sur l'erreur d'origine « SERVER_DATABASE_URL non définie ».
 */
import { readFileSync } from 'node:fs';

/** Bases jetables : les seules que les essais acceptent sans variable posée explicitement. */
const DISPOSABLE_DATABASE = /_(test|rp)$/;

/** Nom de la base d'une URL de connexion (vide si l'URL est illisible). */
export function databaseNameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

export function isDisposableDatabaseUrl(url: string): boolean {
  return DISPOSABLE_DATABASE.test(databaseNameOf(url));
}

/**
 * Charge le `.env` local (sans écraser les variables déjà posées) si `SERVER_DATABASE_URL` n'est pas posée et que ce
 * fichier vise une base jetable. Aucun effet sinon.
 */
export function loadLocalEnvForTests(envFile: URL): void {
  if (process.env.SERVER_DATABASE_URL) return;
  let text: string;
  try {
    text = readFileSync(envFile, 'utf8');
  } catch {
    return; // Pas de fichier local .env
  }
  const match = /^\s*SERVER_DATABASE_URL\s*=\s*(.+?)\s*$/m.exec(text);
  const value = (match?.[1] ?? '').replace(/^["']|["']$/g, '');
  if (!isDisposableDatabaseUrl(value)) return;
  process.loadEnvFile(envFile);
}
