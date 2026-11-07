/**
 * Adaptateur Web Push réel du port `WebPushSender` (AV-365, AV-536 ; ADR-062 §5 ; D13 §14), **sans bibliothèque
 * tierce** : le chiffrement du message est celui de la RFC 8291 (`aes128gcm`, un seul enregistrement) et
 * l'identification du serveur celle de la RFC 8292 (VAPID, jeton ES256), tous deux avec `node:crypto`.
 *
 * - **Désactivé par défaut** : sans les trois variables `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` et `VAPID_SUBJECT`
 *   (ou si l'une est invalide), l'adaptateur par défaut reste `DisabledWebPushSender` et les notifications restent
 *   `IN_APP`. Les clés sont celles du porteur (`pnpm --filter @gic/server vapid:generate`) : jamais écrites dans le
 *   dépôt.
 * - **Contrat du port** (NT-4) : `send` ne lève pas ; 404 et 410 → `GONE` (l'abonnement est révoqué), tout autre
 *   échec → `FAILED` avec un motif sans point de terminaison ; la requête est abandonnée quand le signal est annulé.
 * - **Point de terminaison fourni par le navigateur** : il n'est appelé qu'en `https`, sans identifiants, sur le
 *   port 443, jamais vers `localhost` ni une adresse privée **écrite en clair** dans l'URL, et aucune redirection
 *   n'est suivie. Limite connue (AV-536) : la résolution DNS n'est pas contrôlée, un nom public qui résout vers une
 *   adresse privée passe la garde ; la validation du certificat TLS empêche d'y envoyer le message, pas d'y ouvrir la
 *   connexion. Une défense complète fixerait l'adresse résolue (`lookup` d'un agent HTTPS).
 */
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import type {
  PushMessage,
  PushSendOptions,
  PushSendResult,
  PushTarget,
  WebPushSender,
} from './web-push.js';
import { DisabledWebPushSender } from './web-push.js';

const RECORD_SIZE = 4096;
/** Étiquette de fin d'enregistrement (RFC 8188 §2) : seul enregistrement du message, donc le dernier. */
const LAST_RECORD_DELIMITER = 0x02;
/** En-tête du corps `aes128gcm` : sel (16), taille d'enregistrement (4), longueur d'identifiant (1), clé du serveur (65). */
const BODY_HEADER_BYTES = 16 + 4 + 1 + 65;
/**
 * Plus grande charge utile (RFC 8291 §4, RFC 8030 §7.2) : un service de push accepte au moins 4096 octets de **corps**,
 * en-tête et étiquette GCM compris, soit 4096 − 86 − 16 − 1 = 3993 octets de texte clair. Au-delà, FCM répond 413.
 */
export const MAX_PUSH_PAYLOAD_BYTES = RECORD_SIZE - BODY_HEADER_BYTES - 16 - 1;
/** Validité du jeton VAPID : 12 h (au plus 24 h, RFC 8292 §2). */
const VAPID_TOKEN_SECONDS = 12 * 60 * 60;
/** Durée de conservation du message par le service de push quand l'appareil est éteint. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;

export interface VapidConfig {
  /** Point P-256 non compressé (65 octets), en base64url. */
  readonly publicKey: string;
  /** Scalaire privé P-256 (32 octets), en base64url. */
  readonly privateKey: string;
  /** Contact du serveur d'application : `mailto:` ou `https:` (RFC 8292 §2.1). */
  readonly subject: string;
}

const b64u = (bytes: Buffer): string => bytes.toString('base64url');
const fromB64u = (text: string): Buffer => Buffer.from(text, 'base64url');

/** La configuration est-elle exploitable ? Rend les motifs d'invalidité (aucun n'embarque une clé). */
export function vapidConfigIssues(config: VapidConfig): string[] {
  const issues: string[] = [];
  const pub = fromB64u(config.publicKey);
  const priv = fromB64u(config.privateKey);
  const publicOk = pub.length === 65 && pub[0] === 0x04;
  if (!publicOk) issues.push('VAPID_PUBLIC_KEY : point P-256 non compressé attendu');
  if (priv.length !== 32) issues.push('VAPID_PRIVATE_KEY : 32 octets attendus');
  if (publicOk && priv.length === 32) {
    // Une paire dépareillée serait refusée (403) par tous les services de push : mieux vaut le dire au démarrage.
    try {
      const ecdh = createECDH('prime256v1');
      ecdh.setPrivateKey(priv);
      if (!ecdh.getPublicKey().equals(pub)) {
        issues.push('VAPID_PRIVATE_KEY ne correspond pas à VAPID_PUBLIC_KEY');
      }
    } catch {
      issues.push('VAPID_PRIVATE_KEY : scalaire P-256 invalide');
    }
  }
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(config.subject)) {
    issues.push('VAPID_SUBJECT : « mailto:… » ou « https://… » attendu');
  }
  return issues;
}

function privateKeyOf(config: VapidConfig): KeyObject {
  const pub = fromB64u(config.publicKey);
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: config.privateKey,
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

/** En-tête `Authorization` VAPID pour un point de terminaison (RFC 8292 §3). */
export function vapidAuthorization(
  config: VapidConfig,
  endpoint: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: nowSeconds + VAPID_TOKEN_SECONDS,
        sub: config.subject,
      }),
    ),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: privateKeyOf(config),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${config.publicKey}`;
}

/**
 * Corps `aes128gcm` d'un message Web Push (RFC 8291 §3.4) : en-tête (sel, taille d'enregistrement, clé publique du
 * serveur d'application) puis l'enregistrement chiffré. `appKeys` et `salt` ne servent qu'aux essais (vecteur de la RFC).
 */
export function encryptWebPushPayload(input: {
  readonly uaPublic: Buffer;
  readonly authSecret: Buffer;
  readonly plaintext: Buffer;
  readonly appKeys?: { readonly privateKey: Buffer };
  readonly salt?: Buffer;
}): Buffer {
  if (input.plaintext.length > MAX_PUSH_PAYLOAD_BYTES) {
    throw new RangeError(`Message Web Push trop long (${input.plaintext.length} octets).`);
  }
  const ecdh = createECDH('prime256v1');
  if (input.appKeys) ecdh.setPrivateKey(input.appKeys.privateKey);
  else ecdh.generateKeys();
  const appPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(input.uaPublic);
  const salt = input.salt ?? randomBytes(16);

  // Clé d'entrée : HKDF(sel = secret d'authentification, IKM = secret ECDH, info = « WebPush: info » 0x00 ‖ UA ‖ AS).
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    input.uaPublic,
    appPublic,
  ]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, input.authSecret, keyInfo, 32));
  const contentKey = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12),
  );
  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([input.plaintext, Buffer.from([LAST_RECORD_DELIMITER])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(appPublic.length, 20);
  return Buffer.concat([header, appPublic, encrypted]);
}

const PRIVATE_IPV4 =
  /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|2[3-5]\d\.)/;

/** Le point de terminaison est-il appelable ? `https` seul, sans identifiants, port 443, ni hôte local ni adresse privée. */
export function isSafePushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  if (url.port !== '' && url.port !== '443') return false;
  // Un nom de domaine absolu (point final) désigne le même hôte : « localhost. » ne doit pas passer la garde.
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (
    host === '' ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    return false;
  }
  if (host.endsWith('.internal') || host.endsWith('.lan')) return false;
  // Adresse IPv4 littérale (l'analyse d'URL ramène les écritures décimale, octale et hexadécimale à la forme pointée).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && PRIVATE_IPV4.test(host)) return false;
  if (host.startsWith('[')) {
    // Adresse IPv6 littérale : bouclage, locale de lien, locale unique, IPv4 mappée.
    const bare = host.slice(1, -1);
    if (
      bare === '::1' ||
      bare === '::' ||
      /^(fe[89ab]|f[cd])/.test(bare) ||
      bare.startsWith('::ffff:')
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Clés d'un abonnement de navigateur (RFC 8291 §2.1) : clé publique P-256 non compressée (65 octets) et secret
 * d'authentification (16 octets), en base64url. Contrôlées à l'abonnement (`communication.push.subscribe`, AV-536) comme à
 * l'envoi : des clés d'une autre forme ne serviront jamais.
 */
export function isWellFormedPushKeys(keys: {
  readonly p256dh: string;
  readonly auth: string;
}): boolean {
  const uaPublic = fromB64u(keys.p256dh);
  return uaPublic.length === 65 && uaPublic[0] === 0x04 && fromB64u(keys.auth).length === 16;
}

/** Coupes d'affichage (unités UTF-16) : un téléphone n'affiche que quelques lignes, et trois octets UTF-8 au plus par unité tiennent dans un enregistrement. */
const TITLE_MAX = 120;
const BODY_MAX = 600;
const LINK_MAX = 300;

/** Texte coupé à `max` unités, sans scinder une paire de substitution, avec « … » quand il a été coupé. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/**
 * Charge utile JSON lue par le service worker de la PWA (`title`, `body`, `link`, `alertId`, `alertType`, `tag`).
 * Les textes sont coupés d'abord à des longueurs d'affichage, puis, si l'échappement JSON (un caractère de contrôle prend
 * six octets) fait encore dépasser `MAX_PUSH_PAYLOAD_BYTES`, réduits de moitié jusqu'à tenir : le message part toujours.
 */
export function pushPayload(message: PushMessage): Buffer {
  let title = clip(message.title, TITLE_MAX);
  let body = clip(message.body, BODY_MAX);
  const build = (): Buffer =>
    Buffer.from(
      JSON.stringify({
        title,
        body,
        // Un lien coupé ouvrirait une mauvaise page : trop long, il est omis (l'application s'ouvre à l'accueil).
        link: message.link !== null && message.link.length <= LINK_MAX ? message.link : null,
        alertId: message.alertId,
        alertType: message.alertType,
        tag: message.tag,
      }),
      'utf8',
    );
  let payload = build();
  while (payload.length > MAX_PUSH_PAYLOAD_BYTES && (body.length > 1 || title.length > 1)) {
    if (body.length > 1) body = clip(body, Math.floor(body.length / 2));
    else title = clip(title, Math.floor(title.length / 2));
    payload = build();
  }
  return payload;
}

type FetchLike = (
  url: string,
  init: {
    readonly method: 'POST';
    readonly headers: Record<string, string>;
    readonly body: Buffer;
    /** Jamais de redirection suivie : le point de terminaison est vérifié, pas l'adresse vers laquelle il renverrait. */
    readonly redirect: 'manual';
    readonly signal?: AbortSignal;
  },
) => Promise<{
  readonly status: number;
  readonly ok: boolean;
  /** Corps de la réponse, annulé sans être lu (il ne nous sert à rien et retiendrait la connexion). */
  readonly body?: { cancel(): Promise<void> } | null;
}>;

export class VapidWebPushSender implements WebPushSender {
  readonly enabled = true;

  constructor(
    private readonly config: VapidConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async send(
    target: PushTarget,
    message: PushMessage,
    options?: PushSendOptions,
  ): Promise<PushSendResult> {
    if (!isSafePushEndpoint(target.endpoint))
      return { status: 'FAILED', reason: 'ENDPOINT_REFUSED' };
    if (!isWellFormedPushKeys(target)) {
      // Un abonnement dont les clés ne sont pas celles d'un navigateur ne sera jamais valide : motif distinct.
      return { status: 'FAILED', reason: 'INVALID_SUBSCRIPTION_KEYS' };
    }
    const uaPublic = fromB64u(target.p256dh);
    const authSecret = fromB64u(target.auth);
    let body: Buffer;
    try {
      body = encryptWebPushPayload({ uaPublic, authSecret, plaintext: pushPayload(message) });
    } catch (error) {
      return {
        status: 'FAILED',
        reason: error instanceof RangeError ? 'PAYLOAD_TOO_LARGE' : 'ENCRYPTION_ERROR',
      };
    }
    try {
      const response = await this.fetchImpl(target.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapidAuthorization(this.config, target.endpoint),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(PUSH_TTL_SECONDS),
          // RFC 8030 §5.3 : seules les alertes critiques et leurs escalades sont poussées (BR-NOT-004, « push
          // immédiat ») ; en priorité normale, un téléphone en veille peut retarder leur remise.
          Urgency: 'high',
        },
        body,
        redirect: 'manual',
        ...(options !== undefined ? { signal: options.signal } : {}),
      });
      await response.body?.cancel().catch(() => undefined);
      // Une redirection (3xx) n'est pas suivie : elle sortirait de la garde du point de terminaison (SSRF).
      if (response.status === 404 || response.status === 410) return { status: 'GONE' };
      if (response.ok) return { status: 'SENT' };
      return { status: 'FAILED', reason: `HTTP_${response.status}` };
    } catch {
      // Ni le point de terminaison ni le message de l'erreur (qui peut le citer) ne sortent d'ici.
      return {
        status: 'FAILED',
        reason: options?.signal.aborted === true ? 'ABORTED' : 'NETWORK_ERROR',
      };
    }
  }
}

export interface VapidEnv {
  readonly VAPID_PUBLIC_KEY?: string | undefined;
  readonly VAPID_PRIVATE_KEY?: string | undefined;
  readonly VAPID_SUBJECT?: string | undefined;
}

/** Configuration VAPID de l'environnement, ou `null` (absente ou invalide : le canal reste in-app). */
export function vapidConfigFromEnv(
  env: VapidEnv,
  onInvalid?: (issues: readonly string[]) => void,
): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  const config = { publicKey, privateKey, subject };
  const issues = vapidConfigIssues(config);
  if (issues.length > 0) {
    onInvalid?.(issues);
    return null;
  }
  // Le décodage de Node accepte aussi l'alphabet standard (« + », « / », « = ») : les clés sont rendues sous leur forme
  // canonique base64url, la seule qu'attendent l'en-tête `k=` et `applicationServerKey` de la PWA.
  return {
    publicKey: b64u(fromB64u(publicKey)),
    privateKey: b64u(fromB64u(privateKey)),
    subject,
  };
}

/** L'adaptateur réel quand les clés du porteur sont posées et valides, sinon l'adaptateur désactivé. */
export function webPushSenderFromEnv(
  env: VapidEnv,
  onInvalid?: (issues: readonly string[]) => void,
): WebPushSender {
  const config = vapidConfigFromEnv(env, onInvalid);
  return config === null ? new DisabledWebPushSender() : new VapidWebPushSender(config);
}

/** Paire VAPID neuve (outil du porteur : `vapid:generate`). */
export function generateVapidKeyPair(): {
  readonly publicKey: string;
  readonly privateKey: string;
} {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  // `getPrivateKey` rend le scalaire sans ses zéros de tête (31 octets une fois sur 256) : on le complète à 32.
  const scalar = ecdh.getPrivateKey();
  return {
    publicKey: b64u(ecdh.getPublicKey()),
    privateKey: b64u(Buffer.concat([Buffer.alloc(32 - scalar.length), scalar])),
  };
}
