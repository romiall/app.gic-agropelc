#!/usr/bin/env node
// Vérifie que le rapport de couverture v8 (lcov) d'un paquet atteint un seuil de lignes
// donné. Utilisé en CI pour NFR-31 (packages/domain ≥ 90 % de couverture de lignes) —
// indépendant du seuil déjà imposé par vitest.config.ts, en garde-fou si ce fichier
// venait à être modifié sans revue attentive.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , pkgDir, thresholdArg] = process.argv;
if (!pkgDir || !thresholdArg) {
  console.error('Usage: check-coverage.mjs <répertoire-du-paquet> <seuil-pourcentage>');
  process.exit(2);
}

const threshold = Number(thresholdArg);
const lcovPath = join(pkgDir, 'coverage', 'lcov.info');

let lcov;
try {
  lcov = readFileSync(lcovPath, 'utf8');
} catch {
  console.error(`Rapport de couverture introuvable : ${lcovPath} (lancer "vitest run --coverage" avant).`);
  process.exit(2);
}

let linesFound = 0;
let linesHit = 0;
for (const line of lcov.split('\n')) {
  if (line.startsWith('LF:')) linesFound += Number(line.slice(3));
  if (line.startsWith('LH:')) linesHit += Number(line.slice(3));
}

if (linesFound === 0) {
  console.error(`Aucune ligne mesurée dans ${lcovPath}.`);
  process.exit(2);
}

const pct = (linesHit / linesFound) * 100;
const rounded = Math.round(pct * 100) / 100;
console.log(`Couverture de lignes pour ${pkgDir} : ${rounded}% (seuil ${threshold}%).`);

if (pct < threshold) {
  console.error(`Couverture insuffisante : ${rounded}% < ${threshold}% requis (NFR-31).`);
  process.exit(1);
}
