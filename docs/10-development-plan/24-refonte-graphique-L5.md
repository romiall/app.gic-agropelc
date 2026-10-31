# 24 — Refonte graphique, lot L5 (Clients, objectifs, service, catalogue, prix, livraison)

> Suivi du lot L5, tenu par la session qui le mène ; il est consolidé dans le suivi principal [`24-refonte-graphique.md`](24-refonte-graphique.md) au lot L10. Règles communes : § 6 bis du suivi principal.

## Périmètre

- `apps/pwa/src/features/crm/` (portefeuille, fiche client, prospect, visite, interaction, performance, objectifs)
- `apps/pwa/src/features/fieldwork/` (prise de service)
- `apps/pwa/src/features/catalog/`, `apps/pwa/src/features/pricing/` (catalogue, règles de prix, simulateur)
- `apps/pwa/src/features/sales/DeliverScreen.tsx` (livraison d'une commande, non reprise au lot L3)

## Livré

Principe : les composants communs (`PageHeader`, `Field`, `Segmented`, `DataList`, `Banner`, `Badge`, `Section`, `List`/`ListRow`, `ActionBar`, `EmptyState`, `SkeletonRows`) remplacent le vocabulaire hérité ; libellés, rôles ARIA et noms accessibles lus par les essais sont conservés. Quatre feuilles de domaine nouvelles (`crm.css`, `fieldwork.css`, `catalog.css`, `pricing.css`), aucune couleur en dur.

| Écran | Ce qui change |
|---|---|
| Portefeuille (ECR-CRM-01) | `PageHeader` avec « + Prospect » (seul bouton plein) ; barre de filtres : recherche avec loupe et stade en contrôle segmenté (« Tous », « Prospects », « Clients », « Perdus ») ; liste en colonnes `DataList` : cartes sur téléphone, quatre colonnes dès 900 px (client avec pastille d'initiales, stade, prochaine action avec « en retard », encours) ; toute la ligne est le lien vers la fiche (nom accessible inchangé) ; états vide et chargement |
| Fiche client (ECR-CRM-03) | En-tête (nom, pastille du stade), bandeau « compte pas encore confirmé », actions en rangée `chip-row` avec icônes (« + Vente » seul bouton plein, les autres teintés), tuiles Encours et Crédit, carte des coordonnées, sections Commandes ouvertes, Ventes et Visites et échanges en `List`/`ListRow` avec pastilles de situation ; sur ordinateur (72 rem) coordonnées et chiffres à gauche, listes à droite |
| Nouveau prospect, nouvelle visite, noter un échange | `PageHeader`, champs `Field`, position GPS dans un cadre (état puis bouton), « Plus d'informations » en bloc repliable stylé, type de client, canal et sens en contrôle segmenté, bandeaux (hors ligne, doublon, hors session, rôle, erreur d'enregistrement), barre d'action collée avec le bouton principal ; écrans de résultat avec actions en boutons |
| Mes objectifs et performances (ECR-CRM-05) | Période en contrôle segmenté, origine des chiffres en bandeau (estimation de l'appareil, erreur avec « Réessayer ») ou ligne discrète, activité en tuiles, objectifs en cartes avec jauge d'avancement |
| Gestion des objectifs (ECR-CRM-07) | « Nouvel objectif » dans l'en-tête, formulaire en carte avec barre d'action collée, objectifs en cartes (pastille d'état, annulation avec confirmation en ligne), états vide et chargement |
| Prise de service (ECR-TER-01) | Carte d'état « En service » avec « Fin de service » à côté, « Prendre service » en barre d'action collée, position (état et bouton) en cadre, dérogation en bloc dédié, pointages du jour en lignes de liste |
| Catalogue (ECR-PRX-01) | Rubriques en contrôle segmenté ; produits et motifs en colonnes (`DataList`) avec actions « Modifier » et « Désactiver » à droite ; unités, catégories et conditionnements en lignes de liste ; formulaires de création en carte (champs par deux, cases d'usage en grille) ; création d'un produit avec barre d'action collée |
| Règles de prix (ECR-PRX-02) | « Nouvelle règle » dans l'en-tête ; règles en colonnes (prix, portée, période, code et version) pour les trois sections, actions sous la ligne ; éditeur en carte avec champs par deux et barre d'action collée |
| Simulateur de prix (ECR-PRX-03) | Produit, quantité et date, puis le résultat (grand prix, total, règle retenue, autres règles en liste), puis les affinages (site, zone, catégorie, canal) ; sur ordinateur le résultat reste à droite des saisies |
| Livraison d'une commande (ECR-VEN-04) | `PageHeader` avec retour à la commande, lignes en cartes avec champ de quantité, barre d'action collée, résultat avec le bon de livraison et le retour à la commande |

## Vérification

Faite le 31/10/2026, une fois, sous le verrou commun.

| Contrôle | Résultat |
|---|---|
| Types (`pnpm --filter @gic/pwa run typecheck`) | 0 erreur. Les paquets `@gic/domain` et `@gic/contracts` ont d'abord été construits dans le worktree (leur `dist`, ignoré par git, manquait : sans lui `tsc` ne résout pas les deux modules) |
| ESLint des 15 fichiers modifiés ou créés | 0 erreur, 0 avertissement |
| Essais : `src/features/crm`, `fieldwork`, `catalog`, `pricing`, `sales` (importe `fieldwork/service`), plus `src/styles`, `src/i18n`, `src/components` | 25 fichiers, 261 essais passés. `styles/tokens.test.ts` balaie les quatre feuilles de domaine : aucune couleur en dur |
| Un seul essai modifié | `crm/CustomerScreen.test.tsx` : le filtre par stade du portefeuille passe d'une liste déroulante à un contrôle segmenté ; l'essai clique le bouton radio « Prospects » puis « Tous » au lieu de `selectOptions`. Même comportement vérifié (une ligne, puis deux) |
| Contrôle visuel (Chromium, API et PWA locales, base `gic_agropelc_refonte`) | 375 px et 1280 px, clair et sombre : portefeuille, fiche (compte sans activité et compte avec ventes et commande), nouveau prospect, nouvelle visite, objectifs, gestion des objectifs avec formulaire ouvert, prise de service, catalogue (produits, motifs, formulaire de création), règles de prix (liste et éditeur), simulateur, livraison. Aucun débordement horizontal de page, aucune erreur de console. Deux défauts relevés puis corrigés : pas d'espace entre deux sections ni sous un bandeau, bandeau de période trop large sur ordinateur |
| Construction et `size-check` | Non faits : réservés au dernier lot de la session (L7) |

Non vérifié : le simulateur et les règles de prix n'ont été vus qu'avec le jeu de démonstration (un produit avec une règle) ; la prise de service n'a pas été vue « en service » (le relevé de position n'est pas simulé dans l'outil de capture) ; la gestion des objectifs n'a pas été vue avec des objectifs existants.

## Questions à trancher

- **Q-L5-1 — Retours « ← … »** : la flèche est dans le texte des clés (`customer.back`, `interaction.back`, `orders.detail.back`, `production.back`…) et quatre essais lisent ce nom (« ← Mon portefeuille », « ← Fiche du compte », « ← Bons de commande à recevoir », « ← Transferts à recevoir »). `PageHeader` sait déjà porter un retour avec chevron (`backTo`) : il n'est employé ici que pour la livraison, dont le libellé n'a pas de flèche. Faut-il, au lot L10, passer tous les retours à `PageHeader` (flèche retirée des clés, quatre essais mis à jour) ? Recommandé : oui, pour un seul style de retour.
- **Q-L5-2 — Appeler depuis la fiche client** : ajouter un bouton « Appeler » (lien `tel:`) en tête de la rangée d'actions ? Le numéro reste un lien dans les coordonnées, mais le pouce atteint mieux un bouton. Une clé de texte et un lien, aucune logique. Recommandé : oui.
- **Q-L5-3 — Éditeur de règle de prix** : les champs obligatoires vides s'affichent en erreur (bord rouge, messages sous le formulaire) dès l'ouverture, parce que l'état « invalide » est posé d'emblée (comportement d'avant, conservé). Montrer l'erreur seulement après une saisie ou une tentative d'envoi serait moins agressif, mais touche la validation, donc hors d'une refonte à fonctionnalités constantes. Recommandé : oui, dans un lot à part.

## Notes

**Besoins communs contournés dans les feuilles de domaine** (la session principale tranchera à L10) :

1. **Espace des bandeaux et des sections** : ni `Banner` ni `Section` n'ont de marge ; chaque domaine pose `.<domaine>-screen > .banner` et `> .section` dans sa feuille (`crm.css`, `fieldwork.css`, `catalog.css`, `pricing.css`). Une marge portée par le composant, ou une classe de pile commune, éviterait de le refaire à chaque lot.
2. **Cadre « position »** (état relevé puis bouton « Relever ma position ») : même bloc dans le prospect, la visite et la prise de service, écrit deux fois (`.crm-locate`, `.fw-locate`). Candidat : composant commun.
3. **Contrôle segmenté avec libellé visible** : `Segmented` n'a qu'un nom accessible ; le libellé visible (`field-label`) est répété à la main (type de client, canal, sens, période). Candidat : `SegmentedField`.
4. **Ligne de liste en colonnes cliquable** : `DataRow` ne porte pas de lien ; le portefeuille met la classe `data-row` sur le lien (`li > a.data-row`, classe `crm-row`) pour que le nom accessible de la ligne reste celui que les essais lisent. Candidat : propriété `to` sur `DataRow`.
5. **Champ à libellé masqué** (recherche du portefeuille) : `Field` exige un libellé visible ; `label.visually-hidden` écrit à la main.

**Constatés hors du lot, non corrigés** :

6. Détail d'une commande (lot L3, `sales/OrderDetailScreen`) : à 375 px, les en-têtes de la grille d'avancement (`.progress-grid`, cinq colonnes) se chevauchent (« Commandé » sur « Vendu »).
7. `sales/CustomerPicker` (sélecteur de compte de « + Visite ») garde ses champs et boutons d'avant la refonte (`text-input`, boutons nus) : visible dans la visite.

**Détails de mise en œuvre** :

8. Les écrans de chargement passent de « Chargement… » à `SkeletonRows` (qui garde un nom accessible « Chargement… ») ; aucun essai ne lisait l'ancien texte.
9. Les rôles ARIA d'origine sont conservés sur les bandeaux (`role="status"` ou `"alert"` explicites) : une alerte reste une alerte, un message de situation reste un statut.
10. Clés de texte ajoutées : `portfolio.stage_all_short`, `portfolio.col.*`, `catalog.col.*`, `price_rules.col.*`. Clé devenue inutilisée : `portfolio.outstanding` (le portefeuille compose « Encours » et le montant lui-même) ; à retirer au lot L10 si rien d'autre ne la lit.
11. `features/crm/stage.ts` : fonction de présentation du ton de la pastille d'un stade (prospect en information, client en marque, autres en neutre).
12. La rangée d'actions de la fiche (`chip-row`) défile horizontalement sur téléphone ; « + Vente » reste le seul bouton plein.
