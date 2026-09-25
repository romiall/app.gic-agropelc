# Compte rendu de compréhension (Phase 2 du démarrage)

> Session de démarrage du cadrage : 24/09/2026.
> Objet : contrôle de compréhension avant la production des livrables du Prompt maître. Ce n'est pas un livrable final.

---

## 1. Inspection du dépôt (Phase 0)

| Élément | Constat |
|---|---|
| Dépôt | `romiall/app.gic-agropelc` |
| Branche par défaut | `main` : 2 commits (`2159c35` Initial commit, `a84896d` Add files via upload) |
| Branche de travail | `claude/sweet-gates-7cjwd4`, créée depuis `origin/main` |
| Fichiers présents au démarrage | `README.md` (2 lignes), `Contexte métier de référence — Projet GIC AGROPELC.md` (1 950 lignes), `Prompt maître — Cadrage technique et architecture GIC AGROPELC.md` (1 684 lignes) |
| Code applicatif, configuration, CI | Aucun |
| État réel | Projet vierge : seuls les deux documents fondateurs existent. |

## 2. Documents trouvés et lus

| Document | Code | Lecture |
|---|---|---|
| Contexte métier de référence — Projet GIC AGROPELC | CM | Lu intégralement, §0 à §64 |
| Prompt maître — Cadrage technique et architecture GIC AGROPELC | PM | Lu intégralement, §1 à §51 |

## 3. Finalité du produit (synthèse)

GIC AGROPELC veut un **système central de contrôle opérationnel** (CM §1, §61), pas un simple logiciel de stock ni un CRM. Le système doit relier production, stock, distribution, commercial, client et finance, afin que la direction sache **ce qui entre, ce qui est produit, ce qui existe, où, sous la responsabilité de qui, ce qui est vendu, ce qui est perdu et où est passé l'argent** (CM §64).

Pour y parvenir :

- chaque opération est lue sur trois dimensions cohérentes : physique, financière et responsabilité (CM §5, PM §4) ;
- l'interface est volontairement simple et c'est le moteur qui porte la rigueur (CM §3) ;
- le fonctionnement hors connexion est une contrainte de conception fondamentale (CM §37, PM §5).

Le critère de réussite est la **confiance** : le système doit répondre de façon fiable, traçable et compréhensible à des questions comme « Combien de poulets réellement disponibles pouvons-nous vendre aujourd'hui à Douala ? » ou « Pourquoi manque-t-il cinq unités ? » (CM §62).

## 4. Domaines métier identifiés

| # | Domaine | Sources principales |
|---|---|---|
| 1 | Core / Administration : utilisateurs, rôles, sites, zones, appareils, validations, pièces jointes | CM §47, §48, §57/Core, §42 ; PM §17 |
| 2 | Commercial / CRM opérationnel : prospects, clients, portefeuille, visites, interactions, objectifs, performance | CM §6–§9, §11 ; PM §12 |
| 3 | Pointage terrain : prise et fin de service, géolocalisation | CM §10 ; PM §13 |
| 4 | Commandes et ventes | CM §13, §4 ; PM §24 |
| 5 | Distribution et points de vente | CM §12, §22, §23 ; PM §14 |
| 6 | Stocks : mouvements, transferts, allocations, pertes, inventaires | CM §20–§25, §39 ; PM §6 |
| 7 | Production : volaille, œufs, incubation, porcs, mortalité | CM §14–§19, §33 ; PM §10 |
| 8 | Approvisionnement : fournisseurs, demandes d'achat, commandes fournisseurs, réceptions, factures | CM §26–§28 ; PM §11 |
| 9 | Finance opérationnelle : encaissements, créances, dépenses, caisse, paiements fournisseurs, coûts, marges | CM §31, §32 ; PM §15 |
| 10 | Tarification : règles, historique | CM §29, §30 ; PM §9 |
| 11 | Analytics et tableaux de bord | CM §34, §35 ; PM §19 |
| 12 | Audit et traçabilité | CM §40, §41 ; PM §18 |
| 13 | Notifications, alertes et communication interne | CM §43, §54 |
| 14 | Synchronisation offline | CM §36–§39 ; PM §5, §29, §30 |
| 15 | Intégration Kommo | CM §44–§46 ; PM §16 |

## 5. Contraintes architecturales les plus critiques

1. **Stock = registre de mouvements.** Le stock est la somme de mouvements traçables. Il n'est jamais saisi directement. Un inventaire génère un ajustement et n'écrase jamais le stock (CM §21, §25 ; PM §6).
2. **Offline-first.** Une vente, un prospect, une visite, une perte ou une opération de terrain doivent pouvoir être enregistrés sans réseau (CM §37). Cela impose :
   - des identifiants générés sur l'appareil ;
   - des commandes idempotentes ;
   - une outbox locale ;
   - une gestion explicite des conflits (PM §5, §29, §30).
3. **Temps métier distinct du temps technique.** Le système distingue quatre instants :
   - `occurred_at`, l'heure réelle de l'opération ;
   - l'heure de création sur l'appareil ;
   - l'heure de réception par le serveur ;
   - l'heure de synchronisation.

   Les rapports, la caisse et les performances se calculent sur l'heure réelle (CM §38).
4. **Prévention de la double consommation hors ligne.** Des quantités sont affectées explicitement à un point de vente, un commercial, un vendeur ou un magasin. Un stock négatif volontaire n'est pas un mécanisme normal de résolution (CM §39 ; PM §6).
5. **Aucune disparition silencieuse.** Les opérations sensibles se corrigent par annulation ou contre-écriture, et jamais par une suppression physique (CM §40, §41 ; PM §8).
6. **Historisation.** Les prix appliqués sont figés dans chaque transaction. Un changement de tarif, de zone ou de responsable ne réécrit pas l'historique (CM §30 ; PM §7).
7. **Cohérence physique, finance et responsabilité.** Une vente produit à la fois une sortie de stock, du chiffre d'affaires, une créance ou un encaissement, et une attribution commerciale. Une perte produit une quantité perdue et une valeur perdue (CM §32 ; PM §4).
8. **RBAC.** Un utilisateur peut avoir plusieurs rôles. Chaque droit est limité à un périmètre : propre, équipe, zone, site ou tout (CM §6, §47, §48 ; PM §17, §31).
9. **Source de vérité unique par donnée**, notamment entre Kommo et GIC AGROPELC (CM §44, §45, §59 ; PM §16).
10. **Matériel et réseau modestes.** Téléphones Android d'entrée de gamme, bande passante faible (PM §36).

## 6. Principales zones À VALIDER

Le registre complet et vivant est [`../A-VALIDER.md`](../A-VALIDER.md). Voici les points qui pèsent le plus sur l'architecture :

| Réf. | Sujet | Défaut retenu provisoirement |
|---|---|---|
| AV-024 | Moment où la vente est reconnue et où le stock sort, pour une vente sur commande | La vente naît à la remise physique ; la commande réserve le stock |
| AV-025 | Vente hors ligne au-delà de l'allocation | Bloquée sur l'appareil |
| AV-012 | Règle de conversion d'un prospect en client | Automatique à la première vente confirmée |
| AV-042 | Méthode de valorisation du stock | Coût moyen unitaire pondéré (CMUP) perpétuel |
| AV-037 / AV-048 | Seuils de validation et de preuve pour les pertes et la mortalité | Politique paramétrable avec des seuils par défaut |
| AV-028 | Politique de crédit client | Crédit réservé aux clients autorisés, avec plafond |
| AV-041 | TVA et taxes | Prix TTC, pas de ventilation fiscale au MVP |
| AV-044 / AV-045 | Types de lots, naissage porcin | Chair, pondeuse et porc d'engraissement ; naissage hors MVP |
| AV-021 / AV-022 | Prise de service hors zone, précision GPS | Refus avec la tentative conservée, dérogation validée ; rayon de 500 m |
| AV-001 | Périmètre du premier déploiement | Mise en production progressive par tranches |
| AV-068 | Capacités Kommo (API, webhooks, pipelines) | À vérifier avant la phase Kommo |

## 7. Contradictions et tensions détectées entre les sources

| Réf. | Passages | Nature | Résolution appliquée |
|---|---|---|---|
| **C-01** | PM §31 (colonnes RBAC : Direction, Admin, Resp. commercial, Commercial, Vendeur, Production, Magasinier, Achats, Finance) ↔ CM §47 (11 rôles) | La matrice du PM regroupe les commerciaux terrain et sédentaire et omet le responsable ferme. | Le CM détermine les rôles : la matrice RBAC comporte **les 11 rôles** du CM §47. |
| **C-02** | PM §11 « commandé ≠ reçu ≠ accepté ≠ facturé ≠ payé » ↔ CM §27–§28 « commandé ≠ livré ≠ reçu ≠ accepté ≠ facturé ≠ payé » (exemple 100 / 98 / 3 / 95) | Le PM omet l'étape « livré ». | On suit le CM. La réception distingue **quantité livrée, quantité rejetée et quantité acceptée**. Le reliquat commandé mais non livré reste ouvert sur la commande. |
| **C-03** | CM §15, §33 (« Campagne de 2 400 poulets » = lot de production) ↔ PM §9, §29 (« campagne commerciale », « période commerciale ») | Un même mot recouvre deux concepts. | Désambiguïsation dans le glossaire : **Lot de production** (dont « campagne de production ») ≠ **Campagne commerciale**, qui est une période tarifaire ou promotionnelle. Aucun identifiant technique n'utilise « campaign » seul. |
| **C-04** | CM §4 (« … COMMANDER → VENDRE → LIVRER → ENCAISSER ») ↔ CM §13 (« une vente doit avoir … diminution du stock ») | Si la vente précède la livraison, le stock baisserait avant la sortie physique. | Voir ADR-014 : le stock sort à la **remise physique**. Une vente directe (point de vente, terrain) est à la fois vente et remise. Une commande réserve le stock et se transforme en vente à la livraison. Statut **À VALIDER** (AV-024). |
| **C-05** | PM §24 (états de vente : brouillon, confirmée, payée partiellement, payée, annulée) | Le cycle de vie du document et l'état de paiement sont mélangés. | Deux dimensions orthogonales : `status` (cycle de vie) et `payment_status` (dérivé des encaissements). Statut DÉDUIT, voir SM-SALE. |
| **C-06** | PM §5 (PWA), PM §36 (Android modestes) ↔ CM §3 (« adaptée au téléphone ») | Pas une contradiction : le CM ne parle ni de PWA ni d'Android. | Contraintes techniques **CONFIRMÉES par le PM** (PM §5, §36), traçées comme telles. |
| **C-07** | CM §57 (MVP couvrant presque tous les domaines) ↔ CM §56 et §63.10 (ne pas transformer le MVP en usine à gaz) | Tension sur la taille du MVP. | Le MVP fonctionnel reste celui du CM §57. Il est livré par **tranches verticales** successives en production (plan de développement). Le périmètre de la première mise en service est À VALIDER (AV-001). |
| **C-08** | CM §39 (« ne consomme **prioritairement** que le stock dont il est responsable ») ↔ PM §6 (empêcher autant que possible la double consommation ; le stock négatif volontaire n'est pas le mécanisme normal) | CM est souple (« prioritairement »), PM plus strict. | Par défaut, blocage sur l'appareil au-delà de l'allocation (AV-025). Une vente hors ligne réellement effectuée n'est jamais rejetée à la synchronisation. Si elle crée un solde négatif, elle ouvre un **conflit de stock** à résoudre : c'est une anomalie détectée, pas un mécanisme normal. |
| **C-09** | CM §16 (mortalité = événement de production) ↔ CM §24 (mortalité = forme de perte) | Double rattachement possible. | Un seul objet : la **déclaration de perte** de catégorie `MORTALITE`, rattachée au lot. Elle est saisie depuis le parcours production (« Saisie du jour ») et exploitée par la production comme par le stock. Statut DÉDUIT. |
| **C-10** | PM §23 (liste des 22 domaines) ↔ CM §13, §4 (vente et commande au cœur de la chaîne) | Le PM n'isole pas « Commandes et ventes » comme domaine. | Création d'un domaine **VEN – Commandes et ventes**, distinct du CRM, justifié par la chaîne COMMANDER → VENDRE → LIVRER → ENCAISSER. |
| **C-11** | PM §17 (« Responsable ferme **si pertinent** ») ↔ CM §47 (Responsable ferme listé sans condition) | Le PM relativise un rôle confirmé par le CM. | Le rôle existe (CM). La répartition exacte avec le responsable production est À VALIDER (AV-005). |
| **C-12** | PM §48 (livrer « un document structuré exactement dans cet ordre ») ↔ demande de démarrage (arborescence `/docs` multi-fichiers) | Forme du livrable. | Un document par section dans `docs/`, et un **index maître** [`../README.md`](../README.md) qui présente les 39 sections du PM §48 **dans l'ordre exact** et renvoie à chaque fichier (ADR-022). |

## 8. Ordre de production des livrables

1. Conventions, compte rendu et registre À VALIDER.
2. Exigences sources (`REQ`), vision, hypothèses et limites.
3. Glossaire (L1), périmètre (L2), acteurs et rôles.
4. Domaines fonctionnels (L3), parcours et écrans, index des règles métier.
5. Workflows et machines à états (L4).
6. Invariants (L6), modèle conceptuel et ERD, stratégies stock, pricing et finance.
7. Identifiants, types de tables, modèle relationnel, dictionnaire de données (L5), politique de suppression et d'historisation.
8. Architecture offline, synchronisation et matrice des conflits (L7).
9. RBAC (L8), sécurité (L14), audit.
10. API (L9), catalogue d'événements (L10), intégration Kommo.
11. Architecture logicielle (L11), modules (L12), graphe de dépendances (L16), déploiement.
12. Exigences non fonctionnelles (L13), observabilité, plan de tests.
13. Plan de développement (L15), matrice de traçabilité (L17), ADR (L18), risques (L19), questions ouvertes (L20), recommandation de stack, checklist.
14. Executive summary et audit de cohérence final.
