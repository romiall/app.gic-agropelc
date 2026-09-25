# ADR-004 — Prévention de la double consommation hors ligne : garde exclusive, quotas et réservations

- **Statut** : ACCEPTÉ ; politique par défaut À VALIDER (AV-025, AV-035)
- **Date** : 24/09/2026

## Contexte
Deux utilisateurs hors ligne peuvent croire disposer du même stock (CM §39). Le CM suggère d'affecter explicitement des quantités (PDV, commercial, vendeur, magasin). Le PM exige un mécanisme d'allocation ou de réservation et refuse le stock négatif comme mécanisme normal (PM §6).

## Décision
1. Chaque emplacement physique a un **mode de garde** :
   - `EXCLUSIVE_USER` : stock mobile d'un commercial, utilisable hors ligne sur son appareil principal ;
   - `EXCLUSIVE_DEVICE` : PDV mono-tablette, utilisable par l'appareil désigné ;
   - `SHARED` : consommation hors ligne seulement via quota.
2. **Quota** (`DEVICE_QUOTA`) accordé en ligne à un couple (utilisateur, appareil) sur un emplacement `SHARED`, avec Σ quotas + réservations ≤ solde à l'octroi. Le reste est libéré **sur confirmation de l'appareil** ; la révocation forcée est auditée.
3. **Réservation** (`ORDER_RESERVATION`) des commandes confirmées, transférable lors d'un transfert préparé pour la commande.
4. **Blocage sur l'appareil** au-delà du quota ou du solde exclusif (AV-025).
5. Si la prévention est contournée, une vente hors ligne réelle est appliquée et un conflit `STOCK_NEGATIVE` est ouvert : c'est une anomalie à résoudre, jamais un fonctionnement normal.

## Alternatives étudiées
- **Stock négatif toléré et réconcilié** : refusé par le PM §6.
- **Verrou en ligne obligatoire avant chaque vente** : contraire au CM §37.
- **Tout transférer physiquement vers le stock mobile de chaque vendeur**, y compris au PDV : lourd pour un PDV partagé ; conservé pour les commerciaux terrain (CM §23).

## Justification
La garde exclusive couvre sans friction le cas courant (commercial, PDV à un appareil). Les quotas couvrent le cas partagé. La libération confirmée par l'appareil empêche toute réattribution d'une quantité peut-être déjà vendue hors ligne.

## Conséquences
Tables `stock_allocations` et `stock_allocation_entries` ; écran d'octroi ; notion d'appareil principal ; harnais de tests à plusieurs appareils.

## Risques
RISK-05, RISK-17 (appareil modifié), friction opérationnelle en mode `SHARED`.
