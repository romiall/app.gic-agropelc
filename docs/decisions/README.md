# Registre des décisions d'architecture (Livrable n°18)

> Section 35 du format final (PM §48). Format : Contexte, Décision, Alternatives étudiées, Justification, Conséquences, Risques (PM §43).
> Statuts : **ACCEPTÉ** (retenu pour le développement), **PROPOSÉ** (à confirmer), **À VALIDER** (dépend d'une décision métier du registre `A-VALIDER.md`), **REMPLACÉ**.

| ADR | Titre | Statut | Exigé par le PM §43 |
|---|---|---|---|
| [ADR-001](ADR-001-offline-first.md) | Offline-first : PWA, base locale, commandes, serveur autoritaire | ACCEPTÉ | Oui |
| [ADR-002](ADR-002-identifiants.md) | Stratégie d'identifiants | ACCEPTÉ | Oui |
| [ADR-003](ADR-003-registre-stock.md) | Registre de stock en partie double | ACCEPTÉ | Oui |
| [ADR-004](ADR-004-allocations-offline.md) | Garde exclusive, quotas et réservations | ACCEPTÉ (politique AV-025, AV-035) | Oui |
| [ADR-005](ADR-005-historisation-prix.md) | Historisation des prix | ACCEPTÉ | Oui |
| [ADR-006](ADR-006-annulation-vs-suppression.md) | Annulation vs suppression | ACCEPTÉ | Oui |
| [ADR-007](ADR-007-synchronisation.md) | Stratégie de synchronisation | ACCEPTÉ | Oui |
| [ADR-008](ADR-008-rbac.md) | Modèle RBAC | ACCEPTÉ | Oui |
| [ADR-009](ADR-009-frontieres-kommo.md) | Frontières avec Kommo | ACCEPTÉ (AV-068 à 071) | Oui |
| [ADR-010](ADR-010-comptabilite-operationnelle.md) | Comptabilité opérationnelle | ACCEPTÉ | Oui |
| [ADR-011](ADR-011-architecture-backend.md) | Architecture backend | ACCEPTÉ | Oui |
| [ADR-012](ADR-012-pieces-jointes-offline.md) | Pièces jointes offline | ACCEPTÉ | Oui |
| [ADR-013](ADR-013-monnaie-quantites.md) | Monnaie, montants, quantités | ACCEPTÉ | — |
| [ADR-014](ADR-014-commande-vente-livraison.md) | Commande, vente, livraison | À VALIDER (AV-024) | — |
| [ADR-015](ADR-015-valorisation.md) | Valorisation et coûts de production | À VALIDER (AV-042, AV-043) | — |
| [ADR-016](ADR-016-temps-metier.md) | Temps métier et horloges | ACCEPTÉ | — |
| [ADR-017](ADR-017-compte-client-unique.md) | Compte client unique | ACCEPTÉ (AV-012) | — |
| [ADR-018](ADR-018-validations-generiques.md) | Validations génériques | ACCEPTÉ | — |
| [ADR-019](ADR-019-style-api.md) | Style d'API | ACCEPTÉ | — |
| [ADR-020](ADR-020-postgresql.md) | PostgreSQL | REMPLACÉ (par ADR-023) | — |
| [ADR-021](ADR-021-stack-technique.md) | Stack technique | PROPOSÉ | — |
| [ADR-022](ADR-022-structure-documentaire.md) | Organisation de la documentation | ACCEPTÉ | — |
| [ADR-023](ADR-023-mysql.md) | Base de données : MySQL (remplace ADR-020) | ACCEPTÉ | — |
| [ADR-024](ADR-024-hebergement-hostinger.md) | Hébergement cible : Hostinger sans VPS | ACCEPTÉ | — |

Règle : toute nouvelle décision structurante pendant le développement fait l'objet d'un nouvel ADR (numérotation continue). Une décision remplacée n'est pas supprimée : elle passe au statut REMPLACÉ, avec un lien vers la remplaçante.
