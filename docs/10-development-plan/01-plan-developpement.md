# Plan de développement (Livrable n°15)

> Section 32 du format final (PM §48). Découpage en **tranches verticales utilisables** (PM §38) : chaque phase livre quelque chose de testable de bout en bout, de l'appareil hors ligne à la base de données.
> Les tailles (S, M, L, XL) et les durées sont **indicatives**, pour une équipe de 2 développeurs (hypothèse AV-084). Elles servent à planifier, pas à engager.

---

## 1. Évaluation de l'ordre proposé (PM §39) et corrections

| Ordre PM §39 | Décision | Justification |
|---|---|---|
| P0 Fondations | **Conservé, enrichi** | Ajout du **squelette de synchronisation fonctionnel** (outbox, inbox, pull), d'`approvals` et d'`attachments` en version socle, et de la bibliothèque métier partagée. L'offline doit être éprouvé dès la première tranche (PM §5) |
| P1 Référentiels | **Conservé, ajusté** | Clients et fournisseurs ne sont pas des référentiels : les **clients** vont en P3 (CRM, cycle de vie propre) ; les **fournisseurs** sont créés en version minimale en P1 (fiche seule), car les lots de production et les réceptions y font référence. La **tarification** reste en P1 (moteur partagé indispensable aux ventes) grâce au déplacement des catégories de client et des canaux dans `catalog` |
| P2 Stock et mouvements | **Conservé** | Socle de P4, P5, P6, P7 (graphe §2) |
| P3 CRM terrain | **Conservé, parallélisable avec P2** | `crm` et `fieldwork` ne dépendent pas d'`inventory` |
| P4 Commandes, ventes, encaissements | **Conservé** | Nécessite en plus le **socle de trésorerie** (comptes, mouvements, moyens de paiement), avancé de P8 vers P4 |
| P5 Distribution, PDV | **Conservé** | Allocations, sessions de caisse, réapprovisionnement, tableau de distribution |
| P6 Production / P7 Approvisionnement | **Inversé** : P6 Approvisionnement, P7 Production | `production` dépend de `procurement` (mise en place par achat direct, fournisseurs, intrants reçus). La chaîne du CM §4 est APPROVISIONNER → RECEVOIR → PRODUIRE |
| P8 Finance opérationnelle | **Conservé, réduit** | Le socle de trésorerie est déjà en P4. Restent : dépenses, factures et paiements fournisseurs, rapprochement, coûts et marges |
| P9 Analytics et direction | **Conservé** | Les tableaux de bord de rôle simples sont livrés au fil des phases ; P9 apporte la tour de contrôle, l'explorateur, les exports, les alertes avancées et les notes |
| P10 Kommo | **Conservé** | Dépend du CRM et des ventes ; bloqué par AV-068 |

## 2. Vue d'ensemble

| Phase | Objectif | Fonctionnalités | Dépendances | Livrable | Tests de sortie | État |
|---|---|---|---|---|---|---|
| **P0** Fondations (XL, 5 à 6 sem.) | Socle technique, sécurité et offline éprouvés | Dépôt et conventions, CI/CD, base et migrations, bibliothèque partagée, `platform`, `audit`, `identity` (authentification, appareils, RBAC), `organization` (sites, zones, emplacements, équipes, paramètres), `sync` (push, pull, bootstrap, états), `approvals` et `attachments` (socle), PWA squelette (connexion, PIN, accueil par rôle, pastille de synchronisation) | — | Une commande de démonstration (`organization.setting.set`) et une commande hors ligne (`identity.device.*` / note de test) traversent tout le pipeline, avec audit | Tests des invariants GLO, SYN, ADM, AUD ; harnais de synchronisation de base ; E2E connexion + hors ligne + reprise | Code terminé (P0-01 à P0-16, 25/09/2026) ; P0-17 (`staging` Hostinger) bloqué, hors accès de l'environnement de développement ; démonstration [`07-demonstration-p0.md`](07-demonstration-p0.md) |
| **P1** Référentiels métier (M, 2 à 3 sem.) | Catalogue et prix partagés | Produits, unités, conditionnements, catégories, motifs, coûts standard ; catégories de client et canaux ; fournisseurs (fiche) ; règles tarifaires, campagnes, simulateur ; import CSV des référentiels (AV-072) | P0 | Catalogue et grille tarifaire administrables ; moteur de prix identique sur l'appareil et le serveur | INV-PRX-*, INV-CAT-01 ; AT-006, AT-007 (partiel) | Code terminé (P1-01 à P1-06, 26/09/2026) ; écrans PWA (ECR-PRX-01 à 03) et import CSV (AV-072) hors périmètre — démonstration [`08-demonstration-p1.md`](08-demonstration-p1.md) |
| **P2** Stock et mouvements (L, 4 sem.) | Stock fiable et traçable au magasin et au PDV pilote | Registre, soldes, lots, transferts (avec transit, écarts, réception sans document), pertes avec politiques et validations, consommations, inventaires (dont ouverture), seuils, valorisation CMUP, registre de coûts (socle), alertes de stock | P0, P1 | Magasin et PDV gèrent réceptions d'ouverture, transferts, pertes et inventaires, hors ligne | INV-STK-* ; AT-016, 017, 019, 020, 021, 022, 047, 049 | Non commencée |
| **P3** CRM terrain et pointage (M, 3 sem.) | Effort commercial mesuré | Comptes clients, portefeuille, doublons, fusion, pipeline, visites, interactions, objectifs, pointage, dérogations, tableau commercial simple | P0, P1 (parallélisable avec P2) | Commerciaux terrain équipés, hors ligne | INV-CRM-*, INV-TER-* ; AT-011 (partiel), 012, 013, 014, 015, 051 | Non commencée |
| **P4** Commandes, ventes, encaissements (L, 4 sem.) | Vendre et encaisser partout, même hors ligne | Commandes, réservations, livraisons ; ventes directes et sur commande ; dérogations ; crédit ; annulations ; encaissements et affectations ; créances ; socle de trésorerie (comptes, mouvements, moyens) ; stock mobile des commerciaux ; conversion prospect → client | P1, P2, P3 | Vente de bout en bout (terrain et PDV) avec caisse utilisateur | INV-VEN-*, INV-FIN-01 à 04, 09, 10 ; AT-001 à 011, 018, 030, 032, 033 | Non commencée |
| **P5** Distribution et PDV (M, 3 sem.) | PDV autonomes et pilotés | Configuration PDV (mode de garde), allocations, sessions de caisse, remises de fonds, réapprovisionnement suggéré, tableau de distribution | P4 | Un PDV fonctionne toute la journée hors ligne, avec une caisse contrôlée | INV-FIN-05, 06 ; AT-003, 004, 031, 042 | Non commencée |
| **P6** Approvisionnement (M, 3 sem.) | Achats contrôlés | Demandes d'achat, validations, bons de commande, réceptions (livré, rejeté, accepté), quarantaine, réception sans BC, reliquats | P2 | Chaîne Besoin → Réception opérationnelle | INV-APP-* ; AT-023, 024 | Non commencée |
| **P7** Production (L, 4 sem.) | Production suivie par lot | Lots (chair, pondeuses, porcs), mise en place (stock interne ou achat direct), saisie du jour, mortalité avec seuils, consommations imputées, pesées, collectes d'œufs, incubation, sortie vers commercialisation, clôture, coût par tête | P2, P6 | Fermes équipées ; indicateurs de lot | INV-PRD-*, INV-OEU-01, INV-INC-01 ; AT-026 à 029, 052, 053 | Non commencée |
| **P8** Finance opérationnelle (M, 3 sem.) | Coûts, marges, dettes | Dépenses (imputées), factures fournisseurs et rapprochement, paiements fournisseurs, dettes, coûts de lot complets, marges, valeur des pertes | P4, P6, P7 | Vue financière opérationnelle complète | INV-FIN-07, 08 ; AT-025, 040, 041 | Non commencée |
| **P9** Analytics et direction (L, 4 sem.) | Tour de contrôle et analyse flexible | Couche sémantique, jeux de faits, tour de contrôle, tableaux par rôle complets, explorateur, vues sauvegardées, exports, catalogue complet d'alertes, notes de direction | P4 à P8 | Direction autonome sur ses questions (CM §62) | AT-038, 039, 043, 045, 046, 048, 054 ; NFR-12, 13 | Non commencée |
| **P10** Intégration Kommo (M, 2 à 3 sem.) | Parcours digital continu | Liens externes, webhooks entrants, messages sortants, anti-boucle, supervision, rejeu | P3, P4 ; AV-068 tranché | Leads qualifiés convertis en clients GIC ; enrichissement Kommo | INV-KOM-* ; AT-044 | Non commencée |

Durée indicative totale : environ 37 à 40 semaines de développement pour 2 développeurs, hors recette et formation (AV-084).

## 3. Mises en production (AV-001)

| Release | Phases | Pilote | Valeur livrée |
|---|---|---|---|
| **R1** | P0 à P3 | Magasin central + 1 PDV + 2 commerciaux | Stock fiable et traçable ; effort commercial mesuré ; pointage |
| **R2** | P4, P5 | Même pilote, puis tous les PDV de Douala | Ventes et encaissements, caisse, distribution |
| **R3** | P6, P7 | 1 ferme, puis toutes | Achats, réceptions, production |
| **R4** | P8, P9 | Direction, Finance | Finance opérationnelle, tour de contrôle, analyse |
| **R5** | P10 | Commerciaux sédentaires | Intégration Kommo |

Chaque release est précédée d'une reprise de données ciblée (AV-072) et d'une formation courte (NFR-35).

## 4. Détail des phases

### P0 — Fondations

| Rubrique | Contenu |
|---|---|
| Objectif métier | Rendre possible tout le reste : identité fiable, droits, appareils autorisés, audit, synchronisation hors ligne éprouvée |
| Entités | Utilisateur, rôle, permission, affectation, appareil, session ; site, zone, emplacement (y compris virtuels), équipe, PDV (structure), paramètre ; politique, demande de validation ; pièce jointe ; entrée d'audit ; commande reçue, conflit, flux, état d'appareil ; événement, séquence |
| Tables créées | `identity.*`, `organization.*`, `approvals.*`, `attachments.attachments`, `audit.audit_log`, `sync.*`, `platform.*` |
| API | `/auth/*`, `/me`, `/users`, `/devices`, `/roles`, `/sites`, `/locations`, `/zones`, `/teams`, `/settings`, `/sync/push`, `/sync/pull`, `/sync/bootstrap`, `/sync/status`, `/commands`, `/approvals/inbox`, `/attachments/*`, `/audit`, `/health` |
| Interfaces | ECR-ADM-01 à 07, ECR-SYN-01, 02, ECR-AUD-01 ; accueil par rôle vide (ECR-ADM-03) |
| Workflows | SM-USER, SM-DEVICE, SM-APPROVAL, SM-ATTACHMENT, SM-SYNC-COMMAND, SM-CONFLICT ; WF-16 (squelette) |
| Permissions | `identity.*`, `org.*`, `approvals.*`, `audit.log.read`, `sync.*` |
| Offline | Outbox, séquence d'appareil, projections locales avec retour arrière, pull incrémental, bootstrap, PIN, autonomie bornée, chiffrement local, écart d'horloge |
| Tests unitaires | UUIDv7, horloge, argent et quantités, évaluation des portées, évaluation des politiques, sérialisation canonique d'audit |
| Tests d'intégration | Déclencheurs d'immuabilité (INV-GLO-03), chaîne d'audit (INV-AUD-01), idempotence de l'inbox (INV-SYN-01 à 05), RBAC généré (socle), dernier Admin (INV-ADM-01) |
| Tests E2E | Enrôlement et approbation d'appareil ; connexion et PIN ; commande hors ligne puis reprise ; rejet affiché ; révocation d'appareil |
| Critères d'acceptation | AT-002, AT-034, AT-035, AT-036, AT-050 (sur une commande de démonstration), AT-055 |
| Prérequis | Décisions (ou acceptation explicite des valeurs par défaut) : AV-001 et AV-084 (plan), AV-004 (rôles du seed RBAC), AV-006, AV-007 (appareils partagés : conception), AV-008, AV-009, AV-010, AV-073 (hébergement), AV-074 (rétention, partitionnement), AV-075, AV-077, AV-078, AV-079, AV-086 (dimensionnement) ; stack validée (ADR-021, AV-089) ; comptes d'hébergement. Voir [`04-checklist-demarrage.md`](04-checklist-demarrage.md) |
| Risques | RISK-01, RISK-03, RISK-07, RISK-08, RISK-09, RISK-16, RISK-21, RISK-26 |
| Définition de Done | CI verte (y compris contrôle des modules et de la documentation) ; staging déployé ; runbook de restauration testé ; documentation mise à jour ; démonstration hors ligne réussie sur l'appareil de référence |

### P1 — Référentiels métier

| Rubrique | Contenu |
|---|---|
| Objectif métier | Un seul catalogue et une grille tarifaire administrable, appliquée automatiquement (CM §29, §43) |
| Entités | Produit, unité, conditionnement, catégorie, motif, coût standard ; catégorie de client, canal ; fournisseur (fiche) ; règle tarifaire, campagne |
| Tables | `catalog.*`, `pricing.*`, `procurement.suppliers` |
| API | `/products`, `/units`, `/reason-codes`, `/price-rules`, `/campaigns`, `/prices/resolve`, `/suppliers` (fiche) |
| Interfaces | ECR-PRX-01 à 03 ; import CSV |
| Workflows | SM-PRICE-RULE |
| Permissions | `catalog.*`, `pricing.*`, `procurement.supplier.*` |
| Offline | Jeux `catalog`, `pricing` (règles futures comprises), `policies` |
| Tests unitaires | Moteur de prix (priorités, spécificité, paliers, campagnes, conflits) : exemples de la stratégie pricing + tests de propriété |
| Tests d'intégration | Immuabilité des règles actives, refus des conflits, versionnement, unité de base immuable |
| Tests E2E | Activation d'une règle future, puis résolution hors ligne à la date d'effet |
| Critères d'acceptation | AT-006, AT-007 (sur le simulateur) |
| Prérequis | AV-003 (hiérarchie des zones, dimension de prix), AV-017, AV-018, AV-031, AV-061, AV-062, AV-080 ; données produits et prix fournies par GIC (AV-072) |
| Risques | RISK-06, RISK-19 |
| DoD | Catalogue et prix initiaux chargés en staging ; moteur partagé identique client et serveur (INV-PRX-04 testé) |

### P2 — Stock et mouvements

| Rubrique | Contenu |
|---|---|
| Objectif métier | Savoir quoi, combien, où, de quel lot, et pourquoi le stock a varié (CM §20 à 25) |
| Entités | Mouvement, solde, lot, transfert, perte, consommation, inventaire, seuil, valorisation, écriture de coût |
| Tables | `inventory.*` (sauf allocations, activées en P5 ; la table est créée dès P2) |
| API | `/stock`, `/stock/availability`, `/stock/at`, `/stock-moves`, `/transfers`, `/losses`, `/consumptions`, `/inventory-counts`, `/thresholds` |
| Interfaces | ECR-STK-01 à 05, 07, 08 ; ECR-ADM-08 (file de validation) ; ECR-NOT-01 (alertes de stock) |
| Workflows | SM-TRANSFER, SM-LOSS, SM-INVENTORY-COUNT ; WF-05, WF-07, WF-08 |
| Permissions | `inventory.*` (hors `allocation.manage`) |
| Offline | Jeux `stock`, `transfers`, `counts` ; expédition, réception (avec ou sans document), pertes, consommations, comptages hors ligne |
| Tests unitaires | Couples source → destination par type ; FIFO et FEFO ; CMUP ; formules de disponibilité |
| Tests d'intégration | INV-STK-01 à 04, 06 à 09, 12 à 16 ; reconstruction des soldes ; réconciliation quotidienne |
| Tests E2E | Transfert avec écart ; perte validée avec photo ; inventaire avec rapprochement tardif |
| Critères d'acceptation | AT-016, 017, 019, 020, 021, 022, 047, 049 |
| Prérequis | AV-035 (partiel), AV-036, AV-037, AV-038, AV-039, AV-042, AV-081, AV-082 ; inventaire d'ouverture préparé |
| Risques | RISK-05, RISK-11, RISK-19, RISK-24 |
| DoD | Stock d'ouverture chargé ; zéro écart de réconciliation sur 7 jours de staging |

### P3 — CRM terrain et pointage

| Rubrique | Contenu |
|---|---|
| Objectif métier | Mesurer l'effort commercial et le portefeuille (CM §6 à 10) |
| Entités | Compte client, affectation, historique de stade, étape, visite, interaction, objectif ; pointage, session de travail |
| Tables | `crm.*`, `fieldwork.*` |
| API | `/customers`, `/customers/duplicate-check`, `/visits`, `/interactions`, `/targets`, `/work-sessions` |
| Interfaces | ECR-CRM-01 à 07, ECR-TER-01, 02, ECR-CRM-05 (version simple) |
| Workflows | SM-CUSTOMER, SM-WORK-SESSION, SM-VISIT ; WF-13 (sans vente) ; WF-J1 |
| Permissions | `crm.*`, `fieldwork.*` |
| Offline | Jeux `customers`, `crm_activity` ; création, visite, pointage hors ligne ; `SCOPE_EXIT` à la réaffectation |
| Tests unitaires | Géorepère (distance, précision), signaux de suspicion, fusion de champs |
| Tests d'intégration | INV-CRM-01 à 05, INV-TER-01, 02 |
| Tests E2E | Journée d'un commercial terrain hors ligne |
| Critères d'acceptation | AT-012, 013, 014, 015, 051 |
| Prérequis | AV-003, AV-011, AV-012, AV-013, AV-014, AV-015, AV-016, AV-021, AV-022, AV-023 ; zones et géorepères saisis |
| Risques | RISK-10, RISK-15, RISK-17 |
| DoD | Deux commerciaux pilotes l'utilisent une semaine sans retour au papier |

### P4 — Commandes, ventes, encaissements

| Rubrique | Contenu |
|---|---|
| Objectif métier | Enregistrer chaque vente une fois, avec tous ses effets (CM §13, §32) |
| Entités | Commande, ligne, vente, ligne, encaissement, affectation ; compte de trésorerie, mouvement de trésorerie, moyen de paiement ; stock mobile |
| Tables | `sales.*` ; `finance.payment_methods`, `finance.cash_accounts`, `finance.cash_movements` ; `inventory.stock_allocations` (réservations) |
| API | `/orders`, `/sales`, `/sales/{id}/receipt`, `/payments`, `/receivables`, `/cash-accounts` |
| Interfaces | ECR-VEN-01 à 06, ECR-FIN-01 (créances), ECR-CRM-03 (ventes et créances du client) |
| Workflows | SM-ORDER, SM-SALE, SM-CUSTOMER-PAYMENT ; WF-01 (hors caisse PDV), WF-02, WF-03, WF-04, WF-06, WF-13, WF-14 |
| Permissions | `sales.*`, `finance.cash.read` |
| Offline | Jeux `orders`, `sales_recent`, `cash` ; vente et encaissement hors ligne depuis un stock exclusif ; crédit contrôlé localement |
| Tests unitaires | Arrondis ; attribution ; statut de paiement ; délai d'annulation |
| Tests d'intégration | INV-VEN-01 à 10, INV-FIN-01 à 04, 09, 10, INV-STK-16 |
| Tests E2E | WF-01 (commercial), WF-02, annulations, doublon de paiement |
| Critères d'acceptation | AT-001, 002, 005, 007 à 011, 018, 030, 032, 033 |
| Prérequis | AV-024 et AV-025 (**bloquantes**), AV-026 à AV-031, AV-033, AV-034, AV-041, AV-056, AV-060, AV-063, AV-083, AV-085, AV-087 |
| Risques | RISK-02, RISK-06, RISK-17 |
| DoD | Journée de vente pilote rapprochée (stock, caisse, CA) à zéro écart |

### P5 — Distribution et points de vente

| Rubrique | Contenu |
|---|---|
| Objectif métier | PDV autonomes et pilotés (CM §12, §39) |
| Entités | Configuration PDV, allocation, entrée de quota, session de caisse, remise de fonds, seuil |
| Tables | `organization.points_of_sale` (activée), `inventory.stock_allocation_entries`, `finance.cash_sessions`, `finance.cash_transfers` |
| API | `/allocations`, `/cash-sessions`, `/cash-transfers` ; tableau de distribution |
| Interfaces | ECR-DIS-01 à 04, ECR-STK-06, ECR-FIN-05 (partiel) |
| Workflows | SM-ALLOCATION, SM-CASH-SESSION, SM-CASH-TRANSFER ; WF-01 (PDV), WF-15, WF-18 ; WF-J2 |
| Permissions | `inventory.allocation.manage`, `finance.cash_session.*`, `finance.cash_transfer.record`, `analytics.dashboard.distribution` |
| Offline | Mode `EXCLUSIVE_DEVICE` et `SHARED` ; caisse locale |
| Tests d'intégration | INV-STK-10, 11 ; INV-FIN-05, 06 |
| Tests E2E | PDV toute une journée hors ligne ; trois tablettes avec quotas |
| Critères d'acceptation | AT-003, 004, 031, 042 |
| Prérequis | AV-007, AV-035, AV-040, AV-057 |
| Risques | RISK-02, RISK-05, RISK-17, RISK-23 |
| DoD | Pilote d'un PDV pendant 2 semaines ; écarts de caisse expliqués |

### P6 — Approvisionnement

| Rubrique | Contenu |
|---|---|
| Objectif métier | Commandé ≠ livré ≠ accepté ; stock = accepté (CM §26 à 28) |
| Entités | Demande d'achat, BC, réception (et lignes) |
| Tables | `procurement.*` (le reste) |
| API | `/purchase-requests`, `/purchase-orders`, `/purchase-orders/{id}/matching`, `/receipts` |
| Interfaces | ECR-APP-01 à 04 |
| Workflows | SM-PURCHASE-REQUEST, SM-PURCHASE-ORDER, SM-RECEIPT ; WF-09 (sans facture) ; WF-J8 |
| Permissions | `procurement.*` |
| Offline | Jeu `procurement` ; réception et demande d'achat hors ligne |
| Tests d'intégration | INV-APP-01 à 04, INV-STK-12 |
| Tests E2E | Réception partielle avec rejet ; doublon en quarantaine |
| Critères d'acceptation | AT-023, 024 |
| Prérequis | AV-051 à AV-054 |
| Risques | RISK-04 |
| DoD | Tous les achats d'intrants du pilote passent par l'outil |

### P7 — Production

| Rubrique | Contenu |
|---|---|
| Objectif métier | Effectifs, mortalité, œufs, incubation, coût par lot (CM §14 à 19, §33) |
| Entités | Lot, entrée, pesée, observation, collecte, lot d'incubation, étape |
| Tables | `production.*` |
| API | `/production/lots`, `/production/lots/{id}`, `/production/egg-collections`, `/production/incubations` |
| Interfaces | ECR-PRD-01 à 04, 06, 07 ; ECR-ANA-04 (version simple) |
| Workflows | SM-PRODUCTION-LOT, SM-INCUBATION, SM-EGG-COLLECTION ; WF-10 à WF-12 ; WF-J4 |
| Permissions | `production.*` |
| Offline | Jeu `production` ; toutes les saisies quotidiennes hors ligne |
| Tests unitaires | Bilans (œufs, incubation), seuil relatif de mortalité, coût par tête |
| Tests d'intégration | INV-PRD-01 à 03, INV-OEU-01, INV-INC-01 |
| Tests E2E | Saisie du jour d'une semaine hors ligne |
| Critères d'acceptation | AT-026 à 029, 052, 053 |
| Prérequis | AV-004, AV-005, AV-032, AV-043 à AV-050 |
| Risques | RISK-24 |
| DoD | Un lot pilote suivi de la mise en place à la clôture |

### P8 — Finance opérationnelle

| Rubrique | Contenu |
|---|---|
| Objectif métier | Coûts, marges, dettes, dépenses (CM §31 à 33) |
| Entités | Dépense, catégorie, facture fournisseur, paiement fournisseur, affectation ; coûts de lot complets |
| Tables | `finance.expense_categories`, `finance.expenses`, `finance.supplier_*` |
| API | `/expenses`, `/supplier-invoices`, `/supplier-payments`, `/payables`, `/costs` |
| Interfaces | ECR-FIN-02 à 06, ECR-APP-05 |
| Workflows | SM-EXPENSE, SM-SUPPLIER-INVOICE, SM-SUPPLIER-PAYMENT ; WF-09 (complet) ; WF-J7 |
| Permissions | `finance.*`, `inventory.valuation.read`, `inventory.cost_entry.record` |
| Offline | Dépenses hors ligne (payées immédiatement) |
| Tests d'intégration | INV-FIN-07, 08 ; marges de lot contre l'exemple de la stratégie finance |
| Critères d'acceptation | AT-025, 040, 041 |
| Prérequis | AV-041, AV-042, AV-043, AV-055, AV-058, AV-059, AV-088 |
| Risques | RISK-24 |
| DoD | Marge d'un lot pilote validée par la Direction |

### P9 — Analytics et direction

| Rubrique | Contenu |
|---|---|
| Objectif métier | Tour de contrôle, analyse flexible, alertes actionnables (CM §34, §35, §53, §54) |
| Entités | Vue sauvegardée, export, instantané ; alertes (catalogue complet), notes |
| Tables | `analytics.*`, `communication.*` (complété) |
| API | `/analytics/*`, `/alerts`, `/notes` |
| Interfaces | ECR-ANA-01 à 06, ECR-NOT-01 à 03 |
| Workflows | SM-ALERT ; WF-J5, WF-J6 |
| Permissions | `analytics.*`, `comm.*` |
| Offline | Instantanés `kpi` ; notes et alertes |
| Tests | Cohérence entre écrans (BR-ANA-009), RLS, limites, performance (NFR-12, NFR-13) |
| Critères d'acceptation | AT-038, 039, 043, 045, 046, 048, 054 |
| Prérequis | AV-013, AV-064 à AV-067, AV-086 |
| Risques | RISK-13 |
| DoD | La Direction répond seule aux questions du CM §62 |

### P10 — Intégration Kommo

| Rubrique | Contenu |
|---|---|
| Objectif métier | Parcours digital continu sans double responsabilité (CM §44 à 46) |
| Tables | `integrations.*` |
| API | `/integrations/kommo/*` |
| Interfaces | ECR-KOM-01 ; lien Kommo sur ECR-CRM-03 |
| Workflows | SM-INTEGRATION-MESSAGE ; WF-17 |
| Permissions | `integrations.*` |
| Tests | Webhooks en double, écho, indisponibilité de Kommo, rejeu |
| Critères d'acceptation | AT-044 |
| Prérequis | AV-068 (**bloquante pour cette phase**), AV-069 à AV-071 ; accès sandbox Kommo |
| Risques | RISK-14 |
| DoD | Deux semaines sans message `DEAD` non expliqué |

## 5. Transition cadrage → développement

Voir la checklist [`04-checklist-demarrage.md`](04-checklist-demarrage.md) et le document [`06-passage-au-developpement.md`](06-passage-au-developpement.md). Règle : une phase ne démarre que si ses AV **bloquants** sont tranchés et ses prérequis cochés. Pour les AV importants non tranchés, la valeur par défaut documentée est implémentée **de façon paramétrable**.
