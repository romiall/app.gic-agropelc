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
   - impression par `contentWindow.print()`, après le chargement des polices ;
   - aucun script dans la pièce : le document porte une politique de sécurité `script-src 'none'` (défense en profondeur, toutes les valeurs étant déjà échappées).
   - Le même rendu sert à consulter l'opération (REQ-302) et à l'imprimer (REQ-301). Tout est calculé sur l'appareil, à partir des données déjà chargées par l'écran : utilisable hors ligne. Le logo et les polices sont dans le pré-cache du service worker (`png` et `woff2`).
3. **Polices.** Les gabarits demandent *Segoe UI* et *Bahnschrift*. Elles restent en tête de la pile : un poste Windows imprime avec elles. Ailleurs, l'application embarque deux polices libres de mêmes proportions :
   - Noto Sans pour le texte (normal, demi-gras et gras), réduite à 94 % (`size-adjust`) pour garder la chasse de Segoe UI ;
   - Barlow Semi Condensed pour les titres.
   - Contrôle : les 16 pièces, rendues avec ces polices et comparées aux aperçus du porteur, tiennent dans leur cadre sans débordement.
4. **Pas de souche** (D1). Le corps de la pièce occupe toute la feuille, avec les marges de la souche (fonction `standard`).
5. **Mentions** (AV-310 (a)) :
   - numéro imprimé : `doc_number`, sinon la référence locale, sinon « EN ATTENTE » ;
   - réimpression : tampon « DUPLICATA » avec sa date, décidé par un marqueur local écrit à la première impression ; dès que la pièce a été imprimée sur l'appareil, l'aperçu porte déjà le tampon, si bien que chaque réimpression part directement du geste de l'utilisateur ;
   - le navigateur ne dit pas si l'impression a été annulée : la première impression est notée à l'ouverture de la boîte d'impression, et une impression annulée rend la suivante « DUPLICATA » ;
   - pour un registre (FJC, JE), la clé du marqueur porte le contenu (nombre de lignes et total) : une feuille complétée depuis la dernière impression est une autre feuille, pas un duplicata ;
   - opération annulée : tampon « ANNULÉE » et case « pièce annulée » cochée.
   - Imprimer n'est pas une écriture métier : aucune commande, aucune migration, aucune permission.
6. **Pagination.** Au-delà des lignes du gabarit, la pièce passe sur une feuille suivante numérotée « page i/n », dont les lignes poursuivent la numérotation. Le journal des encaissements, dont la case du numéro est « Page N° », y porte le numéro de feuille et reporte ses totaux d'une feuille à l'autre.
7. **Données.** Des adaptateurs purs (`adaptateurs-ventes.ts`, `-finance.ts`, `-achats.ts`, `-stock.ts`) traduisent les données des écrans en rubriques de la pièce. Une valeur inconnue reste la ligne pointillée du papier, à compléter à la main : on n'invente jamais une valeur (un porteur de fonds n'est pas le destinataire, l'auteur d'une commande n'est pas son commercial, un fournisseur inconnu n'est pas un bout d'identifiant). Le montant en lettres est une fonction pure de `packages/domain` (`amountXafInFrenchWords`, règle 6). Règles retenues après la revue adverse du 26/10/2026 :
   - **prix** : le serveur tarife par unité de base, ou au kg pour un produit vendu au poids. La pièce ramène le prix à l'unité vendue quand il tombe juste (2 plateaux à 3 000), sinon écrit la quantité et le prix en unité de base ; au poids, elle écrit le poids et le prix au kg (la facture compte alors en kg). Le poids et la quantité tarifée se lisent dans le montant brut, arrondis à trois décimales (DÉDUIT, exact dès 1 000 XAF le kg) ;
   - **annulation partielle** : une ligne annulée en entier n'est plus imprimée, une ligne entamée l'est pour sa part restante ; le total imprimé est la somme des lignes. Une vente annulée en entier garde ses lignes d'origine sous le tampon « ANNULÉE » ;
   - **reçu** : le « reste dû » est le solde de la vente juste après cet encaissement, pas celui du jour de l'impression ; un encaissement qui règle aussi autre chose laisse l'objet à écrire ;
   - **journal des encaissements** : seuls les encaissements retenus (`RECORDED`, `CANCELLATION_REQUESTED`) ; ni annulés, ni refusés, ni doublons présumés ; un remboursement est une sortie (BD) ;
   - **bon de décaissement** : seulement une fois l'argent sorti (dépense payée ; paiement fournisseur enregistré, ou annulé après décaissement) ;
   - **bon de réception** : pas pour une réception en quarantaine ou refusée (non comptabilisée) ;
   - **feuille de caisse** : offerte seulement quand tous les mouvements du jour sont chargés ;
   - **suivi de lot** : les consommations d'aliment seulement, en kg quand l'unité le permet (sinon la case reste vide) ; une mortalité rejetée avec retour en stock n'est pas comptée, une mortalité jugée non justifiée l'est (AV-038).
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
   - imprimée sans la mention « modèle provisoire », et son pied dit seulement « Facture numérotée en continu » : la réserve « les mentions légales et le taux de TVA sont à valider avec le comptable avant impression » du gabarit est levée par la validation du comptable ;
   - la somme en lettres est celle du total TTC, non du reste à payer ;
   - prix TTC et TVA à 0, conformément à AV-041 ;
   - le régime de TVA et la mention d'exonération restent à cocher à la main tant qu'AV-451 n'est pas tranché.
10. **Identité de la société.** Elle est copiée de `identite.json` dans `identite.ts` (AV-324, choix (b), provisoire). Une rubrique vide s'imprime en pointillés. Le défaut d'AV-324 (paramètres de l'organisation) reste à construire.

## Conséquences

- Une modification d'une pièce par le porteur se reprend en recopiant `pieces.css` et, si le balisage change, la fonction concernée de `gabarit.ts` ; le test de fidélité le signale.
- Les pièces s'impriment depuis un téléphone ou un ordinateur, hors ligne comprise. Sur iOS, `@page size` est mal pris en charge : l'utilisateur choisit le format dans la boîte d'impression. **À vérifier sur appareil** : sur certains navigateurs mobiles (iOS Safari, versions de Chrome Android), `print()` appelé sur une `iframe` peut imprimer la page entière ; le service worker doit aussi servir le logo et les polices à l'`iframe` `srcdoc` hors ligne (prévu par la spécification, non essayé sur un téléphone).
- Le marqueur de réimpression n'est connu que de l'appareil (AV-310) : une pièce imprimée sur un autre appareil n'y est pas reconnue comme déjà imprimée.

### Limites connues

- **FJC** : sans numéro de pièce. La lecture `GET /cash-accounts/{id}/movements` ne rend ni le numéro du document, ni son mode de paiement, ni sa session : à étendre (AV-311). La feuille est donc remplie avec le type de mouvement comme libellé.
- **BD** d'un paiement fournisseur : sans les numéros des factures réglées, qui ne sont pas lus.
- **Fenêtres de conservation** : sur l'appareil, les ventes sont gardées 7 jours, les dépenses de l'auteur 30 jours. Une pièce plus ancienne ne se produit qu'en ligne, quand l'écran la lit.
- **Rubriques non portées par l'application** : laissées en pointillés. Exemples : transporteur, lot fournisseur, péremption, NIU du client, prix estimé d'une demande d'achat.
- **Comparaison des rubriques** à `CORRESPONDANCE-APPLICATION.xlsx` (recommandation d'AV-309) : pas encore automatisée.
- **Opérations sans pièce propre** (AV-323) : pas encore de mise en page générique.
