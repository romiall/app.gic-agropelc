/** Assemble des noms de classes en ignorant les valeurs vides (`false`, `null`, `undefined`, `''`). */
export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
