-- Espace de noms `platform` (suite) : marque de traitement idempotent par consommateur
-- (P0-08 ; 08-api-events/02-catalogue-evenements.md §1, §3 « consommateurs idempotents
-- (position + clé) »). Utilitaire optionnel : un consommateur dont l'effet de bord n'a pas
-- déjà sa propre contrainte d'unicité métier peut s'appuyer sur cette table (clé
-- `(consumer_name, event_id)`) plutôt que d'en construire une pour son propre domaine.
-- Aujourd'hui exercée uniquement par le consommateur de démonstration du critère de sortie
-- P0-08 (« consommateur de test exactement-une-fois par clé » —
-- apps/server/test/event-consumer-runner.integration.test.ts) ; les consommateurs réels
-- (alertes, projections, Kommo…) restent hors périmètre P0-08.
--
-- Source : docs/03-data/dictionnaire/11-audit-sync-integrations-platform.md (section
-- platform.event_consumer_marks, ajoutée dans le même commit).
--
-- migrate:up transaction:false

CREATE TABLE platform_event_consumer_marks (
  consumer_name  VARCHAR(80)   NOT NULL,
  event_id       BINARY(16)    NOT NULL,
  processed_at   DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (consumer_name, event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Droits par table (INV-GLO-05). Ajout seul, comme platform_domain_events : la preuve
-- d'idempotence tient justement à ce qu'une seconde écriture pour la même clé échoue
-- (contrainte PK) plutôt que d'écraser la première — ni UPDATE ni DELETE pour l'application.
GRANT SELECT, INSERT ON platform_event_consumer_marks TO 'gic_app'@'%';

-- migrate:down transaction:false
DROP TABLE IF EXISTS platform_event_consumer_marks;
