-- Espace de noms `platform` (suite) : événements sautés par un consommateur (P9-04 ; ADR-071 §12,
-- AV-412 ; 08-api-events/02-catalogue-evenements.md §3 « Échecs »). Le runner saute un événement
-- après ses essais et avance la position ; `last_error` n'en garde que le dernier message, réécrit par
-- le premier événement traité ensuite. Cette table d'ajout seul consigne chaque saut (consommateur,
-- position, événement, erreur) pour que l'alerte technique `CONSUMER_FAILED` ne dépende pas d'un
-- champ éphémère.
--
-- Source : docs/03-data/dictionnaire/11-audit-sync-integrations-platform.md (section
-- platform.event_consumer_failures, ajoutée dans le même commit).
--
-- migrate:up transaction:false

CREATE TABLE platform_event_consumer_failures (
  id             BIGINT UNSIGNED AUTO_INCREMENT,
  consumer_name  VARCHAR(80)    NOT NULL,
  event_seq      BIGINT UNSIGNED NOT NULL,
  event_id       BINARY(16)     NOT NULL,
  event_type     VARCHAR(80)    NOT NULL,
  error_message  VARCHAR(1000)  NOT NULL,
  attempts       SMALLINT       NOT NULL,
  failed_at      DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  -- Un saut n'est consigné qu'une fois, même si le runner rejoue l'événement avant d'avancer la position.
  UNIQUE KEY uq_platform_event_consumer_failures_event (consumer_name, event_seq),
  KEY ix_platform_event_consumer_failures_failed (failed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Ajout seul, comme platform_event_consumer_marks : ni UPDATE ni DELETE pour l'application.
GRANT SELECT, INSERT ON platform_event_consumer_failures TO 'gic_app'@'%';

-- migrate:down transaction:false
DROP TABLE IF EXISTS platform_event_consumer_failures;
