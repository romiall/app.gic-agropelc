/**
 * Motifs de refus d'un appareil rendus après un mot de passe juste (AV-253, AV-296). Module à part : l'écran de
 * connexion et le contexte d'authentification les lisent sans dépendre de la requête de connexion.
 */

/** Appareil hors service : ses données téléchargées sont effacées (AV-213). */
export const OUT_OF_SERVICE_REFUSALS = ['DEVICE_BLOCKED', 'DEVICE_LOST', 'DEVICE_RETIRED'] as const;

/** Refus d'appareil ; `DEVICE_BOUND_TO_OTHER_USER` : appareil réservé à un autre compte (AV-296), rien n'est effacé. */
export const DEVICE_REFUSALS = [...OUT_OF_SERVICE_REFUSALS, 'DEVICE_BOUND_TO_OTHER_USER'] as const;
export type DeviceRefusal = (typeof DEVICE_REFUSALS)[number];
