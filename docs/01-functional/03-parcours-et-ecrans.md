# Parcours métier et inventaire des écrans

> Objectif : concevoir à partir des **journées réelles** et des **actions métier évidentes** (CM §49–§53, PM §20), et non à partir de formulaires CRUD.
> Ce document n'est **pas** une maquette. Il fixe les parcours, les actions principales et l'inventaire des écrans (`ECR-*`) utilisés dans la matrice de traçabilité.

---

## 1. Règles UX transverses

| # | Règle | Statut |
|---|---|---|
| UX-01 | L'écran d'accueil est **propre au rôle** et présente d'abord de gros boutons d'action (PRENDRE SERVICE, + PROSPECT, + VENTE…) puis 3 à 6 indicateurs personnels. Un utilisateur multi-rôles voit l'union des actions, regroupées par rôle. | C (CM §49) / D |
| UX-02 | Une action courante tient en **un écran**, avec au plus 5 champs obligatoires. Les valeurs sont préremplies depuis le contexte : utilisateur, appareil, site, heure, position, prix, lot FIFO. | C (CM §3, §49) / D |
| UX-03 | L'utilisateur ne choisit **jamais** un emplacement virtuel, un lot (sauf lot de production en saisie du jour), un type de mouvement ou une règle tarifaire : le moteur les déduit. | C (CM §3, §64) |
| UX-04 | Une **pastille de synchronisation** est toujours visible : vert = synchronisé, orange = « n opérations en attente », rouge = erreur ou conflit, gris = hors ligne depuis X h. | C (PM §29 « états utilisateur ») |
| UX-05 | Toute action hors ligne donne un **retour immédiat** (« Vente enregistrée sur ce téléphone, sera envoyée dès le retour du réseau »). | C (CM §36) |
| UX-06 | Les motifs sont choisis dans une liste courte (5 à 8 codes), avec un commentaire libre optionnel, obligatoire seulement si la politique l'exige. | D |
| UX-07 | La photo est demandée **seulement** quand la politique de contrôle l'exige, et la capture est intégrée au formulaire. | C (CM §24 « pas bureaucratiser ») |
| UX-08 | Les responsables disposent d'une **file de validation unique**, toutes opérations confondues (ECR-ADM-08). | C (CM §52) |
| UX-09 | Les montants s'affichent en francs CFA, séparateur des milliers espace, sans décimales (« 13 500 XAF »). | D |
| UX-10 | Interface en français ; libellés courts et verbes d'action. | AV-079 |
| UX-11 | Cible d'ergonomie : utilisable d'une main, zones tactiles ≥ 44 px, lisible en plein soleil (contraste AA minimum). | D (PM §36) |

## 2. Parcours types par rôle

### WF-J1 — Journée d'un commercial terrain (CM §50)

| Étape | Action utilisateur | Écran | Hors ligne | Effets moteur |
|---|---|---|---|---|
| 1 | Se connecter ou déverrouiller par PIN | ECR-ADM-02 | Oui (PIN local) | Contrôle de l'autonomie hors ligne (AV-009) |
| 2 | PRENDRE SERVICE | ECR-TER-01 | Oui | Tentative géolocalisée, contrôle de géorepère local, session de travail ouverte |
| 3 | Consulter ses objectifs et actions du jour | ECR-CRM-05 | Oui (dernier instantané) | — |
| 4 | Visiter des prospects : + VISITE | ECR-CRM-04 | Oui | Visite géolocalisée, rattachée à la session |
| 5 | Enregistrer un contact : + PROSPECT | ECR-CRM-02 | Oui | Compte client `PROSPECT`, acquéreur = titulaire = soi, contrôle de doublon local |
| 6 | + NOUVELLE COMMANDE | ECR-VEN-02 | Oui | Commande `CONFIRMED` à la synchronisation, réservation côté serveur |
| 7 | + NOUVELLE VENTE depuis son stock mobile | ECR-VEN-01 | Oui (dans la limite de son stock) | Vente, sortie de stock, encaissement ou créance, conversion en client |
| 8 | Consulter ses performances | ECR-CRM-05 | Oui (données locales + dernier instantané serveur) | — |
| 9 | Terminer sa journée : FIN DE SERVICE | ECR-TER-01 | Oui | Session fermée ; sinon clôture automatique à 23:59 |

### WF-J2 — Journée d'un vendeur de point de vente (DÉDUIT de CM §12, §13, §23)

| Étape | Action | Écran | Hors ligne | Effets moteur |
|---|---|---|---|---|
| 1 | Déverrouiller la tablette partagée avec son PIN | ECR-ADM-02 | Oui | Session utilisateur sur appareil partagé (AV-007) |
| 2 | OUVRIR LA CAISSE (comptage du fonds) | ECR-DIS-02 | Oui | Session de caisse ouverte |
| 3 | Consulter le stock du PDV et son allocation | ECR-DIS-01 | Oui | — |
| 4 | + NOUVELLE VENTE (répété) | ECR-VEN-01 | Oui, dans la limite de l'allocation (AV-025) | Vente, sortie de stock, consommation d'allocation, encaissement |
| 5 | RECEVOIR un transfert | ECR-STK-03 | Oui (si transfert déjà téléchargé) | Entrée en stock, écart éventuel |
| 6 | DÉCLARER UNE PERTE | ECR-STK-04 | Oui | Perte, photo et validation selon politique |
| 7 | DEMANDER UN RÉAPPROVISIONNEMENT | ECR-DIS-03 | Oui | Transfert `REQUESTED` |
| 8 | CLÔTURER LA CAISSE (comptage) | ECR-DIS-02 | Oui | Écart de caisse calculé, validation Finance |

### WF-J3 — Journée d'un magasinier (CM §51)

| Étape | Action | Écran | Hors ligne | Effets moteur |
|---|---|---|---|---|
| 1 | Consulter les alertes (stock faible, transferts à préparer, réceptions attendues) | ECR-NOT-01, ECR-ANA-03 | Oui (dernières alertes) | — |
| 2 | RÉCEPTIONNER (BC attendu) : livré, rejeté, accepté | ECR-APP-04 | Oui | Entrée en stock des quantités acceptées, reliquat, CMUP |
| 3 | TRANSFÉRER vers un PDV ou vers un commercial | ECR-STK-02 | Oui | Sortie vers `V_TRANSIT` ; notification au destinataire |
| 4 | DÉCLARER UNE PERTE | ECR-STK-04 | Oui | Perte |
| 5 | Contrôler les stocks | ECR-STK-01, ECR-STK-07 | Oui (soldes locaux du site) | — |
| 6 | INVENTORIER | ECR-STK-05 | Oui (comptage) ; validation en ligne | Ajustements |

### WF-J4 — Journée d'un responsable de ferme ou de production (DÉDUIT de CM §34.5, §49)

| Étape | Action | Écran | Hors ligne | Effets moteur |
|---|---|---|---|---|
| 1 | SAISIE DU JOUR par lot : mortalité, aliment consommé, pesée, observation | ECR-PRD-02 | Oui | Pertes `MORTALITE`, consommations imputées au lot, pesée |
| 2 | Collecte d'œufs (lots de pondeuses) | ECR-PRD-02 (bloc œufs) | Oui | Entrées en stock des œufs commercialisables et à couver |
| 3 | Étapes d'incubation (mise en incubateur, mirage, transfert, éclosion) | ECR-PRD-06 | Oui | Mouvements incubateur et éclosoir, poussins produits |
| 4 | SORTIE VERS COMMERCIALISATION | ECR-PRD-07 | Oui | Transfert bâtiment → magasin ou PDV |
| 5 | Valider les mortalités au-dessus du seuil (Resp. production) | ECR-ADM-08 | Non (validation en ligne) | Perte reconnue |
| 6 | Consulter la fiche lot (effectif, coût par tête, marge) | ECR-PRD-03 | Partiel | — |

### WF-J5 — Journée d'un responsable (commercial, magasin, production) (CM §52)

| Étape | Action | Écran |
|---|---|---|
| 1 | Consulter les KPI de son périmètre | ECR-ANA-02 / ECR-ANA-03 / ECR-ANA-04 |
| 2 | Identifier les anomalies et alertes | ECR-NOT-01 |
| 3 | Suivre les équipes (présences, activité) | ECR-TER-02 |
| 4 | Suivre les commandes | ECR-VEN-03 |
| 5 | Valider les opérations en attente | ECR-ADM-08 |
| 6 | Décider : réaffecter, réapprovisionner, publier une note | ECR-CRM-06, ECR-STK-02, ECR-NOT-03 |

### WF-J6 — Journée de la direction (CM §53)

| Étape | Action | Écran |
|---|---|---|
| 1 | Ouvrir la tour de contrôle : PRODUCTION, STOCK, DISTRIBUTION, VENTES, FINANCES, ÉQUIPES, ALERTES, **lisible en moins de 30 secondes** | ECR-ANA-01 |
| 2 | Descendre dans un indicateur jusqu'aux opérations sources (explication d'un écart) | ECR-ANA-06, ECR-STK-07 |
| 3 | Valider les opérations au-dessus des seuils | ECR-ADM-08 |
| 4 | Activer une règle tarifaire ; publier une note | ECR-PRX-02, ECR-NOT-03 |

### WF-J7 — Finance (CM §34.6)

Valider les sessions de caisse et leurs écarts (ECR-FIN-05) → suivre créances et retards (ECR-FIN-01) → enregistrer dépenses, factures et paiements fournisseurs (ECR-FIN-02 à 04) → analyser coûts et marges (ECR-FIN-06).

### WF-J8 — Achats (CM §27)

Instruire les demandes d'achat (ECR-APP-02) → émettre les bons de commande (ECR-APP-03) → suivre reliquats et rapprochements (ECR-APP-05).

## 3. Inventaire des écrans

Colonnes : identifiant | écran | rôles principaux | hors ligne (Oui / Partiel / Non) | phase de livraison.

### 3.1 Transverse et administration

| ID | Écran | Rôles | Hors ligne | Phase |
|---|---|---|---|---|
| ECR-ADM-01 | Connexion et enrôlement de l'appareil | Tous | Non | P0 |
| ECR-ADM-02 | Déverrouillage par PIN, changement d'utilisateur sur appareil partagé | Tous | Oui | P0 |
| ECR-ADM-03 | Accueil par rôle (actions du jour + indicateurs) | Tous | Oui | P0 (squelette), enrichi à chaque phase |
| ECR-ADM-04 | Utilisateurs et affectations de rôle | ADMIN | Non | P0 |
| ECR-ADM-05 | Appareils (approbation, blocage, déclaration de perte) | ADMIN, responsables | Non | P0 |
| ECR-ADM-06 | Organisation : sites, emplacements, zones, géorepères, équipes, PDV | ADMIN | Non | P0/P1 |
| ECR-ADM-07 | Paramètres et politiques de contrôle | ADMIN (Direction pour les seuils) | Non | P0/P2 |
| ECR-ADM-08 | File de validation unifiée | DIRECTION, responsables, FINANCE | Non | P2 |
| ECR-SYN-01 | État de synchronisation et opérations en attente | Tous | Oui | P0 |
| ECR-SYN-02 | Supervision de la synchronisation (appareils, retards, erreurs) | ADMIN, DIRECTION | Non | P0 |
| ECR-SYN-03 | Résolution des conflits | ADMIN, responsables | Non | P2 |
| ECR-NOT-01 | Centre d'alertes et de notifications | Tous | Oui (dernières) | P2, complété en P9 |
| ECR-NOT-02 | Notes de direction (lecture, accusé) | Tous | Oui | P9 |
| ECR-NOT-03 | Publication d'une note | DIRECTION | Non | P9 |
| ECR-AUD-01 | Journal d'audit (recherche) | DIRECTION, ADMIN, FINANCE | Non | P0 |

### 3.2 Catalogue et tarification

| ID | Écran | Rôles | Hors ligne | Phase |
|---|---|---|---|---|
| ECR-PRX-01 | Catalogue produits, unités, conditionnements | ADMIN | Non | P1 |
| ECR-PRX-02 | Règles tarifaires (brouillon, activation, historique) | RESP_COMMERCIAL, DIRECTION | Non | P1 |
| ECR-PRX-03 | Simulateur de prix (« quel prix pour ce contexte ? ») | RESP_COMMERCIAL, DIRECTION | Partiel | P1 |

### 3.3 Commercial

| ID | Écran | Rôles | Hors ligne | Phase |
|---|---|---|---|---|
| ECR-CRM-01 | Mon portefeuille (recherche, filtres, prochaines actions) | Commerciaux, RESP_COMMERCIAL | Oui | P3 |
| ECR-CRM-02 | + PROSPECT | Commerciaux, VENDEUR_PDV | Oui | P3 |
| ECR-CRM-03 | Fiche compte client (historique, visites, commandes, ventes, créance, lien Kommo) | Commerciaux, RESP_COMMERCIAL, FINANCE | Oui (périmètre) | P3 |
| ECR-CRM-04 | + VISITE | COMMERCIAL_TERRAIN | Oui | P3 |
| ECR-CRM-05 | Mes objectifs et performances | Commerciaux | Oui (instantané) | P3/P9 |
| ECR-CRM-06 | Réaffectation de clients | RESP_COMMERCIAL, DIRECTION | Non | P3 |
| ECR-CRM-07 | Gestion des objectifs | RESP_COMMERCIAL, DIRECTION | Non | P3 |
| ECR-TER-01 | PRENDRE SERVICE / FIN DE SERVICE | COMMERCIAL_TERRAIN | Oui | P3 |
| ECR-TER-02 | Présences et activité de l'équipe | RESP_COMMERCIAL | Non | P3 |

### 3.4 Ventes, distribution, points de vente

| ID | Écran | Rôles | Hors ligne | Phase |
|---|---|---|---|---|
| ECR-VEN-01 | + NOUVELLE VENTE (vente rapide, encaissement intégré) | VENDEUR_PDV, commerciaux, RESP_FERME | Oui | P4 |
| ECR-VEN-02 | + NOUVELLE COMMANDE | Commerciaux | Oui | P4 |
| ECR-VEN-03 | Commandes (à confirmer, à livrer, livrées) | Commerciaux, RESP_COMMERCIAL, MAGASINIER | Partiel | P4 |
| ECR-VEN-04 | LIVRER une commande | Commerciaux, MAGASINIER | Oui | P4 |
| ECR-VEN-05 | Détail d'une vente (reçu, annulation) | Vendeur, responsables | Oui | P4 |
| ECR-VEN-06 | ENCAISSER (règlement de créances d'un client) | Commerciaux, VENDEUR_PDV, FINANCE | Oui | P4 |
| ECR-DIS-01 | Accueil PDV : stock, allocation, ventes et caisse du jour | VENDEUR_PDV | Oui | P5 |
| ECR-DIS-02 | Ouverture et clôture de caisse | VENDEUR_PDV | Oui | P5 |
| ECR-DIS-03 | Demande de réapprovisionnement | VENDEUR_PDV | Oui | P5 |
| ECR-DIS-04 | Distribution par PDV : envoyé, vendu, restant, perdu, encaissé, besoin | DIRECTION, RESP_COMMERCIAL, MAGASINIER | Non | P5 |

### 3.5 Stock

| ID | Écran | Rôles | Hors ligne | Phase |
|---|---|---|---|---|
| ECR-STK-01 | Stock par emplacement (soldes, disponible, alloué, réservé) | MAGASINIER, VENDEUR_PDV, responsables | Oui (périmètre) | P2 |
| ECR-STK-02 | TRANSFÉRER (expédier), y compris affectation à un commercial | MAGASINIER, RESP_FERME | Oui | P2 |
| ECR-STK-03 | RECEVOIR un transfert | Destinataires | Oui | P2 |
| ECR-STK-04 | DÉCLARER UNE PERTE | Tous les détenteurs de stock | Oui | P2 |
| ECR-STK-05 | INVENTAIRE (comptage, validation des écarts) | MAGASINIER, VENDEUR_PDV, RESP_FERME | Comptage oui ; validation non | P2 |
| ECR-STK-06 | Allocations (accorder, libérer, révoquer) | MAGASINIER, responsable PDV | Non | P5 |
| ECR-STK-07 | Registre des mouvements et explication d'écart | Responsables, DIRECTION | Non | P2 |
| ECR-STK-08 | Consommation d'intrants hors lot | MAGASINIER, RESP_FERME | Oui | P2 |

### 3.6 Production

| ID | Écran | Rôles | Hors ligne | Phase |
|---|---|---|---|---|
| ECR-PRD-01 | Lots actifs (effectif, âge, alertes) | RESP_PRODUCTION, RESP_FERME | Oui | P6 |
| ECR-PRD-02 | SAISIE DU JOUR (mortalité, aliment, pesée, collecte d'œufs, observation) | RESP_FERME, (OPERATEUR_FERME) | Oui | P6 |
| ECR-PRD-03 | Fiche lot (effectif, mortalité, consommations, coûts, ventes, marge) | RESP_PRODUCTION, DIRECTION | Partiel | P6/P8 |
| ECR-PRD-04 | Nouveau lot / mise en place / entrée | RESP_PRODUCTION | Oui | P6 |
| ECR-PRD-06 | Incubation (lots, étapes, taux d'éclosion) | RESP_FERME, RESP_PRODUCTION | Oui | P6 |
| ECR-PRD-07 | SORTIE VERS COMMERCIALISATION | RESP_FERME | Oui | P6 |

Note : l'identifiant `ECR-PRD-05` n'est pas attribué. La collecte d'œufs fait partie de la saisie du jour (ECR-PRD-02).

### 3.7 Approvisionnement et finance

| ID | Écran | Rôles | Hors ligne | Phase |
|---|---|---|---|---|
| ECR-APP-01 | Fournisseurs | RESP_ACHATS | Non | P7 |
| ECR-APP-02 | Demande d'achat | Tous les demandeurs, RESP_ACHATS | Oui (création) | P7 |
| ECR-APP-03 | Bons de commande | RESP_ACHATS | Non | P7 |
| ECR-APP-04 | RÉCEPTIONNER | MAGASINIER, RESP_FERME | Oui | P7 |
| ECR-APP-05 | Rapprochement commande / réception / facture | RESP_ACHATS, FINANCE | Non | P8 |
| ECR-FIN-01 | Encaissements et créances (âge, retards) | FINANCE, RESP_COMMERCIAL | Non | P4/P8 |
| ECR-FIN-02 | + DÉPENSE | Tous les rôles autorisés | Oui | P8 |
| ECR-FIN-03 | Factures fournisseurs | FINANCE | Non | P8 |
| ECR-FIN-04 | Paiements fournisseurs | FINANCE | Non | P8 |
| ECR-FIN-05 | Trésorerie : comptes, remises de fonds, sessions de caisse à valider | FINANCE | Non | P5/P8 |
| ECR-FIN-06 | Coûts et marges (lot, produit, PDV, commercial) | FINANCE, DIRECTION | Non | P8 |

### 3.8 Pilotage et intégration

| ID | Écran | Rôles | Hors ligne | Phase |
|---|---|---|---|---|
| ECR-ANA-01 | Tour de contrôle Direction | DIRECTION | Partiel (dernier instantané) | P9 |
| ECR-ANA-02 | Tableau Responsable commercial | RESP_COMMERCIAL | Partiel | P9 |
| ECR-ANA-03 | Tableau Magasinier / stock | MAGASINIER | Partiel | P9 |
| ECR-ANA-04 | Tableau Production | RESP_PRODUCTION, RESP_FERME | Partiel | P9 |
| ECR-ANA-05 | Tableau Finance | FINANCE | Non | P9 |
| ECR-ANA-06 | Explorateur analytique (filtrer, trier, grouper, colonnes, agréger, exporter, vues sauvegardées) | Selon permissions | Non | P9 |
| ECR-KOM-01 | Paramétrage et supervision Kommo | ADMIN | Non | P10 |
