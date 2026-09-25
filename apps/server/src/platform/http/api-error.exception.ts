/**
 * Erreur transport (08-api-events/01-architecture-api.md §2 « Erreurs ») : échec au niveau
 * de l'endpoint lui-même (authentification absente/invalide, requête malformée), distincte
 * du rejet d'**une commande** (`REJECTED`/`CONFLICT`), qui reste une réponse HTTP 200 portant
 * l'enveloppe de résultat (`commandResultSchema`, @gic/contracts) — jamais un statut d'erreur
 * HTTP (§3.1 « Résultat d'une commande : enveloppe identique pour /commands et /sync/push »).
 */
import { HttpException } from '@nestjs/common';
import type { ApiError as ApiErrorBody } from '@gic/contracts';

export class ApiError extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    messageFr: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(messageFr, status);
  }

  toBody(correlationId: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        correlation_id: correlationId,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}
