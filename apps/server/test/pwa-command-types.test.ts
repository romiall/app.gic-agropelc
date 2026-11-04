/**
 * Conformité PWA ↔ serveur : tout type de commande écrit en clair dans la PWA (`commandType: 'a.b.c'`) est enregistré
 * côté serveur. Une commande au type inconnu est refusée à la synchronisation (`REJECTED`) : l'écran qui l'envoie ne
 * fonctionne pas, et ses essais, qui figent le type écrit dans le code, restent verts (constaté le 04/11/2026 sur l'écran
 * de report des pièces papier, PP-B : sept types inventés sur neuf).
 *
 * Lecture de fichiers seulement : ni base ni application (l'analyse est statique, comme `check:boundaries`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APPS = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGES = fileURLToPath(new URL('../../../packages', import.meta.url));

/**
 * Écarts connus, à résorber : types de l'écran de report des pièces papier (PP-B) qui n'existent pas côté serveur.
 * Leurs équivalents : `sales.sale.record`, `sales.order.place`, `sales.order.fulfil`, `finance.cash_transfer.send`,
 * `inventory.transfer.request`, `inventory.loss.declare`, `procurement.receipt.record`
 * (voir `docs/10-development-plan/19-pieces-papier.md`, journal du 04/11/2026). Retirer ici un type dès qu'il est corrigé.
 */
const KNOWN_GAPS: ReadonlySet<string> = new Set([
  'sales.sale.create',
  'sales.sales_order.create',
  'sales.delivery_note.create',
  'finance.cash_transfer.create',
  'inventory.stock_transfer.create',
  'inventory.loss_declaration.create',
  'procurement.goods_receipt.create',
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

const DOTTED = '[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*';

function collect(files: readonly string[], pattern: RegExp): Set<string> {
  const found = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) found.add(match[1]!);
  }
  return found;
}

describe('types de commande de la PWA et du serveur', () => {
  const sent = collect(
    sourceFiles(join(APPS, 'pwa/src')),
    new RegExp(`(?:commandType|command_type)['"]?\\s*[:=]\\s*['"](${DOTTED})['"]`, 'g'),
  );
  // Enregistrés par le serveur (`commandType: 'a.b.c'`) ou déclarés dans les contrats (constantes partagées).
  const registered = new Set([
    ...collect(
      sourceFiles(join(APPS, 'server/src')),
      new RegExp(`commandType:\\s*['"](${DOTTED})['"]`, 'g'),
    ),
    ...collect(
      sourceFiles(join(PACKAGES, 'contracts/src')),
      new RegExp(`['"](${DOTTED})['"]`, 'g'),
    ),
  ]);

  it('la recherche trouve des commandes de part et d’autre (garde contre une analyse vide)', () => {
    expect(sent.size).toBeGreaterThan(50);
    expect(registered.size).toBeGreaterThan(100);
  });

  it('tout type de commande écrit en clair dans la PWA est enregistré côté serveur', () => {
    const unknown = [...sent].filter((type) => !registered.has(type) && !KNOWN_GAPS.has(type));
    expect(unknown).toEqual([]);
  });

  it('les écarts connus en sont toujours (en retirer dès qu’un type est corrigé)', () => {
    const resolved = [...KNOWN_GAPS].filter((type) => registered.has(type) || !sent.has(type));
    expect(resolved).toEqual([]);
  });
});
