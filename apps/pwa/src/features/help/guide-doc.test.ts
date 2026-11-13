/**
 * Le guide écrit (`docs/11-guide-utilisateur/01-guide-global.md`) est généré du contenu de l'aide (AV-525,
 * ADR-058) : il ne peut pas en diverger. Pour le régénérer après une modification du contenu :
 * `GIC_WRITE_GUIDE=1 pnpm --filter @gic/pwa exec vitest run src/features/help/guide-doc.test.ts`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderGuideMarkdown } from './guide-markdown.js';

// Chemin explicite : `new URL(…, import.meta.url)` serait pris par Vite pour un actif à servir (voir tokens.test.ts).
const FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'docs',
  '11-guide-utilisateur',
  '01-guide-global.md',
);

describe('Guide écrit', () => {
  it('est à jour avec le contenu de l’aide', () => {
    const expected = renderGuideMarkdown();
    if (process.env.GIC_WRITE_GUIDE === '1') {
      mkdirSync(dirname(FILE), { recursive: true });
      writeFileSync(FILE, expected, 'utf8');
    }
    // Les fins de ligne du poste (CRLF à l'extraction sous Windows) ne comptent pas.
    const actual = readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
    expect(actual).toBe(expected);
  });

  it('couvre les parcours, les pages et l’annexe des droits', () => {
    const markdown = renderGuideMarkdown();
    expect(markdown).toContain('### Démarrer et conduire un lot d’élevage');
    expect(markdown).toContain('#### Lots de production');
    expect(markdown).toContain('## Annexe A — Quelles pages pour quel rôle');
    expect(markdown).toContain('| Action | Ce qu’elle fait | Qui | Réseau |');
  });
});
