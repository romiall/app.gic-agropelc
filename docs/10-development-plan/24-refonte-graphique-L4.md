# 24 — Refonte graphique, lot L4 (Stock)

> Suivi du lot L4, tenu par la session qui le mène ; il est consolidé dans le suivi principal [`24-refonte-graphique.md`](24-refonte-graphique.md) au lot L10. Règles communes : § 6 bis du suivi principal.

## Périmètre

- `apps/pwa/src/features/stock/` (stock, registre, transferts, réceptions, réception sans document, inventaire, perte, consommation, quotas)
- `apps/pwa/src/features/distribution/ReplenishScreen.tsx` (demande de réapprovisionnement, qui emploie `stock/LinesEditor.tsx`)

## Livré

| Écran | Changement |
|---|---|
| Stock par emplacement (ECR-STK-01) | En-tête de page (la garde de l'emplacement en sous-titre) ; **opérations du stock en tête d'écran** : une rangée `chip-row` de boutons discrets avec icône (transférer, recevoir, déclarer une perte, inventaire, registre, consommation, quotas, réapprovisionnement), proposés selon le rôle (tout si les rôles de l'appareil sont inconnus, rien pendant leur lecture) et, hors ligne, seulement les écrans qui s'utilisent sans réseau ; barre de filtres (emplacement, recherche) ; soldes en `DataList` : cartes sur téléphone, colonnes Produit, Physique, Disponible et Situation dès 900 px, pastille Rupture (alerte) ou Sous le seuil (attention), opérations en attente, seuil et lots en cellule pleine largeur |
| Registre des mouvements (ECR-STK-07) | En-tête de page ; filtres en barre (emplacement, produit, période) ; mouvements en `DataList` (Mouvement avec son détail, Quantité, Date, Valeur) |
| Transférer, recevoir, réception sans document, inventaire, perte, consommation, quotas, demande de réapprovisionnement | En-tête de page (le retour des réceptions et des transferts passe dans l'en-tête) ; bouton principal dans la barre d'action collée (`ActionBar`) ; pastilles `Badge` pour l'état des transferts et de l'inventaire |
| `LinesEditor` (lignes de marchandise) | « Ajouter un produit » : bouton pointillé pleine largeur avec icône ; « Retirer » : bouton discret avec icône ; noms accessibles inchangés |

Feuille de domaine : `features/stock/stock.css` (une seule règle, `move-detail`, le détail d'un mouvement du registre).

## Vérification

- Types et ESLint sans avertissement ; Prettier appliqué fichier par fichier.
- Essais `src/features/stock src/features/distribution src/styles` : 16 fichiers, 171 essais verts.
- **Essai modifié** : `StockScreen.test.tsx` reçoit un simulacre de `useAuth` (l'écran lit désormais les rôles mémorisés pour proposer les opérations) ; aucune assertion existante n'a changé. Un essai est ajouté : opérations proposées selon le rôle.
- Contrôle visuel : dix écrans à 375 px et quatre à 1280 px, en clair ; quatre écrans en sombre ; aucun débordement horizontal ni erreur de console.
- La suite complète d'`apps/pwa`, la construction et le contrôle de taille sont faits une seule fois au lot L10, sur la fusion.

## Questions à trancher

Aucune.

## Notes

- Les groupes de choix exclusifs (« Nature de la perte », six choix ; « Opération » des transferts, deux choix) restent des boutons radio : un contrôle segmenté conviendrait au second, pas au premier ; à voir avec le porteur.
- `move-detail` (feuille de domaine) est l'équivalent de `doc-main small` sans coupure de ligne : à fusionner dans la feuille commune au lot L10 si d'autres domaines en ont besoin.
- `.filter-bar` (feuille commune) passe à des colonnes de 12 rem au plus petit : quatre champs tiennent sur une ligne dès environ 1000 px.
- Cellule pleine largeur `DataCell wide`, rangée `chip-row` et barre de filtres `filter-bar` : briques communes du socle, employées ici pour la première fois.
