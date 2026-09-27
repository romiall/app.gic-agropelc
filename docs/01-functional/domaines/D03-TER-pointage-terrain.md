# D03 — Pointage terrain (TER)

> Couvre : prise et fin de service géolocalisées, tentatives, sessions de travail, dérogations, signaux anti-fraude.
> Module de code : `fieldwork`.

---

## 1. Objectif

Attester la présence des commerciaux terrain dans leur zone de travail pour **réduire les déclarations manifestement frauduleuses**, sans surveillance permanente ni précision « militaire » (CM §10).

Sources : CM §10, §50, §54, §56 ; PM §13.

## 2. Acteurs

`COMMERCIAL_TERRAIN` (et tout utilisateur à qui la permission `fieldwork.checkin.perform` est accordée), `RESP_COMMERCIAL` (suivi et dérogations), `DIRECTION` (lecture), `system` (clôture automatique, détection d'anomalies).

## 3. Principales entités

| Entité | Table | Rôle |
|---|---|---|
| Tentative de pointage | `fieldwork.geo_checkins` | Chaque essai de prise ou fin de service, avec son résultat |
| Session de travail | `fieldwork.work_sessions` | Période d'activité terrain |
| Zone et géorepère | `organization.zones` | Référence géographique (D01) |
| Demande de dérogation | `approvals.approval_requests` (type `CHECKIN_OVERRIDE`) | Validation d'une prise de service refusée |

## 4. Cas d'usage

| ID | Cas d'usage | Commande technique | Acteur | Hors ligne |
|---|---|---|---|---|
| UC-TER-01 | PRENDRE SERVICE | `fieldwork.checkin.record` (type `START_SERVICE`) | COMMERCIAL_TERRAIN | **Oui** |
| UC-TER-02 | Demander une dérogation après refus | `fieldwork.checkin.request_override` | COMMERCIAL_TERRAIN | **Oui** |
| UC-TER-03 | FIN DE SERVICE | `fieldwork.checkin.record` (type `END_SERVICE`) | COMMERCIAL_TERRAIN | **Oui** |
| UC-TER-04 | Clôturer automatiquement les sessions ouvertes | interne planifié + local | `system` | Oui (local) |
| UC-TER-05 | Approuver ou rejeter une dérogation | `approvals.request.approve` / `reject` | RESP_COMMERCIAL | Non |
| UC-TER-06 | Suivre les présences et l'activité de l'équipe | requête | RESP_COMMERCIAL, DIRECTION | Non |

## 5. Entrées

Position (latitude, longitude), précision annoncée par l'appareil, heure, zone déclarée, identifiant d'appareil, motif de dérogation.

## 6. Sorties

Sessions de travail (base de rattachement des visites et ventes terrain), tentatives refusées (audit), indicateurs de présence, alertes « commercial sans activité » et « pointage suspect ».

## 7. Règles métier

| ID | Règle | Statut |
|---|---|---|
| BR-TER-001 | **Toute** tentative de prise ou fin de service est enregistrée, acceptée ou refusée, avec : utilisateur, appareil, `occurred_at`, zone déclarée, latitude, longitude, précision, géorepère utilisé (figé), distance calculée, résultat. | C (CM §10 ; PM §13) |
| BR-TER-002 | Résultat d'une prise de service. `ACCEPTED` si distance ≤ rayon du géorepère **et** précision ≤ précision maximale. `REJECTED_LOW_ACCURACY` si la précision dépasse le maximum. `REJECTED_OUT_OF_ZONE` si la précision est acceptable mais la distance supérieure au rayon. `NO_POSITION` si aucune position n'a pu être obtenue. Rayon par défaut 500 m, précision maximale 150 m. | C (CM §10, 500 m) / AV-022 |
| BR-TER-003 | La distance est la distance orthodromique (haversine) entre la position et le point de référence du géorepère. Elle est calculée sur l'appareil pour le retour immédiat, **puis recalculée par le serveur** avec le géorepère en vigueur à `occurred_at`. En cas de divergence, le résultat serveur fait foi et la divergence est signalée. | D (PM §37) |
| BR-TER-004 | Une prise de service `ACCEPTED` ouvre une session de travail `OPEN`. Un utilisateur a au plus une session non clôturée à la fois. | D |
| BR-TER-005 | Après un refus, l'utilisateur peut réessayer. Après 3 refus sur au moins 2 minutes, il peut demander une dérogation avec un motif obligatoire. La session s'ouvre alors (`status = OPEN`) avec `override_status = PENDING` ; l'activité est autorisée mais signalée. Approbation → `override_status = APPROVED`. Rejet → `override_status = REJECTED` : les activités rattachées restent enregistrées et portent l'indicateur `session_rejected` (SM-WORK-SESSION). | AV-021 |
| BR-TER-006 | La zone déclarée est choisie parmi les zones affectées à l'utilisateur (affectations de rôle de portée `ZONE`). Un utilisateur sans affectation de zone peut déclarer toute zone active dotée d'un géorepère. | D (CM §10) |
| BR-TER-007 | La fin de service est optionnelle. Elle enregistre une position ; un résultat hors zone est simplement signalé, jamais bloquant. | C (CM §10 « éventuellement ») / D |
| BR-TER-008 | Toute session non clôturée l'est automatiquement à 23:59 (heure de Douala), statut `AUTO_CLOSED` : sur l'appareil s'il est hors ligne, sinon par le serveur. | AV-023 |
| BR-TER-009 | Une nouvelle prise de service acceptée alors qu'une session est ouverte clôt la précédente à l'heure de la nouvelle, avec l'indicateur `superseded`. | D |
| BR-TER-010 | Le serveur lève le signal `CHECKIN_SUSPICIOUS` sur les motifs suivants : vitesse implicite > 150 km/h entre deux positions consécutives de l'utilisateur (pointages, visites, ventes terrain) ; précision égale à 0 ; coordonnées identiques au mètre près sur des jours différents ; précision identique répétée sur plus de 5 pointages. | D (limite L-02) |
| BR-TER-011 | Aucun suivi GPS continu. Une position n'est captée que lors d'une prise ou fin de service, d'une visite, d'une vente terrain, d'une opération terrain géolocalisée. | C (CM §10, §56) |
| BR-TER-012 | Les coordonnées et la précision sont conservées **brutes**, sans arrondi. | D (audit) |
| BR-TER-013 | Un commercial terrain sans prise de service un jour ouvré (lundi à samedi par défaut), ni visite, ni vente, déclenche l'alerte `INACTIVE_COMMERCIAL` le lendemain à 08:00. | C (CM §54) / AV-065 |

## 8. Validations

| Contrôle | Erreur |
|---|---|
| Zone déclarée active, avec géorepère, et autorisée (BR-TER-006) | `ZONE_NOT_ALLOWED` |
| `occurred_at` ≤ heure de réception + 5 min, et pas plus ancien que la fenêtre de saisie rétroactive (AV-078) | `OCCURRED_AT_INVALID` |
| Latitude ∈ [−90, 90], longitude ∈ [−180, 180], précision ≥ 0 | `GEO_INVALID` |
| Demande de dérogation : au moins 3 tentatives refusées sur au moins 2 minutes | `OVERRIDE_NOT_ALLOWED_YET` |

## 9. Dépendances

- **Dépend de** : ADM (zones, géorepères, utilisateurs, validations).
- **Utilisé par** : CRM (rattachement des visites), VEN (rattachement des ventes terrain), ANA (présence), NOT (alertes).

## 10. Événements produits

`CheckInAccepted`, `CheckInRejected`, `CheckInOverrideRequested`, `WorkSessionStarted`, `WorkSessionEnded`, `WorkSessionAutoClosed`, `CheckInSuspicious`.

## 11. Événements consommés

`ApprovalGranted` / `ApprovalRejected` (type `CHECKIN_OVERRIDE`) → transition de la session. `ZoneUpdated` → nouvelle version de géorepère pour les pointages futurs.

## 12. Fonctionnement hors ligne

- Les géorepères des zones de l'utilisateur sont téléchargés. Le calcul local donne un résultat immédiat.
- La tentative (acceptée ou refusée) est placée en outbox. Rien n'est perdu, conformément à l'exigence d'audit du CM §10.
- La session est ouverte localement ; visites et ventes s'y rattachent localement.
- À la synchronisation, le serveur recalcule (BR-TER-003). Si le serveur refuse une prise acceptée localement (géorepère modifié entre-temps), la session garde `status = OPEN` et passe à `override_status = PENDING`, avec une dérogation automatiquement demandée ; le commercial est notifié.

## 13. Permissions

`fieldwork.checkin.perform` (OWN), `fieldwork.session.read` (TEAM / ALL), `fieldwork.checkin_override.approve` (TEAM).

## 14. Exceptions

| Cas | Traitement |
|---|---|
| GPS désactivé ou permission refusée | Résultat `NO_POSITION` enregistré ; message d'aide pour activer la localisation ; possibilité de dérogation selon BR-TER-005. |
| Horloge de l'appareil faussée | Le serveur compare l'écart d'horloge du lot (D14) ; au-delà du seuil, la tentative porte l'indicateur `clock_suspect`. |
| Zone supprimée ou désactivée pendant une période hors ligne | Tentative conservée ; résultat serveur `ZONE_INACTIVE`, qui nécessite une dérogation. |
| Commercial affecté à plusieurs zones éloignées dans la même journée | Une nouvelle prise de service dans la seconde zone clôt la première (BR-TER-009). |

## 15. Choix d'implémentation (P3-03)

Précisions retenues par le module `fieldwork` là où les règles ci-dessus laissent un choix ; toutes **DÉDUITES**, sans effet sur les règles confirmées.

| Point | Choix | Justification |
|---|---|---|
| Identifiant de session (§12) | L'appareil qui obtient un résultat local `ACCEPTED` ouvre la session et la transmet (`sessionId`) ; le serveur la crée sous le **même identifiant**. | Les visites et ventes hors ligne s'y rattachent avant la synchronisation. |
| Zone déclarée (BR-TER-006) | Une **sous-zone** d'une zone affectée est admise (ancêtres de `organization.zone_ancestors`). | Les géorepères portent souvent sur des secteurs, sous-zones de la zone d'affectation (AV-003). |
| Zone sans géorepère (§14) | Une zone privée de son géorepère pendant la période hors ligne est traitée comme une zone désactivée : tentative conservée, résultat `ZONE_INACTIVE` (session seulement par dérogation) ; une zone inconnue reste refusée (`ZONE_NOT_ALLOWED`). | INV-TER-02 : aucune tentative n'est perdue. |
| Précision absente | Résultat `REJECTED_LOW_ACCURACY` (`evaluateCheckin`). | Une précision inconnue ne peut pas être vérifiée (BR-TER-002). |
| Prise tardive (INV-TER-01) | Une prise de service acceptée, antérieure à la session ouverte et synchronisée après elle, est enregistrée **déjà close** à l'heure d'ouverture de celle-ci (`SUPERSEDED`). | Au plus une session non close ; l'ordre réel des prises est respecté. |
| Clôture de 23:59 (BR-TER-008) | Instant : 23:59:00 heure de Douala du jour métier de début (`sessionAutoCloseAt`). Une session dont ce moment est passé quand le serveur applique la commande est enregistrée `AUTO_CLOSED`, comme l'appareil hors ligne l'a fait ; entre la clôture de 23:59 et un remplacement, l'heure la plus ancienne l'emporte (`resolveSessionEnd`, `packages/domain`). La tâche `fieldwork.session.auto_close` clôt les sessions restées ouvertes. | SM-WORK-SESSION : « l'heure réelle la plus ancienne l'emporte ». |
| Fin de service tardive | Une fin de service antérieure à une clôture déjà enregistrée (23:59 ou remplacement) la remplace (`CLOSED`, `END_SERVICE`) ; postérieure, elle est rattachée à la session sans la modifier. | Même principe. |
| Dérogation (BR-TER-005) | Les refus comptés sont ceux du jour métier postérieurs à la dernière prise acceptée ; la session de dérogation pointe la dernière tentative refusée (`start_checkin_id`). Sans politique `CHECKIN_OVERRIDE` active : `CONTROL_POLICY_MISSING`. | La dérogation suit une série de refus ; la politique porte l'approbateur (AV-021). |
| Rejet d'une dérogation | Les modules propriétaires des activités rattachées s'enregistrent auprès de `fieldwork` (registre `SESSION_REJECTED_LISTENERS`) pour poser l'indicateur `session_rejected`. | `fieldwork` ne peut pas écrire les tables de `crm` ni de `sales` (graphe des dépendances). |
| Signaux de suspicion (BR-TER-010) | Calculés sur les **pointages** de l'utilisateur ; les positions des visites et ventes terrain (tables de `crm` et `sales`) ne sont pas lues ; positions d'autres jours bornées aux 90 derniers jours. | Frontières de modules ; limite à lever par écoute d'événements si le besoin se confirme. |
| Pointage sans appareil identifié | Refusé (`DEVICE_REQUIRED`). | Une session exige son appareil (dictionnaire). |
| Synchronisation (P3-07) | Jeu `fieldwork` (`USER` : l'agent) : chaque session créée ou modifiée par le serveur (recalcul défavorable, remplacement, fin de service, clôture de 23:59, décision de dérogation) est renvoyée à l'appareil de l'agent. | §12 : l'appareil a ouvert la session localement et doit connaître la décision du serveur. |
| Consultation (P3-06) | `GET /work-sessions` : sessions commencées dans le jour métier demandé et **toutes** les tentatives, refusées comprises ; ancrage par agent (défaut : soi) ou par équipe ; portée `fieldwork.session.read` évaluée par agent et zone déclarée, ses propres sessions lisibles avec la seule permission. | INV-TER-02 ; supervision des présences (ECR-TER-01/02). |
