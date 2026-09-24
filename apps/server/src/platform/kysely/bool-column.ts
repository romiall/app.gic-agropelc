/** MySQL BOOLEAN = TINYINT(1) : kysely-codegen infère `number`, pas `boolean` (schema.generated.ts). */
export function toDbBool(value: boolean | undefined): 0 | 1 {
  return value ? 1 : 0;
}
