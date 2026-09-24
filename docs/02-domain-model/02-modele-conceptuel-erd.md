# Modèle conceptuel de données et ERD

> Sections 12 et 13 du format final (PM §48). Démarche imposée (PM §25) : **domaines → entités métier → relations → cardinalités → invariants → tables**.
> Le modèle relationnel détaillé (tables, colonnes, contraintes) est dans [`../03-data/02-modele-relationnel.md`](../03-data/02-modele-relationnel.md) et le dictionnaire dans [`../03-data/dictionnaire/`](../03-data/dictionnaire/README.md).

---

## 1. Entités métier par domaine

| Domaine | Entités métier | Nature |
|---|---|---|
| Identité | Utilisateur, Rôle, Permission, Affectation de rôle, Appareil, Session d'authentification | Master data, référentiel |
| Organisation | Zone, Site, Point de vente, Emplacement, Équipe, Appartenance d'équipe, Paramètre | Référentiel |
| Catalogue | Catégorie de produit, Unité, Produit, Unité de conditionnement, Code motif, Coût standard | Référentiel |
| Tarification | Règle tarifaire, Campagne commerciale | Référentiel versionné |
| CRM | Compte client, Affectation de titulaire, Historique de stade, Étape de pipeline, Visite, Interaction, Objectif, Catégorie de client, Source, Canal | Master data + transactions |
| Pointage | Tentative de pointage, Session de travail | Transactions |
| Ventes | Commande client, Ligne de commande, Vente, Ligne de vente | Transactions |
| Stock | Lot de traçabilité, Mouvement de stock, Solde, Transfert, Ligne de transfert, Allocation, Entrée d'allocation, Déclaration de perte, Consommation, Inventaire, Ligne d'inventaire, Seuil, Valorisation produit | Registre + transactions + projections |
| Production | Lot de production, Entrée de lot, Pesée, Observation, Collecte d'œufs, Lot d'incubation, Étape d'incubation | Transactions |
| Approvisionnement | Fournisseur, Demande d'achat (+ lignes), Bon de commande (+ lignes), Réception (+ lignes) | Master data + transactions |
| Finance | Moyen de paiement, Compte de trésorerie, Session de caisse, Mouvement de trésorerie, Remise de fonds, Encaissement, Affectation de paiement, Catégorie de dépense, Dépense, Facture fournisseur (+ lignes), Paiement fournisseur (+ affectations), Écriture de coût | Registres + transactions |
| Contrôle | Politique de contrôle, Demande de validation, Pièce justificative | Transactions |
| Communication | Règle d'alerte, Alerte, Notification, Abonnement push, Note (+ audience, accusés) | Transactions |
| Audit, synchronisation, intégration | Entrée d'audit, Commande reçue, Conflit, Flux de changements, État de synchronisation, Lien externe, Messages d'intégration entrants et sortants | Journaux techniques et métier |
| Plateforme | Événement métier, Position de consommateur, Séquence documentaire | Infrastructure |
| Analytics | Vue sauvegardée, Export, Instantané d'indicateurs | Support |

## 2. Relations structurantes et cardinalités

| # | Relation | Cardinalité | Commentaire / invariant |
|---|---|---|---|
| R1 | Utilisateur — Affectation de rôle — Rôle | 1 utilisateur : 0..N affectations ; 1 rôle : 0..N affectations | Rôles multiples (CM §6) ; périmètre optionnel par affectation |
| R2 | Rôle — Permission | N : M (via rôle-permission, avec portée maximale) | PM §17 |
| R3 | Utilisateur — Appareil | Un appareil est enregistré par 1 utilisateur ; il est utilisé par 1..N utilisateurs via les sessions | Appareils partagés (AV-007) |
| R4 | Zone — Zone (parent) | 0..1 parent : 0..N enfants | Arbre sans cycle |
| R5 | Site — Zone | N : 1 | Chaque site est dans une zone |
| R6 | Site — Emplacement | 1 : 1..N (physiques) ; virtuels sans site | BR-ADM-009 |
| R7 | Emplacement `MOBILE` — Utilisateur (détenteur) | 0..1 : 1 | INV-ADM-05 |
| R8 | Site `POINT_DE_VENTE` — Point de vente | 1 : 1 | Extension de site |
| R9 | Compte client — Affectation de titulaire — Utilisateur | 1 compte : 0..N affectations (≤ 1 active) | INV-CRM-02 |
| R10 | Compte client — Utilisateur (acquéreur) | N : 1 | Immuable (INV-CRM-01) |
| R11 | Compte client — Visite | 1 : 0..N | — |
| R12 | Visite — Session de travail | N : 0..1 | Rattachement automatique |
| R13 | Commande — Ligne de commande | 1 : 1..N | — |
| R14 | Commande — Vente (livraisons) | 1 : 0..N | Livraisons partielles |
| R15 | Vente — Ligne de vente | 1 : 1..N | — |
| R16 | Ligne de vente — Mouvement de stock | 1 : 0..N (0 pour un service ; N si plusieurs lots) | INV-VEN-08 |
| R17 | Mouvement — Emplacement source / destination | N : 1 / N : 1 | Partie double |
| R18 | Mouvement — Lot de traçabilité | N : 0..1 | INV-STK-13 |
| R19 | Mouvement — Mouvement inversé | 0..1 : 0..1 | INV-STK-04 |
| R20 | Mouvement — Document source | N : 1 (polymorphe typé : vente, transfert, perte, réception, consommation, inventaire, collecte, incubation, entrée de lot) | Clés étrangères nullables exclusives (voir le modèle relationnel §4) |
| R21 | Lot de production — Lot de traçabilité | 1 : 1 | BR-PRD-002 |
| R22 | Lot d'incubation — Lot de traçabilité | 1 : 1 | BR-INC-001 |
| R23 | Transfert — Ligne de transfert | 1 : 1..N | — |
| R24 | Allocation — Entrée d'allocation | 1 : 1..N | Registre de quota |
| R25 | Allocation (réservation) — Ligne de commande | N : 1 | — |
| R26 | Encaissement — Affectation — Vente ou Commande | 1 encaissement : 0..N affectations ; 1 vente : 0..N | INV-FIN-04, INV-VEN-06 |
| R27 | Compte de trésorerie — Mouvement de trésorerie | 1 : 0..N | INV-FIN-02 |
| R28 | Session de caisse — Compte de trésorerie | N : 1 (≤ 1 ouverte) | INV-FIN-06 |
| R29 | Demande d'achat — BC | N : M (via les lignes) | — |
| R30 | BC — Réception | 1 : 0..N | Reliquats |
| R31 | Ligne de réception — Ligne de BC | N : 0..1 (0 pour une réception sans BC) | — |
| R32 | Facture fournisseur — Lignes — Lignes de BC / réception | 1 : 1..N ; N : 0..1 | Rapprochement |
| R33 | Paiement fournisseur — Affectation — Facture | 1 : 0..N | INV-FIN-07 |
| R34 | Écriture de coût — Objet de coût (lot de production, lot d'incubation, site) | N : 1 | Registre de coûts |
| R35 | Document — Demande de validation | 1 : 0..N (historique des demandes) | Une seule `PENDING` à la fois par document |
| R36 | Document — Pièce justificative | 1 : 0..N | — |
| R37 | Entité GIC — Lien externe (Kommo) | 1 : 0..N | INV-KOM-01 |
| R38 | Commande reçue (sync) — Document créé | 1 : 0..N | `command_id` porté par le document |

## 3. ERD global (vue des agrégats)

```mermaid
flowchart TB
  subgraph ID["Identité & Organisation"]
    U[users] --- URA[user_role_assignments] --- R[roles]
    U --- DEV[devices]
    Z[zones] --- S[sites] --- L[locations]
    S --- POS[points_of_sale]
  end
  subgraph CAT["Catalogue & Pricing"]
    P[products] --- PR[price_rules]
  end
  subgraph CRM["CRM & Pointage"]
    C[customers] --- V[visits]
    C --- CA[customer_assignments]
    WS[work_sessions] --- V
  end
  subgraph VEN["Ventes"]
    O[sales_orders] --- SA[sales]
  end
  subgraph STK["Stock"]
    M[stock_moves] --- B[stock_balances]
    T[stock_transfers] --- M
    LD[loss_declarations] --- M
    AL[stock_allocations]
  end
  subgraph PRD["Production"]
    PL[production_lots] --- SL[stock_lots]
    EC[egg_collections]
    IB[incubation_batches]
  end
  subgraph APP["Approvisionnement"]
    PO[purchase_orders] --- GR[goods_receipts]
  end
  subgraph FIN["Finance"]
    CP[customer_payments] --- PA[payment_allocations]
    CM[cash_movements]
    CE[cost_entries]
    SI[supplier_invoices]
  end
  C --> O
  C --> SA
  SA --> M
  SA --> PA
  P --> M
  L --> M
  SL --> M
  GR --> M
  EC --> M
  IB --> M
  CP --> CM
  M --> CE
  PL --> CE
  GR --> SI
  U --> C
  U --> SA
```

## 4. ERD par domaine

### 4.1 Identité et organisation

```mermaid
erDiagram
  users ||--o{ user_role_assignments : "détient"
  roles ||--o{ user_role_assignments : "attribué via"
  roles ||--o{ role_permissions : "accorde"
  permissions ||--o{ role_permissions : "incluse dans"
  users ||--o{ devices : "enrôle"
  users ||--o{ auth_sessions : "ouvre"
  devices ||--o{ auth_sessions : "porte"
  zones ||--o{ zones : "parent de"
  zones ||--o{ sites : "contient"
  sites ||--o{ locations : "contient"
  locations ||--o{ locations : "parent de (bâtiment → case)"
  users |o--o| locations : "détient (MOBILE)"
  sites ||--o| points_of_sale : "étendu par"
  teams ||--o{ team_memberships : "regroupe"
  users ||--o{ team_memberships : "membre"
  users ||--o{ teams : "dirige"
```

### 4.2 Catalogue et tarification

```mermaid
erDiagram
  product_categories ||--o{ product_categories : "parent de"
  product_categories ||--o{ products : "classe"
  units ||--o{ products : "unité de base"
  products ||--o{ product_units : "conditionnements"
  units ||--o{ product_units : "unité"
  products ||--o{ product_standard_costs : "coût standard historisé"
  products ||--o{ price_rules : "tarifé par"
  zones |o--o{ price_rules : "dimension"
  sites |o--o{ price_rules : "dimension"
  customer_categories |o--o{ price_rules : "dimension"
  commercial_campaigns |o--o{ price_rules : "regroupe"
  price_rules |o--o| price_rules : "remplace"
```

### 4.3 CRM et pointage

```mermaid
erDiagram
  customers ||--o{ customer_assignments : "titulaires successifs"
  users ||--o{ customer_assignments : "titulaire"
  users ||--o{ customers : "acquéreur"
  customers ||--o{ customer_stage_history : "évolution"
  pipeline_steps |o--o{ customers : "étape courante"
  customer_categories |o--o{ customers : "catégorie"
  zones ||--o{ customers : "localisé dans"
  customers |o--o| customers : "fusionné dans"
  customers ||--o{ visits : "visité"
  users ||--o{ visits : "réalise"
  work_sessions |o--o{ visits : "rattache"
  customers ||--o{ interactions : "contacté"
  users ||--o{ geo_checkins : "tente"
  geo_checkins |o--o| work_sessions : "ouvre / ferme"
  zones ||--o{ geo_checkins : "zone déclarée"
  users ||--o{ sales_targets : "cible"
  teams ||--o{ sales_targets : "cible"
```

### 4.4 Ventes et encaissements

```mermaid
erDiagram
  customers ||--o{ sales_orders : "passe"
  users ||--o{ sales_orders : "commercial"
  sales_orders ||--|{ sales_order_lines : "contient"
  products ||--o{ sales_order_lines : "commandé"
  sales_orders |o--o{ sales : "livrée par"
  customers |o--o{ sales : "achète"
  users ||--o{ sales : "vend (seller)"
  users |o--o{ sales : "attribuée (commercial)"
  sites ||--o{ sales : "réalisée à"
  sales ||--|{ sale_lines : "contient"
  products ||--o{ sale_lines : "vendu"
  price_rules |o--o{ sale_lines : "prix appliqué"
  stock_lots |o--o{ sale_lines : "lot"
  sale_lines ||--o{ stock_moves : "sortie de stock"
  customer_payments ||--o{ payment_allocations : "réparti"
  sales |o--o{ payment_allocations : "réglée par"
  sales_orders |o--o{ payment_allocations : "acompte"
  cash_sessions |o--o{ sales : "caisse"
```

### 4.5 Stock

```mermaid
erDiagram
  locations ||--o{ stock_moves : "source"
  locations ||--o{ stock_moves : "destination"
  products ||--o{ stock_moves : "concerne"
  stock_lots |o--o{ stock_moves : "trace"
  stock_moves |o--o| stock_moves : "inverse"
  stock_moves }o--|| stock_balances : "alimente (projection)"
  stock_transfers ||--|{ stock_transfer_lines : "contient"
  stock_transfer_lines ||--o{ stock_moves : "génère"
  loss_declarations ||--o{ stock_moves : "génère"
  consumptions ||--o{ stock_moves : "génère"
  inventory_counts ||--|{ inventory_count_lines : "contient"
  inventory_count_lines ||--o{ stock_moves : "ajuste"
  stock_allocations ||--|{ stock_allocation_entries : "registre de quota"
  stock_allocations |o--o{ stock_moves : "consommée par"
  users |o--o{ stock_allocations : "détenteur"
  devices |o--o{ stock_allocations : "appareil détenteur"
  sales_order_lines |o--o{ stock_allocations : "réservation"
  locations ||--o{ stock_thresholds : "seuils"
  products ||--o| product_valuations : "CMUP"
```

### 4.6 Production

```mermaid
erDiagram
  production_lots ||--|| stock_lots : "trace"
  sites ||--o{ production_lots : "héberge"
  locations ||--o{ production_lots : "bâtiment principal"
  suppliers |o--o{ production_lots : "fournisseur"
  production_lots ||--o{ lot_entries : "entrées"
  production_lots ||--o{ lot_weighings : "pesées"
  production_lots ||--o{ lot_observations : "observations"
  production_lots ||--o{ egg_collections : "collectes (pondeuses)"
  production_lots ||--o{ loss_declarations : "mortalité"
  production_lots ||--o{ consumptions : "intrants (objet de coût)"
  production_lots ||--o{ cost_entries : "coûts"
  incubation_batches ||--|| stock_lots : "trace"
  incubation_batches ||--o{ incubation_events : "étapes"
  lot_entries ||--o{ stock_moves : "génère"
  egg_collections ||--o{ stock_moves : "génère"
  incubation_events ||--o{ stock_moves : "génère"
```

### 4.7 Approvisionnement et dettes

```mermaid
erDiagram
  suppliers ||--o{ purchase_orders : "reçoit"
  purchase_requests ||--|{ purchase_request_lines : "contient"
  purchase_orders ||--|{ purchase_order_lines : "contient"
  purchase_request_lines |o--o{ purchase_order_lines : "couverte par"
  purchase_orders |o--o{ goods_receipts : "réceptionné par"
  suppliers ||--o{ goods_receipts : "livre"
  goods_receipts ||--|{ goods_receipt_lines : "contient"
  purchase_order_lines |o--o{ goods_receipt_lines : "reçue"
  goods_receipt_lines ||--o{ stock_moves : "entrée (accepté)"
  suppliers ||--o{ supplier_invoices : "facture"
  supplier_invoices ||--|{ supplier_invoice_lines : "contient"
  purchase_order_lines |o--o{ supplier_invoice_lines : "facturée"
  supplier_payments ||--o{ supplier_payment_allocations : "répartit"
  supplier_invoices ||--o{ supplier_payment_allocations : "réglée par"
```

### 4.8 Trésorerie, dépenses, coûts

```mermaid
erDiagram
  cash_accounts ||--o{ cash_movements : "registre"
  cash_accounts ||--o{ cash_sessions : "sessions"
  cash_sessions |o--o{ cash_movements : "rattache"
  cash_transfers ||--|{ cash_movements : "génère (OUT, IN)"
  customer_payments ||--o| cash_movements : "génère"
  supplier_payments ||--o| cash_movements : "génère"
  expenses |o--o| cash_movements : "génère (payée)"
  expense_categories ||--o{ expenses : "classe"
  expenses |o--o{ cost_entries : "impute"
  consumptions |o--o{ cost_entries : "impute"
  lot_entries |o--o{ cost_entries : "impute"
  payment_methods ||--o{ customer_payments : "moyen"
```

### 4.9 Transverses

```mermaid
erDiagram
  control_policies ||--o{ approval_requests : "version figée"
  users ||--o{ approval_requests : "demande / décide"
  attachments }o--|| users : "capturée par"
  command_inbox ||--o{ sync_conflicts : "peut ouvrir"
  devices ||--|| device_sync_state : "état"
  devices ||--o{ command_inbox : "envoie"
  change_feed }o--|| command_inbox : "résulte de (souvent)"
  external_links }o--|| customers : "lie (Kommo)"
  alert_rules ||--o{ alerts : "produit"
  alerts ||--o{ notifications : "notifie"
  internal_notes ||--o{ note_audiences : "cible"
  internal_notes ||--o{ note_acknowledgements : "lue par"
  domain_events }o--|| command_inbox : "causé par"
  audit_log }o--|| users : "acteur"
```

Les associations polymorphes (pièce justificative → document ; demande de validation → document ; alerte → objet concerné ; audit → entité) utilisent le couple (`subject_type`, `subject_id`) **sans** clé étrangère. C'est justifié parce que ces tables transverses doivent référencer des documents de tous les modules sans créer de dépendance de schéma. L'intégrité est assurée par l'API interne du module propriétaire (TX) et contrôlée par un job de réconciliation.

## 5. Invariants attachés au modèle

Les invariants sont définis dans [`01-invariants.md`](01-invariants.md). Les plus structurants pour le modèle :

- partie double et conservation du stock (INV-STK-02, INV-STK-03) ;
- immuabilité des transactions (INV-GLO-01, INV-STK-04, INV-VEN-02) ;
- idempotence (INV-SYN-01) ;
- historisation des titulaires (INV-CRM-02) ;
- unicités métier (INV-CRM-03, INV-FIN-03, INV-KOM-01).

## 6. Extensions prévues, non créées

| Entité future | Raison | Point d'accroche |
|---|---|---|
| `production.animals` | Identification individuelle (CM §19) | Un animal peut devenir un `stock_lot` d'une seule unité ; aucune modification du registre |
| `sales.sales_returns`, `sales.sales_return_lines` | Retours clients (AV-029) | Type de mouvement `CUSTOMER_RETURN` déjà défini |
| `procurement.supplier_returns` | Retours fournisseurs | Type `SUPPLIER_RETURN` déjà défini |
| `production.transformations` | Abattage, transformation (AV-032) | Types `PRODUCTION_INPUT` / `PRODUCTION_OUTPUT` |
| `finance.accounting_exports` | Intégration comptable (AV-059) | Documents financiers typés et immuables |
