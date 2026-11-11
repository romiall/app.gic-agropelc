/**
 * Lancement du téléchargement d'un fichier d'archive (AV-539, ADR-070 §6) : le navigateur télécharge lui-même, par un
 * lien portant un billet court (un lien ne porte pas l'en-tête `Authorization`), si bien qu'un fichier de plusieurs
 * centaines de Mo n'est jamais lu en mémoire par l'application. Isolé ici pour que les essais d'écran n'ouvrent pas de
 * vrai téléchargement.
 */
import { apiUrl } from '../../platform/env.js';

/** Ouvre le lien de téléchargement dans le navigateur (le serveur répond `Content-Disposition: attachment`). */
export function startDownload(path: string): void {
  const link = document.createElement('a');
  link.href = apiUrl(path);
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Attente entre deux relectures de l'état d'un téléchargement (remplaçable dans les essais). */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
