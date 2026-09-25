# Modèle fonctionnel par domaines (Livrable n°3)

> Section 7 du format final. Chaque fichier de domaine suit la même structure en 14 rubriques (PM §23) :
> 1. Objectif · 2. Acteurs · 3. Principales entités · 4. Cas d'usage · 5. Entrées · 6. Sorties · 7. Règles métier · 8. Validations · 9. Dépendances · 10. Événements produits · 11. Événements consommés · 12. Fonctionnement hors ligne · 13. Permissions · 14. Exceptions

Les **règles métier** (`BR-<DOM>-nnn`) sont définies **uniquement** dans ces fichiers. L'index consolidé est [`../05-index-regles-metier.md`](../05-index-regles-metier.md).
Les **invariants** (`INV-*`) sont définis dans [`../../02-domain-model/01-invariants.md`](../../02-domain-model/01-invariants.md) et seulement référencés ici.

## Correspondance avec les 22 domaines du PM §23

Le PM autorise la fusion « lorsque cela améliore réellement la cohérence ». Les fusions retenues et leur justification :

| Domaine PM §23 | Fichier | Justification de la fusion |
|---|---|---|
| 1. Core / Administration | [D01-ADM](D01-ADM-core-administration.md) | Identité, organisation, appareils, validations et pièces justificatives forment le socle commun. |
| 2. Commercial / CRM opérationnel | [D02-CRM](D02-CRM-commercial.md) | — |
| 3. Pointage terrain | [D03-TER](D03-TER-pointage-terrain.md) | Gardé séparé : règles géographiques propres. |
| *(absent du PM)* Commandes et ventes | [D04-VEN](D04-VEN-commandes-ventes.md) | Ajouté (tension C-10) : c'est le cœur de COMMANDER → VENDRE → LIVRER. |
| 4. Distribution + 6. Points de vente | [D05-DIS](D05-DIS-distribution-points-de-vente.md) | Un point de vente est l'unité de distribution (CM §12) ; allocations, caisse et réapprovisionnement sont indissociables. |
| 5. Stocks | [D06-STK](D06-STK-stocks.md) | — |
| 7. Production, 8. Volaille, 9. Œufs, 10. Incubation, 11. Porcs | [D07-PRD](D07-PRD-production.md) | Un seul fichier avec un tronc commun (lots, mortalité, consommation, coûts) et une sous-section par filière, pour ne pas les confondre (CM §14) tout en partageant le modèle de lot. |
| 12. Approvisionnement, 13. Fournisseurs, 14. Achats, 15. Réceptions | [D08-APP](D08-APP-approvisionnement.md) | Un seul processus continu (CM §27) : Besoin → DA → Validation → BC → Réception. |
| 16. Finance | [D09-FIN](D09-FIN-finance.md) | Inclut factures et paiements fournisseurs (dettes). |
| 17. Pricing | [D10-PRX](D10-PRX-tarification.md) | — |
| 18. Analytics | [D11-ANA](D11-ANA-analytics.md) | Inclut les tableaux de bord. |
| 19. Audit | [D12-AUD](D12-AUD-audit.md) | — |
| 20. Notifications | [D13-NOT](D13-NOT-notifications-communication.md) | Inclut alertes et notes de direction (CM §43, §54). |
| 21. Synchronisation | [D14-SYN](D14-SYN-synchronisation.md) | — |
| 22. Kommo | [D15-KOM](D15-KOM-kommo.md) | — |
| *(absent du PM §23, cité au PM §39 phase 1)* Catalogue et référentiels | [D16-CAT](D16-CAT-catalogue-referentiels.md) | Ajouté : produits, unités et motifs sont partagés par tous les domaines et doivent avoir un propriétaire unique (CM §59). |

## Conventions propres à ces fichiers

- **Cas d'usage** : `UC-<DOM>-nn`. Chaque cas d'usage cite la **commande technique** (`module.agrégat.verbe`) qui l'implémente (catalogue complet : [`../../08-api-events/01-architecture-api.md`](../../08-api-events/01-architecture-api.md)).
- **Événements** : noms du catalogue [`../../08-api-events/02-catalogue-evenements.md`](../../08-api-events/02-catalogue-evenements.md).
- **Permissions** : codes de la matrice [`../../07-security-rbac/01-rbac.md`](../../07-security-rbac/01-rbac.md).
- **Machines à états** : `SM-*` dans [`../../04-workflows/machines-a-etats/`](../../04-workflows/machines-a-etats/).
