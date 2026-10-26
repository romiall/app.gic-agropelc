# Registre central des points À VALIDER — Questions ouvertes (Livrable n°20)

> **Source unique** de toutes les décisions métier en attente. Tout document qui s'appuie sur une valeur provisoire référence l'identifiant `AV-nnn` ci-dessous.
> Cycle de vie : `OUVERT` → `TRANCHÉ (date, décideur)`. Un point tranché devient **CONFIRMÉ** ; sa décision est reportée ici et propagée dans les documents concernés (voir [`00-reference/00-conventions.md`](00-reference/00-conventions.md) §2).

Classification (PM §45) :

- **BLOQUANTE** : empêche de construire correctement une partie fondamentale. La phase concernée ne peut pas être livrée sans décision, mais le travail des autres phases continue avec la valeur par défaut.
- **IMPORTANTE** : peut être décidée pendant le développement, avant la phase concernée.
- **SECONDAIRE** : peut rester configurable ou être reportée.

Numérotation : les points de P9, menés sous les numéros provisoires 400 à 500, sont renumérotés **AV-350 à AV-450** à l'intégration du 26/10/2026 (numéro provisoire moins 50) ; la plage 330 à 349 reste réservée au fork des écrans ; le prochain numéro libre est le 460 (le 329 a servi à l'intégration ; 451 à 459 sont réservés au fil de l'impression des pièces). Les numéros AV-350 à AV-366 cités dans l'historique de P8 ([`PROMPT-LANCEMENT-P8.md`](../PROMPT-LANCEMENT-P8.md)) étaient provisoires et désignent aujourd'hui AV-263 à AV-279.

---

## 1. Tableau de synthèse

| ID | Sujet | Classe | Phase impactée | Défaut provisoire | État |
|---|---|---|---|---|---|
| AV-001 | Périmètre de la première mise en production | IMPORTANTE | Plan | Mise en production progressive par tranches, site pilote | OUVERT |
| AV-002 | Inventaire des sites, magasins, points de vente et bâtiments existants | IMPORTANTE | P1 | Modèle générique ; données fournies par GIC | OUVERT |
| AV-003 | Hiérarchie des zones et géométrie des zones de pointage | IMPORTANTE | P0/P1 | Zones hiérarchiques ; géorepère = centre + rayon | OUVERT |
| AV-004 | Rôles non listés au CM : opérateur de ferme, livreur, caissier | IMPORTANTE | P0 | Aucun rôle supplémentaire au lancement | **TRANCHÉ** (voir journal §3) |
| AV-005 | Répartition Responsable ferme / Responsable production | IMPORTANTE | P7 | Ferme = son site (saisies, stock) ; Production = toutes les fermes (lots, validations, indicateurs) | **TRANCHÉ** (voir journal §3) |
| AV-006 | Politique d'enrôlement des appareils | IMPORTANTE | P0 | Appareil `PENDING` jusqu'à approbation par l'Admin ou un responsable (portée : AV-247) | **TRANCHÉ** (voir journal §3) |
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
| AV-017 | Catégories de clients | SECONDAIRE | P1 | 5 catégories initiales semées, configurables | **TRANCHÉ** (voir journal §3) |
| AV-018 | Sources de prospects et canaux de vente | SECONDAIRE | P1 | Référentiels configurables | OUVERT |
| AV-019 | Interactions des canaux Kommo stockées dans GIC | SECONDAIRE | P10 | Non : lien et compteurs seulement | OUVERT (P10 reportée le 26/10/2026) |
| AV-020 | Commissions commerciales | SECONDAIRE | Futur | Hors MVP ; attribution conservée | OUVERT |
| AV-021 | Prise de service hors zone : refus ou acceptation signalée | IMPORTANTE | P3 | Refus + tentative conservée + dérogation | OUVERT |
| AV-022 | Rayon de tolérance et précision GPS maximale | SECONDAIRE | P3 | 500 m (CM) ; précision ≤ 150 m | OUVERT |
| AV-023 | Session de travail obligatoire pour visites et ventes terrain | IMPORTANTE | P3 | Rattachement automatique, pas de blocage | OUVERT |
| AV-024 | Reconnaissance de la vente et sortie de stock pour les ventes sur commande | **BLOQUANTE** | P4 | Vente et CA à la confirmation ; marchandise en emplacement « à livrer » jusqu'à la livraison | **TRANCHÉ** (voir journal §3) |
| AV-025 | Vente hors ligne au-delà de l'allocation | **BLOQUANTE** | P4/P5 | Bloquée sur l'appareil ; option « autorisée et signalée » activable par site, désactivée par défaut | **TRANCHÉ** (voir journal §3) |
| AV-026 | Modification de prix / remise par le vendeur | IMPORTANTE | P4 | Interdite sauf `sales.price.override` ; plafond par rôle (Vendeur 0 %, Commercial 5 %, Resp. commercial 15 %), motif, validation au-delà | **TRANCHÉ** (voir journal §3) |
| AV-027 | Ventes anonymes au point de vente | IMPORTANTE | P4 | Autorisées si intégralement payées ; client obligatoire à crédit ou sur commande | **TRANCHÉ** (voir journal §3) |
| AV-028 | Politique de crédit client | IMPORTANTE | P4 | Clients autorisés, plafond, 30 jours depuis la confirmation ; refus en ligne au-delà, validation a posteriori hors ligne | **TRANCHÉ** (voir journal §3) |
| AV-029 | Retours clients | SECONDAIRE | Futur | Hors MVP ; annulation encadrée | OUVERT |
| AV-030 | Conditions d'annulation d'une vente | IMPORTANTE | P4 | Vendeur seul ≤ 15 min (caisse ouverte dès P5), sinon validation ; contre-écriture | **TRANCHÉ** (voir journal §3) |
| AV-031 | Vente au poids ou à l'unité selon les produits | IMPORTANTE | P1/P4 | Les deux par produit dès P4 (`pricing_mode`) ; poids facultatif à l'unité | **TRANCHÉ** (voir journal §3) |
| AV-032 | Poulets vendus vifs et/ou abattus (transformation) | IMPORTANTE | P7 | Vif et abattu dès P7 : transformation multi-produits (entier, découpes, abats), coût réparti au prorata du poids | **TRANCHÉ** (voir journal §3) |
| AV-033 | Acomptes sur commande | SECONDAIRE | P4 | Autorisés, affectés à la commande puis passés à la vente à sa confirmation (ADR-028 §8) | OUVERT |
| AV-034 | Livraison : document distinct ou portée par la vente | IMPORTANTE | P4 | Bon de livraison distinct (livreur, heure, quantités, preuve) ; plusieurs livraisons partielles | **TRANCHÉ** (voir journal §3) |
| AV-035 | Politique d'allocation de stock | IMPORTANTE | P5 | Allocation explicite, libération confirmée par l'appareil | OUVERT |
| AV-036 | Traçabilité par lot jusqu'à la vente | IMPORTANTE | P2/P7 | Obligatoire pour les animaux vivants ; FIFO automatique | OUVERT |
| AV-037 | Seuils de preuve et de validation des pertes | IMPORTANTE | P2 | Politique paramétrable (valeurs §2) ; photo jamais exigée hors mortalité (AV-288, 14/10/2026) | OUVERT |
| AV-038 | Traitement du rejet d'une déclaration de perte | SECONDAIRE | P2 | Deux issues : retour stock ou perte imputée au déclarant ; rejet sans motif = erreur de déclaration | **TRANCHÉ** (voir journal §3) |
| AV-039 | Fréquence et procédure d'inventaire | SECONDAIRE | P2/P5 | Mensuel complet recommandé + ponctuel | OUVERT |
| AV-040 | Seuils de réapprovisionnement | SECONDAIRE | P5 | Paramétrés par emplacement × produit | OUVERT |
| AV-041 | TVA et taxes | IMPORTANTE | P4/P8 | Prix TTC, reçu simple ; taxes à 0 | **TRANCHÉ** (voir journal §3) |
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
| AV-056 | Moyens de paiement et vérification mobile money | IMPORTANTE | P4 | Espèces, Orange Money, MTN MoMo, virement, chèque ; référence saisie, unique par moyen ; doublon mis de côté | **TRANCHÉ** (voir journal §3) |
| AV-057 | Procédure de caisse du point de vente | IMPORTANTE | P5 | Session quotidienne ; clôture comptée ; écart validé | OUVERT |
| AV-058 | Catégories de dépenses et justificatifs | SECONDAIRE | P8 | Liste initiale ; photo > 10 000 XAF ; validation > 50 000 XAF | OUVERT |
| AV-059 | Export / intégration comptable | SECONDAIRE | Futur | Exports CSV structurés | OUVERT |
| AV-060 | Arrondis monétaires | SECONDAIRE | P4 | Arrondi au franc par ligne (demi supérieur) | OUVERT |
| AV-061 | Dimensions tarifaires utilisées au lancement | SECONDAIRE | P1 | Toutes supportées ; grille zone + PDV | OUVERT |
| AV-062 | Validation / activation des règles tarifaires | IMPORTANTE | P1 | Création Resp. commercial ; activation Direction | OUVERT |
| AV-063 | Vente hors ligne à un prix devenu obsolète | IMPORTANTE | P4 | Acceptée au prix figé ; anomalie `PRICE_MISMATCH` | **TRANCHÉ** (voir journal §3) |
| AV-064 | Canaux de notification | SECONDAIRE | P9 | In-app + Web Push | OUVERT |
| AV-065 | Alertes initiales et seuils | SECONDAIRE | P9 | Liste CM §54 ; seuils configurables | OUVERT |
| AV-066 | Accusé de lecture des notes de direction | SECONDAIRE | P9 | Optionnel par note | OUVERT |
| AV-067 | Formats et restrictions d'export | SECONDAIRE | P9 | CSV + XLSX ; exports audités | OUVERT |
| AV-068 | Capacités du compte Kommo (API, webhooks, pipelines, champs) | IMPORTANTE | P10 | À vérifier ; bloquante pour P10 uniquement | OUVERT (P10 reportée le 26/10/2026) |
| AV-069 | Déclencheur de création d'un client GIC depuis Kommo | IMPORTANTE | P10 | Statut Kommo « qualifié » configurable | OUVERT (P10 reportée le 26/10/2026) |
| AV-070 | Données remontées de GIC vers Kommo | SECONDAIRE | P10 | Exemple CM §46 | OUVERT (P10 reportée le 26/10/2026) |
| AV-071 | Correspondance utilisateurs GIC ↔ Kommo | SECONDAIRE | P10 | Table de correspondance explicite | OUVERT (P10 reportée le 26/10/2026) |
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
| AV-114 | Carcasses saisies et frais d'abattage | SECONDAIRE | P7 | Saisies sans produit (coût porté par les produits) ; frais = dépense directe du lot | **TRANCHÉ** (voir journal §3) |
| AV-115 | Abattage des réformes et des porcs | SECONDAIRE | P7 | Tous les types de lots abattables dès P7 (volailles et porcs), liste paramétrée | **TRANCHÉ** (voir journal §3) |
| AV-116 | Définition des indicateurs zootechniques | SECONDAIRE | P7 | Formules de la recommandation, paramétrables | OUVERT |
| AV-117 | Journée sans événement (« RAS ») | SECONDAIRE | P7 | Non construit en P7 (alertes en P9) ; observation « RAS » possible | OUVERT |
| AV-118 | Reclassement d'œufs | SECONDAIRE | P7 | Non construit en P7 ; reclassement avec motif proposé | OUVERT |
| AV-119 | Mortalité constatée hors élevage | SECONDAIRE | P7 | Toute mortalité suit la politique `MORTALITY` | OUVERT |
| AV-120 | Annulations après consommation (collecte, mortalité approuvée) | SECONDAIRE | P7 | Refus en ligne (`STOCK_UNAVAILABLE`) ; correction compensatoire | **TRANCHÉ** (voir journal §3) |
| AV-121 | Seuils de l’alerte de mortalité élevée | SECONDAIRE | P7 | Seuils d’alerte propres (0,5 % ou 20 têtes/jour), paramétrés | OUVERT |
| AV-122 | Durée de conservation des œufs collectés | SECONDAIRE | P7 | 28 jours après la collecte, paramétrée | **TRANCHÉ** (voir journal §3) |
| AV-123 | Annulation d’une entrée de lot | SECONDAIRE | P7 | Responsable production seul | **TRANCHÉ** (voir journal §3) |
| AV-124 | Production entrée sans coût standard défini | SECONDAIRE | P7 | Saisie acceptée à la valeur par défaut ; alerte à l’administrateur | **TRANCHÉ** (voir journal §3) |
| AV-125 | Durée de conservation des produits d’abattage | SECONDAIRE | P7 | 5 jours après l’abattage (frais réfrigéré), paramétrée | **TRANCHÉ** (voir journal §3) |
| AV-126 | Commande saisie hors ligne sur un stock non alloué | IMPORTANTE | P4 | Intention confirmée par le serveur à la synchronisation | **TRANCHÉ** (voir journal §3) |
| AV-127 | Stock insuffisant à la confirmation d'une commande | IMPORTANTE | P4 | Vente du disponible ; le reste demeure une commande en attente | **TRANCHÉ** (voir journal §3) |
| AV-128 | Annulation du reste non livré d'une commande confirmée | IMPORTANTE | P4 | Auteur ou Resp. commercial, sans validation, par contre-écriture | **TRANCHÉ** (voir journal §3) |
| AV-129 | Point de départ de l'échéance d'une vente sur commande | SECONDAIRE | P4 | Depuis la confirmation (date de la vente) | **TRANCHÉ** (voir journal §3) |
| AV-130 | Modification d'une commande confirmée | IMPORTANTE | P4 | Ajustement automatique : contre-écriture et nouvelle vente pour la différence | **TRANCHÉ** (voir journal §3) |
| AV-131 | Perte d'une marchandise vendue avant sa livraison | SECONDAIRE | P4 | Annulation partielle de la vente, puis perte déclarée | OUVERT |
| AV-132 | Délai d'alerte d'une vente confirmée non livrée | SECONDAIRE | P4/P9 | 7 jours, paramétré | OUVERT |
| AV-133 | Livraison faite hors ligne qui arrive après l'annulation du reste de la commande | SECONDAIRE | P4 | Vente directe de régularisation de la quantité en trop et conflit pour revue | OUVERT |
| AV-134 | Correction d'un bon de livraison saisi avec une mauvaise quantité | SECONDAIRE | P4 | Non en V1 : seul le non-livré s'annule (retour de marchandise livrée hors MVP, AV-029) | OUVERT |
| AV-135 | Décision de la Finance sur un encaissement suspect de doublon : correction de la référence | IMPORTANTE | P4 | La Finance peut corriger la référence en décidant ; la vente ou la commande visées sont mémorisées | OUVERT |
| AV-136 | Commande d'un produit vendu au poids | IMPORTANTE | P4 | Non en P4 : seuls les produits à l'unité se commandent ; le poids se vend en vente directe | OUVERT |
| AV-137 | Vente anonyme saisie hors ligne et non intégralement payée | SECONDAIRE | P4 | Enregistrée (fait accompli), drapeau et conflit pour la Finance | OUVERT |
| AV-138 | Annulation d'une vente d'animaux après la clôture de leur lot | SECONDAIRE | P4 | Appliquée (une correction n'est jamais refusée), lot laissé clos, conflit informatif pour le Resp. production | OUVERT |
| AV-139 | Compte de trésorerie crédité par un mobile money, un virement ou un chèque quand l'entreprise a plusieurs comptes | SECONDAIRE | P4 | L'appareil désigne le compte ; à défaut, le seul compte actif du type ; sinon refus | OUVERT |
| AV-140 | Canal d'une vente quand le vendeur n'en choisit pas, et canaux de vente à créer | SECONDAIRE | P4 | Déduit du lieu de la vente ; canaux créés par l'administrateur | OUVERT |
| AV-141 | Vente en ligne avec un prix catalogue différent de celui du serveur | SECONDAIRE | P4 | Refusée : l'appareil doit actualiser son catalogue | OUVERT |
| AV-142 | Qui traite le stock négatif d'une vente hors ligne | SECONDAIRE | P4 | Responsable du site selon son type (magasinier, responsable de ferme, responsable commercial) | OUVERT |
| AV-143 | Vente à crédit hors ligne à un client non autorisé au crédit | SECONDAIRE | P4 | Appliquée, validation a posteriori du dépassement | OUVERT |
| AV-144 | Vente directe depuis un magasin (et non un point de vente) | SECONDAIRE | P4 | Refusée | OUVERT |
| AV-145 | Vente en ligne à un client dont le compte a été fusionné | SECONDAIRE | P4 | Refusée : vendre au compte conservé | OUVERT |
| AV-146 | Sort de l'argent payé d'une vente annulée : remboursement ou crédit client | SECONDAIRE | P4 | Choisi par l'annulateur (annulation directe) ou l'approbateur ; remboursement forcé sans client | OUVERT |
| AV-147 | Remise sur une ligne de commande | SECONDAIRE | P4 | Pas de remise sur une ligne de commande : la dérogation se saisit par le prix convenu (plafond et validation `PRICE_OVERRIDE`) | OUVERT |
| AV-148 | Confirmation d'un brouillon de commande : prix de la saisie ou prix du jour | SECONDAIRE | P4 | Lignes et prix figés à la saisie du brouillon | OUVERT |
| AV-149 | Annulation d'une vente sur commande : la commande garde-t-elle la quantité ? | IMPORTANTE | P4 | Quantité retirée de la commande, qui ne la revendra pas | OUVERT |
| AV-150 | Encaissement saisi hors ligne avec une commande que le serveur refuse ; acompte supérieur au total de la commande | IMPORTANTE | P4 | Encaissement conservé en crédit client non affecté, avec un conflit pour la Finance ; acompte borné au total en ligne | OUVERT |
| AV-151 | Annulation d'un encaissement dont une part a déjà été remboursée au client | SECONDAIRE | P4 | Refusée ; la Finance corrige par une réaffectation ou une régularisation | OUVERT |
| AV-152 | Mort d'animaux vivants hors d'un lot de production (stock mobile, marchandise vivante achetée) | SECONDAIRE | P4 | Mortalité du lot quand les animaux en viennent ; sinon perte simple `DETERIORATION` | OUVERT |
| AV-153 | Écart d'une remise de fonds : imputation et excédent | IMPORTANTE | P5 | Aucun second mouvement ; imputation choisie par la Finance ; excédent admis | OUVERT |
| AV-154 | Cycle quotidien de la session de caisse (seconde session, ouverture concurrente, veille non clôturée) | IMPORTANTE | P5 | Sessions sans limite par jour (paramètre, 0 = sans limite) ; ouvertures concurrentes fusionnées ; clôture forcée par la Finance | **TRANCHÉ** (voir journal §3) |
| AV-155 | Responsabilité d'un écart de caisse avec plusieurs vendeurs et identité du valideur | IMPORTANTE | P5 | Écart imputé à celui qui clôture, sous-totaux par vendeur ; valideur différent de l'ouvreur et du clôtureur | OUVERT |
| AV-156 | Fonds de caisse initial et écart d'ouverture | SECONDAIRE | P5 | Écart d'ouverture posé et validé par la Finance, motif « fonds initial » admis | OUVERT |
| AV-157 | Mouvements d'espèces hors session ou décidés après coup (encaissement, remboursement, inverse) | IMPORTANTE | P5 | Appliqué avec avertissement hors ligne ; rattaché à la session couvrant sa date ; l'inverse hérite de la session d'origine | OUVERT |
| AV-158 | Remises de fonds : comptes admis, récepteur, alerte de remise non reçue | SECONDAIRE | P5 | Récepteur différent de l'expéditeur ; alerte à 48 h ; porteur = utilisateur ou nom libre | OUVERT |
| AV-159 | Refus, recomptage et correction d'un écart de caisse | SECONDAIRE | P5 | Acceptation seule ; une erreur de comptage se corrige par un ajustement validé | OUVERT |
| AV-160 | Quotas d'appareil : granularité et validité par défaut | IMPORTANTE | P5 | Quota par produit (lot indicatif) ; valide jusqu'à la fin du jour métier de l'octroi | OUVERT |
| AV-161 | Quotas d'appareil : dépassement hors ligne, quota révoqué ou échu | IMPORTANTE | P5 | Fait appliqué, excédent au stock commun, reste jamais négatif, conflit signalé | OUVERT |
| AV-162 | Qui accorde les quotas (« responsable du PDV ») et permission de libération | IMPORTANTE | P5 | Magasinier du site, Resp. commercial de la zone, Direction ; libération par l'appareil détenteur (portée propre) | OUVERT |
| AV-163 | Garde d'appareil : mode par défaut des emplacements et appareil non désigné | IMPORTANTE | P5 | Mode obligatoire avec défaut par type ; appareil non désigné : fait appliqué et conflit | OUVERT |
| AV-164 | Tableau de distribution : définitions de « vendu » et « perdu », périmètre, route | SECONDAIRE | P5 | Vendu net des contre-écritures (à livrer à part) ; perdu = pertes reconnues + écarts ; route d'analytique livrée en P5 | OUVERT |
| AV-165 | Sessions de caisse hors PDV et PDV à plusieurs appareils | SECONDAIRE | P5 | Pas de session pour une caisse utilisateur ; validation sans attendre toutes les synchronisations | OUVERT |
| AV-166 | Vente hors ligne sans quota utilisable sur un emplacement partagé : signal du serveur | IMPORTANTE | P5 | Appliquée sur le stock commun et signalée `ALLOCATION_EXCEEDED` (motif `ALLOCATION_MISSING` ou `ALLOCATION_EXPIRED`) si l'emplacement porte au moins un quota actif du produit (même épuisé) ; réglable par site | OUVERT |
| AV-167 | Ouverture de caisse hors ligne plus ancienne que la session qu'elle chevauche | SECONDAIRE | P5 | Fusion dans la plus ancienne session en cause, fenêtre inchangée, intervalle consigné | OUVERT |
| AV-168 | Ouverture de caisse hors ligne pendant la session de la veille, close d'office depuis | IMPORTANTE | P5 | Ouverture prise en compte à la clôture forcée (décalée), comptage conservé, conflit | OUVERT |
| AV-169 | Clôture de caisse hors ligne datée avant l'ouverture de la session | SECONDAIRE | P5 | Observation, session laissée ouverte | OUVERT |
| AV-170 | Responsable imputé de l'écart d'une clôture forcée et de l'écart d'ouverture | IMPORTANTE | P5 | L'ouvreur de la session | OUVERT |
| AV-171 | Clôture de caisse datée avant un mouvement déjà enregistré sur la caisse | SECONDAIRE | P5 | Refus en ligne ; hors ligne, appliquée, jamais validée d'office, signalée à la Finance | OUVERT |
| AV-172 | Remises de fonds : qui réceptionne et qui annule | SECONDAIRE | P5 | Tout titulaire de la portée du compte destinataire, sauf l'expéditeur ; porteur admis ; annulation par l'expéditeur seul | OUVERT |
| AV-173 | Courses hors ligne d'une remise (réception après annulation, annulation après réception, double réception) | IMPORTANTE | P5 | Fait conservé en observation dans un conflit pour la Finance, aucun mouvement ; refus en ligne ; régularisation humaine | OUVERT |
| AV-174 | Décision sur l'écart d'une remise : rejet, retrait, correction, valideur | SECONDAIRE | P5 | Acceptation seule (rejet et retrait refusés) ; imputation et motif obligatoires ; valideur ni expéditeur, ni récepteur, ni porteur | OUVERT |
| AV-175 | Remise perdue en route | IMPORTANTE | P5 | Réception de 0 XAF : écart = − envoyé, sans entrée de trésorerie, décision ordinaire | OUVERT |
| AV-176 | Site de numérotation d'une remise entre comptes sans site | SECONDAIRE | P5 | Site du compte source, sinon du destinataire, sinon série globale `SIEGE` paramétrable | OUVERT |
| AV-177 | Réception sans document : critères de rapprochement, choix de l'expédition, excédent | IMPORTANTE | P5 | Mêmes source et destination, produits reçus inclus dans les produits expédiés ; exacte puis partielle puis excédentaire, la plus ancienne d'abord ; excédent reçu et signalé ; mode paramétrable (`SUBSET` ou `EXACT`) | OUVERT |
| AV-178 | Réception sans document vers un emplacement partagé ou saisie hors garde | SECONDAIRE | P5 | En ligne : refus ; hors ligne : fait appliqué, avertissement et conflit `CUSTODY_DEVICE_MISMATCH` | OUVERT |
| AV-179 | Réception sans document rapprochée après coup : lot et valeur ; produit suivi par lot | IMPORTANTE | P5 | Requalification au lot et à la valeur de l'expédition ; lot obligatoire en ligne pour un produit suivi par lot | OUVERT |
| AV-180 | Retour à la source et réception concurrents ; seconde réception ; retour en double | SECONDAIRE | P5 | Le premier fait appliqué l'emporte ; le second, contradictoire, est mis en quarantaine (hors ligne) ou refusé (en ligne) | OUVERT |
| AV-181 | Délai de la réception sans document non rapprochée : origine, propriétaire du conflit, sortie | SECONDAIRE | P5 | Délai depuis l'heure physique de la réception ; conflit au responsable du stock expéditeur, une seule fois ; clos au rapprochement | OUVERT |
| AV-182 | Portée (`SITE`/`OWN`) des commandes de stock : quelle extrémité d'un transfert fait ressource, et suite hors ligne | IMPORTANTE | P5 | (a) depuis P5-23 : portée évaluée sur au moins une des extrémités physiques (site, et titulaire d'un stock sous garde exclusive) ; refus `FORBIDDEN_SCOPE`, en ligne comme hors ligne, pour toutes les commandes `inventory` | OUVERT |
| AV-183 | Session de caisse ou écart de remise à valider sans politique active | SECONDAIRE | P5 | Clôture ou réception appliquée sans demande ; validation directe (`finance.cash_session.validate`, `finance.cash_transfer.close_discrepancy`), mêmes droits, séparation des tâches et motif | OUVERT |
| AV-184 | Encaissement en espèces au PDV sans session : périmètre de l'exigence, grain et résolution de `CASH_SESSION_MISSING` | IMPORTANTE | P5 | Caisse de PDV seulement, trois chemins d'encaissement ; refus en ligne, contrôle repris sous le verrou du compte ; hors ligne, un conflit par encaissement, résolu par une ouverture qui couvre son heure ou la suit ; doublon suspect approuvé : index recopié, sans refus ni constat | OUVERT |
| AV-185 | Annulation directe : sens de « session de caisse de la vente encore ouverte » (BR-VEN-028) | SECONDAIRE | P5 | Chaque encaissement de la vente sur une caisse de PDV dans une session qui couvre son heure et celle de l'annulation ; sinon demande `CANCEL_SESSION_CLOSED` ; course avec une clôture concurrente : P5-22 | OUVERT |
| AV-186 | Remboursement en espèces sans session de caisse ouverte | SECONDAIRE | P5 | Jamais refusé ni signalé ; daté de sa propre date, rattaché à la session qui la couvre s'il y en a une | OUVERT |
| AV-187 | Sous-totaux par vendeur d'une session : contenu et attribution | SECONDAIRE | P5 | Encaissements nets de leurs inverses, par `received_by_user_id` ; autres flux agrégés sans vendeur | OUVERT |
| AV-188 | Annulation de l'encaissement qui règle une vente anonyme saisie en ligne | SECONDAIRE | P5 | Refus `PAYMENT_ANONYMOUS_SALE` de la demande et de la décision tant que l'encaissement règle une vente sans client saisie en ligne (défaut implémenté en P5-23) | OUVERT |
| AV-189 | Droits de lecture des ressources de P5 : quotas, sessions de caisse, remises de fonds, structure, file des conflits | SECONDAIRE | P5 | Droits semés réutilisés (`inventory.stock.read`, `finance.cash.read`, `org.structure.read`, `sync.conflict.resolve`), portée de la ressource ; aucune permission de lecture nouvelle | OUVERT |
| AV-190 | Sens d'une résolution manuelle de conflit (`sync.conflict.resolve`, `.dismiss`) | IMPORTANTE | P5 | Clôture administrative tracée (décision, motif, références) : aucun rejeu de commande, aucun document créé par le serveur ; refus listés (quarantaine, doublon d'encaissement, références de `COMPENSATE`) | OUVERT |
| AV-191 | Qui voit et traite un conflit | SECONDAIRE | P5 | Rôle propriétaire du conflit parmi les rôles de l'utilisateur (catalogue des rôles), puis portée de `sync.conflict.resolve` des seules affectations de ce rôle, sur le site et l'auteur (à défaut, le détenteur du stock mobile en cause) | OUVERT |
| AV-192 | Clôture d'un conflit par l'auteur du fait qu'il signale | SECONDAIRE | P5 | Refusée pour un conflit sur un fait appliqué (`CONFLICT_SELF_RESOLUTION_FORBIDDEN`) ; permise pour la quarantaine de sa propre commande | OUVERT |
| AV-193 | Ce que les jeux `allocations` et `cash` gardent d'un quota, d'une session ou d'une remise terminés | SECONDAIRE | P5 | Quota servi tant qu'il est actif ; session servie ouverte puis à valider ; remise servie envoyée ou en écart ; sortie du jeu (`SCOPE_EXIT`) ensuite | OUVERT |
| AV-194 | Quotas d'une tablette partagée : cloisonnement par utilisateur | SECONDAIRE | P5 | Ligne au périmètre de l'appareil détenteur, détenteur projeté : l'appareil n'applique que les quotas de l'utilisateur connecté | OUVERT |
| AV-195 | Configuration du PDV hors ligne et changement d'appareil désigné | SECONDAIRE | P5 | `POINT_OF_SALE` dans le jeu `org` au site du PDV, emplacement de vente republié ; changement d'appareil propagé par mise à jour, sans sortie de périmètre ; P5-23 : quotas (AV-230), fiche d'appareil et garde jugée à la date du fait (ADR-040) traités | OUVERT |
| AV-196 | Jeux et publication des référentiels de vente (suite d'ADR-031) | SECONDAIRE | P5 | `catalog` (unités, canaux, motifs, étapes, sources), `me` (paramètres visibles, ligne `GLOBAL`, version remplacée retirée), `policies` (version active, version retirée supprimée) ; lignes semées publiées par le seed | OUVERT |
| AV-197 | Comptes destinataires d'une remise de fonds hors ligne | SECONDAIRE | P5 | Comptes actifs sans détenteur personnel publiés à tous les appareils (jeu `cash`, ligne `GLOBAL`), sans solde, responsable ni version | OUVERT |
| AV-198 | Curseur du pull : ligne du flux validée après une ligne de numéro supérieur | IMPORTANTE | P5 | Variante de (a) depuis P5-23 : curseur retenu devant un trou récent de la numérotation (`sync.pull_settle_seconds`, 120 s) ; même règle pour la position des consommateurs d'événements ; test de concurrence | OUVERT |
| AV-199 | Flux de distribution d'un PDV : catégories, datation, envoyé net des retours | SECONDAIRE | P5 | Chaque mouvement à sa date, une seule catégorie (identité vraie par construction) ; envoyé net des retours à la source à la date du retour ; reçu net des requalifications ; écarts de transfert hors identité ; pertes en attente à part | OUVERT |
| AV-200 | Encaissé d'une période : datation des annulations d'encaissement | SECONDAIRE | P5 | Vue par période d'activité depuis P5-23 : encaissements confirmés à leur date, annulations décidées dans la période à la leur, partagée par l'accueil et le tableau (ADR-041) ; remboursements : AV-244 ; à confirmer par le porteur | OUVERT |
| AV-201 | « Session du jour » d'un PDV et sessions à valider | SECONDAIRE | P5 | Session ouverte (quel que soit son jour) et dernière session ouverte le jour métier ; à valider = sessions `PENDING_VALIDATION` de tous jours et ajustements en attente d'une session validée | OUVERT |
| AV-202 | Fraîcheur d'un appareil : dernier contact et appareils d'un PDV | IMPORTANTE | P5 | Dernier contact = connexion, dernier envoi ou dernier pull (enregistré à chaque pull depuis P5-19, au plus une fois par minute depuis MP-12, AV-319) ; appareils du site = rattachés, désigné du PDV, détenteurs d'un quota actif ; retard au-delà de `analytics.freshness_warning_hours` | OUVERT |
| AV-203 | Disponible net des quotas dans `GET /stock` | SECONDAIRE | P5 | Lignes inchangées (disponible sans consommateur désigné) ; bloc `allocations` par produit : restant alloué, non alloué, reste et disponible du demandeur (BR-STK-011) | OUVERT |
| AV-204 | Périmètre du tableau de distribution ; portée du Resp. commercial sur les PDV | IMPORTANTE | P5 | PDV que la permission atteint (`evaluateAccess`, zone et descendance comprises) ; aucun PDV ⇒ réponse vide ; `site_id` hors portée ⇒ 404 audité ; `RESP_COMMERCIAL` affectable en `ZONE` (seed : `TEAM`, `ZONE`) | OUVERT |
| AV-205 | Frontière entre agrégat et détail du tableau de distribution | SECONDAIRE | P5 | Agrégats sous `analytics.dashboard.distribution` ; session de caisse sous `finance.cash.read`, receveurs sous `sales.payment.read`, auteurs d'un appareil sous `sync.monitor.read`, évalués par site ; sinon `null` | OUVERT |
| AV-206 | Valeurs masquées du tableau de distribution | SECONDAIRE | P5 | Valeur du restant et du perdu (coût du registre) à `null` sans `inventory.valuation.read`, totaux de valeur à `null` dès qu'un PDV est masqué ; chiffre d'affaires et encaissé non masqués ; pas de `FORBIDDEN_MEASURE` | OUVERT |
| AV-207 | Période du tableau de distribution et instants de lecture | SECONDAIRE | P5 | `period` (`TODAY` par défaut, `YESTERDAY`, `WEEK`, `MONTH`, `YEAR`) ou `from`/`to` inclus, au plus `analytics.dashboard_max_period_days` (366) ; restant à la fin de la période ; à livrer, seuils, quotas, caisse et fraîcheur à l'instant | OUVERT |
| AV-208 | Accueil Finance et magasinier : contenu de distribution | SECONDAIRE | P5 | Finance : caisses à valider, écarts du jour, remises en attente, appareils en retard, signaux `CASH_VARIANCE` (critique), `CASH_SESSION_OPEN_LONG`, `CASH_TRANSFER_NOT_RECEIVED`, `DEVICES_STALE` ; magasinier : réapprovisionnement, quotas à régulariser, appareils des PDV de ses sites ; anomalies d'un rôle de sites filtrées par site | OUVERT |
| AV-209 | Chiffre d'affaires du jour : accueil contre tableau de distribution | SECONDAIRE | P5 | Accueil aligné sur le tableau en P5-23 : vendu net par période d'activité, une seule fonction (ADR-041) ; périmètres : AV-245 ; à confirmer par le porteur | OUVERT |
| AV-210 | Ordre d'un lot après une commande à renvoyer ; dépendance reçue mais non réglée | IMPORTANTE | P5 | Lot suspendu après la première commande `RETRY_LATER` (`PRECEDING_COMMAND_PENDING`, rien d'enregistré) ; dépendance non réglée ⇒ `DEPENDENCY_PENDING` ; commande en attente reprenable au renvoi (`FAILED_RETRYABLE`), reprise réclamée sur le compteur de tentatives | OUVERT |
| AV-211 | Faits antérieurs à la révocation d'un quota, synchronisés après : comparaison fait par fait | SECONDAIRE | P5 | (b) depuis P5-23 : comparaison en cumul avec les faits du détenteur antérieurs à la révocation déjà appliqués après elle | OUVERT |
| AV-212 | Fenêtre de quarantaine d'un appareil débloqué ou retiré | IMPORTANTE | P5 | (b) implémenté en P5-23 : périodes hors service closes consignées (`identity.device_status_periods`), quarantaine de tout fait daté dans l'une d'elles | OUVERT |
| AV-213 | Appareil révoqué : envoi de sa file et signal d'effacement local | IMPORTANTE | P5 | Envoi tant que le jeton d'accès vaut, quarantaine côté serveur ; pull non refusé ; effacement à coder dans la PWA | OUVERT |
| AV-214 | Régularisation d'une vente mise en quarantaine (appareil révoqué) | SECONDAIRE | P5 | Inbox seule (aucune ligne de conflit), écart de caisse expliqué par l'inbox, inventaire, ressaisie | OUVERT |
| AV-215 | Stock négatif après une sortie hors ligne autre qu'une vente | SECONDAIRE | P5 | Depuis P5-22 : toute sortie physique qui rend un solde négatif ouvre `STOCK_NEGATIVE` (posé par `recordStockMove`, un par sortie, responsable du stock), conformément à BR-STK-018 | OUVERT |
| AV-216 | Horloge d'appareil suspecte : dates de référence, seuil et alerte | SECONDAIRE | P5 | Date déclarée partout (ADR-016), drapeau visible, seul le contrôle de date future corrigé ; seuil lu dans `sync.clock_skew_flag_minutes` à la réception (P5-23) ; alerte en P9 | OUVERT |
| AV-217 | Commande à renvoyer qui ne se règle jamais : suspension du lot bornée | IMPORTANTE | P5 | Au-delà de `sync.retry_hold_minutes` (30 min) depuis la première réception : toujours à renvoyer, ne suspend plus la suite (`COMMAND_STALLED`), signal `SYNC_COMMAND_STALLED` pour l'Admin, fermé quand elle se règle | OUVERT |
| AV-218 | Compte de réception d'un encaissement mobile money ou bancaire quand l'entreprise a plusieurs comptes du type | IMPORTANTE | Écrans PWA | Compte jamais désigné d'office (« seul compte connu de l'appareil » n'est pas « seul compte de l'entreprise ») : choix proposé dès que l'appareil connaît un compte du type, obligatoire s'il en connaît plusieurs ; sinon aucun compte envoyé et avertissement affiché (`payment.ts`) | OUVERT |
| AV-219 | Motif d'un écart d'inventaire exigé dès la saisie sur l'appareil | SECONDAIRE | Écrans PWA | Motif exigé par l'appareil sur un écart estimé non nul quand des motifs `INVENTORY_ADJUSTMENT` existent (`REQUIRE_VARIANCE_REASON` dans `apps/pwa/src/features/stock/count.ts`) ; sans motif paramétré, l'écart part sans motif | OUVERT |
| AV-220 | Écran de consommation hors lot (ECR-STK-08) pour le vendeur de PDV et le responsable de production | SECONDAIRE | Écrans PWA | (a) : écran proposé aux quatre rôles, intrants et emballages consommables seulement | OUVERT |
| AV-221 | Annulation directe pendant une clôture de caisse concurrente : condition relue sous verrou | SECONDAIRE | P5 | Condition d'AV-185 relue sous le verrou des caisses après l'annulation ; basculée, la transaction est annulée (`RETRY_LATER`) et le renvoi prend le chemin de la demande (`CANCEL_SESSION_CLOSED`) | OUVERT |
| AV-222 | Gardes des référentiels : valeurs retenues là où une contrainte de la base levait une exception | SECONDAIRE | P5 | (a) : suivi `REQUIRED` par défaut d'un produit biologique, nouvelle version après la fin de la remplacée activée sans la toucher, fin tolérée à 5 min dans le passé, unité ou canal identique recréé sans effet | OUVERT |
| AV-223 | Expédition hors ligne d'une demande qui n'est plus à expédier ; mouvement interne hors de la garde de l'auteur | SECONDAIRE | P5 | (a) : demande refusée ou annulée → expédition directe appliquée et conflit `TRANSFER_REQUEST_CLOSED` ; déjà expédiée → quarantaine `TRANSFER_DISPATCH_CONFLICT` ; mouvement interne au même site, refus `INTERNAL_MOVE_CUSTODY` en ligne et `CUSTODY_DEVICE_MISMATCH` hors ligne | OUVERT |
| AV-224 | Opération de caisse datée entre deux sessions, appliquée après l'ouverture de la suivante | IMPORTANTE | P5 | (a) : l'écart d'ouverture de la session suivante est corrigé (ajustement `LATE_BEFORE_OPENING`, inclus dans sa validation ou à demande propre) | OUVERT |
| AV-225 | Résolution manuelle du signal d'une commande bloquée : la commande reste-t-elle rejouable ? | IMPORTANTE | P5 | (a) : la résolution (`KEEP_SERVER` ou `COMPENSATE`) écarte la commande — inbox `REJECTED`, `COMMAND_DISCARDED` au renvoi | OUVERT |
| AV-226 | Tolérance de date future du pipeline | SECONDAIRE | P5 | Paramètre propre `sync.occurred_at_future_tolerance_minutes` (5 min) | OUVERT |
| AV-227 | Écart d'horloge hors des bornes de stockage | SECONDAIRE | P5 | Écart borné à ±2 147 483 647 ms avant stockage et réponse ; le drapeau reste levé | OUVERT |
| AV-228 | Fait saisi par un appareil encore en attente d'approbation | IMPORTANTE | P5 | (c) : attente (`RETRY_LATER`, `DEVICE_PENDING`), appliqué après l'approbation ; appareil refusé sans approbation : quarantaine de tous ses faits | OUVERT |
| AV-229 | Utilisateur suspendu puis réactivé : fenêtre de quarantaine | IMPORTANTE | P10 | Inchangé (statut courant et `status_changed_at`, comme les appareils avant AV-212) ; table jumelle des périodes recommandée avant la mise en production | OUVERT |
| AV-230 | Quotas actifs d'un emplacement de vente qui passe en garde exclusive | SECONDAIRE | P5 | Refus `POS_ALLOCATIONS_ACTIVE` de la configuration tant qu'un quota est actif (le révoquer ou le libérer d'abord) | OUVERT |
| AV-231 | Sorties de stock hors ligne au-delà du quota du détenteur ou du solde d'un emplacement exclusif | IMPORTANTE | Écrans PWA | Perte seulement signalée, autres sorties refusées sur l'appareil (`OFFLINE_LOSS_GUARD = 'SIGNAL'`) | OUVERT |
| AV-232 | Comptage de la caisse à l'aveugle | IMPORTANTE | Écrans PWA | À l'aveugle : attendu et écart affichés après l'enregistrement du comptage (`CASH_COUNT_BLIND`) | OUVERT |
| AV-233 | Encaissement en espèces au PDV sans caisse ouverte sur l'appareil | IMPORTANTE | Écrans PWA | Invite « Ouvrir la caisse », blocage en ligne, enregistrement signalé hors ligne (`OFFLINE_CASH_WITHOUT_SESSION = 'WARN'`) | OUVERT |
| AV-234 | Demande de réapprovisionnement d'un PDV sans source configurée | SECONDAIRE | Écrans PWA | Le vendeur choisit un magasin actif (`REPLENISH_WITHOUT_SOURCE = 'CHOOSE'`) | OUVERT |
| AV-235 | Demandes de réapprovisionnement en double vers un PDV | SECONDAIRE | Écrans PWA | Le déjà demandé est annoncé, sans blocage (`DUPLICATE_REQUEST = 'ANNOUNCE'`) | OUVERT |
| AV-236 | Ventes et encaissé du jour de l'accueil du PDV | SECONDAIRE | Écrans PWA | Ce que connaît le téléphone, annoncé comme tel ; chiffre complet par le tableau | OUVERT |
| AV-237 | Libération des quotas sur l'appareil | IMPORTANTE | Écrans PWA | Bouton par quota sur l'accueil du PDV, confirmé, reste calculé par l'appareil | OUVERT |
| AV-238 | Détenteurs proposés à l'octroi d'un quota | IMPORTANTE | Écrans PWA | Couples déjà détenteurs sur l'emplacement et l'utilisateur lui-même, jamais d'identifiant saisi | OUVERT |
| AV-239 | Remises de fonds sur l'appareil (UC-FIN-07) | IMPORTANTE | Écrans PWA | Écran hors ligne « Remises de fonds » (`/caisse/remises`) pour les détenteurs de `finance.cash_transfer.record` | OUVERT |
| AV-240 | Remise au-delà du solde indicatif de la caisse | SECONDAIRE | Écrans PWA | Signalée sans blocage | OUVERT |
| AV-241 | Rôles de l'écran de trésorerie (ECR-FIN-05) | SECONDAIRE | Écrans PWA | Finance et Direction | OUVERT |
| AV-242 | Lecture seule au-delà de l'autonomie hors connexion (AV-009) | IMPORTANTE | Écrans PWA | Durée depuis la dernière synchronisation complète ; au-delà, nouvelle opération refusée, consultation et envoi intacts | OUVERT |
| AV-243 | Fait hors ligne antérieur au rattachement de l'appareil à un autre site | SECONDAIRE | P5 | Pas de `DEVICE_OTHER_SITE` pour un fait antérieur au dernier rattachement (`designation_changed_at`) | OUVERT |
| AV-244 | Encaissé : remboursements et doublons approuvés | SECONDAIRE | P5 | Remboursements non retranchés de l'encaissé (lus dans la trésorerie) ; doublon approuvé compté à sa date d'origine | OUVERT |
| AV-245 | Chiffre d'affaires d'un PDV : site entier (accueil) ou emplacement de vente (tableau) | SECONDAIRE | P5 | Deux périmètres, une définition : l'accueil compte le site, le tableau l'emplacement de vente | OUVERT |
| AV-246 | Réception d'achat au-delà du seuil de photo, tant que l'application ne joint pas de photo | IMPORTANTE | MP | Acceptée et marquée « photo manquante », signalée aux Achats ; exigence rétablie avec la photo | **TRANCHÉ** (voir journal §3) |
| AV-247 | Approbation d'un appareil neuf par un responsable : quelle portée ? | IMPORTANTE | MP | Portée déduite des affectations actives de l'utilisateur qui a connecté l'appareil | **TRANCHÉ** (voir journal §3) |
| AV-248 | Motifs de départ : résultats de visite, perte d'un prospect, annulation | IMPORTANTE | MP | Listes semées, désactivables ; « Autre » exige un commentaire | **TRANCHÉ** (voir journal §3) |
| AV-249 | Affichage des unités dans la PWA | SECONDAIRE | MP | Libellés courts au singulier et au pluriel ; repli sur le nom du catalogue puis sur le code | **TRANCHÉ** (voir journal §3) |
| AV-250 | Diagnostic « Tester la synchronisation » de l'application livrée | SECONDAIRE | MP | Bouton retiré | **TRANCHÉ** (voir journal §3) |
| AV-251 | Changement du mot de passe provisoire | IMPORTANTE | MP | Imposé par l'écran à la connexion ; aucun refus serveur | **TRANCHÉ** (voir journal §3) |
| AV-252 | Réinitialisation du mot de passe d'un utilisateur par l'administrateur | IMPORTANTE | MP | Mot de passe provisoire saisi par l'administrateur ; changement imposé à la connexion | **TRANCHÉ** (voir journal §3) |
| AV-253 | Connexion depuis un appareil bloqué, perdu ou retiré | IMPORTANTE | MP | Mot de passe correct : message distinct pour l'appareil ; compte suspendu : message générique, motif à l'audit | **TRANCHÉ** (voir journal §3) |
| AV-254 | Approbation du premier appareil d'administration d'une installation neuve | IMPORTANTE | MP | Commande d'installation lancée sur le serveur, tracée ; aucune exception dans l'application | **TRANCHÉ** (voir journal §3) |
| AV-255 | Ventes signalées de l'accueil : quels drapeaux comptent comme anomalie ? | SECONDAIRE | MP | Tous comptés, ventilés par type dans le détail ; avertissement réservé aux drapeaux de contrôle | OUVERT |
| AV-256 | Valeur du stock de l'entreprise : la marchandise en transit compte-t-elle ? | SECONDAIRE | MP | Comprise pour toute l'entreprise (« dont X en transit ») ; hors transit pour un site | OUVERT |
| AV-257 | Permissions des rôles modifiables depuis l'application ? | SECONDAIRE | MP | Rôles figés par le seed versionné au MVP ; seules les affectations se gèrent à l'écran | OUVERT |
| AV-258 | Auto-approbation d'un appareil par le responsable qui l'a connecté | IMPORTANTE | MP | Refusée (`SELF_APPROVAL_FORBIDDEN`) pour approuver et débloquer, sauf l'Admin | **TRANCHÉ** (voir journal §3) |
| AV-259 | Rattachement d'un appareil à un site hors de la portée du responsable | SECONDAIRE | MP | Refusé : le site cible doit être dans la portée de l'auteur (`FORBIDDEN_SCOPE`) ; l'Admin rattache partout | **TRANCHÉ** (voir journal §3) |
| AV-260 | Tablette rattachée à un site : relève-t-elle du responsable de ce site ? | SECONDAIRE | MP | Oui : le site de rattachement compte dans la portée, en plus des affectations de l'utilisateur qui l'a connectée | **TRANCHÉ** (voir journal §3) |
| AV-261 | Lecture des appareils par le Responsable production | SECONDAIRE | MP | `identity.device.read` en portée `SITE` ajouté (il approuve et bloque déjà) | **TRANCHÉ** (voir journal §3) |
| AV-262 | Remise au-delà du plafond ou dépassement d'encours refusés après coup : quel effet ? | SECONDAIRE | MP | Décision tracée sans effet sur la vente ; le refus reste visible dans l'historique de la demande | OUVERT |
| AV-263 | Plafond d'approbation des dépenses par rôle (Resp. production « ≤ seuil, fermes », RC-06) | SECONDAIRE | P8 | Limite `maxAmountXaf` du droit de l'approbateur vérifiée à la décision ; aucune valeur semée | OUVERT |
| AV-264 | Dépense au-delà du seuil sans politique `EXPENSE` active | SECONDAIRE | P8 | Pas de validation (comme les pertes) ; politique `EXPENSE_DEFAULT` semée | OUVERT |
| AV-265 | Dépense hors ligne non conforme, dépense hors ligne non payée | IMPORTANTE | P8 | Appliquée puis placée en validation a posteriori avec motif ; la saisie hors ligne non payée est admise | OUVERT |
| AV-266 | Plafond d'une petite dépense payée par la caisse du PDV (BR-DIS-013) | SECONDAIRE | P8 | `finance.pos_expense_max_xaf` = 50 000 | OUVERT |
| AV-267 | Session de caisse pour une dépense payée par la caisse du PDV | IMPORTANTE | P8 | Exigée comme pour un encaissement : refus en ligne, conflit `CASH_SESSION_MISSING` hors ligne | OUVERT |
| AV-268 | Dépense rejetée après paiement : « imputée au déclarant » | SECONDAIRE | P8 | Reclassée `NON_JUSTIFIEE`, responsabilité du déclarant enregistrée ; recouvrement hors application | OUVERT |
| AV-269 | Dépense imputée à un site | SECONDAIRE | P8 | Avec espèce : frais généraux répartis ; sans espèce : dépense directe du site (PDV compris) ; une espèce par dépense | OUVERT |
| AV-270 | Catégories de dépense : type de coût, PDV, administration | SECONDAIRE | P8 | Type de coût par catégorie (défaut `DEPENSE_DIRECTE`) ; catégories du PDV : transport, carburant, fournitures, entretien, divers ; `NON_JUSTIFIEE` système ; gérées par Finance et Administrateur | OUVERT |
| AV-271 | Facture fournisseur sans bon de commande | SECONDAIRE | P8 | Mise en revue (`MISMATCH`) ; paramètre `finance.invoice_without_po_mode` | OUVERT |
| AV-272 | Avoir fournisseur | IMPORTANTE | P8 | Annulation motivée de la facture contestée puis facture rectificative (même référence admise) ; pas d'entité avoir | OUVERT |
| AV-273 | Échéance par défaut d'une facture fournisseur | SECONDAIRE | P8 | Saisie, sinon date de facture + délai du fournisseur, sinon date de facture | OUVERT |
| AV-274 | Réception ou bon de commande annulé après facturation | SECONDAIRE | P8 | Pas de garde côté achats ; écart « facturé > accepté » lisible au rapprochement, approbation non informée refusée, corrigé par avoir | OUVERT |
| AV-275 | Avances fournisseurs et affectation ultérieure | SECONDAIRE | P8 | Avance admise (`finance.supplier_advance_allowed`) ; affectation ultérieure par `finance.supplier_payment.allocate`, complément sur la même facture regroupé | OUVERT |
| AV-276 | Paiement fournisseur validé : date du décaissement, factures payées entre-temps | SECONDAIRE | P8 | Décaissement daté de la décision ; décision refusée si une affectation dépasse le solde | OUVERT |
| AV-277 | Annulation d'un paiement fournisseur enregistré | SECONDAIRE | P8 | Par la Direction, avec motif, sans demande séparée | OUVERT |
| AV-278 | Lecture des factures, paiements fournisseurs et de la vue d'ensemble financière | SECONDAIRE | P8 | `finance.payable.read` (Direction, Resp. achats, Finance), portée `ALL` | OUVERT |
| AV-279 | Chiffre d'affaires d'un lot de production | IMPORTANTE | P8 | Ventes du lot et de ses produits d'abattage ; œufs exclus (déjà valorisés par le crédit au coût standard) | OUVERT |
| AV-280 | Règles d'un nouveau mot de passe : longueur maximale, réemploi | SECONDAIRE | MP | 8 à 128 caractères ; différent de celui qu'il remplace (le provisoire ne peut pas être gardé) ; aucune règle de composition, d'historique ni d'expiration | OUVERT |
| AV-281 | Gardes de la réinitialisation du mot de passe par l'Admin | SECONDAIRE | MP | Pas son propre compte (changement avec l'actuel), pas un compte désactivé ni le compte système ; compte suspendu accepté ; verrouillage de l'identifiant levé | OUVERT |
| AV-282 | Session révoquée ou compte suspendu : refus immédiat des requêtes ? | IMPORTANTE | MP | Blocage immédiat : session, compte et appareil vérifiés à chaque requête (cache de 5 s, vidé à chaque révocation) | TRANCHÉ |
| AV-283 | « Classer » une opération refusée ou en conflit sur l'appareil | SECONDAIRE | MP | Marque locale `ACKNOWLEDGED`, statut et opération conservés ; par son seul auteur ; conflit classé sans être réglé ; aucun archivage à 30 jours | OUVERT |
| AV-284 | « Encaisser le reste dû » depuis le reçu : sort du surplus | SECONDAIRE | MP | Montant prérempli au reste dû ; affecté à la seule vente du reçu ; le surplus reste en avoir du client ; « Répartir sur toutes les créances » revient à l'affectation automatique | OUVERT |
| AV-285 | Régularisation de la « photo manquante » d'une réception | IMPORTANTE | MP | Close automatiquement à la réception de la photo du bon ; clôture manuelle par le Resp. achats avec motif | TRANCHÉ |
| AV-286 | Photo visible par les valideurs | IMPORTANTE | MP | Oui dès MP-10 : lecture protégée par la portée sur le document ou la décision en attente | TRANCHÉ |
| AV-287 | Chiffrement des photos en attente sur le téléphone | IMPORTANTE | MP | Pas encore (comme la file des opérations) ; chiffrement de tout le stockage local avant la production | TRANCHÉ |
| AV-288 | Photo d'une perte hors mortalité | IMPORTANTE | MP | Toujours facultative ; seule la mortalité l'exige avant l'approbation | TRANCHÉ |
| AV-289 | Validation d'une réception sans BC dont la photo manque | SECONDAIRE | MP | Inchangée : seules les pièces citées par la réception sont exigées | OUVERT |
| AV-290 | Photo refusée ou jamais reçue | SECONDAIRE | MP | Nouvelle photo à prendre ; aucune relance automatique ; `MISSING` à 7 jours et alerte en P9 | OUVERT |
| AV-291 | Formats, nombre et budget local des photos | SECONDAIRE | MP | Images recodées en JPEG ; une photo par opération ; 50 Mo en attente au plus, au-delà l'opération part sans photo | OUVERT |
| AV-292 | Stockage des fichiers pour le pilote | SECONDAIRE | MP | Disque local du serveur (`ATTACHMENTS_STORAGE_DIR`) sur un volume sauvegardé ; stockage objet avec AV-091 | OUVERT |
| AV-293 | Métadonnées des pièces jointes servies à tous les appareils | SECONDAIRE | MP | Inchangé : le flux de la pièce reste en portée `GLOBAL` (repli générique du pipeline) ; contenu protégé par la lecture | OUVERT |
| AV-294 | Politiques de contrôle des achats par défaut | IMPORTANTE | MP | Une politique par type (demande d'achat, BC au-delà du seuil, réception sans BC, en quarantaine, annulation), sans condition, approbateur selon 01-rbac, portée `ALL` | OUVERT |
| AV-295 | Droit de décider une validation, jugé aussi à la réception | SECONDAIRE | MP | Date déclarée et réception par le serveur (décision en ligne seulement) | OUVERT |
| AV-296 | Appareil non partagé lié à l'utilisateur qui l'a connecté | SECONDAIRE | MP | Inchangé : tout compte valide peut se connecter sur un appareil connu et en prend le statut (risque assumé au MVP) | OUVERT |
| AV-297 | Verrouillage de connexion : essais simultanés, adresse derrière un proxy | SECONDAIRE | MP | `TRUST_PROXY` et limitation de débit au proxy ; réservation atomique de l'essai à faire avant la production | OUVERT |
| AV-298 | Accès aux écrans de finance et action « + Dépense » de l'accueil | SECONDAIRE | P8 | Finance : tout ; Direction : lecture, file, annulation d'un paiement ; Achats : lecture ; « + Dépense » au menu des dix rôles et sur l'accueil des rôles de terrain (la Finance a le suivi des dépenses, les factures et les paiements fournisseurs) | OUVERT |
| AV-299 | Marges par produit, point de vente et commercial | IMPORTANTE | P8 | Lots et période en P8 ; axes dans l'explorateur de P9 | OUVERT |
| AV-300 | Ce que P8 ajoute à la trésorerie | SECONDAIRE | P8 | Dépenses à payer, paiements en attente de la Direction, lien des mouvements vers leur document | OUVERT |
| AV-301 | Site et imputation proposés à la saisie d'une dépense | SECONDAIRE | P8 | Site de la caisse qui paie, sinon seul site des affectations, sinon choix ; imputation proposée : dépense directe du site | OUVERT |
| AV-302 | Périmètre de l'écran de rapprochement des achats (ECR-APP-05) | SECONDAIRE | P8 | Resp. achats, Finance et Direction en lecture ; « Réceptions » du Resp. achats y mène ; date prévue dépassée montrée sans seuil, l'alerte reste celle de P9 | OUVERT |
| AV-303 | Périmètre de l'écran « Coûts et marges » (ECR-FIN-06) | SECONDAIRE | P8 | Finance et Direction, menu seulement ; mois en cours par défaut, un an au plus ; marge d'un lot choisi parmi les 50 plus récents par statut ; pertes = déclarations, quantités par produit | OUVERT |
| AV-304 | Périmètre de l'écran des créances (ECR-FIN-01) | SECONDAIRE | P8 | Finance, Direction et Resp. commercial ; action « Créances » de la Finance ; créances seules, situation du jour, à échoir à part ; relances hors de l'application ; liste complète | OUVERT |
| AV-305 | Créances hors de la liste et écarts avec l'accueil (ECR-FIN-01) | SECONDAIRE | P8 | Écran tel quel, ventes sans échéance annoncées comme exclues ; correctifs serveur groupés (nom et compte conservé dans les lignes, montant sans échéance, action du signal, titulaire unique, date inexistante refusée) | OUVERT |
| AV-306 | Pièce citée par une opération : existence, document et auteur non vérifiés | SECONDAIRE | P8 | Présomption conservée jusqu'au pilote ; contrôle serveur groupé avec AV-093 et AV-293 | OUVERT |
| AV-307 | Poste de bureau des rôles de bureau et exception de RC-02 | SECONDAIRE | P8 | Approuvé comme tout appareil (défaut implémenté) ; exemption à décider | OUVERT |
| AV-308 | Référence de la pièce papier : champ dédié ou généralisation de `local_ref` | IMPORTANTE | PP | Champ dédié, sans unicité (doublon signalé, jamais rejeté) | OUVERT |
| AV-309 | Rendu des pièces : composants de la PWA, police libre, consultation et impression sur le même rendu | IMPORTANTE | PP | Un composant par type de pièce, alimenté hors ligne ; police libre embarquée | OUVERT |
| AV-310 | Mentions de la pièce imprimée : numéro, duplicata, annulation, données personnelles | SECONDAIRE | PP | Numéro de l'application, DUPLICATA, bandeau ANNULÉE, mêmes droits qu'à l'écran | OUVERT |
| AV-311 | Journal de caisse imprimé : contenu hors ligne et pagination | SECONDAIRE | PP | Complet en ligne, partiel hors ligne, feuilles de 28 lignes avec report | OUVERT |
| AV-312 | Registre des carnets : contrôle de continuité | SECONDAIRE | PP | Manques et doublons d'après les références saisies, à la demande | OUVERT |
| AV-313 | Présence du personnel non commercial | IMPORTANTE | PP | Table légère alimentée par la fiche PT ; usage statistique, pas de paie | OUVERT |
| AV-314 | Bilan hebdomadaire du commercial | SECONDAIRE | PP | Entité propre et écran ; chiffres calculés, jamais saisis | OUVERT |
| AV-315 | Veille marché dans la visite | SECONDAIRE | PP | Table fille de la visite (fournisseur ou concurrent, produit, unité, prix) | OUVERT |
| AV-316 | Profil commercial du client | IMPORTANTE | PP | Trois champs sur le compte ; demande de crédit distincte de la décision | OUVERT |
| AV-317 | Écran de report et import par lots des pièces papier | IMPORTANTE | PP | Report par type de pièce ; import validé avant chargement, par les commandes existantes | OUVERT |
| AV-318 | Politiques de validation par défaut du stock et du pointage | IMPORTANTE | MP | Une politique par type, sans condition (`TRANSFER_DISCREPANCY`, `INVENTORY_ADJUSTMENT`, `CHECKIN_OVERRIDE`) ; **implémenté** (MP-12) | OUVERT |
| AV-319 | Cadence du tirage de l'appareil et écriture du dernier pull | IMPORTANTE | MP | 30 s au premier plan, rien en arrière-plan, attente progressive hors réseau, dernier pull écrit au plus une fois par minute ; **implémenté** (MP-12) | OUVERT |
| AV-320 | Motifs par défaut des autres catégories (rejet, inventaire, écart de transfert, prix) | IMPORTANTE | MP | Listes courtes désactivables, « Autre » avec commentaire ; **non implémenté** : l'administrateur crée les motifs | OUVERT |
| AV-321 | Quantités préremplies à la réception d'un transfert et d'un bon de commande | SECONDAIRE | MP | Préremplies à l'expédié ou au reste (comportement actuel) | OUVERT |
| AV-322 | Appareil enrôlé et jamais approuvé : ancienneté dans le signal d'accueil | SECONDAIRE | MP | Signal inchangé, appareils refusés par l'Admin ; **non implémenté** | OUVERT |
| AV-323 | Opérations sans pièce papier propre | SECONDAIRE | PP | Mise en page générique à la charte (logo, couleurs, numéro de l'application, rubriques de la commande) | OUVERT |
| AV-324 | Identité de la société imprimée sur les pièces | SECONDAIRE | PP | Paramètres de l'organisation ; rubrique vide imprimée en pointillés | OUVERT |
| AV-325 | Création d'un compte par l'Admin : mot de passe provisoire hors du journal des commandes | IMPORTANTE | MP | Route en ligne `POST /users` hors journal, comme la réinitialisation (ADR-045) ; **implémenté** (MP-13) | OUVERT |
| AV-326 | Périmètres proposés à l'affectation d'un rôle depuis l'écran des comptes | SECONDAIRE | MP | `GLOBAL` et `SITE` ; zones et équipes avec `GET /zones` et `GET /teams` (S-19, S-28) ; **implémenté** (MP-13) | OUVERT |
| AV-327 | L'Admin gère-t-il les rôles de son propre compte ? | SECONDAIRE | MP | Oui, comme les autres comptes ; INV-ADM-01 garde un ADMIN actif ; **implémenté** (MP-13) | OUVERT |
| AV-328 | Suspendre ou désactiver son propre compte | SECONDAIRE | MP | Refusé (`OWN_ACCOUNT`) : un autre Admin le fait ; **implémenté** (MP-13) | OUVERT |
| AV-329 | Indicateurs des tableaux sans mesure égale dans l'explorateur (AT-054) | SECONDAIRE | P9 | Mortalité lue dans `f_losses` (catégorie `MORTALITE`) ; « Pertes » (nombre de déclarations) et « Écarts d'inventaire » (valeur nette) sans équivalent déclaré ; nouveaux clients comptés aussi sans titulaire hors portée personnelle | OUVERT |
| AV-350 | Seuils des alertes : où les paramétrer | SECONDAIRE | P9 | Seuils dans `organization.system_settings` (historisés) ; `alert_rules` ne porte ni seuil ni paramètre de détection | OUVERT |
| AV-351 | Gravité d'une alerte dont le niveau varie | SECONDAIRE | P9 | Gravité fixée à la levée par l'événement ; relèvement seulement, jamais d'abaissement tant que l'alerte est ouverte ; `critical_since` mesure l'escalade | OUVERT |
| AV-352 | Types d'alerte ajoutés au catalogue ; types sans source | SECONDAIRE | P9 | Six types ajoutés (`ALLOCATION_EXPIRED`, `ALLOCATION_REVOCATION_PENDING`, `SALE_UNDELIVERED`, `CONSUMER_FAILED`, `LEDGER_MISMATCH`, `CASH_MISMATCH`) ; `KOMMO_SYNC_FAILED` au catalogue, règle désactivée jusqu'à P10 | OUVERT |
| AV-353 | Résolution automatique des alertes d'état | SECONDAIRE | P9 | Passe planifiée à identité (`pass_id`) : un événement par sujet vrai, puis marqueur de fin de passe complète ; le consommateur résout les alertes `AUTO` non revues par cette passe | OUVERT |
| AV-354 | Alerte d'événement : résolution, écart, nouvelle occurrence | SECONDAIRE | P9 | Résolution manuelle avec commentaire ; écart avec motif réservé aux alertes d'événement ; une occurrence après résolution ou écart crée une nouvelle alerte | OUVERT |
| AV-355 | Alertes de stock « sur mouvement » | IMPORTANTE | P9 | `inventory` publie la transition de franchissement (seuil, zéro, négatif) dans la transaction du mouvement ; passe horaire en filet (événements `breached` vrai et marqueurs de passe) ; sujet = couple emplacement × produit | OUVERT (implémenté en P9-08, défaut a) |
| AV-356 | Alertes de perte anormale et de mortalité élevée | SECONDAIRE | P9 | Perte : valeur d'un emplacement sur un jour ≥ 50 000 XAF (`inventory`) ou ≥ 5 % du CA net du jour métier (`sales`) ; mortalité : seuils d'AV-121 (0,5 % ou 20 têtes, `production`) | OUVERT |
| AV-357 | Pièce requise jamais reçue (`ATTACHMENT_MISSING`) | IMPORTANTE | P9 | Pièce attendue (justificatif de dépense, photo de réception) non reçue après 7 jours ; détection par le module qui l'exige, via l'API publique d'`attachments` | OUVERT |
| AV-358 | Demande d'approbation en attente ; escalade ; sans approbateur | IMPORTANTE | P9 | En attente depuis plus de 24 h : alerte aux approbateurs (titulaires de la permission d'approbation dans le périmètre, demandeur exclu) et à la Direction, `escalated_at` écrit par `approvals` ; la détection « sans approbateur » est différée jusqu'à la lecture inverse d'`identity` | OUVERT |
| AV-359 | Commercial inactif (`INACTIVE_COMMERCIAL`) | SECONDAIRE | P9 | BR-TER-013 : sans prise de service, visite ni vente un jour ouvré (lundi à samedi), alerte le lendemain à 08:00 ; détecteur dans `sales` | OUVERT |
| AV-360 | Réception incomplète (`RECEIPT_INCOMPLETE`) | SECONDAIRE | P9 | BR-APP-015 : bon de commande dont la date prévue est dépassée de plus de 2 jours avec un reliquat, ou réception comportant une quantité rejetée ; auto-résolue à reliquat nul ou clôturé | OUVERT |
| AV-361 | Tâches planifiées de détection : créneaux | SECONDAIRE | P9 | Créneaux de D13 §7.1 en heure de Douala, constantes de planification dans le module ; les tâches déjà écrites mais jamais planifiées (et la vérification de chaîne d'audit) reçoivent leur récurrence | OUVERT |
| AV-362 | Consommateur d'événements en échec | SECONDAIRE | P9 | Table d'ajout seul des événements sautés, écrite par le runner de plateforme ; alerte technique `CONSUMER_FAILED` (ADMIN) lue sur cette table et sur le retard | OUVERT |
| AV-363 | Destinataires d'une alerte | IMPORTANTE | P9 | Règle (rôles × site ou zone), propriétaire, responsable d'équipe, approbateur, repli sur la Direction ; fixés à la levée, complétés sans retrait | OUVERT |
| AV-364 | Canaux de notification par gravité | SECONDAIRE | P9 | `CRITICAL` : in-app et push immédiat ; `WARNING` : in-app ; `INFO` : centre d'alertes seulement | OUVERT |
| AV-365 | Web Push : bibliothèque, clés et repli | IMPORTANTE | P9 | Port `WebPushSender` ; adaptateur journal par défaut ; sans clés VAPID ni abonnement valide, notification in-app seulement | OUVERT |
| AV-366 | Regroupement des notifications push | SECONDAIRE | P9 | Au plus un push par utilisateur et par type toutes les 15 minutes, créneau décidé sous le verrou de l'alerte ; les suivantes restent in-app, comptées au push suivant ; l'escalade n'est jamais regroupée | OUVERT |
| AV-367 | Escalade d'une alerte critique | SECONDAIRE | P9 | 4 h sans prise en compte, mesurées depuis `critical_since` ; niveau supérieur = rôles d'escalade de la règle (Direction par défaut) ; une seule escalade par alerte | OUVERT |
| AV-368 | Prise en compte d'une alerte hors ligne | SECONDAIRE | P9 | `communication.alert.acknowledge` admise hors ligne ; sans effet sur une alerte déjà résolue ou écartée, ni sur une escalade déjà posée ; le serveur le dit | OUVERT |
| AV-369 | Notes de direction : audience, brouillon, expiration, correction | SECONDAIRE | P9 | Audience `ALL`, rôle, site, zone, utilisateur évaluée à la lecture en ligne ; lignes de flux `USER` résolues à la publication ; immuable après publication ; brouillon abandonné = `ARCHIVED` ; note corrective = nouvelle note ; accusé optionnel par note | OUVERT |
| AV-370 | Note automatique à l'activation d'une règle tarifaire | SECONDAIRE | P9 | Non livrée : l'événement `PriceRuleActivated` ne crée pas de note ; la Direction publie la note | OUVERT |
| AV-371 | Limites de l'explorateur | SECONDAIRE | P9 | 10 000 lignes affichées, 100 000 exportées, 15 s d'exécution, trois ans de période détaillée, deux requêtes simultanées par utilisateur ; le dépassement est une erreur, pas une troncature | OUVERT |
| AV-372 | Mesures protégées : refus ou masquage | SECONDAIRE | P9 | Explorateur et export : refus `FORBIDDEN_MEASURE` ; tableaux : valeur masquée (ADR-035) ; toute valeur au coût est protégée (perte, achat, coût, marge, valeur de stock) | OUVERT |
| AV-373 | Étendue exacte des lignes d'un jeu de faits | IMPORTANTE | P9 | Étendue exacte (union de clauses site, zone avec descendantes, titulaire) calculée par évaluation de la permission de lecture du jeu sur les univers finis ; combinaison non énumérable = aucune ligne ; jamais tirée de `listConfinementAt` | OUVERT |
| AV-374 | Jeux de faits livrés en P9 | SECONDAIRE | P9 | Les treize jeux du dictionnaire, par domaine ; `f_sales_line` sans dimension « lot » (CA d'un lot par `lotRevenue`) ; `f_attendance` par personne seulement ; une dimension n'est déclarée que si sa source existe | OUVERT |
| AV-375 | Zone d'une ligne de fait : zone seule ou zone et ancêtres | SECONDAIRE | P9 | La dimension `zone` filtre par la zone et ses descendantes ; le regroupement se fait au niveau choisi | OUVERT |
| AV-376 | Chiffre d'affaires : deux calculs à rapprocher | IMPORTANTE | P9 | `period-activity.ts` fait référence (KPI-COM-07, 08) ; `periodRevenue` : CA égal par construction, attribution (commercial attribué) et nombre de ventes (annulées comprises) distincts, nommés à part ; tout écart devient un correctif minimal tracé | OUVERT |
| AV-377 | Annulations dans l'explorateur | SECONDAIRE | P9 | Mesures par période d'activité par défaut (annulation appliquée, datée de `applied_at`) ; mesure « net par date de vente » distincte, colonne de date propre (`sale_day`), libellé différent ; mélange refusé | OUVERT |
| AV-378 | Remontée d'un chiffre jusqu'aux sources | SECONDAIRE | P9 | Deux niveaux : bloc → exploration filtrée → document ; registre de stock par `GET /stock-moves` (emplacement obligatoire) et audit par les lectures existantes | OUVERT |
| AV-379 | Contenu de la tour de contrôle et des tableaux de rôle | IMPORTANTE | P9 | Sept blocs de D11 §7.2 ; période précédente pour les flux seulement ; blocs indépendants ; indicateurs sans fonction publique créés dans les modules propriétaires | OUVERT |
| AV-380 | Instantanés personnels : fréquence, périodes, utilisateurs, retrait | SECONDAIRE | P9 | Toutes les 15 minutes, `TODAY`, `WEEK`, `MONTH`, pour les titulaires d'un tableau dont un appareil a contacté le serveur depuis 7 jours ; lignes supprimées (avec `DELETE` publié) à la perte du droit ou de l'appareil actif | OUVERT |
| AV-381 | Jeu hors ligne `kpi` | SECONDAIRE | P9 | Une ligne par (tableau, période), portée `USER`, republiée au changement de contenu ou toutes les heures pour la date | OUVERT |
| AV-382 | Vues sauvegardées : partage, vue par défaut, lecture | SECONDAIRE | P9 | Partage par rôle ; aucun droit supplémentaire ; vue par défaut d'un rôle ; suppression physique par le propriétaire, auditée ; listage avec état d'exécutabilité | OUVERT |
| AV-383 | Exports : formats, asynchronie, durée de vie | SECONDAIRE | P9 | CSV (UTF-8 avec BOM, `;`) et XLSX (écrivain interne) ; toujours asynchrone ; échec métier consigné `FAILED` sans rejeu ; téléchargement authentifié 24 h ; fichier purgé à 30 jours | OUVERT |
| AV-384 | Droit d'exporter et de télécharger un export | SECONDAIRE | P9 | `analytics.export` + droit de lecture du jeu + `inventory.valuation.read` pour les mesures protégées, à la demande et au calcul ; téléchargement réservé au demandeur, audité | OUVERT |
| AV-385 | Permissions de P9 : codes réutilisés | SECONDAIRE | P9 | `analytics.view.save` = `analytics.explore` ; `analytics.export.request` = `analytics.export` ; abonnements push et lecture de notifications sous `comm.alert.read` ; accusé de note sous `comm.note.read` | OUVERT |
| AV-386 | Volumétrie cible et paliers analytiques | IMPORTANTE | P9 | Palier 1 (vues SQL, instantanés) ; passage au palier 2 sur mesure : p95 > 3 s ou 20 millions de lignes de faits ; jeu de charge d'un million de lignes de vente | OUVERT |
| AV-387 | Rétention des données de communication et d'analyse | SECONDAIRE | P9 | Alertes 2 ans après résolution (rôle de maintenance), notifications 90 jours après lecture, abonnements invalides à la révocation, fichiers d'export 30 jours, journal des requêtes 90 jours ; marques, événements, audit conservés | OUVERT |
| AV-388 | Délai événement → alerte et fenêtre de stabilisation | IMPORTANTE | P9 | Fenêtre de 120 s de la plateforme conservée (tolérance documentée) ; délai et retard mesurés ; option de fenêtre propre à `communication.alerts` si la mesure l'exige | OUVERT |
| AV-389 | Notifications directes d'événements (hors alerte) | SECONDAIRE | P9 | Notification in-app directe pour les décisions de validation (demandeur), les demandes de validation (approbateurs du périmètre, sous B1), les transferts expédiés (destinataire) et les demandes d'achat décidées (demandeur) ; sans alerte ni push | OUVERT |
| AV-390 | Valeurs au coût dans les alertes et notifications | IMPORTANTE | P9 | Texte neutre pour les destinataires sans `inventory.valuation.read` (évalué au site de l'alerte) ; valeurs protégées en champs séparés de la charge utile, jamais dans `message` | OUVERT |
| AV-391 | Sujet d'une alerte à clé composite | SECONDAIRE | P9 | UUID version 5 déterministe du couple (emplacement × produit, PDV × produit, lot × jour) ; clé de déduplication lisible ; lot exclu de la clé d'un seuil de stock | OUVERT |
| AV-392 | Alerte d'erreur de synchronisation (`SYNC_ERROR`) | SECONDAIRE | P9 | Passe planifiée de la couche `sync` sur la boîte des commandes (`REJECTED` et `CONFLICT`, liste de codes explicite) ; sujet = appareil × code d'erreur ; auto-résolue par marqueur ou par `SyncConflictResolved` | OUVERT |
| AV-393 | Rôles destinataires d'un déclencheur à rôles propres, règle modifiée | SECONDAIRE | P9 | Les rôles propres d'un déclencheur (`DUPLICATE_SUSPECTED`) valent tant que la règle du type n'a pas été modifiée ; une règle modifiée par un administrateur vaut pour tout le type | OUVERT |
| AV-394 | Rôles suivis par `INACTIVE_COMMERCIAL` | SECONDAIRE | P9 | Le rôle `COMMERCIAL_TERRAIN` seul (BR-TER-013), paramètre `sales.inactive_commercial_role_codes` ; congés, jours fériés et activité hors ligne tardive non gérés | OUVERT |
| AV-395 | `PRICE_MISMATCH` : ventes directes et commandes hors ligne | SECONDAIRE | P9 | Une alerte INFO par vente directe ou par commande saisie hors ligne dont le prix figé diffère du prix résolu à la date du fait ; le conflit de synchronisation reste la trace de traitement | OUVERT |
| AV-396 | Avance client : doublon probable non contrôlé | SECONDAIRE | P9 | Seule la référence identique d'une avance est mise de côté et signalée (alerte `DUPLICATE_SUSPECTED`) ; le doublon probable (montant identique dans la fenêtre) n'est contrôlé que pour les encaissements de vente et de commande | OUVERT |
| AV-397 | Encaisse élevée ou sans remise (`CASH_HOLDING_HIGH`) : définition | IMPORTANTE | P9 | Caisse d'utilisateur active de solde positif ; plafond 200 000 XAF ou plus de 3 jours métier depuis la plus récente de la dernière remise non annulée et de l'entrée de l'espèce encore détenue (FIFO) ; 0 désactive un critère ; tâche horaire | OUVERT |
| AV-398 | `CASH_MISMATCH` : jour métier et écarts sans compte | SECONDAIRE | P9 | Un événement par compte et par jour métier de l'exécution ; les écarts sans compte (dépenses, documents fournisseurs) sous la clé `NONE` ; la tâche réussit au lieu d'échouer | OUVERT |
| AV-399 | `ATTACHMENT_MISSING` des dépenses : délai, référence, horizon et rattachement | SECONDAIRE | P9 | Délai de 7 jours compté depuis la réception par le serveur ; horizon de balayage de 90 jours (`attachments.missing_alert_horizon_days`, au moins le délai plus un jour) ; 0 jour ferme les alertes ouvertes ; passe de portée `EXPENSE` ; pièce rattachée avec `owner_type = EXPENSE` | OUVERT |
| AV-400 | `CASH_VARIANCE` : écart toléré, ajustement d'ouverture, ajustements restants | SECONDAIRE | P9 | Un écart dans la tolérance est un constat sans alerte ; l'ajustement de l'écart d'ouverture (AV-224) publie lui aussi l'événement ; une validation d'office ferme l'alerte ; les ajustements encore en attente sont signalés de nouveau ; l'imputé n'est pas destinataire | OUVERT |
| AV-401 | `SALE_UNDELIVERED` : livraison demandée à une date ultérieure | SECONDAIRE | P9 | L'ancienneté se compte depuis la plus tardive de la confirmation de la vente et de la date de livraison demandée par le client | OUVERT |
| AV-402 | `POS_REPLENISH` : condition, cadence et destinataires | SECONDAIRE | P9 | La suggestion « cible − disponible − transit entrant » est positive (D13 littéral, `BELOW_TARGET`), jugée par la passe horaire des seuils ; `inventory.replenish_alert_scope` = `BELOW_MINIMUM` limite aux points de vente sous leur minimum ; aucun événement sur mouvement ; le magasinier d'un autre site que le PDV n'est pas destinataire | OUVERT |
| AV-403 | `HIGH_LOSS` (seuil absolu) : cumul du jour, mortalité, déclarations en attente | IMPORTANTE | P9 | Cumul de l'emplacement sur le jour métier du fait, déclarations en attente comptées, mortalité exclue ; un événement par déclaration tant que le cumul atteint `inventory.high_loss_alert_xaf` (site, à défaut global) | OUVERT |
| AV-404 | `LOT_EXPIRING` : périmètre, sujet et horizon | SECONDAIRE | P9 | Tout lot ouvert qui porte une date de péremption et du stock physique (fournisseur, œufs, abattage), un sujet par lot, par site et par produit, un lot périmé avec du stock reste signalé ; passe quotidienne 06:00 ; horizon en jours du calendrier, 0 admis | OUVERT |
| AV-405 | `HIGH_LOSS` : part « % du CA » | SECONDAIRE | P9 | Perte d'un emplacement ≥ `sales.high_loss_alert_sales_pct` % du CA net du site du jour ; les deux derniers jours clos, à 06:45 le lendemain ; au plus un événement par emplacement et par jour ; sans vente, seul le seuil absolu joue | OUVERT |
| AV-406 | `INVENTORY_VARIANCE` : seuil, levée et fermeture | SECONDAIRE | P9 | Seuil d'alerte = seuil d'approbation de l'écart ; levée à la soumission quand la validation est requise (valeur ou animaux) ; fermée par `InventoryAdjusted` à la comptabilisation approuvée ; le rejet laisse l'alerte ouverte | OUVERT |
| AV-407 | Date de détection des alertes de stock issues d'un fait | SECONDAIRE | P9 | Les événements d'alerte d'`inventory` sont datés de l'horloge du serveur à la détection (escalade de 4 h comptée depuis elle, un résolveur ne précède pas la levée) ; le jour métier de la charge utile reste celui du fait | OUVERT |
| AV-408 | `TRANSFER_NOT_RECEIVED` : délai, site et destinataires | SECONDAIRE | P9 | Transferts `STANDARD` expédiés non reçus au-delà de `inventory.transfer_not_received_hours` (site de l'expéditeur, à défaut global, 48 h) depuis l'expédition ; passe quotidienne 06:30 ; alerte au site de réception, propriétaires : l'expéditeur et le gardien exclusif de l'emplacement destinataire | OUVERT |
| AV-409 | `LEDGER_MISMATCH` : sujet, site et réussite de la tâche | IMPORTANTE | P9 | Un événement par site et par jour métier ; les anomalies sans site (conservation d'un produit) sous la clé `GLOBAL`, sans site ; la tâche de réconciliation se termine en succès (l'alerte et le journal sont le signal) ; une anomalie persistante lève une alerte par jour ; échantillon borné dans la charge utile | OUVERT |
| AV-410 | Résolution de `TRANSFER_UNMATCHED`, `ALLOCATION_EXPIRED` et `ALLOCATION_REVOCATION_PENDING` | SECONDAIRE | P9 | `BlindReceiptMatched` (sujet : la réception) ferme `TRANSFER_UNMATCHED` ; `AllocationRevocationCleared` ferme la révocation en attente ; passe quotidienne à identité pour l'échéance et filet des révocations ; plus de déduplication « par jour » | OUVERT |
| AV-411 | `HIGH_MORTALITY` : effectif de référence, sujet, cadence et couverture | IMPORTANTE | P9 | Cumul des morts du jour métier du fait (validées et en attente) d'un lot, sur l'effectif en élevage au début du jour (repli : après la saisie plus les morts du jour) ; comparaisons strictes aux seuils d'AV-121 (site, à défaut global) ; une alerte par lot et par jour ; un événement par saisie tant que le cumul reste au seuil ; l'autre voie de déclaration (`inventory.loss.declare`) n'est pas couverte | OUVERT |
| AV-412 | `DAILY_ENTRY_MISSING` : saisie du jour, lots examinés, jours et résolution | IMPORTANTE | P9 | Aucune mortalité, intrant, pesée, observation ni collecte datés de la veille pour un lot `ACTIVE` ou `SELLING` mis en place avant la veille et ayant des animaux en élevage ; passe quotidienne à 10:00 ; sept jours sur sept (paramètre) ; fermée par le marqueur de la passe suivante | OUVERT |
| AV-413 | `STANDARD_COST_MISSING` : entrées revues, fenêtre et résolution | SECONDAIRE | P9 | Produits entrés par une collecte (calibres, œufs à couver) ou une naissance dans les 30 derniers jours sans coût standard à l'instant de la passe (07:45) ; fermée par `StandardCostSet` (commande du catalogue) ou par le marqueur | OUVERT |
| AV-414 | `RECEIPT_INCOMPLETE` : condition, bornes, cadence et résolution | IMPORTANTE | P9 | Bon `SENT` ou `PARTIALLY_RECEIVED` avec un reliquat et (date prévue dépassée de **plus** de `procurement.receipt_incomplete_alert_days` jours, ou quantité rejetée à une réception comptée) ; détecté sur chaque changement de ses quantités et par une passe quotidienne à 07:15 ; fermé par `ReceiptIncompleteCleared`, l'annulation du bon, la clôture du reliquat ou le marqueur | OUVERT |
| AV-415 | Réception en quarantaine : `DUPLICATE_SUSPECTED` et sa fermeture | SECONDAIRE | P9 | `GoodsReceiptQuarantined` (raisons, objet « Réception ») à la mise en quarantaine, quelle qu'en soit la raison ; `GoodsReceiptQuarantineDecided` à la décision, approuvée ou rejetée ; le retrait de la demande par le demandeur laisse l'alerte ouverte | OUVERT |
| AV-416 | `APPROVAL_PENDING_LONG` : référence du délai, cadence, `escalated_at` | IMPORTANTE | P9 | Demande `PENDING` depuis au moins `approvals.pending_long_hours` (réception par le serveur, borne comprise) ; passe horaire ; `escalated_at` posé une fois par `approvals` ; destinataires : approbateurs de la politique (demandeur exclu) et Direction ; aucun doublon exclu ; « sans approbateur » toujours différé (B1) | OUVERT |
| AV-417 | `ATTACHMENT_MISSING` des réceptions : exigence, présence et portée | SECONDAIRE | P9 | Exigence recalculée (BR-APP-014, seuil à la date de la réception) ; pièce `DELIVERY_NOTE` disponible ; 7 jours depuis la réception par le serveur, horizon de 90 jours ; passe de portée `GOODS_RECEIPT` à 06:15 ; auteur de la pièce non contrôlé | OUVERT |
| AV-418 | `CHECKIN_SUSPICIOUS` : tentatives, sujet, destinataires et date | SECONDAIRE | P9 | Toute tentative (prise ou fin de service, acceptée ou refusée) portant au moins un signal de BR-TER-010 ; un sujet par pointage ; l'agent et le responsable de sa zone ou de son équipe ; datée de l'application par le serveur ; aucune coordonnée dans la charge utile | OUVERT |
| AV-419 | `DUPLICATE_SUSPECTED` d'un compte client : sujet, charge utile et fermeture | SECONDAIRE | P9 | Doublon créé hors ligne seulement (même téléphone principal) ; sujet = le nouveau compte ; référence = son nom, ni téléphone ni nom du compte d'origine ; fermeture par la fusion (`CustomerDuplicateResolved`) ; la décision du conflit ne ferme pas l'alerte | OUVERT |
| AV-420 | `AUDIT_CHAIN_BROKEN` : fenêtre, partition, heure et récurrence | IMPORTANTE | P9 | `audit.chain.verify_daily` à 03:00 sur deux jours métier à partir du créneau planifié (rattrapage plafonné à 31 jours) ; début exact de la fenêtre ; publie `AuditChainBroken` puis réussit ; sujet = mois métier de la ligne rompue et position ; résolution manuelle ; vérification hebdomadaire du mois renvoyée à P9-22 | OUVERT |
| AV-421 | `SYNC_ERROR` : nature, périmètre, regroupement et codes exclus | SECONDAIRE | P9 | Alerte d'état (corrige « `dismiss` admis » d'AV-392) ; passe horaire sur les commandes `/sync/push` rejetées ou en conflit (rejet jugé à sa dernière prise en charge, conflit ouvert sans borne basse) ; sujet appareil × code ; conflit de gestionnaire : type du conflit encore ouvert ; codes exclus paramétrables | OUVERT |
| AV-422 | `SYNC_STALE` : référence du délai, horizon d'oubli et propriétaire | SECONDAIRE | P9 | Appareil actif ; délai compté depuis le plus récent du dernier contact et de l'activation ; horizon de 30 jours (0 : aucun) ; titulaire = qui a enrôlé l'appareil | OUVERT |
| AV-423 | `DEVICE_SEQ_GAP` : définition du trou, explication par les restes déclarés et mémoire | IMPORTANTE | P9 | Plage absente de la boîte entre 1 et le plus grand numéro reçu, visible depuis plus de 24 h et non expliquée par les restes déclarés de l'appareil ; une plage n'est signalée qu'une fois (`known_gaps`) | OUVERT |
| AV-424 | `CLOCK_SKEW` : passe horaire plutôt que publication à l'envoi | SECONDAIRE | P9 | Dernier écart mesuré (`last_clock_skew_ms`) des appareils actifs ayant envoyé dans les `sync.stale_hours` dernières heures, au seuil de `sync.clock_skew_flag_minutes` ; écart signé | OUVERT |
| AV-425 | `CONSUMER_FAILED` : consommateurs surveillés, condition, fenêtre et supervision indépendante | SECONDAIRE | P9 | Toutes les positions ; événement sauté dans les 24 dernières heures ou retard (âge du plus ancien événement non traité) au-delà de 300 s ; passe de 5 minutes ; sujet = nom du consommateur ; journal d'erreur indépendant de l'alerte ; sonde externe en secondes renvoyée à P9-22 | OUVERT |
| AV-426 | Audience d'une note de direction : qui une ligne `SITE`, `ZONE`, rôle ou utilisateur touche | IMPORTANTE | P9 | Une règle pure unique du domaine pour la lecture, l'accusé et la publication ; `SITE` = affectations de ce site et de la zone du site ou de ses ancêtres ; `ZONE` = affectations de la zone, de ses ancêtres, de ses descendantes et de leurs sites ; `GLOBAL` et `TEAM` ne correspondent ni à `SITE` ni à `ZONE` ; utilisateur actif et affecté | OUVERT |
| AV-427 | Notes de direction : brouillon, publication, archivage, références et notifications | SECONDAIRE | P9 | Commandes en ligne seulement ; publication à l'instant du serveur, expiration strictement postérieure, références d'audience connues ; brouillon visible de son auteur seul ; retrait par tout titulaire de la permission ; une notification in-app par utilisateur touché, l'auteur excepté | OUVERT |
| AV-428 | Lecture et accusé de réception d'une note : date du fait, audience et hors-audience | IMPORTANTE | P9 | Jugés à la date du fait, jamais avant la publication ; un utilisateur que l'audience ne touchait pas à cette date n'est pas enregistré (commande appliquée sans effet) ; note archivée ou expirée depuis accusée sans rejet ; idempotent ; les notifications de la note sont marquées lues | OUVERT |
| AV-429 | Lecture des notes de direction : centre de notes, gestion, fiche et suivi des accusés | SECONDAIRE | P9 | Centre de notes = notes publiées, non expirées, qui touchent le lecteur à l'instant de la lecture (500 examinées au plus) ; gestion = toutes les notes avec audience, brouillons du lecteur seulement ; fiche : 404 opaque audité hors de ces cas ; suivi des accusés = audience résolue maintenant, l'auteur excepté | OUVERT |
| AV-430 | Notifications directes d'événements : événements publiés, destinataires et texte (précise AV-389) | SECONDAIRE | P9 | Cinq événements publiés par leurs modules propriétaires : approbateurs de la politique (Direction à défaut) pour une demande de validation, demandeur pour sa décision, expéditeurs du site source pour un transfert demandé, réceptionnaires du site destinataire pour un transfert expédié ; texte sans valeur ni résumé ; la décision d'une demande d'achat est portée par celle de la validation | OUVERT |
| AV-431 | Activation des notifications directes par type | SECONDAIRE | P9 | Un réglage système, liste des types désactivés (vide par défaut) | OUVERT |
| AV-432 | `DeviceEnrollmentRequested` : prévenir les approbateurs d'un appareil en attente | SECONDAIRE | P9 | Non publié : la portée d'approbation d'un appareil dépasse ce que le résolveur de destinataires exprime ; la file des appareils (ECR-ADM-05) et le bandeau d'attente restent le canal | OUVERT |
| AV-433 | Jeu hors ligne `comms` : contenu, portée et rendu des alertes | SECONDAIRE | P9 | Trois types émis par `communication` en portée `USER` à chaque écriture : alertes de la **boîte** de l'utilisateur, notifications `IN_APP` non lues, notes ; texte rendu pour son destinataire ; supervision, conflits et plafond de 50 en ligne | OUVERT |
| AV-434 | Notifications dans le jeu hors ligne : non lues `IN_APP`, sortie à la lecture | SECONDAIRE | P9 | Une ligne par notification écrite, une sortie à la lecture (une, toutes, ou lecture de la note) ; jamais l'envoi `WEB_PUSH` | OUVERT |
| AV-435 | Notes dans le jeu hors ligne : détenteurs, état de lecture, retrait | SECONDAIRE | P9 | Utilisateurs notifiés à la publication et lecteurs après coup ; l'état de lecture voyage dans la note ; sortie à l'archivage ; expiration masquée par l'appareil | OUVERT |
| AV-436 | Mortalité comptée d'un lot : statuts comptés et sort de la mortalité refusée | SECONDAIRE | P9 | La vue suit le résumé du lot ; or une mortalité refusée comme non justifiée est reclassée `INEXPLIQUEE` et ne compte plus comme mortalité nulle part | OUVERT |
| AV-437 | Valeur d'un solde de stock : deux définitions | SECONDAIRE | P9 | La vue suit BR-STK-054 (solde × coût unitaire moyen courant, comme `GET /stock`) ; l'accueil additionne la valeur du registre | OUVERT |
| AV-438 | Remise et coût d'une ligne de vente annulée | SECONDAIRE | P9 | Remise non contre-passée ; coût d'une annulation = retours de stock de sa ligne ; marge = montant − coût | OUVERT |
| AV-439 | Jeu des achats : facturé et payé hors du jeu | SECONDAIRE | P9 | Quantités commandées, livrées, rejetées, acceptées et montant commandé ; le facturé et le payé se lisent dans les dettes fournisseurs | OUVERT |
| AV-440 | Pertes et dépenses : constaté, en attente et non justifié en colonnes distinctes | SECONDAIRE | P9 | Comme `lossValueSummary` et `expensesSummary` : seul le constaté entre dans la mesure principale ; l'en attente et le non justifié sont à part | OUVERT |
| AV-441 | Prospection : comptes et conversions lus par l'acteur de l'événement | SECONDAIRE | P9 | La personne est l'acquéreur du compte, l'auteur de la visite, le titulaire à la conversion (effort individuel, BR-CRM-019) et non le titulaire courant que juge `GET /customers` | OUVERT |
| AV-442 | Conversion d'un compte fusionné | SECONDAIRE | P9 | Un compte fusionné n'est compté ni à la création ni à la conversion (la fusion recopie la conversion sur le compte conservé) ; `commercialEffort` compte les deux : écart à corriger dans `crm` | OUVERT |
| AV-443 | Achats : date d'un bon de commande et taux de service | SECONDAIRE | P9 | Un bon est daté de son approbation (à défaut de sa création) ; un bon approuvé et pas envoyé compte comme commandé ; KPI-APP-01 « BC clôturés » se lit par le rapprochement d'un bon | OUVERT |
| AV-444 | Soldes de stock, valeur, trésorerie : mesures sans signe ni filtre | SECONDAIRE | P9 | Solde et valeur : tous les emplacements du jeu (filtre `location_type`), disponible nul hors emplacement physique, soldes à zéro omis ; entrées et sorties de trésorerie : flux bruts (`movement_type`, `is_reversal`) | OUVERT |
| AV-445 | Tableaux : étendue non représentable par une portée de lecture | SECONDAIRE | P9 | Un bloc dont l'étendue exacte de l'utilisateur (sites et personnes à la fois, ou plus de clauses qu'une portée de lecture n'en exprime) n'est pas représentable est `unavailable` (`SCOPE_UNSUPPORTED`) sans faire échouer le tableau ; l'explorateur, lui, la juge exactement ; les valeurs au coût de la finance (dépenses, marges) ne se calculent que sous une portée `ALL` ou de sites | OUVERT |
| AV-446 | Vues sauvegardées : propriétaire seul, vue par défaut d'un rôle | SECONDAIRE | P9 | Une vue ne se modifie, ne se partage et ne se supprime que par son créateur (introuvable pour tout autre) ; la vue par défaut d'un rôle doit être partagée avec ce rôle, remplace la précédente (une seule par rôle) et se retire en retirant le partage ; nom unique par propriétaire | OUVERT |
| AV-447 | Exports : échéance, file par demandeur, étendue tronquée, abandon | SECONDAIRE | P9 | Échéance fixée à la demande (`analytics.export_file_hours`, 24 h, immuable par déclencheur) ; au plus 3 exports en file ou en cours par demandeur ; une étendue exacte tronquée faute de place fait terminer l'export en `FAILED` (`SCOPE_TRUNCATED`), jamais en fichier partiel ; un export encore en file plus d'un jour est abandonné (`EXPORT_ABANDONED`) ; fichier supprimé 30 jours après la demande | OUVERT |
| AV-448 | Instantanés personnels : lot, contenu, retrait | SECONDAIRE | P9 | Lot de 50 utilisateurs par exécution (`analytics.snapshot_batch_size`) avec reprise ; contenu = indicateurs des blocs sans les liens d'exploration ; un tableau qui ne peut être calculé garde son instantané daté ; les instantanés des utilisateurs devenus inactifs sont retirés au dernier lot de la passe | OUVERT |
| AV-449 | Document source d'une ligne : dimensions de document et routes | SECONDAIRE | P9 | Chaque jeu de lignes détaillées gagne une dimension de document (vente, commande, encaissement, mouvement, perte, visite, session, coût, dépense, trésorerie, bon) ; la ligne porte son identifiant et la route de lecture du document, ou de sa liste quand aucune lecture par identifiant n'existe | OUVERT |
| AV-450 | Charge : index non ajoutés avant mesure, jeu de ventes seul | SECONDAIRE | P9 | Aucun index de jour métier n'est ajouté tant que le jeu de charge (ventes) ne le justifie pas ; le jeu ne génère ni encaissements ni mouvements : il mesure le chemin le plus lourd, les lignes de vente ; les jeux dont la vue date par une expression (commandes, visites, sessions, coûts, achats) restent à mesurer avant tout index | OUVERT |

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

### AV-006 — Enrôlement des appareils — IMPORTANTE — **TRANCHÉ**
- **Question** : un nouvel appareil peut-il synchroniser immédiatement, ou doit-il être approuvé ?
- **Pourquoi** : PM §37 (« appareils autorisés ») ; risque d'usurpation.
- **Choix** : (a) libre ; (b) approbation par Admin ; (c) approbation par Admin ou par le responsable hiérarchique.
- **Recommandation** : (c). L'appareil reste `PENDING` : il peut consulter mais ne peut pas pousser d'opérations tant qu'il n'est pas `ACTIVE`.
- **Impact** : friction au démarrage ; sécurité.
- **Références** : PM §37 ; SM-DEVICE.
- **Décision** (porteur du projet, 13/10/2026) : (c), approbation par l'Admin ou par le responsable du site ou de l'équipe de la personne qui a connecté l'appareil (portée : AV-247) ; écran ECR-ADM-05 dans le lot de mise en pilote (MP-06).

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
- **Défaut implémenté** : la recommandation. Depuis MP-07 (13/10/2026), la décision exige le rôle Direction **en plus** du marqueur explicite `selfApproved` (`canSelfApprove`, `@gic/domain`) : avant, tout approbateur pouvait valider sa propre demande en posant le marqueur (écart à INV-ADM-02, corrigé et testé). La file de validation ne montre ses propres demandes qu'à la Direction.

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

### AV-017 — Catégories de clients — SECONDAIRE — **TRANCHÉ**
- **Recommandation** : référentiel configurable. Valeurs initiales : `PARTICULIER`, `REVENDEUR`, `RESTAURATION_HOTELLERIE`, `GROSSISTE`, `INSTITUTION`.
- **Décision** (porteur du projet, 13/10/2026) : les cinq catégories sont semées dès l'installation (rejouable, désactivables), sans attendre la liste réelle de GIC ; lot de mise en pilote (MP-02).

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

### AV-026 — Modification de prix par le vendeur — IMPORTANTE — **TRANCHÉ**
- **Recommandation** : interdite par défaut. Avec la permission `sales.price.override`, une remise est possible dans un plafond paramétré par rôle (Vendeur 0 %, Commercial 5 %, Resp. commercial 15 %), avec un motif obligatoire. Au-delà du plafond, une validation est requise.
- **Références** : CM §29, §30 ; PM §37.
- **Décision** (porteur du projet, 30/09/2026) : **plafond par rôle** (recommandation) : remise interdite sans `sales.price.override` ; plafonds paramétrés (Vendeur 0 %, Commercial 5 %, Resp. commercial 15 %) ; motif obligatoire ; au-delà du plafond, ligne enregistrée et validation `PRICE_OVERRIDE`

### AV-027 — Ventes anonymes — IMPORTANTE — **TRANCHÉ**
- **Recommandation** : autorisées au point de vente et en vente directe si la vente est **intégralement payée** au moment de la vente. Un client identifié est obligatoire pour une vente à crédit ou sur commande.
- **Décision** (porteur du projet, 30/09/2026) : **autorisées si la vente est intégralement payée** au moment de la vente (recommandation) ; client identifié obligatoire pour une vente à crédit ou sur commande

### AV-028 — Crédit client — IMPORTANTE — **TRANCHÉ**
- **Recommandation** : vente à crédit seulement pour les clients avec `credit_allowed = true`, dans la limite de `credit_limit_xaf`. L'échéance par défaut est de 30 jours. Hors ligne, le contrôle porte sur l'encours connu localement. Un dépassement nécessite une validation.
- **Décision** (porteur du projet, 30/09/2026) : **clients autorisés dans leur plafond** (recommandation) : `credit_allowed`, `credit_limit_xaf`, échéance par défaut 30 jours ; **au-delà du plafond, confirmation refusée en ligne** ; hors ligne, la vente est enregistrée (fait accompli) et une validation `CREDIT_LIMIT_EXCEEDED` est ouverte ; contrôle local sur l'encours connu de l'appareil. Échéance d'une vente sur commande : voir AV-129

### AV-029 — Retours clients — SECONDAIRE
- **Recommandation** : hors MVP. Les erreurs se corrigent par annulation encadrée (AV-030). Le modèle `sales_returns` est prévu pour une phase ultérieure.

### AV-030 — Annulation d'une vente — IMPORTANTE — **TRANCHÉ**
- **Recommandation** : le vendeur peut annuler sa propre vente sans validation si elle date de moins de 15 minutes et que la session de caisse est encore ouverte. Sinon, il faut une demande d'annulation approuvée par le responsable du point de vente ou le Resp. commercial. Dans tous les cas, l'annulation produit une contre-écriture.
- **Décision** (porteur du projet, 30/09/2026) : **15 minutes, sinon validation** (recommandation) : le vendeur annule seul sa vente de moins de 15 minutes (paramètre `sales.direct_cancel_minutes`) si sa caisse est ouverte, sinon demande validée (`SALE_CANCELLATION`) ; toujours par contre-écriture. **Jusqu'à P5** (sessions de caisse), la condition de caisse est réputée remplie ; depuis P5-14, elle est évaluée à l'heure de l'annulation (AV-185)

### AV-031 — Poids ou unité — IMPORTANTE — **TRANCHÉ**
- **Recommandation** : le modèle supporte les deux par produit (`pricing_mode`). Au lancement, tout se vend à l'unité, avec une saisie de poids optionnelle.
- **Décision** (porteur du projet, 30/09/2026) : **les deux modes par produit dès P4** : `PER_WEIGHT` (découpes, abats, porc au kilo vif s'il est paramétré ainsi, AV-102) et `PER_UNIT` avec poids facultatif

### AV-032 — Vif ou abattu — IMPORTANTE — **TRANCHÉ**
- **Recommandation** : vif uniquement au MVP. L'abattage ou la transformation sera modélisé comme une opération de transformation (consommation → production), sans changer le registre de stock.
- **Décision** (porteur du projet, 27/09/2026) : Poulet **vif et abattu dès P7** : l'abattage est une transformation (consommation des poulets vifs → production de plusieurs produits : poulet entier, découpes, abats), avec rendement et pertes d'abattage ; le coût est réparti entre les produits obtenus **au prorata du poids**.

### AV-033 — Acomptes — SECONDAIRE
- **Recommandation** : autorisés. L'encaissement est affecté à la commande, puis réaffecté à la vente à la livraison.
- **Défaut implémenté** (ADR-028 §8, depuis que la vente naît à la confirmation) : l'acompte est affecté à la commande, puis passé à la vente **à sa confirmation** (cause de renversement `ORDER_CONFIRMED`) ; la question reste ouverte.

### AV-034 — Livraison — IMPORTANTE — **TRANCHÉ**
- **Recommandation** : pas d'entité « livraison » distincte au MVP. La vente de type `ORDER_FULFILMENT` porte le livreur, l'heure de remise et une preuve éventuelle. Une livraison partielle donne une vente partielle.
- **Décision** (porteur du projet, 30/09/2026) : **bon de livraison distinct** (option reformulée après ADR-025) : chaque livraison, même partielle, est un document (livreur, heure de remise, réceptionnaire, quantités par ligne, preuve éventuelle) ; plusieurs livraisons par commande ; ADR-028

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
- **Précision** (P5, 08/10/2026, ADR-033) : pour un emplacement `SHARED`, le seuil et la suggestion s'évaluent sur le **solde physique** (quotas compris) ; le disponible net des quotas ne sert qu'à la vente en ligne, sinon un octroi de quota ferait apparaître une rupture sans aucune sortie.

### AV-041 — TVA et taxes — IMPORTANTE — **TRANCHÉ**
- **Question** : les prix sont-ils TTC ? Certains produits sont-ils exonérés ? Des factures fiscales normalisées sont-elles nécessaires ?
- **Recommandation** : prix saisis et affichés TTC. Pas de ventilation fiscale au MVP. Les colonnes `tax_rate` et `tax_amount_xaf` sont prévues à 0 dans les lignes de vente et d'achat pour permettre l'évolution.
- **Décision** (porteur du projet, 30/09/2026) : **prix TTC, reçu numérique simple** (recommandation) : pas de ventilation fiscale ni de facture normalisée ; colonnes `tax_rate` et `tax_amount_xaf` à 0
- **Confirmation du porteur (20/10/2026, D3)** : la facture client reste hors de l'application pour l'instant (REQ-309). À rouvrir si la facturation électronique annoncée par la loi de finances 2026 s'impose (points légaux à valider avec le comptable).

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

### AV-056 — Moyens de paiement — IMPORTANTE — **TRANCHÉ**
- **Recommandation** : référentiel `ESPECES`, `MOBILE_MONEY_ORANGE`, `MOBILE_MONEY_MTN`, `VIREMENT`, `CHEQUE`. La référence de transaction mobile money est saisie manuellement et unique par moyen. Pas d'intégration API opérateur au MVP.
- **Décision** (porteur du projet, 30/09/2026) : **cinq moyens, référence saisie** (recommandation) : `ESPECES`, `MOBILE_MONEY_ORANGE`, `MOBILE_MONEY_MTN`, `VIREMENT`, `CHEQUE` (liste modifiable) ; référence mobile money saisie à la main, unique par moyen ; un doublon passe en `SUSPECT_DUPLICATE` sans effet de trésorerie ; pas d'API opérateur

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

### AV-063 — Prix obsolète hors ligne — IMPORTANTE — **TRANCHÉ**
- **Recommandation** : la vente est acceptée au prix figé sur l'appareil. L'anomalie `PRICE_MISMATCH` est créée pour revue. Aucune correction automatique du montant client.
- **Décision** (porteur du projet, 30/09/2026) : **acceptée au prix figé sur l'appareil** (recommandation) ; anomalie `PRICE_MISMATCH` pour revue, sans correction du montant client

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
- **Extension demandée (porteur, 20/10/2026, D11)** : import par lots pour l'historique des pièces papier. La validation avant chargement et le passage par les commandes existantes sont la proposition de conception d'AV-317, non un choix du porteur.

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
- **Confirmation du porteur (20/10/2026, D12)** : pour le report d'une pièce papier, 24 h conseillées et 72 h au maximum, valeurs actuelles et paramétrables. Le point reste OUVERT pour l'application de la fenêtre à toutes les commandes (prévue avant la production) ; voir AV-317.

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

### AV-114 — Carcasses saisies et frais d'abattage — SECONDAIRE — **TRANCHÉ**
- **Question** : que deviennent les têtes saisies (condamnées) à l'abattage et les frais propres de l'abattage (sachets, main-d'œuvre) ?
- **Pourquoi** : AV-032 ne les traite pas.
- **Choix** : (a) saisies consommées sans produit, leur coût porté par les produits ; frais d'abattage = dépense directe du lot ; (b) saisies déclarées en perte ; (c) objet de coût d'abattage distinct.
- **Recommandation** : (a).
- **Impact** : indicateur de taux de saisie ; aucune perte de stock.
- **Décision** (porteur du projet, 28/09/2026) : **coût porté par les produits** (option a) : têtes saisies comptées sans produit, frais d'abattage = dépense directe du lot

### AV-115 — Abattage des réformes et des porcs — SECONDAIRE — **TRANCHÉ**
- **Question** : l'abattage s'étend-il aux poules de réforme, aux reproducteurs et aux porcs ?
- **Pourquoi** : AV-032 vise le poulet de chair.
- **Choix** : (a) hors P7, abattage activable par type de lot (paramètre) ; (b) dès P7.
- **Recommandation** : (a).
- **Impact** : paramètre des types de lot abattables.
- **Décision** (porteur du projet, 28/09/2026) : **tous les types dès P7** : poulets de chair, pondeuses et reproducteurs de réforme, porcs d'engraissement et de naissage (réformes) ; la liste reste un paramètre (`production.slaughterable_lot_types`) ; les découpes porcines sont des produits du catalogue

### AV-116 — Définition des indicateurs zootechniques — SECONDAIRE
- **Question** : quelles définitions exactes pour l'indice de consommation, le GMQ, le poids initial, le taux de ponte et le taux de mortalité (AV-049) ?
- **Pourquoi** : aucun document ne les définit (D11 §7.1 est muet).
- **Choix** : variantes : IC économique (hors morts) ou technique ; poids initial pesé ou standard ; taux de ponte sur l'effectif du début de jour ou moyen ; mortalité ÷ effectif initial ou ÷ (initial + entrées).
- **Recommandation** : IC hors morts (aliment en kg ÷ gain de poids vif) ; poids initial = pesée à la mise en place, sinon poids standard paramétré par produit ; taux de ponte ÷ effectif en élevage au début du jour ; mortalité cumulée ÷ (effectif initial + entrées) (KPI-PRD-03).
- **Impact** : `packages/domain` ; lectures de lot. Défaut en place depuis P7-11 (fiche d'un lot, D07 §15) : IC hors morts et GMQ entre la première et la dernière pesée, taux de ponte ÷ effectif en élevage au début du jour, mortalité comptée ÷ effectif initial (qui cumule déjà toutes les entrées) ; le poids standard par produit n'est pas encore paramétré (sans deux pesées, ni GMQ ni IC).

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

### AV-120 — Annulations après consommation (collecte, mortalité approuvée) — SECONDAIRE — **TRANCHÉ**
- **Question** : comment annuler une collecte dont les œufs sont déjà consommés, ou corriger une mortalité déjà approuvée ?
- **Pourquoi** : SM-EGG-COLLECTION prévoit « sinon validation » sans type d'opération ; `LOSS_CANCELLATION` est cité (D06) mais absent.
- **Choix** : (a) annulation par contre-écriture soumise à la validation du Resp. production ; (b) refus, correction par document compensatoire.
- **Recommandation** : (a).
- **Impact** : types d’opération à ajouter si (a).
- **Décision** (porteur du projet, 28/09/2026) : **refus et correction compensatoire** (option b) : une annulation dont les produits sont déjà sortis est refusée (`STOCK_UNAVAILABLE`) ; le responsable corrige par une opération compensatoire (inventaire, perte, nouvelle saisie)

### AV-121 — Seuils de l’alerte de mortalité élevée — SECONDAIRE
- **Question** : l'alerte `HIGH_MORTALITY` garde-t-elle ses seuils (0,5 % de l'effectif ou 20 têtes par jour) maintenant que toute mortalité est validée ?
- **Pourquoi** : les seuils de validation (AV-048) et d'alerte étaient les mêmes.
- **Choix** : (a) seuils d'alerte propres, paramétrés (0,5 % ou 20 têtes par jour, cumul du jour) ; (b) alerte à chaque mortalité.
- **Recommandation** : (a).
- **Impact** : P9 (module `communication`) ; paramètres.

### AV-122 — Durée de conservation des œufs collectés — SECONDAIRE — **TRANCHÉ**
- **Question** : quelle date de péremption porte le lot de stock d'une collecte d'œufs ?
- **Pourquoi** : AV-100 donne à chaque collecte un lot propre « avec date de péremption », mais le catalogue ne porte aucune durée de conservation par produit.
- **Choix** : (a) durée unique pour les œufs, paramétrée (28 jours après la collecte) ; (b) durée par produit dans le catalogue ; (c) aucune date.
- **Recommandation** : (a), en attendant une durée par produit si les calibres se conservent différemment.
- **Impact** : paramètre `production.egg_shelf_life_days` ; ordre FEFO des ventes d'œufs (D06).
- **Décision** (porteur du projet, 28/09/2026) : **28 jours paramétrés** (option a) : péremption = date de collecte + `production.egg_shelf_life_days`

### AV-123 — Annulation d’une entrée de lot — SECONDAIRE — **TRANCHÉ**
- **Question** : qui peut annuler une entrée de lot (mise en place, naissance, transfert, sevrage) saisie par erreur ?
- **Pourquoi** : l'annulation contre-passe le stock des animaux et les coûts du lot (et le crédit du lot de truies pour une naissance) ; aucune règle ne désignait l'acteur.
- **Choix** : (a) Responsable production seul ; (b) Responsable ferme aussi, sur sa ferme ; (c) Responsable ferme avec validation du Responsable production.
- **Recommandation** : (a).
- **Impact** : `production.lot.cancel_entry` sous `production.lot.manage`.
- **Décision** (porteur du projet, 28/09/2026) : **Responsable production seul** (option a), comportement de P7-05 confirmé

### AV-124 — Production entrée sans coût standard défini — SECONDAIRE — **TRANCHÉ**
- **Question** : que faire quand des œufs sont collectés ou des porcelets naissent alors qu'aucun coût standard n'est fixé pour leur produit (AV-098) ?
- **Pourquoi** : la valeur d'entrée en stock et le crédit du lot producteur reposent sur ce coût ; un produit nouvellement créé peut ne pas l'avoir.
- **Choix** : (a) accepter à une valeur par défaut, sans alerte ; (b) accepter et alerter l'administrateur ; (c) refuser en ligne tant que le coût manque.
- **Recommandation** : (b) : la ferme n'est jamais bloquée.
- **Impact** : œufs au CMUP courant (0 sans stock antérieur), porcelets à 0 XAF, écart dans le résultat du lot producteur ; alerte `STANDARD_COST_MISSING` à l'administrateur (module `communication`, P9), déduite des entrées de production dont le produit n'a pas de coût standard à la date de l'entrée.
- **Décision** (porteur du projet, 28/09/2026) : **accepter et alerter** (option b)

### AV-125 — Durée de conservation des produits d’abattage — SECONDAIRE — **TRANCHÉ**
- **Question** : quelle date de péremption porte le lot de stock d'un abattage (poulet entier, découpes, abats) ?
- **Pourquoi** : AV-100 donne à chaque abattage un lot propre « avec date de péremption » ; le catalogue n'a pas de durée de conservation et la chaîne du froid (frais ou congelé) n'est pas décrite.
- **Choix** : (a) durée unique paramétrée (5 jours, frais réfrigéré) ; (b) durée par produit dans le catalogue (entier, découpes, abats, congelé) ; (c) aucune date.
- **Recommandation** : (a) pour P7, (b) si des produits congelés sont vendus.
- **Impact** : paramètre `production.slaughter_shelf_life_days` ; ordre FEFO des ventes (D06).
- **Décision** (porteur du projet, 28/09/2026) : **5 jours paramétrés** (option a)

### AV-126 — Commande saisie hors ligne sur un stock non alloué — IMPORTANTE — **TRANCHÉ**
- **Question** : Un commercial prend une commande sans connexion pour de la marchandise du magasin (pas dans son stock mobile) : ADR-025 soumettait toute confirmation hors ligne au blocage au-delà de l'allocation (AV-025), ce qui rendait la commande hors ligne impossible (UC-VEN-02).
- **Pourquoi** : Le commercial n'a pas d'allocation sur le magasin central ; BR-SYN-007 protège les faits, pas les intentions (ADR-007).
- **Choix** : (a) la commande hors ligne est une intention : le serveur la confirme à la synchronisation (vente datée de l'heure de saisie) ; (b) bloquée hors ligne ; (c) acceptée et signalée.
- **Recommandation** : (a).
- **Impact** : Commande `sales.order.place` hors ligne ; ADR-028.
- **Décision** (porteur du projet, 30/09/2026) : **confirmée par le serveur à la synchronisation** (option a) : la commande saisie hors ligne est une intention ; à son application, le serveur la confirme (vente du disponible, AV-127), avec l'heure métier de la saisie

### AV-127 — Stock insuffisant à la confirmation d'une commande — IMPORTANTE — **TRANCHÉ**
- **Question** : À la confirmation, le stock de l'emplacement de préparation ne couvre pas toute la commande.
- **Pourquoi** : BR-VEN-004 (une commande n'est jamais refusée pour manque de stock) contre ADR-025 (la confirmation déplace le stock) et INV-STK-06 (aucun négatif en ligne).
- **Choix** : (a) vendre le disponible, le reste demeure une commande en attente confirmée plus tard ; (b) refuser la confirmation ; (c) tout vendre, le manque sans mouvement.
- **Recommandation** : (a).
- **Impact** : Quantités vendue et en attente par ligne de commande ; commande de confirmation du reliquat ; alerte au magasinier (P9) ; ADR-028.
- **Décision** (porteur du projet, 30/09/2026) : **vente du disponible** (option a) : la partie en stock devient une vente mise de côté « à livrer » ; le reste demeure une commande en attente, confirmée quand le stock arrive ; le magasinier est alerté (P9)

### AV-128 — Annulation du reste non livré d'une commande confirmée — IMPORTANTE — **TRANCHÉ**
- **Question** : Une commande confirmée (donc vendue) n'est pas livrée en tout ou en partie : qui annule ce reste, et avec quelle validation ?
- **Pourquoi** : Avant ADR-025, l'annulation d'une commande non livrée ne demandait pas de validation ; c'est désormais l'annulation (partielle) d'une vente, que AV-030 encadre.
- **Choix** : (a) auteur de la commande ou Resp. commercial, sans validation ; (b) règle d'AV-030 (15 minutes, sinon validation) ; (c) toujours une validation.
- **Recommandation** : (a) : la marchandise n'a jamais quitté le site.
- **Impact** : Annulation partielle d'une vente par contre-écriture (retour de « à livrer » vers le stock, CA négatif daté) ; ADR-028.
- **Décision** (porteur du projet, 30/09/2026) : **auteur ou Resp. commercial, sans validation** (option a) : la marchandise revient au stock et le chiffre d'affaires diminue, par contre-écriture datée de l'annulation

### AV-129 — Point de départ de l'échéance d'une vente sur commande — SECONDAIRE — **TRANCHÉ**
- **Question** : À partir de quand court le délai de paiement d'une vente sur commande à crédit ?
- **Pourquoi** : Avec ADR-025, la vente naît à la confirmation, parfois bien avant la livraison.
- **Choix** : (a) depuis la confirmation ; (b) depuis la dernière livraison.
- **Recommandation** : (b), pour ne pas afficher de retard avant la remise.
- **Impact** : Calcul de `due_date` ; créances en retard (BR-FIN-007).
- **Décision** (porteur du projet, 30/09/2026) : **depuis la confirmation** (option a) : échéance = heure métier de la vente + délai de paiement du client

### AV-130 — Modification d'une commande confirmée — IMPORTANTE — **TRANCHÉ**
- **Question** : Peut-on modifier une commande confirmée (quantités, produits) avant sa livraison, alors que la vente est immuable (BR-VEN-012) ?
- **Pourquoi** : BR-VEN-005 permettait la modification tant qu'aucune livraison n'avait eu lieu ; ADR-025 en fait une vente.
- **Choix** : (a) non : annuler le non-livré et passer une nouvelle commande ; (b) oui : la modification produit automatiquement une contre-écriture et une nouvelle vente pour la différence.
- **Recommandation** : (a).
- **Impact** : Commande `sales.order.update` sur une commande confirmée ; annulation partielle et vente complémentaire ; ADR-028.
- **Décision** (porteur du projet, 30/09/2026) : **ajustement automatique** (option b) : une baisse annule par contre-écriture la part non livrée concernée, une hausse ou un nouveau produit crée une vente complémentaire (vente du disponible, AV-127) ; les ventes restent immuables

### AV-131 — Perte d'une marchandise vendue avant sa livraison — SECONDAIRE
- **Question** : Une marchandise vendue et mise de côté « à livrer » meurt ou se perd avant la remise au client.
- **Pourquoi** : Le CA est déjà reconnu ; la perte a lieu chez l'entreprise ; aucune règle.
- **Choix** : (a) perte ordinaire (D06), la vente est maintenue ; (b) annulation partielle de la vente, puis perte.
- **Recommandation** : (b) : on ne peut livrer ce qui est perdu ; la vente est corrigée et la perte déclarée.
- **Impact** : Déclaration de perte sur l'emplacement « à livrer ».
- **Précision technique** (ADR-029, 04/10/2026) : seule l'option (b) est exprimable par le registre de stock, une perte partant d'un emplacement physique ; l'option (a) demanderait une perte prise sur l'emplacement « à livrer », non prévue.

### AV-132 — Délai d'alerte d'une vente confirmée non livrée — SECONDAIRE
- **Question** : Au bout de combien de jours signaler une vente confirmée non encore livrée (ADR-025, risques) ?
- **Pourquoi** : ADR-025 demande un indicateur au-delà d'un délai paramétré, sans valeur par défaut.
- **Choix** : Paramètre `sales.undelivered_alert_days`.
- **Recommandation** : 7 jours.
- **Impact** : Indicateur des ventes non livrées ; alerte P9.
- **Défaut posé par le seed** (P4-02) : `sales.undelivered_alert_days` = 7, en attendant la décision.

### AV-133 — Livraison faite hors ligne qui arrive après l'annulation du reste de la commande — SECONDAIRE
- **Question** : Un livreur remet 6 pièces hors ligne à 9 h 30. À 10 h, le commercial annule, en ligne, tout le reste non livré de la commande (la marchandise retourne au stock). À 11 h, l'appareil du livreur se synchronise : la livraison dépasse ce qui restait à livrer. Que fait-on ?
- **Pourquoi** : une livraison est un fait physique accompli, jamais refusé (BR-SYN-007, INV-SYN-06), alors que le stock rendu au magasin n'est plus à livrer ; ADR-029 plafonne les livraisons en base. D04 §14 traite déjà deux livraisons concurrentes de la même commande.
- **Choix** : (a) la quantité en trop est enregistrée comme une vente directe de régularisation, avec un conflit `ORDER_OVER_FULFILMENT` pour revue du Resp. commercial ; (b) la commande annulée est rouverte pour cette quantité ; (c) la livraison est refusée (la marchandise est pourtant chez le client).
- **Recommandation** : (a), comme D04 §14.
- **Impact** : Commande `sales.order.fulfil` hors ligne ; conflits ; ADR-029 §10. Défaut implémenté en attendant la décision : (a).

### AV-134 — Correction d'un bon de livraison saisi avec une mauvaise quantité — SECONDAIRE
- **Question** : Un bon de livraison est saisi avec 5 pièces au lieu de 3. Peut-on le corriger ?
- **Pourquoi** : la quantité livrée est plafonnée en base et ne se défait pas (ADR-029) ; le retour de marchandise déjà livrée est hors MVP (AV-029).
- **Choix** : (a) non en V1 : on ne corrige que le non-livré, et un retour de marchandise livrée est un autre sujet (AV-029) ; (b) oui, par une reprise de livraison réservée au Resp. commercial, qui remet la quantité « à livrer ».
- **Recommandation** : (a).
- **Impact** : Bon de livraison (ADR-028 §7) ; plafond de livraison ; AV-029. Défaut implémenté : (a).

### AV-135 — Décision de la Finance sur un encaissement suspect de doublon : correction de la référence — IMPORTANTE
- **Question** : Un vendeur saisit, pour un second paiement mobile money réel, la référence d'un paiement déjà enregistré : l'encaissement est mis de côté comme doublon suspect (AV-056). Quand la Finance décide, peut-elle corriger la référence (paiement réel mal saisi) ou seulement approuver ou rejeter tel quel ?
- **Pourquoi** : sans correction, approuver un doublon de même référence est impossible (la référence est unique parmi les paiements enregistrés) et le seul recours est de rejeter, alors que l'argent est peut-être arrivé sur le compte. SM-CUSTOMER-PAYMENT prévoit une « référence corrigée » ; le schéma de P4-02 la rend possible à la décision seulement.
- **Choix** : (a) la Finance peut corriger la référence en approuvant ; (b) approuver ou rejeter sans correction (rejet obligatoire si la référence est déjà prise).
- **Recommandation** : (a). L'encaissement suspect mémorise la vente ou la commande visée (`intended_sale_id`, `intended_order_id`), affectée à la décision.
- **Impact** : `sales_customer_payments` (déclencheur de mise à jour, colonnes `intended_*`) ; décision `PAYMENT_DUPLICATE` ; SM-CUSTOMER-PAYMENT. Défaut implémenté en attendant : (a).

### AV-136 — Commande d'un produit vendu au poids — IMPORTANTE
- **Question** : Un restaurateur commande 12 kg de découpes ou deux porcs vendus au kilo vif. Le poids exact n'est connu qu'à la pesée, mais la vente naît à la confirmation de la commande (AV-024). Comment vendre ?
- **Pourquoi** : la ligne de commande n'a ni quantité ni unité de tarification ; la ligne de vente exige un poids de tarification pesé, qui ne peut plus changer (la vente est immuable).
- **Choix** : (a) en P4 seuls les produits à l'unité se commandent ; un produit au poids se vend en vente directe, au poids pesé ; (b) la commande porte un poids estimé, la vente est faite sur l'estimation et un ajustement corrige l'écart à la pesée ; (c) le produit au poids est facturé à la livraison, sur le poids livré.
- **Recommandation** : (a) pour P4, (c) à étudier ensuite.
- **Impact** : `sales.order.place`, lignes de commande et de bon de livraison, AV-031. Défaut implémenté en attendant : (a).

### AV-137 — Vente anonyme saisie hors ligne et non intégralement payée — SECONDAIRE
- **Question** : Une vente sans client doit être intégralement payée (AV-027). Hors ligne, le paiement saisi peut se révéler un doublon (mis de côté) ou être annulé : la vente anonyme se retrouve avec un reste dû et personne à qui le réclamer. Que fait-on ?
- **Pourquoi** : la vente est un fait accompli (marchandise remise) qui n'est jamais rejeté ; la règle « payée intégralement » ne peut pas s'appliquer à ce fait.
- **Choix** : (a) la vente est enregistrée, le drapeau `ANONYMOUS_UNPAID` est posé et un conflit est ouvert pour la Finance ; (b) la vente est rejetée (marchandise remise sans trace).
- **Recommandation** : (a).
- **Impact** : `sales.sale.record` hors ligne, conflits, `sales_sales.flags` ; INV-VEN-07 vérifiée en transaction à l'enregistrement en ligne. Défaut implémenté : (a).

### AV-138 — Annulation d'une vente d'animaux après la clôture de leur lot — SECONDAIRE
- **Question** : Un lot de porcs est clôturé après que tous ses animaux ont été vendus. Un mois plus tard, le client rend les animaux et la vente est annulée : les animaux reviennent dans un lot déjà clôturé, dont le résumé de clôture (coût, résultat) est figé. Que fait-on ?
- **Pourquoi** : une correction ne se refuse pas (ADR-006), mais l'effectif et le coût restant du lot ne correspondent plus à son résumé. Une vente sur commande est protégée : la clôture est refusée tant qu'il reste des têtes vendues non livrées (ADR-029 §9) ; une vente directe, déjà livrée, ne l'est pas.
- **Choix** : (a) l'annulation est appliquée, le lot reste clos et un conflit informatif `LOT_CLOSED` est ouvert pour le Resp. production (comme une saisie tardive hors ligne) ; (b) l'annulation est refusée tant que le lot est clos ; (c) l'annulation rouvre le lot.
- **Recommandation** : (a).
- **Impact** : `sales.sale.cancel` / `.request_cancellation` (P4-05), `returnSoldGoods` (exemptée de `LOT_CLOSED`), conflits. Défaut implémenté : (a).

### AV-139 — Compte de trésorerie crédité par un encaissement — SECONDAIRE
- **Question** : Quand un client paie une vente en mobile money, par virement ou par chèque, sur quel compte de l'entreprise l'argent est-il compté, si l'entreprise a plusieurs comptes (par exemple un compte Orange Money et un compte MTN MoMo) ?
- **Pourquoi** : le moyen de paiement donne un type de compte, pas un compte (deux comptes mobile money ne se distinguent par aucune donnée). Les espèces, elles, se déduisent du lieu : caisse du point de vente, ou caisse de la personne qui encaisse (D09, BR-FIN-002).
- **Choix** : (a) l'appareil désigne le compte à l'encaissement (liste de ses comptes) et le serveur vérifie qu'il convient ; à défaut, le seul compte actif du bon type, sinon la vente est refusée tant que le compte n'est pas désigné ; (b) un compte est rattaché à chaque moyen de paiement (nouvelle information à saisir) ; (c) un paramètre associe chaque moyen à un compte.
- **Recommandation** : (a), sans nouvelle donnée à saisir ; (b) si l'entreprise veut que le compte ne dépende jamais de l'appareil.
- **Impact** : `finance.cashAccountFor`, `sales.sale.record` (puis `sales.payment.record`, P4-08), jeu hors ligne `cash` (P4-11). Défaut implémenté : (a).

### AV-140 — Canal d'une vente et canaux à créer — SECONDAIRE
- **Question** : Quand le vendeur ne choisit pas le canal d'une vente (point de vente, terrain, sédentaire, direct…), comment est-il fixé ? Et qui crée la liste des canaux ?
- **Pourquoi** : BR-VEN-021 cite le point de vente, le commercial terrain en session, le commercial sédentaire et Kommo, mais pas la vente à la ferme, ni un commercial terrain sans session. La liste des canaux (AV-018) n'est pas encore créée : une vente exige un canal existant.
- **Choix** : (a) point de vente → `POINT_DE_VENTE` ; stock mobile ou session de travail ouverte → `TERRAIN` ; commercial sédentaire → `SEDENTAIRE` ; sinon (vente à la ferme) → `DIRECT` ; le vendeur peut toujours choisir un autre canal actif ; les canaux sont créés par l'administrateur (`catalog.sales_channel.create`) ; (b) un canal par rôle de vendeur ; (c) canal toujours saisi.
- **Recommandation** : (a).
- **Impact** : `sales.sale.record`, données initiales (AV-072 : créer `POINT_DE_VENTE`, `TERRAIN`, `SEDENTAIRE`, `DIRECT`, `KOMMO` avant la première vente). Défaut implémenté : (a).

### AV-141 — Vente en ligne avec un prix catalogue obsolète — SECONDAIRE
- **Question** : Un vendeur connecté enregistre une vente avec un prix catalogue différent de celui que le serveur connaît (son catalogue n'est pas à jour). Que fait-on ?
- **Pourquoi** : hors ligne, la vente est un fait déjà conclu au prix affiché (AV-063 : acceptée, anomalie `PRICE_MISMATCH`). En ligne, rien n'oblige à vendre à un prix périmé, et une remise calculée sur un ancien prix pourrait dépasser le plafond sans que le vendeur le sache.
- **Choix** : (a) la vente est refusée avec le message « actualiser le catalogue » (`PRICE_OUTDATED`) ; (b) elle est acceptée avec l'anomalie `PRICE_MISMATCH` comme hors ligne ; (c) l'écart est traité comme une dérogation.
- **Recommandation** : (a).
- **Impact** : `sales.sale.record` en ligne. Défaut implémenté : (a).

### AV-142 — Qui traite le stock négatif d'une vente hors ligne — SECONDAIRE
- **Question** : Une vente hors ligne rend le stock négatif (le stock réel était plus faible que prévu). Qui reçoit l'anomalie `STOCK_NEGATIVE` à résoudre ?
- **Pourquoi** : la matrice des conflits dit « le responsable du site » mais le rôle « responsable PDV » n'existe pas dans les rôles du projet.
- **Choix** : (a) le magasinier pour un magasin ou un point de vente, le responsable de ferme pour une ferme, le responsable commercial pour un stock mobile ; (b) toujours la Direction ; (c) le responsable commercial dans tous les cas.
- **Recommandation** : (a).
- **Impact** : `sales.sale.record` (propriétaire du conflit `STOCK_NEGATIVE`). Défaut implémenté : (a).

### AV-143 — Vente à crédit hors ligne à un client non autorisé au crédit — SECONDAIRE
- **Question** : Un commercial, sans réseau, vend à crédit à un client qui n'a pas (ou plus) l'autorisation de crédit. La vente est déjà conclue : que fait-on ?
- **Pourquoi** : D04 traite le dépassement du plafond (vente appliquée, validation a posteriori), pas le client sans autorisation de crédit. En ligne, la vente est refusée (`CREDIT_NOT_ALLOWED`).
- **Choix** : (a) la vente est appliquée et traitée comme un dépassement : validation a posteriori `CREDIT_LIMIT_EXCEEDED` ; (b) la vente est refusée à la synchronisation.
- **Recommandation** : (a) : le fait physique existe, comme pour toute vente hors ligne.
- **Impact** : `sales.sale.record` hors ligne. Défaut implémenté : (a).

### AV-144 — Vente directe depuis un magasin — SECONDAIRE
- **Question** : Un magasinier peut-il vendre directement depuis un magasin (emplacement de stockage), ou seulement depuis un point de vente, un stock mobile ou une ferme ?
- **Pourquoi** : BR-VEN-017 liste le point de vente, le stock mobile et la ferme ; le magasin sert à stocker et à préparer les commandes.
- **Choix** : (a) refusée (`LOCATION_NOT_SELLABLE`) ; (b) autorisée, au même titre qu'un point de vente.
- **Recommandation** : (a) ; (b) si un magasin vend au comptoir.
- **Impact** : `sales.sale.record`. Défaut implémenté : (a).

### AV-146 — Sort de l'argent payé d'une vente annulée — SECONDAIRE
- **Question** : Quand une vente déjà payée est annulée, l'argent est-il rendu au client (remboursement) ou gardé à son nom pour un prochain achat (crédit client) ? Qui choisit ?
- **Pourquoi** : BR-VEN-027 laisse le choix « à l'approbateur » sans défaut ; une annulation directe (dans les 15 minutes) n'a pas d'approbateur ; une vente sans client ne peut pas porter de crédit.
- **Choix** : (a) le choix est fait par celui qui annule (annulation directe) ou par l'approbateur (demande) et il est obligatoire ; sans client, remboursement ; (b) toujours remboursement ; (c) toujours crédit client quand il y a un client.
- **Recommandation** : (a).
- **Impact** : `sales.sale.cancel`, `.request_cancellation`, décision `SALE_CANCELLATION`, trésorerie (`REFUND`). Le même défaut vaut pour l'annulation d'une commande, la clôture de son reste et la baisse d'une commande (`sales.order.cancel`, `.close_remaining`, `.update`, P4-06) : l'auteur de la commande ou le Resp. commercial choisit (`paymentTreatment`, un seul choix pour toute la part libérée, acompte compris) ; sans choix, `PAYMENT_TREATMENT_REQUIRED`. Défaut implémenté : (a).

### AV-145 — Vente en ligne à un client dont le compte a été fusionné — SECONDAIRE
- **Question** : Un vendeur connecté choisit un client dont le compte a été fusionné dans un autre (doublon). Que fait-on ?
- **Pourquoi** : D04 §14 ne traite que la saisie hors ligne (vendue sur le compte d'origine, les lectures suivent la fusion). Le CRM refuse déjà d'agir sur un compte fusionné.
- **Choix** : (a) la vente est refusée : vendre au compte conservé (`CUSTOMER_MERGED`) ; (b) elle est acceptée et rattachée au compte conservé.
- **Recommandation** : (a).
- **Impact** : `sales.sale.record` en ligne. Défaut implémenté : (a).

### AV-147 — Remise sur une ligne de commande — SECONDAIRE
- **Question** : Une ligne de vente directe peut porter une remise en XAF (BR-VEN-015, AV-026). Une ligne de commande peut-elle en porter une aussi, que la vente reprendrait à chaque confirmation ?
- **Pourquoi** : la ligne de commande fige un prix convenu (BR-VEN-003) mais n'a ni remise ni montant remisé ; la vente créée à la confirmation reprend ce prix sans remise (`ORDER_QUOTE`, AV-087). Un rabais négocié avec le client doit donc se traduire par un prix unitaire convenu plus bas.
- **Choix** : (a) pas de remise sur une ligne de commande : la dérogation se saisit par le prix convenu (prix unitaire), soumise au plafond du rôle et à la validation `PRICE_OVERRIDE` comme une dérogation de vente ; (b) remise en XAF sur la ligne de commande, reprise par chaque ligne de vente créée (avec ses règles de plafond et de validation).
- **Recommandation** : (a) : un prix convenu unique évite de répartir une remise sur les ventes partielles successives d'une même ligne (arrondis au franc, annulations partielles).
- **Impact** : `sales.order.save_draft`, `.place` et `.update` (ligne ajoutée) refusent une remise (`DISCOUNT_NOT_SUPPORTED_ON_ORDER`) ; schéma de `sales_sales_order_lines` (option b : colonne de remise). Défaut implémenté : (a).

### AV-148 — Confirmation d'un brouillon : prix de la saisie ou prix du jour — SECONDAIRE
- **Question** : Un brouillon préparé au bureau (`sales.order.save_draft`) est confirmé plus tard (`sales.order.place`, même identifiant) : la commande garde-t-elle les lignes et les prix résolus à la saisie du brouillon, ou les prix sont-ils recalculés à la confirmation ?
- **Pourquoi** : BR-VEN-003 fixait le prix « au moment de la confirmation » ; un brouillon a déjà des prix résolus et enregistrés à sa saisie. Entre les deux, une règle tarifaire a pu changer, et le client a peut-être reçu un prix pendant la préparation.
- **Choix** : (a) lignes et prix figés à la saisie du brouillon : la confirmation ne change ni lignes ni prix, et la vente créée reprend ces prix ; (b) prix recalculés à la confirmation par le moteur de tarification, à l'heure de la confirmation (le brouillon n'est alors qu'une liste de produits et de quantités).
- **Recommandation** : (a) : le prix convenu avec le client est celui qui lui a été proposé ; le brouillon prépare la commande, il ne la renégocie pas.
- **Impact** : `sales.order.place` sur un brouillon existant (charge utile sans `lines`), `sales.order.save_draft`, BR-VEN-003. Défaut implémenté : (a).

### AV-149 — Annulation d'une vente sur commande : la commande garde-t-elle la quantité ? — IMPORTANTE
- **Question** : Une vente créée par la confirmation d'une commande est annulée, en tout ou en partie (`sales.sale.cancel`, `.request_cancellation`, décision `SALE_CANCELLATION`), pour sa part non livrée. Que devient la quantité annulée sur la commande ?
- **Pourquoi** : SM-SALE dit seulement « commande recalculée ». ADR-028 §5 donne à la commande ses propres annulations (`sales.order.cancel`, `.close_remaining`, `.update`), mais une vente sur commande reste annulable directement (ADR-029 §10). Selon le cas, l'annulation corrige une erreur de la vente (le client attend toujours sa marchandise) ou renonce à la livraison.
- **Choix** : (a) la quantité annulée est retirée de la commande (commandé et vendu baissent), qui ne la revendra pas ; la commande devient `CANCELLED` ou `CLOSED` quand plus rien n'est ouvert ; (b) la quantité annulée revient « en attente » sur la commande, qui la revendra à la prochaine confirmation du reste ; (c) une vente sur commande ne s'annule que par les commandes de la commande (`sales.order.cancel`, `.close_remaining`, `.update`) : `sales.sale.cancel` la refuse.
- **Recommandation** : (a) : annuler une vente est un renoncement ; (b) rouvrirait aussitôt une vente que l'on vient d'annuler. (c) si l'on veut qu'une commande ne soit modifiée que par ses propres commandes.
- **Impact** : `sales.sale.cancel`, `.request_cancellation` et décision `SALE_CANCELLATION` sur une vente de type `ORDER` ; version et statut de la commande ; SM-ORDER, SM-SALE. Défaut implémenté : (a).

### AV-150 — Encaissement saisi hors ligne avec une commande que le serveur refuse ; acompte supérieur au total — IMPORTANTE
- **Question** : Un commercial, hors ligne, prend une commande et encaisse un acompte en espèces. À la synchronisation, le serveur refuse la commande (client sans crédit pour le reste, compte fusionné, canal inconnu…) : la commande est une intention (AV-126). Que devient l'argent, qui est bel et bien dans la caisse du commercial ? Et un acompte peut-il dépasser le total de la commande ?
- **Pourquoi** : aujourd'hui le rejet de la commande annule tout, encaissement compris : la caisse physique et la trésorerie divergent sans trace. L'encaissement est un fait accompli (BR-SYN-007), la commande non. Sans plafond, l'excédent d'un acompte reste affecté à la commande jusqu'à sa clôture (revue adverse de P4-06).
- **Choix** : (a) l'encaissement est enregistré seul, en crédit client non affecté (ou, sans client identifiable, en encaissement à rembourser), avec un conflit pour la Finance, même si la commande est refusée ; un acompte en ligne est borné au total estimé de la commande (`PAYMENT_EXCEEDS_TOTAL`) ; (b) la commande est rejetée avec son encaissement (état actuel) et le commercial ressaisit l'argent comme un encaissement ; (c) l'acompte n'est accepté qu'en ligne.
- **Recommandation** : (a) : l'argent reçu ne doit jamais disparaître du système.
- **Impact** : `sales.order.place` hors ligne ; `sales.payment.record` (P4-08), qui porte l'encaissement seul et le crédit client non affecté ; conflits ; trésorerie. **État (P4-08)** : le plafond de l'acompte est implémenté (`sales.payment.record` : reste à vendre de la commande, refus en ligne, surplus en crédit hors ligne avec l'avertissement `PAYMENT_UNALLOCATED` et un conflit pour la Finance) ; l'encaissement anonyme hors ligne dont la vente est soldée entre-temps est encore refusé (le crédit exige un client). **État (P4-11)** : une commande refusée hors ligne avec des acomptes est défaite (point de sauvegarde) et chaque acompte est enregistré seul, en crédit client non affecté, avec le conflit `ORDER_REFUSED_PAYMENT_KEPT` pour la Finance ; la commande répond `CONFLICT`. En ligne, le refus reste un refus sans encaissement ; un client inconnu garde le refus d'origine (le crédit exige un client).

### AV-151 — Annulation d'un encaissement en partie remboursé — SECONDAIRE
- **Question** : Un client paie 5 000 XAF ; 2 000 restent en crédit et la Finance lui en rembourse 1 500. On découvre ensuite que l'encaissement était erroné. Peut-on l'annuler ?
- **Pourquoi** : l'annulation inverse le mouvement de trésorerie d'origine (5 000) ; le remboursement (1 500) est déjà sorti de caisse. Annuler les deux exige de défaire aussi le remboursement, qui est un fait physique (argent remis).
- **Choix** : (a) refus (`PAYMENT_PARTIALLY_REFUNDED`) : la Finance corrige autrement (réaffectation, écriture de régularisation) ; (b) annulation de la seule part non remboursée ; (c) annulation totale avec une entrée de régularisation du remboursement.
- **Recommandation** : (a) en V1, le cas est rare et la Finance garde la main.
- **Impact** : `sales.payment.request_cancellation` ; SM-CUSTOMER-PAYMENT. Défaut implémenté : (a).

### AV-152 — Mort d'animaux vivants hors d'un lot de production — SECONDAIRE
- **Question** : WF-06 fait déclarer par le commercial une perte `MORTALITE` pour deux poulets morts sur son stock mobile. Or une perte `MORTALITE` exige un lot de production ou d'incubation (P7-02, AV-113). Que déclarer quand les animaux morts ne viennent pas d'un lot suivi (marchandise vivante achetée, stock mobile sans lot) ?
- **Pourquoi** : la catégorie compte dans la mortalité du lot (taux, validation, photo) ; sans lot, elle ne peut pas être rattachée, et une autre catégorie fausse le libellé de la perte.
- **Choix** : (a) animaux issus d'un lot : `MORTALITE` rattachée au lot ; sinon perte simple `DETERIORATION`, motif en commentaire ; (b) autoriser `MORTALITE` sans lot pour la marchandise vivante (contrainte relâchée, hors des indicateurs de lot) ; (c) une catégorie dédiée « mort d'animal hors lot ».
- **Recommandation** : (a) : les poulets vendus en tournée viennent des lots de la ferme ; la marchandise vivante achetée est rare.
- **Impact** : `inventory.loss.declare` ; WF-06 ; dictionnaire `06-inventory` (`category`). Défaut implémenté : (a), sans changement de code (test d'acceptation AT-018 : perte `DETERIORATION` de marchandise sans lot).

### AV-153 — Écart d'une remise de fonds : imputation et excédent — IMPORTANTE
- **Question** : Un vendeur envoie 173 000 XAF à la caisse centrale, la Finance en reçoit 170 000. Qui supporte les 3 000 manquants, et que fait-on si elle reçoit **plus** que prévu ?
- **Pourquoi** : SM-CASH-TRANSFER écrit déjà la sortie du montant envoyé et l'entrée du montant reçu : la perte est dans les livres. Les sources ajoutent pourtant un second mouvement d'écart (double comptage, ADR-032) et ne disent ni qui est imputé ni ce qu'est un excédent.
- **Choix** : (a) aucun second mouvement ; la Finance choisit l'imputation à la clôture (expéditeur, porteur, récepteur, entreprise), l'excédent est admis comme un écart de signe contraire ; (b) imputation automatique à l'expéditeur ; (c) écart d'office à la charge de l'entreprise.
- **Recommandation** : (a) : la retenue éventuelle sur la personne relève d'une dépense ou créance dédiée (P8).
- **Impact** : `finance.cash_transfer.receive`, décision `CASH_TRANSFER_DISCREPANCY`, `finance_cash_transfers` (écart signé, imputation, motif) ; ADR-032. Défaut implémenté : (a).

### AV-154 — Cycle quotidien de la session de caisse — IMPORTANTE — **TRANCHÉ**
- **Question** : AV-057 retient une session par PDV et par jour. Que fait-on d'une seconde session le même jour (relève d'équipe, ouverture par erreur), d'une ouverture saisie hors ligne alors que la session de la veille n'est pas clôturée, et de deux tablettes qui ouvrent chacune « la » session hors ligne ?
- **Pourquoi** : BR-DIS-006 interdit seulement deux sessions ouvertes ; D05 §14 interdit d'ouvrir avant la clôture de la précédente, mais la clôture forcée exige la Finance en ligne : un PDV hors ligne pourrait être bloqué. Une ouverture est un comptage physique, un fait accompli qui ne se rejette pas (BR-SYN-007).
- **Choix** : (a) une session par PDV et par jour (paramètre `finance.cash_sessions_per_day_max`, défaut 1) ; en ligne, refus `CASH_SESSION_ALREADY_OPEN` ; hors ligne, la seconde ouverture est fusionnée dans la session la plus ancienne (comptage conservé, conflit informatif `CASH_SESSION_CONCURRENT_OPEN`) ; la Finance force la clôture d'une session de plus de 24 h ; (b) plusieurs sessions par jour sans limite ; (c) ouverture refusée tant que la précédente n'est pas close, même hors ligne.
- **Recommandation** : (a).
- **Impact** : `finance.cash_session.open` ; INV-FIN-06 ; matrice des conflits. Défaut implémenté : (a) (P5-12 : `planCashSessionOpen`, refus en ligne `CASH_SESSION_ALREADY_OPEN`, `_OVERLAP`, `_DAILY_LIMIT`, fusion hors ligne ; AV-167 et AV-168 précisent la fusion ; limite comptée par caisse ; clôture forcée `finance.cash_session.force_close`).
- **Décision** (porteur du projet, 13/10/2026, après la vérification des écrans : une fois la caisse clôturée, le PDV ne pouvait plus encaisser d'espèces avant le lendemain) : **sans limite** de sessions par jour ; chaque session est comptée et validée par la Finance. Le paramètre `finance.cash_sessions_per_day_max` reste, avec 0 pour « sans limite » (nouveau défaut) ; un site peut encore être borné. Le reste de (a) est inchangé : une seule session ouverte à la fois (BR-DIS-006, INV-FIN-06), fusion hors ligne des ouvertures concurrentes, clôture forcée. Lot de mise en pilote (MP-03).

### AV-155 — Responsabilité d'un écart de caisse avec plusieurs vendeurs, et valideur — IMPORTANTE
- **Question** : Une tablette de PDV est partagée (AV-007) mais le PDV n'a qu'une caisse et une session par jour. À qui impute-t-on l'écart, et que signifie « le valideur n'est pas le vendeur » quand plusieurs vendeurs ont encaissé ?
- **Pourquoi** : la session ne porte qu'un ouvreur et un clôtureur ; D05 §14 parle d'un historique d'écarts « par vendeur ».
- **Choix** : (a) l'écart est imputé à celui qui clôture, journalisé, avec un sous-total des encaissements espèces par vendeur (`received_by_user_id`) pour l'enquête ; le valideur n'est ni l'ouvreur, ni le clôtureur, ni l'auteur d'une clôture forcée ; (b) répartition de l'écart au prorata des encaissements ; (c) une caisse par vendeur.
- **Recommandation** : (a).
- **Impact** : `finance.cash_session.validate` ; lecture d'une session ; ECR-FIN-05. Défaut implémenté : (a) (P5-12 : `closed_by` = l'auteur de la clôture, responsable imputé dans `CashVarianceDetected` ; clôture forcée : AV-170 ; valideur : P5-13 ; sous-totaux par vendeur : P5-14, forme en AV-187).

### AV-156 — Fonds de caisse initial et écart d'ouverture — SECONDAIRE
- **Question** : La première session d'une caisse neuve s'ouvre avec 20 000 XAF comptés pour un solde de 0 : est-ce un écart ? Et à qui revient l'écart d'ouverture des sessions suivantes ?
- **Pourquoi** : BR-FIN-014 écrit un écart à l'ouverture quand le fonds diffère du solde ; le fonds de départ n'est pas une erreur de comptage. Le solde d'ouverture est par ailleurs un mouvement `OPENING_BALANCE` selon le dictionnaire des comptes.
- **Choix** : (a) un écart d'ouverture est toujours posé (`SESSION_VARIANCE`) et validé par la Finance, qui peut le motiver « fonds initial » ; il appartient à la période précédente et n'entre pas dans l'attendu (ADR-032) ; (b) la Finance alimente d'abord la caisse par une remise de fonds ou un solde d'ouverture ; (c) un fonds initial n'est jamais un écart.
- **Recommandation** : (a), simple et traçable ; (b) reste possible.
- **Impact** : `finance.cash_session.open` ; ADR-032. Défaut implémenté : (a) (P5-12 : écart d'ouverture = fonds compté − solde du registre à l'ouverture, `SESSION_VARIANCE` posé à l'ouverture, session `PENDING_VALIDATION` à la clôture).

### AV-157 — Mouvements d'espèces hors session ou décidés après coup — IMPORTANTE
- **Question** : Un encaissement en espèces est saisi hors ligne sans session ouverte ; un remboursement est décidé en ligne par la Finance après la clôture ; un encaissement est annulé le lendemain. Dans quelle session tombent ces mouvements, et sont-ils refusés ?
- **Pourquoi** : D05 §8 rejette (`CASH_SESSION_REQUIRED`) une vente en espèces sans session ; BR-SYN-007 interdit de rejeter un fait accompli. Le registre est immuable : un mouvement ne se rattache pas après coup (ADR-032).
- **Choix** : (a) en ligne, refus `CASH_SESSION_REQUIRED` ; hors ligne, fait appliqué avec avertissement et conflit informatif `CASH_SESSION_MISSING` (propriétaire Finance), sans session si aucune ne couvre sa date ; un remboursement et une remise annulée se rattachent à la session couvrant **leur propre date** ; l'inverse d'un encaissement hérite de la session de l'original et déclenche une réévaluation ; (b) toute vente en espèces hors ligne sans session est bloquée par l'appareil ; (c) rattachement systématique à la session suivante.
- **Recommandation** : (a).
- **Impact** : `sales.sale.record`, `sales.payment.record`, `sales.payment.refund` ; matrice des conflits ; ADR-032. Défaut implémenté : (a). P5-12 : `recordCashMovement` pose l'index `cash_session_id` d'un inverse sur la session de l'original (son index, à défaut la session couvrant sa date) ; P5-14 : l'inverse d'une annulation d'encaissement porte l'`occurred_at` de l'original et retombe dans sa fenêtre (ADR-032 §2) ; refus en ligne et constat hors ligne précisés en AV-184 ; remboursement sans session en AV-186.

### AV-158 — Remises de fonds : comptes admis, récepteur, alerte — SECONDAIRE
- **Question** : Entre quels types de comptes une remise est-elle permise, qui la réceptionne, et au bout de combien de temps une remise envoyée et non reçue est-elle signalée ?
- **Pourquoi** : les sources ne fixent ni les paires de comptes, ni la séparation des tâches entre expéditeur et récepteur, ni de délai d'alerte pour l'argent (48 h existent pour les transferts de stock).
- **Choix** : (a) toute caisse de PDV ou d'utilisateur vers la caisse centrale ou la banque (et la caisse centrale vers un PDV pour son fonds) ; récepteur = responsable du compte destinataire, différent de l'expéditeur ; alerte à 48 h (`finance.cash_transfer_unreceived_hours`) ; porteur = utilisateur ou nom libre ; une seule permission `finance.cash_transfer.record` contrôlée par la portée du compte concerné ; (b) permission de réception distincte ; (c) paires libres.
- **Recommandation** : (a).
- **Impact** : `finance.cash_transfer.*` ; RBAC. Défaut implémenté : (a). **Précisions de P5-15** (À VALIDER) : les paires sont paramétrables (`finance.cash_transfer_allowed_pairs`, défaut du domaine `DEFAULT_CASH_TRANSFER_PAIRS`) et le défaut complète le (a) d'après le glossaire (« PDV → caisse centrale → banque ») et les flux de retrait — `CAISSE_PDV` et `CAISSE_UTILISATEUR` → `CAISSE_CENTRALE` ou `BANQUE` ; `CAISSE_CENTRALE` → `CAISSE_PDV` (fonds) ou `BANQUE` ; `BANQUE` → `CAISSE_CENTRALE` (retrait) ; `MOBILE_MONEY` → `CAISSE_CENTRALE` ou `BANQUE` ; aucune remise vers une caisse d'utilisateur ni vers le mobile money. Une paire refusée est rejetée en ligne (`CASH_TRANSFER_PAIR_NOT_ALLOWED`) et appliquée avec avertissement et conflit hors ligne (l'argent a déjà quitté la caisse, BR-SYN-007). Le récepteur et l'annulation sont précisés par AV-172, qui remplace « récepteur = responsable du compte destinataire ».

### AV-159 — Refus, recomptage et correction d'un écart de caisse — SECONDAIRE
- **Question** : La Finance peut-elle refuser un comptage manifestement faux, ordonner un recomptage, ou corriger un écart déjà validé ?
- **Pourquoi** : SM-CASH-SESSION ne connaît que l'acceptation (`VALIDATED`).
- **Choix** : (a) acceptation seule ; une erreur de comptage se corrige par un **ajustement** (réévaluation) lui-même validé, jamais par une réécriture ; (b) refus avec retour à la clôture ; (c) recomptage obligatoire au-delà d'un seuil.
- **Recommandation** : (a) : un refus rouvrirait une session dont des mouvements ont déjà été rattachés.
- **Impact** : `finance_cash_session_adjustments` ; SM-CASH-SESSION. Défaut implémenté : (a).

### AV-160 — Quotas d'appareil : granularité et validité par défaut — IMPORTANTE
- **Question** : Un quota porte-t-il sur un produit ou sur un lot précis, et jusqu'à quand est-il valable quand on n'indique rien ?
- **Pourquoi** : le lot d'une sortie est choisi par le FIFO du serveur ; l'appareil ne le connaît pas. ADR-004 prévoit une validité (`valid_until`) sans valeur par défaut.
- **Choix** : (a) quota par (emplacement, produit), le lot éventuel est indicatif et ne change pas le disponible ; valide jusqu'à la fin du jour métier (Africa/Douala) de l'octroi, durée modifiable à l'octroi ; (b) quota par lot ; (c) quota sans échéance.
- **Recommandation** : (a).
- **Impact** : `inventory.allocation.grant` ; disponible d'un consommateur ; ADR-033. Défaut implémenté : (a).

### AV-161 — Quotas d'appareil : dépassement, quota révoqué ou échu — IMPORTANTE
- **Question** : Une vente saisie hors ligne dépasse le quota de l'appareil (appareil modifié), ou arrive après la révocation ou l'échéance du quota. Que fait le serveur ?
- **Pourquoi** : BR-SYN-007 interdit de la rejeter ; les sources parlent d'un reste « positif » (WF-18) et d'un reste négatif « sauf conflit tracé » (dictionnaire).
- **Choix** : (a) le fait est appliqué, le quota ramené à 0, l'excédent pris sur le stock commun ; conflit `ALLOCATION_EXCEEDED` (gravité réduite si l'option « autorisée et signalée » du site est active) ; consommation après révocation : appliquée au stock commun, `ALLOCATION_REVOKED_CONSUMED` seulement pour un fait **hors ligne** dont l'`occurred_at` suit la révocation (en ligne, rien n'est imputé au quota révoqué : sortie normale du stock libre) ; un fait hors ligne antérieur à la révocation, synchronisé après elle, reste signalé `ALLOCATION_EXCEEDED` s'il dépassait le reste du quota au moment de la révocation (AT-003 ; chaque fait est jugé seul, sans cumul entre faits en retard : DÉDUIT) ; (b) reste de quota négatif tracé ; (c) rejet.
- **Recommandation** : (a) : le reste ne devient jamais négatif, INV-STK-10 reste vérifiable.
- **Impact** : `recordStockMove` ; matrice des conflits ; ADR-033. Défaut implémenté : (a).

### AV-162 — Qui accorde les quotas, et permission de libération — IMPORTANTE
- **Question** : AV-035 confie l'octroi au « responsable du PDV », qui n'est pas un rôle du projet (AV-142). Qui l'exerce, et sous quelle permission l'appareil détenteur libère-t-il son quota ?
- **Pourquoi** : `inventory.allocation.manage` n'est donnée qu'à Direction, Resp. commercial (zone), Resp. ferme (site) et magasinier (site), pas au vendeur de PDV ; le registre de commandes exige une permission pour chaque commande.
- **Choix** : (a) le magasinier affecté au site du PDV, le Resp. commercial de la zone ou la Direction accordent, augmentent et révoquent ; la libération par le détenteur relève d'une permission dédiée `inventory.allocation.release` de portée propre ; aucun rôle créé ; (b) donner `allocation.manage` à un vendeur senior ; (c) créer un rôle de responsable de PDV.
- **Recommandation** : (a).
- **Impact** : RBAC et seed ; `inventory.allocation.*`. Défaut implémenté : (a). Les affectations de rôle de démonstration couvrent le magasinier (site ou zone) et le Resp. commercial (zone).

### AV-163 — Garde d'appareil : mode par défaut et appareil non désigné — IMPORTANTE
- **Question** : Quel mode de garde reçoit un emplacement créé sans le préciser, et que fait le serveur d'une vente hors ligne venue d'un appareil qui n'est pas celui désigné pour le PDV (ou pas l'appareil principal du détenteur d'un stock mobile) ?
- **Pourquoi** : BR-STK-010 impose un mode à chaque emplacement physique, mais la colonne est facultative et le code traite l'absence comme `SHARED` ; BR-ADM-009 dit « `SHARED` hors stock mobile ». Une tablette de secours légitime existe.
- **Choix** : (a) mode obligatoire, défaut par type (magasin, bâtiment, enclos : `SHARED` ; stock mobile : `EXCLUSIVE_USER` ; PDV : issu de sa configuration) ; une tablette unique partagée est `EXCLUSIVE_DEVICE` sans quota ; un appareil non désigné vend hors ligne : fait appliqué, conflit `CUSTODY_DEVICE_MISMATCH` (propriétaire : magasinier du site), l'écran le bloque ; le stock est servi à toutes les tablettes ; (b) refuser côté serveur ; (c) ne servir le stock qu'à l'appareil désigné.
- **Recommandation** : (a).
- **Impact** : `organization.pos.configure`, `location.create`, `sales.sale.record` ; BR-ADM-009 réécrite ; ADR-033. Défaut implémenté : (a).

### AV-164 — Tableau de distribution : définitions et périmètre — SECONDAIRE
- **Question** : Comment compte-t-on « vendu » (vente à la confirmation, contre-écritures) et « perdu » (écarts de transfert, pertes en attente), qui voit le tableau, et sous quelle adresse est-il servi avant le module d'analyse (P9) ?
- **Pourquoi** : BR-DIS-010 date les ventes sans traiter les ventes sur commande ni les contre-écritures partielles (ADR-028, ADR-029) ; le magasinier n'a ni droit de lecture des ventes ni de la caisse ; REQ-024 cite une route d'analyse de P9.
- **Choix** : (a) vendu = ventes moins retours rattachés à la date de chaque mouvement, avec la colonne « vendu à livrer » ; perdu = pertes reconnues + écarts d'inventaire négatifs + écarts de transfert confirmés (pertes en attente à part) ; la permission du tableau suffit aux agrégats, le détail par document exige le droit du domaine ; route `GET /api/v1/analytics/dashboards/distribution` livrée en P5 par la couche de transport, reprise sans changement par P9 ; (b) route propre ; (c) droits de lecture du domaine exigés.
- **Recommandation** : (a).
- **Impact** : `distribution-api/` ; BR-DIS-010 ; ECR-DIS-04 ; ADR-030. Défaut implémenté : (a).

### AV-165 — Sessions de caisse hors PDV et PDV à plusieurs appareils — SECONDAIRE
- **Question** : Une caisse utilisateur de commercial de terrain ouvre-t-elle des sessions ? La Finance attend-elle la synchronisation de toutes les tablettes d'un PDV `SHARED` avant de valider ?
- **Pourquoi** : BR-FIN-014 est générique alors que le dictionnaire et D05 parlent de PDV ; une tablette ne voit que ses propres ventes (D05 §12).
- **Choix** : (a) seules les caisses de PDV ont des sessions (une caisse utilisateur se vide par remise de fonds, alerte `CASH_HOLDING_HIGH`) ; la validation n'attend personne, la fraîcheur de synchronisation de chaque appareil du PDV est affichée à la Finance ; (b) sessions pour toutes les caisses ; (c) validation bloquée tant qu'un appareil n'a pas synchronisé.
- **Recommandation** : (a).
- **Impact** : `finance.cash_session.open` (refus d'un compte autre que `CAISSE_PDV`) ; tableau de distribution. Défaut implémenté : (a) (P5-12 : `CASH_SESSION_POS_ACCOUNT_REQUIRED`, en ligne comme hors ligne).

### AV-166 — Vente hors ligne sans quota utilisable sur un emplacement partagé : signal du serveur — IMPORTANTE
- **Question** : Une vente hors ligne arrive d'un appareil qui n'a **aucun quota**, ou dont le quota est **échu**, sur un emplacement `SHARED` (PDV à plusieurs tablettes, magasin, bâtiment d'élevage). La tablette aurait dû la bloquer (`ALLOCATION_MISSING`, `ALLOCATION_EXPIRED`), ou la laisser passer en la signalant si le site a activé l'option « autorisée et signalée » (AV-025). Le serveur, qui l'applique toujours (BR-SYN-007), doit-il la signaler, et dans quels cas ?
- **Pourquoi** : AV-025 (tranché) et BR-STK-010, BR-DIS-002 réservent la vente hors ligne d'un emplacement partagé aux quotas, et WF-18 dit le stock non alloué « vendable seulement en ligne ». Mais ADR-033 et P5-09 ne signalaient que le dépassement d'un quota détenu, le quota d'autrui entamé (`ALLOCATION_OVERCOMMITTED`) et le stock négatif : un appareil modifié sans quota, ou dont le quota a expiré, contournait le blocage sans trace, et l'option « signalée » n'avait aucun signal serveur dans ce cas. À l'inverse, signaler toute vente hors ligne d'un emplacement partagé serait bruyant là où personne n'utilise de quota (bâtiments d'élevage, magasins), et rien n'y a été pris à un autre détenteur.
- **Choix** : (a) **signaler quand l'emplacement porte au moins un quota actif du produit** (un quota épuisé reste actif jusqu'à sa libération ou sa révocation : DÉDUIT ; paramètre `sales.offline_unallocated_sale_signal` = `WHEN_ALLOCATED`) : avertissement, drapeau de la vente et conflit appliqué `ALLOCATION_EXCEEDED`, motif `ALLOCATION_MISSING` (entité : l'emplacement) ou `ALLOCATION_EXPIRED` (entité : le quota échu), `quotaRemaining` = 0, `excess` = la quantité, `signalled` = option du site ; (b) `ALWAYS` : signaler toute vente hors ligne sans quota utilisable d'un emplacement partagé ; (c) `NEVER` : ne rien signaler en propre (comportement de P5-09 : seuls `ALLOCATION_OVERCOMMITTED` et `STOCK_NEGATIVE` disent le dommage) ; (d) étendre le signal aux pertes, transferts et consommations hors ligne. Dans tous les cas, un quota **révoqué** relève d'`ALLOCATION_REVOKED_CONSUMED` ou d'`ALLOCATION_EXCEEDED` selon l'`occurred_at` du fait (AV-161), jamais d'ici, et la vente est appliquée sur le stock commun.
- **Recommandation** : (a) pour le pilote, (b) sur les PDV partagés si des contournements apparaissent (réglage du site).
- **Impact** : `inventory` (`prepareQuotaConsumption`), `packages/domain` (`offlineAllocationSignal`, miroir serveur de `decideLocalConsumption`, AT-003), paramètre semé, matrice des conflits, BR-VEN-018, WF-01, WF-18. Défaut implémenté : (a), paramétrable par site (`ALWAYS`, `NEVER`).

### AV-167 — Ouverture de caisse hors ligne plus ancienne que la session qu'elle chevauche — SECONDAIRE
- **Question** : Une ouverture de caisse saisie hors ligne arrive après qu'une autre ouverture de la même caisse, plus tardive dans la journée, a été enregistrée, ou elle précède une session déjà close. Dans quelle session la fusionner, et que deviennent les mouvements entre l'heure saisie et l'ouverture de la session retenue ?
- **Pourquoi** : AV-154 (a) fusionne « dans la session la plus ancienne », mais la session déjà enregistrée ne peut pas avancer son heure d'ouverture (ouverture immuable, déclencheur `update_guard`) ; insérer l'ouverture plus ancienne créerait un chevauchement de fenêtres (ADR-032 §2), que le filet de la base refuserait en boucle. Le cas est réel avec deux tablettes d'un PDV partagé dont la plus matinale synchronise en dernier (AV-007).
- **Choix** : (a) fusion dans la plus ancienne session existante en cause, fenêtre inchangée ; le comptage, l'heure saisie et l'heure retenue sont consignés dans le conflit `CASH_SESSION_CONCURRENT_OPEN` (`earlierThanTarget`) ; les mouvements de l'intervalle restent hors de la session retenue (dans aucune session, ou dans la fenêtre précédente), visibles par la Finance ; (b) clore d'office la session existante et ouvrir la plus ancienne (réécrit une ouverture, contraire à ADR-006 et au déclencheur) ; (c) rejet (contraire à BR-SYN-007).
- **Recommandation** : (a).
- **Impact** : `finance.cash_session.open` ; `planCashSessionOpen` (`packages/domain`). Défaut implémenté (P5-12) : (a), isolé dans la fonction du domaine, modifiable sans migration.

### AV-168 — Ouverture de caisse hors ligne pendant la session de la veille, close d'office depuis — IMPORTANTE
- **Question** : Un vendeur oublie de clôturer la session de la veille ; le matin, sa tablette hors ligne ouvre la journée (07:30) ; la Finance clôture d'office la session de la veille en ligne à 10:00. Quand l'ouverture du matin arrive, son heure tombe dans la fenêtre de la session close `[veille, 10:00[`. Que devient-elle ?
- **Pourquoi** : la fusion d'AV-154 vise une session de la veille **encore ouverte**. Fusionnée dans une session close, l'ouverture laisserait la journée sans session : la clôture du soir ne serait qu'une observation et l'argent du jour ne serait rapproché qu'à l'ouverture suivante (écart d'ouverture).
- **Choix** : (a) la nouvelle session prend effet à la clôture de la session de la veille (ouverture « décalée »), avec le comptage saisi, un conflit informatif `CASH_SESSION_CONCURRENT_OPEN` (`SHIFTED` : heure saisie, heure retenue, solde des mouvements de l'intervalle) et aucun chevauchement ; l'écart d'ouverture comprend alors l'opposé des mouvements de l'intervalle, compensé à la clôture (la somme des deux écarts est l'écart réel de la journée) ; si la journée a déjà une session après la clôture forcée, l'ouverture y est fusionnée ; (b) fusion dans la session close, la journée reste sans session ; (c) refuser la clôture forcée d'une session dans laquelle une ouverture a été fusionnée.
- **Recommandation** : (a) : la journée garde une session et la clôture du soir est rapprochée.
- **Impact** : `finance.cash_session.open` ; `planCashSessionOpen` (mode `SHIFT` ou `MERGE`, paramètre de la fonction, `SHIFT` par défaut) ; matrice des conflits. Défaut implémenté (P5-12) : (a), hors ligne seulement et pour une session d'un jour métier antérieur. Reste ouvert par construction : une ouverture fusionnée dans une session **encore ouverte** de la veille, puis clôture forcée de celle-ci, laisse la fin de journée sans session (la clôture du soir est une observation).

### AV-169 — Clôture de caisse hors ligne datée avant l'ouverture de la session — SECONDAIRE
- **Question** : Une clôture saisie hors ligne porte une heure antérieure à l'ouverture de la session visée (identifiant fusionné dans une session ouverte plus tard par une autre tablette, horloge décalée). Que faire du comptage ?
- **Pourquoi** : la base refuse une clôture antérieure à l'ouverture (`CHECK closed_at ≥ opened_at`) : appliquée telle quelle, l'erreur SQL serait rejouée sans fin ; un rejet contredirait BR-SYN-007.
- **Choix** : (a) observation : comptage conservé dans le conflit `CASH_SESSION_CONCURRENT_CLOSE` (raison `CLOSE_BEFORE_OPEN`), session laissée ouverte, refermée par une clôture ultérieure ou la clôture forcée ; (b) clôture ramenée à l'heure d'ouverture (fenêtre vide, comptage retenu) ; (c) clôture à l'heure de réception, avec `clock_suspect`.
- **Recommandation** : (a) : le comptage d'une autre période ne ferme pas la session d'une autre tablette.
- **Impact** : `finance.cash_session.close` ; `planCashSessionClose` (mode `OBSERVE` ou `CLOSE_AT_OPENING`, paramètre de la fonction). Défaut implémenté (P5-12) : (a).

### AV-170 — Responsable imputé de l'écart d'une clôture forcée et de l'écart d'ouverture — IMPORTANTE
- **Question** : AV-155 impute l'écart de caisse à « celui qui clôture ». Pour une clôture forcée, c'est l'agent de la Finance ou de la Direction qui déclare un comptage a posteriori. À qui imputer l'écart dans l'historique des écarts par vendeur (D05 §14), et à qui imputer l'écart d'ouverture ?
- **Pourquoi** : imputer l'écart à l'auteur de la clôture forcée fausserait l'historique par vendeur et l'alerte `CASH_VARIANCE` ; aucune source ne traite l'écart d'ouverture.
- **Choix** : (a) clôture forcée : l'ouvreur de la session, qui ne l'a pas clôturée ; écart d'ouverture : celui qui a compté le fonds (l'ouvreur) ; (b) aucune imputation avant la décision de la Finance ; (c) l'auteur de la clôture forcée.
- **Recommandation** : (a).
- **Impact** : `cashVarianceImputedUser` (`packages/domain`, mode `OPENER`, `NONE` ou `FORCER`) ; champ `imputed_user_id` de `CashVarianceDetected`, distinct de `closed_by` et de `forced_by` ; alerte `CASH_VARIANCE` (P9). Défaut implémenté (P5-12) : (a).

### AV-171 — Clôture de caisse datée avant un mouvement déjà enregistré sur la caisse — SECONDAIRE
- **Question** : l'attendu d'une clôture se calcule sur la fenêtre `[ouverture, clôture[` d'après l'`occurred_at` (ADR-032 §3), et le pipeline ne refuse que les dates **futures**. Une clôture dont l'heure précède des mouvements déjà enregistrés sur la caisse (horloge en retard, heure falsifiée) les exclut de l'attendu : le vendeur compte exactement l'attendu tronqué, l'écart est nul, la session est validée d'office et la différence n'apparaît qu'à l'ouverture suivante, imputée à l'ouvreur du lendemain (AV-170). Que faire d'une telle clôture ?
- **Pourquoi** : ADR-016 interdit toute correction silencieuse de `occurred_at` (on signale, on ne réécrit pas) ; BR-SYN-007 interdit de rejeter pour une raison d'état un fait déjà accompli hors ligne ; D05 §12 ne prévoit comme contrôle en ligne que « heure de clôture ≥ heure d'ouverture ».
- **Choix** : (a) en ligne, refus `CASH_SESSION_CLOSE_BEFORE_LAST_MOVEMENT` (sans effet) quand un mouvement du compte, hors `SESSION_VARIANCE` et `OPENING_BALANCE`, est daté à l'heure de clôture ou après (borne incluse : la fenêtre est demi-ouverte) ; hors ligne, la clôture est appliquée mais jamais validée d'office (`PENDING_VALIDATION`), avec l'avertissement et le conflit informatif `CASH_SESSION_CLOSE_BEFORE_MOVEMENTS` (dernier mouvement concerné, attendu, écart) ; la clôture forcée, toujours en ligne, suit la même règle ; (b) en ligne, clôture ramenée à l'heure de réception (correction de `occurred_at`, contraire à ADR-016) ; (c) accepter et signaler en ligne comme hors ligne ; (d) accepter sans rien signaler (comportement antérieur).
- **Recommandation** : (a) : l'attendu n'est jamais tronqué sans que la Finance le sache, sans corriger l'heure déclarée ni rejeter un comptage physique déjà fait. Une tolérance d'horloge entre appareils (quelques secondes) n'est pas introduite : un refus se corrige en reclôturant à l'heure réelle.
- **Impact** : `finance.cash_session.close` et `.force_close` ; `checkCashSessionCloseAgainstLedger` et `sessionStatusAfterClose` (`packages/domain`, mode `REFUSE_ONLINE` ou `FLAG`, paramètre de la fonction, `REFUSE_ONLINE` par défaut) ; matrice des conflits ; D05 §12 et §15. Défaut implémenté (P5-12, revue adverse) : (a).

### AV-172 — Remises de fonds : qui réceptionne et qui annule — SECONDAIRE
- **Question** : Qui peut réceptionner une remise de fonds — le responsable nominatif du compte destinataire, ou tout titulaire de `finance.cash_transfer.record` dont la portée couvre ce compte ? Le porteur peut-il être le récepteur ? Qui peut l'annuler ?
- **Pourquoi** : AV-158 (a) écrit à la fois « récepteur = responsable du compte destinataire » et « une seule permission contrôlée par la portée du compte » : deux lectures possibles. La Finance compte plusieurs personnes ; SM-CASH-TRANSFER réserve l'annulation à « l'expéditeur » sans dire ce que fait un collègue de relève. Une Finance réduite à une personne qui remet la caisse centrale à la banque ne peut pas réceptionner elle-même.
- **Choix** : (a) réception par tout titulaire de la permission dont la portée couvre le compte destinataire (Finance `ALL` pour la caisse centrale et la banque ; vendeur du site pour le fonds d'un PDV), différent de l'expéditeur (`CASH_TRANSFER_SELF_RECEIVE`, en ligne **et** hors ligne : règle d'autorisation) ; le porteur peut réceptionner ; annulation par l'expéditeur seul, depuis tout appareil (`CASH_TRANSFER_NOT_SENDER`) ; (b) responsable nominatif du compte seul ; (c) récepteur différent aussi du porteur ; annulation ouverte à toute la portée du compte source.
- **Recommandation** : (a). Équipe Finance d'une seule personne : faire réceptionner par un second titulaire (Direction avec un rôle `FINANCE` cumulé, AV-010) ; à défaut la remise reste `SENT`, l'alerte à 48 h la signale et la banque se confirme sur relevé.
- **Impact** : `finance.cash_transfer.receive`, `.cancel` ; SM-CASH-TRANSFER ; D09 §16. Défaut implémenté : (a). Portée : le détenteur d'une caisse personnelle en est propriétaire (RBAC §3) quel que soit le périmètre de son affectation ; hors portée : `CASH_ACCOUNT_FORBIDDEN` (D09 §8).

### AV-173 — Courses hors ligne d'une remise — IMPORTANTE
- **Question** : Une réception de remise arrive au serveur après son annulation, une annulation après sa réception, ou deux réceptions de la même remise (deux appareils hors ligne). Que fait le serveur, et comment la Finance régularise-t-elle ?
- **Pourquoi** : ADR-032 §8 tranche le principe (observation, conflit informatif, jamais de rejet pour un état métier, BR-SYN-007), mais ni les sources ni l'ADR ne décrivent la régularisation. Une réception après annulation laisse les deux comptes faux tant que la Finance n'a pas établi les faits (l'argent est revenu à la source dans les livres et a été compté à l'arrivée).
- **Choix** : (a) le fait est conservé comme **observation** dans un conflit informatif appliqué (`CASH_TRANSFER_RECEIVED_AFTER_CANCEL`, `CASH_TRANSFER_CANCEL_AFTER_RECEIVE`, `CASH_TRANSFER_RECEIVED_TWICE` ; propriétaire `FINANCE` ; montant, auteur, appareil, heure, commentaire ou motif, état trouvé), réponse `APPLIED_WITH_WARNINGS` avec le même code, aucun mouvement, remise inchangée ; en ligne, refus (`CASH_TRANSFER_CANCELLED`, `CASH_TRANSFER_ALREADY_RECEIVED`). La Finance régularise par une nouvelle remise (ou par l'écart de session au comptage), puis résout le conflit (`sync.conflict.resolve`, livré en P5-17 : clôture administrative tracée, AV-190) — par une autre personne que l'auteur de la réception ou de l'annulation observée, sinon par la Direction ou l'Admin (AV-192) ; (b) appliquer la réception et compenser l'annulation par un mouvement automatique ; (c) rejeter le second fait.
- **Recommandation** : (a) : aucun mouvement n'est inventé par le serveur ; la décision reste humaine et tracée.
- **Impact** : `finance.cash_transfer.receive`, `.cancel` ; table `decideCashTransferAction` (`packages/domain`) ; matrice des conflits ; `02-synchronisation.md` §3.3. Défaut implémenté : (a). Le pipeline publie aussi l'événement de la commande observée (`finance.cash_transfer.receive` ou `.cancel`) : un consommateur lit l'état de la remise, jamais l'événement seul.

### AV-174 — Décision sur l'écart d'une remise : rejet, retrait, correction, valideur — SECONDAIRE
- **Question** : La Finance peut-elle rejeter l'écart d'une remise, ordonner un recomptage ou corriger une erreur de saisie du montant reçu ? Le récepteur peut-il retirer sa demande ? Qui peut valider ?
- **Pourquoi** : SM-CASH-TRANSFER ne connaît que l'approbation. Le registre est immuable (un `TRANSFER_IN` ne se réécrit pas) ; le pendant pour la caisse (AV-155, AV-159) n'est pas transposé aux remises. Un retrait laisserait la remise en `DISCREPANCY_PENDING` sans décision possible.
- **Choix** : (a) **acceptation seule** : un rejet est refusé (`CASH_TRANSFER_DISCREPANCY_NOT_REJECTABLE`) et le retrait aussi (`CASH_TRANSFER_DISCREPANCY_NOT_WITHDRAWABLE`, garde de retrait d'`approvals`) : la demande reste en attente ; imputation obligatoire (`decisionOption` : `SENDER`, `CARRIER`, `RECEIVER`, `COMPANY` ; `COMPANY` recommandé pour un excédent ; `CARRIER` sans porteur connu : `CASH_TRANSFER_IMPUTATION_INVALID`) ; motif obligatoire (`decisionData.reason`, 200 caractères au plus par la forme des données de décision, alors que `closing_reason` en admet 500) ; valideur ni expéditeur, ni récepteur, ni porteur (`CASH_TRANSFER_VALIDATOR_INVOLVED`, même avec `selfApproved`) ; une erreur de saisie se corrige par une remise de régularisation citée dans le motif, jamais par réécriture ; politique retenue : la plus récente qui exige une validation et nomme un approbateur, sinon `CONTROL_POLICY_MISSING` ; (b) rejet qui ramène la remise à `SENT` pour une nouvelle réception ; (c) recomptage obligatoire au-delà d'un seuil.
- **Recommandation** : (a).
- **Impact** : décision `CASH_TRANSFER_DISCREPANCY` (`finance`), garde de retrait (`approvals`), SM-CASH-TRANSFER, SM-APPROVAL ; migration `20261010092000` (motif exigé à `CLOSED`). Défaut implémenté : (a). La retenue sur la personne imputée relève de P8 (ADR-032 §7).

### AV-175 — Remise perdue en route — IMPORTANTE
- **Question** : Une remise envoyée n'arrive pas du tout (argent perdu ou volé en route) : comment la clôturer ?
- **Pourquoi** : le `CHECK` d'état de P5-03 exigeait une entrée de trésorerie pour `DISCREPANCY_PENDING` et `CLOSED`, alors qu'un mouvement est toujours > 0 et que le schéma de réception admet 0 : une remise perdue n'avait aucune issue correcte. L'annulation rendrait l'argent à la source à tort.
- **Choix** : (a) la Finance enregistre une **réception de 0 XAF** : `DISCREPANCY_PENDING` sans `TRANSFER_IN`, écart = − envoyé, décision `CASH_TRANSFER_DISCREPANCY` ordinaire (imputation au porteur ou à l'expéditeur, par exemple) ; (b) une commande dédiée « déclarer la remise perdue » ; (c) interdire la réception de 0 : la remise reste `SENT` (alerte à 48 h).
- **Recommandation** : (a) : un seul chemin pour tout écart.
- **Impact** : `finance.cash_transfer.receive` ; migration `20261010092000` (`CHECK` d'état : entrée exigée si reçu > 0, absente s'il est nul ; aucune entrée pour une remise annulée). Défaut implémenté : (a).

### AV-176 — Site de numérotation d'une remise entre comptes sans site — SECONDAIRE
- **Question** : Quel site de numérotation (`RMF-{SITE}-AAAA-nnnnnn`) pour une remise entre deux comptes sans site, par exemple la caisse personnelle d'un commercial vers la caisse centrale ?
- **Pourquoi** : AV-077 impose un code de site dans chaque numéro et le compteur exige un site, alors que le dictionnaire déclare le site de la remise facultatif. C'est le flux principal des commerciaux (D09 §14, `CASH_HOLDING_HIGH`).
- **Choix** : (a) site du compte source, à défaut celui du compte destinataire (la remise porte alors ce site), à défaut une **série globale** dont le code est paramétrable (`finance.cash_transfer_series_code`, défaut `SIEGE`, 1 à 10 lettres majuscules ou chiffres, sinon le défaut) ; la remise n'a alors pas de site ; **dans tous les cas le compteur est clé par le code** (identifiant déterministe tiré du seul code, ADR-031), non par l'identifiant du site : un site réel du même code, créé avant ou après les premières remises de la série globale, reprend la même suite, sans doublon ; (b) site d'affectation de l'expéditeur ; (c) un site `BUREAU` désigné comme siège.
- **Recommandation** : (a).
- **Impact** : `finance.cash_transfer.send` ; `organization.system_settings` ; D09 §16. Défaut implémenté : (a).

### AV-177 — Réception sans document : critères de rapprochement, choix de l'expédition, excédent — IMPORTANTE
- **Question** : comment le serveur rapproche-t-il une réception sans document d'une expédition de la même paire (source, destination) : quels critères, quelle expédition choisir s'il y en a plusieurs, que faire si les quantités diffèrent ou dépassent l'expédié, et un produit reçu qui ne figure pas dans l'expédition ?
- **Pourquoi** : SM-TRANSFER dit seulement « même source, destination et produits » et « `RECEIVED` ou `DISCREPANCY_PENDING` selon les quantités » ; BR-STK-021 veut qu'une réception hors ligne supérieure à l'expédié soit appliquée avec `TRANSFER_OVER_RECEIVED`. Un mauvais rapprochement crée une perte en transit à tort ou laisse un transit négatif éternel.
- **Choix** : (a) `SUBSET` — mêmes source et destination ; produits reçus inclus dans les produits expédiés ; quantités égales (exacte), inférieures (partielle : l'écart devient une perte en transit à valider, un produit expédié non déclaré est reçu à 0) ou supérieures (excédentaire : l'excédent est reçu, avertissement et conflit informatif `TRANSFER_OVER_RECEIVED` ; **en ligne, un excédent connu au rapprochement immédiat est refusé** (`TRANSFER_OVER_RECEIVED`, BR-STK-021, comme pour la réception avec document) ; rapproché après coup (arrivée de l'expédition, balayage), l'excédent est un fait déjà appliqué : reçu et signalé) ; préférence à l'exacte, puis à la partielle, puis à l'excédentaire, la plus ancienne d'abord (l'identifiant départage) ; une expédition se rapproche d'une seule réception ; aucune contrainte de date (horloges des appareils, ADR-016) ; un produit reçu absent de l'expédition ne se rapproche jamais automatiquement ; (b) `EXACT` — seulement mêmes produits et mêmes quantités ; (c) addition de plusieurs réceptions partielles pour une même expédition.
- **Recommandation** : (a), réglable par `inventory.blind_receipt_match_mode` (`SUBSET` ou `EXACT`, site puis global, historisé), règle isolée dans `packages/domain/src/stock-transfers.ts`.
- **Impact** : D06 BR-STK-024 ; SM-TRANSFER ; une perte en transit constatée à tort se corrige par la décision `TRANSFER_DISCREPANCY` (marchandise retrouvée). Le rapprochement **manuel** d'une réception dont le produit n'est pas dans l'expédition n'est pas construit : la voie est d'enregistrer l'expédition manquante (qui se rapproche seule) ; une commande de rapprochement manuel se décidera avec les écrans (hors P5). Défaut implémenté : (a).
- **Références** : BR-STK-021, BR-STK-024 ; AV-082 ; ADR-016.

### AV-178 — Réception sans document vers un emplacement partagé ou saisie hors garde — SECONDAIRE
- **Question** : que fait le serveur d'une réception sans document vers un emplacement partagé (`SHARED`), ou saisie par un appareil qui n'est pas celui de la garde ?
- **Pourquoi** : BR-STK-024 réserve la réception sans document aux emplacements exclusifs, mais BR-SYN-007 et INV-SYN-06 interdisent de rejeter un fait accompli hors ligne ; le mode de garde peut changer pendant que l'appareil est hors ligne.
- **Choix** : (a) en ligne : refus `BLIND_RECEIPT_NOT_ALLOWED` (l'utilisateur connecté reçoit avec le document) ; hors ligne : fait appliqué, avertissement et conflit `CUSTODY_DEVICE_MISMATCH` (propriétaire : responsable du stock de la destination), raison `LOCATION_NOT_EXCLUSIVE` pour l'emplacement partagé, ou raison d'appareil de P5-09 (`DEVICE_NOT_DESIGNATED`, `DEVICE_NOT_PRIMARY`, `DEVICE_OTHER_SITE`) ; l'écran bloque le cas ; (b) refus même hors ligne ; (c) accepter sans conflit.
- **Recommandation** : (a). Le refus en ligne et le conflit hors ligne sont structurels (BR-SYN-007) : non paramétrables.
- **Impact** : `inventory.transfer.receive` ; matrice des conflits ; AV-163. Défaut implémenté : (a).
- **Références** : BR-STK-016, BR-STK-024 ; BR-SYN-007 ; AV-163.

### AV-179 — Réception sans document rapprochée après coup : lot et valeur ; produit suivi par lot — IMPORTANTE
- **Question** : une réception sans document enregistrée avant l'expédition l'est sans lot et valorisée au moment de la réception ; faut-il requalifier son lot et sa valeur sur ceux de l'expédition au rapprochement ? Un produit suivi par lot (`REQUIRED`) peut-il être reçu sans document sans lot ?
- **Pourquoi** : INV-STK-13 interdit un mouvement sans lot pour un produit `REQUIRED` ; pour un lot biologique, une quantité laissée sans lot dans `V_TRANSIT` fausse le coût par tête (ADR-027) et empêche la clôture du lot (effectif non vendu non nul). SM-TRANSFER écrit pourtant « aucun nouveau mouvement de réception ».
- **Choix** : (a) aucune requalification : la quantité reste sans lot, des résidus par lot et en valeur restent dans `V_TRANSIT` ; (b) requalification : au rapprochement différé, contre-passation exacte des mouvements de la réception sans document (au coût d'origine) puis réception du transfert au lot et à la valeur de chaque mouvement d'expédition ; la réception rapprochée à son application, ou avec une expédition à plusieurs lots, reçoit elle aussi mouvement par mouvement (transit nul par lot et en valeur) ; en ligne, un produit `REQUIRED` sans lot indiqué (`lotId`, indicatif) et sans expédition à rapprocher est refusé (`LOT_REQUIRED`), hors ligne il est reçu sans lot à titre d'exception documentée (BR-SYN-007) puis requalifié ; (c) interdire la réception sans document pour un produit suivi par lot.
- **Recommandation** : (b). Les mouvements de requalification portent l'heure et l'auteur de la réception ; si la quantité sans lot a été vendue entre-temps, le solde sans lot de la destination peut être provisoirement négatif (fait physique conservé, traçabilité de lot statistique pour cette part). `V_TRANSIT` étant global (un solde par produit et par lot), une valeur résiduelle éventuelle n'est pas attachée à la paire : `verifyTransferTransit` contrôle les quantités par document, non les valeurs.
- **Impact** : `transfer-matching.ts` (`applyDeferredMatch`, `applyTransferReceipt`) ; INV-STK-08, INV-STK-13 ; stratégie stock §6 ; ADR-027. Défaut implémenté : (b).
- **Références** : BR-STK-024, BR-STK-050, BR-STK-056 ; INV-STK-13 ; ADR-027 ; AV-097.

### AV-180 — Retour à la source et réception concurrents ; seconde réception ; retour en double — SECONDAIRE
- **Question** : l'expéditeur déclare hors ligne un retour à la source pendant que le destinataire déclare la réception du même transfert, ou deux réceptions du même transfert, ou deux retours, ou un retour, ou une réception avec document, alors qu'une réception sans document de la paire attend déjà ce transfert : que fait le serveur du second fait ?
- **Pourquoi** : SM-TRANSFER exige « aucune réception » pour un retour, mais deux faits hors ligne peuvent se croiser ; BR-SYN-007 interdit de rejeter un fait, et les appliquer tous deux compterait deux fois la marchandise (INV-STK-03).
- **Choix** : (a) le premier fait appliqué l'emporte ; le second, physiquement contradictoire, est mis en quarantaine hors ligne (résultat `CONFLICT`, aucun effet de stock, conflit non appliqué `TRANSFER_RETURN_CONFLICT` pour une réception après retour, un retour après réception ou un retour dont une réception sans document attend l'expédition ; `TRANSFER_OVER_RECEIVED` pour une seconde réception ou pour une réception avec document d'un transfert qu'une réception sans document attend, raison `BLIND_RECEIPT_PENDING` : sans cette garde, un écart refusé faute de politique laisserait la marchandise comptée deux fois) et refusé en ligne (`TRANSFER_STATUS_INVALID`) ; un retour en double hors ligne est appliqué sans effet ; (b) appliquer les deux et laisser l'inventaire corriger ; (c) la réception l'emporte toujours.
- **Recommandation** : (a). Non paramétrable : appliquer deux faits contradictoires est contraire à l'intégrité du registre (INV-STK-03, INV-STK-04) ; la décision est celle du responsable du stock expéditeur.
- **Impact** : `inventory.transfer.return_to_source`, `inventory.transfer.receive` ; matrice des conflits ; la résolution du conflit (`sync.conflict.resolve`) est livrée en P5-17 (clôture administrative tracée, AV-190 ; visibilité par rôle propriétaire et portée, AV-191). Défaut implémenté : (a). **Point annexe, non tranché (revue adverse P5-16)** : les commandes de transfert (demande, expédition, réception avec ou sans document, annulation, retour à la source) ne contrôlent que la présence de la permission, pas sa portée (`SITE`/`OWN`, RBAC §5.4) sur l'emplacement du transfert, comme tout le module `inventory` hors quotas et frais généraux. Reste à décider, avec un correctif commun à toutes ces commandes : l'extrémité qui fait ressource (source, destination, ou l'une des deux) et la suite hors ligne (rejet `FORBIDDEN_SCOPE`, comme une permission absente, ou acceptation avec conflit, BR-SYN-007). Défaut proposé : portée évaluée sur au moins une des deux extrémités, rejet `FORBIDDEN_SCOPE` même hors ligne. Non implémenté en P5-16 ; repris sous AV-182.
- **Références** : BR-STK-025 ; BR-SYN-007 ; ADR-032 §8.

### AV-181 — Délai de la réception sans document non rapprochée : origine, propriétaire, sortie — SECONDAIRE
- **Question** : à partir de quand compte le délai de 48 h, à qui va le conflit `TRANSFER_UNMATCHED`, l'appareil est-il averti dès l'enregistrement, et comment sort-on d'une réception sans document saisie par erreur ?
- **Pourquoi** : BR-STK-024 dit « après 48 h » sans origine ; la matrice des conflits nomme le MAGASINIER sans dire de quel site ; le catalogue de synchronisation range `TRANSFER_UNMATCHED` parmi les avertissements sans dire quand il est émis. Une réception `UNMATCHED` retient la désactivation des deux emplacements (INV-STK-07).
- **Choix** : (a) le délai court depuis l'`occurred_at` de la réception (heure physique, CM §38) ; paramètre `inventory.transfer_unmatched_hours` (site du document, puis global, repli 48) ; conflit informatif au responsable du stock de l'emplacement expéditeur (magasinier pour un magasin, AV-142), un seul par réception (`unmatched_signalled_at`), clos (`MERGE`, avec la référence du transfert) au rapprochement ; ouverture par la tâche horaire `inventory.transfers.unmatched_sweep`, avec l'événement `StockTransferUnmatched` (alerte en P9) ; dès l'application, l'appareil reçoit l'avertissement `TRANSFER_UNMATCHED` « en attente de rapprochement », sans conflit ; sortie : enregistrer l'expédition manquante (rapprochement automatique) ; l'annulation d'une réception sans document saisie par erreur n'est pas construite ; (b) délai compté depuis la réception par le serveur ; (c) conflit au responsable du site destinataire.
- **Recommandation** : (a). Le délai est paramétrable ; le propriétaire dérive du type de l'emplacement expéditeur (AV-142), non d'un rôle codé en dur.
- **Impact** : `inventory.transfers.unmatched_sweep` ; matrice des conflits ; catalogue d'événements ; D13 `TRANSFER_UNMATCHED`. Défaut implémenté : (a).
- **Références** : BR-STK-024 ; AV-142 ; CM §37, §38, §39.

### AV-182 — Portée des commandes de stock : extrémité qui fait ressource et suite hors ligne — IMPORTANTE
- **Question** : Une commande de stock doit-elle vérifier la **portée** de la permission de son auteur (`SITE`, `OWN`, RBAC §5.4), et pas seulement sa présence ? Pour un transfert, quelle extrémité fait ressource (source, destination, l'une des deux) ? Hors ligne, une commande hors portée est-elle refusée ou appliquée avec un conflit ?
- **Pourquoi** : la revue adverse de P5-16 (10/10/2026) a confirmé que les commandes de transfert (`request`, `dispatch`, `receive` avec ou sans document, `cancel`, `return_to_source`, `move_internal`) et celles de perte, d'inventaire et de consommation ne contrôlent que la présence de la permission ; seuls les quotas et les frais généraux contrôlent la portée. Un magasinier d'un site peut donc agir sur le stock d'un autre site. Le défaut est **préexistant (P2)** et transversal : le corriger pour deux commandes seulement créerait une incohérence. **CONFIRMÉ** (revue de P5-16) pour le constat ; le choix est **À VALIDER**.
- **Choix** : (a) portée évaluée sur au moins une des deux extrémités (source ou destination ; un retour peut être déclaré par le destinataire), refus `FORBIDDEN_SCOPE` en ligne comme hors ligne : un contrôle d'autorisation est un contrôle de sécurité, comme une permission absente (RC-01), et non un état métier (BR-SYN-007) ; (b) portée sur l'extrémité qui agit physiquement (source pour l'expédition et l'annulation, destination pour la réception et le retour) ; (c) hors ligne, fait appliqué avec conflit pour le responsable du stock.
- **Recommandation** : (a).
- **Impact** : toutes les commandes `inventory` hors quotas et frais généraux ; `evaluateAccess` ; tests de portée par commande ; RBAC §5.4. **Défaut implémenté (P5-23)** : (a), par un garde commun (`withStockScope`, `stockScopeAllowed` dans `inventory/application/commands/shared.ts`) sur les transferts (demande, refus, annulation, expédition, réception avec et sans document, retour, mouvement interne), les pertes, les consommations, les inventaires et les seuils ; la ressource est l'emplacement — son site, et son titulaire pour un stock sous garde exclusive (portée `OWN` : stock mobile) ; les emplacements virtuels ne font pas ressource ; test `p5-stock-guards.test.ts`.

### AV-183 — Session de caisse à valider sans politique `CASH_VARIANCE` active — SECONDAIRE
- **Question** : Une session close avec écart (ou un ajustement d'une session validée) doit être validée par la Finance au moyen d'une demande `CASH_VARIANCE`. Que faire si aucune politique `CASH_VARIANCE` n'est active (retirée par un administrateur) au moment de la clôture ?
- **Pourquoi** : `requestApproval` exige une politique ; la politique `CASH_VARIANCE_DEFAULT` est semée, mais elle peut être retirée. La clôture est souvent saisie hors ligne : la refuser pour une configuration contredirait BR-SYN-007 (seules la validité, l'authenticité et l'autorisation rejettent un fait accompli, ADR-032 §8). **DÉDUIT** (P5-13, 10/10/2026).
- **Choix** : (a) clôture appliquée sans demande ; la session reste `PENDING_VALIDATION` et `finance.cash_session.validate` la valide directement, avec les mêmes contrôles (permission `finance.cash_session.validate` sur le site, valideur ni ouvreur ni clôtureur ni auteur de la clôture forcée, motif) ; idem pour un ajustement ; (b) refus `CONTROL_POLICY_MISSING` en ligne, application hors ligne ; (c) refus en ligne comme hors ligne, comme la réception d'une remise avec écart en P5-15.
- **Recommandation** : (a).
- **Impact** : `finance.cash_session.close`, `.force_close`, `.validate` ; réévaluation (`recordCashMovement`). Défaut implémenté : (a). **Harmonisé en P5-23** pour les remises de fonds : la réception d'un écart sans politique `CASH_TRANSFER_DISCREPANCY` active n'est plus refusée (P5-15 refusait `CONTROL_POLICY_MISSING`, y compris hors ligne) ; l'écart attend sans demande (`approval_request_id` vide) et se clôt par `finance.cash_transfer.close_discrepancy` (en ligne, `finance.cash_session.validate` sur le site de la remise), qui est aussi la façade de la décision quand la demande existe, comme `finance.cash_session.validate` ; mêmes contrôles (valideur ni expéditeur, ni récepteur, ni porteur ; imputation ; motif) ; `verifyCashTransfers` admet une remise sans demande. Tests : `finance-cash-transfer-commands.test.ts` (réception sans politique en ligne, hors ligne et avec une politique sans approbation ; clôture directe et ses refus, portée ; façade).

### AV-184 — Encaissement en espèces au PDV sans session : périmètre, grain et résolution de `CASH_SESSION_MISSING` — IMPORTANTE
- **Question** : Quels encaissements exigent une session de caisse ouverte (vente directe, acompte d'une commande, encaissement hors vente ; caisse du PDV ou toute caisse) ? Hors ligne, le constat `CASH_SESSION_MISSING` porte-t-il sur l'encaissement ou sur la vente, et comment se ferme-t-il ?
- **Pourquoi** : BR-DIS-005 et D05 §8 exigent une session pour une vente en espèces ; AV-157 (a) fixe le refus en ligne et le fait appliqué hors ligne, sans préciser le périmètre ni la fermeture du conflit. Une tablette hors ligne peut avoir ouvert sa session sans l'avoir encore synchronisée : la vente arrive alors avant l'ouverture qui la couvre. **DÉDUIT** (P5-14, 10/10/2026).
- **Choix** : (a) exigence limitée aux comptes `CAISSE_PDV` (seuls à avoir des sessions, AV-165), pour les trois chemins d'encaissement, sur l'encaissement `RECORDED` (un doublon suspect n'a pas de mouvement) ; en ligne, refus `CASH_SESSION_REQUIRED` si aucune session `OPEN` ne couvre son heure : refus précoce à la planification (lecture simple), puis **contrôle repris sous le verrou du compte après l'écriture du mouvement** ; si l'index posé par `recordCashMovement` est nul (une clôture concurrente a laissé l'encaissement hors de toute session), refus `CASH_SESSION_REQUIRED` et toute la transaction est annulée ; si une clôture concurrente est datée après l'heure de l'encaissement, l'encaissement reste dans cette session close, qui est réévaluée (ordre sériel « encaissement puis clôture », P5-13) ; hors ligne (fait accompli, BR-SYN-007) : index nul, avertissement et conflit appliqué `CASH_SESSION_MISSING` **par encaissement** (entité `CUSTOMER_PAYMENT`, propriétaire Finance ; détails : compte, montant, heure, appareil, et `saleId` pour une vente, `orderId` pour un acompte, aucun document pour un encaissement hors vente) ; le conflit n'est ouvert que hors ligne ; décision `PAYMENT_DUPLICATE` approuvée (doublon suspect accepté par la Finance) : elle écrit le mouvement et recopie son index de session sur l'encaissement ; elle n'est soumise à aucune session : sans session couvrante, index nul, ni refus ni constat (même traitement qu'AV-186) ; résolution d'office (`MERGE`, référence de la session) par `finance.cash_session.open`, à la création seulement (jamais une fusion) : les conflits ouverts `CASH_SESSION_MISSING` des encaissements de la caisse dont le mouvement est sans index et daté à l'heure d'ouverture ou après sont résolus, sans réécrire l'index et sans borne haute ; si la session est ensuite close à une heure antérieure à l'encaissement, le conflit n'est pas rouvert : le signal est alors le refus `CASH_SESSION_CLOSE_BEFORE_LAST_MOVEMENT` d'une clôture en ligne ou le conflit `CASH_SESSION_CLOSE_BEFORE_MOVEMENTS` d'une clôture hors ligne (AV-171) ; un encaissement couvert par une session close n'est pas « sans session » (réévaluation) ; (b) un conflit par vente ; (c) aucune résolution automatique : la Finance ferme chaque conflit.
- **Recommandation** : (a).
- **Impact** : `sales.sale.record`, `sales.order.place` (acomptes), `sales.payment.record`, décision `PAYMENT_DUPLICATE` ; `finance.cash_session.open` (résolution) ; matrice des conflits ; D05 §15. Défaut implémenté : (a) (P5-14, complété par la revue adverse du 10/10/2026 : contrôle sous verrou, index recopié à l'approbation d'un doublon). La résolution manuelle des conflits restants (`sync.conflict.resolve`) est livrée en P5-17 (clôture administrative tracée, AV-190 ; `CASH_SESSION_MISSING` est un conflit appliqué, informatif : `resolve` ou `dismiss`).

### AV-185 — Annulation directe : sens de « session de caisse de la vente encore ouverte » (BR-VEN-028) — SECONDAIRE
- **Question** : Quelle session faut-il regarder, et à quel instant, pour décider qu'une annulation directe est permise ? Que faire d'une vente sans espèces, ou dont l'encaissement n'a pas de session ?
- **Pourquoi** : AV-030 a tranché « si sa caisse est ouverte » ; une vente peut avoir plusieurs encaissements, aucun en espèces, ou un encaissement hors session (AV-184). Hors ligne, la session peut être close par une autre tablette entre la vente et l'annulation. **DÉDUIT** (P5-14, 10/10/2026).
- **Choix** : (a) vendeur de la vente, dans le délai `sales.direct_cancel_minutes`, **et** chaque encaissement `RECORDED` ou `CANCELLATION_REQUESTED` (affectation `ACTIVE`) de la vente sur une caisse de PDV appartient à une session qui couvre à la fois l'heure de l'encaissement et l'heure de l'annulation (ouverte au plus tard à l'`occurred_at` de l'annulation et pas encore close à cet instant) ; aucun encaissement en espèces au PDV : condition remplie ; encaissement sans session : condition non remplie ; sinon l'annulation devient une demande `SALE_CANCELLATION` (avertissement `CANCEL_SESSION_CLOSED`), en ligne comme hors ligne ; (b) évaluation à la réception par le serveur ; (c) condition ignorée, délai seul.
- **Recommandation** : (a) : l'heure de l'annulation est celle du geste ; une annulation hors ligne faite avant la clôture reste directe, et son remboursement, daté de l'annulation, réévalue la session close.
- **Impact** : `sales.sale.cancel` ; SM-SALE ; D04 §7 (BR-VEN-028) et §15. Défaut implémenté : (a) (P5-14, complété par la revue adverse du 10/10/2026 : encaissements en demande d'annulation inclus, session ouverte à l'heure de l'annulation). Course avec une clôture concurrente : AV-221 (P5-22, condition relue sous verrou). L'annulation ne se fie pas à `sales_sales.cash_session_id` (posé seulement par `sales.sale.record`, nul pour une vente issue d'une commande ou réglée après coup) : elle lit les affectations. **Limite connue** : la condition est lue sans verrou ; une clôture concurrente validée pendant l'annulation peut laisser passer une annulation directe dont le remboursement tombe hors session (course de quelques millisecondes, registre juste). Verrouillage et test de concurrence prévus en P5-22 : verrouiller les comptes plus tôt inverserait l'ordre des verrous de D04 §15 et risquerait des interblocages.

### AV-186 — Remboursement en espèces sans session de caisse ouverte — SECONDAIRE
- **Question** : Un remboursement en espèces (`sales.payment.refund` par la Finance, part payée d'une vente annulée sur décision) peut être décidé quand aucune session n'est ouverte sur la caisse du PDV. Faut-il le refuser, ou le signaler ?
- **Pourquoi** : la décision d'une demande d'annulation arrive souvent après la clôture ; un gestionnaire de décision ne peut pas échouer pour un état de la caisse sans bloquer la décision. AV-157 (a) date le remboursement de sa propre date. **DÉDUIT** (P5-14, 10/10/2026).
- **Choix** : (a) jamais refusé ni signalé : mouvement daté de sa propre date, rattaché à la session qui la couvre s'il y en a une, sinon sans index ; l'écart éventuel se voit à l'ouverture suivante (fonds compté face au registre) ; (b) refus `CASH_SESSION_REQUIRED` en ligne ; (c) conflit `CASH_SESSION_MISSING` comme pour un encaissement.
- **Recommandation** : (a).
- **Impact** : `sales.payment.refund`, décision `SALE_CANCELLATION` ; D09 §15. Défaut implémenté : (a) (P5-14).

### AV-187 — Sous-totaux par vendeur d'une session : contenu et attribution — SECONDAIRE
- **Question** : Que contiennent les sous-totaux « par vendeur » d'une session (AV-155) : encaissements bruts ou nets de leurs annulations ? À qui attribuer les remboursements, remises et dépenses ?
- **Pourquoi** : ADR-032 et AV-155 demandent un sous-total des espèces encaissées par vendeur (`received_by_user_id`) pour l'enquête sur un écart, sans en fixer la forme. Seuls les encaissements portent un vendeur ; le registre porte les autres flux. **DÉDUIT** (P5-14, 10/10/2026).
- **Choix** : (a) par fenêtre de la session, encaissements nets de leurs inverses rapportés à celui qui les a reçus, triés par montant décroissant ; les autres flux agrégés par type et sens, sans vendeur ; total des flux et attendu courant ; (b) attribuer aussi les remboursements à l'auteur ; (c) sous-totaux bruts.
- **Recommandation** : (a).
- **Impact** : lecture d'une session (`GET /cash-sessions/{id}`, livrée en P5-17 : champ `flows`) ; ECR-FIN-05 ; `sellerCashSubtotals` (`packages/domain`), `cashSessionSellerSubtotals` (`apps/server/src/finance-api/`, lecture composée exposée en P5-17 par `GET /cash-sessions/{id}` : `window`, `sellers`, `unattributedReceivedXaf`, `otherMovements`, `netFlowsXaf`, `expectedNowXaf`). Défaut implémenté : (a) (P5-14).

### AV-188 — Annulation de l'encaissement qui règle une vente anonyme saisie en ligne — SECONDAIRE
- **Question** : L'annulation approuvée d'un encaissement (`sales.payment.request_cancellation`, décision `PAYMENT_CANCELLATION`) qui réglait une vente anonyme (sans client) saisie en ligne laisse la vente due, sans client à qui réclamer le solde. Faut-il la refuser, l'autoriser en signalant la vente, ou la laisser ainsi ?
- **Pourquoi** : trou préexistant de P4-08, révélé par les tests de P5-14 : le balayage d'INV-VEN-07 (« une vente sans client saisie en ligne est soldée », `sales-finance-invariants.test.ts`) interdit cet état, que la décision approuvée produit pourtant. **CONFIRMÉ** pour le constat (P5-14, 10/10/2026) ; le choix est **À VALIDER**.
- **Choix** : (a) refuser la demande d'annulation de l'encaissement (code à créer, par ex. `PAYMENT_ANONYMOUS_SALE`) tant qu'une vente anonyme saisie en ligne perdrait son règlement : annuler la vente, ou remplacer l'encaissement ; (b) l'autoriser et signaler la vente (drapeau et conflit `ANONYMOUS_UNPAID` pour la Finance), INV-VEN-07 excluant les ventes signalées ; (c) inchangé.
- **Recommandation** : (a).
- **Impact** : `sales.payment.request_cancellation`, décision `PAYMENT_CANCELLATION`, INV-VEN-07. **Défaut implémenté en P5-23 : (a)** — refus `PAYMENT_ANONYMOUS_SALE` à la demande, et à la décision (demande antérieure au contrôle, ou vente devenue concernée depuis), tant qu'une affectation active de l'encaissement règle une vente sans client, saisie en ligne et non annulée ; une vente anonyme saisie hors ligne reste hors de la règle (INV-VEN-07 ne la vise pas). Pour annuler l'encaissement : annuler la vente d'abord. Tests : `sales-cash-session.test.ts` (« AV-188 »), dont les scènes qui annulaient l'encaissement d'une vente anonyme passent désormais par une vente à un client.

### AV-189 — Droits de lecture des ressources de P5 : quotas, sessions de caisse, remises de fonds, structure, file des conflits — SECONDAIRE
- **Question** : Quelle permission ouvre la lecture des quotas d'appareil, des sessions de caisse, des remises de fonds, des sites, emplacements et points de vente, et de la file des conflits ? La matrice RBAC n'a aucune permission de lecture propre à ces ressources.
- **Pourquoi** : le backlog de P5 (P5-17) expose ces lectures sans que la matrice (`docs/07-security-rbac/01-rbac.md` §5) en ait prévu de dédiées ; en créer exige le seed, la matrice et les tests de seed, et touche aux droits de rôles déjà arrêtés. **DÉDUIT** (P5-17, 11/10/2026).
- **Choix** : (a) réutiliser les droits semés : `inventory.stock.read` pour les quotas (ancrés sur l'emplacement, plus « mes quotas » pour le détenteur, qui voit toujours son propre quota), `finance.cash.read` pour les sessions et les remises (comme `GET /cash-accounts` ; portée du **compte** : une session est visible si sa caisse l'est, une remise si l'un de ses deux comptes l'est), `org.structure.read` pour les sites, emplacements et points de vente (portée du site et de sa zone), `sync.conflict.resolve` pour la file des conflits (`sync.monitor.read` n'est détenu ni par la Finance ni par le Resp. achats) ; (b) créer des permissions de lecture dédiées (seed, matrice RBAC, tests de seed) ; (c) réutiliser les permissions d'écriture correspondantes.
- **Recommandation** : (a) : aucun droit n'est créé ni élargi ; une permission dédiée reste possible plus tard sans changer les routes (chaque contrôleur ne porte qu'une constante de permission).
- **Impact** : `GET /sites`, `/locations`, `/points-of-sale`, `/allocations(/{id})`, `/cash-sessions(/{id})`, `/cash-transfers(/{id})`, `/sync/conflicts(/{id})` ; RBAC §5. **Conséquences à signaler** : le Resp. commercial, qui détient `finance.cash_transfer.record` (portée `OWN`) mais pas `finance.cash.read`, ne relit pas les remises qu'il envoie ; un vendeur lit la session de son site avec les sous-totaux de ses collègues (même caisse) ; le magasinier ne lit pas les sessions de caisse. Défaut implémenté : (a) (P5-17).

### AV-190 — Sens d'une résolution manuelle de conflit — IMPORTANTE
- **Question** : Que fait `sync.conflict.resolve` : clôture-t-elle seulement le conflit avec une trace, rejoue-t-elle la commande mise en quarantaine, ou crée-t-elle des documents de régularisation ? Que signifie `sync.conflict.dismiss` ?
- **Pourquoi** : BR-SYN-017 exige que toute résolution soit tracée (décision, auteur, motif, effets compensatoires éventuels) et SM-CONFLICT, comme le dictionnaire de `sync.sync_conflicts`, nomment les résolutions `ACCEPT_CLIENT`, `KEEP_SERVER`, `MERGE`, `COMPENSATE` sans dire si le serveur les exécute. Rejouer une commande en quarantaine ou créer un document à la place d'une personne touche au registre (argent, stock) et dépend de chaque type de conflit. **DÉDUIT** (P5-17, 11/10/2026) ; le choix est **À VALIDER**.
- **Choix** : (a) **clôture administrative tracée** : le conflit passe `RESOLVED` (avec la résolution `ACCEPT_CLIENT`, `KEEP_SERVER`, `MERGE` ou `COMPENSATE`) ou `DISMISSED` (sans résolution), avec l'auteur, l'heure de la décision (`occurred_at` de la commande), le motif (obligatoire, 1 000 caractères au plus) et les références des documents de régularisation (`refs`, 20 identifiants au plus, enregistrées dans `resolution_refs`) ; le serveur ne rejoue aucune commande et ne crée aucun document : la régularisation passe par les commandes ordinaires de chaque module, dont la personne cite les documents. Refus : `ONLINE_REQUIRED` hors ligne ; `NOT_FOUND` ; `FORBIDDEN_SCOPE` hors rôle propriétaire ou hors portée (AV-191) ; `CONFLICT_ALREADY_CLOSED` ; `CONFLICT_MANAGED_ELSEWHERE` pour `PAYMENT_REFERENCE_DUPLICATE` (clos par la décision `PAYMENT_DUPLICATE`) ; `dismiss` d'une quarantaine (commande non appliquée) : `CONFLICT_NOT_INFORMATIVE` ; `resolve` d'une quarantaine avec `ACCEPT_CLIENT` ou `MERGE` : `CONFLICT_REPLAY_NOT_SUPPORTED` ; `COMPENSATE` sans `refs` : `CONFLICT_REFS_REQUIRED` ; `ALLOCATION_OVERCOMMITTED` et `STOCK_NEGATIVE` tant que l'anomalie persiste (jamais corrigé en silence, matrice des conflits ; BR-STK-018 : le solde négatif est une anomalie à résoudre ; régulariser d'abord par l'inventaire, la révocation ou la libération de quotas) : `CONFLICT_CONDITION_PERSISTS` ; signal sur un fait appliqué clos par l'auteur de ce fait : `CONFLICT_SELF_RESOLUTION_FORBIDDEN` (AV-192) ; (b) rejouer la commande en quarantaine (`ACCEPT_CLIENT` : application avec l'état courant, SM-SYNC-COMMAND `CONFLICT → APPLIED`) et créer côté serveur les documents compensatoires ; (c) clôture libre, sans contrôle de la résolution ni des références.
- **Recommandation** : (a) : aucun mouvement ni document n'est inventé par le serveur (même principe qu'AV-173) ; (b) reste possible plus tard, type par type, la charge utile de la commande étant conservée dans `details.payload` pour `VERSION_CONFLICT`, `TRANSFER_*` et `INCUBATION_*`.
- **Impact** : commandes `sync.conflict.resolve` et `sync.conflict.dismiss` (agrégat `SYNC_CONFLICT`, permission `sync.conflict.resolve`) ; événement `SyncConflictResolved` ; SM-CONFLICT ; SM-SYNC-COMMAND (la ligne `CONFLICT → APPLIED/REJECTED` n'est pas implémentée : une commande en quarantaine reste `CONFLICT` dans l'inbox) ; D14 UC-SYN-07 ; matrice des conflits §3 ; `inventory` : `isAllocationOvercommitted`, `hasNegativeStock` (API publique). Les conflits renvoyés à P5-17 par AV-173 (remises), AV-180 (retour à la source, réception) et AV-184 (`CASH_SESSION_MISSING` restants) se traitent ainsi. Défaut implémenté : (a) (P5-17). Non paramétrable : règle de contrôle, non un seuil (règle 8 du CLAUDE.md) ; un autre choix se change en un seul endroit du code (`apps/server/src/sync/`).
- **Références** : BR-SYN-007, BR-SYN-017 ; AV-173, AV-180, AV-184.

### AV-191 — Qui voit et traite un conflit — SECONDAIRE
- **Question** : Quels conflits la file (`GET /sync/conflicts`) montre-t-elle à un utilisateur, et qui peut les clore par `sync.conflict.resolve` ou `.dismiss` : ceux de son rôle, ceux de son périmètre, ou les deux ?
- **Pourquoi** : la matrice des conflits attribue chaque type à un rôle propriétaire (`owner_role`, BR-SYN-017) ; la permission `sync.conflict.resolve` a une portée (`ALL`, `SITE`, `TEAM`, RBAC §5.1) mais ne dit pas quel rôle traite quel conflit ; le catalogue des rôles de l'accueil (`home-api/role-catalog.ts`, `conflictRoles`) l'exprime déjà pour le compteur de conflits de l'accueil. **DÉDUIT** (P5-17, 11/10/2026).
- **Choix** : (a) rôle propriétaire, puis portée : le `owner_role` du conflit fait partie des rôles dont l'utilisateur traite les conflits (`conflictRoles` : Direction et Admin tous ; Finance `FINANCE` ; magasinier `MAGASINIER` ; Resp. ferme `RESP_FERME` ; Resp. commercial `RESP_COMMERCIAL` ; Resp. production `RESP_PRODUCTION` ; Resp. achats `RESP_ACHATS` ; vendeur et commerciaux aucun), puis la portée de `sync.conflict.resolve` s'évalue sur le site du conflit et l'auteur de la commande qui l'a produit (`ALL` tout, `SITE` le site, `TEAM` les commandes de l'équipe) ; (b) portée seule, sans rôle propriétaire ; (c) rôle propriétaire seul.
- **Recommandation** : (a). Précisions de la revue adverse (11/10/2026) : la portée s'évalue sur les **seules affectations des rôles qui traitent ce rôle propriétaire** — un rôle cumulé n'étend jamais le périmètre d'un autre (Resp. achats `ALL` et magasinier d'un site ne traitent pas les conflits de magasin d'un autre site ; `evaluateAccess` restreint aux rôles, `roleCodes`) ; un conflit système (sans auteur) prend pour titulaire le détenteur de l'emplacement en cause s'il en a un (`details.fromLocationId` ou `locationId`, stock mobile). **À signaler** : `TITULAIRE` (conflits de version d'un compte client) n'est lu que par la Direction et l'Admin ; un conflit sans site ni titulaire n'est visible qu'en portée `ALL` ; en portée `TEAM`, le Resp. commercial ne traite que les conflits `RESP_COMMERCIAL` produits par son équipe (ou sur le stock mobile d'un membre) — ceux d'un vendeur de PDV hors équipe (`PRICE_MISMATCH`) ou d'un magasinier (`ORDER_OVER_FULFILMENT`) reviennent à la Direction ; option : porter `sync.conflict.resolve` du Resp. commercial à `ALL` (le filtre de rôle propriétaire le borne déjà aux conflits `RESP_COMMERCIAL`). Le compteur de conflits de l'accueil (`openConflictSummary`, par rôle propriétaire seulement) compte aussi les conflits d'autres sites, que la file n'ouvre pas : à aligner en P5-20 (accueil enrichi). Les conflits de stock d'un point de vente ont pour propriétaire `MAGASINIER` (`stockOwnerRole` : tout site hors ferme) ; un PDV sans magasinier affecté voit les siens traités par la Direction ou l'Admin. Une page de la file peut être plus courte que `limit` (visibilité évaluée après la lecture) : suivre `next_cursor` jusqu'à `null`. Les commandes distinguent un conflit inconnu (`NOT_FOUND`) d'un conflit hors visibilité (`FORBIDDEN_SCOPE`) : leur auteur détient déjà `sync.conflict.resolve` ; la lecture, elle, rend le même 404 audité (RC-07).
- **Impact** : `GET /sync/conflicts(/{id})`, `sync.conflict.resolve`, `sync.conflict.dismiss` (`apps/server/src/sync/conflict-access.ts`) ; `evaluateAccess` (paramètre `roleCodes`, `identity`) ; matrice des conflits §3. Défaut implémenté : (a) (P5-17). Non paramétrable : règle de contrôle, non un seuil (règle 8 du CLAUDE.md) ; un autre choix se change en un seul endroit du code (`apps/server/src/sync/`).

### AV-192 — Clôture d'un conflit par l'auteur du fait qu'il signale — SECONDAIRE
- **Question** : L'auteur de l'opération qui a produit un conflit peut-il le clore lui-même (`sync.conflict.resolve`, `.dismiss`) ?
- **Pourquoi** : un conflit informatif signale souvent une anomalie de la personne qui a saisi le fait (caisse rendue négative, quota dépassé, garde d'appareil contournée) ; le laisser écarter par cette personne viderait le signal de son sens, alors que le projet sépare ailleurs le déclarant du valideur (AV-010, `SELF_APPROVAL_FORBIDDEN`, `CASH_VALIDATOR_INVOLVED`). Relevé par la revue adverse de P5-17 (11/10/2026). **DÉDUIT** ; le choix est **À VALIDER**.
- **Choix** : (a) refus `CONFLICT_SELF_RESOLUTION_FORBIDDEN` quand le conflit porte sur un fait **appliqué** dont l'utilisateur est l'auteur (inbox) ; la quarantaine de sa propre commande (rien d'appliqué, ex. une augmentation de quota sur une version périmée) peut être close par son auteur ; la Direction et l'Admin traitent les conflits des autres ; (b) refus pour tout conflit, quarantaine comprise ; (c) liste paramétrée des types concernés (`organization.system_settings`).
- **Recommandation** : (a) : la séparation des tâches porte sur les signaux, sans bloquer la correction de sa propre saisie restée sans effet.
- **Impact** : `sync.conflict.resolve`, `sync.conflict.dismiss` (`apps/server/src/sync/conflict-commands.ts`) ; SM-CONFLICT. Défaut implémenté : (a) (P5-17). Non paramétrable : règle de contrôle, non un seuil (règle 8 du CLAUDE.md) ; un autre choix se change en un seul endroit du code (`apps/server/src/sync/`).

### AV-193 — Ce que les jeux `allocations` et `cash` gardent d'un quota, d'une session ou d'une remise terminés — SECONDAIRE
- **Question** : Un quota terminé (libéré `CLOSED`, révoqué `REVOKED`), une session de caisse clôturée ou validée, une remise de fonds reçue, close ou annulée restent-ils sur l'appareil ?
- **Pourquoi** : les dictionnaires disent « DL (les quotas de l'appareil) », « DL (session ouverte du PDV) » et « DL (en cours) » (`06-inventory.md`, `09-finance.md`) sans règle de sortie ; le catalogue des jeux (01-architecture-offline.md §3.1) non plus. L'appareil qui clôture une session doit pourtant connaître l'attendu recalculé et l'écart (D05 §12 : l'appareil calcule un attendu indicatif, le serveur recalcule). **DÉDUIT** (P5-18, 11/10/2026).
- **Choix** : (a) quota servi tant qu'il est `ACTIVE` (signal `revocation_pending` compris), sortie du jeu (`SCOPE_EXIT`) à la libération ou à la révocation ; session servie `OPEN` puis `PENDING_VALIDATION` (l'appareil y lit l'attendu, le compté et l'écart du serveur), sortie à `VALIDATED` — une session à valider est republiée à chaque réévaluation par le delta (P5-13) avec l'attendu et l'écart **courants** (`current_expected_xaf`, `current_variance_xaf` : valeurs de clôture, jamais réécrites, plus les deltas des ajustements) ; remise servie `SENT` et `DISCREPANCY_PENDING`, sortie à `RECEIVED`, `CLOSED` et `CANCELLED` (le solde des comptes suit par `CASH_ACCOUNT`), et, quand un compte change de responsable, sortie vers l'ancien et publication au nouveau (revue de P5-18) ; (b) lecture stricte : session `OPEN` seulement, remise `SENT` seulement ; (c) états terminaux conservés (`UPSERT`) avec purge locale.
- **Recommandation** : (a). **À signaler** : un quota épuisé reste `ACTIVE` jusqu'à sa libération (AV-166) et reste donc sur l'appareil ; l'appareil retire aujourd'hui l'entité sans attendre une commande en attente qui la référence (02-synchronisation.md §5.3, « sauf si une commande en attente le référence ») : garde à coder avec les écrans ; une sortie de périmètre est toujours écrite **avant** les mises à jour de la même opération (l'appareil retire la clé quelle que soit la portée, revue de P5-18 ; corrigé aussi pour l'ancien responsable d'un compte, P4-11) ; curseur du pull : AV-198.
- **Impact** : `allocationChange` (`inventory/application/sync-changes.ts`), `emitCashSessionChange` et `emitCashTransferChange` (`finance/application/sync-changes.ts`), projections `STOCK_ALLOCATION`, `CASH_SESSION`, `CASH_TRANSFER` (`apps/server/src/sync/entity-projections.ts`). Défaut implémenté : (a) (P5-18). Non paramétrable : règle de publication, non un seuil (règle 8 du CLAUDE.md).

### AV-194 — Quotas d'une tablette partagée : cloisonnement par utilisateur — SECONDAIRE
- **Question** : Sur une tablette partagée (AV-007), un utilisateur reçoit-il les quotas des autres utilisateurs de la même tablette ?
- **Pourquoi** : un quota est un couple (utilisateur, appareil) (INV-STK-11) ; le jeu `allocations` a la portée `DEVICE` (01-architecture-offline.md §3.1), alors que les jeux personnels sont « cloisonnés par utilisateur » ; le lecteur de projection ne connaît que la portée de la ligne, pas l'utilisateur authentifié. **DÉDUIT** (P5-18).
- **Choix** : (a) ligne au périmètre de l'appareil détenteur, détenteur projeté (`holder_user_id`) : la tablette reçoit les quotas de tous ses utilisateurs (quantités seulement, ni montant ni coût) et n'applique que ceux de l'utilisateur connecté ; (b) ligne `USER` du détenteur au lieu de `DEVICE` : ses quotas atteindraient tous ses appareils, alors qu'un quota ne vaut que sur l'appareil détenteur ; (c) ligne `DEVICE` et filtre du serveur par utilisateur authentifié (contrat des projections modifié).
- **Recommandation** : (a). La garde du serveur reste la référence : consommation par couple, `ALLOCATION_NOT_HOLDER` à la libération. **À signaler** : environ 0,7 Ko par quota actif (mesuré, P5-18) ; l'estimation « < 10 Ko » du jeu tient jusqu'à environ 14 quotas actifs sur l'appareil, **tous utilisateurs de la tablette confondus** (3 vendeurs × 8 produits ≈ 16 Ko : sans gêne fonctionnelle, aucune source ne borne le nombre de quotas).
- **Impact** : projection `STOCK_ALLOCATION` ; écrans de la PWA (hors P5). Défaut implémenté : (a) (P5-18). Non paramétrable.

### AV-195 — Configuration du PDV hors ligne et changement d'appareil désigné — SECONDAIRE
- **Question** : Dans quel jeu et à qui publier la configuration du PDV (mode de garde, appareil désigné), et que reçoit l'ancien appareil quand l'appareil désigné change ?
- **Pourquoi** : le plan (P5-18) demande « `org` complété (`POINT_OF_SALE`, mode de garde), `SCOPE_EXIT` au changement d'appareil désigné » ; le dictionnaire dit « Offline DL (son PDV) ». Or les autres entités de l'organisation sont publiées par le repli générique du pipeline (jeux `site`, `zone`, `location`, `team`, lignes `GLOBAL`), que la PWA liste (`KNOWN_DATASETS`) ; `organization.pos.configure`, dont l'agrégat est le site, modifiait l'emplacement de vente sans le publier ; enfin le périmètre d'un appareil se calcule sur les affectations de l'utilisateur, pas sur la désignation de l'appareil (`device-scope.ts`) : l'ancien appareil d'un PDV reste en général dans le périmètre du site. **DÉDUIT** (P5-18).
- **Choix** : (a) `POINT_OF_SALE` dans le jeu `org`, ligne `SITE` du PDV (clé = le site), et emplacement de vente republié (`LOCATION`, jeu du repli `location`, ligne `GLOBAL`) à chaque configuration ; le changement d'appareil désigné se propage par cette mise à jour : l'ancien appareil apprend qu'il n'est plus désigné (ses décisions locales, `decideLocalConsumption`, refusent alors la vente exclusive), sans sortie de périmètre ; (b) en plus, ligne `DEVICE` de l'appareil désigné et `SCOPE_EXIT` vers l'ancien : la PWA retire l'entité quelle que soit la portée de la ligne, l'ancien appareil perdrait la configuration tout en restant dans le périmètre du site ; (c) regrouper dès maintenant toute l'organisation dans `org` (liste des jeux de la PWA et curseurs à migrer : écrans).
- **Recommandation** : (a). **À signaler** (P5-23) : (1) `pos.configure` ne ferme ni ne révoque les quotas actifs de l'ancien appareil, ni ceux d'un emplacement qui passe en `EXCLUSIVE_DEVICE` (ils restent `ACTIVE` ; INV-STK-19 n'en souffre pas) : révoquer d'office au passage en garde exclusive, ou refuser la configuration tant qu'un quota est actif ; (2) une vente de l'ancien appareil faite avant le changement mais synchronisée après produit un faux `CUSTODY_DEVICE_MISMATCH` (`custodyMismatch` lit l'état courant, sans historique des désignations) ; (3) `identity.device.designate` (`is_shared`, `designated_site_id`) n'est pas publié (la projection `DEVICE` ne les porte pas).
- **Impact** : `organization/application/sync-changes.ts` (`emitPointOfSaleChange`), `pos-commands.ts`, projection `POINT_OF_SALE` ; P5-23. Défaut implémenté : (a) (P5-18). Non paramétrable.
- **Suites traitées en P5-23** : (1) refus `POS_ALLOCATIONS_ACTIVE` du passage en garde exclusive tant qu'un quota est actif (AV-230, INV-DIS-02 ; registre `PosConfigurationGuardRegistry`, garde d'`inventory` ; l'octroi relit la garde sous verrou) ; (3) fiche de l'appareil publiée à lui seul (`emitDeviceChange`, jeu `device`, portée `DEVICE`, avec `is_shared` et `designated_site_id` ; seed republié ; la ligne `GLOBAL` du repli n'est plus servie). (2) faux `CUSTODY_DEVICE_MISMATCH` d'un fait antérieur au changement : historique des gardes (`organization_location_custody_periods`), fait hors ligne jugé sur la garde en vigueur à sa date, partage compris ([ADR-040](decisions/ADR-040-garde-jugee-a-la-date-du-fait.md), INV-DIS-03) ; même défaut pour `DEVICE_OTHER_SITE` : AV-243.

### AV-196 — Jeux et publication des référentiels de vente (suite d'ADR-031) — SECONDAIRE
- **Question** : Dans quels jeux publier les unités, canaux, motifs, étapes, sources, paramètres visibles et politiques ; comment publier les lignes semées ; comment retirer une version remplacée ?
- **Pourquoi** : ADR-031 (« Conséquences ») laissait ces référentiels hors du flux. Le catalogue des jeux (01-architecture-offline.md §3.1) place unités, motifs, canaux, sources et étapes dans `catalog`, les paramètres visibles dans `me` (filtre « Utilisateur ») et les politiques actives dans `policies`. Le repli générique écrit des jeux `unit`, `reason_code`, `setting`, `control_policy`, avec, pour les unités et les canaux, un `aggregate_id` sans rapport avec le code ; le seed écrit ses tables sans le pipeline, donc rien n'était publié (hors moyens de paiement) ; un paramètre a une portée `GLOBAL`, `SITE`, `ZONE` ou `ROLE`, que le flux ne sait pas cibler pour un rôle ; `approvals.policy.set` retirait l'ancienne version sans ligne de flux ; la purge du flux à 60 jours (BR-SYN-015) n'est pas codée. **DÉDUIT** (P5-18).
- **Choix** : (a) jeu `catalog` : `UNIT` et `SALES_CHANNEL` sous la clé dérivée de leur code (ADR-031), `REASON_CODE`, `PIPELINE_STEP` et `LEAD_SOURCE` à leur identifiant ; jeu `me` : `SETTING`, chaque version visible, ligne `GLOBAL` quelle que soit sa portée (la portée est dans la donnée ; l'appareil retient la valeur qui le concerne, BR-ADM-016), les versions visibles antérieures de la même clé et de la même portée retirées (`DELETE`) ; jeu `policies` : `CONTROL_POLICY`, version active publiée et version retirée supprimée (`DELETE`) ; le seed publie de façon idempotente les lignes semées (versions en vigueur des paramètres, politiques actives, emplacements virtuels compris ; `db/seeds/publish-references.ts`) ; (b) paramètres à leur portée (lignes `SITE`, `ZONE`, et `USER` par titulaire pour un rôle) : un site ne reçoit pas la valeur de sa zone, et un changement d'affectation n'est pas suivi ; (c) référentiels servis en ligne seulement.
- **Recommandation** : (a). **À signaler** : (1) la future purge du flux (BR-SYN-015) effacera les lignes publiées une seule fois par le seed : il faudra alors l'instantané du chargement initial (02-synchronisation.md §5.4) ou une republication périodique ; (2) les paramètres visibles propres à un site ou à une zone atteignent tous les appareils (valeurs destinées aux clients, sans secret) ; (3) produits, catégories, conditionnements et règles de prix restent sur les jeux du repli (`product`, …), hors P5-18 ; (4) défaut corrigé : `catalog.unit.deactivate`, `.reactivate` et leurs équivalents `catalog.sales_channel.*` lisaient le code dans l'`aggregate_id` (un UUIDv7 imposé par le contrat, jamais un code) et répondaient toujours `NOT_FOUND` : le code est désormais dans la charge utile (`code`), changement sans effet sur un client, aucun ne les envoyant ; la désactivation devenant possible, les canaux que le serveur déduit lui-même (`POINT_DE_VENTE`, `TERRAIN`, `SEDENTAIRE`, `DIRECT`, AV-018) sont refusés (`SYSTEM_REFERENCE`, dictionnaire `is_system` ; liste `SYSTEM_SALES_CHANNEL_CODES` de l'API publique de `catalog`, la table n'ayant pas la colonne) ; (5) les sources de prospects n'ont pas de commande d'administration (seed seul) ; `catalog.reason_code.set` ne fait que créer ; (6) les jeux du repli `setting` et `control_policy` restent servis (les projections `SETTING` et `CONTROL_POLICY` ne distinguent pas la ligne du repli de celle de `me` ou de `policies`) et ne reçoivent aucun retrait : un appareil qui les tire (la PWA, `KNOWN_DATASETS`, et le harnais `sync-harness.ts`) garde les versions remplacées ou retirées ; à abandonner quand la PWA passera à `me` et `policies` (écrans) ; (7) une version de paramètre antidatée sous une version plus récente n'est pas publiée (elle n'est pas en vigueur), et le seed retire les versions visibles que remplace une révision (`SYSTEM_SETTING_REVISIONS`) ; (8) les emplacements « à livrer », créés à la première confirmation de commande, ne sont pas publiés (le seed ne publie que les virtuels globaux).
- **Impact** : `sync-changes.ts` de `catalog`, `crm` et `organization`, `approvals/application/policy-changes.ts`, commandes `reference-commands.ts`, `pipeline-commands.ts`, `setting-commands.ts`, `policy-commands.ts`, projections `UNIT`, `SALES_CHANNEL`, `PIPELINE_STEP`, `LEAD_SOURCE`, seed. Défaut implémenté : (a) (P5-18). Non paramétrable.

### AV-197 — Comptes destinataires d'une remise de fonds hors ligne — SECONDAIRE
- **Question** : Comment l'appareil qui envoie une remise hors ligne (`finance.cash_transfer.send`, D09 §12) connaît-il le compte destinataire, la caisse centrale en particulier, qu'aucune de ses portées n'atteint ?
- **Pourquoi** : le jeu `cash` ne sert à un appareil que les comptes de son utilisateur (détenteur, à défaut responsable) et de ses sites (`finance.cash.read`) ; la caisse centrale n'est le compte d'aucun site du vendeur ; D09 (« Hors ligne réel ») le renvoyait à P5-18, avec le paramètre des paires (désormais publié dans le jeu `me`, AV-196). **DÉDUIT** (P5-18, 11/10/2026).
- **Choix** : (a) chaque compte actif **sans détenteur personnel** (caisse de PDV, caisse centrale, banque, mobile money) est publié à tous les appareils comme destination (`CASH_TRANSFER_TARGET`, jeu `cash`, ligne `GLOBAL`), avec son code, son nom, son type et son site, **sans solde, responsable ni version** (la version du compte avance à chaque mouvement et dirait l'activité de la caisse) ; émis à la création, à la modification et à la désactivation du compte (sortie `DELETE`), jamais à ses mouvements ; l'appareil filtre par les paires admises ; (b) seuls les types destinataires des paires en vigueur (republication à chaque changement des paires) ; (c) envoi en ligne seulement.
- **Recommandation** : (a). **À signaler** : les caisses personnelles ne sont jamais publiées comme destinations (une paire `… → CAISSE_UTILISATEUR` resterait une remise en ligne) ; la liste des caisses de PDV atteint tous les appareils (codes et noms, sans montant).
- **Impact** : `emitCashTransferTargetChange` (`finance/application/sync-changes.ts`), `account-commands.ts`, projection `CASH_TRANSFER_TARGET`. Défaut implémenté : (a) (P5-18). Non paramétrable.

### AV-198 — Curseur du pull : ligne du flux validée après une ligne de numéro supérieur — IMPORTANTE
- **Question** : Comment garantir qu'un appareil ne saute aucune ligne du flux quand deux transactions concurrentes y écrivent et se valident dans l'ordre inverse de leurs numéros ?
- **Pourquoi** : `sync_change_feed.seq` est un `AUTO_INCREMENT` attribué à l'**insertion**, pas à la validation ; les modules écrivent leurs lignes au milieu de la transaction de la commande (puis l'audit, les événements, le repli, l'inbox). Un pull qui lit la ligne 101 déjà validée pendant que la ligne 100 est encore dans une transaction ouverte pose `next_cursor` à 101 : la ligne 100 n'est jamais servie. Défaut **préexistant** (P0), relevé par la revue adverse de P5-18 (11/10/2026) ; P5-18 en accroît l'enjeu : une sortie terminale (quota révoqué, session validée, remise reçue, AV-193) n'a pas de ligne de rattrapage, et les jeux `allocations` et `cash` sont désormais incrémentaux. L'en-tête de `sync-pull.service.ts` et 02-synchronisation.md §5.4 affirmaient « aucune perte » : corrigés. **DÉDUIT**.
- **Choix** : (a) **curseur retenu** : le pull sert toutes les lignes, mais `next_cursor` ne dépasse pas la première ligne plus récente qu'une fenêtre de stabilisation (paramètre `sync.pull_settle_seconds`, défaut proposé 120 s, plus long que la plus longue transaction de commande) ; les lignes récentes sont resservies au pull suivant (sans effet : état courant, ordre des numéros conservé) ; `has_more` faux tant que le curseur est retenu ; (b) numérotation après validation : les modules écrivent dans une table de transit, un relais séquentiel les numérote dans le flux après la validation (aucune perte, plus de code, léger délai) ; (c) sérialiser les écrivains du flux (verrou global jusqu'à la validation) : simple mais ralentit toutes les commandes ; (d) recharger périodiquement les jeux « chaque synchronisation » (`allocations`, `cash`) depuis zéro.
- **Recommandation** : (a), codée en P5-23 avec un test de concurrence (deux transactions validées dans l'ordre inverse) ; (b) si le volume l'exige plus tard. Risque résiduel de (a) : une transaction plus longue que la fenêtre.
- **Impact** : `apps/server/src/sync/sync-pull.service.ts` ; 02-synchronisation.md §5.4 ; `organization.system_settings` (nouveau paramètre) ; aucun changement du contrat (`next_cursor`, `has_more`). Non bloquant : aucun défaut implémenté en P5-18, la limite est écrite dans le code et la doc.
- **Défaut implémenté (P5-23)** : une variante plus fine de (a). Le curseur n'est retenu que devant un **trou récent** de la numérotation (numéro absent suivi d'une ligne de moins de `sync.pull_settle_seconds`, 120 s), et non devant toute ligne récente : en régime normal, sans transaction annulée ni ouverte, le curseur avance aussitôt (`settledSequenceBound`, `platform/kysely/settled-sequence.ts`). La page est servie entière ; `has_more` est faux tant que le curseur est retenu. La revue adverse de P5-23 a relevé le même défaut sur la position des **consommateurs d'événements** (`platform_domain_events`) : même règle, mêmes conséquences évitées (invalidation du cache des droits, révocation des quotas d'un appareil perdu). Test de concurrence : `p5-pull-cursor.test.ts` (deux transactions validées dans l'ordre inverse ; avec une fenêtre nulle, la ligne est perdue). Risque résiduel : une transaction plus longue que la fenêtre.

### AV-199 — Flux de distribution d'un PDV : catégories, datation, envoyé net des retours — SECONDAIRE
- **Question** : Comment classer les mouvements d'un emplacement pour les indicateurs de distribution (envoyé, reçu, vendu, perdu, restant), et à quelle date compter une contre-écriture (retour à la source, requalification d'une réception sans document, retour client) ?
- **Pourquoi** : BR-DIS-010 donne les indicateurs sans les mouvements qui les composent ; AV-164 (a) date chaque mouvement à sa date et range les écarts de transfert dans le perdu ; le plan (P5-19) demande l'envoyé « net des transferts `RETURNED` » et le reçu « hors inverses des retours à la source, réceptions sans document comptées dès leur application ». Or un écart de transfert part du transit, jamais du solde du PDV, et l'identité du domaine (`distributionResidual`) comptait les retours clients deux fois et n'avait pas de place pour les pertes en attente. **DÉDUIT** (P5-19, 11/10/2026).
- **Choix** : (a) chaque mouvement de l'emplacement tombe dans **une seule** catégorie, à **sa** date (`occurred_at`, jour métier de Douala) : reçu (réceptions moins requalifications des réceptions sans document, plus la marchandise d'un écart rejeté), transféré (expéditions moins retours à la source), vendu et retourné (vendu net), perdu (pertes reconnues, écarts d'inventaire négatifs, et confirmations des déclarations de l'emplacement passées par la validation — `LOSS_CONFIRMATION`, datée de la décision : la perte passe des pertes en attente au perdu), pertes en attente (moins leurs libérations et leurs confirmations, négatives possibles sur une période qui ne contient que la décision), gains d'inventaire, autres entrées et sorties ; l'identité « solde fin − solde début = Σ des catégories » est vraie par construction (`locationFlows`, `distributionFlowsOf`, `distributionResidual` avec `lostPending`) ; hors identité : l'envoyé vers le PDV (expéditions vers lui, nettes des retours à la source **à la date du retour**, négatif possible sur une période) et les écarts de transfert constatés, confirmés et rejetés (la marchandise rejetée est comptée dans le reçu) ; le perdu affiché n'ajoute que les **confirmés** (AV-164) ; (b) par document : un transfert retourné disparaît de sa période d'expédition, une réception requalifiée n'est comptée qu'une fois à sa première date (le solde de fin ne se rapproche plus du registre) ; (c) quantités des lignes de transfert plutôt que du registre.
- **Recommandation** : (a) : un seul calcul sur le registre, explicable jusqu'aux mouvements (BR-ANA-010), et rapprochable. BR-DIS-010 sera complétée en P5-20 (plan). **À signaler** (revue de P5-19) : une ligne de produit `SERVICE` n'a aucun mouvement (INV-VEN-08) : le vendu et l'à livrer de `sales` ne se rapprochent du registre que pour les produits stockés (filtre `productIds` de l'appelant) ; le solde d'ouverture somme le registre depuis l'origine (comme `GET /stock/at`) et l'à livrer relit les ventes sur commande de l'emplacement : instantanés quotidiens de la stratégie stock §3.2 si le volume l'exige (NFR-12, P5-20).
- **Impact** : `inventory/application/public/distribution-metrics.ts` ; `packages/domain/src/distribution.ts` (`lostPending`) ; tableau de distribution (P5-20). Défaut implémenté : (a) (P5-19). Non paramétrable : règle de calcul, non un seuil.

### AV-200 — Encaissé d'une période : datation des annulations d'encaissement — SECONDAIRE
- **Question** : L'annulation d'un encaissement se retranche-t-elle de la période où elle est décidée (vue « par période d'activité ») ou retire-t-elle le paiement de son jour d'origine ?
- **Pourquoi** : D11 (KPI-FIN-01) écrit « Σ encaissements confirmés dans P − annulations dans P » et BR-ANA-003 date une contre-écriture à son annulation ; le code (P4, `cashedSummary`, repris par l'accueil) compte les encaissements `RECORDED` au jour métier du paiement : une annulation décidée plus tard retire rétroactivement le paiement de son jour, une demande d'annulation en cours (`CANCELLATION_REQUESTED`) l'exclut déjà, un remboursement n'est pas retranché. ADR-032 §9 dit seulement « net des annulations ». Relevé par la lecture de P5-19. **DÉDUIT** ; le choix est **À VALIDER**.
- **Choix** : (a) inchangé : encaissements `RECORDED` au jour du paiement, une seule définition partagée par l'accueil et le tableau (`cashedSummary`, `cashedByGroup`) ; (b) vue par période d'activité : encaissements de la période (quel que soit leur statut ultérieur) moins annulations et remboursements décidés dans la période, comme le chiffre d'affaires (`periodRevenue`) ; (c) les deux vues, libellées distinctement (BR-ANA-003).
- **Recommandation** : (b), cohérente avec le chiffre d'affaires et le registre de trésorerie ; elle change l'accueil (P4) et se décide avec le porteur. En attendant, (a) reste implémentée **à un seul endroit**, sans divergence entre écrans (BR-ANA-009).
- **Impact** : `sales/application/public/period-activity.ts` (`cashedActivity`, dont `cashedSummary` et `cashedByGroup` sont la somme et la ventilation) ; accueil ; tableau de distribution. Défaut implémenté : (a) jusqu'à P5-22 ; **(b) depuis P5-23** ([ADR-041](decisions/ADR-041-activite-par-periode-accueil-et-tableau.md)) : encaissements confirmés (enregistrés, en demande d'annulation ou annulés depuis) à leur jour métier, moins annulations décidées dans la période, à leur date ; une demande en cours ne retire plus rien ; les remboursements ne sont pas retranchés (AV-244). Non paramétrable. Test : `p5-distribution-metrics.test.ts` (encaissement annulé le lendemain).

### AV-201 — « Session du jour » d'un PDV et sessions à valider — SECONDAIRE
- **Question** : Quelle session le tableau de distribution montre-t-il pour un PDV un jour donné, et que compte « sessions à valider » ?
- **Pourquoi** : le plan (P5-19) cite « session du jour, écart, sessions à valider » ; une session ouverte la veille peut courir encore (BR-DIS-006), une session close peut être réévaluée (P5-13). **DÉDUIT** (P5-19).
- **Choix** : (a) par caisse de PDV : la session **ouverte maintenant** (au plus une, INV-FIN-06, quel que soit son jour d'ouverture) et la **dernière session ouverte le jour métier** demandé, avec l'écart de clôture et l'écart **courant** (réévaluations comprises, AV-193) ; à valider : les sessions `PENDING_VALIDATION` de tous jours, et à part les ajustements en attente d'une session déjà validée (`OWN_APPROVAL`) ; (b) la seule session du jour métier ; (c) la session couvrant l'instant de lecture.
- **Recommandation** : (a). P5-20 ajoute `sessionsOfDay` (toutes les sessions ouvertes le jour métier) pour les écarts du jour de l'accueil (AV-208) : avec `finance.cash_sessions_per_day_max` > 1, la dernière session ne suffit pas.
- **Impact** : `finance/application/public/distribution-metrics.ts` (`cashSessionsOverview`). Défaut implémenté : (a) (P5-19). Non paramétrable.

### AV-202 — Fraîcheur d'un appareil : dernier contact et appareils d'un PDV — IMPORTANTE
- **Question** : Qu'est-ce que la « dernière synchronisation » d'un appareil (BR-ANA-005, D05 §12 « dernier contact »), et quels appareils sont « ceux du PDV » ?
- **Pourquoi** : `identity_devices.last_seen_at` n'est écrit qu'à la connexion (le dictionnaire dit « dernier contact serveur ») ; `last_push_at` ne bouge qu'à un envoi non vide (la PWA n'appelle pas le serveur quand sa file est vide) ; `last_pull_at` n'était jamais écrit : une tablette en ligne mais oisive paraissait en retard. Aucun lien direct n'existe entre un appareil et un PDV. **DÉDUIT** (P5-19).
- **Choix** : (a) dernier contact = le plus récent de la connexion, du dernier envoi et du **dernier pull**, que le serveur enregistre désormais à chaque `GET /sync/pull` (`sync.device_sync_state`, lignes `_device` et `_a:<auteur>`, colonne `last_pull_at`, appareil connu seulement) ; appareils d'un site = rattachés au site (`designated_site_id`), appareil désigné de son PDV, détenteurs d'un quota actif sur un emplacement du site ; en retard au-delà de `analytics.freshness_warning_hours` (2 h, paramètre semé) ; opérations restantes = dernier total déclaré par appareil et par auteur (P5-07) ; (b) un battement de cœur dédié de l'appareil ; (c) le seul dernier envoi.
- **Recommandation** : (a). Un appareil bloqué, perdu ou retiré reste listé (désigné d'un PDV, détenteur d'un quota) mais n'entre pas dans le nombre d'appareils en retard : son signal est ailleurs (révocation en attente, désignation à changer). **À signaler** : le droit de lecture de la fraîcheur se décidera avec le tableau (P5-20) : `sync.monitor.read` manque au Vendeur et à la Finance, qui voient le tableau de distribution (`analytics.dashboard.distribution`) ; un vendeur sans quota ni tablette rattachée n'apparaît pas parmi les appareils du PDV.
- **Impact** : `apps/server/src/sync/sync-pull.service.ts` (écriture de `last_pull_at`), `apps/server/src/sync/device-freshness.ts` (`devicesOfSites`, `deviceFreshness`), `inventory` (`activeAllocationHolderDevices`) ; dictionnaires `01-identity.md`, `11-audit-sync…`. Défaut implémenté : (a) (P5-19). Seuil paramétrable (`analytics.freshness_warning_hours`).

### AV-203 — Disponible net des quotas dans `GET /stock` — SECONDAIRE
- **Question** : Comment `GET /stock` montre-t-il le disponible net des quotas d'appareil (reporté de P5-17) ?
- **Pourquoi** : `qty_allocated` des soldes reste à zéro (ADR-033 §3, alors que le dictionnaire le décrivait comme « Σ restes de quotas actifs ») ; un quota se tient par (emplacement, produit), les lignes de `GET /stock` par lot ; la vente en ligne retranche déjà les quotas à part (`lockSellableQuantity`) : changer le disponible des lignes le doublerait. **DÉDUIT** (P5-19).
- **Choix** : (a) lignes inchangées (disponible sans consommateur désigné) et bloc `allocations` par produit : solde, réservé, restant alloué (quotas actifs, échus non libérés et en révocation compris, comptés à part), non alloué (`max(0, solde − réservé − alloué)`), dépassement, reste du quota **du demandeur** (utilisateur et appareil du jeton) et son disponible (BR-STK-011 : solde − réservé − restes des autres détenteurs) ; (b) alimenter `qty_allocated` des lignes (règle de répartition par lot à inventer, double soustraction à la vente) ; (c) route séparée.
- **Recommandation** : (a).
- **Impact** : `inventory-api/inventory-read.controller.ts` ; `allocationPositions` ; dictionnaire `06-inventory.md` ; 01-architecture-api.md §4.6. Défaut implémenté : (a) (P5-19). Non paramétrable.

### AV-204 — Périmètre du tableau de distribution ; portée du Resp. commercial sur les PDV — IMPORTANTE
- **Question** : Quels PDV le tableau de distribution montre-t-il à un utilisateur, et que voit un Resp. commercial ?
- **Pourquoi** : la matrice accorde `analytics.dashboard.distribution` en `ALL` (Direction, Finance), `ZONE` (Resp. commercial) et `SITE` (vendeur, magasinier) (01-rbac.md §5.1) ; l'accueil, lui, calcule un périmètre par rôle (ADR-030 §5 : le Resp. commercial y lit son équipe). Un PDV n'a pas de titulaire : une affectation `TEAM` n'en atteint aucun (`scope-evaluation.ts`). Or le seed ne permettait au Resp. commercial que des affectations `TEAM` (`allowedScopeTypes`, DÉDUIT de l'exemple de 01-rbac.md §8) : ses sept droits de portée `ZONE` (`inventory.ledger.read`, `inventory.allocation.manage`, `inventory.loss.approve`, `inventory.loss.read`, `inventory.count.approve`, `inventory.threshold.manage`, `analytics.dashboard.distribution`) n'atteignaient rien. **DÉDUIT** (P5-20, 11/10/2026).
- **Choix** : (a) périmètre = les PDV configurés pour lesquels `evaluateAccess` accepte la permission, PDV par PDV (zone et descendance comprises) ; aucun PDV ⇒ réponse vide, jamais « tout » ; `site_id` hors portée ou inconnu ⇒ 404 audité (RC-07) ; le Resp. commercial devient affectable sur une zone (`allowedScopeTypes` : `TEAM`, `ZONE`) : une affectation `ZONE` lui ouvre les PDV et le stock de sa zone, son affectation `TEAM` garde son équipe ; (b) ramener `TEAM` aux zones des membres de l'équipe (change le moteur RBAC pour toutes les permissions) ; (c) périmètre par rôle, comme l'accueil.
- **Recommandation** : (a). **À signaler** (revue de P5-20) : un Resp. commercial affecté en `TEAM` seulement (premier exemple de Paul, 01-rbac.md §8) a un tableau vide ; l'accueil et le tableau calculent leur périmètre différemment (rôle contre permission), écart assumé (ADR-035). Une affectation `ZONE` a trois autres effets : (1) le « (PDV) » de la matrice pour les approbations de pertes et d'inventaires est indicatif, le moteur ne connaît pas le type de site : le Resp. commercial approuve alors aussi les demandes des fermes et magasins de la zone, dès qu'une politique est liée à ces permissions (aucune n'est semée) ; à l'administrateur de n'affecter que des zones sans ferme, ou de créer des politiques distinctes ; une vraie restriction par type de site toucherait tout le moteur RBAC ; (2) ses pointages sont bornés aux zones affectées et à leurs sous-zones (BR-TER-006, toutes affectations `ZONE` confondues) ; (3) elle **s'ajoute** à l'affectation `TEAM`, qui doit être conservée : seule celle-ci alimente les jeux hors ligne de l'équipe (`computeDeviceScope`).
- **Impact** : `distribution-api/distribution-dashboard.controller.ts`, `read-api/distribution-targets.ts` ; `db/seeds/rbac-data.ts` (`allowedScopeTypes` de `RESP_COMMERCIAL`) ; 01-rbac.md §8 ; ADR-035. Défaut implémenté : (a) (P5-20). Non paramétrable (les affectations relèvent de l'administrateur).

### AV-205 — Frontière entre agrégat et détail du tableau de distribution — SECONDAIRE
- **Question** : Quelles informations du tableau exigent un droit au-delà de `analytics.dashboard.distribution` ?
- **Pourquoi** : AV-164 réserve le détail par document ou par personne au droit du domaine ; AV-202 signalait que `sync.monitor.read` manque au vendeur et à la Finance, qui voient le tableau. **DÉDUIT** (P5-20).
- **Choix** : (a) agrégats (flux, ventes, encaissé par moyen, état de caisse, remises, appareils : code, libellé, dernier contact, retard, opérations restantes) sous la permission du tableau ; identifiant et ouvreur d'une session de caisse sous `finance.cash.read`, encaissé par receveur sous `sales.payment.read`, auteurs d'une tablette partagée sous `sync.monitor.read`, chacun évalué sur le site du PDV, `null` sinon ; (b) tout le détail sous la seule permission du tableau ; (c) `sync.monitor.read` ajouté au vendeur et à la Finance.
- **Recommandation** : (a) : aucun changement du seed RBAC ; clôt le « À signaler » d'AV-202.
- **Impact** : `distribution-api/` (droits annexes évalués par PDV) ; contrat `packages/contracts/src/distribution-dashboard.ts`. Défaut implémenté : (a) (P5-20). Non paramétrable.

### AV-206 — Valeurs masquées du tableau de distribution — SECONDAIRE
- **Question** : Quelles mesures de valeur le tableau masque-t-il, et comment ?
- **Pourquoi** : le plan (P5-20) masque « les valeurs » sans `inventory.valuation.read` (RC-05, BR-ANA-004), mais les métriques de P5-19 ne portaient aucune valeur de stock ; D11 §8 prévoit l'erreur `FORBIDDEN_MEASURE` pour l'explorateur. **DÉDUIT** (P5-20).
- **Choix** : (a) valeur du restant (fin de période) et valeur du perdu, au coût du registre (`value_xaf` des mouvements, `locationFlows`), renvoyées à `null` sans `inventory.valuation.read` sur le site du PDV ; totaux de valeur à `null` dès qu'un PDV est masqué ; chiffre d'affaires et encaissé non masqués (hors BR-ANA-004) ; aucune erreur sur un tableau ; (b) refus `FORBIDDEN_MEASURE` de toute la lecture ; (c) masquer aussi le chiffre d'affaires.
- **Recommandation** : (a) (patron d'ADR-030 §6 et de `GET /stock`).
- **Impact** : `inventory` (`closingValueXaf`, `lostValueXaf`, `transitLostValueXaf`, `distributionKpisOf`) ; tableau. Défaut implémenté : (a) (P5-20). Non paramétrable.

### AV-207 — Période du tableau de distribution et instants de lecture — SECONDAIRE
- **Question** : Quelles périodes le tableau accepte-t-il, et à quel instant se lit chaque notion ?
- **Pourquoi** : 01-architecture-api.md §4.12 prévoyait `?period=` sans liste ; BR-ANA-002 définit les périodes nommées (semaine du lundi au dimanche) ; le reste à livrer, les seuils, les quotas, la caisse et la fraîcheur n'ont pas de sens sur une période passée ; le solde d'ouverture somme tout le registre de l'emplacement (AV-199). **DÉDUIT** (P5-20).
- **Choix** : (a) `period` (`TODAY` par défaut, `YESTERDAY`, `WEEK`, `MONTH`, `YEAR`, en jours métier de Douala) **ou** `from` et `to` (ensemble, dates réelles, bornes incluses, code `CUSTOM`), au plus `analytics.dashboard_max_period_days` jours (366, paramètre semé ; 400 au-delà) ; restant et valeurs à la fin de la période ; à livrer, à réapprovisionner, quotas, caisse et fraîcheur à l'instant de lecture ; instantanés de soldes reportés tant que NFR-12 tient ; (b) période libre sans borne ; (c) instantanés quotidiens dès maintenant.
- **Recommandation** : (a).
- **Impact** : `packages/domain/src/business-day.ts` (`businessPeriodOf`, `businessPeriodDays`) ; contrôleur du tableau ; `db/seeds/system-settings.ts` ; 01-architecture-api.md §4.12 ; 02-organization.md. Défaut implémenté : (a) (P5-20). Durée maximale paramétrable.

### AV-208 — Accueil Finance et magasinier : contenu de distribution — SECONDAIRE
- **Question** : Que l'accueil de la Finance et du magasinier reprend-il du tableau de distribution ?
- **Pourquoi** : le plan (P5-20) prévoit un « accueil Finance et magasinier enrichi » sans en fixer le contenu ; ADR-030 §7 impose une seule fonction par indicateur ; `APPROVALS_PENDING` porte déjà les demandes `CASH_VARIANCE` ; `SYNC_STALE` (D13) vaut 24 h, la fraîcheur de BR-ANA-005 2 h ; les anomalies d'un magasinier comptaient celles de tous les sites. **DÉDUIT** (P5-20).
- **Choix** : (a) avec `analytics.dashboard.distribution` : **Finance** — caisses à valider (`KPI-FIN-CS-PENDING`, ajustements en attente en détail), écarts de caisse du jour (`KPI-FIN-CS-VAR`, manquant et excédent, sur **toutes** les sessions ouvertes le jour métier), remises en attente sur tous les comptes (`KPI-FIN-TRANSFERS`), appareils des PDV **ouverts** en retard (`KPI-OPS-01` ; la tablette restée désignée d'un site fermé n'est pas comptée) ; signaux `CASH_VARIANCE` (critique seulement : écart courant d'une session du jour au-delà de la tolérance et atteignant `finance.cash_variance_critical_xaf` du site), `CASH_SESSION_OPEN_LONG` (`finance.cash_session_force_close_hours` du site), `CASH_TRANSFER_NOT_RECEIVED`, `DEVICES_STALE` ; pas de signal « sessions à valider » ; **magasinier** — produits à réapprovisionner (`KPI-DIS-07`), quotas échus ou en révocation (`KPI-DIS-QUOTAS`, chacun compté une fois), appareils, sur les PDV de **ses** sites seulement, sans caisse ni vente ; aucun PDV ⇒ aucun bloc ; anomalies (`SYNC_CONFLICTS`) d'un rôle de sites filtrées par ses sites ; (b) ouvrir au magasinier les PDV qu'il approvisionne (`replenishmentSourceLocationId`).
- **Recommandation** : (a). Une valeur absurde des seuils de caisse (heures nulles ou négatives, montant négatif) reprend le défaut, comme dans les commandes de caisse : elle ne fait jamais échouer l'accueil ni le tableau. Limite connue : un utilisateur à la fois Finance et magasinier ne voit qu'un `DEVICES_STALE` (dédoublonnage par code), celui de la Finance, qui couvre tous les PDV. Deux défauts antérieurs relevés par la revue de P5-20 sont **corrigés** (12/10/2026) : l'accueil d'un rôle d'équipe ne compte que les anomalies dont l'auteur de la commande, ou pour un conflit système le titulaire du stock mobile en cause, est de son équipe (règle de la portée `TEAM` de `GET /sync/conflicts`, `sync/conflict-resource.ts`) ; `APPROVALS_PENDING` ne compte que les demandes que l'utilisateur peut décider (`evaluateAccess` sur le demandeur, le site et la zone de la demande, comme la décision ; pré-filtre de portée, plus de coupe aux 500 demandes les plus anciennes).
- **Impact** : `home-api/home-service.ts` ; `approvals/application/public/pending-approvals.ts`, `sync/conflict-resource.ts` (correctifs du 12/10/2026) ; D11 §7.1 (codes locaux) ; ADR-030 (renvoi), ADR-035. Défaut implémenté : (a) (P5-20). Seuils paramétrables (ceux de la caisse et de la fraîcheur).

### AV-209 — Chiffre d'affaires du jour : accueil contre tableau de distribution — SECONDAIRE
- **Question** : Le chiffre d'affaires du jour de l'accueil et le vendu net du tableau doivent-ils coïncider ?
- **Pourquoi** : l'accueil (P4, `salesPeriodSummary`, KPI-COM-08) compte les ventes non annulées par jour de la vente ; le tableau (D11, BR-ANA-003) compte le vendu net par période d'activité, une annulation à sa date (`soldByLocation`). Une annulation décidée un autre jour donne deux valeurs pour un même jour et un même PDV, contre BR-ANA-009. **DÉDUIT** (P5-20) ; même famille qu'AV-200.
- **Choix** : (a) le tableau suit D11 ; l'accueil est aligné sur la vue par période d'activité (`periodRevenue`) en P5-23, avec le porteur, en même temps qu'AV-200 ; (b) le tableau aligné sur l'accueil ; (c) deux libellés distincts.
- **Recommandation** : (a).
- **Impact** : `sales/application/public/period-activity.ts` (`saleActivityArms`, partagé par `soldByLocation` et `salesActivityByDay`) ; accueil ; tableau. Défaut implémenté : (a) en entier depuis P5-23 ([ADR-041](decisions/ADR-041-activite-par-periode-accueil-et-tableau.md)) : l'accueil compte le vendu net par période d'activité ; `salesPeriodSummary` et `salesDailySeries` sont retirés. Les deux écrans gardent chacun leur périmètre (AV-245). Non paramétrable. Test : `p5-distribution-metrics.test.ts` (égalité jour par jour, vente annulée le lendemain).

### AV-210 — Ordre d'un lot après une commande à renvoyer ; dépendance reçue mais non réglée — IMPORTANTE
- **Question** : Quand une commande d'un lot reçoit `RETRY_LATER` (dépendance pas encore appliquée, erreur transitoire), le serveur traite-t-il les commandes suivantes du même lot ? Et une commande dont la dépendance est reçue mais pas encore réglée ?
- **Pourquoi** : 02-synchronisation.md §3.1 disait « Arrêt du lot : aucun » (règle pensée pour les rejets), alors qu'INV-SYN-04 garantit l'ordre de chaque couple (appareil, auteur). Le serveur appliquait la suite du lot. AT-004 l'a montré (P5-21, trois tablettes qui synchronisent en même temps) : une vente renvoyée après un interblocage passait **après** la libération du quota qu'elle précédait, et retombait sur le stock commun avec une fausse alerte `ALLOCATION_EXCEEDED`. Deux défauts voisins sont apparus au même endroit. Une commande en attente de dépendance restait `RECEIVED`, et son renvoi rendait ce statut (qui n'est pas un résultat) au lieu de la traiter : le fait n'était jamais appliqué. Une dépendance `RECEIVED` ou `FAILED_RETRYABLE` laissait passer la dépendante. **DÉDUIT** (P5-21, 12/10/2026).
- **Choix** : (a) dès la première réponse `RETRY_LATER` d'un lot, les commandes suivantes reçoivent `RETRY_LATER` (`PRECEDING_COMMAND_PENDING`), sans être traitées ni enregistrées, et l'appareil les renvoie dans l'ordre ; une dépendance inconnue, `RECEIVED` ou `FAILED_RETRYABLE` fait attendre la dépendante (`DEPENDENCY_PENDING`) ; la commande en attente passe `FAILED_RETRYABLE`, et le renvoi identique la reprend ; une reprise est **réclamée** sur le compteur de tentatives (de deux renvois simultanés, un seul traite) ; une ligne `RECEIVED` récemment réclamée est « en cours » (`RETRY_LATER`, `SERVER_BUSY`), réclamée depuis plus de 120 s elle est reprise (délai technique, mesuré depuis `claimed_at`) ; (b) poursuivre le lot, l'ordre n'étant garanti qu'en l'absence d'incident ; (c) l'appareil n'envoie qu'une commande à la fois.
- **Recommandation** : (a) : l'ordre du couple devient une garantie, sans coût en régime normal ; la PWA traite déjà `RETRY_LATER` par statut, sans distinguer les codes.
- **Impact** : `apps/server/src/sync/sync-push.service.ts`, `apps/server/src/commands/command-pipeline.service.ts`, `packages/contracts/src/error-codes.ts` (nouveau code) ; 02-synchronisation.md §3.1 à §3.3 ; INV-SYN-04, BR-SYN-004 ; tests `sync-push-protocol.test.ts`, `p5-pdv-three-tablets.test.ts`. Défaut implémenté : (a) (P5-21). Non paramétrable (règle de protocole).
- **Revue adverse (12/10/2026)** : l'abandon se mesurait sur `received_at`, que le déclencheur de l'inbox rend immuable ; une commande reprise paraissait donc aussitôt abandonnée, et un renvoi arrivé pendant son traitement pouvait la traiter une seconde fois (second audit, ou boucle sur un doublon de clé qui écrasait `APPLIED` et gelait la file). Corrigé : colonne `claimed_at` (migration `20261012090000`), conclusion de l'inbox conditionnée au numéro de tentative, ligne d'inbox verrouillée en tête de la transaction métier, insertion concurrente répondue « réessayer » ; délai de 25 s du lot appliqué ; restes de l'appareil comptés avec les commandes non réglées (BR-DIS-014) ; commande qui ne se règle jamais : AV-217.

### AV-211 — Faits antérieurs à la révocation d'un quota, synchronisés après : comparaison fait par fait — SECONDAIRE
- **Question** : Un fait hors ligne antérieur à la révocation d'un quota, poussé après elle, se compare au reste du quota au moment de la révocation : chaque fait seul, ou leur cumul ?
- **Pourquoi** : `allocation-consumption.ts` compare chaque fait au montant de l'entrée `REVOKE` (`revokedRemainingMilli`). Aucun fait antérieur appliqué après la révocation n'est rattaché au quota révoqué (aucune entrée ne s'écrit sur lui). Trois ventes de 10, avec un reste révoqué de 25, ne signalent donc rien, alors que leur total (30) dépasse. Le stock n'est jamais faussé (le stock commun absorbe), seul le signal `ALLOCATION_EXCEEDED` manque. Relevé par la cartographie de P5-21. **DÉDUIT** (12/10/2026).
- **Choix** : (a) fait par fait (actuel) ; (b) cumul : tenir, par quota révoqué, la somme des faits antérieurs appliqués après lui (entrée de suivi sans effet sur le reste, ou lecture des mouvements du couple sur la fenêtre), et signaler dès que le cumul dépasse ; (c) aucun signal.
- **Recommandation** : (b), avec la réconciliation des quotas (P5-23).
- **Impact** : `inventory/application/allocation-consumption.ts`, `allocation-ledger.ts` ; INV-STK-20. Défaut implémenté : (b) depuis P5-23 — lecture des mouvements du couple (emplacement, produit) du détenteur (utilisateur et appareil), de type consommant un quota, datés au plus tard de la révocation et écrits après elle (`lateFactsBeforeRevocationMilli`) ; le conflit `ALLOCATION_EXCEEDED` porte `earlierAfterRevocation` et l'excédent du seul fait courant ; test `p5-stock-guards.test.ts`. Non paramétrable.

### AV-212 — Fenêtre de quarantaine d'un appareil débloqué ou retiré — IMPORTANTE
- **Question** : Une commande datée pendant que l'appareil était bloqué ou perdu, poussée après son déblocage ou son retrait, est-elle mise en quarantaine ?
- **Pourquoi** : `checkDeviceActive` (`identity/application/public/device-check.ts`) ne lit que le statut courant et `status_changed_at`. Un appareil `ACTIVE` est toujours accepté ; sinon, seul un fait antérieur à `status_changed_at` passe. Or `unblock` et `retire` réécrivent `status_changed_at`. Après un déblocage, les faits datés pendant le blocage sont appliqués. Après `LOST` puis `RETIRED`, les faits datés entre la perte et le retrait le sont aussi. INV-ADM-03 n'est donc garanti que tant que l'appareil reste hors service. BR-ADM-006 parle de commandes « reçues après la date de blocage », INV-ADM-03 et AT-035 d'un `occurred_at` postérieur. Vérifié en lecture (P5-21), non testé : `it.todo` de `p5-pdv-lost-device.test.ts`. **DÉDUIT** (12/10/2026).
- **Choix** : (a) statut courant (actuel) ; (b) historique des périodes de statut de l'appareil (`identity`) et quarantaine de tout fait daté dans une période hors service, quel que soit le statut courant ; (c) date de réception plutôt que date du fait.
- **Recommandation** : (b) ; c'est une garde de sécurité, à faire avant la mise en production (P5-23 ou P10).
- **Impact** : `identity` (historique des statuts, migration), `device-check.ts` ; SM-DEVICE ; AT-035. **Défaut implémenté en P5-23 : (b)**. Table `identity_device_status_periods` (ajout seul, migration `20261013090000`) : `unblock`, et `retire` depuis `BLOCKED` ou `LOST`, y consignent la période qu'ils ferment (`[status_changed_at, occurred_at)`, motif, auteur, commande), dans leur transaction ; `checkDeviceActive` lit la ligne vivante et ses périodes en une instruction et met en quarantaine (`CONFLICT DEVICE_REVOKED`) tout fait daté dans une période close, quel que soit le statut courant. Amorçage vide : les périodes antérieures n'étaient pas conservées (aucune base de production). Chaque transition lit l'appareil `FOR UPDATE` (ADR-038, résidus). Corrigé au passage : `unblock` d'un appareil refusé avant toute approbation pose `approved_by` (l'écriture violait `ck_identity_devices_approved_by`, rejouée sans fin). Suites : AV-228 (appareil en attente), AV-229 (utilisateur réactivé, même défaut). Non paramétrable. Tests : `device-check.test.ts`, `identity-lifecycle.test.ts`, `p5-pdv-lost-device.test.ts` (l'`it.todo` devient un test), `db/tests/identity.test.ts`.

### AV-213 — Appareil révoqué : envoi de sa file et signal d'effacement local — IMPORTANTE
- **Question** : Comment un appareil révoqué envoie-t-il sa file (pour quarantaine), et comment apprend-il qu'il doit effacer ses données ?
- **Pourquoi** : 01-architecture-offline.md prévoit que l'application « tente d'envoyer » sa file, puis efface ses données téléchargées en gardant la file. Mais la perte ou le blocage révoquent les sessions : connexion et rafraîchissement sont refusés, seul un jeton d'accès encore valide (15 min) permet l'envoi. Le pull ne vérifie pas le statut de l'appareil (`sync/sync-pull.service.ts`) et aucun signal « effacer » n'existe. La PWA n'efface pas sur révocation (`wipeLocalSession` relève des échecs de PIN). Le harnais simule l'effacement (`OfflineDevice.wipeLocal`, P5-21). **DÉDUIT** (12/10/2026).
- **Choix** : (a) actuel : envoi tant que le jeton vaut, quarantaine côté serveur, effacement à coder dans la PWA sur `DEVICE_REVOKED` ; (b) canal dédié pour déposer la file d'un appareil révoqué (décision d'architecture, ADR) ; (c) pull refusé à un appareil hors service, réponse qui déclenche l'effacement local.
- **Recommandation** : (a) et (c), avec les écrans PWA ; (b) seulement si le porteur veut récupérer les faits d'un appareil retrouvé.
- **Impact** : `sync/sync-pull.service.ts`, PWA (file, session) ; AT-035. Défaut implémenté : (a). Non paramétrable.

### AV-214 — Régularisation d'une vente mise en quarantaine (appareil révoqué) — SECONDAIRE
- **Question** : Une vente réelle d'un appareil perdu, mise en quarantaine (`DEVICE_REVOKED`), comment se régularise-t-elle ?
- **Pourquoi** : la quarantaine n'écrit que l'inbox (`CONFLICT`, charge utile gardée), sans ligne `sync_sync_conflicts` : elle n'apparaît pas dans la file des conflits (`GET /sync/conflicts`), alors que la matrice des conflits lui donne l'Admin pour propriétaire. AV-190 a exclu le rejeu (`ACCEPT_CLIENT`). AT-035 × PDV (P5-21) montre l'espèce encaissée qui se retrouve en écart de clôture, explicable seulement par l'inbox ; le stock fantôme ne se corrige que par un inventaire (D01). Complète AV-190. **DÉDUIT** (12/10/2026).
- **Choix** : (a) actuel : écart de caisse expliqué par l'inbox, inventaire du détenteur, ressaisie manuelle ; (b) ligne de conflit `DEVICE_REVOKED` (propriétaire Admin) dans la file, avec la charge utile, régularisée par `COMPENSATE` (références des commandes de ressaisie) ; (c) rejeu contrôlé, type par type.
- **Recommandation** : (b).
- **Impact** : `commands/command-pipeline.service.ts` (quarantaine), file des conflits ; AV-190. Défaut implémenté : (a). Non paramétrable.

### AV-215 — Stock négatif après une sortie hors ligne autre qu'une vente — SECONDAIRE
- **Question** : Une perte, une consommation ou une expédition saisie hors ligne qui rend un solde négatif ouvre-t-elle le conflit `STOCK_NEGATIVE` ?
- **Pourquoi** : ces sorties passent `allowNegative` hors ligne (`loss-declaration.ts`, `consumption.ts`, `transfer-commands.ts`) : le solde devient négatif sans conflit. Seule la vente directe ouvrait une ligne de conflit `STOCK_NEGATIVE` (la livraison de régularisation et l'annulation de collecte d'œufs ne renvoyaient que l'avertissement ; `stock-negative-conflicts.ts` ne fait que les fermer), alors que BR-STK-018 l'exige pour tout fait physique hors ligne et que l'accueil l'annonce pour « une vente ou une sortie hors ligne au-delà du stock ». Relevé par la cartographie de P5-21. **DÉDUIT** (12/10/2026).
- **Choix** : (a) actuel ; (b) le même conflit (propriétaire magasinier) pour toute sortie hors ligne qui rend le solde négatif, posé par `recordStockMove`.
- **Recommandation** : (b), avec les invariants et la réconciliation (P5-22).
- **Impact** : `inventory` (perte, consommation, expédition), `stock-negative-conflicts.ts` ; INV-STK-05. Défaut implémenté : (b) depuis P5-22, conforme à BR-STK-018 (CONFIRMÉ) : `recordStockMove` ouvre le conflit pour toute sortie d'un emplacement physique qui laisse un solde négatif (perte, consommation, expédition, mortalité, intrant, production, inventaire, annulation de collecte, livraison de régularisation), un par sortie, rattaché au document source, au nom du responsable du stock (AV-142), identifiants canoniques ; la vente directe garde le sien, un par ligne. `verifyStockLedger` contrôle INV-STK-05 (`negativeBreaches`). Non paramétrable.

### AV-216 — Horloge d'appareil suspecte : dates de référence, seuil et alerte — SECONDAIRE
- **Question** : Avec une horloge d'appareil fausse, quelle date fait foi (session de caisse, échéance et révocation d'un quota, jour métier, quarantaine) ? Le seuil de suspicion est-il paramétrable, et quand l'alerte est-elle levée ?
- **Pourquoi** : ADR-016 ne corrige jamais `occurred_at`. AT-036 × PDV (P5-21, `p5-pdv-clock-skew.test.ts`) en montre les effets, tous jugés sur la date de la tablette :
  - l'espèce d'une tablette en retard tombe avant l'ouverture de la caisse (`CASH_SESSION_MISSING`) ;
  - le mouvement « futur » d'une tablette en avance empêche la clôture d'une autre d'être validée d'office (`CASH_SESSION_CLOSE_BEFORE_MOVEMENTS`) ;
  - une vente faite après minuit reste au jour métier précédent, sur un quota pourtant échu ;
  - la garde de la tablette en avance bloque deux heures trop tôt.

  Le seuil de 5 min est une constante (`packages/domain/src/clock-skew.ts`), alors que `sync.clock_skew_flag_minutes` est semé et jamais lu (règle 8). L'alerte `CLOCK_SKEW` relève de P9 (D13), et le tableau de distribution n'expose pas le drapeau. **DÉDUIT** (12/10/2026).
- **Choix** : (a) date déclarée partout (ADR-016), drapeau visible (`clock_suspect`, `CLOCK_SUSPECT`, `clock_skew_ms`), seul le contrôle de date future corrigé de l'écart (INV-GLO-02, corrigé en P5-21) ; (b) date corrigée de l'écart pour la caisse et les quotas (correction silencieuse, contraire à ADR-016).
- **Recommandation** : (a). Lire le seuil dans `sync.clock_skew_flag_minutes` en P5-23 ; alerte et drapeau dans le tableau en P9.
- **Impact** : `clock-skew.ts`, `sync/sync-push.service.ts`, `platform/sync/command-origin.ts` ; tableau de distribution. Défaut implémenté : (a). **Seuil paramétré en P5-23** : `sync.clock_skew_flag_minutes` (minutes > 0, repli 5 min pour une valeur absente ou absurde) est lu une fois par lot par le service d'envoi, à l'heure serveur de la réception (jamais à `occurred_at`, déclaré par l'horloge en cause) ; la décision est écrite dans l'inbox (`sync_command_inbox.clock_suspect`, migration `20261013090100`, figée par le déclencheur, rattrapée par l'ancienne règle) et relue par `loadCommandOrigin` et les pièces jointes — `platform/sync` ne peut pas lire un paramètre d'`organization` (frontières de modules). Suites : AV-226 (tolérance de date future), AV-227 (écart borné). Test : `sync-clock-skew-setting.test.ts`. Alerte et drapeau dans le tableau : P9.
- **Revue adverse (12/10/2026)** : la correction de l'écart s'appliquait dans les deux sens ; une horloge qui recule entre la saisie et l'envoi faisait rejeter des faits exacts (`OCCURRED_AT_FUTURE`, définitif). Corrigé : `occurred_at + min(0, écart)` — seule une horloge en avance est excusée (INV-GLO-02, BR-SYN-011).

### AV-217 — Commande à renvoyer qui ne se règle jamais : suspension du lot bornée — IMPORTANTE
- **Question** : Une commande qui reçoit `RETRY_LATER` à chaque renvoi suspend-elle indéfiniment toute la file de son auteur (AV-210) ?
- **Pourquoi** : depuis AV-210, la première commande à renvoyer d'un lot suspend la suite. La revue adverse de P5-21 a relevé deux causes de renvoi sans fin : l'étape 7 range toute exception parmi les erreurs transitoires, y compris une erreur déterministe (emplacement introuvable, déclencheur, contrainte) ; une dépendance d'un autre auteur peut ne jamais arriver. Les ventes, encaissements et clôtures suivants de l'auteur restaient alors bloqués sur l'appareil, sans que rien ne le fasse remonter. Le compteur de tentatives (SMALLINT) débordait en une douzaine d'heures de renvois et faisait échouer tout le lot. **DÉDUIT** (12/10/2026).
- **Choix** : (a) au-delà d'une durée paramétrée depuis la première réception, la commande, toujours à renvoyer (jamais perdue, BR-SYN-007), ne suspend plus la suite (`COMMAND_STALLED`), et le signal `SYNC_COMMAND_STALLED` (Admin) est ouvert une fois, fermé quand elle se règle ; (b) mise en quarantaine (`CONFLICT`) au-delà de la durée : débloque aussi, mais le fait n'est plus rejoué (AV-190) ; (c) classer les erreurs : seules les erreurs vraiment transitoires (interblocage, attente de verrou, connexion) sont renvoyées, les autres mises en quarantaine aussitôt — plus fin, mais une erreur mal classée retire un fait accompli du rejeu.
- **Recommandation** : (a), avec (c) à étudier une fois les erreurs déterministes inventoriées. L'ordre du couple n'est plus garanti pour la seule commande bloquée (les suivantes passent devant elle) : le signal le rend visible.
- **Impact** : `commands/command-pipeline.service.ts`, `commands/retry-hold.ts`, `sync/sync-push.service.ts`, contrat (`COMMAND_STALLED`), migration `20261012090000` (`attempts` en INT), paramètre `sync.retry_hold_minutes` ; 02-synchronisation.md §3.1 à §3.3, §4 ; INV-SYN-04, BR-SYN-004 ; matrice des conflits ; côté PWA, renvois sans boucle serrée (fork des écrans). Défaut implémenté : (a), 30 min, paramétrable (`sync.retry_hold_minutes`).

### AV-218 — Compte de réception d'un encaissement mobile money ou bancaire quand l'entreprise a plusieurs comptes du type — IMPORTANTE
- **Question** : Quel compte reçoit un encaissement mobile money ou bancaire quand l'entreprise a plusieurs comptes du type (Orange et MTN) et que l'appareil du vendeur n'en connaît aucun ?
- **Pourquoi** : BR-FIN-002 et AV-139 laissent l'appareil désigner le compte, mais le jeu `cash` ne sert ces comptes qu'à leurs responsables ; le serveur refuse alors l'encaissement (`CASH_ACCOUNT_AMBIGUOUS`), y compris une vente faite hors ligne. **DÉDUIT** (fork « Écrans PWA », reporté à la fusion le 12/10/2026 ; numéro de fork 300).
- **Choix** : (a) publier les comptes d'entreprise à tous les appareils qui encaissent ; (b) rattacher chaque moyen de paiement à un compte (Orange → compte Orange) ; (c) laisser l'appareil sans compte et accepter l'encaissement en attente d'affectation par la Finance.
- **Recommandation** : (b), simple et sans saisie de plus pour le vendeur ; (c) pour les faits hors ligne.
- **Impact** : serveur (`cash-account-resolution.ts`, jeu `cash`), PWA (bloc d'encaissement). Défaut implémenté : Compte jamais désigné d'office (« seul compte connu de l'appareil » n'est pas « seul compte de l'entreprise ») : choix proposé dès que l'appareil connaît un compte du type, obligatoire s'il en connaît plusieurs ; sinon aucun compte envoyé et avertissement affiché (`payment.ts`)

### AV-219 — Motif d'un écart d'inventaire exigé dès la saisie sur l'appareil — SECONDAIRE
- **Question** : Un écart d'inventaire doit-il être justifié par un motif dès la saisie, alors que l'écart réel n'est connu qu'à la soumission ?
- **Pourquoi** : BR-STK-042 veut un écart « justifié par un code motif », le dictionnaire le dit requis si l'écart est non nul, mais le serveur ne l'exige pas (`count.record_lines`) et calcule l'écart à `counted_at` ; l'appareil ne peut qu'estimer l'écart (compté − physique connu − opérations en attente). **DÉDUIT** (fork « Écrans PWA », reporté à la fusion le 12/10/2026 ; numéro de fork 301).
- **Choix** : (a) motif exigé sur un écart estimé non nul ; (b) motif facultatif, demandé à la validation ; (c) contrôle au serveur à la soumission.
- **Recommandation** : (a) sur l'appareil et (c) au serveur
- **Impact** : PWA. Défaut implémenté : Motif exigé par l'appareil sur un écart estimé non nul quand des motifs `INVENTORY_ADJUSTMENT` existent (`REQUIRE_VARIANCE_REASON` dans `apps/pwa/src/features/stock/count.ts`) ; sans motif paramétré, l'écart part sans motif

### AV-220 — Écran de consommation hors lot (ECR-STK-08) pour le vendeur de PDV et le responsable de production — SECONDAIRE
- **Question** : Le vendeur de PDV et le responsable de production doivent-ils disposer de l'écran ECR-STK-08 « Consommation d'intrants hors lot » ?
- **Pourquoi** : la matrice RBAC leur donne `inventory.consumption.record` (vendeur SITE, responsable de production ALL ; UC-STK-10 pour les emballages du PDV), l'inventaire des écrans (03-parcours-et-ecrans.md) ne cite que le magasinier et le responsable de ferme. **DÉDUIT** (fork « Écrans PWA », reporté à la fusion le 12/10/2026 ; numéro de fork 302).
- **Choix** : (a) l'écran suit la permission ; (b) l'écran suit l'inventaire.
- **Recommandation** : (a), et aligner l'inventaire.
- **Impact** : menu des deux rôles. Défaut implémenté : (a) : écran proposé aux quatre rôles, intrants et emballages consommables seulement


### AV-221 — Annulation directe pendant une clôture de caisse concurrente : condition relue sous verrou — SECONDAIRE
- **Question** : Quand une clôture de caisse est validée pendant une annulation directe, après que celle-ci a lu sa condition (« la session de la vente est encore ouverte », AV-185), que fait l'annulation ?
- **Pourquoi** : AV-185 lit la condition sans verrou, pour ne pas prendre la caisse avant le stock (ordre des verrous). La cartographie de P5-22 a confirmé la course : la clôture passe, l'annulation reprend et rembourse à une heure qu'aucune session ne couvre. **DÉDUIT** (12/10/2026).
- **Choix** : (a) relire la condition sous le verrou des caisses, quand l'annulation l'atteint (après le stock) ; si elle a basculé, annuler la transaction par une erreur transitoire (`RETRY_LATER`), et le renvoi identique prend le chemin de la demande (`CANCEL_SESSION_CLOSED`) ; (b) verrouiller les caisses avant le stock pour toutes les opérations (ordre inversé, révision d'ADR-032 §10) ; (c) accepter la course et signaler le remboursement hors session par un conflit.
- **Recommandation** : (a) : aucun ordre inversé, aucun remboursement hors session ; le coût d'un renvoi est rare.
- **Impact** : `sales/application/commands/cancel-commands.ts` (`CashSessionClosedDuringCancellation`), `sale-cancellation.ts` ; ADR-038 §4 ; test `p5-lock-order.test.ts`. Défaut implémenté : (a) (P5-22). Non paramétrable (règle de concurrence).

### AV-222 — Gardes des référentiels : valeurs retenues là où une contrainte de la base levait une exception — SECONDAIRE
- **Question** : Les besoins serveur S-29 et S-31 (écrans) demandent de refuser proprement ce que la base refusait par exception. Quatre cas exigent une valeur, et pas seulement un refus : (1) un produit biologique créé sans suivi par lot ; (2) l'activation d'une nouvelle version dont la date d'effet suit la fin de la règle remplacée ; (3) la tolérance d'une fin « ≥ maintenant » ; (4) une unité ou un canal recréé sous un code existant.
- **Pourquoi** : (1) BR-PRD-001 n'admet en lot qu'un produit suivi par lot, et le suivi est définitif ; (2) BR-PRX-007 fixe la fin de la remplacée à la date d'effet de la nouvelle, mais le déclencheur de garde n'admet qu'une réduction de la fin ; (3) SM-PRICE-RULE écrit « ≥ maintenant », l'activation tolère 5 minutes ; (4) la commande répondait `APPLIED` sans rien changer. **DÉDUIT** (P5-23, 12/10/2026).
- **Choix** : (a) (1) `NONE` refusé, absent réglé à `REQUIRED` ; (2) activée sans toucher la remplacée (sa fin n'est jamais reculée), la période entre les deux restant sans cette règle ; (3) même tolérance de 5 minutes que l'activation (BR-PRX §8) ; (4) identique (libellé, et nature de comptage pour une unité) : sans effet, `APPLIED` ; différent : `CODE_EXISTS` ; (b) (1) `OPTIONAL` par défaut ; (2) refus `PRICE_RULE_PERIOD_INVALID` ; (3) aucune tolérance ; (4) toujours `CODE_EXISTS`.
- **Recommandation** : (a) : la plus stricte pour le suivi, la plus permissive là où rien ne se perd.
- **Impact** : `catalog.product.create`, `catalog.unit.create`, `catalog.sales_channel.create`, `pricing.rule.activate`, `pricing.rule.end` ; D10 §8 et §14, D16 §8 ; test `p5-reference-guards.test.ts`. Défaut implémenté : (a) (P5-23). La tolérance de 5 minutes est celle de BR-PRX §8, déjà codée à l'activation ; non paramétrable (règle de validité, non un seuil).

### AV-223 — Expédition hors ligne d'une demande qui n'est plus à expédier ; mouvement interne hors de la garde de l'auteur — SECONDAIRE
- **Question** : (1) Une expédition saisie hors ligne d'une demande refusée, annulée ou déjà expédiée depuis (une autre tablette), que devient-elle ? (2) Un mouvement interne vers (ou depuis) un emplacement sous la garde exclusive d'un autre — stock mobile d'un commercial — est-il refusé ?
- **Pourquoi** : besoin serveur S-40 (écrans) : l'expédition hors ligne était rejetée (`TRANSFER_STATUS_INVALID`) alors que la marchandise est partie (BR-SYN-007) ; le mouvement interne ne contrôlait ni le site, ni le « même responsable » de BR-STK-022, ni la garde d'appareil, et pouvait remplir ou vider le stock mobile d'un commercial à son insu. **DÉDUIT** (P5-23, 12/10/2026).
- **Choix** : (a) (1) demande `DECLINED` ou `CANCELLED` : expédition **directe** de la même paire appliquée (nouveau transfert, note qui cite la demande), avertissement et conflit appliqué `TRANSFER_REQUEST_CLOSED` pour le responsable du stock expéditeur ; demande déjà expédiée (`DISPATCHED`, `RECEIVED`, `DISCREPANCY_PENDING`, `CLOSED`, `RETURNED`) : **quarantaine** (`CONFLICT`, aucun mouvement, conflit `TRANSFER_DISPATCH_CONFLICT` non appliqué) — une seconde expédition réelle se ressaisit en expédition directe ; (2) même site exigé (règle de validité, `LOCATION_INVALID`, hors ligne compris) ; un emplacement exclusif à un autre utilisateur ou désigné pour un autre appareil : refus `INTERNAL_MOVE_CUSTODY` en ligne, fait appliqué avec `CUSTODY_DEVICE_MISMATCH` (raison `LOCATION_OTHER_CUSTODY`) hors ligne ; le mouvement interne consomme le quota de son auteur sur une source partagée, comme une expédition ; (b) quarantaine dans tous les cas ; (c) rejet maintenu.
- **Recommandation** : (a) : le fait physique n'est jamais perdu, et le doute (deux expéditions pour une demande) est arbitré sans effet.
- **Impact** : `inventory.transfer.dispatch`, `inventory.transfer.move_internal`, `inventory.transfer.decline` (motif exigé, ajouté à la note du demandeur) ; SM-TRANSFER ; matrice des conflits ; contrat (avertissement `TRANSFER_REQUEST_CLOSED`) ; test `p5-stock-guards.test.ts`. Défaut implémenté : (a) (P5-23). Non paramétrable.

### AV-224 — Opération de caisse datée entre deux sessions, appliquée après l'ouverture de la suivante — IMPORTANTE
- **Question** : Une opération d'une caisse de PDV (remise, vente, encaissement, inverse) datée après la clôture d'une session et avant l'ouverture de la suivante, synchronisée **après** cette ouverture, ne tombe dans aucune session. Que devient l'écart d'ouverture de la session suivante, calculé sans elle ?
- **Pourquoi** : revue adverse de P5-23 (12/10/2026), cas de la routine de WF-15 §5 avec deux tablettes. ADR-032 §4 fige l'écart d'ouverture (fonds compté − solde du registre à l'ouverture) ; la réévaluation par le delta (§6) ne couvre que les fenêtres des sessions closes. La remise synchronisée après l'ouverture était donc comptée deux fois : manque imputé à l'ouvreur (AV-170) et alerte critique, registre négatif (sorties en ligne refusées `CASH_INSUFFICIENT`), puis surplus à l'ouverture d'après ; l'état final dépendait de l'ordre de synchronisation. AV-167 et AV-186 n'acceptaient que le cas où l'opération est connue avant l'ouverture. **DÉDUIT**.
- **Choix** : (a) l'écart d'ouverture de la **première session ouverte après l'opération** est corrigé : delta = −montant signé, mouvement `SESSION_VARIANCE` daté de l'ouverture, ajustement de cause `LATE_BEFORE_OPENING` ; traitement : inclus dans la validation si la session est ouverte ou à valider (une session qui en porte un en attente ne se valide jamais d'office), demande `CASH_VARIANCE` propre si elle est validée ; conflit `CASH_SESSION_REEVALUATED` pour la Finance ; jamais compté dans l'écart de clôture (INV-FIN-11) ; (b) rattacher l'opération à la session précédente (fenêtre prolongée jusqu'à l'ouverture suivante) ; (c) inchangé, l'écart se corrige à l'ouverture d'après.
- **Recommandation** : (a) : l'ouvreur n'est jamais tenu d'un manque qui n'existe pas, et les deux ordres de synchronisation laissent le même registre ; (b) changerait la définition de la fenêtre (ADR-032 §3) et l'écart d'une session déjà close.
- **Impact** : `recordCashMovement` (`reevaluateNextOpening`), `finance_cash_session_adjustments.cause` (migration `20261012100000`), clôture (écart d'ouverture effectif, validation exigée), `verifyCashSessions`, `verifyCashSessionVariance`, `postedVarianceXaf` ; D05 §15 ; INV-FIN-05, INV-FIN-11 ; test `p5-cash-opening-gap.test.ts` (les deux ordres). Défaut implémenté : (a) (P5-23). Non paramétrable.

### AV-225 — Résolution manuelle du signal d'une commande bloquée : la commande reste-t-elle rejouable ? — IMPORTANTE
- **Question** : L'Admin résout le signal `SYNC_COMMAND_STALLED` d'une commande qui ne se règle pas (AV-217) — en gardant l'état du serveur, ou après avoir fait ressaisir le fait par d'autres documents. La commande, toujours `FAILED_RETRYABLE` dans l'inbox, doit-elle encore pouvoir s'appliquer si sa cause disparaît ?
- **Pourquoi** : revue adverse de P5-23 (12/10/2026) : `sync.conflict.resolve` ne fermait que le conflit ; la commande restait reprise au renvoi identique et s'appliquait une fois sa dépendance arrivée — double comptage si le fait avait été ressaisi, fait « écarté » appliqué quand même. Si la cause persistait, le renvoi suivant rouvrait un signal : la résolution n'avait aucun effet durable. **DÉDUIT**.
- **Choix** : (a) la résolution du signal **écarte la commande** : sa ligne d'inbox passe `REJECTED` (`COMMAND_DISCARDED`, motif de l'Admin) sous le verrou de l'inbox, pris avant celui du conflit (ordre du pipeline, ADR-038) ; le renvoi suivant reçoit ce refus définitif (l'appareil cesse de la renvoyer) ; décision humaine tracée, hors BR-SYN-007 ; (b) refuser la résolution manuelle du signal, qui ne se ferme qu'avec la commande ; (c) inchangé.
- **Recommandation** : (a) : un fait n'est compté qu'une fois, et l'Admin dispose d'une issue.
- **Impact** : `sync.conflict.resolve` (`sync/conflict-commands.ts`), contrat (`COMMAND_DISCARDED`), 02-synchronisation §3.3, matrice des conflits ; test `sync-push-protocol.test.ts`. Défaut implémenté : (a) (P5-23). Non paramétrable.


### AV-226 — Tolérance de date future du pipeline — SECONDAIRE
- **Question** : La tolérance au-delà de laquelle une date de fait postérieure à l'heure serveur est rejetée (`OCCURRED_AT_FUTURE`, INV-GLO-02) est-elle un paramètre, et lequel ?
- **Pourquoi** : étude d'AV-216 (P5-23, 13/10/2026) : la tolérance était une constante de 5 min dans le pipeline (`OCCURRED_AT_FUTURE_TOLERANCE_MS`), seuil métier codé en dur contraire à la règle 8 du CLAUDE.md ; BR-SYN-011 et ADR-016 la rapprochent du seuil d'horloge suspecte. **DÉDUIT**.
- **Choix** : (a) constante ; (b) même clé que le drapeau (`sync.clock_skew_flag_minutes`) ; (c) clé propre `sync.occurred_at_future_tolerance_minutes`, défaut 5.
- **Recommandation** : (c) : élargir le drapeau (informatif) ne doit pas élargir une fenêtre de rejet.
- **Impact** : pipeline (étape de date future, lecture seulement quand la date corrigée dépasse l'heure serveur ; `futureToleranceMsFrom` : minutes ≥ 0, repli 5 min), seed, dictionnaire 02-organization, BR-SYN-011, ADR-016. Défaut implémenté : (c) (P5-23). Test : `sync-clock-skew-setting.test.ts`.

### AV-227 — Écart d'horloge hors des bornes de stockage — SECONDAIRE
- **Question** : Que faire d'un écart d'horloge supérieur à ce que stockent `sync_command_inbox.clock_skew_ms` et `sync_device_sync_state.last_clock_skew_ms` (`INT`, ±2 147 483 647 ms, ≈ 24,8 jours) ?
- **Pourquoi** : étude d'AV-216 (P5-23) : `device_sent_at` n'est borné que par son format ; une tablette remise à une date lointaine (batterie vidée, horloge à l'an 2000) faisait échouer l'insertion de l'inbox sous `STRICT_TRANS_TABLES`, et tout son lot était en erreur à chaque renvoi. **CONFIRMÉ** par le test (écart de 40 jours).
- **Choix** : (a) borner l'écart à ±INT_MAX avant stockage et réponse (le drapeau reste levé) ; (b) colonnes en `BIGINT`.
- **Recommandation** : (a), sans migration supplémentaire : au-delà de 24 jours, la valeur exacte n'apporte rien.
- **Impact** : `clampClockSkewMs` (domaine), service d'envoi, pipeline ; dictionnaire 11. Défaut implémenté : (a) (P5-23). Test : `sync-clock-skew-setting.test.ts`.

### AV-228 — Fait saisi par un appareil encore en attente d'approbation — IMPORTANTE
- **Question** : Une opération saisie sur un appareil `PENDING` (première connexion, BR-ADM-005), poussée avant ou après son approbation, est-elle appliquée, mise en quarantaine, ou mise en attente ?
- **Pourquoi** : revue de P5-23 (13/10/2026, étude d'AV-212). Le contrôle d'appareil comparait seulement `status_changed_at` (la date d'enrôlement) : poussée pendant l'attente, l'opération finissait en `CONFLICT DEVICE_REVOKED` **définitif** (perdue, à ressaisir), sauf horloge en retard ; poussée après l'approbation, elle était appliquée ; après un refus (`block` depuis `PENDING`), une opération antérieure au refus était appliquée, alors que l'appareil n'a jamais été approuvé. Le sort dépendait d'une course entre l'envoi et l'approbation ; la PWA n'interdit pas la saisie sur un appareil en attente. **CONFIRMÉ** pour le constat (lecture et test) ; le choix est **À VALIDER**.
- **Choix** : (a) comportement antérieur ; (b) quarantaine de tout fait daté pendant l'attente (BR-ADM-005 à la lettre ; perte des premières ventes d'un appareil neuf) ; (c) **attente** : tant que l'appareil est `PENDING`, la commande reçoit `RETRY_LATER` (`DEVICE_PENDING`, non définitif) et s'applique au renvoi qui suit l'approbation ; un appareil refusé sans avoir été approuvé (`approved_by` vide) met toutes ses commandes en quarantaine.
- **Recommandation** : (c) : l'approbation vaut caution de l'appareil, rien n'est appliqué avant elle, et rien n'est perdu (BR-SYN-007) ; au-delà de `sync.retry_hold_minutes`, le signal `SYNC_COMMAND_STALLED` prévient l'Admin qu'un appareil attend.
- **Impact** : `checkDeviceActive` (raison `DEVICE_PENDING`, `approved_by` lu), pipeline (étape appareil → `retryLater`), contrats (`DEVICE_PENDING`), 02-synchronisation §3.3, BR-ADM-005, SM-DEVICE ; aide de test `insertTestDevice` (un appareil hors service a un approbateur). PWA : bandeau d'attente d'approbation avec le code court de l'appareil livré en MP-06 (13/10/2026). Défaut implémenté : (c) (P5-23). Non paramétrable. Tests : `identity-lifecycle.test.ts`, `device-check.test.ts`.

### AV-229 — Utilisateur suspendu puis réactivé : fenêtre de quarantaine — IMPORTANTE
- **Question** : Une opération datée pendant la suspension d'un utilisateur, poussée après sa réactivation, est-elle mise en quarantaine ?
- **Pourquoi** : même défaut qu'AV-212 côté utilisateur (étude de P5-23, 13/10/2026) : `checkUserActive` (`identity/application/public/user-check.ts`) ne lit que le statut courant et `status_changed_at`, que la réactivation réécrit ; BR-ADM-002 et AT-034 ne sont garantis que tant que l'utilisateur reste suspendu. **DÉDUIT** (lecture, non testé).
- **Choix** : (a) inchangé ; (b) table jumelle des périodes de suspension closes (même mécanisme qu'AV-212, `closeOutOfServicePeriod` généralisé) ; (c) date de réception.
- **Recommandation** : (b), avant la mise en production (P10 au plus tard).
- **Impact** : `identity` (migration, `user-commands.ts`, `user-check.ts`) ; SM-USER ; AT-034. Défaut implémenté : (a). Non paramétrable.


### AV-230 — Quotas actifs d'un emplacement de vente qui passe en garde exclusive — SECONDAIRE
- **Question** : Quand un PDV passe son emplacement de vente de la garde partagée à la garde exclusive d'un appareil (`organization.pos.configure`, `EXCLUSIVE_DEVICE`), que deviennent les quotas d'appareil encore actifs sur cet emplacement ?
- **Pourquoi** : AV-195 (1), étude de P5-23 (13/10/2026). Un emplacement exclusif ne consomme aucun quota (`prepareQuotaConsumption`) ; le quota restait `ACTIVE`, jamais plus consommé, mais retranchait toujours son reste du stock libre (INV-STK-19 signalé sans conflit qui l'explique). **CONFIRMÉ** (lecture et test).
- **Choix** : (a) refuser la configuration tant qu'un quota est actif (`POS_ALLOCATIONS_ACTIVE`) : le responsable le libère ou le révoque d'abord, avec sa permission et son motif ; (b) révoquer d'office les quotas au passage en garde exclusive (événement par quota, motif `POS_CUSTODY_CHANGED`, permission à trancher) ; (c) inchangé.
- **Recommandation** : (a) : la révocation reste une décision motivée d'un responsable (ADR-033 §9, le serveur ne révoque jamais seul) ; la commande est en ligne, le refus ne rejette aucun fait accompli (BR-SYN-007).
- **Impact** : `organization` (`PosConfigurationGuardRegistry`, `pos.configure` : emplacement de vente verrouillé en premier), `inventory` (`inventoryPosConfigurationGuard`, octroi : garde relue sous verrou partagé), INV-DIS-02, D05 §8 et §15, SM-ALLOCATION, ADR-038 (résidus). Défaut implémenté : (a) (P5-23). Non paramétrable. Tests : `organization-pos-config.test.ts`, `inventory-allocation-commands.test.ts` (octroi concurrent), `p5-invariants.test.ts` (INV-DIS-02). PWA : l'écran d'administration du PDV doit lister les quotas à fermer avant de réessayer.

### AV-231 — Sorties de stock hors ligne au-delà du quota du détenteur ou du solde d'un emplacement exclusif — IMPORTANTE
- **Question** : Hors ligne, au-delà du quota du détenteur (emplacement partagé) ou du solde d'un emplacement exclusif, faut-il refuser sur l'appareil toutes les sorties de stock, ou seulement certaines ?
- **Pourquoi** : BR-STK-013 dit que l'appareil « refuse toute consommation au-delà de son allocation ou du solde de son emplacement exclusif » (vente, perte, transfert sortant, consommation) ; AV-025 ne tranche que la vente ; le fork signalait jusqu'ici la perte hors ligne au-delà du disponible (F-10, F-14, BR-STK-018), parce qu'une casse constatée existe qu'on la refuse ou non. **DÉDUIT** (fork « Écrans PWA », phase des écrans de P5, reporté à la fusion le 13/10/2026 ; numéro de fork 303).
- **Choix** : (a) tout refuser (lettre de BR-STK-013) ; (b) refuser les sorties décidées (vente, consommation, expédition) et seulement signaler la perte ; (c) tout signaler.
- **Recommandation** : (b).
- **Impact** : une perte réelle refusée hors ligne attendrait le réseau pour être déclarée, et le stock local resterait faux d'ici là. Défaut implémenté : (b) : `OFFLINE_LOSS_GUARD = 'SIGNAL'` (`apps/pwa/src/features/sales/quota.ts`), `'BLOCK'` pour (a).

### AV-232 — Comptage de la caisse à l'aveugle — IMPORTANTE
- **Question** : Comptage de la caisse à l'aveugle : l'attendu (indicatif sur l'appareil, D05 §12) s'affiche-t-il avant la saisie du comptage ?
- **Pourquoi** : D05 §12 prévoit un attendu indicatif calculé sur l'appareil, sans dire quand le montrer ; affiché avant le comptage, il invite à « trouver » l'attendu plutôt qu'à compter, et un écart réel passerait inaperçu (RC-03). **DÉDUIT** (fork « Écrans PWA », phase des écrans de P5, reporté à la fusion le 13/10/2026 ; numéro de fork 304).
- **Choix** : (a) à l'aveugle, attendu et écart affichés après l'enregistrement du comptage (serveur dès sa réponse, sinon indicatif) ; (b) attendu indicatif affiché sur le formulaire.
- **Recommandation** : (a).
- **Impact** : avec (b), l'écart d'une clôture tend vers zéro sans refléter la caisse. Défaut implémenté : (a) : `CASH_COUNT_BLIND = true` (`apps/pwa/src/features/cash/cash-session.ts`), `false` pour (b).

### AV-233 — Encaissement en espèces au PDV sans caisse ouverte sur l'appareil — IMPORTANTE
- **Question** : Encaissement en espèces au PDV sans caisse ouverte sur l'appareil : bloquer, avertir ou proposer « Ouvrir la caisse » ?
- **Pourquoi** : BR-DIS-005 veut que l'écran « propose d'abord Ouvrir la caisse » ; en ligne le serveur refuse (`CASH_SESSION_REQUIRED`) ; hors ligne il applique le fait et ouvre `CASH_SESSION_MISSING` (AV-184, BR-SYN-007). **DÉDUIT** (fork « Écrans PWA », phase des écrans de P5, reporté à la fusion le 13/10/2026 ; numéro de fork 305).
- **Choix** : (a) invite dès l'ouverture de l'écran, blocage en ligne, enregistrement signalé hors ligne ; (b) blocage hors ligne aussi ; (c) simple avertissement partout.
- **Recommandation** : (a).
- **Impact** : (b) empêcherait une vente réelle quand la caisse a été oubliée, (c) laisserait partir en ligne une vente que le serveur refuse. Défaut implémenté : (a) : `OFFLINE_CASH_WITHOUT_SESSION = 'WARN'` (`apps/pwa/src/features/cash/cash-session.ts`), `'BLOCK'` pour (b).

### AV-234 — Demande de réapprovisionnement d'un PDV sans source configurée — SECONDAIRE
- **Question** : PDV sans source de réapprovisionnement configurée (`replenishment_source_location_id` nul) : la demande est-elle possible ?
- **Pourquoi** : la source d'une demande est celle du PDV (WF-05), mais le champ est facultatif et le serveur n'impose que `source ≠ destination`. **DÉDUIT** (fork « Écrans PWA », phase des écrans de P5, reporté à la fusion le 13/10/2026 ; numéro de fork 306).
- **Choix** : (a) le vendeur choisit un magasin (`STORE` actif) ; (b) la demande attend la configuration du PDV.
- **Recommandation** : (a).
- **Impact** : (b) bloque le réapprovisionnement d'un PDV mal configuré ; (a) peut viser un magasin qui ne sert pas ce PDV. Défaut implémenté : (a) : `REPLENISH_WITHOUT_SOURCE = 'CHOOSE'` (`apps/pwa/src/features/distribution/replenish.ts`), `'BLOCK'` pour (b).

### AV-235 — Demandes de réapprovisionnement en double vers un PDV — SECONDAIRE
- **Question** : Demandes en double vers un PDV (deux téléphones, même produit) : bloquer ou annoncer ?
- **Pourquoi** : rien n'empêche deux vendeurs d'un PDV partagé de demander le même produit ; le serveur ne contrôle pas les doublons. **DÉDUIT** (fork « Écrans PWA », phase des écrans de P5, reporté à la fusion le 13/10/2026 ; numéro de fork 307).
- **Choix** : (a) annoncer le déjà demandé (rappel sous le produit, suggestion diminuée) sans bloquer ; (b) refuser un produit déjà demandé.
- **Recommandation** : (a), le magasinier arbitre à l'expédition.
- **Impact** : (b) empêcherait un complément légitime ; (a) laisse au magasin le soin de ne pas expédier deux fois. Défaut implémenté : (a) : `DUPLICATE_REQUEST = 'ANNOUNCE'` (`apps/pwa/src/features/distribution/replenish.ts`), `'BLOCK'` pour (b).

### AV-236 — Ventes et encaissé du jour de l'accueil du PDV — SECONDAIRE
- **Question** : Ventes et encaissé du jour de l'accueil du PDV : quelle source ?
- **Pourquoi** : l'accueil doit fonctionner hors ligne (ECR-DIS-01 : Oui) ; le serveur calcule le vendu et l'encaissé du jour pour tous les téléphones (tableau, ECR-DIS-04), mais l'appareil ne connaît que ses ventes et le jeu `sales_recent` du site ; AV-200 et AV-209 notent déjà un écart entre l'accueil et le tableau. **DÉDUIT** (fork « Écrans PWA », phase des écrans de P5, reporté à la fusion le 13/10/2026 ; numéro de fork 308).
- **Choix** : (a) ce que connaît le téléphone (ventes du jour sur l'emplacement de vente, annulées exclues, encaissé avec ces ventes), annoncé comme tel ; (b) lecture en ligne du tableau, rien hors ligne.
- **Recommandation** : (a), avec le renvoi au tableau pour le chiffre complet.
- **Impact** : sur un PDV partagé, le chiffre de (a) manque les ventes des autres téléphones pas encore synchronisées. Défaut implémenté : (a) (`todaySales`, `apps/pwa/src/features/distribution/pos-home.ts`) ; (b) reste accessible par le lien du tableau. L'encaissé est celui qui est affecté à ces ventes, quelle que soit sa date (acompte reporté sur la vente d'une commande confirmée, règlement ultérieur) ; le tableau donne l'encaissé du jour (BR-DIS-010) (F-70).

### AV-237 — Libération des quotas sur l'appareil — IMPORTANTE
- **Question** : Libération des quotas : quel écran, quel déclencheur, quel reste ?
- **Pourquoi** : SM-ALLOCATION fait émettre la libération par l'appareil détenteur après l'échéance, WF-18 étape 4 la veut en fin de journée, aucun écran de l'inventaire ne l'héberge (ECR-STK-06 est « hors ligne : Non ») ; le serveur ferme le quota sur son propre reste et signale un écart (`ALLOCATION_RELEASE_MISMATCH`). **DÉDUIT** (fork « Écrans PWA », phase des écrans de P5, reporté à la fusion le 13/10/2026 ; numéro de fork 309).
- **Choix** : (a) bouton par quota sur l'accueil du PDV, confirmé, reste calculé par l'appareil (net de ses sorties en attente), quota échu signalé « à libérer » ; (b) libération automatique à l'échéance, sans geste ; (c) reste saisi par le vendeur.
- **Recommandation** : (a).
- **Impact** : (b) libérerait sans que le vendeur sache ce qui reste ; (c) multiplierait les écarts de saisie. Défaut implémenté : (a) (`releasePayload`, `canRelease`, `apps/pwa/src/features/distribution/pos-home.ts`). Le reste déclaré suit la règle du serveur : seuls les faits antérieurs à l'échéance le réduisent, une annulation directe lui rend la quantité vendue (`quotaRemaining`, `apps/pwa/src/features/sales/quota.ts`). Bouton réservé aux rôles qui détiennent `inventory.allocation.release` (CTE, VEN). Limite : un quota sur un emplacement partagé qui n'est pas l'emplacement de vente d'un PDV, ou détenu par un commercial terrain, n'a pas encore d'écran de libération ; il se ferme par une révocation (ECR-STK-06) (F-70).

### AV-238 — Détenteurs proposés à l'octroi d'un quota — IMPORTANTE
- **Question** : Octroi d'un quota : parmi quels détenteurs choisir ?
- **Pourquoi** : l'octroi exige un couple (utilisateur, appareil) ; aucune lecture des utilisateurs ni des appareils n'est servie à l'appareil (S-28), le tableau ne donne les auteurs d'une tablette qu'avec `sync.monitor.read`. **DÉDUIT** (fork « Écrans PWA », phase des écrans de P5, reporté à la fusion le 13/10/2026 ; numéro de fork 310).
- **Choix** : (a) couples déjà détenteurs d'un quota sur l'emplacement (historique de `GET /allocations`) et l'utilisateur lui-même sur ce téléphone, jamais d'identifiant saisi ; (b) saisie libre des identifiants ; (c) attendre une lecture des utilisateurs et des appareils (S-28).
- **Recommandation** : (a) jusqu'à (c).
- **Impact** : (a) ne permet pas le premier octroi à un nouveau vendeur depuis l'écran ; (b) multiplie les refus `ALLOCATION_HOLDER_INVALID`. Défaut implémenté : (a) (`knownHolders`, `apps/pwa/src/features/stock/allocations.ts`). L'utilisateur lui-même n'est proposé que si son rôle peut libérer un quota (CTE, VEN) : sinon son quota ne se fermerait que par une révocation ; un couple dont un quota actif porte le signal de révocation n'est pas proposé ; l'historique est lu sur deux pages de 200 au plus, la liste est annoncée partielle au-delà (F-70).

### AV-239 — Remises de fonds sur l'appareil (UC-FIN-07) — IMPORTANTE
- **Question** : Remises de fonds sur l'appareil (UC-FIN-07) : quel écran, pour qui, sur quelles caisses ?
- **Pourquoi** : l'envoi, l'annulation et la réception d'une remise se font hors ligne (D09, UC-FIN-07 ; WF-15 étape 7), mais l'inventaire des écrans n'en prévoit aucun hors d'ECR-FIN-05, réservé à la Finance et en ligne ; les droits par compte ne sont pas servis à l'appareil. **DÉDUIT** (fork « Écrans PWA », phase des écrans de P5, reporté à la fusion le 13/10/2026 ; numéro de fork 311).
- **Choix** : (a) écran hors ligne « Remises de fonds » (`/caisse/remises`, code du cas d'usage) proposé aux détenteurs de `finance.cash_transfer.record` (RCO, CTE, CSE, VEN, RFE, FIN) : envoi depuis une caisse servie sans détenteur ou dont l'utilisateur est le détenteur, vers les destinations admises par les paires ; annulation motivée de ses propres remises en transit ; réception des remises en transit vers l'une de ces caisses, jamais des siennes, l'envoyé affiché, le reçu saisi et l'écart annoncé avant confirmation ; le serveur contrôle la portée (`CASH_ACCOUNT_FORBIDDEN`) ; (b) remises dans ECR-FIN-05 seulement ; (c) dans l'écran de caisse ECR-DIS-02.
- **Recommandation** : (a), avec un identifiant d'écran à créer dans l'inventaire.
- **Impact** : (b) empêche la remise hors ligne ; (c) l'interdit aux commerciaux et aux caisses personnelles. Défaut implémenté : (a) (`CashTransfersScreen`, `transfers.ts`, `apps/pwa/src/features/cash/`). Le solde d'une caisse de PDV suit le registre et le comptage à l'aveugle (AV-232) : il n'est montré qu'après une clôture comptée par l'utilisateur lui-même (F-74).

### AV-240 — Remise au-delà du solde indicatif de la caisse — SECONDAIRE
- **Question** : Remise au-delà du solde de la caisse : la bloquer sur l'appareil ?
- **Pourquoi** : le solde de l'appareil est indicatif (solde servi plus ses opérations en attente, sans celles des autres appareils) ; en ligne, le serveur refuse une sortie qui rendrait négative une caisse physique (`CASH_INSUFFICIENT`, BR-FIN-012) ; hors ligne, il l'applique et ouvre `CASH_NEGATIVE` pour la Finance (BR-SYN-007). **DÉDUIT** (fork « Écrans PWA », phase des écrans de P5, reporté à la fusion le 13/10/2026 ; numéro de fork 312).
- **Choix** : (a) signaler sans bloquer ; (b) bloquer au-delà du solde indicatif.
- **Recommandation** : (a).
- **Impact** : (b) refuserait une remise réelle quand le solde de l'appareil est en retard. Défaut implémenté : (a) (`overIndicativeBalance`) ; signalé seulement quand le solde est montré (F-74).

### AV-241 — Rôles de l'écran de trésorerie (ECR-FIN-05) — SECONDAIRE
- **Question** : Trésorerie (ECR-FIN-05) : pour quels rôles ?
- **Pourquoi** : l'inventaire la donne à la Finance ; la Direction détient aussi `finance.cash.read` (ALL) et `finance.cash_session.validate` (A·ALL), permission d'approbation des demandes `CASH_VARIANCE` et `CASH_TRANSFER_DISCREPANCY` (politiques semées), mais pas `finance.cash_transfer.record`. **DÉDUIT** (fork « Écrans PWA », phase des écrans de P5, reporté à la fusion le 13/10/2026 ; numéro de fork 313).
- **Choix** : (a) Finance et Direction, la Direction validant et décidant sans recevoir de remise ; (b) Finance seulement.
- **Recommandation** : (a) : une Finance qui a clôturé une caisse ou reçu une remise ne peut pas valider son propre écart (RC-03) ; sans la Direction, il faut un second utilisateur Finance.
- **Impact** : (b) laisse la Direction sans écran pour une validation qu'elle détient. Défaut implémenté : (a) (`ROLE_SETS.treasury`, `apps/pwa/src/app/screens.ts`).

### AV-242 — Lecture seule au-delà de l'autonomie hors connexion (AV-009) — IMPORTANTE
- **Question** : Lecture seule au-delà de l'autonomie hors connexion (AV-009) : quelle synchronisation fait foi, quel blocage ?
- **Pourquoi** : AV-009 fixe 7 jours puis la lecture seule et un bandeau dès 48 h (06-offline-sync §8), avec les paramètres `offline.max_autonomy_hours` et `offline.warning_hours` servis à l'appareil ; restent la mesure et la forme du blocage. **DÉDUIT** (fork « Écrans PWA », phase des écrans de P5, reporté à la fusion le 13/10/2026 ; numéro de fork 314).
- **Choix** : (a) durée depuis la dernière synchronisation complète (tous les jeux tirés, `last_sync_at`), à l'horloge de l'appareil ; au-delà, toute nouvelle opération refusée au point d'enregistrement unique (`submitCommand`), bandeau permanent, consultation et envoi de l'outbox intacts ; appareil jamais synchronisé non bloqué ; (b) mesurer depuis le dernier envoi accepté ; (c) fermer l'accès aux écrans de saisie.
- **Recommandation** : (a).
- **Impact** : une horloge reculée retarde la lecture seule (le serveur marque l'heure suspecte à la réception, `clock_suspect`) ; sous le bandeau, chaque écran garde son message d'échec d'enregistrement. Défaut implémenté : (a) (`autonomy.ts`, `AutonomyBanner.tsx`, `apps/pwa/src/features/sync/` ; garde dans `enqueueCommand`, chemin d'écriture unique, F-75 ; bandeau réévalué chaque minute et au retour au premier plan ; refus annoncé « rien n'a été enregistré » par les écrans qui l'interceptent, les autres gardant leur message d'échec d'enregistrement sous le bandeau).

### AV-243 — Fait hors ligne antérieur au rattachement de l'appareil à un autre site — SECONDAIRE
- **Question** : Un fait hors ligne d'un appareil, daté avant que l'appareil soit rattaché à un autre site (`identity.device.designate`), est-il signalé `DEVICE_OTHER_SITE` ?
- **Pourquoi** : étude d'AV-195 (P5-23, 13/10/2026) : la garde d'appareil lisait le rattachement courant (`designated_site_id`), sans date ; une tablette déplacée vers un autre site après avoir vendu hors ligne voyait ses ventes antérieures signalées à tort. **DÉDUIT** (lecture, puis test).
- **Choix** : (a) dater le dernier rattachement (`designation_changed_at`) et ne pas signaler un fait antérieur (signal omis plutôt que faux) ; (b) historique complet des rattachements, comme celui des gardes ; (c) inchangé.
- **Recommandation** : (a) : le signal est informatif, un rattachement change rarement, et le dernier suffit dans les cas observés ; (b) reste possible sans changer la règle.
- **Impact** : migration `20261013090300` (`identity_devices.designation_changed_at`), `identity.device.designate`, `custodyMismatch` ; ADR-040. Défaut implémenté : (a) (P5-23). Non paramétrable. Test : `inventory-allocation-consumption.test.ts`.

### AV-244 — Encaissé : remboursements et doublons approuvés — SECONDAIRE
- **Question** : L'encaissé d'une période (KPI-FIN-01) retranche-t-il les remboursements faits dans la période ? Un encaissement mis de côté comme doublon, puis approuvé, compte-t-il à sa date d'origine ou à celle de la décision ?
- **Pourquoi** : D11 définit l'encaissé comme « encaissements confirmés dans P − annulations dans P » sans citer les remboursements ; un remboursement (`sales.payment.refund`) est une sortie de trésorerie rattachée à l'encaissement (`refunded_xaf`), pas une annulation. Un doublon approuvé reçoit un mouvement de trésorerie daté de son `occurred_at` d'origine. Relevé en alignant l'accueil et le tableau (P5-23, AV-200). **DÉDUIT**.
- **Choix** : (a) remboursements non retranchés, lus dans la trésorerie (KPI-FIN-06) ; doublon approuvé compté à sa date d'origine, comme son mouvement de trésorerie ; (b) remboursements retranchés à leur date (encaissé net) ; (c) doublon approuvé compté à la date de la décision.
- **Recommandation** : (a) : l'encaissé reste une recette, comparable à l'attendu de caisse ; une colonne « remboursé » pourra s'ajouter au tableau sans changer la définition.
- **Impact** : (a) : le chiffre d'un jour passé change quand un doublon de ce jour est approuvé plus tard. `sales/application/public/period-activity.ts` (`cashedActivity`) ; [ADR-041](decisions/ADR-041-activite-par-periode-accueil-et-tableau.md). Défaut implémenté : (a) (P5-23). Non paramétrable.

### AV-245 — Chiffre d'affaires d'un PDV : site entier (accueil) ou emplacement de vente (tableau) — SECONDAIRE
- **Question** : Le chiffre d'affaires d'un PDV porte-t-il sur tout le site ou sur son seul emplacement de vente ?
- **Pourquoi** : l'accueil d'un rôle de site (vendeur de PDV, magasinier) compte les ventes de tout le site (ADR-030 §5) ; le tableau de distribution compte le vendu de l'emplacement de vente du PDV, qu'il rapproche du stock (BR-DIS-010, AV-199). Les deux suivent la même définition depuis P5-23 (ADR-041), mais un site qui vend aussi depuis un autre emplacement (magasin arrière, second comptoir) affiche deux chiffres. Ce ne sont pas deux valeurs pour un même périmètre (BR-ANA-009), mais un lecteur peut s'en étonner. L'encaissé, lui, est celui du site dans les deux écrans. **DÉDUIT** (P5-23, test).
- **Choix** : (a) garder les deux périmètres, sous des libellés distincts (« chiffre du site », « vendu du PDV ») ; (b) étendre le vendu du tableau à tous les emplacements du site, hors rapprochement ; (c) réduire l'accueil à l'emplacement de vente.
- **Recommandation** : (a) : le rapprochement du tableau n'a de sens que sur l'emplacement dont il suit le stock ; l'accueil répond à « combien le site a-t-il vendu ».
- **Impact** : libellés de la PWA (fork « Écrans PWA ») ; aucune donnée. Défaut implémenté : (a) (P5-23). Non paramétrable. Test : `p5-distribution-metrics.test.ts` (vente d'un autre emplacement du site, comptée par l'accueil, pas par le tableau).

### AV-246 — Réception d'achat au-delà du seuil de photo, tant que l'application ne joint pas de photo — IMPORTANTE — **TRANCHÉ**
- **Question** : BR-APP-014 exige la photo du bon de livraison au-delà de `procurement.receipt_photo_threshold_xaf` (100 000 XAF) ; la PWA ne sait pas encore joindre de photo. Que fait une réception de cette valeur ?
- **Pourquoi** : vérification des écrans (13/10/2026) : la réception de 480 kg d'aliment (168 000 XAF) est refusée `PHOTO_REQUIRED` ; aucune livraison fournisseur importante n'est réceptionnable depuis l'application. **CONFIRMÉ** (navigateur).
- **Choix** : (a) acceptée et marquée « photo manquante », signalée aux Achats pour régularisation ; (b) seuil relevé tant que la photo n'existe pas ; (c) refus maintenu.
- **Recommandation** : (a).
- **Décision** (porteur du projet, 13/10/2026) : (a). La réception est appliquée en ligne comme hors ligne, avec l'avertissement `RECEIPT_PHOTO_MISSING` et un signal pour les Achats ; la photo jointe plus tard la régularise (MP-10). Précise BR-APP-014 et AV-037 pour la période sans photo.
- **Impact** : `procurement.receipt.record` (P6), signal de l'accueil et du suivi des réceptions ; lot de mise en pilote (MP-04).

### AV-247 — Approbation d'un appareil neuf par un responsable : quelle portée ? — IMPORTANTE — **TRANCHÉ**
- **Question** : AV-006 (c) permet l'approbation par un responsable, et `identity.device.approve` est semée en portée SITE ou TEAM ; un appareil `PENDING` n'a pourtant encore ni site ni équipe. Quels appareils un responsable voit-il et approuve-t-il ?
- **Pourquoi** : vérification des écrans (13/10/2026) : aucun écran n'approuve un appareil ; la portée doit être définie pour ECR-ADM-05. **DÉDUIT**.
- **Choix** : (a) portée déduite des affectations actives de l'utilisateur qui a connecté l'appareil (`enrolled_by_user_id`) : site, zone, équipe ; (b) Admin seul.
- **Recommandation** : (a).
- **Décision** (porteur du projet, 13/10/2026) : (a), avec l'Admin toujours habilité.
- **Impact** : lecture `GET /devices`, commandes `identity.device.*` (contrôle de portée), écran ECR-ADM-05 ; lot de mise en pilote (MP-06).
- **Mise en œuvre** (MP-06) : `device-scope.ts` (`enrollerLocators`, `deviceInScope`), partagé par `GET /devices` et les commandes `identity.device.*` (`FORBIDDEN_SCOPE`) ; précisé par AV-258 à AV-260.

### AV-248 — Motifs de départ : résultats de visite, perte d'un prospect, annulation — IMPORTANTE — **TRANCHÉ**
- **Question** : quelles listes de motifs fournir à l'installation pour `VISIT_OUTCOME`, `PROSPECT_LOST` et `CANCELLATION` ?
- **Pourquoi** : vérification des écrans (13/10/2026) : sans résultat de visite (BR-CRM-012, obligatoire), aucune visite n'est possible sur une base neuve ; S-15. **CONFIRMÉ** (navigateur).
- **Choix** : (a) listes proposées ; (b) résultats de visite seulement ; (c) aucune, saisie par l'administrateur.
- **Recommandation** : (a).
- **Décision** (porteur du projet, 13/10/2026) : (a). Visite : `COMMANDE_PRISE` (code figé, lu par KPI-COM-12), `VENTE_REALISEE`, `A_RELANCER`, `PAS_INTERESSE`, `ABSENT`, `AUTRE`. Prospect perdu : `PRIX_TROP_ELEVE`, `CONCURRENT`, `PAS_DE_BESOIN`, `INJOIGNABLE`, `HORS_ZONE`, `AUTRE`. Annulation : `ERREUR_SAISIE`, `DOUBLON`, `DEMANDE_CLIENT`, `AUTRE`. `AUTRE` exige un commentaire ; libellés ajustables au catalogue.
- **Impact** : `db/seeds` (rejouable : insertion des seuls absents, jamais de réécriture d'un motif modifié), publication dans `catalog` ; S-15 ; lot de mise en pilote (MP-02).
- **Mise en œuvre** (MP-09, 14/10/2026) : le commentaire d'un résultat de visite qui l'exige (`requires_comment`, « Autre ») n'était contrôlé nulle part. Visite : la PWA bloque l'envoi sans commentaire (libellé « obligatoire pour ce résultat ») ; le serveur refuse en ligne (`COMMENT_REQUIRED`) et accepte hors ligne (fait accompli, BR-SYN-007, comme un motif désactivé entre-temps ; **DÉDUIT**). Prospect perdu : déjà refusé par le serveur (BR-CRM-009), sans écran dans la PWA. Annulation d'une vente ou d'une commande : déjà exigé par la PWA.
- **Mise en œuvre** (MP-11, 15/10/2026, revue adverse) : la décision (« désactivables », « libellés ajustables ») n'avait aucune commande. `catalog.reason_code.update` (libellé, commentaire exigé), `.deactivate` et `.reactivate` (`catalog.reference.manage`, nouvelle version publiée dans `catalog`, aucune suppression, BR-CAT-010) ; écran du catalogue : « Modifier », « Désactiver », « Réactiver » sur chaque motif. Le code et la catégorie ne changent jamais.

### AV-249 — Affichage des unités dans la PWA — SECONDAIRE — **TRANCHÉ**
- **Question** : comment afficher une quantité et son unité (« 27 PLATEAU » aujourd'hui) ?
- **Pourquoi** : vérification des écrans (13/10/2026) : les codes d'unité s'affichent tels quels sur une vingtaine d'écrans (contournement S-07). **CONFIRMÉ** (navigateur).
- **Choix** : (a) libellés courts au singulier et au pluriel dans la PWA pour les codes connus, repli sur le nom du catalogue puis sur le code ; (b) nom du catalogue tel quel ; (c) abréviations saisies au catalogue (migration).
- **Recommandation** : (a).
- **Décision** (porteur du projet, 13/10/2026) : (a), sans changement de la base (« 27 plateaux », « 1 pièce », « 500 kg », « 12 têtes »).
- **Impact** : fonction unique de formatage dans la PWA et ses appels ; lot de mise en pilote (MP-09).
- **Mise en œuvre** (MP-09, 14/10/2026) : `unitLabel` et `formatQuantityUnit` (`apps/pwa/src/features/sales/format.ts`) ; libellés courts de TETE, OEUF, PIECE, KG, G, L, SAC, PLATEAU, CARTON, DOSE (pluriel à partir de 2, symboles invariables) ; repli sur le nom de l'unité publiée dans le jeu `catalog`, puis sur le code ; une quarantaine d'écrans convertis (quantités, libellés de champ, sélecteurs) ; un message à plusieurs nombres porte l'unité sur chaque nombre ; l'écran d'administration du catalogue garde les codes.

### AV-250 — Diagnostic « Tester la synchronisation » de l'application livrée — SECONDAIRE — **TRANCHÉ**
- **Question** : garder le bouton qui enregistre un paramètre système de test (`organization.setting.set`) ?
- **Pourquoi** : les versions de paramètres sont immuables (BR-ADM-015) : chaque essai pollue définitivement les paramètres ; un navigateur dont l'appareil n'est pas approuvé renvoyait ce test toutes les 30 s depuis des jours (vérification des écrans, 13/10/2026). **CONFIRMÉ**.
- **Choix** : (a) réservé à l'administrateur ; (b) remplacé par un test sans écriture ; (c) retiré.
- **Recommandation** : (b).
- **Décision** (porteur du projet, 13/10/2026) : (c), retiré de l'application ; l'écran de synchronisation garde « Forcer la synchronisation » et les listes d'opérations.
- **Impact** : écran ECR-SYN-01 ; lot de mise en pilote (MP-09).
- **Mise en œuvre** (MP-09, 14/10/2026) : diagnostic, textes et test retirés de `SyncScreen.tsx` ; les commandes de diagnostic déjà en attente dans un navigateur y restent (rien ne disparaît, BR-SYN-013) et s'appliqueraient si l'appareil était approuvé : à vérifier sur le poste du porteur en MP-11.

### AV-251 — Changement du mot de passe provisoire — IMPORTANTE — **TRANCHÉ**
- **Question** : un compte créé ou réinitialisé avec un mot de passe provisoire (`must_change_password`) doit-il être bloqué tant qu'il ne l'a pas changé ?
- **Pourquoi** : la PWA reçoit `must_change_password` à la connexion sans le lire ; aucun écran de changement n'existe (vérification des écrans, 13/10/2026). **CONFIRMÉ**.
- **Choix** : (a) refus serveur de toute opération (`PASSWORD_CHANGE_REQUIRED`) et écran de changement ; (b) écran de changement imposé par la PWA seulement.
- **Recommandation** : (a).
- **Décision** (porteur du projet, 13/10/2026) : (b), différente de la recommandation : la PWA affiche l'écran de changement juste après la connexion et n'ouvre rien d'autre avant ; le serveur ne refuse rien.
- **Impact** : écran de changement du mot de passe, route de changement ; lot de mise en pilote (MP-08).

### AV-252 — Réinitialisation du mot de passe d'un utilisateur par l'administrateur — IMPORTANTE — **TRANCHÉ**
- **Question** : la réinitialisation par l'Admin (02-securite.md) génère-t-elle le mot de passe provisoire ou le fait-elle saisir ?
- **Pourquoi** : la réinitialisation n'existe pas ; un utilisateur qui oublie son mot de passe est bloqué (vérification des écrans, 13/10/2026). **DÉDUIT**.
- **Choix** : (a) généré par le serveur, affiché une fois ; (b) saisi par l'administrateur.
- **Recommandation** : (a).
- **Décision** (porteur du projet, 13/10/2026) : (b), différente de la recommandation. Le mot de passe saisi ne transite que par une route en ligne hors du journal des commandes, n'est ni journalisé ni audité en clair, révoque les sessions de l'utilisateur et pose `must_change_password` (AV-251).
- **Impact** : route de réinitialisation, écran d'administration des utilisateurs ; lot de mise en pilote (MP-08).

### AV-253 — Connexion depuis un appareil bloqué, perdu ou retiré — IMPORTANTE — **TRANCHÉ**
- **Question** : après un mot de passe correct, faut-il dire à l'utilisateur que son appareil est bloqué, perdu ou retiré, ou que son compte est suspendu ?
- **Pourquoi** : aujourd'hui tout répond « Identifiants invalides », même avec le bon mot de passe (vérification des écrans, 13/10/2026). **CONFIRMÉ** (code).
- **Choix** : (a) message distinct pour l'appareil, générique pour le compte ; (b) générique dans tous les cas.
- **Recommandation** : (a).
- **Décision** (porteur du projet, 13/10/2026) : (a). « Cet appareil est bloqué (perdu, retiré) : contactez votre responsable » ; un compte suspendu ou désactivé garde le message générique, le motif est écrit dans l'audit.
- **Impact** : `POST /auth/login` (code d'erreur distinct), écran de connexion ; lot de mise en pilote (MP-05).

### AV-254 — Approbation du premier appareil d'administration d'une installation neuve — IMPORTANTE — **TRANCHÉ**
- **Question** : sur une installation neuve, personne ne peut approuver le premier téléphone de l'administrateur depuis l'application. Comment l'approuver ?
- **Pourquoi** : ECR-ADM-05 (MP-06) exige un appareil actif ; l'amorçage n'est couvert ni par AV-006 ni par AV-228. **DÉDUIT**.
- **Choix** : (a) commande d'installation sur le serveur, avec le code court de l'appareil ; (b) exception d'amorçage dans l'application.
- **Recommandation** : (a).
- **Décision** (porteur du projet, 13/10/2026) : (a). Commande `pnpm run db:approve-device -- <code court>` (acteur système, `approved_by`, audit), documentée dans le runbook de mise en service.
- **Impact** : script d'exploitation, runbook ; lot de mise en pilote (MP-06).
- **Mise en œuvre** (MP-06) : `apps/server/scripts/approve-device.ts` et `bootstrap-device-approval.ts` (gardes : code de 4 caractères, appareil en attente, utilisateur administrateur) ; mise en service : `db/README.md` §5.

### AV-255 — Ventes signalées de l'accueil : quels drapeaux comptent comme anomalie ? — SECONDAIRE
- **Question** : le signal « N ventes du jour portent une anomalie » compte toute vente dont la liste de drapeaux est non vide, y compris `OUT_OF_SESSION` (déjà couvert par le signal de prise de service). Faut-il distinguer les drapeaux informatifs des drapeaux de contrôle ?
- **Pourquoi** : vérification des écrans (13/10/2026) : quatre ventes signalées pour la seule absence de prise de service, avec un texte générique (prix, stock, vente anonyme) qui ne nomme pas la cause et sans lien vers les ventes. **CONFIRMÉ**.
- **Choix** : (a) tous comptés, ventilés par type dans le détail, gravité « avertissement » pour les seuls drapeaux de contrôle (prix, stock, crédit, caisse), lien vers les ventes ; (b) drapeaux informatifs exclus du signal.
- **Recommandation** : (a).
- **Impact** : `home-service.ts` (signal `SALES_FLAGGED`), PWA. Défaut retenu pour le lot de mise en pilote : (a) (MP-09). Non paramétrable.
- **Mise en œuvre** (MP-09, 14/10/2026) : `flaggedSalesOfDay` (`sales`, mêmes ventes que le compteur du jour : non annulées, datées du jour, dans le périmètre) ; signal construit par `flaggedSalesSignal` (`home-format.ts`) : « N ventes du jour signalées », ventilation « Stock devenu négatif : 2 · Vente hors prise de service : 3 » (contrôles d'abord, 240 caractères au plus), avertissement dès un drapeau de contrôle, information sinon, action « Voir les ventes signalées ». Seul `OUT_OF_SESSION` est informatif ; tout autre drapeau, connu ou non, est un contrôle (**DÉDUIT** : l'AV ne classe que prix, stock, crédit et caisse ; le défaut le plus prudent range les autres en contrôle). PWA : le signal mène à `/ventes?anomalies=1` (`signalQuery`, ADR-036), liste filtrée sur les ventes du jour signalées connues de l'appareil, retour à toutes les ventes ; libellés des drapeaux sur chaque ligne.

### AV-256 — Valeur du stock de l'entreprise : la marchandise en transit compte-t-elle ? — SECONDAIRE
- **Question** : KPI-STK-02 (« Σ solde × coût unitaire courant ») exclut aujourd'hui les emplacements virtuels, donc le transit : une marchandise expédiée, qui appartient encore au GIC, disparaît de la valeur jusqu'à sa réception. Faut-il l'inclure ?
- **Pourquoi** : vérification des écrans (13/10/2026) : la valeur du stock de la Direction a baissé de 98 000 XAF le temps d'un transfert. **CONFIRMÉ** (code).
- **Choix** : (a) comprise pour la portée de toute l'entreprise, montrée dans le détail ; hors transit pour un site ; pertes en attente exclues mais affichées à part ; (b) inchangé.
- **Recommandation** : (a).
- **Impact** : `inventory` (lecture de l'accueil), D11 KPI-STK-02. Défaut retenu pour le lot de mise en pilote : (a). Non paramétrable.
- **Mise en œuvre** (MP-09, 14/10/2026) : `stockHealth` rend `transitValueXaf` et `pendingLossValueXaf` (soldes de `V_TRANSIT` et `V_PENDING_LOSS`, emplacements sans site) pour la portée de toute l'entreprise seulement, `null` pour un site ; KPI-STK-02 de la Direction et du magasinier à portée globale : valeur + transit, détail « au coût moyen pondéré · dont X en transit · pertes en attente à part : Y ». Le transit peut être négatif tant qu'une réception sans document n'est pas rapprochée (P5-16) : affiché tel quel, le total reste exact (**DÉDUIT**). Hors périmètre de l'AV, signalé au porteur : la marchandise vendue « à livrer » (`V_TO_DELIVER`) reste hors de la valeur.

### AV-257 — Permissions des rôles modifiables depuis l'application ? — SECONDAIRE
- **Question** : l'écran d'administration des utilisateurs (ECR-ADM-04) doit-il permettre de modifier les permissions d'un rôle (`identity.role.set_permissions`), ou seulement d'affecter des rôles ?
- **Pourquoi** : la commande est annoncée par l'architecture de l'API sans être enregistrée ; ADR-008 fige les rôles par un seed versionné. **DÉDUIT** (vérification des écrans, 13/10/2026).
- **Choix** : (a) rôles figés au MVP, affectations seulement ; (b) permissions modifiables par l'Admin.
- **Recommandation** : (a).
- **Impact** : ECR-ADM-04 (lot suivant). Défaut : (a). Non paramétrable.

### AV-258 — Auto-approbation d'un appareil par le responsable qui l'a connecté — IMPORTANTE — **TRANCHÉ**
- **Question** : un responsable peut-il approuver (ou débloquer) le téléphone qu'il a lui-même connecté, s'il est dans sa portée ?
- **Pourquoi** : la portée d'AV-247 inclut l'utilisateur lui-même (portée `TEAM`) ; aucun texte ne traite l'auto-approbation d'un appareil (RC-03 vise les validations du module `approvals`). Relevé en concevant MP-06. **DÉDUIT**.
- **Choix** : (a) refusée, sauf l'Admin ; (b) permise.
- **Recommandation** : (a).
- **Décision** (porteur du projet, 13/10/2026) : (a). Un déblocage approuve un appareil refusé avant toute approbation : même règle. Bloquer, déclarer perdu, retirer ou rattacher son propre appareil restent permis.
- **Impact** : `device-commands.ts` (`withDeviceScope`), lecture `GET /devices` (actions permises) ; MP-06.

### AV-259 — Rattachement d'un appareil à un site hors de la portée du responsable — SECONDAIRE — **TRANCHÉ**
- **Question** : `identity.device.designate` vérifie-t-il que le site cible est dans la portée de l'auteur, en plus de l'appareil ?
- **Pourquoi** : la commande ne contrôlait que l'existence et l'ouverture du site. **DÉDUIT** (MP-06).
- **Choix** : (a) site cible dans la portée ; (b) tout site actif.
- **Recommandation** : (a).
- **Décision** (porteur du projet, 13/10/2026) : (a).
- **Impact** : `identity.device.designate` ; MP-06.

### AV-260 — Tablette rattachée à un site : relève-t-elle du responsable de ce site ? — SECONDAIRE — **TRANCHÉ**
- **Question** : une tablette rattachée à un site (`designated_site_id`, ex. celle d'un PDV), connectée par quelqu'un d'un autre site, est-elle vue et décidée par le responsable du site de rattachement ?
- **Pourquoi** : AV-247 ne retient que les affectations de l'utilisateur qui a connecté l'appareil ; une tablette de PDV connectée par un administrateur ou un commercial d'une autre zone échapperait au responsable du site. **DÉDUIT** (MP-06).
- **Choix** : (a) oui, le site de rattachement compte aussi ; (b) non, l'utilisateur seul.
- **Recommandation** : (a).
- **Décision** (porteur du projet, 13/10/2026) : (a). Un appareil dont l'utilisateur n'a ni équipe, ni site, ni zone, et qui n'est rattaché à aucun site, ne relève que des portées `ALL` (Admin, Direction).
- **Impact** : `device-scope.ts` (`withDesignatedSite`) ; MP-06.

### AV-261 — Lecture des appareils par le Responsable production — SECONDAIRE — **TRANCHÉ**
- **Question** : le Responsable production détient `identity.device.approve` et `identity.device.block` en `SITE` mais pas `identity.device.read` : il ne peut pas ouvrir la liste des appareils qu'il peut décider. Que fait-on ?
- **Pourquoi** : écart de la matrice RBAC (§5.1) et du seed, relevé en concevant MP-06. **CONFIRMÉ** (lecture).
- **Choix** : (a) lui donner la lecture en `SITE` ; (b) lui retirer approuver et bloquer.
- **Recommandation** : (a).
- **Décision** (porteur du projet, 13/10/2026) : (a).
- **Impact** : `db/seeds/rbac-data.ts` (501 octrois), matrice RBAC §5.1 ; MP-06.

### AV-262 — Remise au-delà du plafond ou dépassement d'encours refusés après coup — SECONDAIRE
- **Question** : une remise au-delà du plafond du vendeur (`PRICE_OVERRIDE`, AV-026) et un dépassement de la limite de crédit (`CREDIT_LIMIT_EXCEEDED`, AV-028) sont validés **après** la vente, déjà enregistrée. Que produit un refus : rien de plus qu'une trace, une alerte, une correction de prix, une sanction ?
- **Pourquoi** : en construisant la file de validation (MP-07), aucun module ne traite la décision de ces deux types (aucun gestionnaire, ADR-018) : approuver ou refuser ne change rien à la vente. Ni le CM ni AV-026 ne disent ce que vaut un refus. **CONFIRMÉ** (lecture du code) ; l'effet attendu est **À VALIDER**.
- **Choix** : (a) décision tracée seulement, visible dans l'historique de la demande et l'audit ; (b) en plus, alerte au vendeur et à son responsable (P9) ; (c) refus = annulation ou avoir à émettre sur la vente (contre-écriture, ADR-006).
- **Recommandation** : (a) maintenant, (b) avec les alertes de P9 ; (c) seulement si le porteur veut qu'un refus corrige la vente.
- **Impact** : `approvals` (aucun gestionnaire pour ces types), écran ECR-ADM-08 (« validation a posteriori : l'opération est déjà enregistrée »), `approvalDecisionSpec` (`recordOnly`), test `approvals-inbox.test.ts` (catalogue fidèle aux gestionnaires). Défaut implémenté : (a), sans paramètre (aucun effet à régler).

### AV-263 — Plafond d'approbation des dépenses par rôle — SECONDAIRE
- **Question** : Le Resp. production approuve les dépenses « ≤ seuil, fermes » (matrice RBAC §5.5) : quel plafond, et faut-il le borner aux sites de type ferme ?
- **Pourquoi** : la matrice le dit sans chiffre ; RC-06 range ce type de plafond dans `role_permissions.limits`, que `decideApprovalRequest` ne lit pas. Le seed donne à RESP_PRODUCTION `finance.expense.approve` en `ALL` sans limite (AV-058). **DÉDUIT**
- **Choix** : (a) mécanisme prêt (`limits.maxAmountXaf` vérifié par le gestionnaire de décision `EXPENSE`, refus `APPROVAL_LIMIT_EXCEEDED`), aucune valeur semée ; (b) plafond semé (par exemple 200 000) ; (c) restriction aux fermes en plus du plafond.
- **Recommandation** : (a), puis (b) dès que le porteur donne le chiffre ; (c) suit les sites affectés au rôle.
- **Impact** : gestionnaire de décision `EXPENSE` ([ADR-042](decisions/ADR-042-depenses-p8.md) §2). Défaut implémenté : (a) (P8). Paramétrable par `role_permissions.limits`.

### AV-264 — Dépense au-delà du seuil sans politique `EXPENSE` — SECONDAIRE
- **Question** : Une dépense au-delà du seuil de validation, alors qu'aucune politique `EXPENSE` n'est active, est-elle refusée ou enregistrée sans validation ?
- **Pourquoi** : les ventes refusent `CONTROL_POLICY_MISSING` ; les pertes s'enregistrent sans validation. Une dépense payée hors ligne ne peut pas être refusée (BR-SYN-007). **DÉDUIT**
- **Choix** : (a) pas de validation, comme les pertes ; (b) refus en ligne, validation forcée hors ligne.
- **Recommandation** : (a) : la politique `EXPENSE_DEFAULT` est semée ; la retirer est un choix explicite de la Direction.
- **Impact** : `finance.expense.record` ([ADR-042](decisions/ADR-042-depenses-p8.md) §2). Défaut implémenté : (a) (P8). Paramétrable par les politiques de contrôle.

### AV-265 — Dépense hors ligne non conforme, dépense hors ligne non payée — IMPORTANTE
- **Question** : Une dépense saisie hors ligne qui enfreint une règle vérifiable seulement au serveur (catégorie désactivée ou non autorisée au PDV, plafond du PDV dépassé, justificatif manquant, lot clos ou introuvable) est-elle refusée, mise en conflit ou appliquée ? Une dépense non payée peut-elle être saisie hors ligne ?
- **Pourquoi** : une dépense payée est un fait financier accompli (BR-SYN-007). SM-EXPENSE (l.183) admet la saisie hors ligne « payée ou non », D09 §12 seulement « payée immédiatement », et le dictionnaire indique `CR`. **DÉDUIT**
- **Choix** : (a) appliquée puis placée en validation a posteriori (`PAID_PENDING_APPROVAL` ou `PENDING_APPROVAL`), motif dans `review_reasons`, avertissement `EXPENSE_REVIEW_REQUIRED` ; (b) appliquée avec un conflit dédié ; (c) refusée. Pour la saisie non payée : (a) admise hors ligne ; (b) réservée au mode en ligne.
- **Recommandation** : (a) et (a) : un seul circuit de décision par la Finance, prévu par la machine à états ; un rejet reclasse la dépense (AV-268).
- **Impact** : `finance.expense.record` ([ADR-042](decisions/ADR-042-depenses-p8.md) §6). Défaut implémenté : (a), (a) (P8). Non paramétrable. Revue de P8-14 : un objet de coût introuvable reste refusé, même hors ligne (ADR-042 §8, validité) ; seul un lot clos est un motif de revue.

### AV-266 — Plafond d'une petite dépense au PDV — SECONDAIRE
- **Question** : Quel montant maximal pour une dépense payée depuis la caisse d'un PDV (BR-DIS-013) ?
- **Pourquoi** : BR-DIS-013 parle d'un plafond sans le chiffrer ; AV-058 ne le donne pas. **DÉDUIT**
- **Choix** : (a) 50 000 XAF, comme le seuil de validation ; (b) un montant plus bas (par exemple 20 000) ; (c) aucun plafond, la validation suffit.
- **Recommandation** : (a) : une petite dépense de caisse ne demande jamais de validation.
- **Impact** : paramètre `finance.pos_expense_max_xaf` ([ADR-042](decisions/ADR-042-depenses-p8.md) §5). Défaut implémenté : (a) (P8). Paramétrable.

### AV-267 — Session de caisse pour une dépense payée par la caisse du PDV — IMPORTANTE
- **Question** : Une dépense payée en espèces depuis la caisse d'un PDV exige-t-elle une session de caisse ouverte ?
- **Pourquoi** : la dépense diminue l'attendu de la session (BR-DIS-013, ADR-032) ; l'encaissement en espèces au PDV exige une session (BR-DIS-005, P5-14). Rien n'est écrit pour une sortie. **DÉDUIT**
- **Choix** : (a) exigée comme un encaissement : `CASH_SESSION_REQUIRED` en ligne, conflit `CASH_SESSION_MISSING` hors ligne résolu à l'ouverture ; (b) non exigée, la dépense hors session reste sans session.
- **Recommandation** : (a) : la caisse du PDV ne bouge qu'en session, l'écart reste explicable.
- **Impact** : `finance.expense.record`, `finance.expense.pay`, `finance.supplier_payment.record` ; résolution à l'ouverture de session ([ADR-042](decisions/ADR-042-depenses-p8.md) §5). Défaut implémenté : (a) (P8). Non paramétrable.

### AV-268 — Dépense rejetée après paiement — SECONDAIRE
- **Question** : Que signifie concrètement « imputée au déclarant » (BR-FIN-022) pour une dépense payée puis rejetée ?
- **Pourquoi** : l'application n'a pas de créance sur le personnel ; ADR-032 §7 renvoie aussi à P8 la retenue sur la personne responsable d'un écart de remise. Pour les pertes, la décision AV-038 enregistre la responsabilité du déclarant. **DÉDUIT**
- **Choix** : (a) reclassement en catégorie système `NON_JUSTIFIEE`, responsabilité du déclarant enregistrée (`responsibility_user_id`), aucune écriture de coût, recouvrement hors application ; (b) créance du personnel (nouvelle entité).
- **Recommandation** : (a) au MVP, aligné sur les pertes ; (b) avec la paie, si elle entre un jour dans le périmètre.
- **Impact** : gestionnaire de décision `EXPENSE` ([ADR-042](decisions/ADR-042-depenses-p8.md) §7). Défaut implémenté : (a) (P8). Non paramétrable.

### AV-269 — Dépense imputée à un site — SECONDAIRE
- **Question** : Une dépense imputée à un site (électricité de la ferme, loyer d'un PDV) alimente-t-elle les frais généraux répartis sur les lots (ADR-026) ou reste-t-elle un coût du site ?
- **Pourquoi** : AV-043 relie les frais généraux « aux dépenses en P8 » ; l'objet de coût `SITE` est aussi celui des frais généraux, qui exigent une espèce. BR-FIN-020 cite le PDV comme objet de coût, absent de la liste des objets. **DÉDUIT**
- **Choix** : (a) avec espèce : frais généraux de cette espèce, répartis ; sans espèce : dépense directe du site, non répartie (PDV = son site) ; une seule espèce par dépense ; (b) toute dépense de site est un frais général ; (c) ventilation d'une dépense sur deux espèces.
- **Recommandation** : (a) : le choix reste explicite à la saisie ; une charge commune se saisit en deux dépenses ou par `inventory.overhead.record`.
- **Impact** : `finance.expense.record` ([ADR-042](decisions/ADR-042-depenses-p8.md) §8). L'appartenance d'un lot au site de la dépense n'est pas contrôlée (`finance` ne lit pas `production`). Défaut implémenté : (a) (P8). Non paramétrable.

### AV-270 — Catégories de dépense : type de coût, PDV, administration — SECONDAIRE
- **Question** : Quel type de coût porte chaque catégorie initiale (AV-058), lesquelles sont permises au PDV, et qui les administre ?
- **Pourquoi** : le dictionnaire prévoit `default_cost_type` et `allowed_on_pos` sans les remplir ; aucune permission n'existe pour administrer les catégories. **DÉDUIT**
- **Choix** : (a) `VETERINAIRE` → `VETERINAIRE`, `ALIMENT_HORS_STOCK` → `ALIMENT`, les autres → `DEPENSE_DIRECTE` ; au PDV : `TRANSPORT`, `CARBURANT`, `FOURNITURES`, `ENTRETIEN`, `DIVERS` ; `NON_JUSTIFIEE` catégorie système non sélectionnable ; administration par une permission `finance.expense_category.manage` (Finance, Administrateur) ; (b) autre répartition.
- **Recommandation** : (a).
- **Impact** : seed `finance-references.ts`, commandes `finance.expense_category.*` ([ADR-042](decisions/ADR-042-depenses-p8.md) §9). Défaut implémenté : (a) (P8). Paramétrable par les commandes de catégorie.

### AV-271 — Facture fournisseur sans bon de commande — SECONDAIRE
- **Question** : Une facture sans bon de commande (service, frais) est-elle approuvée d'office ou mise en revue ?
- **Pourquoi** : BR-FIN-031 rapproche facture, BC et réceptions ; sans BC, rien n'est rapprochable. **DÉDUIT**
- **Choix** : (a) mise en revue : `MISMATCH`, motif `NO_PURCHASE_ORDER`, décision de la Finance ; (b) approuvée d'office.
- **Recommandation** : (a) : une dette sans BC ni réception passe par un second regard.
- **Impact** : paramètre `finance.invoice_without_po_mode` (`REVIEW` ou `APPROVE`) ([ADR-043](decisions/ADR-043-factures-et-paiements-fournisseurs-p8.md) §2). Défaut implémenté : (a) (P8). Paramétrable.

### AV-272 — Avoir fournisseur — IMPORTANTE
- **Question** : Comment enregistrer l'avoir du fournisseur sur une facture contestée (WF-09 : « avoir 3 sacs → APPROVED (95) ») ?
- **Pourquoi** : le dictionnaire n'a ni entité ni colonne d'avoir ; AV-054 renvoie « l'avoir sur facture » à P8. **DÉDUIT**
- **Choix** : (a) annulation motivée de la facture contestée, puis facture rectificative du fournisseur, la même référence étant admise après annulation ; un avoir après paiement passe par l'annulation du paiement ; (b) entité « avoir » liée à la facture, qui en réduit le montant ; (c) modification des lignes d'une facture contestée.
- **Recommandation** : (a) au MVP : rien ne disparaît, l'historique « 98 puis 95 » se lit en deux documents ; (b) quand les avoirs partiels deviendront fréquents.
- **Impact** : unicité partielle de la référence fournisseur, `finance.supplier_invoice.cancel` ([ADR-043](decisions/ADR-043-factures-et-paiements-fournisseurs-p8.md) §4). Défaut implémenté : (a) (P8). Non paramétrable.

### AV-273 — Échéance par défaut d'une facture fournisseur — SECONDAIRE
- **Question** : Quelle échéance retenir quand la facture n'en porte pas ?
- **Pourquoi** : `due_date` est facultative ; le fournisseur porte un délai de paiement facultatif (`payment_terms_days`). L'ancienneté des dettes en dépend. **DÉDUIT**
- **Choix** : (a) date de facture + délai du fournisseur, sinon date de facture ; (b) date de facture + délai global paramétré.
- **Recommandation** : (a).
- **Impact** : `finance.supplier_invoice.record`, `GET /payables` ([ADR-043](decisions/ADR-043-factures-et-paiements-fournisseurs-p8.md) §8). Défaut implémenté : (a) (P8). Non paramétrable.

### AV-274 — Réception ou bon de commande annulé après facturation — SECONDAIRE
- **Question** : Faut-il empêcher l'annulation d'une réception ou d'un BC déjà facturés ?
- **Pourquoi** : `procurement` ne peut pas consulter `finance` ; il lit seulement sa colonne `invoiced_qty_base`. Une décision de Finance peut avoir approuvé une facture au-delà de l'accepté (AT-025). **DÉDUIT**
- **Choix** : (a) aucune garde côté achats ; l'écart « facturé > accepté » est signalé par la réconciliation des fournisseurs et corrigé par avoir (AV-272) ; (b) refus de l'annulation si le facturé dépasserait l'accepté.
- **Recommandation** : (a) : P6 reste inchangé et l'écart reste visible.
- **Impact** : `verifySupplierLedger`, rapprochement ([ADR-043](decisions/ADR-043-factures-et-paiements-fournisseurs-p8.md), Conséquences). Défaut implémenté : (a) (P8). Non paramétrable. Revue de P8-14 : l'écart se lit dans le rapprochement du BC, pas dans la réconciliation (une décision de la Finance peut l'avoir voulu). La réconciliation contrôle que le facturé vaut Σ des factures approuvées (`INVOICED_QTY_DRIFT`), et une approbation qui dépasserait l'accepté sans que la demande le dise est refusée (`INVOICE_MATCHING_CHANGED`).

### AV-275 — Avances fournisseurs et affectation ultérieure — SECONDAIRE
- **Question** : Une avance (paiement non affecté, AV-055) est-elle admise, et comment l'affecter ensuite à une facture ?
- **Pourquoi** : AV-055 admet les avances sans dire comment elles rejoignent une facture ; D09 prévoit `SUPPLIER_PAYMENT_EXCEEDS` (« paiement ≤ dette + avance autorisée »). **DÉDUIT**
- **Choix** : (a) avance admise (paramètre `finance.supplier_advance_allowed`, vrai par défaut), affectation ultérieure par `finance.supplier_payment.allocate` ; (b) avance interdite, paiement ≤ dette.
- **Recommandation** : (a).
- **Impact** : `finance.supplier_payment.record`, `.allocate` ([ADR-043](decisions/ADR-043-factures-et-paiements-fournisseurs-p8.md) §7). Défaut implémenté : (a) (P8). Paramétrable.

### AV-276 — Paiement fournisseur validé : date et affectations — SECONDAIRE
- **Question** : À quelle date se fait le décaissement d'un paiement validé par la Direction, et que faire si une facture a été payée entre la saisie et la décision ?
- **Pourquoi** : BR-FIN-033 impose la validation avant le décaissement ; la saisie et la décision peuvent être séparées de plusieurs jours. **DÉDUIT**
- **Choix** : (a) décaissement daté de la décision ; affectations revérifiées, décision refusée (`ALLOCATION_EXCEEDS`) si l'une dépasse le solde ; (b) décaissement daté de la saisie.
- **Recommandation** : (a) : la trésorerie montre l'argent sorti au jour où il sort.
- **Impact** : gestionnaire de décision `SUPPLIER_PAYMENT` ([ADR-043](decisions/ADR-043-factures-et-paiements-fournisseurs-p8.md) §6). Défaut implémenté : (a) (P8). Non paramétrable.

### AV-277 — Annulation d'un paiement fournisseur enregistré — SECONDAIRE
- **Question** : Qui annule un paiement fournisseur déjà décaissé, et faut-il une demande de validation ?
- **Pourquoi** : SM-SUPPLIER-PAYMENT prévoit « annulation + validation » sans type de décision. **DÉDUIT**
- **Choix** : (a) la Direction (`finance.supplier_payment.approve`) annule directement, avec motif ; (b) la Finance demande, la Direction valide (nouveau type de décision).
- **Recommandation** : (a) : l'annulation est faite par celui qui aurait validé.
- **Impact** : `finance.supplier_payment.cancel` ([ADR-043](decisions/ADR-043-factures-et-paiements-fournisseurs-p8.md) §7). Défaut implémenté : (a) (P8). Non paramétrable.

### AV-278 — Lecture des factures, paiements fournisseurs et de la vue d'ensemble — SECONDAIRE
- **Question** : Quel droit pour lire les factures et paiements fournisseurs, et la vue d'ensemble financière ?
- **Pourquoi** : le catalogue n'a pas de permission de lecture propre ; `finance.payable.read` couvre les dettes. **DÉDUIT**
- **Choix** : (a) `finance.payable.read` (Direction, Resp. achats, Finance), portée `ALL` ; (b) permissions dédiées.
- **Recommandation** : (a).
- **Impact** : `GET /supplier-invoices`, `/supplier-payments`, `/payables`, `/finance/overview` ([ADR-043](decisions/ADR-043-factures-et-paiements-fournisseurs-p8.md) §10, [ADR-044](decisions/ADR-044-couts-complets-et-marges-p8.md) §4). Défaut implémenté : (a) (P8). Non paramétrable. Revue de P8-14 : dans la vue d'ensemble, les blocs CA, encaissé, créances et trésorerie exigent en plus `analytics.dashboard.finance`, et les dépenses `finance.expense.read` en portée `ALL` ; le payé d'un BC dans `/purchase-orders/{id}/matching` exige `finance.payable.read`.

### AV-279 — Chiffre d'affaires d'un lot de production — IMPORTANTE
- **Question** : Le chiffre d'affaires de la marge d'un lot comprend-il les ventes des produits issus du lot (abattage, œufs) ?
- **Pourquoi** : D07 (l.234) compte « les ventes des têtes et produits du lot », mais P4 ne compte que le lot de stock du lot : un lot abattu affiche une marge négative. Les œufs sortent déjà du lot pondeur au coût standard (ADR-027). **DÉDUIT**
- **Choix** : (a) ventes du lot et de ses produits d'abattage ; œufs exclus ; (b) œufs inclus, crédit au coût standard retiré de la marge ; (c) inchangé.
- **Recommandation** : (a) : aucune valeur n'est comptée deux fois.
- **Impact** : `production-api` (marge de lot), lecture publique `slaughterStockLotIds` ([ADR-044](decisions/ADR-044-couts-complets-et-marges-p8.md) §1). Défaut implémenté : (a) (P8). Non paramétrable.


### AV-280 — Règles d'un nouveau mot de passe : longueur maximale, réemploi — SECONDAIRE
- **Question** : au-delà des 8 caractères au moins (AV-008, 02-securite §2), un nouveau mot de passe a-t-il une longueur maximale ? Peut-il être identique à celui qu'il remplace ?
- **Pourquoi** : en construisant MP-08, le changement acceptait un nouveau mot de passe identique à l'actuel. Après une réinitialisation, l'utilisateur aurait donc pu « changer » vers le mot de passe provisoire, que l'Admin connaît. Aucune borne haute n'existait, alors que le hachage argon2id est coûteux. Les sources ne disent rien de la composition, de l'historique ni de l'expiration. **DÉDUIT**.
- **Choix** : (a) 8 à 128 caractères, différent de celui qu'il remplace, sans autre règle ; (b) en plus, une composition imposée (chiffres, lettres) ; (c) en plus, un historique et une expiration.
- **Recommandation** : (a), adapté à des utilisateurs de terrain sur téléphone ; (b) et (c) seulement si le porteur le demande.
- **Impact** : `packages/domain/src/password.ts` (`newPasswordProblem`), création d'un compte, `POST /auth/change-password`, réinitialisation, écrans de la PWA ; ADR-045. Défaut implémenté : (a), bornes en constantes partagées.

### AV-281 — Gardes de la réinitialisation du mot de passe par l'Admin — SECONDAIRE
- **Question** : l'Admin peut-il réinitialiser son propre mot de passe, celui d'un compte désactivé, suspendu, ou du compte système ? La réinitialisation lève-t-elle le verrouillage d'un compte bloqué par des échecs ?
- **Pourquoi** : AV-252 fixe le principe (mot de passe saisi par l'Admin), pas ces cas limites. **DÉDUIT**.
- **Choix** :
  - (a) son propre compte refusé (`RESET_OWN_PASSWORD`) : il passe par le changement, avec l'actuel ;
  - compte désactivé refusé (`USER_DEACTIVATED`) : à réactiver d'abord ;
  - compte suspendu accepté ;
  - compte système introuvable pour cette route ;
  - verrouillage de l'identifiant levé.

  (b) Aucune garde au-delà du droit.
- **Recommandation** : (a).
- **Impact** : `POST /users/{id}/reset-password`, `GET /users` (`actions.resetPassword`), écran des utilisateurs ; ADR-045. Défaut implémenté : (a).

### AV-282 — Session révoquée ou compte suspendu : refus immédiat des requêtes ? — IMPORTANTE — **TRANCHÉ**
- **Question** : une session révoquée (réinitialisation, suspension, déconnexion) ou un compte suspendu doivent-ils être refusés dès la requête suivante, ou à l'expiration du jeton d'accès ?
- **Pourquoi** : `AuthGuard` vérifie la signature et l'expiration du jeton (15 min), mais ne relit ni la session ni le statut de l'utilisateur ou de l'appareil. 02-securite §5 dit pourtant que « le serveur vérifie la correspondance session ↔ appareil et le statut de l'appareil » à chaque requête. Les commandes sont protégées (le pipeline vérifie l'utilisateur et l'appareil), pas les lectures ni `change-password`. **CONFIRMÉ** (lecture du code, MP-08).
- **Choix** : (a) inchangé : refus au renouvellement, au plus 15 min ; (b) contrôle de la session (révocation) et des statuts à chaque requête, avec un cache court ; (c) jeton d'accès plus court.
- **Recommandation** : (b), avant la mise en production.
- **Impact** : `AuthGuard`, performances (une lecture par requête, ou un cache) ; 02-securite §3 et §5 ; MP-11 ou P10. Non paramétrable.
- **Décision** (porteur du projet, 14/10/2026) : (b), « blocage immédiat » : le serveur vérifie à chaque requête la session et le statut du compte et de l'appareil, avec un petit cache de quelques secondes.
- **Mise en œuvre** (MP-11, 14/10/2026) :
  - `AuthGuard` lit l'état de la session du jeton (`session-state.ts`) : une session de sa **famille de rotation** encore vivante (le jeton émis juste avant une rotation porte l'identifiant de la ligne `ROTATED`), un utilisateur `ACTIVE`, un appareil `ACTIVE` ou `PENDING` (l'appareil en attente lit et voit son attente, AV-228). Sinon 401 `UNAUTHENTICATED`, motif dans `details.reason` (`SESSION_REVOKED`, `USER_INACTIVE`, `DEVICE_OUT_OF_SERVICE`).
  - L'état est gardé 5 s par session et vidé par toute révocation du processus (déconnexion, réinitialisation, suspension, désactivation, blocage d'appareil, réutilisation, changement de mot de passe). Un statut changé sans révocation est vu au plus 5 s plus tard. Index `(token_family_id, revoked_at)` (migration `20261102090000`).
  - La déconnexion révoque toute la famille de la session.
  - Revue adverse de MP-11 : la réinitialisation du mot de passe exige en plus un appareil `ACTIVE` (RC-02, 403 `DEVICE_PENDING` audité) ; le changement du mot de passe révoque les autres sessions de l'utilisateur (motif `PASSWORD_CHANGED`, nombre dans l'audit).
  - PWA : un 401 fait renouveler le jeton une fois, puis rejouer l'appel ; un renouvellement refusé vide la session (reconnexion).
  - Conséquence (**DÉDUIT**) : un appareil bloqué, perdu ou retiré n'envoie plus rien dès le blocage, au lieu d'au plus 15 min après. Ses opérations en attente restent sur l'appareil jusqu'au déblocage et à une nouvelle connexion ; les faits datés d'avant le blocage sont alors acceptés (BR-SYN-007), ceux de la période hors service mis en quarantaine (INV-ADM-03).
  - Tests : `auth-session-state.e2e.test.ts`, `identity-users-password.test.ts`, `api-client.test.ts` (PWA).

### AV-283 — « Classer » une opération refusée ou en conflit sur l'appareil — SECONDAIRE
- **Question** : comment l'utilisateur « prend-il connaissance » d'une opération refusée (BR-SYN-009, SM-SYNC-COMMAND : `REJECTED → ACKNOWLEDGED`, « archivé localement 30 jours ») ? Qui le peut sur une tablette partagée, et une opération en conflit se classe-t-elle aussi ?
- **Pourquoi** : vérification des écrans (13/10/2026) : une opération refusée reste « à examiner » sans aucun moyen de la classer. L'état `ACKNOWLEDGED` n'existe pas dans le protocole (`DEVICE_SYNC_STATES`), et d'autres écrans lisent le statut `REJECTED` (vente refusée, expédition ignorée ou ressaisie). Un conflit peut encore être résolu par le serveur et revenir par le téléchargement. **CONFIRMÉ** (navigateur et code).
- **Choix** : (a) marque locale `ACKNOWLEDGED` (`local_flags`), statut inchangé, opération conservée ; classement par son seul auteur ; un conflit se classe aussi, sans être réglé ; aucun archivage ; (b) nouvel état `ACKNOWLEDGED` dans le protocole, purge après 30 jours ; (c) conflits exclus du classement.
- **Recommandation** : (a) : rien ne disparaît (BR-SYN-013), les écrans qui lisent `REJECTED` ne changent pas, la résolution d'un conflit par le serveur s'applique toujours.
- **Impact** : `apps/pwa/src/sync/outbox.ts` (`acknowledgeCommand`, `needsAttention`, `countAttention`), `useSyncStatus.ts`, `SyncScreen.tsx` (bouton « Classer », libellés français des types d'opération). Les expéditions refusées ignorées ou ressaisies (`DISMISSED`, `REENTERED`, écran des transferts) sortent aussi de la liste. Défaut implémenté : (a). Non paramétrable. L'archivage à 30 jours du SM reste à décider avec la purge de l'outbox.
- **Reliquat (vérification contradictoire du 22/10/2026, C18)** : la pastille et la liste « Opérations à examiner » comptent les refus et conflits de tous les auteurs de la tablette alors que « Classer » est offert au seul auteur (`useSyncStatus.ts`, `SyncScreen.tsx`). Un autre utilisateur voit la pastille rouge sans pouvoir agir. Défaut inchangé ; proposition : pastille limitée à ses propres opérations, une ligne informative pour celles des autres (« attendent sa reconnexion »), sans bouton, rien n'étant caché de l'outbox (BR-SYN-013).

### AV-284 — « Encaisser le reste dû » depuis le reçu : sort du surplus — SECONDAIRE
- **Question** : depuis le reçu d'une vente, l'encaissement doit-il régler cette vente avant les plus anciennes ? Que devient un montant supérieur à son reste dû ?
- **Pourquoi** : vérification des écrans (13/10/2026) : le lien ouvrait l'encaissement du client sans montant, et l'affectation automatique (BR-FIN-004, la plus ancienne d'abord) pouvait régler une autre vente que celle du reçu. Le serveur accepte des affectations explicites et laisse le reste en crédit du client (`sales.payment.record`). **CONFIRMÉ** (navigateur et code).
- **Choix** : (a) montant prérempli au reste dû de la vente ; affectation explicite à elle seule ; surplus en avoir du client ; « Répartir sur toutes les créances » revient à l'affectation automatique ; (b) comme (a), mais le surplus réparti sur les autres créances de la plus ancienne à la plus récente (affectations explicites calculées sur l'appareil, refusées en ligne si elles dépassent un reste dû) ; (c) préremplissage seul, affectation automatique.
- **Recommandation** : (a).
- **Impact** : `apps/pwa/src/features/sales/collect.ts` (`previewTargetedAllocation`, `allocationsOf` ; encaissements en attente imputés à leurs ventes), `CollectScreen.tsx` (paramètre `vente`, envoi attendu après la lecture des créances en ligne), `SaleDetailScreen.tsx`, `ROUTES.collectFor`. Vente déjà réglée entre-temps : avertissement et affectation automatique ; hors ligne, la part devenue sans objet reste en crédit (fait accompli, serveur inchangé). Défaut implémenté : (a). Non paramétrable.

### AV-285 — Régularisation de la « photo manquante » d'une réception — IMPORTANTE — **TRANCHÉ**
- **Question** : une réception enregistrée sans la photo exigée du bon de livraison ouvre le conflit informatif `RECEIPT_PHOTO_MISSING` (AV-246). Quand ce signal se ferme-t-il ?
- **Pourquoi** : AV-246 annonce que « la photo jointe ensuite la régularise (MP-10) », sans dire comment ; aucun code ne fermait le conflit. **CONFIRMÉ** (lecture du code, 14/10/2026).
- **Choix** : (a) fermeture automatique à la réception de la photo, et manuelle par le Resp. achats avec un motif ; (b) automatique seulement ; (c) manuelle seulement.
- **Recommandation** : (a).
- **Décision** (porteur du projet, 14/10/2026) : (a).
- **Impact** : fin de l'envoi des octets (`attachments-api/upload.controller.ts`, `regularizeReceiptPhoto` de `procurement`) ; la photo (`DELIVERY_NOTE` de la `GOODS_RECEIPT`) est jointe après coup par son auteur ; clôture manuelle par `sync.conflict.dismiss` (motif obligatoire, existant) ; ADR-046.
- **Mise en œuvre** (MP-10, 14/10/2026) : serveur (`procurement-receipt-commands.test.ts`) ; « Joindre la photo du bon » dans la PWA, depuis le résultat de la réception et la liste des réceptions de l'utilisateur, avec le badge « Photo manquante » tant qu'aucune photo n'est reçue ou en route. Revue de MP-10 : la fermeture automatique est réservée à une photo dont l'auteur est le réceptionnaire, ou peut enregistrer des réceptions sur le site de la réception (`canRegularizeReceiptPhoto`) ; celle d'un tiers reste reçue, le signal reste ouvert pour le Resp. achats (**DÉDUIT** : sans cela, un fichier quelconque contournait la clôture motivée).

### AV-286 — Photo visible par les valideurs — IMPORTANTE — **TRANCHÉ**
- **Question** : la Direction, le Resp. production et le Resp. achats doivent-ils voir la photo dans l'application avant de décider ?
- **Pourquoi** : sans lecture, le valideur ne sait que « justificatif reçu » ; l'URL signée prévue (02-securite §6) attend le choix du stockage objet (AV-091). **CONFIRMÉ**.
- **Choix** : (a) oui dès MP-10, lecture protégée ; (b) plus tard, avec le stockage définitif.
- **Recommandation** : (a).
- **Décision** (porteur du projet, 14/10/2026) : (a). Fichiers sur le disque du serveur pour le pilote.
- **Impact** : `GET /api/v1/attachments/{id}/content` (auteur, valideur d'une demande en attente sur le document, lecteur du document dans sa portée ; refus audité ; `private, no-store`) ; pièces de chaque demande dans `GET /approvals/inbox` ; écran des validations (PWA) ; ADR-046.
- **Mise en œuvre** (MP-10, 14/10/2026) : serveur et PWA (« Voir la photo » sur chaque demande dont une pièce est reçue, nouvel essai après un échec ; `ApprovalsScreen.test.tsx`, `approvals-inbox.test.ts`).

### AV-287 — Chiffrement des photos en attente sur le téléphone — IMPORTANTE — **TRANCHÉ**
- **Question** : faut-il chiffrer dès MP-10 les photos qui attendent leur envoi sur le téléphone ?
- **Pourquoi** : 01-architecture-offline §2 annonce des pièces locales chiffrées, mais la file des opérations ne l'est pas aujourd'hui (seul le jeton de session l'est) ; une clé tirée du PIN rendrait une photo non envoyée illisible après une réinitialisation du PIN. **CONFIRMÉ**.
- **Choix** : (a) pas encore, comme la file des opérations ; chiffrement de tout le stockage local traité en une fois avant la production ; (b) oui, avec une clé tirée du PIN.
- **Recommandation** : (a).
- **Décision** (porteur du projet, 14/10/2026) : (a).
- **Impact** : magasins `attachmentFiles` et `attachmentBlobs` de la PWA en clair, comme `outbox` ; **à traiter avant la mise en production** : chiffrement de la file des opérations et des pièces locales (01-architecture-offline §2, 02-securite §5).

### AV-288 — Photo d'une perte hors mortalité — IMPORTANTE — **TRANCHÉ**
- **Question** : quand la photo d'une perte (hors mortalité) est-elle exigée avant que le responsable puisse approuver ?
- **Pourquoi** : AV-037 propose des seuils de photo (casse, détérioration, produit impropre à partir de 10 000 F ; destruction toujours), jamais appliqués : aucune politique `LOSS_DECLARATION` n'est semée et la garde de photo ne vise que la mortalité. **CONFIRMÉ**.
- **Choix** : (a) selon les seuils d'AV-037 ; (b) toujours facultative ; (c) exigée pour toute perte validée.
- **Recommandation** : (a).
- **Décision** (porteur du projet, 14/10/2026) : (b), toujours facultative : la photo est proposée, jamais exigée ; seule la mortalité l'exige (AV-107, AV-048). Tranche la partie « photo » d'AV-037 ; ses seuils de validation restent ouverts.
- **Impact** : la photo d'une perte n'est pas citée par l'opération (aucune validation ne l'attend) ; elle reste rattachée à la déclaration (`STOCK_LOSS`) et visible du valideur ; ADR-046.

### AV-289 — Validation d'une réception sans BC dont la photo manque — SECONDAIRE
- **Question** : D08 et SM-RECEIPT disent que la validation `RECEIPT_WITHOUT_PO` « exige la photo reçue » ; depuis MP-04, une réception sans BC peut être enregistrée sans photo, et sa validation n'exige alors aucune pièce. Faut-il bloquer l'approbation tant qu'aucune photo du document n'est reçue, comme la mortalité ?
- **Pourquoi** : constat de la lecture de MP-10 ; la réception sans BC n'est pas proposée par la PWA et ses politiques ne sont pas semées (S-24). **CONFIRMÉ**.
- **Choix** : (a) inchangé : seules les pièces citées par la réception sont exigées ; (b) approbation bloquée sans photo `AVAILABLE` du document.
- **Recommandation** : (b) quand la PWA proposera la réception sans BC.
- **Impact** : décision `RECEIPT_WITHOUT_PO` (`procurement`). Défaut implémenté : (a). Non paramétrable.

### AV-290 — Photo refusée ou jamais reçue — SECONDAIRE
- **Question** : que faire d'une photo dont l'enregistrement est refusé, dont l'empreinte ou la signature est fausse (`QUARANTINED`, état final), ou qui n'arrive jamais ?
- **Pourquoi** : SM-ATTACHMENT n'a aucune transition depuis `QUARANTINED` ; aucune tâche ne pose `MISSING` après 7 jours. **CONFIRMÉ**.
- **Choix** : (a) nouvelle photo à prendre (nouvelle pièce, même document) ; aucune relance automatique ; `MISSING` et alerte `ATTACHMENT_MISSING` avec les alertes de P9 ; (b) reprise de la même pièce (`QUARANTINED` → `PENDING_UPLOAD`).
- **Recommandation** : (a).
- **Impact** : PWA (état « refusée » de la photo, nouvelle photo possible) ; P9 (tâche des 7 jours). Défaut implémenté : (a).
- **Mise en œuvre** (MP-10, 14/10/2026, revue adverse) :
  - une pièce exigée par une validation, refusée ou jamais enregistrée, est **remplacée** par une autre pièce reçue du même document, de même nature si la pièce exigée est connue (`requiredAttachmentsSatisfied`, décision et file de validation) : sans cela, la liste figée bloquait l'approbation à vie ; depuis la revue de P8E-05 (16/10/2026), la remplaçante est une pièce de l'auteur du document, le demandeur de la validation : la pièce d'un collègue ne lève pas l'exigence (la photo d'une mortalité, non citée, garde sa règle propre : une photo du document, de tout auteur habilité, AV-107 ; revue de P8E-10) ;
  - la PWA propose de reprendre la photo d'une réception refusée et celle d'une mortalité en attente, quel que soit son jour ;
  - seule une réponse portant un code d'erreur connu du serveur rend un envoi définitivement refusé ; une réponse sans code (passerelle, pare-feu) est réessayée ;
  - une fin d'envoi interrompue après l'écriture du dernier morceau est constatée à la session suivante ou au renvoi : la pièce n'attend plus sans fin ;
  - l'écran de synchronisation compte les photos refusées à reprendre.

### AV-291 — Formats, nombre et budget local des photos — SECONDAIRE
- **Question** : quels fichiers accepter sur le téléphone, combien de photos par opération, et que faire quand l'espace réservé aux photos en attente est plein ?
- **Pourquoi** : le serveur accepte JPEG, WebP et PDF ; HEIC (iPhone) ne se décode pas partout ; NFR-06 fixe 50 Mo de pièces en attente, sans dire quoi faire au-delà. **DÉDUIT**.
- **Choix** : (a) toute image décodable, recodée en JPEG ; une photo par opération ; au-delà de 50 Mo en attente, la photo est refusée avec un message et l'opération part sans elle ; PDF avec la facture fournisseur ; (b) plusieurs photos par opération.
- **Recommandation** : (a) pour le pilote.
- **Impact** : PWA (`PhotoField`, budget). Défaut implémenté : (a).
- **Mise en œuvre** (MP-10, 14/10/2026) : « Prendre une photo » (caméra arrière) ou « Choisir une image » ; image illisible (HEIC sur Android…) ou espace plein : message, l'opération part sans photo ; recodage JPEG (`photo.ts`) ; budget de 50 Mo de photos en attente (`PHOTO_PENDING_BUDGET_BYTES`).

### AV-292 — Stockage des fichiers pour le pilote — SECONDAIRE
- **Question** : où le serveur du pilote garde-t-il les photos, tant que le stockage objet n'est pas choisi (AV-091) ?
- **Pourquoi** : le défaut est le répertoire temporaire du système (`ATTACHMENTS_STORAGE_DIR`), hors sauvegarde. **CONFIRMÉ**.
- **Choix** : (a) disque local du serveur, sur un volume sauvegardé, désigné par `ATTACHMENTS_STORAGE_DIR` ; (b) stockage objet compatible S3 dès le pilote.
- **Recommandation** : (a) ; l'interface `ChunkStorage` permet de changer ensuite.
- **Impact** : configuration du déploiement (P0-17) ; aucune donnée perdue au changement si les fichiers sont recopiés. Défaut : (a), à configurer.

### AV-293 — Métadonnées des pièces jointes servies à tous les appareils — SECONDAIRE
- **Question** : le jeu hors ligne `attachment` doit-il rester servi à tout appareil (identifiant, propriétaire, nature, statut de chaque pièce de l'entreprise), ou être limité à l'auteur de la pièce ?
- **Pourquoi** : revue adverse de MP-10 : le pipeline écrit pour toute commande appliquée une ligne de flux en portée `GLOBAL` (repli générique, P0-06), et la fin d'envoi aussi ; le tirage n'a pas de liste blanche de jeux. Écart avec 02-securite §6 (« l'appareil ne reçoit que son périmètre »). Le contenu reste protégé par la lecture contrôlée (AV-286). **CONFIRMÉ** (lecture du code).
- **Choix** : (a) inchangé pour le pilote ; (b) jeu propre à l'auteur (portée `USER`) et liste blanche des jeux au tirage, sans repli `GLOBAL` pour les pièces ; (c) portée du site du document.
- **Recommandation** : (b), avec le durcissement du tirage (touche le pipeline et `sync/`, à mener avec l'intégration de P9).
- **Impact** : `command-pipeline.service.ts` (repli), `sync-pull.service.ts`, `upload.controller.ts`, PWA (`useOwnerPhotos` n'y lirait plus que ses pièces). Défaut implémenté : (a).

### AV-294 — Politiques de contrôle des achats par défaut — IMPORTANTE
- **Question** : quelles politiques de validation des achats une base neuve doit-elle porter : demande d'achat, bon de commande au-delà du seuil, réception sans bon de commande, réception en quarantaine, annulation d'une réception ?
- **Pourquoi** : revue adverse de MP-11 : aucune n'était semée. Sur une base neuve, toute demande d'achat, tout BC au-delà du seuil, toute réception sans BC ou en quarantaine et toute annulation de réception étaient refusés (`CONTROL_POLICY_MISSING`), y compris une réception saisie hors ligne, fait physique (BR-SYN-007). Le suivi des besoins serveur (S-24) le notait sans AV. **CONFIRMÉ** (lecture du code et du seed).
- **Choix** : (a) une politique par type, sans condition, approbateur selon 01-rbac (demande d'achat, réception sans BC ou en quarantaine, annulation : Resp. achats ou Direction ; BC au-delà du seuil : Direction), portée `ALL` ; (b) même chose en portée `SITE` ; (c) aucune politique semée, l'Admin les crée avant le pilote (`approvals.policy.set`, sans écran).
- **Recommandation** : (a).
- **Impact** : `db/seeds/procurement-references.ts` (codes `*_DEFAULT`, en vigueur depuis 2020 : une politique créée ensuite passe devant), publiées dans le jeu `policies` ; seuil du BC inchangé (`procurement.po_approval_threshold_xaf`, BR-APP-005). Reste (**DÉDUIT**) : si l'Admin retire la politique d'un type, une réception hors ligne de ce type est de nouveau refusée ; l'appliquer sans demande, comme la caisse (AV-183), demande un état de sortie pour une réception en quarantaine sans validation, à décider avec ce cas. Défaut implémenté : (a), modifiable par `approvals.policy.set`.

### AV-295 — Droit de décider une validation, jugé aussi à la réception — SECONDAIRE
- **Question** : le droit d'approuver une demande (et l'auto-validation de la Direction) doit-il valoir seulement à la date déclarée par l'appareil (`occurred_at`, RC-01), ou aussi quand le serveur reçoit la décision ?
- **Pourquoi** : revue adverse de MP-11 : une décision se prend en ligne (SM-APPROVAL ; `ONLINE_REQUIRED` sinon), mais ses droits étaient jugés à la date déclarée, sans borne basse (AV-078 non appliqué). Un approbateur dont le rôle a été retiré pouvait antidater sa décision, une Direction déchue valider sa propre demande. **CONFIRMÉ** (lecture du code).
- **Choix** : (a) inchangé, date déclarée seulement ; (b) date déclarée **et** réception par le serveur (`sync_command_inbox.received_at`) ; (c) réception seulement.
- **Recommandation** : (b) : RC-01 reste vrai, et une décision prise en ligne a ses deux dates à quelques secondes l'une de l'autre.
- **Impact** : `decideApprovalRequest` (`receivedAt`), commandes `approvals.request.approve` / `.reject` et façades (`finance.cash_session.validate`, `finance.cash_transfer.close_discrepancy`, `finance.supplier_invoice.approve`) ; refus `APPROVER_NOT_ALLOWED` ou `SELF_APPROVAL_FORBIDDEN`. Les autres commandes gardent la règle de RC-01 jusqu'à la fenêtre d'antidatage d'AV-078 (avant la production). Défaut implémenté : (b). Non paramétrable.

### AV-296 — Appareil non partagé lié à l'utilisateur qui l'a connecté — SECONDAIRE
- **Question** : un compte peut-il se connecter sur un appareil non partagé (`is_shared` faux) connecté d'abord par un autre utilisateur, et profiter de son statut (`ACTIVE`) ?
- **Pourquoi** : revue adverse de MP-11 : le serveur retrouve l'appareil par l'identifiant fourni par la PWA et rend son statut, sans comparer `enrolled_by_user_id` ni `is_shared`. Un compte valide qui connaît l'identifiant d'un appareil actif (lisible par `identity.device.read`, présent dans le jeton de chaque utilisateur d'une tablette partagée) contourne AV-258 (nul n'approuve l'appareil qu'il a connecté). Il ne gagne aucun droit : le RBAC reste celui du compte. Risque assumé au MVP par 02-securite §5 (l'identifiant d'appareil n'authentifie pas ; clé d'appareil F-18 non retenue). **CONFIRMÉ** (lecture du code).
- **Choix** : (a) inchangé ; (b) appareil non partagé lié à l'utilisateur qui l'a connecté : un autre compte y obtient une demande d'enrôlement distincte, en attente, ou un refus ; l'Admin le désigne « partagé » s'il change de main ; (c) clé d'appareil (F-18).
- **Recommandation** : (b) avant le déploiement du pilote, (c) avant la production.
- **Impact** : `findOrEnrollDevice` et connexion ; PWA (identifiant d'appareil par utilisateur, ou message) ; réaffectation d'un téléphone d'un vendeur à un autre (désignation « partagé », ou retrait puis nouvel enrôlement) ; AV-258. Défaut implémenté : (a).

### AV-297 — Verrouillage de connexion : essais simultanés, adresse derrière un proxy — SECONDAIRE
- **Question** : comment garantir le blocage progressif (5 échecs, 02-securite §2) quand des essais arrivent en même temps, et compter l'adresse réelle de l'appareil derrière le CDN prévu (04-deploiement §2) ?
- **Pourquoi** : revue adverse de MP-11 : le blocage est lu avant la vérification du mot de passe et l'échec compté après ; N requêtes simultanées passent toutes le contrôle (connexion et changement du mot de passe). Le serveur ne lisait pas l'adresse transmise par un proxy : derrière le CDN, toutes les requêtes auraient l'adresse du CDN, et le compteur par adresse bloquerait tout le monde. **CONFIRMÉ** (lecture du code).
- **Choix** : (a) adresses du proxy de confiance (`TRUST_PROXY`) et limitation de débit au proxy, plus réservation atomique de l'essai avant la vérification (compté d'avance, remis à zéro par une connexion réussie) ; (b) `TRUST_PROXY` et limitation de débit au proxy seulement ; (c) inchangé.
- **Recommandation** : (a) avant la production ; (b) suffit au pilote, l'essai réussi devant de toute façon payer une vérification argon2 (quelques centaines d'essais par palier au plus).
- **Impact** : MP-11 : variable `TRUST_PROXY` (`true`, nombre de proxys, ou liste d'adresses ; désactivée par défaut), à régler au déploiement (P0-17) avec la limitation de débit du CDN. Reste la réservation atomique (`login-lockout.ts`, `auth.controller.ts`), sans changer le refus d'un appareil hors service après un mot de passe juste (AV-253 : aucun échec compté). Défaut implémenté : (b).

### AV-298 — Accès aux écrans de finance et action « + Dépense » de l'accueil — SECONDAIRE
- **Question** : qui voit et utilise les écrans de factures et de paiements fournisseurs, et quels rôles ont « + Dépense » sur leur accueil ?
- **Pourquoi** : l'inventaire réserve ECR-FIN-03 et 04 à la Finance, mais le RBAC donne à la Direction l'approbation des écarts de facture et des paiements au-delà du seuil, l'annulation d'un paiement décaissé (AV-277) et la lecture des dettes, et au Resp. achats la lecture des factures et des dettes (AV-278). Dix rôles peuvent saisir une dépense (`finance.expense.record`), sans action d'accueil. **CONFIRMÉ** (inventaire, RBAC, catalogue de l'accueil).
- **Choix** : (a) Finance : tout ; Direction : lecture, décisions dans la file ou sur la facture (`finance.supplier_invoice.approve`), annulation d'un paiement ; Achats : lecture seule ; « + Dépense » dans le menu des dix rôles, et sur l'accueil des rôles de terrain qui dépensent (vendeur de PDV, commercial terrain, Resp. ferme) — la Finance a sur son accueil « Dépenses » (suivi), « Factures fournisseurs » et « Paiements fournisseurs » et saisit une dépense par le menu ; (b) écrans réservés à la Finance, la Direction passant par la file seule ; (c) « + Dépense » sur l'accueil des dix rôles.
- **Recommandation** : (a).
- **Impact** : `apps/pwa/src/app/screens.ts` (rôles des écrans), `home-api/role-catalog.ts` (action d'accueil), ADR-047. Défaut implémenté : (a). Non paramétrable (menu et accueil).

### AV-299 — Marges par produit, point de vente et commercial — IMPORTANTE
- **Question** : l'écran des coûts et marges (ECR-FIN-06) doit-il montrer dès P8 les marges par produit, point de vente et commercial ?
- **Pourquoi** : l'inventaire annonce « coûts et marges (lot, produit, PDV, commercial) », mais le serveur ne sert que la marge d'un lot et la marge brute d'une période (`GET /finance/overview`). Les autres axes sont prévus dans l'explorateur de P9 (marge sur les lignes de vente) ; une lecture propre à P8 donnerait une seconde définition de la marge (BR-ANA-009). **CONFIRMÉ** (code, plan de P9).
- **Choix** : (a) P8 : lots et période, axes dans l'explorateur de P9 ; (b) lecture propre dès P8, réalignée sur P9 ensuite ; (c) rien sur la marge avant P9.
- **Recommandation** : (a).
- **Impact** : ECR-FIN-06 ; P9 (explorateur, KPI-FIN-07). Défaut implémenté : (a).

### AV-300 — Ce que P8 ajoute à la trésorerie — SECONDAIRE
- **Question** : que doit montrer de plus l'écran de trésorerie (ECR-FIN-05) avec P8 ?
- **Pourquoi** : l'inventaire le marque « P5/P8 » sans dire quoi. Seule la Finance paie une dépense à payer (`finance.expense.pay`) ; la Direction valide les paiements fournisseurs au-delà du seuil. **CONFIRMÉ** (inventaire, RBAC).
- **Choix** : (a) dépenses à payer (payer, annuler), paiements fournisseurs en attente de la Direction (lecture), lien d'un mouvement vers son document ; (b) seulement le lien des mouvements ; (c) rien de plus, les dépenses se paient depuis l'écran des dépenses.
- **Recommandation** : (a).
- **Impact** : `apps/pwa/src/features/treasury/TreasuryScreen.tsx` ; lectures `GET /expenses?status=`, `GET /supplier-payments?status=PENDING_APPROVAL`. Défaut implémenté : (a) (P8E-04 : vue de suivi des dépenses réutilisée sur le groupe « à payer » ; paiements en attente en lecture, lien vers la file des validations pour la Direction ; dépense ou paiement fournisseur ouvert depuis sa ligne de mouvement).

### AV-301 — Site et imputation proposés à la saisie d'une dépense — SECONDAIRE
- **Question** : quel site et quelle imputation de coût l'écran « + Dépense » propose-t-il par défaut ?
- **Pourquoi** : le site est obligatoire (`siteId`) ; il porte la portée, la numérotation et le coût du site (ADR-042 §10). L'appareil ne connaît pas exactement le périmètre de l'utilisateur (S-41) : un site hors de ce périmètre est refusé même hors ligne (`FORBIDDEN_SCOPE`). L'imputation (lot, lot d'incubation, frais généraux d'une espèce, dépense directe du site) est un choix explicite (AV-269), mais une dépense sans objet de coût n'a aucune écriture de coût : elle échappe aux coûts de son site et de son point de vente. **DÉDUIT**
- **Choix** :
  - site : (a) celui de la caisse qui paie s'il est l'un des sites de l'utilisateur, sinon le seul site de ses affectations, sinon un choix parmi ses sites (tous les sites actifs si l'appareil ne connaît aucune de ses affectations, ou si l'une est globale ou d'équipe) ; (b) toujours un choix ; (c) le site de la caisse imposé ;
  - imputation : (a) « dépense directe du site » proposée, avec au choix les lots et lots d'incubation ouverts du site, les frais généraux d'une espèce (ferme seulement) et « non imputée » ; (b) « non imputée » proposée ; (c) imputation obligatoire, sans valeur proposée.
- **Recommandation** : (a) pour les deux : une saisie courte (UX-02) qui garde la dépense dans les coûts de son site.
- **Impact** : `apps/pwa/src/features/finance/expense.ts` (`expenseSites`, `defaultExpenseSite`, `EXPENSE_DEFAULT_IMPUTATION`), ECR-FIN-02. Défaut implémenté : (a) et (a) (P8E-03). Paramétrable : constante de l'appareil (`EXPENSE_DEFAULT_IMPUTATION`).

### AV-302 — Périmètre de l'écran de rapprochement des achats (ECR-APP-05) — SECONDAIRE
- **Question** : qui voit l'écran de rapprochement, comment y entre-t-on, et montre-t-il un retard de livraison ?
- **Pourquoi** : l'inventaire (03-parcours-et-ecrans, UC-APP-12) ne cite que le Resp. achats et la Finance, alors que `procurement.order.read` ouvre aussi la Direction, le Resp. production, le Resp. ferme et le magasinier. UC-APP-12 parle de « retards », mais la seule règle écrite est l'alerte de réception incomplète (BR-APP-015, seuil de 2 jours, AV-065 ouvert), qui relève de P9 ; ADR-047 §8 exclut toute règle de retard propre à l'écran. L'action d'accueil `RECEIPTS` du Resp. achats attend cet écran (F-30, S-27). **DÉDUIT**
- **Choix** :
  - rôles : (a) Resp. achats et Finance (inventaire), plus la Direction en lecture, comme les écrans de factures et de paiements (AV-298) ; (b) l'inventaire seul ; (c) tous les détenteurs de `procurement.order.read` ;
  - retard : (a) constat « date de livraison prévue dépassée de N jours » pour un bon attendu avec un reliquat, sans seuil ni alerte ; (b) rien avant l'alerte de P9 ; (c) le seuil de 2 jours de BR-APP-015 ;
  - accès : (a) menu « Achats » et action `RECEIPTS` du Resp. achats ; (b) menu seulement.
- **Recommandation** : (a) pour les trois : l'écran sert ceux qui suivent les fournisseurs et les dettes, sans seconde définition du retard (une seule, celle de P9, BR-ANA-009).
- **Impact** : `apps/pwa/src/app/screens.ts` (`ROLE_SETS.orderMatching`, entrée ECR-APP-05 et son action `RECEIPTS`), `apps/pwa/src/features/procurement/matching.ts` (`orderIndicators`). Défaut implémenté : (a), (a) et (a) (P8E-07). Les factures du bon ne sont lues que par les lecteurs des dettes (`finance.payable.read`) ; les quantités facturées restent visibles de tout lecteur des bons (P8, ADR-043).

### AV-303 — Périmètre de l'écran « Coûts et marges » (ECR-FIN-06) — SECONDAIRE
- **Question** : qui voit l'écran « Coûts et marges », quelle période propose-t-il, quels lots montre-t-il, et que comptent ses pertes ?
- **Pourquoi** : l'inventaire (03-parcours-et-ecrans) cite la Finance et la Direction, mais le Resp. production lit lots, coûts et pertes valorisés, et le Resp. achats une vue d'ensemble partielle. Aucune lecture ne rend les marges de plusieurs lots : seule la fiche d'un lot les porte (S-41), une liste de marges coûterait une lecture par lot. `GET /finance/overview` n'accepte qu'un intervalle de jours, sans période nommée ni plafond. BR-FIN-044 compte dans la valeur des pertes les ajustements d'inventaire négatifs, alors que `GET /losses/summary` ne lit que les déclarations, et une quantité n'a de sens que par produit. **DÉDUIT**
- **Choix** :
  - rôles : (a) Finance et Direction (inventaire), menu « Finance » seulement ; (b) plus le Resp. production ; (c) plus le Resp. achats ;
  - période : (a) mois en cours à ce jour par défaut, raccourcis semaine, jour et année en cours, autre période d'un an au plus, jamais après aujourd'hui ; (b) plafond plus long ;
  - lots : (a) un lot choisi parmi les 50 plus récents d'un statut (en cours, en vente, clôturés), sa fiche et ses écritures de coût à la demande ; (b) un tableau des marges de plusieurs lots (lecture serveur dédiée à créer) ;
  - pertes : (a) les déclarations seulement, quantités par produit, déclarations par lot ou par motif ; (b) avec les écarts d'inventaire négatifs (BR-FIN-044), lecture serveur à étendre.
- **Recommandation** : (a) pour les quatre ; le tableau des marges et les écarts d'inventaire viendront avec l'explorateur de P9 (AV-299), sur une seule définition (BR-ANA-009).
- **Impact** : `apps/pwa/src/app/screens.ts` (`ROLE_SETS.costsMargins`), `apps/pwa/src/features/finance/costs.ts` (`DEFAULT_COST_PERIOD`, `namedPeriod`, `LOT_STATUSES`, `LOT_PAGE_LIMIT`), ECR-FIN-06. Défaut implémenté : (a) pour les quatre (P8E-08). La fiche complète d'un lot reste ouverte depuis l'écran aux seuls rôles de la fiche (Resp. production, Direction).

### AV-304 — Périmètre de l'écran des créances (ECR-FIN-01) — SECONDAIRE
- **Question** : qui voit l'écran des créances, que montre-t-il, quelles suites propose-t-il (encaisser, relancer), et à quelle date ?
- **Pourquoi** : l'inventaire (03-parcours-et-ecrans) nomme la Finance et le Resp. commercial et titre « Encaissements et créances », ADR-047 §9 ne cite que l'ancienneté et l'action d'accueil `RECEIVABLES` de la Finance ; le droit `sales.receivable.read` est tenu par sept rôles (DIR et FIN ALL, RCO TEAM, commerciaux OWN, VEN et RFE SITE). Aucune source ne spécifie de relance de paiement : le CM §44 laisse à Kommo une part importante des relances, dans un contexte commercial, et AV-019 les y garde ; l'indice d'accueil « Suivi et relances » promet plus que la lecture seule. `GET /receivables` n'est ni paginé ni nommé (identifiants seuls), et `as_of` ne recalcule que l'ancienneté, pas les soldes passés. Une créance non échue porte la tranche « 0-30 » ; seule l'échue entre dans les tranches de la synthèse. **DÉDUIT**
- **Choix** :
  - rôles : (a) Finance, Direction et Resp. commercial (inventaire plus la Direction, comme AV-303), action `RECEIVABLES` de la Finance seule ; (b) plus les commerciaux, qui reçoivent le signal « créances échues » ; (c) les sept détenteurs du droit ;
  - contenu : (a) créances seules — encours du jour, échu par tranche de retard, créances par client ou par titulaire, ventes à la demande —, l'encaissement restant à ECR-VEN-06 (« Encaisser », « Encaisser le reste dû ») pour les rôles qui encaissent ; (b) avec les encaissements de la période et le crédit client non affecté (lecture serveur à créer) ;
  - relances : (a) aucune trace dans GIC : appel du client quand son téléphone est connu, relance par le commercial ou dans Kommo ; (b) journal des relances dans GIC (commande et droit à créer) ;
  - date : (a) situation du jour, sans choix de date ; (b) date choisie (ancienneté seule recalculée) ;
  - présentation : « à échoir » à part, l'échu en « 1 à 30 jours de retard », « 31 à 60 », « 61 à 90 », « plus de 90 » ; vues toutes, échues, à échoir ou par tranche, site, regroupement par client (compte conservé d'un compte fusionné) ou par titulaire (commercial attributaire, à défaut vendeur, comme la portée du serveur) ;
  - volume : (a) liste complète, noms des clients absents de l'appareil lus en ligne (10 pages de 200, comptes fusionnés compris), au-delà identifiant abrégé annoncé ; (b) pagination serveur.
- **Recommandation** : (a) partout ; la pagination se décidera sur les volumes du pilote.
- **Impact** : `apps/pwa/src/app/screens.ts` (`ROLE_SETS.receivables`, entrée ECR-FIN-01 et son action `RECEIVABLES`), `apps/pwa/src/features/finance/receivables.ts` (`RECEIVABLE_VIEWS`, `ownerOf`, `CUSTOMER_NAME_MAX_PAGES`), ECR-FIN-01 ; l'indice d'accueil « Suivi et relances » de `apps/server/src/home-api/role-catalog.ts` est devenu « Suivi des retards » (revue de P8E-10), l'écran n'enregistrant aucune relance. Le lien d'encaissement vise toujours le compte conservé d'un client fusionné (l'encaissement sur un compte absorbé est refusé en ligne, BR-CRM-007), sans lien pour un client que la lecture complète des clients ne connaît pas (hors de la portée de l'utilisateur). Défaut implémenté : (a) partout (P8E-09).

### AV-305 — Créances hors de la liste et écarts avec l'accueil (ECR-FIN-01) — SECONDAIRE
- **Question** : comment traiter ce que `GET /receivables` ne montre pas, ou montre autrement que l'accueil et la vue d'ensemble (BR-ANA-009, AT-054) ?
- **Pourquoi** : (1) une vente sans échéance (vente sans client identifié restée impayée, AV-137) a un solde mais n'entre pas dans la liste, qui exige une échéance, alors que l'accueil et `GET /finance/overview` la comptent : le total de l'écran peut être inférieur ; (2) la liste rattache une créance au commercial attributaire, à défaut au vendeur, l'accueil au « vendeur ou commercial » : écart possible pour les portées TEAM et OWN ; (3) une vente en demande d'annulation reste une créance sans marque ; (4) les lignes ne portent ni nom ni téléphone, et le filtre `customer_id` n'étend pas aux comptes absorbés (S-22 ; contourné côté appareil par l'écran d'encaissement, une lecture par compte) ; (5) le signal d'accueil `OVERDUE_RECEIVABLE` n'a pas d'action et ne mène à aucun écran ; (6) `as_of` d'une date inexistante donne une erreur 500. **DÉDUIT**
- **Choix** : (a) écran tel quel — ventes sans échéance annoncées comme exclues, noms lus en ligne, comptes fusionnés regroupés sur l'appareil, aucune marque d'annulation demandée — et correctifs serveur groupés : nom, téléphone et compte conservé dans les lignes, montant et nombre des ventes sans échéance dans `summary`, action « Voir les créances échues » du signal (rôles à arrêter avec AV-304 (b)), titulaire unique pour l'accueil et la liste, 400 sur une date inexistante ; (b) corriger le serveur dans P8E-09.
- **Recommandation** : (a) ; le serveur de P9 est mené en parallèle sur les mêmes fichiers (accueil, métriques) : les correctifs se font à son intégration.
- **Impact** : `apps/pwa/src/features/finance/ReceivablesScreen.tsx` (note de périmètre), `apps/server/src/modules/sales/application/public/receivables.ts`, `apps/server/src/sales-api/sales-read.controller.ts`, `apps/server/src/home-api/home-service.ts` et `apps/server/src/modules/sales/application/public/home-metrics.ts` (correctifs à venir). Défaut implémenté : (a) côté écran (P8E-09).

### AV-306 — Pièce citée par une opération : existence, document et auteur non vérifiés — SECONDAIRE
- **Question** : le serveur doit-il vérifier qu'une pièce citée dans `attachment_ids` existe, appartient au document de l'opération et a été déposée par son auteur ?
- **Pourquoi** : `expense-commands.ts` compte `attachment_ids.length > 0` comme justificatif présent ; une commande forgée qui cite un identifiant inventé lève le motif `ATTACHMENT_MISSING` d'une dépense (entre 10 000 et 50 000 XAF avec les seuils par défaut : ni refus en ligne ni revue). Au-delà du seuil de validation, l'exigence reste portée par la demande et la validation reste bloquée tant qu'aucune pièce de l'auteur n'existe. La réception et la perte font la même présomption depuis P6 et P7 ; le lot P8E l'étend aux dépenses. La PWA cite toujours sa propre pièce. L'enregistrement d'une pièce ne vérifie pas non plus le droit de son auteur sur le document (AV-093). **CONFIRMÉ** (code, revue de P8E-10)
- **Choix** : (a) présomption conservée jusqu'au pilote, contrôle groupé avec AV-093 et AV-293 (en ligne : exiger que chaque pièce citée soit enregistrée pour ce document par l'auteur ; hors ligne : fait accompli, l'identifiant non conforme est retiré du compte et le motif `ATTACHMENT_MISSING` ajouté) ; (b) contrôle dès maintenant.
- **Recommandation** : (a) pour le groupe pilote ; (b) avant l'ouverture à d'autres utilisateurs.
- **Impact** : `apps/server/src/modules/finance/application/commands/expense-commands.ts`, `receipt-commands.ts`, `loss-commands.ts`, `attachment-query.ts` (`requiredAttachmentsSatisfied`). Défaut implémenté : (a).

### AV-307 — Poste de bureau des rôles de bureau et exception de RC-02 — SECONDAIRE
- **Question** : le navigateur de bureau d'un utilisateur Direction, Admin, Finance ou Resp. achats est-il un appareil à approuver comme les autres, ou exempté ?
- **Pourquoi** : RC-02 (`01-rbac.md`) prévoit que le back-office web de ces rôles, « enregistré comme appareil de type navigateur de bureau », échappe à l'exigence d'un appareil `ACTIVE`. Le code ne l'implémente pas : `device-check.ts` exige `ACTIVE` pour tout appareil, un appareil `PENDING` met ses commandes en attente (AV-006, AV-228). ADR-047 avait écrit que le poste de bureau de la Finance « s'approuve comme tout appareil (RC-02) », ce que RC-02 ne dit pas. **CONFIRMÉ** (code, texte)
- **Choix** : (a) poste de bureau enregistré comme appareil de type navigateur de bureau et approuvé comme tout appareil (défaut implémenté, traçable, un seul chemin) ; (b) exemption du back-office web de ces quatre rôles, sans approbation.
- **Recommandation** : (a) pour le pilote ; (b) à revoir quand le back-office web est exposé hors du réseau de GIC.
- **Impact** : `docs/07-security-rbac/01-rbac.md` (RC-02, à aligner une fois tranché), `apps/server/src/modules/identity/application/public/device-check.ts`, ADR-047. Défaut implémenté : (a).

### AV-308 — Référence de la pièce papier : champ dédié ou généralisation de `local_ref` — IMPORTANTE
- **Question** : où garder le numéro imprimé sur un carnet (saisi à la main) : un champ dédié commun à toutes les opérations, ou le champ `local_ref` existant ?
- **Pourquoi** : le porteur a choisi « un champ pièce papier commun à toutes les opérations » (D2, 20/10/2026, **CONFIRMÉ**). Il croyait le champ absent pour le transfert, la perte, l'inventaire et la remise de fonds : or `local_ref varchar(20)` existe sur 13 tables (liste dans `docs/10-development-plan/19-pieces-papier.md` §3) et manque sur la visite, la session de travail, la session de caisse, les paiements et factures fournisseurs, les consommations d'intrant, les pesées et les collectes d'œufs. `local_ref` est, par convention (conventions §1.4), une référence d'appareil `{CODE_APPAREIL}-{seq6}` ; huit commandes l'acceptent (vente, commande, encaissement, livraison, réception, demande d'achat, dépense, remise de fonds), la PWA ne l'envoie dans aucune charge utile, et il sert à signaler un doublon (`LOCAL_REF_DUPLICATE` pour la dépense) ; le numéro d'un carnet est **saisi** et propre à un type de pièce. **CONFIRMÉ** (schéma, code)
- **Choix** : (a) réutiliser `local_ref` avec un préfixe de pièce (`RE-000123`) : aucune migration sur les 13 tables, mais deux sens dans un même champ et rien pour les tables sans `local_ref` ; de plus `local_ref` est unique par (appareil, référence) sur 12 tables (hors bons de commande fournisseur) : un numéro déjà pris est rejeté en ligne (`LOCAL_REF_DUPLICATE`) et effacé hors ligne, ce qui contredit « doublon signalé, jamais rejeté » (BR-SYN-007) ; il est immuable après insertion (un numéro de carnet mal saisi ne se corrige pas) ; et aucune commande ne reçoit `localRef` pour les transferts, pertes, inventaires, bons de commande fournisseur et annulations de vente : le contrat de ces commandes est à étendre même avec (a) ; (b) colonne dédiée (`paper_ref` : code de la pièce et numéro) facultative sur chaque table d'opération concernée, sans contrainte d'unicité : un doublon est signalé par un conflit informatif, jamais rejeté (BR-SYN-007), index par type de pièce, site et numéro.
- **Recommandation** : (b), conforme au choix du porteur et sans ambiguïté pour le contrôle de continuité (AV-312).
- **Impact** : migrations par module propriétaire (hors des plages réservées de la session P9), contrats de commande (champ facultatif), jeux hors ligne, projections, écrans de saisie ; dictionnaire des tables. À trancher en PP-0. Défaut retenu pour la conception : (b). Rien n'est implémenté.

### AV-309 — Rendu des pièces : composants de la PWA, police libre, consultation et impression sur le même rendu — IMPORTANTE
- **Question** : comment l'application reproduit-elle la mise en page des pièces papier, à l'écran et à l'impression, y compris hors ligne ?
- **Pourquoi** : le porteur veut imprimer chaque opération dans la mise en page de la pièce (D1) et consulter une opération dans cette même mise en page (22/10/2026). **CONFIRMÉ**. Les gabarits d'origine (`pieces-papier/gabarits/*.html`) utilisent *Segoe UI* et *Bahnschrift*, polices Windows non redistribuables et absentes des téléphones ; le logo doit être disponible hors ligne ; la prise en charge de `@page size` est limitée sur iOS ; les imprimantes de bureau sont souvent en noir et blanc ; le montant en lettres demande une fonction pure en français (règle 6). **DÉDUIT**
- **Choix** : (a) un composant de la PWA par type de pièce, alimenté par les données locales de l'opération, le même pour l'écran de consultation et pour l'impression (`window.print()`, `@page` A5 paysage, A5 portrait, A4 portrait ou A4 paysage selon la pièce), police libre embarquée, logo dans le pré-cache du service worker, repli sans `@page` ; la souche n'est pas imprimée ; (b) PDF produit par le serveur : écarté, il exclut le hors ligne (D1).
- **Recommandation** : (a). Les rubriques de chaque composant sont comparées à `CORRESPONDANCE-APPLICATION.xlsx` par un test, dont l'oracle (extraction versionnée de la feuille « Champs » du classeur du porteur, aujourd'hui hors du dépôt) est à verser dans `docs/` ou en fixture en PP-0 ; pas de source HTML commune avec le dossier papier. Le dossier d'origine tolère, à défaut de mise en page identique, le respect de la charte (vert, orange doré, logo) : **DÉDUIT**, à confirmer par le porteur.
- **Impact** : `apps/pwa` (composants, feuille d'impression, service worker), `packages/domain` (montant en lettres), écrans de détail à ajouter pour les opérations qui n'en ont pas, ADR « impression des pièces » à rédiger en PP-0. Défaut retenu pour la conception : (a).

### AV-310 — Mentions de la pièce imprimée : numéro, duplicata, annulation, données personnelles — SECONDAIRE
- **Question** : que porte une pièce imprimée par l'application, et qui peut l'imprimer ?
- **Pourquoi** : la pièce est un support probant ; l'application ne supprime rien (ADR-006) ; une réimpression ne doit pas passer pour l'original ; la pièce porte des données personnelles (nom, téléphone du client) et, parfois, des coûts. **DÉDUIT**
- **Choix** : (a) numéro imprimé = `doc_number` s'il est connu, sinon le numéro de la pièce papier (AV-308), sinon `local_ref` hors ligne ; réimpression marquée « DUPLICATA » avec sa date, décidée par un marqueur local écrit sur l'appareil à la première impression (une impression faite sur un autre appareil, hors ligne avant l'envoi ou après un effacement des données du navigateur n'est pas reconnue ; la trace serveur est l'option (b)) ; opération annulée marquée par un bandeau « ANNULÉE » ; nom et téléphone du client imprimés seulement pour qui les voit déjà à l'écran ; valeurs au coût jamais imprimées sans droit de valorisation (RC-05) ; imprimer n'est pas une écriture métier (aucune commande, aucune migration, aucune permission ; seul le marqueur local est écrit) ; (b) en plus, tracer chaque impression dans le journal d'audit (écrit côté serveur : impossible hors ligne sans envoi d'une commande).
- **Recommandation** : (a) ; (b) seulement si la Direction veut tracer les réimpressions (option « 2 exemplaires, client et comptabilité » à décider avec le porteur).
- **Impact** : composants de pièce ; aucune migration. Défaut retenu pour la conception : (a).

### AV-311 — Journal de caisse imprimé : contenu hors ligne et pagination — SECONDAIRE
- **Question** : que montre le journal d'un compte hors ligne, et comment se répartit un jour de plus de 28 opérations ?
- **Pourquoi** : le porteur veut un journal par compte de trésorerie imprimé par l'application (D4), valable aussi pour la caisse d'un commercial (D5, sans comptage par coupures). Les mouvements sont dans `finance_cash_movements` (lecture `GET /cash-accounts/{id}/movements`, ECR-FIN-05) ; la session de caisse ne concerne que la caisse d'un point de vente (BR-FIN-014, AV-165 ; BR-FIN-002 et BR-FIN-010 pour le compte crédité et les types de compte) ; la feuille papier compte 28 lignes, le porteur parle de 25 à 40 opérations par jour. Le jeu hors ligne `cash` ne porte **aucun** mouvement de trésorerie (comptes, sessions, remises, dépenses de l'auteur sur 30 jours) : hors ligne, le journal se reconstruit sur l'appareil à partir de `cash`, de `sales_recent` (encaissements des 7 derniers jours) et de la boîte d'envoi, comme le fait `pendingCashMovements`. La lecture `GET /cash-accounts/{id}/movements` ne rend ni numéro de pièce, ni libellé, ni mode de paiement, ni session (le mode vit sur `sales_customer_payments`) et trie par identifiant ; JE (encaissements par mode) se source sur les encaissements, non sur les mouvements (qui contiennent aussi transferts et remboursements). **CONFIRMÉ** (schéma, code, dossier papier) ; le choix de la reconstruction locale est **DÉDUIT**
- **Choix** : (a) en ligne, état complet d'un compte pour un jour métier (fuseau `Africa/Douala`) ; hors ligne, journal reconstruit localement et marqué « partiel » (il ne peut montrer ni les paiements fournisseurs, ni les encaissements de plus de 7 jours, ni les mouvements d'un autre auteur sur une caisse partagée) ; feuilles de 28 lignes avec report du sous-total ; pied de feuille par type de compte : `CAISSE_PDV`, rapprochement avec la session de caisse (fonds d'ouverture, entrées, sorties, solde théorique, comptage, écart) ; `CAISSE_UTILISATEUR`, totaux sans comptage ; `CAISSE_CENTRALE`, à décider en PP-0 ; mobile money et banque, totaux par mode sans comptage ; (b) en ligne seulement.
- **Recommandation** : (a).
- **Impact** : PWA (état et composant de pièce FJC et JE) ; lecture existante **à étendre** (jointure sur le document source pour le numéro, le libellé et le mode, ou composition côté PWA : à trancher en PP-0), tri par `occurred_at` fait côté PWA sur un jour (200 lignes au plus par page) ; aucune migration. Défaut retenu pour la conception : (a).

### AV-312 — Registre des carnets : contrôle de continuité — SECONDAIRE
- **Question** : comment l'application contrôle-t-elle la continuité des numéros d'un carnet, sachant que le registre reste sur papier ?
- **Pourquoi** : choix du porteur (D7, 20/10/2026) : registre papier et contrôle par les références saisies. **CONFIRMÉ**. Dépend de AV-308. Il faut dire quelle plage est « attendue » et qui consulte.
- **Choix** : (a) d'après les seules références saisies, par type de pièce et par site : numéros manquants entre le plus petit et le plus grand saisis, doublons ; état consulté à la demande par la Finance et le responsable de site ; aucune table nouvelle ; (b) plages attendues saisies à la remise d'un carnet (nouvelle entité) avec alerte de manque.
- **Recommandation** : (a) maintenant ; (b) et l'alerte avec le catalogue d'alertes de P9.
- **Impact** : PWA et lecture ; aucune migration en (a). Défaut retenu pour la conception : (a).

### AV-313 — Présence du personnel non commercial — IMPORTANTE
- **Question** : l'application enregistre-t-elle la présence des ouvriers et du personnel administratif, pour quel usage, et sous quelle forme ?
- **Pourquoi** : choix du porteur (D6) : petite table de présence alimentée chaque semaine à partir de la fiche PT. Le pointage couvre aujourd'hui les seuls commerciaux de terrain (`fieldwork.work_sessions`, `analytics.f_attendance`, ECR-TER-02) ; ouvriers et administratifs n'ont peut-être pas de compte. Ce sont des données personnelles. Il ne faut pas compter deux fois les jours de présence des commerciaux. **CONFIRMÉ** (choix), **À VALIDER** (usage)
- **Choix** : (a) table légère (jour, personne, site, arrivée, départ, code d'absence, source `PAPER`, lot d'import hebdomadaire), `user_id` facultatif et nom de la personne ; usage statistique et de suivi, sans paie ; portée de lecture au site et à la Direction ; (b) un compte utilisateur pour tout le personnel : écarté ici ; (c) hors application.
- **Recommandation** : (a) ; l'usage (paie, discipline, statistiques) est à confirmer par le porteur avant PP-E.
- **Impact** : nouvelle table (module propriétaire à décider en PP-0), import hebdomadaire (AV-317), `analytics.f_attendance` (P9). Défaut retenu pour la conception : (a).

### AV-314 — Bilan hebdomadaire du commercial — SECONDAIRE
- **Question** : quelle entité porte le bilan hebdomadaire du commercial et que contient-elle ?
- **Pourquoi** : choix du porteur (D8) : fiche papier BH et écran dans l'application. Le bilan n'existe pas ; `communication.internal_notes` est la note de direction (sens inverse) et ne convient pas. Le principe du contexte métier veut qu'aucun indicateur ne soit saisi. **CONFIRMÉ**
- **Choix** : (a) entité « bilan hebdomadaire » (commercial, lundi de la semaine, réussites, difficultés, besoins et demandes à la direction, priorités, informations du marché, vu par le responsable, commentaire du responsable) ; chiffres (visites sur place, nouveaux prospects et clients, CA, encaissé, casses et pertes) calculés depuis les données existantes ; (b) réutiliser les notes de direction : écarté.
- **Recommandation** : (a), en coordination avec la session P9 (plages d'AV, d'ADR et de migrations réservées).
- **Impact** : nouvelle entité, commandes `crm` ou `analytics` selon le propriétaire retenu en PP-0, écran. Défaut retenu pour la conception : (a).

### AV-315 — Veille marché dans la visite — SECONDAIRE
- **Question** : comment enregistrer le fournisseur ou le concurrent et le prix constaté pendant une visite ?
- **Pourquoi** : choix du porteur (D9) : rubriques structurées sur la fiche de visite et dans la visite. La visite a des notes, un résultat et une prochaine action, **rien** sur le fournisseur ou le prix d'un concurrent. La fiche VC d'origine n'a qu'une ligne de veille : plusieurs relevés par visite sont une généralisation **DÉDUITE**, à confirmer. **CONFIRMÉ** pour le choix D9 et le schéma.
- **Choix** : (a) table fille de la visite (visite, type fournisseur ou concurrent, nom en libellé libre, produit, unité, prix constaté) ; (b) colonnes sur la visite : écartées (un seul relevé).
- **Recommandation** : (a) ; un référentiel de concurrents plus tard, si la veille s'étend.
- **Impact** : le CRM (P3) est clos : migration, contrat de la commande de visite, jeu hors ligne `crm_activity`, fiche VC. Défaut retenu pour la conception : (a).

### AV-316 — Profil commercial du client — IMPORTANTE
- **Question** : où et comment enregistrer le produit d'intérêt, le potentiel par jour et le mode de paiement habituel d'un client ?
- **Pourquoi** : choix du porteur (D10). Le compte client a `credit_allowed`, `credit_limit_xaf`, `payment_terms_days`, `business_activity`, `category_id`, pas ces trois informations. `credit_allowed` est une **décision du responsable** (AV-028) : la demande de paiement différé du commercial est distincte. La fusion « champ par champ avec version » des comptes modifiés sur deux appareils doit couvrir les nouveaux champs. **CONFIRMÉ**
- **Choix** : (a) trois champs sur le compte (produit d'intérêt, potentiel par jour en quantité et unité, mode de paiement habituel) et une demande de crédit (`credit_requested`) distincte de `credit_allowed` ; versions par champ, doublons et fusion étendus ; (b) table séparée « profil » : écartée, le compte reste le propriétaire.
- **Recommandation** : (a).
- **Impact** : `crm_customers` (migration), commandes de compte, matrice des conflits, jeu hors ligne `customers`, fiche VC. Défaut retenu pour la conception : (a).

### AV-317 — Écran de report et import par lots des pièces papier — IMPORTANTE
- **Question** : comment une pièce papier, ou un lot de pièces anciennes, entre-t-elle dans l'application, par qui, et que devient une ligne en erreur ?
- **Pourquoi** : choix du porteur (D11) : écran de report pour le courant, import par lots pour l'historique, délai de 24 h conseillées et 72 h au maximum (D12). L'import étend AV-072 (modèles CSV : clients, fournisseurs, produits, lots, inventaire d'ouverture). Toute écriture passe par les commandes idempotentes (règle 3). **CONFIRMÉ** (choix), **À VALIDER** (qui, où séjournent les lignes en attente, reprise sur erreur, colonnes hors modèle)
- **Choix** : (a) **écran « Reporter une pièce papier »** par type de pièce, champs dans l'ordre de la pièce, date et heure de la pièce = heure métier, numéro de la pièce (AV-308), doublon signalé, photo de la pièce jointe (ADR-012, ADR-046), annulation par contre-écriture ; **import** de fichiers Excel ou CSV avec fichier modèle tiré de `CORRESPONDANCE-APPLICATION.xlsx`, lignes en attente côté serveur, validation avant chargement du lot, clé d'import par ligne pour l'idempotence, rapport d'erreurs et reprise ligne par ligne, colonnes hors modèle listées au rapport et ignorées ; importeurs : Admin, Finance, responsable de site dans sa portée ; (b) import réservé à l'Admin, sans écran de report.
- **Recommandation** : (a). Le jeu de données de GIC est nécessaire pour PP-C ; l'Excel `fiches-terrain/commercial/` est un premier jeu de test.
- **Impact** : écran PWA, module d'import avec tables d'attente (PP-C), modèles de fichier ; fenêtre d'antidatage d'AV-078 appliquée aux commandes concernées. Défaut retenu pour la conception : (a).

### AV-318 — Politiques de validation par défaut du stock et du pointage — IMPORTANTE
- **Question** : sur une base neuve, quelles politiques de validation portent l'écart d'un transfert reçu, l'écart d'un inventaire non biologique et la dérogation de pointage, et qui approuve ?
- **Pourquoi** : vérification contradictoire des constats d'écran (relue sur le code du 22/10/2026, groupe « validations », C3-A). Le seed ne portait aucune politique `TRANSFER_DISCREPANCY`, `INVENTORY_ADJUSTMENT` ni `CHECKIN_OVERRIDE` (AV-294 n'avait traité que les achats). Sur une base issue du seul seed : la réception d'un transfert avec écart était refusée `CONTROL_POLICY_MISSING`, même hors ligne alors que c'est un fait physique (BR-SYN-007) ; un inventaire non biologique au-dessus du seuil `inventory.count_approval_threshold_xaf` était refusé ; la dérogation de pointage était refusée, et une prise de service acceptée sur l'appareil puis refusée par le serveur créait une session `PENDING` sans demande, donc sans décideur. Les tests créaient eux-mêmes leur politique, ce qui masquait le défaut. **CONFIRMÉ** (code, seed)
- **Choix** : (a) une politique par type, sans condition (`{}`), validation systématique, approbateurs selon 01-rbac : `inventory.transfer_discrepancy.approve` (Direction et Resp. production partout, Resp. ferme et magasinier sur leur site), `inventory.count.approve` (Direction, Finance, Resp. production, Resp. ferme sur son site, Resp. commercial sur sa zone), `fieldwork.checkin_override.approve` (Direction, Resp. commercial pour son équipe) ; (b) idem, mais application sans demande quand le fait est déjà accompli hors ligne (comme AV-183 ; AV-294 l'avait laissé en reste) ; (c) rien de semé, l'Admin crée les politiques (aucun écran avant ECR-ADM-07).
- **Recommandation** : (a).
- **Impact** : `db/seeds/stock-fieldwork-references.ts`, `db/seeds/run.ts`, `db/tests/seed.test.ts`. Défaut implémenté (MP-12, 22/10/2026) : (a), semé par code absent seulement, jamais réécrit. Revue adverse du lot, corrigée dans le même incrément : la politique retenue est la plus récente **qui se décide** (`decidablePolicyFor`, `isDecidablePolicy` : validation exigée et approbateur nommé ; une version révisée par `approvals.policy.set` sans approbateur n'est plus retenue, elle créait une demande que personne ne peut décider) ; hors ligne, repli sur la politique en vigueur à la réception de la commande pour l'écart d'un transfert reçu, l'inventaire au-dessus du seuil et la dérogation de pointage (une révision entre le fait et l'envoi ne le rend plus refusé, BR-SYN-007) ; la demande d'écart de transfert porte la valeur de l'écart au coût (masquée sans droit de valorisation, RC-05). **Reste** : (1) si l'Admin retire ou désactive la politique, ou qu'aucune ne se décide, l'écart de transfert, l'inventaire au-dessus du seuil et la dérogation sont de nouveau refusés `CONTROL_POLICY_MISSING`, hors ligne comprise (même reste qu'AV-294) ; (2) la prise de service acceptée sur l'appareil puis refusée par le serveur ouvre alors une session `PENDING` sans demande (`checkin-commands.ts`) ; (1) et (2) se corrigent avec le choix (b) si le porteur le retient ; (3) les politiques d'achat (`activePolicy` des achats) et de perte n'ont pas ce repli ni ce filtre. Les tests de commande posent eux-mêmes leur politique : le choix de la politique semée est prouvé par `seed.test.ts` (existence, approbateur du catalogue) et `approvals-decidable-policy.test.ts`. La base de référence `gic_agropelc_mp8m` a reçu les trois politiques ; les autres bases les reçoivent par `pnpm db:seed`.

### AV-319 — Cadence du tirage de l'appareil et écriture du dernier pull — IMPORTANTE
- **Question** : à quelle fréquence un appareil tire-t-il le flux, et que le serveur enregistre-t-il à chaque tirage ?
- **Pourquoi** : vérification contradictoire (C20, même run). Le moteur lançait un cycle toutes les 30 s, sans condition, et tirait 35 jeux un par un ; chaque tirage, même vide, réécrivait deux lignes de `sync_device_sync_state` (AV-202 a) : environ 70 écritures par cycle, 8 400 par heure et par onglet, pour un seuil de retard de deux heures. Écarts avec NFR-09 (« aucun traitement périodique plus fréquent que toutes les 5 min, pas de polling en arrière-plan »), RISK-16, `02-synchronisation.md` §4 (attente progressive `min(15 min, 5 s × 2^n)` avec gigue, non codée : ADR-039 §46) ; la charge de 35 appels par cycle pèse aussi sur la résilience en 2G visée par NFR-19. **CONFIRMÉ** (code, chiffres DÉDUITS à mesurer)
- **Choix** : (a) statu quo, 35 jeux toutes les 30 s ; (b) 60 s au premier plan pour les jeux d'exploitation, 10 min pour les référentiels, tirage groupé de plusieurs jeux par appel (S-03), déclencheurs au démarrage, au retour de visibilité, à `online` et après un envoi ; (c) 5 min partout (NFR-09 à la lettre) avec les mêmes déclencheurs ; (d) intermédiaire retenu par défaut : cadence de 30 s inchangée au premier plan, mais rien pendant qu'un onglet est masqué ; au retour au premier plan, un cycle aussitôt si le dernier date d'au moins 15 s (un cycle commencé avant la mise en arrière-plan, ou long, est suivi d'un cycle neuf) ; attente doublée (30 s, 60 s, 120 s) tant que le réseau ou le serveur ne répond pas, plafonnée à 2 min et sans gigue, remise à 30 s par le retour du réseau, le retour au premier plan ou un cycle réussi ; une exception du cycle (réponse inattendue, base locale pleine) compte comme une erreur du serveur ; dernier pull écrit au plus une fois par pas de `sync.pull_record_grain_seconds` (60 s : la valeur lue a entre 60 et 90 s d'âge).
- **Recommandation** : (b), par paramètres (`sync.pull_hot_interval_seconds`, `sync.pull_reference_interval_minutes`), une fois confirmé que l'envoi périodique au premier plan est une exception admise à NFR-09.
- **Impact** : `apps/server/src/sync/sync-pull.service.ts`, `db/seeds/system-settings.ts` (`sync.pull_record_grain_seconds`), `apps/pwa/src/sync/engine.ts` (`SyncEngine`, `nextCycleDelayMs`). Défaut implémenté (MP-12, 22/10/2026) : (d). Conséquences à connaître : (i) tant qu'un cycle n'a pas réussi l'appareil s'affiche « hors ligne » (`connectivity.ts`) ; sur un Wi-Fi sans Internet, aucun événement `online` ne revient et l'état dure jusqu'à 2 min, levé par une saisie, le retour au premier plan ou « Forcer la synchronisation » ; (ii) un onglet masqué (écran éteint) ne tire plus : `last_pull_at` ne bouge plus et le signal « appareil sans contact depuis plus de 2 h » (BR-ANA-005, AV-202, accueil et tableau de distribution) peut compter des tablettes saines ; au porteur de choisir entre l'accepter, un seuil distinct ou un signal fondé sur `pending_reported` et le dernier envoi (retenter l'envoi de l'outbox page masquée reste possible, NFR-09 vise le tirage) ; (iii) `02-synchronisation.md` §4 est aligné sur le moteur livré, ADR-039 §46 est dépassé en partie ; la gigue de ±20 % et l'alerte à 20 échecs ne sont pas codées ; (iv) les durées sont des constantes du paquet de la PWA, sans paramètre. **Reste** : (b), c'est-à-dire le tirage groupé (S-03), les deux cadences paramétrables (`sync.pull_hot_interval_seconds`, `sync.pull_reference_interval_minutes`) ; la mesure du nombre de requêtes de tirage par minute et par appareil (RISK-29) ; l'attente progressive de l'envoi quand rien n'est réglé (appareil `PENDING`, commande bloquée), qui ne dépend pas du résultat réseau.

### AV-320 — Motifs par défaut des autres catégories (rejet, inventaire, écart de transfert, prix) — IMPORTANTE
- **Question** : faut-il semer des motifs par défaut pour `REJECTION`, `LOSS`, `INVENTORY_ADJUSTMENT`, `PRICE_OVERRIDE`, `TRANSFER_DISCREPANCY`, `CHECKIN_OVERRIDE` et `CASH_VARIANCE`, comme pour AV-248 ?
- **Pourquoi** : vérification contradictoire (C7b). Seuls `PRODUCTION_YIELD` et les trois catégories de CRM sont semés. Sur une base neuve, un rejet de marchandise à la réception exige un motif (écran : `REASON_REQUIRED`, serveur : `REJECTION_REASON_REQUIRED`) et la liste est vide : on ne peut pas rejeter. Les listes de perte, d'ajustement d'inventaire, de prix et d'écart de transfert sont vides. Le suivi existant dit seulement « données GIC » (S-24, AV-072). **CONFIRMÉ** (code)
- **Choix** : (a) listes courtes, désactivables et modifiables (MP-11), « Autre » avec commentaire exigé : par exemple `REJECTION` (périmé, abîmé, non conforme, quantité erronée, autre) et `INVENTORY_ADJUSTMENT` (erreur de comptage, casse, péremption, autre), libellés à valider avec GIC ; (b) seulement `REJECTION` et `PRICE_OVERRIDE` ; (c) rien, l'administrateur crée les motifs dans la section « Motifs » du catalogue.
- **Recommandation** : (a).
- **Impact** : nouveau fichier de seed de motifs, `seedReasonCodes`, `loss_category` pour `LOSS`, `db/tests/seed.test.ts`, dictionnaire `03-catalog-pricing.md`. **Défaut non implémenté** : le contournement est (c). À poser au porteur avant le pilote.

### AV-321 — Quantités préremplies à la réception d'un transfert et d'un bon de commande — SECONDAIRE
- **Question** : la réception d'un transfert (et d'un bon de commande) propose-t-elle la quantité expédiée (ou le reste) comme quantité reçue, ou démarre-t-elle vide comme l'inventaire ?
- **Pourquoi** : vérification contradictoire (C24). `ReceiveTransferScreen.tsx` initialise chaque quantité reçue à l'expédié ; le bouton est actif sans aucune saisie. C'est consigné dans le suivi des écrans (F-11, F-25) mais jamais soumis au métier. Le CM §22 veut savoir ce qui a été reçu et les différences, §28 que le réceptionnaire confirme ce qui est réellement reçu : un défaut qui valide d'office biaise vers « aucun écart », et le serveur ne distingue pas une quantité comptée d'une quantité validée par défaut. L'inventaire et la réception sans document démarrent vides. **CONFIRMÉ** (code), **À VALIDER** (le choix)
- **Choix** : (a) préremplie (comportement actuel), plus rapide au quai ; (b) vide, chaque ligne à saisir ou à confirmer d'un geste (« Tout conforme » comme raccourci explicite) ; (c) préremplie, mais le serveur marque la ligne « non comptée » tant que le réceptionnaire n'a pas touché le champ.
- **Recommandation** : (b) pour les transferts entre sites, (a) tolérée pour un bon de commande à lot unique.
- **Impact** : `apps/pwa/src/features/stock/ReceiveTransferScreen.tsx`, `procurement/ReceiptScreen.tsx` et leurs tests ; (c) ajoute un champ au contrat. Défaut implémenté : (a) (aucun changement).

### AV-322 — Appareil enrôlé et jamais approuvé : ancienneté dans le signal d'accueil — SECONDAIRE
- **Question** : un appareil enrôlé et jamais approuvé reste-t-il en attente indéfiniment, et le signal d'accueil en annonce-t-il l'ancienneté ?
- **Pourquoi** : vérification contradictoire (C14, « 8 appareils attendent votre approbation »). Le comportement est voulu : `SM-DEVICE` ne prévoit aucune péremption d'un appareil `PENDING`. Chaque profil de navigateur, fenêtre privée ou stockage vidé crée un identifiant neuf et donc un appareil qui ne sera jamais approuvé ; l'Admin les refuse dans ECR-ADM-05. Le signal n'annonce pas l'ancienneté (`APPROVALS_PENDING` nomme la plus ancienne demande, sans son âge non plus). **CONFIRMÉ** (code)
- **Choix** : (a) le signal annonce l'ancienneté du plus ancien appareil en attente, aucun automatisme ; (b) péremption automatique après N jours (refus ou retrait, paramètre à créer, ordonnanceur, transition tracée) ; (c) le signal ignore les appareils sans contact depuis N jours.
- **Recommandation** : (a), classe SECONDAIRE, sans automatisme destructeur.
- **Impact** : `user-summary.ts` (`MIN(created_at)` des appareils `PENDING`), `home-service.ts` (détail du signal `DEVICES_PENDING`). **Défaut non implémenté** : signal inchangé.

### AV-323 — Opérations sans pièce papier propre — SECONDAIRE
- **Question** : que devient, à l'impression et à la consultation, une opération pour laquelle aucune des 25 pièces n'existe (facture fournisseur, incubation, abattage, interaction CRM, objectif, annulation de vente prise comme opération propre) ?
- **Pourquoi** : REQ-301 et REQ-302 disent « toute opération ». Le catalogue du cadrage ne définit une pièce que pour une partie des opérations ; le dossier d'origine tolère, à défaut de mise en page identique, le respect de la charte. Sans décision, le test d'acceptation « toute opération » ne peut ni passer ni s'écrire. **CONFIRMÉ** (catalogue), **DÉDUIT** (la tolérance)
- **Choix** : (a) mise en page générique à la charte (logo, couleurs, numéro de l'application, rubriques de la commande) pour toute opération sans pièce propre ; (b) exclusion explicite de ces opérations de REQ-301 et REQ-302 ; (c) pièces dédiées dessinées plus tard avec le porteur.
- **Recommandation** : (a), puis (c) pour les opérations que le porteur voudra imprimer en série.
- **Impact** : catalogue de `docs/10-development-plan/19-pieces-papier.md` §3 (colonne « pièce : propre, générique ou exclue »), tâche de PP-0 ; un `AT-*` « chaque type d'opération a une décision de pièce » remplace « toute opération ». Défaut retenu pour la conception : (a).

### AV-324 — Identité de la société imprimée sur les pièces — SECONDAIRE
- **Question** : d'où l'application tire-t-elle l'en-tête imprimé sur chaque pièce (raison sociale, boîte postale, téléphone, NIU, RCCM ou autorisation, siège, forme juridique, banque, régime fiscal) ?
- **Pourquoi** : la note de présentation du dossier d'origine pose l'identité dans un fichier du dossier papier, avec des rubriques « à fournir » (siège, forme juridique, banque) et un numéro « RCCM / autorisation » à confirmer. Les pièces de l'application imprimeront ces rubriques sur chaque page. La validation du jeu de 25 pièces par la Direction et celle des points légaux par le comptable sont des préalables du dossier papier, non du développement. **CONFIRMÉ** (dossier d'origine)
- **Choix** : (a) paramètres de l'organisation (`organization.system_settings`, historisés) lus par les pièces, une rubrique vide imprimée en pointillés à compléter à la main ; (b) constantes du paquet de la PWA ; (c) saisie dans l'écran des paramètres (ECR-ADM-07, non livré).
- **Recommandation** : (a).
- **Impact** : nouveaux paramètres semés vides, composants de pièce, tâche de PP-0 ; la validation de la Direction sur le jeu de pièces est un préalable de PP-A à confirmer avec le porteur. Défaut retenu pour la conception : (a).

### AV-325 — Création d'un compte par l'Admin : mot de passe provisoire hors du journal des commandes — IMPORTANTE
- **Question** : comment l'écran des comptes (ECR-ADM-04) crée-t-il un compte, sachant qu'il faut un mot de passe provisoire que l'Admin saisit ?
- **Pourquoi** : sans écran de création, aucun compte du pilote ne se crée depuis l'application (seul `db:create-local-admin` existe). La commande `identity.user.create` existe, mais son mot de passe, masqué dans la boîte de réception, les événements et l'audit (ADR-045), reste en clair dans la file d'envoi (IndexedDB) de l'appareil de l'Admin jusqu'à l'application de la commande. La réinitialisation d'un mot de passe a déjà tranché ce point (AV-252) : route en ligne hors du journal. **CONFIRMÉ** (code)
- **Choix** : (a) route en ligne `POST /users` hors du journal des commandes (même exception nommée qu'ADR-045) : compte, mot de passe provisoire et première affectation facultative écrits dans une transaction, audit `identity.user.create` sans mot de passe ni téléphone, mot de passe jamais conservé sur l'appareil ; (b) commande `identity.user.create` émise par la file d'envoi (mot de passe en clair dans IndexedDB jusqu'à l'envoi) ; (c) script d'installation `db:create-user` (palliatif sans écran).
- **Recommandation** : (a).
- **Impact** : `apps/server/src/modules/identity/api/user-create.controller.ts`, `identity/application/role-assignment-writer.ts` (écriture partagée avec `identity.role_assignment.grant`), écran des comptes, ADR-045 (extension), D01 UC-ADM-01, `08-api`, `02-securite`. Défaut implémenté (MP-13, 22/10/2026 ; correctifs de revue du 26/10 : la route écrit les lignes `GLOBAL` du flux de changements `user` et `role_assignment`, l'audit porte le rôle et le périmètre de la première affectation) : (a). La commande `identity.user.create` reste disponible pour les scripts et l'import (AV-072). **Reste** : la modification du nom, du téléphone et du courriel (`identity.user.update` n'est pas enregistrée).

### AV-326 — Périmètres proposés à l'affectation d'un rôle depuis l'écran des comptes — SECONDAIRE
- **Question** : quels types de périmètre l'écran propose-t-il à l'Admin quand il donne un rôle (`GLOBAL`, `SITE`, `ZONE`, `TEAM`) ?
- **Pourquoi** : la commande `identity.role_assignment.grant` accepte les quatre types, dans la limite de ce que chaque rôle permet (`allowed_scope_types`). L'écran doit proposer une liste de sites, de zones ou d'équipes : les sites sont lus (jeu `org`, `GET /sites`), mais `GET /zones` et `GET /teams` n'existent pas (S-19, S-28). **CONFIRMÉ** (code)
- **Choix** : (a) `GLOBAL` et `SITE` seulement, selon ce que le rôle permet ; zones et équipes quand leurs lectures existeront ; (b) saisie libre d'identifiants de zone et d'équipe : écartée ; (c) attendre S-19 et S-28 avant de livrer l'écran.
- **Recommandation** : (a). Les permissions d'un rôle ne se modifient pas depuis l'application (AV-257, rôles figés, choix (a)).
- **Impact** : `apps/pwa/src/features/users/users.ts` (`ASSIGNABLE_SCOPES`), `GET /roles` (rôles actifs et périmètres permis). Un rôle qui ne permet ni `GLOBAL` ni `SITE` (zone ou équipe seulement) est signalé « indisponible ici ». Défaut implémenté (MP-13, 22/10/2026) : (a).

### AV-327 — L'Admin gère-t-il les rôles de son propre compte ? — SECONDAIRE
- **Question** : l'écran des comptes propose-t-il à l'Admin d'ajouter ou de retirer des rôles sur son propre compte ?
- **Pourquoi** : la réinitialisation de son propre compte est refusée (AV-281), la suspension et la désactivation aussi (AV-328), mais aucune règle ne tranche les rôles. La revue de MP-13 l'a relevé : un Admin peut retirer sa propre affectation ADMIN (s'il en reste une autre, INV-ADM-01) et perdre l'accès à l'écran en pleine session, ou s'ajouter un rôle sans l'accord d'un tiers. **CONFIRMÉ** (code)
- **Choix** : (a) permis, comme sur les autres comptes ; INV-ADM-01 empêche de retirer le dernier ADMIN, l'audit trace l'auteur ; (b) interdit sur son propre compte (un autre Admin le fait) ; (c) retrait permis, ajout interdit.
- **Recommandation** : (a) pour le pilote, qui n'a qu'un ou deux Admins : (b) bloquerait un Admin seul qui doit se donner un rôle de terrain. À revoir si le parc compte plusieurs Admins.
- **Impact** : `GET /users` (`actions.manageRoles`, `actions.revokeRoles` vrais sur son propre compte), écran des comptes, test `identity-users-admin.test.ts`. Défaut implémenté (MP-13, 26/10/2026) : (a).

### AV-328 — Suspendre ou désactiver son propre compte — SECONDAIRE
- **Question** : l'Admin peut-il suspendre ou désactiver son propre compte ?
- **Pourquoi** : `GET /users` ne lui proposait jamais ces actions sur son propre compte (MP-08, MP-13), mais les commandes `identity.user.suspend` et `.deactivate` l'acceptaient (revue de MP-13) : un client modifié, ou une commande restée dans la file, désactivait l'Admin dès qu'un autre ADMIN restait actif (INV-ADM-01). **CONFIRMÉ** (code)
- **Choix** : (a) refusé par la commande (`OWN_ACCOUNT`) : un autre Admin le fait ; (b) permis, l'écran le masquant seulement ; (c) permis avec confirmation renforcée.
- **Recommandation** : (a) : l'écran et le serveur disent la même chose, et un Admin ne se coupe pas l'accès par erreur.
- **Impact** : `user-commands.ts` (`OWN_ACCOUNT`, identifiants comparés sans la casse), SM-USER, D01 §14, test `identity-users-admin.test.ts`. Défaut implémenté (MP-13, 26/10/2026) : (a).

### AV-329 — Indicateurs des tableaux sans mesure égale dans l'explorateur (AT-054) — SECONDAIRE

- **Question** : AT-054 exige « les mêmes chiffres partout ». À l'intégration de P9 (26/10/2026), quatre indicateurs du tableau de la Direction différaient de la mesure d'explorateur que le registre (`kpi-catalog.ts`) leur associait : mortalité (KPI-PRD-02), pertes (KPI-STK-03), écarts d'inventaire (KPI-STK-04), nouveaux clients (KPI-COM-05). Que faut-il aligner, et sur quoi ?
- **Pourquoi** : DÉDUIT de la lecture du code. La mortalité du tableau compte toutes les déclarations `MORTALITE` constatées, alors que `f_production_daily` ne garde que celles rattachées à un lot de production. Le tableau compte le **nombre** de déclarations de pertes, et l'explorateur n'a pas de mesure de comptage sur `f_losses`. L'écart d'inventaire est une **valeur nette** (gains moins pertes), alors que les mouvements de `f_stock_moves` ne sont pas signés. Enfin, le tableau ne comptait une conversion que si le client avait un titulaire, alors que la vue la compte aussi sans titulaire.
- **Choix** : (a) aligner les définitions : mortalité lue dans `f_losses` filtrée sur la catégorie `MORTALITE` (le registre accepte des filtres) ; pas d'équivalent déclaré pour les pertes et les écarts d'inventaire, dont le lien d'exploration reste un détail ; conversion sans titulaire comptée dans la portée d'un site ou entière, jamais dans celle d'une personne ; (b) ajouter à l'explorateur une mesure de comptage et des mouvements signés ; (c) changer les tableaux pour reprendre les mesures actuelles de l'explorateur.
- **Recommandation** : (a) maintenant ; (b) quand un utilisateur demandera ces deux explorations.
- **Impact** : `packages/domain/src/kpi-catalog.ts` (filtres de l'explorateur), `dashboard-blocks.ts` (lien de la mortalité), `portfolio-activity.ts` (`LEFT JOIN` des affectations), `analytics-dashboards.e2e.test.ts` (AT-054). Défaut implémenté : (a).

### AV-350 — Seuils des alertes : où les paramétrer — SECONDAIRE
- **Question** : Les seuils des alertes (D13 §7.1) sont-ils portés par `alert_rules.thresholds` (dictionnaire) ou par `organization.system_settings` ?
- **Pourquoi** : Le dictionnaire de `communication.alert_rules` prévoit une colonne `thresholds` ; la règle 8 de CLAUDE.md place les seuils métier dans `system_settings`. Les détecteurs sont dans les modules propriétaires, qui n'importent pas `communication` (graphe). Aujourd'hui, seul `finance.cash_variance_critical_xaf` est lu par du code ; `production.high_mortality_alert_pct` et `_heads` et `sales.undelivered_alert_days` sont semés mais lus par aucun code : leurs détecteurs (P9-08 à P9-10) devront les lire. **DÉDUIT**.
- **Choix** : (a) `system_settings` seulement ; `alert_rules` porte l'activation, la gravité, les rôles, le mode de résolution, le délai et les rôles d'escalade ; (b) `alert_rules.thresholds`, publié aux détecteurs par événement de configuration ; (c) les deux, `system_settings` faisant foi.
- **Recommandation** : (a).
- **Impact** : Dictionnaire `communication.alert_rules` (colonne `thresholds` retirée), [ADR-061](decisions/ADR-061-alertes-detection-correlation-et-cycle-de-vie.md) §8, paramètres semés par détecteur. Défaut implémenté : (a). Non paramétrable (c'est le lieu des paramètres).

### AV-351 — Gravité d'une alerte dont le niveau varie — SECONDAIRE
- **Question** : Un type dont la gravité dépend de la valeur (écart de caisse : `WARNING`, `CRITICAL` au-delà de `finance.cash_variance_critical_xaf`) a-t-il une gravité fixe par règle ou calculée par l'événement ?
- **Pourquoi** : D13 §7.1 donne « WARNING (CRITICAL si ≥ seuil) » pour `CASH_VARIANCE` alors que `alert_rules.severity` est unique par type. Deux types distincts (`STOCK_LOW`, `STOCK_OUT`) ont chacun leur clé de déduplication. **DÉDUIT**.
- **Choix** : (a) l'événement porte la gravité calculée par son module ; la règle donne la gravité par défaut et les gravités admises ; une occurrence plus grave relève l'alerte ouverte (et pose `critical_since`), aucune ne l'abaisse ; (b) gravité fixe par règle, un type par niveau ; (c) gravité recalculée à chaque occurrence.
- **Recommandation** : (a) : une alerte qui descend sans que personne ne l'ait lue masque un problème ; la résolution est la seule clôture.
- **Impact** : [ADR-061](decisions/ADR-061-alertes-detection-correlation-et-cycle-de-vie.md) §7, catalogue des alertes (`packages/domain`), push d'une alerte relevée à `CRITICAL` et échéance d'escalade ([ADR-062](decisions/ADR-062-destinataires-notifications-push-et-escalade.md) §7). Défaut implémenté : (a). Non paramétrable.

### AV-352 — Types d'alerte ajoutés au catalogue ; types sans source — SECONDAIRE
- **Question** : Quels types s'ajoutent au catalogue de D13 §7.1, et que fait-on des types dont la phase n'est pas livrée ?
- **Pourquoi** : Le code promet « alerte : P9 » pour les quotas échus et à régulariser (P5-08, `AllocationExpired`, `AllocationRevocationPending`), les ventes confirmées non livrées (AV-132) et les écarts de réconciliation (`LEDGER_MISMATCH`, INV-STK-01, AT-047 ; `CASH_MISMATCH`, D09), absents du catalogue de D13 ; le consommateur d'événements saute un événement en échec sans alerte ; `KOMMO_SYNC_FAILED` relève de P10. Les trois tâches de réconciliation et de vérification de chaîne signalent l'écart en **levant** : leur écriture est annulée par le point de sauvegarde du `JobRunner`, donc leur événement doit être publié avant de se terminer en succès. **DÉDUIT**.
- **Choix** : (a) ajouter les six types, garder `KOMMO_SYNC_FAILED` désactivé ; les tâches de réconciliation publient puis se terminent `DONE` ; (b) n'ajouter aucun type (les signaux restent à l'accueil) ; (c) tout désactiver sauf demande du porteur.
- **Recommandation** : (a).
- **Impact** : D13 §7.1, seed des règles (`communication_alert_rules`), détecteurs de P9-07 à P9-10 ; [ADR-061](decisions/ADR-061-alertes-detection-correlation-et-cycle-de-vie.md) §3 et §13. Défaut implémenté : (a). Paramétrable : `enabled` par règle.

### AV-353 — Résolution automatique des alertes d'état — SECONDAIRE
- **Question** : Comment une alerte d'état (créance échue, stock faible…) se résout-elle quand la condition disparaît (BR-NOT-003) ?
- **Pourquoi** : Les modules propriétaires ne peuvent ni lire `communication` ni connaître les alertes ouvertes ; la condition peut cesser sans événement (un paiement ramène le solde à zéro). Une résolution fondée sur l'horloge résoudrait à tort les alertes encore vraies lors d'une passe rejouée ou doublée le même jour (les tâches existantes dédoublonnent par jour métier). **DÉDUIT**.
- **Choix** : (a) identité de passe : événements et marqueur portent `pass_id`, l'alerte mémorise `last_pass_id`, la clé d'idempotence est (`pass_id`, sujet), le marqueur n'est publié que par la dernière page d'une passe complète ; plus un événement de résolution quand un fait précis la termine ; (b) événement « condition disparue » par module, avec mémoire des alertes ; (c) le consommateur interroge le module à chaque lecture.
- **Recommandation** : (a) : détection sans état côté propriétaire, sans résolution à tort.
- **Impact** : [ADR-061](decisions/ADR-061-alertes-detection-correlation-et-cycle-de-vie.md) §3 ; tâches planifiées des modules (suppression de la déduplication par jour quand elles passent en détecteur d'état) ; coût proportionnel au nombre de sujets vrais ([ADR-068](decisions/ADR-068-charge-paliers-analytiques-et-retention.md)). Défaut implémenté : (a). Non paramétrable.

### AV-354 — Alerte d'événement : résolution, écart, nouvelle occurrence — SECONDAIRE
- **Question** : Comment se clôt une alerte d'événement (perte anormale, doublon suspect), que devient une nouvelle occurrence après sa résolution, et peut-on écarter une alerte d'état ?
- **Pourquoi** : BR-NOT-003 et SM-ALERT : résolution manuelle avec commentaire, écart avec motif ; INV-NOT-01 n'interdit qu'une deuxième alerte *ouverte* par objet. Écarter une alerte d'état dont la condition dure la ferait renaître, notifiée, à la passe suivante. **DÉDUIT**.
- **Choix** : (a) commentaire obligatoire à la résolution, motif obligatoire à l'écart, nouvelle alerte après résolution ou écart ; `dismiss` interdit sur une alerte d'état (la prise en compte la fait taire tant que la condition dure) ; (b) `dismiss` admis sur une alerte d'état avec une fenêtre de silence par type en paramètre ; (c) réouverture de l'alerte résolue.
- **Recommandation** : (a) : l'historique d'un objet reste lisible (une ligne par occurrence traitée).
- **Impact** : Commandes `communication.alert.resolve` et `.dismiss`, index unique sur la clé de déduplication ouverte ([ADR-061](decisions/ADR-061-alertes-detection-correlation-et-cycle-de-vie.md) §6 et §9). Défaut implémenté : (a). Non paramétrable.

### AV-355 — Alertes de stock « sur mouvement » — IMPORTANTE
- **Question** : Les alertes `STOCK_LOW`, `STOCK_OUT` et `STOCK_NEGATIVE` sont-elles détectées à chaque mouvement ou par une passe planifiée ?
- **Pourquoi** : D13 §7.1 dit « Sur mouvement ». Aucun événement `StockThresholdBreached` ni `StockNegativeDetected` n'est publié aujourd'hui ; `recordStockMove` est le chemin le plus sollicité et verrouillé (ADR-038) ; `STOCK_NEGATIVE` naît aussi d'un conflit de synchronisation. Le solde n'a pas d'identifiant propre (clé `emplacement`, `produit`, `lot`) : le sujet est un UUID déterministe du couple. **DÉDUIT**.
- **Choix** : (a) transition publiée par `inventory` dans la transaction du mouvement, pour les couples avec seuil et pour le négatif ; passe horaire en filet (`breached: false` aussi) ; (b) passe planifiée seule, délai d'une heure ; (c) événement à chaque mouvement.
- **Recommandation** : (a), sous réserve que la lecture du seuil n'ajoute ni verrou ni écriture sur le chemin chaud : à mesurer en P9-08, repli sur (b) si le coût est visible.
- **Impact** : `inventory` (publication de l'événement ; lecture du seuil du couple), ordre de verrouillage inchangé, sujet composite ([ADR-061](decisions/ADR-061-alertes-detection-correlation-et-cycle-de-vie.md) §3 et §5). Défaut implémenté : (a) avec filet. Non paramétrable : la cadence du filet est une constante de planification (AV-361).
- **Mise en œuvre (P9-08)** : `recordStockMove` publie à la fin du mouvement, pour chaque extrémité **physique** qui a un seuil actif dont l'état change (état avant = disponible après − variation du mouvement ; disponible = somme des soldes du couple, lecture simple), et `inventory.threshold.set` publie le changement de minimum. Le filet (`inventory.alerts.stock_threshold_sweep`, horaire) ne publie que les couples **dans** l'état (`breached` vrai, avec `pass_id`) et laisse le marqueur de passe résoudre le reste : il n'envoie pas d'événement `breached: false`. **Coût mesuré par analyse du code, pas par chronométrage** : une lecture indexée du seuil actif par mouvement à extrémité physique (aucune lecture de plus sans seuil), puis, si un seuil existe, la somme des soldes du couple et, seulement à une transition, deux lectures de libellés ; aucun verrou ajouté (ADR-038). Repli (b) (filet seul) disponible si une mesure en charge (P9-22) montrait un coût visible.
- **Limites connues, acceptées** : (1) un événement publié au milieu d'une commande dont une ligne suivante est refusée (stock insuffisant en ligne, rejet métier, interblocage rejoué) est annulé avec la transaction mais **consomme son numéro de séquence** : les consommateurs attendent au plus 120 s derrière ce trou (ADR-061 §14) ; différer la publication à la fin de la commande est le correctif si la mesure l'exige ; (2) la somme des soldes est lue sous l'instantané de la transaction : le solde d'un autre lot du couple modifié depuis son début peut être ignoré (la passe horaire corrige) ; (3) une passe horaire qui lit avant un mouvement validé avant son marqueur peut résoudre à tort l'alerte que ce mouvement vient de lever, jusqu'à la transition suivante ou à la passe suivante (une heure au plus).

### AV-356 — Alertes de perte anormale et de mortalité élevée — SECONDAIRE
- **Question** : Quels seuils déclenchent `HIGH_LOSS` et `HIGH_MORTALITY`, et dans quel module chaque critère se calcule-t-il ?
- **Pourquoi** : D13 §7.1 donne 50 000 XAF ou 5 % des ventes du jour pour la perte (par emplacement, sur un jour) ; `inventory` n'importe ni `sales` ni `finance` (graphe), donc le critère « % des ventes » ne peut pas s'évaluer dans `inventory` ; la mortalité a ses paramètres depuis P7 (AV-121). **CONFIRMÉ** (D13) / **DÉDUIT** (emplacement, jour métier, module).
- **Choix** : (a) seuil absolu évalué par `inventory` sur `StockLossDeclared` (`inventory.high_loss_alert_xaf`), part « % du CA net du jour » évaluée par `sales` qui connaît le CA du jour (ADR-041) et lit les pertes par l'API d'`inventory` (`sales.high_loss_alert_sales_pct`) ; deux événements, un seul type d'alerte ; (b) seuil absolu seul ; (c) dénominateur calculé dans `inventory` d'après les sorties de vente du registre, au coût (écart à D13).
- **Recommandation** : (a).
- **Impact** : Détecteurs de `inventory` (P9-08), `sales` (P9-07) et `production` (P9-09), seeds. Défaut implémenté : (a). Paramétrable. La valeur d'une perte est une valeur protégée ([ADR-061](decisions/ADR-061-alertes-detection-correlation-et-cycle-de-vie.md) §11, AV-390).

### AV-357 — Pièce requise jamais reçue (`ATTACHMENT_MISSING`) — IMPORTANTE
- **Question** : Qu'est-ce qu'une pièce « requise non reçue après 7 jours » (D13 §7.1) et qui la détecte ?
- **Pourquoi** : `attachments` ne sait pas quelle pièce est attendue : ce sont les modules qui l'exigent (dépenses, réceptions au-delà du seuil de photo, AV-246 `RECEIPT_PHOTO_MISSING`) qui le savent. La session principale tient `attachments` (MP-10). **DÉDUIT**.
- **Choix** : (a) chaque module exigeant une pièce publie, par une tâche quotidienne, l'événement pour les documents dont la pièce manque depuis plus de `attachments.missing_alert_days` (7) ; (b) un détecteur unique dans `attachments` (demande à la session principale) ; (c) pas d'alerte, signal à l'accueil seulement.
- **Recommandation** : (a) : aucune modification d'`attachments`.
- **Impact** : `finance` (dépenses à justificatif promis) et `procurement` (réceptions marquées `RECEIPT_PHOTO_MISSING`), tâches quotidiennes ; [ADR-061](decisions/ADR-061-alertes-detection-correlation-et-cycle-de-vie.md) §2. Défaut implémenté : (a). Paramétrable (délai ; `0` désactive).

### AV-358 — Demande d'approbation en attente ; escalade ; sans approbateur — IMPORTANTE
- **Question** : Quand une demande de validation est-elle en retard, qui est alerté, qui est le niveau supérieur, et que fait-on d'une demande qu'aucun approbateur ne peut traiter (D01 §14) ?
- **Pourquoi** : `approval_requests.escalated_at` n'est jamais écrit ; les approbateurs sont définis par permission et portée (`approver_permission`, `approver_scope`), jamais par rôle : « qui détient cette permission dans ce périmètre ? » est une lecture inverse que ni `approvals` ni la page d'accueil ne font (l'accueil ne liste que les demandes décidables par l'utilisateur). D01 §14 : demande routée vers `DIRECTION`, alerte « validation sans approbateur ». **DÉDUIT**.
- **Choix** : (a) tâche d'`approvals` : demande `PENDING` depuis plus de `approvals.pending_long_hours` (24) → événement portant la permission, la portée, le site et la zone, `escalated_at` posé une fois, alerte vers les approbateurs et la Direction ; détection « sans approbateur » différée tant que `identity` ne fournit pas la lecture inverse (B1) ; (b) idem avec détection immédiate par lecture directe des tables d'`identity` ; (c) pas d'escalade.
- **Recommandation** : (a).
- **Impact** : `approvals` (tâche, `escalated_at`), [ADR-062](decisions/ADR-062-destinataires-notifications-push-et-escalade.md) §1 et §7 ; besoin B1 (`usersHoldingPermissionAt`, suivi §5). Défaut implémenté : (a), livré en P9-09 (précisions : AV-416). Paramétrable (24 h).

### AV-359 — Commercial inactif (`INACTIVE_COMMERCIAL`) — SECONDAIRE
- **Question** : Quels jours comptent et qui est exclu (congé, nouveau commercial, désactivé), et dans quel module se calcule la condition ?
- **Pourquoi** : BR-TER-013 fixe lundi à samedi « par défaut » et 08:00 ; aucune donnée de congé n'existe dans le modèle. La condition croise prise de service (`fieldwork`), visites (`crm`) et ventes (`sales`) ; `fieldwork` n'importe ni `crm` ni `sales` (graphe), `sales` importe les deux. **CONFIRMÉ** (règle) / **DÉDUIT** (exclusions, module).
- **Choix** : (a) détecteur dans `sales` (API publique de `fieldwork` pour les prises de service, de `crm` pour les visites) ; jours `sales.commercial_working_days` (lundi à samedi) ; exclus : comptes désactivés, utilisateurs sans affectation commerciale active, jours antérieurs à la première affectation ; (b) idem sans exclusion ; (c) congés saisis (hors périmètre).
- **Recommandation** : (a).
- **Impact** : `sales` (tâche quotidienne 08:00 sur le jour métier précédent, P9-07) ; [ADR-061](decisions/ADR-061-alertes-detection-correlation-et-cycle-de-vie.md) §2. Défaut implémenté : (a). Paramétrable (jours) ; l'heure est une constante de planification.

### AV-360 — Réception incomplète (`RECEIPT_INCOMPLETE`) — SECONDAIRE
- **Question** : Quelles conditions et quel délai déclenchent `RECEIPT_INCOMPLETE` ?
- **Pourquoi** : BR-APP-015 le définit (date prévue dépassée de plus de 2 jours avec un reliquat, ou quantité rejetée) ; la valeur « 2 jours » n'était pas un paramètre. **CONFIRMÉ** (règle) / **DÉDUIT** (paramètre, résolution).
- **Choix** : (a) règle de BR-APP-015, délai en paramètre `procurement.receipt_incomplete_alert_days` (2) ; la quantité rejetée lève l'alerte à la réception ; résolution quand le reliquat est nul ou le bon clôturé ; (b) délai compté depuis la dernière réception ; (c) rejet seul.
- **Recommandation** : (a).
- **Impact** : `procurement` (événement sur réception ; tâche quotidienne pour le retard). Défaut implémenté : (a), livré en P9-09 (précisions : AV-414). Paramétrable.

### AV-361 — Tâches planifiées de détection : créneaux — SECONDAIRE
- **Question** : À quelle heure tournent les détections planifiées, et inscrit-on les tâches déjà écrites (`sales.receivables.overdue_daily`, `fieldwork.session.auto_close`, `audit.chain.verify_daily`) ?
- **Pourquoi** : Les créneaux sont donnés par le catalogue (06:00, 07:00, 08:00, 10:00, horaire, 24 h) ; certaines tâches existent sans récurrence (« la planification relève du déploiement », P4-09). `RecurringJobRegistry` est disponible depuis P5-16 ; une récurrence est déclarée en **code** (`INTERVAL` ou `DAILY`), elle ne lit pas `system_settings`. **DÉDUIT**.
- **Choix** : (a) créneaux du catalogue, une récurrence par tâche dans son module, inscrite au démarrage ; la cadence est une constante de code (non paramétrable) ; (b) planification par le déploiement (cron externe) ; (c) tâche unique de `communication` qui appelle les modules.
- **Recommandation** : (a).
- **Impact** : Fichiers `*-recurring-jobs.ts` des modules concernés (nouveau pour `audit`, `sales`, `fieldwork`). Défaut implémenté : (a). Non paramétrable (une tâche à intervalle court qui comparerait `system_settings` à l'heure serait un choix ultérieur). Créneaux retenus en P9-07 (heure de Douala) : `sales` 07:00 (créances), 07:30 (ventes non livrées), 08:00 (commerciaux inactifs) ; `finance` 06:15 (justificatifs de dépense), 02:30 (réconciliation), horaires (sessions ouvertes, remises non reçues, encaisses élevées).

### AV-362 — Consommateur d'événements en échec — SECONDAIRE
- **Question** : Un événement sauté après cinq essais, ou un consommateur en retard, doit-il lever une alerte, et comment la retrouve-t-on ?
- **Pourquoi** : `event-consumer-runner.ts` : l'événement en échec est sauté, la position avance, `last_error` est réécrit à `null` par le premier événement traité ensuite (`saveOffset` après chaque événement) : l'erreur disparaît en quelques secondes ; D13 §14 et le catalogue d'événements §3 promettent « une alerte technique ». **CONFIRMÉ** (documents, code) / **DÉDUIT** (mise en œuvre).
- **Choix** : (a) le runner consigne chaque saut dans `platform_event_consumer_failures` (ajout seul, même transaction que l'avancée de position) ; une tâche de `communication` lit cette table et le retard de position et lève `CONSUMER_FAILED`, un par consommateur et par jour métier, résolu sur le retard ; (b) lecture de `last_error` seule (perte silencieuse possible) ; (c) journaux seulement.
- **Recommandation** : (a) : ajout de plateforme additif, à signaler à la session principale.
- **Impact** : `platform/events` (ajout), [ADR-061](decisions/ADR-061-alertes-detection-correlation-et-cycle-de-vie.md) §12, [ADR-068](decisions/ADR-068-charge-paliers-analytiques-et-retention.md) §7. Défaut implémenté : (a) ; repli sur (b) tant que le changement de plateforme n'est pas intégré. Paramétrable : seuil de retard. **Précisé par AV-425** (P9-10) : condition (sauts dans une fenêtre glissante ou retard), sujet = nom du consommateur, supervision indépendante par le journal ; « curseur propre » inutile (passe sans état) et « même transaction » inexact (deux instructions successives).

### AV-363 — Destinataires d'une alerte — IMPORTANTE
- **Question** : Qui reçoit une alerte, et que fait-on quand personne ne correspond (D13 §14) ?
- **Pourquoi** : BR-NOT-001 : destinataires = rôles × périmètre de l'objet ; BR-NOT-008 : jamais d'objet hors périmètre ; `comm.alert.read` est en portée `OWN` pour les commerciaux, `TEAM` pour le responsable commercial, `SITE` pour le vendeur de PDV, le responsable de ferme et le magasinier : une lecture « par périmètre » ne montrerait pas à un commercial l'alerte de son PDV ni les alertes d'un site sans propriétaire à un rôle `TEAM`. Le responsable d'une équipe est connu (`organization_teams.manager_user_id`). **DÉDUIT**.
- **Choix** : (a) destinataires explicites écrits à la levée (`communication_alert_recipients`, origines `RULE`, `OWNER`, `TEAM_MANAGER`, `APPROVER`, `ESCALATION`, `FALLBACK`), supervision par la portée de `comm.alert.read` avec évaluation exacte ; (b) visibilité par portée seulement ; (c) destinataires recalculés à chaque lecture.
- **Recommandation** : (a).
- **Impact** : [ADR-062](decisions/ADR-062-destinataires-notifications-push-et-escalade.md) §1 à §3 ; lecture inverse (rôle ou permission → utilisateurs) à demander à `identity` (B1), adaptateur isolé en attendant. Défaut implémenté : (a). Paramétrable : rôles par règle.

### AV-364 — Canaux de notification par gravité — SECONDAIRE
- **Question** : Quel canal pour quelle gravité (AV-064) ?
- **Pourquoi** : BR-NOT-004 le donne ; AV-064 le confirme à la forme (in-app + Web Push). **CONFIRMÉ** (règle).
- **Choix** : (a) BR-NOT-004 tel quel ; (b) push aussi pour `WARNING` ; (c) in-app seulement.
- **Recommandation** : (a).
- **Impact** : [ADR-062](decisions/ADR-062-destinataires-notifications-push-et-escalade.md) §4. Défaut implémenté : (a). Non paramétrable en P9 : le canal découle de la gravité de la règle (la règle ne porte pas de colonne de canal).

### AV-365 — Web Push : bibliothèque, clés et repli — IMPORTANTE
- **Question** : Quelle bibliothèque et quelles clés VAPID pour l'envoi Web Push ?
- **Pourquoi** : Aucune bibliothèque Web Push n'est installée ; les clés VAPID sont des secrets d'exploitation que le porteur n'a pas fournis ; D13 §14 prévoit le repli in-app. **DÉDUIT**.
- **Choix** : (a) port et adaptateur journal, bibliothèque et clés décidées au déploiement ; (b) ajouter `web-push` maintenant ; (c) pas de push.
- **Recommandation** : (a) : le serveur se termine et se teste sans secret.
- **Impact** : [ADR-062](decisions/ADR-062-destinataires-notifications-push-et-escalade.md) §5 ; `communication.push.subscribe`. Défaut implémenté : (a). Paramétrable : clés par variables d'environnement.

### AV-366 — Regroupement des notifications push — SECONDAIRE
- **Question** : Comment regrouper les push d'une tempête d'alertes (D13 §14), et le regroupement peut-il retarder une alerte `CRITICAL` « immédiate » ?
- **Pourquoi** : D13 §14 : « au plus 1 push par utilisateur et par type toutes les 15 minutes » ; BR-NOT-004 : push immédiat pour `CRITICAL`. Les deux règles viennent de la spécification : le regroupement est l'exception explicite pour les tempêtes. **CONFIRMÉ** (règles) / **DÉDUIT** (compte au push suivant, course).
- **Choix** : (a) créneau de `communication.push_group_minutes` (15), décidé dans la transaction du consommateur sous le verrou N10b, compte des alertes tues dans le push suivant, escalade jamais regroupée ; (b) créneau sans compte ; (c) aucun regroupement.
- **Recommandation** : (a).
- **Impact** : [ADR-062](decisions/ADR-062-destinataires-notifications-push-et-escalade.md) §6. Défaut implémenté : (a). Paramétrable.

### AV-367 — Escalade d'une alerte critique — SECONDAIRE
- **Question** : Au bout de combien de temps et vers qui une alerte `CRITICAL` non prise en compte est-elle escaladée (BR-NOT-005) ?
- **Pourquoi** : BR-NOT-005 donne 4 h et « responsable → Direction » ; le responsable d'équipe est connu (`TEAM_MANAGER`, destinataire dès la levée), `DIRECTION` est le seul niveau supérieur modélisé au-delà. **CONFIRMÉ** (délai) / **DÉDUIT** (niveau, point de départ).
- **Choix** : (a) `escalation_hours` par règle (4), rôles d'escalade par règle (`DIRECTION` par défaut), une fois, depuis `critical_since` ; (b) escalades successives ; (c) hiérarchie par équipe.
- **Recommandation** : (a).
- **Impact** : [ADR-062](decisions/ADR-062-destinataires-notifications-push-et-escalade.md) §7 ; tâche `communication.alerts.escalate`. Défaut implémenté : (a). Paramétrable.

### AV-368 — Prise en compte d'une alerte hors ligne — SECONDAIRE
- **Question** : Que devient la prise en compte d'une alerte que le serveur a résolue ou escaladée entre-temps ?
- **Pourquoi** : UC-NOT-02 admet la prise en compte hors ligne ; BR-SYN-007 interdit de rejeter un fait accompli pour un état métier. **DÉDUIT**.
- **Choix** : (a) appliquée sans effet, résultat explicite, jugée à l'état serveur à son application ; (b) rejetée ; (c) conflit à résoudre.
- **Recommandation** : (a).
- **Impact** : [ADR-062](decisions/ADR-062-destinataires-notifications-push-et-escalade.md) §7 et §8. Défaut implémenté : (a). Non paramétrable.

### AV-369 — Notes de direction : audience, brouillon, expiration, correction — SECONDAIRE
- **Question** : Comment se définit l'audience d'une note, que reçoit l'appareil, et que devient une note erronée ou un brouillon ?
- **Pourquoi** : BR-NOT-006 : audience, publication, expiration, accusé optionnel, immuable, retrait ou note corrective ; AV-066 : accusé par note. Le jeu `comms` est en portée `USER` ; un rôle n'est pas une portée du flux ; une table de transaction ne se supprime pas (INV-GLO-03). **CONFIRMÉ** (règles) / **DÉDUIT** (résolution, brouillon).
- **Choix** : (a) évaluation à la lecture en ligne, résolution à la publication pour le flux et les notifications, limite assumée pour les affectations postérieures, brouillon archivé jamais supprimé ; (b) catch-up par consommateur des affectations ; (c) audience figée en liste d'utilisateurs.
- **Recommandation** : (a).
- **Impact** : [ADR-063](decisions/ADR-063-notes-de-direction.md). Défaut implémenté : (a). Paramétrable : accusé par note.

### AV-370 — Note automatique à l'activation d'une règle tarifaire — SECONDAIRE
- **Question** : L'activation d'une règle tarifaire publie-t-elle une note automatique (D13 §11) ?
- **Pourquoi** : D13 §11 cite `PriceRuleActivated` « pour une note automatique » ; BR-NOT-007 : une note ne porte aucun effet et ne remplace pas une règle automatisable ; l'événement n'est pas publié aujourd'hui. **À VALIDER**.
- **Choix** : (a) pas de note automatique en P9 ; (b) note automatique de catégorie `PRIX` à l'audience des vendeurs ; (c) notification sans note.
- **Recommandation** : (a) : la décision de communication appartient à la Direction.
- **Impact** : [ADR-063](decisions/ADR-063-notes-de-direction.md) §7. Défaut implémenté : (a). Paramétrable en (b) par une règle ultérieure.

### AV-371 — Limites de l'explorateur — SECONDAIRE
- **Question** : Quelles limites bornent l'explorateur et les exports, et que se passe-t-il au dépassement ?
- **Pourquoi** : BR-ANA-006 : 10 000 / 100 000 / 15 s (« D », sécurité et performance) ; D11 §8 : trois ans et `QUERY_LIMIT_EXCEEDED` ; la concurrence par utilisateur est une garde de charge (RISK-13). **CONFIRMÉ** (limites) / **DÉDUIT** (concurrence, erreur plutôt que troncature).
- **Choix** : (a) valeurs de D11 en paramètres `analytics.*`, `LIMIT + 1` et erreur au dépassement, export en `FAILED` ; (b) troncature signalée par `truncated` ; (c) sans limite de concurrence.
- **Recommandation** : (a).
- **Impact** : [ADR-064](decisions/ADR-064-couche-semantique-et-explorateur.md) §8 et sa révision P9-14, [ADR-068](decisions/ADR-068-charge-paliers-analytiques-et-retention.md) §1. Défaut implémenté : (a), avec une précision : une limite de lignes **demandée** par l'utilisateur, plus petite que le plafond, est un « premier N » voulu (les N premières lignes sans erreur, le total sur toutes) ; seul le plafond est une erreur. Paramétrable : `analytics.query_max_rows`, `analytics.query_max_execution_ms`, `analytics.query_max_period_days`, `analytics.query_max_concurrent_per_user`.

### AV-372 — Mesures protégées : refus ou masquage — SECONDAIRE
- **Question** : Que voit un utilisateur sans `inventory.valuation.read` qui demande le coût, la marge ou une valeur au coût ?
- **Pourquoi** : D11 §8 prévoit `FORBIDDEN_MEASURE` pour l'explorateur ; ADR-035 masque (valeur `null`) dans les tableaux ; les lectures de pertes, d'achats et de production masquent déjà leurs valeurs : l'explorateur doit refuser exactement ce qu'elles masquent. **CONFIRMÉ**.
- **Choix** : (a) refus à l'explorateur et à l'export, masquage dans les tableaux, liste des mesures protégées vérifiée contre les lectures existantes ; (b) masquage partout ; (c) refus partout.
- **Recommandation** : (a) : l'explorateur construit une requête, un refus explicite évite un tableau muet.
- **Impact** : [ADR-064](decisions/ADR-064-couche-semantique-et-explorateur.md) §7, [ADR-067](decisions/ADR-067-vues-sauvegardees-et-exports-audites.md) §8. Défaut implémenté : (a). Non paramétrable.

### AV-373 — Étendue exacte des lignes d'un jeu de faits — IMPORTANTE
- **Question** : Comment l'explorateur et les instantanés confinent-ils les lignes (BR-ANA-004) quand une permission porte plusieurs portées et affectations ?
- **Pourquoi** : `listConfinementAt` est un pré-filtre sur-ensemble : pas de zone, `null` pour `ALL` et pour `SITE` ou `ZONE` sous une affectation autre que de site ; sur un agrégat, aucune évaluation par ligne ne le rattrape. L'octroi effectif est l'intersection portée maximale ∩ affectation (`scope-evaluation.ts`). `ReadScope` combine en ET, sans zone. **DÉDUIT**.
- **Choix** : (a) `resolveExactScope` (`analytics/application/scope/exact-scope.ts`) : évalue `evaluateAccess` pour les sites, zones et utilisateurs **candidats** tirés des affectations et des équipes de l'utilisateur (500 par sorte, `truncated` si le plafond coupe), union sûre par construction compilée en `WHERE` par `scope-sql.ts` ; remplacée par une fonction d'`identity` (B5) ; (b) fonction exacte dans `identity` tout de suite (demande à la session principale) ; (c) ET, plus restrictif.
- **Recommandation** : (a), avec B5 en suivi : ne dépend d'aucun fichier tenu par la session principale.
- **Impact** : `analytics/application/scope/` (`platform/read-scope.ts` n'est pas touché), compilateur ([ADR-064](decisions/ADR-064-couche-semantique-et-explorateur.md) §4, révision P9-14). Défaut implémenté : (a). Plafond de candidats paramétrable (`analytics.scope_max_candidates`, 500). Test : grille portée maximale × affectation contre `evaluateAccess` (jamais plus large, et complète), pour six projections d'attributs.

### AV-374 — Jeux de faits livrés en P9 — SECONDAIRE
- **Question** : Quels jeux `f_*` sont livrés et avec quelles dimensions ?
- **Pourquoi** : Le dictionnaire `12-analytics.md` en liste treize ; une ligne de vente se répartit sur plusieurs mouvements `SALE` (un par lot) : joindre les mouvements dupliquerait le montant ; la session de travail ne porte ni site ni zone ; plusieurs tables sources n'ont pas de colonne de site (mouvements, soldes, coûts, trésorerie). **DÉDUIT**.
- **Choix** : (a) treize jeux, dimensions déclarées seulement quand leur source existe, colonnes de portée dérivées dans la vue (ADR-064 §2), règle fermée sinon ; (b) les six principaux (ventes, encaissements, stock, pertes, production, dépenses) ; (c) un jeu « ligne de vente × mouvement » pour le lot.
- **Recommandation** : (a).
- **Impact** : [ADR-064](decisions/ADR-064-couche-semantique-et-explorateur.md) §2 et §3 ; migrations `analytics_f_*`, dictionnaire `12-analytics.md`. Défaut implémenté : (a). Non paramétrable.

### AV-375 — Zone d'une ligne de fait : zone seule ou zone et ancêtres — SECONDAIRE
- **Question** : Un filtre « zone Douala » inclut-il les sous-zones, et comment regrouper par niveau ?
- **Pourquoi** : Le dictionnaire écrit « zone (et ancêtres) » ; AT-038 attend « zone et sous-zones » ; `organization_zone_ancestors` donne la hiérarchie. **DÉDUIT**.
- **Choix** : (a) dimensions `zone` (zone de rattachement) et `zone_path` ; filtre sur la zone inclut les descendantes ; (b) zone de rattachement seule ; (c) un niveau fixe.
- **Recommandation** : (a).
- **Impact** : [ADR-064](decisions/ADR-064-couche-semantique-et-explorateur.md), `organization` (hiérarchie). Défaut implémenté : (a). Non paramétrable.

### AV-376 — Chiffre d'affaires : deux calculs à rapprocher — IMPORTANTE
- **Question** : Le chiffre d'affaires de `periodRevenue` (tableau commercial, vue d'ensemble financière) et celui de `period-activity.ts` (accueil, tableau de distribution) sont-ils égaux, et que valent leurs différences ?
- **Pourquoi** : Deux fonctions calculent le CA : lignes vendues moins lignes annulées (`period-activity.ts`, ADR-041) et total des ventes moins total des annulations appliquées (`revenue.ts`) ; les montants coïncident (total = somme des lignes, taxe nulle), le **nombre de ventes** de `periodRevenue` compte les ventes annulées, et son **attribution** est le commercial attribué (BR-VEN-020, réalisé d'objectif) alors que l'activité personnelle compte vendeur ou commercial. BR-ANA-009. **DÉDUIT**, à confirmer par test.
- **Choix** : (a) référence = `period-activity.ts`, égalité du CA testée, « réalisé d'objectif » et « activité personnelle » nommés à part, nombre de ventes de `periodRevenue` jamais affiché comme KPI-COM-07 ; correctif minimal tracé si un écart apparaît ; (b) référence = `periodRevenue` ; (c) deux libellés distincts partout.
- **Recommandation** : (a) : c'est la définition d'ADR-041 déjà partagée par deux écrans.
- **Impact** : [ADR-065](decisions/ADR-065-une-seule-definition-par-indicateur-et-periodes.md) §2 ; test d'équivalence (P9-15). Défaut implémenté : (a). Non paramétrable.

### AV-377 — Annulations dans l'explorateur — SECONDAIRE
- **Question** : L'explorateur compte-t-il une annulation à sa date ou à la date de la vente, et sur quelle colonne de date filtre-t-on chaque mesure ?
- **Pourquoi** : BR-ANA-003 : « par période d'activité » à la date d'annulation (BR-FIN-042) ; une vue « net par date de vente » est proposée avec un libellé distinct. Le dictionnaire écrit « daté de son occurred_at » alors que la définition de référence date l'annulation de `applied_at` et filtre `status = 'APPLIED'` (`saleActivityArms`). **CONFIRMÉ** (règle) / **DÉDUIT** (colonnes).
- **Choix** : (a) deux colonnes `business_day` et `sale_day`, une colonne de période par mesure, `ANALYTICS_MIXED_PERIOD_BASIS` si on les mêle ; (b) la seule mesure par période d'activité ; (c) la seule mesure par date de vente.
- **Recommandation** : (a).
- **Impact** : [ADR-064](decisions/ADR-064-couche-semantique-et-explorateur.md) §3, [ADR-065](decisions/ADR-065-une-seule-definition-par-indicateur-et-periodes.md) §5, catalogue de `f_sales_line`, dictionnaire. Défaut implémenté : (a). Non paramétrable.

### AV-378 — Remontée d'un chiffre jusqu'aux sources — SECONDAIRE
- **Question** : Comment se réalise BR-ANA-010 (tout indicateur de la tour mène en au plus deux niveaux aux opérations sources) ?
- **Pourquoi** : AT-043 (« pourquoi manque-t-il 5 unités ? ») et AT-045 (enquête sur une vente annulée) s'appuient sur `GET /stock-moves` (un emplacement à la fois) et la lecture de l'audit, déjà livrées ; BR-ANA-010 demande le chemin depuis le tableau. **DÉDUIT**.
- **Choix** : (a) lien d'exploration par bloc, identifiant et route du document par ligne ; composition des lectures existantes ; (b) nouvelle lecture de trace dédiée ; (c) navigation par l'application seulement.
- **Recommandation** : (a).
- **Impact** : [ADR-065](decisions/ADR-065-une-seule-definition-par-indicateur-et-periodes.md) §6 ; `analytics-api` (liens), tests AT-043 et AT-045. Défaut implémenté : (a). Non paramétrable.

### AV-379 — Contenu de la tour de contrôle et des tableaux de rôle — IMPORTANTE
- **Question** : Quels indicateurs, quelles comparaisons et quel comportement quand un bloc échoue ?
- **Pourquoi** : D11 §7.2 donne les blocs et les alertes associées ; la comparaison « vs période précédente » est dans le bloc VENTES, elle n'a de sens que pour un flux ; plusieurs indicateurs de D11 n'ont pas de fonction publique (couverture, taux visite → commande, réachat, mortalité par jour et sur 7 jours, taux d'œufs et d'éclosion, effectifs par type de lot) ; une tour partielle vaut mieux qu'une erreur. **CONFIRMÉ** (contenu) / **DÉDUIT** (isolation, flux).
- **Choix** : (a) §7.2 avec période précédente des flux, isolation par bloc, fonctions créées dans les modules propriétaires (fichiers de `public/`, listés au suivi) ; (b) contenu plus réduit ; (c) échec global à la première erreur.
- **Recommandation** : (a).
- **Impact** : [ADR-066](decisions/ADR-066-tableaux-tour-de-controle-et-instantanes.md) §2 à §4, [ADR-065](decisions/ADR-065-une-seule-definition-par-indicateur-et-periodes.md) §1. Défaut implémenté : (a). Paramétrable : période maximale (`analytics.dashboard_max_period_days`), plafond du compteur de validations.

### AV-380 — Instantanés personnels : fréquence, périodes, utilisateurs, retrait — SECONDAIRE
- **Question** : Quand et pour qui les instantanés `kpi_snapshots` sont-ils calculés, et que devient une ligne devenue sans objet ?
- **Pourquoi** : Architecture §6 : « toutes les 15 min » ; D11 §12 : tableaux personnels hors ligne. Calculer pour tous les utilisateurs serait du bruit ; sans suppression, un droit retiré laisserait une ligne lisible. **DÉDUIT**.
- **Choix** : (a) 15 minutes, trois périodes, utilisateurs actifs sur 7 jours, `scope_key` = code du tableau, suppression publiée au flux ; (b) tous les utilisateurs ; (c) à la demande seulement.
- **Recommandation** : (a).
- **Impact** : [ADR-066](decisions/ADR-066-tableaux-tour-de-controle-et-instantanes.md) §5. Défaut implémenté : (a). Paramétrable (`analytics.snapshot_*`) ; la cadence de 15 minutes est une constante de planification.

### AV-381 — Jeu hors ligne `kpi` — SECONDAIRE
- **Question** : Quel est le contenu et la portée du jeu `kpi` ?
- **Pourquoi** : `kpi` est cité par la spécification de synchronisation sans producteur ; la PWA ne le connaît pas encore (`KNOWN_DATASETS`) ; republier à chaque calcul bruiterait le pull, ne republier qu'au changement rendrait « à jour au » trompeur. **DÉDUIT**.
- **Choix** : (a) un instantané par (tableau, période) pour son utilisateur, republié au changement ou toutes les heures ; (b) tous les instantanés du site ; (c) pas de jeu : lecture en ligne seulement.
- **Recommandation** : (a).
- **Impact** : [ADR-066](decisions/ADR-066-tableaux-tour-de-controle-et-instantanes.md) §6 ; `sync/kpi-projections.ts` (nouveau) et inscription dans `entity-projections.ts` (session principale, B2). Défaut implémenté : (a). Non paramétrable.

### AV-382 — Vues sauvegardées : partage, vue par défaut, lecture — SECONDAIRE
- **Question** : Comment se partage une vue, que voit le lecteur et comment liste-t-on et exécute-t-on une vue ?
- **Pourquoi** : BR-ANA-007 : une vue partagée ne donne aucun droit supplémentaire, chaque lecteur la voit restreinte à son périmètre ; dictionnaire : `shared_with_roles`, `is_default_for_role`, suppression physique d'un objet de confort ; les écrans ECR-ANA-06 supposent un listage et une exécution. **CONFIRMÉ** / **DÉDUIT** (lectures).
- **Choix** : (a) partage par rôles, revalidation à l'exécution par les droits de l'exécutant, `GET /analytics/views`, exécution par `view_id` ; (b) partage par utilisateurs nommés ; (c) vues publiques à tous.
- **Recommandation** : (a).
- **Impact** : [ADR-067](decisions/ADR-067-vues-sauvegardees-et-exports-audites.md) §1 et §2. Défaut implémenté : (a). Non paramétrable.

### AV-383 — Exports : formats, asynchronie, durée de vie — SECONDAIRE
- **Question** : Quels formats et quelle mécanique pour les exports (AV-067) ?
- **Pourquoi** : AV-067 : CSV et XLSX, exports journalisés ; le dictionnaire donne 24 h et 30 jours ; aucune bibliothèque XLSX n'est installée ; le port de stockage ne sait ni supprimer ni lire en flux ; une tâche qui lève voit ses écritures annulées. **CONFIRMÉ** (formats) / **DÉDUIT** (mécanique).
- **Choix** : (a) tâche unique qui ne lève pas pour un échec métier, écrivain XLSX minimal sans dépendance, port de stockage étendu (suppression, lecture en flux) ; (b) bibliothèque XLSX ; (c) CSV seulement.
- **Recommandation** : (a).
- **Impact** : [ADR-067](decisions/ADR-067-vues-sauvegardees-et-exports-audites.md) §3 à §5. Défaut implémenté : (a). Paramétrable : durées, limite.

### AV-384 — Droit d'exporter et de télécharger un export — SECONDAIRE
- **Question** : Que faut-il pour exporter des données financières (AV-067), et qui peut télécharger un export ?
- **Pourquoi** : AV-067 : « l'export de données financières exige `analytics.export` avec un périmètre financier » ; les mesures protégées exigent `inventory.valuation.read` (BR-ANA-004). L'administrateur détient `audit.log.read` sans `analytics.export` ni `inventory.valuation.read` : lui ouvrir le fichier d'un export de marge élargirait le périmètre par une voie latérale. **CONFIRMÉ** / **DÉDUIT** (double contrôle, demandeur seul).
- **Choix** : (a) droits revérifiés à l'instant du calcul ; téléchargement et lecture d'état réservés au demandeur ; l'audit lit la ligne d'export, pas le fichier ; (b) téléchargement aussi par `audit.log.read` ; (c) droit d'export propre à la finance.
- **Recommandation** : (a).
- **Impact** : [ADR-067](decisions/ADR-067-vues-sauvegardees-et-exports-audites.md) §3, §6 et §8. Défaut implémenté : (a). Non paramétrable.

### AV-385 — Permissions de P9 : codes réutilisés — SECONDAIRE
- **Question** : Faut-il semer de nouvelles permissions ?
- **Pourquoi** : D11 §4 cite `analytics.view.save` et `analytics.export.request` ; D11 §13 et le seed n'en listent pas ; le pipeline exige un code de permission par commande (`permissionCode`) : il n'existe pas de commande « utilisateur authentifié ». `comm.alert.read` et `comm.note.read` sont semées pour les onze rôles. **DÉDUIT**.
- **Choix** : (a) réutiliser les codes semés (`communication.push.subscribe`, `.unsubscribe`, `communication.notification.read` sous `comm.alert.read` ; `communication.note.acknowledge` sous `comm.note.read` ; brouillons de note sous `comm.note.publish`) ; (b) semer `analytics.view.save`, `analytics.export.request`, `comm.push.subscribe` ; (c) tout sous `analytics.explore`.
- **Recommandation** : (a) : aucun changement de la matrice RBAC.
- **Impact** : [ADR-067](decisions/ADR-067-vues-sauvegardees-et-exports-audites.md) §1, [ADR-062](decisions/ADR-062-destinataires-notifications-push-et-escalade.md) §4 et §5 ; `db/seeds/rbac-data.ts` inchangé pour ces codes. Défaut implémenté : (a). Non paramétrable.

### AV-386 — Volumétrie cible et paliers analytiques — IMPORTANTE
- **Question** : Quelle volumétrie dimensionne P9 et à quel signal passe-t-on aux agrégats (AV-086, RISK-13) ?
- **Pourquoi** : H-06 : 150 utilisateurs, 40 sites, 5 000 lignes de vente par jour, 20 000 clients, 200 lots actifs ; architecture §6 : seuils de palier ; le plan de tests prévoit « 1× et 10× H-06 ». **CONFIRMÉ** (hypothèse).
- **Choix** : (a) palier 1 mesuré sur jeu de charge, bascule sur seuil, facteur 10 gardé pour la porte d'avant production ; (b) agrégats dès P9 ; (c) pas de mesure.
- **Recommandation** : (a).
- **Impact** : [ADR-068](decisions/ADR-068-charge-paliers-analytiques-et-retention.md) §5 et §6. Défaut implémenté : (a). Paramétrable : seuils de contrôle.

### AV-387 — Rétention des données de communication et d'analyse — SECONDAIRE
- **Question** : Combien de temps conserve-t-on les alertes, notifications, exports et traces de requêtes, et par quel mécanisme ?
- **Pourquoi** : Le dictionnaire donne 2 ans (alertes), 90 jours (notifications), 30 jours (exports) et la purge des abonnements invalides ; le journal des requêtes de l'explorateur n'a pas de durée (BR-ANA-008 impose l'audit de l'export, pas de chaque requête) ; le rôle d'application n'a pas `DELETE` sur les tables `IMMUABLE` : les alertes se purgent par le rôle de maintenance. **CONFIRMÉ** (dictionnaire) / **DÉDUIT** (journal, mécanisme).
- **Choix** : (a) durées du dictionnaire, 90 jours pour le journal, durées en paramètres, `03-historisation-suppression.md` complété ; (b) conservation sans limite ; (c) journal des requêtes non tenu.
- **Recommandation** : (a).
- **Impact** : [ADR-068](decisions/ADR-068-charge-paliers-analytiques-et-retention.md) §8 ; `docs/03-data/03-historisation-suppression.md` §3 ; tâches de purge. Défaut implémenté : (a). Paramétrable.

### AV-388 — Délai événement → alerte et fenêtre de stabilisation — IMPORTANTE
- **Question** : NFR-15 exige un délai événement → réaction de 10 s au p95 (p95 ≤ 10 s) et BR-NOT-004 un push « immédiat » pour une alerte `CRITICAL` : comment s'accorde-t-on avec la fenêtre de stabilisation de 120 s du consommateur ?
- **Pourquoi** : `settledSequenceBound` retient un événement derrière un trou de numérotation récent jusqu'à 120 s (`EVENT_SETTLE_DEFAULT_SECONDS`) ; la fenêtre protège les événements validés tardivement (P5-23). Elle s'applique à tous les consommateurs, alertes critiques comprises. **DÉDUIT**.
- **Choix** : (a) conserver la fenêtre, la documenter comme tolérance de NFR-15, mesurer délai et retard ; (b) fenêtre propre à `communication.alerts` (option `settleSeconds` du runner), 5 s ; (c) raccourcir la fenêtre pour tous.
- **Recommandation** : (a) puis (b) si la mesure de P9-21 l'exige.
- **Impact** : [ADR-061](decisions/ADR-061-alertes-detection-correlation-et-cycle-de-vie.md) §14, [ADR-068](decisions/ADR-068-charge-paliers-analytiques-et-retention.md) §7 ; `platform/events` (option du runner, ajout). Défaut implémenté : (a). Paramétrable en (b).

### AV-389 — Notifications directes d'événements (hors alerte) — SECONDAIRE
- **Question** : Quels événements du catalogue dont la conséquence est « notification » (et non une alerte) sont livrés par P9 ?
- **Pourquoi** : Le catalogue d'événements cite NOT pour `ApprovalRequested`, `ApprovalGranted`, `ApprovalRejected`, `DeviceEnrollmentRequested`, `StockTransferRequested`, `StockTransferDispatched`, `PurchaseRequestApproved`, `PurchaseRequestRejected`, D01 §14 dit que les événements des demandeurs « servent aux notifications » ; ADR-062 ne prévoyait que alerte, note et export comme sources. **DÉDUIT**.
- **Choix** : (a) liste ci-contre, canal in-app, destinataire par le résolveur (ADR-062 §2) ; les autres restent sans notification ; (b) toutes les lignes du catalogue ; (c) aucune notification directe.
- **Recommandation** : (a).
- **Impact** : [ADR-062](decisions/ADR-062-destinataires-notifications-push-et-escalade.md) §4, P9-11 (livrées avec les notes, par le même écrivain de notifications) ; consommateur de `communication` (second consommateur, ou règle du consommateur d'alertes). Défaut implémenté : (a). Paramétrable : activation par type.

### AV-390 — Valeurs au coût dans les alertes et notifications — IMPORTANTE
- **Question** : Une alerte ou une notification peut-elle porter une valeur au coût (valeur d'une perte, écart d'inventaire en valeur) à un destinataire qui ne détient pas `inventory.valuation.read` ?
- **Pourquoi** : RC-05 et BR-ANA-004 réservent les coûts, marges et valeurs de stock à ce droit ; AV-206 masque déjà la valeur du perdu ; D13 §7.1 envoie `HIGH_LOSS` au responsable de site et `INVENTORY_VARIANCE` à la Finance ; un message pré-rendu contiendrait la valeur pour tous les destinataires, y compris sur l'appareil. **DÉDUIT**.
- **Choix** : (a) charge utile à champs séparés marqués protégés, message rendu à la lecture selon le droit du lecteur, gabarit neutre sinon ; (b) valeur toujours affichée aux destinataires ; (c) aucune valeur dans les alertes.
- **Recommandation** : (a).
- **Impact** : [ADR-061](decisions/ADR-061-alertes-detection-correlation-et-cycle-de-vie.md) §11, [ADR-062](decisions/ADR-062-destinataires-notifications-push-et-escalade.md) §4, dictionnaire `communication.alerts` (`payload`). Défaut implémenté : (a). Non paramétrable.

### AV-391 — Sujet d'une alerte à clé composite — SECONDAIRE
- **Question** : Quel est le sujet d'une alerte dont l'objet n'a pas d'identifiant propre (solde de stock, lot × jour) ?
- **Pourquoi** : `inventory_stock_balances` n'a pas d'identifiant (clé `emplacement`, `produit`, `lot`) ; `aggregate_id` d'un événement et `subject_id` d'une alerte sont des UUID non nuls ; le seuil de stock est par couple emplacement × produit (BR-STK-051). **DÉDUIT**.
- **Choix** : (a) UUID v5 du couple (modèle `platform/sync/code-entity-id.ts`), `subject_type` composite, couple lisible dans la charge utile ; (b) colonne de sujet composite ; (c) un événement par lot.
- **Recommandation** : (a).
- **Impact** : [ADR-061](decisions/ADR-061-alertes-detection-correlation-et-cycle-de-vie.md) §5, catalogue `alerts.ts`. Défaut implémenté : (a). Non paramétrable.

### AV-392 — Alerte d'erreur de synchronisation (`SYNC_ERROR`) — SECONDAIRE
- **Question** : Comment `SYNC_ERROR` est-elle détectée et à quelle maille, alors qu'un rejet est un état terminal sans événement ni conflit ?
- **Pourquoi** : Le pipeline écrit seulement la ligne de boîte d'un rejet (`markAndReject`), `SyncConflictDetected` n'est pas produit à la création ; une alerte par commande inonderait pour un appareil défaillant ; D13 donne « Auto (conflit résolu) » sans mécanisme pour un rejet. **DÉDUIT**.
- **Choix** : (a) passe de `sync` sur la fenêtre `sync.error_alert_window_hours` (24) : un événement par (appareil, code d'erreur) ; codes transitoires exclus ; résolution par marqueur de passe ; `dismiss` admis (alerte d'événement pour un rejet) ; (b) alerte par commande rejetée ; (c) pas d'alerte, file des conflits seulement.
- **Recommandation** : (a).
- **Impact** : `sync` (tâche), [ADR-061](decisions/ADR-061-alertes-detection-correlation-et-cycle-de-vie.md) §2 et §3. Défaut implémenté : (a). Paramétrable (fenêtre, liste de codes). **Révisé par AV-421** : l'alerte reste une alerte d'état (`dismiss` refusé), la détection est une passe horaire.

### AV-393 — Rôles destinataires d'un déclencheur à rôles propres, règle modifiée — SECONDAIRE
- **Question** : Quand un type d'alerte a des déclencheurs à rôles destinataires propres (`DUPLICATE_SUSPECTED` : la Finance pour un paiement, le responsable commercial pour un doublon de client, le responsable des achats pour une réception en quarantaine), que vaut la liste de rôles de la règle quand un administrateur l'a modifiée ?
- **Pourquoi** : La règle (`communication.alert_rule.set`) porte une seule liste de rôles par type ; le catalogue du domaine en porte une par déclencheur. Sans arbitrage, soit le réglage de l'administrateur est contourné par le déclencheur, soit les rôles propres d'un déclencheur disparaissent dès le moindre réglage. **DÉDUIT**.
- **Choix** : (a) tant que la règle a les rôles du catalogue, ceux du déclencheur s'appliquent ; une règle modifiée vaut pour tout le type ; (b) toujours les rôles de la règle ; (c) l'union de la règle et du déclencheur.
- **Recommandation** : (a).
- **Impact** : [ADR-062](decisions/ADR-062-destinataires-notifications-push-et-escalade.md) §1, `effectiveRecipientRoles` (domaine). Défaut implémenté : (a). Paramétrable : par la règle elle-même (la modifier suffit).

### AV-394 — Rôles suivis par `INACTIVE_COMMERCIAL` — SECONDAIRE
- **Question** : Quels rôles la détection d'inactivité d'un commercial suit-elle, et quels cas d'absence légitime ignore-t-elle ?
- **Pourquoi** : BR-TER-013 vise le « commercial terrain » ; le responsable commercial et la Direction ont aussi des affectations commerciales, sans obligation de prise de service quotidienne. Suivre tout rôle commercial inonderait d'alertes l'encadrement. Aucune donnée de congé, de jour férié ni de remplacement n'existe dans le modèle : ces absences légitimes ne sont pas distinguées, et une activité saisie hors ligne et synchronisée après 08:00 n'est pas réévaluée (l'alerte se ferme à la passe suivante). **DÉDUIT**.
- **Choix** : (a) le seul rôle `COMMERCIAL_TERRAIN`, liste paramétrée `sales.inactive_commercial_role_codes` ; jours ouvrés `sales.commercial_working_days` ; congés, fériés et rattrapage hors ligne non gérés (une alerte parasite se ferme seule le jour suivant) ; (b) tout rôle ayant une affectation commerciale ; (c) congés saisis (hors périmètre).
- **Recommandation** : (a).
- **Impact** : `sales` (tâche quotidienne de P9-07), seeds. Défaut implémenté : (a). Paramétrable.

### AV-395 — `PRICE_MISMATCH` : ventes directes et commandes hors ligne — SECONDAIRE
- **Question** : L'alerte `PRICE_MISMATCH` (prix figé par l'appareil hors ligne différent du prix que le serveur aurait résolu à la date du fait, BR-VEN-029, AV-063) vaut-elle aussi pour une commande saisie hors ligne ?
- **Pourquoi** : La vente directe hors ligne est vendue au prix figé de l'appareil ; une commande hors ligne garde elle aussi son prix convenu (D04, lignes d'une commande, P4-06 : « hors ligne : prix de l'appareil et anomalie `PRICE_MISMATCH` ») et ouvre le même conflit de synchronisation. L'alerte doit couvrir les deux documents. **DÉDUIT**.
- **Choix** : (a) un événement par vente directe ou par commande en écart (INFO), publié dans la transaction de la commande, détail des lignes plafonné à 100 ; (b) ventes directes seulement ; (c) une alerte par ligne.
- **Recommandation** : (a).
- **Impact** : `sales` (`sales.sale.record`, `sales.order.place`, `sales.order.update` pour les lignes ajoutées). Défaut implémenté : (a). Non paramétrable.

### AV-396 — Avance client : doublon probable non contrôlé — SECONDAIRE
- **Question** : Une avance client est-elle soumise au contrôle du doublon probable (même montant dans la fenêtre, BR-FIN-005) comme un encaissement de vente ?
- **Pourquoi** : Le contrôle de référence identique couvre les avances (mise de côté, décision `PAYMENT_DUPLICATE`, alerte `DUPLICATE_SUSPECTED`) ; le doublon probable n'est posé que pour les encaissements de vente et de commande, et l'avance ne porte pas ce signalement. Constat de P9-07, pas une régression. **DÉDUIT**.
- **Choix** : (a) laisser en l'état : référence identique seulement pour une avance ; (b) étendre le contrôle du doublon probable aux avances (même fenêtre `sales.duplicate_payment_window_minutes`) ; (c) alerte pour tout encaissement de même montant, quel que soit le type.
- **Recommandation** : (b) à terme, (a) maintenant : le montant d'une avance est souvent rond et répété, le signalement serait bruyant sans retour terrain.
- **Impact** : `sales` (acomptes joints à `sales.order.place`, `advance-payments.ts`). Défaut implémenté : (a). Non paramétrable.

### AV-397 — Encaisse élevée ou sans remise (`CASH_HOLDING_HIGH`) : définition — IMPORTANTE
- **Question** : Comment se définit « solde au-dessus du plafond ou aucune remise depuis plus de 3 jours » (D09 §14) : quels comptes, quelle date de référence, quel sort pour un solde nul ?
- **Pourquoi** : D09 §14 donne les deux seuils sans la date de référence ni la maille ; une caisse de PDV a ses sessions, une caisse centrale ou bancaire n'a pas à être remise. Compter les jours depuis la dernière remise seule signalerait « sans remise depuis trois semaines » un compte vidé puis réalimenté la veille, dès sa première entrée d'espèces. **DÉDUIT**.
- **Choix** : (a) caisses d'utilisateur actives de solde positif ; référence = la plus récente de l'envoi de la dernière remise non annulée et de l'entrée de l'espèce encore détenue (FIFO : les remises consomment les plus anciennes entrées) ; jours métier ; seuils globaux (compte sans site) ; 0 désactive un critère, une valeur invalide revient au défaut ; (b) référence = dernière remise seule (plus simple, bruyant) ; (c) caisses de PDV incluses.
- **Recommandation** : (a).
- **Impact** : `finance` (tâche horaire `finance.cash_holdings.high_check`), seeds (`finance.cash_holding_max_xaf`, `finance.cash_holding_max_days`). Défaut implémenté : (a). Paramétrable (seuils).

### AV-398 — `CASH_MISMATCH` : jour métier et écarts sans compte — SECONDAIRE
- **Question** : À quel jour métier rattache-t-on un écart de la réconciliation de nuit, et comment sujet-t-on un écart qui ne se rattache à aucun compte ?
- **Pourquoi** : La tâche tourne à 02:30 et verrait le jour qui commence ; D13 donne « par compte et jour métier ». Les dépenses et documents fournisseurs (INV-FIN-07 et 08) n'ont pas de compte. Une tâche qui échoue annule ses écritures : l'événement n'aurait jamais existé. **DÉDUIT**.
- **Choix** : (a) jour métier de l'exécution ; un événement par compte ; clé `NONE` pour les écarts sans compte ; la tâche se termine en succès, l'alerte (CRITICAL, résolution manuelle) et le journal sont le signal ; (b) jour examiné (la veille) ; (c) un événement par rupture.
- **Recommandation** : (a).
- **Impact** : `finance` (`finance.cash.reconcile_daily`), [ADR-061](decisions/ADR-061-alertes-detection-correlation-et-cycle-de-vie.md) §3. Défaut implémenté : (a). Non paramétrable. Un écart non corrigé crée une alerte par jour (fidèle au catalogue). Un superviseur qui surveillait les tâches `FAILED` ne voit plus la réconciliation : l'alerte est le signal.

### AV-399 — `ATTACHMENT_MISSING` des dépenses : délai, référence, horizon et rattachement — SECONDAIRE
- **Question** : Les 7 jours d'AV-357 se comptent depuis quelle date, jusqu'à quand balaie-t-on, que devient l'alerte d'une dépense qui sort de l'horizon, et comment une pièce se rattache-t-elle à une dépense ?
- **Pourquoi** : La date du fait d'une dépense hors ligne peut être ancienne : compter depuis elle alerterait dès la synchronisation. Toute dépense au-dessus du seuil avec pièce resterait examinée à jamais. Un marqueur de passe résout tout ce que la passe n'a pas revu : deux producteurs d'un même type s'annuleraient. La présence se lit sur la pièce `AVAILABLE` rattachée au document ; l'envoi de la photo d'une dépense devra donc la rattacher avec `owner_type = 'EXPENSE'` et `owner_id` = identifiant de la dépense (aucun écran d'envoi n'existe encore pour les dépenses, ECR-FIN-02). **DÉDUIT**.
- **Choix** : (a) délai compté depuis la réception par le serveur ; horizon `attachments.missing_alert_horizon_days` (90, au moins le délai plus un jour) ; une dépense qui sort de l'horizon sans pièce n'est plus revue : son alerte se ferme (le balayage reste borné) ; `0` jour désactive l'alerte et ferme celles qui sont ouvertes ; passe de **portée** `EXPENSE`, distincte de celle des réceptions (P9-09) ; rattachement `owner_type = EXPENSE` ; (b) délai depuis la date du fait ; (c) passe unique partagée.
- **Recommandation** : (a).
- **Impact** : `finance` (tâche quotidienne 06:15), domaine et `communication` (marqueur à portée), seeds ; besoin signalé à la session principale pour les écrans de dépense (rattachement). Défaut implémenté : (a). Paramétrable (délai, `0` désactive ; horizon).

### AV-400 — `CASH_VARIANCE` : écart toléré, ajustement d'ouverture, ajustements restants — SECONDAIRE
- **Question** : Un écart de caisse dans la tolérance lève-t-il une alerte, l'ajustement d'un écart d'ouverture (AV-224) est-il signalé, une validation d'office ferme-t-elle l'alerte, et que devient l'alerte quand un seul de plusieurs ajustements est validé ? L'imputé est-il destinataire ?
- **Pourquoi** : Une session validée d'office (écart dans `finance.cash_variance_tolerance_xaf`) n'émet pas `CashSessionValidated` : une alerte levée à l'ouverture (tolérance plus basse à l'époque) ne pourrait jamais se résoudre. L'ajustement d'ouverture ne publiait aucun événement : une session validée recevant une opération antérieure à son ouverture était réévaluée en silence. L'alerte est portée par la session : la validation d'un ajustement la ferme alors que d'autres attendent. D13 §7.1 adresse l'alerte à la Finance seule. **DÉDUIT**.
- **Choix** : (a) un écart toléré est un constat (événement publié, drapeau `tolerated`, aucune alerte) ; la clôture validée d'office (`CashSessionClosed` avec `auto_validated`) ferme l'alerte ; l'ajustement d'ouverture publie l'événement de phase `ADJUSTMENT` ; les ajustements restants sont signalés de nouveau après une validation (cause `REMAINING_ADJUSTMENTS`) ; l'imputé reste hors destinataires ; (b) alerte aussi pour l'écart toléré ; (c) l'imputé destinataire. Limite : la tolérance lue à l'ouverture peut différer de celle de la clôture ; l'alerte ne se lève pas si l'écart était toléré à l'époque, la demande de validation de l'approbation reste la voie de traitement.
- **Recommandation** : (a).
- **Impact** : `finance` (ouverture, clôture, réévaluation, validation), catalogue du domaine. Défaut implémenté : (a). Paramétrable (tolérance, déjà un paramètre).

### AV-401 — `SALE_UNDELIVERED` : livraison demandée à une date ultérieure — SECONDAIRE
- **Question** : Une vente confirmée dont le client a demandé une livraison à une date ultérieure est-elle « non livrée depuis plus de N jours » à partir de sa confirmation ?
- **Pourquoi** : AV-132 compte l'ancienneté depuis la confirmation ; une livraison planifiée à deux semaines serait signalée au bout de sept jours alors qu'elle n'est pas en retard. **DÉDUIT**.
- **Choix** : (a) l'ancienneté se compte depuis la plus tardive de la confirmation et de la date de livraison demandée (`requested_delivery_date`) ; (b) depuis la confirmation seule (AV-132 à la lettre) ; (c) ne jamais alerter une livraison planifiée.
- **Recommandation** : (a).
- **Impact** : `sales` (`sales.orders.undelivered_check`, lecture `listUndeliveredSales`). Défaut implémenté : (a). Paramétrable : `sales.undelivered_alert_days`.

### AV-402 — `POS_REPLENISH` : condition, cadence et destinataires — SECONDAIRE
- **Question** : Un point de vente est-il à réapprovisionner dès que « cible − disponible − transit entrant » est positif, ou seulement sous son minimum ? À quelle cadence, et qui est prévenu ?
- **Pourquoi** : D13 §7.1 dit « suggestion de réapprovisionnement > 0 » (planifiée 06:00 + sur mouvement) : tout point de vente sous sa cible, c'est-à-dire presque toujours, y compris au-dessus du minimum. Le transit entrant (transfert expédié vers le PDV) change la suggestion sans aucun mouvement du PDV : l'événement sur mouvement ne la voit pas. Le résolveur de destinataires rattache l'alerte au site du PDV : un magasinier du seul site source n'est pas destinataire. **DÉDUIT**.
- **Choix** : (a) littéral (`BELOW_TARGET`), jugé par la passe horaire des seuils (06:00 compris), l'alerte se ferme au marqueur de la passe ; paramètre `inventory.replenish_alert_scope` pour `BELOW_MINIMUM` (suggestion positive **et** sous le minimum) ; (b) seulement sous le minimum ; (c) un événement sur mouvement en plus, avec résolution par suggestion nulle.
- **Recommandation** : (a), puis `BELOW_MINIMUM` si le bruit gêne.
- **Impact** : `inventory` (`inventory.alerts.stock_threshold_sweep`), seed, dictionnaire. Défaut implémenté : (a). Paramétrable. Limite : destinataires — le magasinier du site source n'est prévenu que par une affectation de zone ou globale ; la valeur au coût n'est pas en jeu.

### AV-403 — `HIGH_LOSS` (seuil absolu) : cumul du jour, mortalité, déclarations en attente — IMPORTANTE
- **Question** : Quel cumul compare-t-on au seuil de 50 000 XAF : pertes du jour métier de quel fait, avec ou sans mortalité, avec ou sans les déclarations en attente de validation ? Un événement à chaque perte ou au franchissement ?
- **Pourquoi** : D13 §7.1 dit « valeur des pertes d'un emplacement sur 1 jour ». Une mortalité passe par la même déclaration (catégorie `MORTALITE`) : l'inclure doublerait `HIGH_MORTALITY` (production) et valoriserait des animaux au coût par tête. Une perte en attente est déjà sortie du stock : « sur perte » veut l'alerte immédiate. Hors ligne, le jour de la perte est celui du fait, pas celui de la synchronisation. **DÉDUIT**.
- **Choix** : (a) cumul de l'emplacement sur le jour métier de `occurred_at` du fait, statuts constatée, en attente, non justifiée, en annulation ; mortalité exclue ; un événement par déclaration tant que le cumul atteint le seuil (le compteur d'occurrences avance, une alerte résolue renaît à la déclaration suivante, AV-354) ; seuil lu par site puis global, repli 50 000 XAF, une perte sans valeur n'alerte jamais ; (b) mortalité incluse ; (c) un événement au seul franchissement.
- **Recommandation** : (a).
- **Impact** : `inventory` (`declareLoss`, lecture publique `dayLossByLocation`), catalogue. Défaut implémenté : (a). Paramétrable : `inventory.high_loss_alert_xaf`. Limites : (1) la quantité (`loss_quantity`) n'est publiée que pour **un seul** produit ; sur plusieurs produits d'unités différentes elle est nulle et le message l'omet (la valeur, elle, se cumule toujours) ; (2) deux déclarations concurrentes du même emplacement qui franchissent le seuil **ensemble** peuvent ne l'être par aucune (chacune lit l'instantané qui précède l'autre) : la déclaration suivante du jour, qui lit les deux, lève l'alerte ; (3) une mortalité rejetée « perte non justifiée » est reclassée `INEXPLIQUEE` (décision AV-038, préexistante) et entre alors dans le cumul des déclarations suivantes.

### AV-404 — `LOT_EXPIRING` : périmètre, sujet et horizon — SECONDAIRE
- **Question** : Quels lots signale-t-on, comment compte-t-on « sous 15 jours », et que devient un lot déjà périmé qui a encore du stock ?
- **Pourquoi** : D13 §7.1 dit « lot fournisseur », mais la date de péremption est aussi posée par les collectes d'œufs et les abattages ; un œuf périme. Un lot peut être en stock sur plusieurs sites, chacun a son magasinier. **DÉDUIT**.
- **Choix** : (a) tout lot ouvert qui porte une date de péremption et du stock sur un emplacement physique (l'emplacement virtuel de transit n'en compte pas), un sujet par lot, par site **et par produit** (un lot de collecte à plusieurs calibres ou d'abattage porte plusieurs produits), horizon `inventory.lot_expiring_days` en jours du calendrier (entier ≥ 0, repli 15 ; 0 : périmant aujourd'hui ou déjà périmé), un lot périmé reste signalé tant que le stock n'est pas sorti, passe quotidienne 06:00, l'alerte se ferme au marqueur ; (b) lots fournisseur seulement ; (c) sujet le lot seul.
- **Recommandation** : (a).
- **Impact** : `inventory` (`inventory.alerts.lot_expiring_daily`), catalogue (sujet lot × site). Défaut implémenté : (a). Paramétrable : `inventory.lot_expiring_days`.

### AV-405 — `HIGH_LOSS` : part « % du CA » — SECONDAIRE
- **Question** : Rapporte-t-on la perte d'un emplacement au CA de cet emplacement, de son site ou du jour tout entier, quand, et combien de fois ?
- **Pourquoi** : D13 §7.1 dit « ≥ 5 % des ventes du jour » sans le périmètre. Un emplacement qui ne vend pas (poulailler, magasin d'intrants) n'aurait aucune vente propre. Le CA du jour n'est complet qu'à la fin du jour, et les faits hors ligne arrivent après coup. **DÉDUIT**.
- **Choix** : (a) CA net du **site** du jour (ventes − annulations appliquées, tous emplacements) ; les deux derniers jours métier clos, examinés à 06:45 ; au plus un événement par emplacement et par jour (l'identité de passe est le jour examiné) ; sans vente, la part n'est pas définie et seul le seuil absolu joue ; pourcentage lu par site puis global, repli 5 % ; (b) CA de l'emplacement seul ; (c) CA total du jour.
- **Recommandation** : (a).
- **Impact** : `sales` (`sales.losses.sales_share_check`), lecture publique d'`inventory`. Défaut implémenté : (a). Paramétrable : `sales.high_loss_alert_sales_pct` ; la fenêtre de deux jours est une constante de planification, non paramétrable (comme les créneaux, AV-361). **Complémentarité avec le seuil absolu** : une perte qui atteint déjà `inventory.high_loss_alert_xaf` a levé l'alerte à la déclaration ; la part du CA ne la republie pas (une alerte résolue ou écartée ne renaît pas le lendemain, AV-354) et ne couvre donc que les pertes **sous** le seuil absolu. Le pourcentage et le seuil absolu sont lus **à la fin du jour examiné**, comme le fait `inventory` à la déclaration. Limite : une perte synchronisée après le deuxième jour n'est plus examinée.

### AV-406 — `INVENTORY_VARIANCE` : seuil, levée et fermeture — SECONDAIRE
- **Question** : À partir de quel écart d'inventaire alerte-t-on, quand, et qu'est-ce qui ferme l'alerte ?
- **Pourquoi** : D13 §7.1 dit « écart en valeur ≥ seuil » sans nommer le seuil ; AV-039 en fixe un pour la validation. AV-108 impose la validation de tout écart sur des animaux. **DÉDUIT**.
- **Choix** : (a) le seuil d'alerte est le seuil d'approbation (`inventory.count_approval_threshold_xaf`) : l'alerte accompagne la demande de validation, levée à la soumission quand la validation est requise (valeur ou animaux), jamais pour un inventaire sans écart ; fermée par `InventoryAdjusted` à la comptabilisation approuvée ; un rejet de la demande laisse l'alerte ouverte (recomptage), fermeture manuelle ; `InventoryAdjusted` est aussi publié à la comptabilisation immédiate (sans alerte) ; (b) un seuil d'alerte propre ; (c) alerte sur tout écart.
- **Recommandation** : (a).
- **Impact** : `inventory` (`inventory.count.submit`, décision `INVENTORY_ADJUSTMENT`). Défaut implémenté : (a). Paramétrable (seuil d'approbation). Limite : l'écart net additionne des produits d'unités différentes (indicateur grossier, le détail par ligne reste dans l'inventaire).

### AV-407 — Date de détection des alertes de stock issues d'un fait — SECONDAIRE
- **Question** : Un fait de stock saisi hors ligne il y a un jour et synchronisé aujourd'hui est-il « détecté » à la date du fait ou à son application ?
- **Pourquoi** : `first_detected_at` et `critical_since` viennent de la date de l'événement ; l'escalade d'une alerte critique (4 h) compterait depuis le fait et partirait aussitôt, et une résolution datée du fait précéderait la levée. **DÉDUIT**.
- **Choix** : (a) les événements d'alerte d'`inventory` sont datés de l'horloge du serveur au moment où le fait est appliqué ; le jour métier de la charge utile reste celui du fait (perte du jour, négatif du jour) ; (b) date du fait ; (c) date de réception de la commande.
- **Recommandation** : (a).
- **Impact** : `inventory` (`RecordMoveDeps.clock` facultatif, repli sur l'horloge du serveur). Défaut implémenté : (a). Non paramétrable. Les alertes de `sales` et de `finance` livrées en P9-07 gardent la date du fait (gravités WARNING et INFO, sans escalade).

### AV-408 — `TRANSFER_NOT_RECEIVED` : délai, site et destinataires — SECONDAIRE
- **Question** : Depuis quand compte-t-on les 48 h, à quel site rattache-t-on l'alerte et qui est prévenu ?
- **Pourquoi** : D13 §7.1 dit « expédié non reçu depuis plus de 48 h », destinataires « expéditeur, destinataire ». Un transfert expédié hors ligne porte l'heure du départ ; l'action est la réception, au site du destinataire. **DÉDUIT**.
- **Choix** : (a) depuis l'expédition (`dispatched_at`), transferts `STANDARD` à l'état `DISPATCHED` seulement, délai `inventory.transfer_not_received_hours` lu au site de l'expéditeur puis global (repli 48 h) ; alerte rattachée au site de l'emplacement destinataire ; propriétaires : l'expéditeur et, pour un emplacement en garde exclusive d'un utilisateur, ce gardien ; passe quotidienne 06:30 ; les commandes de réception, d'annulation, de refus et de retour résolvent aussitôt, ainsi que le rapprochement d'une réception sans document avec l'expédition (événement `TransferMatchedByBlindReceipt`, publié sous l'identifiant de l'expédition aux deux chemins de rapprochement), le marqueur ferme le reste ; (b) depuis la création ; (c) passe horaire.
- **Recommandation** : (a).
- **Impact** : `inventory` (`inventory.alerts.transfer_not_received_check`). Défaut implémenté : (a). Paramétrable : `inventory.transfer_not_received_hours`.

### AV-409 — `LEDGER_MISMATCH` : sujet, site et réussite de la tâche — IMPORTANTE
- **Question** : Comment sujet-t-on un écart du registre qui ne se rattache à aucun site, et la tâche de réconciliation échoue-t-elle encore ?
- **Pourquoi** : Une tâche qui échoue annule ses écritures : l'événement n'aurait jamais existé (même raisonnement qu'AV-398). La conservation d'un produit (INV-STK-03) porte sur tous les emplacements, virtuels compris. **DÉDUIT**.
- **Choix** : (a) un événement par site et par jour métier (clé `site_key` du sujet : le site, ou `GLOBAL` sans site, alerte sans site vue des portées globales), un échantillon borné par catégorie dans la charge utile, le journal garde les compteurs et, par site, le même échantillon, la tâche se termine en succès ; une anomalie qui persiste lève **une nouvelle alerte chaque jour métier** (le sujet est site × jour, comme AV-398 pour la trésorerie ; le compteur d'occurrences ne compte que les passes du même jour), une alerte résolue puis une anomalie présente du même jour en crée une nouvelle (AV-354) ; (b) un événement global unique ; (c) la tâche échoue toujours.
- **Recommandation** : (a).
- **Impact** : `inventory` (`inventory.ledger.reconcile_daily`), catalogue (sujet `site_key` × jour). Défaut implémenté : (a). Non paramétrable. Un superviseur qui surveillait `platform_jobs.last_error` ne voit plus l'écart : l'alerte est le signal (AT-047).

### AV-410 — Résolution de `TRANSFER_UNMATCHED`, `ALLOCATION_EXPIRED` et `ALLOCATION_REVOCATION_PENDING` — SECONDAIRE
- **Question** : Quel événement ferme chacune de ces alertes, et la tâche d'échéance garde-t-elle sa déduplication « par jour » ?
- **Pourquoi** : Le catalogue de P9-03 fermait `TRANSFER_UNMATCHED` par `inventory.transfer.return_to_source`, qui porte l'identifiant de l'expédition alors que le sujet est la réception : jamais de correspondance. La levée du blocage d'un appareil ou la réactivation d'un utilisateur ne publiait rien : l'alerte restait ouverte. Un événement d'échéance dédupliqué par jour est incompatible avec une passe à identité (ADR-061 §3). **DÉDUIT**.
- **Choix** : (a) `BlindReceiptMatched`, publié au rapprochement tardif sous l'identifiant de la réception, ferme `TRANSFER_UNMATCHED` ; `AllocationRevocationCleared`, publié à la levée du signal, ferme la révocation en attente ; `inventory.allocations.expiry_daily` publie des passes à identité (quotas échus, puis filet des révocations en attente) avec leurs marqueurs, sans déduplication par jour (le rejeu du même créneau est reconnu) ; (b) fermeture manuelle seulement ; (c) conserver la déduplication par jour.
- **Recommandation** : (a).
- **Impact** : `inventory` (`transfer-matching`, consommateur `inventory.allocation_revocation`, tâche d'échéance), catalogue, tests de P5. Défaut implémenté : (a). Non paramétrable.

### AV-411 — `HIGH_MORTALITY` : effectif de référence, sujet, cadence et couverture — IMPORTANTE
- **Question** : Sur quel effectif se calcule le taux journalier, l'alerte est-elle un sujet par lot ou par lot et par jour, à quelle cadence publie-t-on, et que devient la mortalité déclarée par l'autre voie ?
- **Pourquoi** : D13 §7.1 dit « mortalité journalière > 0,5 % de l'effectif ou > 20 têtes », AV-121 « cumul du jour » ; aucun document ne désigne l'effectif. La mortalité de production **est** la déclaration de perte `MORTALITE` (la mortalité n'existe qu'une fois) : elle est un fait de stock à la saisie, la décision de validation ne change pas le fait. Le catalogue de P9-03 donnait un sujet « lot » (une alerte non résolue absorbe les jours suivants sans nouvelle notification), alors que D13 parle d'une mortalité **journalière**. **DÉDUIT**.
- **Choix** : (a) à chaque `production.mortality.record`, dans la transaction de la commande (jamais en échec : le fait est accompli) : cumul des morts du jour métier **du fait** du lot, validées et en attente de validation ; effectif de référence = effectif en élevage au début du jour métier (précédent du taux de ponte, AV-116), à défaut (lot mis en place le jour même) l'effectif en fin de journée plus les morts du jour (soit l'effectif avant les morts, quel que soit l'ordre de saisie), à défaut seul le seuil absolu s'applique (taux `null`, champ omis du message) ; seuils `production.high_mortality_alert_pct` et `production.high_mortality_alert_heads` lus au jour du fait, site puis global (repli 0,5 et 20 ; une valeur de site inexploitable — chaîne, `null`, négative — cède au global), comparaisons strictes (la comparaison relative tolère l'erreur des flottants : 77 sur 5 500 est exactement 1,4 %, non une alerte) ; sujet **lot × jour** (`LOT_DAY`) ; un événement par saisie tant que le cumul du jour reste au seuil (le compteur d'occurrences de l'alerte avance, une alerte résolue renaît à la saisie suivante, AV-354) ; événement daté de l'instant serveur (AV-407), jour métier du fait ; la commande est enregistrée en lecture confirmée, le cumul étant lu sous le verrou du lot : deux saisies simultanées ne manquent pas le franchissement ; (b) sujet « lot » seul (catalogue d'origine) ; (c) effectif initial du lot, ou effectif à l'instant de la saisie (instable dès la deuxième saisie du jour).
- **Limites acceptées** : une mortalité déclarée par `inventory.loss.declare` avec `productionLotId` (voie d'API, AV-119 ; l'écran n'offre pas la catégorie) n'est pas couverte : `inventory` ne peut pas appeler `production` et le seuil se lit sur les réglages de `production` ; les mortalités d'un lot d'incubation sont hors champ (sujet « lot de production ») ; un rejet ou un retrait d'une mortalité fait baisser le cumul sans fermer l'alerte (résolution manuelle) ; deux saisies simultanées par la voie d'API peuvent ne pas se voir (aucun verrou de lot).
- **Recommandation** : (a).
- **Impact** : `production` (`daily-commands.ts`, `production-alert-events.ts`), domaine (`production-alerts.ts`), catalogue d'alertes (sujet `LOT_DAY`, champ « Jour »). Défaut implémenté : (a). Paramétrable : les deux seuils d'AV-121.

### AV-412 — `DAILY_ENTRY_MISSING` : saisie du jour, lots examinés, jours et résolution — IMPORTANTE
- **Question** : Qu'est-ce qu'une « saisie du jour » (aucun en-tête n'existe, BR-PRD-008), quels lots doivent en avoir une, quels jours, et comment l'alerte se ferme-t-elle ?
- **Pourquoi** : D13 §7.1 dit « lot actif sans saisie du jour la veille », planifiée à 10:00 ; D07 liste des commandes indépendantes (mortalité, intrant, pesée, observation, et la collecte d'œufs) sans en faire un agrégat. Aucun calendrier de jours de repos n'existe. Le résolveur du catalogue (`production.daily.record`) est un code de permission, jamais un type d'événement : il ne se déclenchait jamais. **DÉDUIT**.
- **Choix** : (a) un lot est « sans saisie » un jour métier si aucun de ces faits **datés de ce jour** n'existe : mortalité comptée ou en attente, consommation d'intrant enregistrée, pesée non annulée, observation (dont « RAS », AV-117), collecte d'œufs non annulée ; lots examinés : `ACTIVE` ou `SELLING`, mis en place **avant** le jour examiné (jour de la première entrée de lot non annulée — `start_date` ne recule jamais et n'est pas lu ; le jour de la mise en place compte une entrée de lot, non une saisie), avec des animaux en élevage à la fin du jour (un lot en vente vidé par les ventes n'a rien à saisir) ; jour examiné : la veille du créneau planifié (un rattrapage examine la veille du créneau manqué) ; tous les jours de la semaine par défaut, `production.daily_entry_working_days` (numéros ISO) restreint ; un jour non attendu ne publie rien, pas même le marqueur ; une alerte d'état **par lot** (elle porte le dernier jour manquant, les occurrences comptent les passes) ; l'alerte se ferme (marqueur) à la première passe dont le jour examiné a une saisie pour le lot ; une saisie rétroactive d'un jour **déjà examiné** n'est jamais relue (l'alerte d'état porte le dernier jour manquant et suit l'activité du lot, comme `INACTIVE_COMMERCIAL`, AV-394) ; le résolveur mort est retiré du catalogue ; (b) examiner les trois derniers jours (fenêtre de l'antidatage de 72 h, AV-078, non appliquée par le serveur) ; (c) compter la mise en place du lot comme saisie.
- **Recommandation** : (a).
- **Impact** : `production` (`production.lots.daily_entry_check`, module de tâches `ProductionJobsModule`, graphe worker), domaine, graine `production.daily_entry_working_days`, catalogue (résolveur retiré). Défaut implémenté : (a). Paramétrable : jours attendus.

### AV-413 — `STANDARD_COST_MISSING` : entrées revues, fenêtre et résolution — SECONDAIRE
- **Question** : Quelles entrées de production signalent un coût standard manquant, sur quelle fenêtre, et quand l'alerte se ferme-t-elle ?
- **Pourquoi** : D13 §7.1 et AV-124 (tranché) : « production entrée en stock (collecte, naissance) d'un produit sans coût standard à la date de l'entrée », alerte à l'administrateur, résolue à la définition du coût. Aucun drapeau n'est stocké sur les entrées (un coût standard de 0 XAF est valide) ; le coût manquant ne se déduit que par relecture. Tester « la date de l'entrée » ferait renaître chaque nuit l'alerte d'un coût défini après coup (une version datée d'aujourd'hui ne couvre pas l'entrée d'hier). **DÉDUIT**.
- **Choix** : (a) passe quotidienne à 07:45 ; entrées revues : calibres et œufs à couver des collectes non annulées, naissances de porcelets non annulées (les deux seules valorisations au coût standard) des `production.standard_cost_alert_lookback_days` derniers jours (30) ; la condition est « aucun coût standard défini **à l'instant de la passe** » (les versions ne font que s'ajouter) ; un événement par produit (sujet : le produit) portant le dernier jour d'entrée ; `catalog.product_standard_cost.set` publie `StandardCostSet` (résolution immédiate), le marqueur ferme le reste (produit sorti de la fenêtre, entrée annulée) ; les entrées déjà valorisées sans coût standard ne sont pas revalorisées (ADR-027 : l'écart reste dans le résultat du lot producteur) ; (b) alerte sur chaque entrée au moment de la production ; (c) fenêtre illimitée.
- **Limites** : la fenêtre est « aujourd'hui − N jours » à « aujourd'hui » **inclus** (31 jours métier pour 30) et plafonnée à dix ans ; `StandardCostSet` est daté de l'instant serveur (un événement de résolution ne précède jamais la détection) ; une commande de coût validée juste après l'instantané de la passe quotidienne laisse l'alerte ouverte jusqu'à la passe suivante (24 h au plus, même classe de course qu'AV-355) ; l'écran d'action n'a pas de formulaire de coût (voir Impact).
- **Recommandation** : (a).
- **Impact** : `production` (`production.products.standard_cost_check`), `catalog` (`catalog.product_standard_cost.set` : un événement par version de coût, injection du générateur d'identifiants du registrar), graine `production.standard_cost_alert_lookback_days`. Défaut implémenté : (a). Paramétrable : la fenêtre. Hors serveur : l'écran de coût standard n'existe pas encore dans la PWA (ECR-PRX-01 ne contient pas de formulaire de coût) ; l'administrateur n'agit que par l'API.

### AV-414 — `RECEIPT_INCOMPLETE` : condition, bornes, cadence et résolution — IMPORTANTE
- **Question** : Que signifie exactement « incomplet » (BR-APP-015), à quelle borne, quand le détecte-t-on et qu'est-ce qui ferme l'alerte ?
- **Pourquoi** : BR-APP-015 : « bon de commande dont la date prévue est dépassée de plus de 2 jours avec un reliquat, ou réception comportant une quantité rejetée » ; D13 : « planifiée + sur réception », résolue à reliquat nul ou clôturé. Le rejeté n'est pas retranché du reliquat (accepté = livré − rejeté) ; la date prévue est facultative sur un bon ; les quantités de produits d'unités différentes ne s'additionnent pas. **CONFIRMÉ** (règle) / **DÉDUIT** (bornes, cadence).
- **Choix** : (a) un bon `SENT` ou `PARTIALLY_RECEIVED` est incomplet s'il a un **reliquat** (commandé − accepté − clôturé > 0 sur une ligne non annulée) **et** (sa date prévue est dépassée de **plus de** N jours métier — « plus de 2 jours » est strict : exactement 2 jours n'alerte pas, `0` signifie dès le lendemain — **ou** une quantité rejetée figure sur une réception comptée du bon : comptabilisée, en revue, refusée en revue, en annulation demandée ; une réception annulée, rejetée ou en quarantaine ne compte pas) ; sans date prévue, seul le rejet joue ; la quantité rejetée du message est cumulée sur le bon et omise pour plusieurs unités de base ; une réception sans bon n'a pas de reliquat : hors champ (elle passe par la validation `RECEIPT_WITHOUT_PO`) ; **sur réception** (réception comptabilisée, quarantaine approuvée, annulation de réception) l'état du bon est publié : `ReceiptIncompleteDetected` ou `ReceiptIncompleteCleared` ; passe quotidienne `procurement.orders.receipt_incomplete_check` à 07:15 (après le changement de jour de Douala) qui évalue la même condition sur tous les bons ouverts, avec son marqueur ; l'alerte est fermée par `ReceiptIncompleteCleared`, l'annulation du bon, la clôture du reliquat (`procurement.order.close_remaining`) ou le marqueur ; (b) délai compté depuis la dernière réception ; (c) rejet seul.
- **Limites** : un bon reçu en entier (`RECEIVED`), clôturé ou annulé n'est jamais signalé (« reliquat nul ou clôturé ») ; `procurement.receipt.record` est enregistrée en **lecture confirmée** (l'état du bon est relu après son verrou, qui sérialise les réceptions d'un même bon) et les lignes du bon sont relues `FOR UPDATE` (lecture courante) ; les **décisions** de validation (quarantaine approuvée, annulation de réception), exécutées dans la transaction de la commande d'approbation, lisent le rejeté cumulé sous l'instantané de cette transaction : une réception du même bon validée entre-temps peut y être ignorée jusqu'à la passe de 07:15 (verrouiller les réceptions voisines en lecture inverserait l'ordre de verrouillage d'ADR-038) ; la réception annulée est retirée du rejeté cumulé au moment de son annulation ; une alerte levée sur réception est reconduite par la passe du lendemain tant que la condition tient (le compteur d'occurrences compte les passes) ; la course passe / réception est celle d'AV-355.
- **Recommandation** : (a).
- **Impact** : `procurement` (`receipt-alert-events.ts`, `receipt-commands.ts#applyToOrder`, `ReceiptIncompleteJob`), domaine (`procurement-alerts.ts`), catalogue (résolveurs). Défaut implémenté : (a). Paramétrable : `procurement.receipt_incomplete_alert_days`.

### AV-415 — Réception en quarantaine : `DUPLICATE_SUSPECTED` et sa fermeture — SECONDAIRE
- **Question** : Quelles quarantaines lèvent l'alerte de doublon, et quel événement la ferme ?
- **Pourquoi** : le catalogue de P9-03 attendait `GoodsReceiptQuarantined` (jamais publié) et n'avait aucun résolveur pour la réception : la décision sur la quarantaine ne publiait rien. Les raisons de la quarantaine ne sont pas stockées en colonne (texte du résumé de la demande). **DÉDUIT**.
- **Choix** : (a) `GoodsReceiptQuarantined`, dans la transaction de la réception, pour toute quarantaine (doublon du bon de livraison, dépassement hors ligne, bon non réceptionnable hors ligne ; AV-095 les justifie toutes par le risque de double saisie) avec la liste de ses raisons, un libellé du motif (`reason_label`, champ « Motif » du message), l'objet « Réception » et la référence ; `GoodsReceiptQuarantineDecided` (sujet : la réception) à la décision de validation, approuvée ou rejetée, qui ferme l'alerte ; (b) doublon du bon de livraison seulement ; (c) fermeture manuelle seulement.
- **Limites** : le demandeur peut retirer la demande de validation (`approvals.request.withdraw`, aucune garde pour `RECEIPT_QUARANTINE`) : la réception reste en quarantaine sans demande vivante et l'alerte reste ouverte jusqu'à sa fermeture manuelle ; la garde de retrait est une décision d'`approvals`/`procurement` à part.
- **Recommandation** : (a).
- **Impact** : `procurement` (`receipt-commands.ts`, `receipt-alert-events.ts`), catalogue (`DUPLICATE_SUSPECTED.resolvedBy`). Défaut implémenté : (a). Non paramétrable.

### AV-416 — `APPROVAL_PENDING_LONG` : référence du délai, cadence, `escalated_at` — IMPORTANTE
- **Question** : Depuis quand se compte l'attente, à quelle cadence détecte-t-on, qui écrit `escalated_at` et quand, et que fait-on des types d'opération qui ont déjà leur alerte ?
- **Pourquoi** : D13 : « en attente depuis plus de 24 h », approbateurs et niveau supérieur ; SM-APPROVAL : « délai de 24 h dépassé → escaladée ». `requested_at` est la date de l'appareil (une saisie hors ligne ancienne alerterait dès sa synchronisation) ; `created_at` est la réception par le serveur (AV-399). La file de validation de l'utilisateur (`pendingApprovalsFor`) est jugée par utilisateur et plafonnée : inutilisable par un détecteur. **DÉDUIT**.
- **Choix** : (a) `approvals.requests.pending_long_check` toutes les heures ; demande `PENDING` dont la réception par le serveur remonte à `approvals.pending_long_hours` heures ou plus (borne comprise, repli 24) ; un événement par demande en retard, **y compris** celles déjà escaladées (le marqueur fermerait leur alerte sinon) ; charge utile : permission et portée de la politique (jointure externe : la politique est facultative), demandeur, site, zone, libellé du type — jamais le résumé ni le montant (valeurs au coût possibles, RC-05) ; destinataires : titulaires de la permission dans le périmètre du demandeur, demandeur exclu (ADR-062), et Direction par la règle ; `escalated_at` posé **une fois**, par `approvals` seul, au premier constat (jamais remis à `NULL`, conservé si le délai est relevé) ; chaque demande en retard est verrouillée par clé primaire `FOR UPDATE SKIP LOCKED` (aucune promotion de verrou, aucun verrou sur les politiques ni sur des plages) : une demande tenue par une décision en cours est sautée et la passe, devenue **partielle**, ne publie **pas** son marqueur (une passe partielle ne résout rien) ; aucun type d'opération exclu (la même situation peut produire `CASH_VARIANCE` ou `INVENTORY_VARIANCE` **et** cette alerte après 24 h : D13 littéral) ; la décision par une façade d'un module propriétaire ne publie aucun événement qui désigne la demande : le marqueur ferme l'alerte au plus une heure plus tard (de même pour un retrait ou une annulation faits par le module propriétaire, qui n'appelle pas la commande `approvals.request.*`) ; `escalated` de la charge utile signifie « déjà escaladée avant cette passe » ; (b) cadence quotidienne (levée et fermeture retardées jusqu'à 24 h) ; (c) délai compté depuis `requested_at`.
- **Limites** : la détection « sans approbateur » (D01 §14, AV-358) reste différée jusqu'à la lecture inverse d'`identity` (B1) ; les notifications directes `ApprovalRequested`, `ApprovalGranted`, `ApprovalRejected` sont livrées par P9-11 (AV-389), qui pourra aussi les déclarer résolveurs.
- **Recommandation** : (a).
- **Impact** : `approvals` (`ApprovalPendingLongJob`, module de tâches), domaine (`approval-alerts.ts`, libellés). Défaut implémenté : (a). Paramétrable : `approvals.pending_long_hours`.

### AV-417 — `ATTACHMENT_MISSING` des réceptions : exigence, présence et portée — SECONDAIRE
- **Question** : Quelle réception « doit » une photo, qu'est-ce qu'une photo « reçue », et comment cette part de l'alerte se distingue-t-elle de celle des dépenses ?
- **Pourquoi** : BR-APP-014 : photo du bon de livraison exigée sans bon de commande ou à partir d'une valeur (100 000 XAF, AV-037) ; AV-246 / MP-04 : la réception sans photo est appliquée avec un conflit, jamais refusée ; la photo **déclarée** mais jamais reçue ne laisse aucun conflit (c'est le cas visé) ; AV-357 (a) : le module qui exige la pièce publie, sans modifier `attachments`. L'exigence n'est pas mémorisée. **DÉDUIT**.
- **Choix** : (a) `procurement.receipts.attachment_missing_check` à 06:15, passe à identité de **portée `GOODS_RECEIPT`** (le marqueur d'une portée ne ferme que les alertes de sa portée) ; exigence recalculée par `receiptPhotoRequired` (valeur acceptée ≥ seuil lu à la date de la réception, historisé ; ou sans bon) ; présence : une pièce `AVAILABLE` de nature `DELIVERY_NOTE` rattachée à la réception (même critère que la régularisation du conflit) ; délai depuis la réception par le serveur (`attachments.missing_alert_days`, 7 ; `0` désactive et ferme), horizon `attachments.missing_alert_horizon_days` (90) ; réceptions examinées : comptabilisées, en revue, en quarantaine, en annulation demandée ; destinataires : l'auteur et son responsable (D13), repli Direction ; (b) auteur de la pièce contrôlé (suppose `OwnedAttachment.createdBy`, tenu par la session principale, et un droit évalué par `identity`) ; (c) toute nature de pièce.
- **Limites** : l'auteur de la pièce n'est pas contrôlé (la pièce d'un tiers sans droit ferme l'alerte alors que le conflit `RECEIPT_PHOTO_MISSING` reste ouvert) ; un conflit fermé à la main par le Resp. achats ne ferme pas l'alerte (elle dure jusqu'à l'horizon) ; la fermeture après arrivée de la pièce ou annulation de la réception a lieu à la passe suivante (au plus 24 h) ; toute réception exigeant une photo et enregistrée sans photo reçue alerte à J+7 (au plus 90 jours après sa réception par le serveur), y compris celles enregistrées entre MP-04 et MP-10 ; le seuil de valeur est lu comme le fait le gestionnaire de réception (`numberSetting` : nombre ou chaîne numérique) ; délai et horizon sont plafonnés à dix ans ; `SM-ATTACHMENT` prévoit le passage à `MISSING` (jamais posé, AV-290) : non utilisé.
- **Recommandation** : (a).
- **Impact** : `procurement` (`ReceiptAttachmentMissingJob`), domaine (`attachment-alerts.ts`, fenêtre partagée avec `finance`), catalogue (paramètre cité). Défaut implémenté : (a). Paramétrable : délai et horizon (déjà semés), seuil de valeur.

### AV-418 — `CHECKIN_SUSPICIOUS` : tentatives, sujet, destinataires et date — SECONDAIRE
- **Question** : Quelles tentatives de pointage lèvent l'alerte, à quelle maille, vers qui et à quelle date ?
- **Pourquoi** : BR-TER-010 calcule des signaux (limite L-02 : signaler, ne jamais bloquer) et les range dans `suspicion_flags` du pointage ; rien ne les publiait. Trois refus avant dérogation peuvent chacun en porter un. D13 : Resp. commercial, résolution manuelle ; le catalogue désigne aussi l'agent (propriétaire) et son responsable d'équipe. **DÉDUIT**.
- **Choix** : (a) `CheckInSuspicious` publié dans la transaction de `fieldwork.checkin.record`, **après** l'écriture du pointage (un rejet n'annule alors rien) : toute tentative portant au moins un des quatre signaux, quels que soient son type (prise ou fin de service) et son résultat serveur (accepté, refusé, zone inactive) ; sujet = le pointage (agrégat `GEO_CHECKIN`), donc une alerte par pointage (une commande n'est appliquée qu'une fois) ; destinataires : responsable commercial de la zone déclarée ou de l'équipe, agent propriétaire de l'alerte (lecture `OWN`) et son responsable d'équipe ; datée de l'application par le serveur (extension d'AV-407 : un pointage appliqué tard après une synchronisation se lève à son application, en tête de la liste), le jour métier et l'instant du fait restant dans la charge utile ; charge utile : libellés français des signaux (« Précision GPS nulle »…), codes, distance au centre du géorepère arrondie, précision, session, type et résultat — **jamais latitude ni longitude** (la charge est conservée en entier avec l'alerte, ADR-061 §4) ; aucun rattrapage des pointages d'avant P9-10 ; (b) une alerte par agent et par jour (sujet composite) ; (c) prises acceptées seulement.
- **Limites** : les signaux restent ceux de BR-TER-010 sur les **pointages** (les positions des visites et des ventes terrain appartiennent à `crm` et `sales`, D03 §15) ; ils sont figés à l'application (un pointage intermédiaire arrivé tard n'altère pas ceux de son successeur) ; `distance_m` est la distance au centre du géorepère, non la distance parcourue du signal de vitesse ; prévenir un agent que son pointage est jugé suspect est une décision métier à confirmer (le catalogue le prévoit) ; la décision d'une dérogation ne ferme pas l'alerte (résolution manuelle, `dismiss` admis) ; **une alerte par pointage, sans plafond ni regroupement** : un client mobile défaillant (précision à zéro répétée) en crée autant que de pointages, chacune à résoudre à la main et notifiée (le choix (b), une alerte par agent et par jour, reste ouvert si la volumétrie le justifie) ; l'agent propriétaire est prévenu de l'alerte de son propre pointage (documenté ci-dessus, décision métier à confirmer).
- **Recommandation** : (a).
- **Impact** : `fieldwork` (`fieldwork-alert-events.ts`, `checkin-commands.ts`), domaine (`checkinSuspicionLabel`), catalogue (les deux réglages de BR-TER-010 sont cités). Défaut implémenté : (a). Paramétrable : `fieldwork.suspicion_max_speed_kmh`, `fieldwork.suspicion_repeated_accuracy_count`.

### AV-419 — `DUPLICATE_SUSPECTED` d'un compte client : sujet, charge utile et fermeture — SECONDAIRE
- **Question** : Quel compte est le sujet de l'alerte de doublon, que contient-elle, qui la reçoit et qu'est-ce qui la ferme ?
- **Pourquoi** : le catalogue déclarait déjà le déclencheur `CustomerDuplicateSuspected` pour le responsable commercial, mais rien ne le publiait, et la fusion (BR-CRM-007) n'avait aucun événement. Seul le doublon créé **hors ligne** existe comme fait (BR-CRM-006 : en ligne, la création est refusée et rien n'est enregistré). Le type d'alerte est partagé avec les encaissements (P9-07) et les réceptions (P9-09), dont les clés ne doivent pas se heurter. **DÉDUIT**.
- **Choix** : (a) `CustomerDuplicateSuspected` publié dans `crm.customer.create` après le conflit informatif `DUPLICATE_CUSTOMER` (jamais un rejet) ; sujet = le **nouveau** compte, porteur de `duplicate_of_id` (jamais le compte d'origine ni la paire : deux doublons d'un même compte ont chacun leur alerte) ; objet « Compte client », référence = le nom du nouveau compte (aucun code client n'existe), motif « Même numéro de téléphone principal » ; **ni le téléphone ni le nom du compte d'origine** dans la charge utile (conservée en entier, RC-07) ; titulaire (`owner_user_id`), site de rattachement et zone portés pour les destinataires (le type déclare désormais le titulaire comme propriétaire et le responsable d'équipe : neutre pour les encaissements et les réceptions, dont la charge n'a pas ce champ) ; date du fait, comme `PaymentFlaggedDuplicate` (même type, WARNING sans escalade) ; fermeture : `CustomerDuplicateResolved`, publié par `crm.customer.merge` pour le compte **absorbé** qui portait un `duplicate_of_id` et pour le compte **conservé** dont le `duplicate_of_id` désignait l'absorbé (variante d'AT-012) ; (b) un événement par paire ; (c) alerte au conflit `DUPLICATE_CUSTOMER` seul.
- **Limites** : la décision du conflit par `sync.conflict.dismiss` ou `.resolve` ne ferme **pas** l'alerte (l'agrégat de `SyncConflictResolved` est le conflit, non le compte) : l'alerte se traite par `communication.alert.resolve` ou `.dismiss` ; les autres comptes repointés vers le compte conservé gardent leur alerte ; l'import CSV (AV-072) et Kommo (P10) devront appeler le même signal ; le nom d'un compte est une donnée personnelle minimale, conservée avec l'alerte (`communication.alert_retention_days`, 730 jours) et visible de **tout lecteur d'alertes de sa portée**, qu'il détienne ou non la lecture des clients, non des seuls destinataires ; l'alerte est datée du **fait** (date déclarée par l'appareil, comme `PaymentFlaggedDuplicate`), contrairement au pointage daté de l'application par le serveur (AV-418) : une création synchronisée tard porte la date de sa saisie et une horloge d'appareil décalée une date décalée (le jour métier de la charge en dérive) ; unifier la datation des alertes sur fait entre producteurs d'un même type est une décision à prendre (extension d'AV-407), non tranchée ici.
- **Recommandation** : (a).
- **Impact** : `crm` (`customer-alert-events.ts`, `crm.customer.create`, `crm.customer.merge`), catalogue (`ownerFields`, `teamManager`, résolveur). Défaut implémenté : (a). Non paramétrable.

### AV-420 — `AUDIT_CHAIN_BROKEN` : fenêtre, partition, heure et récurrence — IMPORTANTE
- **Question** : Sur quelle fenêtre vérifie-t-on la chaîne, que désigne la « partition », à quelle heure, et que devient la tâche quand la chaîne est rompue ?
- **Pourquoi** : `audit.chain.verify_daily` existait sans récurrence et **levait** à la rupture : le point de sauvegarde du `JobRunner` annulait tout ce qu'elle écrivait puis la reprenait (ADR-061 §3) ; aucun événement ni alerte. Sa fenêtre « du jour » laissait sans contrôle les entrées écrites après la dernière exécution. Aucune partition physique n'existe (ADR-023, RISK-27). **DÉDUIT**.
- **Choix** : (a) exécutée chaque jour à **03:00** (heure de Douala, après le registre de stock et la trésorerie) sur le jour métier **précédent le créneau planifié** et la suite (du début de ce jour jusqu'à la dernière entrée) : toute entrée est vérifiée par au moins une exécution tant qu'aucun créneau n'est perdu, et après un arrêt du worker (l'ordonnanceur fusionne les créneaux manqués en une tâche dont `scheduledFor` est le plus ancien dû) la fenêtre remonte jusqu'à ce créneau, au plus 31 jours métier ; à la rupture, la tâche publie `AuditChainBroken` (partition, position, cause, bornes de la fenêtre) puis **se termine en succès** et consigne l'erreur au journal ; identité de passe = le créneau (le rejeu ne publie pas deux fois) ; la plage est **lue par pages** de 2 000 lignes de clé `seq` en reportant la dernière empreinte (jamais chargée en entier : la fenêtre double avec le jour précédent), et son début est le plus petit `seq` écrit à partir de la date de début, par une requête **exacte** sans hypothèse sur l'ordre des dates d'écriture (une horloge d'application qui recule ne vide ni ne tronque la fenêtre), que MySQL 8 sert par un saut d'index sur `ix_audit_audit_log_site (site_id, recorded_at)` : 20 ms pour 4 000 lignes sur 40 000 mesurées ; sans rupture, rien n'est publié (alerte d'événement, résolution manuelle : un contrôle réussi ne prouve pas la réparation d'une ligne immuable) ; **partition = mois métier `AAAA-MM`** de l'écriture de la ligne rompue (BR-AUD-008, D12 §14) ; **sujet = partition et position** : un autre mois ou une autre position lève une alerte distincte (deux altérations du même mois ne s'absorbent pas) ; (b) point de reprise persistant (aucune lacune, mais une table et un acquittement pour avancer) ; (c) fenêtre du jour seule, plus la vérification hebdomadaire du mois.
- **Limites** : une rupture plus ancienne que la fenêtre n'est revue que par la vérification hebdomadaire du mois complet (03-audit.md §5), **renvoyée à P9-22** (lecture paginée, isolation des tâches longues) ; une rupture dans la fenêtre de deux exécutions consécutives est publiée deux fois (l'alerte ouverte compte une occurrence de plus, sans renotifier) puis plus jamais alors qu'elle persiste ; l'ancrage externe du dernier hachage n'est pas construit ; avant d'activer la récurrence, la chaîne entière de la base d'essai a été vérifiée une fois en lecture seule (39 198 entrées, intacte) : une fausse alerte critique n'est pas acceptable (une base locale créée avant le correctif UTC du 12/10/2026 contient des heures locales, `db/README.md`) ; l'heure est une constante technique (AV-361) ; la vérification s'arrête à la **première** rupture de la fenêtre : une seconde, à une autre position, n'est rapportée qu'une fois la première sortie de la fenêtre (au plus deux jours après l'écriture de sa ligne) ; une tâche abandonnée (créneau perdu) laisse environ 21 heures d'écritures sans contrôle jusqu'à la vérification complète du mois (P9-22) ; le rattrapage après un arrêt du worker est plafonné à 31 jours métier ; la vérification s'exécute dans la transaction de la tâche : une fenêtre de plusieurs centaines de milliers de lignes l'occupe plusieurs dizaines de secondes (la durée est consignée ; un plafond de lignes ou un point de reprise relèvent de P9-22) ; le saut d'index dépend du plan de MySQL (si un plan l'abandonnait, un index `(recorded_at)` règle le cas, à mesurer en P9-22).
- **Recommandation** : (a).
- **Impact** : `audit` (`chain-verification-job.ts`, `audit-recurring-jobs.ts`, `verification-window.ts`), catalogue (sujet : partition et position). Défaut implémenté : (a). Non paramétrable (planification).

### AV-421 — `SYNC_ERROR` : nature, périmètre, regroupement et codes exclus — SECONDAIRE
- **Question** : Quelles commandes comptent, à quelle maille et avec quelle résolution, alors qu'un rejet est un état terminal sans événement ni conflit ?
- **Pourquoi** : le pipeline n'écrit que la ligne de boîte d'un rejet ; une alerte par commande inonderait pour un appareil défaillant (AV-392). AV-392 (a) annonçait « `dismiss` admis (alerte d'événement pour un rejet) » alors que le catalogue déclare `SYNC_ERROR` d'**état** à résolution automatique et que l'ADR-061 §9 réserve `dismiss` aux alertes d'événement : la contradiction est tranchée côté catalogue. **DÉDUIT**.
- **Choix** : (a) passe horaire `sync.errors.alert_check` (couche `sync`) sur les commandes reçues par `/sync/push` dont l'état est `REJECTED` ou `CONFLICT`, **prononcées** dans les `sync.error_alert_window_hours` dernières heures (24, deux bornes ; la date est celle de la dernière prise en charge, `claimed_at`, réinitialisée à chaque reprise d'une commande retenue, repli : la réception — `received_at` est immuable alors qu'une commande retenue peut être rejetée des jours plus tard) ; un événement `SyncErrorDetected` par couple **appareil × code** (le code détaillé `VALIDATION_ERROR:<raison>` est ramené à sa famille) ; un conflit de gestionnaire, sans code propre, prend le type de son conflit **encore ouvert** (un conflit refermé ne compte plus ; deux conflits de même type sur une commande comptent une fois) et reste signalé **quel que soit son âge** (c'est un état, que son ouverture borne : seule la borne haute, l'instant courant, s'applique) ; codes exclus par défaut `COMMAND_DISCARDED` (décision de l'Admin) et `DEPENDENCY_REJECTED` (conséquence d'un autre rejet), paramétrables (`sync.error_alert_excluded_codes`, liste vide admise) ; propriétaire = l'auteur de la commande la plus récente du couple ; ni message d'erreur ni charge de commande dans l'événement ; marqueur de fin de passe toujours publié, même sans erreur : l'alerte d'un couple qui n'est plus vu se ferme seule (« Auto — conflit résolu », D13) ; l'alerte reste **d'état** : `acknowledge` fait taire, `dismiss` est refusé ; (b) une alerte par commande rejetée ; (c) pas d'alerte, file des conflits seule.
- **Limites** : une seule erreur lève une alerte WARNING (aucun seuil d'occurrences, accepté par AV-392) ; les rejets de `/commands` (transport `ONLINE_API`) sont rendus à l'écran qui les a émis ; `COMMAND_ID_REUSED` (D14 BR-SYN-002 parle d'« alerte de sécurité ») n'écrit rien dans la boîte : non couvert ; une anomalie non traitée disparaît seule après la fenêtre (la trace durable reste la boîte et les conflits, immuables) ; la collision d'un `device_seq` avec une autre commande est rendue `RETRY_LATER` sans fin par le pipeline, sans ligne ni alerte : anomalie voisine, non détectée ; tablette partagée : seul l'auteur du dernier rejet est propriétaire ; la boîte des commandes n'a qu'un index sur l'état (`status`) : la passe lit les lignes rejetées ou en conflit puis filtre la fenêtre sur `COALESCE(claimed_at, received_at)` (aucun index ne la couvre), charge les lignes de la fenêtre une à une et les regroupe en mémoire, suffisant à l'échelle d'un pilote (un index `(status, claimed_at)` et un regroupement en SQL sont à mesurer en P9-22) ; le motif de fermeture automatique est celui de D13 (« conflit résolu ») même quand c'est un rejet qui sort de la fenêtre ; seul le pipeline écrit `claimed_at` : un rejet prononcé par l'Admin (`COMMAND_DISCARDED`, exclu par défaut) garde la date de la dernière prise en charge de la commande, si bien que vider la liste des codes exclus le ferait manquer quand cette date dépasse la fenêtre.
- **Recommandation** : (a).
- **Impact** : `sync` (`SyncErrorAlertJob`, module de tâches), domaine (`sync-alerts.ts`), catalogue (réglage cité), semis (`sync.error_alert_excluded_codes`). Défaut implémenté : (a). Paramétrable : fenêtre, liste de codes.

### AV-422 — `SYNC_STALE` : référence du délai, horizon d'oubli et propriétaire — SECONDAIRE
- **Question** : Depuis quand se compte le silence d'un appareil, que devient un appareil abandonné sans être retiré, et qui est prévenu ?
- **Pourquoi** : D13 : « appareil actif sans synchronisation depuis plus de 24 h ». Le dernier contact (`last_seen_at`) n'est écrit qu'à la connexion : un appareil approuvé tard après son enrôlement serait « en retard » dès la passe suivante, et un appareil de réserve resterait signalé sans fin (aucun drapeau « de réserve » n'existe). `identity_devices` n'a pas de colonne utilisateur. **DÉDUIT**.
- **Choix** : (a) passe horaire `sync.devices.stale_check` sur les appareils **actifs** ; dernier contact = le plus récent de la connexion, du dernier envoi et du dernier pull (fraîcheur des appareils de l'accueil, au seuil de l'alerte et non de l'accueil) ; **référence du délai** = le plus récent du dernier contact et de l'activation de l'appareil ; « plus de » `sync.stale_hours` heures (24, borne exclue) ; **horizon d'oubli** `sync.stale_horizon_days` (30, `0` : aucun) : au-delà, l'appareil est tenu pour abandonné, n'est plus signalé et l'alerte se ferme (l'Admin le retire par `RETIRED`) ; propriétaire = l'utilisateur qui a enrôlé l'appareil (convention MP-06), son responsable d'équipe est aussi destinataire ; site = le site désigné ; une tablette partagée est suivie au niveau de l'appareil ; la charge donne la **dernière synchronisation** (le dernier contact réel, omise d'un appareil jamais contacté : la date de l'activation n'en est pas une) et `silent_since`, le départ du silence, **seulement quand il diffère** de la dernière synchronisation (appareil jamais contacté, ou activé après son dernier contact) ; le message affiche les dates présentes et les heures écoulées depuis le départ du silence ; marqueur toujours publié ; (b) délai compté depuis le dernier contact seul ; (c) aucun horizon.
- **Limites** : BR-SYN-014 (D14) annonce « une alerte est levée après 24 h » pour la session expirée d'un auteur de tablette partagée : aucun type d'alerte ne la porte, elle n'est pas couverte (`SYNC_STALE` reste au niveau de l'appareil) ; un appareil actif sans site désigné n'est visible que des portées `ALL` ; chaque passe lit tous les appareils actifs (quelques dizaines en production) ; la date d'activation est `status_changed_at`, fixée à l'`occurred_at` de la commande d'administration (RC-02, `device-commands.ts`) : un déblocage appliqué tard avec une date ancienne donne une référence ancienne (faux positif immédiat, ou appareil hors horizon donc sans alerte).
- **Recommandation** : (a).
- **Impact** : `sync` (`DeviceStaleAlertJob`), domaine (`deviceStaleness`), semis (`sync.stale_horizon_days`). Défaut implémenté : (a). Paramétrable : délai, horizon.

### AV-423 — `DEVICE_SEQ_GAP` : définition du trou, explication par les restes déclarés et mémoire — IMPORTANTE
- **Question** : Qu'est-ce qu'un trou « non comblé depuis plus de 24 h », comment écarter les commandes seulement en attente, et comment éviter que l'alerte renaisse chaque heure ?
- **Pourquoi** : BR-SYN-003 voit dans un trou un signe de perte de données ou de suppression locale. Sur une tablette partagée, le compteur est commun et les lots sont par auteur : les numéros d'un auteur absent manquent tant qu'il n'a pas rouvert sa session, sans rien de perdu. L'alerte est un événement à résolution manuelle dont la condition (commandes perdues) ne disparaît jamais : sans mémoire, la passe horaire la republierait sans fin. `sync_device_sync_state.known_gaps` existait sans être écrit. **DÉDUIT**.
- **Choix** : (a) passe horaire `sync.devices.seq_gap_check` sur les appareils **actifs** ; **trou** = plage de numéros absente de la boîte (transport `SYNC_PUSH`) entre 1 et le plus grand numéro reçu de l'appareil, **ouvert** depuis la réception de la première commande de numéro supérieur ; il est signalé quand il est ouvert depuis plus de `sync.seq_gap_alert_hours` heures (24, borne exclue) ; **explication** : si les restes déclarés de l'appareil (`pending_reported`, total de ses auteurs) couvrent **tous** les numéros manquants, ce sont des commandes encore dans l'outbox et rien n'est signalé ; sans déclaration, rien n'est supposé ; **un événement par appareil et par passe** (première plage nouvelle, total, plages nouvelles) ; **mémoire** : les plages signalées sont écrites dans `known_gaps` (paires `[début, fin]`, ligne `_device`) : une plage **contenue** dans une plage déjà signalée (réduite ou scindée par l'arrivée d'une commande tardive) n'est pas nouvelle, une plage nouvelle ou plus large l'est ; la mémoire garde une plage tant qu'un de ses numéros manque, **que son âge ou l'explication par les restes déclarés la rende visible ou non** (des restes qui oscillent ne font pas renaître l'alerte d'une plage déjà traitée) ; elle s'efface quand tous les numéros sont arrivés (effacement par clé primaire, sans verrou sur la table que les envois écrivent) ; détection en deux temps (agrégat sur l'index unique, fenêtre SQL limitée aux appareils incomplets **en service**) ; la passe rend `incomplete` (appareils à trou, en service ou non) et `examined` (ceux dont les plages sont relues) ; aucun marqueur (alerte d'événement) ; (b) sujet composite appareil × plage ; (c) alerte dès le trou, sans délai ni explication.
- **Limites** : un refus d'auteur (`FORBIDDEN` avant l'écriture de la boîte) laisse un trou définitif : cas voulu, signe de falsification ; une commande perdue alors que d'autres restent en attente est masquée par l'explication tant que les restes couvrent le total (le comptage ne dit pas laquelle manque) ; la suite d'un appareil dont le stockage local est vidé repart de 1 (collision `RETRY_LATER`, voir AV-421) ; un appareil bloqué, perdu ou retiré n'est pas examiné (sa mémoire de plages est conservée) ; l'alerte critique monte à la Direction au bout de 4 h (BR-NOT-005) : une fausse alerte est coûteuse, d'où l'explication par les restes ; les restes déclarés par l'appareil ne sont recoupés par rien : un appareil dont le stockage est tronqué ou falsifié peut déclarer un grand nombre et masquer tout trou (le signe de falsification visé), et la dernière déclaration d'un appareil devenu muet explique encore le trou jusqu'à l'horizon de `SYNC_STALE` ; le coût n'est pas borné dans le temps : l'agrégat parcourt l'index unique entier chaque heure et la fenêtre relit tous les numéros de chaque appareil actif incomplet, y compris celui dont le trou est définitif (refus avant l'écriture de la boîte) — à mesurer en P9-22 (reprise par le dernier numéro examiné).
- **Recommandation** : (a).
- **Impact** : `sync` (`DeviceSeqGapAlertJob`), domaine (`sync-alerts.ts`), catalogue (réglage cité), semis (`sync.seq_gap_alert_hours`), dictionnaire (`known_gaps` écrit). Défaut implémenté : (a). Paramétrable : délai.

### AV-424 — `CLOCK_SKEW` : passe horaire plutôt que publication à l'envoi — SECONDAIRE
- **Question** : L'alerte d'horloge se lève-t-elle à l'envoi (D13 : « sur synchronisation ») ou par une passe, et sur quel écart ?
- **Pourquoi** : `/sync/push` n'ouvre pas de transaction sur son chemin chaud (l'état de l'appareil s'écrit hors transaction), un événement exige une transaction, et une alerte d'état exige un événement de fin (« horloge remise à l'heure ») qui n'existe pas. L'écart du dernier lot est conservé (`last_clock_skew_ms`, écrasé à chaque envoi). **DÉDUIT**.
- **Choix** : (a) passe horaire `sync.devices.clock_skew_check` : appareils **actifs** dont le dernier envoi date des `sync.stale_hours` dernières heures (24, deux bornes) et dont le dernier écart dépasse **strictement** `sync.clock_skew_flag_minutes` (5, lu à l'instant de la passe, comme à la réception du lot) ; événement `ClockSkewDetected` ; écart **signé** en minutes (heure du serveur moins celle de l'appareil : positif, l'appareil est en retard), arrondi à la minute **supérieure** en valeur absolue (5 min 0,4 s au seuil de 5 min s'affiche 6 min, non 5), le seuil étant publié tel que réglé (minutes fractionnaires admises) ; propriétaire = l'auteur du dernier envoi ; marqueur toujours publié : un appareil remis à l'heure (son envoi suivant est dans la tolérance), silencieux depuis plus de 24 h (`SYNC_STALE` prend le relais) ou bloqué voit son alerte se fermer ; (b) publication dans `/sync/push` avec un événement de fin ; (c) dérivée du drapeau `clock_suspect` des commandes de la fenêtre.
- **Limites** : l'écart est celui du **dernier** lot (un lot entièrement `RETRY_LATER` l'écrase aussi) ; l'alerte peut être levée sans qu'une commande de la fenêtre porte `clock_suspect` si le réglage a changé entre-temps (deux seuils, à deux instants) ; l'écart est borné à ±24,8 jours (AV-227), soit 35 792 minutes au plus ; l'écart n'est réécrit que par un envoi de commandes : un appareil remis à l'heure qui n'envoie plus rien garde l'alerte jusqu'à son prochain envoi ou jusqu'à la sortie de la fenêtre ; cette fenêtre est le réglage de `SYNC_STALE` (`sync.stale_hours`) : le modifier change aussi la durée pendant laquelle l'alerte d'horloge d'un appareil muet reste ouverte (un réglage dédié est possible).
- **Recommandation** : (a).
- **Impact** : `sync` (`DeviceClockSkewAlertJob`), domaine (`clockSkewMinutes`), catalogue (réglage cité), D13 §7.1 (détection « planifiée »). Défaut implémenté : (a). Paramétrable : seuil, fenêtre.

### AV-425 — `CONSUMER_FAILED` : consommateurs surveillés, condition, fenêtre et supervision indépendante — SECONDAIRE
- **Question** : Quels consommateurs sont surveillés, à quelle condition l'alerte se lève et se ferme, et comment la déceler quand le consommateur d'alertes lui-même est en défaut ?
- **Pourquoi** : AV-362 prévoyait « un par consommateur et par jour métier, résolu sur le retard » ; le catalogue (sujet = nom du consommateur, alerte d'état à résolution automatique) est plus précis, et un saut ne laisse aucun retard (la position avance) : « résolu sur le retard » fermerait aussitôt l'alerte d'un événement perdu. Le runner consigne un saut puis avance la position par **deux instructions successives**, non une seule transaction (un arrêt entre les deux rejoue l'événement et le saut déjà consigné est absorbé par l'unicité consommateur × numéro). L'alerte est un événement de la file que `communication.alerts` vide lui-même. **CONFIRMÉ** (code) / **DÉDUIT**.
- **Choix** : (a) passe `communication.consumers.failure_check` toutes les cinq minutes sur **toutes** les positions de `platform_event_consumer_offsets`, quel que soit le processus qui les draine : un événement `ConsumerFailureDetected` par consommateur ayant **au moins un événement sauté** dans les `communication.consumer_failure_window_hours` dernières heures (24, fenêtre glissante deux bornes) **ou** un **retard strictement supérieur** à `communication.consumer_lag_alert_seconds` (300, volontairement au-dessus de la fenêtre de stabilisation de 120 s) ; retard = âge, à l'horloge de la base, du plus ancien événement non traité (0 si rien n'attend ; aucun comptage de l'arriéré) ; sujet = nom du consommateur seul ; marqueur de fin de passe toujours publié : l'alerte se ferme quand les deux conditions ont disparu (retard résorbé **et** sauts sortis de la fenêtre) ; `acknowledge` fait taire ; ni le message d'erreur ni le type de l'événement sauté ne sont lus ou publiés (données personnelles possibles, ADR-061 §4) ; le **journal d'erreur** de la tâche (une ligne par consommateur en défaut et par passe) est une supervision indépendante de l'alerte ; la lecture d'état (positions, retard, sauts) est un ajout de `platform/events` (`consumer-status.ts`) ; (b) une alerte par consommateur et par jour métier ; (c) journaux seulement.
- **Limites** : si c'est `communication.alerts` qui saute des événements, il traite quand même les suivants et l'alerte se lève à la passe suivante ; s'il est en retard, l'alerte se lève après son rattrapage (et peut être fermée à la passe d'après) ; si le worker est arrêté, ni la tâche ni le consommateur ne tournent : seule une sonde externe le décèle — la **sonde `/health/ready` en secondes est renvoyée à P9-22** (fichier hors de P9, métriques de charge) ; un consommateur qui n'a jamais tourné n'a pas de ligne ; renommer ou retirer un consommateur laisse sa ligne (aucune suppression accordée à l'application) : une migration doit la renommer ou l'apurer, sinon l'alerte dure ; un consommateur neuf rejoue tout l'historique (retard transitoire au déploiement, à amorcer avec la tête du flux) ; aucune hystérésis (un retard qui oscille autour du seuil ouvre et ferme l'alerte, chaque ouverture notifiant) ; 288 marqueurs par jour en ajout seul ; l'Admin lit consommateur, nombre de sauts et retard, le détail des sauts (type, message) reste dans la table, lue par l'équipe technique ; la table des sauts n'a ni purge ni conservation définie (ajout seul) : la passe en agrège la fenêtre toutes les cinq minutes (index sur `failed_at` : coût proportionnel aux sauts de la fenêtre, jusqu'à dix ans si elle est portée si haut) et un consommateur qui lève à chaque événement l'alourdit vite — conservation et plafond relèvent de P9-22 ; un consommateur de test ou de développement laissé en position faible dans une base partagée où tourne un worker lève une alerte permanente et un événement toutes les cinq minutes (apurer la base de développement) ; le saut est consigné par un `INSERT` simple dont seule l'unicité (consommateur × position) est ignorée : toute autre erreur lève et la position n'avance pas sur un saut sans trace : le worker consigne l'étape en échec (« consommateur … en échec, le tour continue ») et rejoue l'événement au tour suivant (au moins une fois) ; le retard qui en résulte lève l'alerte au-delà de 300 s.
- **Recommandation** : (a).
- **Impact** : `communication` (`ConsumerFailureJob`, module de tâches), `platform/events` (`consumer-status.ts`, ajout signalé à la session principale), domaine (`consumer-alerts.ts`), catalogue (réglage cité), semis (`communication.consumer_failure_window_hours`), [ADR-061](decisions/ADR-061-alertes-detection-correlation-et-cycle-de-vie.md) §12, [ADR-068](decisions/ADR-068-charge-paliers-analytiques-et-retention.md) §7. Défaut implémenté : (a). Paramétrable : seuil de retard, fenêtre des sauts.

### AV-426 — Audience d'une note de direction : qui une ligne `SITE`, `ZONE`, rôle ou utilisateur touche — IMPORTANTE
- **Question** : Qui une ligne d'audience désigne-t-elle exactement, et une affectation `GLOBAL` ou `TEAM` en fait-elle partie ?
- **Pourquoi** : BR-NOT-006 : audience « tous, rôles, sites, zones, utilisateurs » ; ADR-063 §3 : « un de ses sites ou zones d'affectation (avec descendantes) », sans dire dans quel sens se couvrent une zone et un site, ni ce que fait une affectation globale. La même décision doit servir à la **lecture en ligne** (un lecteur), à l'**accusé** (un utilisateur, parfois hors ligne) et à la **résolution à la publication** (notifications) : trois usages qui ne doivent pas diverger. **DÉDUIT**.
- **Choix** : (a) une **règle pure du domaine** (`note-audience.ts`) : l'audience est développée en ensembles (rôles, utilisateurs, sites, zones) à partir de la géographie des seules lignes nommées, puis comparée aux affectations **actives** de l'utilisateur ; `ALL` = tout utilisateur actif ayant une affectation active ; `ROLE` = une affectation active de ce rôle, de toute portée ; `USER` = cet utilisateur (actif et affecté) ; `SITE S` = les affectations de portée `SITE` sur S et celles de portée `ZONE` sur la zone de S ou l'un de ses ancêtres (une zone couvre ses sites) ; `ZONE Z` = les affectations de portée `ZONE` sur Z, sur un ancêtre (qui la couvre) ou sur une descendante, et celles de portée `SITE` sur un site de Z ou de ses descendantes ; les affectations `GLOBAL` et `TEAM` ne correspondent à aucune ligne `SITE` ou `ZONE` (pour atteindre tout le monde : `ALL` ou `ROLE`) ; l'adaptateur de `communication-api/` ne fait que charger la géographie et les affectations (son préfiltre SQL emploie les mêmes ensembles), derrière le port `NoteAudienceResolver` (références inconnues, utilisateurs touchés, utilisateur touché) ; (b) affectations `GLOBAL` incluses (la Direction recevrait toute note de site : bruit, alors qu'elle en est l'auteur) ; (c) correspondance de zone dans un seul sens (un secteur ne recevrait pas la note de sa région, ou l'inverse).
- **Limites** : un employé affecté par équipe (`TEAM`) ne reçoit une note de site ou de zone que par `ALL`, `ROLE` ou `USER` ; « touché » suppose une affectation active à l'instant jugé (comme les destinataires d'alerte) ; `ALL` écrit une notification par utilisateur actif ; une affectation postérieure à la publication voit la note en ligne sans la recevoir par notification (AV-369) ; une audience qui nomme un site ou une zone désactivés n'est pas refusée.
- **Recommandation** : (a).
- **Impact** : domaine (`note-audience.ts`), `communication` (port `NoteAudienceResolver`), `communication-api/` (`identity-note-audience-resolver.ts`, besoin B1 étendu), [ADR-063](decisions/ADR-063-notes-de-direction.md) §3 et §4. Défaut implémenté : (a). Non paramétrable.

### AV-427 — Notes de direction : brouillon, publication, archivage, références et notifications — SECONDAIRE
- **Question** : Quelles validations, quels états et quelles références régissent le brouillon, la publication et l'archivage d'une note, et que reçoivent les destinataires ?
- **Pourquoi** : ADR-063 §1, §2 et §4 posent le cycle et les validations de D13 §8, sans fixer le mode (en ligne ou non), qui peut retirer une note, la vérification des références ni le contenu des notifications. **DÉDUIT**.
- **Choix** : (a) `communication.note.save_draft`, `.publish` et `.archive` **en ligne seulement** (`ONLINE_REQUIRED`), sous `comm.note.publish` ; `publish` crée la note et la publie, ou publie le brouillon désigné avec **le contenu de la commande** ; instant de publication = **horloge du serveur** ; expiration strictement postérieure (`NOTE_EXPIRY_INVALID`) ; références d'audience connues — rôle actif, site, zone, utilisateur — (`NOTE_AUDIENCE_UNKNOWN`) ; une note corrective désigne une note existante, jamais elle-même (`NOTE_RELATED_INVALID`) ; brouillon visible de son seul auteur (un autre : `NOT_FOUND`) ; une note publiée ne se modifie ni ne se republie (`NOTE_NOT_DRAFT`, `NOTE_ALREADY_PUBLISHED`), une note archivée non plus (`NOTE_ARCHIVED`) ; deux créations simultanées de la même note : une seule aboutit (`NOTE_EXISTS`) ; `archive` : le brouillon de l'auteur (abandon) ou une note publiée (retrait par tout titulaire de `comm.note.publish`), à l'instant du serveur (jamais avant la publication), sans effet sur une note déjà archivée ; la publication écrit `InternalNotePublished`, l'archivage `InternalNoteArchived` ; **notification** in-app (`NOTE`) à chaque utilisateur touché, l'auteur excepté : titre de la note, corps « Note de la Direction · <catégorie> [· accusé de réception demandé] », sans lien (l'écran se déduit de la note), source = l'événement de publication (un rejeu ne double rien) ; une audience qui ne touche personne à la publication n'est pas refusée (l'évaluation à la lecture la verra, AV-426) ; (b) hors ligne admis (publication à date de fait) ; (c) retrait par l'auteur seul.
- **Limites** : une note corrective n'archive pas l'ancienne (la Direction le fait) ; un brouillon est introuvable pour un autre titulaire, même de `comm.note.publish` ; une note ne déclenche pas de Web Push (in-app seulement) ; titre de 160 et corps de 8 000 caractères au plus (schéma partagé) ; les commandes s'exécutent en lecture validée (aucun verrou d'intervalle sur une clé absente, la clé primaire arbitre deux créations) ; une note archivée, brouillon abandonné compris, est visible de la gestion de tout titulaire de `comm.note.publish` : l'archivage ne rend donc pas un brouillon abandonné opaque (`NOTE_ARCHIVED`, `archive` sans effet) ; en revanche le brouillon d'un autre n'est pas une note référençable (même réponse qu'une note inconnue) ; les notifications sont écrites **par lots de 200** dans la transaction de publication, sans plafond du nombre de destinataires (une audience « tous » touche tout le personnel).
- **Recommandation** : (a).
- **Impact** : `communication` (`note-commands.ts`, `notes/`), contrats (schémas déjà livrés en P9-03), D13 §8 et §10, catalogue d'événements. Défaut implémenté : (a). Non paramétrable.

### AV-428 — Lecture et accusé de réception d'une note : date du fait, audience et hors-audience — IMPORTANTE
- **Question** : À quelle date et pour quel public un accusé de lecture est-il enregistré, notamment hors ligne, après l'archivage ou l'expiration de la note, ou par un utilisateur que l'audience ne touche pas ?
- **Pourquoi** : UC-NOT-06 et AT-048 : la lecture et l'accusé fonctionnent hors ligne ; BR-SYN-007 : aucun fait accompli n'est rejeté pour une raison d'état métier. Une commande hors ligne arrive après coup : la note a pu être archivée ou expirer, l'audience a pu changer. **CONFIRMÉ** (règles) / **DÉDUIT** (date, hors-audience).
- **Choix** : (a) `communication.note.acknowledge` (droit `comm.note.read`) : `READ` crée la ligne de lecture, `ACKNOWLEDGE` (défaut) la complète une fois ; **idempotent** par (note, utilisateur) ; jugé à la **date du fait** (`occurred_at`), jamais avant la publication ; l'audience est évaluée à cette date (une affectation postérieure ne rend pas un accusé antérieur) ; un utilisateur que l'audience ne touchait pas à cette date n'est **pas enregistré** et la commande est **appliquée sans effet** (`recorded=false`) ; une note archivée ou expirée depuis est accusée à sa date, sans rejet ; une note inconnue ou en brouillon est introuvable ; l'accusé n'est jamais antérieur à la lecture déjà enregistrée ; lire ou accuser marque lues les notifications de la note pour l'utilisateur ; événement `InternalNoteAcknowledged` à chaque changement (lecture ou accusé), aucun pour un rejeu ; (b) rejet `NOT_FOUND` d'un utilisateur hors audience (comme les alertes) ; (c) accusé jugé à l'instant du serveur.
- **Limites** : un utilisateur hors audience à la date du fait n'a aucun retour (appliqué sans effet) ; l'accusé d'une note qui n'en exige pas est enregistré tout de même ; l'idempotence ne rejuge pas l'audience d'un accusé déjà enregistré ; un fait daté d'avant la publication est enregistré à la date de la publication (horloge d'appareil en retard) ; la **première** lecture reçue fixe `read_at` (immuable en base) : une lecture plus ancienne rejouée ensuite par un second appareil de l'utilisateur n'avance pas la date, et un accusé, jamais antérieur à la lecture enregistrée, en reprend la date ; un utilisateur suspendu n'atteint pas le gestionnaire (le pipeline met sa commande en conflit, BR-SYN-007).
- **Recommandation** : (a).
- **Impact** : `communication` (`note-commands.ts`), [ADR-063](decisions/ADR-063-notes-de-direction.md) §5, AT-048. Défaut implémenté : (a). Non paramétrable.

### AV-429 — Lecture des notes de direction : centre de notes, gestion, fiche et suivi des accusés — SECONDAIRE
- **Question** : Quelles notes un lecteur voit-il, que voit la Direction, et comment se suivent les accusés ?
- **Pourquoi** : ADR-063 §3, §5 et §6 posent l'évaluation de l'audience à la lecture, le maintien d'une note à accusé requis dans le centre de notes et le suivi pour la Direction, sans fixer l'étendue exacte, l'expiration, les brouillons ni la pagination. Les schémas de réponse (`noteListResponseSchema` et consorts) sont livrés avec P9-03. **DÉDUIT**.
- **Choix** : (a) `GET /api/v1/notes` : **centre de notes** par défaut (`comm.note.read`) — les notes **publiées et non expirées** (expiration strictement postérieure à l'instant de la lecture) dont l'audience touche le lecteur à cet instant (la règle d'AV-426, évaluée à la lecture : une affectation postérieure à la publication voit la note), plus récentes d'abord, chacune avec l'état du lecteur (`readAt`, `acknowledgedAt`) et sans audience ; `pendingAcknowledgements` = notes à accusé requis non accusées par le lecteur, comptées sur ce que le balayage examine (ci-dessous) quel que soit le filtre `pending_ack=true`, et `truncated` = vrai quand un des deux plafonds du balayage est atteint ; le balayage examine les 500 notes publiées non expirées les plus récentes **et** les 500 plus récentes des notes à accusé requis non accusées par le lecteur (toutes audiences confondues, avant le filtre d'audience) : une note à accuser ne sort pas du centre parce que d'autres notes l'ont dépassée ; `scope=manage` (`comm.note.publish`) — **toutes** les notes, quelle que soit l'audience, avec l'audience, les brouillons du lecteur seulement, filtre `status` (liste de `DRAFT`, `PUBLISHED`, `ARCHIVED`) ; `status` hors gestion et `pending_ack` en gestion sont refusés (400), de même qu'un curseur ou une limite invalides ; `GET /api/v1/notes/{id}` : un lecteur lit une note **publiée, même expirée**, qui le touche, jamais un brouillon ni une note archivée ; la gestion lit toute note avec son audience et son propre brouillon ; tout autre cas est un **404 opaque audité** (RC-07, RC-09) ; `GET /api/v1/notes/{id}/acknowledgements` (`comm.note.publish`) — audience **résolue maintenant**, l'auteur excepté, réunie aux utilisateurs qui ont une ligne de lecture : `audienceSize`, `read`, `acknowledged` et `missing` (sans accusé pour une note à accusé requis, sans lecture pour une note simple, nommés par la couche de transport, 1 000 au plus) ; le brouillon n'a pas d'audience (suivi vide) ; (b) audience figée à la publication (écartée par ADR-063) ; (c) note expirée maintenue dans le centre tant que l'accusé manque.
- **Limites** : au-delà de 500 notes publiées non expirées, ou de 500 notes à accusé requis non accusées par le lecteur (toutes audiences confondues), les plus anciennes ne sont pas examinées (`truncated` vrai ; `NOTE_INBOX_SCAN_MAX`) ; chaque page refait le balayage (500 notes au plus, leurs audiences, les affectations du lecteur), y compris en gestion pour le seul compteur : coût borné, à mesurer en P9-22 ; une note expirée disparaît du centre même si l'accusé manque ; l'accusé d'un utilisateur sorti de l'audience depuis compte parmi les lus et accusés ; le suivi n'est pas paginé ; le tri et le curseur se font à la milliseconde (la création d'un brouillon, écrite à la microseconde par la base, est tronquée à la milliseconde pour le tri de la gestion) ; les identifiants de l'adresse sont acceptés en majuscules comme en minuscules.
- **Recommandation** : (a).
- **Impact** : `communication` (`public/note-read.ts`), `communication-api/` (`communication-read.controller.ts`, port `NoteAudienceResolver` étendu de `visibleNoteIds`), [ADR-063](decisions/ADR-063-notes-de-direction.md) §3, §5, §6, [`01-architecture-api.md`](08-api-events/01-architecture-api.md) §4.10. Défaut implémenté : (a). Non paramétrable.

### AV-430 — Notifications directes d'événements : événements publiés, destinataires et texte — SECONDAIRE
- **Question** : Parmi les événements du catalogue dont la conséquence est « notification », lesquels le code publie-t-il, qui prévient-on, et que dit le message ?
- **Pourquoi** : AV-389 (a) retient une liste d'événements sans fixer les destinataires ni le texte, et aucun d'eux n'était publié. RC-05 et AV-390 : le résumé d'une demande de validation peut décrire une valeur au coût (perte valorisée, écart d'inventaire) et la notification part à des personnes qui n'ont pas toutes ce droit. BR-ADM-017 : nul ne s'approuve soi-même. **DÉDUIT**.
- **Choix** : (a) cinq événements, publiés dans la transaction de l'opération par leur module propriétaire sous un identifiant déterministe (type et objet), consommés par `communication.direct` :
  - `ApprovalRequested` (`requestApproval`) → les titulaires de la permission d'approbation de la politique **figée sur la demande**, sur son périmètre (le demandeur en est le propriétaire, donc les portées `OWN` et `TEAM` jouent, sans qu'il soit jamais destinataire) ; à défaut de tout approbateur, ou d'une politique sans permission, la Direction (comme une alerte sans destinataire) ;
  - `ApprovalGranted` et `ApprovalRejected` (décision) → le demandeur seul, s'il est actif ; jamais lui-même s'il a décidé (Direction, BR-ADM-017) ; le refus porte le motif de l'approbateur (300 caractères au plus) ;
  - `StockTransferRequested` (`inventory.transfer.request`) → les titulaires de `inventory.transfer.dispatch` du site source, demandeur exclu ;
  - `StockTransferDispatched` (`inventory.transfer.dispatch`, sur demande ou en expédition directe, jamais une quarantaine) → les titulaires de `inventory.transfer.receive` du site destinataire, expéditeur exclu ;
  texte court : le libellé du type d'opération ou le numéro du transfert, **jamais** le résumé, le montant ni les quantités ; canal `IN_APP` seulement, livrée à sa création ; `link` vide : l'objet source (`source_type` `APPROVAL_REQUEST` ou `STOCK_TRANSFER`, `source_id`) et la nature (`kind` `DIRECT`) sont rendus par `GET /api/v1/notifications` pour que l'écran ouvre l'objet. `PurchaseRequestApproved` et `PurchaseRequestRejected` : la décision d'une demande d'achat passe par `approvals`, et `ApprovalGranted` ou `ApprovalRejected` (type d'opération `PURCHASE_REQUEST`, « Votre demande (Demande d'achat) a été approuvée ») la notifient ; les publier en plus enverrait deux notifications pour une décision. `PurchaseRequestCancelled` et `ApprovalCancelled` restent sans notification (AV-389). (b) Message avec le résumé et le montant (écarté : RC-05). (c) Notification Web Push aussi (écarté : ni la gravité ni l'urgence d'une alerte).
- **Limites** : un transfert expédié notifie le site destinataire même si une réception sans document l'y avait précédé (le texte, « expédié vers votre site », reste vrai) ; un emplacement virtuel n'a pas de site : seules les portées `ALL` sont alors prévenues ; les approbateurs d'une demande sont jugés à l'instant du traitement, non à celui de la demande, et l'état de la demande n'est pas relu : si l'événement est consommé après la décision (quelques secondes), un approbateur peut être prévenu d'une demande déjà décidée ; au premier démarrage du consommateur, l'historique des événements est parcouru (un événement à la fois, comme `communication.alerts`) ; une charge qui ne tient pas son contrat fait échouer l'événement (consigné, `CONSUMER_FAILED`), jamais ignorée.
- **Recommandation** : (a).
- **Impact** : `approvals` (`approval-events.ts`, `request-approval.ts`, `decide-approval-request.ts`), `inventory` (`transfer-events.ts`, `transfer-commands.ts`), `communication` (consommateur `communication.direct`, `resolve-direct-recipients.ts`), domaine (`direct-notifications.ts`), contrat `notificationItemSchema` (`kind`, `sourceType`, `sourceId`), [ADR-062](decisions/ADR-062-destinataires-notifications-push-et-escalade.md) §4, catalogue d'événements §2.2 et §2.5. Défaut implémenté : (a). Paramétrable : activation par type (AV-431).

### AV-431 — Activation des notifications directes par type — SECONDAIRE
- **Question** : Comment désactiver la notification d'un type d'événement sans arrêter l'événement ni changer le code ?
- **Pourquoi** : AV-389 prévoyait une « activation par type » sans dire où ; les seuils et réglages sont des paramètres (CLAUDE.md, règle 8). **DÉDUIT**.
- **Choix** : (a) un réglage système, `communication.direct_notification_disabled_types` : la liste des types désactivés (vide par défaut) ; (b) un réglage booléen par type ; (c) une règle d'alerte par type.
- **Recommandation** : (a) : un seul lieu, l'ajout ou le retrait d'un type se fait sans migration ; une valeur qui n'est pas une liste de types connus ne désactive rien.
- **Impact** : `db/seeds/system-settings.ts`, dictionnaire `02-organization` (catalogue des clés), consommateur `communication.direct`. Défaut implémenté : (a). Paramétrable.

### AV-432 — `DeviceEnrollmentRequested` : prévenir les approbateurs d'un appareil en attente — SECONDAIRE
- **Question** : Faut-il prévenir les approbateurs quand un appareil attend sa validation, et lesquels ?
- **Pourquoi** : le catalogue cite NOT pour `DeviceEnrollmentRequested`. La portée d'approbation d'un appareil est composée (MP-06, AV-247, AV-260 : les équipes de l'utilisateur qui l'a connecté, les sites de ses affectations, le site de rattachement de l'appareil ; nul ne s'approuve soi-même, AV-258), ce que le résolveur de destinataires (site, zone, propriétaires) n'exprime pas sans `deviceResourceLocators` d'`identity` ; l'événement serait publié dans la transaction de connexion. **DÉDUIT**.
- **Choix** : (a) ne pas publier : la file des appareils (ECR-ADM-05) et le bandeau d'attente restent le canal ; (b) publier et prévenir les titulaires de `identity.device.approve` selon `deviceResourceLocators` ; (c) prévenir seulement l'Administrateur et la Direction.
- **Recommandation** : (b), quand le résolveur saura juger plusieurs ressources (besoin B1) ; en attendant (a), pour ne pas toucher au chemin de connexion.
- **Impact** : `identity` (`device-enrollment.ts`), catalogue d'événements §2.1. Défaut implémenté : (a), aucune notification. Non paramétrable.

### AV-433 — Jeu hors ligne `comms` : contenu, portée et rendu des alertes — SECONDAIRE
- **Question** : Que contient le jeu `comms` d'un appareil, pour qui chaque ligne est-elle émise et comment le texte est-il rendu ?
- **Pourquoi** : la spécification de synchronisation (§3.1) liste, en portée `USER`, « les 50 dernières alertes ouvertes, les notifications non lues, les notes non expirées, les conflits et les demandes de validation de l'utilisateur » ; le dictionnaire dit « du périmètre » pour les alertes ; ADR-060 §6 et ADR-063 §4 posent des lignes `USER` par destinataire. Un rôle n'est pas une portée du flux. **DÉDUIT**.
- **Choix** : (a) trois types d'entité émis par `communication` en portée `USER`, dans la transaction de l'écriture qu'ils décrivent (`sync-changes.ts`), lus par `sync/communication-projections.ts` : `ALERT` (alerte ouverte de la **boîte** de l'utilisateur — les destinataires inscrits —, une ligne quand un destinataire est ajouté, quand le titre, le message ou la gravité changent, à la prise en compte et à l'escalade ; une sortie à la clôture par la condition ou la passe, à la résolution et à l'écartement), `NOTIFICATION` (AV-434), `NOTE` (AV-435) ; une ligne n'est servie que si elle est en portée `USER` de l'utilisateur qui télécharge (le repli générique `GLOBAL` du pipeline ne sert jamais rien), et l'alerte seulement à un destinataire d'une alerte ouverte ; le texte est **rendu pour lui** par les lectures de `communication` : une valeur au coût n'y figure que s'il détient `inventory.valuation.read` sur le site de l'alerte (RC-05, AV-390), la charge utile servie ne porte que les champs non protégés ; les demandes de validation de l'utilisateur restent servies par `APPROVAL_REQUEST` ; (b) alertes du périmètre en lignes `SITE` ou `ZONE` (écarté : volume, et exposition de toutes les alertes du site à chaque appareil de ce site) ; (c) tout le jeu en `GLOBAL` (écarté).
- **Limites** : la supervision par la portée (Direction, Finance, responsables de site ou d'équipe) reste en ligne ; le serveur ne plafonne pas à 50 (l'appareil garde les plus récentes) ; les conflits de l'utilisateur restent en ligne (`GET /conflicts`) ; une occurrence qui ne change ni le titre, ni le message, ni la gravité ne republie rien (le compteur d'occurrences n'est rafraîchi hors ligne qu'au prochain changement) ; le texte déjà téléchargé ne se rappelle pas si le droit de valorisation est perdu ensuite (ADR-062, révision de P9-06) ; le droit est jugé à l'instant du téléchargement.
- **Recommandation** : (a).
- **Impact** : `communication` (`sync-changes.ts`, `alerts/alert-store.ts`, `notifications/alert-notifier.ts`), `sync/communication-projections.ts`, `sync/entity-projections.ts` (une ligne), [ADR-060](decisions/ADR-060-architecture-de-p9-communication-et-analytics.md) §6, [`01-architecture-offline.md`](06-offline-sync/01-architecture-offline.md) §3.1. Défaut implémenté : (a). Non paramétrable.

### AV-434 — Notifications dans le jeu hors ligne : non lues `IN_APP`, sortie à la lecture — SECONDAIRE
- **Question** : Quelles notifications l'appareil reçoit-il, et quand en sortent-elles ?
- **Pourquoi** : le dictionnaire dit « Offline DL (non lues) » ; le Web Push n'est que l'envoi du même message (ADR-062 §5). **DÉDUIT**.
- **Choix** : (a) seules les notifications `IN_APP` non lues : une ligne à l'écriture (alerte, note ou notification directe — `insertNotification` et l'écriture par lots), une sortie quand elles sont lues (`communication.notification.read`, une liste ou « toutes », ou la lecture ou l'accusé de la note) ; le canal `WEB_PUSH` n'entre jamais et sa lecture ne produit aucune sortie ; une ligne ignorée par l'unicité (rejeu) ne publie rien ; (b) toutes les notifications des 90 jours (écarté : volume).
- **Limites** : une notification lue sur un autre appareil sort à la prochaine synchronisation ; « toutes » ne couvre que celles créées jusqu'à l'instant du geste ; la lecture d'un lot de notifications écrit une sortie par notification.
- **Recommandation** : (a).
- **Impact** : `communication` (`notifications/notification-store.ts`, `commands/notification-commands.ts`, `commands/note-commands.ts`), `sync/communication-projections.ts`. Défaut implémenté : (a). Non paramétrable.

### AV-435 — Notes dans le jeu hors ligne : détenteurs, état de lecture, retrait — SECONDAIRE
- **Question** : Qui reçoit une note par le flux, comment voyage l'état de lecture de l'utilisateur et quand la note sort-elle de l'appareil ?
- **Pourquoi** : ADR-063 §4 (audience résolue à la publication, lignes `USER`) et sa révision (un retrait doit atteindre les appareils) ; AT-048 : la note est lue et accusée hors ligne, puis synchronisée. **DÉDUIT**.
- **Choix** : (a) une ligne `NOTE` pour chaque utilisateur touché à la publication (l'auteur excepté) et pour l'utilisateur dont la lecture ou l'accusé vient d'être enregistré (y compris affecté après la publication) ; l'**état de lecture de l'utilisateur** (`read_at`, `acknowledged_at`) voyage **dans la note**, l'audience jamais ; la note n'est servie que si elle est publiée, non expirée au téléchargement, et que l'utilisateur a été notifié ou l'a lue (aucune fuite par une ligne émise à tort) ; à l'archivage, une sortie pour chaque détenteur (utilisateurs notifiés ou ayant lu ou accusé) ; l'expiration ne produit aucune ligne : l'appareil masque une note à son `expires_at` et un téléchargement neuf ne la sert pas ; (b) une entité d'accusé séparée (écarté : l'accusé n'a de sens qu'avec sa note) ; (c) ligne de sortie à l'expiration par une tâche (écarté : l'appareil connaît la date).
- **Limites** : un utilisateur affecté après la publication n'a la note par le flux qu'à sa première lecture en ligne (ADR-063 §4, AV-369) ; un utilisateur dont l'affectation est retirée garde la note sur son appareil jusqu'au retrait ou à l'expiration ; l'accusé saisi sur l'appareil revient confirmé par le flux à la synchronisation ; une note expirée déjà détenue n'est retirée que par l'appareil.
- **Recommandation** : (a).
- **Impact** : `communication` (`commands/note-commands.ts`, `sync-changes.ts`), `sync/communication-projections.ts`, [ADR-063](decisions/ADR-063-notes-de-direction.md) §4, AT-048. Défaut implémenté : (a). Non paramétrable.

### AV-436 — Mortalité comptée d'un lot : statuts comptés et sort de la mortalité refusée — SECONDAIRE
- **Question** : Quels statuts de déclaration de mortalité comptent comme têtes mortes, et que devient une mortalité refusée comme non justifiée ?
- **Pourquoi** : `lotMortalitySummary` (indicateurs du lot, taux de mortalité, AV-113) compte les déclarations `RECORDED`, `APPROVED`, `REJECTED_UNJUSTIFIED` et `CANCELLATION_PENDING` ; `productionLotMortalityByDay` (série jour par jour de l'écran du lot) n'en compte que trois, sans `REJECTED_UNJUSTIFIED`. En pratique l'écart est vide : la décision de rejet « non justifiée » reclasse la déclaration en catégorie `INEXPLIQUEE` (`inventory/application/public/loss-declaration.ts`), et ni l'une ni l'autre des deux fonctions ne la compte plus comme mortalité (elles ne lisent que `category = 'MORTALITE'`). Les animaux sont pourtant morts : la mortalité refusée sort des indicateurs de mortalité du lot et n'apparaît que comme perte inexpliquée imputée au déclarant (AV-038). **DÉDUIT** (constat de code).
- **Choix** : (a) la vue `analytics_f_production_daily` suit le résumé du lot (quatre statuts, catégorie `MORTALITE`) : mêmes chiffres que l'écran du lot et que la série ; la mortalité refusée n'y figure pas, comme partout ailleurs ; (b) compter aussi les déclarations `INEXPLIQUEE` d'un lot de production comme mortalité (changerait l'indicateur du lot, hors du périmètre de P9).
- **Limites** : le taux de mortalité d'un lot ne compte pas les animaux morts dont la déclaration a été refusée comme non justifiée ; à trancher avec la Direction (AV-038, AV-113).
- **Recommandation** : (a) pour P9, et décider avec la Direction si une mortalité refusée doit rester dans les têtes mortes du lot.
- **Impact** : `analytics_f_production_daily` (migration `20261201090500`) ; `inventory` et `production` non modifiés. Défaut implémenté : (a). Non paramétrable.

### AV-437 — Valeur d'un solde de stock : deux définitions — SECONDAIRE
- **Question** : La valeur du stock est-elle le solde multiplié par le coût unitaire moyen courant, ou la somme signée des valeurs figées du registre ?
- **Pourquoi** : D11 KPI-STK-02 écrit « Σ solde × coût unitaire courant » et `GET /stock` l'applique (BR-STK-054, `stockValueXaf`) ; l'accueil (`inventory/application/public/home-metrics.ts`) additionne `stock_balances.value_xaf`, la valeur du registre. Les deux ne coïncident qu'à l'arrondi du coût moyen près. **DÉDUIT**.
- **Choix** : (a) la vue suit BR-STK-054 : `ROUND(solde × coût unitaire moyen arrondi au franc)` ; (b) la valeur du registre.
- **Limites** : l'explorateur et l'accueil peuvent différer de quelques francs par ligne.
- **Recommandation** : (a), puis aligner l'accueil.
- **Impact** : `analytics_f_stock_balance.value_xaf` (migration `20261201090500`). Défaut implémenté : (a). Non paramétrable. La vue exclut aussi les emplacements qui ne sont que la source ou le puits d'un mouvement (fournisseur, client, perte, production, consommation, ajustement, ouverture : aucun stock) et garde le transit, les pertes en attente de validation et l'à-livrer, distingués par `location_type` (KPI-STK-02, AV-256).

### AV-438 — Remise et coût d'une ligne de vente annulée — SECONDAIRE
- **Question** : Une annulation contre-passe-t-elle la remise de la ligne annulée, et quel coût porte-t-elle ?
- **Pourquoi** : une ligne d'annulation porte un montant et une quantité, pas de remise ; le coût figé d'une vente est celui de sa ligne (`sales_sale_lines.cost_xaf`, somme des mouvements `SALE` de la ligne à la vente), celui d'une annulation la somme des retours `CUSTOMER_RETURN` de sa ligne (ADR-029), comme `saleCostsInPeriod`. **DÉDUIT**.
- **Choix** : (a) la remise est la remise accordée sur les lignes vendues, nulle sur une annulation ; le coût d'une annulation est négatif (coût des retours de stock de sa ligne) et sa marge vaut −montant + coût retourné ; une ligne sans sortie de stock a un coût nul (sa marge égale son montant) ; (b) remise contre-passée au prorata (écarté : arrondis sans valeur métier).
- **Recommandation** : (a).
- **Impact** : `analytics_f_sales_line` (migration `20261201090400`). Défaut implémenté : (a). Non paramétrable.

### AV-439 — Jeu des achats : facturé et payé hors du jeu — SECONDAIRE
- **Question** : L'explorateur des achats donne-t-il aussi le facturé et le payé ?
- **Pourquoi** : le dictionnaire d'origine citait « facturé, montants » ; la facture et le paiement sont des documents de la finance (P8), rapprochés par `purchaseOrderMatching` et lus dans les dettes fournisseurs ; le catalogue (ADR-064) ne déclare aucune mesure facturée. **DÉDUIT**.
- **Choix** : (a) `analytics_f_purchases` porte les quantités commandées, livrées, rejetées et acceptées et le montant commandé ; le facturé et le payé se lisent dans les dettes ; (b) un jeu des factures fournisseurs, à ajouter si la Direction le demande.
- **Recommandation** : (a).
- **Impact** : `analytics_f_purchases` (migration `20261201090600`), catalogue (libellé « Montant commandé »). Défaut implémenté : (a). Non paramétrable.

### AV-440 — Pertes et dépenses : constaté, en attente et non justifié en colonnes distinctes — SECONDAIRE
- **Question** : Une perte en attente de validation, une perte rejetée et rendue, une dépense en attente ou payée puis refusée entrent-elles dans le total de l'explorateur ?
- **Pourquoi** : `lossValueSummary` ne compte que les pertes constatées (`RECORDED`, `APPROVED`, `REJECTED_UNJUSTIFIED`, `CANCELLATION_PENDING`) et rend l'en attente à part ; une perte rejetée et rendue n'est pas une perte. `expensesSummary` ne compte que les dépenses valides (`RECORDED`, `APPROVED`, `PAID`), rend à part l'en attente (`PENDING_APPROVAL`, `PAID_PENDING_APPROVAL`) et les payées puis refusées (`PAID_REJECTED`, non justifiées). Une mesure de l'explorateur n'a pas de condition de statut : un total sans colonnes distinctes mélangerait ces sens. **DÉDUIT**.
- **Choix** : (a) la mesure principale ne compte que le constaté ou le valide (`quantity_base` et `value_xaf` ; `amount_xaf`) ; l'en attente et le non justifié sont des mesures à part (`pending_quantity_base`, `pending_value_xaf` ; `pending_xaf`, `unjustified_xaf`) ; le statut reste une dimension ; (b) tout sommer et laisser l'utilisateur filtrer le statut (écarté : un total sans filtre contredirait les écrans de la finance).
- **Recommandation** : (a).
- **Impact** : `analytics_f_losses` (migration `20261201090500`), `analytics_f_expenses` (migration `20261201090600`), catalogue (mesures `pending_quantity`, `pending_value`, `pending`, `unjustified`). Défaut implémenté : (a). Non paramétrable.

### AV-441 — Prospection : comptes et conversions lus par l'acteur de l'événement — SECONDAIRE
- **Question** : L'explorateur de l'activité commerciale lit-il un compte créé et une conversion par la personne qui les a produits (acquéreur, titulaire à la conversion) ou par le titulaire courant du compte ?
- **Pourquoi** : `commercialEffort` (BR-CRM-019) attribue la création du compte à son acquéreur et la conversion au titulaire à l'instant de la conversion, pour mesurer l'effort de chaque personne. `GET /customers/{id}` juge le compte sur son titulaire courant, son site de rattachement et sa zone, et exige `crm.customer.read` en plus de `crm.visit.read`. Un commercial en portée propriétaire qui a acquis un compte puis l'a cédé voit donc encore l'événement dans l'explorateur, mais plus le compte dans la liste ; le nouveau titulaire n'en voit aucun. Seules les visites suivent l'auteur dans les deux lectures. **DÉDUIT**.
- **Choix** : (a) acteur de l'événement (effort individuel, cohérent avec les indicateurs de l'accueil) ; (b) titulaire courant (cohérent avec la liste des comptes, mais l'effort d'un commercial qui cède ses comptes disparaît de sa lecture).
- **Recommandation** : (a).
- **Impact** : `analytics_f_prospecting` (`user_id`), ADR-064 §2 (« comme le module `crm` » réservé aux visites), dictionnaire. Défaut implémenté : (a). Non paramétrable.

### AV-442 — Conversion d'un compte fusionné — SECONDAIRE
- **Question** : La conversion portée par un compte absorbé dans une fusion compte-t-elle ?
- **Pourquoi** : la fusion (`customer-commands.ts`) laisse `converted_at` sur le compte absorbé (stade `MERGED`) et le recopie sur le compte conservé ; `commercialEffort` compte les deux, donc un même client converti deux fois (KPI-COM-05 gonflé, y compris pour deux titulaires si les affectations diffèrent). La création, elle, exclut déjà les comptes fusionnés. **DÉDUIT**.
- **Choix** : (a) exclure les comptes fusionnés des conversions comme de la création (la conversion est celle du compte conservé) ; (b) suivre `commercialEffort` (écart nul, double compte).
- **Recommandation** : (a), et corriger `commercialEffort` dans `crm` (signalé à la session principale, suivi §4).
- **Impact** : `analytics_f_prospecting` (bras `CONVERSION`), suivi §4. Défaut implémenté : (a). Non paramétrable.

### AV-443 — Achats : date d'un bon de commande et taux de service — SECONDAIRE
- **Question** : À quelle date le commandé et le montant commandé d'un bon sont-ils comptés, et le taux de service (KPI-APP-01, « BC clôturés dans la période ») se lit-il dans l'explorateur ?
- **Pourquoi** : `occurred_at` d'un bon est la création de son brouillon : un bon créé fin septembre et approuvé début octobre entrait dans septembre, et une lecture de septembre faite avant l'approbation ne le comptait pas. Le jeu ne porte ni le statut du bon ni sa date de clôture, et le livré et l'accepté sont datés de la réception : le taux de service d'un mois divisait des acceptés du mois par des commandés créés dans le mois. **DÉDUIT**.
- **Choix** : (a) date d'approbation (`approved_at`, à défaut `occurred_at`) : le bon est engagé à cette date ; un bon approuvé et pas encore envoyé compte comme commandé ; le taux de service d'une période se lit commandé contre accepté de la même période, et le rapprochement d'un bon (`purchaseOrderMatching`) donne le taux de service « BC clôturés » ; (b) date d'envoi (`sent_at`, absente d'un bon approuvé non envoyé) ; (c) date de création (écartée : rétroactive).
- **Recommandation** : (a).
- **Impact** : `analytics_f_purchases` (migration `20261201090600`), D11 (KPI-APP-01 approchée). Défaut implémenté : (a). Non paramétrable.

### AV-444 — Soldes de stock, valeur, trésorerie : mesures sans signe ni filtre — SECONDAIRE
- **Question** : Que somment « Solde », « Valeur », « Disponible », « Entrées » et « Sorties » sans filtre, et comment lire un écart d'inventaire net ?
- **Pourquoi** : le jeu des soldes garde le transit, les pertes en attente et l'à-livrer, que l'accueil ne somme pas (il ne somme que les emplacements physiques) ; un disponible de marchandise en transit, en perte en attente ou déjà vendue n'a pas de sens ; `GET /stock` omet les soldes entièrement à zéro. Les entrées et sorties de trésorerie sont des flux bruts : un encaissement annulé donne une entrée et une sortie du même type, un virement interne et un écart de caisse gonflent les deux. Les mesures additives ne sont pas signées : un écart d'inventaire net (KPI-STK-04, gains moins pertes) ne sort qu'en gains et pertes séparés. **DÉDUIT**.
- **Choix** : (a) solde et valeur sans filtre d'emplacement additionnent tous les emplacements du jeu (la dimension `location_type` les sépare), disponible nul hors emplacement physique, soldes à zéro omis ; entrées et sorties bruts, `movement_type` et la dimension `is_reversal` pour les isoler ; écart net lu par type de mouvement ; (b) mesures signées dédiées (écart net, flux net hors virements), à ajouter avec les tableaux (P9-17) si la Direction le demande ; (c) emplacements physiques seuls par défaut (écarté : le transit est du stock de l'entreprise).
- **Recommandation** : (a).
- **Impact** : `analytics_f_stock_balance` (migration `20261201090500`), `analytics_f_cash` (migration `20261201090600`, colonne `is_reversal`), catalogue (dimension `is_reversal` de la trésorerie), dictionnaire. Défaut implémenté : (a). Non paramétrable.

### AV-445 — Tableaux : étendue non représentable par une portée de lecture — SECONDAIRE
- **Question** : Que fait un bloc de tableau quand l'étendue exacte de l'utilisateur ne se traduit pas en une portée de lecture des fonctions de référence (sites et personnes à la fois, ou plus de clauses qu'elle n'en porte) ?
- **Pourquoi** : les fonctions de référence des modules prennent une portée `ReadScope` (sites et/ou personnes, en ET), alors que l'étendue exacte de l'explorateur est une union de clauses (site A ou équipe B). Les traduire en élargissant donnerait à l'utilisateur plus que son droit ; en rétrécissant, un chiffre trompeur. **DÉDUIT**.
- **Choix** : (a) le bloc est `unavailable` (`SCOPE_UNSUPPORTED`), le tableau reste rendu, l'explorateur donne le chiffre exact ; les valeurs au coût de la finance ne se calculent que sous `ALL` ou des sites ; (b) étendre les fonctions de référence à l'union ; (c) refuser tout le tableau.
- **Recommandation** : (a).
- **Impact** : `analytics-api/dashboards/scope-adapter.ts` et `dashboard-blocks.ts` ; [ADR-066](decisions/ADR-066-tableaux-tour-de-controle-et-instantanes.md) §3. Défaut implémenté : (a). Non paramétrable.

### AV-446 — Vues sauvegardées : propriétaire seul, vue par défaut d'un rôle — SECONDAIRE
- **Question** : Qui peut modifier, partager, supprimer une vue, et comment une vue devient-elle la vue par défaut d'un rôle ?
- **Pourquoi** : BR-ANA-007 (un partage ne donne aucun droit) et la clé unique `is_default_for_role` de la base (une vue par défaut par rôle). La permission `analytics.view.share` de la Direction est `ALL`, celle du responsable commercial `TEAM` : elle ne dit pas qui possède une vue. **DÉDUIT**.
- **Choix** : (a) propriétaire seul pour tout, la vue d'un autre est introuvable (existence opaque) ; la vue par défaut doit être partagée avec le rôle, remplace la précédente, tombe si le partage est retiré ; nom unique par propriétaire ; (b) la Direction gère toute vue ; (c) vues par défaut sans partage préalable.
- **Recommandation** : (a).
- **Impact** : `modules/analytics/application/commands/view-commands.ts`, `views/view-store.ts` ; [ADR-067](decisions/ADR-067-vues-sauvegardees-et-exports-audites.md) §1. Défaut implémenté : (a). Non paramétrable.

### AV-447 — Exports : échéance, file par demandeur, étendue tronquée, abandon — SECONDAIRE
- **Question** : Quand un export échoit-il, combien un demandeur peut-il en avoir à la fois, que devient un export dont l'étendue exacte a été tronquée, et que devient une tâche perdue ?
- **Pourquoi** : le déclencheur de `analytics_export_jobs` interdit de changer `expires_at` ; un utilisateur à la gestion large pourrait occuper la file du worker ; un export fait avec une étendue tronquée (`scopeMaxCandidates`) serait plus étroit que le droit sans que le fichier le dise ; une tâche aux cinq rejeux épuisés laisse une ligne `QUEUED`. **DÉDUIT**.
- **Choix** : (a) échéance posée à la demande (`analytics.export_file_hours`, 24), 3 exports en file ou en cours (`analytics.export_max_pending_per_user`), étendue tronquée = `FAILED` `SCOPE_TRUNCATED`, abandon après un jour (`EXPORT_ABANDONED`), fichier supprimé 30 jours après la demande (`analytics.export_file_retention_days`) ; (b) échéance posée à la fin du calcul (déclencheur à modifier) ; (c) fichier partiel avec avertissement.
- **Recommandation** : (a).
- **Impact** : `modules/analytics/application/exports/`, `commands/export-commands.ts`, `maintenance/purge.ts` ; [ADR-067](decisions/ADR-067-vues-sauvegardees-et-exports-audites.md) §3 et §6, [ADR-068](decisions/ADR-068-charge-paliers-analytiques-et-retention.md) §8. Défaut implémenté : (a). Paramétrable : durée, plafond, rétention.

### AV-448 — Instantanés personnels : lot, contenu, retrait — SECONDAIRE
- **Question** : Combien d'utilisateurs une exécution de la tâche d'instantanés traite-t-elle, que contient un instantané, et quand une ligne est-elle retirée ?
- **Pourquoi** : une exécution est une seule transaction de worker ; calculer un tableau coûte une trentaine de lectures ; l'appareil n'a pas besoin des liens d'exploration (en ligne seulement) ; un instantané d'un utilisateur parti ne doit pas rester lisible. **DÉDUIT**.
- **Choix** : (a) 50 utilisateurs par exécution avec une tâche de reprise, indicateurs sans liens, instantané conservé (daté) quand le tableau ne peut être calculé, retrait des utilisateurs inactifs au dernier lot ; (b) 200 utilisateurs (valeur initiale de l'ADR-068) ; (c) calcul à la demande seulement.
- **Recommandation** : (a).
- **Impact** : `analytics-api/jobs/kpi-snapshots-refresh-job.ts`, `analytics/application/snapshots/snapshot-store.ts` ; [ADR-066](decisions/ADR-066-tableaux-tour-de-controle-et-instantanes.md) §5, [ADR-068](decisions/ADR-068-charge-paliers-analytiques-et-retention.md) §3. Défaut implémenté : (a). Paramétrable : `analytics.snapshot_batch_size`, `analytics.snapshot_active_days`.

### AV-449 — Document source d'une ligne : dimensions de document et routes — SECONDAIRE
- **Question** : Comment une ligne de l'explorateur désigne-t-elle le document dont elle provient (BR-ANA-010, niveau 2) ?
- **Pourquoi** : les vues exposent déjà l'identifiant du document de chaque ligne (`sale_id`, `payment_id`, `move_id`…) sans que le catalogue le déclare ; toutes les lectures n'ont pas de route par identifiant (mouvements, pertes, visites, sessions, coûts, trésorerie). **DÉDUIT**.
- **Choix** : (a) une dimension de document par jeu de lignes détaillées, déclarée au catalogue avec le type et la route (route de la liste quand aucune lecture par identifiant n'existe) ; la ligne la porte quand l'exploration regroupe par cette dimension ; (b) nouvelle lecture de trace ; (c) rien.
- **Recommandation** : (a).
- **Impact** : `packages/domain/src/analytics-catalog.ts` (`DOCUMENT_SOURCES`), contrat `catalogDatasetSchema.source`, `analytics-explorer.controller.ts` ; [ADR-065](decisions/ADR-065-une-seule-definition-par-indicateur-et-periodes.md) §6. Défaut implémenté : (a). Non paramétrable.

### AV-450 — Charge : index non ajoutés avant mesure, jeu de ventes seul — SECONDAIRE
- **Question** : Faut-il ajouter dès maintenant des index de jour métier aux tables dont la vue date par une expression, et que génère le jeu de charge ?
- **Pourquoi** : ADR-068 §4 : aucun index sans requête mesurée. Les vues de commandes, visites, sessions, coûts et achats datent par `CONVERT_TZ(...)` sur un horodatage : un index sur l'horodatage seul ne sert pas tant que la requête ne filtre pas la colonne brute. Générer tous les satellites d'un million de ventes (encaissements, mouvements, coûts) demande une connaissance fine de chaque contrainte pour un gain de mesure faible. **DÉDUIT**.
- **Choix** : (a) aucun index avant la mesure ; jeu de ventes (`sales_sales`, `sales_sale_lines`) seul, déterministe, à la demande ; (b) index de précaution sur les horodatages ; (c) jeu complet de satellites.
- **Recommandation** : (a).
- **Impact** : `db/load/p9-load-set.ts`, `apps/server/test/perf/analytics.perf.ts`, suivi de P9 §7. Défaut implémenté : (a). Non paramétrable.

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
| 28/09/2026 | AV-122 | Péremption des œufs collectés : date de collecte + 28 jours, paramétrés | Porteur du projet |
| 28/09/2026 | AV-123 | Annulation d’une entrée de lot réservée au Responsable production | Porteur du projet |
| 28/09/2026 | AV-124 | Production sans coût standard : saisie acceptée à la valeur par défaut, alerte à l’administrateur (P9) | Porteur du projet |
| 28/09/2026 | AV-114 | Têtes saisies sans produit, coût porté par les produits ; frais d’abattage = dépense directe du lot | Porteur du projet |
| 28/09/2026 | AV-115 | Tous les types de lots abattables dès P7 (volailles et porcs), liste paramétrée | Porteur du projet |
| 28/09/2026 | AV-120 | Annulation refusée si les produits sont sortis ; correction compensatoire | Porteur du projet |
| 28/09/2026 | AV-125 | Péremption des produits d’abattage : jour de l’abattage + 5 jours, paramétrés | Porteur du projet |
| 30/09/2026 | AV-026 | Remise interdite sans `sales.price.override` ; plafond par rôle (0 / 5 / 15 %), motif, validation au-delà | Porteur du projet |
| 30/09/2026 | AV-027 | Vente anonyme si intégralement payée | Porteur du projet |
| 30/09/2026 | AV-028 | Crédit aux clients autorisés dans leur plafond ; refus en ligne au-delà, validation a posteriori hors ligne | Porteur du projet |
| 30/09/2026 | AV-030 | Annulation seule ≤ 15 min, sinon validation ; caisse réputée ouverte jusqu'à P5 | Porteur du projet |
| 30/09/2026 | AV-031 | Vente au poids ou à l'unité par produit dès P4 | Porteur du projet |
| 30/09/2026 | AV-034 | Bon de livraison distinct, plusieurs livraisons partielles (ADR-028) | Porteur du projet |
| 30/09/2026 | AV-041 | Prix TTC, reçu simple, taxes à 0 | Porteur du projet |
| 30/09/2026 | AV-056 | Cinq moyens de paiement ; référence mobile money saisie, unique ; doublon mis de côté | Porteur du projet |
| 30/09/2026 | AV-063 | Vente hors ligne au prix figé ; anomalie `PRICE_MISMATCH` | Porteur du projet |
| 30/09/2026 | AV-126 | Commande hors ligne confirmée par le serveur à la synchronisation | Porteur du projet |
| 30/09/2026 | AV-127 | Stock insuffisant : vente du disponible, reste en commande en attente | Porteur du projet |
| 30/09/2026 | AV-128 | Reste non livré annulé par l'auteur ou le Resp. commercial, sans validation | Porteur du projet |
| 30/09/2026 | AV-129 | Échéance d'une vente sur commande depuis la confirmation | Porteur du projet |
| 30/09/2026 | AV-130 | Commande confirmée modifiable : contre-écriture et vente complémentaire automatiques | Porteur du projet |
| 13/10/2026 | AV-006 | Approbation d'un appareil par l'Admin ou par le responsable du site ou de l'équipe de l'utilisateur qui l'a connecté (AV-247) | Porteur du projet |
| 13/10/2026 | AV-017 | Cinq catégories de clients semées dès l'installation, configurables | Porteur du projet |
| 13/10/2026 | AV-154 | Sessions de caisse sans limite par jour (paramètre `finance.cash_sessions_per_day_max`, 0 = sans limite) ; une seule ouverte à la fois | Porteur du projet |
| 13/10/2026 | AV-246 | Réception d'achat au-delà du seuil de photo acceptée sans photo, marquée « photo manquante » et signalée, tant que l'application ne joint pas de photo | Porteur du projet |
| 13/10/2026 | AV-247 | Portée d'approbation d'un appareil neuf déduite des affectations de l'utilisateur qui l'a connecté | Porteur du projet |
| 13/10/2026 | AV-248 | Motifs de départ semés : résultats de visite, perte d'un prospect, annulation ; « Autre » avec commentaire | Porteur du projet |
| 13/10/2026 | AV-249 | Unités affichées en libellés courts au singulier et au pluriel | Porteur du projet |
| 13/10/2026 | AV-250 | Diagnostic « Tester la synchronisation » retiré de l'application | Porteur du projet |
| 13/10/2026 | AV-251 | Mot de passe provisoire : changement imposé par l'écran seulement, sans refus serveur (différent de la recommandation) | Porteur du projet |
| 13/10/2026 | AV-252 | Réinitialisation par l'Admin : mot de passe provisoire saisi par l'administrateur (différent de la recommandation) | Porteur du projet |
| 13/10/2026 | AV-253 | Appareil bloqué, perdu ou retiré : message distinct après un mot de passe correct ; compte suspendu : message générique | Porteur du projet |
| 13/10/2026 | AV-254 | Premier appareil d'administration approuvé par une commande d'installation sur le serveur | Porteur du projet |
| 13/10/2026 | AV-258 | Un responsable n'approuve ni ne débloque l'appareil qu'il a connecté ; l'Admin le peut | Porteur du projet |
| 13/10/2026 | AV-259 | Rattachement d'un appareil : site cible dans la portée de l'auteur | Porteur du projet |
| 13/10/2026 | AV-260 | Le site de rattachement d'un appareil compte dans la portée de son responsable | Porteur du projet |
| 13/10/2026 | AV-261 | Lecture des appareils accordée au Responsable production (portée SITE) | Porteur du projet |
| 14/10/2026 | AV-285 | Photo manquante d'une réception : fermeture automatique à la réception de la photo, et manuelle par le Resp. achats avec motif | Porteur du projet |
| 14/10/2026 | AV-286 | Les valideurs voient la photo dans l'application dès MP-10 (lecture protégée) | Porteur du projet |
| 14/10/2026 | AV-287 | Photos en attente non chiffrées pour l'instant ; chiffrement de tout le stockage local avant la production | Porteur du projet |
| 14/10/2026 | AV-288 | Photo d'une perte toujours facultative ; seule la mortalité l'exige | Porteur du projet |
| 14/10/2026 | AV-282 | Blocage immédiat : session, compte et appareil vérifiés à chaque requête, avec un cache de quelques secondes | Porteur du projet |
| 26/10/2026 | AV-068 | Phase P10 (intégration Kommo) reportée hors du périmètre : pas d'abonnement Kommo, CRM entièrement géré dans GIC ; AV-019 et AV-068 à AV-071 restent ouverts pour une reprise éventuelle | Porteur du projet |
