-- Module `inventory`, correctif A7 (revue de P8) : verrou de la masse mensuelle des frais généraux
-- d'une ferme (site, espèce, mois métier).
-- Source : docs/decisions/ADR-038-ordre-de-verrouillage-global.md (rang N2b, révision de P9) ;
-- ADR-026 (frais généraux répartis) ; docs/03-data/dictionnaire/06-inventory.md.
--
-- La masse d'un mois est lue par `production.overhead.allocate` et par la clôture d'un lot, puis
-- répartie ; une saisie se contrepasse seulement tant que le mois n'est pas réparti. Sans verrou
-- commun, une annulation concurrente d'une répartition laisse la part d'un frais annulé dans les
-- lots et une masse négative sur le site. Cette table ne porte aucune donnée métier : une ligne par
-- (site, espèce, mois), créée au premier besoin par un upsert sans effet qui prend son verrou
-- d'écriture, tenu jusqu'à la fin de la transaction (ADR-038 §3).
--
-- Pas de clé étrangère vers le site : une commande dont la charge utile cite un site inconnu doit
-- être rejetée proprement (`SITE_NOT_FARM`), pas échouer sur une erreur de base prise pour transitoire.
-- migrate:up transaction:false

CREATE TABLE inventory_overhead_pool_locks (
  site_id       BINARY(16)   NOT NULL,
  species_group VARCHAR(10)  NOT NULL,
  period        CHAR(7)      NOT NULL,
  created_at    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (site_id, species_group, period),
  CONSTRAINT ck_inventory_overhead_pool_locks_species CHECK (species_group IN ('VOLAILLE', 'PORC')),
  CONSTRAINT ck_inventory_overhead_pool_locks_period CHECK (period REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- UPDATE : l'upsert sans effet (`ON DUPLICATE KEY UPDATE`) l'exige ; aucune colonne n'est modifiée.
GRANT SELECT, INSERT, UPDATE ON inventory_overhead_pool_locks TO 'gic_app'@'%';

-- migrate:down transaction:false
DROP TABLE IF EXISTS inventory_overhead_pool_locks;
