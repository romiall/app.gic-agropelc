# ADR-045 — Mots de passe hors du journal des commandes, charge conservée sans secret, fiche utilisateur minimale sur les appareils

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; applique AV-252, tranché par le porteur le 13/10/2026, INV-AUD-02 et BR-AUD-007)
- **Date** : 14/10/2026
- **Précise** : BR-SYN-001 (chemin d'écriture unique par les commandes), INV-AUD-02
- **Questions liées** : AV-008, AV-251, AV-252, AV-280, AV-281, AV-282

## Contexte

MP-08 livre le changement imposé du mot de passe provisoire (AV-251) et la réinitialisation par l'Admin avec un mot de passe qu'il saisit (AV-252 : « ne transite que par une route en ligne hors du journal des commandes, n'est ni journalisé ni audité en clair »). La cartographie de MP-08 relève trois points.

- **Écriture hors des commandes.** Le référentiel pose un chemin d'écriture unique : toute écriture est une commande idempotente (BR-SYN-001, 08-api-events §1). Les routes `/auth/*` y font déjà exception. La réinitialisation en fait une de plus, voulue par le porteur.
- **Mot de passe en clair dans les traces.** `identity.user.create` porte le mot de passe provisoire (`initialPassword`) dans sa charge utile. Le pipeline conserve cette charge telle quelle à trois endroits : `sync.command_inbox.payload`, `platform.domain_events.payload` et, faute d'audit propre au gestionnaire, `audit.audit_log.after`. La liste de masquage de l'audit ne connaît pas ce nom de champ. C'est contraire à INV-AUD-02 (« aucun secret dans l'audit ni dans les logs ») et à 09-non-functional/02-observabilite (« charges de commande complètes » interdites dans les journaux).
- **Fiche utilisateur trop large sur les appareils.** La projection `USER`, servie à tous les appareils par la ligne `GLOBAL` du repli générique du pipeline, rend le téléphone, le courriel, la dernière connexion et l'indicateur de mot de passe provisoire de chaque compte touché par une commande. La PWA n'en lit que le nom et le statut.

## Décision

1. **Mots de passe par des routes en ligne, hors du journal des commandes.**
   - `POST /auth/change-password` : l'utilisateur, avec son mot de passe actuel.
   - `POST /users/{id}/reset-password` : l'Admin (`identity.user.manage`).
   - `POST /users` (MP-13, AV-325) : création d'un compte par l'Admin avec son mot de passe provisoire et, facultativement, une première affectation de rôle (`identity.user.manage` et, avec un rôle, `identity.role_assignment.manage`).

   Les trois routes sont écrites par le module propriétaire (`identity`). Elles ne passent ni par `sync.command_inbox`, ni par un événement, ni par la file d'envoi de l'appareil. Elles ne rendent jamais le mot de passe. Leur audit (`identity.user.change_password`, `identity.user.reset_password`, `identity.user.create`) n'en porte que les effets (`must_change_password`, sessions révoquées).

   C'est une **exception nommée** au chemin d'écriture unique, comme `/auth/*`. Aucune autre écriture métier n'en bénéficie.
2. **Charge conservée sans secret.** Le pipeline des commandes applique la liste fermée de masquage (`audit/redact.ts`) à la charge utile qu'il conserve :
   - ligne d'inbox ;
   - événement ;
   - audit par défaut.

   Il calcule l'empreinte d'idempotence (`payload_hash`) sur l'enveloppe masquée. Le gestionnaire reçoit toujours l'enveloppe complète, en mémoire ; aucune relecture de la charge conservée ne sert à rejouer une commande (CONFIRMÉ, lecture du pipeline). La liste reçoit les noms de mots de passe saisis (`initialPassword`, `new_password`, `current_password` et leurs variantes).

   Une charge sans champ sensible est inchangée : même empreinte, aucun effet sur les commandes déjà reçues. Une charge qui en contient garde une empreinte stable pour le même envoi : le rejeu donne le résultat enregistré. Deux envois du même `command_id` qui ne diffèrent que par un secret sont tenus pour le même ; c'est acceptable.
3. **Fiche utilisateur minimale sur les appareils.** La projection `USER` ne rend plus que `id`, `full_name` et `status`. Le téléphone, le courriel, la dernière connexion et l'indicateur de mot de passe provisoire se lisent par `GET /users`, avec le droit `identity.user.read` et sa portée.
4. **Règles d'un nouveau mot de passe partagées** (`packages/domain/src/password.ts`, ADR-021) : 8 à 128 caractères, différent de celui qu'il remplace (AV-008, AV-280). Le serveur les applique à la création d'un compte, au changement et à la réinitialisation ; l'écran les vérifie avant l'envoi. Un mot de passe actuel faux, au changement, compte comme un échec de connexion de l'utilisateur (verrouillage progressif, 02-securite §2).

## Conséquences

- AV-252 est appliqué tel que décidé ; l'écart de `identity.user.create` (mot de passe en clair) est corrigé pour les commandes à venir. Les bases de développement et de test gardent les charges déjà enregistrées : aucune n'a de mot de passe réel (les mots de passe de démonstration sont posés sous forme hachée par `demo-data.ts`).
- Un jeton d'accès déjà émis reste valable jusqu'à son expiration (15 min au plus) après une réinitialisation ou une révocation : `AuthGuard` ne relit ni la session ni le statut de l'utilisateur (02-securite §5 le prévoit pourtant pour l'appareil). Point ouvert : AV-282.
- Test : `apps/server/test/identity-users-password.test.ts`. Il couvre la réinitialisation, les gardes, le verrouillage au changement, le masquage dans l'inbox, l'événement et l'audit, le rejeu et la projection ; 14 mutations, toutes détectées. Côté domaine : `password.test.ts` ; côté audit : `redact.test.ts`.
