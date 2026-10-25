# Proposition d'intégration — pièces papier et application GIC AGROPELC

**Statut : PROPOSITION, non décisionnelle.** Document destiné à la session qui développe l'application. Il ne modifie ni le code, ni le référentiel `docs/`, ni le schéma. C'est à cette session de juger si chaque point est **conforme à la planification initiale**, de le retenir, de l'adapter ou de l'écarter, et d'ouvrir les `AV-nnn` correspondants selon les règles du projet (CLAUDE.md §3 : classer CONFIRMÉ / DÉDUIT / À VALIDER, ne jamais combler un trou en silence, valeur par défaut paramétrable).

Rédigé le 20/10/2026 à partir de (1) douze choix du porteur, (2) la lecture du projet : `db/schema.sql`, `docs/A-VALIDER.md`, `docs/01-functional/domaines/D03` et `D09`, `docs/03-data/01-identifiants-et-conventions.md`, la PWA (`apps/pwa/src`), les contrats serveur, et (3) le classeur Excel `fiches-terrain/commercial/` (feuille `Correspondances`), lu comme **contexte** et non comme source de décision.

Fichiers de référence côté papier (dossier annexe `pieces-papier/`, non suivi par git) : `gabarits/*.html` et `charte/pieces.css` (mise en page exacte de chaque pièce), `pdf/*.pdf` (aperçus 1:1), `CORRESPONDANCE-APPLICATION.xlsx` (rubrique papier ↔ champ de commande, référentiels, seuils).

---

## 1. Le besoin en une page

1. **Imprimer depuis l'application** chaque opération (vente, encaissement, dépense, livraison, commande, réception…) **dans la mise en page des pièces papier** conçues pour GIC AGROPELC : mêmes rubriques, même charte (vert, orange doré, logo). À défaut de mise en page identique, la charte doit être respectée.
2. **Pièces papier de secours** : quand l'application est indisponible, l'opération s'écrit sur une pièce numérotée, puis se **reporte** dans l'application. Les informations importantes des pièces doivent pouvoir y entrer plus tard, y compris par import.
3. Le porteur ne demande **pas** que les pièces soient alignées sur l'application à tout prix : il demande que les informations utiles puissent être **intégrées plus tard**.

## 2. Choix du porteur (à traiter comme exigences à instruire)

| N° | Sujet | Choix du porteur |
|---|---|---|
| D1 | Impression | **Page complète sur papier blanc, depuis la PWA** (impression par le navigateur, utilisable hors ligne) ; numéro = numéro de l'application. |
| D2 | N° de la pièce papier | **Un champ « pièce papier » commun à toutes les opérations.** |
| D3 | Facture client | **Hors application pour l'instant.** |
| D4 | Journal de caisse | **Un journal par compte de trésorerie, imprimé par l'application** ; la feuille vierge reste le secours. |
| D5 | Commerciaux | **La même feuille de caisse**, case « caisse du commercial » ; plus de comptage par coupures. |
| D6 | Pointage | **Table « présence » simple**, alimentée chaque semaine à partir de la fiche PT. |
| D7 | Registre des carnets | **Registre papier + contrôle par les références saisies.** |
| D8 | Bilan hebdomadaire | **Nouvelle fiche papier (BH) + écran dans l'application.** |
| D9 | Veille marché | **Rubriques structurées** sur la fiche de visite et dans la visite. |
| D10 | Profil client | **Rubriques ajoutées** à la fiche de visite et au compte client. |
| D11 | Entrée des données | **Écran de report** pour le courant + **import par lots** pour l'historique. |
| D12 | Délai de report | **24 h conseillées, 72 h au maximum** (valeurs actuelles, paramétrables). |

## 3. Constats vérifiés dans le projet

| Constat | Source | Classe |
|---|---|---|
| Le reçu d'une vente est **déjà imprimable** depuis la PWA : bouton « imprimer » qui appelle `window.print()`, feuille `@media print` qui masque l'en-tête et les boutons. | `apps/pwa/src/features/sales/SaleDetailScreen.tsx:302`, `apps/pwa/src/app/app.css:1225`, `docs/10-development-plan/15-ecrans-pwa.md:78` (ECR-VEN-05 « Reçu imprimable ») | CONFIRMÉ |
| `local_ref varchar(20)` **existe déjà sur 13 tables** : `sales_sales`, `sales_sales_orders`, `sales_customer_payments`, `sales_delivery_notes`, `sales_sale_cancellations`, `procurement_purchase_requests`, `procurement_purchase_orders`, `procurement_goods_receipts`, `inventory_stock_transfers`, `inventory_loss_declarations`, `inventory_inventory_counts`, `finance_expenses`, `finance_cash_transfers`. Il **n'existe pas** sur `crm_visits`, `fieldwork_work_sessions`, `finance_cash_sessions`, les paiements et factures fournisseurs, ni sur les tables de pesée et de collecte d'œufs. | `db/schema.sql` | CONFIRMÉ |
| L'acceptation de `localRef` par la **commande** est vérifiée pour la vente, la commande, l'encaissement, la livraison, la réception, la demande d'achat et la dépense (qui signale un doublon `LOCAL_REF_DUPLICATE`). Pour les autres tables listées, la colonne existe, l'acceptation par la commande n'a pas été vérifiée. | `apps/server/src/modules/*/application/commands/*.ts` | CONFIRMÉ / À VÉRIFIER |
| Convention actuelle de `local_ref` : **référence d'appareil** `{CODE_APPAREIL}-{seq6}`, « reçu remis au client hors ligne » ; `doc_number` officiel attribué par le serveur `{TYPE}-{CODE_SITE}-{AAAA}-{seq6}`. | `docs/03-data/01-identifiants-et-conventions.md` §1.4 | CONFIRMÉ |
| Les mouvements d'un compte de trésorerie sont dans `finance_cash_movements` (sens, montant, type, document source, session, `occurred_at`) ; lecture `GET /cash-accounts/{id}/movements` existante. Une `CAISSE_UTILISATEUR` (caisse d'un commercial) n'a qu'un détenteur ; la **session de caisse** ne concerne que la caisse d'un PDV. | `db/schema.sql`, `apps/server/src/finance-api/finance-read.controller.ts`, D09 BR-FIN-002 et BR-FIN-010, glossaire « session de caisse » | CONFIRMÉ |
| Le compte client a déjà `credit_allowed`, `credit_limit_xaf`, `payment_terms_days`, `business_activity`, `category_id`. Il n'a **pas** de produit d'intérêt, de potentiel par jour, de mode de paiement habituel. `credit_allowed` est une **décision du responsable**, pas une demande. | `db/schema.sql` (`crm_customers`), feuille `Correspondances` de l'Excel | CONFIRMÉ |
| La visite a `notes`, `outcome_reason_code_id`, `next_action_*` ; **rien** sur le fournisseur ou le prix du concurrent. | `db/schema.sql` (`crm_visits`) | CONFIRMÉ |
| Les sessions de travail et `analytics.f_attendance` concernent **les commerciaux de terrain** (pointage géolocalisé). Aucune présence du personnel non commercial. ECR-TER-02 (présences de l'équipe) existe pour le responsable commercial. | D03, `docs/03-data/dictionnaire/12-analytics.md` | CONFIRMÉ |
| Le **bilan hebdomadaire** n'existe pas. L'Excel mappe seulement « réussites » sur `communication.internal_notes`, qui est la **note de direction** (de la direction vers une audience) : mauvais sens pour un bilan de commercial. | Feuille `Correspondances` ; glossaire « note de direction » | CONFIRMÉ |
| Une **reprise de données par modèles CSV** (clients, fournisseurs, produits, lots, inventaire d'ouverture) est déjà prévue : AV-072, ouvert, P1/P2. L'Excel porte une « clé d'import » (`Réf. de la ligne`) et la feuille `Correspondances`. | `docs/A-VALIDER.md` AV-072 ; `fiches-terrain/commercial/README.md` | CONFIRMÉ |
| **Pas de facture client** : prix TTC, reçu numérique simple, `tax_rate` et `tax_amount_xaf` à 0 (décision du porteur le 30/09/2026). | AV-041 | CONFIRMÉ |
| Saisie rétroactive : valeurs initiales `sync.justification_after_hours` = 24, `sync.backdate_max_hours` = 72 ; le point AV-078 est **ouvert** et la fenêtre **n'est pas encore appliquée à toutes les commandes** (prévu avant la production). | `db/seeds/system-settings.ts` ; `docs/A-VALIDER.md` (AV-078 et journal de MP-11) | CONFIRMÉ |

## 4. Propositions par sujet

Chaque sujet indique : le choix du porteur, la **conformité à l'existant** (Conforme / Extension / Nouveau), la proposition, les impacts, les questions pour la session.

### P-01 Impression des opérations (D1) — **Extension** du mécanisme existant

- **Proposition** : généraliser `window.print()` et la feuille `@media print` de ECR-VEN-05 à des composants « pièce imprimable » qui reproduisent les gabarits `pieces-papier/gabarits/*.html`, alimentés par les données **locales** de l'opération (IndexedDB), donc **utilisables hors ligne**. Format de page imposé par `@page` (A5 paysage, A4 portrait…). La **souche n'est pas imprimée** (elle n'a de sens que sur carnet) : le corps occupe la feuille.
- **Correspondance opération → gabarit** : vente → **BV** ; encaissement → **RE** ; dépense, paiement fournisseur, remboursement → **BD** ; remise de fonds → **RF** ; livraison → **BL** ; commande client → **CC** ; bon de commande fournisseur → **BC** ; réception → **BR** ; transfert → **BT** ; demande d'achat → **DA** ; perte ou consommation → **FP** ; inventaire → **FI** ; journal d'un compte → **FJC** ; journal des encaissements → **JE**. Priorité suggérée : BV, RE, BD, BL, CC, RF, BR, BT en premier.
- **Numéro imprimé** : `doc_number` s'il est connu, sinon `local_ref` (hors ligne). **Réimpression** : mention « DUPLICATA » et date de réimpression. Option : 2 exemplaires (client, comptabilité).
- **Opération annulée** : filigrane ou bandeau « ANNULÉE » (principe « rien ne disparaît »).
- **Pièges** : (1) les gabarits papier utilisent *Segoe UI* et *Bahnschrift* (polices Windows, **non redistribuables**, absentes des téléphones) : prévoir une police libre embarquée dans la PWA ; (2) `print-color-adjust: exact` et lisibilité en **noir et blanc** (imprimantes de bureau) ; (3) le logo doit être dans le pré-cache du service worker ; (4) le **montant en lettres** (reçus, bons de caisse) demande une fonction pure en français dans `packages/domain` (règle 6) ; (5) support de `@page size` sur iOS/Safari limité : prévoir un repli ; (6) données personnelles imprimées (nom, téléphone du client).
- **Conformité** : Extension (ECR-VEN-05 existe). Probablement un ADR « impression des pièces » ; des écrans de détail manquent peut-être pour certaines opérations (transfert, réception…).

### P-02 Numéro de la pièce papier (D2) — **Extension ou Nouveau, à arbitrer**

- **Choix du porteur** : un champ commun à toutes les opérations. **Correction d'une information donnée au porteur** : il lui avait été dit que le champ manquait pour le transfert, la perte, l'inventaire, la remise de fonds ; or **`local_ref` existe déjà sur ces tables** (§3). Les tables qui n'ont rien : visite, session de travail, session de caisse, paiement et facture fournisseur, pesée et collecte d'œufs.
- **Option A (la moins invasive)** : réutiliser `local_ref` pour le numéro imprimé du carnet (ex. `RE-000123`, 9 caractères sur 20), avec une convention de préfixe. Pas de migration sur les 13 tables ; cohérent avec §1.4 (« reçu remis au client hors ligne »). **Conflit sémantique à lever** : `local_ref` est aujourd'hui une référence **générée** `{CODE_APPAREIL}-{seq6}` ; le numéro de carnet est **saisi à la main**. Il faudrait distinguer les deux motifs ou accepter que `local_ref` porte l'une ou l'autre.
- **Option B (conforme au choix du porteur)** : colonne dédiée `paper_ref` (type de pièce + numéro) sur toutes les tables d'opération, y compris celles qui n'en ont pas, avec unicité par type de pièce et avertissement de doublon (jamais de rejet d'un fait accompli, BR-SYN-007).
- **À instruire par la session** : lequel des deux est le plus conforme à la planification ; effet sur les contrats de commande, le jeu hors ligne, l'envoi, les migrations (plage réservée de la session principale) ; contrôle de continuité (P-05) ; index.
- **AV à ouvrir** : « Référence de la pièce papier : champ dédié ou généralisation de `local_ref` ».

### P-03 Facture client (D3) — **Conforme** (aucun changement)

- La facture FA reste un **document hors application**, rapproché des ventes par le numéro de bon de vente ou de commande porté sur la facture. AV-041 reste en vigueur. Les colonnes de TVA restent à 0.
- **Rien à développer.** À noter pour plus tard : la facturation électronique annoncée par la loi de finances 2026 (voir `REGLEMENTATION.md`) pourrait rouvrir AV-041.

### P-04 Journal de caisse par compte, imprimé par l'application (D4, D5) — **Extension**

- **Proposition** : un état « journal d'un compte pour un jour métier » : lignes issues de `finance_cash_movements` triées par `occurred_at` ; pour chaque ligne : heure, **n° de la pièce** (`doc_number` ou `local_ref` du document source), **libellé** (client, bénéficiaire ou objet, par jointure sur le document source : encaissement, dépense, remise), **mode de paiement**, **ENTRÉE** ou **SORTIE** (sens du mouvement), session. Pied : totaux ; pour un compte en espèces, rapprochement (fonds d'ouverture compté, entrées et sorties en espèces, solde théorique, comptage, écart) avec les champs de `finance_cash_sessions` ; pour mobile money et banque, totaux par mode sans comptage.
- **Gabarit** : **FJC** (28 lignes, une opération par ligne, plus de comptage par coupures, case « caisse du PDV / du commercial / centrale »). **JE** (30 lignes, A4 portrait) correspond à l'état des encaissements par mode.
- **Caisse d'un commercial** : compte `CAISSE_UTILISATEUR`, **sans session** ; le comptage n'est pas imposé ; la remise de fonds correspond à `finance_cash_transfers` (RF).
- **Pagination** : plus de 28 lignes par jour est probable (le porteur parle de 25 à 40) : prévoir la suite sur une 2ᵉ feuille.
- **Conformité** : Extension en lecture seule (données et endpoint existants, ECR-FIN-05) ; pas de migration. Les données de la **trésorerie hors ligne** (jeu `cash`) sont partielles : préciser ce que l'état hors ligne peut montrer.

### P-05 Registre des carnets (D7) — **Extension**, dépend de P-02

- **Proposition** : le registre reste sur papier (pièce **RC**). L'application fournit un **contrôle de continuité** : par type de pièce et par site, numéros manquants et doublons, d'après les références saisies. Aucune table nouvelle. Alerte éventuelle (à coordonner avec P9).
- **Questions** : plage de numéros attendue par carnet (saisie ? import du registre ?) ; qui consulte ; fréquence.

### P-06 Table « présence » (D6) — **Nouveau**

- **Constat** : le pointage couvre seulement les commerciaux ; les ouvriers et le personnel administratif n'ont peut-être **pas de compte utilisateur**.
- **Proposition** : table légère de présence (jour, personne, site, arrivée, départ, code d'absence, source `PAPER`, lot d'import hebdomadaire) alimentée par import de la fiche **PT**. `user_id` facultatif + nom de la personne. Ne pas fusionner avec `fieldwork.work_sessions` ni compter deux fois les jours de présence (KPI-COM-17).
- **AV à ouvrir** : présence du personnel non commercial (qui, pour quel usage : paie, discipline, statistiques) ; données personnelles.

### P-07 Bilan hebdomadaire du commercial (D8) — **Nouveau**

- **Proposition** : entité « bilan hebdomadaire » (commercial, lundi de la semaine, réussites, difficultés, besoins et demandes à la direction, priorités, informations du marché, vu par le responsable, commentaire du responsable) + écran. Les **chiffres** (visites sur place, nouveaux prospects et clients, CA, encaissé, casses et pertes) sont **calculés** depuis les données existantes (principe du contexte métier : aucun indicateur saisi). Ne pas réutiliser `communication.internal_notes` (mauvais sens).
- **Papier** : fiche **BH** (A5 portrait).
- **Conformité** : Nouveau, proche de P9 (analytique) : à coordonner avec la session P9 (plages d'`AV`, d'ADR et de migrations réservées).

### P-08 Veille marché (D9) — **Nouveau**

- **Proposition** : table fille de la visite « observation de marché » (visite, fournisseur ou concurrent, produit, unité, prix constaté) plutôt que des colonnes sur la visite : plusieurs produits par visite. Rubriques correspondantes sur la fiche **VC**.
- **Intérêt** : comparer nos prix à ceux du marché (indicateur d'écart de prix) ; l'Excel collecte déjà cette information sans cible dans le schéma.
- **Conformité** : Nouveau (CRM P3 est clos) : migration, contrat de commande de visite, jeu hors ligne `crm_activity`.

### P-09 Profil commercial du client (D10) — **Nouveau**

- **Proposition** : colonnes sur `crm_customers` : produit d'intérêt, potentiel par jour (quantité + unité), mode de paiement habituel. **Ne pas écraser `credit_allowed`** : la demande de paiement différé du commercial est **distincte** de la décision du responsable (nouvelle information `credit_requested` ou équivalent).
- **Points d'attention** : la fusion « champ par champ avec version » des comptes modifiés sur deux appareils (`field_versions`) doit inclure ces champs ; matrice des conflits ; doublons de comptes.
- **Conformité** : Nouveau (CRM P3 clos).

### P-10 Entrée des données : écran de report et import par lots (D11)

- **Écran « Reporter une pièce papier »** — **Nouveau** : par type de pièce, champs **dans l'ordre de la pièce**, date et heure de la pièce proposées comme heure métier (`occurred_at`), numéro de la pièce (P-02), contrôle des doublons, photo de la pièce en pièce jointe (ADR-012, ADR-046), annulation par contre-écriture.
- **Import par lots** — **Conforme** à AV-072 (modèles CSV) **étendu** : fichiers Excel ou CSV avec fichier modèle, **zone d'attente et validation avant chargement**, clé d'import par ligne (l'Excel a déjà `Réf. de la ligne`), passage **par les commandes existantes** (règle 3 : aucune écriture directe en table), idempotence. L'Excel `fiches-terrain/commercial` est un **premier jeu de test** (feuilles Clients, Visites_Contacts, Commandes, Encaissements, Stock, Objectifs ; la feuille `Correspondances` donne les cibles).
- **Questions** : qui peut importer ; où séjournent les lignes en attente ; reprise sur erreur ; ce qu'on fait des colonnes « hors modèle » tant que P-08 et P-09 ne sont pas décidés.

### P-11 Délai de report (D12) — **Conforme**

- Garder `sync.justification_after_hours` = 24 et `sync.backdate_max_hours` = 72 (paramétrables). Une pièce plus ancienne passe par une validation du responsable. À traiter avec la fenêtre d'antidatage encore à appliquer (AV-078).

## 5. Séquencement proposé

| Lot | Contenu | Conformité | Dépendances |
|---|---|---|---|
| **PP-A** | P-01 impressions (BV, RE, BD, BL, CC, RF d'abord) puis P-04 journal de caisse | Extension de ECR-VEN-05 et de la trésorerie ; aucun schéma | police libre, fonction « montant en lettres » |
| **PP-B** | P-02 numéro de pièce, P-10 écran de report, P-05 contrôle de continuité | Extension (ou Nouveau selon P-02) | AV « référence de la pièce papier » |
| **PP-C** | P-10 import par lots | Conforme à AV-072 | PP-B, jeu de données GIC |
| **PP-D** | P-08 veille marché, P-09 profil client | Nouveau (CRM clos) | AV, migrations, jeu hors ligne |
| **PP-E** | P-06 présence, P-07 bilan hebdomadaire | Nouveau | AV, coordination avec la session P9 |

Respecter les plages réservées (migrations, AV, ADR) indiquées dans `CLAUDE.md` §1 pour la session principale et la session P9. Les numéros d'AV ne sont **pas** attribués ici.

## 6. Questions ouvertes pour la session et le porteur

1. P-02 : champ dédié ou généralisation de `local_ref` ?
2. P-01 : police libre à embarquer ? gabarits partagés avec le papier (une seule source HTML) ?
3. P-04 : que montre le journal hors ligne ? gestion de la suite sur plusieurs feuilles ?
4. P-06 : le personnel non commercial a-t-il un compte ? pour quel usage ?
5. P-08 et P-09 : champs structurés (choix du porteur) : validation du modèle de données par la session.
6. P-10 : fichier modèle d'import : format et gabarits à générer à partir de `Correspondances`.

## 7. Annexe : pièce, opération, table, `local_ref`

| Pièce | Opération | Table | `local_ref` | Acceptation par la commande |
|---|---|---|---|---|
| BV | vente | `sales_sales` | oui | vérifié |
| RE | encaissement | `sales_customer_payments` | oui | vérifié |
| BD | dépense | `finance_expenses` | oui | vérifié |
| BD | paiement fournisseur | `finance_supplier_payments` | **non** | — |
| RF | remise de fonds | `finance_cash_transfers` | oui | à vérifier |
| FJC | session de caisse | `finance_cash_sessions` | **non** | — |
| BL | livraison | `sales_delivery_notes` | oui | vérifié |
| CC | commande client | `sales_sales_orders` | oui | vérifié |
| DA | demande d'achat | `procurement_purchase_requests` | oui | vérifié |
| BC | bon de commande fournisseur | `procurement_purchase_orders` | oui | à vérifier |
| BR | réception | `procurement_goods_receipts` | oui | vérifié |
| BT | transfert | `inventory_stock_transfers` | oui | à vérifier |
| FP | perte | `inventory_loss_declarations` | oui | à vérifier |
| FI | inventaire | `inventory_inventory_counts` | oui | à vérifier |
| FL | saisie du jour d'un lot | mortalité : `inventory_loss_declarations` ; pesée, collecte d'œufs : tables de production | mortalité oui ; **non** pour pesée et collecte | à vérifier |
| VC | visite | `crm_visits` | **non** | — |
| PT | session de travail | `fieldwork_work_sessions` | **non** | — |
| BH | bilan hebdomadaire | (à créer) | — | — |
