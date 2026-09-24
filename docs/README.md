# Référentiel de cadrage GIC AGROPELC — index maître

> Ce dossier contient le **document de cadrage** demandé par le Prompt maître : un référentiel d'ingénierie qui stabilise le système **avant** toute ligne de code (PM §49, §51).
> Le PM §48 demande « un document structuré exactement dans cet ordre ». Pour rester maintenable, chaque section vit dans son propre fichier (contradiction C-12) ; **le tableau ci-dessous restitue l'ordre exact des 39 sections**, suivi de l'audit de cohérence exigé par le PM §50.

**Sources** (à la racine du dépôt, jamais modifiées) :

- [Contexte métier de référence](<../Contexte métier de référence — Projet GIC AGROPELC.md>) (**CM**) : source de vérité métier, le *quoi* ;
- [Prompt maître](<../Prompt maître — Cadrage technique et architecture GIC AGROPELC.md>) (**PM**) : instruction d'exécution, le *comment*.

**Classification** de chaque affirmation : **CONFIRMÉ** (écrit dans une source), **DÉDUIT** (conséquence argumentée), **À VALIDER** (décision en attente, identifiant `AV-nnn`). Conventions : [`00-reference/00-conventions.md`](00-reference/00-conventions.md).

---

## 1. Le document de cadrage, dans l'ordre du PM §48

| § | Section | Document | Livrable PM |
|---:|---|---|---|
| 1 | Executive Summary | [`00-reference/03-executive-summary.md`](00-reference/03-executive-summary.md) | — |
| 2 | Vision système | [`00-reference/02-vision-hypotheses-limites.md`](00-reference/02-vision-hypotheses-limites.md) §1 | — |
| 3 | Hypothèses et limites | [`00-reference/02-vision-hypotheses-limites.md`](00-reference/02-vision-hypotheses-limites.md) §2, §3 | — |
| 4 | Glossaire métier | [`01-functional/01-glossaire.md`](01-functional/01-glossaire.md) | n°1 |
| 5 | Périmètre | [`01-functional/02-perimetre.md`](01-functional/02-perimetre.md) | n°2 |
| 6 | Acteurs et rôles | [`01-functional/04-acteurs-et-roles.md`](01-functional/04-acteurs-et-roles.md) | n°3 (partie) |
| 7 | Domaines fonctionnels | [`01-functional/domaines/README.md`](01-functional/domaines/README.md) (D01 à D16) | n°3 |
| 8 | Workflows | [`04-workflows/01-workflows.md`](04-workflows/01-workflows.md) ; parcours par rôle et écrans : [`01-functional/03-parcours-et-ecrans.md`](01-functional/03-parcours-et-ecrans.md) | n°4 |
| 9 | Machines à états | [`04-workflows/machines-a-etats/README.md`](04-workflows/machines-a-etats/README.md) | n°4 |
| 10 | Règles métier | [`01-functional/05-index-regles-metier.md`](01-functional/05-index-regles-metier.md) (index généré ; les règles font foi dans chaque domaine) | n°3 |
| 11 | Invariants | [`02-domain-model/01-invariants.md`](02-domain-model/01-invariants.md) | n°6 |
| 12 | Modèle conceptuel de données | [`02-domain-model/02-modele-conceptuel-erd.md`](02-domain-model/02-modele-conceptuel-erd.md) §1, §2 | n°5 |
| 13 | ERD Mermaid | [`02-domain-model/02-modele-conceptuel-erd.md`](02-domain-model/02-modele-conceptuel-erd.md) §3, §4 | n°5 |
| 14 | Modèle relationnel détaillé | [`03-data/02-modele-relationnel.md`](03-data/02-modele-relationnel.md) ; conventions : [`03-data/01-identifiants-et-conventions.md`](03-data/01-identifiants-et-conventions.md) ; historisation et suppression : [`03-data/03-historisation-suppression.md`](03-data/03-historisation-suppression.md) | n°5 |
| 15 | Dictionnaire de données | [`03-data/dictionnaire/README.md`](03-data/dictionnaire/README.md) (12 fichiers) | n°5 |
| 16 | Stratégie stock | [`02-domain-model/03-strategie-stock.md`](02-domain-model/03-strategie-stock.md) | — |
| 17 | Stratégie pricing | [`02-domain-model/04-strategie-pricing.md`](02-domain-model/04-strategie-pricing.md) | — |
| 18 | Architecture offline-first | [`06-offline-sync/01-architecture-offline.md`](06-offline-sync/01-architecture-offline.md) | n°7 |
| 19 | Stratégie de synchronisation | [`06-offline-sync/02-synchronisation.md`](06-offline-sync/02-synchronisation.md) | n°7 |
| 20 | Matrice des conflits | [`06-offline-sync/03-matrice-conflits.md`](06-offline-sync/03-matrice-conflits.md) | n°7 |
| 21 | RBAC | [`07-security-rbac/01-rbac.md`](07-security-rbac/01-rbac.md) | n°8 |
| 22 | Architecture API | [`08-api-events/01-architecture-api.md`](08-api-events/01-architecture-api.md) | n°9 |
| 23 | Catalogue d'événements | [`08-api-events/02-catalogue-evenements.md`](08-api-events/02-catalogue-evenements.md) | n°10 |
| 24 | Intégration Kommo | [`08-api-events/03-integration-kommo.md`](08-api-events/03-integration-kommo.md) | — |
| 25 | Architecture logicielle | [`05-architecture/01-architecture-logicielle.md`](05-architecture/01-architecture-logicielle.md) | n°11 |
| 26 | Modules de code | [`05-architecture/02-modules.md`](05-architecture/02-modules.md) | n°12 |
| 27 | Exigences non fonctionnelles | [`09-non-functional/01-exigences-non-fonctionnelles.md`](09-non-functional/01-exigences-non-fonctionnelles.md) | n°13 |
| 28 | Sécurité | [`07-security-rbac/02-securite.md`](07-security-rbac/02-securite.md) ; journal d'audit : [`07-security-rbac/03-audit.md`](07-security-rbac/03-audit.md) | n°14 |
| 29 | Observabilité | [`09-non-functional/02-observabilite.md`](09-non-functional/02-observabilite.md) | — |
| 30 | Plan de tests | [`09-non-functional/03-plan-de-tests.md`](09-non-functional/03-plan-de-tests.md) | — |
| 31 | Architecture de déploiement | [`05-architecture/04-deploiement.md`](05-architecture/04-deploiement.md) | — |
| 32 | Plan de développement | [`10-development-plan/01-plan-developpement.md`](10-development-plan/01-plan-developpement.md) | n°15 |
| 33 | Graphe de dépendances | [`05-architecture/03-graphe-dependances.md`](05-architecture/03-graphe-dependances.md) | n°16 |
| 34 | Matrice de traçabilité | [`10-development-plan/02-matrice-tracabilite.md`](10-development-plan/02-matrice-tracabilite.md) | n°17 |
| 35 | ADR | [`decisions/README.md`](decisions/README.md) (ADR-001 à ADR-022) | n°18 |
| 36 | Registre des risques | [`10-development-plan/03-registre-risques.md`](10-development-plan/03-registre-risques.md) | n°19 |
| 37 | Questions ouvertes | [`A-VALIDER.md`](A-VALIDER.md) (registre central, 89 points) | n°20 |
| 38 | Recommandation de stack | [`05-architecture/05-stack.md`](05-architecture/05-stack.md) | — |
| 39 | Checklist avant démarrage du développement | [`10-development-plan/04-checklist-demarrage.md`](10-development-plan/04-checklist-demarrage.md) | — |
| — | **AUDIT DE COHÉRENCE DU CAHIER DES CHARGES** (PM §50) | [`10-development-plan/05-audit-coherence.md`](10-development-plan/05-audit-coherence.md) | — |

## 2. Documents complémentaires

| Document | Rôle |
|---|---|
| [`00-reference/00-conventions.md`](00-reference/00-conventions.md) | Statuts, formats d'identifiants, règles de nommage, blocs standard |
| [`00-reference/01-compte-rendu-comprehension.md`](00-reference/01-compte-rendu-comprehension.md) | Contrôle de compréhension initial ; contradictions C-01 à C-12 entre les sources et leur résolution |
| [`01-functional/00-exigences-sources.md`](01-functional/00-exigences-sources.md) | Extraction fidèle des exigences des sources (REQ-001 à REQ-084, REQ-201 à REQ-215) |
| [`02-domain-model/05-strategie-finance-couts.md`](02-domain-model/05-strategie-finance-couts.md) | Finance opérationnelle, valorisation et coûts de lot, avec exemple chiffré |
| [`10-development-plan/06-passage-au-developpement.md`](10-development-plan/06-passage-au-developpement.md) | Structure cible du dépôt, backlog ordonné de P0, règles de travail des sessions de développement |
| [`_tools/check_refs.py`](_tools/check_refs.py) | Contrôle des identifiants et des liens de la documentation ; régénération de l'index des règles |

## 3. Parcours de lecture conseillés

| Lecteur | Ordre de lecture |
|---|---|
| **Direction GIC** | Executive Summary → Registre À VALIDER (décisions attendues) → Checklist de démarrage → Plan de développement §2, §3 |
| **Développeur ou session d'IA qui démarre une phase** | [`../CLAUDE.md`](../CLAUDE.md) → Conventions → Passage au développement → Fiche de la phase (plan §4) → Matrice de traçabilité (lignes de la phase) → Domaines, dictionnaire, machines à états, workflows, RBAC et tests cités |
| **Architecte ou relecteur technique** | Vision → Architecture logicielle → Modules et graphe → Offline et synchronisation → Modèle relationnel → ADR → Audit de cohérence |
| **Recette et tests** | Plan de tests (§6 : AT-001 à AT-055) → Matrice de traçabilité → Workflows |

## 4. Règles de maintenance

1. Un identifiant est défini à **un seul endroit** et référencé partout ailleurs ([`00-reference/00-conventions.md`](00-reference/00-conventions.md) §3).
2. `python3 docs/_tools/check_refs.py` doit renvoyer « aucune référence orpheline » et « aucun lien relatif cassé » avant chaque commit ; `--index` régénère l'index des règles métier.
3. Les sources (CM, PM) ne sont jamais modifiées. Toute évolution métier passe par le registre À VALIDER, puis par la mise à jour des documents concernés ; toute décision technique structurante, par un nouvel ADR.
