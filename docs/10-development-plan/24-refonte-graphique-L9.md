# 24 — Refonte graphique, lot L9 (Administration, validations, synchronisation et conflits)

> Suivi du lot L9, tenu par la session qui le mène ; il est consolidé dans le suivi principal [`24-refonte-graphique.md`](24-refonte-graphique.md) au lot L10. Règles communes : § 6 bis du suivi principal.

## Périmètre

- `apps/pwa/src/features/users/`, `apps/pwa/src/features/devices/` (écrans), `apps/pwa/src/features/approvals/`
- `apps/pwa/src/features/sync/` (écran de synchronisation et file des conflits ; la pastille et le bandeau d'autonomie sont du lot L2)
- `apps/pwa/src/features/attachments/` (photo jointe : `PhotoField`, `PhotoViews`)

## Livré

**Critère du plan** : filtres en contrôle segmenté, explications repliées. Les trois écrans à liste (comptes, appareils, validations) avaient le même début : un paragraphe d'explication de quatre à cinq lignes, puis un groupe de quatre radios empilés (200 px), puis la recherche, et la première carte sous la ligne de flottaison. Ils commencent maintenant par le titre et son action, une ligne repliée « À quoi sert cet écran ? », le filtre d'état sur une seule ligne et la recherche ; sur téléphone, la première carte apparaît dès le premier écran.

| Écran | Ce qui change |
|---|---|
| `users/admin.css`, `users/HelpDisclosure.tsx` (nouveaux) | Feuille commune des écrans d'administration, de validation et de synchronisation (aide repliée, barre de filtres, cartes, formulaires ouverts sous une carte, lignes de rôles, lignes à cocher, bandeaux) ; `HelpDisclosure` : explication repliée (balise `details` native, utilisable au clavier), le texte d'aide est celui d'avant |
| Utilisateurs (`UsersScreen`) | `PageHeader` avec « Nouveau compte » (icône plus, seule action pleine de l'écran) ; aide repliée ; filtre d'état en `Segmented` (Actifs, Suspendus, Désactivés, Tous) ; recherche en `Field` ; comptes en cartes (avatar, nom, téléphone, pastille d'état, rôles et périmètres en lignes avec « Retirer » à droite, dernière connexion, avertissement du mot de passe provisoire) ; actions en boutons teintés (réinitialiser, ajouter un rôle, réactiver) et à contour (suspendre, désactiver) ; création : carte avec titre, aide repliée (« Comment saisir un compte ? ») et champs `Field`, case « Afficher le mot de passe » ; réinitialisation, motif, ajout de rôle : formulaires sous la carte ; retours en `Banner` ; deux colonnes de cartes sur ordinateur |
| Appareils (`DevicesScreen`) | Mêmes briques : action « Actualiser la liste » dans l'en-tête, aide repliée, filtre d'état en `Segmented` (En attente, Actifs, Bloqués, Tous), cartes avec pastille d'état et pastille « Ce téléphone » ; « Approuver » et « Débloquer » en teinté, les autres décisions à contour ; formulaire de décision sous la carte (case « Appareil partagé », site, motif) ; avertissement « C'est le téléphone que vous utilisez » en bandeau |
| Validations (`ApprovalsScreen`) | Action « Actualiser la file » dans l'en-tête, aide repliée, bandeau de filtre avec « Voir toutes les validations » ; demandes en cartes (type, demandeur et site, montant à droite, ce qu'on décide en gras, notes d'avertissement, photos) ; « Approuver » teinté, « Refuser » à contour ; décision sous la carte : issue du refus en lignes à cocher, motif en `Field`, déclaration d'auto-validation en case |
| Synchronisation (`SyncScreen`) | `PageHeader` avec « Forcer la synchronisation » (icône, état de chargement) ; bandeaux pour l'approbation de l'appareil et les photos à envoyer ou refusées ; opérations en attente et à examiner en listes à icônes (« Classer » à droite) ; explication du classement repliée ; « Aucune opération en attente » en une ligne avec une coche |
| Photo jointe (`PhotoField`, `PhotoViews`, `attachments.css` nouveau) | Champ photo : légende et aide, deux gestes en boutons teintés avec icône sur une ligne (l'entrée fichier reste masquée et porte le nom accessible), photo prête en bandeau avec « Retirer la photo », erreurs en bandeau ; état d'envoi en liste ; « Joindre la photo » et « Voir la photo » en boutons teintés avec icône ; photo indisponible en bandeau avec « Réessayer » ; image avec bord et angles arrondis |

Libellés, rôles ARIA et noms accessibles sont inchangés : aucun essai n'a été modifié. Textes ajoutés (clés nouvelles seulement, aucun texte existant ne change) : `users.help_title`, `users.create_help_title`, `devices.help_title`, `approvals.help_title`, `sync.help_title`.

## Vérification

Passes faites sous verrou le 31/10/2026, sur la branche du lot.

- **Types** : `pnpm --filter @gic/pwa run typecheck`, sans erreur (la construction refait le même contrôle).
- **ESLint** : `npx eslint` sur les cinq dossiers et `fr.ts`, sans avertissement.
- **Essais du lot** : `npx vitest run src/features/users src/features/devices src/features/approvals src/features/sync src/features/attachments src/styles` dans `apps/pwa` : 8 fichiers, 136 essais passés (comptes 24, appareils 9, bandeau d'approbation 4, validations 15, synchronisation 2, autonomie 7, photo 5, jetons et contrastes 70).
- **Essais des écrans qui affichent la photo jointe**, une seule fois à la fin du lot : `npx vitest run src/features/stock src/features/production src/features/procurement src/features/finance` : 35 fichiers, 297 essais passés. **Aucun essai modifié.**
- **Construction et budget** : `pnpm --filter @gic/pwa run build` (types, puis `vite build`) réussie ; `node tools/size-check.mjs` : **JS initial 257,4 Ko gzip pour un budget de 300 Ko** (NFR-05) ; écrans chargés à la demande 261,1 Ko, hors budget. Mesure faite sur la branche du lot (jetons, coquille, ventes, production, administration), pas sur la fusion.
- **Contrôle visuel** (Chromium sans fenêtre, 375 px et 1280 px, thèmes clair et sombre) sur les comptes, les appareils, les validations (carte, refus, photo ouverte), la synchronisation et le champ photo : aucun débordement horizontal de la page, aucune erreur de console, aucun texte sous 12 px, aucune cible visible sous 36 px (zone tactile de 48 px).
- **Hauteurs de page en 375 px, avant → après** : comptes 2 191 → 1 782 px, appareils 2 480 → 2 582 px (cartes plus aérées, avec l'état et le dernier contact), validations 1 600 → 1 590 px, synchronisation 894 → 935 px (bandeau d'avertissement et lignes à icônes). **En 1280 px** : comptes 1 660 → 1 126 px, appareils 1 769 → 1 316 px, validations 1 165 → 828 px, synchronisation 800 → 800 px.
- **Non vérifié** : sur un téléphone réel ; l'envoi réel d'une décision, d'une création de compte ou d'une photo au serveur (l'appareil de démonstration attend son approbation) ; la lecture d'une vraie file de validation (simulée pour les images).

## Questions à trancher

- **Q-L9-1** — `HelpDisclosure` (explication repliée en `details` natif) vit dans `features/users/` et est importé par les validations, les appareils et la synchronisation. Faut-il en faire un composant commun (`Disclosure` dans `components/ui/`) au lot L10 ? D'autres écrans des lots L4 à L8 peuvent en avoir besoin.
- **Q-L9-2** — Les actions destructives (désactiver un compte, retirer un rôle, bloquer ou retirer un appareil, déclarer perdu) sont à contour ou en fantôme : le bouton `danger` du jeu commun est plein, ce qui contredit « un seul bouton plein par écran ». Faut-il ajouter une variante à contour rouge ?

## Notes

- **Besoins communs contournés dans la feuille du lot** : (1) `HelpDisclosure` (voir Q-L9-1) ; (2) barre de filtres (contrôle segmenté et recherche, `adm-toolbar`) ; (3) carte à formulaire ouvert dessous (`adm-panel`) ; (4) lignes à cocher dans une carte (`adm-choices`), déjà vues au lot L6 sous un autre nom (`prd-choices`) : à unifier au lot L10.
- **Structure lue par les essais** : le titre « Opérations à examiner » reste le parent direct de sa liste, de l'aide et des boutons « Classer » (un essai part du titre pour trouver le reste) : le groupe est un `section` local et non le composant `Section`, dont le titre est dans une rangée à part. Les textes « opération — situation : motif » restent dans un seul élément.
- **Rôles ARIA** : le défaut « ce rôle ne se donne pas ici » passe par `Field` (annoncé en `alert`, un seul à la fois) ; les autres messages de formulaire restent des notes sans rôle, comme avant ; les anomalies de lecture et de décision sont des `Banner`.
- **Photo jointe** : les classes sont nouvelles (`ph-*`) ; les règles `photo-*` et `server-photo` de `app/app.css` ne s'appliquent plus et partent avec elle au lot L10. `AttachPhoto` enveloppe maintenant toujours son rendu dans un `div` (avant : un fragment), les écrans qui l'emploient n'ont rien à changer.
- **Images de contrôle** : la file de validation de la base de démonstration est vide ; les cartes des images viennent d'une fausse réponse de `GET /approvals/inbox` et d'une fausse photo (routes de l'outil de capture). L'écran de synchronisation montre trois opérations refusées ou en conflit et une photo refusée, semées dans le stockage local du navigateur de test (jamais envoyées au serveur). Les images avant sont prises sur le code du lot L6, avec la même coquille.
- **Hors lot** : les captures du lot L6 (saisie du jour) ont été prises avec l'ancien champ photo ; le nouveau est visible sur les images de ce lot.
