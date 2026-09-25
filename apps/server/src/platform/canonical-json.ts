/**
 * JSON canonique (clés d'objet triées à chaque niveau, aucun espace, ordre des tableaux
 * conservé) : utilisé partout où une empreinte SHA-256 doit être stable quel que soit
 * l'ordre de construction de l'objet source — chaînage d'audit (07-security-rbac/
 * 03-audit.md §5) et `payload_hash` d'une commande (INV-SYN-02).
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
