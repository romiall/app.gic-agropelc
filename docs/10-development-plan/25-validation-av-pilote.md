# Validation des décisions qui conditionnent le pilote (RP-7a)

> Document à remplir par le porteur. Écrit le 02/11/2026 à partir de [`A-VALIDER.md`](../A-VALIDER.md) (registre central) et de l'état du code relu le même jour. Il couvre les 24 points que le plan de reprise ([`reprise/prompt-reprise-reste-a-faire.md`](../../reprise/prompt-reprise-reste-a-faire.md), lot RP-7a) range parmi les décisions du pilote : AV-001, AV-002, AV-072, AV-075, AV-084, AV-296, AV-297, AV-320, AV-485, AV-473 à AV-484 et AV-486 à AV-488. Les autres points ouverts gardent leur défaut paramétrable ; aucun n'est bloquant.

## Comment répondre

1. Colonne « Décision » : écrivez **OK** pour retenir la recommandation (qui est, sauf mention contraire, le défaut déjà en place) ; sinon, l'alternative en une phrase.
2. Les tableaux « À renseigner » (§ 1.2 à 1.5) attendent des informations de GIC, pas un choix.
3. Ensuite, je consigne chaque décision au journal de `A-VALIDER.md` § 3, je passe le point à TRANCHÉ et, quand un défaut change, je lance le lot de code correspondant (§ 5).
4. Classement des affirmations : **CONFIRMÉ** (relu dans le code ou dans un document le 02/11/2026), **DÉDUIT** (conséquence argumentée), **À VALIDER** (votre décision).

## Vue d'ensemble : quoi décider, et pour quand

Échéances DÉDUITES du plan de mise en production ([`01-plan-developpement.md`](01-plan-developpement.md) § 3).

| Points | À trancher avant | Nature |
|---|---|---|
| AV-001, AV-002, AV-072, AV-075, AV-084 | le début de RP-2 (reprise des données) | cadrage et données de GIC |
| AV-296, AV-297 | le déploiement du pilote (AV-297 : un défaut suffit au pilote) | sécurité de la connexion |
| AV-485 | le pilote | base de données de l'hébergement |
| AV-320 | R2 (écart de prix à la vente) et R3 (rejet à la réception) | motifs de départ |
| AV-473 à AV-484 | R4 (tableaux de la Direction) : rien d'urgent | définitions d'indicateurs et d'alerte |
| AV-486 à AV-488 | aucune échéance | confort d'écran |

## 1. Cadrage du pilote et données de départ

### 1.1 Décisions

| AV | Question | Défaut déjà en place = recommandation | Décision |
|---|---|---|---|
| AV-001 | Mise en service d'un bloc, ou par tranches avec un site pilote ? | Par tranches. R1 : magasin central, un point de vente, deux commerciaux (phases P0 à P3). R2 : même pilote, puis tous les points de vente de Douala (P4, P5). R3 : une ferme, puis toutes (P6, P7). R4 : Direction et Finance (P8, P9). R5 : Kommo, reportée. Premier pilote visé : R1 et R2. Chaque release est précédée d'une reprise de données et d'une formation courte. | ☐ OK |
| AV-075 | Quel parc d'appareils vise-t-on ? | Android 8 ou plus, Chrome 100 ou plus, 2 Go de RAM, 1 Go de stockage libre. CONFIRMÉ : la PWA est compilée pour `es2022` ; aucune vérification de version, de mémoire ou de stockage n'est faite à l'exécution. La liste réelle des appareils du pilote est à relever (§ 1.4). | ☐ OK |
| AV-084 | Quelle équipe et quel budget pour développer et exploiter ? | Petite équipe (1 à 3 développeurs), services managés, aucun composant qui exige une équipe d'exploitation dédiée. Déjà en place : kit de mise en ligne scripté ([`deploy/hostinger/`](../../deploy/hostinger/README.md)) avec sauvegarde de la base avant chaque livraison et retour arrière automatique ; alerte `JOB_FAILED` pour l'Admin. Qui fait quoi : § 1.5. | ☐ OK |
| AV-002 | Quels sites, magasins, points de vente et bâtiments existent ? | Aucun choix : ce sont des données (§ 1.2). Recommandation : un site peut porter plusieurs types d'emplacements (une ferme peut avoir un magasin d'intrants et un stock commercial). D'après le journal de la reprise du 01/11/2026, la base en ligne compte 24 zones (Douala et 23 quartiers) et aucun site ; cet état n'a pas été relu en production. | ☐ OK + § 1.2 rempli |
| AV-072 | Comment reprendre les données existantes ? | Modèles CSV d'import (clients, fournisseurs, produits, lots en cours) ; le stock de départ entre par un inventaire d'ouverture (`OPENING`), tracé comme n'importe quel mouvement. Déjà fait : la reprise du reporting commercial (outil dédié, AV-489). À construire : RP-2, outil général avec essai à blanc, passant par les commandes existantes. | ☐ OK + § 1.3 rempli |

Date visée pour le début du pilote R1 (facultatif) : ____________

### 1.2 À renseigner : les sites (AV-002)

Types de site : `FERME`, `MAGASIN`, `POINT_DE_VENTE`, `BUREAU`. Emplacements que l'écran Organisation sait créer : magasin (`STORE`), point de vente (`POS`), bâtiment (`BUILDING`), enclos (`PEN`, dans un bâtiment), incubateur (`INCUBATOR`), éclosoir (`HATCHER`), mobile (`MOBILE` : véhicule ou commercial, confié à une personne). Chaque site appartient à une zone ; un point de vente a un emplacement de vente et, s'il est réapprovisionné, un magasin source situé sur un autre site.

| Site (nom) | Type | Zone ou quartier | Adresse ou repère | Emplacements à créer | Release |
|---|---|---|---|---|---|
| Magasin central | MAGASIN | | | magasin | R1 |
| Point de vente n° 1 | POINT_DE_VENTE | | | emplacement de vente, magasin source | R1, R2 |
| Ferme | FERME | | | bâtiments, enclos, incubateur, éclosoir | R3 |
| | | | | | |

### 1.3 À renseigner : les données à charger (AV-072, entrée de RP-2)

| Donnée | Release proposée | Source ou fournisseur | Format | Prête le |
|---|---|---|---|---|
| Organisation : sites, zones, équipes | R1 | saisie par l'écran Organisation (RP-1), pas de reprise | écran | |
| Comptes utilisateurs : nom, téléphone, rôle, site | R1 | saisie par l'écran Comptes | écran | |
| Catalogue : produits, unités, conditionnements, catégories | R1 | GIC | Excel ou CSV | |
| Stock d'ouverture : quantité par produit et par emplacement, à une date d'arrêt | R1 | inventaire physique du magasin central | | |
| Règles de prix : produit, canal, zone | R2 | GIC | Excel ou CSV | |
| Clients et prospects | R2 | classeurs `BASE_CLIENTS_ET_PARTENAIRES_AFRIQUE_CENTRALE*.xlsx` (trois versions à la racine du dépôt) ; le reporting commercial est déjà chargé en ligne | Excel | |
| Fournisseurs | R3 | GIC | | |
| Lots biologiques en cours | R3 | GIC | | |

Date d'arrêt du stock d'ouverture : ____________

### 1.4 À renseigner : les appareils du pilote (AV-075)

Un appareil partagé (tablette d'un point de vente) est déclaré « partagé » par l'Admin ; un appareil personnel ne l'est pas (voir AV-296, § 2).

| Appareil (marque, modèle) | Android | Chrome | RAM | Utilisateur ou rôle | Site | Partagé ? |
|---|---|---|---|---|---|---|
| | | | | | | |
| | | | | | | |
| | | | | | | |
| | | | | | | |

### 1.5 À renseigner : l'exploitation (AV-084)

| Tâche | Personne | Remplaçant |
|---|---|---|
| Mises en ligne (`deploy.ps1`) | | |
| Approbation des appareils (écran Appareils) | | |
| Lecture des journaux du serveur et réponse à l'alerte `JOB_FAILED` | | |
| Sauvegardes de la base entre deux livraisons (le kit n'en fait qu'une avant chaque livraison ; une sauvegarde planifiée chez l'hébergeur reste À VALIDER) | | |
| Assistance et formation des utilisateurs du pilote | | |

Budget mensuel d'hébergement accepté : ____________

## 2. Sécurité et exploitation

| AV | Question | Défaut déjà en place | Recommandation | Si vous changez le défaut | Décision |
|---|---|---|---|---|---|
| AV-296 | Un compte peut-il se connecter sur un appareil non partagé connecté d'abord par un autre, et prendre son statut `ACTIVE` ? | (a) Oui. CONFIRMÉ : `findOrEnrollDevice` retrouve l'appareil par son identifiant et rend son statut sans comparer qui se connecte. Le compte ne gagne aucun droit (le RBAC reste le sien), mais il contourne la règle « nul n'approuve l'appareil qu'il a connecté » (AV-258). | (b) avant le pilote : un appareil non partagé reste lié à celui qui l'a connecté ; un autre compte obtient une demande d'enrôlement distincte, en attente ; l'Admin le déclare « partagé » si le téléphone change de main. (c) clé d'appareil avant la production. | (b) : lot de code (connexion, PWA, essais) ; réaffecter un téléphone passe par la désignation « partagé » ou un retrait puis un nouvel enrôlement. | ☐ (b) ☐ (a) ☐ autre : |
| AV-297 | Comment garantir le blocage de connexion quand des essais arrivent en même temps, et compter la vraie adresse de l'appareil derrière un proxy ? | (b) `TRUST_PROXY` (variable du serveur, désactivée par défaut) et limitation de débit au proxy. CONFIRMÉ : la variable existe et figure dans le `.env` du serveur en ligne d'après le kit ; sa valeur n'a pas été relue (production non consultée). Non fait : la réservation atomique de l'essai (le blocage est lu avant la vérification du mot de passe, l'échec compté après ; cinq essais, blocage de 1, 5 puis 15 minutes). | (b) suffit au pilote, chaque essai réussi payant une vérification `argon2` ; (a) avant la production. | (a) maintenant : petit lot de code (`login-lockout.ts`, connexion). | ☐ OK (b) pour le pilote, (a) avant la production |
| AV-485 | Jusqu'au pilote, l'application tourne-t-elle sur la base MariaDB 11.8 de l'hébergement mutualisé, ou sur une base MySQL 8.4, celle des essais ? | (a) MariaDB 11.8 mutualisée avec une couche de compatibilité, en ligne depuis le 30/10/2026. | (a) pour mettre en ligne ce qui fonctionne ; (b) ou (c) avant le pilote. Ma recommandation (DÉDUIT) : (c), qui ne coûte rien de plus chaque mois ; (b) si le budget le permet. | Voir la fiche § 2.1. | ☐ (a) ☐ (b) ☐ (c) ☐ autre : |

### 2.1 Fiche de décision AV-485 : trois voies pour la base de données

Faits CONFIRMÉS ([`A-VALIDER.md`](../A-VALIDER.md) AV-485, [`04-deploiement.md`](../05-architecture/04-deploiement.md) § 7) : l'application est développée et testée sur MySQL 8.4 (plus de 2 200 essais du serveur), l'hébergement fournit MariaDB 11.8 avec un seul utilisateur de base. MariaDB refuse `CAST(? AS JSON)` (toute écriture d'une colonne JSON : audit, événements, commandes, tâches) et `FOR SHARE` (plus de vingt-cinq lectures). La mise en ligne du 30/10/2026 a laissé la connexion en erreur 500 et l'ordonnanceur en échec avant le correctif. Aujourd'hui, la couche `mariadb-compat.mjs` réécrit ces deux constructions à l'exécution et `compat-check.mjs` les rejoue sur la vraie base avant chaque redémarrage.

| Voie | Ce que c'est | Avantages | Risques et limites | Coût et effort |
|---|---|---|---|---|
| (a) MariaDB mutualisée et couche de compatibilité | La situation actuelle. | Rien à payer en plus ; déjà en ligne et contrôlé avant chaque redémarrage. | Les essais ne tournent pas sur MariaDB : une nouvelle construction SQL peut casser en ligne sans qu'aucun essai ne la voie ; le contrôle ne couvre que les constructions déjà connues ; plans d'exécution et verrous de MariaDB non comparés (DÉDUIT). | Aucun coût ; vigilance à chaque livraison (journaux du serveur). |
| (b) Base MySQL 8.4 dédiée avant le pilote | Autre offre d'hébergement, serveur privé ou base managée. | Le moteur de la production est celui des essais ; la couche de compatibilité disparaît. | Coût mensuel en plus (À DEMANDER aux hébergeurs : non chiffré ici) ; l'hébergement sans serveur privé avait été retenu (AV-073) : un autre fournisseur ou un serveur privé ajoute de l'exploitation (sauvegardes, mises à jour, supervision) pour une petite équipe ; migration et recette de la base. | Coût mensuel récurrent et effort modéré. |
| (c) Code portable dans les deux moteurs, essais sur MariaDB 11.8 | Faire tourner la suite d'essais sur MariaDB 11.8, en local puis en intégration continue, et corriger les écarts. | Supprime le risque à la source sans changer d'hébergement ni payer plus ; les futurs écarts sont vus par les essais. | Effort de développement à chiffrer : le nombre d'écarts restants est inconnu (verrous, plans, déclencheurs). Un premier essai de la suite sur MariaDB 11.8 donnerait la liste. Il faudrait installer MariaDB sur le poste de 8 Go, ce que je ne ferai qu'avec votre accord. | Effort de développement, aucun coût récurrent. |

## 3. Données de départ : les motifs (AV-320)

Faits CONFIRMÉS le 02/11/2026. La table des motifs a onze catégories ; seules sont semées `PRODUCTION_YIELD` et les trois catégories du CRM (résultat de visite, perte d'un prospect, annulation). Deux listes vides **bloquent** :

- `REJECTION` : sans motif, le serveur refuse une quantité rejetée à la réception d'un achat (`REJECTION_REASON_REQUIRED`). Concerne R3.
- `PRICE_OVERRIDE` : tout écart au prix du catalogue, remise ou majoration, exige un motif (`OVERRIDE_REASON_REQUIRED`) ; sans liste, aucune remise n'est possible. Concerne R2.

Les autres sont facultatives côté serveur (perte, écart d'inventaire, écart de transfert). À l'inventaire, l'écran rend le motif obligatoire dès que la liste n'est pas vide : semer `INVENTORY_ADJUSTMENT` change donc le comportement du magasinier. `CHECKIN_OVERRIDE` et `CASH_VARIANCE` : aucun écran n'en propose les motifs et le serveur n'en exige aucun. Les pertes ont déjà leurs catégories intégrées à l'écran (casse, détérioration, impropre, destruction, inexpliquée, vol suspecté). Aujourd'hui, le contournement est (c) : l'administrateur crée les motifs dans « Catalogue, Motifs » (MP-11).

PROPOSITION (À VALIDER avec GIC). Libellés à ajuster ; chaque liste finit par « Autre », commentaire obligatoire, comme les motifs du CRM. Le semis est rejouable : il n'ajoute que les codes absents et ne touche pas ce que l'administrateur a modifié.

| Catégorie | Motifs proposés |
|---|---|
| `REJECTION` (rejet à la réception) | Produit périmé ; produit abîmé ; non conforme à la commande ; quantité erronée ; Autre |
| `PRICE_OVERRIDE` (écart de prix) | Remise sur gros volume ; alignement sur un concurrent ; produit déclassé ou proche de sa date limite ; geste commercial ; Autre |
| `INVENTORY_ADJUSTMENT` (écart d'inventaire) | Erreur de comptage ; casse ; péremption ; Autre |
| `TRANSFER_DISCREPANCY` (écart de transfert) | Perte pendant le transport ; erreur de préparation ; produit abîmé à l'arrivée ; Autre |

| AV | Question | Défaut déjà en place | Recommandation | Si vous changez le défaut | Décision |
|---|---|---|---|---|---|
| AV-320 | Faut-il semer des motifs de départ pour les catégories ci-dessus ? | (c) Non : rien n'est semé, l'administrateur crée les motifs. Un rejet à la réception et une remise sont donc impossibles sur une base neuve. | (a) les quatre listes proposées, désactivables et modifiables, avec « Autre ». Le registre cite sept catégories ; j'en propose quatre, car aucun écran n'utilise deux d'entre elles et les pertes ont déjà leurs catégories. (b) seulement `REJECTION` et `PRICE_OVERRIDE`, les deux que le serveur exige. | (a) ou (b) : fichier de semis, `db/tests/seed.test.ts`, dictionnaire `03-catalog-pricing.md`. Petit lot. | ☐ (a) ☐ (b) ☐ (c) ; libellés à changer : |

## 4. Points déjà au défaut recommandé

### 4.1 Indicateurs de la Direction et alerte `JOB_FAILED` (AV-473 à AV-484)

Nés de P9-27 (29/10/2026). Tous sont déjà mis en œuvre avec la recommandation ; aucun écran de tableau n'existe encore (RP-4), donc rien ne presse. L'AV-480 amende l'AV-467.

| AV | Sujet | Défaut en place = recommandation | Autre voie possible |
|---|---|---|---|
| AV-473 | Atteinte d'objectif (KPI-COM-16) : quels objectifs | Objectifs individuels actifs ; valeur = chiffre d'affaires réalisé ÷ chiffre d'affaires visé ; une ligne de détail par autre métrique ; absent pour une étendue de sites seuls | Ajouter les objectifs de site, puis d'équipe, quand vous fixez la règle de recouvrement entre les trois niveaux |
| AV-474 | Atteinte d'objectif : fenêtre du réalisé | Cumul depuis le premier jour de l'objectif jusqu'au jour de lecture ; pas de période précédente | Réalisé de la période comparé à l'objectif proratisé ; comportement de la route actuelle |
| AV-475 | Poids moyen et coût par tête avec plusieurs espèces | Indicateur du type de lot qui compte le plus de têtes, détail des autres types | Un indicateur par type (jusqu'à 5 × 2 cartes) ; absent si plus d'un type |
| AV-476 | Consommation d'aliment (KPI-PRD-04) | Aliment imputé à un lot, en kilogrammes, lots de tout statut, jour métier | Ajouter l'aliment imputé à un site ; lots en élevage seulement |
| AV-477 | Poids moyen (KPI-PRD-05) : pesée de référence | Dernière pesée de chaque lot en élevage, pondérée par l'effectif | Pondérer par la taille de l'échantillon ; ignorer une pesée de plus de N jours |
| AV-478 | Coût par tête (KPI-PRD-09) | Somme des coûts restants ÷ somme des effectifs non vendus, lots en élevage du type | Lots de tout statut ; moyenne simple |
| AV-479 | Opérations en attente et conflits ouverts (KPI-OPS-02) | Deux indicateurs : opérations en attente (appareils en service des points de vente ouverts) et conflits ouverts (pour qui peut les traiter) | Un seul total ; l'un des deux seulement |
| AV-480 | Place des cinq indicateurs ; amende AV-467 | Équipes et KPI-COM-16 ; production et KPI-PRD-04, 05, 09 ; distribution et KPI-OPS-02. L'instantané hors ligne du vendeur passe de quatre à cinq indicateurs (six avec les conflits) | Un bloc « Synchronisation » ; aucun ajout |
| AV-481 | `JOB_FAILED` : durée de l'alerte | Ouverte 24 h après le dernier échec, résolution automatique ; durée réglable (`platform.failed_jobs_window_hours`) | L'Admin classe l'alerte à la main |
| AV-482 | `JOB_FAILED` : écran d'action | Aucun lien | Écran de supervision des tâches (lot propre) ; renvoi vers ECR-SYN-02 |
| AV-483 | `JOB_FAILED` : cadence | 5 minutes, constante technique | Réglable ; plus lente |
| AV-484 | `JOB_FAILED` : regroupement et seuil | Une alerte par type de tâche, une seule tâche en échec suffit | Exiger N échecs ; exclure certains types |

Décision pour les douze points : ☐ OK ; sinon, les numéros à changer et la voie choisie : ____________

### 4.2 Refonte graphique (AV-486 à AV-488)

| AV | Sujet | Défaut en place | Recommandation | Décision |
|---|---|---|---|---|
| AV-486 | Éditeur de règle de prix : les champs obligatoires vides s'affichent en rouge dès l'ouverture | (a) Comportement d'avant la refonte conservé | (b) montrer l'erreur après une saisie ou une tentative d'envoi, dans un lot à part (validation et essais de l'éditeur) | ☐ (b) ☐ (a) |
| AV-487 | Trésorerie : « Solde des comptes » (somme des comptes listés, inactifs compris) et total de trésorerie des coûts et marges (fourni par le serveur) : deux définitions du même chiffre | Somme des comptes listés dans la trésorerie ; total du serveur dans les coûts et marges | (a) lire le total du serveur dans les deux écrans, **après avoir demandé à la Finance** : un compte inactif peut-il encore porter un solde ? | Réponse de la Finance : ☐ non ☐ oui ☐ à demander |
| AV-488 | Bouton « Fiche de suivi de la semaine » : composant d'avant la refonte dans le module des pièces papier | (a) Bouton d'avant conservé : ce module n'a pas été touché pour que la mise en page des pièces ne bouge pas | (b) le reprendre avec le prochain lot des pièces (RP-6), mise en page des pièces intacte | ☐ OK (b) |

## 5. Ce qui se passe après vos réponses

| Décision | Suite | Taille (DÉDUIT) |
|---|---|---|
| AV-296 (b) | Lot de code : `findOrEnrollDevice`, connexion, PWA, essais | moyenne |
| AV-297 (a) | `login-lockout.ts` : réservation atomique de l'essai | petite |
| AV-320 (a) ou (b) | Fichier de semis des motifs, `db/tests/seed.test.ts`, dictionnaire | petite |
| AV-485 (c) | Essai de la suite sur MariaDB 11.8 pour chiffrer, puis corrections et intégration continue | moyenne à grande |
| AV-485 (b) | Décision et migration d'hébergement, hors code | à chiffrer |
| AV-486 (b), AV-487 (a), AV-488 (b) | Petits lots de la PWA | petite chacune |
| Les autres | Aucun code : consignés au journal de `A-VALIDER.md` § 3 | |

Les tableaux § 1.2 et § 1.3 sont l'entrée du lot suivant, RP-2 (reprise des données).
