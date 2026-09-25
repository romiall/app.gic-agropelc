import { describe, expect, it } from 'vitest';
import { FixedClock } from './clock.js';
import { Uuidv7Generator } from './uuidv7-generator.js';
import { extractUuidv7Timestamp, isUuidv7 } from './uuid.js';

describe('Uuidv7Generator', () => {
  it("génère un UUIDv7 valide horodaté par l'horloge injectée", () => {
    const clock = new FixedClock(new Date('2026-09-24T12:00:00.000Z'));
    const generator = new Uuidv7Generator(clock);
    const id = generator.newId();
    expect(isUuidv7(id)).toBe(true);
    expect(extractUuidv7Timestamp(id)?.toISOString()).toBe('2026-09-24T12:00:00.000Z');
  });

  it('deux appels successifs produisent des identifiants distincts', () => {
    const generator = new Uuidv7Generator(new FixedClock(new Date()));
    const a = generator.newId();
    const b = generator.newId();
    expect(a).not.toBe(b);
  });
});
