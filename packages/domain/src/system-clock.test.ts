import { describe, expect, it } from 'vitest';
import { SystemClock } from './system-clock.js';

describe('SystemClock', () => {
  it("renvoie un instant proche de l'heure système réelle", () => {
    const before = Date.now();
    const value = new SystemClock().now().getTime();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });
});
