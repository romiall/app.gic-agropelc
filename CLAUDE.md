# CLAUDE.md — règles de travail sur le projet GIC AGROPELC

Ce fichier s'adresse à toute session Claude Code et à tout développeur qui travaille dans ce dépôt. Il est court : le détail est dans `docs/`.

## 1. État du projet

- **Cadrage terminé** : le référentiel d'ingénierie complet est dans [`docs/`](docs/README.md) (39 sections du Prompt maître §48, puis l'audit de cohérence).
- **Phase P0 : code terminé** (P0-01 à P0-16, 25/09/2026 ; AV-089 et AV-073 tranchés le 24/09/2026, voir [`docs/A-VALIDER.md`](docs/A-VALIDER.md) §3). Restent P0-17 (`staging` déployé) et le volet matériel de P0-18 (démonstration sur appareil physique), hors de portée d'une session sans accès Hostinger — voir [`docs/10-development-plan/07-demonstration-p0.md`](docs/10-development-plan/07-demonstration-p0.md). Backlog et structure : [`docs/10-development-plan/06-passage-au-developpement.md`](docs/10-development-plan/06-passage-au-developpement.md). GitHub est la source de vérité : chaque incrément est commité et poussé ; l'environnement local ne sert qu'à récupérer le dépôt et exécuter/tester. Aucun déploiement Hostinger n'est requis pour P0 à P3 (ADR-024 §5). **Prochaine étape : phase P1** (référentiels métier).
- Documentation rédigée en **français**.

## 2. Sources et hiérarchie

| Source | Rôle |
|---|---|
| `Contexte métier de référence — Projet GIC AGROPELC.md` (CM) | Source de vérité **métier** (le quoi). Ne jamais la modifier. |
| `Prompt maître — Cadrage technique et architecture GIC AGROPELC.md` (PM) | Instruction **technique** (le comment). Ne jamais la modifier. |
| `docs/` | Référentiel dérivé des deux sources ; fait foi pour le développement. |

En cas de contradiction : le CM décide du quoi, le PM du comment, et le point est tracé (`C-nn` ou `AV-nnn`).

## 3. Règles absolues

1. **Classer chaque affirmation** : CONFIRMÉ (écrit dans une source), DÉDUIT (conséquence argumentée), À VALIDER (décision en attente). Une hypothèse n'est jamais présentée comme une exigence.
2. **Ne jamais combler un trou en silence.** Une question métier non couverte devient un point `AV-nnn` dans [`docs/A-VALIDER.md`](docs/A-VALIDER.md) (question, pourquoi, choix, recommandation, impact, classe). La valeur par défaut est implémentée de façon **paramétrable**, et le travail continue. Seul un AV **bloquant** arrête la phase concernée (aujourd'hui : AV-024 et AV-025, pour P4).
3. **Toute écriture est une commande idempotente** (`command_id`, `device_seq`, `occurred_at`), validée par le serveur. Aucun fait accompli n'est rejeté pour une raison d'état métier (BR-SYN-007).
4. **Rien ne disparaît** : pas de suppression physique d'une opération sensible ; correction par annulation ou contre-écriture (ADR-006). Le journal d'audit est en ajout seul.
5. **Frontières de modules** : une table n'est écrite que par son module propriétaire ; un module n'importe que l'API publique des modules de niveau inférieur ([graphe](docs/05-architecture/03-graphe-dependances.md)).
6. **Logique métier partagée** : validations, moteur de prix, politiques, disponibilité et arrondis vivent dans `packages/domain`, sans entrée-sortie, et s'exécutent à l'identique sur l'appareil et le serveur (ADR-021).
7. **Temps et argent** : quatre horodatages (`occurred_at`, `client_created_at`, `received_at`, `applied_at`), fuseau `Africa/Douala` ; montants en XAF entiers ; quantités en `numeric(14,3)` (ADR-013, ADR-016).
8. **Seuils = paramètres** : aucun seuil métier codé en dur (`organization.system_settings`, historisés).

## 4. Avant de travailler sur une phase ou une fonctionnalité

Lire, dans cet ordre :

1. [`docs/README.md`](docs/README.md) — index maître ;
2. [`docs/00-reference/00-conventions.md`](docs/00-reference/00-conventions.md) — identifiants, statuts, nommage ;
3. [`docs/10-development-plan/06-passage-au-developpement.md`](docs/10-development-plan/06-passage-au-developpement.md) — structure du dépôt, backlog, règles R1 à R11 ;
4. la fiche de la phase dans [`docs/10-development-plan/01-plan-developpement.md`](docs/10-development-plan/01-plan-developpement.md) §4 ;
5. les lignes de la phase dans la [matrice de traçabilité](docs/10-development-plan/02-matrice-tracabilite.md), puis chaque document qu'elles citent : domaine (`docs/01-functional/domaines/Dnn`), tables (`docs/03-data/dictionnaire/`), machine à états (`SM-*`), workflow (`WF-*`), permissions (`docs/07-security-rbac/01-rbac.md`), tests d'acceptation (`AT-*`).

## 5. En fin de modification

- Dans le **même commit** que le changement : mettre à jour le dictionnaire (schéma), la matrice (exigence), le registre AV (décision), un nouvel ADR (décision structurante), l'index des règles (`python3 docs/_tools/check_refs.py --index`).
- Lancer `python3 docs/_tools/check_refs.py` : il doit afficher « aucune référence orpheline » et « aucun lien relatif cassé ».
- Chaque invariant `INV-*` touché a au moins un test ; chaque test d'acceptation de la phase est automatisé.
- Messages de commit en français, préfixés par la portée (ex. `docs(cadrage): …`, `feat(inventory): …`).

## 6. Identifiants

`REQ` exigences · `BR-<DOM>` règles métier · `INV-<DOM>` invariants · `ADR` décisions · `AV` questions ouvertes · `SM-*` machines à états · `WF-nn` workflows · `ECR-<DOM>` écrans · `NFR` exigences non fonctionnelles · `AT` tests d'acceptation · `RISK` risques · `C-nn` contradictions entre les sources. Chaque identifiant est défini à un seul endroit ; les formats sont dans [`docs/00-reference/00-conventions.md`](docs/00-reference/00-conventions.md) §3.
