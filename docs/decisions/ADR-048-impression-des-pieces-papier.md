# ADR-048 — Impression et consultation des opérations dans la mise en page des pièces papier

- **Statut** : ACCEPTÉ (choix du porteur du 26/10/2026 pour la fidélité exacte et la facture ; le reste est DÉDUIT, technique)
- **Date** : 26/10/2026
- **Précise** : AV-309 (choix (a), rendu fidèle au gabarit), AV-310 (choix (a)), AV-311 (en partie), AV-324 (défaut provisoire), ADR-006 (rien ne disparaît), ADR-021 (logique partagée)
- **Questions liées** : AV-041, AV-309, AV-310, AV-311, AV-323, AV-324, AV-451 ; REQ-301, REQ-302, REQ-304, REQ-309

## Contexte

Le porteur a conçu 25 pièces papier aux couleurs de GIC AGROPELC (`pieces-papier/` : gabarits HTML produits par `_generation/lib.mjs`, feuille `charte/pieces.css`, aperçus `apercu/*.png`, dossier de validation et cahier des charges de l'imprimeur en PDF). Il demande, le 26/10/2026, que toute opération imprimée par l'application reproduise **exactement** la pièce correspondante : « que les modèles soient exactement tels que je les ai codés, tels que je les ai conçus en PDF ». **CONFIRMÉ**.

AV-309 recommandait un composant de la PWA par pièce et « pas de source HTML commune avec le dossier papier ». Un composant redessiné à la main ne garantit pas la fidélité demandée : chaque marge, chaque filet et chaque rubrique devrait être recopié et maintenu deux fois. **DÉDUIT**.

Deux autres décisions du porteur, le même jour : la **facture** (FA) est imprimée par l'application (D3 est levé), et le comptable a déjà validé son modèle. **CONFIRMÉ**.

## Décision

1. **Même balisage, même feuille de style que le papier.**
   - `apps/pwa/src/features/pieces/charte.css` est la copie à l'octet de `pieces-papier/charte/pieces.css`.
   - `gabarit.ts` est le portage en TypeScript de `_generation/lib.mjs` : mêmes fonctions (`entete`, `champ`, `cases`, `lignes`, `montant`, `lettres`, `signatures`, `pied`…), mêmes classes, mêmes dimensions. La seule différence est la valeur écrite dans chaque case.
   - Les ajouts de l'application sont isolés dans `valeurs.css` : valeur écrite dans une case, case cochée, deux lignes au plus dans une cellule de tableau, tampons, aperçu à l'écran. La charte n'est jamais modifiée dans l'application.
   - Un test vérifie que `charte.css` est la copie de `pieces.css` et que l'identité imprimée est celle de `identite.json` : une retouche du porteur sur son dossier fait échouer le test tant que la copie n'est pas reprise.
2. **Une pièce est un document autonome** posé dans une `iframe` (`srcdoc`) :
   - feuille de style du papier isolée de l'application ;
   - `@page` à la taille de la pièce (A5 paysage, A4 portrait…, marges nulles : le cadre de la pièce porte ses propres marges) ;
   - impression par `contentWindow.print()`, après le chargement des polices.
   - Le même rendu sert à consulter l'opération (REQ-302) et à l'imprimer (REQ-301). Tout est calculé sur l'appareil, à partir des données déjà chargées par l'écran : utilisable hors ligne. Le logo et les polices sont dans le pré-cache du service worker (`png` et `woff2`).
3. **Polices.** Les gabarits demandent *Segoe UI* et *Bahnschrift*. Elles restent en tête de la pile : un poste Windows imprime avec elles. Ailleurs, l'application embarque deux polices libres de mêmes proportions :
   - Noto Sans pour le texte, réduite à 94 % (`size-adjust`) pour garder la chasse de Segoe UI ;
   - Barlow Semi Condensed pour les titres.
   - Contrôle : les 16 pièces, rendues avec ces polices et comparées aux aperçus du porteur, tiennent dans leur cadre sans débordement.
4. **Pas de souche** (D1). Le corps de la pièce occupe toute la feuille, avec les marges de la souche (fonction `standard`).
5. **Mentions** (AV-310 (a)) :
   - numéro imprimé : `doc_number`, sinon la référence locale, sinon « EN ATTENTE » ;
   - réimpression : tampon « DUPLICATA » avec sa date, décidé par un marqueur local écrit à la première impression ;
   - opération annulée : tampon « ANNULÉE » et case « pièce annulée » cochée.
   - Imprimer n'est pas une écriture métier : aucune commande, aucune migration, aucune permission.
6. **Pagination.** Au-delà des lignes du gabarit, la pièce passe sur une feuille suivante numérotée « page i/n ». Le journal des encaissements reporte ses totaux d'une feuille à l'autre.
7. **Données.** Des adaptateurs purs (`adaptateurs-ventes.ts`, `-finance.ts`, `-achats.ts`, `-stock.ts`) traduisent les données des écrans en rubriques de la pièce. Une valeur inconnue reste la ligne pointillée du papier, à compléter à la main : on n'invente jamais une valeur. Le montant en lettres est une fonction pure de `packages/domain` (`amountXafInFrenchWords`, règle 6).
8. **Seize pièces** sont imprimables depuis leur écran :

   | Pièces | Écran |
   |---|---|
   | BV, FA, RE | détail d'une vente |
   | CC | détail d'une commande |
   | BL | livraison saisie |
   | BD | dépense ; paiement fournisseur |
   | RF | remise de fonds |
   | FJC | mouvements d'un compte de trésorerie, pour le jour |
   | JE | ventes, sur 7 jours |
   | DA | demande d'achat |
   | BC | bon de commande |
   | BR | réception |
   | BT | transfert reçu |
   | FI | inventaire |
   | FP | perte saisie |
   | FL | saisie du jour d'un lot, pour la semaine |

   Les autres pièces (VC, PT, BH, RC, papeterie) n'ont pas d'opération correspondante dans l'application aujourd'hui.
9. **Facture** (choix du porteur du 26/10/2026) :
   - imprimée sans la mention « modèle provisoire » ;
   - prix TTC et TVA à 0, conformément à AV-041 ;
   - le régime de TVA et la mention d'exonération restent à cocher à la main tant qu'AV-451 n'est pas tranché.
10. **Identité de la société.** Elle est copiée de `identite.json` dans `identite.ts` (AV-324, choix (b), provisoire). Une rubrique vide s'imprime en pointillés. Le défaut d'AV-324 (paramètres de l'organisation) reste à construire.

## Conséquences

- Une modification d'une pièce par le porteur se reprend en recopiant `pieces.css` et, si le balisage change, la fonction concernée de `gabarit.ts` ; le test de fidélité le signale.
- Les pièces s'impriment depuis un téléphone ou un ordinateur, hors ligne comprise. Sur iOS, `@page size` est mal pris en charge : l'utilisateur choisit le format dans la boîte d'impression.
- Le marqueur de réimpression n'est connu que de l'appareil (AV-310) : une pièce imprimée sur un autre appareil n'y est pas reconnue comme déjà imprimée.

### Limites connues

- **FJC** : sans numéro de pièce. La lecture `GET /cash-accounts/{id}/movements` ne rend ni le numéro du document, ni son mode de paiement, ni sa session : à étendre (AV-311). La feuille est donc remplie avec le type de mouvement comme libellé.
- **BD** d'un paiement fournisseur : sans les numéros des factures réglées, qui ne sont pas lus.
- **Fenêtres de conservation** : sur l'appareil, les ventes sont gardées 7 jours, les dépenses de l'auteur 30 jours. Une pièce plus ancienne ne se produit qu'en ligne, quand l'écran la lit.
- **Rubriques non portées par l'application** : laissées en pointillés. Exemples : transporteur, lot fournisseur, péremption, NIU du client, prix estimé d'une demande d'achat.
- **Comparaison des rubriques** à `CORRESPONDANCE-APPLICATION.xlsx` (recommandation d'AV-309) : pas encore automatisée.
- **Opérations sans pièce propre** (AV-323) : pas encore de mise en page générique.
