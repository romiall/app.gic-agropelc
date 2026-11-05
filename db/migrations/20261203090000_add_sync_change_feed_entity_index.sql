-- Index d'entité du flux de changements (AV-520, BR-SYN-015). La compaction du flux supprime les lignes de plus de
-- 60 jours qu'une ligne plus récente remplace pour la même entité et la même portée
-- (apps/server/src/platform/sync/change-feed-purge.ts) : pour chaque candidate, elle cherche « une ligne plus
-- récente de cette entité ». Les index existants ((scope_type, scope_id, seq) et (dataset, seq)) ne servent pas cette
-- recherche, qui parcourrait le jeu entier pour chaque ligne.
--
-- Aucune donnée n'est touchée ; l'index se pose en ligne. Retour arrière : il se supprime sans perte.
--
-- migrate:up transaction:false

ALTER TABLE sync_change_feed ADD KEY ix_sync_change_feed_entity (entity_id, seq);

-- migrate:down transaction:false

ALTER TABLE sync_change_feed DROP KEY ix_sync_change_feed_entity;
