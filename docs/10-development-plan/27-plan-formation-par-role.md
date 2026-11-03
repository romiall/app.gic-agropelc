# Plan de formation par rôle (lot RP-7d, NFR-35)

> **Statut : rédigé le 03/11/2026** pour garantir l'autonomie rapide des équipes terrain et prévenir le risque d'abandon ([plan de reprise](../../reprise/prompt-reprise-reste-a-faire.md) § 4, NFR-35, RISK-15).
> **Exigence NFR-35** : un nouvel utilisateur doit être autonome sur son action principale après **30 minutes de formation**. Chaque module est conçu sous forme d'atelier court et orienté action (UX-01 à UX-11).

---

## 1. Principes pédagogiques et organisation

1. **Ateliers de 30 minutes maximum** : chaque rôle n'apprend que son périmètre quotidien direct (≤ 5 champs obligatoires par écran).
2. **Pratique directe sur smartphone** : les participants manipulent sur leur propre appareil (ou appareil d'exploitation) dès la première minute.
3. **Apprentissage du hors-ligne** : chaque utilisateur apprend à travailler en coupant volontairement sa connexion (mode avion) pour acquérir le réflexe de confiance dans la synchronisation locale.
4. **Validation par exercice pratique** : à l'issue des 30 minutes, l'apprenant réalise une action complète sans assistance (critère de succès NFR-35).

---

## 2. Sommaire des modules de formation

| Réf. | Rôle visé | Thème principal | Action clé (≤ 30 min) |
|---|---|---|---|
| **MOD-00** | *Tous utilisateurs* | Socle commun | Connexion, code PIN, synchronisation, hors-ligne |
| **MOD-01** | `COMMERCIAL_TERRAIN` | Ventes itinérantes | Prise de service GPS, visite, vente mobile, encaissement |
| **MOD-02** | `VENDEUR_PDV` | Boutique et comptoir | Caisse, vente comptoir, ticket de vente, réapprovisionnement |
| **MOD-03** | `MAGASINIER` | Dépôt et stocks | Réception BC, inventaire tournant, transfert de stock |
| **MOD-04** | `RESP_FERME` / `RESP_PRODUCTION` | Élevage et couvoir | Saisie quotidienne mortalité/aliment, collecte œufs, incubation |
| **MOD-05** | `RESP_ACHATS` | Approvisionnements | Validation demandes, bons de commande, rapprochement réceptions |
| **MOD-06** | `FINANCE` | Trésorerie et dépenses | Contrôle des caisses, paiement fournisseur, suivi créances |
| **MOD-07** | `DIRECTION` | Pilotage et arbitrages | Tour de contrôle, alertes de seuils, notes internes, validations |
| **MOD-08** | `ADMIN` | Administration système | Comptes utilisateurs, approbation appareils, sites et paramètres |

---

## 3. Détail des modules de formation

### MOD-00 : Socle commun (15 minutes — Pré-requis universel)
- **Public** : tout nouvel utilisateur avant d'accéder à son métier.
- **Objectifs** :
  1. Installer la PWA sur son téléphone et la lancer en mode plein écran.
  2. Se connecter avec son numéro de téléphone ou e-mail et faire approuver l'appareil.
  3. Définir son code PIN à 6 chiffres et le mémoriser.
  4. Comprendre le badge de synchronisation (vert = à jour, orange = opérations en attente).
- **Exercice de validation** : verrouiller l'écran, couper Internet, déverrouiller par code PIN.

---

### MOD-01 : Commercial terrain (30 minutes)
- **Public** : commerciaux itinérants (`COMMERCIAL_TERRAIN`).
- **Écrans clés** : `ECR-TER-01` (Service), `ECR-CRM-02` (Prospect), `ECR-CRM-04` (Visite), `ECR-VEN-01` (Vente).
- **Déroulement** :
  - *Min 00-05* : Prise de service géolocalisée (bouton vert « Prendre mon service » dans sa zone).
  - *Min 05-12* : Création d'un prospect (nom, téléphone, position GPS automatique).
  - *Min 12-20* : Enregistrement d'une vente en mode hors ligne (choix des poulets/aliments, calcul automatique, règlement espèces ou crédit autorisé).
  - *Min 20-25* : Consultation du bon de vente et explication du duplicata.
  - *Min 25-30* : Clôture de fin de journée et vérification de la synchronisation au retour réseau.
- **Critère d'autonomie** : réaliser une vente de 2 poulets hors ligne en moins de 2 minutes.

---

### MOD-02 : Vendeur point de vente (30 minutes)
- **Public** : vendeurs boutique et points de vente sédentaires (`VENDEUR_PDV`).
- **Écrans clés** : `ECR-DIS-01` (Accueil PDV), `ECR-DIS-02` (Caisse), `ECR-VEN-01` (Vente comptoir).
- **Déroulement** :
  - *Min 00-08* : Ouverture de caisse du jour avec fond de caisse initial.
  - *Min 08-18* : Enchaînement de ventes comptoir (espèces, Mobile Money), émission du reçu client.
  - *Min 18-24* : Signalement d'un produit sous seuil et demande de réapprovisionnement magasin.
  - *Min 24-30* : Clôture de caisse du soir, comptage physique et déclaration des espèces à remettre.
- **Critère d'autonomie** : ouvrir une caisse et enregistrer un encaissement mixte en moins de 3 minutes.

---

### MOD-03 : Magasinier (30 minutes)
- **Public** : magasiniers centraux et annexes (`MAGASINIER`).
- **Écrans clés** : `ECR-APP-04` (Réception), `ECR-STK-02` (Transfert), `ECR-STK-05` (Inventaire).
- **Déroulement** :
  - *Min 00-10* : Réception d'un bon de commande fournisseur (quantités livrées, motif si rejet partiel, photo du bordereau livreur).
  - *Min 10-20* : Préparation et expédition d'un transfert vers un point de vente ou une ferme.
  - *Min 20-25* : Comptage physique d'inventaire tournant sur un rayon.
  - *Min 25-30* : Déclaration d'une avarie ou perte de stock avec motif obligatoire.
- **Critère d'autonomie** : réceptionner un arrivage avec 1 sac d'aliment refusé sans assistance.

---

### MOD-04 : Éleveur et Responsable de ferme (30 minutes)
- **Public** : chefs de site avicole (`RESP_FERME`, `RESP_PRODUCTION`).
- **Écrans clés** : `ECR-PRD-01` (Lots), `ECR-PRD-02` (Ponte/Mortalité), `ECR-PRD-06` (Incubation).
- **Déroulement** :
  - *Min 00-10* : Saisie journalière du bâtiment (nombre de poulets morts avec photo si seuil dépassé, sacs d'aliment consommés).
  - *Min 10-18* : Collecte des œufs par calibre (plateaux normaux, fêlés, double-jaune).
  - *Min 18-25* : Transfert d'alvéoles vers l'incubateur ou miretage d'éclosoir.
  - *Min 25-30* : Consultation de la fiche de lot (taux de mortalité cumulé, FCR).
- **Critère d'autonomie** : renseigner la saisie matinale complète d'une bande de poulets de chair en 90 secondes.

---

### MOD-05 : Responsable des achats (30 minutes)
- **Public** : service approvisionnements (`RESP_ACHATS`).
- **Écrans clés** : `ECR-APP-01` (Fournisseurs), `ECR-APP-02` (Demandes), `ECR-APP-03` (Bons de commande).
- **Déroulement** :
  - *Min 00-10* : Revue des demandes d'achat des fermes et transformation en bon de commande.
  - *Min 10-18* : Gestion de la fiche fournisseur et des conditions tarifaires.
  - *Min 18-25* : Rapprochement 3 voies (bon de commande, bon de réception magasin, facture fournisseur).
  - *Min 25-30* : Suivi des reliquats de commande non encore livrés.
- **Critère d'autonomie** : émettre un bon de commande d'intrants à partir d'une demande de ferme.

---

### MOD-06 : Équipe Finance et Comptabilité (30 minutes)
- **Public** : trésorier, comptable, responsable administratif et financier (`FINANCE`).
- **Écrans clés** : `ECR-FIN-01` (Créances), `ECR-FIN-02` (Dépenses), `ECR-FIN-05` (Trésorerie).
- **Déroulement** :
  - *Min 00-10* : Vue de trésorerie consolidée par compte et validation des remises de fonds.
  - *Min 10-18* : Traitement et imputation des notes de dépenses terrain avec justificatifs.
  - *Min 18-25* : Ordonnancement des paiements fournisseurs selon l'échéancier.
  - *Min 25-30* : Suivi de la balance âgée des créances clients et pointage des retards.
- **Critère d'autonomie** : pointer une remise de caisse et valider une dépense de carburant justifiée.

---

### MOD-07 : Direction générale (30 minutes)
- **Public** : directeurs de pôle, gérant, CEO (`DIRECTION`).
- **Écrans clés** : `ECR-ANA-01` (Tour de contrôle), `ECR-NOT-01` (Alertes), `ECR-NOT-03` (Notes internes).
- **Déroulement** :
  - *Min 00-10* : Lecture en 30 secondes de la tour de contrôle (ventes du jour, trésorerie, alertes rouges).
  - *Min 10-18* : Traitement de la file des validations d'exception (dépassement crédit client, dérogations).
  - *Min 18-25* : Rédaction et publication d'une note de service interne ciblée sur les équipes de vente.
  - *Min 25-30* : Descente dans l'explorateur analytique (`ECR-ANA-06`) pour isoler l'origine d'un écart de marge.
- **Critère d'autonomie** : statuer sur une dérogation en attente et diffuser une note aux responsables.

---

### MOD-08 : Administrateur système (30 minutes)
- **Public** : administrateur applicatif et support technique (`ADMIN`).
- **Écrans clés** : `ECR-ADM-04` (Utilisateurs), `ECR-ADM-05` (Appareils), `ECR-ADM-06` (Organisation), `ECR-ADM-07` (Paramètres).
- **Déroulement** :
  - *Min 00-08* : Création d'un compte agent, affectation des rôles et périmètres de site/zone.
  - *Min 08-15* : Approbation d'un nouveau terminal smartphone avec contrôle du code court.
  - *Min 15-22* : Ajustement d'un paramètre opérationnel (ex. seuil de stock ou tolérance de pesée).
  - *Min 22-30* : Consultation du journal d'audit (`ECR-AUD-01`) et diagnostic d'une anomalie.
- **Critère d'autonomie** : enrôler un nouveau commercial et son téléphone de bout en bout.

---

## 4. Matériel pédagogique remis aux apprenants

1. **La Fiche Plastifiée « 5 Réflexes Clés »** (format carte de poche) :
   - *Réflexe 1* : Je déverrouille avec mon PIN en arrivant sur le terrain.
   - *Réflexe 2* : Même sans réseau, je continue de saisir normalement.
   - *Réflexe 3* : Le badge orange me montre mes ventes enregistrées sur le téléphone.
   - *Réflexe 4* : Dès que j'ai du réseau, je laisse l'application ouverte 30 secondes pour synchroniser.
   - *Réflexe 5* : En cas de batterie faible, mes données sont sécurisées dans le téléphone.
2. **Support d'aide en ligne** : bouton d'aide contextuelle sur chaque écran menant au résumé de l'action.
