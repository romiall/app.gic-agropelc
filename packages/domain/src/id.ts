/**
 * Générateur d'identifiants injecté (ADR-002, ADR-021 K1).
 *
 * Comme pour `Clock`, aucune fonction de `packages/domain` n'appelle
 * `crypto.randomUUID()` directement : elle reçoit un `IdGenerator`. Cela permet des
 * tests déterministes (une séquence d'identifiants prévisible) et garantit que
 * l'appareil et le serveur génèrent des identifiants au même format (UUIDv7, uuid.ts).
 */
export interface IdGenerator {
  /** Nouvel identifiant UUIDv7 (03-data/01-identifiants-et-conventions.md §1.3). */
  newId(): string;
}
