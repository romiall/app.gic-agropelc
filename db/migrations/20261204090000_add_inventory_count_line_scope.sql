-- Portée d'une ligne d'inventaire et recherche des lignes à rapprocher (BR-STK-044, BR-STK-045, INV-STK-09).
--
-- `all_lots` : 1 quand la ligne, sans lot, porte sur tous les lots du produit dans l'emplacement (le compteur a donné
-- un total sans détailler les lots) : le théorique est le total des soldes et l'écart se répartit sur les lots en FIFO
-- inverse. 0 : un lot désigné, ou le seul solde sans lot, comportement de toutes les lignes existantes.
--
-- L'index sert la recherche faite à chaque mouvement enregistré, « une ligne comptée de ce produit à un instant égal ou
-- postérieur à celui du mouvement » : elle est vide pour un mouvement du jour, donc sans coût, et ne rend que les
-- comptages récents pour un fait saisi hors ligne puis synchronisé tard.
--
-- Aucune donnée n'est touchée. Retour arrière sans perte.
--
-- migrate:up transaction:false

ALTER TABLE inventory_inventory_count_lines
  ADD COLUMN all_lots TINYINT(1) NOT NULL DEFAULT 0 AFTER lot_key,
  ADD KEY ix_inventory_inventory_count_lines_product_counted (product_id, counted_at);

-- migrate:down transaction:false
-- La clé étrangère `product_id` n'avait que son index implicite : à l'ajout de l'index ci-dessus, MySQL l'a retiré et
-- s'appuie désormais sur celui-ci, qu'il refuse donc de laisser tomber (erreur 1553). La clé étrangère est retirée puis
-- recréée : MySQL lui rend ainsi son index implicite d'origine, et l'index peut alors partir.

ALTER TABLE inventory_inventory_count_lines
  DROP FOREIGN KEY fk_inventory_inventory_count_lines_product;

ALTER TABLE inventory_inventory_count_lines
  DROP KEY ix_inventory_inventory_count_lines_product_counted,
  DROP COLUMN all_lots;

ALTER TABLE inventory_inventory_count_lines
  ADD CONSTRAINT fk_inventory_inventory_count_lines_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT;
