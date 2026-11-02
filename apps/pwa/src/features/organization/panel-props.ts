/** Données et envoi partagés par les quatre panneaux de l'écran « Organisation » (ECR-ADM-06). */
import type { useOnlineCommands } from '../admin/admin-online.js';
import type { Option, PosView, SiteView, TeamView, ZoneView } from './organization.js';

export type OrgCommands = ReturnType<typeof useOnlineCommands>;

export interface OrgData {
  readonly sites: readonly SiteView[];
  readonly zones: readonly ZoneView[];
  readonly teams: readonly TeamView[];
  readonly pointsOfSale: readonly PosView[];
  /** Comptes actifs (responsables d'équipe, membres, titulaires d'un emplacement mobile). */
  readonly users: readonly Option[];
  /** Appareils actifs (désignation d'un point de vente en garde exclusive). */
  readonly devices: readonly Option[];
  /** Relecture en cours ou en échec : les actions se bloquent. */
  readonly stale: boolean;
  /** Clé de relecture des lectures propres à un panneau (emplacements d'un site). */
  readonly reloadKey: string;
}

export interface PanelProps {
  readonly data: OrgData;
  readonly commands: OrgCommands;
}

/** Les actions d'un panneau se bloquent pendant une commande, une relecture ou une réponse attendue. */
export function panelBlocked({ data, commands }: PanelProps): boolean {
  return commands.blocked || data.stale;
}
