-- Espace de noms `crm` (P3-02). Source : docs/03-data/dictionnaire/04-crm-fieldwork.md ;
-- D02-CRM ; SM-CUSTOMER, SM-VISIT ; INV-CRM-01 à 05.
--
-- Deux colonnes DÉDUITES, ajoutées au dictionnaire dans le même commit :
-- - `crm_customers.field_versions` : dernière écriture (version, heure métier) de chaque champ,
--   pour la fusion champ par champ d'un compte modifié sur deux appareils (matrice des
--   conflits ; `mergeFieldPatch`, packages/domain) — le seul `version` de ligne ne dit pas quel
--   champ a changé depuis la version de base de l'appareil ;
-- - `crm_customers.duplicate_of_id` : un prospect créé hors ligne avec le téléphone d'un compte
--   existant est un **fait accompli** (BR-SYN-007) : il est enregistré, rattaché au compte
--   existant par cette colonne et exclu de l'unicité du téléphone (INV-CRM-03) jusqu'à la
--   fusion par un responsable (conflit `DUPLICATE_CUSTOMER`, BR-CRM-006, BR-CRM-007).
--
-- migrate:up transaction:false

CREATE TABLE crm_lead_sources (
  id          BINARY(16)     NOT NULL,
  code        VARCHAR(40)    NOT NULL,
  label       VARCHAR(200)   NOT NULL,
  sort_order  SMALLINT       NOT NULL DEFAULT 0,
  is_active   BOOLEAN        NOT NULL DEFAULT TRUE,
  is_system   BOOLEAN        NOT NULL DEFAULT FALSE,
  created_at  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by  BINARY(16)     NOT NULL,
  updated_at  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by  BINARY(16)     NULL,
  version     INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_crm_lead_sources_code (code),
  CONSTRAINT ck_crm_lead_sources_system CHECK (is_system = FALSE OR is_active = TRUE),
  CONSTRAINT fk_crm_lead_sources_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_lead_sources_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_crm_lead_sources_update_guard BEFORE UPDATE ON crm_lead_sources FOR EACH ROW
BEGIN
  IF NOT (NEW.code <=> OLD.code AND NEW.created_at <=> OLD.created_at AND NEW.created_by <=> OLD.created_by) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_lead_sources : le code est immuable.';
  END IF;
END;

CREATE TRIGGER trg_crm_lead_sources_no_delete BEFORE DELETE ON crm_lead_sources FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_lead_sources : suppression physique interdite ; utiliser is_active=false.';
END;

CREATE TABLE crm_pipeline_steps (
  id          BINARY(16)     NOT NULL,
  code        VARCHAR(40)    NOT NULL,
  label       VARCHAR(200)   NOT NULL,
  sort_order  SMALLINT       NOT NULL DEFAULT 0,
  is_active   BOOLEAN        NOT NULL DEFAULT TRUE,
  is_system   BOOLEAN        NOT NULL DEFAULT FALSE,
  created_at  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by  BINARY(16)     NOT NULL,
  updated_at  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by  BINARY(16)     NULL,
  version     INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_crm_pipeline_steps_code (code),
  KEY ix_crm_pipeline_steps_order (is_active, sort_order),
  CONSTRAINT ck_crm_pipeline_steps_system CHECK (is_system = FALSE OR is_active = TRUE),
  CONSTRAINT fk_crm_pipeline_steps_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_pipeline_steps_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_crm_pipeline_steps_update_guard BEFORE UPDATE ON crm_pipeline_steps FOR EACH ROW
BEGIN
  IF NOT (NEW.code <=> OLD.code AND NEW.created_at <=> OLD.created_at AND NEW.created_by <=> OLD.created_by) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_pipeline_steps : le code est immuable.';
  END IF;
END;

CREATE TRIGGER trg_crm_pipeline_steps_no_delete BEFORE DELETE ON crm_pipeline_steps FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_pipeline_steps : suppression physique interdite ; utiliser is_active=false.';
END;

CREATE TABLE crm_customers (
  id                     BINARY(16)     NOT NULL,
  stage                  VARCHAR(10)    NOT NULL DEFAULT 'PROSPECT',
  pipeline_step_id       BINARY(16)     NULL,
  customer_type          VARCHAR(12)    NOT NULL DEFAULT 'PARTICULIER',
  display_name           VARCHAR(200)   NOT NULL,
  contact_name           VARCHAR(200)   NULL,
  business_activity      VARCHAR(200)   NULL,
  category_id            BINARY(16)     NULL,
  phone_primary          VARCHAR(20)    NULL,
  phone_secondary        VARCHAR(20)    NULL,
  email                  VARCHAR(200)   NULL,
  address_text           TEXT           NULL,
  zone_id                BINARY(16)     NOT NULL,
  lat                    DECIMAL(9,6)   NULL,
  lng                    DECIMAL(9,6)   NULL,
  geo_accuracy_m         DECIMAL(8,1)   NULL,
  source_code            VARCHAR(40)    NOT NULL,
  acquired_by_user_id    BINARY(16)     NOT NULL,
  acquired_at            DATETIME(6)    NOT NULL,
  owner_user_id          BINARY(16)     NULL,
  home_site_id           BINARY(16)     NULL,
  converted_at           DATETIME(6)    NULL,
  first_sale_id          BINARY(16)     NULL,
  conversion_reverted    BOOLEAN        NOT NULL DEFAULT FALSE,
  lost_reason_code_id    BINARY(16)     NULL,
  merged_into_id         BINARY(16)     NULL,
  duplicate_of_id        BINARY(16)     NULL,
  credit_allowed         BOOLEAN        NOT NULL DEFAULT FALSE,
  credit_limit_xaf       BIGINT         NULL,
  payment_terms_days     SMALLINT       NULL,
  last_sale_at           DATETIME(6)    NULL,
  field_versions         JSON           NOT NULL DEFAULT (JSON_OBJECT()),
  -- INV-CRM-03 : téléphone normalisé unique parmi les comptes non MERGED ; un doublon
  -- hors ligne en attente de fusion (duplicate_of_id) est hors de l'unicité.
  phone_key              VARCHAR(20)    GENERATED ALWAYS AS (
    CASE WHEN stage <> 'MERGED' AND duplicate_of_id IS NULL THEN phone_primary END
  ) STORED,
  occurred_at            DATETIME(6)    NOT NULL,
  client_created_at      DATETIME(6)    NULL,
  received_at_server     DATETIME(6)    NULL,
  command_id             BINARY(16)     NULL,
  created_device_id      BINARY(16)     NULL,
  captured_offline       BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect          BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason       TEXT           NULL,
  created_at             DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by             BINARY(16)     NOT NULL,
  updated_at             DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by             BINARY(16)     NULL,
  version                INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_crm_customers_phone (phone_key),
  UNIQUE KEY uq_crm_customers_command (command_id),
  KEY ix_crm_customers_owner (owner_user_id),
  KEY ix_crm_customers_zone (zone_id),
  KEY ix_crm_customers_stage (stage),
  KEY ix_crm_customers_home_site (home_site_id),
  KEY ix_crm_customers_acquired (acquired_by_user_id, acquired_at),
  KEY ix_crm_customers_phone_primary (phone_primary),
  FULLTEXT KEY ftx_crm_customers_display_name (display_name) WITH PARSER ngram,
  CONSTRAINT ck_crm_customers_stage CHECK (stage IN ('PROSPECT', 'CUSTOMER', 'LOST', 'MERGED')),
  CONSTRAINT ck_crm_customers_type CHECK (customer_type IN ('PARTICULIER', 'ENTREPRISE')),
  -- BR-CRM-002 : au moins un moyen de retrouver le compte.
  CONSTRAINT ck_crm_customers_findable CHECK (phone_primary IS NOT NULL OR (lat IS NOT NULL AND lng IS NOT NULL)),
  CONSTRAINT ck_crm_customers_position CHECK ((lat IS NULL AND lng IS NULL) OR (lat IS NOT NULL AND lng IS NOT NULL)),
  CONSTRAINT ck_crm_customers_ranges CHECK (
    (lat IS NULL OR lat BETWEEN -90 AND 90) AND (lng IS NULL OR lng BETWEEN -180 AND 180)
    AND (geo_accuracy_m IS NULL OR geo_accuracy_m >= 0)
  ),
  CONSTRAINT ck_crm_customers_prospect_step CHECK (stage <> 'PROSPECT' OR pipeline_step_id IS NOT NULL),
  CONSTRAINT ck_crm_customers_lost CHECK (stage <> 'LOST' OR lost_reason_code_id IS NOT NULL),
  CONSTRAINT ck_crm_customers_merged CHECK (
    (stage = 'MERGED' AND merged_into_id IS NOT NULL) OR (stage <> 'MERGED' AND merged_into_id IS NULL)
  ),
  -- INV-CRM-04 : un CUSTOMER a une première vente.
  CONSTRAINT ck_crm_customers_customer CHECK (stage <> 'CUSTOMER' OR first_sale_id IS NOT NULL),
  CONSTRAINT ck_crm_customers_self_refs CHECK (
    (merged_into_id IS NULL OR merged_into_id <> id) AND (duplicate_of_id IS NULL OR duplicate_of_id <> id)
  ),
  CONSTRAINT ck_crm_customers_credit CHECK (
    (credit_limit_xaf IS NULL OR credit_limit_xaf >= 0) AND (payment_terms_days IS NULL OR payment_terms_days >= 0)
  ),
  CONSTRAINT fk_crm_customers_step FOREIGN KEY (pipeline_step_id) REFERENCES crm_pipeline_steps (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customers_category FOREIGN KEY (category_id) REFERENCES catalog_customer_categories (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customers_zone FOREIGN KEY (zone_id) REFERENCES organization_zones (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customers_source FOREIGN KEY (source_code) REFERENCES crm_lead_sources (code) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customers_acquired_by FOREIGN KEY (acquired_by_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customers_owner FOREIGN KEY (owner_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customers_home_site FOREIGN KEY (home_site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customers_lost_reason FOREIGN KEY (lost_reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customers_merged_into FOREIGN KEY (merged_into_id) REFERENCES crm_customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customers_duplicate_of FOREIGN KEY (duplicate_of_id) REFERENCES crm_customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customers_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customers_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customers_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- INV-CRM-01 : acquéreur et date d'acquisition immuables ; l'origine de la création aussi.
CREATE TRIGGER trg_crm_customers_update_guard BEFORE UPDATE ON crm_customers FOR EACH ROW
BEGIN
  IF NOT (
    NEW.acquired_by_user_id <=> OLD.acquired_by_user_id AND
    NEW.acquired_at <=> OLD.acquired_at AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_customers : acquéreur et date d''acquisition immuables (INV-CRM-01).';
  END IF;
END;

CREATE TRIGGER trg_crm_customers_no_delete BEFORE DELETE ON crm_customers FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_customers : suppression physique interdite (INV-GLO-03) ; fusionner ou marquer perdu.';
END;

CREATE TABLE crm_customer_assignments (
  id           BINARY(16)     NOT NULL,
  customer_id  BINARY(16)     NOT NULL,
  user_id      BINARY(16)     NOT NULL,
  valid_from   DATETIME(6)    NOT NULL,
  valid_to     DATETIME(6)    NULL,
  assigned_by  BINARY(16)     NOT NULL,
  reason       TEXT           NULL,
  command_id   BINARY(16)     NULL,
  -- INV-CRM-02 : au plus une affectation active par compte (unicité partielle) ; le
  -- non-chevauchement des périodes closes est revérifié par déclencheur (conventions §4).
  active_key   BINARY(16)     GENERATED ALWAYS AS (CASE WHEN valid_to IS NULL THEN customer_id END) STORED,
  created_at   DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_crm_customer_assignments_active (active_key),
  KEY ix_crm_customer_assignments_user (user_id, valid_from),
  KEY ix_crm_customer_assignments_customer (customer_id, valid_from),
  CONSTRAINT ck_crm_customer_assignments_period CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT fk_crm_customer_assignments_customer FOREIGN KEY (customer_id) REFERENCES crm_customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customer_assignments_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customer_assignments_assigned_by FOREIGN KEY (assigned_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_crm_customer_assignments_overlap_ins BEFORE INSERT ON crm_customer_assignments FOR EACH ROW
BEGIN
  IF EXISTS (
    SELECT 1 FROM crm_customer_assignments
    WHERE customer_id = NEW.customer_id
      AND id <> NEW.id
      AND valid_from < COALESCE(NEW.valid_to, '9999-12-31 23:59:59.999999')
      AND COALESCE(valid_to, '9999-12-31 23:59:59.999999') > NEW.valid_from
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_customer_assignments : périodes de titulaire chevauchantes (INV-CRM-02).';
  END IF;
END;

-- IMMUABLE sauf fermeture de période (dictionnaire) ; revérifie le non-chevauchement.
CREATE TRIGGER trg_crm_customer_assignments_update_guard BEFORE UPDATE ON crm_customer_assignments FOR EACH ROW
BEGIN
  IF NOT (
    NEW.customer_id <=> OLD.customer_id AND
    NEW.user_id <=> OLD.user_id AND
    NEW.valid_from <=> OLD.valid_from AND
    NEW.assigned_by <=> OLD.assigned_by AND
    NEW.reason <=> OLD.reason AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_customer_assignments : seule la fermeture (valid_to) est modifiable.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM crm_customer_assignments
    WHERE customer_id = NEW.customer_id
      AND id <> NEW.id
      AND valid_from < COALESCE(NEW.valid_to, '9999-12-31 23:59:59.999999')
      AND COALESCE(valid_to, '9999-12-31 23:59:59.999999') > NEW.valid_from
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_customer_assignments : périodes de titulaire chevauchantes (INV-CRM-02).';
  END IF;
END;

CREATE TRIGGER trg_crm_customer_assignments_no_delete BEFORE DELETE ON crm_customer_assignments FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_customer_assignments : suppression physique interdite ; fermer par valid_to.';
END;

CREATE TABLE crm_customer_stage_history (
  id              BINARY(16)     NOT NULL,
  customer_id     BINARY(16)     NOT NULL,
  from_stage      VARCHAR(10)    NULL,
  to_stage        VARCHAR(10)    NOT NULL,
  from_step_id    BINARY(16)     NULL,
  to_step_id      BINARY(16)     NULL,
  occurred_at     DATETIME(6)    NOT NULL,
  actor_user_id   BINARY(16)     NOT NULL,
  reason_code_id  BINARY(16)     NULL,
  cause_ref       BINARY(16)     NULL,
  command_id      BINARY(16)     NULL,
  created_at      DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY ix_crm_customer_stage_history_customer (customer_id, occurred_at),
  CONSTRAINT ck_crm_customer_stage_history_stages CHECK (
    (from_stage IS NULL OR from_stage IN ('PROSPECT', 'CUSTOMER', 'LOST', 'MERGED'))
    AND to_stage IN ('PROSPECT', 'CUSTOMER', 'LOST', 'MERGED')
  ),
  CONSTRAINT fk_crm_customer_stage_history_customer FOREIGN KEY (customer_id) REFERENCES crm_customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customer_stage_history_from_step FOREIGN KEY (from_step_id) REFERENCES crm_pipeline_steps (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customer_stage_history_to_step FOREIGN KEY (to_step_id) REFERENCES crm_pipeline_steps (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customer_stage_history_actor FOREIGN KEY (actor_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_customer_stage_history_reason FOREIGN KEY (reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_crm_customer_stage_history_no_update BEFORE UPDATE ON crm_customer_stage_history FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_customer_stage_history : historique immuable (BR-CRM-008).';
END;

CREATE TRIGGER trg_crm_customer_stage_history_no_delete BEFORE DELETE ON crm_customer_stage_history FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_customer_stage_history : suppression physique interdite (BR-CRM-008).';
END;

CREATE TABLE crm_visits (
  id                          BINARY(16)     NOT NULL,
  customer_id                 BINARY(16)     NOT NULL,
  user_id                     BINARY(16)     NOT NULL,
  work_session_id             BINARY(16)     NULL,
  customer_stage_at_visit     VARCHAR(10)    NOT NULL,
  lat                         DECIMAL(9,6)   NULL,
  lng                         DECIMAL(9,6)   NULL,
  accuracy_m                  DECIMAL(8,1)   NULL,
  distance_to_customer_m      DECIMAL(8,1)   NULL,
  outcome_reason_code_id      BINARY(16)     NOT NULL,
  notes                       TEXT           NULL,
  next_action_at              DATE           NULL,
  next_action_note            TEXT           NULL,
  flags                       JSON           NOT NULL DEFAULT (JSON_ARRAY()),
  status                      VARCHAR(10)    NOT NULL DEFAULT 'RECORDED',
  -- Index partiel « prochaines actions ouvertes » (dictionnaire : `(next_action_at)` partiel).
  open_next_action_at         DATE           GENERATED ALWAYS AS (CASE WHEN status = 'RECORDED' THEN next_action_at END) STORED,
  cancelled_at                DATETIME(6)    NULL,
  cancelled_by                BINARY(16)     NULL,
  cancel_reason_code_id       BINARY(16)     NULL,
  cancel_comment              TEXT           NULL,
  cancel_approval_request_id  BINARY(16)     NULL,
  occurred_at                 DATETIME(6)    NOT NULL,
  client_created_at           DATETIME(6)    NULL,
  received_at_server          DATETIME(6)    NULL,
  command_id                  BINARY(16)     NULL,
  created_device_id           BINARY(16)     NULL,
  captured_offline            BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect               BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason            TEXT           NULL,
  created_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by                  BINARY(16)     NOT NULL,
  updated_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by                  BINARY(16)     NULL,
  version                     INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_crm_visits_command (command_id),
  KEY ix_crm_visits_user_occurred (user_id, occurred_at),
  KEY ix_crm_visits_customer_occurred (customer_id, occurred_at),
  KEY ix_crm_visits_next_action (open_next_action_at),
  KEY ix_crm_visits_session (work_session_id),
  CONSTRAINT ck_crm_visits_status CHECK (status IN ('RECORDED', 'CANCELLED')),
  CONSTRAINT ck_crm_visits_stage CHECK (customer_stage_at_visit IN ('PROSPECT', 'CUSTOMER', 'LOST', 'MERGED')),
  CONSTRAINT ck_crm_visits_position CHECK ((lat IS NULL AND lng IS NULL) OR (lat IS NOT NULL AND lng IS NOT NULL)),
  CONSTRAINT ck_crm_visits_ranges CHECK (
    (lat IS NULL OR lat BETWEEN -90 AND 90) AND (lng IS NULL OR lng BETWEEN -180 AND 180)
    AND (accuracy_m IS NULL OR accuracy_m >= 0)
  ),
  -- [STD-CANCEL] : colonnes d'annulation renseignées si et seulement si CANCELLED.
  CONSTRAINT ck_crm_visits_cancel CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancel_reason_code_id IS NULL AND cancel_comment IS NULL)
  ),
  CONSTRAINT fk_crm_visits_customer FOREIGN KEY (customer_id) REFERENCES crm_customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_visits_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_visits_session FOREIGN KEY (work_session_id) REFERENCES fieldwork_work_sessions (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_visits_outcome FOREIGN KEY (outcome_reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_visits_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_visits_cancel_reason FOREIGN KEY (cancel_reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_visits_cancel_approval FOREIGN KEY (cancel_approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_visits_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_visits_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_visits_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- BR-CRM-016 : une visite synchronisée n'est plus modifiable — seules l'annulation et les
-- indicateurs (session rejetée après coup, SM-WORK-SESSION) évoluent.
CREATE TRIGGER trg_crm_visits_update_guard BEFORE UPDATE ON crm_visits FOR EACH ROW
BEGIN
  IF NOT (
    NEW.customer_id <=> OLD.customer_id AND
    NEW.user_id <=> OLD.user_id AND
    NEW.work_session_id <=> OLD.work_session_id AND
    NEW.customer_stage_at_visit <=> OLD.customer_stage_at_visit AND
    NEW.lat <=> OLD.lat AND
    NEW.lng <=> OLD.lng AND
    NEW.accuracy_m <=> OLD.accuracy_m AND
    NEW.distance_to_customer_m <=> OLD.distance_to_customer_m AND
    NEW.outcome_reason_code_id <=> OLD.outcome_reason_code_id AND
    NEW.notes <=> OLD.notes AND
    NEW.next_action_at <=> OLD.next_action_at AND
    NEW.next_action_note <=> OLD.next_action_note AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_visits : visite non modifiable ; l''annuler et en saisir une nouvelle (BR-CRM-016).';
  END IF;
END;

CREATE TRIGGER trg_crm_visits_no_delete BEFORE DELETE ON crm_visits FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_visits : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END;

CREATE TABLE crm_interactions (
  id                          BINARY(16)     NOT NULL,
  customer_id                 BINARY(16)     NOT NULL,
  user_id                     BINARY(16)     NOT NULL,
  channel                     VARCHAR(10)    NOT NULL,
  direction                   VARCHAR(10)    NOT NULL DEFAULT 'SORTANT',
  summary                     TEXT           NULL,
  next_action_at              DATE           NULL,
  next_action_note            TEXT           NULL,
  status                      VARCHAR(10)    NOT NULL DEFAULT 'RECORDED',
  cancelled_at                DATETIME(6)    NULL,
  cancelled_by                BINARY(16)     NULL,
  cancel_reason_code_id       BINARY(16)     NULL,
  cancel_comment              TEXT           NULL,
  cancel_approval_request_id  BINARY(16)     NULL,
  occurred_at                 DATETIME(6)    NOT NULL,
  client_created_at           DATETIME(6)    NULL,
  received_at_server          DATETIME(6)    NULL,
  command_id                  BINARY(16)     NULL,
  created_device_id           BINARY(16)     NULL,
  captured_offline            BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect               BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason            TEXT           NULL,
  created_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by                  BINARY(16)     NOT NULL,
  updated_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by                  BINARY(16)     NULL,
  version                     INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_crm_interactions_command (command_id),
  KEY ix_crm_interactions_user_occurred (user_id, occurred_at),
  KEY ix_crm_interactions_customer_occurred (customer_id, occurred_at),
  CONSTRAINT ck_crm_interactions_channel CHECK (channel IN ('APPEL', 'SMS', 'EMAIL', 'AUTRE')),
  CONSTRAINT ck_crm_interactions_direction CHECK (direction IN ('ENTRANT', 'SORTANT')),
  CONSTRAINT ck_crm_interactions_status CHECK (status IN ('RECORDED', 'CANCELLED')),
  CONSTRAINT ck_crm_interactions_cancel CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancel_reason_code_id IS NULL AND cancel_comment IS NULL)
  ),
  CONSTRAINT fk_crm_interactions_customer FOREIGN KEY (customer_id) REFERENCES crm_customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_interactions_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_interactions_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_interactions_cancel_reason FOREIGN KEY (cancel_reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_interactions_cancel_approval FOREIGN KEY (cancel_approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_interactions_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_interactions_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_interactions_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_crm_interactions_update_guard BEFORE UPDATE ON crm_interactions FOR EACH ROW
BEGIN
  IF NOT (
    NEW.customer_id <=> OLD.customer_id AND
    NEW.user_id <=> OLD.user_id AND
    NEW.channel <=> OLD.channel AND
    NEW.direction <=> OLD.direction AND
    NEW.summary <=> OLD.summary AND
    NEW.next_action_at <=> OLD.next_action_at AND
    NEW.next_action_note <=> OLD.next_action_note AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_interactions : interaction non modifiable ; l''annuler et en saisir une nouvelle (BR-CRM-016).';
  END IF;
END;

CREATE TRIGGER trg_crm_interactions_no_delete BEFORE DELETE ON crm_interactions FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_interactions : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END;

CREATE TABLE crm_sales_targets (
  id            BINARY(16)     NOT NULL,
  target_type   VARCHAR(5)     NOT NULL,
  user_id       BINARY(16)     NULL,
  team_id       BINARY(16)     NULL,
  site_id       BINARY(16)     NULL,
  metric        VARCHAR(20)    NOT NULL,
  product_id    BINARY(16)     NULL,
  period_start  DATE           NOT NULL,
  period_end    DATE           NOT NULL,
  target_value  DECIMAL(16,3)  NOT NULL,
  status        VARCHAR(10)    NOT NULL DEFAULT 'ACTIVE',
  created_at    DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by    BINARY(16)     NOT NULL,
  updated_at    DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by    BINARY(16)     NULL,
  version       INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY ix_crm_sales_targets_user (user_id, period_start),
  KEY ix_crm_sales_targets_team (team_id, period_start),
  KEY ix_crm_sales_targets_site (site_id, period_start),
  CONSTRAINT ck_crm_sales_targets_type CHECK (target_type IN ('USER', 'TEAM', 'SITE')),
  CONSTRAINT ck_crm_sales_targets_target CHECK (
    (target_type = 'USER' AND user_id IS NOT NULL AND team_id IS NULL AND site_id IS NULL)
    OR (target_type = 'TEAM' AND team_id IS NOT NULL AND user_id IS NULL AND site_id IS NULL)
    OR (target_type = 'SITE' AND site_id IS NOT NULL AND user_id IS NULL AND team_id IS NULL)
  ),
  CONSTRAINT ck_crm_sales_targets_metric CHECK (
    metric IN ('CA', 'QTE_PRODUIT', 'NOUVEAUX_CLIENTS', 'VISITES', 'PROSPECTS_CREES')
  ),
  CONSTRAINT ck_crm_sales_targets_product CHECK (metric <> 'QTE_PRODUIT' OR product_id IS NOT NULL),
  CONSTRAINT ck_crm_sales_targets_period CHECK (period_end >= period_start),
  CONSTRAINT ck_crm_sales_targets_value CHECK (target_value > 0),
  CONSTRAINT ck_crm_sales_targets_status CHECK (status IN ('ACTIVE', 'CANCELLED')),
  CONSTRAINT fk_crm_sales_targets_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_sales_targets_team FOREIGN KEY (team_id) REFERENCES organization_teams (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_sales_targets_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_sales_targets_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_sales_targets_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_sales_targets_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- BR-CRM-018 : pas deux objectifs actifs de même cible, métrique et produit sur des périodes
-- qui se chevauchent (verrouillage de ligne dans le gestionnaire + re-vérification ici).
CREATE TRIGGER trg_crm_sales_targets_overlap_ins BEFORE INSERT ON crm_sales_targets FOR EACH ROW
BEGIN
  IF NEW.status = 'ACTIVE' AND EXISTS (
    SELECT 1 FROM crm_sales_targets
    WHERE id <> NEW.id AND status = 'ACTIVE'
      AND target_type = NEW.target_type
      AND user_id <=> NEW.user_id AND team_id <=> NEW.team_id AND site_id <=> NEW.site_id
      AND metric = NEW.metric AND product_id <=> NEW.product_id
      AND period_start <= NEW.period_end AND period_end >= NEW.period_start
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_sales_targets : objectif actif chevauchant (BR-CRM-018).';
  END IF;
END;

-- Seule l'annulation est permise après création ; une réactivation revérifie le chevauchement.
CREATE TRIGGER trg_crm_sales_targets_update_guard BEFORE UPDATE ON crm_sales_targets FOR EACH ROW
BEGIN
  IF NOT (
    NEW.target_type <=> OLD.target_type AND
    NEW.user_id <=> OLD.user_id AND
    NEW.team_id <=> OLD.team_id AND
    NEW.site_id <=> OLD.site_id AND
    NEW.metric <=> OLD.metric AND
    NEW.product_id <=> OLD.product_id AND
    NEW.period_start <=> OLD.period_start AND
    NEW.period_end <=> OLD.period_end AND
    NEW.target_value <=> OLD.target_value AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_sales_targets : objectif non modifiable ; l''annuler et en définir un nouveau.';
  END IF;
  IF NEW.status = 'ACTIVE' AND EXISTS (
    SELECT 1 FROM crm_sales_targets
    WHERE id <> NEW.id AND status = 'ACTIVE'
      AND target_type = NEW.target_type
      AND user_id <=> NEW.user_id AND team_id <=> NEW.team_id AND site_id <=> NEW.site_id
      AND metric = NEW.metric AND product_id <=> NEW.product_id
      AND period_start <= NEW.period_end AND period_end >= NEW.period_start
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_sales_targets : objectif actif chevauchant (BR-CRM-018).';
  END IF;
END;

CREATE TRIGGER trg_crm_sales_targets_no_delete BEFORE DELETE ON crm_sales_targets FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_sales_targets : suppression physique interdite ; utiliser CANCELLED.';
END;

-- Droits par table (INV-GLO-05). Historique de stade : ajout seul.
GRANT SELECT, INSERT, UPDATE ON crm_lead_sources TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON crm_pipeline_steps TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON crm_customers TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON crm_customer_assignments TO 'gic_app'@'%';
GRANT SELECT, INSERT ON crm_customer_stage_history TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON crm_visits TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON crm_interactions TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON crm_sales_targets TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS crm_sales_targets;
DROP TABLE IF EXISTS crm_interactions;
DROP TABLE IF EXISTS crm_visits;
DROP TABLE IF EXISTS crm_customer_stage_history;
DROP TABLE IF EXISTS crm_customer_assignments;
DROP TABLE IF EXISTS crm_customers;
DROP TABLE IF EXISTS crm_pipeline_steps;
DROP TABLE IF EXISTS crm_lead_sources;
SET FOREIGN_KEY_CHECKS = 1;
