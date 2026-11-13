# ADR-058 — Aide contextuelle de chaque page et guide de l'application

- **Statut** : ACCEPTÉ (CONFIRMÉ : demande du porteur du 06/11/2026 ; la forme — un contenu de données, un panneau par page, un guide généré — est DÉDUITE)
- **Date** : 06/11/2026
- **Précise** : ADR-036 (registre des écrans et navigation par rôle), ADR-049 (système de design), ADR-057 (l'Administrateur exerce la ferme et le stock)
- **Questions liées** : AV-525, AV-526

## Contexte

Le porteur n'arrivait pas à comprendre l'usage du module de production : depuis son compte il ne trouvait ni comment créer, ni comment
modifier, ni comment consulter un lot, et les pages lui paraissaient « statiques ». Les écrans fonctionnaient, mais rien ne disait **par où
commencer, qui peut faire quoi, ni pourquoi une page est vide**. Il demande, pour toutes les pages de l'application, un menu contextuel qui
dise à tout utilisateur les actions qu'il peut entreprendre depuis la page où il se trouve, et une documentation globale, fondée sur les
spécifications et l'état actuel du code, doublée d'une documentation contextuelle par fenêtre.

## Décision

1. **Un contenu de données unique** (`apps/pwa/src/features/help/content/`) : une entrée par route de l'application (à quoi sert la page,
   ce qu'il faut avoir fait avant, les actions avec les rôles qui les font et le réseau qu'elles exigent, l'étape suivante), des parcours de
   bout en bout (rôle de chaque étape) et des questions fréquentes. Les rôles viennent de `ROLE_SETS` : un changement de droits d'un écran
   corrige l'aide sans la réécrire.
2. **Le bouton « ? » de la barre du haut** ouvre, sur toutes les pages, un panneau calculé sur l'appareil à partir des rôles mémorisés
   (donc utilisable hors ligne) : *ce que vous pouvez faire ici*, *réservé à d'autres profils* (avec les rôles qui le peuvent : c'est la réponse à
   « pourquoi je ne vois pas ce bouton ? »), *avant de commencer*, *ensuite*. Il décrit, il n'autorise rien : le serveur revérifie.
3. **Un écran « Guide et aide » (`/aide`, ECR-HLP-01, tous les profils)** : le profil connecté, les parcours de son rôle d'abord, toutes les
   pages par domaine (celles d'un autre profil sont marquées), les questions fréquentes, une recherche sans accents ni ligature.
4. **Un guide écrit généré** (`docs/11-guide-utilisateur/01-guide-global.md`) à partir du même contenu, avec une annexe « pages × rôles ».
   Un essai échoue tant que le fichier n'est pas à jour (`GIC_WRITE_GUIDE=1` le régénère) : l'écrit et l'écran ne peuvent pas diverger.
5. **Un essai de couverture** : chaque route de l'application a sa page d'aide, chaque écran du registre aussi, les liens mènent à des routes
   qui existent, les rôles cités existent. Une page ajoutée sans aide fait échouer la suite.
6. **Le contenu est du texte long, écrit en français dans des modules typés**, non dans `fr.ts` : il se relit avec le code qu'il décrit, il est
   testé pour sa couverture et il alimente un document. Les libellés des écrans, eux, restent dans `fr.ts`.

## Conséquences

- Une nouvelle page de l'application doit recevoir son entrée d'aide (essai de couverture) ; un changement de droits met l'aide à jour seul.
- Le guide écrit est un document de plus à relire à chaque livraison, mais il se régénère par une commande.
- Le panneau et le guide décrivent l'état du code : ce qu'une page ne fait pas encore y est dit comme tel (limites connues dans AV-526).
- Aucun changement du serveur, aucune migration.

## Alternatives écartées

- **Aide en ligne seulement (site ou wiki)** : inaccessible hors ligne, donc au terrain ; non versionnée avec le code.
- **Écrire l'aide dans `fr.ts`** : des centaines de lignes de prose mêlées aux libellés, sans couverture vérifiable ni document dérivé.
- **Un guide écrit à la main** : il diverge du code au premier changement ; la génération et l'essai l'évitent.
- **Visites guidées (infobulles pas à pas)** : lourdes à tenir pour 90 routes ; le panneau par page couvre le besoin sans parcours imposé.
