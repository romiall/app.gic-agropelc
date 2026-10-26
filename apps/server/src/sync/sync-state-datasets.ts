/**
 * Jeux de `sync_device_sync_state` propres à la synchronisation de l'appareil (dictionnaire
 * sync.device_sync_state) : la ligne de l'appareil et une ligne par couple (appareil, auteur). Fichier sans
 * dépendance : importé par le service d'envoi, la fraîcheur des appareils et les tâches d'alerte du worker,
 * qui ne doivent pas tirer le service d'envoi (et son pipeline de commandes) pour lire ces noms.
 */

/** Ligne technique par appareil (`dataset = '_device'`, dictionnaire sync.device_sync_state). */
export const DEVICE_DATASET = '_device';
/** Ligne technique par couple (appareil, auteur) : `_a:` suivi des 32 caractères hexadécimaux de l'utilisateur. */
export const AUTHOR_DATASET_PREFIX = '_a:';
/** Motif `LIKE` des lignes par auteur (le `_` est un joker de `LIKE` : échappé). */
export const AUTHOR_DATASET_LIKE = String.raw`\_a:%`;

export function authorDataset(userId: string): string {
  return `${AUTHOR_DATASET_PREFIX}${userId.replace(/-/g, '')}`;
}

/** UUID d'un auteur depuis sa ligne `_a:<32 hexadécimaux>` ; `null` si le nom n'est pas de cette forme. */
export function authorOfDataset(dataset: string): string | null {
  const hex = dataset.slice(AUTHOR_DATASET_PREFIX.length).toLowerCase();
  if (!dataset.startsWith(AUTHOR_DATASET_PREFIX) || !/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
