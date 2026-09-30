# ADR-026 — Coût de lot : frais généraux de ferme et coproduits d'abattage

- **Statut** : ACCEPTÉ (décisions du porteur du projet du 27/09/2026 ; tranche AV-043 et AV-032 ; complète ADR-015) ; **amendé le 28/09/2026** (AV-103 à AV-106, voir en fin de document)
- **Date** : 27/09/2026

## Contexte

ADR-015 définit le coût d'un lot comme le cumul du registre de coûts (animaux d'origine, intrants consommés, dépenses directes) et le coût par tête comme ce cumul divisé par l'effectif non vendu. Deux points restaient ouverts :

- AV-043 : le coût de lot comprend-il des frais généraux ? La recommandation était « coûts directs uniquement ».
- AV-032 : le poulet est-il vendu vif seulement ? La recommandation était « vif uniquement au MVP ».

Le porteur du projet a tranché le 27/09/2026 : **coûts directs + frais généraux**, et **vif et abattu dès P7**.

## Décision

1. **Frais généraux de ferme** (CONFIRMÉ) :
   - ils sont saisis comme écritures de coût sur l'**objet de coût site** (registre de coûts d'`inventory`, `cost_object_type = SITE`), en attendant que les dépenses de `finance` (P8) y soient reliées ;
   - ils sont **répartis chaque mois** entre les lots actifs du site au prorata **têtes × jours** (effectif présent chaque jour du mois, sommé par lot) ;
   - la part de chaque lot devient une écriture de coût du lot ; le coût par tête intègre donc les frais généraux à chaque fin de mois.
2. **Abattage** (CONFIRMÉ) : transformation des poulets vifs d'un lot (consommation, `PRODUCTION_INPUT`) en plusieurs produits (poulet entier, découpes, abats — `PRODUCTION_OUTPUT`), avec rendement et pertes d'abattage enregistrés ; le coût des poulets abattus est **réparti entre les produits obtenus au prorata du poids**.
3. DÉDUIT, précisé dans D07 §15 à l'implémentation :
   - la répartition mensuelle est une tâche idempotente par (site, mois), rejouable sans double imputation ; un mois déjà réparti n'est jamais réécrit — une correction passe par une écriture de régularisation ;
   - une écriture de frais généraux saisie après la répartition de son mois est répartie au mois suivant, ou par une régularisation du mois concerné (choix précisé en D07 §15) ;
   - un site sans lot actif sur le mois conserve ses frais généraux non répartis, visibles comme tels ;
   - les frais généraux restent distincts des coûts directs dans le détail du coût de lot (deux composantes affichées).

## Alternatives

Coûts directs uniquement (ADR-015, recommandation AV-043) — écartée par le porteur du projet. Autres clés proposées et écartées : effectif moyen seul, parts égales, aliment consommé ; autres rythmes écartés : à la clôture du lot, chaque jour. Pour les coproduits : valeur de vente relative, coefficients fixes.

## Justification

Choix du porteur du projet : le coût par tête doit refléter le coût complet de la ferme. La clé têtes × jours impute davantage aux lots nombreux et longs, et le rythme mensuel limite les calculs tout en gardant un coût par tête à jour chaque mois.

## Conséquences

- ADR-015 reste en vigueur (statut inchangé pour AV-042) et est complété par cette décision.
- `inventory` : la tâche de répartition lit les soldes quotidiens des lots de traçabilité (effectif) ; `production` fournit la liste des lots actifs d'un site et d'une période.
- Les marges de lot incluent les frais généraux ; la marge brute des ventes au fil de l'eau reste calculée au coût figé des mouvements.

## Risques

RISK-24 (coût par tête) : un coût par tête qui augmente en fin de mois modifie la valorisation des sorties suivantes ; les sorties déjà faites gardent leur coût figé (jamais de revalorisation rétroactive, ADR-015).

## Amendement du 28/09/2026 (AV-103 à AV-106, décisions du porteur du projet)

1. **Séparation par espèce** (AV-104) : les frais généraux ne sont jamais mélangés entre espèces. Deux ensembles par ferme : **volaille** (chair, pondeuses, reproducteurs) et **porc** (engraissement, naissage). Chaque écriture de frais généraux porte une espèce ; un frais commun à toute la ferme est **ventilé à la saisie** (un montant par espèce). Chaque ensemble est réparti entre les lots de son espèce au prorata têtes × jours.
2. **Saisie** (AV-103) : Finance (toutes fermes), Responsable production (toutes fermes), Responsable ferme (sa ferme), en ligne, tracée à l'audit.
3. **Moment** (AV-106) : la répartition est lancée **à la demande** (Finance ou Responsable production) pour une ferme, une espèce et un mois ; un frais saisi après donne une **régularisation** du même mois (nouvelle exécution portant sur le montant non encore réparti), jamais une réécriture. Remplace le point 3 « DÉDUIT » ci-dessus sur les écritures tardives.
4. **Lot clôturé en cours de mois** (AV-105) : à la clôture, le lot reçoit une **part estimée** sur les frais déjà connus du mois de son espèce (têtes × jours écoulés) ; les exécutions suivantes du mois excluent ce lot. Précision DÉDUITE à l'implémentation (P7-10) : la part estimée porte sur chaque mois de la vie du lot dont une masse reste non répartie, pas seulement le mois de clôture.
5. **Responsabilité technique** (DÉDUIT, correction) : la répartition vit dans le module **`production`** — commande en ligne `production.overhead.allocate` — et écrit les coûts par l'API publique d'`inventory` ; `inventory` (niveau inférieur du graphe de dépendances) ne peut pas lister les lots de `production`. Remplace la phrase « `inventory` : la tâche de répartition… ; `production` fournit la liste des lots actifs » des Conséquences.
6. Les règles détaillées (arrondis, têtes × jours) sont dans [D07 §15](../01-functional/domaines/D07-PRD-production.md).
