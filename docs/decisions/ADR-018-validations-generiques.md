# ADR-018 — Validations et politiques de contrôle génériques

- **Statut** : ACCEPTÉ (CONFIRMÉ CM §24, §42, §52 ; seuils AV-037, AV-048, AV-051, AV-058)
- **Date** : 24/09/2026

## Décision
- Module `approvals` : **politiques versionnées** (type d'opération, conditions de catégorie, quantité, valeur ou pourcentage, photo, commentaire, validation, permission et portée d'approbation) et **demandes de validation** (sujet polymorphe, politique figée, décision).
- Évaluation de la politique à `occurred_at` (indicative sur l'appareil, de référence sur le serveur).
- **File de validation unifiée** pour les responsables (CM §52).
- Décision exécutée **de manière synchrone** : chaque module enregistre auprès d'`approvals` un gestionnaire pour ses types d'opération, appelé dans la transaction de la décision (inversion de dépendance). Un événement est émis pour les notifications.
- Séparation des tâches (AV-010).

## Alternatives
Une logique de validation codée dans chaque module : incohérences, pas de file unique. Moteur de workflow générique (BPMN) : surdimensionné.

## Conséquences
Paramétrage des seuils par la Direction sans développement ; effet immédiat et cohérent des décisions.
