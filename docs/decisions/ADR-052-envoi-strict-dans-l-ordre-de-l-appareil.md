# ADR-052 — Envoi de l'appareil dans l'ordre strict, renvois distingués par motif

- **Statut** : PROPOSÉ (fork « Écrans PWA », phase des écrans de P5, numéro de fork à renuméroter à l'intégration ; DÉDUIT, technique)
- **Date** : 12/10/2026
- **Révise** : [ADR-037](ADR-037-synchronisation-appareil-durcie.md) §11 (« dépendance d'abord ») ; précise §12

## Contexte

ADR-037 §11 retenait sur l'appareil une commande dont une dépendance (`depends_on`) attendait encore sa réponse, et laissait partir les commandes qui la suivaient. Il contournait un défaut du serveur : une dépendance seulement reçue, ou en échec passager, faisait refuser définitivement la commande dépendante (S-17).

Depuis P5-21 (AV-210, `e07a608`), le serveur :

1. fait attendre une dépendance reçue mais pas encore réglée (`RETRY_LATER` `DEPENDENCY_PENDING`, reprise au renvoi) : S-17 est levé ;
2. ne traite plus rien après une commande à renvoyer dans un lot : les suivantes reçoivent `RETRY_LATER` `PRECEDING_COMMAND_PENDING`, sans être traitées ni enregistrées (INV-SYN-04 : l'ordre est garanti par couple appareil × auteur) ;
3. depuis la revue de P5-21 (`b3d5dc0`, AV-217), signale `COMMAND_STALLED` une commande à renvoyer depuis plus de `sync.retry_hold_minutes` : elle reste à renvoyer, mais ne retient plus la suite de son lot ;
4. borne le traitement d'un lot à 25 s : la suite reçoit `RETRY_LATER` `SERVER_BUSY`, sans être traitée.

La retenue de l'appareil devenait alors contraire à INV-SYN-04. Une libération de quota ou une clôture de caisse pouvait passer avant la vente qui la précède, scénario qu'AV-210 visait. Par ailleurs, l'appareil traitait tous les `RETRY_LATER` de la même façon : un `PRECEDING_COMMAND_PENDING` remettait à zéro le compteur de renvois sans succès (`busy_retries`) et remplaçait le motif réel de la commande. Une commande bloquée en attente de dépendance n'atteignait jamais l'« échec répété », et l'écran restait figé.

## Décision

1. **Ordre strict** (`apps/pwa/src/sync/outbox.ts`, `pendingOutbox`). Les commandes de l'utilisateur de la session partent dans l'ordre de `device_seq`, dépendantes comprises : le serveur fait attendre la dépendance et suspend la suite. Le lot s'arrête seulement **avant** une commande dont une dépendance attend encore sur l'appareil sans partir dans ce lot :
   - commande d'un autre utilisateur de la tablette, qui ne part qu'à sa reconnexion (ADR-037 §13) ;
   - commande bloquée écartée de ce cycle (point 3).

   L'envoyer ne ferait que suspendre la suite. Une dépendance refusée ou en conflit n'arrête pas l'envoi : le serveur refuse la dépendante (`DEPENDENCY_REJECTED`).
2. **Renvois distingués par motif** (`apps/pwa/src/sync/push.ts`, `nextBusyRetries`) :
   - `PRECEDING_COMMAND_PENDING` est neutre : la commande n'a pas été traitée, son compteur et son motif réel ne changent pas ;
   - `SERVER_BUSY` (erreur du serveur, ou délai du lot dépassé) et `DEPENDENCY_PENDING` comptent un renvoi sans succès. Une dépendance qui ne vient pas finit donc signalée ;
   - `COMMAND_STALLED` est aussitôt signalé en échec répété (au moins `REPEATED_FAILURE_ATTEMPTS`). L'écran qui l'a émise se débloque et affiche le motif du serveur (« Commande bloquée depuis plus de … ») ;
   - tout autre motif remet le compteur à zéro.
3. **Un renvoi par cycle pour une commande bloquée** (`apps/pwa/src/sync/engine.ts`). Une commande `COMMAND_STALLED` ne retient plus la suite au serveur. Elle est écartée des lots suivants du même cycle et repart au cycle suivant : pas de renvoi en boucle serrée pendant que la file se vide (AV-217).

## Conséquences

- INV-SYN-04 est tenu de bout en bout : l'appareil n'envoie jamais une commande avant une commande antérieure du même auteur encore à envoyer, sauf commande bloquée que le serveur a lui-même libérée de l'ordre.
- Une commande qui dépend de la saisie d'un autre utilisateur de la tablette retient la suite de son auteur jusqu'à la reconnexion de l'autre. Les écrans évitent déjà ces dépendances (ADR-037 §13 : seules les créations de l'utilisateur sont proposées).
- Le délai de 25 s par lot et une vraie erreur du serveur partagent le code `SERVER_BUSY`. L'appareil ne peut pas distinguer une commande non traitée d'une commande en échec : un lot lent pendant trois cycles signale à tort un échec répété (besoin S-43, code distinct).
- Les restes déclarés (`pending_by_author`) comptent encore le lot comme parti. Le serveur y ajoute lui-même ce qu'il n'a pas réglé (`b3d5dc0`).
- L'attente progressive de §4 de `02-synchronisation.md` (`min(15 min, 5 s·2^n)`, alerte à 20 échecs) n'est pas encore appliquée : l'intervalle reste fixe (30 s).
- L'index des décisions reçoit la ligne de cet ADR à l'intégration ; ADR-037 §11 y est marqué révisé.

Tests : `apps/pwa/src/sync/outbox.test.ts` (ordre strict, arrêt avant une dépendance qui ne part pas), `apps/pwa/src/sync/push.test.ts` (motifs de renvoi, commande bloquée), `apps/pwa/src/sync/engine.test.ts` (renvoi unique par cycle).
