# ADR-016 — Temps métier et horloges

- **Statut** : ACCEPTÉ (CONFIRMÉ CM §38 ; PM §5 ; fenêtre rétroactive AV-078)
- **Date** : 24/09/2026

## Décision
- Quatre instants distincts : `occurred_at` (réel, déclaré sur l'appareil), `client_created_at` (horloge de l'appareil), `received_at` (serveur), `applied_at` / `created_at` (serveur).
- Tous les rapports, performances, caisses et soldes à date utilisent `occurred_at`, ramené au jour métier `Africa/Douala`.
- Écart d'horloge mesuré à chaque push ; au-delà de 5 min, marquage `clock_suspect` et alerte. **Aucune correction silencieuse** de `occurred_at`.
- Refus des dates futures (> 5 min après correction) ; saisie rétroactive limitée à 72 h, avec justification au-delà de 24 h (AV-078).
- Stockage `timestamptz` en UTC ; serveur synchronisé par NTP.

## Alternatives
Utiliser l'heure serveur : contraire au CM §38. Corriger automatiquement l'heure : masquerait une fraude ou une erreur.

## Conséquences
Soldes « à une date métier », rapprochements tardifs des inventaires, sessions de caisse réévaluées.
