/**
 * Écart d'ouverture d'une session de caisse (ADR-032 §4) : posé par la commande d'ouverture, à
 * `opened_at`, il appartient à la période précédente et n'entre pas dans INV-FIN-11. Règle partagée par
 * la vérification d'une session (`verifyCashSessionVariance`) et le balayage de toutes les sessions
 * (`verifyCashSessions`, P5-22), pour qu'elles ne divergent pas.
 */
export function isOpeningVarianceMovement(
  movement: { readonly commandId: string | null; readonly occurredAt: Date },
  session: { readonly commandId: string | null; readonly closedAt: Date | null },
): boolean {
  // Avec sa commande d'ouverture, c'est le mouvement de cette commande ; sans commande (session posée
  // hors pipeline), tout écart antérieur à la clôture est celui de l'ouverture (clôture et ajustements
  // sont datés à `closed_at`).
  if (session.commandId !== null) return movement.commandId === session.commandId;
  return session.closedAt === null || movement.occurredAt.getTime() < session.closedAt.getTime();
}
