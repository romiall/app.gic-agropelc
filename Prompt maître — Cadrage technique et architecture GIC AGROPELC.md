# MISSION — CADRAGE TECHNIQUE COMPLET AVANT DÉVELOPPEMENT

Tu interviens comme **architecte logiciel senior, analyste métier, architecte de données et lead engineer** sur le projet GIC AGROPELC.

Tu disposes dans le contexte du projet d'une spécification fonctionnelle décrivant l'application à construire.

Cette spécification constitue la **source de vérité métier initiale**.

Ta mission n'est PAS encore de développer l'application.

Ta mission est de transformer les besoins existants en un **cahier des charges fonctionnel et technique suffisamment rigoureux pour servir de référence pendant tout le développement**, empêcher les dérives fonctionnelles, réduire les hallucinations futures et permettre de construire le produit module par module sans casser sa cohérence globale.

---

# 1. RÈGLE ABSOLUE : NE PAS INVENTER LE MÉTIER

Tu dois distinguer systématiquement trois catégories d'information :

### CONFIRMÉ
Exigence explicitement présente dans les spécifications du projet.

### DÉDUIT
Décision technique ou fonctionnelle nécessaire pour rendre une exigence cohérente, mais qui n'est pas explicitement formulée dans le document.

### À VALIDER
Question métier pour laquelle plusieurs choix raisonnables existent et pour laquelle aucune décision fiable ne peut être déduite du document.

Ne transforme jamais une hypothèse en exigence métier.

Lorsque quelque chose manque :

1. signale le manque ;
2. explique son impact ;
3. propose éventuellement une valeur par défaut raisonnable ;
4. marque explicitement cette valeur comme `À VALIDER`.

Ne bloque toutefois pas toute l'analyse pour une information manquante.

Continue le cadrage avec les éléments disponibles.

---

# 2. PRINCIPES PRODUIT NON NÉGOCIABLES

L'architecture doit préserver les principes suivants.

## 2.1 Application métier intégrée

Le système couvre notamment :

- commercial ;
- CRM opérationnel ;
- prospection terrain ;
- clients ;
- commandes ;
- ventes ;
- distribution ;
- points de vente ;
- stocks ;
- production animale ;
- production d'œufs ;
- incubation ;
- porcs ;
- pertes ;
- approvisionnements ;
- fournisseurs ;
- achats ;
- réceptions ;
- intrants ;
- finance opérationnelle ;
- encaissements ;
- créances ;
- dépenses ;
- marges ;
- tableaux de bord ;
- analytics ;
- audit ;
- communication interne ;
- intégration Kommo.

Le système ne doit pas être pensé comme plusieurs mini-applications indépendantes.

Les modules doivent partager un modèle métier cohérent.

---

# 3. CHAÎNE MÉTIER PRINCIPALE

L'architecture doit être pensée autour du cycle :

**APPROVISIONNER  
→ RECEVOIR  
→ PRODUIRE  
→ STOCKER  
→ TRANSFÉRER  
→ PROSPECTER  
→ COMMANDER  
→ VENDRE  
→ LIVRER  
→ ENCAISSER  
→ ANALYSER**

Chaque événement important doit pouvoir être relié autant que possible à :

- une quantité physique ;
- une valeur financière ;
- un responsable ;
- une date réelle d'opération ;
- un site ou emplacement ;
- éventuellement un lot ;
- un appareil ;
- son état de synchronisation.

---

# 4. LES TROIS REGISTRES FONDAMENTAUX

Conçois l'architecture autour de trois dimensions cohérentes.

## Registre physique

Il répond notamment à :

- qu'avons-nous ?
- combien ?
- où ?
- provenant de quel lot ?
- transféré vers où ?
- vendu où ?
- perdu où ?

## Registre financier

Il répond notamment à :

- combien cela a coûté ?
- combien cela a rapporté ?
- combien a été encaissé ?
- combien reste à recevoir ?
- quelle marge ?
- quelle perte financière ?

## Registre de responsabilité

Il répond notamment à :

- qui a créé l'opération ?
- qui l'a validée ?
- quand l'opération s'est-elle réellement produite ?
- sur quel appareil ?
- en ligne ou hors connexion ?
- depuis quel site ou zone ?

Toute architecture proposée doit préserver la cohérence entre ces trois dimensions.

---

# 5. OFFLINE-FIRST EST UNE CONTRAINTE D'ARCHITECTURE

L'application est une application web/mobile de type PWA devant continuer à fonctionner lorsque le réseau Internet disparaît.

Le mode offline n'est PAS une fonctionnalité ajoutée ultérieurement.

Il doit influencer :

- le modèle de données ;
- les identifiants ;
- l'API ;
- les transactions ;
- l'audit ;
- la gestion des conflits ;
- les stocks ;
- les timestamps ;
- les synchronisations ;
- l'UX ;
- la gestion des appareils.

Les opérations locales doivent notamment pouvoir conserver :

- `uuid`
- `device_id`
- `user_id`
- `occurred_at`
- `created_at`
- `updated_at`
- statut de synchronisation
- version ou mécanisme équivalent de concurrence

Une opération créée hors ligne conserve comme heure métier son heure réelle d'exécution et NON l'heure ultérieure de synchronisation.

Le système doit prévoir au minimum les états conceptuels :

- LOCAL_ONLY
- PENDING_SYNC
- SYNCING
- SYNCED
- CONFLICT
- REJECTED

Tu peux améliorer cette nomenclature si nécessaire.

---

# 6. STOCK : RÈGLE ARCHITECTURALE CRITIQUE

Le stock ne doit jamais être simplement un champ `quantity` modifiable arbitrairement.

Le stock doit découler de **mouvements traçables**.

Exemples :

- réception ;
- production ;
- transfert ;
- vente ;
- consommation ;
- mortalité ;
- casse ;
- perte ;
- retour ;
- correction d'inventaire.

Conceptuellement :

**Stock disponible = somme des mouvements validés applicables.**

Un inventaire physique différent du stock théorique ne doit pas écraser le stock.

Il doit générer un mouvement d'ajustement traçable.

Prévoir également le mécanisme d'**allocation ou réservation de stock** afin d'empêcher autant que possible la double consommation d'un même stock lorsque plusieurs appareils travaillent hors connexion.

Le stock négatif volontaire ne doit pas être considéré comme le mécanisme normal de résolution des conflits.

---

# 7. HISTORISATION

Aucune modification ultérieure ne doit réécrire silencieusement l'histoire.

Exemples :

- changement de tarif ;
- changement de zone ;
- modification d'un produit ;
- changement de responsable ;
- modification de règle commerciale.

Une vente réalisée avec un prix de 4 500 FCFA doit continuer à afficher 4 500 FCFA même si le tarif devient 4 700 FCFA le lendemain.

Détermine quelles données doivent être :

- historisées ;
- versionnées ;
- snapshotées dans les transactions ;
- référencées dynamiquement.

---

# 8. SUPPRESSIONS ET ANNULATIONS

Les opérations sensibles ne doivent généralement pas être supprimées physiquement.

Exemples :

- vente ;
- encaissement ;
- réception ;
- mouvement de stock ;
- perte ;
- transfert ;
- paiement.

Prévoir selon le cas :

- annulation ;
- contre-écriture ;
- reverse movement ;
- statut annulé ;
- journal d'audit.

Identifie précisément les tables qui peuvent utiliser un soft delete et celles pour lesquelles une logique d'annulation/contre-écriture est préférable.

---

# 9. TARIFICATION

Le système doit gérer des grilles tarifaires dynamiques.

Une règle tarifaire peut potentiellement dépendre de :

- produit ;
- zone ;
- site ;
- point de vente ;
- catégorie client ;
- quantité ;
- période ;
- campagne commerciale.

Le modèle doit permettre plusieurs règles simultanément.

Définis :

- leur priorité ;
- leur niveau de spécificité ;
- leur période de validité ;
- leur historisation ;
- leur mécanisme d'application ;
- les éventuels conflits entre règles.

Chaque ligne de vente doit conserver suffisamment d'informations pour reconstruire le prix réellement appliqué.

---

# 10. PRODUCTION

Ne modélise pas tous les produits agricoles de manière naïvement identique.

Il existe différentes réalités métier.

Prévoir notamment :

### Volaille

- lots ;
- bâtiments ;
- entrée de poussins ;
- mortalité ;
- alimentation ;
- poids ;
- sorties ;
- transferts ;
- disponibilité commerciale.

### Œufs

- collecte ;
- cassés ;
- non conformes ;
- commercialisables ;
- incubation ;
- éventuel classement.

### Incubation

- lot d'œufs ;
- entrée incubateur ;
- mirage ;
- infertilité ;
- transfert éclosoir ;
- éclosion ;
- poussins obtenus.

### Porcs

- groupes/lots ;
- cases ;
- entrées ;
- alimentation ;
- poids ;
- mortalité ;
- transfert ;
- commercialisation.

Le modèle peut prévoir une identification individuelle future des animaux, mais sans rendre cette complexité obligatoire pour le MVP.

---

# 11. APPROVISIONNEMENT

Le workflow cible est conceptuellement :

**Besoin  
→ Demande d'achat  
→ Validation  
→ Bon de commande  
→ Réception  
→ Facture fournisseur  
→ Paiement**

Le modèle doit faire la différence entre :

**commandé ≠ reçu ≠ accepté ≠ facturé ≠ payé**

Une réception de 95 unités sur 100 commandées ne doit pas générer artificiellement 100 unités de stock.

---

# 12. COMMERCIAL ET CRM OPÉRATIONNEL

Le système doit gérer notamment :

- prospects ;
- clients ;
- commerciaux propriétaires ;
- secteurs ;
- visites ;
- interactions ;
- pointages ;
- commandes ;
- performances ;
- objectifs ;
- historique commercial.

Prévoir les différents profils commerciaux :

- commercial terrain ;
- commercial sédentaire ;
- vendeur point de vente ;
- responsable commercial.

Un même utilisateur peut cumuler plusieurs rôles.

Le système doit pouvoir calculer les performances sur une période libre :

- prospects créés ;
- visites ;
- conversions ;
- commandes ;
- quantité vendue ;
- CA ;
- marge ;
- clients actifs ;
- nouveaux clients ;
- panier moyen ;
- taux de réachat ;
- performance par zone ;
- performance par produit.

---

# 13. POINTAGE ET GÉOLOCALISATION

Le système doit pouvoir vérifier les prises de service à partir notamment de :

- latitude ;
- longitude ;
- précision GPS ;
- zone autorisée ;
- distance ;
- heure ;
- appareil.

Une tentative hors zone doit pouvoir être conservée dans l'audit plutôt que disparaître.

Ne pars pas du principe qu'un suivi GPS permanent est requis.

Le MVP privilégie les événements de localisation utiles :

- début de service ;
- éventuellement fin de service ;
- visites ;
- opérations géolocalisées pertinentes.

---

# 14. POINTS DE VENTE

Chaque point de vente fonctionne comme un mini-magasin.

Il possède notamment :

- son stock affecté ;
- ses vendeurs ;
- ses ventes ;
- ses pertes ;
- ses transferts ;
- son inventaire ;
- sa caisse éventuelle.

Le système doit permettre le rapprochement :

**stock théorique vs stock physique**

et demander une justification des écarts.

---

# 15. FINANCE

Le MVP vise prioritairement une **comptabilité opérationnelle/de gestion fiable**, et non la reconstruction complète d'un ERP comptable réglementaire.

Prévoir néanmoins une architecture suffisamment propre pour permettre ultérieurement une intégration comptable plus avancée.

Le MVP doit pouvoir suivre notamment :

- CA ;
- ventes ;
- encaissements ;
- créances ;
- dépenses ;
- achats ;
- fournisseurs ;
- caisse ;
- pertes ;
- coût ;
- marge ;
- valorisation du stock.

---

# 16. KOMMO

Kommo ne doit pas être dupliqué inutilement.

Principe cible :

## Kommo

- communication ;
- WhatsApp ;
- nurturing ;
- automatisations CRM ;
- pipeline relationnel/digital.

## GIC AGROPELC

- clients métier ;
- produits ;
- commandes ;
- ventes ;
- prix ;
- production ;
- stocks ;
- paiements ;
- performance opérationnelle.

Prévoir une intégration bidirectionnelle via API/webhooks.

Identifie précisément :

- les entités synchronisées ;
- leur source de vérité ;
- les identifiants externes ;
- les événements entrants ;
- les événements sortants ;
- les risques de boucle de synchronisation ;
- l'idempotence ;
- les mécanismes de retry ;
- les erreurs.

---

# 17. RBAC ET RESPONSABILITÉS

Prévoir au minimum les rôles métier suivants :

- Direction ;
- Administrateur ;
- Responsable commercial ;
- Commercial terrain ;
- Commercial sédentaire ;
- Vendeur point de vente ;
- Responsable production ;
- Responsable ferme si pertinent ;
- Magasinier ;
- Achats ;
- Comptabilité / Finance.

Un utilisateur peut posséder plusieurs rôles.

Ne te limite pas à un simple champ `role` dans la table utilisateur si cela compromet l'évolutivité.

Étudie un modèle RBAC avec :

- users ;
- roles ;
- permissions ;
- user_roles ;
- éventuellement role_permissions ;
- restrictions contextuelles par site/zone.

---

# 18. AUDIT

Définis un véritable journal d'audit.

Les opérations sensibles doivent permettre de déterminer :

- utilisateur ;
- action ;
- entité ;
- identifiant ;
- ancienne valeur si pertinente ;
- nouvelle valeur si pertinente ;
- date réelle ;
- date serveur ;
- appareil ;
- online/offline ;
- IP lorsque pertinente ;
- synchronisation ;
- validation ;
- raison éventuelle.

Explique également quelles informations doivent être immuables.

---

# 19. ANALYTICS

Les principaux modules doivent permettre une logique analytique flexible :

**Filtrer  
→ Trier  
→ Grouper  
→ Choisir les colonnes  
→ Agréger  
→ Exporter  
→ éventuellement sauvegarder la vue**

L'architecture des données doit donc faciliter des requêtes analytiques telles que :

> ventes de poulets à Douala entre deux dates groupées par commercial

ou :

> pertes par lot et motif

ou :

> CA et marge par point de vente

ou :

> prospects créés par commercial au cours du mois

Ne crée pas 100 rapports figés si quelques dimensions analytiques bien modélisées permettent d'obtenir le résultat.

---

# 20. UX

La complexité doit être dans le moteur, pas dans l'interface.

Un utilisateur opérationnel doit être orienté vers son action métier principale.

Exemples :

- PRENDRE SERVICE
- + PROSPECT
- + COMMANDE
- + NOUVELLE VENTE
- RÉCEPTIONNER
- TRANSFÉRER
- DÉCLARER UNE PERTE
- SAISIE DU JOUR

L'architecture fonctionnelle doit donc également considérer les **journées métier**, et pas uniquement des listes CRUD.

---

# 21. LIVRABLE N°1 — GLOSSAIRE MÉTIER

Commence par produire un dictionnaire des termes métier.

Pour chaque notion :

| Terme | Définition | Exemple | Entités liées | Statut |
|---|---|---|---|---|

Le statut doit être :

- CONFIRMÉ
- DÉDUIT
- À VALIDER

Évite les synonymes ambigus.

---

# 22. LIVRABLE N°2 — PÉRIMÈTRE DU SYSTÈME

Définis clairement :

### Dans le système

Fonctions dont GIC AGROPELC est responsable.

### Hors système

Fonctions gérées par :

- Kommo ;
- WhatsApp ;
- services externes ;
- éventuellement logiciel comptable externe.

### Futures extensions

Fonctions prévues mais hors MVP.

L'objectif est d'éviter les doubles responsabilités.

---

# 23. LIVRABLE N°3 — MODÈLE FONCTIONNEL COMPLET

Construis le modèle fonctionnel par domaines.

Pour chaque domaine indique :

1. objectif ;
2. acteurs ;
3. principales entités ;
4. use cases ;
5. entrées ;
6. sorties ;
7. règles métier ;
8. validations ;
9. dépendances ;
10. événements produits ;
11. événements consommés ;
12. fonctionnement offline ;
13. permissions ;
14. exceptions.

Domaines minimum :

1. Core / Administration
2. Commercial / CRM opérationnel
3. Pointage terrain
4. Distribution
5. Stocks
6. Points de vente
7. Production
8. Volaille
9. Œufs
10. Incubation
11. Porcs
12. Approvisionnement
13. Fournisseurs
14. Achats
15. Réceptions
16. Finance
17. Pricing
18. Analytics
19. Audit
20. Notifications
21. Synchronisation
22. Kommo

Fusionne les domaines lorsque cela améliore réellement la cohérence.

---

# 24. LIVRABLE N°4 — WORKFLOWS ET MACHINES À ÉTATS

Pour chaque processus important, produis une machine à états.

Minimum :

### Prospect

Exemple conceptuel :

`PROSPECT → CONTACTÉ → INTÉRESSÉ → NÉGOCIATION → CLIENT / PERDU`

Mais vérifie si cette structure doit être configurable.

### Commande client

Définis précisément ses états.

### Vente

Définis :

- brouillon ;
- confirmée ;
- payée partiellement ;
- payée ;
- annulée ;
- etc.

### Transfert de stock

### Achat

### Réception

### Paiement fournisseur

### Encaissement client

### Perte

### Inventaire

### Lot de production

### Session de travail commercial

### Synchronisation offline

Pour chaque transition :

| État initial | Action | Condition | Nouvel état | Effets métier | Effets stock | Effets finance | Permission |
|---|---|---|---|---|---|---|---|

---

# 25. LIVRABLE N°5 — MODÈLE RELATIONNEL

Construis ensuite le modèle relationnel complet.

Ne commence PAS avec une liste arbitraire de tables.

Pars :

**Domaines  
→ Entités métier  
→ relations  
→ cardinalités  
→ invariants  
→ tables**

Présente d'abord un ERD conceptuel en Mermaid.

Puis donne le dictionnaire relationnel.

Pour chaque table :

### Nom

### Responsabilité métier

### Colonnes

Pour chaque colonne :

| Colonne | Type logique | Nullable | Default | Rôle |
|---|---|---:|---|---|

Puis :

### Primary Key

### Foreign Keys

### Unique Constraints

### Check Constraints

### Index

### Relations

### Politique de suppression

### Données historisées

### Données auditables

### Comportement offline

### Règles d'intégrité

---

# 26. IDENTIFIANTS

Analyse la stratégie d'identification.

Le fonctionnement offline exige que la création d'entités puisse se faire sans demander d'identifiant au serveur.

Étudie notamment :

- UUID v4 ;
- UUID v7 ;
- ULID ;
- identifiants numériques internes éventuellement complémentaires.

Propose une stratégie cohérente et explique pourquoi.

---

# 27. TYPES DE TABLES

Classe explicitement les tables en catégories telles que :

### Référentiels

Exemple :

- produits ;
- unités ;
- zones ;
- sites ;
- motifs.

### Master Data

Exemple :

- clients ;
- fournisseurs ;
- utilisateurs.

### Transactions

Exemple :

- commandes ;
- ventes ;
- achats.

### Journaux / Ledgers

Exemple :

- mouvements de stock ;
- encaissements ;
- audit.

### Tables de liaison

### Historisation

### Synchronisation

### Intégrations externes

Cette classification doit rendre l'architecture lisible.

---

# 28. LIVRABLE N°6 — INVARIANTS MÉTIER

Écris une section spécifique appelée :

# INVARIANTS DU SYSTÈME

Ce sont les règles qui ne doivent jamais être violées.

Exemples à analyser :

- une vente synchronisée ne doit pas être créée deux fois ;
- un UUID d'opération doit être idempotent ;
- une réception ne peut alimenter le stock que pour la quantité réellement acceptée ;
- une modification tarifaire ne réécrit pas une ancienne vente ;
- un mouvement de stock doit avoir une cause ;
- une annulation de vente doit corriger le stock ;
- une transaction financière ne doit pas disparaître sans trace ;
- une quantité allouée offline ne doit pas être consommée deux fois.

Ajoute tous les invariants nécessaires.

Ce document servira ultérieurement aux tests automatisés.

---

# 29. LIVRABLE N°7 — ARCHITECTURE OFFLINE ET SYNCHRONISATION

Décris précisément :

## Données locales

Quelles données sont disponibles offline ?

## Données téléchargées

Quelles données sont synchronisées vers chaque utilisateur ?

Ne recommande pas une réplication complète de toute la base si elle est inutile.

## Outbox locale

Définis la structure conceptuelle de la file d'événements à synchroniser.

## Inbox serveur

Explique comment empêcher les doubles traitements.

## Idempotence

## Retry

## Backoff

## Conflict detection

## Conflict resolution

## Optimistic concurrency

## Versioning

## Tombstones éventuels

## Synchronisation incrémentale

## Curseurs de synchronisation

## Synchronisation des pièces jointes

## Synchronisation des photos

## États utilisateur

Exemple :

- synchronisé ;
- 5 opérations en attente ;
- erreur ;
- conflit nécessitant intervention.

Décris également le comportement lorsqu'une application reste hors connexion pendant plusieurs jours.

---

# 30. CONFLITS OFFLINE

Crée une matrice des conflits.

Exemple :

| Entité | Conflit possible | Probabilité | Gravité | Résolution |
|---|---|---:|---:|---|

Inclure au minimum :

- prospect modifié sur deux appareils ;
- client réaffecté ;
- prix changé ;
- stock vendu offline ;
- transfert concurrent ;
- produit désactivé ;
- utilisateur désactivé ;
- commande modifiée ;
- réception en double ;
- paiement en double.

Ne réponds pas systématiquement « last write wins ».

Choisis une stratégie adaptée à la criticité métier.

---

# 31. LIVRABLE N°8 — RBAC

Construis une matrice :

| Permission | Direction | Admin | Resp. commercial | Commercial | Vendeur | Production | Magasinier | Achats | Finance |
|---|---|---|---|---|---|---|---|---|---|

Ne mets pas seulement `Oui/Non`.

Prévois lorsque pertinent :

- Own
- Team
- Site
- Zone
- All
- Approve
- Read Only

Détermine également les autorisations contextuelles.

---

# 32. LIVRABLE N°9 — ARCHITECTURE API

Sans écrire encore toute l'API, définis les principaux domaines d'API.

Exemple conceptuel :

`/auth`
`/users`
`/customers`
`/prospects`
`/orders`
`/sales`
`/inventory`
`/stock-movements`
`/transfers`
`/production`
`/purchases`
`/receipts`
`/payments`
`/pricing`
`/analytics`
`/sync`
`/integrations/kommo`

Pour chaque domaine précise :

- responsabilités ;
- principales commandes ;
- principales queries ;
- événements ;
- exigences d'idempotence ;
- permissions.

N'impose pas REST si une autre architecture apporte objectivement un avantage, mais justifie toute alternative.

---

# 33. LIVRABLE N°10 — ÉVÉNEMENTS MÉTIER

Construis un catalogue des événements importants.

Exemples :

- ProspectCreated
- CustomerConverted
- OrderConfirmed
- SaleConfirmed
- PaymentReceived
- StockTransferred
- StockLossDeclared
- InventoryAdjusted
- PurchaseOrderApproved
- GoodsReceived
- ProductionRecorded
- MortalityRecorded
- PriceRuleActivated
- SyncConflictDetected

Pour chaque événement :

| Événement | Producteur | Consommateurs | Données minimum | Conséquence |
|---|---|---|---|---|

Cela ne signifie pas obligatoirement que l'application doit utiliser une architecture Event Sourcing complète.

Fais la différence entre :

- événements métier ;
- journal d'audit ;
- événements d'intégration ;
- messages de synchronisation.

---

# 34. LIVRABLE N°11 — ARCHITECTURE LOGICIELLE

Après le modèle métier et relationnel seulement, propose l'architecture applicative.

Évalue notamment :

- modular monolith ;
- microservices ;
- backend monolithique structuré ;
- BFF éventuel ;
- API ;
- worker ;
- scheduler ;
- queue ;
- stockage de fichiers ;
- cache ;
- notifications ;
- intégrations.

Le projet démarre comme un produit unique.

Ne recommande pas des microservices uniquement parce que le système comporte plusieurs domaines.

Privilégie la simplicité opérationnelle sans sacrifier les frontières fonctionnelles.

---

# 35. LIVRABLE N°12 — DÉCOUPAGE EN MODULES DE CODE

Propose des bounded contexts ou modules techniques cohérents.

Exemple indicatif :

- Identity
- Organization
- CRM
- Sales
- Pricing
- Inventory
- Production
- Procurement
- Finance
- Analytics
- Audit
- Sync
- Integrations

Pour chaque module :

- responsabilité ;
- tables possédées ;
- API exposées ;
- événements publiés ;
- dépendances autorisées ;
- dépendances interdites.

Évite un système dans lequel n'importe quel module peut modifier directement les tables de tous les autres.

---

# 36. LIVRABLE N°13 — EXIGENCES NON FONCTIONNELLES

Formalise les exigences relatives à :

- offline-first ;
- disponibilité ;
- performance ;
- sécurité ;
- authentification ;
- autorisation ;
- audit ;
- confidentialité ;
- intégrité ;
- sauvegardes ;
- restauration ;
- observabilité ;
- logs ;
- monitoring ;
- synchronisation ;
- compatibilité mobile ;
- PWA ;
- bande passante réduite ;
- appareils Android modestes ;
- résilience réseau ;
- évolutivité ;
- maintenabilité.

Pour chaque exigence, définis si possible une cible mesurable.

---

# 37. LIVRABLE N°14 — STRATÉGIE DE SÉCURITÉ

Analyse notamment :

- authentification ;
- gestion des sessions ;
- refresh tokens ;
- révocation ;
- appareils autorisés ;
- RBAC ;
- contrôle côté serveur ;
- géolocalisation ;
- pièces justificatives ;
- chiffrement en transit ;
- données locales sensibles ;
- stockage offline ;
- protection de l'API ;
- rate limiting ;
- journalisation ;
- fraude interne ;
- usurpation d'identité ;
- injection ;
- IDOR ;
- modification de prix ;
- manipulation de stock ;
- double paiement ;
- synchronisation falsifiée.

Ne considère jamais l'interface cliente comme une autorité de confiance.

---

# 38. LIVRABLE N°15 — PLAN DE DÉVELOPPEMENT

Une fois l'architecture stabilisée, propose un plan de réalisation.

Ne découpe pas uniquement par pages.

Découpe par **vertical slices fonctionnelles utilisables**.

Chaque phase doit produire quelque chose de testable.

Présente :

| Phase | Objectif | Fonctionnalités | Dépendances | Livrable | Tests de sortie |
|---|---|---|---|---|---|

Le plan doit commencer par les fondations nécessaires au reste du projet.

---

# 39. ORDRE DE CONSTRUCTION

Évalue explicitement un ordre proche de :

### Phase 0 — Fondations

- repository ;
- conventions ;
- architecture ;
- environnement ;
- DB ;
- migrations ;
- auth ;
- utilisateurs ;
- RBAC ;
- sites ;
- zones ;
- appareils ;
- audit ;
- sync skeleton.

### Phase 1 — Référentiels métier

- produits ;
- catégories ;
- unités ;
- sites ;
- emplacements ;
- clients ;
- fournisseurs ;
- tarifs.

### Phase 2 — Stock et mouvements

Parce que de nombreux autres modules en dépendent.

### Phase 3 — Commercial / CRM terrain

### Phase 4 — Commandes / ventes / encaissements

### Phase 5 — Distribution / points de vente

### Phase 6 — Production

### Phase 7 — Approvisionnement

### Phase 8 — Finance opérationnelle

### Phase 9 — Analytics / direction

### Phase 10 — Kommo

Ce découpage n'est qu'un point de départ.

Corrige-le si les dépendances réelles exigent un autre ordre.

---

# 40. POUR CHAQUE PHASE

Donne :

### Objectif métier

### Entités concernées

### Tables créées

### API nécessaires

### Interfaces principales

### Workflows

### Permissions

### Offline

### Tests unitaires

### Tests d'intégration

### Tests E2E

### Critères d'acceptation

### Prérequis

### Risques

### Définition de "Done"

---

# 41. LIVRABLE N°16 — DÉPENDANCES ENTRE MODULES

Construis un graphe de dépendances.

Exemple :

`Identity`
↓
`Organizations / Sites`
↓
`Catalog`
↓
`Inventory`
↓
`Sales`

etc.

Indique les modules qui peuvent être développés parallèlement et ceux qui sont bloquants.

---

# 42. LIVRABLE N°17 — MATRICE DE TRAÇABILITÉ

Construis un tableau reliant :

**Besoin métier  
→ règle métier  
→ module  
→ entités  
→ tables  
→ API  
→ écran  
→ test d'acceptation**

Cette matrice doit permettre ultérieurement de vérifier qu'une exigence initiale n'a pas disparu pendant le développement.

---

# 43. LIVRABLE N°18 — REGISTRE DES DÉCISIONS D'ARCHITECTURE

Crée les premières ADR — Architecture Decision Records.

Minimum :

- ADR-001 : Offline-first
- ADR-002 : stratégie d'identifiants
- ADR-003 : mouvements de stock
- ADR-004 : allocations offline
- ADR-005 : historisation des prix
- ADR-006 : annulation vs suppression
- ADR-007 : stratégie de synchronisation
- ADR-008 : modèle RBAC
- ADR-009 : frontières avec Kommo
- ADR-010 : stratégie comptabilité opérationnelle
- ADR-011 : architecture backend
- ADR-012 : pièces jointes offline

Pour chaque ADR :

**Contexte  
Décision  
Alternatives étudiées  
Justification  
Conséquences  
Risques**

---

# 44. LIVRABLE N°19 — RISQUES TECHNIQUES

Construis un registre :

| Risque | Probabilité | Impact | Cause | Prévention | Détection | Mitigation |
|---|---:|---:|---|---|---|---|

Étudie au minimum :

- corruption de données offline ;
- doubles ventes ;
- doubles synchronisations ;
- double réception ;
- stock incohérent ;
- prix obsolète offline ;
- appareil perdu ;
- utilisateur révoqué pendant qu'il est offline ;
- horloge locale incorrecte ;
- conflit de modification ;
- upload photo interrompu ;
- croissance des journaux ;
- analytics trop coûteux ;
- mauvaise intégration Kommo.

---

# 45. LIVRABLE N°20 — QUESTIONS OUVERTES

À la fin seulement, crée une liste des décisions métier restant à prendre.

Classe-les :

### BLOQUANTE

Empêche de construire correctement une partie fondamentale.

### IMPORTANTE

Peut être décidée pendant le développement.

### SECONDAIRE

Peut rester configurable ou être reportée.

Pour chacune :

- question ;
- pourquoi elle importe ;
- choix possibles ;
- option que tu recommanderais par défaut ;
- impact du choix.

---

# 46. STACK TECHNIQUE

Ne choisis pas la stack avant d'avoir terminé l'analyse fonctionnelle, le modèle de données et l'architecture.

À la fin seulement, propose une stack adaptée aux contraintes :

- application web ;
- mobile-first ;
- PWA ;
- offline-first ;
- IndexedDB ou équivalent ;
- synchronisation robuste ;
- backend API ;
- base relationnelle ;
- fichiers/photos ;
- intégration Kommo ;
- environnement de production réaliste ;
- coût d'exploitation raisonnable.

Pour chaque composant de la stack :

| Besoin | Technologie | Pourquoi | Alternative |
|---|---|---|---|

Privilégie les technologies matures, documentées et maintenables.

---

# 47. BASE DE DONNÉES

Le domaine étant hautement relationnel, considère une base relationnelle comme option naturelle.

Mais justifie précisément le choix final.

Analyse notamment :

- PostgreSQL ;
- MySQL ;
- contraintes ;
- transactions ;
- JSON éventuel ;
- index ;
- reporting ;
- concurrence ;
- migrations.

Ne choisis pas une base NoSQL simplement pour simplifier le développement frontend.

---

# 48. FORMAT FINAL DU DOCUMENT

Livre un document structuré exactement dans cet ordre :

1. Executive Summary
2. Vision système
3. Hypothèses et limites
4. Glossaire métier
5. Périmètre
6. Acteurs et rôles
7. Domaines fonctionnels
8. Workflows
9. Machines à états
10. Règles métier
11. Invariants
12. Modèle conceptuel de données
13. ERD Mermaid
14. Modèle relationnel détaillé
15. Dictionnaire de données
16. Stratégie stock
17. Stratégie pricing
18. Architecture offline-first
19. Stratégie de synchronisation
20. Matrice des conflits
21. RBAC
22. Architecture API
23. Catalogue d'événements
24. Intégration Kommo
25. Architecture logicielle
26. Modules de code
27. Exigences non fonctionnelles
28. Sécurité
29. Observabilité
30. Plan de tests
31. Architecture de déploiement
32. Plan de développement
33. Graphe de dépendances
34. Matrice de traçabilité
35. ADR
36. Registre des risques
37. Questions ouvertes
38. Recommandation de stack
39. Checklist avant démarrage du développement

---

# 49. NIVEAU DE DÉTAIL ATTENDU

Ce document n'est pas une présentation commerciale.

C'est un **référentiel d'ingénierie**.

Évite :

- les paragraphes génériques ;
- les formulations vagues ;
- les conseils du type « prévoir une bonne sécurité » ;
- les tables créées sans justification métier ;
- les champs ajoutés arbitrairement ;
- les duplications ;
- les architectures inutilement complexes.

Je veux des décisions concrètes et vérifiables.

Lorsque tu proposes une table, explique ce qu'elle représente.

Lorsque tu proposes un état, explique comment on y entre et comment on en sort.

Lorsque tu proposes une contrainte, explique quel problème elle empêche.

Lorsque tu proposes un workflow, montre ses effets sur :

- stock ;
- finance ;
- audit ;
- synchronisation.

---

# 50. RÈGLE DE COHÉRENCE FINALE

À la fin de ton travail, effectue toi-même un contrôle de cohérence.

Vérifie notamment que :

- chaque besoin majeur possède une réponse architecturale ;
- chaque module possède les entités nécessaires ;
- chaque entité possède une responsabilité claire ;
- aucune table fondamentale n'a plusieurs sources de vérité contradictoires ;
- le stock reste traçable ;
- les prix sont historisés ;
- les ventes restent auditables ;
- l'offline ne permet pas facilement la double consommation de stock ;
- les timestamps offline sont conservés ;
- les synchronisations sont idempotentes ;
- les rôles sont cohérents ;
- Kommo et AGROPELC ne se disputent pas la même responsabilité ;
- les anciennes données ne changent pas à cause d'une modification de paramétrage ;
- le MVP reste exploitable sans nécessiter toutes les futures fonctionnalités.

Termine par une section :

# AUDIT DE COHÉRENCE DU CAHIER DES CHARGES

avec :

- incohérences détectées ;
- ambiguïtés restantes ;
- points fragiles ;
- risques de dette technique ;
- éléments suffisamment stabilisés pour commencer le développement.

---

# 51. IMPORTANT : NE CODE PAS ENCORE L'APPLICATION

Tu peux produire :

- Mermaid ;
- pseudo-modèles ;
- schémas ;
- signatures conceptuelles ;
- exemples SQL très courts uniquement lorsqu'ils servent à expliquer une contrainte.

Mais ne génère PAS encore :

- les pages de l'application ;
- le frontend ;
- les composants UI ;
- les contrôleurs complets ;
- les migrations complètes ;
- les centaines de endpoints ;
- l'application elle-même.

La finalité de cette étape est :

> **stabiliser le système avant de produire du code.**

Lorsque le document est terminé, il doit être suffisamment précis pour qu'un autre ingénieur ou une autre IA puisse prendre une phase du projet, lire les spécifications correspondantes et la développer sans inventer la logique métier.