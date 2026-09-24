# Glossaire métier (Livrable n°1)

> Dictionnaire de référence. **Un terme = un concept = un identifiant technique.** Les synonymes à proscrire sont listés au §13.
> Colonnes : Terme | Définition | Exemple | Entités liées (identifiants techniques) | Statut (C = CONFIRMÉ, D = DÉDUIT, AV = À VALIDER avec renvoi).

---

## 1. Organisation, personnes, accès

| Terme | Définition | Exemple | Entités liées | Statut |
|---|---|---|---|---|
| **Utilisateur** | Personne disposant d'un compte d'accès nominatif. Un utilisateur peut cumuler plusieurs rôles. | Paul, responsable commercial et commercial terrain | `identity.users` | C (CM §6, §47) |
| **Rôle** | Ensemble nommé de permissions correspondant à une fonction métier. | `COMMERCIAL_TERRAIN` | `identity.roles`, `identity.role_permissions` | C (CM §47) |
| **Permission** | Droit élémentaire d'exécuter une action sur une ressource, avec une portée maximale. | `sales.sale.record` portée `OWN` | `identity.permissions` | C (PM §17) |
| **Affectation de rôle** | Attribution d'un rôle à un utilisateur, bornée dans le temps et limitée à un périmètre (global, site, zone, équipe). | Rôle `VENDEUR_PDV` sur le site « PDV Marché Mboppi » | `identity.user_role_assignments` | C (PM §17) / D (bornage temporel) |
| **Portée** (scope) | Étendue des données sur lesquelles une permission s'exerce : `OWN` (propre), `TEAM` (équipe), `ZONE`, `SITE`, `ALL` (tout). | Un commercial lit les clients `OWN` | `identity.role_permissions.max_scope` | C (PM §31) |
| **Équipe** | Groupe de commerciaux placé sous la responsabilité d'un responsable commercial. | Équipe Douala Nord | `organization.teams`, `organization.team_memberships` | D (CM §6 « sous sa responsabilité », §48 « son équipe ») |
| **Appareil** | Terminal (téléphone, tablette, ordinateur) enregistré dans le système, identifié de manière unique et autorisé à synchroniser. | Tablette PDV-02 | `identity.devices` | C (CM §57/Core, PM §5) |
| **Enrôlement** | Première association d'un appareil au système, soumise à approbation. | — | `identity.devices.status` | D / AV-006 |
| **Session d'authentification** | Période de validité des jetons d'accès d'un utilisateur sur un appareil. À ne pas confondre avec la session de travail ni avec la session de caisse. | — | `identity.auth_sessions` | D |
| **Site** | Lieu physique d'activité de GIC AGROPELC : ferme, magasin (entrepôt), point de vente ou bureau. | Ferme de Nkometou ; PDV Marché Sandaga | `organization.sites` | C (CM §57/Core, §12, §22) |
| **Point de vente (PDV)** | Site commercial fonctionnant comme un mini-magasin : stock affecté, vendeurs, prix applicables, caisse, ventes, pertes, transferts, inventaires. | PDV Marché Mboppi | `organization.sites` (type `POINT_DE_VENTE`) + `organization.points_of_sale` | C (CM §12, PM §14) |
| **Magasin** | Site ou emplacement de stockage central de marchandises ou d'intrants. | Magasin central Douala | `organization.sites` (type `MAGASIN`) | C (CM §22) |
| **Ferme** | Site de production animale. | Ferme de Nkometou | `organization.sites` (type `FERME`) | C (CM §1, §22) |
| **Emplacement** | Lieu précis où un stock peut exister. Il peut être physique (bâtiment, case, magasin, rayon d'un PDV, incubateur, éclosoir, stock mobile d'un utilisateur) ou virtuel (fournisseurs, clients, pertes, transit…). **Toute quantité de stock est rattachée à un emplacement.** | Bâtiment B2 de la ferme ; stock mobile de Paul | `organization.locations` | D (CM §2/Stock « Où se trouve-t-il ? ») |
| **Bâtiment** | Emplacement physique d'élevage d'une ferme. | Bâtiment B2 (poulets de chair) | `organization.locations` (type `BUILDING`) | C (CM §15, §57) |
| **Case** | Subdivision d'un bâtiment porcin. | Case P-04 | `organization.locations` (type `PEN`, parent = bâtiment) | C (CM §19) |
| **Stock mobile** | Emplacement de type `MOBILE` rattaché à un utilisateur (commercial, vendeur, livreur), qui détient physiquement la marchandise et en est responsable. | « Stock de Paul » : 50 poulets | `organization.locations` (type `MOBILE`, `custodian_user_id`) | D (CM §23) |
| **Emplacement virtuel** | Emplacement non physique qui matérialise l'origine ou la destination externe d'un mouvement : `V_SUPPLIER`, `V_CUSTOMER`, `V_PRODUCTION`, `V_CONSUMPTION`, `V_LOSS`, `V_PENDING_LOSS`, `V_ADJUSTMENT`, `V_TRANSIT`, `V_OPENING`. | Une vente déplace de « PDV » vers `V_CUSTOMER` | `organization.locations` (`is_virtual = true`) | D (ADR-003) |
| **Zone** | Découpage géographique ou commercial hiérarchique (ville, marché, quartier, secteur), utilisé pour la tarification, le portefeuille, l'analyse et le pointage. | Douala > Akwa > Marché Sandaga | `organization.zones` | C (CM §9, §10, §29) / AV-003 (niveaux) |
| **Géorepère** (zone de pointage) | Cercle (point de référence + rayon) attaché à une zone ou à un site, dans lequel la prise de service est acceptée. | Centre Marché Sandaga, rayon 500 m | `organization.zones.geofence_*` | C (CM §10, 500 m) / AV-003, AV-022 |
| **Paramètre système** | Valeur de configuration historisée (seuils, délais, rayons). | Rayon de pointage par défaut = 500 m | `organization.system_settings` | D |

## 2. Commercial et CRM

| Terme | Définition | Exemple | Entités liées | Statut |
|---|---|---|---|---|
| **Compte client** | Tiers commercial suivi par GIC AGROPELC, **prospect ou client**. Un seul enregistrement suit la personne ou l'entreprise de la prospection jusqu'à la fidélisation. | Restaurant « Chez Mama » | `crm.customers` | D (ADR-017) |
| **Prospect** | Compte client au stade `PROSPECT` : identifié, pas encore converti. | — | `crm.customers.stage = PROSPECT` | C (CM §7) |
| **Client** | Compte client au stade `CUSTOMER`, ayant effectué au moins une vente confirmée (règle de conversion AV-012). | — | `crm.customers.stage = CUSTOMER` | C (CM §7) / AV-012 |
| **Client perdu** | Compte client au stade `LOST` : prospect abandonné, avec motif. | — | `crm.customers.stage = LOST` | D (PM §24) |
| **Conversion** | Passage de `PROSPECT` à `CUSTOMER`. | Première vente du restaurant | `crm.customer_stage_history`, événement `CustomerConverted` | C (CM §7) |
| **Étape de pipeline** | Sous-étape configurable du stade `PROSPECT` (NOUVEAU, CONTACTÉ, INTÉRESSÉ, NÉGOCIATION). | — | `crm.pipeline_steps` | AV-011 |
| **Client actif / inactif** | Qualificatif **calculé** d'un client selon la date de sa dernière vente confirmée. Jamais saisi. | Inactif : aucune vente depuis 30 jours | vue analytique | C (CM §9) / AV-013 (délai) |
| **Acquéreur** | Utilisateur ayant créé ou acquis le compte client. **Immuable.** | Paul a acquis le client X | `crm.customers.acquired_by_user_id` | C (CM §7 « Qui les a acquis ? ») |
| **Titulaire** (commercial responsable) | Utilisateur qui gère actuellement le compte client (portefeuille). Historisé. | Marie gère X depuis le 01/10 | `crm.customer_assignments`, `crm.customers.owner_user_id` | C (CM §8) |
| **Portefeuille** | Ensemble des comptes clients dont un utilisateur est titulaire à une date donnée. | — | `crm.customer_assignments` | C (CM §8) |
| **Réaffectation** | Changement de titulaire d'un compte client, historisé. | — | `crm.customer_assignments`, événement `CustomerReassigned` | C (CM §8) |
| **Visite** | Rencontre physique enregistrée d'un commercial avec un compte client, géolocalisée si possible. | Visite du 12/10 à 10 h 20, résultat « intéressé » | `crm.visits` | C (CM §7, §10) |
| **Interaction** | Contact non physique enregistré (appel, SMS, message, e-mail) hors canaux gérés par Kommo. | Appel de relance | `crm.interactions` | C (CM §7) / AV-019 |
| **Résultat de visite** | Code de l'issue d'une visite (référentiel). | `COMMANDE_PRISE`, `A_RELANCER`, `ABSENT` | `catalog.reason_codes` (catégorie `VISIT_OUTCOME`) | D |
| **Prochaine action** | Action planifiée à l'issue d'une visite ou interaction (date + note), qui alimente « actions à réaliser ». | Relancer le 15/10 | `crm.visits.next_action_at` | D (CM §34.3) |
| **Objectif commercial** | Valeur cible d'une métrique pour une cible (utilisateur, équipe, PDV) sur une période. | CA de 2 000 000 XAF en octobre pour Paul | `crm.sales_targets` | C (CM §34.3, §57) / AV-016 |
| **Source (de prospect)** | Origine de l'acquisition du compte client. | `PROSPECTION_TERRAIN`, `KOMMO` | `crm.customers.source_code`, `crm.lead_sources` | C (CM §7) / AV-018 |
| **Canal de vente** | Canal par lequel une commande ou une vente est obtenue. | `POINT_DE_VENTE`, `WHATSAPP` | `crm.sales_channels`, `sales.sales.channel_code` | C (CM §11) / AV-018 |
| **Catégorie de client** | Classification utilisée pour la tarification et l'analyse. | `REVENDEUR` | `crm.customer_categories` | C (CM §29 « type de client ») / AV-017 |
| **Commercial terrain** | Utilisateur qui prospecte physiquement. | — | rôle `COMMERCIAL_TERRAIN` | C (CM §6) |
| **Commercial sédentaire** | Utilisateur qui travaille depuis un bureau ou les canaux digitaux. | — | rôle `COMMERCIAL_SEDENTAIRE` | C (CM §6) |
| **Vendeur (de PDV)** | Utilisateur qui vend depuis un point de vente. | — | rôle `VENDEUR_PDV` | C (CM §6) |
| **Vendeur exécutant** | Utilisateur ayant matériellement enregistré la vente. | — | `sales.sales.seller_user_id` | D (CM §13 « un vendeur ») |
| **Commercial attribué** | Commercial à qui la vente est attribuée pour la performance : le titulaire du client à `occurred_at`, sinon le vendeur exécutant. Figé sur la vente. | — | `sales.sales.commercial_user_id` | D (CM §8, §13) |

## 3. Pointage terrain

| Terme | Définition | Exemple | Entités liées | Statut |
|---|---|---|---|---|
| **Prise de service** | Déclaration géolocalisée du début d'activité d'un commercial terrain dans une zone déclarée. | 07 h 58, zone Akwa, précision 25 m | `fieldwork.geo_checkins` (type `START_SERVICE`) | C (CM §10) |
| **Fin de service** | Déclaration (optionnelle) de fin d'activité, géolocalisée. | — | `fieldwork.geo_checkins` (type `END_SERVICE`) | C (CM §10 « éventuellement ») |
| **Tentative de pointage** | Tout essai de prise ou de fin de service, accepté ou refusé, conservé pour audit. | Tentative refusée à 1,8 km de la zone | `fieldwork.geo_checkins` | C (CM §10) |
| **Session de travail** | Période d'activité terrain ouverte par une prise de service acceptée (ou dérogée) et fermée par une fin de service ou une clôture automatique. | — | `fieldwork.work_sessions` | D (CM §10, §50) |
| **Dérogation de pointage** | Validation par un responsable d'une prise de service refusée ou imprécise. | — | `approvals.approval_requests` (type `CHECKIN_OVERRIDE`) | AV-021 |

## 4. Produits, unités, référentiels

| Terme | Définition | Exemple | Entités liées | Statut |
|---|---|---|---|---|
| **Produit** | Article suivi en stock et/ou vendu, acheté ou produit : animal, œuf, intrant, marchandise, emballage, service. | « Poulet de chair vif » ; « Aliment démarrage 50 kg » | `catalog.products` | C (CM §5.1, §20) |
| **Famille de stock** | Classification du produit selon le CM §20 : `BIOLOGIQUE`, `PRODUCTION_COMMERCIALISABLE`, `INTRANT`, `MARCHANDISE`, `EMBALLAGE_CONSOMMABLE`, `SERVICE` (non stocké). | Aliment = `INTRANT` | `catalog.products.stock_family` | C (CM §20) / D (`SERVICE`) |
| **Unité de base** | Unité dans laquelle le stock d'un produit est compté dans le registre. | Tête, œuf, kg | `catalog.products.base_unit_code` | D |
| **Unité de conditionnement** | Unité de saisie convertible en unité de base par un facteur. | Plateau = 30 œufs ; sac = 50 kg | `catalog.product_units` | D / AV-080 |
| **Mode de tarification** | Le prix s'applique par unité (`PER_UNIT`) ou par poids (`PER_WEIGHT`). | — | `catalog.products.pricing_mode` | AV-031 |
| **Code motif** | Élément de référentiel expliquant une opération (perte, rejet, ajustement, annulation, dérogation de prix, résultat de visite). | `CASSE_TRANSPORT` | `catalog.reason_codes` | C (CM §24 « motif ») |
| **Suivi par lot** | Indique si le produit doit (`REQUIRED`), peut (`OPTIONAL`) ou ne doit pas (`NONE`) porter un lot dans le registre. | Poulet vif : `REQUIRED` | `catalog.products.lot_tracking` | AV-036 |

## 5. Stock

| Terme | Définition | Exemple | Entités liées | Statut |
|---|---|---|---|---|
| **Mouvement de stock** | Enregistrement immuable du déplacement d'une quantité positive d'un produit d'un emplacement source vers un emplacement destination, pour une cause métier, à un instant réel. **Seule façon de faire varier un stock.** | 3 poulets de « PDV Mboppi » vers `V_CUSTOMER` (vente) | `inventory.stock_moves` | C (CM §21, PM §6) / D (partie double, ADR-003) |
| **Type de mouvement** | Cause métier normalisée d'un mouvement (réception, vente, transfert, perte, consommation, production, ajustement, contre-passation…). | `SALE` | `inventory.stock_moves.move_type` | C (CM §21 « causes ») |
| **Registre de stock** (ledger) | Ensemble ordonné des mouvements, en ajout seul. | — | `inventory.stock_moves` | C (PM §6) |
| **Solde de stock** (stock théorique) | Quantité calculée d'un produit (et d'un lot) dans un emplacement = entrées − sorties du registre. Projection reconstructible. | 97 poulets au PDV | `inventory.stock_balances` | C (CM §25 « stock théorique ») |
| **Stock physique** | Quantité effectivement constatée lors d'un inventaire. | 94 | `inventory.inventory_count_lines.counted_qty` | C (CM §25) |
| **Écart d'inventaire** | Stock physique − stock théorique, justifié et régularisé par un mouvement d'ajustement. | −3 | `inventory.inventory_count_lines.variance_qty` | C (CM §25, §60) |
| **Stock disponible** | Solde − quantités réservées − quantités allouées restantes à d'autres détenteurs. Quantité qu'un nouvel utilisateur peut encore consommer. Les pertes en attente sont déjà sorties du solde (déplacées vers `V_PENDING_LOSS`). | — | calcul sur `stock_balances` | C (CM §2/Stock) / D (formule) |
| **Stock biologique** | Animaux vivants en élevage (en bâtiment ou case). | 2 310 poulets du lot L-2026-014 en B2 | soldes des produits `BIOLOGIQUE` dans des emplacements `BUILDING`/`PEN` | C (CM §20) |
| **Stock commercial** | Stock affecté à un magasin, un PDV, un vendeur ou une zone de distribution, destiné à la vente. | — | soldes dans des emplacements `STORE`, `POS`, `MOBILE` | C (CM §20) |
| **Intrant** | Produit consommé par la production ou l'exploitation (aliment, maïs, soja, médicament, vaccin, produit sanitaire, emballage, alvéole). | — | `catalog.products.stock_family = INTRANT` | C (CM §20) |
| **Lot de stock** (lot de traçabilité) | Dimension de traçabilité d'un mouvement : lot de production d'origine, lot fournisseur ou lot de collecte. | Lot L-2026-014 | `inventory.stock_lots` | D (CM §2 « de quel lot provient-il ») |
| **Transfert** | Document de déplacement d'un stock entre deux emplacements physiques, en deux temps (expédition, réception), avec traçabilité des écarts. | Magasin → PDV Mboppi : 100 poulets expédiés, 98 reçus | `inventory.stock_transfers` | C (CM §22) |
| **Demande de réapprovisionnement** | Transfert à l'état `REQUESTED`, émis par le destinataire. | Le PDV demande 60 plateaux | `inventory.stock_transfers.status = REQUESTED` | D (CM §12 « réapprovisionnement ») |
| **Écart de transfert** | Différence entre quantité expédiée et quantité reçue ; traitée comme une perte en transit à justifier. | 2 poulets | `inventory.stock_transfer_lines.discrepancy_qty` | C (CM §22 « différences ») |
| **Affectation de stock** | Remise physique d'une quantité à un utilisateur, qui en devient responsable : transfert vers son stock mobile. | Paul reçoit 50 poulets | `inventory.stock_transfers` vers un emplacement `MOBILE` | C (CM §23) |
| **Allocation** (quota hors ligne) | Droit exclusif, accordé à un couple (utilisateur, appareil), de consommer hors ligne une quantité d'un produit dans un emplacement **partagé**, sans déplacement physique. | Vendeur A : 30 poulets sur le stock du PDV | `inventory.stock_allocations` (type `DEVICE_QUOTA`) | C (CM §39, PM §6) / D (forme) / AV-035 |
| **Réservation** | Quantité d'un emplacement bloquée pour une commande client confirmée. | 20 plateaux réservés pour la commande C-123 | `inventory.stock_allocations` (type `ORDER_RESERVATION`) | C (PM §6 « réservation ») / D |
| **Perte** (déclaration de perte) | Document déclarant une sortie de stock sans contrepartie commerciale : mortalité, casse, détérioration, impropre, destruction, inexpliquée, vol suspecté. | 12 œufs cassés au PDV | `inventory.loss_declarations` | C (CM §24) |
| **Perte en attente** | Quantité retirée du disponible mais non encore reconnue comme perte, dans l'attente d'une validation. | — | emplacement `V_PENDING_LOSS` | D (ADR-003) |
| **Consommation** | Sortie d'un intrant utilisé par un lot, un site ou un PDV, imputée à un objet de coût. | 6 sacs d'aliment pour le lot L-2026-014 | `inventory.consumptions` | C (CM §21 « consommation ») |
| **Inventaire** | Document de comptage physique d'un emplacement, comparant théorique et physique et générant les ajustements. | Inventaire mensuel PDV Mboppi | `inventory.inventory_counts` | C (CM §25) |
| **Inventaire d'ouverture** | Inventaire initial chargeant le stock existant au démarrage d'un emplacement. | — | `inventory.inventory_counts.count_type = OPENING` | D (AV-072) |
| **Seuil de réapprovisionnement** | Minimum et cible par emplacement × produit, déclenchant une alerte. | Min 20 plateaux, cible 60 | `inventory.stock_thresholds` | D (CM §12, §54) / AV-040 |
| **Valorisation** | Valeur monétaire d'un stock ou d'un mouvement : quantité × coût unitaire figé au moment du mouvement. | — | `inventory.stock_moves.unit_cost_xaf`, `inventory.product_valuations` | C (CM §32) / AV-042 (méthode) |
| **CMUP** | Coût moyen unitaire pondéré, recalculé à chaque entrée valorisée. | — | `inventory.product_valuations` | AV-042 |

## 6. Production

| Terme | Définition | Exemple | Entités liées | Statut |
|---|---|---|---|---|
| **Lot de production** | Groupe d'animaux élevés ensemble, suivi comme une unité de production, de coûts et de performance. Synonyme métier admis : « **campagne de production** ». | Lot L-2026-014 : 2 400 poulets de chair | `production.production_lots` | C (CM §15, §19, §33) |
| **Type de lot** | `POULET_CHAIR`, `PONDEUSE`, `PORC_ENGRAISSEMENT` (options : `REPRODUCTEUR_VOLAILLE`, `PORC_NAISSAGE`). | — | `production.production_lots.lot_type` | C (CM §14–§19) / AV-044 |
| **Mise en place** | Entrée initiale des animaux dans un lot. | 2 400 poussins le 01/09 | `production.lot_entries` (type `PLACEMENT`) | C (CM §15 « quantité initiale, date de démarrage ») |
| **Entrée de lot** | Tout ajout d'animaux à un lot : mise en place, naissance, transfert entrant. | — | `production.lot_entries` | C (CM §19 « entrée ») |
| **Effectif** | Nombre d'animaux vivants d'un lot = somme des soldes de son lot de stock sur tous les emplacements. Jamais saisi. | 2 310 | projection | C (CM §15 « effectif restant ») |
| **Mortalité** | Mort d'animaux d'un lot, enregistrée comme déclaration de perte de catégorie `MORTALITE`. | 4 morts le 12/10 | `inventory.loss_declarations` (catégorie `MORTALITE`, `lot_id`) | C (CM §16) / D (C-09) |
| **Saisie du jour** | Parcours unique de saisie quotidienne d'un lot : mortalité, consommation d'aliment, pesée éventuelle, collecte d'œufs pour un lot de pondeuses, observation. | — | écran `ECR-PRD-02` ; commandes multiples | C (CM §49) |
| **Pesée** | Relevé du poids moyen d'un échantillon d'animaux. | 1,85 kg sur 30 sujets | `production.lot_weighings` | C (CM §15 « poids lorsque disponible ») |
| **Collecte d'œufs** | Relevé quotidien d'un lot de pondeuses : collectés = cassés + non conformes + commercialisables + à couver. | 1 850 collectés | `production.egg_collections` | C (CM §17) |
| **Œuf commercialisable** | Œuf destiné à la vente. | — | produit catégorie œufs de consommation | C (CM §17) |
| **Œuf à couver** | Œuf destiné à l'incubation. | — | produit dédié | C (CM §17) |
| **Lot d'incubation** | Ensemble d'œufs à couver mis en incubation ensemble et suivis jusqu'à l'éclosion. | Lot INC-2026-007 : 600 œufs | `production.incubation_batches` | C (CM §18) |
| **Mirage** | Contrôle des œufs en incubation, qui identifie les infertiles et la mortalité embryonnaire. | 42 infertiles | `production.incubation_events` (type `CANDLING`) | C (CM §18) |
| **Éclosion** | Sortie des poussins de l'éclosoir. | 498 poussins | `production.incubation_events` (type `HATCH`) | C (CM §18) |
| **Taux d'éclosion** | Poussins obtenus ÷ œufs incubés (et ÷ œufs fertiles, en indicateur secondaire). | 83 % | calcul | C (CM §18) |
| **Sortie vers commercialisation** | Transfert d'animaux d'un lot, depuis leur emplacement d'élevage vers un emplacement commercial, ou vente directe depuis la ferme. | — | `inventory.stock_transfers` ou `sales.sales` | C (CM §15) |
| **Clôture de lot** | Fin d'un lot à effectif nul, qui fige ses indicateurs. | — | `production.production_lots.status = CLOSED` | D |
| **Coût de lot** | Somme des coûts imputés au lot (animaux d'origine, intrants consommés, dépenses directes). | — | `inventory.cost_entries` | C (CM §15, §33) / AV-043 |

## 7. Ventes et commandes

| Terme | Définition | Exemple | Entités liées | Statut |
|---|---|---|---|---|
| **Commande client** | Engagement d'un client sur des produits, quantités et prix indicatifs, pour une remise ultérieure. Ne fait pas sortir de stock. | Commande de 20 plateaux pour vendredi | `sales.sales_orders` | C (CM §4, §7) |
| **Vente** | Transaction de remise de produits à un client contre un prix. **Fait sortir le stock**, crée le CA et, si non payée, une créance. | 3 poulets à 4 500 XAF | `sales.sales` | C (CM §13) |
| **Vente directe** | Vente sans commande préalable : la remise est immédiate (PDV, terrain avec stock mobile, vente à la ferme). | — | `sales.sales.sale_type = DIRECT` | D (ADR-014) |
| **Vente sur commande** (livraison) | Vente créée au moment de la remise physique d'une commande. Une livraison partielle crée une vente partielle. | — | `sales.sales.sale_type = ORDER_FULFILMENT` | C (CM §4 « LIVRER ») / AV-024, AV-034 |
| **Vente anonyme** | Vente au comptant sans client identifié. | — | `sales.sales.customer_id` nul | AV-027 |
| **Vente à crédit** | Vente dont tout ou partie reste due, créant une créance. | — | `sales.sales.payment_status ≠ PAID` | C (CM §13 « créance ») / AV-028 |
| **Annulation de vente** | Neutralisation d'une vente confirmée par contre-écriture (mouvements inverses, désaffectation des paiements), jamais par suppression. | — | `sales.sales.status = CANCELLED` | C (CM §41) |
| **Prix appliqué** | Prix unitaire effectivement retenu sur une ligne, figé avec la règle, la version et le motif de dérogation éventuel. | — | `sales.sale_lines.unit_price_xaf`, `price_rule_id` | C (CM §30) |
| **Chiffre d'affaires (CA)** | Somme des montants des ventes confirmées non annulées, datées par `occurred_at`. | — | calcul | C (CM §31) |
| **Panier moyen** | CA ÷ nombre de ventes sur la période. | — | calcul | C (CM §9) |
| **Réachat** | Proportion de clients ayant effectué au moins deux ventes sur la période considérée. | — | calcul | C (CM §9) / D (formule) |

## 8. Approvisionnement

| Terme | Définition | Exemple | Entités liées | Statut |
|---|---|---|---|---|
| **Fournisseur** | Tiers qui fournit des intrants, matières premières, médicaments, équipements, emballages, consommables ou animaux. | Provenderie X | `procurement.suppliers` | C (CM §26) |
| **Besoin** | Constat d'un manque, exprimé par une demande d'achat. Pas d'entité séparée. | — | `procurement.purchase_requests` | C (CM §27) / D (fusion) |
| **Demande d'achat (DA)** | Document interne demandant l'achat de produits, soumis à validation. | DA-2026-031 : 100 sacs d'aliment | `procurement.purchase_requests` | C (CM §27) |
| **Bon de commande fournisseur (BC)** | Engagement envers un fournisseur : produits, quantités, prix. | BC-2026-044 | `procurement.purchase_orders` | C (CM §27) |
| **Réception** | Document constatant ce qui est livré, rejeté et accepté ; seul l'accepté entre en stock. | 98 livrés, 3 rejetés, 95 acceptés | `procurement.goods_receipts` | C (CM §28) |
| **Quantité livrée** | Quantité présentée par le fournisseur. | 98 | `goods_receipt_lines.qty_delivered` | C (CM §28) |
| **Quantité rejetée** | Quantité refusée à la réception (non conforme). | 3 | `goods_receipt_lines.qty_rejected` | C (CM §28) |
| **Quantité acceptée** | Quantité livrée − quantité rejetée ; seule quantité entrant en stock. | 95 | `goods_receipt_lines.qty_accepted` | C (CM §28) |
| **Reliquat** | Quantité commandée − quantité acceptée cumulée, restant attendue sur la commande. | 5 | calcul | D |
| **Facture fournisseur** | Document du fournisseur indiquant le montant dû ; crée une dette fournisseur. | — | `finance.supplier_invoices` | C (CM §27) |
| **Rapprochement** | Comparaison commande ↔ réception ↔ facture (quantités et prix). | — | calcul + anomalies | C (CM §26 « écarts ») / AV-053 |
| **Lot fournisseur** | Référence de lot indiquée par le fournisseur, conservée à la réception. | — | `goods_receipt_lines.supplier_lot_ref` → `inventory.stock_lots` | C (CM §28) |

## 9. Finance

| Terme | Définition | Exemple | Entités liées | Statut |
|---|---|---|---|---|
| **Encaissement** | Somme reçue d'un client, par un moyen de paiement, à un instant réel, affectée à une ou plusieurs ventes ou commandes. | 13 500 XAF en espèces | `sales.customer_payments` | C (CM §31) |
| **Affectation de paiement** | Répartition d'un encaissement sur une vente (règlement) ou une commande (acompte). | — | `sales.payment_allocations` | D |
| **Créance** | Montant restant dû par un client sur ses ventes confirmées = montant des ventes − affectations actives. **Calculée.** | — | vue `sales.v_receivables` | C (CM §13, §31) |
| **Créance en retard** | Créance dont l'échéance est dépassée. | — | calcul sur `sales.sales.due_date` | C (CM §54) |
| **Moyen de paiement** | Mode de règlement (référentiel). | `ESPECES`, `MOBILE_MONEY_MTN` | `finance.payment_methods` | AV-056 |
| **Compte de trésorerie** | Réceptacle d'argent suivi par le système : caisse d'un PDV, caisse centrale, compte mobile money, compte bancaire. | Caisse PDV Mboppi | `finance.cash_accounts` | C (CM §12 « caisse », §31 « caisses ») / D (généralisation) |
| **Session de caisse** | Période d'utilisation d'une caisse de PDV, entre ouverture (fonds compté) et clôture (comptage), avec écart. | — | `finance.cash_sessions` | D (CM §12, §54 « anomalie de caisse ») / AV-057 |
| **Mouvement de trésorerie** | Enregistrement immuable d'une entrée ou sortie d'argent d'un compte de trésorerie. | — | `finance.cash_movements` | D |
| **Remise de fonds** | Transfert d'argent entre deux comptes de trésorerie (PDV → caisse centrale → banque). | — | `finance.cash_transfers` | D |
| **Dépense** | Sortie d'argent pour une charge non stockée, catégorisée, éventuellement imputée à un objet de coût. | Carburant 15 000 XAF | `finance.expenses` | C (CM §31) |
| **Dette fournisseur** | Montant dû à un fournisseur = factures − paiements affectés. | — | vue `finance.v_payables` | C (CM §32) |
| **Paiement fournisseur** | Sortie d'argent réglant une ou plusieurs factures fournisseur. | — | `finance.supplier_payments` | C (CM §27) |
| **Objet de coût** | Entité à laquelle un coût est imputé : lot de production, lot d'incubation, site, PDV. | — | `inventory.cost_entries.cost_object_*` | D (CM §33) |
| **Coût des ventes** (COGS) | Σ quantité vendue × coût unitaire figé sur le mouvement de sortie. | — | calcul | D (CM §31 « marges ») |
| **Marge** | CA − coût des ventes (marge brute), éventuellement − coûts directs imputés. | — | calcul | C (CM §31, §33) |
| **Valeur perdue** | Σ quantité perdue × coût unitaire figé sur le mouvement de perte. | — | calcul | C (CM §32) |

## 10. Tarification

| Terme | Définition | Exemple | Entités liées | Statut |
|---|---|---|---|---|
| **Règle tarifaire** | Prix unitaire d'un produit applicable dans un contexte (zone, site, PDV, catégorie de client, canal, quantité minimale, campagne commerciale) pendant une période de validité, avec une priorité. **Immuable une fois active.** | Poulet vif, Douala, 4 800 XAF à partir du 20/09 | `pricing.price_rules` | C (CM §29, PM §9) |
| **Spécificité** | Score calculé du degré de précision d'une règle ; la règle la plus spécifique l'emporte à priorité égale. | PDV > zone > global | calcul | D (PM §9) |
| **Priorité** | Entier explicite départageant les règles ; une campagne commerciale peut primer sur la grille standard. | — | `pricing.price_rules.priority` | C (PM §9) |
| **Campagne commerciale** | Période commerciale nommée (promotion, saison) à laquelle des règles tarifaires sont rattachées. **Ne pas confondre avec un lot de production.** | « Fêtes de fin d'année 2026 » | `pricing.commercial_campaigns` | C (CM §29 « période commerciale », PM §9) |
| **Dérogation de prix** | Prix appliqué différent du prix résolu, avec permission, motif et éventuellement validation. | Remise de 5 % | `sales.sale_lines.price_source = MANUAL_OVERRIDE` | AV-026 |
| **Écart de prix** (anomalie) | Vente hors ligne dont le prix figé diffère du prix que le serveur aurait résolu à `occurred_at`. | — | anomalie `PRICE_MISMATCH` | AV-063 |

## 11. Traçabilité, contrôle, synchronisation

| Terme | Définition | Exemple | Entités liées | Statut |
|---|---|---|---|---|
| **Heure métier** (`occurred_at`) | Instant réel où l'opération s'est produite, déclaré sur l'appareil. Base de tous les rapports. | Vente à 11 h 47 | colonne `occurred_at` | C (CM §38) |
| **Heure de création appareil** (`client_created_at`) | Horloge de l'appareil au moment de la saisie. | — | colonne `client_created_at` | C (CM §38) |
| **Heure de réception** (`received_at`) | Instant où le serveur reçoit la commande. | 14 h 22 | `sync.command_inbox.received_at` | C (CM §38) |
| **Heure d'application** (`applied_at`) | Instant où le serveur applique la commande (synchronisation effective). | 14 h 23 | `sync.command_inbox.applied_at` | C (CM §38) |
| **Commande** (technique) | Intention d'écriture idempotente, identifiée par un UUID, créée sur l'appareil et appliquée par le serveur. **À distinguer de la commande client.** | `sales.sale.record` | `sync.command_inbox` | D (ADR-007) |
| **Outbox locale** | File des commandes en attente d'envoi sur un appareil. | « 5 opérations en attente » | IndexedDB `outbox` | C (PM §29) |
| **Statut de synchronisation** | État d'une commande locale : `LOCAL_ONLY`, `PENDING_SYNC`, `SYNCING`, `SYNCED`, `SYNCED_WITH_WARNING`, `CONFLICT`, `REJECTED`. | — | outbox locale | C (PM §5) / D (`SYNCED_WITH_WARNING`) |
| **Conflit de synchronisation** | Situation où une commande ne peut pas être appliquée telle quelle à cause d'un état serveur incompatible ; requiert une résolution tracée. | — | `sync.sync_conflicts` | C (PM §30) |
| **Capturé hors ligne** | Indicateur qu'une opération a été saisie sans réseau. | — | colonne `captured_offline` | C (CM §40) |
| **Anomalie** | Fait détecté automatiquement, qui ne bloque pas l'opération mais demande une revue (écart de prix, stock négatif, doublon suspect, écart d'horloge). | — | `communication.alerts` | D |
| **Alerte** | Signal actionnable destiné à un rôle ou à un utilisateur, avec cycle de vie (ouverte, prise en compte, résolue). | Stock faible PDV Mboppi | `communication.alerts` | C (CM §54) |
| **Politique de contrôle** | Règle paramétrable exigeant photo, justification ou validation selon type d'opération, catégorie, quantité ou valeur. | Perte ≥ 25 000 XAF → validation | `approvals.control_policies` | C (CM §24, §42) / D (forme) |
| **Demande de validation** | Instance d'une validation requise pour une opération, avec décision tracée. | — | `approvals.approval_requests` | C (CM §2/Responsabilité « qui l'a validée ») |
| **Pièce justificative** | Fichier (photo, facture, reçu, bon de livraison, document fournisseur) attaché à une opération. | — | `attachments.attachments` | C (CM §42) |
| **Journal d'audit** | Registre en ajout seul des actions sensibles (qui, quoi, quand, où, appareil, avant/après, validation, motif). | — | `audit.audit_log` | C (CM §40, PM §18) |
| **Contre-écriture** (contre-passation) | Enregistrement inverse neutralisant l'effet d'une opération antérieure sans l'effacer. | Mouvement `V_CUSTOMER` → PDV à l'annulation d'une vente | `*.reverses_*_id` | C (CM §41, PM §8) |
| **Note de direction** | Communication interne publiée par la direction vers une audience. | « Nouveau prix du poulet au 20/09 » | `communication.internal_notes` | C (CM §43) |

## 12. Intégration Kommo

| Terme | Définition | Exemple | Entités liées | Statut |
|---|---|---|---|---|
| **Kommo** | Outil CRM externe gérant les leads digitaux, les conversations (WhatsApp), le pipeline relationnel, les relances et les automatisations. | — | `integrations.*` | C (CM §44) |
| **Lead Kommo** | Opportunité digitale gérée dans Kommo. N'existe pas comme entité propriétaire dans GIC. | — | `integrations.external_links` (type externe `lead`) | C (CM §44, §46) |
| **Lien externe** | Correspondance entre une entité GIC et son identifiant dans un système externe. | Client X ↔ contact Kommo 123456 | `integrations.external_links` | C (PM §16) |

## 13. Termes proscrits ou ambigus

| Terme à éviter | Problème | Terme à utiliser |
|---|---|---|
| « Campagne » seul | Désigne soit un lot de production (CM §15), soit une période commerciale (PM §9). Tension C-03. | **Lot de production** (ou « campagne de production ») / **Campagne commerciale** |
| « Commande » seul | Désigne soit la commande client, soit la commande fournisseur, soit la commande technique de synchronisation. | **Commande client**, **Bon de commande fournisseur (BC)**, **commande (technique)** |
| « Stock » comme quantité saisissable | Contraire au CM §21. | **Solde de stock** (calculé) ; **Mouvement de stock** (saisi indirectement) |
| « Supprimer » une vente, un paiement, une réception, une perte | Contraire au CM §41. | **Annuler** (contre-écriture) |
| « Session » seul | Ambigu : authentification, travail, caisse. | **Session d'authentification**, **session de travail**, **session de caisse** |
| « Affectation » seul | Ambigu : affectation de stock (CM §23), de rôle, de client, de paiement. | **Affectation de stock**, **affectation de rôle**, **réaffectation de client**, **affectation de paiement** |
| « Allocation » pour un déplacement physique | Une allocation ne déplace rien physiquement. | **Affectation de stock** (physique, transfert) vs **allocation** (quota hors ligne) |
| « Date » seule sur une opération | Ambigu entre les instants du CM §38. | `occurred_at`, `client_created_at`, `received_at`, `applied_at` |
| « Client » pour un prospect | Le stade compte. | **Compte client** (générique), **prospect**, **client** |
| « Validé » pour un état synchronisé | Ambigu : validation humaine ou application serveur. | **Approuvé** (humain) / **Synchronisé** (technique) |
