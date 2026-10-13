import { afterEach, describe, expect, it, vi } from 'vitest';
import { login } from './login.js';

const input = { phone: '+237600000000', password: 'secret', deviceId: 'device-1' };

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('login (ECR-ADM-01)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['DEVICE_BLOCKED', 'DEVICE_LOST', 'DEVICE_RETIRED'] as const)(
    '403 %s : motif de l’appareil rendu tel quel (AV-253)',
    async (code) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => reply(403, { error: { code, message: 'Appareil hors service' } })),
      );
      expect(await login(input)).toEqual({ ok: false, reason: code });
    },
  );

  it('403 sans motif connu : réponse inattendue, jamais un motif inventé', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(403, { error: { code: 'FORBIDDEN' } })),
    );
    expect(await login(input)).toEqual({ ok: false, reason: 'UNKNOWN', status: 403 });
  });

  it('200 : jetons, état de l’appareil et code court à afficher pendant l’attente (MP-06)', async () => {
    const body = {
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 900,
      must_change_password: false,
      device_status: 'PENDING',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(200, { ...body, device_short_code: '7KQ2' })),
    );
    expect(await login(input)).toEqual({
      ok: true,
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 900,
      mustChangePassword: false,
      deviceStatus: 'PENDING',
      deviceShortCode: '7KQ2',
    });
    // Serveur antérieur à MP-06 : pas de code, pas de champ inventé.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(200, body)),
    );
    expect(await login(input)).not.toHaveProperty('deviceShortCode');
  });

  it('401 : identifiants invalides, sans lire le corps', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(401, { error: { code: 'INVALID_CREDENTIALS' } })),
    );
    expect(await login(input)).toEqual({ ok: false, reason: 'INVALID_CREDENTIALS' });
  });
});
