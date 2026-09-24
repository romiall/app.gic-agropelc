# Matrice de traçabilité (Livrable n°17)

> Section 34 du format final (PM §48 ; PM §42). Chaîne : **besoin → règle métier → module → entités → tables → API → écran → test d'acceptation**.
> Une ligne par exigence source ([`../01-functional/00-exigences-sources.md`](../01-functional/00-exigences-sources.md)) : 84 exigences du CM (REQ-001 à REQ-084) et 15 contraintes du PM (REQ-201 à REQ-215).
> **Usage pendant le développement** : à la fin de chaque phase, vérifier que chaque ligne de la phase a ses tests verts ; toute exigence retirée ou modifiée exige une décision tracée (ADR ou registre `A-VALIDER.md`). Une ligne n'est jamais supprimée.

**Conventions de lecture**

- *Règles* : règles métier (BR), invariants (INV), règles de contrôle d'accès (RC), principes d'UX (UX) et décisions (ADR). Seules les règles **principales** sont citées ; l'index complet est dans [`05-index-regles-metier.md`](../01-functional/05-index-regles-metier.md).
- *Tables* : sans le préfixe de schéma quand le module est évident ; `[STD-ORIGIN]` désigne le bloc de colonnes d'origine présent sur chaque document ([`03-data/01-identifiants-et-conventions.md`](../03-data/01-identifiants-et-conventions.md)).
- *API* : commandes `module.agrégat.verbe` (via `/sync/push` ou `/commands`) et lectures `GET /…` ([`08-api-events/01-architecture-api.md`](../08-api-events/01-architecture-api.md)).
- *Tests* : tests d'acceptation `AT-nnn` ([`09-non-functional/03-plan-de-tests.md`](../09-non-functional/03-plan-de-tests.md) §6). Quand une exigence est non fonctionnelle, la vérification est la mesure de la NFR citée.
- *Phase* : phase du plan de développement ([`01-plan-developpement.md`](01-plan-developpement.md)) où l'exigence devient vérifiable.

---

## 1. Vision et principes

| REQ | Besoin (résumé) | Règles | Modules | Entités | Tables | API | Écrans | Tests | Phase |
|---|---|---|---|---|---|---|---|---|---|
| REQ-001 | Chaîne intégrée APPROVISIONNER → … → ANALYSER | P1 ; BR-SYN-001 ; BR-STK-001 ; BR-PRD-002 ; ADR-011 | Tous (monolithe modulaire) | Événement métier ; mouvement de stock (colonne vertébrale) | `platform.domain_events`, `inventory.stock_moves`, `inventory.stock_lots` | `/sync/push`, `/commands` | ECR-ADM-03 | AT-026, AT-038 à 043 | P0 → P10 |
| REQ-002 | Savoir ce qui a été acheté, reçu, produit, … dépensé, et par qui | BR-STK-001 ; BR-FIN-011 ; BR-VEN-020 ; BR-AUD-002 ; P9 | inventory, finance, sales, audit | Mouvement ; mouvement de trésorerie ; vente ; entrée d'audit | `inventory.stock_moves`, `finance.cash_movements`, `sales.sales`, `audit.audit_log` | `GET /stock-moves`, `/sales`, `/audit` | ECR-STK-07, ECR-AUD-01, ECR-ANA-01 | AT-038 à 043 | P2, P4, P9 |
| REQ-003 | Simple, rapide, mobile, robuste en mauvaise connexion | UX-01 à UX-11 ; BR-PRD-008 ; BR-SYN-018 ; NFR-01, 02, 05, 35 | PWA, sync | — (base locale IndexedDB) | — | `/sync/*` | Tous ; ECR-VEN-01, ECR-PRD-02 | AT-001 ; NFR-01, NFR-35 | Toutes |
| REQ-004 | Chaque opération analysable en physique, financier, responsabilité | P9 ; BR-VEN-016 ; BR-VEN-023 ; BR-VEN-020 ; BR-STK-035 | inventory, sales, finance, audit | Mouvement ; encaissement ; écriture de coût ; entrée d'audit | `inventory.stock_moves`, `inventory.cost_entries`, `sales.customer_payments`, `audit.audit_log` | `sales.sale.record`, `inventory.loss.declare` | ECR-VEN-05, ECR-STK-07 | AT-001, AT-026 | P2, P4 |
| REQ-005 | Responsabilité : qui, rôle, lieu, date, appareil, validateur, état de synchro | BR-AUD-002 ; BR-SYN-005 ; BR-ADM-017 ; INV-GLO-01 | audit, sync, approvals | Entrée d'audit ; commande reçue ; demande de validation | `audit.audit_log`, `sync.command_inbox`, `approvals.approval_requests`, `[STD-ORIGIN]` | `GET /audit`, `/sync/status` | ECR-AUD-01, ECR-SYN-01 | AT-001, AT-045 | P0 |

## 2. Organisation commerciale, prospection, attribution, performance

| REQ | Besoin (résumé) | Règles | Modules | Entités | Tables | API | Écrans | Tests | Phase |
|---|---|---|---|---|---|---|---|---|---|
| REQ-006 | Plusieurs commerciaux ; rôles distincts terrain, sédentaire, vendeur PDV, responsable | BR-ADM-003 ; BR-ADM-014 ; BR-VEN-020 | identity, organization | Rôle ; affectation ; équipe | `identity.roles`, `identity.user_role_assignments`, `organization.teams`, `organization.team_memberships` | `identity.role_assignment.grant` ; `GET /users`, `/teams` | ECR-ADM-04 | AT-033, AT-015 | P0 |
| REQ-007 | Cumul de plusieurs rôles | BR-ADM-003 ; INV-ADM-04 ; ADR-008 | identity | Affectation de rôle | `identity.user_role_assignments` | `identity.role_assignment.grant`, `.revoke` | ECR-ADM-04, ECR-ADM-03 | AT-033 ; tests RBAC générés (§5) | P0 |
| REQ-008 | Enregistrer les prospects (coordonnées, localisation, activité, type, source, responsable) | BR-CRM-001, 002, 003, 006, 014 ; INV-CRM-03 | crm | Compte client ; affectation ; source | `crm.customers`, `crm.customer_assignments`, `crm.lead_sources` | `crm.customer.create` ; `GET /customers` | ECR-CRM-02, ECR-CRM-03 | AT-011, AT-012 | P3 |
| REQ-009 | Enregistrer visites et interactions | BR-CRM-012, 013, 015, 016, 017 | crm, fieldwork | Visite ; interaction ; session de travail | `crm.visits`, `crm.interactions`, `fieldwork.work_sessions` | `crm.visit.record`, `crm.interaction.record` ; `GET /visits`, `/interactions` | ECR-CRM-04, ECR-CRM-03 | AT-051 | P3 |
| REQ-010 | Suivre l'évolution du prospect, sa conversion, ses commandes | BR-CRM-008, 010, 011 ; BR-VEN-001 ; INV-CRM-04 | crm, sales | Compte ; historique de stade ; commande | `crm.customer_stage_history`, `crm.customers`, `sales.sales_orders` | `crm.customer.set_pipeline_step`, `sales.order.place`, `sales.sale.record` | ECR-CRM-03, ECR-VEN-02 | AT-011 | P3, P4 |
| REQ-011 | Mesurer l'effort commercial (prospects ajoutés, visités, convertis, CA acquis) | BR-CRM-003, 004, 019 ; BR-ANA-001 ; INV-CRM-01 | crm, analytics | Compte (acquéreur) ; visite ; vente | `crm.customers`, `crm.visits`, `sales.sales`, `analytics.kpi_snapshots` | `GET /analytics/dashboards/{code}` | ECR-CRM-05, ECR-ANA-02 | AT-012, AT-015 | P3, P9 |
| REQ-012 | Rattacher un client à un commercial (portefeuille) | BR-CRM-005, 024 ; BR-VEN-020 ; INV-CRM-02 ; RC-07 | crm | Affectation de titulaire | `crm.customer_assignments`, `crm.customers` | `crm.customer.reassign` ; `GET /customers` | ECR-CRM-01 | AT-013, AT-033 | P3 |
| REQ-013 | Historique des réaffectations | BR-CRM-005, 020 ; INV-CRM-02 ; INV-VEN-10 | crm, sales | Affectation de titulaire ; attribution de vente | `crm.customer_assignments`, `sales.sales` | `crm.customer.reassign` | ECR-CRM-06, ECR-CRM-03 | AT-013 | P3 |
| REQ-014 | Quel commercial gère ce client ; clients à fort CA ; clients inactifs | BR-CRM-011 ; BR-ANA-004, 009 | crm, analytics | Compte ; vente | `crm.customers`, `sales.sales`, `analytics.kpi_snapshots` | `GET /customers`, `POST /analytics/query` | ECR-CRM-01, ECR-ANA-02, ECR-ANA-06 | AT-039 | P3, P9 |
| REQ-015 | Performance d'un commercial sur une période quelconque | BR-CRM-019 ; BR-ANA-002, 009 | analytics | Indicateur ; instantané | `analytics.kpi_snapshots` (+ vues sur `sales`, `crm`) | `GET /analytics/dashboards/{code}?period=`, `POST /analytics/query` | ECR-CRM-05, ECR-ANA-02 | AT-015 | P3, P9 |
| REQ-016 | Indicateurs : prospects créés, visités, contacts, nouveaux clients, commandes, ventes, CA, encaissements, objectifs | BR-ANA-001 ; BR-CRM-018, 019 | analytics, crm | Objectif ; indicateur | `crm.sales_targets`, `analytics.kpi_snapshots` | `crm.target.set` ; `GET /targets`, `/analytics/*` | ECR-CRM-05, ECR-CRM-07, ECR-ANA-02 | AT-015 | P3, P9 |
| REQ-017 | Indicateurs calculés, jamais saisis | BR-ANA-001, 009 | analytics | Indicateur (défini, non stocké en saisie) | Aucune table de saisie d'indicateur ; `analytics.kpi_snapshots` calculé | Lectures seules `/analytics/*` | ECR-ANA-01 à 06 | AT-015, AT-054 | P9 |

## 3. Pointage et géolocalisation

| REQ | Besoin (résumé) | Règles | Modules | Entités | Tables | API | Écrans | Tests | Phase |
|---|---|---|---|---|---|---|---|---|---|
| REQ-018 | Prise de service déclarée (utilisateur, heure, zone, position, précision) | BR-TER-001, 004, 006 ; INV-TER-01 | fieldwork | Pointage ; session de travail | `fieldwork.geo_checkins`, `fieldwork.work_sessions` | `fieldwork.checkin.record` ; `GET /work-sessions` | ECR-TER-01 | AT-014 | P3 |
| REQ-019 | Vérifier la position par rapport à la zone, avec tolérance | BR-TER-002, 003 ; BR-ADM-012 | fieldwork, organization | Pointage ; zone (géorepère) | `fieldwork.geo_checkins`, `organization.zones` | `fieldwork.checkin.record` | ECR-TER-01, ECR-ADM-06 | AT-014 | P3 |
| REQ-020 | Conserver les tentatives hors zone pour audit | BR-TER-001, 005, 010 ; BR-ADM-013 ; INV-TER-02 | fieldwork, approvals, audit | Pointage refusé ; dérogation | `fieldwork.geo_checkins`, `approvals.approval_requests` | `fieldwork.checkin.request_override` | ECR-TER-01, ECR-TER-02, ECR-ADM-08 | AT-014 | P3 |
| REQ-021 | Pas de géolocalisation permanente | BR-TER-011, 007 ; BR-CRM-012 ; NFR-09 | fieldwork, crm | — (absence voulue de trace continue) | Aucune table de trace GPS | — | ECR-TER-01, ECR-CRM-04 | NFR-09 (mesure : aucune capture hors événements) | P3 |

## 4. Ventes et points de vente

| REQ | Besoin (résumé) | Règles | Modules | Entités | Tables | API | Écrans | Tests | Phase |
|---|---|---|---|---|---|---|---|---|---|
| REQ-022 | Ventes multicanales | BR-VEN-020, 021 | sales, catalog | Canal ; vente | `catalog.sales_channels`, `sales.sales` | `sales.sale.record` ; `POST /analytics/query` | ECR-VEN-01, ECR-ANA-06 | AT-039 | P1, P4 |
| REQ-023 | Plusieurs PDV, chacun avec stock, vendeurs, caisse | BR-DIS-001, 002, 003 ; BR-ADM-008 | organization, inventory, finance | Site ; PDV ; emplacement de vente ; compte de caisse | `organization.sites`, `organization.points_of_sale`, `organization.locations`, `finance.cash_accounts` | `organization.site.create`, `organization.pos.configure` ; `GET /sites` | ECR-ADM-06, ECR-DIS-01 | AT-004 | P0, P5 |
| REQ-024 | Par PDV : envoyé, vendu, restant, encaissé, quasi immédiatement | BR-DIS-010 ; BR-ANA-005 ; NFR-16 | analytics, inventory, sales, finance | Indicateur de distribution | Vues sur `inventory.stock_moves`, `sales.sales`, `finance.cash_movements` | `GET /analytics/dashboards/{code}` | ECR-DIS-04, ECR-ANA-01 | AT-042 | P5 |
| REQ-025 | Vente associable à vendeur, commercial, client, PDV, canal, zone | BR-VEN-020, 021, 022, 024 ; INV-VEN-10 | sales | Vente ; ligne de vente | `sales.sales`, `sales.sale_lines` | `sales.sale.record` ; `GET /sales` | ECR-VEN-01, ECR-VEN-05 | AT-001, AT-013 | P4 |
| REQ-026 | Une vente diminue le stock, augmente le CA, crée une créance, est rattachée | BR-VEN-016, 023 ; BR-FIN-007, 042, 043 ; INV-VEN-08 | sales, inventory, finance | Vente ; mouvement ; encaissement ; affectation ; créance | `sales.sales`, `inventory.stock_moves`, `sales.customer_payments`, `sales.payment_allocations`, `sales.v_receivables`, `finance.cash_movements` | `sales.sale.record`, `sales.payment.record` | ECR-VEN-01, ECR-VEN-05, ECR-FIN-01 | AT-001, AT-032 | P4 |

## 5. Production

| REQ | Besoin (résumé) | Règles | Modules | Entités | Tables | API | Écrans | Tests | Phase |
|---|---|---|---|---|---|---|---|---|---|
| REQ-027 | Ne pas confondre volaille, œufs, incubation, porcs | BR-PRD-001 ; BR-OEU-001 ; BR-INC-001 ; BR-POR-001 | production | Lot (typé) ; collecte ; lot d'incubation | `production.production_lots`, `production.egg_collections`, `production.incubation_batches` | `GET /production/lots`, `/production/egg-collections`, `/production/incubations` | ECR-PRD-01, ECR-PRD-06 | AT-026, AT-028, AT-029, AT-052 | P7 |
| REQ-028 | Lots avicoles : quantité initiale, date, bâtiment, fournisseur, souche | BR-PRD-001, 002, 004, 009 ; BR-VOL-001 | production, inventory | Lot de production ; entrée ; lot de traçabilité | `production.production_lots`, `production.lot_entries`, `inventory.stock_lots` | `production.lot.create`, `production.lot.record_entry` | ECR-PRD-04, ECR-PRD-03 | AT-026 | P7 |
| REQ-029 | Quantité d'un lot jamais modifiée arbitrairement | BR-PRD-003 ; BR-STK-001, 002 ; INV-PRD-01 ; INV-STK-01 | production, inventory | Solde du lot de traçabilité | `inventory.stock_balances`, `inventory.stock_moves` | Aucune commande de saisie d'effectif | ECR-PRD-03 | AT-022, AT-026 | P7 |
| REQ-030 | Mortalité traçable, avec effet sur stock biologique, disponible futur, performance, coût | BR-PRD-005, 006, 013 ; BR-STK-035 ; INV-PRD-03 | production, inventory | Déclaration de perte (MORTALITE) ; mouvement ; écriture de coût | `inventory.loss_declarations`, `inventory.stock_moves`, `inventory.cost_entries` | `production.mortality.record` | ECR-PRD-02 | AT-027 | P7 |
| REQ-031 | Œufs : collectés, cassés, non conformes, commercialisables, à couver | BR-OEU-001, 002, 004 ; INV-OEU-01 | production, inventory | Collecte d'œufs ; mouvement | `production.egg_collections`, `inventory.stock_moves` | `production.egg_collection.record` | ECR-PRD-02 | AT-028 | P7 |
| REQ-032 | Classifications d'œufs supplémentaires | BR-OEU-006 ; BR-CAT-001 | catalog, production | Produit | `catalog.products` | `catalog.product.create` | ECR-PRX-01 | AT-053 | P1, P7 |
| REQ-033 | Incubation : constitution, entrée, mirage, infertiles, éclosion, poussins, taux | BR-INC-001 à 007 ; INV-INC-01 | production, inventory | Lot d'incubation ; étape | `production.incubation_batches`, `production.incubation_events`, `inventory.stock_moves` | `production.incubation.start`, `.record_candling`, `.transfer_to_hatcher`, `.record_hatch` | ECR-PRD-06 | AT-029 | P7 |
| REQ-034 | Porcs suivis par groupe : entrée, case, effectif, alimentation, poids, mortalité, vente | BR-POR-001 à 004 ; BR-PRD-015 | production, inventory, organization | Lot porcin ; case ; pesée | `production.production_lots`, `production.lot_weighings`, `organization.locations` (PEN) | `production.lot.create`, `production.weighing.record`, `inventory.transfer.move_internal` | ECR-PRD-03, ECR-PRD-04 | AT-052 | P7 |
| REQ-035 | Identification individuelle = évolution future | BR-POR-005 | production | Animal (extension) | `production.animals` (décrite, **non créée** au MVP) | — | — | AT-052 (aucun identifiant individuel exigé) | Futur |

## 6. Stock

| REQ | Besoin (résumé) | Règles | Modules | Entités | Tables | API | Écrans | Tests | Phase |
|---|---|---|---|---|---|---|---|---|---|
| REQ-036 | Distinguer stock biologique, commercialisable, commercial | BR-CAT-001 ; BR-STK-010 ; BR-VOL-002 | catalog, inventory, organization | Produit (famille de stock) ; emplacement | `catalog.products`, `organization.locations`, `inventory.stock_balances` | `GET /stock` | ECR-STK-01 | AT-038 | P1, P2 |
| REQ-037 | Toute variation de stock a une cause | BR-STK-001, 002, 006 ; INV-STK-01 à 04 ; ADR-003 | inventory | Mouvement (type = cause) | `inventory.stock_moves`, `inventory.stock_balances` | Toute commande à effet stock ; `GET /stock-moves` | ECR-STK-07 | AT-022, AT-043 | P2 |
| REQ-038 | Quel stock, où, depuis quand, d'où, combien disponible | BR-STK-004, 005, 011, 050 | inventory | Solde ; lot de traçabilité ; allocation | `inventory.stock_balances`, `inventory.stock_lots`, `inventory.stock_allocations` | `GET /stock`, `/stock-moves` | ECR-STK-01, ECR-STK-07 | AT-038, AT-043 | P2 |
| REQ-039 | Transferts entre emplacements, avec écarts | BR-STK-020, 021, 022, 025 ; BR-DIS-012 ; INV-STK-08 | inventory | Transfert ; ligne ; mouvement de transit | `inventory.stock_transfers`, `inventory.stock_transfer_lines`, `inventory.stock_moves` | `inventory.transfer.request`, `.dispatch`, `.receive` | ECR-STK-02, ECR-STK-03 | AT-016, AT-017 | P2 |
| REQ-040 | Stock confié à un vendeur ou commercial, sous sa responsabilité | BR-STK-016, 023 ; BR-ADM-009 ; BR-VEN-017 ; INV-ADM-05 | inventory, organization | Emplacement MOBILE ; transfert | `organization.locations`, `inventory.stock_transfers` | `inventory.transfer.dispatch`, `.return_to_source` | ECR-STK-02, ECR-STK-01 | AT-018 | P4 |
| REQ-041 | Perte documentée (nature, produit, quantité, lieu, date, utilisateur, motif, lot) | BR-STK-030, 032 ; BR-OEU-003 | inventory | Déclaration de perte ; mouvement | `inventory.loss_declarations`, `inventory.stock_moves` | `inventory.loss.declare` | ECR-STK-04 | AT-019, AT-020 | P2 |
| REQ-042 | Photo, validation ou justification selon le niveau de perte | BR-STK-031, 033 ; BR-ADM-016, 020 ; INV-STK-14 ; ADR-018 | approvals, attachments, inventory | Politique de contrôle ; demande de validation ; pièce jointe | `approvals.control_policies`, `approvals.approval_requests`, `attachments.attachments` | `approvals.request.approve`, `.reject`, `approvals.policy.set` | ECR-STK-04, ECR-ADM-08, ECR-ADM-07 | AT-019, AT-020 | P0, P2 |
| REQ-043 | Inventaire : théorique vs physique, écart expliqué et régularisé | BR-STK-040 à 044 ; INV-STK-09 | inventory | Inventaire ; ligne de comptage | `inventory.inventory_counts`, `inventory.inventory_count_lines`, `inventory.stock_moves` | `inventory.count.open`, `.record_lines`, `.submit` | ECR-STK-05 | AT-021 | P2 |

## 7. Approvisionnement

| REQ | Besoin (résumé) | Règles | Modules | Entités | Tables | API | Écrans | Tests | Phase |
|---|---|---|---|---|---|---|---|---|---|
| REQ-044 | Par fournisseur : commandé, prix, reçu, écarts, documents, dettes | BR-APP-001, 005 ; BR-FIN-030, 031, 032 | procurement, finance | Fournisseur ; BC ; réception ; facture ; dette | `procurement.suppliers`, `procurement.purchase_orders`, `procurement.goods_receipts`, `finance.supplier_invoices`, `finance.v_payables` | `GET /suppliers`, `/purchase-orders`, `/receipts`, `/payables` | ECR-APP-01, ECR-APP-05, ECR-FIN-03 | AT-025 | P6, P8 |
| REQ-045 | Besoin → demande → validation → BC → réception → facture → paiement | BR-APP-002 à 005 ; BR-FIN-030, 033 ; WF-09 | procurement, finance, approvals | Demande d'achat ; BC ; réception ; facture ; paiement | `procurement.purchase_requests`, `procurement.purchase_orders`, `procurement.goods_receipts`, `finance.supplier_invoices`, `finance.supplier_payments` | `procurement.request.submit`, `procurement.order.create`, `.submit`, `procurement.receipt.record`, `finance.supplier_invoice.record`, `finance.supplier_payment.record` | ECR-APP-02, 03, 04, ECR-FIN-03, 04 | AT-023, AT-025 | P6, P8 |
| REQ-046 | Commandé ≠ livré ≠ reçu ≠ accepté ≠ facturé ≠ payé | BR-APP-007, 009 ; BR-FIN-031, 032 ; INV-APP-01, 02 ; INV-FIN-07 | procurement, finance | Ligne de BC ; ligne de réception ; ligne de facture ; affectation de paiement | `procurement.purchase_order_lines`, `procurement.goods_receipt_lines`, `finance.supplier_invoice_lines`, `finance.supplier_payment_allocations` | `GET /purchase-orders/{id}` (rapprochement) | ECR-APP-05 | AT-023, AT-025 | P6, P8 |
| REQ-047 | Réception réelle confirmée ; le stock n'augmente que de l'accepté | BR-APP-007, 008, 010, 011, 012 ; INV-APP-03 ; INV-STK-12 | procurement, inventory | Réception ; mouvement d'entrée | `procurement.goods_receipts`, `procurement.goods_receipt_lines`, `inventory.stock_moves` | `procurement.receipt.record` | ECR-APP-04 | AT-023, AT-024 | P6 |

## 8. Prix

| REQ | Besoin (résumé) | Règles | Modules | Entités | Tables | API | Écrans | Tests | Phase |
|---|---|---|---|---|---|---|---|---|---|
| REQ-048 | Prix variables selon ville, marché, quartier, PDV, saison, type de client, quantité, canal | BR-PRX-001, 003, 004, 005, 016 | pricing, catalog, organization | Règle tarifaire ; campagne ; catégorie de client ; canal ; zone | `pricing.price_rules`, `pricing.commercial_campaigns`, `catalog.customer_categories`, `catalog.sales_channels`, `organization.zones` | `pricing.rule.draft`, `.activate` ; `GET /prices/resolve` | ECR-PRX-02, ECR-PRX-03 | AT-006 | P1 |
| REQ-049 | Seules les personnes autorisées modifient ; les vendeurs ont le bon prix sans appel | BR-PRX-010, 011, 012, 013 ; BR-DIS-004 ; INV-PRX-04 | pricing, sync | Règle tarifaire ; jeu synchronisé `pricing` | `pricing.price_rules`, `sync.change_feed` | `pricing.rule.activate` ; `GET /sync/pull` | ECR-PRX-02, ECR-VEN-01 | AT-005, AT-006 | P1 |
| REQ-050 | Un changement de prix ne réécrit jamais le passé | BR-PRX-007, 008, 014 ; BR-VEN-003, 013 ; INV-PRX-01, 03 ; INV-VEN-05 ; ADR-005 | pricing, sales | Version de règle ; ligne de vente (prix figé) | `pricing.price_rules`, `sales.sale_lines`, `sales.sales_order_lines` | `pricing.rule.supersede` | ECR-PRX-02, ECR-VEN-05 | AT-007 | P1, P4 |

## 9. Finance

| REQ | Besoin (résumé) | Règles | Modules | Entités | Tables | API | Écrans | Tests | Phase |
|---|---|---|---|---|---|---|---|---|---|
| REQ-051 | Comptabilité opérationnelle : ventes, CA, encaissements, créances, dépenses, achats, dettes, caisse, coûts, marges | BR-FIN-001, 011, 020, 042, 043 ; INV-FIN-02 ; ADR-010 | finance, sales, inventory | Mouvement de trésorerie ; dépense ; encaissement ; créance ; dette ; écriture de coût | `finance.cash_movements`, `finance.expenses`, `sales.customer_payments`, `sales.v_receivables`, `finance.v_payables`, `inventory.cost_entries` | `finance.expense.record`, `sales.payment.record` ; `GET /cash-accounts`, `/expenses`, `/receivables`, `/payables` | ECR-FIN-01 à 06 | AT-030, AT-032, AT-040 | P4, P8 |
| REQ-052 | Stock et finance reliés (valeur des ventes, des pertes, des consommations) | BR-STK-035, 052, 053 ; BR-FIN-043, 044 ; BR-APP-008 ; INV-STK-15 | inventory, finance | Coût unitaire figé ; valorisation ; écriture de coût | `inventory.stock_moves` (coût unitaire), `inventory.product_valuations`, `inventory.cost_entries` | `GET /costs` | ECR-FIN-06, ECR-STK-07 | AT-019, AT-041 | P2, P8 |
| REQ-053 | Rentabilité d'un lot (initial, mortalité, vendu, coûts, CA, marge) | BR-PRD-012, 013, 014 ; BR-FIN-040, 041 ; INV-FIN-08 ; ADR-015 | production, inventory, sales, analytics | Lot ; écriture de coût ; ligne de vente (lot) | `production.production_lots`, `inventory.cost_entries`, `sales.sale_lines` | `production.lot.close` ; `GET /production/lots/{id}` | ECR-PRD-03, ECR-FIN-06 | AT-026, AT-041 | P7, P8 |

## 10. Tableaux de bord et analyse

| REQ | Besoin (résumé) | Règles | Modules | Entités | Tables | API | Écrans | Tests | Phase |
|---|---|---|---|---|---|---|---|---|---|
| REQ-054 | Tour de contrôle Direction | BR-ANA-005, 009, 010 ; NFR-12 | analytics | Indicateur ; instantané | `analytics.kpi_snapshots` (+ vues) | `GET /analytics/dashboards/{code}` | ECR-ANA-01 | AT-038 à 043 | P9 |
| REQ-055 | Tableau Responsable commercial | BR-ANA-004, 009 ; BR-CRM-019 | analytics | Indicateur | `analytics.kpi_snapshots` | `GET /analytics/dashboards/{code}` | ECR-ANA-02 | AT-015, AT-039, AT-054 | P3 (simple), P9 |
| REQ-056 | Tableau Commercial (objectifs, prospects, clients, visites, ventes) | BR-CRM-018, 019 ; BR-ANA-004 ; UX-01 | analytics, crm | Objectif ; indicateur | `crm.sales_targets`, `analytics.kpi_snapshots` | `GET /analytics/dashboards/{code}` | ECR-CRM-05, ECR-ADM-03 | AT-015, AT-054 | P3 |
| REQ-057 | Tableau Magasinier (réceptions, sorties, transferts, stock, alertes, pertes, inventaires) | BR-STK-051 ; BR-ANA-004 | analytics, inventory | Solde ; seuil ; alerte | `inventory.stock_balances`, `inventory.stock_thresholds`, `communication.alerts` | `GET /stock`, `/alerts` | ECR-ANA-03, ECR-STK-01 | AT-047 | P2 (simple), P9 |
| REQ-058 | Tableau Production (lots, effectifs, mortalité, œufs, incubation, disponible) | BR-PRD-006 ; BR-INC-007 ; BR-ANA-009 | analytics, production | Lot ; indicateur | `production.production_lots`, `analytics.kpi_snapshots` | `GET /production/lots`, `/analytics/dashboards/{code}` | ECR-ANA-04, ECR-PRD-01 | AT-026, AT-027 | P7 (simple), P9 |
| REQ-059 | Tableau Finance (ventes, paiements, créances, dépenses, fournisseurs, caisse, coûts, marges) | BR-FIN-007, 032 ; BR-ANA-004 ; RC-05 | analytics, finance, sales | Créance ; dette ; compte de trésorerie | `sales.v_receivables`, `finance.v_payables`, `finance.cash_movements` | `GET /receivables`, `/payables`, `/analytics/dashboards/{code}` | ECR-ANA-05, ECR-FIN-01, ECR-FIN-05 | AT-040, AT-054 | P8 (simple), P9 |
| REQ-060 | Vues analytiques : filtre, tri, regroupement, colonnes, agrégation, export | BR-ANA-006, 007, 008 ; RC-09 | analytics, audit | Vue sauvegardée ; export | `analytics.saved_views`, `analytics.export_jobs` | `POST /analytics/query`, `analytics.view.save`, `analytics.export.request` | ECR-ANA-06 | AT-046 | P9 |

## 11. Connectivité, synchronisation, traçabilité

| REQ | Besoin (résumé) | Règles | Modules | Entités | Tables | API | Écrans | Tests | Phase |
|---|---|---|---|---|---|---|---|---|---|
| REQ-061 | Connecté : remontée rapide ; hors connexion : stockage local puis synchro | BR-SYN-001, 010, 015, 018 ; NFR-16 ; ADR-007 | sync | Commande reçue ; flux de changements ; état d'appareil | `sync.command_inbox`, `sync.change_feed`, `sync.device_sync_state` | `POST /sync/push`, `GET /sync/pull`, `GET /sync/bootstrap` | ECR-SYN-01 | AT-001, AT-037 | P0 |
| REQ-062 | Sans connexion : vente, prospect, visite, pertes, réceptions… restent possibles | BR-SYN-001, 007 ; BR-VEN-019 ; BR-STK-018, 024 ; INV-SYN-06 ; NFR-18 | sync + modules concernés | Outbox locale ; commande | IndexedDB (outbox) ; `sync.command_inbox` | `POST /sync/push` | ECR-VEN-01, ECR-CRM-02, ECR-CRM-04, ECR-STK-04 | AT-001, AT-017, AT-037 | P0 → P7 |
| REQ-063 | Heure réelle conservée ; distinction réel / création / réception | BR-SYN-011, 012 ; BR-STK-005 ; BR-ANA-002 ; INV-GLO-01, 02 ; ADR-016 | sync, tous | Horodatages métier et techniques | `[STD-ORIGIN]` (`occurred_at`, `client_created_at`, `received_at`, `applied_at`) | `POST /sync/push` | ECR-SYN-01, ECR-VEN-05 | AT-001, AT-036 | P0 |
| REQ-064 | Réduire la survente hors ligne par affectation explicite de quantités | BR-STK-010, 012, 013, 016 ; BR-DIS-002 ; INV-STK-10, 11 ; ADR-004 | inventory, organization | Allocation ; entrée d'allocation ; mode de garde | `inventory.stock_allocations`, `inventory.stock_allocation_entries`, `organization.locations` | `inventory.allocation.grant`, `.release`, `.revoke` | ECR-STK-06, ECR-DIS-01 | AT-003, AT-004, AT-018, AT-049 | P4, P5 |
| REQ-065 | Audit des opérations sensibles (quoi, qui, quand, où, appareil, avant/après, motif, validation) | BR-AUD-001 à 006 ; INV-AUD-01 ; INV-GLO-04 | audit | Entrée d'audit | `audit.audit_log` | `GET /audit` | ECR-AUD-01 | AT-045 | P0 |
| REQ-066 | Correction par annulation, contre-écriture ou ajustement, jamais par suppression | BR-STK-002, 034 ; BR-VEN-012, 027 ; BR-FIN-006 ; BR-APP-013 ; BR-CRM-016 ; INV-GLO-03 ; ADR-006 | inventory, sales, finance, procurement, crm | Contre-écriture ; demande d'annulation | Toutes les tables des catégories Transaction et Registre (`IMMUABLE`) | `sales.sale.cancel`, `sales.payment.request_cancellation`, `inventory.loss.request_cancellation`, `procurement.receipt.request_cancellation` | ECR-VEN-05, ECR-ADM-08 | AT-009, AT-010, AT-020, AT-022 | P2, P4, P6 |
| REQ-067 | Pièces justificatives pour certaines opérations | BR-ADM-019, 020 ; BR-APP-014 ; BR-FIN-020 ; ADR-012 | attachments, approvals | Pièce jointe ; politique de contrôle | `attachments.attachments`, `approvals.control_policies` | `POST /attachments/{id}/upload-session`, `PUT /attachments/{id}/content` | ECR-STK-04, ECR-APP-04, ECR-FIN-02 | AT-019 ; NFR-08 (upload interrompu) | P0 |
| REQ-068 | Notes internes de la direction, qui ne remplacent pas les règles | BR-NOT-006, 007 ; BR-PRX-012 | communication | Note ; audience ; accusé de lecture | `communication.internal_notes`, `communication.note_audiences`, `communication.note_acknowledgements` | `communication.note.publish`, `.acknowledge` | ECR-NOT-02, ECR-NOT-03 | AT-048 | P9 |

## 12. Kommo

| REQ | Besoin (résumé) | Règles | Modules | Entités | Tables | API | Écrans | Tests | Phase |
|---|---|---|---|---|---|---|---|---|---|
| REQ-069 | Kommo reste responsable des leads digitaux, conversations, pipeline relationnel | BR-KOM-001 ; BR-CRM-017, 023 ; INV-KOM-03 ; ADR-009 | integrations, crm | Lien externe | `integrations.external_links` | — (aucune copie des conversations) | ECR-KOM-01 | AT-044 | P10 |
| REQ-070 | GIC est la source métier des clients, produits, commandes, ventes, stock, prix | BR-KOM-003, 009 ; P10 ; ADR-009 | integrations, crm | Compte client (source de vérité) ; lien externe | `crm.customers`, `integrations.external_links` | — | ECR-KOM-01 | AT-044 | P10 |
| REQ-071 | Échanges lead → qualification → attribution → conversion → commande → vente | BR-KOM-002, 004 à 008 ; INV-KOM-01, 02 ; WF-17 | integrations | Message entrant ; message sortant ; lien externe | `integrations.inbox_messages`, `integrations.outbox_messages`, `integrations.external_links` | `POST /integrations/kommo/webhook`, `integrations.kommo.replay` | ECR-KOM-01 | AT-044 | P10 |

## 13. Rôles, accès, interface

| REQ | Besoin (résumé) | Règles | Modules | Entités | Tables | API | Écrans | Tests | Phase |
|---|---|---|---|---|---|---|---|---|---|
| REQ-072 | Rôles minimum du CM §47 | BR-ADM-003 ; ADR-008 ; matrice [`07-security-rbac/01-rbac.md`](../07-security-rbac/01-rbac.md) | identity | Rôle ; permission | `identity.roles`, `identity.permissions`, `identity.role_permissions` (seed versionné) | `identity.role.set_permissions` ; `GET /roles` | ECR-ADM-04 | AT-033 ; tests RBAC générés | P0 |
| REQ-073 | Accès restreints au périmètre (portefeuille, site, équipe…) | BR-CRM-024 ; BR-ANA-004 ; BR-NOT-008 ; RC-01 à RC-10 ; NFR-24 | identity + tous | Affectation (portée) | `identity.user_role_assignments` | Toutes (contrôle de portée systématique) | — | AT-033, AT-054 | P0 → P10 |
| REQ-074 | Actions métier évidentes (PRENDRE SERVICE, + PROSPECT, + VISITE, + VENTE…) | UX-01 à UX-11 ; BR-PRD-008 ; NFR-35 | PWA | — | — | — | ECR-ADM-03, ECR-TER-01, ECR-CRM-02, ECR-CRM-04, ECR-VEN-01, ECR-STK-04, ECR-PRD-02 | NFR-35 (tests utilisateurs pilotes) | Toutes |
| REQ-075 | La direction comprend la situation en quelques dizaines de secondes | BR-ANA-005, 010 ; NFR-12 | analytics | Indicateur | `analytics.kpi_snapshots` | `GET /analytics/dashboards/{code}` | ECR-ANA-01 | NFR-12 (test utilisateur ≤ 30 s) | P9 |
| REQ-076 | Un responsable consulte, détecte, suit et valide | BR-ADM-018 ; BR-NOT-001 ; BR-ANA-004 | approvals, communication, analytics | Demande de validation ; alerte | `approvals.approval_requests`, `communication.alerts` | `GET /approvals/inbox`, `/alerts` | ECR-ADM-08, ECR-NOT-01, ECR-ANA-02, ECR-TER-02 | AT-019, AT-047 | P0, P9 |
| REQ-077 | Alertes actionnables (stock faible, pertes, mortalité, réception incomplète, créances…) | BR-NOT-001 à 005 ; BR-STK-051 ; BR-PRD-006 ; BR-APP-015 ; BR-TER-013 ; INV-NOT-01 | communication + modules émetteurs | Règle d'alerte ; alerte ; notification | `communication.alert_rules`, `communication.alerts`, `communication.notifications`, `communication.push_subscriptions` | `communication.alert.acknowledge`, `.resolve` ; `GET /alerts` | ECR-NOT-01 | AT-027, AT-032, AT-047 | P2 → P9 |

## 14. Évolutivité, périmètre, cohérence

| REQ | Besoin (résumé) | Règles | Modules | Entités | Tables | API | Écrans | Tests | Phase |
|---|---|---|---|---|---|---|---|---|---|
| REQ-078 | Supporter la croissance (utilisateurs, sites, produits, volumes) | NFR-14, NFR-33 ; ADR-011 ; H-06 | Tous | — | Partitionnement de `audit.audit_log`, `inventory.stock_moves`, `sync.command_inbox`, `sync.change_feed` | — | — | NFR-33 (test de charge à 10×, avant R4) | P0, R4 |
| REQ-079 | Hors MVP : géolocalisation permanente, IA, IoT, tournées, paie, RH… | BR-TER-011 ; BR-POR-005 ; BR-VOL-003 ; [`02-perimetre.md`](../01-functional/02-perimetre.md) | — | — | — | — | — | Revue de périmètre (RISK-20) | — |
| REQ-080 | MVP = base fiable Core, stock, ventes, CRM terrain… | Plan P0 à P5 ; R1, R2 | Tous les modules de N0 à N6 | — | — | — | — | DoD des phases P0 à P5 | P0 → P5 |
| REQ-081 | Même histoire à travers les dimensions (lot → production → … → marge) | BR-PRD-002 ; BR-VEN-013 ; BR-STK-050 ; BR-FIN-040 ; P9 | production, inventory, sales, finance | Lot de traçabilité (fil conducteur) | `inventory.stock_lots`, `inventory.stock_moves`, `sales.sale_lines`, `inventory.cost_entries` | `GET /production/lots/{id}` | ECR-PRD-03, ECR-FIN-06 | AT-026 | P7, P8 |
| REQ-082 | Un propriétaire officiel unique par donnée importante | P10 ; BR-KOM-003 ; INV-GLO-05 ; [`05-architecture/02-modules.md`](../05-architecture/02-modules.md) | Tous | — | Chaque table a un module propriétaire ([`03-data/02-modele-relationnel.md`](../03-data/02-modele-relationnel.md)) | — | — | AT-044, AT-055 | P0 |
| REQ-083 | Données explicables : quand deux chiffres diffèrent, on sait pourquoi | BR-ANA-009, 010 ; BR-STK-042, 044 ; NFR-38 | analytics, inventory | Mouvement (explication d'écart) | `inventory.stock_moves` ; tâche de réconciliation quotidienne | `GET /stock-moves`, `POST /analytics/query` | ECR-STK-07, ECR-ANA-01 | AT-021, AT-043, AT-054 | P2, P9 |
| REQ-084 | Répondre aux questions de réussite du CM §62 | BR-ANA-009, 010 ; BR-DIS-010 ; BR-FIN-042 | analytics + tous | — | — | `GET /analytics/*` | ECR-ANA-01, ECR-ANA-06 | AT-038 à AT-043 | P9 |

## 15. Contraintes techniques du Prompt maître

| REQ | Contrainte (résumé) | Règles et décisions | Modules | Entités | Tables | API | Écrans | Tests | Phase |
|---|---|---|---|---|---|---|---|---|---|
| REQ-201 | PWA qui fonctionne sans réseau | ADR-001 ; BR-SYN-001 ; NFR-02, NFR-18 | sync, PWA | Outbox ; projection locale | `sync.*` ; IndexedDB | `/sync/*` | ECR-SYN-01 | AT-001, AT-037 | P0 |
| REQ-202 | Chaque opération locale porte uuid, device_id, user_id, occurred_at… | BR-SYN-002, 003 ; INV-SYN-01 à 04 ; ADR-002 | sync | Commande | `sync.command_inbox`, `[STD-ORIGIN]` | `POST /sync/push` | — | AT-002 | P0 |
| REQ-203 | États de synchronisation minimum | BR-SYN-005, 006, 018 ; SM-SYNC-COMMAND | sync | Commande ; conflit | `sync.command_inbox`, `sync.sync_conflicts` | `GET /sync/status`, `sync.conflict.resolve` | ECR-SYN-01, ECR-SYN-03 | AT-001, AT-005, AT-049 | P0 |
| REQ-204 | Stock = Σ mouvements ; inventaire → ajustement ; pas de double consommation hors ligne | BR-STK-004, 012, 043 ; INV-STK-01, 10 ; ADR-003, ADR-004 | inventory | Mouvement ; allocation ; inventaire | `inventory.stock_moves`, `inventory.stock_balances`, `inventory.stock_allocations`, `inventory.inventory_counts` | Commandes `inventory.*` | ECR-STK-01, ECR-STK-05, ECR-STK-06 | AT-003, AT-004, AT-021, AT-022 | P2, P5 |
| REQ-205 | Données historisées, versionnées, figées ou référencées | ADR-005 ; BR-PRX-014 ; BR-VEN-013 ; BR-CAT-007 ; BR-ADM-015 ; [`03-data/03-historisation-suppression.md`](../03-data/03-historisation-suppression.md) | Tous | — | Tables versionnées et colonnes figées | — | — | AT-007, AT-013 | P0 → P8 |
| REQ-206 | Aucune suppression physique des opérations sensibles | ADR-006 ; BR-AUD-001 ; BR-STK-002 ; INV-GLO-03 | Tous | — | Déclencheurs d'immuabilité | — | — | AT-022, AT-045 | P0 |
| REQ-207 | Règles tarifaires simultanées : priorité, spécificité, validité, historique | BR-PRX-002 à 006 ; INV-PRX-02 ; ADR-005 | pricing | Règle tarifaire | `pricing.price_rules` | `pricing.rule.*`, `GET /prices/resolve` | ECR-PRX-02, ECR-PRX-03 | AT-006, AT-007 | P1 |
| REQ-208 | RBAC : users, roles, permissions, affectations, restrictions contextuelles | ADR-008 ; RC-01 à RC-10 | identity | Utilisateur ; rôle ; permission ; affectation | `identity.users`, `identity.roles`, `identity.permissions`, `identity.role_permissions`, `identity.user_role_assignments` | `identity.*` | ECR-ADM-04 | AT-033 ; tests RBAC générés | P0 |
| REQ-209 | Journal d'audit complet | BR-AUD-002 ; INV-AUD-01, 02 | audit | Entrée d'audit | `audit.audit_log` | `GET /audit` | ECR-AUD-01 | AT-045 | P0 |
| REQ-210 | Intégration Kommo bidirectionnelle par API et webhooks | ADR-009 ; BR-KOM-* ; INV-KOM-* | integrations | Lien externe ; messages | `integrations.*` | `/integrations/kommo/*` | ECR-KOM-01 | AT-044 | P10 |
| REQ-211 | Appareils Android modestes, faible bande passante | NFR-05, NFR-07, NFR-34, NFR-40 ; [`05-architecture/05-stack.md`](../05-architecture/05-stack.md) | PWA | — | — | — | Tous | Tests E2E sur l'appareil de référence ; budget de bundle en CI | P0 |
| REQ-212 | Le client n'est jamais une autorité | P11 ; RC-08 ; BR-SYN-001 | Tous | — | — | Revalidation serveur de chaque commande | — | AT-022, AT-033 | P0 |
| REQ-213 | Base relationnelle justifiée | ADR-020 ; [`05-stack.md`](../05-architecture/05-stack.md) §3 | — | — | PostgreSQL | — | — | Revue d'architecture | P0 |
| REQ-214 | Pas de microservices ; frontières fonctionnelles préservées | ADR-011 ; NFR-32 | Tous | — | Un schéma par module | — | — | AT-055 | P0 |
| REQ-215 | Pas de génération de l'application avant stabilisation du cadrage | [`04-checklist-demarrage.md`](04-checklist-demarrage.md) | — | — | — | — | — | Checklist de démarrage cochée | Avant P0 |

---

## 16. Contrôle de couverture

Contrôle effectué à la rédaction de cette matrice (fin de cadrage) :

| Contrôle | Résultat |
|---|---|
| Exigences sans règle, décision ou NFR de rattachement | **0** |
| Exigences sans écran | CM : 6 (REQ-035 extension, REQ-079 exclusions, REQ-073, 078, 080, 082 transverses) ; PM : 7 contraintes techniques (REQ-202, 205, 206, 212 à 215), sans écran par nature |
| Exigences sans test d'acceptation (AT) | 9 : REQ-021, 074, 075, 078, 211 (vérifiées par la mesure de NFR-09, 35, 12, 33, 05/34) ; REQ-079 (revue de périmètre) ; REQ-080 (DoD des phases) ; REQ-213, REQ-215 (revues) |
| AT ajoutés pendant la construction de la matrice | AT-051 (visites), AT-052 (porcs), AT-053 (nouvelle catégorie d'œufs), AT-054 (cohérence des indicateurs et portée), AT-055 (frontières de modules) |
| Écrans non rattachés à une exigence | 0 (ECR-PRD-05 est volontairement non attribué) |

**Règle de maintien** : toute nouvelle exigence reçoit un identifiant `REQ-nnn` dans [`00-exigences-sources.md`](../01-functional/00-exigences-sources.md) **et** une ligne dans cette matrice, dans le même commit. Le script [`../_tools/check_refs.py`](../_tools/check_refs.py) signale toute référence orpheline (REQ, BR, INV, AT, ECR, ADR…).
