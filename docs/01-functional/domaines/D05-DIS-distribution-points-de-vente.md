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
| BR-DIS-001 | Un PDV est un site de type `POINT_DE_VENTE`. Il a exactement un emplacement de vente par défaut (type `POS`) et un compte de caisse de type `CAISSE_PDV`. | C (CM §12) / D |
| BR-DIS-002 | Mode de garde de l'emplacement de vente (BR-STK-010) : `EXCLUSIVE_DEVICE` si le PDV fonctionne avec un seul appareil désigné (recommandé par défaut) ; `SHARED` si plusieurs appareils vendent simultanément, auquel cas des allocations sont nécessaires pour vendre hors ligne. | D (CM §39) / AV-035 |
| BR-DIS-003 | Les vendeurs d'un PDV sont les utilisateurs qui ont le rôle `VENDEUR_PDV` avec une portée `SITE` sur ce PDV. Un vendeur ne vend que dans le PDV auquel son appareil est rattaché pour la session en cours. | C (CM §12) / D |
| BR-DIS-004 | Les prix du PDV sont résolus par le moteur de tarification avec le contexte du PDV : PDV > zone du PDV > zones parentes > global (D10). | C (CM §12, §29) |
| BR-DIS-005 | Un encaissement **en espèces** au PDV exige une session de caisse ouverte. Sans session ouverte, l'écran de vente propose d'abord « Ouvrir la caisse ». | AV-057 |
| BR-DIS-006 | Au plus une session ouverte par compte de caisse. Une session ouverte depuis plus de 24 h déclenche une alerte. | D |
| BR-DIS-007 | À la clôture, le vendeur compte les espèces. Solde attendu = fonds d'ouverture + encaissements espèces + autres entrées − remboursements − dépenses payées par la caisse − remises de fonds envoyées. Écart = compté − attendu. Si l'écart est non nul, il est enregistré en mouvement de caisse `SESSION_VARIANCE` et la validation Finance est requise. | C (CM §54 « anomalie de caisse ») / AV-057 |
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
| Ouverture : aucune session ouverte sur la caisse ; fonds ≥ 0 | `CASH_SESSION_ALREADY_OPEN` |
| Clôture : session ouverte ; comptage ≥ 0 | `CASH_SESSION_NOT_OPEN` |
| Vente en espèces sans session ouverte | `CASH_SESSION_REQUIRED` |
| Configuration : emplacement de vente appartenant au PDV ; caisse de type `CAISSE_PDV` rattachée au PDV | `POS_CONFIG_INVALID` |

## 9. Dépendances

ADM (sites, emplacements, appareils), STK (transferts, allocations, seuils, inventaires, pertes), VEN (ventes), FIN (caisse), PRX (prix), NOT (alertes), ANA (tableau de distribution).

## 10. Événements produits

`CashSessionOpened`, `CashSessionClosed`, `CashVarianceDetected`, `CashSessionValidated`, `CashTransferSent`, `CashTransferReceived`, `CashTransferDiscrepancyDetected`, `ReplenishmentSuggested` (interne, source d'alerte). Les événements de stock et de vente sont ceux de D04 et D06.

## 11. Événements consommés

`SaleConfirmed` et `SaleCancelled` (calcul du solde attendu de caisse), `StockThresholdBreached` (alerte de réapprovisionnement), `StockTransferDispatched` (notification au PDV destinataire), `PaymentReceived` (solde attendu).

## 12. Fonctionnement hors ligne

- Le PDV doit pouvoir **vendre toute la journée sans réseau** (CM §37).
- La session de caisse s'ouvre et se clôture localement. Le solde attendu est calculé localement à partir des opérations de l'appareil. La validation a lieu en ligne.
- En mode `EXCLUSIVE_DEVICE`, tout le stock du PDV est utilisable hors ligne par l'appareil désigné.
- En mode `SHARED`, chaque appareil n'utilise que son allocation.
- La réception d'un approvisionnement est possible sans le document (BR-STK-024) en mode exclusif.
- Les tableaux de distribution sont en ligne ; ils affichent la fraîcheur de synchronisation de chaque PDV (dernier contact de l'appareil).

## 13. Permissions

`org.structure.manage` (configuration), `finance.cash_session.operate`, `finance.cash_session.validate`, `finance.cash_transfer.record`, `inventory.transfer.request`, `inventory.transfer.dispatch`, `inventory.transfer.receive`, `inventory.allocation.manage`, `analytics.dashboard.distribution`.

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Vendeur oublie de clôturer la caisse | Alerte après 24 h (BR-DIS-006) ; la session suivante ne peut pas être ouverte tant que la précédente n'est pas clôturée. Un responsable peut forcer la clôture (`finance.cash_session.validate`), avec un comptage déclaré a posteriori. |
| Tablette du PDV en panne | Changement d'appareil désigné (BR-DIS-014). Si l'ancien appareil est irrécupérable, il est révoqué et un inventaire + comptage de caisse sont exigés. |
| PDV hors ligne plusieurs jours | Ventes limitées au stock détenu ; réception sans document possible ; à la reconnexion, rapprochement complet. Au-delà de l'autonomie maximale (AV-009), passage en lecture seule. |
| Écart de caisse récurrent | Alerte `CASH_VARIANCE` avec historique par vendeur ; décision humaine. |
