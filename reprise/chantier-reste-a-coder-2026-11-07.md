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
| 4 | Report des pièces papier DA, BC, VC, FI, FL (FA, FJC et JE sont des documents dérivés : non reportables) + registre des carnets par site (AV-312) | en cours | — |
| 5 | Restes d'AV-514 : jeux hors ligne `presence` et `weekly_reports`, vue d'analyse de la présence, rattachement à un compte, chiffres du bilan allégés — AV-532, migration `20261204110000` | fait, commité | voir `git log` |
| 6 | Besoins serveur des écrans : revue des 52 besoins par trois relecteurs, S-08, S-20, S-21, S-33, S-34, S-36, S-41 (a), S-42, S-50 et S-52 codés, le reste consigné — AV-533, AV-534 | fait, commité | voir `git log` |
| 7 | Restes de P9 : `DeviceEnrollmentRequested` (AV-432) fait avec le lot 6 ; détail par canal et classement des commerciaux du bloc VENTES livrés ; `PushSendOptions` déjà exporté ; disponible par zone (KPI-STK-01) consigné — AV-535 | fait, commité | voir `git log` |
| 8 | S-12 (clients du siège hors ligne), S-39 seconde partie (objectifs de site), tablette partagée multi-vendeurs : défauts paramétrables + AV | à faire | — |
| 9 | Web Push côté serveur sans clés (AV-365) : adaptateur RFC 8291 et 8292 prouvé contre l'exemple de la RFC, activation par les variables VAPID, clé publique servie à la PWA, script de génération ; abonnement de la PWA non fait — AV-536 | fait, commité | voir `git log` |
| 10 | Vérification complète (`scratchpad\full-check.ps1`) | à faire | — |
| 11 | Revue adverse (cinq relecteurs au plus) et clôture (CLAUDE.md, reprise, mémoire) | à faire | — |

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
