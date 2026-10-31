# 24 — Refonte graphique et ergonomique de la PWA

> **Statut (31/10/2026)** : **refonte close**. Direction visuelle validée par le porteur sur maquette ([ADR-049](../decisions/ADR-049-systeme-de-design-de-la-pwa.md), compléments : [ADR-050](../decisions/ADR-050-complements-au-systeme-de-design-de-la-pwa.md)) ; les lots L0 (audit, direction), L1 (fondations, § 7), L2 (coquille, navigation, connexion, accueil, § 8), L3 (ventes et caisse, § 8 bis), L4 à L9 (les domaines, § 8 ter) et L10 (clôture, § 8 quater) sont faits. Branche `claude/refonte-graphique-b75250`, **commits locaux, rien de poussé** ; les lots L0 à L3 et L10 ont été menés en séquence, les lots L4 à L9 par trois sessions en parallèle (§ 6 bis) puis fusionnés.
> **Portée** : `apps/pwa` seulement, **à fonctionnalités constantes** (mêmes commandes, même hors ligne, même synchronisation). `apps/server`, `db/`, `deploy/` et `apps/pwa/src/features/pieces/` (mise en page exacte des pièces imprimées) ne sont pas touchés.
> **Numéros pris par le chantier** : AV-486 à AV-488, ADR-049 et ADR-050 ; les autres numéros réservés (AV 489 à 499, ADR 051) sont rendus au projet.

## 1. Pourquoi

L'application est complète côté métier, mais son rendu est jugé « fonctionnel sans donner envie de l'utiliser » : gros boutons, champs bruts, pages de texte. Le porteur veut une application moderne, soignée, qui garde la simplicité appréciée. Priorité : **l'ergonomie et la logique de disposition** (ce que l'utilisateur fait le plus souvent est sous la main, dans l'ordre naturel de son travail).

## 2. Mesures de départ

Relevées le 30/10/2026 sur une base locale neuve (données de démonstration), avec un compte qui détient les onze rôles, en largeur mobile 375 px (51 écrans ; les totaux de boutons et de contrôles portent sur 47 d'entre eux) et bureau 1280 px (8 écrans). Outil de relevé : § 9.

| Mesure | Valeur |
|---|---|
| Écrans / composants | 61 `*Screen.tsx` / 90 fichiers `.tsx` hors essais |
| Feuille de styles | un seul fichier, `app.css` (1 351 lignes, 23 Ko) |
| Couleurs écrites en dur | 28 teintes distinctes, 59 occurrences ; 10 variables seulement |
| Tailles de police | 10 tailles (11 à 24 px) sur 47 déclarations, aucune échelle |
| Thème sombre, mouvement réduit, transitions | aucun, aucun, aucune |
| Icônes | aucune (un seul `<svg>` : le tracé des indicateurs) |
| Polices | celles du système ; Noto Sans et Barlow Semi Condensed ne servent qu'aux pièces imprimées |
| Classes CSS utilisées / styles en ligne | environ 120 / aucun : le vocabulaire est petit |
| Essais qui dépendent d'une classe ou du DOM | 18 sélecteurs dans 9 des 102 fichiers d'essais ; tous les autres passent par rôles, libellés et textes |
| Débordement horizontal à 375 px | aucun sur 51 écrans |
| Tableaux (`<table>`) | **aucun** : listes de cartes jusque sur ordinateur |
| Boutons relevés | 96, dont 25 pleins en vert foncé |
| Contrôles natifs | 67 listes déroulantes, 32 cases et boutons radio (bleu du navigateur) |
| Hauteur de l'accueil / du menu (compte à onze rôles) | 11 565 px / 4 998 px |

## 3. Audit par motif

| Motif | Constat | Direction |
|---|---|---|
| **Boutons** | Tout `button` est un bloc vert plein de 44 px de haut ; une seule variante, le contour (`secondary`). Le bouton principal d'un écran ne se distingue pas des actions secondaires. | Hauteur visible de 40 px (48 px pour l'unique action principale), zone tactile prolongée à 48 px sans élargir le dessin ; variantes pleine, teintée, fantôme, contour, danger ; un seul bouton plein par écran. |
| **Champs** | Seuls trois types de `input` sont stylés ; `select`, `textarea`, nombres, dates, cases et radios gardent l'aspect du navigateur. Pas d'aide ni d'erreur rattachées, pas d'unité à côté d'une quantité (« Quantité » vide sans unité). | Composant champ unique (libellé, aide, erreur, unité), sélecteur, case, interrupteur, **contrôle segmenté** pour les petits choix (les 6 radios de la perte occupent 300 px, les 4 radios d'un filtre d'utilisateurs 200 px). |
| **Listes et tableaux** | Aucun tableau. Les créances, utilisateurs, mouvements de stock sont des cartes empilées, y compris à 1280 px ; les numéros de vente (`VTE-DEMO-MAG-2026-000001`) occupent la ligne principale et se coupent. | Ligne de liste à trois zones (repère, texte, valeur et état) ; sur ordinateur, les mêmes listes s'affichent en colonnes, sans changer les rôles du DOM (les essais restent valables). Client et montant d'abord, référence ensuite. |
| **Cartes et groupes** | Cartes blanches à bord plein partout, sections annoncées par un petit titre gris en capitales ; `/pdv` est un mur de texte avec des chiffres noyés dans des phrases. | Cartes réservées aux objets (un résumé, un formulaire, une ligne de liste) ; chiffres en tuiles ; textes d'aide repliés. |
| **En-têtes de page** | Titre seul, sans retour ni action ; l'action principale flotte à côté du titre (« + Prospect ») ou se trouve en bas de page, hors de vue. | En-tête de page : retour, titre, sous-titre, action principale ; sur un formulaire, barre d'action collée en bas avec le total. |
| **Navigation** | Aucune navigation permanente : tout passe par la page « Menu » (40 entrées en une colonne, tuiles de hauteurs et de poids inégaux, certaines pleines au hasard) ; sur ordinateur, même colonne centrée de 928 px. | Barre d'onglets en bas sur mobile (4 destinations selon le rôle plus « Plus »), bouton « + » pour les créations rapides ; barre latérale groupée par domaine sur ordinateur. |
| **Retours à l'utilisateur** | Chargement : une ligne de texte ; états vides : une phrase ; confirmations en `window.confirm`. | Squelettes, états vides avec la prochaine action, bandeaux et notifications, feuille de confirmation. |
| **Pastilles d'état** | Une seule famille de verts : « Non payée » et « Payée » se ressemblent (`saleStatusTone` renvoie un ton neutre pour l'impayé). | Quatre tons sémantiques (réussi, attention, alerte, information) distincts de la couleur de marque, plus un point et le texte. |
| **Nombres et montants** | Même graisse partout ; chiffres non alignés ; l'extrémité du tracé des indicateurs est écrasée en ellipse (SVG étiré). | Chiffres tabulaires, police condensée pour les grands nombres, point d'extrémité net. |
| **Densité** | 85 textes sous 14 px sur l'accueil ; hiérarchie à deux niveaux (gras ou non). | Échelle de 12 à 32 px, jamais sous 12 px ; trois niveaux d'encre. |
| **Accueil** | Une section par rôle, mêmes indicateurs répétés (« Chiffre d'affaires du jour » quatre fois) ; actions du jour en tuiles de hauteurs inégales. | Un indicateur n'apparaît qu'une fois ; l'action principale du rôle en tête ; sélecteur de rôle quand l'utilisateur en cumule. |
| **Coquille** | Bandeau « approbation de l'appareil » de 70 px sur chaque écran tant que l'appareil n'est pas approuvé ; pastille de synchronisation en lien souligné. | Bandeau réduit et refermable ; indicateur de synchronisation compact (point, nombre d'opérations en attente), détail dans une feuille. |

## 4. Ruptures de logique métier

- **Vendeur de point de vente** : l'action quotidienne (« + Vente ») est une tuile parmi d'autres sur l'accueil, et le bouton « Enregistrer » d'une vente est sous la ligne de flottaison. La caisse (ouverte ou non, depuis quand) est une phrase de `/pdv`, alors qu'elle conditionne l'encaissement.
- **Commercial terrain** : six actions (service, prospect, visite, vente, commande, dépense) au même niveau ; « Prendre service » est un lien en capitales dans un signal.
- **Magasinier et responsable de ferme** : les opérations de stock (recevoir, transférer, compter, déclarer une perte) ne sont pas sur l'écran de stock ; il faut repasser par le menu.
- **Finance** : créances, dépenses, factures, paiements et trésorerie sont des écrans isolés, sans barre latérale ; les créances sont du texte et des puces là où un tableau (client, dû, échu, échéance, actions) est l'outil naturel.
- **Direction** : la « Tour de contrôle » est annoncée « Bientôt » en tête de l'accueil, devant des actions qui existent.
- **Administration** : un paragraphe d'explication précède la liste des utilisateurs ; le filtre d'état est un groupe de radios.
- **Tous** : le même écran sert un compte à un rôle et un compte à onze rôles ; l'accueil ne se hiérarchise pas par fréquence d'usage.

## 5. Direction visuelle (validée le 30/10/2026, ADR-049)

Maquette envoyée au porteur le 30/10/2026 (accueil d'un vendeur de point de vente, nouvelle vente, thème sombre, créances sur ordinateur). Choix du porteur : style **sobre et aéré**, navigation **onglets en bas avec bouton « + »** sur téléphone (barre latérale sur ordinateur), thème **clair par défaut, sombre au choix**. Le thème automatique, qui suit le téléphone, est une troisième valeur du réglage.

- **Palette** : celle du logo officiel et de la charte des pièces papier. Vert de la banderole `#3a6351` (principal), vert profond `#2b4b3d`, jaune d'œuf `#cdab0a` en accent rare (repère de l'onglet actif, pastille de compteur), neutres légèrement teintés de vert, encre `#15211b`. Le vert très sombre actuel (`#0b3d1e`) n'est pas celui du logo : il est remplacé. Couleurs d'état séparées de la marque : réussi, attention, alerte, information.
- **Typographie** : Noto Sans pour l'interface (4 graisses), Barlow Semi Condensed pour les titres et les grands nombres ; polices déjà dépendances du projet, embarquées, sans réseau. Échelle 12, 13, 15, 17, 20, 24, 32 px ; base de 15 px, champs de 16 px (évite le zoom du téléphone).
- **Forme** : fond clair teinté, cartes blanches à bord fin et ombre très légère, rayon de 8 px pour les contrôles, 12 px pour les cartes, pastilles arrondies ; icônes en traits de 1,8 px, intégrées sans réseau.
- **Navigation** : mobile, barre du haut compacte (titre, synchronisation, compte) et barre d'onglets en bas ; ordinateur, barre latérale verte groupée par domaine, en-tête de page avec actions. Les destinations suivent le rôle (catalogue `role-catalog.ts`).
- **Thèmes** : clair par défaut (usage en plein jour), sombre au choix ou selon le système.
- **Mouvement** : transitions de 120 à 180 ms, supprimées avec `prefers-reduced-motion`.

## 6. Plan par lots

| Lot | Contenu | Critère d'achèvement |
|---|---|---|
| **L0** | Audit, direction, plan (ce document) | Direction validée par le porteur |
| **L1** | Fondations : jetons (`tokens.css`, thèmes clair et sombre), base typographique, composants partagés (bouton, champ, sélecteur, case, interrupteur, segmenté, carte, pastille, onglets, ligne de liste, liste en colonnes, en-tête de page, état vide, squelette, bandeau, feuille, tuile d'indicateur, icônes), page de référence réservée au développement | La page de référence montre chaque composant en clair et en sombre, mobile et bureau ; types et essais verts ; budget NFR-05 tenu |
| **L2** | Coquille et navigation par rôle, connexion, PIN, changement de mot de passe, accueil par rôle | Onglets en bas et barre latérale ; accueil sans indicateur répété ; essais de l'accueil et de la navigation verts |
| **L3** | Ventes et caisse : vente, liste et détail, encaissement, commandes de vente, caisse, point de vente | Barre d'action fixe sur les formulaires ; plus aucun style propre à ces écrans |
| **L4** | Stock : stock, registre, transferts, réceptions, inventaire, perte, consommation, quotas | Actions du stock accessibles depuis l'écran de stock |
| **L5** | Commandes et clients, objectifs, service, catalogue, prix | Portefeuille et fiche client lisibles en bureau et en mobile |
| **L6** | Production : lots, saisie du jour, collecte, incubation, sortie | Saisie du jour réalisable d'une main |
| **L7** | Achats : demandes, bons de commande, réceptions, fournisseurs, rapprochement | Listes en colonnes sur ordinateur |
| **L8** | Finance : trésorerie, créances, dépenses, factures, paiements, coûts et marges, remises | Créances et paiements en tableaux ; tuiles et vieillissement lisibles |
| **L9** | Administration, validations, synchronisation et conflits | Filtres en contrôle segmenté ; explications repliées |
| **L10** | Clôture : une vérification complète, suivi, point dans `CLAUDE.md` | Types, ESLint, essais, construction et contrôle de taille, frontières et références verts |

Chaque lot ferme sur : contrôle visuel mobile et bureau, `typecheck`, essais du domaine (la suite complète d'`apps/pwa` au plus une fois par lot), un commit en français, un point d'avancement avec avant et après sur deux ou trois écrans.

## 6 bis. Développement parallèle des lots L4 à L9

Décision du porteur du 30/10/2026 : après le lot L3, les lots de domaine sont menés **en parallèle** par quatre sessions, chacune en développement séquentiel (un lot à la fois, aucun sous-agent). Les dossiers de chaque lot ne se recouvrent pas ; ce qui est commun a été préparé avant le départ.

| Session | Lots | Périmètre | Suivi |
|---|---|---|---|
| Session principale | L4, puis L10 | `features/stock/`, réapprovisionnement ; clôture sur la fusion | § 8 ter, § 8 quater |
| Fork A | L5, puis L7 | `crm`, `fieldwork`, `catalog`, `pricing`, livraison ; `procurement` | § 8 ter |
| Fork B | L6, puis L9 | `production` ; `users`, `devices`, `approvals`, `sync` (écrans), `attachments` | § 8 ter |
| Fork C | L8 | `finance`, `treasury` | § 8 ter |

Règles qui évitent tout cumul de fichiers :

- **Fichiers communs** (`components/ui/*`, `styles/{tokens,base,components,screens,shell,home}.css`, `app/app.css`, `main.tsx`, `app/screens.ts`, `shell/*`) : personne ne les modifie pendant les lots ; la session principale les ajuste sur demande et retire `app.css` au lot L10. Briques communes déjà posées : `DataCell` pleine largeur (`wide`), rangée d'actions `chip-row`, barre de filtres `filter-bar`, `ref` transmis par `Button`.
- **Une feuille de style par domaine** : `features/<domaine>/<domaine>.css`, importée par les écrans du domaine ; le test des couleurs balaie toutes les feuilles (plus de liste à tenir).
- **Textes** : les clés de `fr.ts` d'un lot s'ajoutent au milieu de ses propres blocs, jamais à leur première ou dernière ligne ; les conflits restants se règlent à la fusion.
- **Suivi** : chaque lot a tenu son propre fichier ; ils sont consolidés dans ce document au lot L10 (§ 8 ter) et supprimés.
- **Questions** : pas d'AV ni d'ADR en route ; les questions s'écrivent `Q-L<n>-<k>` dans le fichier du lot, la session principale les numérote et les enregistre au lot L10 (numéros 486 à 499 pour les AV, 050 et 051 pour les ADR).
- **Machine (8 Go)** : une seule étape lourde à la fois (types, ESLint, essais, construction, serveurs, Chromium), sous un verrou commun hors du dépôt.
- **Fusion** : une branche par session, un commit par lot, aucun push ; la session principale fusionne sur demande du porteur, dans l'ordre L4 à L9, puis le lot L10 vérifie la fusion en une seule passe. **Fait le 31/10/2026** : trois fusions sans aucun conflit (seul `fr.ts` était commun et chaque lot ajoutait ses clés dans ses propres blocs), vérification faite une fois au lot L10 (§ 8 quater).

## 7. Fondations livrées (lot L1)

Le lot L1 est l'infrastructure de tout le reste : un écran qui n'a pas encore été repris profite déjà des jetons et du style des éléments nus (boutons, champs, cases), les lots suivants adoptent les composants.

| Où | Contenu |
|---|---|
| `apps/pwa/src/styles/tokens.css` | Jetons : couleurs clair et sombre (le sombre sous `data-theme="dark"` et, pour « automatique », sous `prefers-color-scheme`), typographie (7 tailles), espacement de 4 px, rayons, ombres, gestes (40 px visibles, 48 px pour l'action principale), mouvement |
| `styles/fonts.css`, `base.css` | Noto Sans (400, 600, 700) et Barlow Semi Condensed (600, 700) en `woff2`, mêmes fichiers que les pièces imprimées ; style des éléments nus : boutons, champs, listes déroulantes, cases et radios dessinées, interrupteur, focus visible, `prefers-reduced-motion` |
| `styles/components.css` | Classes des composants ; aucune couleur en dur |
| `app/app.css` | Feuille héritée, **re-tokenisée** : plus aucune couleur écrite en dur, anciens noms de variables renvoyés aux jetons, règles en conflit avec la base retirées. Retirée au lot L10 (§ 8 quater) |
| `components/ui/` | `Button`, `LinkButton`, `IconButton` · `Field`, `Input`, `Select`, `Textarea`, `Checkbox`, `Radio`, `Switch`, `Segmented` · `Card`, `Section`, `List`, `ListRow`, `DataList` (cartes sur téléphone, colonnes dès 900 px), `Badge`, `Avatar`, `KpiTile`, `Sparkline` · `Banner`, `EmptyState`, `Skeleton`, `Spinner`, `Sheet`, `ToastProvider` et `useToast` · `Tabs`, `TabPanel`, `PageHeader` · `Icon` (47 icônes) · thème (`theme.ts`) |
| `dev/ComponentGallery.tsx` | Page de référence `/dev/composants`, développement seulement : absente de la construction de production (`import.meta.env.DEV`) |

Règles pour les lots suivants :

- **Un seul bouton plein par écran** (`primary`) ; les autres actions en `tonal`, `ghost` ou `outline`. Le bouton nu reste plein pour ne pas casser les écrans non repris : le premier geste d'un lot est de le rétrograder là où il n'est pas l'action principale.
- **Listes** : `List` et `ListRow` sur téléphone, `DataList` quand un écran a plusieurs colonnes ; toujours des `ul` et des `li`, jamais de `table`, pour que les essais par rôle, libellé et texte restent valables.
- **Petits choix exclusifs** (cinq au plus) : `Segmented`, pas une pile de radios ni une liste déroulante.
- **Formulaires** : `Field` relie libellé, aide, erreur et unité au contrôle ; le bouton principal va dans une barre d'action collée en bas (lot L3).
- **Aucune couleur en dur** : `styles/tokens.test.ts` le vérifie sur toutes les feuilles de style (une par domaine comprise), et vérifie les contrastes (texte 4,5 : 1, bordure de champ 3 : 1) dans les deux thèmes.
- Les sélecteurs que les essais utilisent (`text-warn`, `result-warn`, `result-error`, `action-primary`, `home-muted`, `[data-kpi]`) sont conservés tant que l'essai correspondant ne change pas.

## 8. Coquille et navigation livrées (lot L2)

| Où | Contenu |
|---|---|
| `features/shell/` | `Shell` (assemblage), `Bars` (barre du haut, onglets du bas, barre latérale), `Sheets` (actions rapides, menu du compte), `nav-config` (onglets par rôle, actions rapides, domaines de la barre latérale : logique pure, testée) |
| `styles/shell.css`, `styles/home.css` | Coquille et accueil ; les composants viennent de `components.css` |
| Navigation | Téléphone : barre du haut compacte (marque, synchronisation, compte) et onglets du bas : Accueil, deux destinations du rôle, « + », Plus. À partir de 1024 px : barre latérale verte par domaine, repliable, avec l'écran courant marqué. Table des onglets par rôle validée le 30/10/2026 (`ROLE_TABS`). Le « + » ouvre les actions du jour du rôle qui mènent à un écran livré ; il n'apparaît pas pour l'administrateur seul |
| Compte | L'avatar ouvre « Mon compte » : nom et rôles (mémorisés avec la navigation), apparence (Clair, Sombre, Automatique), synchronisation, déconnexion ; la page « Plus » reprend l'apparence et la déconnexion |
| Synchronisation | Pastille compacte : icône et texte, le texte n'est masqué que lorsque tout est synchronisé sur écran étroit (il reste lu) |
| Bandeaux | Composant `Banner` ; le rôle ARIA est porté par le corps du bandeau ; l'approbation de l'appareil est refermable pour la session |
| Connexion, PIN, mot de passe | Logo officiel, champs, boutons et bannières d'erreur partagés ; libellés et noms accessibles inchangés |
| Accueil | Signaux en liste (icône, pastille de gravité, action) ; **un rôle à la fois** avec sélecteur (choix mémorisé pour la session) ; action principale pleine largeur, autres en tuiles, « Bientôt » en dernier ; indicateurs en tuiles. Compte à onze rôles : 11 565 px → 2 496 px sur téléphone, 5 621 px → 1 545 px sur ordinateur |
| Installation | Manifeste, icône d'onglet et d'écran d'accueil : logo officiel réduit (PNG de 5 à 67 Ko, 167 Ko au total) ; couleur de la barre d'état suivant le thème |

Reste pour la suite : l'en-tête de page et la barre d'action des écrans des autres domaines (lots L4 à L9), les écrans « Plus » propres à chaque rôle de bureau.

## 8 bis. Ventes et caisse livrées (lot L3)

| Où | Contenu |
|---|---|
| `styles/screens.css` (nouvelle) | Vocabulaire commun des écrans de saisie et de consultation (titres, blocs, champs, lignes de vente, cartes de ligne, listes de documents, reçus, totaux, alertes, résultats d'opération) restylé **une fois** à partir des jetons. Tous les domaines (stock, achats, finance, production…) en profitent dès maintenant ; les règles correspondantes ont quitté `app/app.css`, qui ne garde que ce qu'aucun lot n'a encore repris |
| `ActionBar` (`components/ui/Nav.tsx`) | Barre d'action collée au-dessus des onglets du bas : résumé (total à encaisser, total de la commande, montant à encaisser) et action principale. Posée sur la vente, la commande, l'encaissement, l'ouverture et la clôture de caisse et l'envoi d'une remise ; le bouton garde son nom accessible et son état désactivé. Un bouton principal resté seul (`submit-sale`, domaines pas encore repris) reste collé mais opaque quand il est inactif : le texte qui défile dessous ne transparaît plus |
| `CommandResult` | Retour d'une opération rendu par `Banner`, le ton suivant la phase (enregistrée, envoyée, acceptée, avertie, en conflit, refusée) ; les clés `…result.*` et le suivi de l'outbox sont inchangés |
| Ventes récentes, commandes | `PageHeader`, lignes de document (client, moment, numéro, montant) et pastilles de situation : paiement d'une vente confirmée, statut d'une commande, « À livrer », « Attend du stock » (`saleListBadge` dans `recent-sales.ts`, `orderStatusTone` dans `open-orders.ts`) ; détail d'une vente et d'une commande sur les mêmes composants |
| Accueil du point de vente | Les actions passent en tête (« Nouvelle vente » pleine largeur, les autres en grille de deux colonnes), la caisse devient une carte avec la pastille Ouverte ou Fermée et son action au même endroit ; ventes du jour, quotas et stock inchangés |
| Caisse, remises de fonds, distribution | `PageHeader` ; carte d'état de la caisse (pastille Ouverte ou Fermée) ; chiffres du comptage dans une carte (`figures-card`) ; bouton principal collé au-dessus des onglets |

Libellés, rôles ARIA et noms accessibles sont inchangés : aucun essai de comportement n'a été modifié (`styles/tokens.test.ts` couvre en plus `screens.css`). Les boutons nus avec `ref` (ouverture d'une remise, d'une annulation) restent des `<button>` : le composant `Button` ne transmet pas encore de `ref` ; ils reprennent le style par la feuille commune.

## 8 ter. Domaines livrés (lots L4 à L9)

Menés par trois sessions en parallèle sur trois branches (fusionnées le 31/10/2026 sans conflit), chacune en développement séquentiel : un lot à la fois, un commit par lot (deux pour L8), contrôle visuel à 375 et 1280 px, clair et sombre. Principe commun : les composants partagés remplacent le vocabulaire hérité ; libellés, rôles ARIA et noms accessibles lus par les essais sont conservés ; une feuille de style par domaine, sans couleur en dur.

| Lot | Domaine | Ce qui change | Essais et construction du lot |
|---|---|---|---|
| **L4** | Stock (`stock`, réapprovisionnement) | Opérations du stock (transférer, recevoir, perte, inventaire, registre, consommation, quotas, réapprovisionnement) en rangée d'actions en tête de l'écran de stock, selon le rôle ; soldes et registre en colonnes (`DataList`) avec pastilles Rupture et Sous le seuil ; formulaires avec `PageHeader`, barre d'action collée et pastilles d'état ; éditeur de lignes (« Ajouter un produit » en bouton pointillé, « Retirer » discret) | 171 essais (stock, distribution, styles) ; un essai ajouté (opérations selon le rôle) et un simulacre d'authentification dans `StockScreen.test.tsx` |
| **L5** | Clients et terrain (`crm`, `fieldwork`, `catalog`, `pricing`, livraison) | Portefeuille en colonnes (cartes sur téléphone) avec filtre de stade segmenté ; fiche client (actions en rangée, tuiles, deux colonnes sur ordinateur) ; prospect, visite, échange ; objectifs avec jauges ; prise de service ; catalogue, règles et simulateur de prix ; livraison ; quatre feuilles de domaine | 261 essais ; un essai modifié : le filtre de stade du portefeuille passe d'une liste déroulante à un contrôle segmenté (même comportement) |
| **L6** | Production (`production`) | Saisie du jour d'une main : nature de la saisie en tuiles, un seul bouton plein dans la barre d'action collée, retour de l'opération ramené sous les yeux ; lots en colonnes dont la ligne entière est le lien ; collecte (reste à répartir dans la barre), mise en place (informations facultatives repliées), incubation, sortie, fiche de lot en tuiles | 112 essais, aucun modifié |
| **L7** | Achats (`procurement`) | Demande d'achat ; fournisseurs ; bons de commande (liste en colonnes, lignes et actions sous la ligne, total dans la barre d'action) ; réceptions ; rapprochement en colonnes avec un point d'attention par écart | 167 essais des domaines voisins, aucun modifié ; construction verte, JavaScript initial 256,8 Ko gzip |
| **L8** | Finance et trésorerie (`finance`, `treasury`) | Phrases d'indicateurs en tuiles ; créances, factures, paiements et comptes en tableaux (`DataList`) avec détail et actions sous la ligne ; vieillissement des créances en barre empilée ordinale (rampe validée pour les deux thèmes) ; saisies en champs reliés et barre d'action collée ; états vides compacts | 250 essais ; quatre fichiers d'essais adaptés dans leur forme (phrases devenues tuiles, mêmes valeurs) ; JavaScript initial 256,9 Ko gzip |
| **L9** | Administration, validations, synchronisation, photo jointe (`users`, `devices`, `approvals`, `sync`, `attachments`) | Filtres d'état en contrôle segmenté, explications repliées (`HelpDisclosure`) ; comptes, appareils et validations en cartes, actions teintées ou à contour ; synchronisation en listes à icônes ; champ photo en boutons teintés | 136 essais du lot et 297 des écrans qui affichent la photo, aucun modifié ; JavaScript initial 257,4 Ko gzip |

Contrôle visuel de chaque lot : aucun débordement horizontal ni erreur de console. Les écrans sans données de démonstration (créances échues, factures, paiements, validations, lots de production) ont été regardés avec des lectures simulées dans l'outil de capture, sans rien livrer. **Non regardés** : les formulaires ouverts sous une ligne (décisions de la finance), les mouvements d'un compte, la création réelle d'un compte ou l'envoi d'une photo au serveur (l'appareil de démonstration attend son approbation). **Aucun écran n'a été vu sur un téléphone réel.**

Questions posées par les sessions et suites (décision du porteur du 31/10/2026) :

| Question | Sujet | Suite |
|---|---|---|
| Q-L5-1 | Retours « ← … » | Adoptée : un seul lien de retour (§ 8 quater) |
| Q-L5-2 | Bouton « Appeler » sur la fiche client | Adoptée (§ 8 quater) |
| Q-L5-3 | Éditeur de règle de prix : erreurs dès l'ouverture | Laissée au registre : AV-486 |
| Q-L6-1 | Bouton « Fiche de suivi de la semaine » (module des pièces) | Laissée au registre : AV-488 |
| Q-L6-2 | Onglets du bas du responsable de ferme | Adoptée (§ 8 quater) |
| Q-L7-1 | Pastille de statut dans le rapprochement | Non retenue à ce jour (ADR-050) |
| Q-L8-1 | Barre de vieillissement de tout l'encours | Adoptée (§ 8 quater) |
| Q-L8-2 | Solde des comptes de la trésorerie et total du serveur | Laissée au registre : AV-487 |
| Q-L9-1 | Aide repliée en composant commun | Non retenue à ce jour (ADR-050) |
| Q-L9-2 | Bouton à contour rouge pour les actions destructives | Non retenue à ce jour (ADR-050) |

Briques communes que les lots ont contournées dans leurs feuilles de domaine (ADR-050 §7) : marge portée par `Banner` et `Section`, ligne de liste en colonnes cliquable (`DataRow` avec lien), contrôle segmenté avec libellé visible, état vide compact, `ref` transmis par `Input`, `Select` et `Textarea`, état à point dont le texte passe à la ligne, barre empilée ordinale, ligne extensible, cadre « position ». À promouvoir en composants si un cinquième domaine refait le même contournement.

Notes de lots à garder : les groupes de choix exclusifs « Nature de la perte » (six choix) et « Opération » des transferts (deux choix) restent des boutons radio (un contrôle segmenté conviendrait au second) ; `move-detail` (`stock/stock.css`) est l'équivalent de `doc-main small` sans coupure de ligne ; les écrans de chargement passent de « Chargement… » à `SkeletonRows` (même nom accessible) ; les rôles ARIA d'origine sont conservés sur les bandeaux.

## 8 quater. Clôture (lot L10)

| Où | Contenu |
|---|---|
| Fusion | Les trois branches des sessions fusionnées dans la branche du chantier, dans l'ordre, sans conflit : `refs/heads/claude/refonte-l5-l7-79286f` (L5, L7), `refs/heads/claude/refonte-l6-l9-7e4005` (L6, L9), `refs/heads/claude/refonte-l8-45f38c` (L8). Rien de poussé |
| Retours | `BackLink` (`components/ui/Nav.tsx`) : le lien de retour de l'en-tête de page, utilisable seul par les écrans qui gardent leur propre titre (reçu d'une vente, détail d'une commande) ou n'en ont pas (élément introuvable). Sept retours « ← … » passent à `PageHeader` ou à `BackLink`, la flèche quitte les libellés (`fr.ts`), la classe `back-link` disparaît ; le retour des transferts et des réceptions du lot L4 n'affiche plus deux flèches. Quatre essais lisaient le nom du lien avec la flèche : ils lisent le même lien sans elle |
| Appeler | `AnchorButton` (`components/ui/Button.tsx`) : lien hors de l'application (téléphone, courriel) qui a l'apparence d'un bouton. Fiche client : « Appeler » ouvre la rangée d'actions quand le compte a un numéro ; « Noter un échange » prend l'icône du crayon. Un essai ajouté (numéro, première place, absence sans numéro) |
| Créances | La barre de vieillissement montre tout l'encours : segment gris neutre « à échoir » puis les quatre tranches échues ; titre « Encours par retard » ; la ligne « À échoir » ouvre la légende, la liste des quatre tranches échues est inchangée. Une assertion ajoutée à l'essai de l'encours |
| Responsable de ferme | Onglets du bas : Saisie du jour et Collecte (le stock passe dans « Plus » et sert de repli si la collecte n'est pas proposée) ; l'essai de `tabsForRoles` suit |
| `app/app.css` retiré | Règles encore employées reprises dans `styles/screens.css` (vocabulaire hérité : `error-message`, `alert`, `home-muted`, `home-banner`, `action*`, `text-input`, `text-warn`, pièces papier, impression) et `features/auth/auth.css` (écrans de connexion) ; alias de variables, `form-field`, `outbox-list` et règles de l'ancien champ photo supprimés ; la règle d'impression masque `page-back` au lieu de `back-link` |
| Reliquats corrigés | Grille d'avancement du détail d'une commande : trois paires par rangée sur téléphone, les libellés ne se chevauchent plus ; « Changer » du sélecteur de compte en `Button` ; l'essai de la relecture des dettes (L8) contrôle de nouveau le montant ; clé `portfolio.outstanding` retirée |

Vérification, **une seule fois** sur le résultat fusionné (31/10/2026, sous le verrou commun) :

| Contrôle | Résultat |
|---|---|
| Types (`pnpm --filter @gic/pwa run typecheck`) | 0 erreur |
| ESLint (`npx eslint apps/pwa`) | 0 erreur ; 1 avertissement antérieur à la refonte (`AuthContext.tsx`, `react-refresh/only-export-components`) |
| Essais (`npx vitest run` dans `apps/pwa`) | 106 fichiers passés (1 ignoré), 983 essais passés (1 ignoré : `pieces/apercu.test.ts`, ignoré avant la refonte) |
| Construction et budget NFR-05 (`build`, `tools/size-check.mjs`) | Réussie ; JavaScript initial **257,5 Ko gzip** pour un budget de 300 Ko ; écrans chargés à la demande 264,5 Ko, hors budget |
| Frontières (`pnpm run check:boundaries`) | Aucune violation (694 modules) |
| Références (`python docs/_tools/check_refs.py`) | Aucune référence orpheline, aucun identifiant défini deux fois, aucun lien relatif cassé |
| Prettier | Appliqué fichier par fichier, depuis la racine, aux fichiers touchés |

Essais modifiés au lot L10, comportement inchangé : quatre noms de lien de retour sans flèche (`CustomerScreen`, `InteractionScreen`, `ReceiptScreen`, `ReceiveTransferScreen`) ; la table des onglets de la ferme (`nav-config.test.ts`) ; la relecture des dettes (`SupplierInvoicesScreen`, assertion renforcée). Essais ajoutés : « Appeler » ; ligne « À échoir » de la légende.

Reste à faire (hors de la refonte) : le contrôle dans un navigateur sur un téléphone réel ; AV-486 à AV-488 ; le bandeau d'approbation de l'appareil, qui prend environ 120 px en haut de chaque écran tant que l'appareil n'est pas approuvé (constat du lot L6, à raccourcir) ; la reprise des briques communes contournées si un domaine rouvre ; la fusion de la branche dans `main` et la mise en ligne, **sur demande explicite du porteur**.

## 9. Outils de vérification

- **Relevé et captures sans fenêtre** : Chromium déjà installé (révision 1234) piloté par Playwright, profil persistant (appareil et code PIN conservés), navigation interne sans rechargement. Il rend les écrans en 375 px et 1280 px, clair et sombre, et relève par écran : débordement horizontal, boutons, contrôles natifs, tailles de police, tableaux, erreurs de console. Le navigateur intégré à l'application reste utilisable pour un coup d'œil, mais sa fenêtre est parfois masquée et les captures échouent alors.
- **Base locale** : `gic_agropelc_refonte`, neuve (migrations, semis, `demo:data`), compte de démonstration à onze rôles ; jamais la base partagée des essais.

## 10. Journal

| Date | Fait |
|---|---|
| 30/10/2026 | Audit des 61 écrans (mesures § 2), maquette de la direction (§ 5), plan par lots (§ 6). Direction validée par le porteur (style, navigation, thème) ; ADR-049 rédigé. Lot L0 clos. |
| 30/10/2026 | Lot L1 (fondations, § 7) : jetons clair et sombre, polices, base, composants partagés, page de référence, `app.css` re-tokenisée. |
| 30/10/2026 | Lot L2 (coquille et navigation, § 8) : barre du haut, onglets du bas avec « + », barre latérale, menu du compte, connexion, accueil à un rôle à la fois, logo officiel (icônes d'installation). |
| 30/10/2026 | Lot L3 (ventes et caisse, § 8 bis) : vocabulaire commun des écrans restylé (`screens.css`), barre d'action collée sur la vente, la commande et l'encaissement, listes avec pastilles de situation, accueil du point de vente et caisse en cartes. |
| 30/10/2026 | Socle commun du développement parallèle des lots L4 à L9 (§ 6 bis) : balayage automatique des feuilles de style, briques communes (cellule pleine largeur, rangée d'actions, barre de filtres, `ref` du bouton), suivi par lot. |
| 31/10/2026 | Lots L4 à L9 (§ 8 ter) : stock (session principale), clients, terrain, catalogue, prix et achats (session A), production, administration, validations, synchronisation et photo jointe (session B), finance et trésorerie (session C) ; trois branches, un commit par lot (deux pour L8). |
| 31/10/2026 | Lot L10 (clôture, § 8 quater) : fusion des trois branches sans conflit ; retours en en-tête (`BackLink`), « Appeler » (`AnchorButton`), vieillissement de tout l'encours, onglets de la ferme ; `app.css` retiré ; vérification complète ; ADR-050, AV-486 à AV-488. |
