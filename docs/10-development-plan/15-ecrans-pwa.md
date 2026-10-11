# Écrans PWA des phases au code serveur terminé (fork « Écrans PWA »)

> Suivi du fork ouvert le 10/10/2026, en parallèle de la fin de P5 côté serveur. Branche locale `claude/pwa-ecrans` (worktree `.claude/worktrees/pwa-ecrans`), partie de `a1fa2c6` (P5-13). Périmètre : les écrans de la PWA (`apps/pwa`) des phases dont le code serveur est terminé, dans l'ordre socle de l'appareil, navigation par rôle, ventes (P4), puis stock, CRM, achats, production et administration des prix si le temps le permet. Hors périmètre : écrans de P5 (ECR-DIS-01 à 04, ECR-FIN-05, ECR-STK-06), P8, P9, P10.
>
> Règles du fork : aucune modification de `apps/server`, `db`, `packages/domain`, `packages/contracts` ; un besoin côté serveur est consigné au § 4 et l'écran s'adapte ; une question métier non couverte devient un AV numéroté de 300 à 349 (§ 5), avec un défaut paramétrable ; une décision structurante devient un ADR numéroté de 050 à 059 (§ 6). Ce fichier est mis à jour à chaque commit du fork.

---

## 1. Incréments livrés

| # | Incrément | Commit | Contenu |
|---|---|---|---|
| F-01 | Socle de l'appareil : jeux publiés depuis P1 | `215aedb` | `KNOWN_DATASETS` étendu aux 22 jeux publiés depuis P1 (34 en tout) (catalogue, prix, stock, quotas, CRM, achats, production, commandes, ventes récentes, caisses, communications) ; `SCOPE_EXIT` retiré par périmètre (une entité tenue par plusieurs périmètres reste tant qu'il en reste un) ; lecture typée des projections (`storage/projections.ts`, crochet `useProjected`) |
| F-02 | Navigation par rôle ([ADR-050](../decisions/ADR-050-navigation-par-role-sur-l-appareil.md)) | `9fd96f7` | Registre des écrans livrés (`app/screens.ts`) ; route d'une action de l'accueil complétée par l'appareil quand le serveur renvoie `route: null` ; navigation mémorisée par utilisateur (store `navigation`, version 2 de la base locale) ; menu par rôle `/menu`, utilisable hors ligne, lien depuis l'en-tête et depuis l'accueil en erreur ; déconnexion déplacée dans le menu |
| F-03 | ECR-VEN-01 « + Nouvelle vente » | `295b3f1` | Couche de données des ventes (`features/sales/`) : référentiels lus sur l'appareil, prix par `resolvePrice` avec le canal déduit comme le serveur (BR-VEN-021), disponible local (solde moins opérations en attente), blocage hors ligne par `decideLocalConsumption` (AV-025), envoi par l'outbox et suivi du résultat (UX-05). Écran : emplacement prérempli, client de passage ou identifié, articles (conditionnements, poids, dérogation de prix avec motif), encaissement prérempli au total, référence exigée selon le moyen. Correctif du socle : clé locale d'un solde de stock = emplacement × produit |
| F-04 | ECR-VEN-05 « Détail d'une vente (reçu, annulation) » et ventes récentes | `a643f36` | Ventes des 7 derniers jours (jeu `sales_recent`) complétées par les ventes de l'appareil pas encore confirmées (en attente, refusées, en conflit) ; reçu composé sur l'appareil, imprimable ; annulation par `sales.sale.cancel` (motif `CANCELLATION` ou commentaire, sort de la somme encaissée d'un client identifié), immédiate dans le délai `sales.direct_cancel_minutes` pour le vendeur, sinon demande soumise à validation ; annulation d'une vente encore sur l'appareil chaînée par `depends_on` ; rôles du registre alignés sur la matrice RBAC (`sales.sale.record`, `sales.sale.read`) |
| — | Correctif : disponible local | `ad5516b` | Une livraison ne consomme plus l'emplacement (la part vendue l'a quitté à la confirmation, ADR-028) ; une commande passée sur l'appareil, oui |
| F-05 | ECR-VEN-02, 03, 04 et corrections de la revue adverse | `21be2e3` | Nouvelle commande (client obligatoire, préparation, prix convenu, date et adresse, acompte) ; commandes ouvertes avec filtres « à livrer » et « en attente de stock », commandes livrées ou closes lues en ligne ; détail (progression des lignes, livrer, vendre le disponible, annuler ou clôturer le reste) ; livraison plafonnée au reste à livrer, livraisons de l'appareil en attente déduites. Corrections confirmées par la revue adverse (8 agents ; 30 constats proposés, 28 confirmés, une quinzaine de défauts distincts une fois les doublons entre dimensions regroupés) : synchronisation durcie ([ADR-051](../decisions/ADR-051-synchronisation-appareil-durcie.md)), zone de tarification (BR-VEN-022), canal laissé au serveur si les rôles sont inconnus, dérogation de prix réservée aux rôles qui ont `sales.price.override`, services sans effet de stock (BR-VEN-031), garde d'appareil hors ligne (`EXCLUSIVE_DEVICE`), compte de réception désigné ou à choisir (AV-300), référence envoyée seulement si le moyen l'exige et bornée à 80 caractères, saisies démesurées et erreurs d'enregistrement rattrapées, garde-fou d'affichage, bandeau « prix peut-être non à jour » au-delà de 24 h, disponible jamais « -0 » |
| F-06 | ECR-VEN-06 « Encaisser une créance » | `a54e009` | Client, montant reçu, moyen, référence et compte de réception (bloc commun) ; aperçu de l'affectation automatique (échéance la plus ancienne d'abord, reste en avoir, BR-FIN-004) ; créances lues en ligne (`GET /api/v1/receivables`), hors ligne celles des ventes récentes de l'appareil ; encaissements en attente d'envoi ; lien « Encaisser le reste dû » depuis le reçu ; action `PAYMENTS` de la Finance |
| F-07 | Corrections de la seconde revue adverse | `66d2dfe` | Revue de F-05 et F-06 (8 agents ; 28 constats confirmés, une vingtaine de défauts distincts). Synchronisation ([ADR-051](../decisions/ADR-051-synchronisation-appareil-durcie.md) révisé) : enveloppe immuable (le passage de `captured_offline` à vrai au premier envoi échoué faisait refuser un renvoi déjà appliqué, `COMMAND_ID_REUSED`), erreur HTTP distinguée du réseau perdu (`SERVER_ERROR`), délai des requêtes, tirage poursuivi après une erreur sur un jeu, commandes de l'auteur seulement, session gardée sur une erreur passagère, relance immédiate, pastille sur la joignabilité réelle, propriétaire des données adopté sans effacement. Ventes : livraisons et commandes acceptées gardées jusqu'au tirage de `orders`, actions en attente sur une commande, sort de l'argent demandé dès qu'une marchandise vendue n'est pas livrée, résultat gardé quand la commande quitte l'appareil, erreurs d'enregistrement rattrapées partout, encours local pour l'avertissement de crédit, compte de réception jamais désigné d'office, site de l'encaissement, encaissements en attente imputés avant l'aperçu, créances relues, ordre des créances aligné sur le serveur, recherche de clients en ligne (S-12), champs libres bornés, garde-fou réinitialisé à la navigation |
| F-08 | ECR-STK-01 « Stock par emplacement » | _à venir_ | Soldes de l'emplacement choisi (jeu `stock`), disponible pour cet appareil net des quotas des autres appareils (ADR-033) et des opérations de l'appareil en attente, quotas, lots en solde avec péremption, seuils (BR-STK-051, `evaluateStockThreshold`) avec réapprovisionnement suggéré ; filtre des produits sous le seuil, ouvert par l'action « Alertes de stock » du magasinier |

## 2. Écrans

Statut des écrans touchés par le fork (le statut de référence reste dans [`03-parcours-et-ecrans.md`](../01-functional/03-parcours-et-ecrans.md)).

| Écran | Route PWA | Statut | Hors ligne | Notes |
|---|---|---|---|---|
| ECR-ADM-03 | `/` et `/menu` | Enrichi (F-02) | Menu : oui ; accueil : non | Actions routées par le registre de l'appareil (ADR-050) |
| ECR-VEN-01 | `/ventes/nouvelle` | Livré (F-03) | Oui, dans la limite du stock exclusif ; emplacement partagé bloqué hors ligne tant que les quotas ne sont pas servis (S-05) | Action `NEW_SALE` |
| ECR-VEN-05 | `/ventes` et `/ventes/:saleId` | Livré (F-04) | Oui (7 derniers jours connus de l'appareil) | Reçu imprimable ; annulation directe ou demande |
| ECR-VEN-02 | `/commandes/nouvelle` | Livré (F-05) | Oui | Action `NEW_ORDER` ; pas de brouillon (`save_draft` est en ligne seulement) |
| ECR-VEN-03 | `/commandes` et `/commandes/:orderId` | Livré (F-05) | Partiel : ouvertes hors ligne, livrées ou closes en ligne | Action `FOLLOW_DELIVERIES` |
| ECR-VEN-04 | `/commandes/:orderId/livrer` | Livré (F-05) | Oui | Depuis le détail d'une commande |
| ECR-STK-01 | `/stock` | Livré (F-08) | Oui (périmètre téléchargé) | Action `STOCK_ALERTS` (filtre « sous le seuil ») ; transit entrant non compté tant que l'écran de réception n'est pas livré |
| ECR-VEN-06 | `/encaisser` | Livré (F-06), corrigé (F-07) | Oui (aperçu partiel hors ligne : ventes des 7 derniers jours) | Action `PAYMENTS` ; depuis le reçu d'une vente ; recherche de clients en ligne pour les rôles sans portefeuille (S-12) |

## 3. Vérifications

| Incrément | Tests PWA (vitest) | Typecheck | ESLint | Prettier | Navigateur |
|---|---|---|---|---|---|
| F-01 | 96 verts (15 fichiers) | OK | OK | OK | Différé : connexion requise (voir § 7) |
| F-02 | 105 verts (17 fichiers) | OK | OK | OK | Différé : connexion requise (voir § 7) |
| F-03 | 17 verts sur les ventes (logique et écran, dont une vente hors ligne) | OK | OK | OK | Différé : connexion requise (voir § 7) |
| F-04 | 5 verts (liste, reçu, annulation directe, annulation chaînée à une vente hors ligne, vente inconnue) | OK | OK | OK | Différé : connexion requise (voir § 7) |
| F-05 | 153 verts (24 fichiers), dont commandes (5), synchronisation durcie (6), encaissement (4), garde-fou (2) | OK | OK | OK | Différé : connexion requise (voir § 7) |
| F-06 | 157 verts (25 fichiers), dont encaissement des créances (4) | OK | OK | OK | Différé : connexion requise (voir § 7) |
| F-07 | 170 verts (27 fichiers), dont synchronisation durcie (9), opérations en vol (4), commandes (6), encaissement (5), garde-fou (3) | OK | OK | OK | Différé : connexion requise (voir § 7) |
| F-08 | 2 verts sur l'écran de stock (soldes, disponible, seuil ; filtre d'alertes) | OK | OK | OK | Différé : connexion requise (voir § 7) |

## 4. Besoins côté serveur et contrats

Constats faits en construisant les écrans, sans modification du serveur ni des contrats dans le fork. À reprendre par la session principale.

| # | Besoin | Pourquoi | Adaptation côté PWA en attendant |
|---|---|---|---|
| S-01 | Jeux `catalog` et `pricing` de l'architecture cible (01-architecture-offline.md §3.1) : le serveur publie les produits, unités, catégories, motifs, règles de prix, campagnes et fournisseurs par le repli générique du pipeline, un jeu par type d'agrégat (`product`, `price_rule`…), portée `GLOBAL` | Le nom du jeu dépend de l'`aggregate_type` choisi par l'appareil émetteur ; le filtre « produits vendables × zones × sites du périmètre » de `pricing` n'existe pas | La PWA tire chaque jeu par type d'agrégat (`pull.ts`) |
| S-02 | Projection `PRODUCT_STANDARD_COST` servie à tout appareil qui tire le jeu `product_standard_cost` | RC-05 : aucun coût sur l'appareil | La PWA ne tire pas ce jeu |
| S-03 | Tirage de plusieurs jeux par appel (`GET /sync/pull?datasets=…`) | 34 jeux = 34 appels par cycle de synchronisation (toutes les 30 s) | Appels successifs, un par jeu |
| S-04 | Renseigner dans `apps/server/src/home-api/role-catalog.ts` la route des actions dont l'écran est livré par le fork (ADR-030 §8) : voir le registre `apps/pwa/src/app/screens.ts` (`actionCodes`) | Sans route du serveur, l'appareil complète seul ; une route du serveur l'emporte | Registre des écrans de l'appareil (ADR-050) |
| S-05 | Lecteur de projection `STOCK_ALLOCATION` (jeu `allocations`, prévu en P5-18) : les lignes sont émises mais aucun lecteur ne les sert | Sans quota sur l'appareil, `decideLocalConsumption` bloque toute vente hors ligne sur un emplacement partagé (AV-025) | Quota tenu pour absent ; vente hors ligne possible sur un stock à garde exclusive, ou si le site autorise le dépassement (`sales.offline_over_allocation_allowed`) |
| S-06 | Profondeur de zone (`zone_depth`) absente de la projection `PRICE_RULE` | `resolvePrice` en a besoin pour la spécificité | Lue dans la projection `ZONE` de la règle (à défaut 1) |
| S-07 | Unités (`catalog_units`) et canaux de vente non synchronisés (aucun lecteur) ; données semées absentes du flux, sauf les moyens de paiement | Libellés d'unités et canaux inconnus de l'appareil ; un appareil neuf ne reçoit ni produits ni paramètres semés | Codes d'unité affichés tels quels ; canal déduit et envoyé explicitement ; paramètres absents = valeurs par défaut |
| S-08 | Une règle de prix retirée ou annulée n'est jamais retirée de l'appareil (pas de `DELETE` ni de `SCOPE_EXIT`) | Prix catalogue périmé hors ligne jusqu'à la fin de validité de la règle | Le serveur signale `PRICE_MISMATCH` ; en ligne, `PRICE_OUTDATED` est expliqué à l'écran |
| S-09 | Comptes de trésorerie mobile money et bancaires de l'entreprise : servis par le jeu `cash` à leurs seuls responsables ; la résolution du serveur est ambiguë dès deux comptes du type (`CASH_ACCOUNT_AMBIGUOUS`), même hors ligne | Un vendeur ne peut ni désigner le compte ni le laisser au serveur quand l'entreprise a un compte Orange et un compte MTN : tout encaissement mobile money est refusé | AV-300 : compte désigné quand l'appareil le connaît (seul compte du type d'office, choix si plusieurs) ; sinon laissé au serveur, avec un avertissement |
| S-10 | Unités (`catalog_units.is_count`) non synchronisées | Une quantité fractionnaire d'un produit compté est refusée par le serveur (`LINE_INVALID`), même hors ligne : la vente faite est perdue | Aucune : l'appareil ne sait pas quelle unité est comptée ; saisie par défaut entière (1) |
| S-11 | Session de caisse ouverte absente du jeu `cash` (prévue en P5-18) | P5-14 exige une session ouverte pour un encaissement en espèces au PDV (`CASH_SESSION_REQUIRED` en ligne, `CASH_SESSION_MISSING` hors ligne) : l'appareil ne peut pas prévenir | Le refus du serveur est affiché en clair ; aucun contrôle local |
| S-12 | Jeu `customers` non servi à la Finance ni à la Direction (portée `ALL`) | ECR-VEN-06 et l'encaissement au siège : le client ne peut pas être choisi hors ligne | Recherche en ligne sur `GET /api/v1/customers?q=` ; hors ligne, seuls les clients de l'appareil |
| S-13 | `captured_offline` fait partie de l'empreinte d'idempotence (`payload_hash` sur toute l'enveloppe) | L'appareil ne peut pas corriger le drapeau après coup sans faire refuser un renvoi (`COMMAND_ID_REUSED`) ; une saisie faite juste après la perte du réseau part marquée « en ligne » | Drapeau fixé à la saisie par la joignabilité constatée (ADR-051 §1, §2) ; enveloppe jamais modifiée |
| S-14 | Colonnes `DATE` (péremption des lots, ouverture d'un site) servies comme instants à minuit local du serveur | La date affichée dépend du fuseau du serveur | Date lue dans le fuseau métier `Africa/Douala` (`businessDayOf`) |

## 5. AV proposés

Plage réservée au fork : AV numérotés de 300 à 349. Chaque point est à reporter dans [`A-VALIDER.md`](../A-VALIDER.md) par la session principale lors de la fusion ; le défaut est implémenté de façon paramétrable.

Tant qu'ils ne sont pas reportés dans le registre, `check_refs.py` signale ces AV comme références orphelines : c'est attendu, la fusion les définit.

| AV | Question | Défaut implémenté | Classe |
|---|---|---|---|
| AV-300 | Quel compte reçoit un encaissement mobile money ou bancaire quand l'entreprise a plusieurs comptes du type (Orange et MTN) et que l'appareil du vendeur n'en connaît aucun ? Pourquoi : BR-FIN-002 et AV-139 laissent l'appareil désigner le compte, mais le jeu `cash` ne sert ces comptes qu'à leurs responsables ; le serveur refuse alors l'encaissement (`CASH_ACCOUNT_AMBIGUOUS`), y compris une vente faite hors ligne. Choix : (a) publier les comptes d'entreprise à tous les appareils qui encaissent ; (b) rattacher chaque moyen de paiement à un compte (Orange → compte Orange) ; (c) laisser l'appareil sans compte et accepter l'encaissement en attente d'affectation par la Finance. Recommandation : (b), simple et sans saisie de plus pour le vendeur ; (c) pour les faits hors ligne. Impact : serveur (`cash-account-resolution.ts`, jeu `cash`), PWA (bloc d'encaissement) | Compte jamais désigné d'office (« seul compte connu de l'appareil » n'est pas « seul compte de l'entreprise ») : choix proposé dès que l'appareil connaît un compte du type, obligatoire s'il en connaît plusieurs ; sinon aucun compte envoyé et avertissement affiché (`payment.ts`) | Important |

## 6. ADR proposés

Plage réservée au fork : ADR numérotés de 050 à 059.

| ADR | Décision |
|---|---|
| [ADR-051](../decisions/ADR-051-synchronisation-appareil-durcie.md) | Synchronisation de l'appareil durcie : joignabilité réelle du serveur, enveloppe immuable (`captured_offline` fixé à la saisie), décompte jusqu'au tirage des jeux `stock`, `orders` et `customers`, reprise des envois interrompus, un seul titulaire des données, erreur du serveur distinguée du réseau perdu, commandes de l'auteur seulement, session gardée sur une erreur passagère, relance immédiate. Ligne d'index à ajouter à la fusion |
| [ADR-050](../decisions/ADR-050-navigation-par-role-sur-l-appareil.md) | Navigation par rôle sur l'appareil : registre des écrans de la PWA, route complétée par l'appareil, navigation mémorisée hors ligne (store `navigation`), menu `/menu`. Ligne d'index à ajouter dans `docs/decisions/README.md` à la fusion |

## 7. Environnement du fork

- Serveurs de développement lancés depuis le worktree par deux entrées ajoutées au `.claude/launch.json` du dépôt principal (fichier local non versionné) : `fork-pwa:server` (port 3000, base `gic_agropelc_dev`) et `fork-pwa:pwa` (port 5173). L'outil d'aperçu lit la configuration du dépôt principal, pas celle du worktree ; les entrées `server:dev` et `pwa:dev` existantes sont inchangées.
- Vérification dans le navigateur : la connexion avec le compte administrateur local exige de saisir ses identifiants, que le fork ne lit ni ne recopie ; le porteur se connecte lui-même dans le panneau du navigateur, puis le fork poursuit.
