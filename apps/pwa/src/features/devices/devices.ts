/**
 * ECR-ADM-05 « Appareils » (MP-06 ; SM-DEVICE ; BR-ADM-025) : logique pure de l'écran.
 *
 * - Liste lue sur `GET /devices` : le serveur ne rend que les appareils de la portée du lecteur et, pour
 *   chacun, les actions qu'il peut y faire (`actions`, AV-258 compris). L'écran croise ces droits avec les
 *   transitions de SM-DEVICE pour ne proposer que des décisions possibles ; le serveur revérifie tout.
 * - Commandes `identity.device.*` (agrégat `DEVICE`, identifiant de l'appareil) ; motif obligatoire pour
 *   bloquer ou refuser, facultatif pour déclarer perdu ou retirer (500 caractères au plus).
 */

export const DEVICE_STATUSES = ['PENDING', 'ACTIVE', 'BLOCKED', 'LOST', 'RETIRED'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/** Appareil renvoyé par `GET /api/v1/devices`. */
export interface DeviceView {
  readonly id: string;
  readonly shortCode: string;
  readonly label: string | null;
  readonly status: DeviceStatus;
  readonly statusReason: string | null;
  readonly statusChangedAt: string | null;
  readonly platform: string | null;
  readonly appVersion: string | null;
  readonly isShared: boolean;
  readonly designatedSiteId: string | null;
  readonly enrolledByUserId: string;
  readonly enrolledByName: string | null;
  readonly createdAt: string;
  readonly lastContactAt: string | null;
  readonly stale: boolean;
  readonly actions: {
    readonly approve: boolean;
    readonly block: boolean;
    readonly unblock: boolean;
    readonly designate: boolean;
  };
}

export type DeviceFilter = 'PENDING' | 'ACTIVE' | 'BLOCKED' | 'ALL';
export const DEVICE_FILTERS: readonly DeviceFilter[] = ['PENDING', 'ACTIVE', 'BLOCKED', 'ALL'];

export type DeviceAction =
  'APPROVE' | 'REFUSE' | 'BLOCK' | 'UNBLOCK' | 'LOST' | 'RETIRE' | 'DESIGNATE';

/** Décisions proposées pour un appareil : transitions de SM-DEVICE permises au lecteur. */
export function actionsFor(device: DeviceView): DeviceAction[] {
  const can = device.actions;
  switch (device.status) {
    case 'PENDING':
      return [
        ...(can.approve ? (['APPROVE'] as const) : []),
        ...(can.block ? (['REFUSE'] as const) : []),
      ];
    case 'ACTIVE':
      return [
        ...(can.block ? (['BLOCK', 'LOST', 'RETIRE'] as const) : []),
        ...(can.designate ? (['DESIGNATE'] as const) : []),
      ];
    case 'BLOCKED':
      return [
        ...(can.unblock ? (['UNBLOCK'] as const) : []),
        ...(can.block ? (['RETIRE'] as const) : []),
        ...(can.designate ? (['DESIGNATE'] as const) : []),
      ];
    case 'LOST':
      return can.block ? ['RETIRE'] : [];
    case 'RETIRED':
      return [];
  }
}

export const REASON_MAX = 500;

/** Motif exigé (bloquer, refuser) ou facultatif (perdu, retrait) ; aucune saisie pour les autres. */
export function reasonRule(action: DeviceAction): 'REQUIRED' | 'OPTIONAL' | 'NONE' {
  if (action === 'BLOCK' || action === 'REFUSE') return 'REQUIRED';
  if (action === 'LOST' || action === 'RETIRE') return 'OPTIONAL';
  return 'NONE';
}

/** La saisie permet-elle d'envoyer ? */
export function canSend(action: DeviceAction, reason: string): boolean {
  const trimmed = reason.trim();
  if (trimmed.length > REASON_MAX) return false;
  return reasonRule(action) !== 'REQUIRED' || trimmed.length > 0;
}

export interface DesignationForm {
  readonly isShared: boolean;
  /** Site de rattachement ; chaîne vide : aucun. */
  readonly siteId: string;
}

/** Commande d'une décision. */
export function commandOf(
  action: DeviceAction,
  input: { readonly reason: string; readonly designation?: DesignationForm },
): { readonly commandType: string; readonly payload: Record<string, unknown> } {
  const reason = input.reason.trim();
  switch (action) {
    case 'APPROVE':
      return { commandType: 'identity.device.approve', payload: {} };
    case 'REFUSE':
    case 'BLOCK':
      return { commandType: 'identity.device.block', payload: { reason } };
    case 'UNBLOCK':
      return { commandType: 'identity.device.unblock', payload: {} };
    case 'LOST':
      return { commandType: 'identity.device.declare_lost', payload: reason ? { reason } : {} };
    case 'RETIRE':
      return { commandType: 'identity.device.retire', payload: reason ? { reason } : {} };
    case 'DESIGNATE':
      return {
        commandType: 'identity.device.designate',
        payload: {
          isShared: input.designation?.isShared ?? false,
          designatedSiteId: input.designation?.siteId ? input.designation.siteId : null,
        },
      };
  }
}

/** Recherche locale : code court, utilisateur ou plateforme contenant le texte. */
export function matchesSearch(device: DeviceView, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [device.shortCode, device.enrolledByName, device.platform, device.label]
    .filter((value): value is string => typeof value === 'string')
    .some((value) => value.toLowerCase().includes(needle));
}

/** Chemin de lecture pour un filtre. */
export function devicesPath(filter: DeviceFilter): string {
  return `/api/v1/devices?limit=200${filter === 'ALL' ? '' : `&status=${filter}`}`;
}
