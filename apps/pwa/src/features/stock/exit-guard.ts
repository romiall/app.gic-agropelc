/**
 * Liens entre les messages de la garde hors ligne d'une sortie de stock (`ExitGuardMessages`) et les
 * champs de quantité qu'ils décrivent (`aria-describedby`, `aria-invalid`).
 */
import type { ExitGuard } from '../sales/quota.js';

/** Identifiant du message de la garde pour un produit (vide : garde d'appareil). */
export function guardIssueId(prefix: string, productId: string): string {
  return `${prefix}-guard-${productId || 'appareil'}`;
}

/** Identifiant du message de la garde qui concerne ce produit, s'il y en a un. */
export function guardDescribedBy(
  guard: ExitGuard,
  prefix: string,
  productId: string,
): string | undefined {
  const issue = [...guard.blocks, ...guard.signals].find(
    (candidate) => candidate.productId === productId || candidate.productId === '',
  );
  return issue ? guardIssueId(prefix, issue.productId) : undefined;
}

/** Vrai si la garde refuse la sortie de ce produit. */
export function guardBlocks(guard: ExitGuard, productId: string): boolean {
  return guard.blocks.some(
    (candidate) => candidate.productId === productId || candidate.productId === '',
  );
}
