# Démonstration de sortie de phase P0

> Backlog P0-18 ([`06-passage-au-developpement.md`](06-passage-au-developpement.md) §3). Critère : « AT-002, AT-034, AT-035, AT-036, AT-050, AT-055 verts ; démonstration hors ligne sur l'appareil de référence ». État arrêté le 25/09/2026, à la fin des éléments de code de P0 (P0-01 à P0-16).

---

## 1. Tests d'acceptation

Tous vérifiés verts, suite complète (apps/server, 195 tests ; apps/pwa, 51 tests) — voir le détail par test ci-dessous.

| AT | Scénario | Où | État |
|---|---|---|---|
| AT-002 | Lot renvoyé après perte de la réponse → un seul effet | `sync-push-pull.test.ts` (rejeu), `sync-harness.test.ts` (plusieurs appareils concurrents) | Vert |
| AT-034 | Utilisateur désactivé, commandes hors ligne avant/après | `identity-lifecycle.test.ts` | Vert |
| AT-035 | Appareil déclaré perdu, quarantaine des commandes postérieures | `identity-lifecycle.test.ts` | Vert |
| AT-036 | Horloge d'appareil décalée de 2 h → `CLOCK_SUSPECT` | `sync-push-pull.test.ts`, `sync-harness.test.ts` (deux appareils, écarts opposés) | Vert |
| AT-050 | Mise à jour de l'application avec des commandes N-1 en attente | `sync-push-pull.test.ts` | Vert |
| AT-055 | Import interdit entre modules → CI en échec | `pnpm run check:boundaries` (dependency-cruiser, job CI `verify`) | Vert |

Note d'exécution locale (25/09/2026) : la suite `apps/server` est verte de façon fiable en
exécution séquentielle des fichiers de test (`vitest run --no-file-parallelism`, 3 exécutions
consécutives, 195/195). En parallélisme de fichiers par défaut (`vitest.config.ts`,
`fileParallelism: true`), une contention occasionnelle sur le verrou du chaînage d'audit
(INV-AUD-01) peut renvoyer `RETRY_LATER` à un test qui ne boucle pas lui-même dessus —
comportement correct du serveur (c'est exactement ce que `RETRY_LATER` sert à faire), mais
propre à l'exécution de plusieurs fichiers d'écriture en même temps sur une seule base
partagée dans un environnement à cœurs limités ; déjà signalé comme compromis assumé par le
commentaire de `sync-push-pull.test.ts` avant cette session. De même,
`record-audit.test.ts` (« deux insertions concurrentes ») lève occasionnellement un vrai
deadlock InnoDB (`Deadlock found when trying to get lock`) même isolé de tout autre
fichier — un appel direct à `recordAudit` sans la reprise que `command-pipeline.service.ts`
applique aux erreurs transitoires (étape 7). Les deux existaient avant cette session
(P0-06/P0-07, ni l'un ni l'autre fichier n'a été modifié ici) ; sans incidence sur le code
serveur ni sur la validité des AT ci-dessus, vérifiés individuellement et par exécution
séquentielle complète.

## 2. Démonstration hors ligne

### 2.1 Ce qui est automatisé (CI, reproductible)

- **Coquille applicative hors ligne** (NFR-02) : `apps/pwa/e2e/offline-shell.spec.ts`
  (Playwright) — premier chargement en ligne, service worker activé, second chargement
  entièrement hors ligne (réseau coupé), écran de connexion rendu depuis le cache.
- **Pipeline complet, y compris hors ligne** : `sync-harness.test.ts` (P0-15) pousse
  `organization.setting.set` — la commande de démonstration désignée par le plan de
  développement §3 — en simulant `captured_offline: true`, une réponse perdue puis rejouée,
  et vérifie l'égalité de l'état après un pull complet.
- **Moteur de synchronisation de l'appareil** : `apps/pwa/src/sync/*.test.ts` (51 tests) —
  outbox, PIN/chiffrement local, push/pull, y compris les scénarios hors ligne (fetch en
  échec) et de session révoquée.

### 2.2 Parcours manuel (appareil de référence physique — hors de portée de cette session)

Ce que l'ADR-024 §5 exclut explicitement de P0 à P3 (aucun accès Hostinger requis) n'inclut
**pas** un appareil Android physique pour la démonstration finale de phase — un point que
cette session, exécutée dans un environnement cloud sans matériel, ne peut pas couvrir. Le
parcours à exécuter, une fois un appareil disponible :

1. Installer la PWA (« Ajouter à l'écran d'accueil ») depuis `pnpm run pwa:dev` (ou un build
   servi localement) sur le réseau du poste de développement.
2. Se connecter (ECR-ADM-01), établir le PIN (07-security-rbac/02-securite.md §3).
3. Couper le réseau (mode avion).
4. Depuis l'écran de synchronisation (ECR-SYN-01), utiliser le diagnostic (« Tester la
   synchronisation ») : la commande rejoint l'outbox (pastille orange, UX-04), l'application
   reste utilisable.
5. Rétablir le réseau : la pastille passe au vert, la commande apparaît « Synchronisé » ;
   vérifier côté serveur (`GET /api/v1/audit` ou `db/tests`) que l'audit et l'événement de
   domaine portent le `correlation_id` de cette commande (P0-16).
6. Verrouiller l'application (fermer puis rouvrir) : déverrouillage par PIN sans réseau
   (BR-ADM-024).

## 3. Ce qui reste ouvert avant la fin réelle de la phase

| Élément | Raison | Qui/quand |
|---|---|---|
| P0-17 : `staging` déployé chez Hostinger | Accès Hostinger hors de cet environnement (ADR-024 §5) ; modalité d'exécution Node.js encore ouverte (AV-090) | Porteur du projet, à la phase de déploiement |
| Procès-verbal de restauration **sur `staging`** (NFR-23) | Dépend du point précédent | Idem ; la procédure elle-même est écrite et validée localement — [`04-deploiement.md`](../05-architecture/04-deploiement.md) §5.1 |
| Démonstration hors ligne sur un appareil Android physique | Aucun matériel dans cet environnement cloud | Porteur du projet ou équipe technique, dès qu'un appareil est disponible (parcours §2.2 ci-dessus) |

Tout le reste du backlog P0 (P0-01 à P0-16) est terminé, testé, documenté et poussé sur
`claude/affectionate-maxwell-qvgrzq`.
