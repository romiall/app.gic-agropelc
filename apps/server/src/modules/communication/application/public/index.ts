/**
 * API publique du module `communication` (ADR-070) : lue par la couche de transport `communication-api/`
 * et par `analytics-api/` (compteurs d'alertes de la tour de contrôle). Aucun autre module ne l'importe :
 * les modules propriétaires publient des événements (ADR-070 §2).
 */
export { ALERTS_CONSUMER_NAME } from '../events/alerts-consumer.js';
