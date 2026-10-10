# ADR-034 — Niveau d'isolation choisi par commande : lecture confirmée pour les sessions de caisse

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; sans effet sur une règle métier)
- **Date** : 10/10/2026

## Contexte

Le pipeline de commandes (`apps/server/src/commands/command-pipeline.service.ts`, étape 6) ouvre une transaction par commande, à l'isolation de la connexion : la **lecture répétable** d'InnoDB. À ce niveau, une lecture verrouillante (`SELECT … FOR UPDATE`) qui parcourt une plage d'index pose aussi des **verrous de plage** (*gap locks*, *next-key locks*) sur les intervalles entre les lignes lues.

Les commandes de session de caisse de P5-12 (`finance.cash_session.open`, `.close`, `.force_close`) verrouillent les sessions d'une caisse à partir d'un instant (`lockAccountSessionsFrom`, `finance/application/cash-session-ledger.ts`) avant d'en insérer une. Les identifiants sont des UUIDv7, donc voisins dans l'index. Deux ouvertures concurrentes sur **deux caisses différentes** posaient ainsi des verrous de plage qui se chevauchaient, puis chacune attendait l'insertion de l'autre : interblocage MySQL, erreur non métier, commande rejouée (`RETRY_LATER`). La revue adverse de P5-12 l'a confirmé le 10/10/2026.

Ces commandes n'ont pas besoin des verrous de plage. Elles sérialisent déjà leurs écritures sous un verrou de ligne explicite sur la caisse (`finance_cash_accounts`, exclusif), pris avant toute lecture des sessions (ordre de verrouillage écrit dans D05 §15).

## Décision

1. **Option par commande.** Le registre des gestionnaires (`platform/sync/command-handler-registry.ts`) accepte une option facultative `isolationLevel` à l'enregistrement d'une commande. Seule valeur admise : `'read committed'` (type `CommandIsolationLevel`). Sans l'option, rien ne change : l'isolation reste celle de la connexion.
2. **Application par le pipeline.** Le pipeline applique `setIsolationLevel` à la transaction métier de l'étape 6 quand l'entrée du registre le demande. Aucune autre étape n'est touchée : inbox, idempotence et journal d'audit restent dans leur propre transaction, à l'isolation par défaut.
3. **Usage réservé.** Une commande ne demande la lecture confirmée que si elle remplit deux conditions :
   - elle sérialise ses écritures sous un verrou de ligne explicite, pris avant ses lectures ;
   - ses lectures verrouillantes par plage n'ont pas besoin de protéger l'absence de lignes, ce que le verrou de ligne garantit déjà.

   Au 10/10/2026, seules les trois commandes de session de caisse le font.

## Alternatives

- **Lecture confirmée pour toutes les commandes**, réglée sur la connexion : change la sémantique de toutes les commandes existantes, dont certaines peuvent reposer sur la lecture répétable (unicités vérifiées en code, sommes relues dans la transaction ; DÉDUIT, non audité commande par commande). Écartée.
- **Supprimer les lectures par plage** et ne verrouiller que la caisse : la clôture et la fusion d'une ouverture hors ligne lisent toutes les sessions qui chevauchent une fenêtre. Sans verrou sur ces sessions, une réévaluation concurrente (P5-13) pourrait lire une session périmée. Écartée.
- **Rejouer l'interblocage** et s'en remettre au `RETRY_LATER` du pipeline : il est transitoire, mais P5-12 l'a mesuré sur 7 tours sur 8 d'ouvertures parallèles de deux caisses vierges (D05 §15) ; chaque ouverture simultanée de caisses voisines serait retardée. Écartée.

## Conséquences

- **Contrainte d'exploitation** : la lecture confirmée exige, quand la journalisation binaire est active, `binlog_format = ROW` (ou `MIXED`). Avec le format `STATEMENT`, InnoDB refuse d'écrire. C'est le cas du poste de développement (MySQL 8.4 : `ROW`) et la valeur par défaut de MySQL 8 ; le MySQL managé de production (ADR-023, ADR-024) devra être vérifié lors du déploiement de `staging` (P0-17). D'autres commandes de caisse présentent la même famille de verrous de plage (remises de fonds de P5-15, `recordCashMovement` sur deux caisses neuves). Leur interblocage reste possible et transitoire : il sera traité avec l'ordre de verrouillage global en P5-22.
- Toute nouvelle commande qui demande la lecture confirmée doit justifier les deux conditions du point 3 dans son commentaire d'enregistrement, et un test de concurrence doit le prouver.
- Références : D05 §15 (ordre des verrous des sessions de caisse), 05-architecture/01-architecture-logicielle.md §4, ADR-032.
