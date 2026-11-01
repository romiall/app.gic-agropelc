# Reprise du reporting commercial (classeur Excel du 08 au 31/10/2026)

Outil du kit : [`import-reporting-commercial.mjs`](import-reporting-commercial.mjs), avec sa logique pure [`reporting-import-mapping.mjs`](reporting-import-mapping.mjs) et son essai [`test-reporting-import-mapping.mjs`](test-reporting-import-mapping.mjs). Décisions et points ouverts : [AV-489](../../docs/A-VALIDER.md). Aucun fichier de ce dossier ne contient de donnée de personne ni de secret ; le classeur, l'extraction JSON et les rapports restent dans `import-reporting-commercial/` (exclu de git).

## 1. Ce que fait l'outil

Il charge dans la base de l'application le classeur « GIC Reporting Commercial v2.0 » rempli par le responsable commercial : **194 prospects**, **58 contacts** (19 visites sur place et 39 appels) et, dans un rapport, **14 journées**. Le classeur était censé refléter le schéma (feuille `Correspondances`) : **le schéma ne change pas**, ce sont les données qui sont adaptées.

| Étape | Auteur | Commande ou fonction | Date |
|---|---|---|---|
| Appareil de reprise (le pipeline exige un appareil actif, RC-02) | utilisateur système | insertion + audit `identity.device.approve` | maintenant |
| Zones : une racine `VILLE` (« Douala ») et une zone `QUARTIER` par quartier | administrateur | `organization.zone.create` | maintenant |
| Compte du responsable, mot de passe provisoire à changer à la première connexion | administrateur | `identity.user.create` | maintenant |
| Affectation `RESP_COMMERCIAL` / `ZONE` sur la racine (couvre les zones filles) | utilisateur système | écrivain de l'affectation de `identity` + audit + événement | **début d'usage : 08/10/2026** |
| Prospects | le responsable | `crm.customer.create` | date de création du classeur |
| Étapes du pipeline (36) | le responsable | `crm.customer.set_pipeline_step` | premier contact, sinon jour de création + 1 minute |
| Visites sur place (19) | le responsable | `crm.visit.record` | date et heure du contact |
| Appels (39) | le responsable | `crm.interaction.record` | date et heure du contact |

Garanties (**CONFIRMÉES** par l'essai local du 01/11/2026, voir § 5) :

- **Vraies commandes du pipeline** (transport `SYSTEM`, appareil de reprise) : règles métier, droits à la date du fait, journal d'audit chaîné, événements, flux de synchronisation de la PWA du responsable. Aucune table d'un module n'est écrite directement, sauf l'appareil de reprise (insertion directe, comme `apps/server/scripts/demo-data.ts`) et l'affectation de rôle (écrivain du module `identity`, comme `grant-test-access.mjs`), chacun avec sa ligne d'audit.
- **Faits accomplis datés** : `captured_offline` et `backdated_reason` (« Reprise Excel 31/10/2026 … ») sur chaque ligne ; `client_created_at` = `occurred_at` ; l'heure réelle de l'écriture est dans `received_at` et `applied_at`. Le serveur n'applique aucune fenêtre d'antidatage (AV-078 non codé).
- **Rejouable sans doublon** : identifiants UUIDv7 dérivés de la clé `RESCOM|N` (clients) et de la référence de ligne (contacts) ; une seconde exécution ne crée rien. Un rejet est définitif dans le journal des commandes : après correction, relancer avec `--run-salt r2`.
- **Rien ne disparaît, rien n'est fusionné** : les doublons sont importés, signalés par le mécanisme natif (conflit `DUPLICATE_CUSTOMER` ouvert, événement d'alerte), à fusionner par le responsable (BR-CRM-006, BR-CRM-007).
- **Sauvegarde obligatoire** de la base avant toute écriture (`mysqldump` ou `mariadb-dump` compressé dans `~/backups_db`) ; l'outil refuse d'écrire si elle échoue. `--no-backup` est réservé aux essais locaux.
- **Vérification ligne à ligne** après l'écriture (champ par champ pour chaque prospect, visite et appel ; décomptes ; journal des commandes ; audit ; copie des lignes source) ; code de sortie non nul au moindre écart.

## 2. Correspondance colonne par colonne

Chaque cellule est reprise quelque part : dans un champ de l'application, dans le **motif de reprise** de la ligne (`backdated_reason`, 500 caractères, visible en base), et dans la **ligne source complète** (toutes les cellules non vides avec leurs intitulés) jointe à la charge de la commande, donc conservée par le journal d'audit (`after.legacy`) et le journal des commandes. Le modèle client n'a ni note, ni produit d'intérêt, ni potentiel, ni mode de paiement : ces valeurs n'ont pas de champ propre et restent dans le motif et la ligne source (**décision du porteur : pas de modification du schéma à cause de cet import**).

### 2.1 Feuille `Clients` (23 colonnes) → `crm.customers`

| Col. | Intitulé du classeur | Cible | Traitement |
|---|---|---|---|
| A | N° | clé `RESCOM\|N` → identifiant du compte ; motif de reprise | des sauts dans la numérotation sont normaux |
| B | Code client | motif de reprise ; ligne source | le N° fait foi (un code est attribué deux fois) |
| C | Enseigne / nom du client | `display_name` | espaces repliés |
| D | Statut (automatique) | `stage` = `PROSPECT` | tout autre statut est une erreur bloquante |
| E | Type de client | `category_id`, `customer_type`, `business_activity` | voir § 3 ; le libellé d'origine reste dans `business_activity` |
| F | Interlocuteur | `contact_name` | **seulement** si ce n'est pas la valeur par défaut « Responssable » ; sinon ligne source |
| G | Téléphone principal | `phone_primary` | normalisé par le serveur en E.164 (+237) ; un numéro de 10 chiffres est importé tel que saisi et signalé |
| H | Téléphone 2 / WhatsApp | `phone_secondary` | vide dans ce classeur |
| I | Quartier / zone | `zone_id` | une zone `QUARTIER` par quartier sous « Douala » ; orthographes fusionnées ; « Autre » devient « Autre quartier » |
| J | Localisation précise / point de repère | `address_text` | « Quartier : … - Repère : … » |
| K, L | Latitude, Longitude | `lat`, `lng` | vides dans ce classeur |
| M | Source du prospect | `source_code` | `PROSPECTION_TERRAIN`, `RECOMMANDATION`, `RESEAU_SOCIAL`…, sinon `AUTRE` signalé |
| N | Étape du pipeline | `pipeline_step_id` + historique d'étape | création à `NOUVEAU`, puis `crm.customer.set_pipeline_step` (**DÉDUIT** : date du premier contact, sinon jour de création + 1 minute) |
| O | Date de création | `occurred_at` et `acquired_at` (00:00, heure de Douala) | prospects « repris de la fiche de septembre » : **08/10/2026** (début d'usage du responsable), date d'origine dans le motif |
| P, Q, R | Produit d'intérêt, potentiel par jour, unité | aucun champ | motif de reprise (« produit … 5 Kg/j ») + ligne source |
| S | Mode de paiement habituel | aucun champ | motif de reprise + ligne source |
| T | Paiement différé demandé ? | aucun champ (`credit_allowed` est une décision du responsable) | motif si « Oui » ; vide dans ce classeur |
| U, V | Compte perdu ?, motif de perte | `mark_lost` non géré | erreur bloquante si « Oui » ; vide dans ce classeur |
| W | Observations | motif de reprise (« obs. … ») | la mention de septembre n'est pas répétée ; ligne source |

### 2.2 Feuille `Visites_Contacts` (22 colonnes) → `crm.visits` et `crm.interactions`

| Col. | Intitulé | Cible | Traitement |
|---|---|---|---|
| A | N° | ligne source | |
| B | Réf. de la ligne | identifiant de la visite ou de l'appel (clé d'idempotence) ; motif | |
| C, D | Date, Heure | `occurred_at` (Douala, +01:00) | l'heure saisie est **approximative** : notée dans le motif |
| E | Type de contact | visite sur place → `crm.visit.record` ; appel téléphonique → `crm.interaction.record` canal `APPEL`, sortant ; « WhatsApp / message » → `SMS` ; autre → `AUTRE` signalé | |
| F | Client / prospect | `customer_id` | rapproché par la clé client (col. Q), jamais par le nom |
| G | Objet du contact | `notes` (visite) ou `summary` (appel) : « Objet : … » | |
| H | Résultat | visite : `outcome_reason_code_id` ; appel : texte « Résultat saisi : … » | « À relancer » → `A_RELANCER` ; « Absent / fermé » → `ABSENT` ; « Rendez-vous fixé » → `A_RELANCER` avec la mention dans les notes (aucun motif dédié) |
| I, J | Fournisseur ou concurrent, prix concurrent | notes ou résumé si renseignés | vides dans ce classeur |
| K, L | Prochaine action : date, à faire | `next_action_at`, `next_action_note` | |
| M, N | Latitude, Longitude | `lat`, `lng` d'une visite | vides : visite sans position |
| O | Notes | notes ou résumé | vide dans ce classeur |
| P | Commercial | auteur de la commande = le responsable | |
| Q à V | N° client, clé, code, nom, quartier, semaine | rapprochement ; ligne source | colonnes calculées |

Les 19 visites portent le drapeau `OUT_OF_SESSION` (aucune session de travail : informatif, jamais bloquant, BR-CRM-013).

### 2.3 Feuille `Journal` (22 colonnes) → **archive dans le rapport**

Le pointage de l'application (`fieldwork.work_sessions`) exige une position GPS ou une dérogation approuvée (au moins 3 tentatives, politique `CHECKIN_OVERRIDE`) : créer 14 sessions sans position reviendrait à **inventer une preuve**. Les 14 journées (date, début, fin, zone, frais, compteurs calculés et commentaires) sont donc **archivées en entier dans le rapport** (`rapport.json`, `rapport.md`) et dans le classeur, **non écrites** dans les tables de pointage. Les frais (42 500 XAF) ne deviennent pas des dépenses de la Finance. Le pointage GPS démarre avec l'application. Les géorepères des zones créées sont vides : à poser avec l'écran d'organisation avant que le responsable prenne son service.

### 2.4 Feuille `Paramètres` et feuilles vides

| Élément | Traitement |
|---|---|
| Nom et prénom | `identity.users.full_name` (option `--manager-name`) |
| Fonction « Responsable commercial » | rôle `RESP_COMMERCIAL`, affectation `ZONE` sur « Douala » à partir du début d'usage |
| Zone principale (un quartier) | couverte par l'affectation sur la racine ; aucune zone « principale » dans le modèle |
| Téléphone | le schéma exige un téléphone E.164 **unique** sur chaque compte (`--manager-phone`, requis pour créer le compte) ; la connexion se fait par adresse e-mail |
| Responsable direct (« DG »), seuils d'alerte | aucun champ : non repris |
| Date de début d'usage (08/10/2026) | début de l'affectation du rôle (`--manager-start`) |
| `Commandes`, `Encaissements`, `Planning`, `Stock`, `Objectifs`, `Bilans_Hebdo`, `Équipe` | vides : rien à reprendre |

## 3. Valeurs par défaut déduites (à relire dans le rapport)

- **Types de client** : « Revendeur / détaillant de marché » et « Boutique / supérette / supermarché » → `REVENDEUR` ; « Restaurant », « Hôtel », « Traiteur / événementiel » → `RESTAURATION_HOTELLERIE` ; « Particulier / ménage » → `PARTICULIER` ; « Boulangerie / pâtisserie » et « Autre » → aucune catégorie. `customer_type` : `ENTREPRISE` pour les types d'entreprise, `PARTICULIER` pour « Particulier / ménage », valeur par défaut du modèle pour « Autre ».
- **Prospects de septembre** (26) : acquis le jour du début d'usage ; l'acquéreur d'un compte est immuable (INV-CRM-01), d'où ce choix explicite.
- **Étapes sans contact** : 33 prospects sont au-delà de « Nouveau » sans contact saisi (étape posée à la main dans le classeur) ; la date du passage est inventée par nécessité, signalée dans le motif.
- **Doublons** : même téléphone (2 paires) → le plus récent est rattaché au premier par le serveur, conflit ouvert ; même nom (3 groupes, téléphones différents) et code attribué deux fois (le N° 27 garde la clé `RESCOM|27`) → importés tels quels.

## 4. Mode d'emploi

### 4.1 Essai local sur une base neuve (jamais la base partagée des essais)

Créer une base neuve (`dbmate --no-dump-schema up` sur `DATABASE_URL` d'une base vide, `db:seed`, `db:create-local-admin`), puis, depuis `apps/server` (PowerShell) :

```powershell
$env:SERVER_DATABASE_URL = '<url de la base neuve>'
$env:RESCOM_INITIAL_PASSWORD = '<mot de passe jetable>'
node --import tsx ..\..\deploy\hostinger\import-reporting-commercial.mjs --data <donnees_extraites.json> --dry-run --app-dir . --code-dir src --admin <telephone de l'admin local> --manager-email <e-mail> --manager-name "<nom>" --manager-phone <+237...> --expect-clients 194 --expect-contacts 58 --expect-journal 14
```

`--dry-run --offline` contrôle les données sans base ; `--dry-run` lit la base (rien n'est écrit) ; `--apply --no-backup --yes` écrit ; `--verify-only` ne fait que vérifier. `node deploy/hostinger/test-reporting-import-mapping.mjs` essaie la correspondance sur des données synthétiques.

### 4.2 En ligne (chaque étape exige l'autorisation explicite du porteur)

L'outil se lance depuis `~/import-reporting/` avec Node 22 ; `--env-file` et `--app-dir` désignent l'application par des chemins absolus (aucun `cd`). Le mot de passe provisoire n'est jamais écrit : l'outil le demande en saisie masquée dans un terminal (`ssh -t`, fenêtre PowerShell ordinaire, pas l'ISE) ; la variable `RESCOM_INITIAL_PASSWORD` du processus reste possible sans terminal.

1. Envoyer dans `~/import-reporting/` (dossier privé, droits 700, fichiers 600) les trois fichiers `.mjs` (`import-reporting-commercial`, `reporting-import-mapping`, `mariadb-compat`) et `donnees_extraites.json` (`scp`) ; vérifier les empreintes (`sha256sum`).
2. **Essai à blanc** (`--dry-run`) : lit la base sans rien écrire et contrôle les décomptes, les référentiels, les droits de l'administrateur, le compte et son téléphone, les zones et clients déjà présents, la **lecture des réglages JSON** (fonction `normalizePhoneAt` du serveur) et la **sauvegarde** (lecture réelle d'une table avec `mysqldump`, mêmes options et mêmes identifiants que la sauvegarde, sortie jetée) ; relire le rapport.
3. **Écriture** (`--apply`, avec `ssh -t`) : confirmation `OUI`, **sauvegarde de la base** (refus d'écrire si elle échoue), mot de passe masqué, appareil de reprise, zones, compte, affectation, commandes, vérification ligne à ligne ; code de sortie non nul au moindre écart.
4. Récupérer le rapport (`scp -r`), puis **supprimer `~/import-reporting/`** (données de personnes) ; garder la sauvegarde de `~/backups_db`.
5. Dans l'application : poser le mot de passe provisoire voulu avec « Réinitialiser le mot de passe » si besoin, approuver l'appareil du responsable après sa première connexion (`approve-device.mjs`), **retirer l'appareil « Reprise de données » dans l'écran Appareils**.

### 4.3 Reprise après un arrêt

Relancer la même commande : les identifiants sont déterministes, ce qui existe est retrouvé et la vérification porte sur l'ensemble. Une commande **refusée** (`REJECTED`) est définitive dans le journal des commandes : après avoir corrigé la cause, relancer avec `--run-salt r2` (nouveaux identifiants de commande, mêmes identifiants de comptes). Une erreur transitoire (`RETRY_LATER`) est réessayée trois fois, puis l'outil s'arrête après trois refus de suite. `--verify-only` ne fait que comparer la base au classeur.

## 5. Essais du 01/11/2026

**Base locale MySQL 8.4 neuve** : applications, rejeu et sauvegarde passés : 24 zones, compte et affectation, 194 prospects (tous champs concordants), 2 doublons de téléphone signalés par le serveur (conflits ouverts), 230 lignes d'historique d'étape, 19 visites, 39 appels, 288 commandes `APPLIED` (2 avec avertissement de doublon), 288 lignes d'audit, 194 lignes source conservées dans l'audit ; **aucune commande refusée**, rejeu sans aucune création. Contrôle SQL indépendant : un seul titulaire, 194 affectations ouvertes, 230 changements `customers` et 58 `crm_activity` pour la synchronisation de la PWA.

**Essai à blanc en ligne** (lecture seule, 23 h 06 UTC, base MariaDB 11.8.9 de l'hébergement) : mêmes décomptes que l'essai local (24 zones, 194 prospects, 36 changements d'étape, 19 visites, 39 appels, 288 commandes préparées ; 0 erreur, 7 avertissements, 51 informations) ; compte, zones, clients et appareil de reprise à créer ; **lecture des réglages JSON conforme** ; **sauvegarde prouvée** avec les identifiants de `DATABASE_URL`. Rien n'a été écrit en base ; le dossier `~/import-reporting/` a été supprimé après la récupération du rapport.

## 6. Limites et risques connus

- **Première écriture CRM sur MariaDB 11.8** : l'écriture a été essayée sur MySQL 8.4 (288 commandes, 0 refus) ; sur MariaDB, l'essai à blanc a prouvé les lectures, les réglages JSON et la sauvegarde, mais aucune commande du CRM n'y avait encore été écrite (AV-485). La couche de compatibilité est installée automatiquement si le serveur est MariaDB. Une erreur SQL propre à MariaDB ferait échouer proprement une commande (transaction annulée, jamais d'écriture partielle) ; l'outil s'arrête après trois refus de suite, la sauvegarde est faite, la relance est sans danger.
- **AV-078** : si la fenêtre d'antidatage (72 h) est codée plus tard, l'importer avant, ou exempter le transport `SYSTEM`.
- **Alertes** : les événements écrits alimentent les détecteurs du serveur (doublons suspectés, relances échues, prospects non contactés…) : des alertes apparaîtront à la Direction et au responsable, c'est le comportement voulu.
- **Équipe** : l'affectation est de type `ZONE`. Les jeux hors ligne de l'équipe exigent une affectation `TEAM` et une équipe, à créer avec l'écran d'organisation (RP-1).
- **Données du classeur** : vérité des visites et des prospects non vérifiable (aucun GPS) ; la ligne source est gardée telle quelle.

## 7. Journal des opérations en ligne

| Date | Opération | Résultat |
|---|---|---|
| 01/11/2026 (23 h 06 UTC) | Essai à blanc en ligne (lecture seule) avec l'outil du commit `8e3fb5e` ; dossier privé `~/import-reporting/` créé puis supprimé | conforme : 288 commandes préparées, 0 erreur de données ; aucune écriture en base |
| — | Écriture (sauvegarde `~/backups_db/gic-avant-reprise-reporting-<horodatage>.sql.gz`) | à venir, sur autorisation du porteur |
