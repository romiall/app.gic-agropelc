# ADR-025 — Vente reconnue à la confirmation, marchandise « à livrer » jusqu'à la remise

- **Statut** : ACCEPTÉ (décision du porteur du projet du 27/09/2026 ; tranche AV-024 ; remplace la partie « vente » d'ADR-014)
- **Date** : 27/09/2026

## Contexte

ADR-014 plaçait la naissance de la vente à la **remise physique** (livraison), la commande ne faisant que réserver le stock, et laissait AV-024 ouvert (bloquant pour P4). Tension C-04 : la chaîne du CM §4 est COMMANDER → VENDRE → LIVRER → ENCAISSER, et une vente diminue le stock (CM §13).

Le porteur du projet a tranché AV-024 le 27/09/2026 : **la vente et le chiffre d'affaires sont reconnus à la confirmation de la commande** (option a), et, entre la confirmation et la livraison, la marchandise se trouve dans un **emplacement « vendu, à livrer »** qu'elle quitte à la remise au client, afin que le comptage physique du magasin reste juste.

## Décision

1. **Confirmation d'une commande = vente** : le chiffre d'affaires, la créance et l'attribution commerciale naissent à l'heure métier de la confirmation (CONFIRMÉ, décision AV-024).
2. **Deux temps de stock** (CONFIRMÉ) :
   - à la confirmation, la marchandise vendue quitte le stock disponible de l'emplacement de préparation pour un emplacement « vendu, à livrer » du même site ;
   - à la livraison (remise physique, partielle ou totale), elle quitte cet emplacement vers le client (`V_CUSTOMER`).
3. **Vente directe** (PDV, terrain, ferme) : vente et remise dans la même opération, sans passage par l'emplacement « à livrer » (inchangé).
4. DÉDUIT, à préciser au démarrage de P4 (documentation de D04, SM-ORDER, SM-SALE et du dictionnaire `sales`) — **précisé par [ADR-028](ADR-028-commande-vente-livraison-p4.md) le 30/09/2026** (emplacement virtuel `V_TO_DELIVER` par site, mouvements `SALE` et `DELIVERY`, vente du disponible, annulation partielle par contre-écriture, commande hors ligne confirmée à la synchronisation) :
   - nature de l'emplacement « à livrer » (virtuel par site, ou physique réservé à la préparation) et types de mouvements des deux temps ;
   - annulation d'une vente confirmée non livrée (retour de l'emplacement « à livrer » vers le stock, par contre-écriture) ;
   - livraison partielle, reliquat non livré et clôture du reste ;
   - coût de la vente figé à la confirmation (premier mouvement) ;
   - hors ligne : une confirmation saisie hors ligne reste soumise au blocage au-delà de l'allocation (AV-025, ADR-004).

## Alternatives

(b) Vente à la remise physique (ADR-014, recommandation initiale) : un seul événement de stock, CA reconnu à la livraison — écartée par le porteur du projet. (c) Vente confirmée avec un état « à livrer » sans mouvement de stock : le stock du magasin resterait gonflé des marchandises vendues.

## Justification

Choix du porteur du projet : le chiffre d'affaires suit l'engagement du client. L'emplacement « à livrer » évite l'écart entre stock affiché et stock physique qu'aurait produit une sortie immédiate vers le client (option présentée et retenue le 27/09/2026).

## Conséquences

- ADR-014 passe au statut **REMPLACÉ** pour la naissance de la vente et la sortie de stock ; ses autres éléments (pas d'entité « livraison » distincte au MVP, AV-034 ; acomptes transférés) restent valables jusqu'à la conception détaillée de P4.
- Les règles de D04 écrites sur la base d'ADR-014 (notamment BR-VEN-006 « livrer une commande crée une vente ») sont à réécrire au démarrage de P4, dans le même commit que leur implémentation.
- Le CA d'une période inclut les ventes confirmées non encore livrées ; les indicateurs distinguent « vendu » et « livré ».

## Risques

CA reconnu pour une commande finalement non livrée : corrigé par annulation (contre-écriture) de la vente confirmée ; à suivre par un indicateur des ventes confirmées non livrées au-delà d'un délai paramétré.
