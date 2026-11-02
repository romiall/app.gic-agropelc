/** Lecture de saisies numériques des écrans d'administration. */

/** Nombre saisi avec une virgule ou un point décimal ; `null` si vide ou illisible. */
export function parseDecimal(text: string): number | null {
  const cleaned = text.trim().replace(',', '.');
  if (cleaned === '' || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}
