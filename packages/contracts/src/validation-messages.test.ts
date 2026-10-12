import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeIssueFr, describeIssuesFr } from './validation-messages.js';

function issuesOf(schema: z.ZodTypeAny, value: unknown): z.ZodIssue[] {
  const parsed = schema.safeParse(value);
  if (parsed.success) throw new Error('valeur acceptée');
  return parsed.error.issues;
}

describe('describeIssueFr (S-37)', () => {
  const supplier = z.object({
    code: z.string().min(1).max(40),
    email: z.string().email().optional(),
    paymentTermsDays: z.number().int().nonnegative().max(3650).optional(),
    kind: z.enum(['A', 'B']).optional(),
    id: z.string().uuid().optional(),
    at: z.string().datetime().optional(),
    lines: z.array(z.string()).min(1).optional(),
  });

  it('champ obligatoire, texte vide, longueur maximale', () => {
    expect(describeIssueFr(issuesOf(supplier, {})[0]!)).toBe('« code » : champ obligatoire.');
    expect(describeIssueFr(issuesOf(supplier, { code: '' })[0]!)).toBe('« code » : texte vide.');
    expect(describeIssueFr(issuesOf(supplier, { code: 'x'.repeat(41) })[0]!)).toBe(
      '« code » : au plus 40 caractères.',
    );
  });

  it('courriel, identifiant, date et heure, valeur inconnue', () => {
    expect(describeIssueFr(issuesOf(supplier, { code: 'F', email: 'abc' })[0]!)).toBe(
      '« email » : adresse électronique invalide.',
    );
    expect(describeIssueFr(issuesOf(supplier, { code: 'F', id: '12' })[0]!)).toBe(
      '« id » : identifiant invalide (UUID attendu).',
    );
    expect(describeIssueFr(issuesOf(supplier, { code: 'F', at: 'hier' })[0]!)).toContain(
      'date et heure invalides',
    );
    expect(describeIssueFr(issuesOf(supplier, { code: 'F', kind: 'C' })[0]!)).toBe(
      '« kind » : valeur inconnue « C » (attendu : A, B).',
    );
  });

  it('bornes numériques, entier, type', () => {
    expect(describeIssueFr(issuesOf(supplier, { code: 'F', paymentTermsDays: 40000 })[0]!)).toBe(
      '« paymentTermsDays » : valeur trop grande (au plus 3650).',
    );
    expect(describeIssueFr(issuesOf(supplier, { code: 'F', paymentTermsDays: -1 })[0]!)).toBe(
      '« paymentTermsDays » : valeur trop petite (au moins 0).',
    );
    expect(describeIssueFr(issuesOf(supplier, { code: 'F', paymentTermsDays: 1.5 })[0]!)).toBe(
      '« paymentTermsDays » : nombre entier attendu.',
    );
    expect(describeIssueFr(issuesOf(supplier, { code: 7 })[0]!)).toBe(
      '« code » : un texte attendu, un nombre reçu.',
    );
    expect(describeIssueFr(issuesOf(z.number().positive(), 0)[0]!)).toBe(
      'valeur trop petite (strictement plus de 0).',
    );
    expect(describeIssueFr(issuesOf(supplier, { code: 'F', lines: [] })[0]!)).toBe(
      '« lines » : au moins 1 élément(s).',
    );
  });

  it('un constat personnalisé garde son message français, précédé du champ', () => {
    const schema = z.object({ q: z.number() }).superRefine((data, ctx) => {
      if (data.q > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Quantité refusée.' });
      if (data.q > 2) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['q'], message: 'Trop grande.' });
      }
    });
    expect(describeIssuesFr(issuesOf(schema, { q: 3 }))).toBe(
      'Quantité refusée. ; « q » : Trop grande.',
    );
  });
});
