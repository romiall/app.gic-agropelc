# Exigences sources (REQ)

> Extraction **fidèle** des exigences explicites des sources, sans interprétation. Toutes ces exigences sont **CONFIRMÉES**.
> Chaque exigence est tracée jusqu'aux tests dans [`../10-development-plan/02-matrice-tracabilite.md`](../10-development-plan/02-matrice-tracabilite.md).
> Plages de numérotation : `REQ-001` à `REQ-199` = exigences métier du **CM** ; `REQ-201` et suivants = contraintes techniques imposées par le **PM**.

---

## 1. Exigences métier (Contexte métier)

### 1.1 Vision et principes

| ID | Exigence | Source | Domaines |
|---|---|---|---|
| REQ-001 | Un système **intégré** couvre la chaîne APPROVISIONNER → RECEVOIR → PRODUIRE → STOCKER → TRANSFÉRER → PROSPECTER → COMMANDER → VENDRE → LIVRER → ENCAISSER → ANALYSER ; ces opérations ne vivent pas dans des systèmes indépendants et leurs relations sont préservées. | CM §1, §4 | Tous |
| REQ-002 | Savoir avec fiabilité ce qui a été acheté, reçu, produit, stocké, transféré, vendu, perdu, encaissé et dépensé, et qui est responsable de chaque opération. | CM §2, §64 | Tous |
| REQ-003 | L'application est simple, rapide, adaptée au téléphone, utilisable par des profils non techniques, robuste en mauvaise connexion, rigoureuse dans l'enregistrement ; la complexité est portée par le système. | CM §3, §49 | UX |
| REQ-004 | Toute opération importante est analysable selon trois dimensions : physique, financière, responsabilité. | CM §5 | Tous |
| REQ-005 | La dimension responsabilité retrouve l'utilisateur, le rôle, le lieu, la date, l'heure, l'appareil, la personne ayant validé et l'état de synchronisation. | CM §2, §5.3 | AUD, SYN |

### 1.2 Organisation commerciale, prospection, attribution, performance

| ID | Exigence | Source | Domaines |
|---|---|---|---|
| REQ-006 | Le système fonctionne avec plusieurs commerciaux dès le départ et distingue commercial terrain, commercial sédentaire, vendeur de point de vente et responsable commercial. | CM §6 | CRM, ADM |
| REQ-007 | Un utilisateur peut cumuler plusieurs rôles. | CM §6, §47 | ADM |
| REQ-008 | Enregistrer les prospects : coordonnées, localisation, activité, type, source, commercial responsable. | CM §7 | CRM |
| REQ-009 | Enregistrer les visites et les interactions. | CM §7 | CRM |
| REQ-010 | Suivre l'évolution du prospect et sa conversion éventuelle en client ; enregistrer ses commandes. | CM §7 | CRM, VEN |
| REQ-011 | Mesurer l'effort commercial : prospects ajoutés par jour, visités par semaine, ayant commandé, devenus clients, CA des clients acquis par un commercial. | CM §7 | CRM, ANA |
| REQ-012 | Rattacher un client à un commercial (portefeuille) pour la responsabilité, le suivi, la performance, le CA, les objectifs et les commissions futures. | CM §8 | CRM |
| REQ-013 | Prendre en compte l'historique des réaffectations de clients. | CM §8 | CRM |
| REQ-014 | Répondre : quel commercial gère ce client, quels clients génèrent le plus de CA, quels sont les clients importants du commercial X, quel CA vient du portefeuille du commercial Y. | CM §8 | CRM, ANA |
| REQ-015 | Suivre la performance de chaque commercial sur une période quelconque : aujourd'hui, hier, cette semaine, ce mois, cette année, plage personnalisée. | CM §9 | ANA |
| REQ-016 | Indicateurs : prospects créés, prospects visités, contacts collectés, nouveaux clients, commandes, ventes, CA, quantité vendue, panier moyen, conversion, clients actifs et inactifs, réachat, performance par produit, par zone et par canal. | CM §9 ; PM §12 | ANA |
| REQ-017 | Les indicateurs sont calculés à partir des opérations enregistrées et jamais saisis manuellement. | CM §9 | ANA |

### 1.3 Pointage terrain

| ID | Exigence | Source | Domaines |
|---|---|---|---|
| REQ-018 | Le commercial terrain déclare sa prise de service : utilisateur, date, heure, zone déclarée, position, précision fournie par l'appareil, appareil. | CM §10 | TER |
| REQ-019 | Le système vérifie la compatibilité de la position avec la zone déclarée, avec une tolérance de quelques centaines de mètres (500 m envisagés initialement). | CM §10 | TER |
| REQ-020 | Une tentative de prise de service hors zone peut être conservée pour audit. | CM §10 ; PM §13 | TER, AUD |
| REQ-021 | Pas de géolocalisation permanente ; la localisation porte sur la prise de service, éventuellement la fin de service, la visite de prospect et les opérations terrain importantes. | CM §10, §56 ; PM §13 | TER, CRM |

### 1.4 Canaux, points de vente, ventes

| ID | Exigence | Source | Domaines |
|---|---|---|---|
| REQ-022 | Les ventes proviennent de plusieurs canaux (terrain, direct, point de vente, sédentaire, digital, WhatsApp, Kommo) ; le système en permet l'analyse. | CM §11 | VEN, ANA |
| REQ-023 | Plusieurs points de vente, chacun unité opérationnelle identifiable pouvant disposer d'un stock, de vendeurs, de prix, d'une caisse, de ventes, de pertes, de transferts et d'inventaires. | CM §12 ; PM §14 | DIS |
| REQ-024 | La direction sait presque immédiatement, par point de vente, ce qui a été envoyé, vendu, ce qui reste, ce qui a été perdu, encaissé, et s'il faut réapprovisionner. | CM §2, §12 | DIS, ANA |
| REQ-025 | Une vente est enregistrée et associable, selon le contexte, à un vendeur, un commercial, un client, un point de vente, un produit, une quantité, un prix, une date, un paiement et éventuellement un lot d'origine. | CM §13 | VEN |
| REQ-026 | Une vente diminue le stock concerné, augmente le CA, crée ou met à jour une créance éventuelle, est rattachée au commercial et au client, et est prise en compte dans les tableaux de bord. | CM §13, §32 | VEN, STK, FIN |

### 1.5 Production

| ID | Exigence | Source | Domaines |
|---|---|---|---|
| REQ-027 | Les réalités de production (poulets, œufs, incubation, porcs) ne sont pas artificiellement confondues. | CM §14 ; PM §10 | PRD |
| REQ-028 | Production avicole organisée en lots (campagnes) : quantité initiale, date de démarrage, bâtiment, fournisseur, souche, mortalités, effectif restant, alimentation, poids, coûts, transferts, sortie vers commercialisation. | CM §15 | VOL |
| REQ-029 | La quantité disponible d'un lot n'est jamais modifiée arbitrairement ; elle évolue selon les événements enregistrés. | CM §15 | VOL, STK |
| REQ-030 | La mortalité est traçable et agit sur le stock biologique, la quantité future commercialisable, la performance et le coût du lot ; elle génère une perte économique ; preuve ou validation selon l'importance. | CM §16 | PRD, STK, FIN |
| REQ-031 | La production d'œufs distingue collectés, cassés, non conformes, commercialisables et destinés à l'incubation ; le stock d'œufs commercialisables résulte de ces événements. | CM §17 | OEU |
| REQ-032 | D'autres classifications d'œufs peuvent être ajoutées. | CM §17 | OEU |
| REQ-033 | L'incubation couvre constitution du lot d'œufs, entrée en incubateur, quantité incubée, mirage, œufs infertiles, mortalité embryonnaire, transfert vers éclosoir, poussins obtenus, pertes et taux d'éclosion ; les œufs engagés sont reliés au résultat obtenu. | CM §18 | INC |
| REQ-034 | La production porcine est suivie par groupe ou lot : entrée, case ou bâtiment, effectif, alimentation, poids, mortalité, transfert, vente. | CM §19 | POR |
| REQ-035 | L'identification individuelle des animaux est une évolution future, non imposée au MVP. | CM §19 ; PM §10 | POR, VOL |

### 1.6 Stocks

| ID | Exigence | Source | Domaines |
|---|---|---|---|
| REQ-036 | Le stock distingue stock biologique, production commercialisable, stock commercial (affecté à un magasin, un point de vente, un vendeur, une zone de distribution) et intrants. | CM §20 | STK |
| REQ-037 | Le stock est traçable : toute variation a une cause (vente, perte, mortalité, transfert, consommation, inventaire, casse) et l'historique permet de reconstruire les variations. | CM §21 ; PM §6 | STK |
| REQ-038 | Répondre : quel stock, où, depuis quand, de quel lot ou opération il provient, quelle quantité est disponible, quelle quantité est affectée à un commercial ou un point de vente. | CM §2 | STK |
| REQ-039 | Les transferts entre emplacements (ferme → magasin, magasin → point de vente, ferme → point de vente, magasin → commercial, point de vente → point de vente, retour vers magasin) indiquent ce qui est parti, quand, par qui, ce qui est reçu, par qui, et les différences. | CM §22 | STK, DIS |
| REQ-040 | Un vendeur ou commercial peut recevoir une quantité de marchandises dont il est responsable jusqu'à ce qu'elle soit vendue, retournée, transférée, déclarée perdue ou régularisée par inventaire. | CM §23 | STK, DIS |
| REQ-041 | Une perte est documentée : nature, produit, quantité, lieu, date, utilisateur, motif, commentaire, lot si pertinent. Natures : mortalité, casse d'œufs, détérioration, produit impropre, destruction, perte inexpliquée, vol suspecté, erreur d'inventaire. | CM §24 | STK |
| REQ-042 | Selon la nature ou le niveau de la perte, le système peut exiger une photo, une validation ou une justification renforcée, proportionnées au risque. | CM §24, §42 | STK, ADM |
| REQ-043 | L'inventaire compare stock théorique et stock physique ; l'écart est visible, expliqué et génère une opération de régularisation traçable. | CM §25, §60 | STK |

### 1.7 Approvisionnement

| ID | Exigence | Source | Domaines |
|---|---|---|---|
| REQ-044 | Suivre, par fournisseur, ce qui a été commandé, à quel prix, ce qui a été reçu, les écarts, les documents, les montants facturés et payés. | CM §26 | APP, FIN |
| REQ-045 | Le processus d'achat distingue les événements Besoin → Demande d'achat → Validation → Commande fournisseur → Réception → Facture → Paiement. | CM §27 ; PM §11 | APP, FIN |
| REQ-046 | Commandé ≠ livré ≠ reçu ≠ accepté ≠ facturé ≠ payé. | CM §27 | APP, FIN |
| REQ-047 | Le magasinier confirme la réception réelle (livré, rejeté, accepté) ; le stock n'augmente que de la quantité acceptée ; la réception est traçable (fournisseur, commande, produit, quantité, date, magasinier, justificatif, observations, lot fournisseur). | CM §28 | APP, STK |

### 1.8 Tarification

| ID | Exigence | Source | Domaines |
|---|---|---|---|
| REQ-048 | Les prix peuvent varier selon la ville, le marché, le quartier, le point de vente, la saison, le type de client, la quantité achetée, la période commerciale. | CM §29 ; PM §9 | PRX |
| REQ-049 | Les personnes autorisées modifient les tarifs ; les vendeurs accèdent au bon prix sans réunion, appel ou note ; le nouveau prix s'applique automatiquement à sa date d'effet. | CM §29, §43 | PRX |
| REQ-050 | Un changement de prix ne réécrit jamais les transactions passées ; chaque transaction conserve le prix appliqué, pourquoi, quand et selon quelle règle. | CM §30 ; PM §7, §9 | PRX, VEN |

### 1.9 Finance

| ID | Exigence | Source | Domaines |
|---|---|---|---|
| REQ-051 | Comptabilité opérationnelle fiable : ventes, CA, encaissements, créances, dépenses, achats, fournisseurs, paiements, caisses, pertes, coût des stocks, marges. Pas de logiciel comptable réglementaire complet à court terme. | CM §31, §56 ; PM §15 | FIN |
| REQ-052 | Stock et finance sont reliés : une vente a une valeur, un encaissement ou une créance ; une perte a une valeur connue ; un achat crée une dépense ou dette fournisseur et la réception augmente le stock ; rapprochement possible. | CM §32 | FIN, STK |
| REQ-053 | Analyser la rentabilité d'une campagne ou d'un lot : quantité initiale, mortalités, quantité vendue et restante, intrants consommés, coûts, pertes, CA, marge. | CM §33 | PRD, FIN, ANA |

### 1.10 Pilotage et analyse

| ID | Exigence | Source | Domaines |
|---|---|---|---|
| REQ-054 | Tableau de bord Direction (« tour de contrôle ») : production, stock, ventes, encaissements, dépenses, créances, pertes, performances commerciales, alertes ; vue sur production, stock, distribution, ventes, finances, équipes, alertes. | CM §34.1, §53 | ANA |
| REQ-055 | Tableau de bord Responsable commercial : ventes, prospects, visites, clients, objectifs, performances individuelles et par zone, clients inactifs, tendances. | CM §34.2 | ANA |
| REQ-056 | Tableau de bord Commercial : ses objectifs, prospects, clients, visites, commandes, ventes, performances, actions à réaliser. | CM §34.3 | ANA |
| REQ-057 | Tableau de bord Magasinier : réceptions, sorties, transferts, stock, alertes, pertes, inventaires. | CM §34.4 | ANA |
| REQ-058 | Tableau de bord Production : lots, effectifs, mortalités, production, alimentation, œufs, incubation, disponibilité. | CM §34.5 | ANA |
| REQ-059 | Tableau de bord Finance : ventes, paiements, créances, dépenses, fournisseurs, caisse, coûts, marges. | CM §34.6 | ANA |
| REQ-060 | Les vues analytiques permettent filtre, tri, regroupement, sélection de colonnes, agrégation, export. | CM §35 ; PM §19 | ANA |
| REQ-061 | Un appareil connecté remonte ses données rapidement ; un appareil hors connexion enregistre localement et ses données deviennent visibles après synchronisation automatique au retour du réseau. | CM §36 | SYN |

### 1.11 Hors connexion

| ID | Exigence | Source | Domaines |
|---|---|---|---|
| REQ-062 | L'absence de connexion n'empêche pas l'enregistrement d'une vente, d'un prospect, d'une visite, de certaines pertes et opérations de terrain, ni la consultation des informations essentielles déjà synchronisées ; offline-first dès le départ. | CM §37 | SYN, tous |
| REQ-063 | Une opération hors connexion conserve son heure réelle ; le système distingue moment réel, création technique, réception serveur et synchronisation. | CM §38 ; PM §5 | SYN, AUD |
| REQ-064 | Le risque de survente hors ligne est réduit par l'affectation explicite de quantités à un point de vente, un commercial, un vendeur ou un magasin. | CM §39 ; PM §6 | STK, SYN |

### 1.12 Traçabilité, corrections, justificatifs, communication

| ID | Exigence | Source | Domaines |
|---|---|---|---|
| REQ-065 | Pour les opérations sensibles : quoi, qui, quand, où, avec quel appareil, ancienne et nouvelle information, hors connexion ou non, qui a validé ; une opération importante ne disparaît jamais silencieusement. | CM §40 ; PM §18 | AUD |
| REQ-066 | La correction d'une vente, d'un paiement, d'une réception, d'un mouvement de stock ou d'une perte passe par correction, annulation, contre-opération ou ajustement, et non par suppression. | CM §41 ; PM §8 | Tous |
| REQ-067 | Pièces justificatives (photo, facture, reçu, bon de livraison, document fournisseur) pour certaines opérations, proportionnées au risque. | CM §42 | ADM |
| REQ-068 | La direction transmet des notes internes (prix, instruction, procédure, information) ; une note ne remplace pas une règle automatisable. | CM §43 | NOT |

### 1.13 Kommo

| ID | Exigence | Source | Domaines |
|---|---|---|---|
| REQ-069 | Kommo garde la responsabilité des leads digitaux, conversations, WhatsApp, pipeline relationnel, relances et automatisations ; GIC complète Kommo sans le copier. | CM §44 ; PM §16 | KOM |
| REQ-070 | GIC est la source métier des clients opérationnels, produits, commandes, ventes, stock, production, prix, paiements, achats, fournisseurs, performances commerciales et du pilotage. | CM §45 ; PM §16 | KOM |
| REQ-071 | GIC et Kommo échangent des informations ; parcours digital lead → qualification → attribution → conversion → commande → vente → paiement → historique ; enrichissement du profil relationnel (statut, nombre de commandes, CA cumulé). | CM §45, §46 | KOM |

### 1.14 Rôles, droits, UX

| ID | Exigence | Source | Domaines |
|---|---|---|---|
| REQ-072 | Rôles minimum : Direction, Administrateur, Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable production, Responsable ferme, Magasinier, Responsable achats, Comptabilité/Finance. | CM §47 ; PM §17 | ADM |
| REQ-073 | Les accès sont restreints : un commercial terrain travaille sur ses prospects, clients, visites, commandes et performances ; un responsable commercial voit son équipe ; un magasinier accède au stock sans nécessairement accéder aux finances ; la direction a une vue globale. | CM §48 | ADM |
| REQ-074 | L'interface privilégie des actions métier évidentes (PRENDRE SERVICE, + AJOUTER PROSPECT, + ENREGISTRER VISITE, + NOUVELLE COMMANDE, + NOUVELLE VENTE, RÉCEPTIONNER, TRANSFÉRER, DÉCLARER UNE PERTE, SAISIE DU JOUR) et les journées réelles des utilisateurs plutôt que des formulaires CRUD. | CM §49–§52 ; PM §20 | UX |
| REQ-075 | La direction comprend la situation générale en quelques dizaines de secondes. | CM §53 | ANA |
| REQ-076 | Un responsable consulte les KPI, identifie les anomalies, suit équipes et commandes, voit les alertes et valide des opérations sans naviguer dans des dizaines d'écrans. | CM §52 | ANA, ADM |

### 1.15 Alertes, évolutivité, MVP, cohérence

| ID | Exigence | Source | Domaines |
|---|---|---|---|
| REQ-077 | Alertes actionnables : stock faible, rupture, perte anormalement élevée, mortalité élevée, réception incomplète, écart d'inventaire, créance en retard, anomalie de caisse, erreur de synchronisation, commercial sans activité, point de vente à réapprovisionner. | CM §54 | NOT |
| REQ-078 | Le système supporte la croissance du nombre d'utilisateurs, sites, points de vente, produits, fournisseurs, lots et transactions. | CM §55 | Tous |
| REQ-079 | Hors MVP : géolocalisation permanente, IA prédictive, IoT, capteurs, optimisation des tournées, paie, RH exhaustive, maintenance industrielle, comptabilité réglementaire complète. | CM §56 | Périmètre |
| REQ-080 | Le MVP fournit une base fiable pour Core (utilisateurs, rôles, sites, zones, appareils, audit, synchronisation), Commercial (prospects, clients, visites, pointage, commandes, objectifs), Distribution (produits, mouvements, stock, transferts, points de vente, ventes, pertes, inventaires), Production (lots, bâtiments, animaux, mortalité, œufs, incubation, porcs), Approvisionnement (fournisseurs, demandes, commandes, réceptions, intrants), Finance (encaissements, créances, dépenses, caisse, coûts, marges), Pilotage (tableaux de bord, analytics, exports, notifications, audit) ; Kommo en intégration transversale. | CM §57 | Plan |
| REQ-081 | Le système raconte la même histoire à travers les dimensions : Lot → production → disponibilité → transfert → point de vente → vente → client → commercial → paiement → CA → marge ; ou Lot → mortalité/perte → motif → quantité → coût. | CM §58 | Tous |
| REQ-082 | Chaque donnée importante a un propriétaire officiel unique (identité client, stock, prix, commande, statut commercial, paiement, conversation WhatsApp) ; aucune vérité contradictoire. | CM §59 | KOM, tous |
| REQ-083 | Les données sont fiables, explicables, traçables, cohérentes, exploitables ; lorsque deux chiffres diffèrent, le système permet de comprendre pourquoi. | CM §60 | Tous |
| REQ-084 | Le système répond de façon fiable aux questions de réussite du CM §62 (poulets disponibles à Douala, ventes de la semaine, commercial générateur, clients ayant commandé, encaissé réel, pertes, coût de production, quantité envoyée à un point de vente, cause d'un écart de 5 unités). | CM §62 | Tous |

---

## 2. Contraintes techniques imposées par le Prompt maître

| ID | Contrainte | Source |
|---|---|---|
| REQ-201 | Application web/mobile de type **PWA**, qui continue de fonctionner sans réseau ; l'offline influence données, identifiants, API, transactions, audit, conflits, stocks, horodatage, synchronisation, UX, appareils. | PM §5 |
| REQ-202 | Les opérations locales conservent au minimum `uuid`, `device_id`, `user_id`, `occurred_at`, `created_at`, `updated_at`, un statut de synchronisation et une version (ou équivalent). | PM §5 |
| REQ-203 | États de synchronisation minimum : `LOCAL_ONLY`, `PENDING_SYNC`, `SYNCING`, `SYNCED`, `CONFLICT`, `REJECTED` (nomenclature améliorable). | PM §5 |
| REQ-204 | Stock disponible = somme des mouvements validés applicables ; un inventaire génère un ajustement ; un mécanisme d'allocation ou de réservation empêche la double consommation offline ; le stock négatif volontaire n'est pas un mécanisme normal. | PM §6 |
| REQ-205 | Déterminer les données historisées, versionnées, figées (snapshot) dans les transactions ou référencées dynamiquement. | PM §7 |
| REQ-206 | Pas de suppression physique des opérations sensibles ; politique de soft delete ou d'annulation/contre-écriture définie table par table. | PM §8 |
| REQ-207 | Plusieurs règles tarifaires simultanées avec priorité, spécificité, période de validité, historisation, mécanisme d'application et gestion des conflits ; chaque ligne de vente permet de reconstruire le prix appliqué. | PM §9 |
| REQ-208 | RBAC avec `users`, `roles`, `permissions`, `user_roles`, `role_permissions` et restrictions contextuelles par site ou zone ; niveaux Own, Team, Site, Zone, All, Approve, Read Only. | PM §17, §31 |
| REQ-209 | Journal d'audit : utilisateur, action, entité, identifiant, ancienne et nouvelle valeur, date réelle, date serveur, appareil, online/offline, IP, synchronisation, validation, raison ; informations immuables définies. | PM §18 |
| REQ-210 | Intégration Kommo bidirectionnelle par API et webhooks : entités synchronisées, sources de vérité, identifiants externes, événements entrants et sortants, anti-boucle, idempotence, retry, erreurs. | PM §16 |
| REQ-211 | Compatibilité avec des appareils Android modestes et une bande passante réduite. | PM §36 |
| REQ-212 | L'interface cliente n'est jamais une autorité de confiance ; tout est contrôlé côté serveur. | PM §37 |
| REQ-213 | Base relationnelle considérée comme option naturelle, choix justifié ; pas de NoSQL pour simplifier le frontend. | PM §47 |
| REQ-214 | Pas de microservices par principe ; simplicité opérationnelle sans sacrifier les frontières fonctionnelles. | PM §34 |
| REQ-215 | Pas de génération de l'application avant stabilisation du cadrage. | PM §51 |
