/** Initiales d'un nom : deux lettres au plus (« Hôtel de la Plage » donne « HD »). */
export function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase());
  return letters.join('') || '?';
}
