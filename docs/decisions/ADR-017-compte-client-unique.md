# ADR-017 — Un seul compte client pour le prospect et le client

- **Statut** : ACCEPTÉ (DÉDUIT de CM §7, §8) ; règle de conversion À VALIDER (AV-012)
- **Date** : 24/09/2026

## Décision
Une seule table `crm.customers`, avec un stade système (`PROSPECT`, `CUSTOMER`, `LOST`, `MERGED`) et des étapes de pipeline configurables (au stade `PROSPECT`). L'acquéreur est immuable ; le titulaire est historisé. Conversion automatique à la première vente confirmée ; fusion pour les doublons.

## Alternatives
Tables séparées prospects et clients : copie à la conversion, historique (visites, acquisition) coupé, doublons.

## Justification
L'historique complet « prospect → client → CA » est demandé (CM §7 : « CA des clients acquis par ce commercial »).
