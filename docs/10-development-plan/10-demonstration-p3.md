# Démonstration de sortie de phase P3

> Plan §4 (P3 — CRM terrain et pointage). Critère : « Commerciaux terrain équipés, hors ligne ». État arrêté le 27/09/2026, à la fin des éléments de code de P3 (P3-01 à P3-08). Développement local (MySQL 8.4 sur le poste, ADR-024 §5) ; commits locaux, rien n'est poussé vers le dépôt distant à cette date.

---

## 1. Aucun AV bloquant

P3 n'a aucun AV **bloquant** (checklist §2). Les AV listés en prérequis restent `OUVERT` ; leur valeur par défaut est implémentée de façon **paramétrable** ou réversible, sans être présentée comme une décision :

| AV | Défaut implémenté | Où |
|---|---|---|
| AV-003 | Zones hiérarchiques ; géorepère = centre + rayon ; la zone déclarée à la prise de service peut être une sous-zone d'une zone affectée (D03 §15) | `checkin-commands.ts` |
| AV-011 | Étapes configurables (`crm.pipeline.configure`) ; seed NOUVEAU, CONTACTÉ, INTÉRESSÉ, NÉGOCIATION ; terminaux `CUSTOMER` et `LOST` fixes ; au moins une étape active | `pipeline-commands.ts`, `db/seeds/crm-references.ts` |
| AV-012 | Conversion automatique à la première vente confirmée : API interne `convertOnConfirmedSale` prête pour `sales` (P4) ; la vente confirmée la plus ancienne fixe `converted_at`, même synchronisée après une autre | `conversion.ts` |
| AV-013 | Paramètre `crm.inactive_after_days` (30) présent ; le qualificatif actif / inactif n'est pas encore calculé (lectures analytiques, P9) | seed |
| AV-014 | Portefeuille propre ; doublon par téléphone normalisé : refus en ligne sans divulgation hors périmètre, conflit informatif `DUPLICATE_CUSTOMER` hors ligne, résolu par la fusion ; `GET /customers/duplicate-check` masqué hors périmètre | `customer-commands.ts`, `crm-read.controller.ts` |
| AV-015 | Réaffectation par le responsable commercial (son équipe) ou la Direction ; motif obligatoire ; périodes contiguës ; `SCOPE_EXIT` vers l'ancien titulaire | `customer-commands.ts`, `crm/application/sync-changes.ts` |
| AV-016 | Objectif = cible (`USER`, `TEAM`, `SITE`) × métrique × produit facultatif × période, sans chevauchement ; non modifiable (annulation puis nouvelle définition) | `target-commands.ts` |
| AV-021 | Refus, tentative conservée, dérogation après 3 refus sur 2 minutes (paramètres `fieldwork.override_min_attempts`, `fieldwork.override_min_minutes`), validée selon la politique `CHECKIN_OVERRIDE` ; sans politique active : `CONTROL_POLICY_MISSING` | `checkin-commands.ts` |
| AV-022 | Rayon par zone, défaut 500 m (paramètre `fieldwork.geofence_radius_m`) ; précision maximale de la zone, à défaut le paramètre `fieldwork.max_gps_accuracy_m` (150 m) | `zone-commands.ts`, `checkin-commands.ts` |
| AV-023 | Rattachement automatique des visites à la session, indicateurs, jamais de blocage ; clôture à 23:59 (Douala) sur l'appareil ou par le serveur | `activity-commands.ts`, `session-auto-close-job.ts` |

Aucun point nouveau n'a été ouvert : les choix d'implémentation laissés libres par les règles sont **DÉDUITS** et documentés dans [D02 §15](../01-functional/domaines/D02-CRM-commercial.md) et [D03 §15](../01-functional/domaines/D03-TER-pointage-terrain.md).

## 2. Tests d'acceptation et invariants

### 2.1 Tests d'acceptation de la phase (plan §4 : AT-011 partiel, 012, 013, 014, 015, 051)

| AT | Scénario | Où | État |
|---|---|---|---|
| AT-011 | Première vente à un prospect : conversion ; KPI « nouveaux clients » | `crm-customer-commands.test.ts` (API de conversion, y compris par la chaîne de fusion) ; `crm-read.e2e.test.ts` (nouveaux clients dans l'effort commercial) | Partiel, comme prévu : la vente et son déclenchement arrivent en P4 |
| AT-012 | Même prospect créé sur deux appareils hors ligne | `crm-customer-commands.test.ts` (conflit, fusion, acquéreur le plus ancien ; variante où le doublon a été acquis le premier) | Vert |
| AT-013 | Réaffectation : ventes passées à l'ancien titulaire, futures au nouveau ; historique visible | `crm-customer-commands.test.ts`, `crm-sync-projections.test.ts`, `crm-read.e2e.test.ts` | Partiel : périodes, motif, droits à `occurred_at`, `SCOPE_EXIT` et historique verts ; attribution figée des ventes (INV-VEN-10) en P4 |
| AT-014 | Prise à 180 m acceptée, à 1,8 km refusée, puis dérogation | `fieldwork-checkin-commands.test.ts` | Vert |
| AT-015 | Performance d'un commercial : aujourd'hui, semaine, plage libre | `crm-read.e2e.test.ts` (`GET /performance/commercial`), `crm-field-day.e2e.test.ts` | Vert pour l'effort (prospects créés, visites, comptes et prospects visités, contacts, nouveaux clients) ; commandes, ventes et CA en P4, instantanés analytiques en P9 |
| AT-051 | Visite hors ligne à 800 m d'un client géolocalisé, sans session | `crm-activity-commands.test.ts` ; `crm-read.e2e.test.ts` (indicateurs lus par le responsable) | Vert : `far_from_customer` et `out_of_session`, non modifiable en base, correction par annulation et nouvelle visite, comptée dans les prospects visités |

Scénario de bout en bout du plan (« journée d'un commercial terrain hors ligne ») : `crm-field-day.e2e.test.ts` — une journée entière saisie hors ligne (prise de service, prospect, visite dépendant de sa création, contact, visite lointaine, fin de service), envoyée en un lot par `/sync/push`, rejouée sans doublon, puis téléchargée par `/sync/pull` ; l'effort de la journée égale les opérations.

### 2.2 Invariants `INV-CRM-*` et `INV-TER-*`

| INV | Où | État |
|---|---|---|
| INV-CRM-01 | `db/tests/crm-fieldwork.test.ts` (déclencheur) ; `crm-fieldwork-invariants.test.ts` (acquisition = création, sur toute la base) | Vert |
| INV-CRM-02 | `db/tests/crm-fieldwork.test.ts` ; `crm-customer-commands.test.ts` (réaffectation) ; balayage (titulaire actif unique, périodes, titulaire dénormalisé) | Vert |
| INV-CRM-03 | `db/tests/crm-fieldwork.test.ts` ; `crm-customer-commands.test.ts` (doublons en ligne et hors ligne, unicité rétablie à la fusion) ; balayage | Vert |
| INV-CRM-04 | `db/tests/crm-fieldwork.test.ts` (contrainte) ; balayage | Vert |
| INV-CRM-05 | `crm-customer-commands.test.ts` (chaîne aplatie) ; balayage (fusionné → non fusionné, doublons re-pointés) | Vert |
| INV-TER-01 | `db/tests/crm-fieldwork.test.ts` ; `fieldwork-checkin-commands.test.ts` (remplacement, prise tardive, 23:59) ; balayage | Vert |
| INV-TER-02 | `db/tests/crm-fieldwork.test.ts` (immuabilité) ; `fieldwork-checkin-commands.test.ts` (refus conservés) ; balayage (références des sessions et des tentatives) | Vert |

Le balayage (`crm-fieldwork-invariants.test.ts`) porte sur toute la base de test, alimentée par le vrai pipeline : à la clôture, 196 comptes dont 35 fusionnés, 200 affectations, 136 sessions, 220 tentatives, 56 visites.

### 2.3 Suites complètes (27/09/2026)

`packages/domain` 143 tests (14 fichiers) ; `packages/contracts` 154 tests ; `apps/server` 340 tests (51 fichiers, exécution séquentielle, 8 min 23 s) ; `db` 61 tests (7 fichiers). `typecheck`, `check:boundaries` (254 modules), `lint` (aucune erreur ; un avertissement préexistant de la PWA), `format:check`, `python3 docs/_tools/check_refs.py` verts.

Note d'exécution : une exécution complète lancée pendant une forte charge du poste a duré 31 minutes au lieu de 6 et a produit 9 dépassements du délai de 5 s par test dans des fichiers de P0 à P2 (vérification d'appareil, séquences, droits, tâches, harnais…) ; relancés, ces 8 fichiers passent. Aucun échec fonctionnel. Les délais de la suite serveur sont désormais de 20 s par test et 60 s par crochet (`apps/server/vitest.config.ts`) : chaque test traverse une vraie base et le premier d'un fichier paie l'ouverture des connexions et le démarrage de Nest.

## 3. Ce qui est livré

| Élément | Contenu |
|---|---|
| P3-01 `packages/domain` | Pointage (distance, résultat, dérogation, signaux de suspicion), évaluation d'une visite, normalisation du téléphone, fusion champ par champ ; puis (P3-03) fin de session partagée appareil/serveur (`sessionAutoCloseAt`, `resolveSessionEnd`) |
| P3-02 `db` | Migrations `crm.*` et `fieldwork.*` : unicités partielles (téléphone, titulaire actif, session ouverte), non-chevauchement par déclencheurs, immuabilités ; référentiels CRM initiaux ; paramètres |
| P3-03 `fieldwork` | `fieldwork.checkin.record`, `.request_override`, décision `CHECKIN_OVERRIDE` ; sessions sous l'identifiant de l'appareil ; remplacement, prise tardive, clôture de 23:59 (tâche `fieldwork.session.auto_close`) |
| P3-04 comptes | `crm.customer.create`, `.update`, `.set_pipeline_step`, `.mark_lost`, `.reopen`, `.reassign`, `.merge`, `.set_credit_terms`, `crm.pipeline.configure` ; conversion (API interne) |
| P3-05 activité | `crm.visit.record`, `.cancel`, `crm.interaction.record`, `.cancel`, `crm.target.set`, `.cancel` ; indicateur `SESSION_REJECTED` au rejet d'une dérogation |
| P3-06 lectures | `GET /customers`, `/customers/{id}`, `/customers/duplicate-check`, `/visits`, `/interactions`, `/targets`, `/performance/commercial`, `/work-sessions` — portée élément par élément, refus audités |
| P3-07 hors ligne | Jeux `customers`, `crm_activity`, `fieldwork` ; `SCOPE_EXIT` à la réaffectation |
| P3-08 intégrité | Balayage des invariants ; journée d'un commercial terrain hors ligne de bout en bout |
| P3-09 clôture | Géorepère d'une zone modifiable ou retirable (`organization.zone.update`, avant / après à l'audit) ; rayon par défaut lu dans le paramètre `fieldwork.geofence_radius_m` (règle 8) au lieu d'une constante ; tentative déclarée sur une zone privée de son géorepère conservée (`ZONE_INACTIVE`, INV-TER-02) |
| Plateforme | Un rejet du gestionnaire annule la transaction (aucune écriture partielle) ; audit avant / après fourni par le gestionnaire ; consignation et résolution des conflits de synchronisation ; avertissement `VERSION_CONFLICT` |
| RBAC | Aucun changement : les permissions `crm.*` et `fieldwork.*` existaient depuis le seed P0-05. Nouveau paramètre `crm.commercial_role_codes` |

Décisions DÉDUITES à connaître (détail : D02 §15, D03 §15) :

- **Fusion** : le compte conservé est le plus anciennement acquis ; son acquéreur est ainsi retenu sans modifier un acquéreur immuable (INV-CRM-01, BR-CRM-007).
- **Rôle commercial** : un rôle de la liste `crm.commercial_role_codes` (titulaire à la création, nouveau titulaire d'une réaffectation).
- **Ancien titulaire hors ligne** : ses visites et interactions postérieures à une réaffectation sont acceptées et parviennent au nouveau titulaire (D02 §12) ; en ligne, refusées.
- **Sessions** : l'heure réelle la plus ancienne l'emporte entre la fin de service, le remplacement et la clôture de 23:59 ; une prise tardive est enregistrée déjà close.
- **Jeu `fieldwork`** : ajouté au catalogue des jeux hors ligne pour renvoyer à l'agent les décisions du serveur sur ses sessions.
- **Lectures** : sans critère, une liste porte sur soi, les équipes dirigées et, pour les comptes, ses sites d'affectation ; les interactions se lisent avec `crm.visit.read`.

Correctif transverse découvert en P3-04 : quand un gestionnaire concluait au rejet (`REJECTED`) après avoir écrit, le pipeline **validait** la transaction — l'écriture partielle était conservée. Aucun gestionnaire existant n'était touché (tous rejetaient avant d'écrire), mais la garantie « un rejet n'a aucun effet » (INV-SYN-05) dépendait de la discipline de chaque module : le pipeline annule désormais la transaction (`pipeline.integration.test.ts`).

## 4. Ce qui n'est pas livré (signalé, pas silencieux)

| Élément | Raison | Déclencheur |
|---|---|---|
| Écrans PWA ECR-CRM-01 à 07, ECR-TER-01, 02 | Même précédent que P0-11, P1 et P2 : aucun écran métier construit, les API sont prêtes | Session dédiée aux écrans |
| Historique des géorepères (« géorepère en vigueur à `occurred_at` », BR-TER-003) | Le serveur recalcule avec le géorepère **courant** de la zone ; chaque tentative fige celui qu'elle a utilisé. Une modification du géorepère entre une prise et sa synchronisation s'appliquerait rétroactivement à cette prise | Premier changement de géorepère en exploitation (versions de géorepère dans `organization`) |
| Alertes `INACTIVE_COMMERCIAL` (BR-TER-013), `CHECKIN_SUSPICIOUS`, prochaines actions échues, « portefeuille sans titulaire actif » (D02 §11) ; notifications au commercial (D03 §12) et au nouveau titulaire (D02 §12) | Module `communication` absent. Les signaux sont stockés (`suspicion_flags`, indicateurs de visite) et descendent par les jeux hors ligne (`comms`, `crm_activity`), sans notification poussée | P9 |
| Signaux de suspicion calculés aussi sur les visites et ventes terrain (BR-TER-010) | `fieldwork` ne lit pas les tables de `crm` ni de `sales` (graphe) | Écoute d'événements, si le besoin se confirme |
| Qualificatif actif / inactif (BR-CRM-011), clients à fort CA, indicateurs de ventes | Ventes en P4 ; analytique en P9 | P4, P9 |
| Déclenchement de la conversion par `SaleConfirmed`, `conversion_reverted` par `SaleCancelled` | L'API est prête ; l'appel appartient à `sales` | P4 |
| Création ou rapprochement depuis Kommo (BR-CRM-023) ; liens externes suivant la fusion | Module `integrations` | P10 |
| Position du compte proposée depuis sa première visite (BR-CRM-014) | Proposition d'interface ; l'enregistrement passe par `crm.customer.update` | Écran ECR-CRM-04 |
| Consultation et résolution générique des conflits de synchronisation | `DUPLICATE_CUSTOMER` et `VERSION_CONFLICT` sont consignés ; seule la fusion clôt `DUPLICATE_CUSTOMER` | Écran de revue des conflits (P4 : premiers conflits de vente) |
| Fenêtre de saisie rétroactive (AV-078 : `BACKDATE_EXCEEDED`, `JUSTIFICATION_REQUIRED`) | Le pipeline ne contrôle que la date future (`OCCURRED_AT_FUTURE`) depuis P0 | Avant la mise en production de R1 |
| Portefeuilles clients initiaux, objectifs initiaux (checklist P3) | Données GIC (AV-072) | Réception des données |
| Ordonnancement récurrent de `fieldwork.session.auto_close` | Même limite que P0-07 et P2-07 : aucun ordonnanceur récurrent | Déploiement (AV-090) |
| DoD « deux commerciaux pilotes l'utilisent une semaine sans retour au papier » | Exige les écrans et un déploiement | Déploiement |

## 5. Prochaine étape

La phase **P4** (ventes) reste bloquée par AV-024 et AV-025 (règle R11), et **P5** dépend de P4. La phase **P6** (Approvisionnement) ne dépend que de P2 et n'a aucun AV bloquant : elle peut démarrer.
