/**
 * Port de stockage par morceaux (ADR-012 : upload « séparé, par morceaux de 256 Ko,
 * reprenable (offset) »). Un seul fournisseur en P0 ({@link LocalFsChunkStorage}, émulateur
 * local — AV-091, SECONDAIRE/OUVERT : « aucun impact sur P0 à P3 »), mais l'interface existe
 * dès maintenant parce que la source elle-même annonce son remplacement par un stockage
 * objet S3-compatible réel à la phase de déploiement (ADR-012 point 4) — pas une
 * abstraction spéculative.
 *
 * Contrat d'ajout strictement séquentiel (jamais d'écriture à une position arbitraire) :
 * {@link ChunkStorage.appendChunk} exige `offset === taille actuelle` et lève
 * {@link ChunkOffsetMismatchError} sinon — c'est ce contrat, pas un numéro de session
 * séparé, qui rend l'upload reprenable (le client découvre la position de reprise via
 * {@link ChunkStorage.uploadedBytes}, jamais par un état qu'il devrait lui-même suivre).
 */
export interface ChunkStorage {
  uploadedBytes(key: string): Promise<number>;
  /** @returns la taille totale après ajout. @throws {ChunkOffsetMismatchError} si `offset` ne correspond pas à la taille actuelle. */
  appendChunk(key: string, offset: number, chunk: Buffer): Promise<number>;
  readAll(key: string): Promise<Buffer>;
}

export class ChunkOffsetMismatchError extends Error {
  constructor(
    readonly key: string,
    readonly expectedOffset: number,
    readonly receivedOffset: number,
  ) {
    super(
      `Décalage d'upload invalide pour ${key} : attendu ${expectedOffset}, reçu ${receivedOffset}.`,
    );
  }
}
