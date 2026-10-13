# D01 — Core / Administration (ADM)

> Couvre : identité et accès, organisation (sites, emplacements, zones, équipes, points de vente), appareils, paramètres, politiques de contrôle et validations, pièces justificatives.
> Modules de code : `identity`, `organization`, `approvals`, `attachments` (voir [`../../05-architecture/02-modules.md`](../../05-architecture/02-modules.md)).

---

## 1. Objectif

Fournir le socle commun à tous les domaines :

- **qui** agit (utilisateurs, rôles, permissions à portée) ;
- **depuis quoi** (appareils autorisés) ;
- **où** (sites, emplacements, zones) ;
- **sous quel contrôle** (politiques proportionnées au risque, validations) ;
- **avec quelle preuve** (pièces justificatives).

Sources : CM §5.3, §42, §47, §48, §57/Core ; PM §17, §37.

## 2. Acteurs

`ADMIN` (configuration), `DIRECTION` (seuils, validations), tous les responsables (validations dans leur périmètre), tous les utilisateurs (connexion, pièces justificatives), acteur système `system` (clôtures automatiques).

## 3. Principales entités

| Entité | Table | Rôle |
|---|---|---|
| Utilisateur | `identity.users` | Compte nominatif |
| Rôle, permission, rôle-permission | `identity.roles`, `identity.permissions`, `identity.role_permissions` | Catalogue RBAC |
| Affectation de rôle | `identity.user_role_assignments` | Rôle × périmètre × période |
| Appareil | `identity.devices` | Terminal enrôlé |
| Session d'authentification | `identity.auth_sessions` | Jetons, révocation, autonomie hors ligne |
| Site, point de vente | `organization.sites`, `organization.points_of_sale` | Lieux d'activité |
| Emplacement | `organization.locations` | Lieu de stock (physique ou virtuel) |
| Zone | `organization.zones` | Hiérarchie géographique et commerciale, géorepère |
| Équipe, appartenance | `organization.teams`, `organization.team_memberships` | Périmètre `TEAM` |
| Paramètre système | `organization.system_settings` | Valeurs de configuration historisées |
| Politique de contrôle | `approvals.control_policies` | Seuils photo, justification, validation |
| Demande de validation | `approvals.approval_requests` | Validation tracée |
| Pièce justificative | `attachments.attachments` | Fichier attaché |

## 4. Cas d'usage

| ID | Cas d'usage | Commande technique | Acteur | Hors ligne |
|---|---|---|---|---|
| UC-ADM-01 | Créer ou modifier un utilisateur | `identity.user.create`, `identity.user.update` | ADMIN | Non |
| UC-ADM-02 | Désactiver ou réactiver un utilisateur | `identity.user.deactivate`, `identity.user.reactivate` | ADMIN | Non |
| UC-ADM-03 | Affecter ou révoquer un rôle sur un périmètre | `identity.role_assignment.grant`, `identity.role_assignment.revoke` | ADMIN | Non |
| UC-ADM-04 | Configurer les permissions d'un rôle | `identity.role.set_permissions` | ADMIN | Non |
| UC-ADM-05 | Se connecter et enrôler un appareil | `identity.device.enroll` (via `/auth`) | Tous | Non |
| UC-ADM-06 | Lister les appareils de sa portée ; approuver, refuser (bloquer), débloquer, déclarer perdu ou retirer un appareil ; le déclarer partagé et le rattacher à un site (BR-DIS-003, AV-007) — écran ECR-ADM-05 (MP-06) | `GET /devices`, `identity.device.approve`, `identity.device.designate`, `identity.device.block`, `identity.device.unblock`, `identity.device.declare_lost`, `identity.device.retire` | ADMIN, responsable | Non |
| UC-ADM-07 | Déverrouiller l'application par PIN, changer d'utilisateur sur un appareil partagé | local (aucune commande) | Tous | **Oui** |
| UC-ADM-08 | Révoquer les sessions d'un utilisateur | `identity.session.revoke` | ADMIN | Non |
| UC-ADM-09 | Créer, modifier ou fermer un site ; configurer un point de vente | `organization.site.create`, `organization.site.update`, `organization.site.close`, `organization.pos.configure` | ADMIN | Non |
| UC-ADM-10 | Créer, modifier ou désactiver un emplacement ; créer un stock mobile pour un utilisateur | `organization.location.create`, `organization.location.update`, `organization.location.deactivate` | ADMIN | Non |
| UC-ADM-11 | Gérer les zones et leur géorepère | `organization.zone.create`, `organization.zone.update` | ADMIN | Non |
| UC-ADM-12 | Gérer les équipes et leurs membres | `organization.team.create`, `organization.team.set_members` | ADMIN, RESP_COMMERCIAL (lecture) | Non |
| UC-ADM-13 | Modifier un paramètre système | `organization.setting.set` | ADMIN (DIRECTION pour les seuils financiers) | Non |
| UC-ADM-14 | Définir une politique de contrôle | `approvals.policy.set` | DIRECTION, ADMIN | Non |
| UC-ADM-15 | Traiter la file de validation (approuver ou rejeter) | `approvals.request.approve`, `approvals.request.reject` | Responsables, DIRECTION, FINANCE | Non |
| UC-ADM-16 | Joindre une pièce justificative à une opération | `attachments.attachment.register` + upload | Tous | **Oui** (capture et file d'upload) |

## 5. Entrées

- Données de personnes : nom, téléphone, rôles, périmètres.
- Descriptions de sites, emplacements, zones (coordonnées GPS des géorepères) et équipes.
- Valeurs des paramètres et des seuils.
- Demandes de validation émises par les autres domaines.
- Fichiers capturés (photos, scans).

## 6. Sorties

- Droits effectifs d'un utilisateur à un instant donné, consommés par tous les modules.
- Liste des appareils autorisés.
- Référentiel d'organisation téléchargé sur les appareils.
- Décisions de validation, qui déclenchent les effets différés dans les domaines demandeurs.
- Pièces disponibles et empreintes.

## 7. Règles métier

| ID | Règle | Statut |
|---|---|---|
| BR-ADM-001 | L'identifiant de connexion est le numéro de téléphone normalisé au format E.164 (ex. `+2376XXXXXXXX`). Il est unique parmi les utilisateurs non désactivés définitivement. | AV-008 |
| BR-ADM-002 | Un utilisateur désactivé ne peut plus s'authentifier. Ses opérations hors ligne dont `occurred_at` est **antérieur** à la désactivation restent acceptées. Les opérations **postérieures** sont mises en quarantaine pour revue (conflit `USER_DEACTIVATED`). | D (CM §40 ; PM §30) |
| BR-ADM-003 | Une affectation de rôle a une date de début, une date de fin optionnelle et un périmètre (`GLOBAL`, `SITE`, `ZONE`, `TEAM`). La révoquer renseigne `revoked_at` sans supprimer la ligne. | C (PM §17) / D |
| BR-ADM-004 | Les droits d'une commande sont évalués **à la date `occurred_at`** : l'auteur devait détenir la permission et le périmètre à cet instant, et ni l'utilisateur ni l'appareil ne devaient être révoqués à cet instant. | D (offline, ADR-008) |
| BR-ADM-005 | Un appareil `PENDING` permet de se connecter mais pas de créer d'opérations. Seul un appareil `ACTIVE` peut pousser des commandes. Depuis P5-23 (AV-228), une commande d'un appareil encore `PENDING` n'est pas appliquée mais attend (`RETRY_LATER`, `DEVICE_PENDING`) : elle s'applique au renvoi qui suit l'approbation ; un appareil refusé avant toute approbation met toutes ses commandes en quarantaine. | AV-006 ; AV-228 |
| BR-ADM-006 | Un appareil `BLOCKED` ou `LOST` voit toutes ses sessions révoquées. Les commandes reçues de cet appareil après la date de blocage sont mises en quarantaine (conflit `DEVICE_REVOKED`) et jamais appliquées automatiquement. La période hors service reste une fenêtre de quarantaine après un déblocage ou un retrait (périodes closes consignées, P5-23). | D (PM §37) ; AV-212 |
| BR-ADM-007 | Chaque appareil reçoit un **code court** unique (4 caractères alphanumériques), utilisé dans les références locales des documents. Il est attribué à l'enrôlement, rendu par la connexion (`device_short_code`) et affiché par l'appareil en attente d'approbation, pour que l'utilisateur le communique à son responsable (MP-06) ; il n'a aucune valeur d'authentification. | D (ADR-002) |
| BR-ADM-008 | Un site a un type parmi `FERME`, `MAGASIN`, `POINT_DE_VENTE`, `BUREAU`. Un site fermé (`CLOSED`) n'accepte plus de nouvelles opérations ; son historique reste consultable. | C (CM §12, §22) / D |
| BR-ADM-009 | Tout emplacement physique appartient à exactement un site. Un emplacement de type `MOBILE` a exactement un détenteur (`custodian_user_id`) et le mode de garde `EXCLUSIVE_USER`. **Tout emplacement physique porte un mode de garde** (BR-STK-010) : celui demandé à la création, à défaut le défaut de son type (`MOBILE` : `EXCLUSIVE_USER` ; magasin, bâtiment, enclos, couveuse, abattoir, emplacement de vente : `SHARED`) ; l'emplacement de vente d'un PDV prend le mode de la configuration du PDV (BR-DIS-002) et un magasin peut être `EXCLUSIVE_DEVICE` (tablette désignée) ou `SHARED` avec quotas d'appareil (ADR-033, AV-163). | D (CM §23, §39) ; AV-163 |
| BR-ADM-010 | Les emplacements virtuels (`V_*`) sont créés par le système, uniques par type, et ne peuvent être ni modifiés ni désactivés. Les neuf types globaux, qui n'appartiennent à aucun site, sont créés au démarrage. **Exception** : l'emplacement « à livrer » `V_TO_DELIVER` est rattaché à un site et unique **par site** (un seul actif par site) ; le système le crée à la première confirmation sur le site (ADR-028 §1). Il reste virtuel, donc immuable et jamais désactivé. | D (ADR-003 ; ADR-028 §1) |
| BR-ADM-011 | Un emplacement ne peut être désactivé que si tous ses soldes sont nuls et qu'aucun transfert, réservation ou allocation n'y est en cours ; l'emplacement de vente (`POS`) d'un site dont la caisse de PDV a une session de caisse ouverte ne se désactive pas, et le site ne se ferme pas (`LOCATION_HAS_OPEN_CASH_SESSION`, garde `finance`, P5-12). | D (INV-STK-07) |
| BR-ADM-012 | Les zones forment un arbre sans cycle. Un géorepère est optionnel : point de référence + rayon, 500 m par défaut. | C (CM §10) / AV-003 |
| BR-ADM-013 | Modifier un géorepère n'affecte que les pointages futurs ; chaque tentative de pointage fige le géorepère utilisé. | C (PM §7) |
| BR-ADM-014 | Une équipe a un responsable. Un utilisateur appartient à au plus une équipe à une date donnée. Les appartenances sont historisées (début, fin). | D (CM §6, §48) |
| BR-ADM-015 | Un paramètre système est historisé : toute modification crée une nouvelle valeur datée, et l'ancienne reste consultable. | C (PM §7) |
| BR-ADM-016 | La politique de contrôle applicable est celle **en vigueur à `occurred_at`**. Sa version est figée sur l'opération et sur la demande de validation. | C (PM §7) / D |
| BR-ADM-017 | L'approbateur d'une demande est différent du demandeur. Exception : `DIRECTION`, avec le marqueur `SELF_APPROVED`. Une décision est définitive ; la revenir exige une nouvelle opération (contre-opération). | AV-010 |
| BR-ADM-018 | Approuver exige la permission d'approbation propre au type d'opération, sur un périmètre qui contient l'opération (ex. `inventory.loss.approve` portée `SITE` sur le site de la perte). | C (PM §31) |
| BR-ADM-019 | Une pièce justificative est immuable et identifiée par son empreinte SHA-256. La remplacer ajoute une nouvelle pièce ; l'ancienne est conservée et marquée remplacée. | C (CM §40) / D |
| BR-ADM-020 | Une opération dont la politique exige une photo peut être enregistrée hors ligne avec la photo stockée localement. Si l'opération exige aussi une validation, l'approbateur voit « justificatif en cours de transmission » et ne peut pas approuver avant la réception de la pièce. | D (ADR-012) |
| BR-ADM-021 | Le numéro officiel d'un document est attribué par le serveur selon le format `{TYPE}-{CODE_SITE}-{AAAA}-{seq6}`, avec un compteur par type, site et année. | AV-077 |
| BR-ADM-022 | La référence locale d'un document est attribuée par l'appareil : `{CODE_APPAREIL}-{seq}`, séquence strictement croissante par appareil. Elle est affichée tant que le numéro officiel n'est pas connu et reste consultable ensuite. | D (ADR-002) |
| BR-ADM-023 | L'autonomie hors ligne d'un appareil expire 7 jours après la dernière synchronisation réussie. L'application passe alors en lecture seule jusqu'à la prochaine synchronisation. | AV-009 |
| BR-ADM-024 | Le PIN local (6 chiffres) n'est jamais transmis au serveur. Après 5 échecs consécutifs, l'utilisateur doit se reconnecter en ligne avec son mot de passe. | D (sécurité) |
| BR-ADM-025 | **Portée d'un appareil** (lecture et décisions) : un décideur voit et décide un appareil si l'utilisateur qui l'a connecté relève de ses équipes, de ses sites ou de ses zones (affectations actives), ou si le site de rattachement de l'appareil relève de sa portée ; une portée `ALL` voit tout. Nul n'approuve ni ne débloque l'appareil qu'il a connecté, sauf l'Admin ; le site cible d'un rattachement est dans la portée de l'auteur. Le premier appareil d'administration d'une installation neuve est approuvé par une commande d'installation sur le serveur. | D (AV-247, AV-254, AV-258 à AV-261 ; MP-06) |

## 8. Validations (contrôles de saisie et serveur)

| Objet | Contrôle | Erreur |
|---|---|---|
| Utilisateur | Téléphone valide E.164 et unique ; au moins un rôle actif pour pouvoir se connecter | `USER_PHONE_INVALID`, `USER_PHONE_TAKEN`, `USER_NO_ROLE` |
| Affectation de rôle | Le périmètre est cohérent avec le rôle (ex. `VENDEUR_PDV` exige un site de type `POINT_DE_VENTE`) ; `valid_to` > `valid_from` | `ROLE_SCOPE_INVALID` |
| Emplacement `MOBILE` | Le détenteur est un utilisateur actif ; un seul emplacement `MOBILE` actif par utilisateur | `LOCATION_CUSTODIAN_INVALID` |
| Zone | Pas de cycle ; rayon entre 50 m et 5 000 m ; latitude et longitude valides | `ZONE_CYCLE`, `GEOFENCE_INVALID` |
| Politique de contrôle | Pas deux politiques actives identiques (même type d'opération, catégorie et période) | `POLICY_OVERLAP` |
| Validation | Demande à l'état `PENDING` ; approbateur autorisé et différent du demandeur ; pièces requises reçues | `APPROVAL_NOT_PENDING`, `APPROVER_NOT_ALLOWED`, `SELF_APPROVAL_FORBIDDEN`, `ATTACHMENT_MISSING` |
| Pièce justificative | Type MIME autorisé (`image/jpeg`, `image/webp`, `application/pdf`) ; taille ≤ 5 Mo après compression ; empreinte cohérente avec le contenu reçu | `ATTACHMENT_TYPE`, `ATTACHMENT_SIZE`, `ATTACHMENT_HASH_MISMATCH` |

## 9. Dépendances

- **Dépend de** : aucun domaine métier (socle).
- **Utilisé par** : tous les domaines. RBAC, sites et emplacements, validations et pièces justificatives sont appelés par CRM, VEN, STK, PRD, APP et FIN.

## 10. Événements produits

`UserCreated`, `UserUpdated`, `UserDeactivated`, `UserReactivated`, `RoleAssigned`, `RoleAssignmentRevoked`, `RolePermissionsChanged`, `DeviceEnrollmentRequested`, `DeviceApproved`, `DeviceBlocked`, `DeviceDeclaredLost`, `SessionRevoked`, `SiteCreated`, `SiteUpdated`, `SiteClosed`, `LocationCreated`, `LocationUpdated`, `LocationDeactivated`, `ZoneCreated`, `ZoneUpdated`, `TeamMembershipChanged`, `SystemSettingChanged`, `ControlPolicyChanged`, `ApprovalRequested`, `ApprovalGranted`, `ApprovalRejected`, `ApprovalCancelled`, `AttachmentRegistered`, `AttachmentUploaded`, `AttachmentUploadFailed`.

## 11. Événements consommés

| Événement | Producteur | Réaction |
|---|---|---|
| `StockLossDeclared`, `InventoryCountSubmitted`, `ExpenseRecorded`, `PurchaseRequestSubmitted`, `SaleCancellationRequested`, `PriceOverrideApplied`, `CheckInRejected`, `GoodsReceiptQuarantined`, `CashSessionClosed`, `StockTransferDiscrepancyDetected`, `PaymentFlaggedDuplicate` | Domaines demandeurs | Aucune réaction directe : ces domaines appellent l'API interne `approvals.requestApproval(...)` dans la même transaction. Ces événements servent aux notifications. |
| `UserDeactivated` | ADM | Révocation des sessions, fermeture des allocations de l'utilisateur (voir D05) |

## 12. Fonctionnement hors ligne

| Élément | Disponible hors ligne | Détail |
|---|---|---|
| Déverrouillage par PIN | Oui | Vérification locale par dérivation de clé ; 5 essais au maximum |
| Droits effectifs de l'utilisateur | Oui (copie) | Téléchargés à la connexion et à chaque synchronisation ; servent à l'UX seulement. Le serveur revalide toujours (BR-ADM-004). |
| Référentiel d'organisation du périmètre | Oui | Sites, emplacements, zones et géorepères du périmètre |
| Création ou modification d'utilisateurs, rôles, sites, zones | Non | Opérations d'administration en ligne uniquement |
| Validation d'une demande | Non | Exige l'état serveur à jour |
| Capture de pièces justificatives | Oui | Stockage local, upload différé et reprenable (ADR-012) |

## 13. Permissions

| Permission | Objet |
|---|---|
| `identity.user.read`, `identity.user.manage` | Utilisateurs |
| `identity.role.manage`, `identity.role_assignment.manage` | Rôles et affectations |
| `identity.device.read`, `identity.device.approve`, `identity.device.block` | Appareils |
| `identity.session.revoke` | Sessions |
| `org.structure.read`, `org.structure.manage` | Sites, emplacements, zones, équipes, PDV |
| `org.settings.manage` | Paramètres |
| `approvals.request.read`, `approvals.policy.manage` | File de validation, politiques |
| Permissions d'approbation spécifiques (`*.approve`) | Définies par chaque domaine |

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Utilisateur désactivé avec des opérations hors ligne en attente | BR-ADM-002. Les opérations antérieures sont appliquées, les postérieures mises en quarantaine ; alerte à l'Admin. |
| Appareil perdu avec des opérations non synchronisées | Les opérations sont perdues si l'appareil n'est jamais retrouvé. L'**écart de séquence** détecté (voir D14) signale le trou. Les stocks mobiles et les allocations du détenteur restent sous sa responsabilité jusqu'à inventaire. |
| Dernier administrateur désactivé | Refusé (`LAST_ADMIN`) : au moins un utilisateur `ADMIN` actif doit exister. |
| Validation demandée alors qu'aucun approbateur n'existe dans le périmètre | La demande est routée vers `DIRECTION` ; alerte « validation sans approbateur ». |
| Pièce justificative jamais reçue (upload échoué au-delà de 7 jours) | Alerte `ATTACHMENT_MISSING` au responsable ; l'opération reste `PENDING_APPROVAL` si la pièce est requise pour la validation. |
| Paramètre modifié pendant qu'un appareil est hors ligne | L'appareil applique l'ancienne valeur. À la synchronisation, le serveur réévalue selon la version en vigueur à `occurred_at` (BR-ADM-016). |
