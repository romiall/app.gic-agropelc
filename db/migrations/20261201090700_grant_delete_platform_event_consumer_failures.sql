-- Purge du journal des événements sautés par un consommateur (P9-25, PF-7 ; ADR-061 §12, ADR-068 §8 ; AV-425
-- « Limites » renvoyait la conservation à P9-22 ; AV-472, choix (a)). La migration 20261201090200 n'accordait que
-- SELECT et INSERT : l'application ne pouvait rien supprimer et la table croissait sans limite.
--
-- Le journal des sauts est une table **technique**, sans valeur métier : les événements eux-mêmes restent dans
-- platform_domain_events, immuable, distinct de ce journal ; le message d'erreur d'un saut peut porter une donnée
-- personnelle (ADR-061 §4). DELETE est accordé à l'application pour la seule purge bornée par
-- platform.consumer_failure_retention_days (90 jours), que le code ne fait jamais entamer la fenêtre de
-- l'alerte CONSUMER_FAILED (communication.consumer_failure_window_hours). Aucun UPDATE : la ligne d'un saut ne se
-- modifie pas. Aucun déclencheur : la garde de fenêtre est dans le code de la purge
-- (platform/events/consumer-failure-purge.ts).
--
-- Numéro provisoire : renuméroter à la consolidation si un autre groupe de migrations est créé.
--
-- migrate:up transaction:false

GRANT DELETE ON platform_event_consumer_failures TO 'gic_app'@'%';

-- migrate:down transaction:false
REVOKE DELETE ON platform_event_consumer_failures FROM 'gic_app'@'%';
