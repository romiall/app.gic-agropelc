# Checklist avant démarrage du développement

> Section 39 du format final (PM §48). Condition du PM §51 et de REQ-215 : **aucun code applicatif** avant que les éléments marqués « P0 » soient cochés. Les autres éléments sont cochés avant la phase indiquée.
> Responsables : **DIR** = Direction GIC (ou son référent métier) ; **TECH** = équipe technique ; **ADM** = administrateur GIC.
> Règle générale ([`01-plan-developpement.md`](01-plan-developpement.md) §5) : une phase ne démarre que si ses AV **bloquants** sont tranchés. Un AV **important** non tranché n'arrête pas la phase : la valeur par défaut documentée est implémentée de façon **paramétrable**, et cette acceptation est inscrite au journal du registre ([`../A-VALIDER.md`](../A-VALIDER.md) §3).

---

## 1. Validation du cadrage — avant P0

| ✓ | Élément | Document | Resp. |
|---|---|---|---|
| [ ] | Compte rendu de compréhension lu ; résolutions des contradictions C-01 à C-12 acceptées | [`00-reference/01-compte-rendu-comprehension.md`](../00-reference/01-compte-rendu-comprehension.md) | DIR |
| [ ] | Principes, hypothèses H-01 à H-12 et limites L-01 à L-08 acceptés | [`00-reference/02-vision-hypotheses-limites.md`](../00-reference/02-vision-hypotheses-limites.md) | DIR |
| [ ] | Glossaire relu : chaque terme a le sens attendu par les équipes GIC | [`01-functional/01-glossaire.md`](../01-functional/01-glossaire.md) | DIR |
| [ ] | Périmètre du MVP et découpage en releases R1 à R5 validés (AV-001) | [`01-functional/02-perimetre.md`](../01-functional/02-perimetre.md), plan §3 | DIR |
| [ ] | Rôles et matrice RBAC validés, y compris les rôles non listés au CM (AV-004) | [`01-functional/04-acteurs-et-roles.md`](../01-functional/04-acteurs-et-roles.md), [`07-security-rbac/01-rbac.md`](../07-security-rbac/01-rbac.md) | DIR |
| [ ] | Stack technique confirmée (AV-089) | [`05-architecture/05-stack.md`](../05-architecture/05-stack.md), ADR-021 | DIR + TECH |
| [ ] | Registre À VALIDER parcouru ; décision ou acceptation explicite des valeurs par défaut pour tous les AV de P0 (§2) | [`A-VALIDER.md`](../A-VALIDER.md) | DIR |

## 2. Décisions À VALIDER par phase

| Phase | AV bloquants (décision obligatoire) | AV à trancher ou dont le défaut est à accepter | Données à fournir par GIC | Accès externes |
|---|---|---|---|---|
| **P0** Fondations | — | AV-001, AV-004, AV-006, AV-007, AV-008, AV-009, AV-010, AV-073, AV-074, AV-075, AV-077, AV-078, AV-079, AV-084, AV-086, AV-089 | Utilisateurs initiaux et leurs rôles ; liste des sites (AV-002, partielle) | Comptes chez l'hébergeur |
| **P1** Référentiels | — | AV-003 (hiérarchie des zones), AV-017, AV-018, AV-031, AV-061, AV-062, AV-080 | Catalogue produits, unités, conditionnements ; grille de prix en vigueur ; fournisseurs (AV-072) | — |
| **P2** Stock | — | AV-035 (partiel), AV-036, AV-037, AV-038, AV-039, AV-042, AV-081, AV-082 | Emplacements détaillés (AV-002) ; inventaire d'ouverture par emplacement | — |
| **P3** CRM terrain | — | AV-003 (géorepères), AV-011, AV-012, AV-013, AV-014, AV-015, AV-016, AV-021, AV-022, AV-023 | Zones et géorepères ; portefeuilles clients initiaux ; objectifs | — |
| **P4** Ventes | **AV-024, AV-025** | AV-026 à AV-031, AV-033, AV-034, AV-041, AV-056, AV-060, AV-063, AV-083, AV-085, AV-087 | Clients existants ; créances ouvertes ; comptes mobile money | Relevés mobile money (rapprochement) |
| **P5** Distribution | — | AV-007, AV-035, AV-040, AV-057 | Configuration de chaque PDV ; fonds de caisse | — |
| **P6** Approvisionnement | — | AV-051, AV-052, AV-053, AV-054 | Fournisseurs complets ; BC en cours | — |
| **P7** Production | — | AV-004, AV-005, AV-032, AV-043 à AV-049 | Lots en cours (effectifs, dates, coûts engagés) | — |
| **P8** Finance | — | AV-041, AV-042, AV-043, AV-055, AV-058, AV-059, AV-088 | Dettes fournisseurs ouvertes ; catégories de dépenses | — |
| **P9** Analytics | — | AV-013, AV-064, AV-065, AV-066, AV-067, AV-086 | Liste des questions prioritaires de la Direction (CM §62) | — |
| **P10** Kommo | **AV-068** (IMPORTANTE au registre, mais prérequis dur de cette phase : sans connaître les capacités du compte, l'intégration ne peut pas être construite) | AV-069, AV-070, AV-071 | Correspondance des utilisateurs GIC ↔ Kommo | Sandbox Kommo, jeton d'intégration |

Aucun AV bloquant ne concerne P0 à P3 : **la release R1 peut être développée intégralement** avec les valeurs par défaut documentées.

## 3. Organisation et équipe — avant P0

| ✓ | Élément | Référence | Resp. |
|---|---|---|---|
| [ ] | Équipe constituée (profils TypeScript, React, MySQL) et budget d'exploitation validé | AV-084, RISK-21 | DIR |
| [ ] | Référent métier GIC désigné, disponible pour les arbitrages | RISK-18 | DIR |
| [ ] | Revue hebdomadaire du registre À VALIDER planifiée | RISK-18 | DIR + TECH |
| [ ] | Utilisateurs pilotes de R1 identifiés (magasin central, 1 PDV, 2 commerciaux terrain) | Plan §3 | DIR |
| [ ] | Appareil de référence acquis, conforme au parc cible (AV-075), pour mesurer NFR-01, NFR-02, NFR-40 | NFR-34 | TECH |

## 4. Environnement technique — avant P0

| ✓ | Élément | Référence | Resp. |
|---|---|---|---|
| [ ] | Hébergeur retenu : **Hostinger, sans VPS** (tranché, ADR-024) ; plan précis choisi | AV-073, [`05-architecture/04-deploiement.md`](../05-architecture/04-deploiement.md) | DIR + TECH |
| [ ] | Modalité d'exécution du serveur Node.js chez Hostinger sans VPS choisie | AV-090 — sans impact sur P0 à P3 | DIR + TECH |
| [ ] | Base **MySQL 8 ≥ 8.0.19** managée disponible chez Hostinger | ADR-023, NFR-20 | TECH |
| [ ] | Fournisseur de stockage objet S3-compatible choisi (Hostinger sans VPS n'en propose pas) ; privé, versionné ; CDN pour la PWA | ADR-012, AV-091 | TECH |
| [ ] | Environnements `dev`, `staging`, `production` créés | Déploiement §1 | TECH |
| [ ] | Sous-domaine `app.gic-agropelc.com` pointé vers l'hébergement retenu ; TLS automatique | NFR-26, ADR-024 §2 | TECH |
| [ ] | Dépôt : branche principale protégée, revue obligatoire, CI GitHub Actions | Déploiement §3 | TECH |
| [ ] | Secrets générés et stockés dans le gestionnaire de secrets : clé de signature des jetons (EdDSA), clés VAPID, accès au stockage objet | [`07-security-rbac/02-securite.md`](../07-security-rbac/02-securite.md) | TECH |
| [ ] | Supervision : capture des erreurs, collecte OpenTelemetry, sonde de disponibilité externe | [`09-non-functional/02-observabilite.md`](../09-non-functional/02-observabilite.md) | TECH |
| [ ] | Procédure de restauration écrite ; premier test de restauration planifié en staging | NFR-21, NFR-23 | TECH |

## 5. Règles de travail et qualité — avant P0

| ✓ | Élément | Référence | Resp. |
|---|---|---|---|
| [ ] | Chaque développeur (ou session d'IA) a lu `CLAUDE.md` et l'index `docs/README.md` | [`../../CLAUDE.md`](../../CLAUDE.md), [`../README.md`](../README.md) | TECH |
| [ ] | Structure du dépôt et backlog P0 adoptés | [`06-passage-au-developpement.md`](06-passage-au-developpement.md) | TECH |
| [ ] | CI configurée avec les contrôles bloquants : lint, typage, tests, frontières de modules (NFR-32), budget de bundle (NFR-05), références de la documentation (`python3 docs/_tools/check_refs.py`), détection de secrets | Déploiement §3 | TECH |
| [ ] | Définition de « Done » commune adoptée | Plan §4, [`09-non-functional/03-plan-de-tests.md`](../09-non-functional/03-plan-de-tests.md) §7 | TECH |
| [ ] | Jeu de données synthétique de référence défini (aucune donnée réelle hors production) | Plan de tests §2 | TECH |

## 6. Reprise des données (AV-072) — avant chaque release

| ✓ | Élément | Release |
|---|---|---|
| [ ] | Modèles CSV transmis à GIC : sites et emplacements, utilisateurs et rôles, produits et unités, prix | R1 |
| [ ] | Inventaire d'ouverture réalisé et importé en staging (import à blanc), puis en production à la date de bascule | R1 |
| [ ] | Clients et prospects existants, avec titulaire ; créances ouvertes | R1 (clients) / R2 (créances) |
| [ ] | Fournisseurs ; lots en cours ; dettes ouvertes | R3 / R4 |
| [ ] | Date de bascule et procédure de retour arrière fixées pour chaque release | R1 à R5 |

## 7. État en fin de cadrage

| Domaine | État | Commentaire |
|---|---|---|
| Exigences sources, règles métier, invariants | Stabilisé | 99 exigences, 313 règles, 81 invariants ; statut de chaque règle indiqué |
| Workflows, machines à états | Stabilisé | 18 workflows, 30 machines à états |
| Modèle de données | Stabilisé pour P0 à P5 | Tables de P6 à P10 à confirmer avec leurs AV ; types recadrés pour MySQL (ADR-023) |
| Offline, synchronisation, conflits | Stabilisé | Politique de dépassement d'allocation dépendante d'AV-025 (bloquant P4) |
| Sécurité, RBAC, audit | Stabilisé | Rôles additionnels : AV-004 ; défense en profondeur analytique reportée sur les tests (RISK-28) |
| API, événements | Stabilisé (principes, catalogue) | Contrats détaillés écrits phase par phase dans `packages/contracts` |
| Base de données | **Tranchée** | MySQL 8, remplace PostgreSQL (ADR-023) |
| Hébergement | **Tranché** | Hostinger, sans VPS (ADR-024, AV-073) ; modalité d'exécution du serveur encore ouverte (AV-090), sans impact sur P0 à P3 |
| Architecture, modules | Stabilisé | — |
| Stack | Proposée | AV-089 (composants applicatifs inchangés ; seule la base a changé) |
| Décisions métier | 91 points ouverts, dont 2 bloquants (P4) | Voir le registre |

**Verdict** : le développement de **P0** peut commencer dès que les sections 1, 3, 4 et 5 sont cochées et que les AV de P0 sont tranchés ou leurs valeurs par défaut acceptées. Aucune spécification manquante n'oblige à improviser pour P0 à P3. Le recadrage base de données et hébergement (ADR-023, ADR-024) ne retarde pas ce verdict : le développement reste entièrement local jusqu'au déploiement.
