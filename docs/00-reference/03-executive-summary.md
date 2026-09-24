# Executive Summary

> Section 1 du format final (PM §48). Synthèse du cadrage pour la Direction de GIC AGROPELC et pour l'équipe qui développera l'application.
> Statuts : **CONFIRMÉ** (écrit dans une source), **DÉDUIT** (conséquence argumentée), **À VALIDER** (décision en attente, registre [`../A-VALIDER.md`](../A-VALIDER.md)). Voir [`00-conventions.md`](00-conventions.md).

---

## 1. Le besoin

GIC AGROPELC gère une activité avicole et porcine : achats, fermes, incubation, magasins, points de vente, commerciaux terrain et sédentaires. Aujourd'hui, l'information est dispersée entre cahiers, fichiers Excel, messages WhatsApp et mémoires individuelles (CM §1). La Direction ne peut pas savoir de façon fiable **ce qui entre, ce qui est produit, ce qui existe, où, sous la responsabilité de qui, ce qui est vendu, ce qui est perdu et où est passé l'argent** (CM §64). **CONFIRMÉ.**

## 2. La réponse proposée

Une **application métier intégrée**, utilisable sur téléphone même sans réseau, dans laquelle chaque opération réelle est saisie **une seule fois**, au plus près du terrain. Chaque saisie produit automatiquement :

- ses effets **physiques** : mouvements de stock ;
- ses effets **financiers** : chiffre d'affaires, encaissements, créances, caisses, coûts ;
- ses effets de **responsabilité** : auteur, validateur, appareil, lieu, heure réelle, journal d'audit.

La complexité est portée par le moteur, pas par l'utilisateur : un vendeur déclare « j'ai vendu 3 poulets » ; le système en déduit le stock, le prix applicable, la créance ou l'encaissement, l'attribution commerciale et l'audit (principe P2).

## 3. Décisions structurantes

| # | Décision | Pourquoi | Statut | Référence |
|---|---|---|---|---|
| 1 | **Offline-first** : application web installable (PWA) avec base locale ; chaque saisie est une commande idempotente, rejouée sans risque ; le serveur reste l'autorité | Réseau faible sur le terrain ; aucune vente ne doit être perdue ni comptée deux fois | CONFIRMÉ (PM §5) / DÉDUIT | ADR-001, ADR-007 |
| 2 | **Stock = registre de mouvements** en partie double ; les soldes sont des calculs, jamais des saisies | Chaque variation de stock a une cause, un auteur et une heure (CM §21) | CONFIRMÉ / DÉDUIT | ADR-003 |
| 3 | **Stock confié** : stock mobile d'un commercial, quotas par appareil dans un PDV partagé, réservations | Limiter la double consommation hors ligne (CM §39) | DÉDUIT ; politique de dépassement **À VALIDER** (AV-025) | ADR-004 |
| 4 | **Prix par règles** (site, zone, catégorie de client, canal, quantité, période), moteur identique sur l'appareil et le serveur, prix **figé** sur chaque vente | Le bon prix sans appel ni réunion ; le passé n'est jamais réécrit (CM §29, §30) | CONFIRMÉ / DÉDUIT | ADR-005 |
| 5 | **Rien ne disparaît** : correction par annulation ou contre-écriture ; journal d'audit en ajout seul, chaîné | Traçabilité et lutte contre la fraude (CM §40, §41) | CONFIRMÉ | ADR-006 |
| 6 | **Contrôle proportionné au risque** : photo, justification ou validation selon la catégorie, la quantité et la valeur ; séparation des tâches | Rigueur sans alourdir les petites opérations (CM §24, §42) | CONFIRMÉ / DÉDUIT ; seuils À VALIDER | ADR-018 |
| 7 | **11 rôles, 117 permissions**, avec des portées (soi, équipe, site, zone, tout) évaluées à l'heure réelle de l'opération | Chacun ne voit et ne fait que ce qui relève de sa responsabilité (CM §47, §48) | CONFIRMÉ / DÉDUIT | ADR-008 |
| 8 | **Kommo reste l'outil des conversations et des leads digitaux ; GIC est la source de vérité** des clients, ventes, stocks et prix | Pas de double vérité (CM §44 à §46, §59) | CONFIRMÉ | ADR-009 |
| 9 | **Comptabilité opérationnelle** (pas une comptabilité générale) : ventes, encaissements, créances, caisses, dépenses, dettes, coûts de lot et marges | Besoin de pilotage (CM §31 à §33) | CONFIRMÉ ; méthode de valorisation À VALIDER (AV-042, AV-043) | ADR-010, ADR-015 |
| 10 | **Monolithe modulaire** : un seul déploiement, 19 modules aux frontières contrôlées, PostgreSQL | Simplicité d'exploitation pour une petite équipe, sans sacrifier les frontières (PM §34) | DÉDUIT | ADR-011, ADR-020 |
| 11 | **Stack proposée** : TypeScript de bout en bout (React + IndexedDB sur l'appareil ; NestJS + PostgreSQL sur le serveur) | Même code métier hors ligne et en ligne ; technologies matures | **PROPOSÉ**, à confirmer (AV-089) | ADR-021, [`../05-architecture/05-stack.md`](../05-architecture/05-stack.md) |

## 4. Le cadrage en chiffres

| Élément | Nombre | Document |
|---|---:|---|
| Exigences extraites des sources (84 du Contexte métier, 15 du Prompt maître) | 99 | [`../01-functional/00-exigences-sources.md`](../01-functional/00-exigences-sources.md) |
| Contradictions entre les sources, identifiées et résolues | 12 | [`01-compte-rendu-comprehension.md`](01-compte-rendu-comprehension.md) |
| Domaines fonctionnels / règles métier | 16 / 313 | [`../01-functional/05-index-regles-metier.md`](../01-functional/05-index-regles-metier.md) |
| Invariants (propriétés toujours vraies, testées) | 81 | [`../02-domain-model/01-invariants.md`](../02-domain-model/01-invariants.md) |
| Workflows interdomaines / parcours types / machines à états | 18 / 8 / 30 | [`../04-workflows/`](../04-workflows/) |
| Écrans inventoriés | 69 | [`../01-functional/03-parcours-et-ecrans.md`](../01-functional/03-parcours-et-ecrans.md) |
| Modules / tables (+ vues) | 19 / 105 (+ 2) | [`../03-data/02-modele-relationnel.md`](../03-data/02-modele-relationnel.md) |
| Commandes métier / événements | 159 / 170 | [`../08-api-events/`](../08-api-events/) |
| Rôles / permissions | 11 / 117 | [`../07-security-rbac/01-rbac.md`](../07-security-rbac/01-rbac.md) |
| Exigences non fonctionnelles / tests d'acceptation | 40 / 55 | [`../09-non-functional/`](../09-non-functional/) |
| Décisions d'architecture (ADR) / risques techniques | 22 / 26 | [`../decisions/`](../decisions/README.md), [`../10-development-plan/03-registre-risques.md`](../10-development-plan/03-registre-risques.md) |
| Questions ouvertes : bloquantes / importantes / secondaires | 2 / 47 / 40 | [`../A-VALIDER.md`](../A-VALIDER.md) |

Chaque exigence est reliée à ses règles, ses tables, ses écrans et ses tests dans la [matrice de traçabilité](../10-development-plan/02-matrice-tracabilite.md) : aucune exigence n'est restée sans réponse.

## 5. Plan de réalisation

Onze phases, livrées en cinq mises en production successives, chacune utilisable seule. Durée indicative : **37 à 40 semaines pour 2 développeurs**, hors recette et formation (hypothèse AV-084).

| Release | Phases | Ce que GIC obtient | Pilote |
|---|---|---|---|
| **R1** | P0 Fondations, P1 Catalogue et prix, P2 Stock, P3 CRM terrain et pointage | Stock fiable et traçable ; effort commercial mesuré ; prise de service contrôlée | Magasin central, 1 PDV, 2 commerciaux |
| **R2** | P4 Ventes et encaissements, P5 Points de vente | Vendre et encaisser partout, même hors ligne ; caisses contrôlées ; distribution par PDV | Puis tous les PDV de Douala |
| **R3** | P6 Approvisionnement, P7 Production | Achats contrôlés ; lots de volailles, œufs, incubation, porcs | 1 ferme, puis toutes |
| **R4** | P8 Finance, P9 Analyse | Coûts, marges, dettes ; tour de contrôle de la Direction ; explorateur | Direction, Finance |
| **R5** | P10 Kommo | Parcours digital continu du lead à la vente | Commerciaux sédentaires |

Détail : [`../10-development-plan/01-plan-developpement.md`](../10-development-plan/01-plan-developpement.md).

## 6. Ce que la Direction doit décider

**Avant le démarrage (P0)** : confirmer la stack (AV-089), l'hébergement et la localisation des données (AV-073), l'équipe et le budget (AV-001, AV-084), et accepter ou modifier les valeurs par défaut des règles d'accès et d'appareils (AV-004, AV-006 à AV-010, AV-075, AV-078). La liste complète est dans la [checklist de démarrage](../10-development-plan/04-checklist-demarrage.md).

**Deux décisions bloquantes, avant la phase P4 (ventes)** :

| AV | Question | Recommandation par défaut |
|---|---|---|
| AV-024 | Pour une vente sur commande, à quel moment la vente est-elle reconnue et le stock sort-il ? | À la remise physique au client (livraison) |
| AV-025 | Un vendeur hors ligne peut-il vendre au-delà de la quantité qui lui est confiée ? | Non : blocage sur l'appareil, avec message clair |

Aucune décision bloquante ne concerne la première release (R1) : elle peut être développée intégralement avec les valeurs par défaut documentées, toutes paramétrables.

## 7. Principaux risques

| Risque | Parade principale | Référence |
|---|---|---|
| Adoption insuffisante sur le terrain (retour au papier ou à WhatsApp) | Écrans orientés action, au plus 5 champs obligatoires par action courante, pilotes, formation courte | RISK-15, NFR-35 |
| Stock incohérent (pertes non déclarées, stock confié contourné) | Registre en partie double, garde exclusive, inventaires rapprochés, réconciliation quotidienne | RISK-05, NFR-38 |
| Décisions métier prises trop tard | Registre centralisé, valeurs par défaut paramétrables, revue hebdomadaire | RISK-18 |
| Appareils modestes et réseau faible | Budget de poids de l'application, tests sur un appareil de référence, synchronisation par lots | RISK-23, NFR-01, NFR-05 |
| Équipe réduite | Stack unique et mature, services managés, documentation complète | RISK-21 |

Registre complet : [`../10-development-plan/03-registre-risques.md`](../10-development-plan/03-registre-risques.md).

## 8. Verdict

Le cadrage est **suffisamment stable pour démarrer le développement de P0** dès que la [checklist de démarrage](../10-development-plan/04-checklist-demarrage.md) est cochée. L'[audit de cohérence](../10-development-plan/05-audit-coherence.md) confirme les 14 contrôles du PM §50 et liste les points fragiles à surveiller. Le [document de passage au développement](../10-development-plan/06-passage-au-developpement.md) décrit la structure du code et le backlog ordonné de P0.

Pour naviguer dans la documentation : [index maître](../README.md).
