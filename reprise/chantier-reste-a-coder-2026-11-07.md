# Chantier « tout ce qui restait à coder » du 07/11/2026 — état et reprise

> Demande du porteur (07/11/2026, après la poussée de la branche de travail sur GitHub) : « code tout ce que tu as listé de
> restant à coder ». Même méthode que le chantier du 05/11 : séquentiel, un lot après l'autre, un commit local par lot,
> vérification complète et une seule revue adverse à la fin. **Rien n'est poussé ni mis en ligne** par ce chantier.
> Numéros à utiliser : **AV-527 et suivants, ADR-059 puis ADR-069 et suivants, migrations `20261204…` et suivantes**
> (la branche `claude/magical-swirles-5e9ece` de l'autre session a pris AV-524 à 526 et ADR-057 et 058 : ne pas les réutiliser).

## Lots

| Lot | Contenu | État | Commit |
|---|---|---|---|
| 1 | Rapprochement tardif d'inventaire (BR-STK-044, BR-STK-045, AT-021, INV-STK-09, S-23) — AV-527, ADR-059, migration `20261204090000` | fait, commité | `365fb8a6` |
| 2 | Fenêtre de saisie rétroactive appliquée à toute commande (BR-SYN-012, AV-078) — AV-528, droit `sync.backdate.exceed` (130 droits, 523 octrois) | fait, commité | `32c6f240` |
| 3 | Quarantaine d'un compte suspendu puis réactivé (AV-229) — migration `20261204100000` | fait, commité | `6d04b78d` |
| 4a | Report des pièces papier DA, BC, VC, FI (FA, FJC et JE sont des documents dérivés : non reportables) — AV-530 | fait, commité | voir `git log` |
| 4b | Report de la fiche de suivi de lot FL (mortalité, aliment, pesée, observation ; les œufs par l'écran de collecte) — AV-531 | fait, commité | voir `git log` |
| 4 | Report des pièces papier DA, BC, VC, FI, FL (lots 4a et 4b ; FA, FJC et JE sont des documents dérivés : non reportables) ; registre serveur des carnets par site (AV-312) **non fait, consigné** : il attend la colonne dédiée d'AV-501 (b) | fait (registre consigné) | voir les lots 4a, 4b et 8 |
| 5 | Restes d'AV-514 : jeux hors ligne `presence` et `weekly_reports`, vue d'analyse de la présence, rattachement à un compte, chiffres du bilan allégés — AV-532, migration `20261204110000` | fait, commité | voir `git log` |
| 6 | Besoins serveur des écrans : revue des 52 besoins par trois relecteurs, S-08, S-20, S-21, S-33, S-34, S-36, S-41 (a), S-42, S-50 et S-52 codés, le reste consigné — AV-533, AV-534 | fait, commité | voir `git log` |
| 7 | Restes de P9 : `DeviceEnrollmentRequested` (AV-432) fait avec le lot 6 ; détail par canal et classement des commerciaux du bloc VENTES livrés ; `PushSendOptions` déjà exporté ; disponible par zone (KPI-STK-01) consigné — AV-535 | fait, commité | voir `git log` |
| 8 | S-12 (clients du siège hors ligne), S-39 seconde partie (objectifs de site), tablette partagée multi-vendeurs, registre serveur des carnets (AV-312) : **non codés, sciemment** — décision du porteur ou essai sur appareil requis ; raisons et conception consignées dans AV-522 et AV-312 | fait (consigné), commité | voir `git log` |
| 9 | Web Push côté serveur sans clés (AV-365) : adaptateur RFC 8291 et 8292 prouvé contre l'exemple de la RFC, activation par les variables VAPID, clé publique servie à la PWA, script de génération ; abonnement de la PWA non fait — AV-536 | fait, commité | voir `git log` |
| 10 | Vérification complète (`scratchpad\full-check.ps1`), deux fois : avant la revue, puis après ses correctifs | fait | voir le bilan |
| 11 | Revue adverse (cinq relecteurs en lecture seule, 38 constats) et clôture (CLAUDE.md, reprise, mémoire) | fait, commité | `25180033` |

## Règles de travail rappelées

Séquentiel ; pas de Workflow ; cinq agents au plus en parallèle ; jamais de `git push` sans demande ; rien en production sans
autorisation ; base d'essais `gic_agropelc_rp` seulement (migrations appliquées par `scratchpad\apply-migration-rp.mjs`) ;
`git add` de chemins explicites ; commits en français avec le pied `Co-Authored-By: Claude Sonnet 5.5` ; pas de `grep -r` de
la racine ; scripts d'édition écrits avec l'outil Write (pas de `node -e` avec des accents graves) ; toute nouvelle route de la
PWA devra recevoir une entrée d'aide après la fusion avec la branche de l'autre session (`features/help/content/`).

## Décisions de conception du lot 4 (07/11/2026)

- DA → `procurement.request.submit` (`localRef` déjà accepté) ; BC → `procurement.order.create` + `procurement.order.submit`
  (`localRef` à ajouter) ; VC → `crm.visit.record` (numéro de la pièce dans les notes) ; FI → `inventory.count.open` (`localRef`
  à ajouter) + `record_lines` + `submit` ; FL → les commandes de saisie du jour de la production, une par fait de chaque jour.
- FA (facture d'une vente), FJC (feuille journalière de caisse) et JE (journal des encaissements) ne se reportent pas : ils sont
  imprimés d'après des faits déjà enregistrés (la vente, les mouvements de caisse).

## Bilan et reprise (07/11/2026, fin du chantier)

**Commits locaux** (rien n'est poussé ni mis en ligne) : `365fb8a6` lot 1 · `32c6f240` lot 2 · `6d04b78d` lot 3 · `c731f649` et `78340006` lots 4a et 4b · `6442f381` lot 5 · `3afe2bc8` lot 6 · `dd559644` lot 7 · `48bc2f30` lot 9 · `7e109bdc` lot 8 (points consignés sans code) · `25180033` correctifs de la revue adverse · `063aa804` essais (« vu » d'un bilan, délai de l'exploration du catalogue d'analyse).

**Revue adverse** : cinq relecteurs en lecture seule (rapprochement d'inventaire et quarantaine de compte ; fenêtre d'antidatage et besoins serveur ; report des pièces papier ; jeux hors ligne, vue d'analyse et ventes ; Web Push et notifications) ont rendu 38 constats. Ceux qui sont réels ont été vérifiés dans le code puis corrigés (`25180033`) : identifiants d'agrégat des saisies d'une fiche de suivi de lot qui coïncidaient (≈ 2 % des fiches : une saisie perdue sans signal), double compensation et mauvaise répartition entre lots d'un rapprochement tardif, redirections HTTP suivies par l'adaptateur Web Push (contournement de la garde), code des rôles servi à tous les appareils, demande de transfert annulée en course avec son expédition (transfert soldé avec de la marchandise en transit), retour arrière d'une migration (erreur 1553 constatée), registre des carnets qui jugeait une fiche sur sa seule première saisie, trois erreurs ESLint, un essai que la fenêtre d'antidatage avait cassé. Le reste est consigné comme limite connue ou décision dans AV-229, AV-527, AV-528, AV-530 à AV-533 et AV-536.

**Vérification** (base jetable `gic_agropelc_rp`) : types des cinq paquets, ESLint (0 erreur, un avertissement ancien), frontières, références et kit verts ; essais du domaine 863, des contrats 286, de la base 249, du serveur 2 573 (243 fichiers) et de la PWA 1 539 (1 ignoré) verts, sauf quelques échecs de l'environnement tous rejoués et verts (un essai d'exploration de tout le catalogue d'analyse qui dépassait 20 s sur la base d'essai chargée, délai porté à 180 s ; un essai tombé pendant une suspension du poste ; un worker tombé ; un essai de ce chantier mal daté, corrigé) ; depuis le premier passage, seul le dossier des pièces papier de la PWA a changé (189 essais verts).

**À décider par le porteur** : accorder `sync.backdate.exceed` aux rôles opérationnels qui reportent des pièces de plus de 72 h (AV-528, AV-531 (a)) ; restreindre le jeu `role_assignment` aux affectations de l'utilisateur (AV-533) ; S-12, S-39 seconde partie, tablette partagée, registre serveur des carnets (AV-522, AV-312, AV-501 (b)) ; fournir les clés VAPID et un téléphone pour l'abonnement Web Push de la PWA (AV-536) ; mettre en ligne les trois migrations et le droit nouveau (`deploy.ps1` puis `db:seed`) ; pousser `main`.

**Reste à faire côté code, sur demande** : abonnement Web Push de la PWA et gestionnaire `push` du service worker (génération Workbox) ; colonne `paper_ref` par table d'opération puis registre serveur des carnets (AV-501 (b), AV-312) ; jeu `customers` du siège (AV-522) ; essais dans un navigateur et sur un téléphone, jamais faits.

**Prompt de reprise à coller** : « Reprends le projet GIC AGROPELC (CLAUDE.md puis reprise/chantier-reste-a-coder-2026-11-07.md). Le chantier du 07/11 est fait et vérifié en local (douze commits, rien poussé, rien en ligne). Dis-moi ce que je dois décider (section Bilan), et applique ce que je tranche. Ne touche pas aux fichiers de l'autre outil (rôle SUPERVISION, AV-529). »
