# Démonstration de sortie de phase P5

> Plan §4 (P5 — Distribution et points de vente). Critère : « Un PDV fonctionne toute la journée hors ligne, avec une caisse contrôlée ». État arrêté le 13/10/2026, à la fin des éléments de code de P5 (P5-01 à P5-23). Développement sur le poste local (MySQL 8.4, port 3307), commits locaux sur la branche `claude/brave-pasteur-c7q4y7` : **rien n'est poussé** sans demande du porteur ; la CI n'a donc pas tourné sur ces commits (ADR-024 §5 : aucun déploiement Hostinger requis).
>
> P5 suit P4 : le PDV vend (P4) sur des quotas d'appareil, encaisse dans une session de caisse contrôlée et remet ses fonds ; le tableau de distribution suit, par PDV, l'envoyé, le reçu, le vendu, le perdu, le restant et l'encaissé. Les écrans de P5 ont été menés en parallèle par le fork « Écrans PWA » et intégrés le 13/10/2026 ([suivi](15-ecrans-pwa.md) § 9).

---

## 1. Aucun AV bloquant

La conception de P5 est arrêtée par [ADR-032](../decisions/ADR-032-sessions-de-caisse-et-remises-de-fonds.md) (sessions de caisse et remises de fonds : un écart n'est compté qu'une fois) et [ADR-033](../decisions/ADR-033-quotas-d-appareil-apres-adr-028.md) (quotas d'appareil sans réservation), puis précisée en cours de phase par [ADR-034](../decisions/ADR-034-isolation-par-commande.md) (isolation en lecture confirmée pour les sessions de caisse), [ADR-035](../decisions/ADR-035-tableaux-d-analyse-avant-p9.md) (tableau de distribution avant P9), [ADR-038](../decisions/ADR-038-ordre-de-verrouillage-global.md) (ordre de verrouillage global), [ADR-040](../decisions/ADR-040-garde-jugee-a-la-date-du-fait.md) (garde jugée à la date du fait) et [ADR-041](../decisions/ADR-041-activite-par-periode-accueil-et-tableau.md) (chiffre d'affaires et encaissé par période d'activité). Les écrans ajoutent [ADR-039](../decisions/ADR-039-envoi-strict-dans-l-ordre-de-l-appareil.md) (envoi strict dans l'ordre de l'appareil).

Aucun AV n'est bloquant. Les 77 points ouverts par P5 (28 importants, 49 secondaires) restent `OUVERT` : leur valeur par défaut est implémentée, paramétrable quand la règle s'y prête, et n'est pas présentée comme une décision ([`A-VALIDER.md`](../A-VALIDER.md)). Ils sont à passer en revue avec le porteur.

| AV | Question | Classe | Défaut implémenté |
|---|---|---|---|
| AV-153 | Écart d'une remise de fonds : imputation et excédent | IMPORTANTE | Aucun second mouvement ; imputation choisie par la Finance ; excédent admis |
| AV-154 | Cycle quotidien de la session de caisse (seconde session, ouverture concurrente, veille non clôturée) | IMPORTANTE | Une session par jour (paramètre) ; ouvertures concurrentes fusionnées ; clôture forcée par la Finance |
| AV-155 | Responsabilité d'un écart de caisse avec plusieurs vendeurs et identité du valideur | IMPORTANTE | Écart imputé à celui qui clôture, sous-totaux par vendeur ; valideur différent de l'ouvreur et du clôtureur |
| AV-156 | Fonds de caisse initial et écart d'ouverture | SECONDAIRE | Écart d'ouverture posé et validé par la Finance, motif « fonds initial » admis |
| AV-157 | Mouvements d'espèces hors session ou décidés après coup (encaissement, remboursement, inverse) | IMPORTANTE | Appliqué avec avertissement hors ligne ; rattaché à la session couvrant sa date ; l'inverse hérite de la session d'origine |
| AV-158 | Remises de fonds : comptes admis, récepteur, alerte de remise non reçue | SECONDAIRE | Récepteur différent de l'expéditeur ; alerte à 48 h ; porteur = utilisateur ou nom libre |
| AV-159 | Refus, recomptage et correction d'un écart de caisse | SECONDAIRE | Acceptation seule ; une erreur de comptage se corrige par un ajustement validé |
| AV-160 | Quotas d'appareil : granularité et validité par défaut | IMPORTANTE | Quota par produit (lot indicatif) ; valide jusqu'à la fin du jour métier de l'octroi |
| AV-161 | Quotas d'appareil : dépassement hors ligne, quota révoqué ou échu | IMPORTANTE | Fait appliqué, excédent au stock commun, reste jamais négatif, conflit signalé |
| AV-162 | Qui accorde les quotas (« responsable du PDV ») et permission de libération | IMPORTANTE | Magasinier du site, Resp. commercial de la zone, Direction ; libération par l'appareil détenteur (portée propre) |
| AV-163 | Garde d'appareil : mode par défaut des emplacements et appareil non désigné | IMPORTANTE | Mode obligatoire avec défaut par type ; appareil non désigné : fait appliqué et conflit |
| AV-164 | Tableau de distribution : définitions de « vendu » et « perdu », périmètre, route | SECONDAIRE | Vendu net des contre-écritures (à livrer à part) ; perdu = pertes reconnues + écarts ; route d'analytique livrée en P5 |
| AV-165 | Sessions de caisse hors PDV et PDV à plusieurs appareils | SECONDAIRE | Pas de session pour une caisse utilisateur ; validation sans attendre toutes les synchronisations |
| AV-166 | Vente hors ligne sans quota utilisable sur un emplacement partagé : signal du serveur | IMPORTANTE | Appliquée sur le stock commun et signalée `ALLOCATION_EXCEEDED` (motif `ALLOCATION_MISSING` ou `ALLOCATION_EXPIRED`) si l'emplacement porte au moins un quota actif du produit (même épuisé) ; réglable par site |
| AV-167 | Ouverture de caisse hors ligne plus ancienne que la session qu'elle chevauche | SECONDAIRE | Fusion dans la plus ancienne session en cause, fenêtre inchangée, intervalle consigné |
| AV-168 | Ouverture de caisse hors ligne pendant la session de la veille, close d'office depuis | IMPORTANTE | Ouverture prise en compte à la clôture forcée (décalée), comptage conservé, conflit |
| AV-169 | Clôture de caisse hors ligne datée avant l'ouverture de la session | SECONDAIRE | Observation, session laissée ouverte |
| AV-170 | Responsable imputé de l'écart d'une clôture forcée et de l'écart d'ouverture | IMPORTANTE | L'ouvreur de la session |
| AV-171 | Clôture de caisse datée avant un mouvement déjà enregistré sur la caisse | SECONDAIRE | Refus en ligne ; hors ligne, appliquée, jamais validée d'office, signalée à la Finance |
| AV-172 | Remises de fonds : qui réceptionne et qui annule | SECONDAIRE | Tout titulaire de la portée du compte destinataire, sauf l'expéditeur ; porteur admis ; annulation par l'expéditeur seul |
| AV-173 | Courses hors ligne d'une remise (réception après annulation, annulation après réception, double réception) | IMPORTANTE | Fait conservé en observation dans un conflit pour la Finance, aucun mouvement ; refus en ligne ; régularisation humaine |
| AV-174 | Décision sur l'écart d'une remise : rejet, retrait, correction, valideur | SECONDAIRE | Acceptation seule (rejet et retrait refusés) ; imputation et motif obligatoires ; valideur ni expéditeur, ni récepteur, ni porteur |
| AV-175 | Remise perdue en route | IMPORTANTE | Réception de 0 XAF : écart = − envoyé, sans entrée de trésorerie, décision ordinaire |
| AV-176 | Site de numérotation d'une remise entre comptes sans site | SECONDAIRE | Site du compte source, sinon du destinataire, sinon série globale `SIEGE` paramétrable |
| AV-177 | Réception sans document : critères de rapprochement, choix de l'expédition, excédent | IMPORTANTE | Mêmes source et destination, produits reçus inclus dans les produits expédiés ; exacte puis partielle puis excédentaire, la plus ancienne d'abord ; excédent reçu et signalé ; mode paramétrable (`SUBSET` ou `EXACT`) |
| AV-178 | Réception sans document vers un emplacement partagé ou saisie hors garde | SECONDAIRE | En ligne : refus ; hors ligne : fait appliqué, avertissement et conflit `CUSTODY_DEVICE_MISMATCH` |
| AV-179 | Réception sans document rapprochée après coup : lot et valeur ; produit suivi par lot | IMPORTANTE | Requalification au lot et à la valeur de l'expédition ; lot obligatoire en ligne pour un produit suivi par lot |
| AV-180 | Retour à la source et réception concurrents ; seconde réception ; retour en double | SECONDAIRE | Le premier fait appliqué l'emporte ; le second, contradictoire, est mis en quarantaine (hors ligne) ou refusé (en ligne) |
| AV-181 | Délai de la réception sans document non rapprochée : origine, propriétaire du conflit, sortie | SECONDAIRE | Délai depuis l'heure physique de la réception ; conflit au responsable du stock expéditeur, une seule fois ; clos au rapprochement |
| AV-182 | Portée (`SITE`/`OWN`) des commandes de stock : quelle extrémité d'un transfert fait ressource, et suite hors ligne | IMPORTANTE | (a) depuis P5-23 : portée évaluée sur au moins une des extrémités physiques (site, et titulaire d'un stock sous garde exclusive) ; refus `FORBIDDEN_SCOPE`, en ligne comme hors ligne, pour toutes les commandes `inventory` |
| AV-183 | Session de caisse ou écart de remise à valider sans politique active | SECONDAIRE | Clôture ou réception appliquée sans demande ; validation directe (`finance.cash_session.validate`, `finance.cash_transfer.close_discrepancy`), mêmes droits, séparation des tâches et motif |
| AV-184 | Encaissement en espèces au PDV sans session : périmètre de l'exigence, grain et résolution de `CASH_SESSION_MISSING` | IMPORTANTE | Caisse de PDV seulement, trois chemins d'encaissement ; refus en ligne, contrôle repris sous le verrou du compte ; hors ligne, un conflit par encaissement, résolu par une ouverture qui couvre son heure ou la suit ; doublon suspect approuvé : index recopié, sans refus ni constat |
| AV-185 | Annulation directe : sens de « session de caisse de la vente encore ouverte » (BR-VEN-028) | SECONDAIRE | Chaque encaissement de la vente sur une caisse de PDV dans une session qui couvre son heure et celle de l'annulation ; sinon demande `CANCEL_SESSION_CLOSED` ; course avec une clôture concurrente : P5-22 |
| AV-186 | Remboursement en espèces sans session de caisse ouverte | SECONDAIRE | Jamais refusé ni signalé ; daté de sa propre date, rattaché à la session qui la couvre s'il y en a une |
| AV-187 | Sous-totaux par vendeur d'une session : contenu et attribution | SECONDAIRE | Encaissements nets de leurs inverses, par `received_by_user_id` ; autres flux agrégés sans vendeur |
| AV-188 | Annulation de l'encaissement qui règle une vente anonyme saisie en ligne | SECONDAIRE | Refus `PAYMENT_ANONYMOUS_SALE` de la demande et de la décision tant que l'encaissement règle une vente sans client saisie en ligne (défaut implémenté en P5-23) |
| AV-189 | Droits de lecture des ressources de P5 : quotas, sessions de caisse, remises de fonds, structure, file des conflits | SECONDAIRE | Droits semés réutilisés (`inventory.stock.read`, `finance.cash.read`, `org.structure.read`, `sync.conflict.resolve`), portée de la ressource ; aucune permission de lecture nouvelle |
| AV-190 | Sens d'une résolution manuelle de conflit (`sync.conflict.resolve`, `.dismiss`) | IMPORTANTE | Clôture administrative tracée (décision, motif, références) : aucun rejeu de commande, aucun document créé par le serveur ; refus listés (quarantaine, doublon d'encaissement, références de `COMPENSATE`) |
| AV-191 | Qui voit et traite un conflit | SECONDAIRE | Rôle propriétaire du conflit parmi les rôles de l'utilisateur (catalogue des rôles), puis portée de `sync.conflict.resolve` des seules affectations de ce rôle, sur le site et l'auteur (à défaut, le détenteur du stock mobile en cause) |
| AV-192 | Clôture d'un conflit par l'auteur du fait qu'il signale | SECONDAIRE | Refusée pour un conflit sur un fait appliqué (`CONFLICT_SELF_RESOLUTION_FORBIDDEN`) ; permise pour la quarantaine de sa propre commande |
| AV-193 | Ce que les jeux `allocations` et `cash` gardent d'un quota, d'une session ou d'une remise terminés | SECONDAIRE | Quota servi tant qu'il est actif ; session servie ouverte puis à valider ; remise servie envoyée ou en écart ; sortie du jeu (`SCOPE_EXIT`) ensuite |
| AV-194 | Quotas d'une tablette partagée : cloisonnement par utilisateur | SECONDAIRE | Ligne au périmètre de l'appareil détenteur, détenteur projeté : l'appareil n'applique que les quotas de l'utilisateur connecté |
| AV-195 | Configuration du PDV hors ligne et changement d'appareil désigné | SECONDAIRE | `POINT_OF_SALE` dans le jeu `org` au site du PDV, emplacement de vente republié ; changement d'appareil propagé par mise à jour, sans sortie de périmètre ; P5-23 : quotas (AV-230), fiche d'appareil et garde jugée à la date du fait (ADR-040) traités |
| AV-196 | Jeux et publication des référentiels de vente (suite d'ADR-031) | SECONDAIRE | `catalog` (unités, canaux, motifs, étapes, sources), `me` (paramètres visibles, ligne `GLOBAL`, version remplacée retirée), `policies` (version active, version retirée supprimée) ; lignes semées publiées par le seed |
| AV-197 | Comptes destinataires d'une remise de fonds hors ligne | SECONDAIRE | Comptes actifs sans détenteur personnel publiés à tous les appareils (jeu `cash`, ligne `GLOBAL`), sans solde, responsable ni version |
| AV-198 | Curseur du pull : ligne du flux validée après une ligne de numéro supérieur | IMPORTANTE | Variante de (a) depuis P5-23 : curseur retenu devant un trou récent de la numérotation (`sync.pull_settle_seconds`, 120 s) ; même règle pour la position des consommateurs d'événements ; test de concurrence |
| AV-199 | Flux de distribution d'un PDV : catégories, datation, envoyé net des retours | SECONDAIRE | Chaque mouvement à sa date, une seule catégorie (identité vraie par construction) ; envoyé net des retours à la source à la date du retour ; reçu net des requalifications ; écarts de transfert hors identité ; pertes en attente à part |
| AV-200 | Encaissé d'une période : datation des annulations d'encaissement | SECONDAIRE | Vue par période d'activité depuis P5-23 : encaissements confirmés à leur date, annulations décidées dans la période à la leur, partagée par l'accueil et le tableau (ADR-041) ; remboursements : AV-244 ; à confirmer par le porteur |
| AV-201 | « Session du jour » d'un PDV et sessions à valider | SECONDAIRE | Session ouverte (quel que soit son jour) et dernière session ouverte le jour métier ; à valider = sessions `PENDING_VALIDATION` de tous jours et ajustements en attente d'une session validée |
| AV-202 | Fraîcheur d'un appareil : dernier contact et appareils d'un PDV | IMPORTANTE | Dernier contact = connexion, dernier envoi ou dernier pull (enregistré à chaque pull depuis P5-19) ; appareils du site = rattachés, désigné du PDV, détenteurs d'un quota actif ; retard au-delà de `analytics.freshness_warning_hours` |
| AV-203 | Disponible net des quotas dans `GET /stock` | SECONDAIRE | Lignes inchangées (disponible sans consommateur désigné) ; bloc `allocations` par produit : restant alloué, non alloué, reste et disponible du demandeur (BR-STK-011) |
| AV-204 | Périmètre du tableau de distribution ; portée du Resp. commercial sur les PDV | IMPORTANTE | PDV que la permission atteint (`evaluateAccess`, zone et descendance comprises) ; aucun PDV ⇒ réponse vide ; `site_id` hors portée ⇒ 404 audité ; `RESP_COMMERCIAL` affectable en `ZONE` (seed : `TEAM`, `ZONE`) |
| AV-205 | Frontière entre agrégat et détail du tableau de distribution | SECONDAIRE | Agrégats sous `analytics.dashboard.distribution` ; session de caisse sous `finance.cash.read`, receveurs sous `sales.payment.read`, auteurs d'un appareil sous `sync.monitor.read`, évalués par site ; sinon `null` |
| AV-206 | Valeurs masquées du tableau de distribution | SECONDAIRE | Valeur du restant et du perdu (coût du registre) à `null` sans `inventory.valuation.read`, totaux de valeur à `null` dès qu'un PDV est masqué ; chiffre d'affaires et encaissé non masqués ; pas de `FORBIDDEN_MEASURE` |
| AV-207 | Période du tableau de distribution et instants de lecture | SECONDAIRE | `period` (`TODAY` par défaut, `YESTERDAY`, `WEEK`, `MONTH`, `YEAR`) ou `from`/`to` inclus, au plus `analytics.dashboard_max_period_days` (366) ; restant à la fin de la période ; à livrer, seuils, quotas, caisse et fraîcheur à l'instant |
| AV-208 | Accueil Finance et magasinier : contenu de distribution | SECONDAIRE | Finance : caisses à valider, écarts du jour, remises en attente, appareils en retard, signaux `CASH_VARIANCE` (critique), `CASH_SESSION_OPEN_LONG`, `CASH_TRANSFER_NOT_RECEIVED`, `DEVICES_STALE` ; magasinier : réapprovisionnement, quotas à régulariser, appareils des PDV de ses sites ; anomalies d'un rôle de sites filtrées par site |
| AV-209 | Chiffre d'affaires du jour : accueil contre tableau de distribution | SECONDAIRE | Accueil aligné sur le tableau en P5-23 : vendu net par période d'activité, une seule fonction (ADR-041) ; périmètres : AV-245 ; à confirmer par le porteur |
| AV-210 | Ordre d'un lot après une commande à renvoyer ; dépendance reçue mais non réglée | IMPORTANTE | Lot suspendu après la première commande `RETRY_LATER` (`PRECEDING_COMMAND_PENDING`, rien d'enregistré) ; dépendance non réglée ⇒ `DEPENDENCY_PENDING` ; commande en attente reprenable au renvoi (`FAILED_RETRYABLE`), reprise réclamée sur le compteur de tentatives |
| AV-211 | Faits antérieurs à la révocation d'un quota, synchronisés après : comparaison fait par fait | SECONDAIRE | (b) depuis P5-23 : comparaison en cumul avec les faits du détenteur antérieurs à la révocation déjà appliqués après elle |
| AV-212 | Fenêtre de quarantaine d'un appareil débloqué ou retiré | IMPORTANTE | (b) implémenté en P5-23 : périodes hors service closes consignées (`identity.device_status_periods`), quarantaine de tout fait daté dans l'une d'elles |
| AV-213 | Appareil révoqué : envoi de sa file et signal d'effacement local | IMPORTANTE | Envoi tant que le jeton d'accès vaut, quarantaine côté serveur ; pull non refusé ; effacement à coder dans la PWA |
| AV-214 | Régularisation d'une vente mise en quarantaine (appareil révoqué) | SECONDAIRE | Inbox seule (aucune ligne de conflit), écart de caisse expliqué par l'inbox, inventaire, ressaisie |
| AV-215 | Stock négatif après une sortie hors ligne autre qu'une vente | SECONDAIRE | Depuis P5-22 : toute sortie physique qui rend un solde négatif ouvre `STOCK_NEGATIVE` (posé par `recordStockMove`, un par sortie, responsable du stock), conformément à BR-STK-018 |
| AV-216 | Horloge d'appareil suspecte : dates de référence, seuil et alerte | SECONDAIRE | Date déclarée partout (ADR-016), drapeau visible, seul le contrôle de date future corrigé ; seuil lu dans `sync.clock_skew_flag_minutes` à la réception (P5-23) ; alerte en P9 |
| AV-217 | Commande à renvoyer qui ne se règle jamais : suspension du lot bornée | IMPORTANTE | Au-delà de `sync.retry_hold_minutes` (30 min) depuis la première réception : toujours à renvoyer, ne suspend plus la suite (`COMMAND_STALLED`), signal `SYNC_COMMAND_STALLED` pour l'Admin, fermé quand elle se règle |
| AV-221 | Annulation directe pendant une clôture de caisse concurrente : condition relue sous verrou | SECONDAIRE | Condition d'AV-185 relue sous le verrou des caisses après l'annulation ; basculée, la transaction est annulée (`RETRY_LATER`) et le renvoi prend le chemin de la demande (`CANCEL_SESSION_CLOSED`) |
| AV-222 | Gardes des référentiels : valeurs retenues là où une contrainte de la base levait une exception | SECONDAIRE | (a) : suivi `REQUIRED` par défaut d'un produit biologique, nouvelle version après la fin de la remplacée activée sans la toucher, fin tolérée à 5 min dans le passé, unité ou canal identique recréé sans effet |
| AV-223 | Expédition hors ligne d'une demande qui n'est plus à expédier ; mouvement interne hors de la garde de l'auteur | SECONDAIRE | (a) : demande refusée ou annulée → expédition directe appliquée et conflit `TRANSFER_REQUEST_CLOSED` ; déjà expédiée → quarantaine `TRANSFER_DISPATCH_CONFLICT` ; mouvement interne au même site, refus `INTERNAL_MOVE_CUSTODY` en ligne et `CUSTODY_DEVICE_MISMATCH` hors ligne |
| AV-224 | Opération de caisse datée entre deux sessions, appliquée après l'ouverture de la suivante | IMPORTANTE | (a) : l'écart d'ouverture de la session suivante est corrigé (ajustement `LATE_BEFORE_OPENING`, inclus dans sa validation ou à demande propre) |
| AV-225 | Résolution manuelle du signal d'une commande bloquée : la commande reste-t-elle rejouable ? | IMPORTANTE | (a) : la résolution (`KEEP_SERVER` ou `COMPENSATE`) écarte la commande — inbox `REJECTED`, `COMMAND_DISCARDED` au renvoi |
| AV-226 | Tolérance de date future du pipeline | SECONDAIRE | Paramètre propre `sync.occurred_at_future_tolerance_minutes` (5 min) |
| AV-227 | Écart d'horloge hors des bornes de stockage | SECONDAIRE | Écart borné à ±2 147 483 647 ms avant stockage et réponse ; le drapeau reste levé |
| AV-228 | Fait saisi par un appareil encore en attente d'approbation | IMPORTANTE | (c) : attente (`RETRY_LATER`, `DEVICE_PENDING`), appliqué après l'approbation ; appareil refusé sans approbation : quarantaine de tous ses faits |
| AV-230 | Quotas actifs d'un emplacement de vente qui passe en garde exclusive | SECONDAIRE | Refus `POS_ALLOCATIONS_ACTIVE` de la configuration tant qu'un quota est actif (le révoquer ou le libérer d'abord) |
| AV-243 | Fait hors ligne antérieur au rattachement de l'appareil à un autre site | SECONDAIRE | Pas de `DEVICE_OTHER_SITE` pour un fait antérieur au dernier rattachement (`designation_changed_at`) |
| AV-244 | Encaissé : remboursements et doublons approuvés | SECONDAIRE | Remboursements non retranchés de l'encaissé (lus dans la trésorerie) ; doublon approuvé compté à sa date d'origine |
| AV-245 | Chiffre d'affaires d'un PDV : site entier (accueil) ou emplacement de vente (tableau) | SECONDAIRE | Deux périmètres, une définition : l'accueil compte le site, le tableau l'emplacement de vente |

**Écrans de P5** (fork, AV-231 à AV-242, défauts appliqués par la PWA) :

| AV | Question | Classe | Défaut implémenté |
|---|---|---|---|
| AV-231 | Sorties de stock hors ligne au-delà du quota du détenteur ou du solde d'un emplacement exclusif | IMPORTANTE | Perte seulement signalée, autres sorties refusées sur l'appareil (`OFFLINE_LOSS_GUARD = 'SIGNAL'`) |
| AV-232 | Comptage de la caisse à l'aveugle | IMPORTANTE | À l'aveugle : attendu et écart affichés après l'enregistrement du comptage (`CASH_COUNT_BLIND`) |
| AV-233 | Encaissement en espèces au PDV sans caisse ouverte sur l'appareil | IMPORTANTE | Invite « Ouvrir la caisse », blocage en ligne, enregistrement signalé hors ligne (`OFFLINE_CASH_WITHOUT_SESSION = 'WARN'`) |
| AV-234 | Demande de réapprovisionnement d'un PDV sans source configurée | SECONDAIRE | Le vendeur choisit un magasin actif (`REPLENISH_WITHOUT_SOURCE = 'CHOOSE'`) |
| AV-235 | Demandes de réapprovisionnement en double vers un PDV | SECONDAIRE | Le déjà demandé est annoncé, sans blocage (`DUPLICATE_REQUEST = 'ANNOUNCE'`) |
| AV-236 | Ventes et encaissé du jour de l'accueil du PDV | SECONDAIRE | Ce que connaît le téléphone, annoncé comme tel ; chiffre complet par le tableau |
| AV-237 | Libération des quotas sur l'appareil | IMPORTANTE | Bouton par quota sur l'accueil du PDV, confirmé, reste calculé par l'appareil |
| AV-238 | Détenteurs proposés à l'octroi d'un quota | IMPORTANTE | Couples déjà détenteurs sur l'emplacement et l'utilisateur lui-même, jamais d'identifiant saisi |
| AV-239 | Remises de fonds sur l'appareil (UC-FIN-07) | IMPORTANTE | Écran hors ligne « Remises de fonds » (`/caisse/remises`) pour les détenteurs de `finance.cash_transfer.record` |
| AV-240 | Remise au-delà du solde indicatif de la caisse | SECONDAIRE | Signalée sans blocage |
| AV-241 | Rôles de l'écran de trésorerie (ECR-FIN-05) | SECONDAIRE | Finance et Direction |
| AV-242 | Lecture seule au-delà de l'autonomie hors connexion (AV-009) | IMPORTANTE | Durée depuis la dernière synchronisation complète ; au-delà, nouvelle opération refusée, consultation et envoi intacts |

**Renvoyé à une phase ultérieure** : AV-229 (Utilisateur suspendu puis réactivé : fenêtre de quarantaine, P10).

Les choix d'implémentation laissés libres par les règles sont **DÉDUITS** et documentés dans [D05 §15](../01-functional/domaines/D05-DIS-distribution-points-de-vente.md), [D06 §15](../01-functional/domaines/D06-STK-stocks.md) et [D09 §15](../01-functional/domaines/D09-FIN-finance.md).

## 2. Tests d'acceptation et invariants

### 2.1 Tests d'acceptation de la phase (plan §4 : AT-003, 004, 017, 031, 042, 049)

| AT | Scénario | Où | État |
|---|---|---|---|
| AT-003 | Vendeur hors ligne qui tente de dépasser son allocation | `packages/domain/src/allocations.test.ts` (`decideLocalConsumption`) ; miroir serveur `sales-allocations.test.ts`, `inventory-allocation-consumption.test.ts` (fait appliqué, `ALLOCATION_EXCEEDED`, quota jamais négatif) ; garde de l'appareil `apps/pwa/src/features/sales/quota.test.ts` (F-58, F-70) | Vert ; blocage à l'écran non vérifié dans le navigateur |
| AT-004 | Trois tablettes d'un PDV partagé, hors ligne, avec quotas | `p5-pdv-three-tablets.test.ts` (aucun solde négatif, quotas consommés, libération en fin de journée) | Vert |
| AT-017 | Réception sans document au PDV hors ligne, puis arrivée de l'expédition | `inventory-transfer-acceptance.test.ts` (rapprochement dans les deux ordres de synchronisation, transit de la paire à zéro) | Vert |
| AT-031 | Clôture de caisse avec un écart de −500, puis vente tardive | `finance-cash-session-commands.test.ts`, `finance-cash-session-validation.test.ts`, `sales-cash-session.test.ts` (écart validé, réévaluation par le delta, session validée figée, sous-totaux par vendeur) ; `packages/domain/src/cash-session.test.ts` | Vert |
| AT-042 | « Quelle quantité envoyée à ce PDV ? » | `p5-distribution-metrics.test.ts` (`GET /analytics/dashboards/distribution` = fonctions des modules ; identité de rapprochement ; masques par droit ; accueil et tableau égaux jour par jour, ADR-041) | Vert |
| AT-049 | Solde négatif provoqué par une vente hors ligne | `sales-allocations.test.ts` (vraie vente, P5-11), `inventory-allocation-restore.test.ts` (conflit `STOCK_NEGATIVE` fermé par l'inventaire) | Vert |

**Parcours de sortie** : « un PDV toute une journée hors ligne » (`p5-pdv-offline-day.test.ts`, P5-21) — trois tablettes, cent ventes chacune, caisse, remise, annulation, réception, perte et quotas ; deux ordres de synchronisation donnent le même état final, l'écart courant de −500 est compté une fois, le tableau est rapproché. Croisés avec le PDV : AT-035 (`p5-pdv-lost-device.test.ts`), AT-036 (`p5-pdv-clock-skew.test.ts`, seuil paramétré : `sync-clock-skew-setting.test.ts`).

### 2.2 Invariants

| INV | Où | État |
|---|---|---|
| INV-FIN-05 | `finance-cash-session-validation.test.ts` ; balayage `p5-invariants.test.ts` ; réconciliation `cash-ledger-reconciliation-job.test.ts` (`verifyCashSessions`) | Vert |
| INV-FIN-06 | `db/tests/finance-cash-sessions.test.ts` (index unique partiel) ; `finance-cash-session-commands.test.ts` (refus en ligne, fusion hors ligne) | Vert |
| INV-FIN-11 | `finance-cash-session-reconciliation.test.ts`, `p5-lock-order.test.ts` ; balayage ; `packages/domain` | Vert |
| INV-STK-05 | `inventory-stock-negative.test.ts` (`STOCK_NEGATIVE` pour toute sortie physique, AV-215) ; balayage | Vert |
| INV-STK-19 | `inventory-allocation-commands.test.ts` ; `packages/domain/src/allocations.test.ts` | Vert |
| INV-STK-20 | `db/tests/inventory-allocations.test.ts` ; `inventory-allocation-restore.test.ts` ; balayage | Vert |
| INV-STK-07 | `organization-pos-config.test.ts` (désactivation gardée : solde, quota, transfert, session ouverte), `inventory-blind-receipt.test.ts` | Vert |
| INV-STK-10, INV-STK-11 | `inventory-allocation-consumption.test.ts`, `sales-allocations.test.ts`, `p5-pdv-three-tablets.test.ts` ; `db/tests/inventory-allocations.test.ts` ; balayage `p5-invariants.test.ts` | Vert |
| INV-SYN-04 (reformulé) | `sync-shared-tablet.test.ts`, `sync-push-protocol.test.ts`, `p5-pdv-offline-day.test.ts` (ordre par couple appareil-auteur sur la tablette partagée) | Vert |
| INV-DIS-01, INV-DIS-02, INV-DIS-03 | `organization-pos-config.test.ts` ; balayage `p5-invariants.test.ts` | Vert |

Ordre de verrouillage (ADR-038) : chaque paire de transactions concurrentes relevée a son test (`p5-lock-order.test.ts`).

### 2.3 Suites complètes (13/10/2026, base neuve `gic_agropelc_p523d`)

`packages/domain` 364 tests (24 fichiers, couverture 99,1 %) ; `packages/contracts` 222 tests (9 fichiers) ; `db` 188 tests (20 fichiers) ; `apps/pwa` 506 tests (72 fichiers) ; `apps/server` 1 111 tests (127 fichiers). `typecheck`, `check:boundaries`, `lint` et `python docs/_tools/check_refs.py` verts. La CI n'a pas tourné (rien n'est poussé).

## 3. Ce qui est livré

| Incrément | Contenu |
|---|---|
| P5-01 conception | ADR-032, ADR-033, AV-153 à AV-165, réalignement documentaire, backlog de 24 incréments |
| P5-02 `packages/domain` | Quotas (consommation locale, AT-003), caisse (attendu, écart, seuils), distribution (flux, identité de rapprochement) ; schémas de commandes dans `packages/contracts` |
| P5-03, P5-04 `db` | Sessions de caisse, ajustements, remises de fonds, politiques et paramètres de caisse ; durcissement des quotas |
| P5-05 `organization` | Configuration du PDV, mode de garde obligatoire, registre de gardes de désactivation |
| P5-06 `identity` | Appareil désigné (`identity.device.designate`), permission `inventory.allocation.release` |
| P5-07 `sync` | Tablette partagée côté serveur, restes déclarés par auteur, harnais multi-appareils `OfflineDevice` |
| P5-08 à P5-10 `inventory` | Commandes de quotas, consommateur de révocation, échéance ; consommation dans `recordStockMove` et garde d'appareil ; restitution, réconciliation du registre des quotas, `STOCK_NEGATIVE` clos par l'inventaire |
| P5-11 `sales` | Vente directe sur les quotas d'appareil ; miroir serveur d'AT-003 ; AT-049 de bout en bout |
| P5-12, P5-13 `finance` | Sessions de caisse (ouverture, clôture, clôture forcée, attendu par fenêtre ; isolation : ADR-034) ; validation en façade de `CASH_VARIANCE`, réévaluation par le delta |
| P5-14 `sales` et `finance` | Session exigée à l'encaissement en espèces au PDV, `CASH_SESSION_MISSING` hors ligne, annulation directe soumise à la session, sous-totaux par vendeur (AT-031) |
| P5-15 `finance` | Remises de fonds : envoi, réception, annulation, décision d'écart sans second mouvement, « en transit », alerte à 48 h |
| P5-16 `inventory` | Réception sans document, rapprochement, `TRANSFER_UNMATCHED` à 48 h, retour à la source, ordonnanceur de plateforme (AT-017) |
| P5-17 lectures HTTP | Sites, emplacements, PDV, quotas, sessions de caisse, remises ; file des conflits, `sync.conflict.resolve` et `.dismiss` |
| P5-18 hors ligne | Jeux `allocations`, `cash` complété, `org`, référentiels de vente dans `catalog`, `me`, `policies` ; rattrapage du seed ; dédoublonnage du pull |
| P5-19, P5-20 distribution | Métriques partagées par le tableau et l'accueil ; `GET /analytics/dashboards/distribution` (ADR-035, AT-042) ; accueil Finance et magasinier |
| P5-21 E2E | PDV hors ligne toute une journée, AT-004, AT-035 et AT-036 croisés ; correctifs du protocole d'envoi et des connexions MySQL en UTC |
| P5-22 invariants | Balayage de toute la base, réconciliation de la trésorerie étendue, `STOCK_NEGATIVE` pour toute sortie physique, ordre de verrouillage global testé en concurrence (ADR-038) |
| P5-23 revue adverse | Onze lots de correctifs : gardes des référentiels et besoins serveur des écrans (S-02, S-20, S-29 à S-31, S-37, S-40, S-48) ; affectations sous verrou, curseur du pull (AV-198) ; portée des commandes `inventory` (AV-182), quotas en vigueur et cumul (AV-211) ; caisse entre deux sessions (AV-224) ; écart de remise sans politique (AV-183), encaissement d'une vente anonyme (AV-188) ; quarantaine d'un appareil par historique de ses statuts (AV-212, AV-228) ; horloge suspecte paramétrée (AV-216, AV-226, AV-227) ; garde exclusive et quotas (AV-195, AV-230), garde jugée à la date du fait (ADR-040, AV-243) ; accueil et tableau sur une seule définition (ADR-041, AV-200, AV-209) |
| Écrans (fork) | ECR-DIS-01 à 04, ECR-STK-06, ECR-FIN-05, ECR-FIN-07 (remises de fonds) ; jeux de P5 sur l'appareil, envoi strict dans l'ordre (ADR-039), garde d'AT-003, lecture seule après l'autonomie hors connexion, statut de la session retenue d'une ouverture fusionnée (F-56 à F-78) |

## 4. Ce qui reste hors périmètre de P5

- **Vérification dans le navigateur et sur appareil** des écrans de P5 (et de ceux des phases précédentes) : à faire avec le porteur (compte de démonstration local, `pnpm run demo:data`, [`db/README.md`](../../db/README.md) §5).
- **Changement d'utilisateur sur une même tablette** (sessions multiples de la PWA, changement de vendeur hors ligne avec son code PIN, jeux cloisonnés par utilisateur) : reporté à une phase dédiée (décision du porteur du 13/10/2026, [suivi](15-ecrans-pwa.md) § 9.7) ; le suivi par auteur des opérations et des quotas, livré, reste le périmètre de P5.
- **Garde de sécurité des comptes** : fenêtre de quarantaine d'un utilisateur suspendu puis réactivé (AV-229), avant la mise en production, sinon en P10.
- **Alertes** (remise non reçue, réception non rapprochée, quotas à régulariser, écart de caisse) : les signaux existent (accueil, conflits) ; la diffusion est en P9.
- **Finance opérationnelle** (dépenses, factures et paiements fournisseurs, rapprochement) : P8 ; les ajustements tardifs des sessions validées à l'écran de trésorerie attendent S-51.
- **Besoins serveur des écrans** encore ouverts ([`16-besoins-serveur-des-ecrans.md`](16-besoins-serveur-des-ecrans.md)) : lot transverse à planifier avec le porteur.
- **Déploiement** (`staging` Hostinger, P0-17) et démonstration sur appareil physique (P0-18).
