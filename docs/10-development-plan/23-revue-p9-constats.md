# Revue adverse du code de P9 (P9-25) — constats

> Revue menée le 26/10/2026 sur la branche `claude/p9-integration`, après l'intégration de P9 et une suite complète verte sur une base neuve (serveur 2 020 tests). Six relecteurs, un par domaine, chacun chargé de réfuter ses propres constats avant de les rendre. **Aucun correctif n'est encore appliqué** : le traitement est le premier travail de la session suivante (voir [`../../CLAUDE.md`](../../CLAUDE.md), « Reprise »). Verdicts : CONFIRMÉ (test temporaire, mesure ou trace dans le code), PLAUSIBLE (non démontré). Gravités : BLOQUANT, MAJEUR, MINEUR.

> **Revue interrompue le 26/10/2026 à la demande du porteur**, après le rendu d'un seul domaine sur six (§ 1, exports). Les domaines alertes, notifications et notes, explorateur, tableaux de bord et plateforme (voies de tâches, purge) restent à relire : la revue est à relancer en entier sur ces cinq domaines avant la clôture P9-26. Les neuf tests sautés (`ctx.skip` faute de données dans `analytics-views-commercial` et `analytics-views-stock`) sont aussi à examiner.

## 1. Vues sauvegardées et exports audités

| N° | Constat | Gravité | Verdict | Où | Correctif proposé |
|---|---|---|---|---|---|
| EX-1 | La purge des exports abandonnés entre en course avec un calcul en cours. Elle supprime le fichier hors transaction, puis son `UPDATE` heurte le déclencheur et toute la passe est annulée. Résultat : un export `DONE`, notifié, sans fichier (`410` au téléchargement) | MAJEUR | CONFIRMÉ (test) | `maintenance/purge.ts:103-110`, `exports/export-store.ts:584-605` | Sélection `FOR UPDATE SKIP LOCKED`, filtre `status IN ('QUEUED','RUNNING')`, suppression du fichier après la mise à jour |
| EX-2 | Fichiers d'export jamais purgés quand la rétention baisse ou quand la purge ne tourne pas pendant plus de 30 jours (fenêtre glissante `[now-2×, now-1×[`) ; le compteur de fichiers supprimés est faux | MINEUR | CONFIRMÉ (code) | `purge.ts:94-100`, `export-store.ts:651-667` | Sélectionner les `EXPIRED` encore pourvus d'un fichier, marquer `file_purged_at` (le déclencheur doit l'autoriser) |
| EX-3 | Le téléchargement ne revérifie ni le droit du jeu ni `inventory.valuation.read` : un droit retiré après le calcul laisse télécharger des valeurs au coût pendant 24 h | MINEUR | CONFIRMÉ (code) | `analytics-api/analytics-exports.controller.ts:115-170` | Rejouer la validation des droits au téléchargement, `403` audité ; **à faire trancher par le porteur** (AV-384 ne l'exige pas) |
| EX-4 | Un XLSX de 100 000 lignes bloque la boucle du worker environ 4 s (580 Mo), ce qui gèle la voie courte des alertes | MINEUR | CONFIRMÉ (mesure) | `xlsx-writer.ts:116-176`, `zip-writer.ts:221` | Construction par lots avec `await`, `deflateRaw` asynchrone ; XLSX dans `test:perf` |
| EX-5 | Tests annoncés par ADR-067 absents : limite de lignes, de durée et étendue tronquée sur le chemin d'export | MINEUR | CONFIRMÉ | `run-export.ts:356-368` | Deux cas `FAILED` sans fichier, audités |
| EX-6 | Seuil d'abandon d'un export codé en dur (1 jour), contraire à la règle 8 | MINEUR | CONFIRMÉ | `purge.ts:103` | Paramètre `analytics.export_abandon_hours` (24) |
| EX-7 | Période relative résolue au calcul et non à la demande ; l'audit ne garde pas les dates résolues | MINEUR | PLAUSIBLE / CONFIRMÉ pour l'audit | `run-export.ts:290-343` | Figer `fromDay`/`toDay` à la demande, ou au moins les écrire dans l'audit |
| EX-8 | Plafond `EXPORT_BACKLOG` dépassable par deux demandes simultanées du même utilisateur | MINEUR | PLAUSIBLE | `export-commands.ts:81-97` | Verrou par demandeur avant le compte |

Relu sans constat : commandes et lectures des vues (propriétaire seul, revalidation pour l'exécutant), calcul de l'export (droits revérifiés, échec métier `FAILED` sans boucle), contrôleur (demandeur seul, audit du téléchargement), garde contre l'injection de formule CSV et XLSX, échappement XML, stockage (`pathFor` borné), déclencheurs d'immuabilité, AT-046.
