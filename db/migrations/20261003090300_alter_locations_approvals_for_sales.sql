-- Espaces de noms `organization` et `approvals` (P4-02 2/2, ADR-028 §1, AV-056).
--
-- 1. Emplacement virtuel « à livrer » `V_TO_DELIVER`, rattaché à un SITE (exception à « virtuel ⇒
--    sans site », BR-ADM-010) : un seul actif par site (`active_to_deliver_site`). Il est virtuel
--    (`is_virtual`), mais exclu de `active_virtual_type`, dont l'unicité globale ne vaut que pour
--    les neuf types globaux. Le nom `ck_organization_locations_virtual_site` est conservé.
-- 2. Types d'opération de validation `PAYMENT_CANCELLATION` et `PAYMENT_DUPLICATE` (annulation d'un
--    encaissement ; décision de la Finance sur un doublon `SUSPECT_DUPLICATE`, AV-056).
--
-- Les listes reprennent l'état actuel de db/schema.sql.
--
-- migrate:up transaction:false

ALTER TABLE organization_locations
  DROP CHECK ck_organization_locations_type,
  DROP CHECK ck_organization_locations_virtual_site;

ALTER TABLE organization_locations
  MODIFY COLUMN is_virtual TINYINT(1) GENERATED ALWAYS AS (location_type IN (
    'V_OPENING', 'V_SUPPLIER', 'V_CUSTOMER', 'V_PRODUCTION', 'V_CONSUMPTION', 'V_LOSS', 'V_PENDING_LOSS',
    'V_ADJUSTMENT', 'V_TRANSIT', 'V_TO_DELIVER'
  )) STORED,
  ADD COLUMN active_to_deliver_site BINARY(16) GENERATED ALWAYS AS (
    IF(location_type = 'V_TO_DELIVER' AND status = 'ACTIVE', site_id, NULL)
  ) STORED,
  ADD UNIQUE KEY uq_organization_locations_active_to_deliver_site (active_to_deliver_site);

ALTER TABLE organization_locations
  ADD CONSTRAINT ck_organization_locations_type CHECK (location_type IN (
    'STORE', 'POS', 'BUILDING', 'PEN', 'INCUBATOR', 'HATCHER', 'MOBILE', 'SLAUGHTERHOUSE',
    'V_OPENING', 'V_SUPPLIER', 'V_CUSTOMER', 'V_PRODUCTION', 'V_CONSUMPTION', 'V_LOSS', 'V_PENDING_LOSS',
    'V_ADJUSTMENT', 'V_TRANSIT', 'V_TO_DELIVER'
  )),
  ADD CONSTRAINT ck_organization_locations_virtual_site CHECK (
    (is_virtual = TRUE AND site_id IS NULL AND location_type <> 'V_TO_DELIVER')
    OR (is_virtual = FALSE AND site_id IS NOT NULL)
    OR (location_type = 'V_TO_DELIVER' AND site_id IS NOT NULL)
  );

ALTER TABLE approvals_control_policies DROP CHECK ck_approvals_control_policies_operation_type;
ALTER TABLE approvals_control_policies ADD CONSTRAINT ck_approvals_control_policies_operation_type CHECK (operation_type IN (
  'LOSS_DECLARATION', 'MORTALITY', 'INVENTORY_ADJUSTMENT', 'TRANSFER_DISCREPANCY', 'EXPENSE',
  'PURCHASE_REQUEST', 'PURCHASE_ORDER', 'RECEIPT_WITHOUT_PO', 'RECEIPT_VALUE', 'SUPPLIER_PAYMENT',
  'PRICE_OVERRIDE', 'SALE_CANCELLATION', 'CREDIT_LIMIT_EXCEEDED', 'CASH_VARIANCE', 'CHECKIN_OVERRIDE',
  'RECEIPT_QUARANTINE', 'RECEIPT_CANCELLATION', 'ANIMAL_COUNT_ADJUSTMENT',
  'PAYMENT_CANCELLATION', 'PAYMENT_DUPLICATE'
));

-- migrate:down transaction:false
-- Un seul ALTER par table : en cas d'échec (emplacement V_TO_DELIVER ou politique PAYMENT_*
-- existants), l'instruction est annulée en bloc et les contraintes d'origine restent en place.

ALTER TABLE approvals_control_policies
  DROP CHECK ck_approvals_control_policies_operation_type,
  ADD CONSTRAINT ck_approvals_control_policies_operation_type CHECK (operation_type IN (
    'LOSS_DECLARATION', 'MORTALITY', 'INVENTORY_ADJUSTMENT', 'TRANSFER_DISCREPANCY', 'EXPENSE',
    'PURCHASE_REQUEST', 'PURCHASE_ORDER', 'RECEIPT_WITHOUT_PO', 'RECEIPT_VALUE', 'SUPPLIER_PAYMENT',
    'PRICE_OVERRIDE', 'SALE_CANCELLATION', 'CREDIT_LIMIT_EXCEEDED', 'CASH_VARIANCE', 'CHECKIN_OVERRIDE',
    'RECEIPT_QUARANTINE', 'RECEIPT_CANCELLATION', 'ANIMAL_COUNT_ADJUSTMENT'
  ));

ALTER TABLE organization_locations
  DROP CHECK ck_organization_locations_type,
  DROP CHECK ck_organization_locations_virtual_site,
  DROP KEY uq_organization_locations_active_to_deliver_site,
  DROP COLUMN active_to_deliver_site,
  MODIFY COLUMN is_virtual TINYINT(1) GENERATED ALWAYS AS (location_type IN (
    'V_OPENING', 'V_SUPPLIER', 'V_CUSTOMER', 'V_PRODUCTION', 'V_CONSUMPTION', 'V_LOSS', 'V_PENDING_LOSS',
    'V_ADJUSTMENT', 'V_TRANSIT'
  )) STORED,
  ADD CONSTRAINT ck_organization_locations_type CHECK (location_type IN (
    'STORE', 'POS', 'BUILDING', 'PEN', 'INCUBATOR', 'HATCHER', 'MOBILE', 'SLAUGHTERHOUSE',
    'V_OPENING', 'V_SUPPLIER', 'V_CUSTOMER', 'V_PRODUCTION', 'V_CONSUMPTION', 'V_LOSS', 'V_PENDING_LOSS',
    'V_ADJUSTMENT', 'V_TRANSIT'
  )),
  ADD CONSTRAINT ck_organization_locations_virtual_site CHECK (
    (is_virtual = TRUE AND site_id IS NULL) OR (is_virtual = FALSE AND site_id IS NOT NULL)
  );
