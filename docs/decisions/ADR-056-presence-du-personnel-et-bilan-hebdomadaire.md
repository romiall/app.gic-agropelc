# ADR-056 — Présence du personnel et bilan hebdomadaire du commercial : propriétaires, commandes, chiffres calculés

- **Statut** : ACCEPTÉ (DÉDUIT ; AV-313 et AV-314 gardent leur défaut, AV-514 pose les questions nouvelles)
- **Date** : 05/11/2026
- **Précise** : ADR-006 (rien ne disparaît), ADR-021 (logique partagée), ADR-048 (pièces papier), ADR-053 (chargement par fichier)
- **Questions liées** : AV-313, AV-314, AV-315, AV-316, AV-514 ; REQ-306, REQ-307, REQ-308 ; [`19-pieces-papier.md`](../10-development-plan/19-pieces-papier.md)

## Contexte

Le porteur a demandé (D6, D8, D9, D10 du 20/10/2026) que la présence du personnel non commercial et le bilan hebdomadaire du
commercial entrent dans l'application, alimentés par les fiches papier PT et BH, et que la fiche de visite VC s'imprime avec le
profil commercial du client et la veille marché (PP-D). Rien de tout cela n'existait : le pointage numérique ne couvre que les
commerciaux de terrain (`fieldwork_work_sessions`), et `communication.internal_notes` est la note de direction vers les équipes
(sens inverse du bilan). Les propriétaires des tables restaient « à décider en PP-0 » (AV-313, AV-314).

## Décision

1. **Présence : le module `fieldwork` possède deux tables.** `fieldwork_presence_sheets` est la feuille PT reportée (site,
   semaine, numéro de la feuille papier, responsable, source `PAPER`) : c'est le « lot d'import hebdomadaire » d'AV-313.
   `fieldwork_staff_presence` porte une ligne par personne et par jour (nom, fonction, zone ou mission, compte lié facultatif,
   arrivée, départ, code d'absence A, M, C, R ou MI). Les lignes sont en ajout seul ; la feuille ne change que par son annulation
   motivée (déclencheurs). La correction est donc **annuler puis reporter de nouveau** (règle 4).
2. **Présence : une commande par feuille.** `fieldwork.presence.record` (agrégat `PRESENCE_SHEET`, identifiant choisi par
   l'appareil) et `fieldwork.presence.cancel`. Un jour s'écrit en heures **ou** par un code d'absence, jamais les deux ; un
   départ suit son arrivée ; une feuille compte au plus 50 personnes, chacune une fois (une seule définition du nom, `personNameKey`) ;
   la semaine est un lundi et n'a pas à venir (`PRESENCE_WEEK_IN_FUTURE` : une feuille se reporte pendant la semaine ou après).
   Ces règles sont dans `@gic/domain` (`staff-presence.ts`) : l'appareil les applique avant d'envoyer, le serveur les rejoue
   (`PRESENCE_*`). Droits `fieldwork.presence.record` et `.read`, portée **site** (Direction et Admin partout, responsables de
   production et de ferme sur leur site ; le responsable de production, affecté globalement, les lit tous : pré-filtre par
   `listConfinementAt`), jugée à `occurred_at` comme tout fait. **Rejeu** : le serveur ne reconnaît comme rejeu que la même
   feuille (même auteur, site, semaine, en-têtes, lignes et jours) ; un autre contenu ou un autre auteur sous le même
   identifiant est refusé (`PRESENCE_ID_TAKEN`, comme `LOSS_ID_TAKEN`), de même qu'une feuille déjà annulée
   (`PRESENCE_SHEET_CANCELLED` : rien n'est reporté, l'écran ne l'annonce pas comme enregistrée).
3. **Présence : jamais comptée deux fois.** Ces lignes ne sont pas des sessions de travail. Elles n'entrent ni dans le pointage
   numérique ni dans `analytics_f_attendance` (jours de présence des commerciaux, KPI-COM-17) : aucun jour n'est compté deux fois.
   Une vue d'analyse propre à la présence papier est un ajout de P9, hors de ce lot (AV-514).
4. **Bilan : le module `crm` possède `crm_weekly_reports`.** Un bilan par commercial et par semaine (lundi au dimanche, jours
   métier de Douala), cinq textes (réussites, difficultés, besoins et demandes à la direction, priorités, informations du marché),
   le « vu » du responsable et son commentaire. Commandes `crm.weekly_report.submit` et `crm.weekly_report.review` (agrégat
   `WEEKLY_REPORT`). L'identifiant du bilan dérive du couple (commercial, semaine) : **renvoyer le bilan est une correction**,
   possible tant que le responsable ne l'a pas vu ; le texte le plus récent (`occurred_at`) l'emporte et un envoi plus ancien
   arrivé après est ignoré (le journal le dit : avant = après = l'état enregistré). Une fois `REVIEWED`, les textes sont figés
   (`REPORT_LOCKED`, déclencheur ; le bilan vu ne redevient pas `SUBMITTED`, même en SQL direct) ; le responsable peut revoir son
   commentaire. Les textes d'avant une correction restent dans le journal d'audit de la commande. Droits
   `crm.weekly_report.submit` (commerciaux, pour eux), `.read` (soi ; équipe pour le responsable commercial ; tous pour la
   Direction) et `.review` (équipe ou tous), jamais sur son propre bilan. **Son propre bilan s'écrit et se lit avec la seule
   permission** : l'auteur en est le titulaire par construction, et la portée `OWN` d'une ressource sans zone ni site ne serait
   jamais « dans le périmètre » d'un commercial terrain, affecté par zone. **Le « vu » est une intention sur un état partagé** :
   il porte la version lue (`base_version`) et le serveur le refuse (`REPORT_CHANGED`) si le commercial a corrigé depuis ; le
   dernier « vu » l'emporte (`occurred_at`) sans faire reculer la date ; un « vu » sans commentaire garde celui qui existe,
   `null` l'efface. Une correction écrite hors ligne avant le « vu » mais arrivée après est refusée (`REPORT_LOCKED`) : choix à
   confirmer (AV-514).
5. **Bilan : les chiffres ne sont ni saisis ni stockés.** `GET /weekly-reports/figures` les compose à la lecture (couche
   transport `crm-api`, qui compose déjà `crm` et `sales`) avec les définitions déjà publiées, une seule par indicateur
   (ADR-065 §2) : visites, comptes créés et conversions (`commercialEffort`), chiffre d'affaires net des ventes attribuées
   (`periodRevenue`), encaissé net (`cashedActivity`), pertes déclarées (`lossesDeclaredBy`, nouvelle fonction publique
   d'`inventory`). La **valeur des pertes est au coût** : `null` sans `inventory.valuation.read` (RC-05).
6. **Lectures en ligne.** `GET /staff-presence` et `GET /weekly-reports` (portée élément par élément, RC-04). Écrire est
   possible hors ligne (outbox) ; relire l'historique demande le réseau. Aucun jeu hors ligne n'est ajouté : c'est le reste
   déclaré en AV-514, à reprendre si les responsables travaillent hors ligne.
7. **Les trois fiches papier.** PT (A4 paysage, quatorze lignes par feuille), BH (A5 portrait) et VC (A5 portrait) sont rendues
   comme les seize autres (ADR-048) : balisage et charte du dossier papier, aucune apparence modifiée. Un essai compare
   chaque rubrique, titre de colonne, titre de section et case des gabarits `pieces-papier/gabarits/` à la pièce rendue. La fiche
   PT imprime du lundi au samedi comme le papier (le dimanche relevé se lit dans l'application) ; la fiche VC n'a de place que
   pour un relevé de veille : le premier s'écrit et le titre de la section dit « 1 relevé sur n ».
8. **Chargement par fichier.** Le type « Présence du personnel (fiche PT) » de `ECR-IMP-01` lit une ligne par personne avec
   ses jours en colonnes (le code d'absence dans la case « arrivée », comme sur le papier) et réunit les lignes d'une même
   feuille : même site (désigné par son code ou son nom), même semaine (n'importe quel jour de la semaine) et même numéro. Il
   lit les heures `07:45`, `07 h 45` et `08:30:00` (format « Heure » d'Excel) et ignore les lignes recopiées sans personne ni
   jour. L'identifiant de la feuille dérive de l'auteur et de **toute la charge** (site, semaine, numéro, responsable, lignes) :
   recharger le même fichier ne reporte rien deux fois (ADR-053), et une feuille rechargée corrigée est une autre feuille.

## Conséquences

- Deux migrations : `20261104120000` (présence) et `20261104130000` (bilan), en ajout seul (tables nouvelles).
- Cinq droits (`fieldwork.presence.record`, `fieldwork.presence.read`, `crm.weekly_report.submit`, `.read`, `.review`),
  seize octrois : matrice RBAC, graine et essai de graine alignés.
- Deux écrans : `ECR-TER-03` (présence, `/presence`) et `ECR-CRM-08` (bilan, `/bilan-hebdomadaire`) ; la fiche VC s'ouvre depuis
  une visite de l'activité du compte.
- Déclencheurs : une feuille annulée ne change plus du tout (elle ne redevient pas `RECORDED`) ; un bilan vu ne redevient pas
  `SUBMITTED`. Le premier envoi d'un bilan s'exécute en lecture validée (`read committed`) : un `FOR UPDATE` sur une ligne
  absente poserait un verrou de plage qui ferait s'interbloquer deux commerciaux.
- Une date impossible dans une requête de lecture (`2026-02-30`) est un 400, jamais une erreur serveur.
- Non fait, consigné en AV-514 : jeu hors ligne des bilans et des feuilles, vue d'analyse de la présence papier, signalement
  d'une feuille reportée deux fois (même site, semaine et numéro sous deux identifiants), rattachement d'une personne à un
  compte lors de la saisie, droit de rédiger un bilan du responsable commercial, pertes en attente de validation dans les
  chiffres, texte plus long que sa zone sur la fiche imprimée (signalé au pied de la fiche, jamais coupé sans le dire).
