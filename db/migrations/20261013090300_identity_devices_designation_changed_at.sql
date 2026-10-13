-- Module `identity`, date du dernier rattachement d'un appareil (P5-23, revue adverse ; AV-243). Source :
-- BR-DIS-003, BR-STK-016 ; dictionnaire 01-identity (`identity_devices.designation_changed_at`).
--
-- La garde d'appareil des faits hors ligne signale `DEVICE_OTHER_SITE` quand l'appareil est rattaché à un
-- autre site que l'emplacement (`designated_site_id`, lu au présent). Un appareil rattaché à un autre site
-- après avoir vendu hors ligne voyait ses ventes antérieures signalées à tort. `identity.device.designate`
-- pose désormais la date d'effet du rattachement (`occurred_at`) : un fait antérieur n'est pas jugé sur un
-- rattachement plus récent (signal informatif seulement : on préfère l'omettre que le donner à tort). NULL
-- pour un rattachement antérieur à cette colonne : jugé comme avant.
--
-- migrate:up transaction:false

ALTER TABLE identity_devices
  ADD COLUMN designation_changed_at DATETIME(6) NULL AFTER designated_site_id;

-- migrate:down transaction:false

ALTER TABLE identity_devices DROP COLUMN designation_changed_at;
