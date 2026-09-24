# ADR-008 — Modèle RBAC : rôles multiples, portées, affectations bornées, évaluation à la date réelle

- **Statut** : ACCEPTÉ (CONFIRMÉ CM §6, §47, §48 ; PM §17, §31)
- **Date** : 24/09/2026

## Contexte
Un utilisateur cumule plusieurs rôles (CM §6, §47). Les accès dépendent du périmètre : propre, équipe, site, zone, tout (CM §48 ; PM §31). Des opérations sont saisies hors ligne puis appliquées plus tard.

## Décision
- Tables `roles`, `permissions`, `role_permissions` (avec portée maximale et limites paramétriques), `user_role_assignments` (rôle × périmètre concret × période).
- Droit effectif = union des affectations actives ; intersection de la portée maximale et du périmètre de l'affectation.
- Évaluation **à `occurred_at`** pour les commandes (hors ligne comprises).
- Séparation des tâches : approbateur ≠ demandeur ; Admin sans approbation métier (AV-010).
- Matrice versionnée en données de référence ; tests générés depuis la matrice.
- RLS PostgreSQL sur les vues analytiques, en défense en profondeur.

## Alternatives étudiées
- Champ `role` unique sur l'utilisateur : incompatible avec le cumul (PM §17).
- ABAC complet (politiques par attributs) : plus puissant, mais plus opaque et plus difficile à tester ; les portées couvrent les besoins actuels.

## Justification
Modèle lisible par un administrateur, testable, extensible par configuration (nouveaux rôles sans code, AV-004).

## Conséquences
L'évaluateur de portée dépend d'`organization` (zones, sites, équipes) ; `identity` est placé au-dessus d'`organization` dans le graphe ; cache des droits invalidé par événement.

## Risques
RISK-26.
