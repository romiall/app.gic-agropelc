-- Espace de noms `platform` (noyau) : outbox transactionnelle des événements métier,
-- positions des consommateurs, compteurs de numérotation de documents.
-- Source : docs/03-data/dictionnaire/11-audit-sync-integrations-platform.md
-- (sections platform.domain_events, platform.event_consumer_offsets,
-- platform.document_sequences). Aucune dépendance à un autre module (N0,
-- docs/05-architecture/03-graphe-dependances.md).
--
-- migrate:up transaction:false

CREATE TABLE platform_domain_events (
  seq              BIGINT UNSIGNED AUTO_INCREMENT,
  event_id         BINARY(16)    NOT NULL,
  event_type       VARCHAR(80)   NOT NULL,
  event_version    SMALLINT      NOT NULL DEFAULT 1,
  producer_module  VARCHAR(40)   NOT NULL,
  aggregate_type   VARCHAR(40)   NOT NULL,
  aggregate_id     BINARY(16)    NOT NULL,
  occurred_at      DATETIME(6)   NOT NULL,
  recorded_at      DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  payload          JSON          NOT NULL,
  command_id       BINARY(16)    NULL,
  correlation_id   BINARY(16)    NULL,
  causation_id     BINARY(16)    NULL,
  PRIMARY KEY (seq),
  UNIQUE KEY uq_platform_domain_events_event_id (event_id),
  KEY ix_platform_domain_events_type_seq (event_type, seq),
  KEY ix_platform_domain_events_aggregate (aggregate_type, aggregate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Pas un event store : outbox de consommation, purement en ajout (ADR-011).
-- Aucune colonne n'est jamais modifiée après insertion.
-- (Pas de `DELIMITER` : pseudo-commande du client `mysql` interactif, sans effet — et en
-- erreur de syntaxe — sur une connexion pilotée par un client SQL comme dbmate/mysql2 ;
-- le protocole multi-instructions du serveur découpe déjà correctement sur `BEGIN … END`.)
CREATE TRIGGER trg_platform_domain_events_no_update BEFORE UPDATE ON platform_domain_events FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_domain_events : aucune modification (immuable, ADR-011).';
END;

CREATE TRIGGER trg_platform_domain_events_no_delete BEFORE DELETE ON platform_domain_events FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_domain_events : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE platform_event_consumer_offsets (
  consumer_name  VARCHAR(80)   NOT NULL,
  last_seq       BIGINT        NOT NULL DEFAULT 0,
  updated_at     DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  last_error     TEXT          NULL,
  PRIMARY KEY (consumer_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE platform_document_sequences (
  doc_type    VARCHAR(10)  NOT NULL,
  -- Référence sans clé étrangère : le noyau platform ne dépend d'aucun module
  -- (docs/03-data/02-modele-relationnel.md §5).
  site_id     BINARY(16)   NOT NULL,
  year        SMALLINT     NOT NULL,
  next_value  INT          NOT NULL DEFAULT 1,
  PRIMARY KEY (doc_type, site_id, year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Droits par table (INV-GLO-05 ; docs/03-data/03-historisation-suppression.md §4).
-- Préalable (hors migration, environnement) : `CREATE USER 'gic_app'@'%' IDENTIFIED BY '<secret>';`
-- — voir db/README.md. domain_events est en ajout seul : ni UPDATE ni DELETE pour l'application.
GRANT SELECT, INSERT ON platform_domain_events TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON platform_event_consumer_offsets TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON platform_document_sequences TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS platform_document_sequences;
DROP TABLE IF EXISTS platform_event_consumer_offsets;
DROP TABLE IF EXISTS platform_domain_events;
SET FOREIGN_KEY_CHECKS = 1;
