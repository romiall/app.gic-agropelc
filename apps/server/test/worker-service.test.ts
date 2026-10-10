/**
 * Boucle du worker (P0-08, P5-16) : chaque étape d'un tour (ordonnanceur, consommateurs d'événements,
 * file de tâches) est isolée. Une étape qui lève est consignée dans le journal et le tour continue :
 * elle ne prive ni les autres étapes ni les tours suivants, et n'arrête pas le processus (un
 * interblocage ou une erreur persistante de l'ordonnanceur ne doit pas arrêter les consommateurs).
 * Test unitaire : aucun accès à la base, collaborateurs simulés.
 */
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerService } from '../src/worker/worker.service.js';

function build(overrides: {
  readonly enqueueDue?: () => Promise<string[]>;
  readonly processOnce?: (name: string) => Promise<void>;
  readonly claim?: () => Promise<{ claimed: boolean; jobId?: string; result?: string }>;
}) {
  const scheduler = { enqueueDue: vi.fn(overrides.enqueueDue ?? (async () => [])) };
  const eventRunner = { processOnce: vi.fn(overrides.processOnce ?? (async () => undefined)) };
  const consumers = { names: () => ['alpha', 'beta'] };
  const jobRunner = {
    claimAndProcessOne: vi.fn(overrides.claim ?? (async () => ({ claimed: false }))),
  };
  const service = new WorkerService(
    jobRunner as never,
    scheduler as never,
    eventRunner as never,
    consumers as never,
  );
  return { service, scheduler, eventRunner, jobRunner };
}

describe('WorkerService.runOnce — isolation des étapes (P5-16)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('un tour sans échec : ordonnanceur, chaque consommateur, puis les tâches jusqu’à épuisement', async () => {
    const claims = [{ claimed: true, jobId: 'j1', result: 'DONE' }, { claimed: false }];
    const { service, scheduler, eventRunner, jobRunner } = build({
      claim: async () => claims.shift()!,
    });
    await service.runOnce();
    expect(scheduler.enqueueDue).toHaveBeenCalledTimes(1);
    expect(eventRunner.processOnce.mock.calls.map(([name]) => name)).toEqual(['alpha', 'beta']);
    expect(jobRunner.claimAndProcessOne).toHaveBeenCalledTimes(2);
  });

  it('l’ordonnanceur et un consommateur en échec sont journalisés ; les autres étapes tournent quand même', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, eventRunner, jobRunner } = build({
      enqueueDue: async () => {
        throw new Error('ordonnanceur indisponible');
      },
      processOnce: async (name) => {
        if (name === 'alpha') throw new Error('consommateur alpha en échec');
      },
    });
    await expect(service.runOnce()).resolves.toBeUndefined();
    expect(eventRunner.processOnce.mock.calls.map(([name]) => name)).toEqual(['alpha', 'beta']);
    expect(jobRunner.claimAndProcessOne).toHaveBeenCalledTimes(1);
    const messages = logged.mock.calls.map(([message]) => String(message));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('ordonnanceur indisponible');
    expect(messages[1]).toContain('consommateur alpha en échec');
  });

  it('la file de tâches en échec ne fait pas remonter l’erreur : le tour se termine, le suivant reprendra', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service } = build({
      claim: async () => {
        throw new Error('connexion perdue');
      },
    });
    await expect(service.runOnce()).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]![0])).toContain('connexion perdue');
  });
});
