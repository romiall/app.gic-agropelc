# D12 — Audit (AUD)

> Module de code : `audit`. Spécification technique : [`../../07-security-rbac/03-audit.md`](../../07-security-rbac/03-audit.md).
> Le journal d'audit est distinct des **événements métier** (faits publiés entre modules), du **journal des commandes de synchronisation** (`sync.command_inbox`) et des **logs techniques**. Voir la comparaison dans le catalogue d'événements.

---

## 1. Objectif

Permettre à la direction de comprendre, pour toute opération sensible, **ce qui s'est passé, qui l'a fait, quand, où, avec quel appareil, l'ancienne et la nouvelle information, si c'était hors connexion et qui a validé**. Aucune opération importante ne doit disparaître silencieusement (CM §40 ; PM §18).

## 2. Acteurs

Producteurs : tous les modules et le système. Lecteurs : `DIRECTION`, `ADMIN`, `FINANCE` (entités financières), responsables (entités de leur périmètre, par le biais de l'historique d'un document).

## 3. Principales entités

| Entité | Table | Rôle |
|---|---|---|
| Entrée d'audit | `audit.audit_log` | Journal en ajout seul, chaîné par hachage |

## 4. Cas d'usage

| ID | Cas d'usage | Mécanisme | Acteur |
|---|---|---|---|
| UC-AUD-01 | Journaliser une action sensible | API interne `audit.record(...)` appelée dans la transaction métier | Tous les modules |
| UC-AUD-02 | Journaliser une tentative refusée (droit, validation, authentification) | `audit.record(..., result = DENIED/FAILED)` dans une transaction séparée | Tous les modules |
| UC-AUD-03 | Consulter l'historique d'un document | requête filtrée par entité | Responsables |
| UC-AUD-04 | Rechercher dans le journal (utilisateur, appareil, action, période, site) | ECR-AUD-01 | DIRECTION, ADMIN, FINANCE |
| UC-AUD-05 | Vérifier l'intégrité du chaînage | tâche planifiée quotidienne | `system` |

## 5. Entrées

Contexte de la commande (auteur, rôles, appareil, IP, heure métier, capture hors ligne, identifiant de commande), valeurs avant et après, motif, référence de validation.

## 6. Sorties

Historique consultable et exportable (audité), preuve d'intégrité, alertes `AUDIT_CHAIN_BROKEN`.

## 7. Règles métier

| ID | Règle | Statut |
|---|---|---|
| BR-AUD-001 | Le journal d'audit est en **ajout seul** : aucune modification ni suppression, garanti par les droits de la base (aucun `UPDATE` ni `DELETE` accordé) et par un déclencheur de refus. | C (CM §40 ; PM §18) |
| BR-AUD-002 | Une entrée d'audit contient au minimum : utilisateur, rôles actifs (instantané), action, type et identifiant d'entité, valeurs avant et après (champs modifiés seulement), `occurred_at` (date réelle), `recorded_at` (date serveur), appareil, capture hors ligne ou non, adresse IP, identifiant de commande de synchronisation, délai de synchronisation, référence de validation, motif, résultat. | C (PM §18) |
| BR-AUD-003 | Sont **toujours** audités : toute commande sur une vente, commande client, encaissement, paiement, réception, transfert, perte, consommation, inventaire, allocation, session de caisse, remise de fonds, dépense, facture et paiement fournisseur, écriture de coût, règle tarifaire, politique de contrôle, paramètre, utilisateur, rôle, affectation de rôle, appareil, compte client (coordonnées, réaffectation, fusion, crédit), toute décision de validation, tout export, toute lecture du journal d'audit, tout événement d'authentification (succès, échec, verrouillage PIN, révocation). | C (CM §40) / D (liste) |
| BR-AUD-004 | Les refus d'autorisation et les tentatives invalides sont audités (`DENIED`, `FAILED`), pour détecter les tentatives d'accès non autorisé (IDOR, élévation de droits). | D (PM §37) |
| BR-AUD-005 | L'entrée d'audit d'une action réussie est écrite **dans la même transaction** que l'effet métier : pas d'effet sans audit, pas d'audit sans effet. | D |
| BR-AUD-006 | Chaque entrée contient le hachage de l'entrée précédente et son propre hachage (SHA-256 d'une sérialisation canonique). La vérification quotidienne lève `AUDIT_CHAIN_BROKEN` en cas de rupture. | D (fraude interne, PM §37) |
| BR-AUD-007 | Aucune donnée secrète n'est journalisée : mots de passe, PIN, jetons, clés. | D |
| BR-AUD-008 | Conservation de 10 ans. Partitionnement mensuel ; archivage froid au-delà de 24 mois, restaurable. | AV-074 |
| BR-AUD-009 | Accès au journal : `audit.log.read` ; toute consultation est elle-même auditée. | D |
| BR-AUD-010 | Les actions du système (tâches planifiées, réactions à des événements) sont auditées sous l'acteur technique `system`, avec la cause (identifiant d'événement ou de tâche). | D |

## 8. Validations

Une entrée d'audit incomplète (sans action, entité ou acteur) fait échouer la transaction métier : c'est une erreur de programmation, détectée par les tests.

## 9. Dépendances

Aucune dépendance métier ; appelé par tous les modules.

## 10. Événements produits

`AuditChainBroken` (alerte).

## 11. Événements consommés

Aucun : l'audit est écrit de manière synchrone, pas par réaction à des événements.

## 12. Fonctionnement hors ligne

Les entrées d'audit sont produites **par le serveur** à l'application des commandes. Le contexte hors ligne (heure réelle, appareil, capture hors ligne, écart d'horloge, délai de synchronisation) vient de l'enveloppe de la commande. L'appareil ne produit pas d'audit de confiance : son journal local sert seulement au diagnostic.

## 13. Permissions

`audit.log.read`.

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Volume du journal | Partitionnement et archivage (BR-AUD-008) ; index par entité, par acteur et par date. |
| Rupture du chaînage détectée | Alerte critique à la Direction et à l'Admin ; enquête ; les partitions antérieures restent vérifiables indépendamment. |
| Demande d'effacement de données personnelles | Pseudonymisation des champs personnels dans les valeurs avant et après, par une procédure spéciale, auditée et approuvée par la Direction. Le chaînage porte sur une empreinte, préservée par la pseudonymisation (voir la spécification technique). |
