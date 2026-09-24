# Machines à états (Livrable n°4, partie 2)

> Section 9 du format final (PM §48). Chaque machine donne un diagramme Mermaid et la table de transitions exigée par le PM §24 :
> | État initial | Action | Condition | Nouvel état | Effets métier | Effets stock | Effets finance | Permission |
> Sous chaque table, un paragraphe **Hors ligne** précise quelles transitions peuvent être déclenchées sans réseau et comment elles sont réconciliées.

Convention : `[*]` = création. Une transition absente de la table est **interdite** : le serveur la refuse avec `INVALID_TRANSITION`.

| Fichier | Machines |
|---|---|
| [01-commercial.md](01-commercial.md) | SM-CUSTOMER, SM-WORK-SESSION, SM-VISIT |
| [02-ventes-caisse.md](02-ventes-caisse.md) | SM-ORDER, SM-SALE, SM-CUSTOMER-PAYMENT, SM-CASH-SESSION, SM-CASH-TRANSFER |
| [03-stock.md](03-stock.md) | SM-TRANSFER, SM-LOSS, SM-INVENTORY-COUNT, SM-ALLOCATION |
| [04-production.md](04-production.md) | SM-PRODUCTION-LOT, SM-INCUBATION, SM-EGG-COLLECTION |
| [05-achats-finance.md](05-achats-finance.md) | SM-PURCHASE-REQUEST, SM-PURCHASE-ORDER, SM-RECEIPT, SM-SUPPLIER-INVOICE, SM-SUPPLIER-PAYMENT, SM-EXPENSE |
| [06-transverses.md](06-transverses.md) | SM-SYNC-COMMAND, SM-CONFLICT, SM-APPROVAL, SM-DEVICE, SM-USER, SM-ATTACHMENT, SM-ALERT, SM-PRICE-RULE, SM-INTEGRATION-MESSAGE |

Les workflows interdomaines qui combinent ces machines sont dans [`../01-workflows.md`](../01-workflows.md).
