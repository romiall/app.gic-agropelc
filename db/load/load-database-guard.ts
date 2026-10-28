/**
 * Garde du générateur du jeu de charge (P9-25, PF-10). Les ventes de charge sont immuables
 * (`trg_sales_sales_no_delete`, `trg_sales_sale_lines_no_delete`) : une fois insérées, elles ne se retirent
 * plus, et les balayages d'invariants de P4 et de P8 (INV-VEN-06, INV-VEN-07, INV-VEN-08) les verraient et
 * échoueraient dans la suite par défaut de la base touchée. Elles ne s'insèrent donc que dans une base
 * dédiée, dont le nom se termine par `_load`.
 *
 * Fonction pure, testée sans base (`db/tests/load-database-guard.test.ts`). Même règle que l'expression
 * régulière de `apps/server/test/perf/analytics.perf.ts` (`db/` et `apps/server` ne partagent aucun code) :
 * garder les deux alignées.
 */

/** Suffixe exigé du nom de la base de charge. */
export const LOAD_DATABASE_SUFFIX = '_load';

/**
 * Vrai si le nom est celui d'une base dédiée : au moins un caractère avant le suffixe, casse ignorée
 * (Windows range les noms de bases en minuscules).
 */
export function isLoadDatabase(name: string | null | undefined): boolean {
  return (
    typeof name === 'string' &&
    name.length > LOAD_DATABASE_SUFFIX.length &&
    name.toLowerCase().endsWith(LOAD_DATABASE_SUFFIX)
  );
}

/** Rend la main si la base est dédiée au jeu de charge ; lève sinon (aucune écriture n'a eu lieu). */
export function assertLoadDatabase(name: string | null | undefined): void {
  if (isLoadDatabase(name)) return;
  throw new Error(
    `Jeu de charge refusé : la base « ${name ?? '(aucune)'} » n’est pas dédiée (son nom doit se terminer ` +
      `par « ${LOAD_DATABASE_SUFFIX} », par exemple gic_agropelc_p9_load). Les ventes générées sont ` +
      `immuables (déclencheurs) : elles ne se retirent plus et fausseraient les invariants de P4 et de P8.`,
  );
}
