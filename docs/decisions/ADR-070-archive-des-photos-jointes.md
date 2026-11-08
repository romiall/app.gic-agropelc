# ADR-070 — Archive des photos jointes : volumes fabriqués en flux, vidage vérifié, tracé et jamais destructeur des lignes

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; applique la demande dictée du porteur le 08/11/2026 : questionnaire de clôture Q10, [AV-539](../A-VALIDER.md) ; défauts à confirmer : AV-545 à AV-549)
- **Date** : 08/11/2026
- **Précise** : [ADR-046](ADR-046-pieces-jointes-du-pilote.md) (pièces jointes du pilote, stockage sur le disque du serveur), [ADR-006](ADR-006-annulation-vs-suppression.md) (rien ne disparaît), [ADR-024](ADR-024-hebergement-hostinger.md) (hébergement mutualisé)
- **Questions liées** : AV-539, AV-292, AV-091, AV-074, AV-545 à AV-549

## Contexte

Les photos jointes aux opérations (bons de livraison des réceptions, mortalités et pertes, justificatifs de dépense, factures fournisseur) sont rangées par le serveur sur son disque, **hors base et hors sauvegardes** (ADR-046, AV-292). Le registre en attend environ 30 Go la première année (AV-074 les conserve 5 ans) ; la taille réelle en ligne n'est pas connue (à relever, AV-549). L'espace de l'hébergement mutualisé est limité ; le porteur a décidé le 08/11/2026 (Q10) de **télécharger les photos par période, rangées par type d'opération, de les garder dans le stockage interne de l'entreprise, puis de vider l'espace du serveur** ; les photos de moins de 30 jours restent toujours sur le serveur.

Contraintes qui pèsent sur la conception :

- l'hébergement n'a qu'un processus Passenger, une durée de requête et une mémoire bornées (non mesurées, [`deploy/hostinger/README.md`](../../deploy/hostinger/README.md)) : aucune archive de plusieurs Go ne peut être fabriquée en une requête ni chargée en mémoire ;
- **rien ne disparaît sans trace** (ADR-006, INV-GLO-03 : `attachments_attachments` interdit l'effacement d'une ligne par déclencheur ; le journal d'audit est en ajout seul) ;
- une dépendance nouvelle exige l'accord du porteur ;
- ce n'est pas un fait métier saisi hors ligne : les gestes d'archivage et de vidage n'ont de sens qu'en ligne et ne se rejouent pas ; comme la création d'un compte et la réinitialisation d'un mot de passe ([ADR-045](ADR-045-mots-de-passe-hors-journal-et-charge-sans-secret.md)), ils sont des **actions d'exploitation en ligne de l'Admin**, hors du journal des commandes de synchronisation (règle 3 du `CLAUDE.md` : « tout fait métier »), mais jugées, auditées et idempotentes.

## Décision

### 1. Principe : l'archive copie, le vidage supprime des octets, jamais des lignes

Une pièce archivée **reste `AVAILABLE`** et sa ligne de `attachments_attachments` n'est pas touchée : tous les contrôles de « photo présente » (BR-APP-014, validation d'une mortalité, signal de photo manquante) continuent de juger la pièce reçue. Ce qui change est la **trace d'archivage**, tenue par trois tables du module `attachments` (écrites par lui seul, aucun `DELETE`, déclencheurs d'immuabilité) : `attachments_archives` (le plan d'une période), `attachments_archive_volumes` (un fichier ZIP) et `attachments_archive_items` (une photo : référence, chemin dans l'archive, empreinte, taille, date de soumission, état `PLANNED`, `PURGED` ou `RELEASED`). Ce qui est supprimé du disque est le fichier, après un téléchargement complet et une confirmation (§7 et 8) ; la lecture d'une pièce vidée rend `410 ATTACHMENT_ARCHIVED` avec la date, le nom du volume et le chemin dans l'archive (§9), jamais une image cassée.

### 2. Ce qui peut être archivé

Une pièce est archivable si, **au moment de la préparation et de nouveau au moment du vidage** :

1. elle est `AVAILABLE`, son fichier est sur le disque à la taille enregistrée, et elle n'a pas déjà été archivée (un élément `PLANNED` ou `PURGED` la couvre déjà ; `RELEASED` la libère) ;
2. elle a été **reçue il y a plus de `attachments.archive.min_age_days`** (30 par défaut). Le jour de réception est celui du serveur (`received_at`, à défaut `created_at`) : jamais l'horloge de l'appareil. **Plancher de 30 jours en code** (`ARCHIVE_MIN_AGE_FLOOR_DAYS`), que le réglage ne peut qu'augmenter : la règle « moins de 30 jours reste toujours » est un invariant, pas un défaut (le catalogue des paramètres refuse moins de 30) ;
3. elle est dans la période choisie (un mois ou un trimestre du calendrier, fuseau `Africa/Douala`, sur le jour de réception) ;
4. **l'opération qui la porte est fermée** : aucune demande de validation `PENDING` sur son document, et un état terminal du document selon son module (liste en AV-546) :

   | Propriétaire | Fermé | Ouvert (la photo reste) |
   |---|---|---|
   | `GOODS_RECEIPT` | `POSTED`, `REJECTED`, `CANCELLED` | `POSTED_PENDING_REVIEW`, `REVIEW_REJECTED`, `QUARANTINED`, `CANCELLATION_PENDING` |
   | `STOCK_LOSS` | `RECORDED`, `APPROVED`, `REJECTED_UNJUSTIFIED`, `CANCELLED` | `PENDING_APPROVAL`, `REJECTED_RETURNED`, `CANCELLATION_PENDING` |
   | `EXPENSE` | `PAID`, `REJECTED`, `PAID_REJECTED`, `CANCELLED` | `RECORDED`, `PENDING_APPROVAL`, `APPROVED`, `PAID_PENDING_APPROVAL` |
   | `SUPPLIER_INVOICE` | `PAID`, `CANCELLED` | `MISMATCH`, `DISPUTED`, `APPROVED`, `PARTIALLY_PAID` |

   Chaque module propriétaire expose ces faits par une fonction de son API publique (`archiveFactsOfReceipts`, `archiveFactsOfLosses`, `archiveFactsOfExpenses`, `archiveFactsOfSupplierInvoices` : numéro du document, référence secondaire, catégorie, fermé ou non) ; `approvals` expose les sujets avec une demande `PENDING`. La composition se fait dans la couche de transport (`attachments-api/`), comme `attachment-access.ts` : le module `attachments` (N2) n'importe aucun module qui lui est supérieur.

La catégorie de dossier suit le document : `RECEPTION`, `MORTALITE` (perte de catégorie `MORTALITE`), `PERTE` (les autres pertes), `DEPENSE`, `FACTURE_FOURNISSEUR`.

### 3. Un plan figé, un seul plan vivant par période

`POST /api/v1/attachment-archives` (`{ granularity, periodStart }`) calcule l'ensemble archivable **une fois**, l'enregistre (archive, volumes, éléments, dans une transaction, par lots de 500 lignes) et rend le plan. Le téléchargement et le vidage s'appliquent à cet ensemble figé, même si d'autres pièces deviennent archivables entre-temps. Une clé unique générée (`live_key`, comme `active_pending_key` des validations) interdit deux plans `READY` pour la même période ; un plan s'annule tant que rien n'a été vidé (`CANCELLED` : ses éléments sont libérés). Un plan est limité à 50 000 pièces (borne de mémoire de la préparation ; un reste se prépare en second plan, la période réapparaissant au catalogue). Les photos écartées sont **comptées et expliquées** au résultat : gardées car l'opération est ouverte, absentes du disque.

### 4. Des volumes bornés, fabriqués en flux

Un **volume** est un fichier ZIP qui ne porte que les photos d'**un mois et d'une catégorie**, d'au plus `attachments.archive.volume_max_mb` Mo de photos (512 par défaut) et 10 000 photos ; un mois et une catégorie plus gros donnent plusieurs parties (`_p02`…). Nom : `GIC-photos_<AAAA-MM>_<CATÉGORIE>_<AAAAMMJJ du plan>[_pNN].zip` (la date du plan évite d'écraser, dans le dossier de l'entreprise, le volume d'un second plan de la même période). Un trimestre est donc trois mois de volumes.

**Pourquoi ces bornes** : une requête (un volume) dure quelques dizaines de secondes à quelques minutes selon le débit ; une coupure ne perd qu'un volume, qu'on retélécharge ; aucun volume n'atteint les 4 Gio ni les 65 535 entrées du ZIP classique, donc **pas de ZIP64** ; la mémoire du processus ne dépend pas de la taille du volume.

**Écriture sans dépendance** (`apps/server/src/platform/zip/stored-zip-writer.ts`, ~150 lignes) : ZIP **« stocké »** (méthode 0, sans compression : des JPEG déjà recodés ne se compressent pas, et le processeur de l'hébergement reste libre), un générateur asynchrone qui lit chaque photo par blocs de 64 Kio, **descripteurs de données** (bit 3 : le CRC-32 est calculé au passage, `zlib.crc32` s'il existe, sinon une table), noms en UTF-8. La **longueur totale est calculée d'avance** (tailles enregistrées en base, vérifiées par `stat` à la préparation et au téléchargement) : l'en-tête `Content-Length` est exact, le navigateur affiche l'avancement et reconnaît un téléchargement tronqué. Le volume contient `<CATÉGORIE>/<AAAA-MM>/<fichiers>`, `MANIFESTE.csv` (une ligne par photo : chemin, catégorie, référence, référence secondaire, date de soumission, date de prise de vue, nature, type, taille, SHA-256, identifiants de la pièce et du document ; séparateur `;`, BOM UTF-8, Excel français) et `LISEZMOI.txt` (structure, conservation 5 ans, comment vérifier l'empreinte). Le commentaire du ZIP porte l'identifiant du plan et le rang du volume.

### 5. Noms des dossiers et des fichiers

`<CATÉGORIE>/<AAAA-MM>/<NUMÉRO>[_<RÉFÉRENCE SECONDAIRE>]_<AAAAMMJJ-HHMMSS>_<8 DERNIERS CARACTÈRES DE L'IDENTIFIANT>.<jpg|webp|pdf>`

- **NUMÉRO** : le numéro du document dans le système (`doc_number` : réception, perte ou mortalité, dépense, facture) ; **référence secondaire** : la pièce papier de l'appareil (`local_ref`), le bon de livraison du fournisseur ou le numéro de facture du fournisseur. Retrouver « toutes les images d'une référence » est alors une recherche de texte dans le dossier de l'entreprise, sur l'une ou l'autre.
- **Date et heure** : la **soumission**, c'est-à-dire la réception de la pièce par le serveur, en heure de Douala (AV-548) ; la date de prise de vue reste dans le manifeste.
- **Sûreté** : chaque élément est réduit à `[A-Za-z0-9._-]` (le reste devient `-`, les séparateurs sont fusionnés, début et fin nettoyés, 40 caractères au plus), si bien qu'aucun nom ne contient `/`, `\`, `..`, un caractère interdit de Windows, ni un premier caractère interprété comme une formule par un tableur ; le chemin est construit par le serveur, jamais lu d'un champ libre ; un doublon éventuel reçoit `-2`, `-3`. Les noms sont **déterministes** : le même plan redonne les mêmes octets.

### 6. Téléchargement : un billet court, un volume par requête

Le navigateur télécharge le mieux un fichier de plusieurs centaines de Mo par un lien (reprise, avancement, disque), pas par une lecture en mémoire ; mais un lien ne porte pas l'en-tête `Authorization`. L'application demande donc, authentifiée, `POST …/archives/{id}/volumes/{volumeId}/ticket` et reçoit un **billet** : JWT ES256 signé par la clé des jetons d'accès, de nature distincte (`typ: attachment-archive-download`, sans `sub`, `device_id` ni `session_id` : il n'est jamais accepté comme jeton d'accès), valable 10 minutes, qui désigne le volume, l'utilisateur, l'appareil et la session. Le billet voyage en **paramètre de requête** : le routeur de Fastify borne un paramètre de chemin à 100 caractères, un JWT en compte plus de 300 ; le serveur ne journalise jamais la partie après `?` (`refusalLogEntry`). `GET /api/v1/attachment-archives/download?ticket={billet}` (route `@Public()` au sens de NFR-24 : authentifiée par le billet) **revérifie à chaque appel** la signature, l'échéance, la session vivante, le compte actif, l'appareil en service et le droit `attachments.archive.export` ; un refus est audité.

Le flux : `Content-Type: application/zip`, `Content-Length` exact, `Content-Disposition: attachment`, `Cache-Control: private, no-store`, `Accept-Ranges: none` (la reprise partielle n'est pas faite). **Un seul téléchargement de volume à la fois** dans le processus (`429 ARCHIVE_BUSY` sinon) : protège la mémoire, le disque et les autres utilisateurs ; un garde-fou d'une heure rend la place d'un téléchargement qui ne se règle jamais. Pendant l'écriture, **chaque photo est vérifiée** contre l'empreinte et la taille enregistrées (une photo corrompue ou absente interrompt la réponse : la connexion est coupée, le navigateur signale un échec, le volume n'est jamais compté livré) et l'empreinte SHA-256 des octets réellement envoyés est calculée.

### 7. Quand une archive est-elle « téléchargée en entier »

Un volume est **livré** quand le serveur a écrit la réponse entière (longueur exacte, vérifications de chaque photo réussies, flux terminé sans coupure) ; il enregistre alors, en une transaction, `zip_sha256` (la même à chaque livraison : un écart déclenche une anomalie auditée), le nombre de livraisons, l'acteur et l'heure, et une ligne d'audit `attachments.archive.volume_downloaded`. Une réponse interrompue est auditée `attachments.archive.volume_download_aborted` (octets envoyés) et ne compte pas.

La somme de contrôle est **fournie avec l'archive** : affichée à l'écran (avec la commande `Get-FileHash` de Windows), écrite dans le plan. L'Admin peut en outre **vérifier le fichier rangé dans le stockage de l'entreprise** : l'écran calcule l'empreinte du fichier choisi, sur l'appareil (SHA-256 incrémental sans dépendance, rien n'est envoyé hormis l'empreinte), et `POST …/volumes/{volumeId}/verify` la compare à celle du serveur (`verified_at` ; `409 ARCHIVE_HASH_MISMATCH` si elle diffère). La vérification est **recommandée, non exigée** (AV-547) : le vidage compte et audite les volumes vérifiés.

### 8. Le vidage

`POST …/archives/{id}/purge` (`{ confirm: true, volumeIds? }`, droit `attachments.archive.purge`) est **refusé** (`409 ARCHIVE_NOT_DOWNLOADED`, la liste des volumes manquants en détail) tant qu'un des volumes visés n'est pas livré en entier ; sans `volumeIds`, il vise tous les volumes du plan. Par volume, par lots de 500 pièces, **dans une transaction qui verrouille la ligne du volume** (deux vidages ne se croisent pas), pour chaque élément encore `PLANNED` :

1. la pièce est relue : toujours `AVAILABLE`, même empreinte et même taille, plus ancienne que le seuil, opération **toujours fermée** (§2.4) ; sinon l'élément est `RELEASED` (motif `OPEN_OPERATION` ou `CHANGED`), la photo reste et pourra être archivée plus tard ;
2. le fichier est supprimé du stockage (`ChunkStorage.delete`, sans effet s'il est déjà absent) ;
3. l'élément passe à `PURGED` (date, acteur).

Le serveur ne supprime donc que ce qu'il a livré **et** revérifié. Le volume est `resolved_at` quand tous ses éléments sont résolus ; le plan passe `COMPLETED` quand tous ses volumes le sont. La requête **rend la main au bout de 20 secondes** (durée de requête bornée) en disant combien de photos restent prévues (`result.remaining`) : l'écran rappelle le vidage tant qu'il en reste. Le vidage est **rejouable** (un élément résolu n'est plus touché) et le résultat compte : vidées, libérées (avec motif), octets rendus. Une ligne d'audit `attachments.archive.purged` (acteur, appareil, période, volumes, nombre, octets, volumes vérifiés) est écrite par volume, dans la même transaction que le changement d'état. Ordre choisi : fichier supprimé **avant** l'écriture de l'état ; une coupure entre les deux laisse un élément `PLANNED` sans fichier, que la reprise du vidage résout (la lecture d'une pièce dont le fichier manque et qui a un élément d'archive rend aussi `410`).

### 9. Lecture après vidage

`GET /api/v1/attachments/{id}/content` contrôle d'abord la portée comme avant, puis, si la pièce a un élément `PURGED` (ou si son fichier manque et qu'elle a un élément d'archive), répond **`410 ATTACHMENT_ARCHIVED`** avec `archived_at`, `reference`, `volume_file_name` et `entry_path`. La PWA classe ce cas (`ARCHIVED`) et dit « Photo archivée le … : elle n'est plus sur le serveur ; cherchez-la dans l'archive de l'entreprise (référence …) » au lieu d'une image cassée. Le statut `upload_status` n'est pas modifié : les appareils n'ont rien à resynchroniser.

### 10. Droits, paramètres, audit

- **Droits** (Admin seulement, portée `ALL`) : `attachments.archive.export` (voir le catalogue, préparer, télécharger, vérifier, annuler) et `attachments.archive.purge` (vider). Deux droits pour pouvoir séparer plus tard le téléchargement du vidage ; le marquage « sensible » attend AV-092. Chaque route déclare `@RequiresPermission` et revérifie le droit (refus audité).
- **Paramètres** (`organization.system_settings`, historisés) : `attachments.archive.min_age_days` (30, plancher 30), `attachments.archive.volume_max_mb` (512), `attachments.archive.default_granularity` (`QUARTER` : la période proposée à l'écran, le mois restant possible), `attachments.archive.retention_years` (5 : durée de conservation de l'archive gardée par l'entreprise, rappelée à l'écran et dans `LISEZMOI.txt`, AV-074).
- **Audit** (entité `ATTACHMENT_ARCHIVE`) : `attachments.archive.created`, `.volume_downloaded`, `.volume_download_aborted`, `.volume_verified`, `.purged`, `.cancelled`, plus les refus. Chaque ligne porte l'acteur, l'appareil, la période, les nombres et les octets.

### 11. Écran

Un onglet « Archive des photos » dans **Paramètres** (visible du seul rôle `ADMIN`) : choix mois ou trimestre, liste des périodes avec ce qui est sur le serveur, ce qui est archivable et ce qui est gardé (moins de 30 jours) ; « Préparer l'archive » ; la liste des volumes avec « Télécharger » (un à un ou « Tout télécharger », qui enchaîne les volumes un à un en attendant la fin de chacun) et « Vérifier un fichier » ; puis **« Vider l'espace »**, désactivé tant que tous les volumes ne sont pas livrés, avec une confirmation qui dit ce qui sera supprimé (nombre, taille) et ce qui reste, et qui exige de cocher « J'ai rangé ces fichiers dans le stockage de l'entreprise » ; le résultat affiche ce qui a été vidé, ce qui a été gardé et ce qui reste sur le serveur.

## Alternatives étudiées

- **Une archive unique de la période, fabriquée en une requête** : écartée (durée, mémoire, une coupure à 90 % recommence tout, aucune reprise).
- **Archive fabriquée en tâche de fond puis téléchargée** : écartée (elle doublerait l'espace occupé au moment où l'on veut en libérer ; Passenger ne garantit pas la survie d'un travail long ; le flux à la demande n'écrit rien sur le disque).
- **Bibliothèque ZIP (`archiver`, `yazl`)** : écartée sans l'accord du porteur ; le format stocké tient en 150 lignes et ses cas limites (descripteurs, longueur exacte) sont testés.
- **Compression `deflate`** : écartée (gain nul sur du JPEG, coût processeur sur un hébergement partagé).
- **Jeton `Authorization` et lecture en mémoire du fichier par le navigateur** : écarté (plusieurs centaines de Mo en mémoire du navigateur, aucune reprise) ; le billet court suit le patron de l'URL signée prévue par `02-securite` §6.
- **Nouveau statut `ARCHIVED` de `upload_status`** : écarté (il fausserait chaque contrôle de « photo présente » : validations, signaux de photo manquante, tableaux) ; une table de trace laisse la pièce reçue et dit où elle est.
- **Supprimer les lignes** : interdit (ADR-006, INV-GLO-03).
- **Stockage objet** (AV-091, option D de Q10) : non retenu ici (coût, compte externe) ; l'archive reste compatible : ce lot ne change que la façon de libérer le disque.
- **Une commande de synchronisation** pour l'archivage : écartée (en ligne seulement, rien à rejouer, effet sur le système de fichiers).

## Conséquences

- Trois tables et leurs déclencheurs (migration `20261206090000`), deux droits (132 permissions, 563 octrois), quatre paramètres, un type d'entité d'audit, quatre fonctions publiques de lecture des faits d'archivage dans `procurement`, `inventory` et `finance`, une dans `approvals`, une écriture ZIP réutilisable (`platform/zip/`), un onglet de l'écran des paramètres, un code d'erreur de lecture (`410 ATTACHMENT_ARCHIVED`).
- **Après le vidage, la seule copie des photos est l'archive de l'entreprise** : sa perte est la perte de la preuve. Le porteur doit garder **au moins deux copies** (AV-549) ; le serveur n'y peut rien. Les sauvegardes de la base contiennent la trace (référence, empreinte, chemin dans l'archive), pas les octets.
- La copie quotidienne des photos vers le poste du porteur (option B de Q10, non livrée à ce jour) reste compatible mais ne doit pas rejouer ses suppressions sur la copie.
- Un document ouvert pour toujours (dépense jamais payée, facture jamais soldée) garde sa photo sur le serveur : l'écran le compte (« gardées : opération ouverte »).
- `GET /health/ready` et l'ordonnanceur ne sont pas touchés ; aucune tâche récurrente n'est ajoutée (l'archivage est un geste de l'Admin).

## Risques

- **Le serveur n'observe que ce qu'il a envoyé** : un mandataire qui garde la réponse en mémoire peut faire croire à une livraison complète. Parades : la vérification d'empreinte du fichier rangé, la confirmation explicite de l'Admin, le plafond du volume. À essayer en ligne avec un petit mois d'abord (le débit et la durée de requête de l'hébergement n'ont pas été mesurés).
- **Disque insuffisant pour le téléchargement** : sans objet côté serveur (rien n'est écrit), côté poste de l'Admin seulement.
- **Course** entre un vidage et une photo d'une opération qui se rouvre : l'état est relu dans la transaction du vidage, sous le verrou du volume ; une opération qui se rouvre sans passer par un état « ouvert » de la liste n'est pas détectée (AV-546).
- **Billet dans l'adresse** : le journal d'accès de l'hébergement peut garder l'adresse du téléchargement, billet compris. Il ne vaut que 10 minutes, ne donne accès qu'à un volume, et le serveur revérifie la session, le compte, l'appareil et le droit à chaque appel ; un billet récupéré dans un journal est donc inerte une fois la session fermée ou l'échéance passée.
- **Horloge** : l'âge se juge sur l'horloge du serveur (`CLOCK`), pas sur l'appareil.
- **Taille de l'ensemble** : 50 000 pièces par plan, 10 000 par volume ; au-delà, plusieurs plans successifs.
