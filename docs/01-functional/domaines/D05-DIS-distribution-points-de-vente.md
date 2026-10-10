# D05 — Distribution et points de vente (DIS)

> Couvre : configuration du point de vente, mode de garde de son stock, vendeurs, caisse du point de vente (sessions, clôture, remises de fonds), réapprovisionnement, suivi « envoyé / vendu / restant / perdu / encaissé / à réapprovisionner ».
> Ce domaine **compose** des capacités d'autres modules : `organization` (PDV), `inventory` (transferts, allocations, seuils, inventaires), `sales` (ventes), `finance` (caisse). Il ne possède aucune table en propre en dehors de `organization.points_of_sale`.

---

## 1. Objectif

Faire fonctionner chaque point de vente comme une **unité opérationnelle identifiable**, qui vend même sans réseau. La direction doit savoir presque immédiatement :

- ce qui y a été envoyé ;
- ce qui a été vendu ;
- ce qui reste ;
- ce qui a été perdu ;
- ce qui a été encaissé ;
- s'il faut réapprovisionner.

Sources : CM §12, §22, §23, §39, §54 ; PM §14.

## 2. Acteurs

`VENDEUR_PDV`, `MAGASINIER` (approvisionnement des PDV), `RESP_COMMERCIAL` (supervision commerciale des PDV), `FINANCE` (validation des caisses), `DIRECTION`, `system` (suggestions, alertes).

## 3. Principales entités

| Entité | Table (module propriétaire) | Rôle |
|---|---|---|
| Point de vente | `organization.sites` + `organization.points_of_sale` | Configuration : emplacement de vente, caisse, appareil désigné, source de réapprovisionnement |
| Emplacement de vente | `organization.locations` (type `POS`) | Stock du PDV |
| Compte de caisse du PDV | `finance.cash_accounts` (type `CAISSE_PDV`) | Argent du PDV |
| Session de caisse | `finance.cash_sessions` | Ouverture, clôture, écart |
| Remise de fonds | `finance.cash_transfers` | PDV → caisse centrale ou banque |
| Transferts, allocations, seuils, inventaires | `inventory.*` | Voir D06 |

## 4. Cas d'usage

| ID | Cas d'usage | Commande technique | Acteur | Hors ligne |
|---|---|---|---|---|
| UC-DIS-01 | Configurer un PDV (emplacement, caisse, mode de garde, appareil désigné, source de réappro) | `organization.pos.configure` | ADMIN | Non |
| UC-DIS-02 | OUVRIR LA CAISSE (fonds compté) | `finance.cash_session.open` | VENDEUR_PDV | **Oui** |
| UC-DIS-03 | CLÔTURER LA CAISSE (comptage) | `finance.cash_session.close` | VENDEUR_PDV | **Oui** |
| UC-DIS-04 | Valider une session de caisse et son écart | `finance.cash_session.validate` | FINANCE | Non |
| UC-DIS-05 | Remettre les fonds (envoi) ; confirmer la réception des fonds | `finance.cash_transfer.send`, `finance.cash_transfer.receive` | VENDEUR_PDV ; FINANCE | **Oui** (envoi) |
| UC-DIS-06 | Demander un réapprovisionnement (avec suggestion) | `inventory.transfer.request` | VENDEUR_PDV | **Oui** |
| UC-DIS-07 | Approvisionner un PDV (expédition) | `inventory.transfer.dispatch` | MAGASINIER | **Oui** |
| UC-DIS-08 | Recevoir un approvisionnement au PDV | `inventory.transfer.receive` | VENDEUR_PDV | **Oui** |
| UC-DIS-09 | Retourner du stock au magasin ; transférer vers un autre PDV | `inventory.transfer.dispatch` | VENDEUR_PDV | **Oui** |
| UC-DIS-10 | Accorder des allocations aux appareils d'un PDV partagé | `inventory.allocation.grant` | MAGASINIER, responsable du PDV | Non |
| UC-DIS-11 | Suivre la distribution par PDV | requête (ECR-DIS-04) | DIRECTION, RESP_COMMERCIAL, MAGASINIER | Non |

Ventes, pertes et inventaires au PDV : voir D04 et D06.

## 5. Entrées

Transferts expédiés vers le PDV, ventes, pertes, inventaires, encaissements, comptages de caisse, seuils.

## 6. Sorties

Tableau de distribution par PDV et période, suggestions de réapprovisionnement, écarts de caisse, alertes `POS_REPLENISH`, `STOCK_LOW`, `STOCK_OUT`, `CASH_VARIANCE`.

## 7. Règles métier

| ID | Règle | Statut |
|---|---|---|
| BR-DIS-001 | Un PDV est un site de type `POINT_DE_VENTE`. Il a exactement un emplacement de vente par défaut (type `POS`, qui ne se désactive pas seul : `LOCATION_IS_POS_SALES_LOCATION`) et un compte de caisse de type `CAISSE_PDV`. | C (CM §12) / D |
| BR-DIS-002 | Mode de garde de l'emplacement de vente (BR-STK-010) : `EXCLUSIVE_DEVICE` si le PDV fonctionne avec un seul appareil désigné (recommandé par défaut) ; `SHARED` si plusieurs appareils vendent simultanément, auquel cas des allocations sont nécessaires pour vendre hors ligne. | D (CM §39) / AV-035 |
| BR-DIS-003 | Les vendeurs d'un PDV sont les utilisateurs qui ont le rôle `VENDEUR_PDV` avec une portée `SITE` sur ce PDV. Un vendeur ne vend que dans le PDV auquel son appareil est rattaché pour la session en cours. | C (CM §12) / D |
| BR-DIS-004 | Les prix du PDV sont résolus par le moteur de tarification avec le contexte du PDV : PDV > zone du PDV > zones parentes > global (D10). | C (CM §12, §29) |
| BR-DIS-005 | Un encaissement **en espèces** au PDV exige une session de caisse ouverte. Sans session ouverte, l'écran de vente propose d'abord « Ouvrir la caisse ». | AV-057 |
| BR-DIS-006 | Au plus une session ouverte par compte de caisse (INV-FIN-06) ; seule une caisse de PDV ouvre une session (AV-165). Une ouverture qui chevaucherait une session de la caisse (ouverte, ou close après l'heure d'ouverture) ou dépasserait la limite de sessions du jour métier (`finance.cash_sessions_per_day_max`, 1 par défaut) est refusée en ligne et, hors ligne, fusionnée dans la session existante avec un conflit informatif (AV-154, AV-167, AV-168). Une session ouverte depuis **plus de** `finance.cash_session_force_close_hours` (24 h par défaut, réglable par site) est signalée par la tâche `finance.cash_sessions.open_long_check` (événement `CashSessionOpenLongDetected` ; alerte `CASH_SESSION_OPEN_LONG` en P9) et peut être clôturée d'office par la Finance (§14, §15). | D (P5-12) / AV-154 |
| BR-DIS-007 | À la clôture, le vendeur compte les espèces. **Solde attendu** = fonds compté à l'ouverture + Σ entrées − Σ sorties des mouvements du registre de la caisse dont l'`occurred_at` est dans la fenêtre `[ouverture, clôture[` de la session, hors `SESSION_VARIANCE` et `OPENING_BALANCE` (ADR-032 §3) : encaissements espèces, autres entrées, remboursements, dépenses payées par la caisse et remises de fonds envoyées sont des mouvements ordinaires du registre, aucun n'est compté à part. Le serveur calcule seul l'attendu et l'écart ; la commande ne porte que le montant compté. Écart = compté − attendu. Un écart non nul est enregistré en mouvement de caisse `SESSION_VARIANCE` ; la session est validée d'office si l'écart d'ouverture et l'écart de clôture sont nuls ou dans la tolérance (`finance.cash_variance_tolerance_xaf`, 0 par défaut), sinon la validation Finance est requise. | C (CM §54 « anomalie de caisse ») / D (ADR-032) / AV-057 |
| BR-DIS-008 | Une session validée est **immuable**. Une vente hors ligne tardive rattachée à une session validée ouvre un écart complémentaire, lui aussi à valider (D04 §14). | D |
| BR-DIS-009 | La remise de fonds se fait en deux temps : envoi (sortie de la caisse PDV) puis réception (entrée dans la caisse centrale ou en banque). Un écart entre les deux ouvre `CASH_TRANSFER_DISCREPANCY`. | D |
| BR-DIS-010 | Indicateurs de distribution par PDV × produit × période (sur `occurred_at`) : **envoyé** = Σ quantités expédiées vers le PDV ; **reçu** = Σ quantités reçues ; **vendu** = Σ ventes depuis le PDV (net des annulations) ; **perdu** = Σ pertes reconnues au PDV + écarts d'inventaire négatifs ; **restant** = solde courant ; **encaissé** = Σ encaissements enregistrés au PDV ; **à réapprovisionner** = suggestion BR-STK-051. | C (CM §12, §2/Distribution) / D (formules) |
| BR-DIS-011 | La suggestion de réapprovisionnement ne crée jamais de transfert automatiquement : un humain crée la demande ou l'expédition. | D (CM §54 « provoquer une action ») |
| BR-DIS-012 | Les retours vers le magasin et les transferts entre PDV sont des transferts ordinaires (BR-STK-020). | C (CM §22) |
| BR-DIS-013 | Les petites dépenses payées depuis la caisse du PDV sont permises pour les catégories autorisées et sous un plafond. Elles diminuent le solde attendu de la session. | AV-058 |
| BR-DIS-014 | Le changement d'appareil désigné d'un PDV `EXCLUSIVE_DEVICE` exige que l'ancien appareil ait tout synchronisé ou ait été révoqué (BR-STK-016). | D |

## 8. Validations

| Contrôle | Erreur |
|---|---|
| Ouverture : caisse de PDV (AV-165), en ligne comme hors ligne | `CASH_SESSION_POS_ACCOUNT_REQUIRED` |
| Ouverture : caisse connue ; portée `finance.cash_session.operate` sur le site de la caisse (en ligne comme hors ligne) | `NOT_FOUND`, `FORBIDDEN_SCOPE` |
| Ouverture en ligne : site ouvert ; caisse active | `SITE_CLOSED`, `CASH_ACCOUNT_INACTIVE` (hors ligne : appliquée ; site fermé depuis : avertissement `CASH_SESSION_SITE_CLOSED` ; caisse désactivée : avertissement `CASH_ACCOUNT_INACTIVE`) |
| Ouverture en ligne : aucune session ouverte sur la caisse ; aucune session dont la fenêtre couvre l'heure d'ouverture ; limite de sessions du jour métier | `CASH_SESSION_ALREADY_OPEN`, `CASH_SESSION_OVERLAP`, `CASH_SESSION_DAILY_LIMIT` (hors ligne : fusion ou décalage, avertissement `CASH_SESSION_CONCURRENT_OPEN`) |
| Fonds compté et comptage de clôture : entiers ≥ 0 | `VALIDATION_ERROR` (schéma partagé) |
| Fonds ou comptage dont l'écart avec le solde ou l'attendu sort des entiers représentables (compté démesuré face à un registre négatif) ; validité du montant, refusé en ligne comme hors ligne | `CASH_AMOUNT_INVALID` |
| Clôture en ligne : session ouverte ; heure de clôture ≥ heure d'ouverture ; session connue (ou alias d'une ouverture fusionnée) | `CASH_SESSION_NOT_OPEN`, `CASH_SESSION_CLOSE_BEFORE_OPEN` (hors ligne : observation, avertissement `CASH_SESSION_CONCURRENT_CLOSE`) ; `NOT_FOUND` |
| Clôture en ligne, ordinaire ou forcée : aucun mouvement du compte (hors écarts et solde d'ouverture) daté à l'heure de clôture ou après (AV-171) | `CASH_SESSION_CLOSE_BEFORE_LAST_MOVEMENT` (hors ligne : appliquée, jamais validée d'office, avertissement `CASH_SESSION_CLOSE_BEFORE_MOVEMENTS`) |
| Clôture forcée : en ligne ; permission `finance.cash_session.validate` ; session ouverte depuis plus du seuil | `ONLINE_REQUIRED`, `FORBIDDEN`, `FORBIDDEN_SCOPE`, `CASH_SESSION_NOT_OPEN`, `CASH_SESSION_FORCE_CLOSE_TOO_EARLY` |
| Désactivation d'une caisse dont une session est ouverte | `CASH_ACCOUNT_HAS_OPEN_SESSION` |
| Désactivation de l'emplacement de vente, ou fermeture du site, dont la caisse a une session ouverte | `LOCATION_HAS_OPEN_CASH_SESSION` |
| Vente en espèces sans session ouverte | `CASH_SESSION_REQUIRED` |
| Configuration : emplacement de vente appartenant au PDV ; caisse de type `CAISSE_PDV` rattachée au PDV | `POS_CONFIG_INVALID` |

## 9. Dépendances

ADM (sites, emplacements, appareils), STK (transferts, allocations, seuils, inventaires, pertes), VEN (ventes), FIN (caisse), PRX (prix), NOT (alertes), ANA (tableau de distribution).

## 10. Événements produits

`CashSessionOpened`, `CashSessionClosed`, `CashVarianceDetected`, `CashSessionOpenLongDetected` (P5-12, tâche), `CashSessionValidated`, `CashTransferSent`, `CashTransferReceived`, `CashTransferDiscrepancyDetected`, `ReplenishmentSuggested` (interne, source d'alerte). Les événements de stock et de vente sont ceux de D04 et D06.

## 11. Événements consommés

`SaleConfirmed` et `SaleCancelled` (calcul du solde attendu de caisse), `StockThresholdBreached` (alerte de réapprovisionnement), `StockTransferDispatched` (notification au PDV destinataire), `PaymentReceived` (solde attendu).

## 12. Fonctionnement hors ligne

- Le PDV doit pouvoir **vendre toute la journée sans réseau** (CM §37).
- La session de caisse s'ouvre et se clôture localement. Le solde attendu est calculé localement à partir des opérations de l'appareil, à titre **indicatif** : le serveur le recalcule sur le registre, par fenêtre de temps (ADR-032 §3), et une tablette d'un PDV partagé ne voit pas les ventes des autres. La validation a lieu en ligne.
- En mode `EXCLUSIVE_DEVICE`, tout le stock du PDV est utilisable hors ligne par l'appareil désigné.
- En mode `SHARED`, chaque appareil n'utilise que son allocation.
- La réception d'un approvisionnement est possible sans le document (BR-STK-024) en mode exclusif.
- Les tableaux de distribution sont en ligne ; ils affichent la fraîcheur de synchronisation de chaque PDV (dernier contact de l'appareil).

## 13. Permissions

`org.structure.manage` (configuration), `finance.cash_session.operate`, `finance.cash_session.validate`, `finance.cash_transfer.record`, `inventory.transfer.request`, `inventory.transfer.dispatch`, `inventory.transfer.receive`, `inventory.allocation.manage`, `analytics.dashboard.distribution`.

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Vendeur oublie de clôturer la caisse | Alerte après plus de 24 h (paramètre `finance.cash_session_force_close_hours`, tâche `finance.cash_sessions.open_long_check`, BR-DIS-006). En ligne, la session suivante ne peut pas être ouverte tant que la précédente n'est pas clôturée (`CASH_SESSION_ALREADY_OPEN`) ; hors ligne, l'ouverture est fusionnée dans la session de la veille (AV-154). La Finance ou la Direction clôturent la session d'office (`finance.cash_session.force_close`, permission `finance.cash_session.validate`, au-delà du seuil), avec un comptage déclaré a posteriori ; une ouverture saisie hors ligne pendant ce temps et synchronisée ensuite prend effet à la clôture forcée (AV-168). |
| Tablette du PDV en panne | Changement d'appareil désigné (BR-DIS-014). Si l'ancien appareil est irrécupérable, il est révoqué et un inventaire + comptage de caisse sont exigés. |
| PDV hors ligne plusieurs jours | Ventes limitées au stock détenu ; réception sans document possible ; à la reconnexion, rapprochement complet. Au-delà de l'autonomie maximale (AV-009), passage en lecture seule. |
| Écart de caisse récurrent | Alerte `CASH_VARIANCE` avec historique par vendeur ; décision humaine. |

## 15. Choix d'implémentation (P5-12)

Précisions retenues par le module `finance` pour les sessions de caisse (`cash-session-commands.ts`, logique partagée `packages/domain/src/cash-session-lifecycle.ts`), là où les règles laissent un choix ; toutes **DÉDUITES**, sauf mention d'un point AV.

| Point | Choix | Justification |
|---|---|---|
| Ouverture (`finance.cash_session.open`, hors ligne possible) | Agrégat `CASH_SESSION`, identifiant choisi par l'appareil (UUIDv7) ; charge utile `cashAccountId`, `countedXaf`, `comment?`. Contrôles dans l'ordre : identifiant déjà connu (sans effet) ; caisse connue (`NOT_FOUND`) ; caisse de PDV (`CASH_SESSION_POS_ACCOUNT_REQUIRED`, même hors ligne : erreur de validité, pas d'état) ; portée `operate` sur le site de la caisse (`FORBIDDEN_SCOPE`) ; en ligne seulement, site ouvert (`SITE_CLOSED`) et caisse active (`CASH_ACCOUNT_INACTIVE`) ; sessions de la caisse et limite du jour (`planCashSessionOpen`). Hors ligne, une caisse désactivée depuis ouvre la session (fait accompli) avec l'avertissement `CASH_ACCOUNT_INACTIVE` et un conflit pour la Finance ; un site fermé depuis (`organization.site.close` ne désactive pas ses caisses, et sa garde ne voit pas une ouverture pas encore synchronisée) aussi, avec l'avertissement et le conflit appliqué `CASH_SESSION_SITE_CLOSED` pour la Finance, qui clôture la session. `opened_at` = `occurred_at` (ou l'heure retenue, AV-168) ; site copié de la caisse ; appareil, réception et horloge suspecte lus dans l'inbox. Réponse : `cashSessionId`, `openedAt`, `openingExpectedXaf`, `openingVarianceXaf` (montants en chaîne décimale). | ADR-032 §2, §8 ; AV-154, AV-165 ; BR-SYN-007. |
| Écart d'ouverture | Fonds compté − solde du **registre** à l'ouverture : Σ signée des mouvements d'`occurred_at` antérieur, plus les `SESSION_VARIANCE` de l'instant exact (écart d'une clôture précédente au même instant, compté une seule fois : `countsInOpeningBalance`), jamais la projection `balance_xaf`. Écart non nul : mouvement `SESSION_VARIANCE` à `opened_at`, rattaché à la session ; il appartient à la période précédente, n'entre pas dans l'attendu et se valide avec la session (le fonds initial d'une caisse neuve est un écart d'ouverture positif, AV-156). | ADR-032 §4 ; BR-FIN-014 ; AV-156. |
| Ouverture concurrente ou en course hors ligne | En ligne : refus sans effet (`CASH_SESSION_ALREADY_OPEN` si une session ouverte est en cause, `CASH_SESSION_OVERLAP` si l'heure tombe dans la fenêtre d'une session close, `CASH_SESSION_DAILY_LIMIT`). Hors ligne : **fusion** dans la plus ancienne session en cause — ni session ni mouvement, comptage conservé dans le conflit `CASH_SESSION_CONCURRENT_OPEN` (appliqué, propriétaire Finance) sur l'identifiant proposé, avertissement du même nom, `server_refs.cashSessionId` = session retenue. Une ouverture plus ancienne que la session qu'elle chevauche y est fusionnée sans changer sa fenêtre (AV-167, `earlierThanTarget`). Une ouverture dont l'heure tombe dans la fenêtre d'une session d'un jour métier **antérieur**, close depuis (clôture forcée), prend effet à la clôture de cette session (AV-168, issue `SHIFTED` ; `flowsBetweenXaf` = solde des mouvements de l'intervalle, qui explique l'écart d'ouverture). Limite du jour comptée **par caisse** (une seule caisse de PDV active par site, BR-FIN-010 ; une caisse remplacée dans la journée repart de zéro). Une seconde commande d'ouverture sur un identifiant déjà fusionné est fusionnée de nouveau (cas rare, sans effet sur l'argent ; la recherche d'alias est réservée à la clôture). | AV-154, AV-167, AV-168 ; ADR-032 §2, §8 ; INV-FIN-06. |
| Clôture (`finance.cash_session.close`, hors ligne possible) | Charge utile `countedXaf`, `comment?` ; tout vendeur du site (portée `operate`) peut clôturer : `closed_by` = l'auteur, à qui l'écart est imputé (AV-155). Identifiant d'une ouverture fusionnée : la clôture vise la session retenue (alias lu dans le conflit `CASH_SESSION_CONCURRENT_OPEN`) ; identifiant inconnu : `NOT_FOUND`. Attendu calculé par le serveur par fenêtre `[opened_at, closed_at[` ; écart non nul : `SESSION_VARIANCE` à `closed_at`. Statut : `VALIDATED` d'office (`auto_validated`, `validated_at` = `closed_at`, sans valideur) si l'écart d'ouverture **et** l'écart de clôture sont dans la tolérance (`finance.cash_variance_tolerance_xaf` du site, à défaut global, 0) ; l'écart toléré non nul est posé quand même (INV-FIN-11) ; sinon `PENDING_VALIDATION`, sans demande `CASH_VARIANCE` avant P5-13 (`approval_request_id` nul). **La validation d'office est livrée en P5-12 ; P5-13 ne porte que la validation par la Finance et la réévaluation.** Réponse : `cashSessionId`, `closingExpectedXaf`, `varianceXaf`, `status`. | SM-CASH-SESSION ; ADR-032 §3, §5 ; AV-057, AV-155. |
| Clôture concurrente, après une clôture forcée, ou datée avant l'ouverture | En ligne : `CASH_SESSION_NOT_OPEN`, `CASH_SESSION_CLOSE_BEFORE_OPEN`. Hors ligne : **observation** — session et registre inchangés (INV-FIN-05 pour une session validée), comptage conservé dans le conflit `CASH_SESSION_CONCURRENT_CLOSE` (appliqué, Finance ; raison `ALREADY_CLOSED` ou `CLOSE_BEFORE_OPEN`, état existant consigné), avertissement du même nom. Une clôture datée avant l'ouverture laisse la session ouverte (AV-169) : une clôture ultérieure ou la clôture forcée la referme ; le `CHECK` `closed_at ≥ opened_at` n'est jamais atteint. | ADR-032 §8 ; AV-169 ; BR-SYN-007. |
| Clôture datée avant un mouvement déjà enregistré (AV-171) | L'attendu `[ouverture, clôture[` exclut tout mouvement daté à l'heure de clôture ou après : une clôture antidatée donnerait un écart nul et une validation d'office, la différence retombant sur l'ouvreur suivant. Contrôle sous les verrous, après la fenêtre : mouvement le plus récent du compte daté à `closed_at` ou après, hors `SESSION_VARIANCE` et `OPENING_BALANCE` (borne incluse). En ligne, clôture ordinaire **et forcée** : refus sans effet `CASH_SESSION_CLOSE_BEFORE_LAST_MOVEMENT` (`occurred_at` n'est jamais corrigé, ADR-016). Hors ligne (fait accompli) : clôture appliquée, jamais `VALIDATED` d'office, avertissement et conflit appliqué `CASH_SESSION_CLOSE_BEFORE_MOVEMENTS` (`latestMovementAt`, attendu, écart, statut). Un mouvement enregistré **après** la clôture et daté après elle (opération tardive) relève de la réévaluation (P5-13). | AV-171 ; ADR-016, ADR-032 §3 ; BR-SYN-007. |
| Clôture forcée (`finance.cash_session.force_close`, en ligne) | Hors ligne : `ONLINE_REQUIRED`. Permission `finance.cash_session.validate` (Finance, Direction), portée du site. Session ouverte (`CASH_SESSION_NOT_OPEN`) depuis **plus de** `finance.cash_session_force_close_hours` (site, global, 24) à l'`occurred_at` de la commande, borne stricte (`CASH_SESSION_FORCE_CLOSE_TOO_EARLY`). Comptage déclaré et motif obligatoires ; même calcul qu'une clôture ; statut toujours `PENDING_VALIDATION`, même sans écart ; `force_closed`, `forced_by` = `closed_by` = l'auteur ; le motif est conservé dans l'audit et dans `CashSessionClosed` (aucune colonne : `variance_reason` est celle du valideur, P5-13). L'écart est imputé à l'ouvreur de la session, pas à l'agent de la Finance (AV-170). | SM-CASH-SESSION ; §14 ; AV-170. |
| Index `cash_session_id` | `recordCashMovement` le pose à l'insertion pour une caisse de PDV : la session dont la fenêtre couvre `occurred_at` **au moment de l'écriture** (lecture verrouillante après le verrou du compte), sinon `NULL` ; pour un inverse, l'index de l'original, à défaut la session couvrant sa date (AV-157) ; une valeur explicite de l'appelant prime (écarts de session). Jamais réécrit : une ouverture hors ligne appliquée après coup ne rattache pas les mouvements déjà écrits, et une clôture rétrodatée peut laisser un mouvement indexé hors de la fenêtre. L'attendu et INV-FIN-11 se lisent toujours par fenêtre de temps (à retenir pour P5-13, qui détecte les opérations tardives). API publique `findCashSessionCovering` (pour `sales` en P5-14). | ADR-032 §2 ; AV-157. |
| Gardes de désactivation | `finance.cash_account.deactivate` refuse une caisse dont une session est ouverte (`CASH_ACCOUNT_HAS_OPEN_SESSION`, avant le contrôle du solde). La garde `finance` du registre d'`organization` refuse la désactivation de l'emplacement de vente (`POS`) d'un site dont la caisse de PDV a une session ouverte, et donc la fermeture du site (`LOCATION_HAS_OPEN_CASH_SESSION`). Limite connue : un site sans emplacement `POS` actif ne consulte pas cette garde à sa fermeture (le registre est par emplacement). | BR-ADM-011 ; dictionnaire `organization.locations`. |
| Tâche et événements | Tâche `finance.cash_sessions.open_long_check` (processus worker) : un `CashSessionOpenLongDetected` par session ouverte depuis plus du seuil (site, global, 24 h) et par jour métier, sans modifier la session ; planification au déploiement. Événements explicites (producteur `finance`, agrégat `CASH_SESSION`) : `CashSessionOpened` (création seulement, jamais pour une fusion), `CashSessionClosed` (clôture et clôture forcée), `CashVarianceDetected` (phase `OPENING` ou `CLOSING`, gravité `WARNING` ou `CRITICAL` selon `finance.cash_variance_critical_xaf`, responsable imputé `imputed_user_id`, distinct du clôtureur et de l'auteur d'une clôture forcée). | BR-DIS-006 ; D13 ; catalogue d'événements §2.8. |
| Ordre des verrous | Ouverture : site (partagé), caisse (exclusif), sessions de la caisse (exclusif), registre (partagé). Clôture et clôture forcée : lecture simple de la session, puis site, caisse, session (exclusif), registre. `recordCashMovement` : caisse, puis session couvrante (partagé). Garde d'emplacement : sessions (partagé), sans verrou de caisse. Le site d'abord : l'insertion d'une session ou d'un conflit verrouille la ligne du site en partage (clé étrangère) ; `organization.site.close`, qui tient le site en exclusif puis consulte la garde, ne forme donc pas de cycle avec une ouverture (test de concurrence). Toute donnée qui fonde une décision est lue en lecture verrouillante (l'instantané de la transaction peut précéder le verrou du compte). Les trois commandes de session s'exécutent en **lecture confirmée** (`isolationLevel: 'read committed'` à l'enregistrement, `CommandHandlerRegistry`) : sous la lecture répétable, les lectures verrouillantes par plage de deux caisses voisines dans l'index (deux caisses neuves : identifiants UUIDv7 consécutifs) verrouillaient le même intervalle puis s'attendaient à l'`INSERT` (interblocage 1213 ; ouvertures parallèles de deux caisses vierges : `RETRY_LATER` sur 7 tours de 8). La sérialisation d'un compte reste portée par le verrou exclusif de sa ligne. | ADR-032 §10 ; ADR-034 (lecture confirmée) ; P5-22 (écrit dans D04 §15, D06, D09). |
