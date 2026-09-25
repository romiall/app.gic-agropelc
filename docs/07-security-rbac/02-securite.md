# Stratégie de sécurité (Livrable n°14)

> Section 28 du format final (PM §48). Principe directeur : **l'interface cliente n'est jamais une autorité de confiance** (PM §37, REQ-212). Tout est revérifié par le serveur à la réception de chaque commande.

---

## 1. Menaces principales (contexte GIC AGROPELC)

| Menace | Acteur | Actif visé | Mesures (détaillées ci-dessous) |
|---|---|---|---|
| Fraude interne sur le stock (déclarations de pertes fictives, ventes non déclarées) | Vendeur, magasinier, commercial | Stock, argent | Registre immuable, politiques de contrôle, validations, séparation des tâches, inventaires, alertes, audit |
| Fraude sur l'argent (encaissement non déclaré, double saisie, caisse) | Vendeur, commercial | Trésorerie | Sessions de caisse, références uniques, remises de fonds en deux temps, alertes de détention d'espèces |
| Manipulation des prix | Vendeur | Marge | Prix résolus par le moteur, dérogations plafonnées et motivées, anomalies `PRICE_MISMATCH` |
| Présence fictive | Commercial terrain | Performance | Pointage géolocalisé recalculé par le serveur, signaux de suspicion |
| Usurpation d'identité (PIN partagé, appareil prêté) | Tout utilisateur | Responsabilité | Identifiants nominatifs, PIN personnel, appareils enrôlés, audit par appareil |
| Appareil perdu ou volé | Tiers | Données locales, capacité d'écriture | PIN, chiffrement local, autonomie bornée, révocation, quarantaine |
| Synchronisation falsifiée (rejeu, commandes forgées, suppression de commandes locales) | Utilisateur malveillant, tiers | Intégrité du registre | Idempotence, empreinte, séquence d'appareil, RBAC à `occurred_at`, validation serveur complète |
| Accès non autorisé aux données d'autrui (IDOR) | Utilisateur authentifié | Données clients et financières | Contrôle de portée sur chaque requête, identifiants non devinables sans valeur de sécurité, tests générés |
| Attaques web classiques (injection, XSS, CSRF) | Externe | Serveur, sessions | Requêtes paramétrées, validation stricte, CSP, en-têtes de sécurité, jetons Bearer |
| Webhooks Kommo forgés | Externe | CRM | Authentification des webhooks, journalisation brute, idempotence |

## 2. Authentification

| Élément | Décision | Statut |
|---|---|---|
| Identifiant | Numéro de téléphone E.164 | AV-008 |
| Mot de passe | ≥ 8 caractères ; hachage **argon2id** (paramètres OWASP en vigueur, mémoire ≥ 19 Mo) ; changement forcé à la première connexion | D |
| Tentatives | 5 échecs → blocage progressif (1, 5, 15 min) par identifiant et par IP ; audit `auth.login.failed` | D |
| PIN local | 6 chiffres, par utilisateur et par appareil ; il sert à **déverrouiller** l'application hors ligne. Une clé est dérivée du PIN (PBKDF2-SHA256, ≥ 310 000 itérations, sel aléatoire) et déchiffre les jetons et les magasins sensibles locaux. Il n'est jamais transmis au serveur. 5 échecs → effacement des jetons locaux et reconnexion en ligne obligatoire (BR-ADM-024) | D |
| Double facteur | Non au MVP (coût et fiabilité des SMS) ; à envisager pour `DIRECTION`, `ADMIN`, `FINANCE` (TOTP) | AV-008 |
| Réinitialisation | Par l'Admin uniquement (pas de libre-service SMS au MVP) ; audit | D |

## 3. Sessions, jetons, révocation

| Élément | Décision |
|---|---|
| Jeton d'accès | JWT signé (EdDSA ou ES256), durée **15 min**, contenu minimal : `sub`, `device_id`, `session_id`, `iat`, `exp`. **Aucun** droit dans le jeton : les droits sont lus côté serveur à chaque requête (avec cache court, invalidé à chaque changement) |
| Jeton de rafraîchissement | Opaque (256 bits aléatoires), stocké haché (SHA-256), **rotation à chaque usage**, famille de rotation. La réutilisation d'un jeton déjà utilisé révoque toute la famille (`TOKEN_REUSE`) et lève une alerte. Durée glissante : 30 jours |
| Autonomie hors ligne | `offline_grant_until` = dernière synchronisation + 7 jours (AV-009), signé par le serveur et vérifié localement pour autoriser la saisie |
| Révocation | Désactivation d'utilisateur, blocage d'appareil, décision de l'Admin : révocation de toutes les sessions concernées ; effet immédiat en ligne (refus du rafraîchissement, jeton d'accès expiré sous 15 min) ; hors ligne, effet à la reconnexion, avec quarantaine des commandes postérieures (INV-ADM-03) |
| Stockage côté appareil | Jetons chiffrés par la clé dérivée du PIN, dans IndexedDB (et non `localStorage`) ; jamais accessibles à un script tiers (CSP) |

## 4. Autorisation

1. **RBAC côté serveur** sur chaque commande et chaque requête ([`01-rbac.md`](01-rbac.md)), évalué à `occurred_at` pour les commandes.
2. **Filtrage de portée systématique** : chaque requête de lecture passe par une fonction de filtrage (`scopeFilter(user, resource)`) de la couche d'accès aux données. Aucune requête ne lit une ressource par son seul identifiant sans contrôle de portée (anti-IDOR).
3. **Défense en profondeur pour l'analytics** : MySQL n'offre pas d'équivalent à la sécurité au niveau des lignes (RLS) de PostgreSQL (ADR-023, recadrage Hostinger sans VPS). Le filtrage applicatif (point 2) reste donc l'**unique** ligne d'exécution pour les vues `analytics.f_*`, compensé par une fonction de filtrage unique et partagée entre toutes les lectures analytiques, une couverture de test systématique (un test de propriété par rôle × jeu de faits, à chaque commit) et l'absence de tout accès direct à la base pour un utilisateur final. Réduction assumée et suivie : RISK-28.
4. **Mesures sensibles** : colonnes financières masquées sans `inventory.valuation.read` (RC-05).
5. **Séparation des tâches** : RC-03 (approbateur ≠ demandeur ; Admin sans approbation métier).

## 5. Appareils autorisés

- Enrôlement → `PENDING` → approbation (AV-006) → `ACTIVE`.
- Chaque requête porte `device_id` (dans le jeton). Le serveur vérifie la correspondance session ↔ appareil et le statut de l'appareil.
- Le code court et l'identifiant d'appareil n'ont **aucune** valeur d'authentification : c'est la session qui authentifie.
- Extension future (F-18) : clé asymétrique d'appareil (WebCrypto non exportable) pour signer les lots de commandes. Non retenue au MVP (complexité, faible gain tant que la session est vérifiée).

## 6. Protection des données

| Donnée | En transit | Au repos (serveur) | Au repos (appareil) |
|---|---|---|---|
| Toutes | TLS 1.2+ (1.3 recommandé), HSTS, redirection HTTPS | Chiffrement du disque et des sauvegardes (service managé) | — |
| Mots de passe | — | argon2id | Jamais stockés |
| Jetons | — | Rafraîchissement haché | Chiffrés (clé dérivée du PIN) |
| Données personnelles des clients (nom, téléphone, position) | TLS | Base chiffrée ; accès restreint par portée | Magasins `scope_customers` chiffrés (AES-GCM, clé dérivée du PIN) |
| Outbox, pièces jointes locales | TLS | Stockage objet chiffré, URL signées à durée courte (5 min) | Chiffrées |
| Référentiels (produits, prix, zones) | TLS | — | En clair (non sensibles ; performances) |
| Secrets (clés d'API Kommo, clés de signature) | — | Gestionnaire de secrets de l'hébergeur ; jamais en base ni dans le dépôt | Jamais |

Minimisation : l'appareil ne reçoit que son périmètre (O3) ; aucune donnée financière globale n'est téléchargée. Positions GPS : collectées seulement aux événements (CM §10), conservées 2 ans puis dégradées (AV-074).

## 7. Protection de l'API

| Mesure | Détail |
|---|---|
| Validation d'entrée | Schémas stricts (bibliothèque partagée) : types, bornes, énumérations ; rejet des champs inconnus |
| Injection SQL | Requêtes paramétrées uniquement (constructeur de requêtes typé) ; aucune concaténation ; l'explorateur analytique n'accepte que des identifiants déclarés (BR-ANA-006) |
| XSS | Échappement par défaut du framework ; CSP stricte (`default-src 'self'`, sans `unsafe-inline` pour les scripts) ; textes libres rendus en texte |
| CSRF | Authentification par en-tête `Authorization: Bearer` (pas de cookie de session pour l'API), donc pas de CSRF |
| CORS | Origines autorisées : le domaine de l'application seulement |
| Limitation de débit | Par IP et par utilisateur : `/auth` 10/min ; `/sync/push` 30/min par appareil ; lecture 300/min ; analytics 30/min ; webhooks Kommo 120/min. Réponse 429 avec `Retry-After` |
| Taille | Corps ≤ 1 Mo (push ≤ 256 Ko compressés) ; morceaux de pièces jointes ≤ 256 Ko |
| En-têtes | `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` (géolocalisation et caméra : `self`) |
| Erreurs | Messages génériques côté client ; détails dans les logs avec `correlation_id` ; aucune pile d'appels exposée |
| Dépendances | Analyse automatique des vulnérabilités en CI ; mises à jour mensuelles |

## 8. Géolocalisation

- La position est une **déclaration de l'appareil**. Le serveur recalcule les distances (BR-TER-003) et détecte les incohérences (BR-TER-010).
- Limite assumée : pas de détection fiable de faux GPS dans une PWA (L-02). Mesures compensatoires : signaux statistiques, visites croisées (distance au compte), contrôles par le responsable. Extension native possible (F-18).

## 9. Pièces justificatives

- Type MIME vérifié par signature de fichier (magic bytes) et non par l'extension ; taille ≤ 5 Mo ; SHA-256 vérifié.
- Stockage objet privé ; accès par URL signée à durée courte, délivrée après contrôle de portée sur le document propriétaire.
- Images réencodées côté serveur (suppression des métadonnées EXIF, sauf date et position conservées en base si utiles).

## 10. Réponses aux fraudes métier (PM §37)

| Fraude | Contrôles préventifs | Contrôles détectifs |
|---|---|---|
| **Modification de prix** | Prix résolu par le moteur ; dérogation = permission + plafond + motif (AV-026) ; règles immuables (INV-PRX-01) | Anomalies `PRICE_MISMATCH` ; analyse des écarts prix appliqué / catalogue par vendeur ; audit |
| **Manipulation de stock** | Aucune saisie de solde ; mouvements immuables ; pertes contrôlées par des politiques et des validations (approbateur ≠ déclarant) ; inventaires validés au-delà d'un seuil | Écarts d'inventaire par emplacement et par responsable ; pertes anormales (`HIGH_LOSS`) ; soldes négatifs ; réconciliation quotidienne du registre (INV-STK-01) |
| **Double paiement** | Unicité (moyen, référence) ; quarantaine `SUSPECT_DUPLICATE` | Heuristique montant, client et délai ; rapprochement avec les relevés |
| **Synchronisation falsifiée** | Session obligatoire ; RBAC à `occurred_at` ; validation complète côté serveur ; identifiants UUIDv7 contrôlés ; empreinte (INV-SYN-02) ; séquence d'appareil | Trous de séquence (`DEVICE_SEQ_GAP`) ; écarts d'horloge ; rejeu d'identifiant (`COMMAND_ID_REUSED`) ; audit |
| **Encaissements non déclarés** | Ventes à prix connus ; caisse par session ; remises en deux temps | Écarts de caisse ; détention d'espèces élevée ; comparaison ventes / stock |
| **Présence fictive** | Géorepère, précision minimale, dérogation validée | Signaux de suspicion ; visites éloignées du compte |
| **Usurpation** | PIN personnel ; blocage après échecs ; appareils enrôlés | Connexions inhabituelles (nouvel appareil, horaires) ; audit par appareil |
| **Collusion vendeur–approbateur** | Séparation des tâches ; escalade à la Direction au-delà des seuils | Tableaux « validations par approbateur » ; revue par la Direction |

## 11. Journalisation et audit

- Audit métier : [`03-audit.md`](03-audit.md).
- Logs techniques : structurés (JSON), sans secret ni donnée personnelle en clair (téléphones masqués), avec `correlation_id` ; conservés 30 jours (voir observabilité).
- Événements de sécurité audités : connexion (succès, échec), verrouillage, rafraîchissement anormal, révocation, changement de droits, lecture d'audit, export, refus d'autorisation (`DENIED`).

## 12. Sécurité du développement et de l'exploitation

- Revue de code obligatoire ; analyse statique et analyse des dépendances en CI ; secrets exclus du dépôt (détection automatique).
- Environnements séparés (dev, recette, production) ; aucune donnée de production en dev, sauf anonymisation.
- Accès production : comptes nominatifs, principe du moindre privilège, accès base en lecture seule par défaut pour le support.
- Sauvegardes chiffrées, restaurations testées (voir exigences non fonctionnelles).
- Test d'intrusion externe recommandé avant la généralisation (après R2).
