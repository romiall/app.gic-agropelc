import { describe, expect, it } from 'vitest';
import {
  EVENT_ID_NAMESPACE,
  deterministicEventId,
  uuidV5,
} from '../src/platform/events/deterministic-event-id.js';

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('uuidV5', () => {
  it('rend le vecteur de référence de la RFC 4122 (espace de noms DNS)', () => {
    expect(uuidV5(DNS_NAMESPACE, 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    expect(uuidV5(DNS_NAMESPACE, 'python.org')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });
});

describe('deterministicEventId', () => {
  const OBJECT = '01900000-0000-7000-8000-000000000001';

  it('un UUID v5 valide, toujours le même pour le même fait', () => {
    const id = deterministicEventId('ApprovalRequested', OBJECT);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicEventId('ApprovalRequested', OBJECT)).toBe(id);
    expect(id).toBe(uuidV5(EVENT_ID_NAMESPACE, `ApprovalRequested:${OBJECT}`));
  });

  it('change avec le type de l’événement et avec l’objet', () => {
    const base = deterministicEventId('ApprovalRequested', OBJECT);
    expect(deterministicEventId('ApprovalGranted', OBJECT)).not.toBe(base);
    expect(
      deterministicEventId('ApprovalRequested', '01900000-0000-7000-8000-000000000002'),
    ).not.toBe(base);
  });
});
