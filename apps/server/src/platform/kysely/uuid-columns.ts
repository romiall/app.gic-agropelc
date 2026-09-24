/** Conversion UUID texte → `BINARY(16)` (Buffer) aux points d'écriture Kysely — @gic/domain::uuidToBin fait le calcul, ce fichier l'adapte au type Node attendu par mysql2/Kysely. */
import { binToUuid, uuidToBin } from '@gic/domain';

export function toBin(uuid: string): Buffer {
  return Buffer.from(uuidToBin(uuid));
}

export function toBinOrNull(uuid: string | null | undefined): Buffer | null {
  return uuid === null || uuid === undefined ? null : toBin(uuid);
}

export function fromBin(bytes: Buffer): string {
  return binToUuid(bytes);
}

export function fromBinOrNull(bytes: Buffer | null): string | null {
  return bytes === null ? null : fromBin(bytes);
}
