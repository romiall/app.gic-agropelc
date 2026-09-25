# ADR-022 — Organisation de la documentation d'ingénierie

- **Statut** : ACCEPTÉ (résolution de la tension C-12)
- **Date** : 24/09/2026

## Contexte
Le PM §48 demande un document structuré en 39 sections ordonnées. La demande de démarrage demande une arborescence `/docs` versionnée, exploitable par des sessions de développement futures.

## Décision
- Un fichier par sujet dans `docs/` (lisible, chargeable séparément par une session de développement).
- Un **index maître** `docs/README.md` qui présente les 39 sections du PM §48 **dans l'ordre exact**, plus l'audit de cohérence, chacune avec un lien vers son fichier.
- Source unique par identifiant (AV, BR, INV, ADR, REQ, ECR, SM, NFR, RISK, AT), contrôlée par `docs/_tools/check_refs.py` en CI.
- `CLAUDE.md` à la racine : règles et ordre de lecture pour les futures sessions.

## Conséquences
L'index des règles métier est généré ; toute modification de spécification précède le code (conventions §7).
