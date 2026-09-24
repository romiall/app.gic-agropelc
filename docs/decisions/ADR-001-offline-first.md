# ADR-001 — Offline-first : PWA, base locale, commandes, serveur autoritaire

- **Statut** : ACCEPTÉ (cadrage), contrainte CONFIRMÉE (CM §37 ; PM §5)
- **Date** : 24/09/2026

## Contexte
Commerciaux, vendeurs, magasiniers et fermes travaillent avec une connexion lente, intermittente ou absente (CM §37). L'absence de réseau ne doit pas empêcher une vente, un prospect, une visite, certaines pertes et les opérations de terrain. L'heure réelle doit être conservée (CM §38). Le PM impose une PWA et fait de l'offline une contrainte d'architecture (PM §5).

## Décision
1. Application **PWA** installable, dont le shell est mis en cache par un service worker versionné.
2. **Base locale IndexedDB** contenant un sous-ensemble de données limité au **périmètre** de l'utilisateur (ADR-007).
3. **Chemin d'écriture unique** : toute écriture est une **commande** (intention) placée dans une **outbox** locale, puis envoyée dès que possible, y compris en ligne.
4. Le serveur est **autoritaire** : il revalide tout ; les effets locaux sont provisoires et annulés en cas de rejet ou de conflit.
5. **Même code métier** côté appareil et serveur (bibliothèque partagée, ADR-021).
6. Autonomie bornée (AV-009) et verrouillage par PIN.

## Alternatives étudiées
- **En ligne uniquement avec cache de lecture** : contraire au CM §37.
- **Réplication complète de base** (CouchDB/PouchDB, bases de synchronisation génériques) : réplication d'états et non d'intentions ; conflits résolus au niveau des documents (dernier écrit) ; pas de contrôle métier serveur ; rejeté par le PM §29 (« pas de réplication complète ») et le PM §30 (pas de LWW).
- **Application native** : meilleurs accès système (GPS, arrière-plan), mais coût double et diffusion plus lourde ; conservée comme extension (F-18).

## Justification
Les commandes idempotentes portent **l'intention métier**. Le serveur peut donc appliquer les règles (stock, prix, droits) et tracer précisément (audit). La PWA suffit pour la cible Android et Chrome, avec un coût de diffusion nul.

## Conséquences
- Identifiants générés sur l'appareil (ADR-002) ; temps métier distinct (ADR-016).
- Protocole de synchronisation dédié (ADR-007), matrice des conflits, harnais de tests de synchronisation.
- UX : états de synchronisation visibles en permanence.

## Risques
RISK-01, RISK-07, RISK-16, RISK-23.
