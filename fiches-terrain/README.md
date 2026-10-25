# Fiches terrain

Fiches Excel remises aux équipes **en attendant que l'application GIC AGROPELC soit opérationnelle**. Ce dossier est une **annexe** du projet : il ne fait partie ni du code, ni du référentiel `docs/`, et rien dans l'application n'en dépend aujourd'hui.

Objectif : que l'entreprise puisse déjà travailler et mesurer son activité, avec des données **rangées de façon à pouvoir être chargées plus tard dans l'application** sans ressaisie.

| Fiche | Public | Dossier |
|---|---|---|
| Reporting commercial (journalier, hebdomadaire, mensuel) | Commerciaux terrain, commerciaux sédentaires, vendeurs de PDV, responsable commercial | [`commercial/`](commercial/README.md) |

D'autres fiches (production, magasin, finance…) viendront s'ajouter ici, chacune dans son sous-dossier.

## Conventions communes

Valables pour toutes les fiches, pour que leur chargement futur reste simple et homogène :

1. **Feuilles de saisie = journaux.** Une ligne = un fait. Entête en **ligne 5**, données à partir de la **ligne 6**, aucune cellule fusionnée dans le tableau, un seul type de valeur par colonne (dates réelles, nombres réels).
2. **Saisie par listes déroulantes** alimentées par une feuille `Listes` (choix modifiables, avec un code indicatif de l'application cible) : dates, heures, clients, produits, oui/non. Classeurs **sans macro** (`.xlsx`).
3. **Aucun indicateur saisi à la main** : les rapports ne contiennent que des formules (principe du contexte métier, §9).
4. **Clé de rapprochement** : chaque ligne porte le commercial (ou l'utilisateur) et une référence calculée, pour éviter les doublons au chargement.
5. **Feuille `Correspondances`** : pour chaque colonne, le champ cible indicatif dans l'application (à valider au moment du chargement).
6. Les fiches sont **générées par un script** (`_generation/`) : on corrige le script, on régénère ; on ne retouche pas le fichier à la main.
