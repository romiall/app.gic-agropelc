# ADR-023 — Base de données : MySQL (remplace ADR-020)

- **Statut** : ACCEPTÉ (recadrage confirmé par le porteur du projet ; remplace [ADR-020](ADR-020-postgresql.md))
- **Date** : 24/09/2026 (ADR-020) ; recadrage : session du 24/09/2026

## Contexte

ADR-020 retenait PostgreSQL sur la base d'une analyse fonctionnelle pure (invariants, contraintes, reporting), sans contrainte d'hébergement. Le porteur du projet a depuis confirmé une contrainte ferme : l'hébergement de production se fera chez **Hostinger**, **sans VPS** (AV-073 tranché, voir [`../A-VALIDER.md`](../A-VALIDER.md)). Les offres Hostinger sans VPS mettent à disposition une base **MySQL** managée ; une base PostgreSQL managée n'y est pas proposée en dehors d'une installation manuelle sur un VPS, explicitement écartée.

La question n'est donc plus « quelle est la meilleure base dans l'absolu » mais : **MySQL peut-il porter les mêmes garanties que celles obtenues avec PostgreSQL, sans dégrader un invariant métier ?** Un audit complet de toutes les dépendances PostgreSQL du cadrage a été mené pour y répondre : voir [`../05-architecture/05-stack.md`](../05-architecture/05-stack.md) §3, qui contient le tableau complet (besoin, implémentation PostgreSQL actuelle, limitation MySQL, alternative, garantie obtenue).

## Décision

**MySQL 8.0 (≥ 8.0.19), moteur InnoDB**, est retenu comme base relationnelle cible, en service managé chez Hostinger pour le développement et la production (hors phase de développement local, qui n'en dépend pas — voir §5).

Chaque garantie précédemment obtenue par une fonctionnalité propre à PostgreSQL est reportée sur un mécanisme équivalent :

| Fonctionnalité PostgreSQL | Report sur MySQL 8 |
|---|---|
| Index uniques partiels | Colonne générée stockée (NULL hors condition) + `UNIQUE` sur cette colonne |
| Contraintes d'exclusion (périodes non chevauchantes) | Verrouillage de ligne (`SELECT … FOR UPDATE`) dans le gestionnaire de commande + déclencheur de re-vérification |
| Hiérarchie de zones (tableau + GIN) | Table de fermeture transitive (`zone_ancestors`) |
| Recherche approchée (`pg_trgm`) | Index plein texte MySQL, analyseur `ngram` |
| Verrous consultatifs | `SELECT … FOR UPDATE` sur une ligne dédiée de la même transaction |
| File de tâches `SKIP LOCKED` | Table de tâches maison dans `platform`, `SELECT … FOR UPDATE SKIP LOCKED` (MySQL ≥ 8.0.1) ; **pg-boss abandonné** (bibliothèque propre à PostgreSQL) |
| Type `uuid` natif | `BINARY(16)`, conversion par `packages/domain` |
| `timestamptz` | `DATETIME(6)`, toujours écrit et lu en UTC par un convertisseur unique partagé |
| `jsonb` | `JSON` natif (même restriction : charges techniques uniquement) |
| Déclencheurs d'immuabilité, privilège `DELETE` retiré | Identique (syntaxe `SIGNAL` au lieu de `RAISE EXCEPTION`) |
| Contraintes `CHECK` | Identique à partir de MySQL 8.0.16 (réellement appliquées, contrairement aux versions antérieures) |
| Un schéma PostgreSQL par module | Une seule base MySQL ; tables préfixées par module ; `GRANT` **par table** au lieu de par schéma (même garantie, granularité identique) |
| Partitionnement dès la création des registres | **Reporté** : les tables `audit.audit_log`, `inventory.stock_moves`, `sync.command_inbox`, `sync.change_feed`, `platform.domain_events` ne sont pas partitionnées au P0/P2 (le partitionnement MySQL impose des contraintes sur les clés étrangères entrantes incompatibles avec ces tables très référencées) ; la volumétrie H-06 (~20 000 lignes d'audit/jour) laisse plusieurs années de marge avec de bons index ; un archivage applicatif prend le relais avant la limite. Voir RISK-27 |
| RLS analytique (défense en profondeur) | **Non reportée** : MySQL n'a pas d'équivalent. Le filtrage de portée applicatif (`scopeFilter`, RC-01/RC-02) reste l'unique ligne d'enforcement, compensée par une couverture de test systématique (un test de limite de portée par rôle × jeu de faits) et l'absence de tout accès direct à la base pour un utilisateur final. Voir RISK-28 |

**Seule réduction de garantie non entièrement compensée par un mécanisme déclaratif équivalent** : la défense en profondeur RLS de l'analytique, remplacée par une discipline de test renforcée plutôt que par une seconde couche indépendante d'exécution. Aucun invariant `INV-*` n'est affaibli : les 79 des 81 invariants qui ne portent pas sur l'analytique gardent une garantie de niveau base de données strictement équivalente ; les 2 qui en dépendent (BR-ANA-004 et la défense en profondeur associée) restent garantis par le code, avec une couverture de test renforcée en compensation.

## Alternatives étudiées

1. **Conserver PostgreSQL, ouvrir un VPS chez Hostinger.** Rejeté : contrainte ferme du porteur de projet (pas de VPS), quel que soit son bien-fondé technique.
2. **Conserver PostgreSQL chez un hébergeur managé tiers (hors Hostinger), Hostinger ne servant que le domaine.** Non retenu pour cette décision : Hostinger est confirmé comme cible d'hébergement de la base et du calcul ; multiplier les fournisseurs pour la seule base contredirait la simplicité recherchée (AV-084, RISK-21). Reste une option de repli si l'audit ci-dessus révélait une garantie irréparable — ce n'est pas le cas.
3. **Base NoSQL ou base « offerte » par une plateforme (Firebase, etc.).** Toujours écarté, pour les raisons déjà données par ADR-020 §« Pourquoi pas une base NoSQL / synchronisée » : le domaine reste un graphe de références fortes avec des transactions multi-entités ; rien dans la contrainte Hostinger ne change cette analyse.
4. **MySQL sans report des garanties** (accepter des invariants purement applicatifs, sans déclencheur ni verrou). Rejeté : contredit l'exigence explicite de ne pas réduire une garantie métier pour faciliter le changement de base.

## Justification

L'audit démontre que MySQL 8 porte un report fidèle pour la quasi-totalité des mécanismes utilisés (contraintes, immuabilité, concurrence, identifiants, file de tâches). Le seul renoncement réel (RLS) porte sur une couche de défense **secondaire**, déjà documentée comme telle avant ce recadrage (`07-security-rbac/02-securite.md` §4 : « en plus du filtrage applicatif »), jamais comme le mécanisme principal d'un invariant `INV-*`. Le report du partitionnement n'affecte aucune garantie de correction, seulement un palier de dimensionnement encore loin d'être atteint. Aucun repli vers un VPS n'est donc nécessaire.

## Conséquences

- `packages/domain` gagne un point de conversion UUID ↔ `BINARY(16)` et un convertisseur horodatage UTC unique, partagés par tous les modules.
- Les migrations SQL ciblent la syntaxe MySQL ; `dbmate` reste l'outil retenu (compatible MySQL nativement, aucun changement d'outillage).
- Kysely change de dialecte (pilote `mysql2` au lieu de `pg`) ; le reste de la bibliothothèque d'accès SQL typé est inchangé.
- La bibliothèque de file de tâches change : `pg-boss` est abandonné au profit d'une table de tâches maison dans `platform` (quelques dizaines de lignes), sur le même schéma `SELECT … FOR UPDATE SKIP LOCKED`.
- Trois nouveaux mécanismes à documenter précisément en P0 : colonnes générées pour les unicités conditionnelles, table de fermeture transitive pour les zones, verrouillage de ligne pour les remplacements d'advisory locks. Voir [`../05-architecture/05-stack.md`](../05-architecture/05-stack.md) §3 pour le détail table par table.
- Le développement de P0 à P3 (release R1) est **entièrement local** : MySQL en conteneur de développement/test, aucun accès à Hostinger requis (voir ADR-024).

## Risques

RISK-27 (dette technique liée aux reports MySQL), RISK-28 (perte de la défense en profondeur RLS), RISK-24 (valorisation, inchangé). Voir [`../10-development-plan/03-registre-risques.md`](../10-development-plan/03-registre-risques.md).
