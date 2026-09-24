# Plan de tests

> Section 30 du format final (PM §48). Les critères de sortie par phase sont dans le plan de développement. Les invariants (`INV-*`) sont la base des tests de propriété et d'intégration (PM §28).

---

## 1. Stratégie par niveau

| Niveau | Cible | Outils (voir la stack) | Déclenchement |
|---|---|---|---|
| **Unitaire** | Bibliothèque métier partagée : moteur de prix, conversions d'unités, arrondis, évaluation des politiques, calculs de disponibilité et d'allocation, transitions des machines à états, validations de schémas | Framework de test TypeScript | Chaque commit |
| **Propriété (génératif)** | Invariants algébriques : conservation du stock, idempotence, arrondis, déterminisme du prix, bilans (œufs, incubation), affectations ≤ montants | Bibliothèque de tests de propriétés | Chaque commit |
| **Intégration** | Gestionnaires de commandes sur **MySQL réel** (conteneur jetable, ADR-023) : transactions, contraintes, déclencheurs d'immuabilité, unicités conditionnelles (colonnes générées), non-chevauchements (verrou + déclencheur) | Conteneurs de test | Chaque commit |
| **Portée analytique** | Un test de propriété par (rôle × jeu de faits `analytics.f_*`) : aucune ligne hors portée jamais renvoyée par `scopeFilter` — remplace la défense en profondeur RLS, absente en MySQL (RISK-28) | Tests générés | Chaque commit |
| **Contrat** | Schémas de commandes et de jeux de synchronisation partagés entre PWA et serveur ; compatibilité N-1 | Tests de schémas versionnés | Chaque commit |
| **Scénarios de synchronisation** | Appareils simulés : hors ligne, rejeux, coupures au milieu d'un lot, désordre, horloges faussées, périodes de plusieurs jours, révocations | Harnais de simulation (plusieurs clients virtuels contre un serveur de test) | Chaque commit (sous-ensemble) ; nightly (complet) |
| **RBAC généré** | Pour chaque (rôle, permission) de la matrice : accès dans la portée, refus hors portée, refus sans permission | Tests générés depuis la matrice (données de référence) | Chaque commit |
| **E2E** | Parcours WF-J1 à J8 ; mode hors ligne réel (réseau coupé), réseau dégradé (2G), serveur arrêté ; profil d'appareil modeste (CPU ×4, mémoire limitée) | Playwright (Chromium ; émulation mobile) | Chaque fusion vers la branche principale ; nightly |
| **Performance** | NFR-10 à NFR-14, NFR-19 ; charge à 1× et 10× H-06 | k6 (ou équivalent) | Avant chaque mise en production de phase |
| **Sécurité** | IDOR (tests générés), injection, limitation de débit, jetons (rotation, réutilisation), webhooks non authentifiés, en-têtes ; analyse des dépendances | Tests automatisés + analyse statique ; test d'intrusion externe (après R2) | Chaque commit / par phase |
| **Migration** | Montée de version sur une copie anonymisée ; expand/contract ; reconstruction des projections | Scripts | Avant chaque mise en production |
| **Recette métier (UAT)** | Tests d'acceptation AT-* avec les utilisateurs pilotes | Scénarios guidés | Fin de phase |

## 2. Données de test

- **Jeu de référence synthétique** : 2 fermes, 1 magasin central, 3 PDV (Douala : Mboppi, Sandaga ; Yaoundé : Mokolo), 8 commerciaux, 3 vendeurs, 60 produits, 500 clients, 4 lots actifs.
- Générateurs de données aléatoires cohérentes (factories) pour les tests de propriété et de charge.
- **Aucune donnée de production** hors environnement de production, sauf copie anonymisée (pseudonymisation des personnes et des téléphones).

## 3. Harnais de synchronisation

Un harnais crée N appareils virtuels (clients de la bibliothèque de synchronisation réelle, stockage en mémoire) contre un serveur de test. Il pilote :

- la coupure réseau par appareil ;
- la perte de réponse (la commande est appliquée mais la réponse est perdue, ce qui teste l'idempotence) ;
- le rejeu d'un lot ;
- l'inversion d'ordre de lots ;
- l'avance ou le retard d'horloge ;
- la révocation d'appareil ou d'utilisateur pendant une période hors ligne ;
- la réaffectation de portefeuille ;
- les changements de prix ;
- les inventaires concurrents.

À la fin de chaque scénario, il vérifie **tous** les invariants (§4) et l'égalité de l'état local de chaque appareil avec le serveur après un pull complet.

## 4. Couverture des invariants

| Invariants | Type de test principal |
|---|---|
| INV-GLO-01, 03, 04, 05, 07 | Intégration (déclencheurs, droits, unicités) ; revue CI (imports) |
| INV-GLO-02, 06 | Unitaire + propriété |
| INV-SYN-01 à 06 | Scénarios de synchronisation + propriété (rejeu arbitraire) |
| INV-STK-01, 03, 04 | Propriété (séquences aléatoires de mouvements ; reconstruction des soldes) + réconciliation |
| INV-STK-02, 06, 07, 08, 12 à 16 | Intégration |
| INV-STK-05, 09, 10, 11 | Scénarios de synchronisation |
| INV-VEN-*, INV-FIN-* | Intégration + propriété (montants, affectations) |
| INV-CRM-*, INV-TER-* | Intégration (exclusions, unicités) |
| INV-PRD-*, INV-OEU-01, INV-INC-01 | Unitaire + intégration |
| INV-APP-* | Intégration + scénario (réception en double) |
| INV-PRX-01 à 03 | Intégration ; INV-PRX-04 : propriété croisée appareil / serveur (même jeu de règles, contextes aléatoires) |
| INV-ADM-*, INV-AUD-*, INV-KOM-*, INV-NOT-01, INV-CAT-01 | Intégration |

Règle (NFR-31) : un invariant sans test est un défaut bloquant pour la mise en production de la phase qui le concerne.

## 5. Tests RBAC générés

La matrice RBAC est stockée comme données de référence (seed). Le générateur produit, pour chaque (rôle, permission, portée), trois cas :

1. action dans la portée → autorisée ;
2. même action sur une ressource hors portée → `404` (lecture) ou `FORBIDDEN_SCOPE` (commande) ;
3. rôle sans la permission → refus.

Un test vérifie aussi que chaque endpoint déclaré dans l'API est couvert (NFR-24).

## 6. Tests d'acceptation (AT)

Chaque test d'acceptation est rattaché aux exigences dans la matrice de traçabilité. « Données » = jeu de référence.

| ID | Scénario | Résultat attendu | Réf. |
|---|---|---|---|
| AT-001 | Vente hors ligne au PDV à 11:47, synchronisée à 14:22 | Vente datée de 11:47 ; stock, caisse, CA et audit corrects ; `captured_offline` vrai ; délai de synchronisation tracé | WF-01, REQ-062, REQ-063 |
| AT-002 | Même lot de synchronisation envoyé deux fois (réponse perdue) | Une seule vente, un seul encaissement, un seul mouvement | INV-SYN-01, REQ-202 |
| AT-003 | Vendeur hors ligne qui tente de dépasser son allocation | Blocage sur l'appareil avec message clair | AV-025, REQ-064 |
| AT-004 | Trois tablettes d'un PDV partagé, hors ligne, avec quotas | Aucun solde négatif ; quotas consommés ; libération en fin de journée | WF-18, INV-STK-10 |
| AT-005 | Vente hors ligne à un prix devenu obsolète | Vente acceptée au prix figé ; anomalie `PRICE_MISMATCH` | AV-063, WF-14 |
| AT-006 | Règle à date d'effet future téléchargée, puis appareil hors ligne à la date d'effet | Nouveau prix appliqué automatiquement | BR-PRX-011, REQ-049 |
| AT-007 | Changement du prix de 4 500 à 4 800 | La vente antérieure reste à 4 500, avec sa règle et sa version | REQ-050, INV-VEN-05 |
| AT-008 | Commande, réservation, acompte, livraison partielle, puis solde | Reliquat ; acompte transféré ; ventes partielles ; statut de commande | WF-02, SM-ORDER |
| AT-009 | Annulation directe dans les 15 min | Mouvements inverses, remboursement, CA négatif daté de l'annulation | SM-SALE, REQ-066 |
| AT-010 | Annulation hors délai | Demande de validation ; auto-validation refusée ; validation par un autre utilisateur | AV-030, INV-ADM-02 |
| AT-011 | Première vente à un prospect | Conversion en client ; KPI « nouveaux clients » | BR-CRM-010, REQ-010 |
| AT-012 | Même prospect créé sur deux appareils hors ligne | Conflit `DUPLICATE_CUSTOMER` ; fusion ; acquéreur le plus ancien | BR-CRM-007, REQ-011 |
| AT-013 | Réaffectation d'un client | Ventes passées attribuées à l'ancien titulaire ; ventes futures au nouveau ; historique visible | REQ-013, INV-VEN-10 |
| AT-014 | Prise de service à 180 m (acceptée), à 1,8 km (refusée), puis dérogation | Résultats corrects ; tentative refusée conservée ; session avec dérogation validée | REQ-018 à 020 |
| AT-015 | Performance d'un commercial : aujourd'hui, semaine, plage libre | Chiffres égaux aux opérations sous-jacentes | REQ-015 à 017 |
| AT-016 | Transfert de 58 plateaux, 57 reçus | Écart en perte en transit validée ; conservation respectée | WF-05, REQ-039 |
| AT-017 | Réception sans document au PDV hors ligne, puis arrivée de l'expédition | Rapprochement automatique ; transit à zéro | BR-STK-024 |
| AT-018 | 50 poulets affectés à un commercial ; ventes, perte, retour | Solde mobile nul ; responsabilité soldée | WF-06, REQ-040 |
| AT-019 | Perte de 600 000 XAF | `V_PENDING_LOSS` (indisponible) ; photo exigée avant approbation ; validation | WF-07, REQ-042 |
| AT-020 | Rejet d'une perte pour erreur de déclaration | Retour de la quantité en stock | SM-LOSS, AV-038 |
| AT-021 | Inventaire : théorique 100, compté 97, puis vente tardive antérieure | Écart −3 visible et justifié ; rapprochement : écart net −2 ; solde à `counted_at` = compté | WF-08, REQ-043, INV-STK-09 |
| AT-022 | Tentative de modifier un solde directement (API ou base) | Impossible : aucune API ; `UPDATE` et `DELETE` refusés | REQ-037, INV-STK-01 |
| AT-023 | BC de 100, livré 98, rejeté 3 | Stock +95 ; reliquat 5 ; CMUP recalculé | REQ-046, REQ-047 |
| AT-024 | Même BL réceptionné deux fois | Seconde réception en quarantaine, sans effet stock | INV-APP-03 |
| AT-025 | Facture de 98 sacs pour 95 acceptés ; paiement > seuil | `MISMATCH` → décision ; dette ; validation Direction avant décaissement | WF-09, REQ-044 |
| AT-026 | Cycle complet d'un lot de 2 400 poulets | Effectif, mortalité, coût par tête, CA, marge conformes à l'exemple de la stratégie finance | WF-10, REQ-053, REQ-081 |
| AT-027 | Mortalité de 30 têtes sur un lot de 2 000 | Validation requise ; alerte `HIGH_MORTALITY` immédiate | AV-048, REQ-030 |
| AT-028 | Collecte : 1 850 = 25 + 15 + 1 690 + 120 | Seuls 1 690 et 120 entrent en stock ; déséquilibre refusé | REQ-031, INV-OEU-01 |
| AT-029 | Incubation de 600 œufs | Bilan juste ; taux d'éclosion 83 % | WF-12, REQ-033 |
| AT-030 | Même référence mobile money saisie deux fois | Second encaissement `SUSPECT_DUPLICATE`, sans effet de trésorerie | INV-FIN-03 |
| AT-031 | Clôture de caisse avec un écart de −500, puis vente tardive | Écart validé ; réévaluation de la session | WF-15, SM-CASH-SESSION |
| AT-032 | Créance échue | Alerte `OVERDUE_RECEIVABLE` ; règlement affecté aux plus anciennes | BR-FIN-004, BR-FIN-007 |
| AT-033 | Commercial A qui tente de lire un client de B ; magasinier sur un écran de stock | 404 ; valeurs masquées pour le magasinier | REQ-073, RC-05 |
| AT-034 | Utilisateur désactivé avec des commandes hors ligne avant et après la désactivation | Avant : appliquées ; après : quarantaine | BR-ADM-002 |
| AT-035 | Appareil déclaré perdu | Quarantaine des commandes postérieures ; effacement local sauf outbox | SM-DEVICE, INV-ADM-03 |
| AT-036 | Horloge d'appareil décalée de 2 h | `clock_suspect` ; alerte ; `occurred_at` non corrigé | ADR-016, REQ-063 |
| AT-037 | 7 jours hors ligne puis reconnexion | Lecture seule à J7 ; envoi complet ; rejets expliqués | WF-16, AV-009 |
| AT-038 | « Combien de poulets réellement disponibles à Douala ? » | Somme correcte (zone et sous-zones, réservations déduites) | REQ-084, stratégie stock §4 |
| AT-039 | « Combien vendu cette semaine, par quel commercial, à quels clients ? » | Tableau de bord = explorateur = documents | REQ-084, BR-ANA-009 |
| AT-040 | « Combien réellement encaissé ? » | Encaissé distinct du CA ; créances cohérentes | REQ-084, REQ-051 |
| AT-041 | « Quelles pertes ? Combien a coûté cette production ? » | Pertes par produit, lot et motif ; coût du lot | REQ-084, REQ-053 |
| AT-042 | « Quelle quantité envoyée à ce PDV ? » | Envoyé, reçu, vendu, perdu, restant, encaissé | REQ-024, BR-DIS-010 |
| AT-043 | « Pourquoi manque-t-il 5 unités ? » | Remontée du registre jusqu'aux documents, auteurs et appareils | REQ-083, REQ-084 |
| AT-044 | Lead Kommo qualifié → client → vente | Compte GIC créé et lié ; CA cumulé dans Kommo ; écho ignoré | WF-17, REQ-071 |
| AT-045 | Enquête d'audit sur une vente annulée | Qui, quand (réel et serveur), appareil, hors ligne, validateur, avant et après ; chaîne vérifiée | REQ-065, INV-AUD-01 |
| AT-046 | Export de ventes par un responsable commercial | Limité à son équipe ; export audité | BR-ANA-007, 008 |
| AT-047 | Stock sous le seuil, puis réapprovisionnement | Une seule alerte, résolue automatiquement | BR-NOT-002, 003 |
| AT-048 | Note de direction à accusé de lecture | Lue et accusée hors ligne ; synchronisée | REQ-068 |
| AT-049 | Solde négatif provoqué par une vente hors ligne | Conflit `STOCK_NEGATIVE` ; résolution par inventaire ; conflit fermé | INV-STK-05, C-08 |
| AT-050 | Mise à jour de l'application avec des commandes N-1 en attente | Commandes acceptées ; mise à jour activée ensuite | BR-SYN-016 |
| AT-051 | Visite hors ligne d'un client géolocalisé, saisie à 800 m de sa position, sans session de travail ouverte | Visite appliquée avec `far_from_customer` et `out_of_session` visibles du responsable ; comptée dans « prospects visités » ; non modifiable après synchronisation (correction = annulation + nouvelle visite) | REQ-009, BR-CRM-012, BR-CRM-013, BR-CRM-015, BR-CRM-016 |
| AT-052 | Groupe de 40 porcs réparti sur 2 cases ; déplacement de 5 têtes d'une case à l'autre ; pesée d'échantillon ; vente de 3 têtes | Effectif par case = solde par emplacement ; effectif du groupe inchangé par le déplacement ; vente à la tête ou au kilo vif selon le mode de tarification (AV-031) ; aucun identifiant individuel demandé | REQ-034, REQ-035, BR-POR-001 à 004 |
| AT-053 | Ajout par l'Admin d'une nouvelle catégorie d'œufs (ex. gros calibre) | Nouveau produit et nouveau champ de collecte utilisables sans modification du modèle de mouvement ; collectes antérieures inchangées | REQ-032, BR-OEU-006 |
| AT-054 | Indicateur « ventes de la semaine » lu sur le tableau commercial, la tour de contrôle et l'explorateur, pour le même périmètre | Valeurs identiques ; un commercial ne voit que ses lignes (portée OWN) ; sans `inventory.valuation.read`, aucun coût ni marge affiché | REQ-017, REQ-055, REQ-056, REQ-059, BR-ANA-004, BR-ANA-009 |
| AT-055 | Ajout, dans une branche, d'un import interdit entre modules (ex. `inventory` qui importe `sales`) | CI en échec sur le contrôle des frontières de modules | REQ-082, REQ-214, NFR-32 |

## 7. Critères de sortie d'une phase (rappel)

1. Tests unitaires, de propriété, d'intégration et RBAC verts ; couverture conforme à NFR-31.
2. Scénarios de synchronisation de la phase verts (nightly de 3 jours consécutifs).
3. Tests d'acceptation de la phase validés par les utilisateurs pilotes.
4. Cibles NFR de la phase mesurées.
5. Zéro défaut bloquant ou critique ouvert.
