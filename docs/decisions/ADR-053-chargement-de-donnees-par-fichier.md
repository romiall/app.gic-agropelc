# ADR-053 — Chargement de données par fichier : contrôle sur l'appareil, identifiants dérivés de la clé, rejeu reconnu par le serveur

- **Statut** : ACCEPTÉ (DÉDUIT ; AV-508 ouvert avec son défaut)
- **Date** : 04/11/2026
- **Précise** : ADR-006 (rien ne disparaît), ADR-021 (logique partagée), ADR-046 (pièces jointes), ADR-048 (pièces papier)
- **Questions liées** : AV-072, AV-317, AV-508 ; REQ-303 ; [`19-pieces-papier.md`](../10-development-plan/19-pieces-papier.md)

## Contexte

La reprise des données (AV-072) et l'import par lots des pièces papier (AV-317, PP-C) demandent de charger des fichiers :
catalogue, fournisseurs, clients, historique des carnets. AV-317 (a) imaginait un module serveur d'import, avec des tables
d'attente, un rapport d'erreurs et une reprise ligne par ligne. Aucun n'existait, et les données de GIC ne sont pas
encore là. En revanche l'application a déjà **un seul chemin d'écriture** — l'outbox, des commandes idempotentes validées
par le serveur et auditées (règle 3) — et ses écrans de saisie portent déjà les contrôles métier (ADR-021).

## Décision

1. **Le fichier est lu et contrôlé sur l'appareil** (`apps/pwa/src/features/import/`, écran `ECR-IMP-01`). CSV de l'Excel
   français (UTF-8 ou Windows-1252, point-virgule, virgule ou tabulation, guillemets), 20 000 lignes de données au plus.
   Le rapport précède tout envoi : lignes à charger, déjà présentes (appareil ou outbox), en erreur, en double dans le
   fichier, colonnes obligatoires absentes, colonnes inconnues ignorées et listées. Aucune table d'attente côté serveur.
2. **Aucune règle nouvelle** : un type de données est une table de colonnes et une fonction qui transforme une ligne en
   commandes **en appelant le contrôle et la charge utile de l'écran de saisie** correspondant (`checkProduct`,
   `checkSupplier`, `checkProspect`, `prospectPayload`, `resolveSlip` + `buildReportCommand` pour les pièces papier).
   Ce que l'écran refuse, le chargement le refuse ; ce que l'écran envoie, le chargement l'envoie.
3. **Les droits sont ceux de l'écran de saisie** du type (catalogue : administrateur, fournisseurs : responsable des achats,
   clients : commerciaux, vendeur de PDV, responsable de ferme, pièces : rôles de l'écran de report). Aucun droit nouveau :
   le serveur revérifie chaque commande avec les droits de son auteur (RC-08).
4. **Identifiant d'un élément dérivé de sa clé** (`importEntityId(type, clé)` : SHA-256, mis en forme UUIDv7 à date fixe) :
   le code du produit, le téléphone du client, `TYPE|numéro` de la pièce. Charger deux fois le même fichier envoie la même
   création, qui ne crée rien de plus. Une catégorie ou une commande **déjà en attente** est citée par l'identifiant de
   *sa* commande dans l'outbox, jamais par un identifiant recalculé (elle peut venir d'un écran de saisie).
5. **Règle pour les gestionnaires du serveur** : une commande de création qui arrive sous un autre `command_id` avec un
   `aggregate_id` déjà écrit doit être **reconnue** (`APPLIED`, rien refait), jamais échouer sur la clé primaire — une
   écriture qui échoue est renvoyée sans fin par l'appareil (S-30, S-31). Les gestionnaires de catégorie, produit,
   fournisseur, client, vente, commande, encaissement, dépense, remise de fonds et réception le faisaient ; l'essai de
   rechargement de PP-C a trouvé deux manques, corrigés : l'expédition directe d'un transfert (`TRANSFER_ID_TAKEN`) et la
   déclaration de perte (clé primaire). L'essai `pwa-paper-slip-commands.test.ts` garde les huit types de pièce.
6. **Une pièce papier est un fait accompli** (BR-SYN-007) : sa commande part « saisie hors ligne », avec l'heure de la
   pièce et son motif d'antidatage (celui du fichier, à défaut le motif commun saisi à l'écran), jamais refusée pour un état
   métier. Le bon de livraison (BL) vise une commande ligne par ligne : il reste un report pièce par pièce.

## Conséquences

- Pas de migration, pas de commande serveur nouvelle ; le serveur n'a changé que pour reconnaître un rejeu (point 5).
- Le chargement passe par l'outbox : il part par lots de 50 commandes, dans l'ordre, et s'arrête proprement hors ligne
  (les lignes partent à la reconnexion). Les refus du serveur reviennent avec leur motif, ligne par ligne.
- Les types sont des ajouts de 100 à 300 lignes (`entities.ts`, `slips.ts`) ; les règles de prix, les comptes de trésorerie
  et le stock d'ouverture restent à ajouter — le dernier exige d'abord la commande `inventory.opening.post`, absente côté
  serveur.
- **Limite connue** : un code pris par une donnée que l'appareil ne connaît pas (produit non vendable absent du jeu
  `product`) n'est vu que du serveur, qui le refuse (`CODE_EXISTS`) ; la ligne est listée au résultat.

## Alternatives écartées

- **Module serveur d'import avec tables d'attente** (AV-317 (a)) : plus de code, un second chemin d'écriture à auditer,
  des rapports à tenir côté serveur ; à reprendre si les volumes (plusieurs milliers de lignes par fichier) ou l'historique
  complet des pièces l'exigent.
- **Script d'administration** lancé par un développeur (comme `import-reporting-commercial.mjs`) : bon pour un premier
  chargement unique avec des données connues, pas pour un outil que les équipes répètent.
- **Identifiants aléatoires et détection des doublons par clé métier** : un rechargement après purge de l'outbox
  dupliquerait les pièces (le numéro de pièce répété est un avertissement hors ligne, jamais un refus).
