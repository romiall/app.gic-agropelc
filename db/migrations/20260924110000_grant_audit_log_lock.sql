-- Correctif de privilège découvert en P0-06 (pipeline de commande, chaînage d'audit
-- applicatif, 07-security-rbac/03-audit.md §5) : `SELECT ... FOR UPDATE` (lecture
-- verrouillante, utilisée pour sérialiser le calcul de prev_hash/row_hash sur la dernière
-- ligne de audit_audit_log) exige, chez MySQL, le privilège UPDATE en plus de SELECT —
-- une lecture verrouillante est refusée avec « SELECT with locking clause command denied »
-- même quand SELECT seul suffirait pour une lecture ordinaire (documenté ; vérifié en local :
-- reproductible sur toute table SELECT+INSERT sans UPDATE, ex. platform_domain_events).
--
-- Ceci n'affaiblit pas l'immuabilité (INV-AUD-01) : trg_audit_audit_log_no_update
-- (20260924100600_create_audit.sql) bloque *toute* commande UPDATE, quel que soit le
-- privilège du rôle qui l'émet — le déclencheur reste l'unique mécanisme d'application,
-- comme c'est déjà le cas pour sync_command_inbox (GRANT ... UPDATE accordé, mais liste
-- blanche de colonnes appliquée par déclencheur).
--
-- migrate:up transaction:false

GRANT UPDATE ON audit_audit_log TO 'gic_app'@'%';

-- migrate:down transaction:false
REVOKE UPDATE ON audit_audit_log FROM 'gic_app'@'%';
