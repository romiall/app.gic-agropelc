#!/usr/bin/env node
// Budget de bundle NFR-05 : JS initial <= 300 Ko gzip. Le JS initial est ce que la page charge avant toute
// interaction : les scripts et préchargements (`modulepreload`) de `dist/index.html`, le service worker et
// Workbox (fichiers à la racine de `dist/`, `workbox-window`). Les écrans chargés à la demande (`React.lazy`,
// App.tsx) en sont exclus : ils ne sont demandés qu'à l'ouverture de leur écran (et mis en cache par le
// service worker pour le hors-ligne). Leur total est affiché à part, pour mémoire.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const BUDGET_BYTES = 300 * 1024;
const distDir = join(process.cwd(), 'dist');

function listJsFiles(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listJsFiles(full));
    } else if (entry.endsWith('.js') && !entry.endsWith('.js.map')) {
      files.push(full);
    }
  }
  return files;
}

let files;
try {
  files = listJsFiles(distDir);
} catch {
  console.error(`Build introuvable : ${distDir} (lancer "vite build" avant).`);
  process.exit(2);
}

if (files.length === 0) {
  console.error(`Aucun fichier JS trouvé dans ${distDir}.`);
  process.exit(2);
}

const html = readFileSync(join(distDir, 'index.html'), 'utf8');
const referenced = new Set(
  [...html.matchAll(/(?:src|href)="\/?([^"]+\.js)"/g)].map((match) => join(distDir, match[1])),
);
const isInitial = (file) =>
  referenced.has(file) ||
  !file.startsWith(join(distDir, 'assets')) ||
  file.replace(distDir, '').includes('workbox-window');

let totalGzip = 0;
let lazyGzip = 0;
for (const file of files) {
  const gzipSize = gzipSync(readFileSync(file)).length;
  if (!isInitial(file)) {
    lazyGzip += gzipSize;
    continue;
  }
  totalGzip += gzipSize;
  console.log(`  ${file.replace(distDir, 'dist')} : ${(gzipSize / 1024).toFixed(1)} Ko gzip`);
}
console.log(
  `Écrans chargés à la demande (gzip, hors budget) : ${(lazyGzip / 1024).toFixed(1)} Ko.`,
);

const totalKo = totalGzip / 1024;
console.log(
  `Total JS initial (gzip) : ${totalKo.toFixed(1)} Ko (budget ${BUDGET_BYTES / 1024} Ko, NFR-05).`,
);

if (totalGzip > BUDGET_BYTES) {
  console.error(`Budget de bundle dépassé : ${totalKo.toFixed(1)} Ko > ${BUDGET_BYTES / 1024} Ko.`);
  process.exit(1);
}
