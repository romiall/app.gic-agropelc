# ADR-028 — Commandes, ventes et livraisons après ADR-025 : emplacement « à livrer », livraisons, contre-écritures partielles

- **Statut** : ACCEPTÉ (décisions du porteur du projet du 30/09/2026 : AV-026 à AV-028, AV-030, AV-031, AV-034, AV-041, AV-056, AV-063, AV-126 à AV-130 ; précise ADR-025 §4 ; remplace les éléments restants d'ADR-014)
- **Date** : 30/09/2026

## Contexte

ADR-025 (AV-024) place la vente à la **confirmation** de la commande et fait passer la marchandise vendue par un emplacement « vendu, à livrer » jusqu'à sa remise au client. Son §4 renvoyait au démarrage de P4 : la nature de cet emplacement, les types de mouvements, l'annulation avant livraison, la livraison partielle, le coût figé et le cas hors ligne. La cartographie de P4 (30/09/2026) a montré qu'ADR-014 (vente à la remise, pas de document de livraison, acomptes transférés à la livraison) et plusieurs règles de D04 ne tiennent plus. Le porteur du projet a tranché les questions métier le 30/09/2026 (A-VALIDER §3).

## Décision

1. **Emplacement « à livrer »** (DÉDUIT) : un emplacement **virtuel par site**, de type `V_TO_DELIVER`, créé à la première confirmation sur le site. Virtuel, il n'est ni vendable, ni compté dans le disponible, ni dans l'effectif non vendu d'un lot, ni dans un inventaire du magasin : la marchandise vendue est mise de côté, elle n'est plus du stock de l'entreprise.
2. **Mouvements** (DÉDUIT) :
   - vente directe : `SALE`, emplacement physique → `V_CUSTOMER` (inchangé) ;
   - confirmation d'une commande : `SALE`, emplacement de préparation → `V_TO_DELIVER` du site ; le **coût de la vente est figé sur ce mouvement** (ADR-025 §4) ;
   - livraison : `DELIVERY`, `V_TO_DELIVER` → `V_CUSTOMER`, à la valeur figée de la vente (aucune nouvelle valorisation) ;
   - contre-écriture d'une vente : `CUSTOMER_RETURN`, de la destination du mouvement `SALE` d'origine (`V_CUSTOMER` ou `V_TO_DELIVER`) vers sa source, à la valeur d'origine.
   Le coût des ventes reste la somme des mouvements `SALE` nets de leurs inverses ; `V_CUSTOMER` cumule le **livré** (stratégie stock §2).
3. **Lots biologiques** (DÉDUIT, ADR-027) : le mouvement `SALE` vers `V_TO_DELIVER` est une **sortie définitive** du lot (coût restant, effectif non vendu) ; la livraison ne l'est pas une seconde fois.
4. **Une vente par confirmation** (AV-127, AV-126) : confirmer une commande crée une vente (type `ORDER`) pour la quantité disponible sur l'emplacement de préparation ; le reste demeure **en attente** sur la ligne de commande et sera confirmé plus tard par une nouvelle vente. Une commande saisie hors ligne est une intention confirmée par le serveur à son application, avec l'heure métier de la saisie. Aucune réservation `ORDER_RESERVATION` n'est posée pour une commande : la part vendue est déplacée, la part en attente n'a pas de stock (ADR-004 reste valable pour les quotas d'appareil, P5).
5. **Annulation partielle par contre-écriture** (AV-128, AV-130, DÉDUIT) : une vente reste immuable ; toute annulation, totale ou partielle, est un **document d'annulation** (lignes, quantités, montants) qui inverse les mouvements concernés et diminue le chiffre d'affaires à sa propre heure métier. La vente passe `CANCELLED` quand toutes ses lignes sont annulées. Le reste non livré d'une commande s'annule par l'auteur de la commande ou le Resp. commercial, sans validation ; une vente directe suit AV-030.
6. **Modification d'une commande confirmée** (AV-130) : une baisse annule par contre-écriture la part vendue non livrée concernée, puis la part en attente ; une hausse ou un nouveau produit crée une vente complémentaire (vente du disponible). Le prix des lignes déjà vendues ne change pas.
7. **Livraison** (AV-034) : document **bon de livraison** (`LIV`) avec ses lignes : livreur, heure de remise, réceptionnaire, preuve éventuelle, quantités par ligne de vente ; plusieurs livraisons partielles par commande ; une livraison ne dépasse pas le vendu non livré.
8. **Paiements** : un encaissement s'affecte à des ventes ; un acompte avant confirmation s'affecte à la commande et passe à la vente à sa confirmation (AV-033, défaut) ; la part d'un encaissement libérée par une annulation devient du crédit client non affecté (ou un remboursement). Échéance d'une vente à crédit = heure métier de la vente + délai du client (AV-129).

## Alternatives

Emplacement « à livrer » physique réservé à la préparation (compté dans l'effectif d'un lot biologique et dans les inventaires, à exclure partout du disponible). Types de mouvements propres à la confirmation (`SALE_TO_DELIVER`) au lieu de `SALE` à destination différente. Livraison portée par la vente (colonnes uniques, une seule livraison). Réservation du manque plutôt que vente du disponible. Annulation partielle par modification des lignes de vente (contraire à l'immuabilité, INV-VEN-02).

## Justification

Décisions métier du porteur du projet (30/09/2026). Choix techniques DÉDUITS : l'emplacement virtuel évite de compter la marchandise vendue comme du stock, sans nouvelle règle d'exclusion ; garder `SALE` pour les deux cas conserve les invariants existants (INV-VEN-08, INV-STK-16, coût des ventes) ; le document d'annulation est la contre-écriture d'ADR-006 appliquée à une partie de document.

## Conséquences

- D04 (BR-VEN-004 à 011, 016, 023), D09 (BR-FIN-008, 043), SM-ORDER, SM-SALE, le dictionnaire `sales`, INV-VEN-04 et 08, INV-STK-16, la stratégie stock (§2 `V_CUSTOMER`) et AT-008 sont réécrits dans les commits de P4 qui les implémentent.
- `organization` : type d'emplacement virtuel `V_TO_DELIVER` rattaché à un site (exception à « virtuel ⇒ sans site ») ; `inventory` : type de mouvement `DELIVERY`, inverse `SALE → CUSTOMER_RETURN`, sortie définitive des lots biologiques vers `V_TO_DELIVER`.
- ADR-014 passe au statut **REMPLACÉ** en totalité (ADR-025 et le présent ADR).
- Le chiffre d'affaires d'une période = Σ ventes − Σ annulations, chacune à sa propre heure métier ; les indicateurs distinguent « vendu » et « livré ».

## Risques

Commande confirmée jamais livrée : indicateur des ventes non livrées au-delà de `sales.undelivered_alert_days` (AV-132, alerte en P9). Marchandise vendue perdue avant la remise : annulation partielle puis perte (AV-131, défaut).
