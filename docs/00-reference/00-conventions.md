# Conventions de la documentation d'ingénierie GIC AGROPELC

> Statut du document : **normatif** pour toute la documentation du dossier `docs/` et pour les futures sessions de développement.

---

## 1. Sources et hiérarchie

| Code | Document | Rôle | Emplacement |
|---|---|---|---|
| **CM** | « Contexte métier de référence — Projet GIC AGROPELC » | **Source de vérité métier** : définit CE QUE le système doit accomplir. | racine du dépôt |
| **PM** | « Prompt maître — Cadrage technique et architecture GIC AGROPELC » | **Instruction d'exécution** : définit COMMENT analyser, formaliser et architecturer. | racine du dépôt |

Règles :

1. Une information du CM n'est jamais remplacée par une hypothèse technique.
2. En cas de tension CM ↔ PM : le CM décide du *quoi*, le PM du *comment*. Les tensions sont tracées dans [`01-compte-rendu-comprehension.md`](01-compte-rendu-comprehension.md) §7.
3. Les deux documents sources **restent à la racine et ne sont jamais modifiés** par les sessions de cadrage ou de développement. Toute évolution métier passe par une nouvelle version fournie par GIC AGROPELC ou par une décision consignée dans le registre [`../A-VALIDER.md`](../A-VALIDER.md).

### 1.1 Format des références aux sources

- `CM §28` : section 28 du Contexte métier.
- `PM §6` : section 6 du Prompt maître.
- `CM §20/Intrants` : sous-partie nommée d'une section.

---

## 2. Classification des informations (obligatoire)

Toute règle, décision, entité, état, permission ou valeur par défaut porte un statut.

| Statut | Signification | Justification exigée |
|---|---|---|
| **CONFIRMÉ** | Explicitement défini par une source du projet. | Référence `CM §x` (exigence métier) ou `PM §x` (contrainte technique imposée par le Prompt maître, ex. PWA, états de synchronisation, UUID). |
| **DÉDUIT** | Nécessaire à la cohérence du système et raisonnablement déductible, sans être explicitement formulé. | Justification courte : quelle exigence CONFIRMÉE le rend nécessaire. |
| **À VALIDER** | Plusieurs choix raisonnables existent ; une décision de GIC AGROPELC est nécessaire. | Identifiant `AV-nnn` renvoyant au registre central [`../A-VALIDER.md`](../A-VALIDER.md), avec la valeur par défaut retenue provisoirement. |

Règles d'usage :

- Une valeur par défaut proposée pour un point À VALIDER est **utilisable pour avancer**, mais doit rester paramétrable ou facilement modifiable tant que le point n'est pas tranché.
- Un point À VALIDER tranché par GIC AGROPELC devient **CONFIRMÉ (décision AV-nnn du JJ/MM/AAAA)** ; le registre est mis à jour et le statut est propagé dans les documents qui le référencent.
- Une décision technique (ex. PostgreSQL, UUIDv7) n'est **jamais** présentée comme une exigence métier. Elle est **DÉDUIT** et documentée par un ADR.
- Abréviations autorisées dans les tableaux : `C` = CONFIRMÉ, `D` = DÉDUIT, `AV` = À VALIDER.

---

## 3. Identifiants documentaires

| Préfixe | Objet | Exemple | Fichier de définition (source unique) |
|---|---|---|---|
| `REQ-nnn` | Exigence extraite des sources | `REQ-041` | [`01-functional/00-exigences-sources.md`](../01-functional/00-exigences-sources.md) |
| `BR-<DOM>-nnn` | Règle métier | `BR-STK-004` | fichier du domaine dans `01-functional/domaines/` |
| `INV-<DOM>-nn` | Invariant système | `INV-STK-03` | [`02-domain-model/01-invariants.md`](../02-domain-model/01-invariants.md) |
| `AV-nnn` | Point à valider / question ouverte | `AV-012` | [`../A-VALIDER.md`](../A-VALIDER.md) |
| `ADR-nnn` | Décision d'architecture | `ADR-003` | `decisions/ADR-nnn-*.md` |
| `SM-<nom>` | Machine à états | `SM-SALE` | `04-workflows/machines-a-etats/` |
| `WF-nn` | Workflow / parcours | `WF-07` | [`04-workflows/01-workflows.md`](../04-workflows/01-workflows.md) |
| `ECR-<DOM>-nn` | Écran / vue (inventaire, pas de maquette) | `ECR-VEN-02` | [`01-functional/03-parcours-et-ecrans.md`](../01-functional/03-parcours-et-ecrans.md) |
| `NFR-nn` | Exigence non fonctionnelle | `NFR-12` | [`09-non-functional/01-exigences-non-fonctionnelles.md`](../09-non-functional/01-exigences-non-fonctionnelles.md) |
| `RISK-nn` | Risque technique | `RISK-07` | [`10-development-plan/03-registre-risques.md`](../10-development-plan/03-registre-risques.md) |
| `AT-nnn` | Test d'acceptation | `AT-015` | [`09-non-functional/03-plan-de-tests.md`](../09-non-functional/03-plan-de-tests.md) |
| `C-nn` | Contradiction / tension entre sources | `C-04` | [`01-compte-rendu-comprehension.md`](01-compte-rendu-comprehension.md) |

Codes de domaine `<DOM>` :

| Code | Domaine | Code | Domaine |
|---|---|---|---|
| `ADM` | Core / Administration (identité, organisation, appareils, validations, pièces jointes) | `APP` | Approvisionnement (fournisseurs, achats, réceptions) |
| `CRM` | Commercial / CRM opérationnel | `FIN` | Finance opérationnelle |
| `TER` | Pointage terrain | `PRX` | Tarification (pricing) |
| `VEN` | Commandes et ventes | `ANA` | Analytics et tableaux de bord |
| `DIS` | Distribution et points de vente | `AUD` | Audit |
| `STK` | Stocks | `NOT` | Notifications, alertes, communication interne |
| `PRD` | Production (commun) | `SYN` | Synchronisation |
| `VOL` | Volaille de chair | `KOM` | Intégration Kommo |
| `OEU` | Œufs | `SEC` | Sécurité (transverse) |
| `INC` | Incubation | `POR` | Porcs |
| `CAT` | Catalogue et référentiels | `OPS` | Exploitation technique (observabilité) |

---

## 4. Conventions de nommage technique

La documentation est rédigée en **français**. Les **identifiants techniques sont en anglais** afin d'être directement réutilisables dans le code. Le glossaire ([`01-functional/01-glossaire.md`](../01-functional/01-glossaire.md)) fait le lien terme métier ↔ identifiant technique.

| Élément | Convention | Exemple |
|---|---|---|
| Schéma PostgreSQL (= module propriétaire) | `snake_case` | `inventory` |
| Table | `snake_case`, **pluriel** | `inventory.stock_moves` |
| Colonne | `snake_case` | `occurred_at` |
| Valeur d'énumération | `UPPER_SNAKE_CASE` | `PENDING_APPROVAL` |
| Commande (écriture) | `<module>.<agrégat>.<verbe>` | `sales.sale.record` |
| Événement métier | `PascalCase` au passé | `SaleRecorded` |
| Permission | `<module>.<ressource>.<action>` | `inventory.loss.approve` |
| Endpoint | `/api/v1/<ressource-kebab-case>` | `/api/v1/stock-transfers` |
| Code de référentiel | `UPPER_SNAKE_CASE` | `MORTALITE` |

---

## 5. Conventions de données transverses

Ces conventions sont détaillées et justifiées dans [`03-data/01-identifiants-et-conventions.md`](../03-data/01-identifiants-et-conventions.md) et les ADR associés. Rappel synthétique :

| Sujet | Convention | Statut |
|---|---|---|
| Identifiant technique | UUIDv7 généré par le client ou par le serveur (ADR-002) | D |
| Monnaie | Franc CFA BEAC (`XAF`), montants **entiers** en francs (ADR-013) | D (monnaie CM §30 « FCFA ») / AV-041 (taxes) |
| Fuseau horaire métier | `Africa/Douala` (UTC+1, pas d'heure d'été) ; stockage `timestamptz` en UTC | D (CM §29 Douala, Yaoundé) |
| Heure métier | `occurred_at` : heure réelle de l'opération, jamais remplacée par l'heure de synchronisation | C (CM §38, PM §5) |
| Quantités | `numeric(14,3)` en **unité de base** du produit ; entier imposé pour les produits comptés à l'unité | D |

---

## 6. Règles de rédaction

1. Pas de « etc. », « selon les besoins », « on verra plus tard » lorsqu'une définition précise est possible. Une liste ouverte est explicitement déclarée **configurable** (référentiel) avec ses valeurs initiales.
2. Un état est toujours décrit avec ses transitions d'entrée et de sortie.
3. Une contrainte est toujours accompagnée du problème qu'elle empêche.
4. Un workflow indique ses effets **stock / finance / audit / synchronisation**.
5. Une table est toujours rattachée à **un seul module propriétaire**.
6. Toute incohérence découverte entre deux documents est **corrigée à la source** (on ne crée pas une seconde version contradictoire).
7. Les diagrammes sont en **Mermaid** pour être versionnés en texte.

---

## 7. Cycle de vie de la documentation

| Étape | Qui | Effet |
|---|---|---|
| Cadrage initial | Session de cadrage | Production des livrables PM §21–§50. |
| Décision métier | GIC AGROPELC | Mise à jour de `A-VALIDER.md`, propagation du statut, ADR éventuel. |
| Développement d'une phase | Session de développement | Lit `CLAUDE.md`, puis le plan de phase, puis les documents référencés. Toute divergence nécessaire est d'abord documentée (ADR ou modification de spec) **avant** le code. |
| Contrôle | Outil `docs/_tools/check_refs.py` | Vérifie que chaque identifiant référencé (`AV-`, `BR-`, `INV-`, `ADR-`, `REQ-`, `ECR-`, `SM-`, `NFR-`, `RISK-`, `AT-`, `C-`) est défini et que chaque lien relatif mène à un fichier existant. |
