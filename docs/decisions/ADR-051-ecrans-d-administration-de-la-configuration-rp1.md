# ADR-051 — Écrans d'administration de la configuration (RP-1) : paramètres par catalogue, lectures de la structure, journal d'audit borné pour la Finance

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; AV-490 à AV-494 tranchés par le porteur le 01/11/2026, AV-495 à AV-497 ouverts avec leur défaut)
- **Date** : 01/11/2026
- **Précise** : ADR-008 (RBAC), ADR-021 (logique partagée), ADR-036 (registre des écrans), ADR-045 (écritures en ligne hors journal des mots de passe), ADR-049 (système de design)
- **Questions liées** : AV-490 à AV-497 ; besoins serveur S-19 et S-28 ([`16-besoins-serveur-des-ecrans.md`](../10-development-plan/16-besoins-serveur-des-ecrans.md))

## Contexte

Le serveur sait créer et modifier l'organisation, les paramètres et les politiques de contrôle par des commandes (P0, P1, P5, MP), mais la PWA n'avait aucun écran pour le faire : seuls les comptes (ECR-ADM-04) et les appareils (ECR-ADM-05) en avaient un. Sans eux, un pilote ne peut ni créer ses sites, zones et équipes, ni régler ses seuils, sans passer par la base. La lecture du code du 01/11/2026 relève en outre :

- aucune lecture HTTP des zones ni des équipes (seuls `/sites`, `/locations` et `/points-of-sale` existaient) : S-19 et S-28 ;
- la valeur d'un paramètre est du JSON libre (`z.unknown()` dans la commande `organization.setting.set`) : rien n'empêche un texte à la place d'un seuil ;
- `03-audit.md` § 6 écrit que « la Finance est limitée aux entités financières », mais la lecture du journal servait tout détenteur de `audit.log.read` sans restriction ;
- la commande `organization.setting.set` omet `isClientVisible` : une nouvelle version d'un réglage visible sur les appareils cesserait de l'être.

## Décision

1. **Trois écrans en ligne seulement** (garde commune `AdminGate` : hors ligne, un message ; une connexion perdue entre l'affichage et l'envoi refuse l'enregistrement, rien n'est mis en file ; une commande déjà envoyée sans réponse est rejouée comme toute commande, idempotente) : **ECR-ADM-06 Organisation** (`/administration/organisation`, Admin : sites, emplacements, zones et géorepères, équipes, points de vente), **ECR-ADM-07 Paramètres et politiques** (`/administration/parametres`, Direction et Admin), **ECR-AUD-01 Journal d'audit** (`/administration/audit`, Direction, Admin et Finance). Ils appartiennent au groupe de menu « Général » et se chargent à la demande. **ECR-ADM-04** gagne les affectations de rôle sur une zone ou une équipe.
2. **Aucune commande nouvelle** : toute écriture passe par la file d'envoi (`submitCommand`, un seul chemin d'écriture) avec les commandes existantes (`organization.site.*`, `.location.*`, `.zone.*`, `.team.*`, `.pos.configure`, `organization.setting.set`, `approvals.policy.set`, `identity.role_assignment.*`). Les droits restent jugés par le serveur ; l'écran n'offre que ce que les commandes permettent (AV-497).
3. **Lectures ajoutées** (en ligne, droits existants) : `GET /zones` (liste plate, bornée par les affectations `ZONE`), `GET /teams` (portée `ALL` : toutes ; sinon les équipes dirigées ou dont on est membre ; noms des membres fournis, AV-495), `GET /organization/settings/current` (version en vigueur par clé et portée) et l'historique d'une clé avec l'auteur de chaque version, `GET /approvals/policies[?code=]` (`approvals.policy.manage`, avec la liste des permissions d'approbateur), `GET /audit/entity-types`, et pour `GET /audit` : `from` et `to` (jours métier, `Africa/Douala`, sur `recorded_at`), le nom de l'acteur.
4. **Catalogue des paramètres partagé** : `packages/contracts/src/settings-catalog.ts` donne, pour chaque clé semée, sa forme (entier, nombre, oui/non, choix, liste, jours de la semaine, objet), son unité, ses bornes, son domaine et si le serveur la lit « du site, à défaut global » (`site: true`). `validateSettingValue` est pur et sert l'écran ; les libellés français restent dans la PWA (`settings.label.<clé>`). La source des clés et des défauts reste `db/seeds/system-settings.ts` : un essai du serveur échoue si une clé semée manque au catalogue (AV-490). Les réglages techniques sont repliés derrière un interrupteur avec avertissement ; une clé hors catalogue reste modifiable comme objet JSON. La portée offerte est le global, ou un site pour les seuls réglages `site: true` (AV-491). Une nouvelle version **reporte la visibilité sur les appareils** de la version en vigueur.
5. **Journal d'audit borné côté serveur** (AV-493) : la Direction et l'Admin lisent tout ; tout autre détenteur de `audit.log.read` (la Finance) ne lit que les types d'entité du paramètre `audit.finance_entity_types` (quinze types financiers semés, repli identique dans le code, **fermé par défaut**). La liste des types d'entité du filtre est bornée de la même façon. La restriction est posée par la couche de transport (`audit-api/audit-scope.ts`) : le module `audit` ne dépend d'aucun autre. Chaque consultation étant elle-même inscrite au journal (BR-AUD-009), l'écran ne relit que sur demande.
6. **Politiques** (AV-494) : l'écran crée une **nouvelle version** (photo, commentaire, validation, approbateur, portée) ; la `condition` JSON, qui décide quand la politique s'applique, est reprise telle quelle et reste en lecture seule.
7. **Géorepère par champs** (AV-492) : latitude, longitude et rayon saisis, avec « Utiliser ma position » (GPS de l'appareil) ; pas de carte.

## Alternatives étudiées

- Éditeur JSON brut pour tous les paramètres : écarté (une faute de type change silencieusement une règle).
- Contrôle du type de chaque clé dans la commande du serveur : meilleur à terme (AV-496), hors de ce lot qui ne modifie pas le pipeline des commandes ; le catalogue partagé en est la première brique.
- Restriction de la Finance seulement dans l'écran : écartée (un autre client lirait tout).
- Carte pour le géorepère : écartée (dépendance cartographique et tuiles en ligne, taille du paquet).

## Conséquences

- `GET /zones` et `GET /teams` couvrent la **lecture** de S-19 et S-28 ; restent le jeu hors ligne `zone` filtré par les affectations et la publication des appartenances aux appareils (statut « Partiel »).
- Une clé de paramètre semée sans entrée au catalogue fait échouer `settings-catalog.test.ts` ; une clé retirée du seed qui reste au catalogue aussi.
- Nouvelle clé semée : `audit.finance_entity_types` (dictionnaire [`02-organization.md`](../03-data/dictionnaire/02-organization.md)) ; `03-audit.md` § 6 précise la règle.
- Le serveur ne valide toujours pas le type d'une valeur par clé : seul l'écran le fait (AV-496).
- Le contrôle dans un navigateur et sur un téléphone reste à faire.

## Risques

- Un mauvais seuil saisi par la Direction ou l'Admin prend effet dès l'enregistrement : le motif du changement est proposé à chaque modification et l'historique de chaque clé (version, auteur, motif) se relit sur l'écran.
- Supprimer l'approbateur d'une politique peut la rendre non décidable (AV-494) ; l'écran n'empêche pas cette configuration, il la signale.
