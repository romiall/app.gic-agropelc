# ADR-014 — Commande, vente et livraison

- **Statut** : ACCEPTÉ provisoirement ; **À VALIDER** (AV-024 bloquante pour P4, AV-034)
- **Date** : 24/09/2026

## Contexte
Chaîne COMMANDER → VENDRE → LIVRER → ENCAISSER (CM §4). Une vente diminue le stock (CM §13). Tension C-04 : si la vente précède la livraison, le stock baisse avant la sortie physique.

## Décision
- La **commande** engage le client et **réserve** le stock ; elle ne fait pas sortir de stock.
- La **vente** naît au moment de la **remise physique** :
  - vente directe (PDV, terrain, ferme) : remise immédiate ;
  - vente `ORDER_FULFILMENT` : livraison d'une commande, partielle ou totale.
- Pas d'entité « livraison » distincte au MVP : la vente sur commande porte le livreur, l'heure et le réceptionnaire (AV-034).
- CA reconnu à l'heure métier de la vente ; les acomptes restent affectés à la commande puis sont transférés à la vente.

## Alternatives
(a) Vente à la confirmation de commande, avec sortie de stock différée : deux temps de stock, CA prématuré ; (c) vente confirmée puis état « à livrer » : état hybride compliqué hors ligne.

## Justification
Un seul événement physique = un seul document qui fait sortir le stock. Cohérence stock ↔ CA ↔ créance.

## Conséquences
SM-ORDER, SM-SALE ; réservation transférable (BR-VEN-010) ; attribution de la livraison au commercial de la commande.
