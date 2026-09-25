# Stratégie stock

> Section 16 du format final (PM §48). Décisions : ADR-003 (registre en partie double), ADR-004 (allocations hors ligne), ADR-015 (valorisation). Règles : D06. Invariants : INV-STK-*.

---

## 1. Principe fondamental

> **Stock disponible = somme des mouvements validés applicables** (PM §6). Le stock n'est jamais saisi (CM §21).

Le système ne contient **aucune** colonne de quantité modifiable par un utilisateur. Toute quantité affichée provient :

- soit du registre `inventory.stock_moves`, source de vérité en ajout seul ;
- soit de la projection `inventory.stock_balances`, maintenue dans la même transaction et reconstructible.

## 2. Registre en partie double

### 2.1 Forme d'un mouvement

Chaque mouvement déplace une quantité **strictement positive** d'un produit, d'un emplacement source vers un emplacement destination. L'origine et la destination externes sont des **emplacements virtuels** :

| Emplacement virtuel | Signification | Exemple d'usage |
|---|---|---|
| `V_OPENING` | Stock existant au démarrage | Inventaire d'ouverture |
| `V_SUPPLIER` | Extérieur fournisseur | Réception, retour fournisseur |
| `V_CUSTOMER` | Extérieur client | Vente, annulation |
| `V_PRODUCTION` | Transformation biologique ou procédé | Collecte d'œufs, éclosion, naissance, reclassement |
| `V_CONSUMPTION` | Consommation d'intrants | Aliment, médicament, emballage |
| `V_LOSS` | Perte reconnue | Mortalité, casse, vol |
| `V_PENDING_LOSS` | Perte en attente de validation | Perte au-dessus du seuil |
| `V_ADJUSTMENT` | Écart d'inventaire | Gain ou perte d'inventaire |
| `V_TRANSIT` | Marchandise entre deux emplacements | Transfert expédié, non reçu |

Conséquences :

1. **Conservation structurelle** : un mouvement retire exactement ce qu'il ajoute. Aucune quantité n'apparaît ni ne disparaît sans contrepartie (INV-STK-03).
2. **Lisibilité analytique** : le solde cumulé de `V_CUSTOMER` est le total vendu, celui de `V_LOSS` le total perdu, celui de `V_CONSUMPTION` le total consommé. Cela répond directement à « vendu où, perdu où » (PM §4).
3. **Explication de tout écart** : « pourquoi 100 → 95 ? » se lit comme la liste des mouvements sortants de l'emplacement entre deux dates, avec type, document, auteur, appareil et motif (CM §21, §62).

### 2.2 Structure minimale (logique)

```text
stock_moves(
  id uuid PK, product_id, lot_id NULL, quantity numeric(14,3) > 0,
  from_location_id, to_location_id, move_type, reason_code_id NULL,
  unit_cost_xaf bigint,            -- figé par le serveur
  occurred_at, recorded_at,        -- heure métier / heure serveur
  source_doc_type, source_doc_id, source_line_id,
  allocation_id NULL, is_reversal bool, reverses_move_id NULL UNIQUE,
  created_by, created_device_id NULL, command_id NULL, captured_offline bool
)
```

Contraintes clés (exemples SQL courts, à titre explicatif) :

```sql
CHECK (quantity > 0),
CHECK (from_location_id <> to_location_id),
UNIQUE (reverses_move_id)  -- un mouvement ne s'inverse qu'une fois
-- et un déclencheur refuse tout UPDATE/DELETE sur stock_moves
```

La conformité du couple (source, destination) au type est vérifiée par l'API interne d'`inventory` (table §7.7 de D06). En complément, une contrainte sur les **types d'emplacement** (physique ou virtuel attendu) est testée.

### 2.3 Documents sources

Aucun mouvement n'existe sans document métier : vente, transfert, perte, consommation, inventaire, réception, collecte, étape d'incubation, entrée de lot. Le document porte le **pourquoi** (motif, commentaire, pièces, validation) ; le mouvement porte le **quoi, combien, où, quand, à quel coût**.

## 3. Soldes et projections

### 3.1 `stock_balances`

Clé : (`location_id`, `product_id`, `lot_key`), où `lot_key` = `lot_id` ou la valeur nulle normalisée (UUID nul) pour les produits sans lot.

Colonnes :

- `qty_on_hand` : Σ entrées − Σ sorties ;
- `qty_reserved` : Σ réservations actives ;
- `qty_allocated` : Σ restes d'allocations actives ;
- `last_move_at`, `updated_at`.

Mise à jour : dans la transaction du mouvement. On verrouille la ligne de la **source** (`SELECT … FOR UPDATE`) pour le contrôle de disponibilité (INV-STK-06), puis on met à jour la source et la destination.

Reconstruction : `REFRESH` par agrégation complète du registre (procédure de maintenance). Un job quotidien compare la projection au registre (INV-STK-01) et lève `LEDGER_MISMATCH` en cas d'écart.

### 3.2 Solde à une date métier

`balance_at(loc, product, lot, t)` = Σ des mouvements de `occurred_at` ≤ t. Cette fonction sert aux inventaires (théorique à `counted_at`), aux analyses historiques et à l'explication des écarts. Pour les emplacements très actifs, des **instantanés quotidiens** (`inventory.stock_balance_snapshots`, table de projection optionnelle, D) peuvent accélérer le calcul. Ils sont recalculés si un mouvement tardif antérieur arrive.

### 3.3 Disponible

```text
disponible(C, loc, produit, lot?) =
    qty_on_hand
  − qty_reserved
  − (qty_allocated − reste_alloué_à(C))     -- sur un emplacement SHARED
```

Sur un emplacement `EXCLUSIVE_USER` ou `EXCLUSIVE_DEVICE`, le disponible du détenteur = `qty_on_hand − qty_reserved`.

## 4. Familles de stock et classification analytique

Le CM §20 distingue stock biologique, production commercialisable, stock commercial et intrants. Ce n'est **pas** une propriété figée du produit : un même poulet vif est biologique en bâtiment et commercial au PDV. La classification analytique d'une quantité est donc calculée :

| Famille (CM §20) | Règle de classification |
|---|---|
| Stock biologique | Produit de famille `BIOLOGIQUE` dans un emplacement `BUILDING`, `PEN`, `INCUBATOR` ou `HATCHER` |
| Production commercialisable | Produit de famille `PRODUCTION_COMMERCIALISABLE` dans un emplacement de ferme, **ou** produit `BIOLOGIQUE` d'un lot à l'état `SELLING` dans son emplacement d'élevage (« prêts à la vente », CM §2) |
| Stock commercial | Tout produit vendable dans un emplacement `STORE`, `POS` ou `MOBILE` (magasin, PDV, vendeur ; la « zone de distribution » s'obtient par la zone du site) |
| Intrants | Produit de famille `INTRANT` ou `EMBALLAGE_CONSOMMABLE`, quel que soit l'emplacement |

Question CM §62 : « Combien de poulets réellement disponibles pouvons-nous vendre aujourd'hui à Douala ? » = Σ disponible du produit « Poulet de chair vif » sur les emplacements commerciaux des sites de la zone Douala et de ses sous-zones, + Σ effectif en élevage des lots `SELLING` des fermes rattachées à Douala (si la direction inclut la vente à la ferme), − réservations.

## 5. Garde, allocations et prévention de la double consommation hors ligne

### 5.1 Modes de garde

| Mode | Emplacements typiques | Qui consomme hors ligne | Mécanisme |
|---|---|---|---|
| `EXCLUSIVE_USER` | `MOBILE` (stock d'un commercial) | Le détenteur, sur son **appareil principal** | Tout le solde est à lui ; le changement d'appareil principal se fait en ligne (BR-STK-016) |
| `EXCLUSIVE_DEVICE` | PDV mono-tablette, magasin de ferme avec un seul appareil | Tout utilisateur autorisé, sur l'**appareil désigné** | Tout le solde est à l'appareil |
| `SHARED` | Magasin central, PDV multi-appareils | Seulement via **allocation** (quota) ; sinon consommation en ligne uniquement | ADR-004 |

### 5.2 Allocation (quota hors ligne)

- Accordée **en ligne** par un responsable à un couple (utilisateur, appareil), pour (emplacement, produit[, lot]), avec une quantité et une validité (`valid_until`).
- À l'octroi, le serveur garantit Σ restes + réservations ≤ solde (INV-STK-10).
- L'appareil télécharge son quota et le décrémente localement à chaque sortie. Il refuse de dépasser (AV-025).
- Registre de quota `stock_allocation_entries` : `GRANT`, `INCREASE`, `CONSUME`, `RELEASE`, `REVOKE`, `TRANSFER`. Reste = Σ entrées signées.
- Libération : **confirmée par l'appareil** (il envoie son reste à la synchronisation). Tant que l'appareil ne l'a pas confirmée, le serveur considère le reste comme toujours détenu, ce qui empêche une double attribution.
- Révocation forcée (appareil perdu, vendeur absent) : auditée ; toute consommation ultérieure imputée à ce quota ouvre `ALLOCATION_REVOKED_CONSUMED`.

Pourquoi ce choix plutôt qu'un stock négatif toléré (PM §6) ? Parce que la double consommation est **empêchée à la source**, au lieu d'être découverte a posteriori. Le coût opérationnel (octroyer des quotas) n'existe qu'en mode `SHARED`. Le mode `EXCLUSIVE_DEVICE`, recommandé par défaut pour les PDV, le supprime pour le cas courant.

### 5.3 Réservation de commande

Même table (`allocation_type = ORDER_RESERVATION`), portée par la ligne de commande et non par un appareil. Elle est consommée par la livraison, libérée par l'annulation, **transférée** par un transfert préparé pour la commande.

### 5.4 Quand la prévention échoue

Un appareil modifié, un quota révoqué ou une réception mal rapprochée peuvent rendre un solde serveur négatif lors de l'application d'une opération hors ligne **réelle**. Politique :

1. L'opération est appliquée : le fait physique existe, le rejeter falsifierait le registre.
2. Le conflit `STOCK_NEGATIVE` est ouvert et l'alerte critique levée (INV-STK-05).
3. Résolution par un responsable, avec l'un des documents suivants :
   - inventaire (la marchandise existait : écart positif) ;
   - rapprochement d'un transfert manquant ;
   - perte imputée (enquête).
4. Le solde négatif n'est **jamais** un état normal : un tableau de bord liste les soldes négatifs ouverts ; l'objectif opérationnel est zéro.

## 6. Transferts et transit

- Deux temps (expédition, réception) via `V_TRANSIT`. Le solde de transit **par transfert** se calcule avec `source_doc_id`.
- Écart à la réception → `V_PENDING_LOSS` → décision (SM-TRANSFER).
- **Réception sans document** (BR-STK-024) : l'appareil destinataire, en mode exclusif, déclare « reçu de X ». Le serveur impute `V_TRANSIT` → destination sur le **transit non rapproché** de la paire (X, destination), qui peut devenir temporairement négatif. Il rapproche ensuite automatiquement dès que l'expédition arrive. Un transit non rapproché depuis plus de 48 h → conflit `TRANSFER_UNMATCHED`.
- Déplacement interne (même site) : mouvement direct `INTERNAL_MOVE` sans transit.

## 7. Lots de traçabilité

| Origine (`stock_lots.origin_type`) | Créé par | Produits |
|---|---|---|
| `PRODUCTION_LOT` | Création d'un lot de production | Animaux du lot ; œufs d'un lot de pondeuses (si suivi) |
| `INCUBATION_BATCH` | Démarrage d'une incubation | Œufs en incubation, poussins éclos |
| `SUPPLIER_LOT` | Réception avec lot fournisseur | Intrants (vaccins, aliments), avec date de péremption |
| `COLLECTION` | Collecte d'œufs (option) | Œufs d'une date de collecte |

Choix automatique **FIFO** : pour une sortie sans lot désigné, le serveur consomme les lots en solde positif dans l'emplacement, par date de création du lot croissante. Pour les intrants périssables, c'est la date de péremption croissante (FEFO). La traçabilité est donc **statistique** pour les produits mélangés (L-07), conformément au CM §58 (« contribuer statistiquement »).

## 8. Inventaire

1. Comptage d'un emplacement à `counted_at` ; l'activité continue.
2. Théorique = `balance_at(counted_at)`.
3. Écarts → `INVENTORY_GAIN` / `INVENTORY_LOSS` datés de `counted_at`, avec motif. Validation au-dessus du seuil.
4. **Rapprochement tardif** (BR-STK-044) : tout mouvement de `occurred_at` ≤ `counted_at` appliqué après la comptabilisation déclenche un ajustement compensatoire lié à l'inventaire. Ainsi `balance_at(counted_at)` reste égal au compté (INV-STK-09), et l'écart net de l'inventaire reflète le vrai inexpliqué. Exemple chiffré : WF-08.
5. Un inventaire d'ouverture charge le stock initial depuis `V_OPENING`, avec un coût déclaré.

## 9. Valorisation (AV-042, ADR-015)

| Cas | Coût unitaire figé sur le mouvement |
|---|---|
| Réception | Prix du BC (ou prix déclaré sans BC) |
| Ouverture | Coût déclaré à l'inventaire d'ouverture |
| Sortie ou transfert d'un produit sans lot biologique | **CMUP** courant du produit (`product_valuations.avg_unit_cost_xaf`) |
| Sortie ou transfert d'un produit biologique d'un lot de production | **Coût par tête du lot** au moment de l'application = coût cumulé du lot ÷ effectif non vendu |
| Production interne sans lot valorisé (œufs, poussins avant rattachement) | **Coût standard** du produit (BR-CAT-011), ou coût calculé du lot d'incubation pour les poussins (BR-INC-009) |
| Gain d'inventaire | CMUP courant (ou coût par tête du lot) |
| Mouvement inverse | Coût du mouvement d'origine |

Recalcul du CMUP à chaque entrée valorisée, dans l'ordre d'application serveur :

```text
nouveau_cmup = (qté_avant × cmup_avant + qté_entrée × coût_entrée) / (qté_avant + qté_entrée)
```

La quantité de référence est le stock total du produit (tous emplacements physiques et transit). Si la quantité de référence est ≤ 0 au moment de l'entrée, le CMUP prend le coût d'entrée.

Limite assumée : les opérations hors ligne tardives sont valorisées selon l'ordre serveur, pas selon `occurred_at`. L'écart est négligeable à l'échelle de GIC et évite de revaloriser le passé.

## 10. Performance et volumétrie

- Hypothèse H-06 : ≤ 5 000 lignes de vente par jour, soit environ 15 000 mouvements par jour tous types confondus, et environ 5,5 millions par an.
- Index : (`from_location_id`, `product_id`, `occurred_at`), (`to_location_id`, `product_id`, `occurred_at`), (`source_doc_type`, `source_doc_id`), (`lot_id`), (`command_id`).
- Partitionnement mensuel par `recorded_at` au-delà de 20 millions de lignes (seuil de revue).
- Les soldes courants sont servis par `stock_balances`, jamais par agrégation du registre en temps réel.

## 11. Réponses aux questions du CM §2 (Stock)

| Question | Réponse du modèle |
|---|---|
| Quel stock avons-nous ? | `stock_balances` agrégé par produit |
| Où se trouve-t-il ? | Par `location_id` → site → zone |
| Depuis quand ? | `stock_lots.created_at` et premier mouvement entrant du lot dans l'emplacement |
| De quel lot ou de quelle opération provient-il ? | `lot_id` → lot de production / d'incubation / fournisseur ; document source des mouvements entrants |
| Quelle quantité est disponible ? | Formule §3.3 |
| Quelle quantité est affectée à un commercial ou à un PDV ? | Solde des emplacements `MOBILE` et `POS` ; allocations actives par détenteur |
