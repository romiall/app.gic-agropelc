-- Espace de noms `audit` (P2, correctif de concurrence). Tête de la chaîne d'audit : une
-- seule ligne (dernier `seq`, dernier `row_hash`), verrouillée par `recordAudit` pour
-- sérialiser le chaînage (07-security-rbac/03-audit.md §5, « sous verrou séquentiel »).
--
-- Pourquoi : verrouiller « la dernière ligne » d'`audit_audit_log` (`ORDER BY seq DESC LIMIT 1
-- FOR UPDATE`, P0-06) pose aussi un verrou d'intervalle (next-key, REPEATABLE READ) sur
-- l'intervalle qui suit cette ligne. Deux transactions concurrentes s'y bloquent mutuellement :
-- la première veut insérer dans l'intervalle que la seconde attend de verrouiller — InnoDB
-- détecte un verrou mortel et annule l'une d'elles (observé en test, `record-audit.test.ts` ;
-- en production, toute commande concurrente échouait alors en RETRY_LATER). Un verrou sur une
-- ligne exacte, par clé primaire, ne porte sur aucun intervalle : les transactions
-- s'attendent, sans jamais s'interbloquer.
--
-- Initialisée depuis la chaîne existante (base neuve : seq 0, empreinte de genèse = 64 zéros,
-- la même valeur que GENESIS_PREV_HASH, audit/hash-chain.ts).
--
-- migrate:up transaction:false

CREATE TABLE audit_chain_head (
  id             TINYINT UNSIGNED NOT NULL,
  last_seq       BIGINT UNSIGNED  NOT NULL,
  last_row_hash  CHAR(64)         NOT NULL,
  updated_at     DATETIME(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT ck_audit_chain_head_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

INSERT INTO audit_chain_head (id, last_seq, last_row_hash)
SELECT 1,
       COALESCE(MAX(seq), 0),
       COALESCE((SELECT row_hash FROM audit_audit_log ORDER BY seq DESC LIMIT 1), REPEAT('0', 64))
FROM audit_audit_log;

-- Mise à jour par `recordAudit` seulement ; `SELECT ... FOR UPDATE` exige aussi UPDATE (voir
-- 20260924110000_grant_audit_log_lock.sql). Ni INSERT ni DELETE : la ligne unique est posée ici.
GRANT SELECT, UPDATE ON audit_chain_head TO 'gic_app'@'%';

-- migrate:down transaction:false
DROP TABLE IF EXISTS audit_chain_head;
