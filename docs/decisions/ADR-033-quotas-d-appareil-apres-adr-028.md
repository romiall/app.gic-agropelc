# ADR-033 — Quotas d'appareil après ADR-028 : consommation dans `inventory`, disponible par consommateur, source unique de la garde

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; précise ADR-004 §1 à §5 et ADR-028 §4 sans décision métier nouvelle : les points métier sont les AV-160 à AV-163, à défaut paramétrable)
- **Date** : 08/10/2026
- **Précisé par** : [ADR-040](ADR-040-garde-jugee-a-la-date-du-fait.md) (P5-23) : la garde d'un fait hors ligne se juge sur la période en vigueur à sa date

## Contexte

ADR-004 prévoit la garde exclusive, les quotas d'appareil et les réservations de commande. ADR-028 §4 a supprimé la **réservation** : confirmer une commande vend le disponible vers l'emplacement « à livrer », le reste n'a pas de stock. Il reste donc à fixer, pour P5, les quotas (BR-STK-012 à 014, SM-ALLOCATION, AV-025, AV-007, AV-035). La lecture des sources et du code a montré :

- des règles encore écrites avec « réservations actives » (BR-STK-011, 012, 015, INV-STK-10, SM-ALLOCATION, glossaire, ERD) ;
- **deux sources** du mode de garde : `organization.points_of_sale.custody_mode` (écrit par `organization.pos.configure`) et `organization.locations.custody_mode`, seule lue par le stock, les ventes et la synchronisation, nullable et traitée en silence comme `SHARED` ;
- aucune commande de quota, aucune consommation : `allocation_id` d'un mouvement n'est jamais écrit, `qty_allocated` n'est jamais alimenté, `sales.offline_over_allocation_allowed` est semé mais jamais lu ; le disponible `SHARED` retranche **tous** les quotas, y compris celui du consommateur ;
- un reste de quota qui, selon les sources, est « ≥ 0 » ou « négatif avec conflit tracé » ; une granularité par lot (quota facultativement par lot) en tension avec un solde tenu par ligne de lot que le FIFO attribue côté serveur.

## Décision

1. **Quota d'appareil seul.** `allocation_type = DEVICE_QUOTA` ; `ORDER_RESERVATION`, `sales_order_line_id` et l'entrée `TRANSFER` n'ont plus d'objet (migration de durcissement). ADR-004 §3 est REMPLACÉ par ADR-028 §4.
2. **Source unique de la garde** : `organization.locations.custody_mode` et `designated_device_id`. `organization.pos.configure` les écrit sur l'emplacement de vente dans la même transaction (cohérence testée, INV-DIS-01). Le mode est **obligatoire** pour tout emplacement physique, avec un défaut par type (AV-163) ; un mode absent est une anomalie de donnée, plus un `SHARED` silencieux.
3. **Le reste d'un quota** est tenu par `inventory_stock_allocations.quantity_remaining`, somme des entrées signées du registre immuable (GRANT, INCREASE, CONSUME, RELEASE, REVOKE, ADJUST, RESTORE ; INV-STK-20) ; il **ne devient jamais négatif**. `qty_allocated` des lignes de solde, hérité de P2 (colonne par ligne de lot, inadaptée à un quota par produit), n'est plus une donnée de décision : il reste à zéro et sa suppression est une dette connue.
4. **Disponible d'un consommateur C** : emplacement exclusif = solde ; emplacement `SHARED` = Σ des soldes du produit à l'emplacement − Σ des restes des quotas **des autres** détenteurs. Le quota est au grain (emplacement, produit) ; le lot éventuel d'un quota est indicatif (AV-160).
5. **La consommation vit dans `inventory`** (`recordStockMove`), jamais dans `sales` : une seule règle pour la vente, la perte, le transfert sortant et la consommation (BR-STK-013). Elle résout le couple (utilisateur, appareil) d'après l'**inbox de commandes** (jamais le payload), écrit l'entrée `CONSUME` et `allocation_id` du mouvement dans la transaction, après avoir verrouillé les lignes de solde (ordre : soldes, puis quotas). Un quota n'est consommé que par son couple (INV-STK-11).
6. **En ligne**, un dépassement est refusé sans effet (`ALLOCATION_EXCEEDED` ou `INSUFFICIENT_STOCK`). **Hors ligne**, le fait est toujours appliqué (BR-SYN-007) : le quota est ramené à 0 et l'excédent pris sur le stock commun ; le conflit `ALLOCATION_EXCEEDED` porte l'excédent (gravité réduite et « signalée » si `sales.offline_over_allocation_allowed` est vrai pour le site). Une consommation imputée à un quota **révoqué** ou **échu** est appliquée au stock commun ; `ALLOCATION_REVOKED_CONSUMED` n'est ouvert que si l'`occurred_at` suit la révocation. Un solde qui tombe sous Σ restes après une perte ou un inventaire ouvre `ALLOCATION_OVERCOMMITTED` (informatif), produit par `recordStockMove` à l'écriture du mouvement.
7. **Aucun quota n'est consommé** par une opération qui n'est pas un fait de l'appareil détenteur : confirmation de commande (mode strict, jamais négatif), livraison (`V_TO_DELIVER`), vente de régularisation, annulation.
8. **Restitution** : à l'annulation d'une vente, `returnSoldGoods` lit `allocation_id` du mouvement `SALE` d'origine ; si le quota est encore actif, une entrée `RESTORE` positive, plafonnée à la consommation d'origine, lui rend la quantité ; sinon elle retourne au stock commun. L'**inverse** d'un mouvement de consommation (correction d'un document, `reverseDocumentMoves`) suit la même règle : il écrit un `RESTORE` plafonné, jamais un `CONSUME` négatif.
9. **Libération et révocation.** La libération est une commande de l'appareil détenteur (`inventory.allocation.release`, permission de portée `OWN`, fait accompli) qui déclare le reste ; un écart avec le reste du serveur ouvre un conflit au lieu d'être corrigé en silence. L'octroi, l'augmentation et la révocation sont en ligne ; l'augmentation porte la version attendue du quota (`base_version`) pour qu'un double envoi ne la compte pas deux fois ; la révocation est motivée et auditée. Un appareil bloqué ou perdu met ses quotas en `revocation_pending` pour décision d'un responsable, sans mouvement automatique ; l'échéance (`valid_until`) alerte, **le serveur ne libère jamais seul**.
10. **Seuils de réapprovisionnement** d'un emplacement `SHARED` : évalués sur le **solde physique** (quotas compris) ; le disponible net des quotas ne sert qu'à la vente en ligne.

## Alternatives

Garder les réservations de commande : contraire à ADR-028 §4. Un quota par lot : le lot d'une sortie est choisi par le FIFO du serveur, l'appareil ne le connaît pas. Consommer dans `sales` : trois règles divergentes (vente, perte, transfert). Laisser le reste de quota devenir négatif : fausse la somme des quotas contre le solde (INV-STK-10) ; le conflit porte déjà l'excédent. Un second mode de garde porté par le PDV : deux sources de vérité, constatées.

## Justification

Un seul point de consommation et un reste jamais négatif rendent INV-STK-10 et INV-STK-11 vérifiables par un balayage de toute la base (R7) ; le couple lu dans l'inbox empêche un appareil modifié de consommer le quota d'un autre ; le fait accompli reste appliqué (BR-SYN-007) sans jamais rendre le disponible d'un autre détenteur négatif.

## Conséquences

BR-STK-011, 012 et INV-STK-10 sont réécrites sans réservation, BR-STK-015 est retirée, SM-ALLOCATION est réduite au quota, ADR-004 porte une note de statut ; INV-STK-19 (Σ restes des quotas actifs ≤ Σ soldes à l'octroi) et INV-STK-20 (reste = Σ entrées ≥ 0, quota fermé = reste 0, Σ `CONSUME` = Σ mouvements portant `allocation_id`) sont ajoutés ; les codes `ALLOCATION_EXCEEDED`, `CUSTODY_DEVICE_MISMATCH` et `ALLOCATION_OVERCOMMITTED` rejoignent les avertissements ; `verifyStockLedger` contrôle le reste des quotas.

## Risques

Un octroi et une sortie concurrents : tous deux verrouillent d'abord les lignes de solde (ordre constant), la sérialisation est testée en concurrence. Un appareil resté hors ligne au-delà de l'échéance bloque son quota : alerte et révocation manuelle, jamais de libération automatique. La dette `qty_allocated` : colonne et jeu `stock` gardent un zéro trompeur jusqu'à sa suppression ; documenté au dictionnaire.
