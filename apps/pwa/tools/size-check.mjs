#!/usr/bin/env node
// Budget de bundle NFR-05 : JS initial <= 300 Ko gzip. Tant qu'aucun découpage par rôle
// n'existe (squelette P0-14, un seul rôle vide), tous les chunks JS de `dist/` sont chargés
// au premier affichage — le total mesuré ici EST le JS initial. Dès qu'un écran accessible
// seulement après authentification (ou propre à un rôle) sera chargé par `React.lazy`, ce
// script devra exclure ses chunks (non requis avant l'interaction qui les charge).
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

let totalGzip = 0;
for (const file of files) {
  const gzipSize = gzipSync(readFileSync(file)).length;
  totalGzip += gzipSize;
  console.log(`  ${file.replace(distDir, 'dist')} : ${(gzipSize / 1024).toFixed(1)} Ko gzip`);
}

const totalKo = totalGzip / 1024;
console.log(
  `Total JS initial (gzip) : ${totalKo.toFixed(1)} Ko (budget ${BUDGET_BYTES / 1024} Ko, NFR-05).`,
);

if (totalGzip > BUDGET_BYTES) {
  console.error(`Budget de bundle dépassé : ${totalKo.toFixed(1)} Ko > ${BUDGET_BYTES / 1024} Ko.`);
  process.exit(1);
}
