/**
 * `POST /api/v1/auth/login` (ECR-ADM-01 : connexion et enrôlement de l'appareil — un
 * appareil neuf est enrôlé `PENDING` par ce même appel, `apps/server/.../auth.controller.ts`
 * « findOrEnrollDevice »). Jamais hors ligne par construction (première connexion sur cet
 * appareil : aucun jeton local à déchiffrer encore).
 */
import { apiUrl } from '../../platform/env.js';

export interface LoginInput {
  readonly phone: string;
  readonly password: string;
  readonly deviceId: string;
}

export type LoginResult =
  | {
      readonly ok: true;
      readonly accessToken: string;
      readonly refreshToken: string;
      readonly expiresIn: number;
      readonly mustChangePassword: boolean;
      readonly deviceStatus: 'PENDING' | 'ACTIVE';
    }
  | { readonly ok: false; readonly reason: 'OFFLINE' }
  | { readonly ok: false; readonly reason: 'INVALID_CREDENTIALS' }
  | { readonly ok: false; readonly reason: 'LOCKED' }
  | { readonly ok: false; readonly reason: 'UNKNOWN'; readonly status: number };

export async function login(input: LoginInput): Promise<LoginResult> {
  let response: Response;
  try {
    response = await fetch(apiUrl('/api/v1/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        phone: input.phone,
        password: input.password,
        device_id: input.deviceId,
        platform: 'PWA',
      }),
    });
  } catch {
    return { ok: false, reason: 'OFFLINE' };
  }

  if (response.status === 401) return { ok: false, reason: 'INVALID_CREDENTIALS' };
  if (response.status === 429) return { ok: false, reason: 'LOCKED' };
  if (!response.ok) return { ok: false, reason: 'UNKNOWN', status: response.status };

  const body = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    must_change_password: boolean;
    device_status: 'PENDING' | 'ACTIVE';
  };
  return {
    ok: true,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
    mustChangePassword: body.must_change_password,
    deviceStatus: body.device_status,
  };
}
