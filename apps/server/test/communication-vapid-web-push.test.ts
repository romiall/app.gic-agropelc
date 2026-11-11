/**
 * Adaptateur Web Push réel (AV-365, AV-536) — sans base : calcul pur et un serveur HTTP local.
 *
 * - **Chiffrement (RFC 8291)** : l'exemple de l'annexe A de la RFC (entrées fixes, valeurs intermédiaires et corps
 *   attendus octet pour octet : la seule preuve d'interopérabilité avec les navigateurs qu'on peut avoir hors d'un
 *   téléphone), puis l'aller-retour avec un déchiffrement écrit côté appareil sur des clés tirées au hasard.
 * - **Jeton VAPID (RFC 8292)** : en-tête, revendications et signature ES256 vérifiées avec la clé publique.
 * - Garde du point de terminaison (aucune requête vers le réseau interne), mappage 404 et 410 → `GONE`, aucun point
 *   de terminaison dans les motifs d'échec, coupe des textes longs, configuration (absente, partielle,
 *   dépareillée, valide), requête réelle (`fetch`) vers un serveur HTTP local.
 */
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  encryptWebPushPayload,
  generateVapidKeyPair,
  isSafePushEndpoint,
  MAX_PUSH_PAYLOAD_BYTES,
  pushPayload,
  vapidAuthorization,
  vapidConfigFromEnv,
  vapidConfigIssues,
  VapidWebPushSender,
  webPushSenderFromEnv,
  type VapidConfig,
} from '../src/modules/communication/application/notifications/vapid-web-push.js';
import {
  DisabledWebPushSender,
  type PushMessage,
  type PushTarget,
} from '../src/modules/communication/application/notifications/web-push.js';

const b64 = (text: string): Buffer => Buffer.from(text, 'base64url');
const enc = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), length));

interface UserAgent {
  readonly privateKey: Buffer;
  readonly publicKey: Buffer;
  readonly authSecret: Buffer;
}

function newUserAgent(): UserAgent {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey(),
    publicKey: ecdh.getPublicKey(),
    authSecret: randomBytes(16),
  };
}

const targetOf = (ua: UserAgent, endpoint = 'https://push.example.org/send/abc'): PushTarget => ({
  endpoint,
  p256dh: enc(ua.publicKey),
  auth: enc(ua.authSecret),
});

/** Côté appareil (RFC 8291 §3.4), écrit à part de l'adaptateur : ouvre un corps `aes128gcm`. */
function openWebPushBody(body: Buffer, ua: UserAgent): Buffer {
  const salt = body.subarray(0, 16);
  expect(body.readUInt32BE(16)).toBe(4096);
  const idLength = body.readUInt8(20);
  expect(idLength).toBe(65);
  const appPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(ua.privateKey);
  const shared = ecdh.computeSecret(appPublic);
  const ikm = Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      ua.authSecret,
      Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), ua.publicKey, appPublic]),
      32,
    ),
  );
  const decipher = createDecipheriv(
    'aes-128-gcm',
    hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16),
    hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12),
  );
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ]);
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end -= 1;
  expect(padded[end - 1]).toBe(0x02);
  return padded.subarray(0, end - 1);
}

const message: PushMessage = {
  title: 'Perte anormale',
  body: 'Site de Bonabéri : 12 têtes perdues',
  link: '/alertes/0198c3a0-1111-7aaa-8bbb-000000000001',
  alertId: '0198c3a0-1111-7aaa-8bbb-000000000001',
  alertType: 'HIGH_LOSS',
  tag: 'alert:HIGH_LOSS',
};

function newConfig(): VapidConfig {
  return { ...generateVapidKeyPair(), subject: 'mailto:porteur@example.org' };
}

/** Vérifie l'en-tête `Authorization` VAPID (RFC 8292 §3) et rend ses revendications. */
function verifyVapidHeader(
  header: string,
  config: VapidConfig,
): { aud: string; exp: number; sub: string } {
  const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  expect(match, header).not.toBeNull();
  const [, head, claimsPart, signature, key] = match!;
  expect(key).toBe(config.publicKey);
  expect(JSON.parse(b64(head!).toString('utf8'))).toEqual({ typ: 'JWT', alg: 'ES256' });
  const publicBytes = b64(config.publicKey);
  const publicKey = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: enc(publicBytes.subarray(1, 33)),
      y: enc(publicBytes.subarray(33, 65)),
    },
    format: 'jwk',
  });
  expect(
    verify(
      'sha256',
      Buffer.from(`${head}.${claimsPart}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      b64(signature!),
    ),
  ).toBe(true);
  return JSON.parse(b64(claimsPart!).toString('utf8'));
}

describe('chiffrement du message (RFC 8291)', () => {
  // Annexe A de la RFC 8291 : « When I grow up, I want to be a watermelon ».
  const RFC = {
    plaintext: 'When I grow up, I want to be a watermelon',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    asPublic:
      'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    uaPublic:
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
    ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
    cek: 'oIhVW04MRdy2XN9CiKLxTg',
    nonce: '4h_95klXJ5E_qnoN',
    // En-tête (sel, taille d'enregistrement, clé du serveur d'application) et enregistrement chiffré, chacun
    // codé à part : leur concaténation en base64url n'est pas celle des octets (86 octets d'en-tête).
    header:
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    record: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  };

  it('valeurs intermédiaires de l’exemple de la RFC : secret ECDH, IKM, clé et nonce', () => {
    const ua = createECDH('prime256v1');
    ua.setPrivateKey(b64(RFC.uaPrivate));
    expect(enc(ua.getPublicKey())).toBe(RFC.uaPublic);
    const shared = ua.computeSecret(b64(RFC.asPublic));
    expect(enc(shared)).toBe(RFC.ecdhSecret);
    const keyInfo = Buffer.concat([
      Buffer.from('WebPush: info\0', 'utf8'),
      b64(RFC.uaPublic),
      b64(RFC.asPublic),
    ]);
    const ikm = Buffer.from(hkdfSync('sha256', shared, b64(RFC.auth), keyInfo, 32));
    expect(enc(ikm)).toBe(RFC.ikm);
    expect(enc(hkdf(ikm, b64(RFC.salt), 'Content-Encoding: aes128gcm\0', 16))).toBe(RFC.cek);
    expect(enc(hkdf(ikm, b64(RFC.salt), 'Content-Encoding: nonce\0', 12))).toBe(RFC.nonce);
  });

  it('l’adaptateur produit exactement le corps de l’exemple de la RFC', () => {
    const body = encryptWebPushPayload({
      uaPublic: b64(RFC.uaPublic),
      authSecret: b64(RFC.auth),
      plaintext: Buffer.from(RFC.plaintext, 'utf8'),
      appKeys: { privateKey: b64(RFC.asPrivate) },
      salt: b64(RFC.salt),
    });
    expect(body.length).toBe(86 + 58);
    expect(enc(body.subarray(0, 86))).toBe(RFC.header);
    expect(enc(body.subarray(86))).toBe(RFC.record);
  });

  it('aller-retour : l’appareil rouvre ce que le serveur chiffre, avec un sel et des clés neufs à chaque message', () => {
    const ua = newUserAgent();
    const plaintext = Buffer.from(JSON.stringify({ title: 'é'.repeat(50), n: 1 }), 'utf8');
    const first = encryptWebPushPayload({
      uaPublic: ua.publicKey,
      authSecret: ua.authSecret,
      plaintext,
    });
    const second = encryptWebPushPayload({
      uaPublic: ua.publicKey,
      authSecret: ua.authSecret,
      plaintext,
    });
    expect(openWebPushBody(first, ua)).toEqual(plaintext);
    expect(openWebPushBody(second, ua)).toEqual(plaintext);
    // Sel et clé publique du serveur d’application tirés à chaque message.
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false);
    expect(first.subarray(21, 86).equals(second.subarray(21, 86))).toBe(false);
    // Taille : en-tête 86 + texte + délimiteur 1 + étiquette GCM 16.
    expect(first.length).toBe(86 + plaintext.length + 1 + 16);
  });

  it('une charge utile trop longue pour un seul enregistrement lève RangeError', () => {
    const ua = newUserAgent();
    const encrypt = (size: number) =>
      encryptWebPushPayload({
        uaPublic: ua.publicKey,
        authSecret: ua.authSecret,
        plaintext: Buffer.alloc(size, 0x61),
      });
    expect(encrypt(MAX_PUSH_PAYLOAD_BYTES)).toBeInstanceOf(Buffer);
    expect(() => encrypt(MAX_PUSH_PAYLOAD_BYTES + 1)).toThrow(RangeError);
  });
});

describe('jeton VAPID (RFC 8292)', () => {
  it('en-tête, revendications (origine du service de push, 12 h, contact) et signature ES256 vérifiées', () => {
    const config = newConfig();
    const now = 1_790_000_000;
    const claims = verifyVapidHeader(
      vapidAuthorization(config, 'https://updates.push.services.mozilla.com/wpush/v2/abc', now),
      config,
    );
    expect(claims).toEqual({
      aud: 'https://updates.push.services.mozilla.com',
      exp: now + 12 * 3600,
      sub: 'mailto:porteur@example.org',
    });
  });

  it('une signature d’une autre paire n’est pas acceptée', () => {
    const config = newConfig();
    const other = { ...newConfig(), publicKey: config.publicKey };
    expect(() =>
      verifyVapidHeader(vapidAuthorization(other, 'https://fcm.googleapis.com/fcm/send/x'), config),
    ).toThrow();
  });
});

describe('configuration VAPID', () => {
  it('une paire générée est valide ; les motifs d’invalidité ne contiennent jamais une clé', () => {
    const config = newConfig();
    expect(vapidConfigIssues(config)).toEqual([]);
    expect(b64(config.publicKey)).toHaveLength(65);
    expect(b64(config.privateKey)).toHaveLength(32);

    const mismatched = { ...config, privateKey: generateVapidKeyPair().privateKey };
    expect(vapidConfigIssues(mismatched)).toEqual([
      'VAPID_PRIVATE_KEY ne correspond pas à VAPID_PUBLIC_KEY',
    ]);
    expect(vapidConfigIssues({ ...config, privateKey: enc(randomBytes(31)) })).toEqual([
      'VAPID_PRIVATE_KEY : 32 octets attendus',
    ]);
    const compressed = createECDH('prime256v1');
    compressed.generateKeys();
    expect(
      vapidConfigIssues({ ...config, publicKey: enc(compressed.getPublicKey(null, 'compressed')) }),
    ).toEqual(['VAPID_PUBLIC_KEY : point P-256 non compressé attendu']);
    for (const subject of ['porteur@example.org', 'http://example.org', 'mailto:', '']) {
      expect(vapidConfigIssues({ ...config, subject })).toEqual([
        'VAPID_SUBJECT : « mailto:… » ou « https://… » attendu',
      ]);
    }
    for (const subject of ['mailto:a@b.cm', 'https://gic-agropelc.com/contact']) {
      expect(vapidConfigIssues({ ...config, subject })).toEqual([]);
    }
    for (const issue of [...vapidConfigIssues(mismatched)]) {
      expect(issue).not.toContain(config.privateKey);
      expect(issue).not.toContain(mismatched.privateKey);
    }
  });

  it('absente ou partielle : désactivée sans bruit ; invalide : désactivée et signalée ; valide : activée', () => {
    const config = newConfig();
    const reported: string[][] = [];
    const onInvalid = (issues: readonly string[]) => reported.push([...issues]);
    const fromEnv = (env: Parameters<typeof webPushSenderFromEnv>[0]) =>
      webPushSenderFromEnv(env, onInvalid);

    for (const env of [
      {},
      { VAPID_PUBLIC_KEY: config.publicKey },
      { VAPID_PUBLIC_KEY: config.publicKey, VAPID_PRIVATE_KEY: config.privateKey },
      {
        VAPID_PUBLIC_KEY: '  ',
        VAPID_PRIVATE_KEY: config.privateKey,
        VAPID_SUBJECT: config.subject,
      },
    ]) {
      const sender = fromEnv(env);
      expect(sender).toBeInstanceOf(DisabledWebPushSender);
      expect(sender.enabled).toBe(false);
    }
    expect(reported).toEqual([]);

    const invalid = fromEnv({
      VAPID_PUBLIC_KEY: config.publicKey,
      VAPID_PRIVATE_KEY: enc(randomBytes(32)),
      VAPID_SUBJECT: config.subject,
    });
    expect(invalid.enabled).toBe(false);
    expect(reported).toHaveLength(1);

    const valid = fromEnv({
      VAPID_PUBLIC_KEY: ` ${config.publicKey} `,
      VAPID_PRIVATE_KEY: config.privateKey,
      VAPID_SUBJECT: config.subject,
    });
    expect(valid).toBeInstanceOf(VapidWebPushSender);
    expect(valid.enabled).toBe(true);
    expect(reported).toHaveLength(1);
    expect(
      vapidConfigFromEnv({
        VAPID_PUBLIC_KEY: ` ${config.publicKey} `,
        VAPID_PRIVATE_KEY: config.privateKey,
        VAPID_SUBJECT: config.subject,
      }),
    ).toEqual(config);

    // Paire collée en base64 standard (« + », « / », « = ») : rendue sous la forme canonique base64url, celle que
    // l’en-tête `k=` et la PWA attendent.
    const standard = (text: string): string => {
      const swapped = text.replace(/-/g, '+').replace(/_/g, '/');
      return swapped + '='.repeat((4 - (swapped.length % 4)) % 4);
    };
    expect(
      vapidConfigFromEnv({
        VAPID_PUBLIC_KEY: standard(config.publicKey),
        VAPID_PRIVATE_KEY: standard(config.privateKey),
        VAPID_SUBJECT: config.subject,
      }),
    ).toEqual(config);
  });
});

describe('garde du point de terminaison', () => {
  it('seuls les services de push en https sont appelés : ni réseau interne, ni identifiants, ni port étranger', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/xyz',
      'https://web.push.apple.com/QFgz',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
      'https://example.com:443/push',
      'https://10.example.com/push',
    ]) {
      expect(isSafePushEndpoint(endpoint), endpoint).toBe(true);
    }
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'ftp://fcm.googleapis.com/x',
      'https://user:secret@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://localhost/x',
      'https://LOCALHOST/x',
      'https://localhost./x',
      'https://printer.local./x',
      'https://app.localhost/x',
      'https://printer.local/x',
      'https://intranet.internal/x',
      'https://nas.lan/x',
      'https://127.0.0.1/x',
      'https://2130706433/x',
      'https://0x7f.1/x',
      'https://0.0.0.0/x',
      'https://10.0.0.5/x',
      'https://172.16.0.1/x',
      'https://172.31.255.255/x',
      'https://192.168.1.10/x',
      'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/x',
      'https://224.0.0.1/x',
      'https://255.255.255.255/x',
      'https://[::1]/x',
      'https://[fe80::1]/x',
      'https://[fd00::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'pas une url',
      '',
    ]) {
      expect(isSafePushEndpoint(endpoint), endpoint).toBe(false);
    }
  });
});

describe('charge utile du message', () => {
  it('les textes longs sont coupés sans scinder une paire de substitution et tiennent toujours dans un enregistrement', () => {
    const long = pushPayload({
      ...message,
      title: 'é'.repeat(500),
      body: '世'.repeat(5000),
      link: `/${'a'.repeat(400)}`,
    });
    const parsed = JSON.parse(long.toString('utf8')) as PushMessage;
    expect(parsed.title).toHaveLength(120);
    expect(parsed.title.endsWith('…')).toBe(true);
    expect(parsed.body).toHaveLength(600);
    expect(parsed.body.endsWith('…')).toBe(true);
    expect(parsed.link).toBeNull();
    expect(long.length).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);

    // Une paire de substitution n’est pas coupée en deux : 400 émojis (800 unités) coupés à 600 → 299 entiers.
    const emojis = JSON.parse(
      pushPayload({ ...message, body: '😀'.repeat(400) }).toString('utf8'),
    ) as PushMessage;
    expect(emojis.body).toBe(`${'😀'.repeat(299)}…`);

    const short = JSON.parse(pushPayload(message).toString('utf8')) as PushMessage;
    expect(short).toEqual(message);
  });

  it('la borne est celle de la RFC 8291 (3993 octets) et un texte pathologique tient encore : l’échappement JSON d’un caractère de contrôle prend six octets', () => {
    expect(MAX_PUSH_PAYLOAD_BYTES).toBe(3993);
    const pathological = pushPayload({
      ...message,
      title: '\u0001'.repeat(500),
      body: '\u0001'.repeat(5000),
    });
    expect(pathological.length).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
    const parsed = JSON.parse(pathological.toString('utf8')) as PushMessage;
    expect(parsed.alertId).toBe(message.alertId);
    expect(parsed.tag).toBe(message.tag);
    expect(parsed.body.length).toBeGreaterThan(0);
    // Le corps complet (en-tête de 86 octets, étiquette GCM, délimiteur) tient dans les 4096 octets garantis.
    const ua = newUserAgent();
    const body = encryptWebPushPayload({
      uaPublic: ua.publicKey,
      authSecret: ua.authSecret,
      plaintext: pathological,
    });
    expect(body.length).toBeLessThanOrEqual(4096);
  });
});

function recordingFetch(outcome: number | Error) {
  const calls: {
    url: string;
    headers: Record<string, string>;
    body: Buffer;
    redirect: string;
    signal: AbortSignal | undefined;
  }[] = [];
  const state = { cancelled: 0 };
  const fn = async (
    url: string,
    init: {
      headers: Record<string, string>;
      body: Buffer;
      redirect: string;
      signal?: AbortSignal;
    },
  ) => {
    calls.push({
      url,
      headers: init.headers,
      body: init.body,
      redirect: init.redirect,
      signal: init.signal,
    });
    if (outcome instanceof Error) throw outcome;
    return {
      status: outcome,
      ok: outcome >= 200 && outcome < 300,
      body: {
        cancel: async () => {
          state.cancelled += 1;
        },
      },
    };
  };
  return { calls, fn, state };
}

describe('VapidWebPushSender', () => {
  const options = () => ({ signal: new AbortController().signal });

  it('envoi accepté (200, 201) : un POST chiffré, avec l’en-tête VAPID, la durée de vie et le codage', async () => {
    const ua = newUserAgent();
    const config = newConfig();
    for (const status of [200, 201]) {
      const http = recordingFetch(status);
      const sender = new VapidWebPushSender(config, http.fn);
      const signal = new AbortController().signal;
      expect(sender.enabled).toBe(true);
      expect(await sender.send(targetOf(ua), message, { signal })).toEqual({ status: 'SENT' });
      expect(http.calls).toHaveLength(1);
      const [call] = http.calls;
      expect(call!.url).toBe('https://push.example.org/send/abc');
      expect(call!.signal).toBe(signal);
      // Aucune redirection suivie (SSRF) ; le corps de la réponse est annulé sans être lu.
      expect(call!.redirect).toBe('manual');
      expect(http.state.cancelled).toBe(1);
      expect(call!.headers).toMatchObject({
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'high',
      });
      expect(verifyVapidHeader(call!.headers.Authorization!, config).aud).toBe(
        'https://push.example.org',
      );
      expect(JSON.parse(openWebPushBody(call!.body, ua).toString('utf8'))).toEqual(message);
    }
  });

  it('404 et 410 : l’abonnement a disparu (GONE) ; les autres refus : échec avec le code HTTP seul', async () => {
    const ua = newUserAgent();
    const config = newConfig();
    for (const status of [404, 410]) {
      const sender = new VapidWebPushSender(config, recordingFetch(status).fn);
      expect(await sender.send(targetOf(ua), message, options())).toEqual({ status: 'GONE' });
    }
    for (const status of [400, 401, 403, 413, 429, 500, 503]) {
      const sender = new VapidWebPushSender(config, recordingFetch(status).fn);
      expect(await sender.send(targetOf(ua), message, options())).toEqual({
        status: 'FAILED',
        reason: `HTTP_${status}`,
      });
    }
  });

  it('erreur réseau ou annulation : échec sans jamais lever, sans point de terminaison dans le motif', async () => {
    const ua = newUserAgent();
    const config = newConfig();
    const secret = 'https://secret-push-host.example.org/send/token-123';
    const failing = new VapidWebPushSender(
      config,
      recordingFetch(new Error(`connect ECONNREFUSED ${secret}`)).fn,
    );
    const network = await failing.send(targetOf(ua, secret), message, options());
    expect(network).toEqual({ status: 'FAILED', reason: 'NETWORK_ERROR' });
    expect(JSON.stringify(network)).not.toContain('secret-push-host');

    const controller = new AbortController();
    controller.abort();
    expect(
      await failing.send(targetOf(ua, secret), message, { signal: controller.signal }),
    ).toEqual({
      status: 'FAILED',
      reason: 'ABORTED',
    });
  });

  it('point de terminaison refusé ou clés d’abonnement invalides : aucune requête, échec nommé', async () => {
    const ua = newUserAgent();
    const http = recordingFetch(201);
    const sender = new VapidWebPushSender(newConfig(), http.fn);
    for (const endpoint of [
      'http://fcm.googleapis.com/x',
      'https://169.254.169.254/x',
      'https://localhost/x',
    ]) {
      expect(await sender.send(targetOf(ua, endpoint), message, options())).toEqual({
        status: 'FAILED',
        reason: 'ENDPOINT_REFUSED',
      });
    }
    for (const bad of [
      { ...targetOf(ua), p256dh: 'BPk' },
      { ...targetOf(ua), p256dh: enc(randomBytes(65)).replace(/^./, 'A') },
      { ...targetOf(ua), auth: 'sec' },
      { ...targetOf(ua), auth: enc(randomBytes(32)) },
    ]) {
      expect(await sender.send(bad, message, options())).toEqual({
        status: 'FAILED',
        reason: 'INVALID_SUBSCRIPTION_KEYS',
      });
    }
    // Un point qui a la forme d’une clé P-256 sans en être une : chiffrement impossible, échec nommé.
    const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0x01)]);
    expect(
      await sender.send({ ...targetOf(ua), p256dh: enc(offCurve) }, message, options()),
    ).toEqual({ status: 'FAILED', reason: 'ENCRYPTION_ERROR' });
    expect(http.calls).toHaveLength(0);
  });

  it('requête réelle (fetch) vers un serveur HTTP local : en-têtes et corps tels que le service de push les reçoit', async () => {
    const ua = newUserAgent();
    const config = newConfig();
    const received: { path: string | undefined; headers: IncomingHttpHeaders; body: Buffer }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          path: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks),
        });
        response.writeHead(201).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // Le garde interdit le réseau local : la requête réelle est réorientée vers le serveur d’essai.
      const sender = new VapidWebPushSender(config, (url, init) =>
        fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init),
      );
      const result = await sender.send(
        targetOf(ua, 'https://push.example.org/wpush/v2/abc'),
        message,
        options(),
      );
      expect(result).toEqual({ status: 'SENT' });
      expect(received).toHaveLength(1);
      const [request] = received;
      expect(request!.path).toBe('/wpush/v2/abc');
      expect(request!.headers['content-encoding']).toBe('aes128gcm');
      expect(request!.headers['content-type']).toBe('application/octet-stream');
      expect(request!.headers.ttl).toBe('86400');
      expect(request!.headers.urgency).toBe('high');
      const claims = verifyVapidHeader(request!.headers.authorization!, config);
      expect(claims.aud).toBe('https://push.example.org');
      const nowSeconds = Math.floor(Date.now() / 1000);
      expect(claims.exp).toBeGreaterThan(nowSeconds + 11 * 3600);
      expect(claims.exp).toBeLessThanOrEqual(nowSeconds + 12 * 3600);
      expect(request!.body.length).toBe(Number(request!.headers['content-length']));
      expect(JSON.parse(openWebPushBody(request!.body, ua).toString('utf8'))).toEqual(message);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('une redirection du service de push n’est jamais suivie : échec HTTP_302 et aucune seconde requête (SSRF)', async () => {
    const ua = newUserAgent();
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? '');
      request.resume();
      request.on('end', () => {
        if (request.url === '/wpush/v2/redirect') {
          const { port: serverPort } = server.address() as AddressInfo;
          response.writeHead(302, { Location: `http://127.0.0.1:${serverPort}/internal` }).end();
        } else {
          response.writeHead(201).end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const sender = new VapidWebPushSender(newConfig(), (url, init) =>
        fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init),
      );
      expect(
        await sender.send(
          targetOf(ua, 'https://push.example.org/wpush/v2/redirect'),
          message,
          options(),
        ),
      ).toEqual({ status: 'FAILED', reason: 'HTTP_302' });
      expect(paths).toEqual(['/wpush/v2/redirect']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
