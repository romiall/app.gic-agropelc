// Utilitaires de test uniquement : génère des UUIDv7 valides et déterministes pour les
// fixtures, sans dépendre de l'aléa réel (cohérent avec la discipline de packages/domain).
import { buildUuidv7 } from '@gic/domain';

let counter = 0;

/** UUIDv7 valide et déterministe, distinct à chaque appel dans un même test. */
export function fixtureUuid(): string {
  counter += 1;
  const bytes = new Uint8Array(10);
  let x = counter;
  for (let i = 0; i < 10; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[i] = x & 0xff;
  }
  return buildUuidv7(Date.parse('2026-09-24T10:00:00.000Z') + counter, bytes);
}

/**
 * Enveloppe de commande brute valide (champs de transport + payload), pour les tests de
 * command-envelope, command-registry et sync-protocol. Les schémas testés sans `payload`
 * (ex. `commandEnvelopeBaseSchema`) ignorent silencieusement ce champ en trop (mode
 * « strip » par défaut de zod), donc un seul bâtisseur suffit pour les trois fichiers.
 */
export function fixtureRawCommandEnvelope(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    command_id: fixtureUuid(),
    device_seq: 1,
    command_type: 'sales.sale.record',
    command_version: 1,
    author_user_id: fixtureUuid(),
    aggregate_type: 'sale',
    aggregate_id: fixtureUuid(),
    base_version: null,
    occurred_at: '2026-09-24T10:00:00.000Z',
    client_created_at: '2026-09-24T10:00:05.000Z',
    captured_offline: false,
    payload: { quantity: 3 },
    ...overrides,
  };
}
