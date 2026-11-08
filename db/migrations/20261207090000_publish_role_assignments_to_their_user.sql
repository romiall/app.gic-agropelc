-- Jeu de synchronisation `role_assignment` restreint à l'utilisateur de l'affectation (ADR-071 ; AV-533, AV-550 à AV-552 ;
-- décision du porteur du 08/11/2026, questionnaire de clôture Q24, réponse A). Module `sync`, table `sync_change_feed`
-- (dictionnaire 11-audit-sync-integrations-platform.md, `sync.change_feed`) ; les affectations elles-mêmes
-- (`identity_user_role_assignments`) ne sont pas touchées.
--
-- Jusqu'ici une affectation de rôle était publiée par une ligne `GLOBAL` (repli générique du pipeline des commandes, création
-- d'un compte, scripts d'exploitation) : chaque appareil recevait toutes les affectations de l'entreprise, donc qui détient
-- quel rôle sur quel périmètre. Elles sont désormais publiées à leur utilisateur seul (ligne `USER`,
-- `emitRoleAssignmentChange`), et la projection `ROLE_ASSIGNMENT` ne sert plus aucune ligne `GLOBAL`. Il reste à traiter ce que le
-- flux porte déjà :
--
-- 1. Retrait. Une ligne `SCOPE_EXIT` en portée `GLOBAL` par affectation publiée jusqu'ici. La PWA l'applique en retirant le
--    périmètre `GLOBAL` de la projection de l'appareil, et la projection elle-même s'il ne lui en reste aucun
--    (`applyChange`, 02-synchronisation.md §5.3) : les affectations des autres comptes quittent les appareils déjà alimentés à
--    leur première synchronisation après la livraison. Une ligne `SCOPE_EXIT` plutôt que `DELETE` : elle ne dépend pas de l'ordre
--    d'application et ne supprime pas l'affectation propre d'un appareil dont la ligne `USER` de l'étape 2 serait passée avant.
--    La compaction du flux (BR-SYN-015) ne supprime jamais la dernière ligne d'une clé : un appareil absent plus de 60 jours
--    reçoit ce retrait à son retour ; les anciennes lignes `UPSERT` `GLOBAL` qu'elle remplace sont purgées comme les autres,
--    et la projection les ignore de toute façon.
-- 2. Rattrapage. Une ligne `UPSERT` en portée `USER` par affectation (en vigueur ou non, révoquée ou échue : l'appareil juge la
--    validité à son heure), à sa version courante. Sans elle, un appareil neuf ne recevrait plus aucune affectation, puisque ses
--    lignes `GLOBAL` ne sont plus servies, et un appareil déjà alimenté perdrait les siennes à l'étape 1. Elle rattrape aussi
--    les affectations posées par des scripts qui ne publiaient rien (rôle du responsable commercial de Bonabéri, 08/11/2026).
--
-- Les deux étapes n'écrivent que dans le flux (ajout seul, aucun déclencheur ne s'y oppose). L'ordre n'importe pas pour un
-- appareil : retrait puis republication ou republication puis retrait laissent les mêmes projections.
--
-- Retour arrière : supprime les lignes ajoutées ici et, avec elles, toute autre ligne `USER` du jeu (publiées depuis par
-- l'application, que l'ancienne projection ne sert pas) ; les appareils qui avaient déjà appliqué le retrait n'ont plus
-- d'affectations d'autrui, ce que personne ne regrettera.
--
-- migrate:up transaction:false

INSERT INTO sync_change_feed (dataset, entity_type, entity_id, change_type, scope_type, scope_id, row_version)
SELECT 'role_assignment', 'ROLE_ASSIGNMENT', published.entity_id, 'SCOPE_EXIT', 'GLOBAL', NULL, 1
  FROM (
    SELECT DISTINCT entity_id
      FROM sync_change_feed
     WHERE dataset = 'role_assignment'
       AND entity_type = 'ROLE_ASSIGNMENT'
       AND scope_type = 'GLOBAL'
       AND change_type = 'UPSERT'
  ) AS published;

INSERT INTO sync_change_feed (dataset, entity_type, entity_id, change_type, scope_type, scope_id, row_version)
SELECT 'role_assignment', 'ROLE_ASSIGNMENT', a.id, 'UPSERT', 'USER', a.user_id, a.version
  FROM identity_user_role_assignments a;

-- migrate:down transaction:false

DELETE FROM sync_change_feed
 WHERE dataset = 'role_assignment'
   AND entity_type = 'ROLE_ASSIGNMENT'
   AND ((scope_type = 'GLOBAL' AND change_type = 'SCOPE_EXIT') OR scope_type = 'USER');
