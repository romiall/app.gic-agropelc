# Registre central des points À VALIDER — Questions ouvertes (Livrable n°20)

> **Source unique** de toutes les décisions métier en attente. Tout document qui s'appuie sur une valeur provisoire référence l'identifiant `AV-nnn` ci-dessous.
> Cycle de vie : `OUVERT` → `TRANCHÉ (date, décideur)`. Un point tranché devient **CONFIRMÉ** ; sa décision est reportée ici et propagée dans les documents concernés (voir [`00-reference/00-conventions.md`](00-reference/00-conventions.md) §2).

Classification (PM §45) :

- **BLOQUANTE** : empêche de construire correctement une partie fondamentale. La phase concernée ne peut pas être livrée sans décision, mais le travail des autres phases continue avec la valeur par défaut.
- **IMPORTANTE** : peut être décidée pendant le développement, avant la phase concernée.
- **SECONDAIRE** : peut rester configurable ou être reportée.

---

## 1. Tableau de synthèse

| ID | Sujet | Classe | Phase impactée | Défaut provisoire | État |
|---|---|---|---|---|---|
| AV-001 | Périmètre de la première mise en production | IMPORTANTE | Plan | Mise en production progressive par tranches, site pilote | OUVERT |
| AV-002 | Inventaire des sites, magasins, points de vente et bâtiments existants | IMPORTANTE | P1 | Modèle générique ; données fournies par GIC | OUVERT |
| AV-003 | Hiérarchie des zones et géométrie des zones de pointage | IMPORTANTE | P0/P1 | Zones hiérarchiques ; géorepère = centre + rayon | OUVERT |
| AV-004 | Rôles non listés au CM : opérateur de ferme, livreur, caissier | IMPORTANTE | P0 | Aucun rôle supplémentaire au lancement | **TRANCHÉ** (voir journal §3) |
| AV-005 | Répartition Responsable ferme / Responsable production | IMPORTANTE | P7 | Ferme = son site (saisies, stock) ; Production = toutes les fermes (lots, validations, indicateurs) | **TRANCHÉ** (voir journal §3) |
| AV-006 | Politique d'enrôlement des appareils | IMPORTANTE | P0 | Appareil `PENDING` jusqu'à approbation | OUVERT |
| AV-007 | Appareils partagés entre plusieurs utilisateurs | IMPORTANTE | P0/P5 | Autorisés ; session et allocation par couple utilisateur/appareil | OUVERT |
| AV-008 | Mode d'authentification des utilisateurs terrain | IMPORTANTE | P0 | Téléphone + mot de passe à l'enrôlement ; PIN local | OUVERT |
| AV-009 | Autonomie maximale hors connexion | IMPORTANTE | P0 | 7 jours puis écritures bloquées | OUVERT |
| AV-010 | Séparation des tâches (déclarant ≠ approbateur) | IMPORTANTE | P0 | Oui ; dérogation Direction tracée | OUVERT |
| AV-011 | Étapes du pipeline prospect | SECONDAIRE | P3 | Configurable ; 4 étapes + 2 terminaux | OUVERT |
| AV-012 | Règle de conversion prospect → client | IMPORTANTE | P3/P4 | Automatique à la première vente confirmée | OUVERT |
| AV-013 | Définition client actif / inactif | SECONDAIRE | P9 | Inactif = aucune vente depuis 30 jours | OUVERT |
| AV-014 | Visibilité des prospects entre commerciaux et doublons | IMPORTANTE | P3 | Portefeuille propre ; contrôle de doublon par téléphone | OUVERT |
| AV-015 | Règles de réaffectation de clients | IMPORTANTE | P3 | Resp. commercial / Direction ; historique conservé | OUVERT |
| AV-016 | Structure des objectifs commerciaux | SECONDAIRE | P3 | Objectif par utilisateur ou équipe, période, métrique | OUVERT |
| AV-017 | Catégories de clients | SECONDAIRE | P1 | 5 catégories initiales configurables | OUVERT |
| AV-018 | Sources de prospects et canaux de vente | SECONDAIRE | P1 | Référentiels configurables | OUVERT |
| AV-019 | Interactions des canaux Kommo stockées dans GIC | SECONDAIRE | P10 | Non : lien et compteurs seulement | OUVERT |
| AV-020 | Commissions commerciales | SECONDAIRE | Futur | Hors MVP ; attribution conservée | OUVERT |
| AV-021 | Prise de service hors zone : refus ou acceptation signalée | IMPORTANTE | P3 | Refus + tentative conservée + dérogation | OUVERT |
| AV-022 | Rayon de tolérance et précision GPS maximale | SECONDAIRE | P3 | 500 m (CM) ; précision ≤ 150 m | OUVERT |
| AV-023 | Session de travail obligatoire pour visites et ventes terrain | IMPORTANTE | P3 | Rattachement automatique, pas de blocage | OUVERT |
| AV-024 | Reconnaissance de la vente et sortie de stock pour les ventes sur commande | **BLOQUANTE** | P4 | Vente et CA à la confirmation ; marchandise en emplacement « à livrer » jusqu'à la livraison | **TRANCHÉ** (voir journal §3) |
| AV-025 | Vente hors ligne au-delà de l'allocation | **BLOQUANTE** | P4/P5 | Bloquée sur l'appareil ; option « autorisée et signalée » activable par site, désactivée par défaut | **TRANCHÉ** (voir journal §3) |
| AV-026 | Modification de prix / remise par le vendeur | IMPORTANTE | P4 | Interdite sauf permission, plafond et motif | OUVERT |
| AV-027 | Ventes anonymes au point de vente | IMPORTANTE | P4 | Autorisées si payées comptant intégralement | OUVERT |
| AV-028 | Politique de crédit client | IMPORTANTE | P4 | Clients autorisés, plafond, échéance 30 jours | OUVERT |
| AV-029 | Retours clients | SECONDAIRE | Futur | Hors MVP ; annulation encadrée | OUVERT |
| AV-030 | Conditions d'annulation d'une vente | IMPORTANTE | P4 | Validation requise sauf ≤ 15 min et caisse ouverte | OUVERT |
| AV-031 | Vente au poids ou à l'unité selon les produits | IMPORTANTE | P1/P4 | Les deux supportés ; à l'unité par défaut | OUVERT |
| AV-032 | Poulets vendus vifs et/ou abattus (transformation) | IMPORTANTE | P7 | Vif et abattu dès P7 : transformation multi-produits (entier, découpes, abats), coût réparti au prorata du poids | **TRANCHÉ** (voir journal §3) |
| AV-033 | Acomptes sur commande | SECONDAIRE | P4 | Autorisés, affectés à la commande | OUVERT |
| AV-034 | Livraison : document distinct ou portée par la vente | IMPORTANTE | P4 | Portée par la vente sur commande | OUVERT |
| AV-035 | Politique d'allocation de stock | IMPORTANTE | P5 | Allocation explicite, libération confirmée par l'appareil | OUVERT |
| AV-036 | Traçabilité par lot jusqu'à la vente | IMPORTANTE | P2/P7 | Obligatoire pour les animaux vivants ; FIFO automatique | OUVERT |
| AV-037 | Seuils de preuve et de validation des pertes | IMPORTANTE | P2 | Politique paramétrable (valeurs §2) | OUVERT |
| AV-038 | Traitement du rejet d'une déclaration de perte | SECONDAIRE | P2 | Deux issues : retour stock ou perte imputée au déclarant ; rejet sans motif = erreur de déclaration | **TRANCHÉ** (voir journal §3) |
| AV-039 | Fréquence et procédure d'inventaire | SECONDAIRE | P2/P5 | Mensuel complet recommandé + ponctuel | OUVERT |
| AV-040 | Seuils de réapprovisionnement | SECONDAIRE | P5 | Paramétrés par emplacement × produit | OUVERT |
| AV-041 | TVA et taxes | IMPORTANTE | P4/P8 | Prix TTC, pas de ventilation fiscale | OUVERT |
| AV-042 | Méthode de valorisation du stock | IMPORTANTE | P2/P8 | CMUP perpétuel ; coût de lot pour le biologique | OUVERT |
| AV-043 | Coûts incorporés au coût d'un lot | IMPORTANTE | P7/P8 | Coûts directs + frais généraux du site, répartis chaque mois au prorata têtes × jours | **TRANCHÉ** (voir journal §3) |
| AV-044 | Types de lots exploités | IMPORTANTE | P7 | Cinq types actifs dès P7 ; reproducteur volaille suivi comme une pondeuse | **TRANCHÉ** (voir journal §3) |
| AV-045 | Naissage porcin dans le MVP | IMPORTANTE | P7 | Inclus : naissances dans le lot de naissage, sevrage = transfert vers un lot d'engraissement avec coût | **TRANCHÉ** (voir journal §3) |
| AV-046 | Classification des œufs et conditionnement | IMPORTANTE | P7 | Catégories CM + calibres à la collecte (liste paramétrable, un produit par calibre) ; plateau de 30 | **TRANCHÉ** (voir journal §3) |
| AV-047 | Origine des œufs à couver et paramètres d'incubation | SECONDAIRE | P7 | Œufs internes ou achetés ; durées paramétrées par espèce | **TRANCHÉ** (voir journal §3) |
| AV-048 | Seuil de validation de la mortalité | IMPORTANTE | P7 | Toute mortalité validée (photo + Resp. production) ; seuils paramétrés en conséquence | **TRANCHÉ** (voir journal §3) |
| AV-049 | Indicateurs zootechniques attendus | SECONDAIRE | P7/P9 | Base + indice de consommation, poids moyen et GMQ, taux de ponte | **TRANCHÉ** (voir journal §3) |
| AV-050 | Suivi sanitaire (vaccination, traitements) | SECONDAIRE | Futur | Consommations vétérinaires imputées ; pas de plan de prophylaxie | **TRANCHÉ** (voir journal §3) |
| AV-051 | Seuils de validation des achats | IMPORTANTE | P6 | Toute DA validée ; BC > 500 000 XAF par Direction | OUVERT |
| AV-052 | Réception sans bon de commande | IMPORTANTE | P6 | Autorisée avec justification et validation | OUVERT |
| AV-053 | Tolérances de rapprochement commande / réception / facture | SECONDAIRE | P6/P8 | Tolérance nulle ; écart signalé | OUVERT |
| AV-054 | Traitement des quantités rejetées à réception | SECONDAIRE | P6 | Hors stock ; avoir sur facture | OUVERT |
| AV-055 | Règles de paiement fournisseur | SECONDAIRE | P8 | Finance enregistre ; Direction approuve > seuil | OUVERT |
| AV-056 | Moyens de paiement et vérification mobile money | IMPORTANTE | P4 | Liste configurable ; référence saisie manuellement | OUVERT |
| AV-057 | Procédure de caisse du point de vente | IMPORTANTE | P5 | Session quotidienne ; clôture comptée ; écart validé | OUVERT |
| AV-058 | Catégories de dépenses et justificatifs | SECONDAIRE | P8 | Liste initiale ; photo > 10 000 XAF ; validation > 50 000 XAF | OUVERT |
| AV-059 | Export / intégration comptable | SECONDAIRE | Futur | Exports CSV structurés | OUVERT |
| AV-060 | Arrondis monétaires | SECONDAIRE | P4 | Arrondi au franc par ligne (demi supérieur) | OUVERT |
| AV-061 | Dimensions tarifaires utilisées au lancement | SECONDAIRE | P1 | Toutes supportées ; grille zone + PDV | OUVERT |
| AV-062 | Validation / activation des règles tarifaires | IMPORTANTE | P1 | Création Resp. commercial ; activation Direction | OUVERT |
| AV-063 | Vente hors ligne à un prix devenu obsolète | IMPORTANTE | P4 | Acceptée au prix figé ; anomalie signalée | OUVERT |
| AV-064 | Canaux de notification | SECONDAIRE | P9 | In-app + Web Push | OUVERT |
| AV-065 | Alertes initiales et seuils | SECONDAIRE | P9 | Liste CM §54 ; seuils configurables | OUVERT |
| AV-066 | Accusé de lecture des notes de direction | SECONDAIRE | P9 | Optionnel par note | OUVERT |
| AV-067 | Formats et restrictions d'export | SECONDAIRE | P9 | CSV + XLSX ; exports audités | OUVERT |
| AV-068 | Capacités du compte Kommo (API, webhooks, pipelines, champs) | IMPORTANTE | P10 | À vérifier ; bloquante pour P10 uniquement | OUVERT |
| AV-069 | Déclencheur de création d'un client GIC depuis Kommo | IMPORTANTE | P10 | Statut Kommo « qualifié » configurable | OUVERT |
| AV-070 | Données remontées de GIC vers Kommo | SECONDAIRE | P10 | Exemple CM §46 | OUVERT |
| AV-071 | Correspondance utilisateurs GIC ↔ Kommo | SECONDAIRE | P10 | Table de correspondance explicite | OUVERT |
| AV-072 | Reprise des données existantes | IMPORTANTE | P1/P2 | Modèles CSV + inventaire d'ouverture | OUVERT |
| AV-073 | Hébergement, localisation et protection des données | IMPORTANTE | P0 | Hostinger, sans VPS ; région selon l'offre | **TRANCHÉ** (voir journal §3) |
| AV-074 | Durées de conservation | SECONDAIRE | P0/P9 | Audit et finance 10 ans ; GPS 2 ans ; photos 5 ans | OUVERT |
| AV-075 | Parc d'appareils cible | IMPORTANTE | P0 | Android ≥ 8, Chrome ≥ 100, 2 Go RAM | OUVERT |
| AV-076 | Impression de reçus au point de vente | SECONDAIRE | Futur | Reçu numérique / partage | OUVERT |
| AV-077 | Format de numérotation officielle des documents | SECONDAIRE | P0 | `{TYPE}-{SITE}-{AAAA}-{seq6}` | OUVERT |
| AV-078 | Saisie rétroactive (heure métier dans le passé) | IMPORTANTE | P0 | ≤ 72 h ; justification au-delà de 24 h | OUVERT |
| AV-079 | Langues de l'interface | SECONDAIRE | P0 | Français, prêt pour l'anglais | OUVERT |
| AV-080 | Unités de conditionnement | SECONDAIRE | P1 | Configurables par produit | OUVERT |
| AV-081 | Validation préalable des transferts | SECONDAIRE | P2 | Non requise ; demande de réappro approuvée par l'expédition | OUVERT |
| AV-082 | Traitement des écarts de transfert | SECONDAIRE | P2 | Validation + justification ; imputation au transfert | OUVERT |
| AV-083 | Vente d'un produit désactivé pendant une période hors ligne | SECONDAIRE | P4 | Acceptée et signalée | OUVERT |
| AV-084 | Équipe et budget de développement / exploitation | IMPORTANTE | Plan | Petite équipe ; services managés | OUVERT |
| AV-085 | Frais de livraison facturés au client | SECONDAIRE | P4 | Ligne de service optionnelle | OUVERT |
| AV-086 | Volumétrie cible à 3 ans | IMPORTANTE | P0/P9 | 150 utilisateurs, 40 sites, 5 000 lignes de vente/jour | OUVERT |
| AV-087 | Prix appliqué à la livraison d'une commande | SECONDAIRE | P4 | Prix convenu à la commande | OUVERT |
| AV-088 | Clôture et verrouillage de période | SECONDAIRE | P8 | Pas de verrouillage au MVP | OUVERT |
| AV-089 | Confirmation de la stack technique proposée (ADR-021) | IMPORTANTE | P0 | TypeScript de bout en bout : React + Vite + Dexie ; NestJS (Fastify) + Kysely ; **MySQL** (ADR-023, remplace PostgreSQL) | **TRANCHÉ** (voir journal §3) |
| AV-090 | Modalité d'exécution du serveur Node.js chez Hostinger sans VPS | IMPORTANTE | Déploiement | Application Node.js gérée par l'hébergeur si disponible, sinon plateforme tierce à bas coût en complément | OUVERT |
| AV-091 | Fournisseur de stockage objet S3-compatible (Hostinger sans VPS n'en propose pas) | SECONDAIRE | Déploiement | Cloudflare R2 ou Backblaze B2 | OUVERT |
| AV-092 | Permissions marquant `identity.permissions.is_sensitive` (audit renforcé et revue d'attribution périodique) | IMPORTANTE | P0 | `false` pour les 117 permissions (défaut du schéma ; aucune n'est désignée par une source) | OUVERT |
| AV-093 | Permission gouvernant `attachments.attachment.register` | SECONDAIRE | P0 | Permission générique `attachments.attachment.manage`, accordée à tous les rôles opérationnels | OUVERT |
| AV-094 | Permission de lecture des documents de stock (transferts, pertes, consommations, inventaires, seuils) | SECONDAIRE | P2 | Pertes : `inventory.loss.read`, encadrement dans son périmètre, déclarants de terrain limités à leurs propres pertes ; autres documents : `inventory.stock.read` | **TRANCHÉ** (voir journal §3) |
| AV-095 | Réception hors ligne dépassant le reliquat d'un bon de commande : quarantaine ou application avec excédent en revue | SECONDAIRE | P6 | Quarantaine (défaut confirmé) | **TRANCHÉ** (voir journal §3) |
| AV-096 | Dérogation d'emplacement de réception (réception d'un BC hors de son site de livraison) : qui l'accorde et comment | SECONDAIRE | P6 | Autorisée après validation du Resp. achats ; stock à la validation | **TRANCHÉ** (voir journal §3) |
| AV-097 | Coût par tête d'un lot après les sorties | IMPORTANTE | P7 | Coût restant ÷ têtes restantes (ADR-027) | **TRANCHÉ** (voir journal §3) |
| AV-098 | Valeur des productions des lots reproducteurs | IMPORTANTE | P7 | Coût standard ; crédit du lot producteur (ADR-027) | **TRANCHÉ** (voir journal §3) |
| AV-099 | Lots à plusieurs produits (truies, verrats, porcelets ; poules et coqs) | IMPORTANTE | P7 | Un lot par produit, lots liés | **TRANCHÉ** (voir journal §3) |
| AV-100 | Lot de stock des œufs collectés et des produits d’abattage | IMPORTANTE | P7 | Lot de stock propre par collecte et par abattage | **TRANCHÉ** (voir journal §3) |
| AV-101 | Lieu et acteur de l'abattage | IMPORTANTE | P7 | À la ferme, emplacement abattoir, Resp. ferme | **TRANCHÉ** (voir journal §3) |
| AV-102 | Unités et vente des produits d'abattage | IMPORTANTE | P7 | Entier à la pièce ; découpes et abats au kg | **TRANCHÉ** (voir journal §3) |
| AV-103 | Saisie des frais généraux de ferme | IMPORTANTE | P7 | Finance (ALL), Resp. production (ALL), Resp. ferme (SITE) | **TRANCHÉ** (voir journal §3) |
| AV-104 | Frais généraux séparés par espèce | IMPORTANTE | P7 | Volaille / porc séparés ; frais communs ventilés à la saisie | **TRANCHÉ** (voir journal §3) |
| AV-105 | Lot clôturé en cours de mois | IMPORTANTE | P7 | Part estimée à la clôture sur les frais connus | **TRANCHÉ** (voir journal §3) |
| AV-106 | Moment de la répartition et frais tardifs | SECONDAIRE | P7 | À la demande ; régularisation des frais tardifs | **TRANCHÉ** (voir journal §3) |
| AV-107 | Mortalité reçue sans photo | IMPORTANTE | P7 | Enregistrée ; validation bloquée jusqu’à la photo | **TRANCHÉ** (voir journal §3) |
| AV-108 | Écarts d’inventaire sur des animaux | IMPORTANTE | P7 | Validation Resp. production pour tout écart sur animaux | **TRANCHÉ** (voir journal §3) |
| AV-109 | Lots permanents (pondeuses, reproducteurs, truies) | IMPORTANTE | P7 | Résultat mensuel ; vente par produit | **TRANCHÉ** (voir journal §3) |
| AV-110 | Nombre de collectes d’œufs par jour | SECONDAIRE | P7 | Plusieurs collectes par jour | **TRANCHÉ** (voir journal §3) |
| AV-111 | Organisation du naissage porcin | IMPORTANTE | P7 | Lot truies + lot porcelets ; sevrage vers engraissement | **TRANCHÉ** (voir journal §3) |
| AV-112 | Mise en place par achat direct | SECONDAIRE | P7 | Une seule opération (réception + entrée) | **TRANCHÉ** (voir journal §3) |
| AV-113 | Mortalité des poussins avant mise en place | SECONDAIRE | P7 | Mortalité rattachée au lot d’incubation | **TRANCHÉ** (voir journal §3) |
| AV-114 | Carcasses saisies et frais d'abattage | SECONDAIRE | P7 | Saisies sans produit (coût porté par les produits) ; frais = dépense directe du lot | OUVERT |
| AV-115 | Abattage des réformes et des porcs | SECONDAIRE | P7 | Poulet de chair seul ; autres types activables par paramètre | OUVERT |
| AV-116 | Définition des indicateurs zootechniques | SECONDAIRE | P7 | Formules de la recommandation, paramétrables | OUVERT |
| AV-117 | Journée sans événement (« RAS ») | SECONDAIRE | P7 | Non construit en P7 (alertes en P9) ; observation « RAS » possible | OUVERT |
| AV-118 | Reclassement d'œufs | SECONDAIRE | P7 | Non construit en P7 ; reclassement avec motif proposé | OUVERT |
| AV-119 | Mortalité constatée hors élevage | SECONDAIRE | P7 | Toute mortalité suit la politique `MORTALITY` | OUVERT |
| AV-120 | Annulations après consommation (collecte, mortalité approuvée) | SECONDAIRE | P7 | Refus en ligne (`STOCK_UNAVAILABLE`) ; correction compensatoire, en attendant la décision | OUVERT |
| AV-121 | Seuils de l’alerte de mortalité élevée | SECONDAIRE | P7 | Seuils d’alerte propres (0,5 % ou 20 têtes/jour), paramétrés | OUVERT |
| AV-122 | Durée de conservation des œufs collectés | SECONDAIRE | P7 | 28 jours après la collecte, paramétrée | OUVERT |

---

## 2. Détail des questions

Format de chaque fiche : **Question**, **Pourquoi c'est important**, **Choix possibles**, **Recommandation par défaut**, **Impact du choix**, **Références**.

### AV-001 — Périmètre de la première mise en production — IMPORTANTE
- **Question** : le MVP (CM §57) est-il mis en service d'un bloc, ou tranche par tranche avec un site pilote ?
- **Pourquoi** : le CM §57 couvre presque tous les domaines, alors que le CM §56 et le §63.10 demandent de ne pas surcharger le MVP (tension C-07).
- **Choix** : (a) mise en service unique après toutes les phases ; (b) mise en production progressive par tranches verticales ; (c) pilote sur un point de vente et une ferme, puis extension.
- **Recommandation** : (b) + (c). Tranches R1 à R5 définies dans [`10-development-plan/01-plan-developpement.md`](10-development-plan/01-plan-developpement.md).
- **Impact** : calendrier, formation, reprise de données. Aucun impact sur le modèle de données.
- **Références** : CM §56, §57 ; C-07.

### AV-002 — Inventaire des sites physiques — IMPORTANTE
- **Question** : quels sites existent ou sont prévus (fermes, magasins, points de vente, bureau) ? Quels bâtiments et cases ? Une ferme sert-elle aussi de magasin ?
- **Pourquoi** : paramétrage initial des sites, emplacements et périmètres RBAC.
- **Choix** : n/a (données).
- **Recommandation** : un site peut porter plusieurs types d'emplacements. Une ferme peut donc avoir un magasin d'intrants et un stock commercial.
- **Impact** : données d'initialisation uniquement.
- **Références** : CM §12, §15, §22.

### AV-003 — Zones : hiérarchie et géométrie — IMPORTANTE
- **Question** : quels niveaux de zone utiliser (ville, marché, quartier, secteur) ? Une zone de pointage est-elle un cercle (centre + rayon) ou un polygone ?
- **Pourquoi** : les zones servent à la tarification (Douala, Yaoundé, marché, quartier, CM §29), à l'analyse par zone (CM §9), au portefeuille et au pointage (CM §10).
- **Choix** : (a) cercle centre + rayon ; (b) polygone ; (c) les deux.
- **Recommandation** : zones hiérarchiques à niveaux configurables (`VILLE` > `MARCHE` | `QUARTIER` > `SECTEUR`). Géorepère de pointage = **point de référence + rayon**, par défaut 500 m (CM §10). Le polygone est une évolution future.
- **Impact** : calcul de distance au pointage, héritage tarifaire.
- **Références** : CM §9, §10, §29 ; PM §13.

### AV-004 — Rôles supplémentaires — IMPORTANTE — **TRANCHÉ**
- **Question** : faut-il des rôles non listés au CM §47, comme opérateur ou agent de ferme (saisie quotidienne), livreur ou transporteur, caissier distinct du vendeur ?
- **Pourquoi** : la « SAISIE DU JOUR » en ferme et les transferts physiques sont peut-être faits par des personnes qui n'ont aucun rôle du CM.
- **Choix** : (a) aucun rôle supplémentaire ; (b) ajouter `OPERATEUR_FERME` (saisie seulement) ; (c) ajouter aussi `LIVREUR` et `CAISSIER`.
- **Recommandation** : (a) au lancement. Le modèle RBAC permet d'ajouter (b) ou (c) par simple configuration, sans code. Le rôle `OPERATEUR_FERME` est décrit comme **proposé** dans la matrice RBAC.
- **Impact** : paramétrage uniquement (RBAC data-driven).
- **Références** : CM §47, §49 ; ADR-008.
- **Décision** (porteur du projet, 27/09/2026) : **Aucun rôle supplémentaire** au lancement (option a) ; `OPERATEUR_FERME` reste un rôle proposé, ajoutable par paramétrage.

### AV-005 — Responsable ferme vs Responsable production — IMPORTANTE — **TRANCHÉ**
- **Question** : comment répartir les droits entre ces deux rôles (CM §47) ?
- **Recommandation** : le Responsable ferme agit sur **son site** : saisies, stock de la ferme, validations locales sous seuil. Le Responsable production agit sur **toutes les fermes** : création et clôture des lots, validations au-dessus du seuil, indicateurs.
- **Impact** : matrice RBAC uniquement.
- **Références** : CM §47 ; C-11.
- **Décision** (porteur du projet, 27/09/2026) : Recommandation retenue : le Responsable ferme agit sur **son site** (saisies, stock de la ferme) ; le Responsable production agit sur **toutes les fermes** (création et clôture des lots, validations, indicateurs).

### AV-006 — Enrôlement des appareils — IMPORTANTE
- **Question** : un nouvel appareil peut-il synchroniser immédiatement, ou doit-il être approuvé ?
- **Pourquoi** : PM §37 (« appareils autorisés ») ; risque d'usurpation.
- **Choix** : (a) libre ; (b) approbation par Admin ; (c) approbation par Admin ou par le responsable hiérarchique.
- **Recommandation** : (c). L'appareil reste `PENDING` : il peut consulter mais ne peut pas pousser d'opérations tant qu'il n'est pas `ACTIVE`.
- **Impact** : friction au démarrage ; sécurité.
- **Références** : PM §37 ; SM-DEVICE.

### AV-007 — Appareils partagés — IMPORTANTE
- **Question** : une tablette de point de vente peut-elle être utilisée par plusieurs vendeurs ?
- **Recommandation** : oui. Chaque utilisateur déverrouille avec son propre PIN. Les allocations de stock sont liées au couple **(utilisateur, appareil)**.
- **Impact** : modèle d'allocation et de session.
- **Références** : CM §12, §39 ; ADR-004.

### AV-008 — Authentification des utilisateurs terrain — IMPORTANTE
- **Recommandation** : l'identifiant est le numéro de téléphone. Un mot de passe (8 caractères minimum) est demandé à l'enrôlement de l'appareil. Un PIN local à 6 chiffres sert au déverrouillage hors ligne. Pas d'OTP SMS au MVP.
- **Impact** : UX de connexion, sécurité.
- **Références** : CM §49 ; PM §37.

### AV-009 — Autonomie hors connexion maximale — IMPORTANTE
- **Question** : combien de temps un appareil peut-il enregistrer des opérations sans aucune synchronisation ?
- **Choix** : 72 h ; 7 jours ; illimité.
- **Recommandation** : **7 jours**. Au-delà, l'application passe en lecture seule et exige une reconnexion. Un bandeau d'avertissement apparaît à partir de 48 h.
- **Impact** : risque utilisateur révoqué ou appareil perdu (RISK-08) contre continuité d'activité.
- **Références** : PM §29 ; ADR-001.

### AV-010 — Séparation des tâches — IMPORTANTE
- **Recommandation** :
  - le déclarant ne peut pas approuver sa propre opération (perte, dépense, écart d'inventaire, demande d'achat) ;
  - le rôle Admin n'approuve aucune opération métier ;
  - exception : un utilisateur Direction peut s'auto-approuver, avec le marqueur `SELF_APPROVED` dans l'audit (petite structure).
- **Références** : CM §5.3, §40 ; ADR-018.

### AV-011 — Pipeline prospect — SECONDAIRE
- **Recommandation** : étapes configurables. Valeurs initiales : `NOUVEAU`, `CONTACTE`, `INTERESSE`, `NEGOCIATION`. Terminaux système non configurables : `CLIENT` (conversion) et `PERDU`.
- **Références** : PM §24 ; SM-CUSTOMER.

### AV-012 — Conversion prospect → client — IMPORTANTE
- **Question** : quand un prospect devient-il client ?
- **Choix** : (a) à la première commande confirmée ; (b) à la première vente confirmée ; (c) manuellement.
- **Recommandation** : (b), automatique. Le CM distingue « combien ont commandé » de « combien sont devenus clients » (CM §7), ce qui suggère que la commande seule ne suffit pas.
- **Impact** : indicateurs de conversion et attribution d'acquisition.
- **Références** : CM §7 ; BR-CRM-010.

### AV-013 — Client actif / inactif — SECONDAIRE
- **Recommandation** : l'état actif ou inactif est **calculé, jamais saisi**. Inactif = aucune vente confirmée depuis 30 jours (paramètre).
- **Références** : CM §7, §9.

### AV-014 — Visibilité et doublons de prospects — IMPORTANTE
- **Recommandation** : un commercial voit son portefeuille. À la création, le serveur contrôle les doublons par numéro de téléphone normalisé, sur tous les clients. En cas de doublon, il indique seulement « déjà suivi par un autre commercial », sans révéler les données. Hors ligne, le contrôle porte sur les données locales, puis sur le serveur à la synchronisation (conflit `DUPLICATE_CUSTOMER`).
- **Références** : CM §7, §8 ; matrice des conflits.

### AV-015 — Réaffectation de clients — IMPORTANTE
- **Recommandation** : la réaffectation est faite par le Responsable commercial ou la Direction. L'**acquéreur** (qui a acquis le client) est immuable. Les ventes passées gardent le commercial attribué au moment de la vente ; les ventes futures reviennent au nouveau titulaire.
- **Références** : CM §8 ; BR-CRM-020.

### AV-016 — Objectifs commerciaux — SECONDAIRE
- **Recommandation** : un objectif est défini par une cible (utilisateur, équipe ou point de vente), une période, une métrique (`CA`, `QTE_PRODUIT`, `NOUVEAUX_CLIENTS`, `VISITES`, `PROSPECTS_CREES`) et une valeur.

### AV-017 — Catégories de clients — SECONDAIRE
- **Recommandation** : référentiel configurable. Valeurs initiales : `PARTICULIER`, `REVENDEUR`, `RESTAURATION_HOTELLERIE`, `GROSSISTE`, `INSTITUTION`.

### AV-018 — Sources et canaux — SECONDAIRE
- **Recommandation** : canaux de vente (CM §11) `TERRAIN`, `DIRECT`, `POINT_DE_VENTE`, `SEDENTAIRE`, `DIGITAL`, `WHATSAPP`, `KOMMO`. Sources de prospect : `PROSPECTION_TERRAIN`, `RECOMMANDATION`, `KOMMO`, `RESEAU_SOCIAL`, `VISITE_SPONTANEE`, `AUTRE`.

### AV-019 — Interactions des canaux Kommo — SECONDAIRE
- **Recommandation** : les conversations et relances restent dans Kommo (CM §44). GIC ne stocke que les interactions hors Kommo (appels, visites) et le lien vers le lead ou contact Kommo.

### AV-020 — Commissions — SECONDAIRE
- **Recommandation** : hors MVP (CM §8 « éventuelles commissions futures »). L'attribution est figée sur chaque vente, ce qui permet de les calculer plus tard.

### AV-021 — Prise de service hors zone — IMPORTANTE
- **Choix** : (a) refus, tentative conservée ; (b) acceptation signalée ; (c) refus + demande de dérogation validée par un responsable.
- **Recommandation** : (c).
- **Références** : CM §10 ; SM-WORK-SESSION.

### AV-022 — Tolérance GPS — SECONDAIRE
- **Recommandation** : rayon de 500 m (valeur CM), paramétrable par zone. Précision maximale acceptée de 150 m. Au-delà, l'utilisateur doit réessayer ; après 3 essais sur au moins 2 minutes, il peut soumettre une dérogation.

### AV-023 — Session obligatoire — IMPORTANTE
- **Recommandation** : aucun blocage. Les visites et ventes terrain se rattachent automatiquement à la session ouverte. Si aucune session n'est ouverte, l'indicateur « visite hors session » est levé. Les sessions ouvertes sont clôturées automatiquement à 23:59 (heure de Douala).

### AV-024 — Vente sur commande : reconnaissance et sortie de stock — BLOQUANTE (phase 4) — **TRANCHÉ**
- **Question** : pour une commande livrée plus tard, quand le stock sort-il et quand le chiffre d'affaires est-il reconnu ?
- **Choix** : (a) à la confirmation de la commande ; (b) à la remise physique (livraison) ; (c) vente confirmée avant livraison, avec un état « à livrer ».
- **Recommandation** : (b). La commande réserve le stock ; la livraison crée la vente, la sortie de stock et la créance. Une vente directe est à la fois vente et remise.
- **Impact** : machines à états commande et vente, calcul du CA, créances. Voir ADR-014.
- **Références** : CM §4, §13, §32 ; C-04.
- **Décision** (porteur du projet, 27/09/2026) : Vente et chiffre d'affaires reconnus à la **confirmation** de la commande (option a, différente de la recommandation) ; la marchandise passe alors dans un emplacement « vendu, à livrer » et sort vers le client à la livraison (le comptage physique du magasin reste juste) ; une vente directe est à la fois vente et remise.

### AV-025 — Vente hors ligne au-delà de l'allocation — BLOQUANTE (phases 4 et 5) — **TRANCHÉ**
- **Choix** : (a) blocage sur l'appareil ; (b) autorisée et signalée, avec vérification à la synchronisation ; (c) autorisée seulement pour certains rôles.
- **Recommandation** : (a). Un vendeur ne peut pas vendre hors ligne plus que son allocation ou que le stock de son emplacement exclusif. Une option (b) peut être activée **par site**, désactivée par défaut.
- **Impact** : risque de vente manquée contre risque de survente.
- **Références** : CM §39 ; PM §6 ; C-08 ; ADR-004.
- **Décision** (porteur du projet, 27/09/2026) : Vente hors ligne au-delà de l'allocation **bloquée sur l'appareil** (option a) ; l'option « autorisée et signalée » reste activable par site, désactivée par défaut.

### AV-026 — Modification de prix par le vendeur — IMPORTANTE
- **Recommandation** : interdite par défaut. Avec la permission `sales.price.override`, une remise est possible dans un plafond paramétré par rôle (Vendeur 0 %, Commercial 5 %, Resp. commercial 15 %), avec un motif obligatoire. Au-delà du plafond, une validation est requise.
- **Références** : CM §29, §30 ; PM §37.

### AV-027 — Ventes anonymes — IMPORTANTE
- **Recommandation** : autorisées au point de vente et en vente directe si la vente est **intégralement payée** au moment de la vente. Un client identifié est obligatoire pour une vente à crédit ou sur commande.

### AV-028 — Crédit client — IMPORTANTE
- **Recommandation** : vente à crédit seulement pour les clients avec `credit_allowed = true`, dans la limite de `credit_limit_xaf`. L'échéance par défaut est de 30 jours. Hors ligne, le contrôle porte sur l'encours connu localement. Un dépassement nécessite une validation.

### AV-029 — Retours clients — SECONDAIRE
- **Recommandation** : hors MVP. Les erreurs se corrigent par annulation encadrée (AV-030). Le modèle `sales_returns` est prévu pour une phase ultérieure.

### AV-030 — Annulation d'une vente — IMPORTANTE
- **Recommandation** : le vendeur peut annuler sa propre vente sans validation si elle date de moins de 15 minutes et que la session de caisse est encore ouverte. Sinon, il faut une demande d'annulation approuvée par le responsable du point de vente ou le Resp. commercial. Dans tous les cas, l'annulation produit une contre-écriture.

### AV-031 — Poids ou unité — IMPORTANTE
- **Recommandation** : le modèle supporte les deux par produit (`pricing_mode`). Au lancement, tout se vend à l'unité, avec une saisie de poids optionnelle.

### AV-032 — Vif ou abattu — IMPORTANTE — **TRANCHÉ**
- **Recommandation** : vif uniquement au MVP. L'abattage ou la transformation sera modélisé comme une opération de transformation (consommation → production), sans changer le registre de stock.
- **Décision** (porteur du projet, 27/09/2026) : Poulet **vif et abattu dès P7** : l'abattage est une transformation (consommation des poulets vifs → production de plusieurs produits : poulet entier, découpes, abats), avec rendement et pertes d'abattage ; le coût est réparti entre les produits obtenus **au prorata du poids**.

### AV-033 — Acomptes — SECONDAIRE
- **Recommandation** : autorisés. L'encaissement est affecté à la commande, puis réaffecté à la vente à la livraison.

### AV-034 — Livraison — IMPORTANTE
- **Recommandation** : pas d'entité « livraison » distincte au MVP. La vente de type `ORDER_FULFILMENT` porte le livreur, l'heure de remise et une preuve éventuelle. Une livraison partielle donne une vente partielle.

### AV-035 — Politique d'allocation — IMPORTANTE
- **Recommandation** : l'allocation est accordée explicitement par le magasinier ou le responsable du point de vente. Le stock d'un emplacement **exclusif** (stock mobile d'un commercial) est entièrement alloué à son titulaire. La libération d'un quota est confirmée par l'appareil à la synchronisation ; la révocation forcée est auditée.

### AV-036 — Traçabilité par lot — IMPORTANTE
- **Recommandation** : lot obligatoire pour les animaux vivants et propagé **automatiquement** (FIFO) jusqu'à la vente, sans action du vendeur. Lot optionnel pour les œufs (lot de ponte / date de collecte). Lot fournisseur optionnel pour les intrants.

### AV-037 — Seuils des pertes — IMPORTANTE
Politique par défaut, paramétrable :

| Catégorie | Photo requise | Validation requise |
|---|---|---|
| `CASSE`, `DETERIORATION`, `IMPROPRE` | valeur ≥ 10 000 XAF | valeur ≥ 25 000 XAF |
| `DESTRUCTION` | toujours | toujours |
| `INEXPLIQUEE`, `VOL_SUSPECTE` | non (commentaire obligatoire) | toujours |
| `MORTALITE` | voir AV-048 | voir AV-048 |

### AV-038 — Rejet d'une perte — SECONDAIRE — **TRANCHÉ**
- **Recommandation** : l'approbateur choisit entre deux issues. `ERREUR_DECLARATION` : la marchandise existe et retourne en stock. `PERTE_NON_JUSTIFIEE` : la perte est confirmée mais reclassée en perte inexpliquée imputée au déclarant ou au lieu.
- **Décision** (porteur du projet, 26/09/2026) : les deux issues sont retenues ; `PERTE_NON_JUSTIFIEE` impute la responsabilité **au déclarant** (`responsibility_user_id`) ; un rejet sans option de décision est traité comme `ERREUR_DECLARATION` (la quantité revient en stock). C'est le comportement construit en P2-04 (`loss-commands.ts`), désormais confirmé.

### AV-039 — Inventaires — SECONDAIRE
- **Recommandation** : inventaire complet mensuel recommandé par emplacement, plus inventaires ponctuels. Un écart dont la valeur absolue dépasse 25 000 XAF nécessite une validation.

### AV-040 — Seuils de réapprovisionnement — SECONDAIRE
- **Recommandation** : un couple (minimum, cible) par emplacement × produit. Aucune valeur par défaut.

### AV-041 — TVA et taxes — IMPORTANTE
- **Question** : les prix sont-ils TTC ? Certains produits sont-ils exonérés ? Des factures fiscales normalisées sont-elles nécessaires ?
- **Recommandation** : prix saisis et affichés TTC. Pas de ventilation fiscale au MVP. Les colonnes `tax_rate` et `tax_amount_xaf` sont prévues à 0 dans les lignes de vente et d'achat pour permettre l'évolution.

### AV-042 — Valorisation du stock — IMPORTANTE
- **Choix** : CMUP, FIFO, coût standard.
- **Recommandation** : CMUP perpétuel par produit, recalculé à chaque entrée valorisée. Pour les produits biologiques issus d'un lot, le coût unitaire est le coût cumulé du lot divisé par l'effectif vivant. Voir ADR-015.

### AV-043 — Composantes du coût de lot — IMPORTANTE — **TRANCHÉ**
- **Recommandation** : coûts directs uniquement au MVP : animaux ou œufs d'origine, aliments et intrants consommés, dépenses directement imputées au lot. Aucune répartition de frais généraux.
- **Décision** (porteur du projet, 27/09/2026) : Coût de lot = **coûts directs + frais généraux** de la ferme (option différente de la recommandation) : les frais généraux sont saisis comme écritures de coût sur le **site** (registre de coûts existant, relié aux dépenses en P8) et répartis **chaque mois** entre les lots actifs du site au prorata **têtes × jours**.

### AV-044 — Types de lots — IMPORTANTE — **TRANCHÉ**
- **Recommandation** : `POULET_CHAIR`, `PONDEUSE`, `PORC_ENGRAISSEMENT`. Types optionnels activables par configuration : `REPRODUCTEUR_VOLAILLE`, `PORC_NAISSAGE`.
- **Décision** (porteur du projet, 27/09/2026) : Les **cinq types** actifs dès P7 (`POULET_CHAIR`, `PONDEUSE`, `PORC_ENGRAISSEMENT`, `REPRODUCTEUR_VOLAILLE`, `PORC_NAISSAGE`) ; un lot reproducteur volaille est suivi **comme une pondeuse** (collectes), ses œufs allant surtout en œufs à couver.

### AV-045 — Naissage porcin — IMPORTANTE — **TRANCHÉ**
- **Recommandation** : hors MVP. Les porcelets entrent dans un lot par une « entrée » générique (`BIRTH`, `PURCHASE`, `TRANSFER_IN`). L'identification individuelle est une évolution future (CM §19).
- **Décision** (porteur du projet, 27/09/2026) : Naissage porcin **inclus** (conséquence d'AV-044) : lot `PORC_NAISSAGE` (truies et porcelets) ; les naissances y entrent (`BIRTH`) ; au **sevrage**, les porcelets sont transférés vers un lot d'engraissement avec leur coût.

### AV-046 — Classification des œufs — IMPORTANTE — **TRANCHÉ**
- **Recommandation** : catégories du CM §17. Plateau de 30 œufs comme unité de vente. Les œufs cassés et non conformes n'entrent pas en stock commercial. Un produit « œuf déclassé » vendable pourra être activé.
- **Décision** (porteur du projet, 27/09/2026) : Catégories du CM §17 **et calibres** : cassés et non conformes hors stock ; les œufs commercialisables sont répartis **par calibre dès la collecte** (liste de calibres paramétrable, chaque calibre étant un produit) ; plateau de 30 œufs pour la vente.

### AV-047 — Incubation — SECONDAIRE — **TRANCHÉ**
- **Recommandation** : œufs à couver issus de la production interne ou d'un achat. Durée d'incubation, jour de mirage et jour de transfert vers l'éclosoir paramétrés par espèce.
- **Décision** (porteur du projet, 27/09/2026) : Recommandation retenue : œufs à couver issus de la production interne **ou** d'un achat ; durées (mirage, transfert vers l'éclosoir, éclosion) paramétrées par espèce, sans rien bloquer.

### AV-048 — Validation de la mortalité — IMPORTANTE — **TRANCHÉ**
- **Recommandation** : une déclaration de mortalité journalière supérieure à 0,5 % de l'effectif du lot **ou** à 20 têtes exige une photo et une validation du Responsable production. En dessous, elle est enregistrée sans validation.
- **Décision** (porteur du projet, 27/09/2026) : **Toute** déclaration de mortalité exige une photo et la validation du Responsable production (option différente de la recommandation) ; les seuils restent des paramètres (réglés pour exiger la validation dès la première tête).

### AV-049 — Indicateurs zootechniques — SECONDAIRE — **TRANCHÉ**
- **Recommandation** : taux de mortalité, effectif, taux d'éclosion (CM §18), œufs commercialisables / collectés, coût par tête. Indicateurs proposés, à valider : indice de consommation, poids moyen, gain moyen quotidien, taux de ponte.
- **Décision** (porteur du projet, 27/09/2026) : Indicateurs de base **plus** indice de consommation, poids moyen et gain moyen quotidien, taux de ponte, dès P7.

### AV-050 — Suivi sanitaire — SECONDAIRE — **TRANCHÉ**
- **Recommandation** : seules les consommations de produits vétérinaires sont imputées au lot. Le plan de prophylaxie est une évolution future.
- **Décision** (porteur du projet, 27/09/2026) : Recommandation retenue : seules les consommations de produits vétérinaires sont imputées au lot (et les observations sanitaires notées) ; pas de plan de prophylaxie.

### AV-051 — Validation des achats — IMPORTANTE
- **Recommandation** : toute demande d'achat est validée par le Responsable achats ou la Direction. Un bon de commande supérieur à 500 000 XAF est approuvé par la Direction.

### AV-052 — Réception sans bon de commande — IMPORTANTE
- **Recommandation** : autorisée (achat direct au marché) avec justificatif et validation du Responsable achats après coup. Le stock entre dès la réception.

### AV-053 — Tolérances de rapprochement — SECONDAIRE
- **Recommandation** : tolérance nulle. Tout écart de quantité ou de prix entre commande, réception et facture est signalé pour validation.

### AV-054 — Quantités rejetées — SECONDAIRE
- **Recommandation** : elles n'entrent jamais en stock (CM §28). Elles sont tracées sur la réception et donnent lieu à un avoir ou une réduction sur la facture.

### AV-055 — Paiements fournisseurs — SECONDAIRE
- **Recommandation** : la Finance enregistre. La Direction approuve au-delà de 500 000 XAF. Les avances sont autorisées sous forme de paiement non affecté.

### AV-056 — Moyens de paiement — IMPORTANTE
- **Recommandation** : référentiel `ESPECES`, `MOBILE_MONEY_ORANGE`, `MOBILE_MONEY_MTN`, `VIREMENT`, `CHEQUE`. La référence de transaction mobile money est saisie manuellement et unique par moyen. Pas d'intégration API opérateur au MVP.

### AV-057 — Procédure de caisse — IMPORTANTE
- **Recommandation** :
  - une session de caisse par point de vente et par jour ;
  - ouverture avec fonds de caisse compté ;
  - clôture avec comptage ;
  - l'écart constaté est validé par la Finance ;
  - la remise des fonds se fait par transfert de caisse vers la caisse centrale ou la banque.

### AV-058 — Dépenses — SECONDAIRE
- **Recommandation** : catégories initiales `ALIMENT_HORS_STOCK`, `VETERINAIRE`, `TRANSPORT`, `CARBURANT`, `ENERGIE_EAU`, `MAIN_OEUVRE_OCCASIONNELLE`, `ENTRETIEN`, `FOURNITURES`, `DIVERS`. Justificatif photo au-delà de 10 000 XAF, validation au-delà de 50 000 XAF.

### AV-059 — Intégration comptable — SECONDAIRE
- **Recommandation** : hors MVP. Des exports structurés (ventes, encaissements, achats, dépenses, paiements) permettront une intégration ultérieure avec un logiciel comptable, référentiel SYSCOHADA à confirmer.

### AV-060 — Arrondis — SECONDAIRE
- **Recommandation** : montant de ligne = arrondi au franc (demi supérieur) de quantité × prix unitaire − remise. Le total est la somme des lignes.

### AV-061 — Dimensions tarifaires au lancement — SECONDAIRE
- **Recommandation** : le moteur supporte toutes les dimensions du PM §9. La grille initiale combine zone (ville) et point de vente.

### AV-062 — Activation des tarifs — IMPORTANTE
- **Recommandation** : une règle est créée en brouillon par le Responsable commercial ou la Direction. Seule la Direction l'active (permission `pricing.rule.activate`).

### AV-063 — Prix obsolète hors ligne — IMPORTANTE
- **Recommandation** : la vente est acceptée au prix figé sur l'appareil. L'anomalie `PRICE_MISMATCH` est créée pour revue. Aucune correction automatique du montant client.

### AV-064 — Notifications — SECONDAIRE
- **Recommandation** : notifications in-app et Web Push. SMS et WhatsApp (via Kommo) seront envisagés plus tard.

### AV-065 — Alertes — SECONDAIRE
- **Recommandation** : alertes du CM §54 avec des seuils paramétrables (valeurs initiales dans le domaine NOT).

### AV-066 — Accusé de lecture — SECONDAIRE
- **Recommandation** : option par note (`requires_ack`).

### AV-067 — Exports — SECONDAIRE
- **Recommandation** : CSV et XLSX. Chaque export est journalisé. L'export de données financières exige `analytics.export` avec un périmètre financier.

### AV-068 — Capacités Kommo — IMPORTANTE (bloquante pour la phase 10 uniquement)
- **Question** : quel abonnement Kommo ? Quels pipelines et statuts ? Quels champs personnalisés ? Webhooks disponibles ? Limites de débit de l'API ?
- **Recommandation** : intégration via l'API REST de Kommo et ses webhooks, à vérifier sur le compte réel avant la phase 10.

### AV-069 — Création de client depuis Kommo — IMPORTANTE
- **Recommandation** : un client GIC est créé (ou rapproché par téléphone) quand un lead Kommo atteint un statut configuré, par exemple « Qualifié – à commander ».

### AV-070 — Données GIC → Kommo — SECONDAIRE
- **Recommandation** : statut client, nombre de commandes, CA cumulé, dernière commande, commercial responsable (CM §46).

### AV-071 — Utilisateurs Kommo — SECONDAIRE
- **Recommandation** : table de correspondance explicite entre utilisateurs GIC et Kommo, administrée par l'Admin.

### AV-072 — Reprise de données — IMPORTANTE
- **Recommandation** : modèles CSV d'import pour clients, fournisseurs, produits et lots en cours. Le stock initial est chargé par un **inventaire d'ouverture** (`OPENING`), donc tracé comme n'importe quel mouvement.

### AV-073 — Hébergement et données personnelles — IMPORTANTE — **TRANCHÉ**
- **Décision** (confirmée par le porteur du projet) : hébergement chez **Hostinger**, **sans VPS**. Base de données MySQL (conséquence : [ADR-023](decisions/ADR-023-mysql.md)) ; calcul et hébergement du domaine chez le même fournisseur ([ADR-024](decisions/ADR-024-hebergement-hostinger.md)). Région : celle proposée par Hostinger ; vérification de la conformité à la réglementation camerounaise sur les données personnelles toujours à la charge de GIC, au moment du déploiement.
- **Ce qui reste ouvert** : la modalité précise d'exécution du serveur Node.js (AV-090) et le fournisseur de stockage objet (AV-091), aucun des deux ne bloquant le développement (voir [ADR-024](decisions/ADR-024-hebergement-hostinger.md) §5).
- **Chiffrement** : au repos et en transit, selon l'offre retenue — à vérifier au déploiement.

### AV-074 — Conservation — SECONDAIRE
- **Recommandation** : journal d'audit et pièces financières conservés 10 ans. Positions GPS conservées 2 ans. Photos conservées 5 ans.

### AV-075 — Parc d'appareils — IMPORTANTE
- **Recommandation** : Android 8 ou plus, Chrome 100 ou plus, 2 Go de RAM, 1 Go de stockage libre pour l'application.

### AV-076 — Impression de reçus — SECONDAIRE
- **Recommandation** : hors MVP. Reçu affiché à l'écran et partageable.

### AV-077 — Numérotation des documents — SECONDAIRE
- **Recommandation** : numéro officiel attribué par le serveur, `{TYPE}-{CODE_SITE}-{AAAA}-{seq6}`. Référence locale attribuée sur l'appareil, `{CODE_APPAREIL}-{seq}`. Voir ADR-002.

### AV-078 — Saisie rétroactive — IMPORTANTE
- **Recommandation** : `occurred_at` peut précéder l'heure de création sur l'appareil d'au plus 72 h. Au-delà de 24 h, une justification est obligatoire et l'opération est signalée. Au-delà de 72 h, la saisie est refusée, sauf si une validation l'autorise.

### AV-079 — Langues — SECONDAIRE
- **Recommandation** : interface en français, architecture i18n prête pour l'anglais.

### AV-080 — Conditionnements — SECONDAIRE
- **Recommandation** : unités de conditionnement configurables par produit, avec un facteur de conversion vers l'unité de base (sac, plateau, carton).

### AV-081 — Validation des transferts — SECONDAIRE
- **Recommandation** : pas de validation préalable. Une demande de réapprovisionnement d'un point de vente est acceptée implicitement quand le magasin expédie.

### AV-082 — Écarts de transfert — SECONDAIRE
- **Recommandation** : un écart entre quantité expédiée et quantité reçue est une perte en transit. Il exige une justification et une validation par le responsable du site expéditeur ou la Direction.

### AV-083 — Produit désactivé hors ligne — SECONDAIRE
- **Recommandation** : la vente est acceptée (c'est un fait accompli) et signalée à la revue.

### AV-084 — Équipe et budget — IMPORTANTE
- **Recommandation** : l'architecture est dimensionnée pour une petite équipe (1 à 3 développeurs) et des services managés. Aucun composant nécessitant une équipe d'exploitation dédiée.

### AV-085 — Frais de livraison — SECONDAIRE
- **Recommandation** : produit de type `SERVICE` optionnel, facturé en ligne de vente, sans effet sur le stock.

### AV-086 — Volumétrie cible — IMPORTANTE
- **Question** : combien d'utilisateurs, de sites, de ventes par jour, de clients et de lots actifs à 3 ans ?
- **Pourquoi** : dimensionnement des projections analytiques, du partitionnement des registres et des jeux de données téléchargés hors ligne.
- **Recommandation** : hypothèse H-06 : ≤ 150 utilisateurs, ≤ 40 sites et points de vente, ≤ 5 000 lignes de vente par jour, ≤ 20 000 clients et prospects, ≤ 200 lots actifs.
- **Impact** : au-delà de 10 fois ces valeurs, revoir la stratégie analytique (ADR-011 §évolutions).

### AV-087 — Prix à la livraison d'une commande — SECONDAIRE
- **Question** : si le tarif change entre la commande et la livraison, quel prix s'applique ?
- **Choix** : (a) prix convenu à la commande ; (b) prix du jour de livraison ; (c) le plus favorable au client.
- **Recommandation** : (a). La commande est un engagement : le prix convenu est figé sur la ligne de commande (BR-VEN-003, BR-VEN-007).
- **Impact** : moteur de prix à la livraison ; indicateur d'écart entre prix convenu et prix du jour.

### AV-088 — Clôture de période — SECONDAIRE
- **Question** : faut-il verrouiller les mois clôturés pour interdire toute écriture datée d'une période close ?
- **Choix** : (a) pas de verrouillage ; (b) verrouillage mensuel par la Finance, avec les écritures tardives redatées au premier jour de la période ouverte ; (c) verrouillage avec dérogation.
- **Recommandation** : (a) au MVP. La fenêtre de saisie rétroactive (AV-078), l'immuabilité des sessions de caisse validées et le principe des contre-écritures datées de leur propre `occurred_at` suffisent. (b) sera nécessaire avec une intégration comptable (AV-059).
- **Impact** : règles de datation des écritures tardives ; rapports financiers.


### AV-089 — Confirmation de la stack technique — IMPORTANTE — **TRANCHÉ**
- **Décision** (confirmée par le porteur du projet) : la stack recadrée est retenue telle que documentée dans [`05-architecture/05-stack.md`](05-architecture/05-stack.md) et [ADR-021](decisions/ADR-021-stack-technique.md) : TypeScript de bout en bout, monorepo `apps/pwa` + `apps/server` + `packages/domain` + `packages/contracts` (React + Vite + Workbox + Dexie côté appareil ; NestJS/Fastify + Kysely côté serveur), **MySQL 8 ≥ 8.0.19** (ADR-023, remplace PostgreSQL). Ce n'était pas un choix entre plusieurs options (l'alternative « serveur dans un autre langage » aurait imposé deux implémentations de `packages/domain`, contraire à K1) : la proposition de fin de cadrage est retenue sans réserve.
- **Impact** : **P0 démarre.** Un changement de framework (React → Preact, NestJS → Fastify seul) ne remettrait pas en cause l'architecture ; un changement de langage serveur la remettrait en cause (nouvel ADR).

### AV-090 — Modalité d'exécution du serveur Node.js chez Hostinger sans VPS — IMPORTANTE
- **Question** : comment le processus API et le processus worker (Node.js) s'exécutent-ils concrètement chez Hostinger, qui n'offre pas de VPS ?
- **Pourquoi** : conditionne le format de l'artefact de build (image de conteneur ou paquet Node.js) et la façon dont le worker exécute ses tâches planifiées (processus persistant ou invocation périodique par une tâche cron de l'hébergeur).
- **Choix** : (a) offre Hostinger d'exécution d'applications Node.js, si elle couvre un processus de fond persistant ou une invocation cron suffisamment fréquente pour le worker ; (b) plateforme tierce à bas coût, sans VPS, uniquement pour le calcul (API + worker), la base restant chez Hostinger ; (c) repli vers un VPS, en dernier recours, si (a) et (b) s'avèrent impraticables — **à proposer explicitement à la Direction avant d'être retenu**, la contrainte « sans VPS » étant ferme.
- **Recommandation** : (a), avec le worker adapté en invocation périodique (cron) plutôt qu'en processus persistant si nécessaire — adaptation sans effet sur le modèle de données ni la logique métier.
- **Impact** : aucun sur P0 à P3 (développement entièrement local, [ADR-024](decisions/ADR-024-hebergement-hostinger.md) §5). Détermine le contenu de l'étape « Build » de la CI/CD et la configuration de l'environnement `staging`.

### AV-091 — Fournisseur de stockage objet S3-compatible — SECONDAIRE
- **Question** : quel fournisseur héberge les pièces jointes (photos, justificatifs, exports) puisque Hostinger sans VPS n'expose pas de produit de stockage objet ?
- **Pourquoi** : ADR-012 (pièces jointes offline) suppose un stockage S3-compatible, privé, avec URL signées et verrou d'objet pour les ancres d'audit.
- **Choix** : (a) Cloudflare R2 ; (b) Backblaze B2 ; (c) AWS S3.
- **Recommandation** : (a) ou (b), pour le coût au volume attendu (~30 Go la première année).
- **Impact** : aucun sur P0 à P3 (émulateur S3 local, ex. MinIO, en développement et en CI). Détermine les identifiants de service à provisionner avant le déploiement de `staging`.

### AV-092 — Permissions sensibles (audit renforcé, revue d'attribution) — IMPORTANTE
- **Question** : parmi les 117 permissions du catalogue ([`07-security-rbac/01-rbac.md`](07-security-rbac/01-rbac.md) §5), lesquelles doivent porter `identity.permissions.is_sensitive = true` — colonne qui « déclenche un audit renforcé et une revue d'attribution » ([`03-data/dictionnaire/01-identity.md`](03-data/dictionnaire/01-identity.md)) ?
- **Pourquoi** : la matrice RBAC documente `max_scope`, `is_approval` (préfixe `A·`) et les `limits` pour chaque permission, mais ne renseigne `is_sensitive` nulle part — ni dans la matrice, ni ailleurs dans `docs/`. Le mécanisme le plus proche déjà spécifié, RC-05 (masquage des colonnes financières sans `inventory.valuation.read`), est une permission *additionnelle* requise à la lecture, pas le marqueur `is_sensitive` (qui gouverne l'audit et la revue périodique, un mécanisme distinct).
- **Choix** : (a) `false` partout (aucune permission désignée, statu quo jusqu'à décision) ; (b) `true` pour les permissions financières et de valorisation (`inventory.valuation.read`, `finance.*`, `sales.price.override`…) ; (c) `true` pour toute permission `is_approval = true` (les 19 permissions d'approbation) ; (d) une liste que la Direction arrête explicitement.
- **Recommandation** : (a) pour démarrer — le défaut du schéma (`DEFAULT FALSE`) ne réduit aucune garantie déjà accordée ailleurs (RC-05 reste actif indépendamment), et évite de figer une liste non demandée par une source.
- **Impact** : aucun sur P0 (le seed RBAC, `db/seeds/rbac-data.ts`, fonctionne avec `false` partout). Détermine, quand tranché, les permissions couvertes par la revue d'attribution périodique et l'audit renforcé (mécanisme à spécifier séparément si (b), (c) ou (d) est retenu).

### AV-093 — Permission gouvernant `attachments.attachment.register` — SECONDAIRE
- **Question** : quelle permission RBAC gouverne `attachments.attachment.register` (SM-ATTACHMENT, [`04-workflows/machines-a-etats/06-transverses.md`](04-workflows/machines-a-etats/06-transverses.md)) ?
- **Pourquoi** : la machine à états documente « Permission de l'opération » — c'est-à-dire la permission du document propriétaire (ex. `inventory.loss.declare` pour joindre une photo à une déclaration de perte), pas une permission propre à `attachments`. Or `CommandHandlerRegistry.register()` (P0-06) n'accepte qu'un **seul `permissionCode` statique** par `(command_type, version)`, connu à l'enregistrement — jamais résolu dynamiquement à partir du `payload` reçu. Comme aucun module propriétaire (`inventory`, `procurement`, `sales`…) n'existe encore en P0 (tous en P2 ou après), il n'y a rien de concret vers quoi déléguer cette résolution : ni permission déjà définie pour « joindre une pièce à n'importe quelle opération », ni mécanisme de résolution dynamique par `owner_type` dans le registre actuel.
- **Choix** : (a) une permission générique `attachments.attachment.manage`, accordée à tous les rôles opérationnels (portée `OWN`), qui gouverne l'enregistrement quel que soit `owner_type` — la permission propre au document (ex. `inventory.loss.declare`) reste vérifiée séparément par le module propriétaire au moment où il crée ce document, dans son propre gestionnaire ; (b) étendre `CommandHandlerRegistry` pour accepter un résolveur de permission dynamique (fonction du payload) au lieu d'un code statique — changement de la signature établie en P0-06, à ne faire que si un besoin réel l'exige (aucun aujourd'hui) ; (c) laisser chaque futur module propriétaire enregistrer son propre `command_type` d'enregistrement de pièce jointe (ex. `inventory.loss_attachment.register`) plutôt qu'un `attachments.attachment.register` générique — démultiplie les points d'entrée pour une même table.
- **Recommandation** : (a) — la vérification RC-01 de `attachments.attachment.register` reste un filtre existence-seule générique (comme tout `command_type`, RC-01 tel que P0-06 l'a posé) ; elle n'empêche ni ne remplace la vérification, par le module propriétaire, que l'auteur avait bien le droit de créer *le document* auquel la pièce est jointe. Un rôle qui ne peut créer aucune opération contrôlée n'a aucune raison de détenir `attachments.attachment.manage` non plus (à retirer alors du seed).
- **Impact** : aucun sur la correction de P0 (permission nouvelle, ajoutée au catalogue et au seed comme n'importe quelle autre ; RBAC généré depuis le seed reste la source unique). À revisiter quand un premier module propriétaire (P2, `inventory`) existe réellement, pour confirmer que la portée `OWN` générique suffit ou si RC-04 exige un filtrage plus fin par `owner_type`.

### AV-094 — Permission de lecture des documents de stock — SECONDAIRE — **TRANCHÉ**
- **Décision** (porteur du projet, 26/09/2026) : quiconque a la capacité de voir les pertes les lit **dans son périmètre**, mais cette capacité est réservée à l'**encadrement** (« secret administratif ») : une vendeuse qui déclare une perte ne doit pas voir les pertes déclarées par ses collègues. Traduction dans la matrice (seed `db/seeds/rbac-data.ts`, portées DÉDUITES de la décision et de la portée d'approbation existante de chaque rôle) : nouvelle permission `inventory.loss.read` — Direction ALL, responsable commercial ZONE, responsable de production ALL, responsable de ferme SITE, magasinier SITE, finance ALL ; vendeur PDV et commercial terrain OWN (leurs propres déclarations seulement) ; administrateur technique, commercial sédentaire, achats : aucune. Les autres documents (transferts, consommations, inventaires, seuils) restent sous `inventory.stock.read`. Conséquence technique appliquée en même temps : une demande de validation (qui résume l'opération, dont les pertes) ne descend hors ligne que sur l'appareil de son demandeur (projection `APPROVAL_REQUEST`, jeu `comms`), plus jamais vers tous les appareils.
- **Question** : quelle permission gouverne la consultation des transferts, des déclarations de perte, des consommations, des inventaires et des seuils (`GET /transfers`, `/losses`, `/consumptions`, `/inventory-counts`, `/thresholds`) ?
- **Pourquoi** : la matrice RBAC ([`07-security-rbac/01-rbac.md`](07-security-rbac/01-rbac.md) §5.3) définit `inventory.stock.read` (soldes), `inventory.ledger.read` (registre) et `inventory.valuation.read` (montants), mais aucune permission de lecture propre à ces documents. Or une déclaration de perte peut porter une catégorie sensible (`VOL_SUSPECTE`, `INEXPLIQUEE`) et, après un rejet `PERTE_NON_JUSTIFIEE`, une responsabilité imputée à une personne (AV-038) : la lire n'est pas anodin pour un vendeur de PDV qui voit le stock de son site.
- **Choix** : (a) `inventory.stock.read`, à la portée de l'emplacement du document ; (b) une permission de lecture par document (`inventory.transfer.read`, `inventory.loss.read`…) ajoutée à la matrice et au seed ; (c) (a) pour tous les documents sauf les pertes, lisibles seulement avec `inventory.loss.declare` (ses propres déclarations) ou `inventory.loss.approve`.
- **Recommandation** : (a) pour démarrer — c'est ce qui est implémenté en P2-05 (`apps/server/src/inventory-api/inventory-read.controller.ts`) : aucun droit n'est élargi au-delà de la portée de stock déjà accordée, et les montants restent masqués sans `inventory.valuation.read` (RC-05). (c) si la Direction juge que les pertes imputées doivent rester confidentielles au sein d'un site.
- **Impact** : une seule constante par route dans le contrôleur de lecture (et, pour (b), des permissions nouvelles au catalogue, au seed et dans la matrice). Aucun effet sur les commandes d'écriture ni sur le jeu hors ligne (qui ne transporte pas les pertes).

### AV-095 — Réception hors ligne dépassant le reliquat d'un BC — SECONDAIRE — **TRANCHÉ**
- **Question** : une réception saisie hors ligne dont l'acceptation cumulée dépasse le reliquat de la ligne de bon de commande (au-delà de la tolérance, AV-053) doit-elle être **mise en quarantaine** (aucun effet stock jusqu'à décision) ou **appliquée**, l'excédent partant en revue ?
- **Pourquoi** : deux règles du référentiel se recouvrent sans se trancher. BR-APP-010 : « Hors ligne, la réception est appliquée et l'excédent part en revue (`OVER_RECEIPT`) ». BR-APP-012 et D08 §14 : une réception dont « l'acceptation cumulée > commandée pour une réception concurrente hors ligne » est mise en `QUARANTINED`, sans effet stock (« la seconde passe en quarantaine si elle dépasse le reliquat »). Le serveur ne sait pas distinguer une livraison excédentaire unique d'une double saisie concurrente du même BC.
- **Choix** : (a) quarantaine de toute réception hors ligne excédentaire ; (b) application, excédent tracé (`excess_qty_base`) et conflit informatif `OVER_RECEIPT` ; (c) (a) si une autre réception du même BC a été comptabilisée après l'heure métier de celle-ci, (b) sinon.
- **Recommandation** : (a) — aucune entrée de stock fantôme possible (PM §30 « réception en double »), la décision du responsable des achats comptabilise la réception réelle. C'est la valeur par défaut, **paramétrable** (`procurement.offline_over_receipt_mode` = `QUARANTINE` ; `APPLY_WITH_REVIEW` pour (b)) — les deux modes sont implémentés (P6-05).
- **Impact** : paramètre système seul ; aucun changement de schéma. En ligne, la réception excédentaire reste refusée (`OVER_RECEIPT`) dans les deux cas (BR-APP-010).
- **Décision** (porteur du projet, 27/09/2026) : Défaut confirmé : une réception hors ligne dépassant le reliquat passe en **quarantaine** (`procurement.offline_over_receipt_mode` = `QUARANTINE`).

### AV-096 — Dérogation d'emplacement de réception — SECONDAIRE — **TRANCHÉ**
- **Question** : D08 §8 admet une réception sur un emplacement hors du site de livraison du bon de commande « ou dérogation motivée ». Qui accorde cette dérogation (le magasinier par un motif saisi, ou le responsable des achats par une validation), et la réception compte-t-elle alors pour le reliquat du BC ?
- **Pourquoi** : aucune règle ne décrit la dérogation (ni rôle, ni politique de contrôle, ni colonne de motif au dictionnaire). L'ouvrir sans cadre permettrait de faire entrer du stock commandé pour un site dans un autre site sans contrôle.
- **Choix** : (a) pas de dérogation : `RECEIPT_LOCATION_INVALID`, la marchandise est réceptionnée au site du BC puis transférée (D06) ; (b) dérogation par motif saisi à la réception (colonne `location_override_reason` à ajouter), tracée à l'audit ; (c) dérogation soumise à validation (`RECEIPT_LOCATION_OVERRIDE`, politique de contrôle), stock entré à la validation.
- **Recommandation** : (a) tant que le besoin n'est pas avéré — le transfert conserve la traçabilité complète (transit, écarts) ; (b) si des livraisons directes vers un autre site sont courantes. Défaut implémenté (P6-05) : (a).
- **Impact** : (b) ou (c) : une colonne et une règle dans `procurement.receipt.record` ; aucun effet sur le registre de stock.
- **Décision** (porteur du projet, 27/09/2026) : Réception hors du site de livraison du BC **autorisée après validation** du responsable des achats (option c) : la réception attend la décision et le stock entre à la validation ; à construire en reprise de P6.

### AV-097 — Coût par tête d'un lot après les sorties — IMPORTANTE — **TRANCHÉ**
- **Question** : le coût par tête d'un lot se calcule-t-il sur le coût cumulé ou sur le coût restant après les sorties (ventes, abattage, sevrage) ?
- **Pourquoi** : la formule écrite (BR-PRD-012, ADR-015, stratégies stock §9 et finance §6.1 : « coût cumulé ÷ effectif non vendu ») réimpute aux têtes restantes le coût des têtes déjà sorties : sur l'exemple de la stratégie finance, le coût des ventes dépasse le coût du lot de 43 %.
- **Choix** : (a) coût restant (coût du lot moins la valeur déjà sortie) ÷ têtes restantes ; (b) moyenne figée ; (c) formule écrite.
- **Impact** : ADR-027 ; BR-PRD-012 ; `inventory` (valorisation des sorties d'un lot biologique).
- **Décision** (porteur du projet, 28/09/2026) : **coût restant** (option a) : coût par tête = (Σ écritures de coût du lot − Σ valeurs figées des sorties définitives) ÷ effectif non vendu ; la mortalité et les écarts d'inventaire ne réduisent pas le coût restant (ils le répartissent sur moins de têtes, BR-PRD-013) ; la dernière sortie emporte le coût restant exact

### AV-098 — Valeur des productions des lots reproducteurs — IMPORTANTE — **TRANCHÉ**
- **Question** : quelle valeur donner aux œufs des pondeuses et reproducteurs et aux porcelets nés du naissage ?
- **Pourquoi** : les lots qui produisent n'avaient aucune règle de partage du coût entre les reproducteurs et leur production (BR-OEU-007 ne parlait que du coût standard des œufs).
- **Choix** : (a) coût standard du produit, le lot producteur est crédité d'autant ; (b) coût réel du mois ÷ unités produites ; (c) porcelets porteurs des coûts d'exploitation.
- **Impact** : ADR-027 ; écritures de coût (sens `CREDIT` de production transférée) ; coûts standard par produit (dont calibres).
- **Décision** (porteur du projet, 28/09/2026) : **coût standard + crédit** (option a) : chaque œuf ou porcelet produit entre en stock au coût standard en vigueur de son produit ; le lot producteur reçoit un crédit du même montant ; l'écart entre coût réel et standard reste dans le résultat du lot producteur

### AV-099 — Lots à plusieurs produits (truies, verrats, porcelets ; poules et coqs) — IMPORTANTE — **TRANCHÉ**
- **Question** : comment gérer un lot qui contiendrait plusieurs produits biologiques ?
- **Pourquoi** : BR-PRD-001 donne un seul produit à un lot, alors qu'un naissage réunit truies, verrats et porcelets et qu'un lot reproducteur réunit poules et coqs.
- **Choix** : (a) produit principal + produits autorisés ; (b) un lot par produit, liés ; (c) produit mixte unique.
- **Impact** : `production_lots` : lien facultatif vers un lot parent (bande) ; effectif et indicateurs par lot.
- **Décision** (porteur du projet, 28/09/2026) : **un lot par produit** (option b) : chaque lot garde un seul produit biologique (BR-PRD-001 inchangée) ; les lots d'une même bande (truies, verrats, porcelets ; poules, coqs) sont liés entre eux

### AV-100 — Lot de stock des œufs collectés et des produits d’abattage — IMPORTANTE — **TRANCHÉ**
- **Question** : les œufs d'une collecte et les produits d'un abattage partagent-ils le lot de stock du lot de production ?
- **Pourquoi** : si oui, la clôture du lot d'animaux rend ses œufs et découpes restants invendables (sélection FIFO limitée aux lots ouverts) et INV-PRD-02 interdit tout mouvement après la clôture.
- **Choix** : (a) lot propre par collecte et par abattage, rattaché au lot de production ; (b) même lot.
- **Impact** : `inventory.stock_lots` (origines), FEFO, attribution du CA au lot de production par l'origine.
- **Décision** (porteur du projet, 28/09/2026) : **lot propre, rattaché** (option a) : chaque collecte crée un lot de stock d'origine `COLLECTION`, chaque abattage un lot d'origine transformation, avec date de péremption, rattachés au lot de production ; la clôture du lot d'animaux reste indépendante

### AV-101 — Lieu et acteur de l'abattage — IMPORTANTE — **TRANCHÉ**
- **Question** : où et par qui se fait l'abattage des poulets (AV-032) ?
- **Pourquoi** : aucun type d'emplacement ni aucun acteur n'était défini pour l'abattage.
- **Choix** : (a) à la ferme, emplacement « abattoir », Resp. ferme ; (b) abattoir prestataire ; (c) au point de vente.
- **Impact** : type d'emplacement `SLAUGHTERHOUSE` ; commande d'abattage sous `production.daily.record`.
- **Décision** (porteur du projet, 28/09/2026) : **à la ferme** (option a) : emplacement dédié de la ferme, saisie par le Responsable ferme (hors ligne possible), produits entrés au stock de la ferme

### AV-102 — Unités et vente des produits d'abattage — IMPORTANTE — **TRANCHÉ**
- **Question** : comment se comptent et se vendent le poulet abattu, les découpes et les abats ?
- **Pourquoi** : l'abattage produit plusieurs produits ; leur unité de base conditionne la saisie et le prix (AV-031 ouvert pour le vif).
- **Choix** : (a) entier à la pièce, découpes et abats au kilo ; (b) tout au kilo ; (c) tout à la pièce.
- **Impact** : référentiel produits ; poids obligatoire à l’abattage (clé de répartition, AV-032).
- **Décision** (porteur du projet, 28/09/2026) : **entier à la pièce** (poids enregistré à l'abattage), **découpes et abats au kilo** (option a)

### AV-103 — Saisie des frais généraux de ferme — IMPORTANTE — **TRANCHÉ**
- **Question** : qui enregistre les frais généraux d'une ferme en attendant le module finance ?
- **Pourquoi** : seule la Finance détient `inventory.cost_entry.record`, sans commande construite.
- **Choix** : (a) Finance + Resp. production ; (b) Finance seule ; (c) Finance, Resp. production et Resp. ferme pour sa ferme.
- **Impact** : RBAC : `inventory.cost_entry.record` accordée à RESP_PRODUCTION (ALL) et RESP_FERME (SITE).
- **Décision** (porteur du projet, 28/09/2026) : **Finance, Responsable production et Responsable ferme pour sa propre ferme** (option c), en ligne, tracés à l'audit

### AV-104 — Frais généraux séparés par espèce — IMPORTANTE — **TRANCHÉ**
- **Question** : la répartition têtes × jours mélange-t-elle les espèces (un poussin pesant autant qu'une truie) ?
- **Pourquoi** : dans une ferme mixte, la volaille absorberait presque tous les frais.
- **Choix** : coefficient par type, aucune pondération, poids vif ; puis niveau de séparation et traitement des frais communs.
- **Impact** : ADR-026 amendé ; écritures de frais généraux portant une espèce.
- **Décision** (porteur du projet, 28/09/2026) : réponse du porteur : « la répartition doit être spécifique à chaque espèce, il ne faut pas mélanger les coûts ». Précisions retenues : deux ensembles **volaille** (chair, pondeuses, reproducteurs) et **porc** (engraissement, naissage) ; chaque frais est rattaché à une espèce ; un frais commun est **ventilé à la saisie** par montant par espèce ; chaque ensemble est réparti entre les lots de son espèce au prorata têtes × jours

### AV-105 — Lot clôturé en cours de mois — IMPORTANTE — **TRANCHÉ**
- **Question** : un lot clôturé en cours de mois reçoit-il sa part des frais généraux de ce mois ?
- **Pourquoi** : la répartition se fait après la fin du mois, alors que la clôture fige le résultat du lot.
- **Choix** : (a) oui, après clôture ; (b) non, lots actifs seuls ; (c) part estimée à la clôture.
- **Impact** : ADR-026 amendé ; clôture de lot.
- **Décision** (porteur du projet, 28/09/2026) : **part estimée à la clôture** (option c) : à la clôture, le lot reçoit une part calculée sur les frais déjà connus du mois de son espèce et les têtes × jours écoulés ; la répartition du mois exclut ensuite ce lot et ce montant

### AV-106 — Moment de la répartition et frais tardifs — SECONDAIRE — **TRANCHÉ**
- **Question** : quand la répartition mensuelle est-elle faite, et que deviennent les frais saisis en retard ?
- **Pourquoi** : ADR-026 renvoyait ces règles à un « D07 §15 » inexistant.
- **Choix** : (a) le 8 du mois suivant, retard au mois suivant ; (b) le 1er, retard régularisé ; (c) à la demande.
- **Impact** : commande `production.overhead.allocate` ; aucun ordonnanceur requis.
- **Décision** (porteur du projet, 28/09/2026) : **à la demande** (option c) : la Finance ou le Responsable production lance la répartition d'un mois pour une ferme et une espèce ; un frais saisi après donne une **régularisation** du même mois (nouvelle exécution sur le montant non réparti), jamais une réécriture

### AV-107 — Mortalité reçue sans photo — IMPORTANTE — **TRANCHÉ**
- **Question** : une mortalité arrive sans photo alors que la photo est obligatoire (AV-048) : que faire ?
- **Pourquoi** : hors ligne, un fait accompli n'est jamais rejeté (BR-SYN-007).
- **Choix** : (a) enregistrée, validation bloquée jusqu'à la photo ; (b) commentaire si photo impossible ; (c) rejet.
- **Impact** : pièces jointes de la déclaration consultées à la décision (et non figées dans la demande).
- **Décision** (porteur du projet, 28/09/2026) : **enregistrée, validation bloquée** (option a) : la perte est enregistrée en attente ; aucune décision n'est possible tant qu'une photo n'est pas jointe après coup

### AV-108 — Écarts d’inventaire sur des animaux — IMPORTANTE — **TRANCHÉ**
- **Question** : un inventaire de bâtiment en baisse pourrait contourner la validation systématique des mortalités.
- **Pourquoi** : les inventaires suivent aujourd'hui la politique `INVENTORY_ADJUSTMENT` (seuil, validation possible par le Resp. ferme).
- **Choix** : (a) validation du Resp. production pour tout écart sur des produits biologiques ; (b) règles actuelles.
- **Impact** : `inventory` : inventaires comportant des produits biologiques.
- **Décision** (porteur du projet, 28/09/2026) : **validation du Responsable production** (option a) pour tout écart d'inventaire portant sur des produits biologiques

### AV-109 — Lots permanents (pondeuses, reproducteurs, truies) — IMPORTANTE — **TRANCHÉ**
- **Question** : comment suivre le résultat et les ventes des lots qui vivent des mois et vendent en continu ?
- **Pourquoi** : BR-PRD-010 (vente directe seulement en statut `SELLING`) et un résultat unique à la clôture ne conviennent pas aux lots permanents.
- **Choix** : (a) résultat mensuel, vente autorisée par produit ; (b) comme les autres lots.
- **Impact** : lectures de lot (résultat par mois) ; P4 (règle de vente).
- **Décision** (porteur du projet, 28/09/2026) : **résultat mensuel** (option a) en plus du résultat à la clôture ; la vente des productions (œufs, réformes, porcelets) est autorisée par produit, sans passer le lot en `SELLING`

### AV-110 — Nombre de collectes d’œufs par jour — SECONDAIRE — **TRANCHÉ**
- **Question** : une ou plusieurs collectes par jour et par lot ?
- **Pourquoi** : BR-OEU-004 imposait une collecte consolidée par jour, en tension avec BR-SYN-007 (une seconde saisie hors ligne ne peut pas être rejetée).
- **Choix** : (a) plusieurs collectes par jour, chacune équilibrée ; (b) une seule, doublon en quarantaine.
- **Impact** : BR-OEU-004 remplacée ; pas d’unicité (lot, date).
- **Décision** (porteur du projet, 28/09/2026) : **plusieurs collectes par jour** (option a), chacune équilibrée séparément ; aucune n'est rejetée comme doublon

### AV-111 — Organisation du naissage porcin — IMPORTANTE — **TRANCHÉ**
- **Question** : avec un lot par produit (AV-099), comment s'organise le naissage ?
- **Pourquoi** : AV-045 place les naissances dans le lot de naissage puis un sevrage vers l'engraissement.
- **Choix** : (a) lot truies (et lot verrats) + lot porcelets lié ; (b) naissances directement en engraissement.
- **Impact** : types `PORC_NAISSAGE` (truies, porcelets) ; entrées `BIRTH` et transfert de sevrage.
- **Décision** (porteur du projet, 28/09/2026) : **lot truies + lot porcelets** (option a) : les naissances entrent dans un lot « porcelets » lié au lot de truies, au coût standard du porcelet (crédit du lot truies, AV-098) ; au sevrage, les porcelets sont transférés vers un lot d'engraissement avec leur coût (coût restant, AV-097)

### AV-112 — Mise en place par achat direct — SECONDAIRE — **TRANCHÉ**
- **Question** : la mise en place d'animaux achetés se saisit-elle en une ou deux opérations ?
- **Pourquoi** : BR-PRD-004 prévoit « réception et reclassement dans la même transaction », sans API de réception publique dans `procurement`.
- **Choix** : (a) une seule opération ; (b) deux étapes.
- **Impact** : API publique de réception à exposer par `procurement`.
- **Décision** (porteur du projet, 28/09/2026) : **une seule opération** (option a) depuis l'écran de mise en place : réception du bon de commande et entrée dans le lot ensemble ; le BC doit être livré sur la ferme du lot

### AV-113 — Mortalité des poussins avant mise en place — SECONDAIRE — **TRANCHÉ**
- **Question** : des poussins éclos meurent à l'éclosoir avant toute mise en place : comment le déclarer ?
- **Pourquoi** : la contrainte « `production_lot_id` requis si `MORTALITE` » empêchait une mortalité rattachée à un lot d'incubation.
- **Choix** : (a) mortalité du lot d'incubation ; (b) perte simple.
- **Impact** : `inventory.loss_declarations` : mortalité rattachée à un lot de production ou d’incubation.
- **Décision** (porteur du projet, 28/09/2026) : **mortalité du lot d'incubation** (option a), avec photo et validation comme toute mortalité

### AV-114 — Carcasses saisies et frais d'abattage — SECONDAIRE
- **Question** : que deviennent les têtes saisies (condamnées) à l'abattage et les frais propres de l'abattage (sachets, main-d'œuvre) ?
- **Pourquoi** : AV-032 ne les traite pas.
- **Choix** : (a) saisies consommées sans produit, leur coût porté par les produits ; frais d'abattage = dépense directe du lot ; (b) saisies déclarées en perte ; (c) objet de coût d'abattage distinct.
- **Recommandation** : (a).
- **Impact** : indicateur de taux de saisie ; aucune perte de stock.

### AV-115 — Abattage des réformes et des porcs — SECONDAIRE
- **Question** : l'abattage s'étend-il aux poules de réforme, aux reproducteurs et aux porcs ?
- **Pourquoi** : AV-032 vise le poulet de chair.
- **Choix** : (a) hors P7, abattage activable par type de lot (paramètre) ; (b) dès P7.
- **Recommandation** : (a).
- **Impact** : paramètre des types de lot abattables.

### AV-116 — Définition des indicateurs zootechniques — SECONDAIRE
- **Question** : quelles définitions exactes pour l'indice de consommation, le GMQ, le poids initial, le taux de ponte et le taux de mortalité (AV-049) ?
- **Pourquoi** : aucun document ne les définit (D11 §7.1 est muet).
- **Choix** : variantes : IC économique (hors morts) ou technique ; poids initial pesé ou standard ; taux de ponte sur l'effectif du début de jour ou moyen ; mortalité ÷ effectif initial ou ÷ (initial + entrées).
- **Recommandation** : IC hors morts (aliment en kg ÷ gain de poids vif) ; poids initial = pesée à la mise en place, sinon poids standard paramétré par produit ; taux de ponte ÷ effectif en élevage au début du jour ; mortalité cumulée ÷ (effectif initial + entrées) (KPI-PRD-03).
- **Impact** : `packages/domain` ; lectures de lot.

### AV-117 — Journée sans événement (« RAS ») — SECONDAIRE
- **Question** : comment dire qu'une journée d'un lot s'est déroulée sans mortalité ni consommation ?
- **Pourquoi** : l'alerte `DAILY_ENTRY_MISSING` (P9) se déclencherait à tort.
- **Choix** : (a) observation « RAS » ; (b) commande dédiée ; (c) rien.
- **Recommandation** : (a).
- **Impact** : alertes P9.

### AV-118 — Reclassement d'œufs — SECONDAIRE
- **Question** : comment reclasser des œufs (à couver vers consommation, changement de calibre, œufs à couver trop vieux) ?
- **Pourquoi** : aucune opération prévue.
- **Choix** : (a) opération de reclassement (`PRODUCTION_INPUT` + `PRODUCTION_OUTPUT`) avec motif ; (b) perte puis nouvelle collecte.
- **Recommandation** : (a).
- **Impact** : nouvelle commande de production.

### AV-119 — Mortalité constatée hors élevage — SECONDAIRE
- **Question** : une mortalité déclarée depuis un point de vente, en transit ou sur un stock mobile suit-elle la politique `MORTALITY` ?
- **Pourquoi** : AV-048 vise la mortalité des lots ; `inventory.loss.declare` accepte aussi la catégorie `MORTALITE`.
- **Choix** : (a) toute mortalité suit `MORTALITY` (Resp. production) ; (b) hors élevage, politique des pertes ordinaires.
- **Recommandation** : (a).
- **Impact** : `inventory.loss.declare` (catégorie `MORTALITE`).

### AV-120 — Annulations après consommation (collecte, mortalité approuvée) — SECONDAIRE
- **Question** : comment annuler une collecte dont les œufs sont déjà consommés, ou corriger une mortalité déjà approuvée ?
- **Pourquoi** : SM-EGG-COLLECTION prévoit « sinon validation » sans type d'opération ; `LOSS_CANCELLATION` est cité (D06) mais absent.
- **Choix** : (a) annulation par contre-écriture soumise à la validation du Resp. production ; (b) refus, correction par document compensatoire.
- **Recommandation** : (a).
- **Impact** : types d’opération à ajouter si (a).

### AV-121 — Seuils de l’alerte de mortalité élevée — SECONDAIRE
- **Question** : l'alerte `HIGH_MORTALITY` garde-t-elle ses seuils (0,5 % de l'effectif ou 20 têtes par jour) maintenant que toute mortalité est validée ?
- **Pourquoi** : les seuils de validation (AV-048) et d'alerte étaient les mêmes.
- **Choix** : (a) seuils d'alerte propres, paramétrés (0,5 % ou 20 têtes par jour, cumul du jour) ; (b) alerte à chaque mortalité.
- **Recommandation** : (a).
- **Impact** : P9 (module `communication`) ; paramètres.

### AV-122 — Durée de conservation des œufs collectés — SECONDAIRE
- **Question** : quelle date de péremption porte le lot de stock d'une collecte d'œufs ?
- **Pourquoi** : AV-100 donne à chaque collecte un lot propre « avec date de péremption », mais le catalogue ne porte aucune durée de conservation par produit.
- **Choix** : (a) durée unique pour les œufs, paramétrée (28 jours après la collecte) ; (b) durée par produit dans le catalogue ; (c) aucune date.
- **Recommandation** : (a), en attendant une durée par produit si les calibres se conservent différemment.
- **Impact** : paramètre `production.egg_shelf_life_days` ; ordre FEFO des ventes d'œufs (D06).

---

## 3. Journal des décisions

| Date | ID | Décision | Décideur |
|---|---|---|---|
| 24/09/2026 | AV-073 | Hébergement chez Hostinger, sans VPS. Conséquence technique : base de données MySQL au lieu de PostgreSQL (ADR-023) ; domaine de production `app.gic-agropelc.com` (ADR-024) | Porteur du projet |
| 24/09/2026 | AV-089 | Stack recadrée confirmée sans réserve (TypeScript de bout en bout, MySQL). P0 démarre | Porteur du projet |
| 26/09/2026 | AV-038 | Rejet d'une perte : deux issues ; `PERTE_NON_JUSTIFIEE` imputée au déclarant ; rejet sans option = `ERREUR_DECLARATION` (comportement P2-04 confirmé) | Porteur du projet |
| 26/09/2026 | AV-094 | Lecture des pertes réservée à l'encadrement dans son périmètre (`inventory.loss.read`) ; déclarants de terrain limités à leurs propres déclarations ; autres documents de stock sous `inventory.stock.read` | Porteur du projet |
| 27/09/2026 | AV-024 | Vente et CA à la confirmation ; marchandise en emplacement « à livrer » jusqu'à la livraison | Porteur du projet |
| 27/09/2026 | AV-025 | Bloquée sur l'appareil ; option « autorisée et signalée » activable par site, désactivée par défaut | Porteur du projet |
| 27/09/2026 | AV-004 | Aucun rôle supplémentaire au lancement | Porteur du projet |
| 27/09/2026 | AV-005 | Ferme = son site (saisies, stock) ; Production = toutes les fermes (lots, validations, indicateurs) | Porteur du projet |
| 27/09/2026 | AV-032 | Vif et abattu dès P7 : transformation multi-produits (entier, découpes, abats), coût réparti au prorata du poids | Porteur du projet |
| 27/09/2026 | AV-043 | Coûts directs + frais généraux du site, répartis chaque mois au prorata têtes × jours | Porteur du projet |
| 27/09/2026 | AV-044 | Cinq types actifs dès P7 ; reproducteur volaille suivi comme une pondeuse | Porteur du projet |
| 27/09/2026 | AV-045 | Inclus : naissances dans le lot de naissage, sevrage = transfert vers un lot d'engraissement avec coût | Porteur du projet |
| 27/09/2026 | AV-046 | Catégories CM + calibres à la collecte (liste paramétrable, un produit par calibre) ; plateau de 30 | Porteur du projet |
| 27/09/2026 | AV-047 | Œufs internes ou achetés ; durées paramétrées par espèce | Porteur du projet |
| 27/09/2026 | AV-048 | Toute mortalité validée (photo + Resp. production) ; seuils paramétrés en conséquence | Porteur du projet |
| 27/09/2026 | AV-049 | Base + indice de consommation, poids moyen et GMQ, taux de ponte | Porteur du projet |
| 27/09/2026 | AV-050 | Consommations vétérinaires imputées ; pas de plan de prophylaxie | Porteur du projet |
| 27/09/2026 | AV-095 | Quarantaine (défaut confirmé) | Porteur du projet |
| 27/09/2026 | AV-096 | Autorisée après validation du Resp. achats ; stock à la validation | Porteur du projet |
| 28/09/2026 | AV-097 | Coût restant ÷ têtes restantes (ADR-027) | Porteur du projet |
| 28/09/2026 | AV-098 | Coût standard ; crédit du lot producteur (ADR-027) | Porteur du projet |
| 28/09/2026 | AV-099 | Un lot par produit, lots liés | Porteur du projet |
| 28/09/2026 | AV-100 | Lot de stock propre par collecte et par abattage | Porteur du projet |
| 28/09/2026 | AV-101 | À la ferme, emplacement abattoir, Resp. ferme | Porteur du projet |
| 28/09/2026 | AV-102 | Entier à la pièce ; découpes et abats au kg | Porteur du projet |
| 28/09/2026 | AV-103 | Finance (ALL), Resp. production (ALL), Resp. ferme (SITE) | Porteur du projet |
| 28/09/2026 | AV-104 | Volaille / porc séparés ; frais communs ventilés à la saisie | Porteur du projet |
| 28/09/2026 | AV-105 | Part estimée à la clôture sur les frais connus | Porteur du projet |
| 28/09/2026 | AV-106 | À la demande ; régularisation des frais tardifs | Porteur du projet |
| 28/09/2026 | AV-107 | Enregistrée ; validation bloquée jusqu’à la photo | Porteur du projet |
| 28/09/2026 | AV-108 | Validation Resp. production pour tout écart sur animaux | Porteur du projet |
| 28/09/2026 | AV-109 | Résultat mensuel ; vente par produit | Porteur du projet |
| 28/09/2026 | AV-110 | Plusieurs collectes par jour | Porteur du projet |
| 28/09/2026 | AV-111 | Lot truies + lot porcelets ; sevrage vers engraissement | Porteur du projet |
| 28/09/2026 | AV-112 | Une seule opération (réception + entrée) | Porteur du projet |
| 28/09/2026 | AV-113 | Mortalité rattachée au lot d’incubation | Porteur du projet |
