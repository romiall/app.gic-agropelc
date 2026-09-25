/**
 * Erreur de domaine : violation d'une règle vérifiable localement, sans accès réseau ni
 * base (arguments invalides passés à une fonction de `packages/domain`). Distincte des
 * codes d'erreur métier du catalogue API (08-api-events/01-architecture-api.md §2), qui
 * vivent dans `packages/contracts` et couvrent des refus décidés par le serveur.
 */
export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function assertSafeInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new DomainError(`${label} doit être un entier sûr (reçu ${value}).`, 'NOT_SAFE_INTEGER');
  }
}
