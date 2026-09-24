# D15 — Intégration Kommo (KOM)

> Module de code : `integrations` (sous-module `kommo`). Spécification technique : [`../../08-api-events/03-integration-kommo.md`](../../08-api-events/03-integration-kommo.md). Décision : ADR-009.

---

## 1. Objectif

Faire coopérer GIC AGROPELC et Kommo **sans dupliquer** leurs responsabilités (CM §44, §45, §59 ; PM §16).

- **Kommo** : leads digitaux, conversations (WhatsApp), pipeline relationnel, relances, automatisations.
- **GIC** : clients opérationnels, produits, commandes, ventes, prix, stock, production, paiements, performance.

Le parcours digital (CM §46) doit être continu : publicité → WhatsApp → Kommo → lead → qualification → attribution → **conversion en client GIC → commande GIC → vente → paiement → historique client**, et l'historique commercial enrichit le profil Kommo.

## 2. Acteurs

Kommo (système externe), `COMMERCIAL_SEDENTAIRE` (utilisateur principal des deux outils), `RESP_COMMERCIAL`, `ADMIN` (configuration, supervision), `system`.

## 3. Principales entités

| Entité | Table | Rôle |
|---|---|---|
| Lien externe | `integrations.external_links` | Correspondance entité GIC ↔ identifiant Kommo (contact, lead, utilisateur) |
| Boîte d'entrée d'intégration | `integrations.inbox_messages` | Webhooks Kommo reçus, dédupliqués |
| Boîte de sortie d'intégration | `integrations.outbox_messages` | Appels vers Kommo, avec reprise |
| Paramètres d'intégration | `integrations.integration_settings` | Pipeline et statuts déclencheurs, champs personnalisés, correspondance utilisateurs |

## 4. Cas d'usage

| ID | Cas d'usage | Sens | Déclencheur | Hors ligne |
|---|---|---|---|---|
| UC-KOM-01 | Lead qualifié dans Kommo → création ou rapprochement du compte client GIC | Kommo → GIC | Webhook de changement de statut du lead vers le statut configuré (AV-069) | n/a (serveur) |
| UC-KOM-02 | Mise à jour d'un contact Kommo → proposition de mise à jour du compte GIC | Kommo → GIC | Webhook de modification de contact | n/a |
| UC-KOM-03 | Compte client GIC créé ou modifié (champs partagés) → contact Kommo | GIC → Kommo | `ProspectCreated`, `CustomerUpdated` pour un compte lié | n/a |
| UC-KOM-04 | Commande et vente GIC → mise à jour du lead et du contact Kommo (statut, montants, CA cumulé, nombre de commandes) | GIC → Kommo | `OrderConfirmed`, `OrderFulfilled`, `SaleConfirmed`, `SaleCancelled`, `PaymentReceived` | n/a |
| UC-KOM-05 | Réaffectation du titulaire → responsable Kommo | GIC → Kommo | `CustomerReassigned` | n/a |
| UC-KOM-06 | Superviser, rejouer ou abandonner un message en échec | — | ECR-KOM-01 | Non |
| UC-KOM-07 | Configurer pipeline, statuts, champs et correspondance des utilisateurs | — | ECR-KOM-01 | Non |

## 5. Entrées

Webhooks Kommo (lead, contact) ; événements métier GIC.

## 6. Sorties

Comptes clients GIC créés ou rapprochés, liens externes, contacts et leads Kommo enrichis, alertes `KOMMO_SYNC_FAILED`.

## 7. Règles métier

| ID | Règle | Statut |
|---|---|---|
| BR-KOM-001 | GIC ne crée, ne modifie ni ne supprime **jamais** un lead Kommo, sauf pour les champs d'enrichissement déclarés (statut de commande, montants). Il ne lit ni ne stocke les conversations. | C (CM §44) / AV-019 |
| BR-KOM-002 | À la réception d'un lead qualifié : recherche d'un compte GIC par lien externe, puis par téléphone normalisé. S'il existe, on crée le lien ; sinon on crée le compte au stade `PROSPECT`, avec la source `KOMMO`, l'identifiant du lead et du contact en liens externes, et le titulaire issu de la correspondance des utilisateurs (BR-CRM-023). | C (CM §46) / AV-069, AV-071 |
| BR-KOM-003 | Champs partagés : nom, téléphone, e-mail, adresse. **GIC est la source de vérité**. Une modification Kommo n'est appliquée à GIC que si le champ n'a pas été modifié dans GIC depuis la dernière synchronisation ; sinon, le conflit `KOMMO_FIELD_CONFLICT` est ouvert et la valeur GIC est renvoyée à Kommo. | C (CM §59) / D |
| BR-KOM-004 | Données GIC → Kommo : stade (prospect, client, perdu), titulaire, nombre de commandes, CA cumulé, date de la dernière vente, statut de la dernière commande. | C (CM §46) / AV-070 |
| BR-KOM-005 | **Anti-boucle** : un changement appliqué depuis Kommo n'est pas renvoyé vers Kommo. On compare l'empreinte des champs partagés avec la dernière empreinte échangée, et on marque l'origine de la modification. | C (PM §16) |
| BR-KOM-006 | **Idempotence entrante** : un webhook est identifié par une clé de déduplication (identifiant d'entité Kommo + type + horodatage de modification Kommo). Un doublon est ignoré. | C (PM §16) |
| BR-KOM-007 | **Idempotence sortante** : chaque message sortant a une clé ; les mises à jour sont des remplacements de valeurs absolues (pas d'incréments), donc rejouables sans effet de bord. | C (PM §16) |
| BR-KOM-008 | Reprise : jusqu'à 10 tentatives avec attente progressive (30 s × 2^n, plafond 1 h). Ensuite, le message passe `DEAD`, l'alerte `KOMMO_SYNC_FAILED` est levée et un rejeu manuel est possible. | C (PM §16) / D |
| BR-KOM-009 | Une indisponibilité de Kommo n'empêche **aucune** opération GIC : l'intégration est asynchrone. | D (CM §45) |
| BR-KOM-010 | Les webhooks entrants sont authentifiés (secret partagé ou signature selon les capacités Kommo) et journalisés bruts avant tout traitement. | D (PM §37) / AV-068 |

## 8. Validations

Webhook : authentification, schéma attendu, entité connue ou créable. Message sortant : lien externe existant, champs mappés configurés.

## 9. Dépendances

CRM (comptes clients), VEN (commandes, ventes), FIN (paiements), ADM (utilisateurs), NOT (alertes).

## 10. Événements produits

`KommoLeadQualifiedReceived`, `KommoContactUpdateReceived`, `KommoFieldConflictDetected`, `KommoSyncFailed`.

## 11. Événements consommés

`ProspectCreated`, `CustomerUpdated`, `CustomerConverted`, `CustomerReassigned`, `CustomerMerged`, `ProspectLost`, `OrderConfirmed`, `OrderFulfilled`, `OrderCancelled`, `SaleConfirmed`, `SaleCancelled`, `PaymentReceived`.

## 12. Fonctionnement hors ligne

Sans objet sur les appareils : l'intégration est exécutée par le worker serveur. Une opération GIC saisie hors ligne est propagée à Kommo après sa synchronisation.

## 13. Permissions

`integrations.kommo.manage`, `integrations.kommo.monitor`.

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Lead Kommo sans téléphone | Création du compte si la configuration l'autorise, sinon message `NEEDS_REVIEW` pour le commercial sédentaire. |
| Utilisateur Kommo sans correspondance GIC | Compte créé sans titulaire ; alerte au Resp. commercial. |
| Fusion de comptes GIC liés à deux contacts Kommo | Les deux liens sont conservés sur le compte fusionné ; aucune fusion n'est faite côté Kommo (hors responsabilité GIC). |
| API Kommo en limitation de débit | Réessai après le délai indiqué par Kommo ; lissage de la boîte de sortie. |
