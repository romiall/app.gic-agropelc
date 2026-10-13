# ADR-039 — Envoi de l'appareil dans l'ordre strict, renvois distingués par motif

- **Statut** : ACCEPTÉ à l'intégration du 13/10/2026 (fork « Écrans PWA », phase des écrans de P5 ; numéro de fork 052, renuméroté ADR-039 ; DÉDUIT, technique)
- **Date** : 12/10/2026
- **Révise** : [ADR-037](ADR-037-synchronisation-appareil-durcie.md) §11 (« dépendance d'abord ») ; précise §12
- **Révisé le 12/10/2026** (F-61, revue adverse de F-57) : dépendance d'un autre utilisateur de la tablette, commande en vol, relève pendant un cycle, verrou entre onglets, « en cours de traitement », commande retenue derrière un échec (décisions 4 à 8)

## Contexte

ADR-037 §11 retenait sur l'appareil une commande dont une dépendance (`depends_on`) attendait encore sa réponse, et laissait partir les commandes qui la suivaient. Il contournait un défaut du serveur : une dépendance seulement reçue, ou en échec passager, faisait refuser définitivement la commande dépendante (S-17).

Depuis P5-21 (AV-210, `e07a608`), le serveur :

1. fait attendre une dépendance reçue mais pas encore réglée (`RETRY_LATER` `DEPENDENCY_PENDING`, reprise au renvoi) : S-17 est levé ;
2. ne traite plus rien après une commande à renvoyer dans un lot : les suivantes reçoivent `RETRY_LATER` `PRECEDING_COMMAND_PENDING`, sans être traitées ni enregistrées (INV-SYN-04 : l'ordre est garanti par couple appareil × auteur) ;
3. depuis la revue de P5-21 (`b3d5dc0`, AV-217), signale `COMMAND_STALLED` une commande à renvoyer depuis plus de `sync.retry_hold_minutes` : elle reste à renvoyer, mais ne retient plus la suite de son lot ;
4. borne le traitement d'un lot à 25 s : la suite reçoit `RETRY_LATER` `SERVER_BUSY`, sans être traitée.

La retenue de l'appareil devenait alors contraire à INV-SYN-04. Une libération de quota ou une clôture de caisse pouvait passer avant la vente qui la précède, scénario qu'AV-210 visait. Par ailleurs, l'appareil traitait tous les `RETRY_LATER` de la même façon : un `PRECEDING_COMMAND_PENDING` remettait à zéro le compteur de renvois sans succès (`busy_retries`) et remplaçait le motif réel de la commande. Une commande bloquée en attente de dépendance n'atteignait jamais l'« échec répété », et l'écran restait figé.

## Décision

1. **Ordre strict** (`apps/pwa/src/sync/outbox.ts`, `pendingOutbox`). Les commandes de l'utilisateur de la session partent dans l'ordre de `device_seq`, dépendantes comprises : le serveur fait attendre la dépendance et suspend la suite. Le lot s'arrête seulement **avant** :
   - une commande dont une dépendance **du même auteur** attend sans partir dans ce lot (commande bloquée écartée de ce cycle, point 3) : l'envoyer ne ferait que suspendre la suite ;
   - une commande plus récente qu'une commande de l'auteur encore en vol (`SYNCING`, décision 7).

   Une dépendance d'un autre utilisateur de la tablette n'arrête pas le lot (révisé par F-61) : elle ne part qu'à la reconnexion de son auteur, et le lot attendrait sans fin. La dépendante part ; le serveur la fait attendre et suspend la suite au plus `sync.retry_hold_minutes`, puis la déclare bloquée (`COMMAND_STALLED`) et libère la file. Les écrans évitent de créer cette dépendance (décision 4). Une dépendance refusée ou en conflit n'arrête pas l'envoi : le serveur refuse la dépendante (`DEPENDENCY_REJECTED`).
2. **Renvois distingués par motif** (`apps/pwa/src/sync/push.ts`, `nextBusyRetries`) :
   - `PRECEDING_COMMAND_PENDING` est neutre : la commande n'a pas été traitée, son compteur et son motif réel ne changent pas ;
   - `SERVER_BUSY` (erreur du serveur, ou délai du lot dépassé) et `DEPENDENCY_PENDING` comptent un renvoi sans succès. Une dépendance qui ne vient pas finit donc signalée ;
   - `COMMAND_STALLED` est aussitôt signalé en échec répété (au moins `REPEATED_FAILURE_ATTEMPTS`). L'écran qui l'a émise se débloque et affiche le motif du serveur (« Commande bloquée depuis plus de … ») ;
   - tout autre motif remet le compteur à zéro.
3. **Un renvoi par cycle pour une commande bloquée** (`apps/pwa/src/sync/engine.ts`). Une commande `COMMAND_STALLED` ne retient plus la suite au serveur. Elle est écartée des lots suivants du même cycle et repart au cycle suivant : pas de renvoi en boucle serrée pendant que la file se vide (AV-217).
4. **Pas de dépendance vers la saisie d'un autre utilisateur** (`apps/pwa/src/features/sales/pending.ts`, `waitsForOtherUser`). Seule l'annulation d'une vente en crée une : les ventes de l'appareil sont listées tous auteurs confondus. Tant que la vente d'un autre utilisateur de la tablette attend son envoi, l'annulation est refusée, avec le motif. Les autres dépendances visent des saisies de l'utilisateur seul (prospects, inventaires, incubations, lots : ADR-037 §13) ; une livraison ne peut pas viser une commande encore sur l'appareil, dont les lignes n'ont pas d'identifiant (DÉDUIT de `open-orders.ts`).
5. **Relève pendant un cycle** (`apps/pwa/src/sync/api-client.ts`, `engine.ts`, `pull.ts`). Le moteur arrêté (déconnexion) interrompt son cycle entre deux appels. Chaque appel du moteur déclare l'utilisateur pour lequel il est fait : si la session a changé, l'appel n'a pas lieu. Le lot redevient à envoyer sans compter d'essai, les jeux ne sont ni effacés ni tirés pour l'utilisateur précédent, et la session suivante n'est pas déconnectée. Sans cela, les commandes d'un utilisateur partiraient avec le jeton du suivant et seraient refusées définitivement (`FORBIDDEN`).
6. **Un cycle à la fois sur l'appareil** (`engine.ts`). Le cycle tourne sous un verrou du navigateur (`navigator.locks`, nom `gic-sync`), partagé par les onglets. Sous ce verrou, tout ce qui est resté `SYNCING` repart au début du cycle. Sans verrou (navigateur ancien), seul ce qui a été envoyé avant le délai d'un lot (60 s, plus une marge) repart : l'heure d'envoi est conservée sur la commande (`sent_at`).
7. **Commande en vol** (`outbox.ts`). Rien de plus récent ne part tant qu'une commande de l'auteur est `SYNCING`, faute de quoi le serveur l'appliquerait après une commande qui la suit.
8. **« En cours de traitement » et retenue derrière un échec** (`push.ts`, `features/sales/submit.ts`). Un `SERVER_BUSY` reçu moins de 120 s après un envoi resté sans réponse n'est pas compté : le serveur tient la commande réclamée 120 s (`STALE_CLAIM_SECONDS`, DÉDUIT), le motif signifie alors « en cours de traitement » (besoin S-45, code distinct). Une commande plus récente qu'une commande du même auteur en échec répété, non déclarée bloquée, est retenue par le serveur. Elle ne fige plus son écran, et son résultat annonce la retenue.

## Conséquences

- INV-SYN-04 est tenu de bout en bout. L'appareil n'envoie jamais une commande avant une commande antérieure du même auteur encore à envoyer ou en vol, dans un onglet comme dans un autre. Seule exception : la commande bloquée que le serveur a lui-même libérée de l'ordre.
- Une dépendance vers la saisie d'un autre utilisateur, si elle existait malgré la décision 4, suspendrait la suite de son auteur au plus `sync.retry_hold_minutes`, jamais sans fin.
- Le délai de 25 s par lot et une vraie erreur du serveur partagent le code `SERVER_BUSY`. L'appareil ne peut pas distinguer une commande non traitée d'une commande en échec : un lot lent pendant trois cycles signale à tort un échec répété (besoin S-43, code distinct).
- Les restes déclarés (`pending_by_author`) comptent encore le lot comme parti. Le serveur y ajoute lui-même ce qu'il n'a pas réglé (`b3d5dc0`).
- L'attente progressive de §4 de `02-synchronisation.md` (`min(15 min, 5 s·2^n)`, alerte à 20 échecs) n'est pas encore appliquée : l'intervalle reste fixe (30 s).
- L'index des décisions reçoit la ligne de cet ADR à l'intégration ; ADR-037 §11 y est marqué révisé.

Tests :
- `apps/pwa/src/sync/outbox.test.ts` : ordre strict, arrêt avant une dépendance de l'auteur qui ne part pas, dépendance d'un autre utilisateur qui part, commande en vol ;
- `apps/pwa/src/sync/push.test.ts` : motifs de renvoi, commande bloquée, « en cours de traitement », relève ;
- `apps/pwa/src/sync/pull.test.ts` : relève avant et pendant le tirage ;
- `apps/pwa/src/sync/engine.test.ts` : renvoi unique par cycle et reprise au suivant, arrêt entre deux lots, verrou entre onglets et reprise des envois interrompus ;
- `apps/pwa/src/features/sales/CommandResult.test.tsx` : retenue derrière un échec ;
- `apps/pwa/src/features/sales/SalesScreens.test.tsx` : annulation refusée.
