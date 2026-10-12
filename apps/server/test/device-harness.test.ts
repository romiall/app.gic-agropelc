/**
 * Ajouts de P5-21 au harnais `OfflineDevice`, contre des services de synchronisation simulés (aucune
 * base) : horloge propre à l'appareil, envoi jusqu'au règlement, lecture de la file, effacement local
 * d'un appareil révoqué qui garde sa file, curseur de départ d'un jeu.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { FixedClock } from '@gic/domain';
import type { CommandResult, PushRequest } from '@gic/contracts';
import { OfflineDevice, type DeviceServices } from './device-harness.js';
import { closeTestDb, freshUuid } from './helpers.js';

afterAll(closeTestDb);

const NOW = new Date('2026-10-08T10:00:00.000Z');
const AUTHOR = freshUuid();

interface PullCall {
  readonly dataset: string;
  readonly cursor: number;
}

/** Services simulés : `answer` décide du statut de chaque commande à chaque envoi. */
function simulated(answer: (commandId: string, call: number) => CommandResult['status']) {
  const pushes: PushRequest[] = [];
  const pulls: PullCall[] = [];
  const services = {
    push: {
      push: async (request: PushRequest) => {
        pushes.push(request);
        const call = pushes.length;
        return {
          results: request.commands.map((command) => {
            const status = answer(command.command_id, call);
            return status === 'RETRY_LATER'
              ? {
                  command_id: command.command_id,
                  status,
                  error: { code: 'SERVER_BUSY', message: 'Occupé.' },
                }
              : { command_id: command.command_id, status };
          }),
          server_time: NOW.toISOString(),
          clock_skew_ms: 0,
        };
      },
    },
    pull: {
      pull: async (request: { dataset: string; cursor: number }) => {
        pulls.push({ dataset: request.dataset, cursor: request.cursor });
        return {
          dataset: request.dataset,
          changes: [
            {
              seq: 41,
              dataset: request.dataset,
              entity_type: 'STOCK_BALANCE',
              entity_id: 'x',
              change_type: 'UPSERT',
              data: { qty: 3 },
            },
          ],
          next_cursor: 41,
          has_more: false,
        };
      },
    },
  } as unknown as DeviceServices;
  return { services, pushes, pulls };
}

const spec = (n: number) => ({
  type: 'test.harness.demo',
  aggregateType: 'TEST',
  occurredAt: NOW.toISOString(),
  payload: { n },
});

describe('harnais OfflineDevice : ajouts de P5-21', () => {
  it('horloge de l’appareil : `device_sent_at` suit l’écart, l’horloge fournie reste intacte', async () => {
    const clock = new FixedClock(NOW);
    const { services, pushes } = simulated(() => 'APPLIED');
    const tablet = new OfflineDevice(services, freshUuid(), clock);
    tablet.setClockOffset(2 * 3_600_000);
    expect(tablet.deviceNow().toISOString()).toBe('2026-10-08T12:00:00.000Z');
    expect(clock.now().toISOString()).toBe(NOW.toISOString());
    tablet.enqueue(AUTHOR, spec(1));
    await tablet.sync(AUTHOR);
    expect(pushes[0]!.device_sent_at).toBe('2026-10-08T12:00:00.000Z');
  });

  it('syncUntilSettled relance un `RETRY_LATER` au cycle suivant ; la file garde l’ordre et les réponses', async () => {
    let busy: string | undefined;
    const { services, pushes } = simulated((commandId, call) =>
      call === 1 && commandId === busy ? 'RETRY_LATER' : 'APPLIED',
    );
    const tablet = new OfflineDevice(services, freshUuid(), new FixedClock(NOW));
    tablet.enqueue(AUTHOR, spec(1));
    busy = tablet.enqueue(AUTHOR, spec(2)).command_id;
    tablet.enqueue(AUTHOR, spec(3));

    const results = await tablet.syncUntilSettled(AUTHOR);
    expect(pushes).toHaveLength(2);
    expect(results.map((r) => r.status)).toEqual(['APPLIED', 'RETRY_LATER', 'APPLIED', 'APPLIED']);
    expect(tablet.pending(AUTHOR)).toBe(0);
    const outbox = tablet.outbox();
    expect(outbox.map((q) => q.envelope.device_seq)).toEqual([1, 2, 3]);
    expect(outbox.every((q) => q.settled && q.result?.status === 'APPLIED')).toBe(true);
  });

  it('syncUntilSettled lève si la file ne se règle pas en `maxCycles` cycles', async () => {
    const { services } = simulated(() => 'RETRY_LATER');
    const tablet = new OfflineDevice(services, freshUuid(), new FixedClock(NOW));
    tablet.enqueue(AUTHOR, spec(1));
    await expect(tablet.syncUntilSettled(AUTHOR, { maxCycles: 3 })).rejects.toThrow(
      /non réglée après 3 cycles/,
    );
    expect(tablet.pending(AUTHOR)).toBe(1);
  });

  it('setCursor fixe le départ d’un jeu ; wipeLocal efface données et curseurs, garde la file', async () => {
    const { services, pulls } = simulated(() => 'APPLIED');
    const tablet = new OfflineDevice(services, freshUuid(), new FixedClock(NOW));
    tablet.setCursor('stock', 40);
    await tablet.pullAll('stock', AUTHOR, NOW);
    expect(pulls[0]).toEqual({ dataset: 'stock', cursor: 40 });
    expect(tablet.localProjection.size).toBe(1);
    tablet.enqueue(AUTHOR, spec(1));

    tablet.wipeLocal();
    expect(tablet.localProjection.size).toBe(0);
    expect(tablet.pending(AUTHOR)).toBe(1);
    await tablet.pullAll('stock', AUTHOR, NOW);
    expect(pulls[1]).toEqual({ dataset: 'stock', cursor: 0 });
  });
});
