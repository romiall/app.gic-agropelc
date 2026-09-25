# D02 — Commercial / CRM opérationnel (CRM)

> Couvre : comptes clients (prospects et clients), acquisition, portefeuille et réaffectations, pipeline prospect, visites, interactions hors Kommo, objectifs, performance commerciale.
> Module de code : `crm`. Le pointage est traité dans [D03-TER](D03-TER-pointage-terrain.md), les commandes et ventes dans [D04-VEN](D04-VEN-commandes-ventes.md).

---

## 1. Objectif

Permettre à chaque commercial de développer et suivre **son** portefeuille. Mesurer l'**effort** commercial (prospects, visites, contacts) autant que le **résultat** (conversions, commandes, CA), sur n'importe quelle période. Répondre à « qui gère ce client, qui l'a acquis, que rapporte ce portefeuille ».

Sources : CM §6–§9, §11, §34.2, §34.3, §50 ; PM §12.

## 2. Acteurs

`COMMERCIAL_TERRAIN`, `COMMERCIAL_SEDENTAIRE`, `VENDEUR_PDV` (création de clients au PDV), `RESP_COMMERCIAL`, `DIRECTION`, `FINANCE` (conditions de crédit, lecture), acteur externe Kommo (création de comptes depuis un lead, voir D15), `system` (conversion automatique).

## 3. Principales entités

| Entité | Table | Rôle |
|---|---|---|
| Compte client | `crm.customers` | Prospect ou client, stade, étape, coordonnées, localisation, acquéreur, titulaire courant, conditions de crédit |
| Historique de stade et d'étape | `crm.customer_stage_history` | Évolution du prospect (CM §7) |
| Affectation de titulaire | `crm.customer_assignments` | Portefeuille historisé (CM §8) |
| Étape de pipeline | `crm.pipeline_steps` | Référentiel configurable (AV-011) |
| Visite | `crm.visits` | Rencontre physique géolocalisée |
| Interaction | `crm.interactions` | Contact non physique hors Kommo |
| Objectif commercial | `crm.sales_targets` | Cible × métrique × période |
| Catégorie de client, source, canal | `catalog.customer_categories`, `crm.lead_sources`, `catalog.sales_channels` | Référentiels (AV-017, AV-018) |

## 4. Cas d'usage

| ID | Cas d'usage | Commande technique | Acteur | Hors ligne |
|---|---|---|---|---|
| UC-CRM-01 | + PROSPECT : créer un compte client | `crm.customer.create` | Commerciaux, VENDEUR_PDV | **Oui** |
| UC-CRM-02 | Modifier les coordonnées ou la localisation d'un compte | `crm.customer.update` | Titulaire, RESP_COMMERCIAL | **Oui** |
| UC-CRM-03 | + VISITE | `crm.visit.record` | COMMERCIAL_TERRAIN, RESP_COMMERCIAL | **Oui** |
| UC-CRM-04 | Enregistrer une interaction (appel, SMS…) | `crm.interaction.record` | Commerciaux | **Oui** |
| UC-CRM-05 | Faire avancer un prospect dans le pipeline | `crm.customer.set_pipeline_step` | Titulaire | **Oui** |
| UC-CRM-06 | Marquer un prospect perdu ; le rouvrir | `crm.customer.mark_lost`, `crm.customer.reopen` | Titulaire, RESP_COMMERCIAL | **Oui** |
| UC-CRM-07 | Conversion automatique en client à la première vente | interne (réaction à `SaleConfirmed`) | `system` | n/a (serveur) |
| UC-CRM-08 | Réaffecter un compte à un autre commercial | `crm.customer.reassign` | RESP_COMMERCIAL, DIRECTION | Non |
| UC-CRM-09 | Fusionner deux comptes en doublon | `crm.customer.merge` | RESP_COMMERCIAL, ADMIN | Non |
| UC-CRM-10 | Définir des objectifs | `crm.target.set`, `crm.target.cancel` | RESP_COMMERCIAL, DIRECTION | Non |
| UC-CRM-11 | Consulter son portefeuille et une fiche client | requête | Commerciaux | **Oui** (périmètre) |
| UC-CRM-12 | Consulter ses objectifs et performances | requête | Commerciaux | Partiel (instantané + données locales) |
| UC-CRM-13 | Définir les conditions de crédit d'un client | `crm.customer.set_credit_terms` | FINANCE, DIRECTION | Non |
| UC-CRM-14 | Configurer les étapes du pipeline | `crm.pipeline.configure` | ADMIN, DIRECTION | Non |

## 5. Entrées

- Saisies terrain : identité, téléphone, activité, type, catégorie, localisation GPS, photo de façade optionnelle, source.
- Résultats de visite et prochaines actions.
- Décisions de réaffectation et objectifs.
- Leads qualifiés venant de Kommo (D15).
- Ventes confirmées (D04), pour la conversion et les indicateurs.

## 6. Sorties

- Portefeuilles par commercial (courant et historique).
- Attribution d'acquisition et de titulaire, lue par les ventes pour figer l'attribution.
- Indicateurs d'effort : prospects créés, visités, contacts, conversions.
- Actions à réaliser : prochaines actions échues, clients inactifs.
- Profil client enrichi vers Kommo (D15).

## 7. Règles métier

| ID | Règle | Statut |
|---|---|---|
| BR-CRM-001 | Un compte client a un **stade système** parmi `PROSPECT`, `CUSTOMER`, `LOST`, `MERGED`. Les étapes de pipeline (configurables) ne s'appliquent qu'au stade `PROSPECT`. | C (CM §7) / D (stades) / AV-011 |
| BR-CRM-002 | Champs obligatoires à la création : nom affiché, zone, source, **et** au moins un moyen de retrouver le compte (téléphone ou position GPS). Tous les autres champs sont optionnels. | D (CM §7, UX CM §49) |
| BR-CRM-003 | À la création : l'**acquéreur** est le créateur (ou le commercial désigné par un responsable) ; le **titulaire** initial est l'acquéreur s'il a un rôle commercial. Un compte créé par un vendeur de PDV sans rôle commercial n'a pas de titulaire et est rattaché à son site (`home_site_id`). | C (CM §7, §8) / D |
| BR-CRM-004 | L'acquéreur (`acquired_by_user_id`) et la date d'acquisition sont **immuables**. | C (CM §7) |
| BR-CRM-005 | Un compte a **au plus un titulaire actif** à tout instant. Les affectations sont historisées dans `crm.customer_assignments`, par périodes contiguës et sans chevauchement (INV-CRM-02). | C (CM §8) |
| BR-CRM-006 | Le téléphone principal normalisé est unique parmi les comptes non `MERGED`. En ligne, une création en doublon est refusée et le serveur répond « compte existant, suivi par un autre commercial », sans divulguer de données hors périmètre. Hors ligne, le doublon est détecté à la synchronisation et produit le conflit `DUPLICATE_CUSTOMER`, résolu par fusion. | AV-014 |
| BR-CRM-007 | La fusion rattache le compte absorbé au compte conservé (`merged_into_id`, stade `MERGED`). Les visites, commandes et ventes gardent leur identifiant d'origine ; les lectures agrégées suivent la chaîne de fusion. L'acquéreur retenu est celui du compte le plus anciennement acquis. | D |
| BR-CRM-008 | Tout changement de stade ou d'étape est historisé (`from`, `to`, `occurred_at`, auteur, motif). | C (CM §7 « évolution du prospect ») |
| BR-CRM-009 | Passer au stade `LOST` exige un code motif (catégorie `PROSPECT_LOST`). Un compte `LOST` peut être rouvert en `PROSPECT`, ce qui est historisé. | D (PM §24) |
| BR-CRM-010 | Un `PROSPECT` devient automatiquement `CUSTOMER` à sa **première vente confirmée**. `converted_at` = `occurred_at` de cette vente ; `first_sale_id` est renseigné ; la conversion est attribuée au titulaire à cette date. | AV-012 |
| BR-CRM-011 | Un `CUSTOMER` ne redevient jamais `PROSPECT`. Le qualificatif actif / inactif est **calculé** (aucune vente confirmée depuis N jours, N = 30 par défaut) et jamais stocké comme stade. | C (CM §9) / AV-013 |
| BR-CRM-012 | Une visite porte : compte, utilisateur, `occurred_at`, position GPS et précision si disponibles, distance au compte si le compte est géolocalisé, résultat obligatoire (code motif `VISIT_OUTCOME`), note et prochaine action optionnelles. | C (CM §7, §10) / D |
| BR-CRM-013 | Une visite est rattachée automatiquement à la session de travail ouverte de l'utilisateur à `occurred_at`. Sans session, elle porte l'indicateur `out_of_session`. | AV-023 |
| BR-CRM-014 | Si un compte n'a pas de position, la position de sa première visite (précision ≤ 50 m) est proposée comme position du compte ; l'utilisateur confirme. | D (UX) |
| BR-CRM-015 | Une visite enregistrée à plus de 500 m (paramètre `crm.visit.max_distance_m`) de la position connue du compte porte l'indicateur `far_from_customer`, visible des responsables. | D (anti-fraude, CM §5.3) |
| BR-CRM-016 | Une visite ou une interaction synchronisée n'est plus modifiable. Pour corriger, on l'annule (`status = CANCELLED`, motif) et on en saisit une nouvelle. | C (CM §41) / D |
| BR-CRM-017 | Une interaction a un canal parmi `APPEL`, `SMS`, `EMAIL`, `AUTRE`. Les conversations WhatsApp et Kommo ne sont pas saisies dans GIC. | C (CM §44) / AV-019 |
| BR-CRM-018 | Un objectif est défini par une cible (`USER`, `TEAM`, `SITE`), une métrique, un produit optionnel, une période et une valeur. Deux objectifs actifs ne peuvent pas avoir la même cible, métrique et produit sur des périodes qui se chevauchent. | AV-016 |
| BR-CRM-019 | Les indicateurs de performance se calculent sur `occurred_at` des opérations et sur l'attribution **figée** sur chaque vente (`commercial_user_id`), jamais sur le titulaire courant. | C (CM §8, §9) |
| BR-CRM-020 | Une réaffectation clôt l'affectation courante à l'instant T et en ouvre une nouvelle au même instant, avec motif obligatoire. Les ventes passées gardent leur attribution. Les commandes ouvertes gardent le commercial qui les a obtenues. | AV-015 |
| BR-CRM-021 | Les modifications de coordonnées et de position d'un compte sont auditées avec leurs valeurs avant et après. | C (CM §40) |
| BR-CRM-022 | Les conditions de crédit (`credit_allowed`, `credit_limit_xaf`, `payment_terms_days`) ne sont modifiables qu'avec `crm.customer.credit_manage`. | AV-028 |
| BR-CRM-023 | Un compte créé ou rapproché depuis Kommo a la source `KOMMO` et un lien externe. Son titulaire est le commercial GIC mappé à l'utilisateur Kommo responsable, sinon il reste sans titulaire en attente d'affectation. | AV-069, AV-071 |
| BR-CRM-024 | Un commercial ne peut créer, modifier ou visiter que des comptes de son portefeuille, sauf les nouveaux comptes qu'il crée. Un responsable commercial agit sur les portefeuilles de son équipe. | C (CM §48) |

## 8. Validations

| Objet | Contrôle | Erreur |
|---|---|---|
| Compte | Téléphone normalisable E.164 ; zone existante et active ; source et catégorie valides | `PHONE_INVALID`, `ZONE_INVALID`, `REFERENCE_INVALID` |
| Compte | Doublon de téléphone (BR-CRM-006) | `DUPLICATE_CUSTOMER` |
| Visite | Compte existant non `MERGED` ; `occurred_at` pas dans le futur ; précision GPS ≥ 0 | `CUSTOMER_NOT_FOUND`, `OCCURRED_AT_FUTURE` |
| Changement d'étape | Compte au stade `PROSPECT` ; étape active | `STAGE_TRANSITION_INVALID` |
| Réaffectation | Nouveau titulaire actif avec un rôle commercial ; différent du titulaire actuel | `ASSIGNEE_INVALID` |
| Fusion | Deux comptes distincts non `MERGED` ; permission sur les deux périmètres | `MERGE_INVALID` |
| Objectif | Valeur > 0 ; période valide ; pas de chevauchement (BR-CRM-018) | `TARGET_OVERLAP` |

## 9. Dépendances

- **Dépend de** : ADM (utilisateurs, équipes, zones, RBAC), D03-TER (session ouverte pour rattacher les visites).
- **Utilisé par** : VEN (compte client, titulaire à `occurred_at`, conditions de crédit), FIN (créances par client), ANA, KOM.

## 10. Événements produits

`ProspectCreated`, `CustomerUpdated`, `ProspectStepChanged`, `CustomerConverted`, `ProspectLost`, `ProspectReopened`, `CustomerReassigned`, `CustomerMerged`, `CustomerCreditTermsChanged`, `VisitRecorded`, `VisitCancelled`, `InteractionRecorded`, `SalesTargetSet`.

## 11. Événements consommés

| Événement | Producteur | Réaction |
|---|---|---|
| `SaleConfirmed` | VEN | Si le compte est `PROSPECT` → conversion (BR-CRM-010) et `CustomerConverted` |
| `SaleCancelled` | VEN | Si la vente annulée était `first_sale_id` et qu'aucune autre vente confirmée n'existe, le compte **reste** `CUSTOMER` avec l'indicateur `conversion_reverted`, pour préserver l'historique (pas de retour en arrière silencieux). |
| `KommoLeadQualifiedReceived` | KOM | Création ou rapprochement du compte (BR-CRM-023) |
| `UserDeactivated` | ADM | Alerte au responsable commercial : « portefeuille de X sans titulaire actif » ; pas de réaffectation automatique |

## 12. Fonctionnement hors ligne

| Élément | Comportement |
|---|---|
| Données téléchargées | Comptes du portefeuille de l'utilisateur ; pour un responsable, ceux de son équipe ; comptes rattachés au PDV pour un vendeur ; visites des 90 derniers jours ; étapes de pipeline ; référentiels. |
| Création d'un prospect | Identifiant UUIDv7 créé sur l'appareil ; contrôle de doublon **local** sur le téléphone ; commande `crm.customer.create` en outbox. |
| Visite | Position GPS capturée hors ligne (le GPS ne dépend pas du réseau) ; rattachement local à la session ouverte. |
| Modification concurrente d'un compte | Fusion champ par champ avec version (voir matrice des conflits, ligne « prospect modifié sur deux appareils »). |
| Réaffectation pendant que l'ancien titulaire est hors ligne | Les opérations de l'ancien titulaire à `occurred_at` antérieur restent valides. Postérieures : acceptées (visites, commandes) et attribuées selon BR-CRM-020, avec une notification au nouveau titulaire. |
| Performances | Calcul local sur les données propres (ventes, visites, prospects du jour), fusionné avec le dernier instantané serveur ; affichage « à jour au JJ/MM HH:MM ». |

## 13. Permissions

`crm.customer.read`, `crm.customer.create`, `crm.customer.update`, `crm.customer.reassign`, `crm.customer.mark_lost`, `crm.customer.merge`, `crm.customer.credit_manage`, `crm.visit.record`, `crm.visit.read`, `crm.interaction.record`, `crm.target.manage`, `crm.target.read`, `crm.pipeline.configure`.

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Deux commerciaux créent le même prospect hors ligne | Le premier appliqué gagne. Le second est appliqué avec le conflit `DUPLICATE_CUSTOMER` (les deux comptes existent). Le responsable fusionne ; l'acquéreur retenu est le plus ancien par `occurred_at` (BR-CRM-007). |
| Compte sans téléphone ni GPS | Refusé (BR-CRM-002). |
| Visite d'un compte hors portefeuille (ex. client d'un collègue rencontré) | Refusée en ligne (`FORBIDDEN_SCOPE`). Hors ligne impossible, car le compte n'est pas téléchargé : l'utilisateur crée un prospect, ce qui déclenche la détection de doublon. |
| Utilisateur titulaire désactivé | Le portefeuille reste attaché à lui (historique) jusqu'à réaffectation ; alerte au responsable. |
| Conversion déclenchée par une vente ensuite annulée | Voir §11 : le stade `CUSTOMER` est conservé, avec l'indicateur `conversion_reverted`. |
