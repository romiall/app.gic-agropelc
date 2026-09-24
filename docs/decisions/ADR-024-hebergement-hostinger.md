# ADR-024 — Hébergement cible : Hostinger sans VPS ; développement local d'abord

- **Statut** : ACCEPTÉ (décision confirmée par le porteur du projet ; tranche AV-073)
- **Date** : session du 24/09/2026

## Contexte

L'architecture de déploiement ([`../05-architecture/04-deploiement.md`](../05-architecture/04-deploiement.md)) décrivait une topologie générique (plateforme de conteneurs managée, base managée, stockage objet, CDN) sans fournisseur nommé, avec AV-073 ouvert. Le porteur du projet a confirmé :

1. L'hébergement de production cible est **Hostinger**.
2. **Aucun VPS** : le porteur ne souhaite pas administrer ni payer une machine virtuelle dédiée.
3. Le domaine racine est `gic-agropelc.com` ; le sous-domaine de production est `app.gic-agropelc.com`.
4. Le développement **ne dépend pas** de Hostinger : les premières phases se font en local, sur GitHub, avec CI et services conteneurisés locaux.

## Décision

1. **Hostinger sans VPS** est la cible d'hébergement de production pour le calcul applicatif et la base MySQL (ADR-023). Aucune tâche de cette session ni du démarrage de P0 ne dépend d'un accès à Hostinger.
2. **Domaine** : `app.gic-agropelc.com` est la cible de production. Il n'est **jamais codé en dur** : l'URL de base de l'API et de la PWA est une variable d'environnement (`APP_BASE_URL`, `API_BASE_URL`), résolue différemment par environnement :

   | Environnement | URL de base (exemple) | Configuré |
   |---|---|---|
   | `dev` (local) | `http://localhost:3000` | Fichier `.env` local, non versionné |
   | `staging` | à définir (sous-domaine à choisir, ex. `staging.app.gic-agropelc.com` ou un fournisseur distinct) | Variables d'environnement CI/CD |
   | `production` | `https://app.gic-agropelc.com` | Variables d'environnement de la plateforme d'hébergement |

3. **Aucune configuration DNS, aucun achat d'infrastructure, aucun déploiement n'est fait maintenant.** Ces actions sont déclenchées par la phase de déploiement (fin de P0 au plus tôt, voir `04-deploiement.md` §1 « environnements »), pas par ce recadrage.
4. **Stockage objet** (photos, pièces jointes, ADR-012) : Hostinger sans VPS n'expose pas de produit de stockage objet compatible S3 documenté. La cible retenue reste un fournisseur **S3-compatible séparé** (Cloudflare R2, Backblaze B2, ou équivalent), choisi au moment du déploiement — c'était déjà une brique indépendante avant ce recadrage (`04-deploiement.md` §2 la traitait déjà comme un composant distinct de la base). Voir AV-091.
5. **Modalité d'exécution du serveur Node.js (API et worker)** chez Hostinger sans VPS reste **ouverte** (AV-090) : selon l'offre retenue (hébergement avec exécution Node.js, ou plateforme tierce à bas coût compatible « pas de VPS » en complément de Hostinger pour le seul calcul). Cette question ne bloque ni le recadrage ni le démarrage de P0 (§5).

## Alternatives étudiées

1. **VPS Hostinger.** Rejeté explicitement par le porteur du projet.
2. **Fournisseur cloud managé générique** (celui envisagé par `04-deploiement.md` avant ce recadrage : conteneurs managés + PostgreSQL managé). Écarté pour la production : le porteur a fixé Hostinger comme cible. Reste la référence de repli si la modalité d'exécution Node.js de Hostinger s'avère impraticable sans VPS (à réévaluer à la phase de déploiement, pas maintenant).
3. **Déployer immédiatement pour valider.** Rejeté : contredit l'instruction explicite du porteur (« il n'est pas nécessaire, pendant le recadrage ni au démarrage du développement, de déployer immédiatement l'application »).

## Justification

Le porteur du projet a un contrôle direct et légitime sur son budget d'exploitation et le fournisseur retenu (AV-084, RISK-21). Séparer développement et infrastructure de production (§5) permet de respecter cette contrainte sans ralentir ni complexifier les phases P0 à P3, qui n'en dépendent pas.

## Conséquences

- `04-deploiement.md` est mis à jour : la topologie nomme Hostinger comme fournisseur de calcul et de base, garde le stockage objet et les services de supervision comme fournisseurs indépendants, et retire toute estimation de coût fondée sur un fournisseur de conteneurs génériques.
- Le pipeline de CI/CD garde une étape de build indépendante du fournisseur cible (image Docker **ou** artefact Node.js selon la modalité retenue par AV-090), pour ne pas figer un choix encore ouvert.
- Deux nouveaux points À VALIDER, non bloquants : AV-090 (modalité d'exécution Node.js chez Hostinger), AV-091 (fournisseur de stockage objet).

## Risques

RISK-22 (indisponibilité de l'hébergement), inchangé. Nouveau risque de modalité d'exécution non encore choisie : couvert par AV-090, sans impact sur P0 à P3 (§5).

## Section 5 — Ce qui ne dépend pas de Hostinger

Conformément à la demande du porteur de projet, aucun élément du développement des phases P0 à P3 (release R1) ne requiert d'accès à Hostinger :

| Élément | Où il tourne pendant le développement |
|---|---|
| Base de données | MySQL en conteneur local et en CI (image officielle, ex. `mysql:8.0`) |
| Serveur API et worker | Processus Node.js local ; conteneur local pour les tests d'intégration |
| PWA | Serveur de développement Vite local ; build statique testable sans réseau |
| Stockage objet (pièces jointes) | Émulateur S3 local en développement et en CI (ex. MinIO en conteneur), pointant vers le vrai fournisseur seulement en staging/production |
| Tests (unitaires, intégration, E2E, charge) | Entièrement locaux et en CI GitHub Actions |
| Recette utilisateurs pilotes | Environnement `staging`, dont l'hébergement précis reste à choisir (AV-090), mais qui n'est nécessaire qu'à la fin de P0, pas pendant |

Le [passage au développement](../10-development-plan/06-passage-au-developpement.md) §6 « Ce qui n'est pas encore fait » est mis à jour en conséquence.
