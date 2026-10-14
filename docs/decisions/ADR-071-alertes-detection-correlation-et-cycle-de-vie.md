# ADR-071 — Alertes : catalogue déclaratif, détection par les propriétaires, corrélation par `communication`, cycle de vie

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; applique D13, SM-ALERT, BR-NOT-001 à 005, INV-NOT-01 ; les choix métier sont AV-400 à AV-412 et AV-438 à AV-442, défauts paramétrables)
- **Date** : 14/10/2026 (numéro provisoire de la plage 070 à 079 ; révisé le même jour après la revue adverse de la conception)
- **Précise** : [ADR-070](ADR-070-architecture-de-p9-communication-et-analytics.md), [ADR-038](ADR-038-ordre-de-verrouillage-global.md) (rang N10b)
- **Questions liées** : AV-064, AV-065, AV-400 à AV-412, AV-438 à AV-442

## Contexte

D13 §7.1 catalogue trente types d'alerte avec déclencheur, gravité, destinataires et mode de résolution. Le code n'en produit aucun. Les phases précédentes ont préparé le terrain de façon inégale :

| Situation | Types concernés |
|---|---|
| Événement nommé déjà publié, consommateur attendu | `CASH_VARIANCE`, `CASH_SESSION_OPEN_LONG`, `CASH_TRANSFER_NOT_RECEIVED`, `OVERDUE_RECEIVABLE` (`ReceivableOverdue`), `TRANSFER_UNMATCHED`, quotas échus ou à régulariser |
| Événement spécifié au catalogue, non publié (seul l'événement générique `<module>.<aggregate>.<verbe>` du pipeline existe) | `STOCK_LOW`, `STOCK_OUT`, `STOCK_NEGATIVE`, `HIGH_LOSS`, `HIGH_MORTALITY`, `INVENTORY_VARIANCE`, `PRICE_MISMATCH`, `DUPLICATE_SUSPECTED`, `SYNC_ERROR`, `CHECKIN_SUSPICIOUS`… |
| Condition calculable à partir de données présentes, ni événement ni tâche | `DAILY_ENTRY_MISSING`, `APPROVAL_PENDING_LONG` (`escalated_at` jamais écrit), `RECEIPT_INCOMPLETE`, `ATTACHMENT_MISSING`, `INACTIVE_COMMERCIAL`, `CASH_HOLDING_HIGH`, `SYNC_STALE`, `DEVICE_SEQ_GAP`, `CLOCK_SKEW`, `LOT_EXPIRING` (`inventory_stock_lots.expiry_date`, indexée), `STANDARD_COST_MISSING` |
| Tâche existante qui **lève** sur écart (écriture annulée par le point de sauvegarde du `JobRunner`) | `AUDIT_CHAIN_BROKEN` (`audit/chain-verification-job.ts`), `LEDGER_MISMATCH` (`inventory.ledger.reconcile_daily`), `CASH_MISMATCH` (`finance.cash.reconcile_daily`) — promises par INV-STK-01, D09 et AT-047, absentes de D13 |
| Phase non livrée | `KOMMO_SYNC_FAILED` (P10) : au catalogue, règle désactivée |

Faits de la plateforme qui bornent la conception :
- `JobRunner` exécute le gestionnaire d'une tâche dans **une** transaction sous un point de sauvegarde ; si le gestionnaire lève, ses écritures sont annulées et la tâche est rejouée (5 essais).
- `EventConsumerRunner` ouvre **une transaction par événement**, tente 5 fois, puis **saute** l'événement ; `last_error` n'est conservé que jusqu'au prochain événement traité ; la position ne dépasse jamais un trou récent de numérotation (`settledSequenceBound`, 120 s par défaut) : un événement derrière un trou attend jusqu'à 120 s.
- Le worker traite en série : ordonnanceur, un lot par consommateur, puis les tâches dues (`worker.service.ts`).
- Les tâches récurrentes sont déclarées en code (`INTERVAL` ou `DAILY`), pas lues dans `system_settings`.

## Décision

1. **Catalogue déclaratif unique** dans `packages/domain` (`alerts.ts`), exécuté à l'identique par le consommateur, les tests et les seeds. Par type : code, nature (`STATE` ou `EVENT`), module détecteur, gravité par défaut et gravités admises, mode de résolution, type d'objet (`subject_type`) et règle de composition du sujet, écran d'action, rôles destinataires par défaut et destinataire propriétaire, événements qui lèvent, événements qui résolvent, paramètres de seuil (clés `system_settings`), champs de la charge utile **protégés** (valeurs au coût, §11) et indicateur « source disponible ». Les fonctions pures `alertFromEvent` (événement → levée ou résolution) et `renderAlertMessage(payload, droits du lecteur)` sont testées sans entrée-sortie.
2. **Détection par événement, dans le module qui porte la donnée** (ADR-070 §2, §5). Le placement est imposé par le graphe de dépendances :

   | Module détecteur | Types |
   |---|---|
   | `sales` (peut lire `crm`, `fieldwork`, `inventory`, `finance`) | `OVERDUE_RECEIVABLE`, `SALE_UNDELIVERED`, `PRICE_MISMATCH`, `DUPLICATE_SUSPECTED` (encaissement), `INACTIVE_COMMERCIAL` (prise de service par l'API de `fieldwork`, visites par celle de `crm`, ventes), part « % des ventes du jour » de `HIGH_LOSS` |
   | `finance` | `CASH_VARIANCE`, `CASH_SESSION_OPEN_LONG`, `CASH_TRANSFER_NOT_RECEIVED`, `CASH_HOLDING_HIGH`, `CASH_MISMATCH`, justificatif de dépense manquant (`ATTACHMENT_MISSING`) |
   | `inventory` | `STOCK_LOW`, `STOCK_OUT`, `STOCK_NEGATIVE`, `POS_REPLENISH`, `HIGH_LOSS` (seuil absolu), `INVENTORY_VARIANCE`, `TRANSFER_NOT_RECEIVED`, `TRANSFER_UNMATCHED`, `LOT_EXPIRING`, `ALLOCATION_EXPIRED`, `ALLOCATION_REVOCATION_PENDING`, `LEDGER_MISMATCH` |
   | `production` | `HIGH_MORTALITY`, `DAILY_ENTRY_MISSING`, `STANDARD_COST_MISSING` |
   | `procurement` | `RECEIPT_INCOMPLETE`, `DUPLICATE_SUSPECTED` (réception en quarantaine), pièce de réception manquante (`ATTACHMENT_MISSING`) |
   | `approvals` | `APPROVAL_PENDING_LONG` (et écriture de `escalated_at`) |
   | `crm` | `DUPLICATE_SUSPECTED` (compte client) |
   | `fieldwork` | `CHECKIN_SUSPICIOUS` |
   | `sync` (couche transverse) | `SYNC_ERROR`, `SYNC_STALE`, `DEVICE_SEQ_GAP`, `CLOCK_SKEW` |
   | `audit` | `AUDIT_CHAIN_BROKEN` |
   | `communication` | `CONSUMER_FAILED` |

   Trois voies de publication :
   - **sur fait** : le gestionnaire de commande publie un événement nommé dans sa transaction ;
   - **sur transition d'état** : le module publie quand l'état franchit le seuil, dans un sens (`breached: true`) ou dans l'autre (`breached: false`) ;
   - **par passe planifiée** (§3).
3. **Passe planifiée et marqueur.** La tâche d'un détecteur d'état publie **un événement par sujet pour lequel la condition est vraie**, puis, en dernier, un marqueur `AlertDetectionPassCompleted` (`alert_type`, `pass_id`, `business_day`).
   - **Identité de passe.** `pass_id` est un identifiant propre à la passe, reporté dans chaque événement et dans le marqueur ; l'alerte mémorise `last_pass_id`. Au marqueur, le consommateur résout les alertes `AUTO` du type, ouvertes, dont `last_pass_id` diffère du `pass_id` du marqueur. La comparaison se fait par identifiant, jamais par horloge.
   - **Pas de déduplication par jour dans le détecteur.** La clé d'idempotence d'un événement de passe est (`pass_id`, sujet) ; l'unicité de l'alerte ouverte est portée par `open_dedup_key`. Les tâches existantes qui dédoublonnent par jour métier (`sales.receivables.overdue_daily`, `finance.cash_sessions.open_long_check`, `finance.cash_transfers.unreceived_check`, `inventory.allocations.expiry_daily`) sont adaptées sur ce point quand elles passent en détecteur d'état, sans changer leur contrat d'événement.
   - **Passe en plusieurs pages.** Chaque page est une transaction de la tâche ou une tâche de continuation (curseur dans la charge utile) ; le marqueur n'est publié que par la dernière page d'une passe **complète** : une passe interrompue, rejouée ou partielle ne résout rien. Une passe qui n'a pas pu publier tous ses sujets (erreur d'une page) ne publie pas de marqueur.
   - **Tâche qui lève sur écart.** Un détecteur ne lève jamais pour signaler la condition qu'il a mission de publier : `audit.chain.verify_daily`, `inventory.ledger.reconcile_daily` et `finance.cash.reconcile_daily` publient leur événement (`AuditChainBroken`, `LedgerMismatchDetected`, `CashMismatchDetected`) dans leur transaction puis se terminent en `DONE`, avec le signal d'échec dans leur résultat ; autrement le point de sauvegarde du `JobRunner` annulerait l'événement. `audit.chain.verify_daily` reçoit sa récurrence quotidienne dans son module (aujourd'hui aucune).
4. **Événements : données minimales.** Chaque événement de déclenchement porte : l'identifiant du sujet, `site_id` (et `zone_id` quand elle diffère de celle du site), le propriétaire ou le responsable imputé, la gravité calculée quand elle varie, le jour métier, et les valeurs du message **en champs séparés** (les champs protégés, §11, restent distincts). Pas de donnée personnelle inutile. Une version d'événement inconnue est ignorée avec une alerte technique.
5. **Sujet composite.** Un objet sans identifiant propre (solde d'un emplacement pour un produit, lot × jour) reçoit un `subject_id` déterministe : UUID version 5 dérivé du couple (modèle de `platform/sync/code-entity-id.ts`), avec `subject_type` `STOCK_POSITION`, `POS_PRODUCT`, `LOT_DAY`… ; `dedup_key = <type>:<hex du sujet>`. Le lot n'entre pas dans la clé d'un seuil de stock (le seuil est par emplacement × produit) ; le couple lisible (`location_id`, `product_id`) est dans la charge utile pour l'écran d'action. `aggregate_id` de l'événement est cet identifiant.
6. **Déduplication (INV-NOT-01)** : colonne générée `open_dedup_key` = `dedup_key` tant que le statut est `OPEN` ou `ACKNOWLEDGED`, sinon `NULL`, sous index unique (MySQL n'a pas d'index partiel). Une occurrence nouvelle sur une alerte ouverte met à jour `occurrences`, `last_detected_at` et `last_pass_id` ; sur une alerte résolue ou écartée, elle en crée une nouvelle. Le consommateur ne marque (`platform_event_consumer_marks`) que les événements du catalogue des déclencheurs (`alertFromEvent` non nul), en première instruction de sa transaction : la redélivrance ne double pas le compteur. Les marques sont immuables et conservées (`IMMUABLE`, volume négligeable : une ligne par événement de déclenchement).
7. **Gravité** : fixée à la levée (celle de l'événement si le type en admet plusieurs, sinon celle de la règle) ; une occurrence plus grave relève l'alerte ouverte et pose `critical_since` à ce moment, aucune ne l'abaisse (AV-401). Un type dont la gravité dépend de la valeur est un type unique (`CASH_VARIANCE`) ; deux types distincts (`STOCK_LOW`, `STOCK_OUT`) ont chacun leur clé de déduplication.
8. **Seuils : un seul lieu**, `organization.system_settings` (règle 8 ; historisé), lu par le détecteur dans son module. `alert_rules` porte l'activation, la gravité, les rôles destinataires, le mode de résolution, le délai et les rôles d'escalade (AV-400). La cadence d'une tâche est une **constante de code** (`RecurringJobRegistry`) ; un paramètre de cadence n'est un paramètre que s'il est lu par la tâche (une tâche à intervalle court décide, d'après `system_settings`, si son heure est venue) — sinon il n'est pas déclaré paramétrable (AV-411). Une règle désactivée n'empêche pas l'événement d'être publié ; elle empêche l'alerte.
9. **Résolution** :
   - alerte d'état : automatique (événement de résolution ou marqueur de passe) ;
   - alerte d'événement : manuelle (`communication.alert.resolve`, commentaire obligatoire) ;
   - **écarter** (`communication.alert.dismiss`, motif obligatoire) est réservé aux alertes d'événement ; sur une alerte d'état, `acknowledge` fait taire la condition tant qu'elle dure, sans la faire renaître à la passe suivante (AV-404) ;
   - une alerte résolue ou écartée n'est plus modifiée (`IMMUABLE`, ADR-006).
10. **Verrous** : rang **N10b** de l'ADR-038 (ligne d'alerte et lignes de destinataires), pris **avant** les insertions N11 (événements) et la tête d'audit N14. Le consommateur n'écrit que `communication_*` et ses événements ; les commandes `communication.alert.*` verrouillent la ligne de l'alerte (`FOR UPDATE`) puis écrivent ses transitions. Aucune commande d'un autre module ne tient N10b : pas de cycle.
11. **Valeurs au coût (RC-05, BR-ANA-004).** Une valeur protégée (valeur d'une perte, écart d'inventaire en valeur, montants d'achat) n'est jamais stockée dans `message` : elle est un champ distinct de `payload` marqué protégé dans le catalogue ; `renderAlertMessage` la rend seulement au lecteur titulaire de `inventory.valuation.read` sur le site de l'alerte, sinon un gabarit neutre (« Pertes anormales au site X »). Les notifications `IN_APP`, `WEB_PUSH` et le jeu hors ligne `comms` n'embarquent que le texte rendu pour leur destinataire (AV-440).
12. **Consommateur défaillant** : le runner de plateforme enregistre chaque événement sauté dans une table d'ajout seul (`platform_event_consumer_failures` : consommateur, `seq`, `event_id`, erreur, tentatives, horodatage), dans la transaction qui avance la position ; une tâche de `communication` lit cette table par un curseur propre et lève `CONSUMER_FAILED` (ADMIN), un par consommateur et par jour métier ; l'alerte se résout sur le retard de position, pas sur l'effacement de `last_error`. C'est un changement de `platform/` (ajout, signalé au suivi §3) ; en attendant, la tâche lit `last_error` et le retard, sans prétendre ne rien perdre (AV-412).
13. **Types ajoutés** au catalogue de D13 : `ALLOCATION_EXPIRED`, `ALLOCATION_REVOCATION_PENDING` (P5-08), `SALE_UNDELIVERED` (AV-132), `CONSUMER_FAILED` (§12), `LEDGER_MISMATCH`, `CASH_MISMATCH` (§2) ; D13 §7.1 est complété dans le même commit que chaque détecteur (AV-402).
14. **Délai** : un événement derrière un trou de numérotation récent attend jusqu'à 120 s (fenêtre de stabilisation de la plateforme). NFR-15 (p95 ≤ 10 s) tient dans le cas nominal ; la fenêtre est une tolérance documentée, mesurée par le délai `recorded_at` de l'événement → `created_at` de l'alerte, et réglable pour `communication.alerts` si la mesure l'exige (AV-438).

## Alternatives écartées

- **Un événement « condition disparue » par module** : chaque module devrait mémoriser les alertes ouvertes ou lire `communication` ; le marqueur de passe garde la détection sans état.
- **Marqueur fondé sur l'horloge (`last_detected_at < started_at`)** : une passe rejouée ou doublée le même jour résout à tort des alertes encore vraies ; l'identité de passe l'évite.
- **Un seul index unique sur `dedup_key`** : bloquerait la nouvelle alerte d'un objet dont l'ancienne est résolue.
- **Gravité recalculée à chaque occurrence** : une alerte qui descend de `CRITICAL` à `WARNING` sans lecture masque un problème.
- **Seuils dans `alert_rules.thresholds`** : les détecteurs sont dans les modules propriétaires, qui ne peuvent lire `communication`.
- **`INACTIVE_COMMERCIAL` dans `fieldwork`** : il lui faudrait importer `crm` et `sales`, ce que le graphe interdit (et créerait un cycle) ; `sales` importe déjà `crm` et `fieldwork`.

## Conséquences

- Chaque détecteur est un incrément testé : production de l'événement (module propriétaire), consommation, déduplication, résolution, rejeu, passe interrompue.
- Une passe publie autant d'événements que de sujets vrais : bornée par page (ADR-078) ; le coût est du nombre d'alertes ouvertes, pas du nombre d'objets.
- Les alertes locales d'appareil (« stock de votre allocation < 5 ») restent calculées sur l'appareil.
- Les fichiers de `platform/` touchés (table des échecs du runner, isolation des tâches longues, port de stockage) sont des ajouts signalés à la session principale.

## Tests

`alerts.test.ts` (domaine : une ligne de catalogue par type, `alertFromEvent`, messages neutres et valorisés), `communication-alerts.test.ts` (consommateur : levée, déduplication sous redélivrance et en concurrence, relèvement de gravité, résolution par marqueur, par événement, manuelle ; **passe doublée ou interrompue : aucune résolution à tort** ; `dismiss` refusé sur une alerte d'état ; sujet composite), tâches qui ne lèvent plus sur écart, INV-NOT-01 balayé sur toute la base, mutations sur base jetable pour chaque garde.
