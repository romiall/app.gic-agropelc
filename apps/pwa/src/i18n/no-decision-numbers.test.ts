/**
 * Aucun numéro de décision (AV-nnn) ne doit pouvoir atteindre l'écran : ce sont des identifiants internes du registre
 * des questions à valider, qui ne disent rien à l'utilisateur et se coupent au tiret sur téléphone. Ils restent
 * permis dans les commentaires et dans les fichiers d'essai, jamais dans une ligne de code (libellé, message
 * d'erreur, texte par défaut d'un composant).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Chemin explicite : `new URL('..', import.meta.url)` serait pris par Vite pour un actif à servir (voir tokens.test.ts).
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..') + sep;
const DECISION_NUMBER = /\bAV-\d{3}\b/;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules') files.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      files.push(path);
    }
  }
  return files;
}

/** Lignes de code (hors commentaires de ligne et de bloc) qui portent un numéro de décision. */
function offendingLines(path: string): string[] {
  const offending: string[] = [];
  let inBlockComment = false;
  readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = raw.trim();
      if (inBlockComment) {
        if (line.includes('*/')) inBlockComment = false;
        return;
      }
      if (line.startsWith('/*')) {
        if (!line.includes('*/')) inBlockComment = true;
        return;
      }
      if (line.startsWith('//') || line.startsWith('*')) return;
      // Commentaires de fin de ligne et commentaires JSX d'une seule ligne.
      const code = raw.replace(/\s\/\/\s.*$/, '').replace(/\{\/\*.*?\*\/\}/g, '');
      if (DECISION_NUMBER.test(code)) {
        offending.push(`${path.slice(SRC.length)}:${index + 1}: ${line.slice(0, 160)}`);
      }
    });
  return offending;
}

describe('numéros de décision à l’écran', () => {
  it('aucune ligne de code de la PWA ne porte un numéro AV-nnn (libellés, messages, textes par défaut)', () => {
    const offending = sourceFiles(SRC).flatMap(offendingLines);
    expect(offending, offending.join('\n')).toEqual([]);
  });
});
