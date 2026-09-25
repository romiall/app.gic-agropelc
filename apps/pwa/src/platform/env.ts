/**
 * URL de base de l'API : jamais codée en dur (ADR-024 §2, `API_BASE_URL`). En développement,
 * `vite.config.ts` proxifie `/api` vers le serveur local ; en production, la variable
 * d'environnement de build fixe l'origine réelle (même domaine ou sous-domaine dédié).
 */
export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}
