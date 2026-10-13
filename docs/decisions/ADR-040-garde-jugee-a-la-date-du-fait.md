# ADR-040 — Garde d'un emplacement jugée à la date du fait hors ligne

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; P5-23, revue adverse)
- **Date** : 13/10/2026
- **Précise** : [ADR-033](ADR-033-quotas-d-appareil-apres-adr-028.md) §2 (garde des emplacements) ; BR-STK-016, BR-DIS-003
- **Questions liées** : AV-195 (2), AV-243

## Contexte

Un fait saisi hors ligne (vente, perte, transfert, réception sans document, mouvement interne) est contrôlé à son arrivée par la garde d'appareil (`custodyMismatch`, `inventory`). Le contrôle vérifie que l'appareil est bien :
- l'appareil désigné d'un emplacement `EXCLUSIVE_DEVICE` ;
- l'appareil principal du détenteur d'un emplacement `EXCLUSIVE_USER` ;
- un appareil qui n'est pas rattaché à un autre site.

Sinon, le fait est appliqué (BR-SYN-007), avec un conflit informatif `CUSTODY_DEVICE_MISMATCH`.

Ce contrôle lisait la garde **courante** de l'emplacement et le rattachement **courant** de l'appareil, d'où trois effets :
- **Faux conflit au changement d'appareil désigné.** Exemple : la tablette d'un PDV est perdue, puis remplacée par `organization.pos.configure` (BR-DIS-014 le permet). Ses ventes antérieures à la perte, poussées ensuite, sont acceptées par le contrôle d'appareil (RC-02). Elles étaient pourtant signalées `DEVICE_NOT_DESIGNATED` face au nouvel appareil.
- **Mauvaise règle au changement de mode.** Un fait d'une période exclusive, synchronisé après le passage en garde partagée, était jugé sous les règles du partage. Il consommait des quotas, ou ouvrait un faux `ALLOCATION_EXCEEDED` (AV-166).
- **Faux `DEVICE_OTHER_SITE`** quand l'appareil est rattaché à un autre site après avoir vendu.

## Décision

1. **Historique des gardes.** La table `organization_location_custody_periods` (module `organization`) consigne chaque période de garde : mode, appareil désigné, `[valid_from, valid_to)`.
   - Elle est écrite par `organization.location.create` (période initiale) et par `organization.pos.configure`. Une période ne naît que si le couple (mode, appareil) change : un rejeu est sans effet. Elle commence à l'`occurred_at` de la commande, jamais avant le début de la période qu'elle ferme.
   - Fermer une période consiste à poser `valid_to`, une seule fois. Rien d'autre ne se modifie et rien ne se supprime (déclencheurs).
   - Amorçage : une période ouverte par emplacement physique, avec son état courant, depuis sa création.
   - INV-DIS-03 : au plus une période ouverte par emplacement, égale à la garde courante ; les périodes sont contiguës.
2. **Jugement à la date du fait.** Pour un fait hors ligne, la garde retenue est celle de la période qui couvre son `occurred_at` (`custodyAt`, API publique d'`organization`).
   - À défaut, c'est la plus ancienne période qui a une durée. Une période vide (deux changements de même date) n'a jamais été en vigueur.
   - Sans aucune période (emplacement inséré avant l'historique), c'est la garde courante.
   - La règle vaut pour l'appareil désigné, et pour le partage ou non : un fait d'une période exclusive ne consomme ni ne signale aucun quota. Elle s'applique à `prepareQuotaConsumption`, à la réception sans document et au mouvement interne.
   - Un fait **en ligne** garde l'état courant : il est contemporain de son contrôle.
3. **Rattachement d'un appareil** (AV-243). `identity.device.designate` pose `designation_changed_at` à l'`occurred_at` de la commande. Un fait antérieur au dernier rattachement n'est pas jugé `DEVICE_OTHER_SITE`. Le signal étant informatif, on préfère l'omettre que le donner à tort ; seul le dernier rattachement est daté.
4. **Ce qui reste au présent** :
   - les décisions de verrouillage et d'état présent (`record-move.ts` : verrou des soldes selon le mode courant ; `checkOvercommitted`) ;
   - le détenteur d'un stock mobile (`EXCLUSIVE_USER`), qui ne change jamais : `location.update` ne l'expose pas ;
   - l'appareil principal du détenteur (`primary_device_id`), qu'aucune commande n'écrit encore (S-44).

## Conséquences

- Plus de faux `CUSTODY_DEVICE_MISMATCH` pour un fait antérieur à un changement de garde. La précision à la frontière d'une période est celle de l'horloge de l'appareil (ADR-016) ; l'effet se limite à un signal, jamais à un rejet.
- Une lecture de plus par fait hors ligne (période couvrante, index `(location_id, valid_from)`), sans verrou. Une configuration validée à l'instant même peut ne pas être vue ; seul un signal informatif en dépend.
- `organization.pos.configure` écrit l'historique sous le verrou exclusif de l'emplacement de vente, déjà pris en premier (ADR-038, résidus) ; la période ouverte est relue `FOR UPDATE`.
- Tests :
  - `inventory-allocation-consumption.test.ts` : changement d'appareil désigné, passage d'exclusif à partagé, période vide de même date, rattachement postérieur ;
  - `organization-pos-config.test.ts` : périodes écrites par les commandes, `custodyAt` ;
  - `p5-invariants.test.ts` : INV-DIS-03.

## Alternatives

- **Colonne de date de changement sur l'emplacement** (un seul niveau d'historique) : deux changements rapprochés font mal juger les faits de la période intermédiaire. Écartée.
- **Tolérance d'horloge à la frontière** (paramètre `organization.custody_change_grace_minutes`) : rien ne la demande aujourd'hui ; elle reste possible sans changer le schéma.
- **Historique tenu par déclencheur `AFTER UPDATE`** : il donnerait deux sources de vérité, aucun déclencheur du dépôt n'écrit de données, et il manquerait l'auteur et la commande. Écarté.
