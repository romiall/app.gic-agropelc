/**
 * Réaction des modules supérieurs au rejet d'une dérogation de session (SM-WORK-SESSION :
 * « Rejet → activités rattachées : indicateur `session_rejected` »). `fieldwork` ne connaît pas
 * ces activités (visites : `crm` ; ventes terrain : `sales`, P4) et ne peut pas les importer
 * (graphe : `crm → fieldwork`, jamais l'inverse) : même inversion de dépendance que le registre
 * des décisions d'`approvals` — chaque module propriétaire d'activités s'enregistre au démarrage,
 * et sa réaction s'exécute dans la transaction de la décision.
 */
import type { UnitOfWork } from '../../../platform/unit-of-work.js';

export type SessionRejectedListener = (uow: UnitOfWork, sessionId: string) => Promise<void>;

export class SessionRejectedListenerRegistry {
  private readonly listeners: SessionRejectedListener[] = [];

  register(listener: SessionRejectedListener): void {
    this.listeners.push(listener);
  }

  async notify(uow: UnitOfWork, sessionId: string): Promise<void> {
    for (const listener of this.listeners) await listener(uow, sessionId);
  }
}

export const SESSION_REJECTED_LISTENERS = Symbol('SESSION_REJECTED_LISTENERS');
