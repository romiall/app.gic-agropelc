/**
 * Port d'envoi Web Push (P9-05 ; ADR-062 §5 ; D13 §14 ; AV-365). Aucune bibliothèque Web Push ni clé VAPID
 * n'est installée : l'adaptateur par défaut est **désactivé** et le dit (`enabled = false`). Les
 * notifications restent alors `IN_APP`, comme D13 §14 le prévoit « sans clé ou sans abonnement valide » ;
 * jamais une notification n'est marquée « envoyée » sans l'avoir été.
 *
 * **Contrat d'un adaptateur réel (NT-4, AV-365)** : `send` ne lève pas (404 et 410 → `GONE`, tout autre
 * échec → `FAILED` avec un motif sans point de terminaison) et abandonne sa requête quand
 * `options.signal` est annulé. Le répartiteur ne s'y fie pas : il enveloppe chaque envoi (exception,
 * silence au-delà du délai) ; un disjoncteur par hôte de service de push relève de l'adaptateur.
 */

/** Jeton d'injection ; remplacé par un adaptateur réel quand le porteur a tranché AV-365. */
export const WEB_PUSH_SENDER = Symbol('WEB_PUSH_SENDER');

export interface PushTarget {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface PushMessage {
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly alertId: string | null;
  readonly alertType: string | null;
  /** Étiquette de remplacement côté navigateur : un push d'alerte remplace le précédent du même type. */
  readonly tag: string;
}

export type PushSendResult =
  | { readonly status: 'SENT' }
  /** Le service de push répond que l'abonnement n'existe plus (410) : il doit être révoqué. */
  | { readonly status: 'GONE' }
  | { readonly status: 'FAILED'; readonly reason: string };

/** Options d'un envoi : le signal est annulé quand le répartiteur n'attend plus la réponse. */
export interface PushSendOptions {
  readonly signal: AbortSignal;
}

export interface WebPushSender {
  /** Faux : aucune notification `WEB_PUSH` n'est créée (le canal in-app suffit). */
  readonly enabled: boolean;
  /**
   * Envoie un push. Contrat : ne lève pas, rend `GONE` pour 404 et 410, `FAILED` pour tout autre échec, et
   * abandonne la requête quand `options.signal` est annulé (NT-4).
   */
  send(
    target: PushTarget,
    message: PushMessage,
    options?: PushSendOptions,
  ): Promise<PushSendResult>;
}

/** Adaptateur par défaut : aucun envoi réel n'est possible sans clé ni bibliothèque. */
export class DisabledWebPushSender implements WebPushSender {
  readonly enabled = false;

  async send(): Promise<PushSendResult> {
    return { status: 'FAILED', reason: 'WEB_PUSH_DISABLED' };
  }
}
