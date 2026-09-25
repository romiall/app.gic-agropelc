import { describe, expect, it } from 'vitest';
import { FixedClock } from './clock.js';

describe('FixedClock (déterminisme des tests, NFR-31)', () => {
  it('renvoie toujours le même instant tant que non modifié', () => {
    const clock = new FixedClock(new Date('2026-09-24T10:00:00.000Z'));
    expect(clock.now().getTime()).toBe(clock.now().getTime());
    expect(clock.now().toISOString()).toBe('2026-09-24T10:00:00.000Z');
  });

  it("renvoie une copie défensive (l'appelant ne peut pas muter l'horloge interne)", () => {
    const clock = new FixedClock(new Date('2026-09-24T10:00:00.000Z'));
    const first = clock.now();
    first.setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  it("advance() avance l'horloge du delta donné (scénarios de synchronisation)", () => {
    const clock = new FixedClock(new Date('2026-09-24T10:00:00.000Z'));
    clock.advance(90_000); // 90 s
    expect(clock.now().toISOString()).toBe('2026-09-24T10:01:30.000Z');
  });

  it("setTo() positionne l'horloge à un instant précis", () => {
    const clock = new FixedClock(new Date(0));
    clock.setTo(new Date('2026-01-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
