-- P0-09 (2/2) : verrouillage progressif de connexion (07-security-rbac/02-securite.md §2
-- « 5 échecs → blocage progressif (1, 5, 15 min) par identifiant et par IP »). Aucun schéma
-- n'était documenté pour ce mécanisme (seule la règle l'était) — table dédiée, comme
-- platform.jobs en P0-08. Deux compteurs indépendants (par identifiant, par IP) : une même
-- ligne ne mélange jamais les deux, `scope_type` les distingue.
--
-- migrate:up transaction:false
CREATE TABLE identity_login_attempts (
  scope_type     VARCHAR(10)   NOT NULL,
  scope_value    VARCHAR(64)   NOT NULL,
  failed_count   SMALLINT      NOT NULL DEFAULT 0,
  blocked_until  DATETIME(6)   NULL,
  updated_at     DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (scope_type, scope_value),
  CONSTRAINT ck_identity_login_attempts_scope_type CHECK (scope_type IN ('IDENTIFIER', 'IP'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Droits par table (INV-GLO-05). Pas de DELETE : aucune politique de purge documentée pour
-- ce compteur technique (à revoir si le volume le justifie) — UPDATE seul suffit à
-- réinitialiser un compteur après succès.
GRANT SELECT, INSERT, UPDATE ON identity_login_attempts TO 'gic_app'@'%';

-- migrate:down transaction:false
DROP TABLE IF EXISTS identity_login_attempts;
