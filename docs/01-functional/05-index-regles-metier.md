# Index des règles métier

> Section 10 du format final (PM §48). **Fichier généré** par `python3 docs/_tools/check_refs.py --index` :
> ne pas éditer à la main. La règle fait foi dans son fichier de domaine ; ce tableau n'en donne qu'un résumé tronqué.

Nombre total de règles : **313**.

## D01 — Core / Administration (ADM)

Fichier : [`domaines/D01-ADM-core-administration.md`](domaines/D01-ADM-core-administration.md)

| ID | Règle (résumé) | Statut |
|---|---|---|
| BR-ADM-001 | L'identifiant de connexion est le numéro de téléphone normalisé au format E.164 (ex. `+2376XXXXXXXX`). Il est unique parmi les utilisateurs… | AV-008 |
| BR-ADM-002 | Un utilisateur désactivé ne peut plus s'authentifier. Ses opérations hors ligne dont `occurred_at` est antérieur à la désactivation restent… | D (CM §40 ; PM §30) |
| BR-ADM-003 | Une affectation de rôle a une date de début, une date de fin optionnelle et un périmètre (`GLOBAL`, `SITE`, `ZONE`, `TEAM`). La révoquer re… | C (PM §17) / D |
| BR-ADM-004 | Les droits d'une commande sont évalués à la date `occurred_at` : l'auteur devait détenir la permission et le périmètre à cet instant, et ni… | D (offline, ADR-008) |
| BR-ADM-005 | Un appareil `PENDING` permet de se connecter mais pas de créer d'opérations. Seul un appareil `ACTIVE` peut pousser des commandes. | AV-006 |
| BR-ADM-006 | Un appareil `BLOCKED` ou `LOST` voit toutes ses sessions révoquées. Les commandes reçues de cet appareil après la date de blocage sont mise… | D (PM §37) |
| BR-ADM-007 | Chaque appareil reçoit un code court unique (4 caractères alphanumériques), utilisé dans les références locales des documents. | D (ADR-002) |
| BR-ADM-008 | Un site a un type parmi `FERME`, `MAGASIN`, `POINT_DE_VENTE`, `BUREAU`. Un site fermé (`CLOSED`) n'accepte plus de nouvelles opérations ; s… | C (CM §12, §22) / D |
| BR-ADM-009 | Tout emplacement physique appartient à exactement un site. Un emplacement de type `MOBILE` a exactement un détenteur (`custodian_user_id`)… | D (CM §23, §39) |
| BR-ADM-010 | Les emplacements virtuels (`V_*`) sont créés par le système au démarrage, uniques par type, et ne peuvent être ni modifiés ni désactivés. | D (ADR-003) |
| BR-ADM-011 | Un emplacement ne peut être désactivé que si tous ses soldes sont nuls et qu'aucun transfert, réservation ou allocation n'y est en cours. | D (INV-STK-07) |
| BR-ADM-012 | Les zones forment un arbre sans cycle. Un géorepère est optionnel : point de référence + rayon, 500 m par défaut. | C (CM §10) / AV-003 |
| BR-ADM-013 | Modifier un géorepère n'affecte que les pointages futurs ; chaque tentative de pointage fige le géorepère utilisé. | C (PM §7) |
| BR-ADM-014 | Une équipe a un responsable. Un utilisateur appartient à au plus une équipe à une date donnée. Les appartenances sont historisées (début, f… | D (CM §6, §48) |
| BR-ADM-015 | Un paramètre système est historisé : toute modification crée une nouvelle valeur datée, et l'ancienne reste consultable. | C (PM §7) |
| BR-ADM-016 | La politique de contrôle applicable est celle en vigueur à `occurred_at`. Sa version est figée sur l'opération et sur la demande de validat… | C (PM §7) / D |
| BR-ADM-017 | L'approbateur d'une demande est différent du demandeur. Exception : `DIRECTION`, avec le marqueur `SELF_APPROVED`. Une décision est définit… | AV-010 |
| BR-ADM-018 | Approuver exige la permission d'approbation propre au type d'opération, sur un périmètre qui contient l'opération (ex. `inventory.loss.appr… | C (PM §31) |
| BR-ADM-019 | Une pièce justificative est immuable et identifiée par son empreinte SHA-256. La remplacer ajoute une nouvelle pièce ; l'ancienne est conse… | C (CM §40) / D |
| BR-ADM-020 | Une opération dont la politique exige une photo peut être enregistrée hors ligne avec la photo stockée localement. Si l'opération exige aus… | D (ADR-012) |
| BR-ADM-021 | Le numéro officiel d'un document est attribué par le serveur selon le format `{TYPE}-{CODE_SITE}-{AAAA}-{seq6}`, avec un compteur par type,… | AV-077 |
| BR-ADM-022 | La référence locale d'un document est attribuée par l'appareil : `{CODE_APPAREIL}-{seq}`, séquence strictement croissante par appareil. Ell… | D (ADR-002) |
| BR-ADM-023 | L'autonomie hors ligne d'un appareil expire 7 jours après la dernière synchronisation réussie. L'application passe alors en lecture seule j… | AV-009 |
| BR-ADM-024 | Le PIN local (6 chiffres) n'est jamais transmis au serveur. Après 5 échecs consécutifs, l'utilisateur doit se reconnecter en ligne avec son… | D (sécurité) |

## D02 — Commercial / CRM opérationnel (CRM)

Fichier : [`domaines/D02-CRM-commercial.md`](domaines/D02-CRM-commercial.md)

| ID | Règle (résumé) | Statut |
|---|---|---|
| BR-CRM-001 | Un compte client a un stade système parmi `PROSPECT`, `CUSTOMER`, `LOST`, `MERGED`. Les étapes de pipeline (configurables) ne s'appliquent… | C (CM §7) / D (stades) / AV-011 |
| BR-CRM-002 | Champs obligatoires à la création : nom affiché, zone, source, et au moins un moyen de retrouver le compte (téléphone ou position GPS). Tou… | D (CM §7, UX CM §49) |
| BR-CRM-003 | À la création : l'acquéreur est le créateur (ou le commercial désigné par un responsable) ; le titulaire initial est l'acquéreur s'il a un… | C (CM §7, §8) / D |
| BR-CRM-004 | L'acquéreur (`acquired_by_user_id`) et la date d'acquisition sont immuables. | C (CM §7) |
| BR-CRM-005 | Un compte a au plus un titulaire actif à tout instant. Les affectations sont historisées dans `crm.customer_assignments`, par périodes cont… | C (CM §8) |
| BR-CRM-006 | Le téléphone principal normalisé est unique parmi les comptes non `MERGED`. En ligne, une création en doublon est refusée et le serveur rép… | AV-014 |
| BR-CRM-007 | La fusion rattache le compte absorbé au compte conservé (`merged_into_id`, stade `MERGED`). Les visites, commandes et ventes gardent leur i… | D |
| BR-CRM-008 | Tout changement de stade ou d'étape est historisé (`from`, `to`, `occurred_at`, auteur, motif). | C (CM §7 « évolution du prospect ») |
| BR-CRM-009 | Passer au stade `LOST` exige un code motif (catégorie `PROSPECT_LOST`). Un compte `LOST` peut être rouvert en `PROSPECT`, ce qui est histor… | D (PM §24) |
| BR-CRM-010 | Un `PROSPECT` devient automatiquement `CUSTOMER` à sa première vente confirmée. `converted_at` = `occurred_at` de cette vente ; `first_sale… | AV-012 |
| BR-CRM-011 | Un `CUSTOMER` ne redevient jamais `PROSPECT`. Le qualificatif actif / inactif est calculé (aucune vente confirmée depuis N jours, N = 30 pa… | C (CM §9) / AV-013 |
| BR-CRM-012 | Une visite porte : compte, utilisateur, `occurred_at`, position GPS et précision si disponibles, distance au compte si le compte est géoloc… | C (CM §7, §10) / D |
| BR-CRM-013 | Une visite est rattachée automatiquement à la session de travail ouverte de l'utilisateur à `occurred_at`. Sans session, elle porte l'indic… | AV-023 |
| BR-CRM-014 | Si un compte n'a pas de position, la position de sa première visite (précision ≤ 50 m) est proposée comme position du compte ; l'utilisateu… | D (UX) |
| BR-CRM-015 | Une visite enregistrée à plus de 500 m (paramètre `crm.visit.max_distance_m`) de la position connue du compte porte l'indicateur `far_from_… | D (anti-fraude, CM §5.3) |
| BR-CRM-016 | Une visite ou une interaction synchronisée n'est plus modifiable. Pour corriger, on l'annule (`status = CANCELLED`, motif) et on en saisit… | C (CM §41) / D |
| BR-CRM-017 | Une interaction a un canal parmi `APPEL`, `SMS`, `EMAIL`, `AUTRE`. Les conversations WhatsApp et Kommo ne sont pas saisies dans GIC. | C (CM §44) / AV-019 |
| BR-CRM-018 | Un objectif est défini par une cible (`USER`, `TEAM`, `SITE`), une métrique, un produit optionnel, une période et une valeur. Deux objectif… | AV-016 |
| BR-CRM-019 | Les indicateurs de performance se calculent sur `occurred_at` des opérations et sur l'attribution figée sur chaque vente (`commercial_user_… | C (CM §8, §9) |
| BR-CRM-020 | Une réaffectation clôt l'affectation courante à l'instant T et en ouvre une nouvelle au même instant, avec motif obligatoire. Les ventes pa… | AV-015 |
| BR-CRM-021 | Les modifications de coordonnées et de position d'un compte sont auditées avec leurs valeurs avant et après. | C (CM §40) |
| BR-CRM-022 | Les conditions de crédit (`credit_allowed`, `credit_limit_xaf`, `payment_terms_days`) ne sont modifiables qu'avec `crm.customer.credit_mana… | AV-028 |
| BR-CRM-023 | Un compte créé ou rapproché depuis Kommo a la source `KOMMO` et un lien externe. Son titulaire est le commercial GIC mappé à l'utilisateur… | AV-069, AV-071 |
| BR-CRM-024 | Un commercial ne peut créer, modifier ou visiter que des comptes de son portefeuille, sauf les nouveaux comptes qu'il crée. Un responsable… | C (CM §48) |

## D03 — Pointage terrain (TER)

Fichier : [`domaines/D03-TER-pointage-terrain.md`](domaines/D03-TER-pointage-terrain.md)

| ID | Règle (résumé) | Statut |
|---|---|---|
| BR-TER-001 | Toute tentative de prise ou fin de service est enregistrée, acceptée ou refusée, avec : utilisateur, appareil, `occurred_at`, zone déclarée… | C (CM §10 ; PM §13) |
| BR-TER-002 | Résultat d'une prise de service. `ACCEPTED` si distance ≤ rayon du géorepère et précision ≤ précision maximale. `REJECTED_LOW_ACCURACY` si… | C (CM §10, 500 m) / AV-022 |
| BR-TER-003 | La distance est la distance orthodromique (haversine) entre la position et le point de référence du géorepère. Elle est calculée sur l'appa… | D (PM §37) |
| BR-TER-004 | Une prise de service `ACCEPTED` ouvre une session de travail `OPEN`. Un utilisateur a au plus une session non clôturée à la fois. | D |
| BR-TER-005 | Après un refus, l'utilisateur peut réessayer. Après 3 refus sur au moins 2 minutes, il peut demander une dérogation avec un motif obligatoi… | AV-021 |
| BR-TER-006 | La zone déclarée est choisie parmi les zones affectées à l'utilisateur (affectations de rôle de portée `ZONE`). Un utilisateur sans affecta… | D (CM §10) |
| BR-TER-007 | La fin de service est optionnelle. Elle enregistre une position ; un résultat hors zone est simplement signalé, jamais bloquant. | C (CM §10 « éventuellement ») / D |
| BR-TER-008 | Toute session non clôturée l'est automatiquement à 23:59 (heure de Douala), statut `AUTO_CLOSED` : sur l'appareil s'il est hors ligne, sino… | AV-023 |
| BR-TER-009 | Une nouvelle prise de service acceptée alors qu'une session est ouverte clôt la précédente à l'heure de la nouvelle, avec l'indicateur `sup… | D |
| BR-TER-010 | Le serveur lève le signal `CHECKIN_SUSPICIOUS` sur les motifs suivants : vitesse implicite > 150 km/h entre deux positions consécutives de… | D (limite L-02) |
| BR-TER-011 | Aucun suivi GPS continu. Une position n'est captée que lors d'une prise ou fin de service, d'une visite, d'une vente terrain, d'une opérati… | C (CM §10, §56) |
| BR-TER-012 | Les coordonnées et la précision sont conservées brutes, sans arrondi. | D (audit) |
| BR-TER-013 | Un commercial terrain sans prise de service un jour ouvré (lundi à samedi par défaut), ni visite, ni vente, déclenche l'alerte `INACTIVE_CO… | C (CM §54) / AV-065 |

## D04 — Commandes et ventes (VEN)

Fichier : [`domaines/D04-VEN-commandes-ventes.md`](domaines/D04-VEN-commandes-ventes.md)

| ID | Règle (résumé) | Statut |
|---|---|---|
| BR-VEN-001 | Une commande client exige un client identifié (pas de commande anonyme). | D (CM §7 « commandes » liées au prospect ou client) |
| BR-VEN-002 | Une commande passe à `CONFIRMED` par `sales.order.place` (engagement du client). L'état `DRAFT` n'existe côté serveur que pour une préparat… | D |
| BR-VEN-003 | Chaque ligne de commande fige un prix convenu (`quoted_unit_price_xaf`) résolu par le moteur de tarification au moment de la confirmation,… | C (CM §30) / D |
| BR-VEN-004 | À la confirmation, le serveur tente de réserver la quantité sur l'emplacement de préparation (`fulfilment_location_id`). Si le disponible e… | C (PM §6) / D |
| BR-VEN-005 | Une commande n'est modifiable (quantités, produits, date, lieu) que tant qu'aucune livraison n'a eu lieu. Toute modification contrôle la ve… | D (PM §30 « commande modifiée ») |
| BR-VEN-006 | Livrer une commande crée une vente de type `ORDER_FULFILMENT` portant la référence de la commande, le livreur, l'heure réelle de remise et… | AV-024, AV-034 |
| BR-VEN-007 | À la livraison, le prix appliqué est le prix convenu de la ligne de commande (`price_source = ORDER_QUOTE`). | AV-087 |
| BR-VEN-008 | La quantité livrée cumulée d'une ligne ne peut pas dépasser la quantité commandée. Une remise supplémentaire est une vente directe distinct… | D (INV-VEN-04) |
| BR-VEN-009 | L'annulation d'une commande (avant toute livraison) ou la clôture de son reliquat libère les réservations correspondantes. Les acomptes dev… | D / AV-033 |
| BR-VEN-010 | Un transfert préparé pour une commande (ex. vers le stock mobile du livreur) référence la commande ; son expédition transfère la réservatio… | D (ADR-004) |
| BR-VEN-011 | Une vente naît à l'état `CONFIRMED` : elle représente un fait accompli (produits remis). Aucune vente « brouillon » n'est synchronisée ; un… | D (C-05) |
| BR-VEN-012 | Une vente confirmée est immuable. Toute correction passe par une annulation (contre-écriture), suivie si besoin d'une nouvelle vente. | C (CM §41 ; PM §8) |
| BR-VEN-013 | Chaque ligne de vente fige : produit (et son libellé), lot, quantité en unité de saisie et en unité de base, quantité de tarification (poid… | C (CM §30 ; PM §9) |
| BR-VEN-014 | Le montant de ligne est l'arrondi au franc (demi supérieur) de quantité de tarification × prix appliqué − remise. Le total de la vente est… | AV-060 |
| BR-VEN-015 | Une dérogation de prix exige la permission `sales.price.override`. Elle doit rester dans le plafond de remise du rôle et porter un code mot… | AV-026 |
| BR-VEN-016 | Les effets stock d'une vente sont des mouvements de l'emplacement source vers `V_CUSTOMER`, un par ligne et par lot. Le lot est choisi auto… | C (CM §13) / AV-036 |
| BR-VEN-017 | Emplacement source d'une vente directe : l'emplacement de vente du PDV pour un vendeur ; le stock mobile pour un commercial ; l'emplacement… | C (CM §23) / D |
| BR-VEN-018 | En ligne, une vente n'est acceptée que si la quantité est disponible pour le vendeur : solde − réservations − allocations d'autres détenteu… | C (CM §39) / AV-025 |
| BR-VEN-019 | Une vente hors ligne réellement effectuée est toujours appliquée à la synchronisation, même si le solde serveur est insuffisant. Dans ce ca… | D (C-08 ; INV-STK-05) |
| BR-VEN-020 | Attribution figée sur chaque vente. `seller_user_id` = l'utilisateur qui enregistre. `commercial_user_id` = pour une vente sur commande, le… | C (CM §8, §13) / D |
| BR-VEN-021 | Le canal (`channel_code`) est déduit du contexte : vente de PDV → `POINT_DE_VENTE` ; commercial terrain en session → `TERRAIN` ; commercial… | C (CM §11) / D |
| BR-VEN-022 | La zone de la vente (`zone_id`) est figée : zone du site pour une vente en PDV, zone du client sinon, à défaut zone de la session de travai… | C (PM §7) / D |
| BR-VEN-023 | Les paiements saisis avec la vente créent des encaissements affectés à la vente, dans la même transaction. Le reste dû constitue une créanc… | C (CM §13) / AV-028 |
| BR-VEN-024 | Une vente anonyme (sans client) doit être intégralement payée à l'enregistrement. | AV-027 |
| BR-VEN-025 | Une vente à crédit exige un client autorisé au crédit, avec un encours après vente ≤ plafond. Hors ligne, le contrôle porte sur l'encours c… | AV-028 |
| BR-VEN-026 | Le statut de paiement (`UNPAID`, `PARTIALLY_PAID`, `PAID`) est dérivé des affectations actives de paiement et n'est jamais saisi. | D (C-05) |
| BR-VEN-027 | Annuler une vente produit : les mouvements inverses (de `V_CUSTOMER` vers l'emplacement d'origine, même lot, même coût unitaire) ; la resti… | C (CM §41) / D |
| BR-VEN-028 | L'annulation directe (sans validation) n'est permise qu'au vendeur de la vente, moins de 15 minutes après `occurred_at`, et si la session d… | AV-030 |
| BR-VEN-029 | Pour une vente hors ligne, si le prix figé diffère du prix que le serveur aurait résolu à `occurred_at` avec les règles alors actives, la v… | AV-063 |
| BR-VEN-030 | Une vente d'un produit désactivé est acceptée si elle a été capturée hors ligne avant la réception de la désactivation, avec une anomalie ;… | AV-083 |
| BR-VEN-031 | Une ligne de produit de type `SERVICE` (ex. frais de livraison) n'a aucun effet de stock. | AV-085 |
| BR-VEN-032 | Taxes : les colonnes de taxe existent avec un taux de 0 ; les prix sont TTC. | AV-041 |

## D05 — Distribution et points de vente (DIS)

Fichier : [`domaines/D05-DIS-distribution-points-de-vente.md`](domaines/D05-DIS-distribution-points-de-vente.md)

| ID | Règle (résumé) | Statut |
|---|---|---|
| BR-DIS-001 | Un PDV est un site de type `POINT_DE_VENTE`. Il a exactement un emplacement de vente par défaut (type `POS`) et un compte de caisse de type… | C (CM §12) / D |
| BR-DIS-002 | Mode de garde de l'emplacement de vente (BR-STK-010) : `EXCLUSIVE_DEVICE` si le PDV fonctionne avec un seul appareil désigné (recommandé pa… | D (CM §39) / AV-035 |
| BR-DIS-003 | Les vendeurs d'un PDV sont les utilisateurs qui ont le rôle `VENDEUR_PDV` avec une portée `SITE` sur ce PDV. Un vendeur ne vend que dans le… | C (CM §12) / D |
| BR-DIS-004 | Les prix du PDV sont résolus par le moteur de tarification avec le contexte du PDV : PDV > zone du PDV > zones parentes > global (D10). | C (CM §12, §29) |
| BR-DIS-005 | Un encaissement en espèces au PDV exige une session de caisse ouverte. Sans session ouverte, l'écran de vente propose d'abord « Ouvrir la c… | AV-057 |
| BR-DIS-006 | Au plus une session ouverte par compte de caisse. Une session ouverte depuis plus de 24 h déclenche une alerte. | D |
| BR-DIS-007 | À la clôture, le vendeur compte les espèces. Solde attendu = fonds d'ouverture + encaissements espèces + autres entrées − remboursements −… | C (CM §54 « anomalie de caisse ») / AV-057 |
| BR-DIS-008 | Une session validée est immuable. Une vente hors ligne tardive rattachée à une session validée ouvre un écart complémentaire, lui aussi à v… | D |
| BR-DIS-009 | La remise de fonds se fait en deux temps : envoi (sortie de la caisse PDV) puis réception (entrée dans la caisse centrale ou en banque). Un… | D |
| BR-DIS-010 | Indicateurs de distribution par PDV × produit × période (sur `occurred_at`) : envoyé = Σ quantités expédiées vers le PDV ; reçu = Σ quantit… | C (CM §12, §2/Distribution) / D (formules) |
| BR-DIS-011 | La suggestion de réapprovisionnement ne crée jamais de transfert automatiquement : un humain crée la demande ou l'expédition. | D (CM §54 « provoquer une action ») |
| BR-DIS-012 | Les retours vers le magasin et les transferts entre PDV sont des transferts ordinaires (BR-STK-020). | C (CM §22) |
| BR-DIS-013 | Les petites dépenses payées depuis la caisse du PDV sont permises pour les catégories autorisées et sous un plafond. Elles diminuent le sol… | AV-058 |
| BR-DIS-014 | Le changement d'appareil désigné d'un PDV `EXCLUSIVE_DEVICE` exige que l'ancien appareil ait tout synchronisé ou ait été révoqué (BR-STK-01… | D |

## D06 — Stocks (STK)

Fichier : [`domaines/D06-STK-stocks.md`](domaines/D06-STK-stocks.md)

| ID | Règle (résumé) | Statut |
|---|---|---|
| BR-STK-001 | Toute variation de stock est un mouvement : produit, quantité strictement positive en unité de base, emplacement source, emplacement destin… | C (CM §21 ; PM §6) |
| BR-STK-002 | Un mouvement est immuable. Pour le corriger, on crée un mouvement inverse (`is_reversal = true`, `reverses_move_id`), toujours issu d'un do… | C (CM §41 ; PM §8) |
| BR-STK-003 | Les origines et destinations externes sont des emplacements virtuels : `V_SUPPLIER`, `V_CUSTOMER`, `V_PRODUCTION`, `V_CONSUMPTION`, `V_LOSS… | D (ADR-003) |
| BR-STK-004 | Le solde d'un emplacement × produit × lot = Σ quantités entrantes − Σ quantités sortantes. `stock_balances` est une projection mise à jour… | C (PM §6) |
| BR-STK-005 | Le solde peut être calculé à une date métier (Σ des mouvements de `occurred_at` ≤ date). C'est la base des inventaires et des analyses hist… | D (CM §38) |
| BR-STK-006 | Types de mouvement autorisés, avec leur couple (source → destination) : voir la table §7.7. Tout autre couple est refusé. | D |
| BR-STK-010 | Chaque emplacement physique a un mode de garde : `EXCLUSIVE_USER` (stock mobile, utilisable hors ligne par son détenteur sur son appareil p… | D (CM §39 ; ADR-004) |
| BR-STK-011 | Disponible pour un consommateur C sur un emplacement `SHARED` = solde − réservations actives − allocations actives restantes des autres dét… | D |
| BR-STK-012 | Une allocation (`DEVICE_QUOTA`) est accordée en ligne à un couple (utilisateur, appareil) sur un emplacement `SHARED`, pour un produit et é… | C (CM §39) / AV-035 |
| BR-STK-013 | Toute opération qui réduit le stock (vente, perte, transfert sortant, consommation) faite par le détenteur d'une allocation sur l'emplaceme… | AV-025 |
| BR-STK-014 | Une allocation est libérée par l'appareil détenteur (libération confirmée à la synchronisation) ou révoquée par un responsable. Une révocat… | AV-035 |
| BR-STK-015 | Une réservation (`ORDER_RESERVATION`) est créée par la confirmation d'une commande. Elle est consommée par la livraison et libérée par l'an… | C (PM §6) / D |
| BR-STK-016 | Le stock d'un emplacement `EXCLUSIVE_USER` n'est utilisable hors ligne que sur l'appareil principal du détenteur. Le changement d'appareil… | D (ADR-004) |
| BR-STK-017 | En ligne, aucune opération ne peut rendre négatif le disponible d'un emplacement physique (`INSUFFICIENT_STOCK`). | C (PM §6) |
| BR-STK-018 | Une opération hors ligne constatant un fait physique (vente, perte, consommation, transfert sortant) est appliquée même si le solde serveur… | D (C-08) |
| BR-STK-020 | Un transfert entre deux emplacements physiques distincts suit deux temps. Expédition : source → `V_TRANSIT`, par l'expéditeur, à l'heure ré… | C (CM §22) |
| BR-STK-021 | Écart = quantité expédiée − quantité reçue. Un écart positif est déplacé de `V_TRANSIT` vers `V_PENDING_LOSS` avec la catégorie `ECART_TRAN… | C (CM §22 « différences ») / AV-082 |
| BR-STK-022 | Un déplacement interne immédiat (même site, même responsable, ex. case → case, bâtiment → magasin de ferme) est un transfert de type `INTER… | D |
| BR-STK-023 | L'affectation de stock à un commercial ou vendeur (CM §23) est un transfert vers son emplacement `MOBILE`. Il en est responsable jusqu'à ve… | C (CM §23) |
| BR-STK-024 | Une réception sans document (le transfert n'est pas encore téléchargé sur l'appareil destinataire) n'est permise que sur un emplacement exc… | D (CM §37, §39) |
| BR-STK-025 | Un transfert ne peut être annulé qu'avant expédition. Après expédition, seul un transfert retour le neutralise. | C (CM §41) |
| BR-STK-026 | Une demande de réapprovisionnement (`REQUESTED`) est satisfaite par l'expédition de l'emplacement fournisseur, qui peut expédier une quanti… | AV-081 |
| BR-STK-030 | Une déclaration de perte porte : catégorie (`MORTALITE`, `CASSE`, `DETERIORATION`, `IMPROPRE`, `DESTRUCTION`, `INEXPLIQUEE`, `VOL_SUSPECTE`… | C (CM §24) / D (un produit) |
| BR-STK-031 | La politique de contrôle en vigueur (catégorie, quantité, valeur) détermine si une photo, un commentaire ou une validation sont requis. | C (CM §24, §42) / AV-037, AV-048 |
| BR-STK-032 | Perte sans validation requise : mouvement emplacement → `V_LOSS`, statut `RECORDED`. Perte avec validation requise : mouvement emplacement… | D (ADR-003) |
| BR-STK-033 | Approbation : `V_PENDING_LOSS` → `V_LOSS`, statut `APPROVED`. Rejet, selon la décision : `ERREUR_DECLARATION` → retour `V_PENDING_LOSS` → e… | AV-038 |
| BR-STK-034 | Une perte `RECORDED` ne peut être annulée que par une annulation soumise à validation (`inventory.loss.approve`), qui crée le mouvement inv… | C (CM §41) |
| BR-STK-035 | La valeur d'une perte = quantité × coût unitaire figé sur le mouvement. Pour un produit biologique de lot, c'est une valeur économique indi… | C (CM §16, §32) / AV-042 |
| BR-STK-036 | Une consommation déplace un intrant de son emplacement vers `V_CONSUMPTION` et l'impute à un objet de coût : lot de production, lot d'incub… | C (CM §4 « coût d'un lot », §21) |
| BR-STK-040 | Un inventaire porte sur un emplacement, pour tous les produits ou une sélection. Chaque ligne donne le produit (et le lot pour les produits… | C (CM §25) |
| BR-STK-041 | L'activité n'est pas bloquée pendant un inventaire : la vérité physique est fixée à `counted_at`. | D (UX, offline) |
| BR-STK-042 | À la soumission, le serveur calcule le théorique à `counted_at` (BR-STK-005) et l'écart = compté − théorique. Un écart est toujours conserv… | C (CM §25, §60) |
| BR-STK-043 | Si la valeur absolue totale des écarts est sous le seuil, l'inventaire est comptabilisé automatiquement ; sinon il passe `PENDING_APPROVAL`… | C (CM §25) / AV-039 |
| BR-STK-044 | Rapprochement tardif : si un mouvement de `occurred_at` ≤ `counted_at` est appliqué après la comptabilisation, le serveur crée un ajustemen… | D (offline ; INV-STK-09) |
| BR-STK-045 | Pour un produit à lot au point de vente, l'écart d'un produit compté sans lot est réparti sur les lots en FIFO inverse (les plus récents d'… | D |
| BR-STK-046 | Un inventaire d'ouverture (`OPENING`) a un théorique nul ; ses mouvements partent de `V_OPENING`, avec un coût unitaire déclaré. Un emplace… | D (AV-072) |
| BR-STK-050 | Pour un produit à suivi par lot `REQUIRED`, tout mouvement porte un lot. Pour `OPTIONAL`, le lot est porté s'il est connu. Pour `NONE`, jam… | AV-036 |
| BR-STK-051 | Un seuil (minimum, cible) par emplacement × produit déclenche `STOCK_LOW` si disponible < minimum, et `STOCK_OUT` si disponible ≤ 0. La qua… | C (CM §12, §54) / AV-040 |
| BR-STK-052 | Tout mouvement porte le coût unitaire en vigueur au moment de son application : CMUP courant du produit ; ou coût du lot par tête pour un p… | AV-042 |
| BR-STK-053 | Le CMUP d'un produit est recalculé à chaque entrée valorisée (réception, ouverture, gain d'inventaire valorisé), selon l'ordre d'applicatio… | AV-042 |
| BR-STK-054 | La valeur d'un stock = Σ (solde × coût unitaire courant), par produit ou par produit × lot. Elle n'est visible qu'avec `inventory.valuation… | C (CM §48 « magasinier sans finance ») |

## D07 — Production (PRD) : tronc commun, volaille (VOL), œufs (OEU), incubation (INC), porcs (POR)

Fichier : [`domaines/D07-PRD-production.md`](domaines/D07-PRD-production.md)

| ID | Règle (résumé) | Statut |
|---|---|---|
| BR-PRD-001 | Un lot a un type (`POULET_CHAIR`, `PONDEUSE`, `PORC_ENGRAISSEMENT`, options activables `REPRODUCTEUR_VOLAILLE`, `PORC_NAISSAGE`), un produi… | C (CM §15, §19) / AV-044 |
| BR-PRD-002 | La création d'un lot crée son lot de traçabilité (`inventory.stock_lots`, origine `PRODUCTION_LOT`). Tous les mouvements des animaux du lot… | D (CM §58) |
| BR-PRD-003 | L'effectif d'un lot n'est jamais saisi : c'est la somme des soldes de son lot de traçabilité. On distingue l'effectif en élevage (emplaceme… | C (CM §15 ; REQ-029) |
| BR-PRD-004 | Une entrée de lot est une mise en place (`PLACEMENT`), une naissance (`BIRTH`) ou un transfert entrant (`TRANSFER_IN`). Mise en place à par… | C (CM §15) / D |
| BR-PRD-005 | La mortalité est une déclaration de perte de catégorie `MORTALITE` rattachée au lot et à l'emplacement (D06, BR-STK-030). Elle est saisie d… | C (CM §16) / AV-048 |
| BR-PRD-006 | Le seuil relatif de mortalité se calcule sur l'effectif en élevage du lot à `occurred_at`, par l'appareil (approximation locale) puis par l… | D (PM §37) |
| BR-PRD-007 | Une consommation d'intrant pour un lot est une consommation (D06, BR-STK-036) dont l'objet de coût est le lot. Sa valeur (quantité × coût u… | C (CM §4, §15, §33) |
| BR-PRD-008 | La saisie du jour d'un lot est un écran unique qui émet des commandes distinctes (mortalité, consommation, pesée, collecte, observation). C… | C (CM §49) / D |
| BR-PRD-009 | Les statuts d'un lot sont `PLANNED` → `ACTIVE` (première entrée) → `SELLING` (animaux déclarés prêts ou disponibles à la vente) → `CLOSED`.… | D (SM-PRODUCTION-LOT) |
| BR-PRD-010 | Seuls les animaux d'un lot `SELLING` peuvent être vendus directement depuis un emplacement d'élevage. Les transferts vers un emplacement co… | C (CM §15, §2 « prêts à la vente ») / D |
| BR-PRD-011 | Un lot ne peut être clôturé qu'avec un effectif non vendu nul. La clôture fige les indicateurs finaux (mortalité cumulée, coût total, CA at… | D |
| BR-PRD-012 | Le coût du lot = Σ `inventory.cost_entries` de l'objet lot : animaux d'origine, intrants consommés, dépenses directement imputées. Coût par… | C (CM §15, §33) / AV-042, AV-043 |
| BR-PRD-013 | La mortalité ne réduit pas le coût du lot : elle le répartit sur un effectif plus faible (hausse du coût par tête). Sa « valeur économique… | C (CM §16) |
| BR-PRD-014 | Marge d'un lot = CA des ventes portant le lot − coût du lot imputable aux têtes vendues. Pour un lot clôturé : CA total − coût total. | C (CM §33) / D |
| BR-PRD-015 | Une pesée enregistre la taille d'échantillon, le poids moyen (g) et, optionnellement, le poids total ; elle n'a aucun effet de stock. | C (CM §15, §19) |
| BR-VOL-001 | Un lot `POULET_CHAIR` a pour produit « Poulet de chair vif », compté à la tête. Sa mise en place provient de « Poussin d'un jour (chair) »… | C (CM §15) / D |
| BR-VOL-002 | La sortie vers commercialisation est un transfert du bâtiment vers un magasin, un PDV ou un stock mobile, qui porte le lot et le coût par t… | C (CM §15) |
| BR-VOL-003 | Au MVP, le poulet est vendu vif ; l'abattage et la transformation ne sont pas modélisés. | AV-032 |
| BR-OEU-001 | Une collecte d'œufs d'un lot `PONDEUSE` pour une date donne : collectés, cassés, non conformes, commercialisables, à couver. Invariant : co… | C (CM §17) |
| BR-OEU-002 | Effets stock d'une collecte : `PRODUCTION_OUTPUT` de « Œuf de consommation » (quantité commercialisable) et de « Œuf à couver » (quantité à… | C (CM §17 « le stock d'œufs commercialisables doit résulter de ces événements ») / AV-046 |
| BR-OEU-003 | Un œuf cassé après son entrée en stock (manutention, transport, PDV) est une perte de catégorie `CASSE` (D06). | C (CM §24) |
| BR-OEU-004 | Une seule collecte par lot et par date (collecte journalière consolidée). Une correction passe par l'annulation de la collecte (mouvements… | D |
| BR-OEU-005 | Unité de base : l'œuf. Le plateau (30 œufs) est une unité de conditionnement pour la vente et le comptage. | AV-046, AV-080 |
| BR-OEU-006 | Des catégories supplémentaires (calibres, œufs déclassés vendables) s'ajoutent comme nouveaux produits et nouveaux champs de collecte, sans… | C (CM §17 « d'autres classifications ») |
| BR-OEU-007 | Coût des œufs produits : coût standard par produit au MVP. Le coût réel se lit au niveau du lot de pondeuses (coût du lot ÷ œufs produits). | AV-042 |
| BR-INC-001 | Un lot d'incubation est constitué d'œufs à couver issus du stock (production interne ou achat réceptionné) ; il crée son lot de traçabilité… | C (CM §18) / AV-047 |
| BR-INC-002 | Démarrage : déplacement interne des œufs à couver du stockage vers l'emplacement `INCUBATOR` ; `eggs_set_qty` est figé. | C (CM §18) |
| BR-INC-003 | Mirage : les infertiles et la mortalité embryonnaire sortent de l'incubateur vers `V_PRODUCTION` (`PRODUCTION_INPUT`, motifs `INFERTILE`, `… | C (CM §18) / D |
| BR-INC-004 | Transfert vers l'éclosoir : déplacement interne incubateur → `HATCHER` des œufs restants. | C (CM §18) |
| BR-INC-005 | Éclosion : les œufs restants sortent vers `V_PRODUCTION` (`PRODUCTION_INPUT`) ; les poussins viables entrent en stock (`PRODUCTION_OUTPUT`… | C (CM §18) |
| BR-INC-006 | Invariant de bilan : œufs incubés = infertiles + mortalité embryonnaire + pertes accidentelles + non éclos + poussins éclos (viables + non… | C (CM §18 « relier la quantité d'œufs engagés au résultat ») |
| BR-INC-007 | Taux d'éclosion = poussins éclos viables ÷ œufs incubés. Indicateur secondaire : ÷ œufs fertiles (incubés − infertiles). | C (CM §18) / D |
| BR-INC-008 | Les durées (jour de mirage, jour de transfert, jour d'éclosion attendu) sont des paramètres par espèce ; ils alimentent l'échéancier et les… | AV-047 |
| BR-INC-009 | Coût des poussins produits = coût des œufs engagés + intrants imputés au lot d'incubation, divisé par le nombre de poussins viables (valeur… | D / AV-043 |
| BR-POR-001 | Suivi par groupe (lot `PORC_ENGRAISSEMENT`) réparti sur une ou plusieurs cases (`PEN`). L'effectif par case est le solde par emplacement. | C (CM §19) |
| BR-POR-002 | Entrées : achat (réception + reclassement), transfert entrant, naissance (`BIRTH`, si le naissage est activé). | C (CM §19 « entrée ») / AV-045 |
| BR-POR-003 | Déplacement entre cases : déplacement interne (BR-STK-022). | C (CM §19 « transfert ») |
| BR-POR-004 | Vente : à la tête avec poids optionnel, ou au kilo vif selon le mode de tarification du produit (D04, BR-VEN-013). | AV-031 |
| BR-POR-005 | L'identification individuelle n'est pas au MVP ; l'extension `production.animals` est décrite dans le modèle de données mais non créée. | C (CM §19 ; PM §10) |

## D08 — Approvisionnement : fournisseurs, achats, réceptions (APP)

Fichier : [`domaines/D08-APP-approvisionnement.md`](domaines/D08-APP-approvisionnement.md)

| ID | Règle (résumé) | Statut |
|---|---|---|
| BR-APP-001 | Un fournisseur a un code unique, un nom, les catégories de produits qu'il fournit, des contacts, un délai de paiement et un statut (`ACTIVE… | C (CM §26) / D |
| BR-APP-002 | Une demande d'achat porte : demandeur, site bénéficiaire, date de besoin, justification, et des lignes (produit, quantité, prix estimé opti… | C (CM §27) / D |
| BR-APP-003 | Toute demande d'achat soumise exige une validation (`procurement.request.approve`), par le Resp. achats ou la Direction, distinct du demand… | AV-051, AV-010 |
| BR-APP-004 | Une demande approuvée peut être couverte par un ou plusieurs BC, entièrement ou partiellement ; ses lignes suivent la quantité commandée. | D |
| BR-APP-005 | Un BC porte : fournisseur actif, emplacement de livraison, lignes (produit, quantité, prix unitaire XAF), total, date de livraison prévue.… | C (CM §26, §27) / AV-051 |
| BR-APP-006 | Une fois envoyé (`SENT`), un BC n'est plus augmenté : on peut seulement réduire ou clôturer le reliquat, ou annuler les lignes non reçues.… | D (CM §30 « ne pas réécrire ») |
| BR-APP-007 | Une ligne de réception porte : quantité livrée, quantité rejetée (avec motif), quantité acceptée = livrée − rejetée, lot fournisseur et dat… | C (CM §28) |
| BR-APP-008 | La réception fige le coût unitaire d'entrée : prix de la ligne de BC, ou prix déclaré pour une réception sans BC. Ce coût alimente le CMUP… | C (CM §32) / AV-042 |
| BR-APP-009 | Reliquat d'une ligne de BC = quantité commandée − Σ quantités acceptées. Un BC est `PARTIALLY_RECEIVED` tant qu'un reliquat existe, `RECEIV… | C (CM §27) / D |
| BR-APP-010 | Une acceptation cumulée supérieure à la quantité commandée est refusée en ligne (tolérance 0 par défaut). Hors ligne, la réception est appl… | AV-053 |
| BR-APP-011 | Une réception sans BC est autorisée : fournisseur, prix déclaré et justificatif obligatoires. Le stock entre immédiatement ; la réception r… | AV-052 |
| BR-APP-012 | Une réception suspectée d'être un doublon (même numéro de bon de livraison fournisseur déjà reçu pour ce fournisseur, ou acceptation cumulé… | D (PM §30 « réception en double ») |
| BR-APP-013 | Annuler une réception comptabilisée exige une validation et crée les mouvements inverses. C'est impossible si le stock concerné n'est plus… | C (CM §41) / D |
| BR-APP-014 | Une photo du bon de livraison est requise selon la politique de contrôle (par défaut : toute réception sans BC, et toute réception de valeu… | C (CM §42) / AV-037 |
| BR-APP-015 | Alerte `RECEIPT_INCOMPLETE` : BC dont la date prévue est dépassée de plus de 2 jours avec un reliquat, ou réception comportant une quantité… | C (CM §54) / AV-065 |
| BR-APP-016 | L'achat d'animaux vivants (poussins, porcelets) se réceptionne directement dans un bâtiment et peut déclencher la mise en place d'un lot da… | D |

## D09 — Finance opérationnelle (FIN)

Fichier : [`domaines/D09-FIN-finance.md`](domaines/D09-FIN-finance.md)

| ID | Règle (résumé) | Statut |
|---|---|---|
| BR-FIN-001 | Un encaissement porte : montant > 0 (XAF entiers), moyen de paiement, `occurred_at`, utilisateur qui reçoit, compte de trésorerie crédité,… | C (CM §31) / D |
| BR-FIN-002 | Le compte crédité est déduit du contexte : caisse du PDV (espèces au PDV), caisse de l'utilisateur (espèces reçues par un commercial terrai… | D |
| BR-FIN-003 | Σ affectations actives d'un encaissement ≤ son montant ; Σ affectations actives sur une vente ≤ son total. La part non affectée d'un encais… | D |
| BR-FIN-004 | Un règlement saisi sans vente précise s'affecte automatiquement aux ventes impayées du client, de la plus ancienne échéance à la plus récen… | D |
| BR-FIN-005 | Le couple (moyen de paiement, référence externe) est unique. Un doublon reçu est mis en `SUSPECT_DUPLICATE`, sans mouvement de trésorerie n… | D (PM §30 « paiement en double ») / AV-056 |
| BR-FIN-006 | Un encaissement n'est jamais supprimé. Son annulation (validation requise) crée le mouvement de trésorerie inverse et désactive ses affecta… | C (CM §41) |
| BR-FIN-007 | Créance d'une vente = total − Σ affectations actives. Échéance = `due_date` de la vente. Une créance est en retard si la date du jour dépas… | C (CM §13, §54) / AV-028 |
| BR-FIN-008 | Un acompte est un encaissement affecté à une commande. À la livraison, son affectation est transférée vers la vente créée : affectation com… | AV-033 |
| BR-FIN-010 | Types de compte de trésorerie : `CAISSE_PDV`, `CAISSE_UTILISATEUR`, `CAISSE_CENTRALE`, `MOBILE_MONEY`, `BANQUE`. Chaque compte a un respons… | C (CM §12, §31) / D |
| BR-FIN-011 | Tout flux d'argent est un mouvement de trésorerie en ajout seul : compte, sens (`IN` / `OUT`), montant > 0, type (`CUSTOMER_PAYMENT`, `REFU… | D (CM §31, §41) |
| BR-FIN-012 | En ligne, une sortie ne peut rendre négatif le solde d'une caisse physique (`CAISSE_*`). Hors ligne, elle est appliquée et produit l'anomal… | D |
| BR-FIN-013 | Une remise de fonds se fait en deux temps : `TRANSFER_OUT` à l'envoi, `TRANSFER_IN` à la réception. Un écart ouvre `CASH_TRANSFER_DISCREPAN… | D |
| BR-FIN-014 | Session de caisse : voir D05 (BR-DIS-005 à BR-DIS-008). À l'ouverture, un fonds compté différent du solde du compte produit un mouvement `S… | AV-057 |
| BR-FIN-020 | Une dépense porte : catégorie, montant, `occurred_at` (date de la charge), bénéficiaire, description, objet de coût optionnel (lot de produ… | C (CM §31, §42) / AV-058 |
| BR-FIN-021 | Payée immédiatement : le mouvement de trésorerie `EXPENSE` est enregistré tout de suite (fait accompli) ; la validation, si requise, est a… | D |
| BR-FIN-022 | Une dépense imputée à un objet de coût crée une écriture de coût (`inventory.cost_entries`) à son approbation, ou dès l'enregistrement si a… | D |
| BR-FIN-030 | Une facture fournisseur porte : fournisseur, référence du fournisseur (unique par fournisseur), date, échéance, montant total, lignes ratta… | C (CM §26, §27) |
| BR-FIN-031 | Rapprochement à l'enregistrement : quantité facturée ≤ quantité acceptée, prix facturé = prix du BC. Tout écart met la facture en `MISMATCH… | C (CM §26 « écarts ») / AV-053 |
| BR-FIN-032 | Dette fournisseur = Σ factures approuvées − Σ affectations de paiements fournisseurs. Un paiement non affecté est une avance fournisseur. | C (CM §32) / AV-055 |
| BR-FIN-033 | Un paiement fournisseur au-delà du seuil (500 000 XAF) exige l'approbation de la Direction avant le décaissement. | AV-055 |
| BR-FIN-040 | Le registre de coûts (`inventory.cost_entries`, module `inventory`) est en ajout seul. Chaque écriture porte : objet de coût, type de coût… | C (CM §15, §33) / D |
| BR-FIN-041 | Sources d'écritures de coût : consommations imputées à un lot et mises en place (écrites par `inventory` dans la transaction du mouvement)… | D |
| BR-FIN-042 | CA d'une période = Σ montants des ventes dont `occurred_at` est dans la période − Σ montants des ventes annulées dont l'annulation est dans… | C (CM §30, §41) / D |
| BR-FIN-043 | Coût des ventes = Σ (quantité × coût unitaire figé) des mouvements `SALE` − ceux de leurs inverses, sur les mêmes principes de date. Marge… | C (CM §31) / D |
| BR-FIN-044 | Valeur des pertes = Σ (quantité × coût unitaire figé) des mouvements vers `V_LOSS` et des ajustements d'inventaire négatifs. Pour les produ… | C (CM §32) |
| BR-FIN-045 | Tous les montants sont en XAF entiers ; aucune conversion de devise. | D (ADR-013) |
| BR-FIN-046 | Pas de clôture de période verrouillant la saisie au MVP. La fenêtre de saisie rétroactive (AV-078) et l'immuabilité des sessions de caisse… | AV-088 |

## D10 — Tarification (PRX)

Fichier : [`domaines/D10-PRX-tarification.md`](domaines/D10-PRX-tarification.md)

| ID | Règle (résumé) | Statut |
|---|---|---|
| BR-PRX-001 | Une règle tarifaire porte : produit (obligatoire), prix unitaire en XAF entiers, unité de tarification (unité de base, unité de conditionne… | C (CM §29 ; PM §9) |
| BR-PRX-002 | Plusieurs règles peuvent exister simultanément pour un même produit. | C (PM §9) |
| BR-PRX-003 | Une règle candidate pour un contexte : même produit ; statut `ACTIVE` ; `valid_from` ≤ `occurred_at` < `valid_to` ; chaque dimension rensei… | D (PM §9) |
| BR-PRX-004 | Choix entre candidates, dans l'ordre : priorité la plus haute ; puis spécificité la plus haute ; puis quantité minimale la plus haute ; pui… | D (PM §9) |
| BR-PRX-005 | Spécificité = Σ des poids des dimensions renseignées : site 32 ; catégorie de client 16 ; zone 3 × profondeur (1 à 4, donc 3 à 12) ; canal… | D / AV-061 |
| BR-PRX-006 | Conflit interdit : l'activation est refusée (`PRICE_RULE_CONFLICT`) si une autre règle active du même produit, de même priorité et de même… | D (PM §9 « conflits entre règles ») |
| BR-PRX-007 | Une règle active est immuable, sauf pour avancer sa date de fin. Changer un prix = activer une nouvelle règle qui remplace l'ancienne (`sup… | C (CM §30 ; PM §7) |
| BR-PRX-008 | Aucune règle n'est supprimée. Un brouillon abandonné passe `CANCELLED`, une règle terminée `RETIRED`. Le prix en vigueur à toute date passé… | C (CM §30) |
| BR-PRX-009 | Un contexte sans règle candidate donne `PRICE_NOT_FOUND` : la vente est bloquée, sauf dérogation de prix permise (BR-VEN-015). Tout produit… | D |
| BR-PRX-010 | L'activation exige `pricing.rule.activate`. Préparer un brouillon exige `pricing.rule.draft`. | AV-062 |
| BR-PRX-011 | Une règle peut être activée avec une date d'effet future. Elle est téléchargée à l'avance sur les appareils concernés, qui l'appliquent aut… | C (CM §29, §43) / D |
| BR-PRX-012 | À l'activation, une note de direction peut être publiée automatiquement pour informer les équipes (option cochée par défaut) ; la note n'es… | C (CM §43) |
| BR-PRX-013 | Le moteur de résolution est une seule implémentation, partagée par l'appareil et le serveur, pour garantir le même résultat hors ligne et e… | D (ADR-021) |
| BR-PRX-014 | Chaque ligne de vente et de commande fige : `price_rule_id`, `price_rule_version`, prix catalogue résolu, prix appliqué, source du prix et… | C (CM §30 ; PM §9) |
| BR-PRX-015 | Une campagne commerciale a un nom, une période et un statut. Ses règles portent en général une priorité supérieure (100 par défaut) à celle… | C (PM §9) / D |
| BR-PRX-016 | Une « saison » (CM §29) se modélise par une campagne commerciale ou par la période de validité d'une règle, sans dimension spécifique. | D |

## D11 — Analytics et tableaux de bord (ANA)

Fichier : [`domaines/D11-ANA-analytics.md`](domaines/D11-ANA-analytics.md)

| ID | Règle (résumé) | Statut |
|---|---|---|
| BR-ANA-001 | Aucun indicateur n'est saisi. Tous sont calculés à partir des opérations enregistrées. | C (CM §9) |
| BR-ANA-002 | La date d'analyse d'une opération est son `occurred_at`, ramenée au jour métier en fuseau `Africa/Douala`. Périodes proposées : aujourd'hui… | C (CM §9, §38) |
| BR-ANA-003 | Annulations : les vues « par période d'activité » comptent la contre-écriture à la date d'annulation (BR-FIN-042). Une vue « net par date d… | D |
| BR-ANA-004 | Le RBAC s'applique aux analyses au niveau des lignes (portée : OWN, TEAM, SITE, ZONE, ALL) et au niveau des mesures : coût, marge et valeur… | C (CM §48) |
| BR-ANA-005 | Chaque tableau de bord affiche la fraîcheur : heure du dernier calcul, et nombre d'appareils du périmètre dont la dernière synchronisation… | C (CM §36) / D |
| BR-ANA-006 | L'explorateur n'accepte que des jeux, dimensions, mesures et filtres déclarés dans la couche sémantique ; aucune requête libre. Limites : 1… | D (sécurité, performance) |
| BR-ANA-007 | Une vue sauvegardée partagée ne donne aucun droit supplémentaire : chaque lecteur la voit restreinte à son propre périmètre. | D |
| BR-ANA-008 | Tout export est audité : utilisateur, jeu de faits, filtres, colonnes, nombre de lignes, format. | C (CM §40) / AV-067 |
| BR-ANA-009 | Tableaux de bord, explorateur et instantanés utilisent les mêmes définitions d'indicateurs (§7.1). Deux écrans ne peuvent pas afficher deux… | C (CM §60) |
| BR-ANA-010 | Tout indicateur de la tour de contrôle mène en au plus deux niveaux aux opérations sources. | C (CM §53, §60) |

## D12 — Audit (AUD)

Fichier : [`domaines/D12-AUD-audit.md`](domaines/D12-AUD-audit.md)

| ID | Règle (résumé) | Statut |
|---|---|---|
| BR-AUD-001 | Le journal d'audit est en ajout seul : aucune modification ni suppression, garanti par les droits de la base (aucun `UPDATE` ni `DELETE` ac… | C (CM §40 ; PM §18) |
| BR-AUD-002 | Une entrée d'audit contient au minimum : utilisateur, rôles actifs (instantané), action, type et identifiant d'entité, valeurs avant et apr… | C (PM §18) |
| BR-AUD-003 | Sont toujours audités : toute commande sur une vente, commande client, encaissement, paiement, réception, transfert, perte, consommation, i… | C (CM §40) / D (liste) |
| BR-AUD-004 | Les refus d'autorisation et les tentatives invalides sont audités (`DENIED`, `FAILED`), pour détecter les tentatives d'accès non autorisé (… | D (PM §37) |
| BR-AUD-005 | L'entrée d'audit d'une action réussie est écrite dans la même transaction que l'effet métier : pas d'effet sans audit, pas d'audit sans eff… | D |
| BR-AUD-006 | Chaque entrée contient le hachage de l'entrée précédente et son propre hachage (SHA-256 d'une sérialisation canonique). La vérification quo… | D (fraude interne, PM §37) |
| BR-AUD-007 | Aucune donnée secrète n'est journalisée : mots de passe, PIN, jetons, clés. | D |
| BR-AUD-008 | Conservation de 10 ans. Partitionnement mensuel ; archivage froid au-delà de 24 mois, restaurable. | AV-074 |
| BR-AUD-009 | Accès au journal : `audit.log.read` ; toute consultation est elle-même auditée. | D |
| BR-AUD-010 | Les actions du système (tâches planifiées, réactions à des événements) sont auditées sous l'acteur technique `system`, avec la cause (ident… | D |

## D13 — Alertes, notifications et communication interne (NOT)

Fichier : [`domaines/D13-NOT-notifications-communication.md`](domaines/D13-NOT-notifications-communication.md)

| ID | Règle (résumé) | Statut |
|---|---|---|
| BR-NOT-001 | Chaque type d'alerte a une règle : condition de déclenchement, gravité (`INFO`, `WARNING`, `CRITICAL`), destinataires (rôles × périmètre de… | C (CM §54) / D |
| BR-NOT-002 | Déduplication : au plus une alerte ouverte par (type, objet concerné). Une nouvelle occurrence met à jour l'alerte ouverte (compteur, derni… | C (CM §54 « pas accumuler ») |
| BR-NOT-003 | Une alerte d'état (stock faible, créance en retard) se résout automatiquement quand la condition disparaît. Une alerte d'événement (perte a… | D |
| BR-NOT-004 | Une alerte `CRITICAL` déclenche une notification push immédiate aux destinataires. Une alerte `WARNING` produit une notification in-app. Le… | D / AV-064 |
| BR-NOT-005 | Une alerte `CRITICAL` non prise en compte sous 4 h est escaladée au niveau supérieur (responsable → Direction). | D |
| BR-NOT-006 | Une note de direction a une audience (tous, rôles, sites, zones, utilisateurs), une date de publication, une date d'expiration optionnelle… | C (CM §43) / AV-066 |
| BR-NOT-007 | Une note ne porte aucun effet métier (ni prix, ni règle) : ces effets passent par leurs modules. Une note peut référencer l'objet concerné… | C (CM §43) |
| BR-NOT-008 | Un utilisateur ne reçoit que les alertes et notifications relatives à des objets de son périmètre RBAC. | C (CM §48) |

## D14 — Synchronisation (SYN)

Fichier : [`domaines/D14-SYN-synchronisation.md`](domaines/D14-SYN-synchronisation.md)

| ID | Règle (résumé) | Statut |
|---|---|---|
| BR-SYN-001 | Chemin d'écriture unique : toute écriture, en ligne ou hors ligne, est une commande identifiée par un UUIDv7 généré à la création (`command… | D (ADR-007) |
| BR-SYN-002 | Idempotence : le serveur n'applique qu'une fois un `command_id`. Un renvoi du même identifiant avec le même contenu renvoie le résultat enr… | C (PM §29 ; INV-SYN-01) |
| BR-SYN-003 | Chaque appareil numérote ses commandes par une séquence strictement croissante (`device_seq`). Un trou non comblé après 24 h lève `DEVICE_S… | D (PM §37 « synchronisation falsifiée ») |
| BR-SYN-004 | Le serveur applique les commandes d'un appareil dans l'ordre de `device_seq`. Une commande qui dépend d'une autre (`depends_on`) attend son… | D |
| BR-SYN-005 | États côté appareil : `LOCAL_ONLY` (brouillon non soumis), `PENDING_SYNC`, `SYNCING`, `SYNCED`, `SYNCED_WITH_WARNING`, `CONFLICT`, `REJECTE… | C (PM §5) / D (`SYNCED_WITH_WARNING`) |
| BR-SYN-006 | Résultats côté serveur. `APPLIED` → `SYNCED`. `APPLIED_WITH_WARNINGS` : appliquée, avec anomalie ou conflit informatif ouvert → `SYNCED_WIT… | D |
| BR-SYN-007 | Une opération constatant un fait physique ou financier accompli (vente, encaissement, perte, réception, expédition, consommation, collecte)… | D (C-08 ; CM §40) |
| BR-SYN-008 | Une opération d'intention sur un état partagé (modifier une commande, changer une étape de pipeline, réaffecter) utilise la concurrence opt… | C (PM §29, §30) |
| BR-SYN-009 | Quand une commande est `REJECTED` ou `CONFLICT`, l'appareil annule ses effets locaux (ex. le stock local est rétabli), conserve l'opération… | D (UX CM §3) |
| BR-SYN-010 | Déclencheurs de synchronisation : ouverture de l'application, retour du réseau, après chaque commande si en ligne, toutes les 5 minutes qua… | D (CM §36) |
| BR-SYN-011 | Le serveur mesure l'écart d'horloge de l'appareil à chaque envoi (heure serveur − heure d'envoi de l'appareil). Au-delà de 5 minutes, les c… | C (CM §38) / D (ADR-016) |
| BR-SYN-012 | `occurred_at` ne peut précéder `client_created_at` que dans la fenêtre de saisie rétroactive (AV-078). Au-delà de 24 h, une justification e… | AV-078 |
| BR-SYN-013 | Une commande en outbox n'est jamais supprimée automatiquement tant qu'elle n'est pas `SYNCED`, ou `REJECTED` et prise en compte. La déconne… | C (CM §40) |
| BR-SYN-014 | Sur un appareil partagé, chaque commande garde son auteur. Les commandes d'un utilisateur sont envoyées avec la session de cet utilisateur.… | D (AV-007) |
| BR-SYN-015 | Le téléchargement est incrémental par jeu de données, avec curseur. Un appareil dont le curseur est plus ancien que la rétention du flux de… | D (PM §29) |
| BR-SYN-016 | Une nouvelle version de l'application doit pouvoir envoyer les commandes créées par la version précédente : chaque commande porte `command_… | D |
| BR-SYN-017 | La résolution de chaque type de conflit revient à un rôle défini dans la matrice des conflits. Toute résolution est tracée : décision, aute… | C (PM §30) |
| BR-SYN-018 | L'utilisateur voit en permanence : « Synchronisé » ; « n opérations en attente » ; « Erreur : n opérations à vérifier » ; « Hors ligne depu… | C (PM §29 « états utilisateur ») |

## D15 — Intégration Kommo (KOM)

Fichier : [`domaines/D15-KOM-kommo.md`](domaines/D15-KOM-kommo.md)

| ID | Règle (résumé) | Statut |
|---|---|---|
| BR-KOM-001 | GIC ne crée, ne modifie ni ne supprime jamais un lead Kommo, sauf pour les champs d'enrichissement déclarés (statut de commande, montants).… | C (CM §44) / AV-019 |
| BR-KOM-002 | À la réception d'un lead qualifié : recherche d'un compte GIC par lien externe, puis par téléphone normalisé. S'il existe, on crée le lien… | C (CM §46) / AV-069, AV-071 |
| BR-KOM-003 | Champs partagés : nom, téléphone, e-mail, adresse. GIC est la source de vérité. Une modification Kommo n'est appliquée à GIC que si le cham… | C (CM §59) / D |
| BR-KOM-004 | Données GIC → Kommo : stade (prospect, client, perdu), titulaire, nombre de commandes, CA cumulé, date de la dernière vente, statut de la d… | C (CM §46) / AV-070 |
| BR-KOM-005 | Anti-boucle : un changement appliqué depuis Kommo n'est pas renvoyé vers Kommo. On compare l'empreinte des champs partagés avec la dernière… | C (PM §16) |
| BR-KOM-006 | Idempotence entrante : un webhook est identifié par une clé de déduplication (identifiant d'entité Kommo + type + horodatage de modificatio… | C (PM §16) |
| BR-KOM-007 | Idempotence sortante : chaque message sortant a une clé ; les mises à jour sont des remplacements de valeurs absolues (pas d'incréments), d… | C (PM §16) |
| BR-KOM-008 | Reprise : jusqu'à 10 tentatives avec attente progressive (30 s × 2^n, plafond 1 h). Ensuite, le message passe `DEAD`, l'alerte `KOMMO_SYNC_… | C (PM §16) / D |
| BR-KOM-009 | Une indisponibilité de Kommo n'empêche aucune opération GIC : l'intégration est asynchrone. | D (CM §45) |
| BR-KOM-010 | Les webhooks entrants sont authentifiés (secret partagé ou signature selon les capacités Kommo) et journalisés bruts avant tout traitement. | D (PM §37) / AV-068 |

## D16 — Catalogue et référentiels (CAT)

Fichier : [`domaines/D16-CAT-catalogue-referentiels.md`](domaines/D16-CAT-catalogue-referentiels.md)

| ID | Règle (résumé) | Statut |
|---|---|---|
| BR-CAT-001 | Un produit a un code unique, un libellé, une catégorie, une famille de stock (`BIOLOGIQUE`, `PRODUCTION_COMMERCIALISABLE`, `INTRANT`, `MARC… | C (CM §20) / D |
| BR-CAT-002 | L'unité de base d'un produit est immuable dès qu'un mouvement existe : changer d'unité de base fausserait le registre. On crée alors un nou… | D (INV-CAT-01) |
| BR-CAT-003 | Une unité de base « à l'unité » (tête, œuf, pièce) impose des quantités entières en unité de base. | D |
| BR-CAT-004 | Une unité de conditionnement a un facteur de conversion > 0 vers l'unité de base, figé une fois utilisé dans une transaction (les transacti… | D / AV-080 |
| BR-CAT-005 | Un produit de famille `SERVICE` n'a aucun effet de stock et un suivi par lot `NONE`. | AV-085 |
| BR-CAT-006 | Désactiver un produit interdit toute nouvelle saisie en ligne. L'historique, les soldes et les règles restent. Les opérations hors ligne an… | C (PM §30 « produit désactivé ») / D |
| BR-CAT-007 | Modifier le libellé d'un produit ne réécrit pas l'historique : les lignes de vente gardent le libellé figé (BR-VEN-013). | C (PM §7) |
| BR-CAT-008 | Un produit vendable doit avoir au moins une règle tarifaire globale active avant d'être activé à la vente (BR-PRX-009). | D |
| BR-CAT-009 | Mode de tarification par produit : `PER_UNIT` (par défaut) ou `PER_WEIGHT` (prix au kg, poids saisi à la vente). | AV-031 |
| BR-CAT-010 | Les codes motifs sont désactivables mais jamais supprimés : les opérations passées gardent leur référence. | C (PM §7) |
| BR-CAT-011 | Un produit peut porter un coût standard (XAF par unité de base), utilisé pour valoriser les productions internes sans lot (œufs, poussins a… | AV-042 |
