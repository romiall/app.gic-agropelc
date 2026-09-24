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
| AV-004 | Rôles non listés au CM : opérateur de ferme, livreur, caissier | IMPORTANTE | P0 | Non créés ; rôle optionnel `OPERATEUR_FERME` proposé | OUVERT |
| AV-005 | Répartition Responsable ferme / Responsable production | IMPORTANTE | P7 | Ferme = site ; Production = toutes fermes + lots | OUVERT |
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
| AV-024 | Reconnaissance de la vente et sortie de stock pour les ventes sur commande | **BLOQUANTE** | P4 | Vente créée à la remise physique | OUVERT |
| AV-025 | Vente hors ligne au-delà de l'allocation | **BLOQUANTE** | P4/P5 | Bloquée sur l'appareil | OUVERT |
| AV-026 | Modification de prix / remise par le vendeur | IMPORTANTE | P4 | Interdite sauf permission, plafond et motif | OUVERT |
| AV-027 | Ventes anonymes au point de vente | IMPORTANTE | P4 | Autorisées si payées comptant intégralement | OUVERT |
| AV-028 | Politique de crédit client | IMPORTANTE | P4 | Clients autorisés, plafond, échéance 30 jours | OUVERT |
| AV-029 | Retours clients | SECONDAIRE | Futur | Hors MVP ; annulation encadrée | OUVERT |
| AV-030 | Conditions d'annulation d'une vente | IMPORTANTE | P4 | Validation requise sauf ≤ 15 min et caisse ouverte | OUVERT |
| AV-031 | Vente au poids ou à l'unité selon les produits | IMPORTANTE | P1/P4 | Les deux supportés ; à l'unité par défaut | OUVERT |
| AV-032 | Poulets vendus vifs et/ou abattus (transformation) | IMPORTANTE | P7 | Vif uniquement au MVP | OUVERT |
| AV-033 | Acomptes sur commande | SECONDAIRE | P4 | Autorisés, affectés à la commande | OUVERT |
| AV-034 | Livraison : document distinct ou portée par la vente | IMPORTANTE | P4 | Portée par la vente sur commande | OUVERT |
| AV-035 | Politique d'allocation de stock | IMPORTANTE | P5 | Allocation explicite, libération confirmée par l'appareil | OUVERT |
| AV-036 | Traçabilité par lot jusqu'à la vente | IMPORTANTE | P2/P7 | Obligatoire pour les animaux vivants ; FIFO automatique | OUVERT |
| AV-037 | Seuils de preuve et de validation des pertes | IMPORTANTE | P2 | Politique paramétrable (valeurs §2) | OUVERT |
| AV-038 | Traitement du rejet d'une déclaration de perte | SECONDAIRE | P2 | Deux issues : retour stock ou perte imputée | OUVERT |
| AV-039 | Fréquence et procédure d'inventaire | SECONDAIRE | P2/P5 | Mensuel complet recommandé + ponctuel | OUVERT |
| AV-040 | Seuils de réapprovisionnement | SECONDAIRE | P5 | Paramétrés par emplacement × produit | OUVERT |
| AV-041 | TVA et taxes | IMPORTANTE | P4/P8 | Prix TTC, pas de ventilation fiscale | OUVERT |
| AV-042 | Méthode de valorisation du stock | IMPORTANTE | P2/P8 | CMUP perpétuel ; coût de lot pour le biologique | OUVERT |
| AV-043 | Coûts incorporés au coût d'un lot | IMPORTANTE | P7/P8 | Coûts directs uniquement | OUVERT |
| AV-044 | Types de lots exploités | IMPORTANTE | P7 | Chair, pondeuse, porc d'engraissement | OUVERT |
| AV-045 | Naissage porcin dans le MVP | IMPORTANTE | P7 | Non ; entrées génériques | OUVERT |
| AV-046 | Classification des œufs et conditionnement | IMPORTANTE | P7 | Catégories CM ; plateau de 30 ; déclassés non vendus | OUVERT |
| AV-047 | Origine des œufs à couver et paramètres d'incubation | SECONDAIRE | P7 | Interne ou achat ; durées configurables | OUVERT |
| AV-048 | Seuil de validation de la mortalité | IMPORTANTE | P7 | > 0,5 % de l'effectif ou > 20 têtes / jour | OUVERT |
| AV-049 | Indicateurs zootechniques attendus | SECONDAIRE | P7/P9 | Ceux du CM + taux calculables | OUVERT |
| AV-050 | Suivi sanitaire (vaccination, traitements) | SECONDAIRE | Futur | Consommations uniquement | OUVERT |
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
| AV-073 | Hébergement, localisation et protection des données | IMPORTANTE | P0 | Cloud, région UE ou Afrique ; vérification juridique | OUVERT |
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

### AV-004 — Rôles supplémentaires — IMPORTANTE
- **Question** : faut-il des rôles non listés au CM §47, comme opérateur ou agent de ferme (saisie quotidienne), livreur ou transporteur, caissier distinct du vendeur ?
- **Pourquoi** : la « SAISIE DU JOUR » en ferme et les transferts physiques sont peut-être faits par des personnes qui n'ont aucun rôle du CM.
- **Choix** : (a) aucun rôle supplémentaire ; (b) ajouter `OPERATEUR_FERME` (saisie seulement) ; (c) ajouter aussi `LIVREUR` et `CAISSIER`.
- **Recommandation** : (a) au lancement. Le modèle RBAC permet d'ajouter (b) ou (c) par simple configuration, sans code. Le rôle `OPERATEUR_FERME` est décrit comme **proposé** dans la matrice RBAC.
- **Impact** : paramétrage uniquement (RBAC data-driven).
- **Références** : CM §47, §49 ; ADR-008.

### AV-005 — Responsable ferme vs Responsable production — IMPORTANTE
- **Question** : comment répartir les droits entre ces deux rôles (CM §47) ?
- **Recommandation** : le Responsable ferme agit sur **son site** : saisies, stock de la ferme, validations locales sous seuil. Le Responsable production agit sur **toutes les fermes** : création et clôture des lots, validations au-dessus du seuil, indicateurs.
- **Impact** : matrice RBAC uniquement.
- **Références** : CM §47 ; C-11.

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

### AV-024 — Vente sur commande : reconnaissance et sortie de stock — BLOQUANTE (phase 4)
- **Question** : pour une commande livrée plus tard, quand le stock sort-il et quand le chiffre d'affaires est-il reconnu ?
- **Choix** : (a) à la confirmation de la commande ; (b) à la remise physique (livraison) ; (c) vente confirmée avant livraison, avec un état « à livrer ».
- **Recommandation** : (b). La commande réserve le stock ; la livraison crée la vente, la sortie de stock et la créance. Une vente directe est à la fois vente et remise.
- **Impact** : machines à états commande et vente, calcul du CA, créances. Voir ADR-014.
- **Références** : CM §4, §13, §32 ; C-04.

### AV-025 — Vente hors ligne au-delà de l'allocation — BLOQUANTE (phases 4 et 5)
- **Choix** : (a) blocage sur l'appareil ; (b) autorisée et signalée, avec vérification à la synchronisation ; (c) autorisée seulement pour certains rôles.
- **Recommandation** : (a). Un vendeur ne peut pas vendre hors ligne plus que son allocation ou que le stock de son emplacement exclusif. Une option (b) peut être activée **par site**, désactivée par défaut.
- **Impact** : risque de vente manquée contre risque de survente.
- **Références** : CM §39 ; PM §6 ; C-08 ; ADR-004.

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

### AV-032 — Vif ou abattu — IMPORTANTE
- **Recommandation** : vif uniquement au MVP. L'abattage ou la transformation sera modélisé comme une opération de transformation (consommation → production), sans changer le registre de stock.

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

### AV-038 — Rejet d'une perte — SECONDAIRE
- **Recommandation** : l'approbateur choisit entre deux issues. `ERREUR_DECLARATION` : la marchandise existe et retourne en stock. `PERTE_NON_JUSTIFIEE` : la perte est confirmée mais reclassée en perte inexpliquée imputée au déclarant ou au lieu.

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

### AV-043 — Composantes du coût de lot — IMPORTANTE
- **Recommandation** : coûts directs uniquement au MVP : animaux ou œufs d'origine, aliments et intrants consommés, dépenses directement imputées au lot. Aucune répartition de frais généraux.

### AV-044 — Types de lots — IMPORTANTE
- **Recommandation** : `POULET_CHAIR`, `PONDEUSE`, `PORC_ENGRAISSEMENT`. Types optionnels activables par configuration : `REPRODUCTEUR_VOLAILLE`, `PORC_NAISSAGE`.

### AV-045 — Naissage porcin — IMPORTANTE
- **Recommandation** : hors MVP. Les porcelets entrent dans un lot par une « entrée » générique (`BIRTH`, `PURCHASE`, `TRANSFER_IN`). L'identification individuelle est une évolution future (CM §19).

### AV-046 — Classification des œufs — IMPORTANTE
- **Recommandation** : catégories du CM §17. Plateau de 30 œufs comme unité de vente. Les œufs cassés et non conformes n'entrent pas en stock commercial. Un produit « œuf déclassé » vendable pourra être activé.

### AV-047 — Incubation — SECONDAIRE
- **Recommandation** : œufs à couver issus de la production interne ou d'un achat. Durée d'incubation, jour de mirage et jour de transfert vers l'éclosoir paramétrés par espèce.

### AV-048 — Validation de la mortalité — IMPORTANTE
- **Recommandation** : une déclaration de mortalité journalière supérieure à 0,5 % de l'effectif du lot **ou** à 20 têtes exige une photo et une validation du Responsable production. En dessous, elle est enregistrée sans validation.

### AV-049 — Indicateurs zootechniques — SECONDAIRE
- **Recommandation** : taux de mortalité, effectif, taux d'éclosion (CM §18), œufs commercialisables / collectés, coût par tête. Indicateurs proposés, à valider : indice de consommation, poids moyen, gain moyen quotidien, taux de ponte.

### AV-050 — Suivi sanitaire — SECONDAIRE
- **Recommandation** : seules les consommations de produits vétérinaires sont imputées au lot. Le plan de prophylaxie est une évolution future.

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

### AV-073 — Hébergement et données personnelles — IMPORTANTE
- **Recommandation** : hébergement cloud managé, région UE ou Afrique la plus proche en latence. Chiffrement au repos et en transit. La conformité à la réglementation camerounaise sur les données personnelles est à vérifier par GIC.

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

---

## 3. Journal des décisions

| Date | ID | Décision | Décideur |
|---|---|---|---|
| — | — | Aucune décision enregistrée à ce jour | — |
