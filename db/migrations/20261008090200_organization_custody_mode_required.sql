-- Module `organization`, mode de garde obligatoire et source unique (P5-05). Source : ADR-033 §2 ;
-- BR-STK-010 (« chaque emplacement physique a un mode de garde »), BR-DIS-002, BR-ADM-009 ; AV-163 ;
-- INV-DIS-01.
--
-- Avant cette migration le mode était facultatif : le code traitait son absence comme `SHARED` en
-- silence, et la configuration d'un PDV (`organization_points_of_sale`) ne le reportait jamais sur
-- l'emplacement de vente, seul lu par le stock, les ventes et la synchronisation (deux sources de
-- vérité). Désormais :
-- 1. les emplacements existants sans mode reçoivent le défaut de leur type (stock mobile :
--    `EXCLUSIVE_USER` ; tout autre emplacement physique : `SHARED`) ;
-- 2. l'emplacement de vente d'un PDV déjà configuré reprend le mode et l'appareil désigné de sa
--    configuration ;
-- 3. à l'insertion, un mode absent est rempli par le même défaut (les commandes l'écrivent déjà
--    explicitement ; le déclencheur couvre tout autre chemin) ;
-- 4. un emplacement physique sans mode est refusé (`CHECK`).
--
-- migrate:up transaction:false

UPDATE organization_locations
   SET custody_mode = CASE WHEN location_type = 'MOBILE' THEN 'EXCLUSIVE_USER' ELSE 'SHARED' END
 WHERE custody_mode IS NULL AND is_virtual = FALSE;

UPDATE organization_locations l
  JOIN organization_points_of_sale p ON p.sales_location_id = l.id
   SET l.custody_mode = p.custody_mode,
       l.designated_device_id = p.designated_device_id;

CREATE TRIGGER trg_organization_locations_custody_default BEFORE INSERT ON organization_locations FOR EACH ROW
BEGIN
  IF NEW.custody_mode IS NULL AND LEFT(NEW.location_type, 2) <> 'V_' THEN
    SET NEW.custody_mode = IF(NEW.location_type = 'MOBILE', 'EXCLUSIVE_USER', 'SHARED');
  END IF;
END;

ALTER TABLE organization_locations
  ADD CONSTRAINT ck_organization_locations_custody_required CHECK (is_virtual = TRUE OR custody_mode IS NOT NULL);

-- migrate:down transaction:false
-- Les modes remplis restent en place : ils sont valides sous l'ancien schéma, où le mode était facultatif.
ALTER TABLE organization_locations DROP CHECK ck_organization_locations_custody_required;
DROP TRIGGER trg_organization_locations_custody_default;
