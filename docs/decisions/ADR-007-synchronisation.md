# ADR-007 — Synchronisation : commandes idempotentes (push) et flux de changements par périmètre (pull)

- **Statut** : ACCEPTÉ (exigences CONFIRMÉES PM §5, §29, §30 ; mécanisme DÉDUIT)
- **Date** : 24/09/2026

## Contexte
Il faut remonter sans perte ni doublon des opérations créées hors ligne, gérer les conflits selon la criticité métier, et redescendre vers chaque appareil **seulement** les données de son périmètre (PM §29).

## Décision
1. **Push** : lots ordonnés de commandes (`command_id`, `device_seq`, `occurred_at`, `base_version`, `depends_on`) ; inbox serveur idempotente (clé primaire `command_id` + empreinte) ; application séquentielle par appareil ; un résultat par commande (`APPLIED`, `APPLIED_WITH_WARNINGS`, `CONFLICT`, `REJECTED`, `RETRY_LATER`).
2. **Faits contre intentions** : un fait accompli n'est jamais rejeté pour une raison d'état métier (BR-SYN-007) ; une intention sur un état partagé utilise la concurrence optimiste, avec fusion ou conflit.
3. **Pull** : `sync.change_feed`, avec une ligne par (entité, périmètre destinataire), `UPSERT`, `DELETE` ou `SCOPE_EXIT`, sans copie de données (lecture de l'état courant) ; curseurs par jeu de données ; chargement initial avec point haut ; rétention de 60 jours.
4. Pièces jointes : canal séparé et reprenable (ADR-012).

## Alternatives étudiées
- Réplication d'états, dernier écrit gagnant : refusé (PM §30).
- Horodatage `updated_at` comme curseur : perd des changements lors de transactions concurrentes ; ne gère pas les sorties de périmètre.
- CRDT : adapté à l'édition collaborative, pas aux règles métier de stock et de finance.

## Justification
Le couple commandes + flux sépare nettement **ce qui est demandé** (intention, traçable et rejouable) de **ce qui est** (état serveur), et permet un filtrage fin par périmètre (portefeuille, site, appareil).

## Conséquences
Tables `sync.command_inbox`, `sync.change_feed`, `sync.sync_conflicts`, `sync.device_sync_state` ; chaque gestionnaire écrit le flux dans sa transaction ; compatibilité N-1 des commandes (BR-SYN-016).

## Risques
RISK-01, RISK-03, RISK-10.
