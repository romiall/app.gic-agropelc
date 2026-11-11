# Guide de l’application GIC AGROPELC

> **Généré** à partir du contenu de l’aide de l’application (`apps/pwa/src/features/help/content/`) : c’est le même texte que le bouton « ? » de chaque page et que l’écran « Guide et aide ». Ne le modifiez pas à la main : corrigez le contenu, puis régénérez avec `GIC_WRITE_GUIDE=1 pnpm --filter @gic/pwa exec vitest run src/features/help/guide-doc.test.ts`. Un essai échoue tant que ce fichier n’est pas à jour.

## 1. Comment lire ce guide

- **Chaque page de l’application a son aide** : le bouton « ? » en haut de l’écran dit à quoi sert la page, ce que votre profil peut y faire, ce qui demande un autre rôle (et lequel), ce qu’il faut avoir fait avant et l’étape suivante.
- **Les droits dépendent du rôle** : un compte reçoit un ou plusieurs rôles ; un rôle de terrain (responsable de ferme, magasinier, vendeur) est rattaché à un site. Une page ou un bouton absent veut dire « votre rôle ne porte pas cette fonction », pas « la fonction n’existe pas ».
- **Rien ne se supprime** : on corrige par annulation motivée ; l’historique reste.
- **Hors ligne** : la plupart des saisies du terrain restent sur le téléphone et partent au retour du réseau ; l’administration, la finance, l’analyse, la clôture d’un lot et les annulations demandent le réseau.

### Les rôles

| Code | Rôle |
|---|---|
| DIR | Direction |
| ADM | Administrateur |
| RCO | Responsable commercial |
| CTE | Commercial terrain |
| CSE | Commercial sédentaire |
| VEN | Vendeur de point de vente |
| RPR | Responsable production |
| RFE | Responsable de ferme |
| MAG | Magasinier |
| ACH | Responsable achats |
| FIN | Finance |
| SUP | Supervision consultative |

## 2. Les parcours de bout en bout

### Mettre l’application en route

Déclarer l’entreprise, ses sites, ses produits et ses comptes avant que le terrain ne travaille.

*Écrit pour : Administrateur.*

| # | Étape | Page | Qui | Ce qu’on y fait |
|---|---|---|---|---|
| 1 | Organisation | `/administration/organisation` | Administrateur | Créez la ferme et ses bâtiments ou cases, un magasin d’aliment sur la ferme, le magasin central, les points de vente et les zones. |
| 2 | Catalogue | `/catalogue` | Administrateur | Vérifiez ou créez les produits : poussin d’un jour, aliment, œufs et leurs calibres, poulet de chair vif, porcelet… |
| 3 | Comptes et rôles | `/administration/utilisateurs` | Administrateur | Créez les comptes (responsable de production, responsable de ferme, magasinier, vendeurs) et affectez chaque rôle de terrain à son site. |
| 4 | Appareils | `/administration/appareils` | Direction, Administrateur, Responsable commercial, Responsable production, Responsable de ferme, Magasinier | À sa première connexion, chaque personne enrôle son téléphone ; vous le reconnaissez à son code court et vous l’approuvez. |
| 5 | Paramètres et politiques | `/administration/parametres` | Direction, Administrateur | Réglez les seuils et les contrôles : validation des mortalités, caisse exigée ou non, délais d’annulation… |
| 6 | Chargement de données | `/chargement` | Administrateur, Responsable commercial, Finance, Direction | Chargez par fichier CSV les produits, fournisseurs, clients et le stock d’ouverture. Un lot déjà en élevage se reprend par la rubrique « Reprise d’un lot » de Production → Nouveau lot (ou par le chargement « Lots en cours ») ; la Direction valide la reprise. |

### Démarrer et conduire un lot d’élevage

Du premier achat d’animaux à la clôture du lot : poulets de chair, pondeuses, porcs.

*Écrit pour : Responsable production, Administrateur, Responsable de ferme.*

| # | Étape | Page | Qui | Ce qu’on y fait |
|---|---|---|---|---|
| 1 | Enregistrer l’achat des animaux | `/achats/receptions/sans-bon` | Magasinier, Responsable de ferme, Responsable production, Administrateur | Réception sans bon de commande : le fournisseur, les animaux, l’aliment, le prix unitaire (obligatoire) et le code du lot fournisseur. Les animaux entrent en stock sur la ferme. |
| 2 | Créer le lot | `/production/nouveau-lot` | Responsable production, Administrateur | Rubrique « Nouveau lot » : ferme, type de lot, animaux, bâtiment principal. Le lot est planifié. |
| 3 | Faire entrer les animaux | `/production/nouveau-lot` | Responsable production, Administrateur | Rubrique « Entrée dans un lot » : origine « réception d’achat » ou « stock de la ferme », nombre de têtes. La première entrée rend le lot actif. |
| 4 | Saisir la journée | `/production/lots` | Responsable production, Responsable de ferme, Administrateur | Chaque jour, touchez le lot : mortalité, aliment, pesée, observation. Possible sans réseau. |
| 5 | Valider les mortalités | `/validations` | Direction, Responsable production, Responsable de ferme | Les mortalités que la politique de contrôle soumet à validation attendent la décision d’un responsable, dans Validations. L’Administrateur seul dépose les mortalités mais ne les valide pas. |
| 6 | Envoyer à la vente | `/production/sortie` | Responsable de ferme, Responsable production, Administrateur | Déclarez le lot prêt à la vente puis envoyez les animaux vers un magasin ou un point de vente. |
| 7 | Clôturer le lot | `/production/fiche` | Responsable production, Direction, Supervision consultative, Administrateur | Quand tous les animaux sont partis et que les mortalités sont traitées, clôturez : le coût est figé et la marge se lit sur la fiche. |

### Collecter les œufs et faire éclore

Une ferme de pondeuses : œufs du jour, œufs à vendre, œufs à couver, poussins.

*Écrit pour : Responsable de ferme, Responsable production, Administrateur.*

| # | Étape | Page | Qui | Ce qu’on y fait |
|---|---|---|---|---|
| 1 | Avoir un lot de pondeuses actif | `/production/lots` | Responsable production, Responsable de ferme, Administrateur | Voir « Démarrer et conduire un lot » : le type de lot est « Pondeuses » ou « Reproducteurs ». |
| 2 | Collecter les œufs | `/production/collecte` | Responsable production, Responsable de ferme, Administrateur | Chaque jour : collectés, cassés, non conformes, à couver, et le reste par calibre. Le bilan doit tomber juste. |
| 3 | Mettre à couver | `/production/incubation` | Responsable de ferme, Responsable production, Administrateur | « Démarrer un lot » : choisissez l’incubateur et les œufs à couver. |
| 4 | Mirage, transfert, éclosion | `/production/incubation` | Responsable de ferme, Responsable production, Administrateur | Au jour prévu, enregistrez le mirage, transférez vers l’éclosoir, puis l’éclosion : les poussins entrent en stock. |
| 5 | Mettre les poussins en place | `/production/nouveau-lot` | Responsable production, Administrateur | Créez un lot de poulets de chair et faites-y entrer les poussins depuis le stock de la ferme. |
| 6 | Vendre les œufs commercialisables | `/ventes/nouvelle` | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme | Les œufs par calibre sont en stock : vente directe ou transfert vers un point de vente. |

### Acheter et réceptionner une livraison

De la demande d’achat au paiement du fournisseur.

*Écrit pour : Responsable achats, Magasinier, Responsable de ferme.*

| # | Étape | Page | Qui | Ce qu’on y fait |
|---|---|---|---|---|
| 1 | Demande d’achat | `/achats/demandes` | Direction, Responsable production, Responsable de ferme, Magasinier, Responsable achats, Finance, Administrateur | Le demandeur exprime son besoin (produits, quantités, justification). |
| 2 | Bon de commande | `/achats/bons-de-commande` | Responsable achats | Le responsable des achats commande auprès d’un fournisseur ; la Direction valide au-dessus du seuil. |
| 3 | Réception | `/achats/receptions` | Magasinier, Responsable de ferme, Responsable production, Administrateur | À la livraison, le magasinier compte : livré, rejeté, accepté ; l’accepté entre en stock. |
| 4 | Facture fournisseur | `/finance/factures` | Direction, Supervision consultative, Responsable achats, Finance | La Finance saisit la facture ; elle est rapprochée du bon de commande et de la réception. |
| 5 | Paiement | `/finance/paiements` | Direction, Supervision consultative, Responsable achats, Finance | La Finance paie ; au-delà du seuil, la Direction décide. |
| 6 | Rapprochement | `/achats/rapprochement` | Responsable achats, Finance, Direction, Supervision consultative | Commandé, livré, accepté, facturé, payé : repérez les écarts. |

### Approvisionner un point de vente et vendre

La journée d’un point de vente, de l’ouverture de la caisse à la remise des fonds.

*Écrit pour : Vendeur de point de vente, Magasinier.*

| # | Étape | Page | Qui | Ce qu’on y fait |
|---|---|---|---|---|
| 1 | Ouvrir la caisse | `/caisse` | Vendeur de point de vente, Finance | Comptez le fonds de caisse (si la caisse est exigée pour le site). |
| 2 | Demander du stock | `/pdv/reapprovisionnement` | Vendeur de point de vente | Le vendeur demande un réapprovisionnement (produits sous le seuil suggérés). |
| 3 | Expédier | `/stock/transferts` | Magasinier, Responsable de ferme, Responsable production, Administrateur | Le magasinier expédie ou refuse la demande. |
| 4 | Recevoir | `/stock/receptions` | Commercial terrain, Vendeur de point de vente, Responsable production, Responsable de ferme, Magasinier, Administrateur | Le vendeur compte à l’arrivée ; un écart part en validation. |
| 5 | Vendre | `/ventes/nouvelle` | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme | Vente rapide, encaissement intégré, reçu. |
| 6 | Clôturer la caisse | `/caisse` | Vendeur de point de vente, Finance | Comptez l’espèce ; le serveur calcule l’écart. |
| 7 | Remettre les fonds | `/caisse/remises` | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Finance | Remise de l’espèce à la Finance. |
| 8 | Inventaire | `/stock/inventaire` | Magasinier, Vendeur de point de vente, Responsable de ferme, Responsable production, Administrateur | Comptez le stock du point de vente ; les écarts se valident. |

### Prendre une commande et la livrer payée

Du client identifié à l’encaissement.

*Écrit pour : Responsable commercial, Commercial terrain, Commercial sédentaire.*

| # | Étape | Page | Qui | Ce qu’on y fait |
|---|---|---|---|---|
| 1 | Ajouter le client | `/clients/nouveau` | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme | Prospect créé, puis proposé à la vente. |
| 2 | Passer la commande | `/commandes/nouvelle` | Responsable commercial, Commercial terrain, Commercial sédentaire | Articles, date de livraison, acompte facultatif. Aucun contrôle d’argent à la commande. |
| 3 | Suivre la commande | `/commandes` | Direction, Supervision consultative, Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Magasinier, Finance | Vendue, livrée, en attente de stock. |
| 4 | Livrer | `/commandes` | Direction, Supervision consultative, Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Magasinier, Finance | Depuis la commande : quantités remises. Le client paie avant la livraison, sauf client autorisé au crédit. |
| 5 | Encaisser | `/encaisser` | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Finance | Règlement reçu, affecté à la créance la plus ancienne. |

### Corriger une erreur

Rien ne se supprime : on corrige par annulation motivée, et l’historique reste.

*Écrit pour : Responsable production, Responsable de ferme, Administrateur, Magasinier, Vendeur de point de vente.*

| # | Étape | Page | Qui | Ce qu’on y fait |
|---|---|---|---|---|
| 1 | Collecte d’œufs saisie par erreur | `/production/collecte` | Responsable production, Responsable de ferme, Administrateur | Liste « Collectes récentes » → Annuler (motif obligatoire). |
| 2 | Pesée, entrée d’animaux, lot | `/production/fiche` | Responsable production, Administrateur | Fiche du lot → Entrées ou Pesées → Annuler ; un lot planifié et vide s’annule ; un lot actif se clôture. En ligne. |
| 3 | Vente | `/ventes` | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Direction, Supervision consultative, Finance | Détail de la vente → Annuler : immédiat dans le délai prévu, sinon soumis à validation. |
| 4 | Commande | `/commandes` | Direction, Supervision consultative, Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Magasinier, Finance | Détail de la commande → Annuler, ou clôturer le reste après une livraison partielle. |
| 5 | Remise de fonds | `/caisse/remises` | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Finance | Annuler une remise envoyée et pas encore reçue. |
| 6 | Inventaire | `/stock/inventaire` | Magasinier, Vendeur de point de vente, Responsable de ferme, Responsable production, Administrateur | Annuler un comptage avant sa soumission. |
| 7 | Opération refusée | `/synchronisation` | tous | L’écran Synchronisation donne la raison du refus en langage métier ; refaites l’opération corrigée. |

## 3. Les pages, par domaine

### Ventes

#### Règles tarifaires

`/prix/regles` · ECR-PRX-02 · Responsable commercial, Direction · en ligne

Les règles de prix d’un produit : en vigueur, brouillons, historique. On rédige une règle ou une nouvelle version (jamais de modification d’une version existante), la Direction l’active ou y met fin. En ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Rédiger une règle | Brouillon ou nouvelle version de la dernière règle active. | Responsable commercial, Direction | en ligne |
| Activer ou terminer | Réservé à la Direction ; un conflit d’activation est annoncé avant. | Direction | en ligne |

**Ensuite**

- Simulateur de prix (`/prix/simulateur`) — vérifier quel prix sera appliqué

#### Simulateur de prix

`/prix/simulateur` · ECR-PRX-03 · Responsable commercial, Direction, Supervision consultative · utilisable hors ligne

Pour un produit, une quantité, une date, un site, une zone, une catégorie de client et un canal : le prix que la vente appliquerait, la règle retenue et les autres règles applicables. Aucune écriture.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Simuler un prix | Renseignez le contexte ; le résultat reste à droite sur ordinateur. | Responsable commercial, Direction, Supervision consultative | — |

#### Nouvelle vente

`/ventes/nouvelle` · ECR-VEN-01 · Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme · utilisable hors ligne

Vendre vite et encaisser sur le même écran : emplacement de départ, client (« client de passage » par défaut), articles au prix du catalogue, encaissement prérempli au total. La vente est enregistrée même sans réseau.

**Avant de commencer**

- Du stock à l’emplacement de vente (ou un quota pour un stock partagé). Hors ligne, la vente est bloquée au-delà de ce que le téléphone connaît du stock.
- Un point de vente a besoin d’une caisse ouverte seulement si le paramètre « caisse exigée » est activé pour le site.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Enregistrer une vente | Articles, quantités, mode d’encaissement (espèces, Mobile Money, banque) ; le reçu se compose aussitôt. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme | — |
| Accorder une remise | Dans la limite de votre plafond ; au-delà, la vente attend la validation d’un responsable. | Direction, Responsable commercial, Commercial terrain, Commercial sédentaire, Responsable de ferme | — |
| Vendre à crédit | Pour un client autorisé au crédit, dans son plafond : la vente crée une créance. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme | — |

**Ensuite**

- Détail de la vente (`/ventes`) — reçu, impression, annulation
- Encaisser (`/encaisser`) — pour régler plus tard une créance

#### Ventes récentes

`/ventes` · ECR-VEN-05 · Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Direction, Supervision consultative, Finance · utilisable hors ligne

Les ventes des 7 derniers jours connues du téléphone, y compris celles pas encore acceptées par le serveur. Le signal « ventes signalées » de l’accueil ouvre cette liste filtrée sur les anomalies.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Retrouver une vente | La plus récente d’abord ; touchez-la pour son reçu. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Direction, Supervision consultative, Finance | — |
| Faire une nouvelle vente | Ouvre l’écran de vente. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme | — |

#### Nouvelle commande

`/commandes/nouvelle` · ECR-VEN-02 · Responsable commercial, Commercial terrain, Commercial sédentaire · utilisable hors ligne

Prendre la commande d’un client identifié : emplacement de préparation, articles au prix du catalogue (figé dans la commande), date et adresse de livraison facultatives, acompte facultatif. Une commande ne dépend jamais de l’argent : elle se livre payée.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Passer une commande | À son application, le serveur vend le disponible et laisse le reste en attente de stock. | Responsable commercial, Commercial terrain, Commercial sédentaire | — |

**Ensuite**

- Commandes (`/commandes`) — suivre les livraisons

#### Commandes

`/commandes` · ECR-VEN-03 · Direction, Supervision consultative, Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Magasinier, Finance · utilisable hors ligne

Les commandes à confirmer, à livrer et livrées. Les commandes ouvertes viennent du téléphone ; les commandes livrées ou closes se lisent en ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Suivre une commande | Touchez-la pour la progression de chaque ligne. | Direction, Supervision consultative, Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Magasinier, Finance | — |
| Prendre une nouvelle commande | Ouvre l’écran de commande. | Responsable commercial, Commercial terrain, Commercial sédentaire | — |

#### Encaisser une créance

`/encaisser` · ECR-VEN-06 · Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Finance · utilisable hors ligne

Enregistrer un règlement reçu d’un client : montant, moyen, référence, compte de réception. L’affectation est automatique : l’échéance la plus ancienne d’abord, le reste en avoir du client.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Encaisser | Possible sans réseau ; l’écran montre l’aperçu de l’affectation avant l’envoi. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Finance | — |

**Ensuite**

- Créances (`/finance/creances`) — voir ce qui reste dû

#### Caisse du point de vente

`/caisse` · ECR-DIS-02 · Vendeur de point de vente, Finance · utilisable hors ligne

Ouvrir la caisse avec le fonds compté, puis la clôturer en comptant l’espèce. Le comptage est à l’aveugle : l’attendu et l’écart s’affichent après l’enregistrement. Un écart part en validation de la Finance.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Ouvrir la caisse | Comptez le fonds de caisse. | Vendeur de point de vente, Finance | — |
| Clôturer la caisse | Comptez l’espèce ; le serveur calcule l’attendu et l’écart. | Vendeur de point de vente, Finance | — |

**Ensuite**

- Remises de fonds (`/caisse/remises`) — remettre l’espèce à la Finance

#### Remises de fonds

`/caisse/remises` · ECR-FIN-07 · Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Finance · utilisable hors ligne

Remettre des fonds d’une caisse vers une destination admise, annuler une remise non reçue, ou recevoir une remise arrivée sur l’une de vos caisses. Un écart annoncé à la réception part en validation de la Finance.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Envoyer une remise | Montant et destination. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Finance | — |
| Annuler une remise envoyée | Tant qu’elle n’est pas reçue ; motif obligatoire. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Finance | — |
| Recevoir une remise | Montant reçu ; un écart est signalé à la Finance. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Finance | — |

#### Accueil du point de vente

`/pdv` · ECR-DIS-01 · Vendeur de point de vente · utilisable hors ligne

La journée du point de vente en un coup d’œil : caisse du jour, stock de l’emplacement de vente avec ses seuils, vos quotas et leur libération, ventes du jour, accès aux opérations.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Voir le stock et les ventes du jour | Disponible du téléphone, seuils, ventes connues. | Vendeur de point de vente | — |
| Libérer un quota | Rendre au stock ce qui n’est pas vendu. | Commercial terrain, Vendeur de point de vente | — |

**Ensuite**

- Nouvelle vente (`/ventes/nouvelle`) — vendre
- Demander un réapprovisionnement (`/pdv/reapprovisionnement`) — quand le stock baisse

#### Distribution par point de vente

`/pdv/distribution` · ECR-DIS-04 · Direction, Supervision consultative, Responsable commercial, Vendeur de point de vente, Magasinier, Finance · en ligne

Pour chaque point de vente et la période choisie : envoyé, reçu, vendu, perdu, restant, encaissé et à réapprovisionner, avec la caisse et les appareils. Lecture en ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Comparer les points de vente | Choisissez la période ; les mesures masquées par vos droits ne s’affichent pas. | Direction, Supervision consultative, Responsable commercial, Vendeur de point de vente, Magasinier, Finance | en ligne |

### Stock

#### Stock par emplacement

`/stock` · ECR-STK-01 · Direction, Supervision consultative, Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable production, Responsable de ferme, Magasinier, Responsable achats, Finance, Administrateur · utilisable hors ligne

Les soldes de ce que vous détenez : produits, quantités et valeur par emplacement (magasin, bâtiment, point de vente, stock mobile), avec le disponible net des quotas des autres appareils. Une pastille signale les produits sous leur seuil.

**Avant de commencer**

- Vous ne voyez que les emplacements de votre périmètre : votre site (magasinier, responsable de ferme, vendeur), tous les sites (Direction, Administrateur, Responsable de production).
- Les soldes se téléchargent à la connexion et se mettent à jour à chaque synchronisation ; hors ligne, ils montrent le dernier état connu plus vos propres opérations en attente.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Consulter les soldes | Recherche par produit ; filtre « sous le seuil » (alertes de stock). | Direction, Supervision consultative, Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable production, Responsable de ferme, Magasinier, Responsable achats, Finance, Administrateur | — |
| Transférer | Envoyer du stock vers un autre emplacement. | Magasinier, Responsable de ferme, Responsable production, Administrateur | — |
| Recevoir un transfert | Accepter ce qui vous est envoyé. | Commercial terrain, Vendeur de point de vente, Responsable production, Responsable de ferme, Magasinier, Administrateur | — |
| Déclarer une perte | Casse, péremption, vol, mortalité hors lot… | Commercial terrain, Vendeur de point de vente, Responsable production, Responsable de ferme, Magasinier, Administrateur | — |
| Faire un inventaire | Compter physiquement et laisser le système calculer l’écart. | Magasinier, Vendeur de point de vente, Responsable de ferme, Responsable production, Administrateur | — |
| Régler les seuils d’alerte | Le minimum sous lequel un produit est signalé, et la cible du réapprovisionnement. | Direction, Responsable commercial, Responsable production, Responsable de ferme, Magasinier, Administrateur | — |
| Enregistrer une consommation | Intrants et emballages utilisés hors lot. | Magasinier, Responsable de ferme, Vendeur de point de vente, Responsable production, Administrateur | — |
| Voir le registre des mouvements | Chaque entrée et sortie, pour expliquer un écart. | Direction, Supervision consultative, Responsable commercial, Responsable production, Responsable de ferme, Magasinier, Finance, Administrateur | en ligne |

**Ensuite**

- Réceptions d’achat (`/achats/receptions`) — pour faire entrer de la marchandise achetée

#### Transferts

`/stock/transferts` · ECR-STK-02 · Magasinier, Responsable de ferme, Responsable production, Administrateur · utilisable hors ligne

Préparer et expédier du stock d’un emplacement vers un autre (magasin, point de vente, commercial, ferme), répondre aux demandes de réapprovisionnement, et déplacer du stock à l’intérieur d’un site.

**Avant de commencer**

- Du stock disponible à l’emplacement d’origine ; un destinataire déclaré (point de vente, commercial, autre magasin).

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Expédier un transfert | Choisissez l’origine, la destination et les lignes (produit, quantité) : la marchandise passe « en transit » jusqu’à la réception. | Magasinier, Responsable de ferme, Responsable production, Administrateur | — |
| Répondre à une demande | Expédier ou refuser (avec motif) une demande de réapprovisionnement d’un point de vente. | Magasinier, Responsable de ferme, Responsable production, Administrateur | — |
| Déplacer dans le site | Mouvement interne entre deux emplacements du même site, sans transit. | Magasinier, Responsable de ferme, Responsable production, Administrateur | — |
| Annuler un transfert | Tant qu’il n’est pas reçu : le serveur refuse l’annulation une fois la réception saisie. | Magasinier, Responsable de ferme, Responsable production, Administrateur | — |

**Ensuite**

- Réceptions (`/stock/receptions`) — ce que le destinataire accepte à l’arrivée

#### Réceptions de transfert

`/stock/receptions` · ECR-STK-03 · Commercial terrain, Vendeur de point de vente, Responsable production, Responsable de ferme, Magasinier, Administrateur · utilisable hors ligne

Les transferts qui vous sont destinés : vérifier ce qui arrive, accepter ou signaler un écart.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Voir les transferts attendus | En transit vers vous, du plus ancien au plus récent. | Commercial terrain, Vendeur de point de vente, Responsable production, Responsable de ferme, Magasinier, Administrateur | — |
| Recevoir | Comptez à l’arrivée : la quantité reçue entre en stock ; un écart est annoncé et part en validation. | Commercial terrain, Vendeur de point de vente, Responsable production, Responsable de ferme, Magasinier, Administrateur | — |
| Recevoir sans document | Marchandise arrivée sans transfert saisi : à rapprocher ensuite du transfert d’origine. | Commercial terrain, Vendeur de point de vente, Responsable production, Responsable de ferme, Magasinier, Administrateur | — |

#### Déclarer une perte

`/stock/perte` · ECR-STK-04 · Commercial terrain, Vendeur de point de vente, Responsable production, Responsable de ferme, Magasinier, Administrateur · utilisable hors ligne

Sortir du stock une marchandise perdue (casse, péremption, vol, mortalité hors lot…) avec sa cause et, au besoin, une photo. Selon la politique, la perte attend la validation d’un responsable.

**Avant de commencer**

- Pour la mortalité d’un lot de production, utilisez plutôt la saisie du jour du lot : la perte y est rattachée au lot.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Déclarer une perte | Emplacement, produit, quantité, motif ; photo facultative. En ligne, le serveur refuse au-delà du disponible. | Commercial terrain, Vendeur de point de vente, Responsable production, Responsable de ferme, Magasinier, Administrateur | — |

**Ensuite**

- Validations (`/validations`) — pour suivre la décision du responsable

#### Inventaire

`/stock/inventaire` · ECR-STK-05 · Magasinier, Vendeur de point de vente, Responsable de ferme, Responsable production, Administrateur · utilisable hors ligne

Compter physiquement un emplacement : le système calcule l’écart avec le stock théorique. Le comptage se fait sans réseau ; la validation des écarts se fait en ligne, par un responsable.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Ouvrir un inventaire | Choisissez l’emplacement à compter. | Magasinier, Vendeur de point de vente, Responsable de ferme, Responsable production, Administrateur | — |
| Saisir les quantités comptées | Ligne par ligne ; l’écart estimé s’affiche, l’écart réel est calculé par le serveur. | Magasinier, Vendeur de point de vente, Responsable de ferme, Responsable production, Administrateur | — |
| Soumettre le comptage | Les écarts partent en validation ; une fois décidés, ils ajustent le stock. | Magasinier, Vendeur de point de vente, Responsable de ferme, Responsable production, Administrateur | — |
| Annuler l’inventaire | Avant sa soumission, sans effet sur le stock. | Magasinier, Vendeur de point de vente, Responsable de ferme, Responsable production, Administrateur | — |

**Ensuite**

- Validations (`/validations`) — où le responsable décide des écarts

#### Consommation d’intrants

`/stock/consommation` · ECR-STK-08 · Magasinier, Responsable de ferme, Vendeur de point de vente, Responsable production, Administrateur · utilisable hors ligne

Enregistrer ce qui a été consommé hors lot de production (aliment, médicament, emballage) : le stock baisse et le coût est imputé. Pour la consommation d’un lot, utilisez plutôt sa saisie du jour.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Enregistrer une consommation | Emplacement, produit consommable, quantité et nature du coût. | Magasinier, Responsable de ferme, Vendeur de point de vente, Responsable production, Administrateur | — |

#### Registre des mouvements

`/stock/registre` · ECR-STK-07 · Direction, Supervision consultative, Responsable commercial, Responsable production, Responsable de ferme, Magasinier, Finance, Administrateur · en ligne

Chaque entrée et chaque sortie de stock, datée et rattachée à son document : l’outil pour expliquer un écart. Lecture en ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Chercher des mouvements | Par période, emplacement, produit ou type d’opération. | Direction, Supervision consultative, Responsable commercial, Responsable production, Responsable de ferme, Magasinier, Finance, Administrateur | en ligne |
| Exporter en CSV | La période affichée, pour la traiter dans un tableur. | Direction, Supervision consultative, Responsable commercial, Responsable production, Responsable de ferme, Magasinier, Finance, Administrateur | en ligne |

#### Seuils d’alerte

`/stock/seuils` · ECR-STK-09 · Direction, Responsable commercial, Responsable production, Responsable de ferme, Magasinier, Administrateur · utilisable hors ligne

Pour chaque produit d’un emplacement : le minimum sous lequel il est signalé en alerte de stock, et la cible vers laquelle le réapprovisionnement le ramène. Chaque réglage crée une nouvelle version ; l’ancienne reste à l’historique.

**Avant de commencer**

- L’emplacement doit déjà avoir du stock pour que ses produits soient proposés.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Fixer un seuil | Choisissez l’emplacement et le produit, puis le minimum et la cible (la cible au moins égale au minimum). | Direction, Responsable commercial, Responsable production, Responsable de ferme, Magasinier, Administrateur | — |
| Modifier un seuil | Le nouveau réglage remplace l’ancien, qui reste à l’historique ; les alertes se recalculent. | Direction, Responsable commercial, Responsable production, Responsable de ferme, Magasinier, Administrateur | — |

**Ensuite**

- Stock (`/stock`) — voir les produits sous leur seuil

#### Quotas

`/stock/quotas` · ECR-STK-06 · Direction, Responsable commercial, Responsable de ferme, Magasinier, Administrateur · en ligne

Accorder du stock d’un emplacement à un détenteur (point de vente, commercial) : le détenteur vend dans la limite de son quota, même sans réseau.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Accorder un quota | Produit, quantité, détenteur, échéance éventuelle. | Direction, Responsable commercial, Responsable de ferme, Magasinier, Administrateur | en ligne |
| Augmenter un quota | Ajoute de la quantité à un quota existant. | Direction, Responsable commercial, Responsable de ferme, Magasinier, Administrateur | en ligne |
| Révoquer ou libérer | Le non-vendu retourne au stock de l’emplacement. | Direction, Responsable commercial, Responsable de ferme, Magasinier, Administrateur | en ligne |

#### Demande de réapprovisionnement

`/pdv/reapprovisionnement` · ECR-DIS-03 · Vendeur de point de vente · utilisable hors ligne

Demander du stock à la source du point de vente. Les produits sous leur seuil sont suggérés ; rien n’est demandé automatiquement.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Envoyer une demande | Produits et quantités ; le magasinier l’expédie ou la refuse. | Vendeur de point de vente | — |
| Annuler ma demande | Tant qu’elle n’est pas expédiée. | Vendeur de point de vente | — |

#### Tableau du stock

`/pilotage/stock` · ECR-ANA-03 · Magasinier, Direction, Supervision consultative, Responsable production, Responsable de ferme, Responsable achats, Finance, Administrateur · utilisable hors ligne

Les soldes, les alertes de seuil, les pertes et les mouvements du stock de votre périmètre.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Lire les indicateurs | Choisissez la période ; chaque indicateur peut mener aux opérations qui l’expliquent. Hors ligne, le dernier instantané reste affiché. | Magasinier, Direction, Supervision consultative, Responsable production, Responsable de ferme, Responsable achats, Finance, Administrateur | — |
| Ouvrir l’explorateur | Pour descendre d’un indicateur jusqu’aux opérations sources (selon vos droits). | Magasinier, Direction, Supervision consultative, Responsable production, Responsable de ferme, Responsable achats, Finance, Administrateur | — |

**Ensuite**

- Stock (`/stock`) — le détail des soldes par emplacement

### Clients

#### Mon portefeuille

`/clients` · ECR-CRM-01 · Responsable commercial, Commercial terrain, Commercial sédentaire · utilisable hors ligne

Vos comptes clients : recherche par nom ou téléphone, filtre par stade, prochaine action prévue en tête. Utilisable hors ligne sur le périmètre téléchargé.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Chercher un client | Nom, téléphone, stade du pipeline. | Responsable commercial, Commercial terrain, Commercial sédentaire | — |
| Ajouter un prospect | Un nouveau contact rencontré. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme | — |

#### Nouveau prospect

`/clients/nouveau` · ECR-CRM-02 · Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme · utilisable hors ligne

Enregistrer un contact : nom, téléphone ou position, zone et source. Un doublon de téléphone est signalé avant l’envoi ; le compte est aussitôt proposé à la vente.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Créer le prospect | Peu de champs obligatoires ; possible sans réseau. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme | — |

**Ensuite**

- Visite (`/clients/visite`) — noter le résultat d’une visite

#### Nouvelle visite

`/clients/visite` · ECR-CRM-04 · Responsable commercial, Commercial terrain · utilisable hors ligne

Noter une visite : le compte, le résultat (obligatoire), un commentaire et la prochaine action. La position est relevée à l’ouverture.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Enregistrer la visite | Les signalements (hors session, loin du compte) sont annoncés avant l’envoi. | Responsable commercial, Commercial terrain | — |

#### Réaffectation de clients

`/clients/reaffecter` · ECR-CRM-06 · Responsable commercial, Direction · en ligne

Confier des comptes clients à un autre commercial actif, avec un motif. Lecture et décision en ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Réaffecter | Filtrez par titulaire, stade ou texte, choisissez les comptes puis le nouveau commercial. | Responsable commercial, Direction | en ligne |

#### Mes objectifs

`/objectifs` · ECR-CRM-05 · Responsable commercial, Commercial terrain, Commercial sédentaire · utilisable hors ligne

Votre effort et vos objectifs avec leur réalisé. En ligne, le serveur calcule ; hors ligne, une estimation du téléphone couvre les visites, comptes visités, échanges et prospects.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Suivre ma progression | Visites, prospects, chiffre d’affaires et quantités vendues (ces deux derniers en ligne). | Responsable commercial, Commercial terrain, Commercial sédentaire | — |

#### Gestion des objectifs

`/objectifs/gestion` · ECR-CRM-07 · Responsable commercial, Direction · en ligne

Fixer les objectifs d’un commercial, d’une équipe ou d’un site, avec contrôle de chevauchement, et les annuler. En ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Définir un objectif | La Direction fixe par site, équipe ou commercial ; le responsable commercial pour lui-même et son équipe. | Responsable commercial, Direction | en ligne |
| Annuler un objectif | Un objectif annulé reste à l’historique. | Responsable commercial, Direction | en ligne |

#### Prendre service

`/service` · ECR-TER-01 · Responsable commercial, Commercial terrain · utilisable hors ligne

Pointer votre arrivée sur le terrain (position relevée, zone reconnue) puis votre fin de service. Les visites de la journée se rattachent à la session de travail.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Prendre service | Après des refus répétés (hors zone, position imprécise), une dérogation motivée ouvre une session en attente de validation. | Responsable commercial, Commercial terrain | — |
| Terminer le service | La session se ferme ; à défaut, elle est close à 23 h 59. | Responsable commercial, Commercial terrain | — |

#### Présences et activité de l’équipe

`/equipe/activite` · ECR-TER-02 · Responsable commercial, Direction, Supervision consultative · en ligne

Pour une équipe et un jour : prises et fins de service, tentatives refusées, demandes de dérogation en attente, visites et échanges. Lecture en ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Suivre l’équipe | Choisissez l’équipe et le jour. | Responsable commercial, Direction, Supervision consultative | en ligne |

#### Bilan de la semaine

`/bilan-hebdomadaire` · ECR-CRM-08 · Commercial terrain, Commercial sédentaire, Responsable commercial, Direction · utilisable hors ligne

Le commercial rédige son bilan de la semaine (cinq rubriques) avec des chiffres calculés par le serveur, jamais saisis ; le responsable lit les bilans de son équipe et les marque « vus ».

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Rédiger mon bilan | Renvoyer le bilan le corrige tant que le responsable ne l’a pas vu. | Commercial terrain, Commercial sédentaire | — |
| Marquer un bilan comme vu | Avec un commentaire éventuel. | Responsable commercial, Direction | — |

#### Tableau commercial

`/pilotage/commercial` · ECR-ANA-02 · Responsable commercial, Direction, Supervision consultative, Finance, Commercial terrain, Commercial sédentaire · utilisable hors ligne

Les ventes, les visites, les objectifs et le portefeuille de votre périmètre commercial.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Lire les indicateurs | Choisissez la période ; chaque indicateur peut mener aux opérations qui l’expliquent. Hors ligne, le dernier instantané reste affiché. | Responsable commercial, Direction, Supervision consultative, Finance, Commercial terrain, Commercial sédentaire | — |
| Ouvrir l’explorateur | Pour descendre d’un indicateur jusqu’aux opérations sources (selon vos droits). | Responsable commercial, Direction, Supervision consultative, Finance, Commercial terrain, Commercial sédentaire | — |

### Achats

#### Demandes d’achat

`/achats/demandes` · ECR-APP-02 · Direction, Responsable production, Responsable de ferme, Magasinier, Responsable achats, Finance, Administrateur · utilisable hors ligne

Exprimer un besoin (aliment, médicaments, matériel) et suivre la réponse du responsable des achats. Une demande acceptée devient un bon de commande.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Faire une demande d’achat | Site demandeur, produits, quantités et justification. Possible sans réseau. | Direction, Responsable production, Responsable de ferme, Magasinier, Responsable achats, Finance, Administrateur | — |
| Suivre mes demandes | État de chaque demande : soumise, approuvée, refusée, annulée. | Direction, Responsable production, Responsable de ferme, Magasinier, Responsable achats, Finance, Administrateur | — |
| Instruire les demandes | Les demandes à décider arrivent dans la file Validations. | Responsable achats | — |

**Ensuite**

- Bons de commande (`/achats/bons-de-commande`) — ce que le responsable des achats en fait

#### Fournisseurs

`/achats/fournisseurs` · ECR-APP-01 · Responsable achats · en ligne

La fiche des fournisseurs : coordonnées, produits fournis, état actif ou non. Lecture et écriture en ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Ajouter un fournisseur | Nom, contact, produits habituels. | Responsable achats | en ligne |
| Modifier une fiche | Mettre à jour les coordonnées ou les produits. | Responsable achats | en ligne |
| Désactiver ou réactiver | Un fournisseur désactivé n’apparaît plus dans les nouveaux bons de commande ; son historique reste. | Responsable achats | en ligne |

#### Bons de commande

`/achats/bons-de-commande` · ECR-APP-03 · Responsable achats · en ligne

Commander auprès d’un fournisseur ce que les demandes ont approuvé, suivre les livraisons et le reliquat. Un bon au-dessus du seuil est validé par la Direction.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Créer un bon de commande | Fournisseur, site de livraison, lignes (produit, quantité, prix). | Responsable achats | en ligne |
| Modifier et soumettre | Un bon se modifie tant qu’il n’est pas envoyé ; il se soumet à validation si besoin. | Responsable achats | en ligne |
| Marquer comme envoyé | Une fois transmis au fournisseur. | Responsable achats | en ligne |
| Annuler ou clore le reliquat | Annuler un bon, ou clore ce qui n’a pas été livré. | Responsable achats | en ligne |

**Ensuite**

- Réceptions (`/achats/receptions`) — à la livraison, le magasinier réceptionne
- Rapprochement (`/achats/rapprochement`) — commandé, livré, facturé, payé

#### Réceptions d’achat

`/achats/receptions` · ECR-APP-04 · Magasinier, Responsable de ferme, Responsable production, Administrateur · utilisable hors ligne

Faire entrer en stock ce qu’un fournisseur a livré : les bons de commande attendus sur votre site, ou une livraison sans bon de commande (animaux, aliment achetés au comptant).

**Avant de commencer**

- Pour réceptionner un bon de commande, il doit avoir été envoyé au fournisseur et être destiné à votre site.
- Pour les animaux d’un lot : la réception sans bon de commande est le chemin le plus court (voir ci-dessous).

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Réceptionner un bon de commande | Touchez le bon : pour chaque ligne, quantités livrée, rejetée et acceptée ; photo du bon de livraison. | Magasinier, Responsable de ferme, Responsable production, Administrateur | — |
| Réceptionner sans bon de commande | Fournisseur, produits et prix unitaire (obligatoire) ; pour un produit suivi par lot, le code du lot fournisseur. Revue ensuite par les Achats. | Magasinier, Responsable de ferme, Responsable production, Administrateur | — |

**Ensuite**

- Nouveau lot (`/production/nouveau-lot`) — pour faire entrer des animaux réceptionnés dans un lot
- Stock (`/stock`) — pour voir l’entrée en stock

#### Rapprochement commande, réception, facture

`/achats/rapprochement` · ECR-APP-05 · Responsable achats, Finance, Direction, Supervision consultative · en ligne

Pour chaque bon de commande : commandé, livré, accepté, facturé, payé. L’outil pour repérer ce qui manque ou ce qui est facturé en trop.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Suivre un bon de commande de bout en bout | Les écarts entre quantités et montants sont signalés. | Responsable achats, Finance, Direction, Supervision consultative | en ligne |

**Ensuite**

- Factures fournisseurs (`/finance/factures`) — pour traiter un écart de facture

### Production

#### Lots de production

`/production/lots` · ECR-PRD-01 · Responsable production, Responsable de ferme, Administrateur · utilisable hors ligne

Vos lots d’élevage actifs ou en vente, avec l’âge, l’effectif et les saisies du jour. C’est le point de départ de la ferme : de là on crée un lot, on y fait entrer les animaux, on saisit la journée et on suit les fiches.

**Avant de commencer**

- Un lot n’apparaît ici qu’une fois actif, c’est-à-dire dès que des animaux y sont entrés. Un lot créé mais vide reste dans « Lots planifiés », plus bas.
- Les animaux doivent d’abord être en stock sur la ferme (achat réceptionné, éclosion interne) ou venir d’un autre lot.
- Il faut une ferme avec ses bâtiments et un magasin déclarés dans Administration → Organisation.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Créer un lot | Choisissez la ferme, le type de lot (poulets de chair, pondeuses, porcs…), les animaux et le bâtiment principal. Le lot est « planifié » tant qu’aucun animal n’y est entré. | Responsable production, Administrateur | — |
| Faire entrer les animaux dans un lot | Touchez un lot planifié, ou ouvrez « Nouveau lot » puis « Entrée dans un lot » : stock de la ferme, réception d’achat, autre lot, naissance. La première entrée rend le lot actif. | Responsable production, Administrateur | — |
| Saisir la journée d’un lot | Touchez un lot actif : mortalité, aliment et intrants, pesée, observation. Chaque saisie est enregistrée même sans réseau. | Responsable production, Responsable de ferme, Administrateur | — |
| Collecter les œufs | Pour les lots de pondeuses et de reproducteurs : œufs collectés, cassés, commercialisables par calibre et à couver. | Responsable production, Responsable de ferme, Administrateur | — |
| Gérer les incubations | Mise en incubateur, mirage, transfert vers l’éclosoir, éclosion. | Responsable de ferme, Responsable production, Administrateur | — |
| Envoyer un lot à la vente | Déclarer un lot prêt à la vente et envoyer les animaux vers un magasin ou un point de vente. | Responsable de ferme, Responsable production, Administrateur | — |
| Consulter la fiche d’un lot | Effectif, mortalité, indicateurs, coûts, ventes et marge, y compris pour un lot clôturé. C’est aussi là que l’on clôture ou annule un lot, et que l’on annule une entrée ou une pesée. | Responsable production, Direction, Supervision consultative, Administrateur | — |

**Ensuite**

- Nouveau lot (`/production/nouveau-lot`) — quand aucun lot n’est ouvert
- Enregistrer l’achat des animaux (`/achats/receptions/sans-bon`) — quand les animaux ne sont pas encore en stock sur la ferme

#### Nouveau lot et entrée d’animaux

`/production/nouveau-lot` · ECR-PRD-04 · Responsable production, Administrateur · utilisable hors ligne

Trois rubriques : « Nouveau lot » crée le lot, « Entrée dans un lot » y fait entrer les animaux, « Reprise d’un lot » déclare un lot déjà en élevage au moment de la mise en service. Un lot est planifié tant qu’aucun animal n’y est entré ; la première entrée le rend actif et ouvre sa saisie du jour.

**Avant de commencer**

- Une ferme avec au moins un bâtiment ou une case, et le produit biologique du lot (par exemple « poussin d’un jour ») au catalogue.
- Pour une entrée depuis le stock ou un achat : les animaux doivent avoir été réceptionnés sur la ferme (Achats → Réceptions, ou la réception sans bon de commande).

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Créer un lot | Ferme, type de lot, animaux du lot et bâtiment principal ; le fournisseur, la souche, les dates prévues et une note sont facultatifs. Possible sans réseau, le numéro du lot est donné par le serveur. | Responsable production, Administrateur | — |
| Faire entrer des animaux | Origine : stock de la ferme, réception d’achat, autre lot (transfert), sevrage ou naissance. Le nombre de têtes est obligatoire ; le poids moyen et les mort-nés sont facultatifs. | Responsable production, Administrateur | — |
| Enregistrer l’achat des animaux | Quand le stock de la ferme est vide : réception sans bon de commande (animaux et aliment, prix unitaire obligatoire). | Magasinier, Responsable de ferme, Responsable production, Administrateur | — |
| Reprendre un lot déjà en élevage | Rubrique « Reprise d’un lot » : date de mise en place réelle, effectif repris à la date d’arrêt et valeur totale du lot (animaux, aliments, soins déjà engagés). La Direction valide la déclaration : le lot n’apparaît qu’après sa validation, et une reprise comptabilisée ne s’annule pas. | Responsable production, Administrateur | — |
| Annuler une entrée ou un lot | Depuis la fiche du lot, en ligne : une entrée s’annule (les animaux retournent à leur origine) ; un lot planifié et vide s’annule ; un lot actif se clôture. | Responsable production, Direction, Supervision consultative, Administrateur | en ligne |

**Ensuite**

- Saisie du jour (`/production/lots`) — une fois les animaux entrés, le lot est actif

#### Collecte d’œufs

`/production/collecte` · ECR-PRD-02 · Responsable production, Responsable de ferme, Administrateur · utilisable hors ligne

Le relevé d’un lot de pondeuses ou de reproducteurs pour un jour : œufs collectés, cassés, non conformes, à couver, et le reste commercialisable réparti par calibre. Le bilan doit tomber juste avant l’enregistrement ; les œufs commercialisables entrent aussitôt au stock.

**Avant de commencer**

- Un lot de pondeuses ou de reproducteurs actif ; les calibres d’œufs et le produit « œuf à couver » doivent exister au catalogue.
- Un emplacement de stockage des œufs (magasin) sur la ferme.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Enregistrer une collecte | Lot, jour (pas après aujourd’hui), emplacement de stockage, quantités. Possible sans réseau. | Responsable production, Responsable de ferme, Administrateur | — |
| Annuler une collecte saisie par erreur | La liste « Collectes récentes » propose « Annuler » : les œufs sortent du stock et du coût du lot. Impossible si ces œufs ont déjà été vendus, transférés ou mis à couver. | Responsable production, Responsable de ferme, Administrateur | — |
| Mettre des œufs à couver | Les œufs « à couver » se mettent en incubateur depuis l’écran des incubations. | Responsable de ferme, Responsable production, Administrateur | — |

**Ensuite**

- Incubations (`/production/incubation`) — pour mettre les œufs à couver en incubateur
- Saisie du jour (`/production/lots`) — retour au lot

#### Incubations

`/production/incubation` · ECR-PRD-06 · Responsable de ferme, Responsable production, Administrateur · utilisable hors ligne

Le suivi des lots d’incubation de la ferme : mise en incubateur, mirage, transfert vers l’éclosoir, éclosion, et perte d’un lot entier. Deux rubriques : « Lots en cours » et « Démarrer un lot ».

**Avant de commencer**

- Des œufs à couver en stock sur la ferme (collecte d’œufs d’un lot de reproducteurs ou œufs achetés).
- Un incubateur et, pour le transfert, un éclosoir déclarés comme emplacements de la ferme (Administration → Organisation).

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Démarrer un lot d’incubation | Choisissez l’incubateur et les œufs à mettre à couver ; les dates prévues de mirage, de transfert et d’éclosion se calculent selon l’espèce. | Responsable de ferme, Responsable production, Administrateur | — |
| Enregistrer un mirage | Œufs clairs et morts en début d’incubation : ils quittent l’incubateur et le lot garde ses œufs viables. | Responsable de ferme, Responsable production, Administrateur | — |
| Transférer vers l’éclosoir | Tous les œufs du lot présents à l’incubateur passent à l’éclosoir. | Responsable de ferme, Responsable production, Administrateur | — |
| Enregistrer l’éclosion | Poussins éclos et pertes : les poussins entrent en stock, prêts à être mis en place dans un lot. | Responsable de ferme, Responsable production, Administrateur | — |
| Déclarer un lot perdu | Perte totale d’un lot d’incubation (annulation, en ligne). | Responsable de ferme, Responsable production, Administrateur | en ligne |

**Ensuite**

- Nouveau lot (`/production/nouveau-lot`) — pour mettre les poussins éclos en place dans un nouveau lot

#### Sortie vers la vente

`/production/sortie` · ECR-PRD-07 · Responsable de ferme, Responsable production, Administrateur · utilisable hors ligne

Deux choses : déclarer qu’un lot est prêt à la vente (le lot passe « en vente »), puis envoyer ses animaux vers un magasin ou un point de vente (transfert du bâtiment vers la destination).

**Avant de commencer**

- Un lot actif avec des animaux en élevage. Les destinations (magasin, point de vente) sont déclarées dans Administration → Organisation.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Déclarer le lot prêt à la vente | Le lot passe de « actif » à « en vente » (et inversement). Réservé à qui gère les lots. | Responsable production, Administrateur | — |
| Envoyer des animaux vers la vente | Bâtiment d’origine, destination, nombre de têtes, transporteur et note. Le destinataire reçoit le transfert sur son téléphone. | Responsable de ferme, Responsable production, Administrateur | — |

**Ensuite**

- Fiche du lot (`/production/fiche`) — pour clôturer le lot quand tous ses animaux sont partis

#### Fiche d’un lot

`/production/fiche` · ECR-PRD-03 · Responsable production, Direction, Supervision consultative, Administrateur · en ligne

Tout ce qu’il faut savoir d’un lot : effectif, mortalité, indicateurs (mortalité, gain moyen quotidien, indice de consommation, ponte), coûts, ventes et marge, entrées et pesées. Elle sert aussi à corriger et à clore : clôture, annulation du lot, d’une entrée ou d’une pesée.

**Avant de commencer**

- En ligne pour les indicateurs, les coûts et les corrections ; hors ligne, seul l’effectif calculé par le téléphone s’affiche.
- Les montants (coûts, ventes, marges) ne se voient qu’avec le droit de valorisation (Direction, Finance, Responsable production, Supervision) ; l’Administrateur seul n’en voit pas.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Consulter un lot, même clôturé | Le sélecteur propose les lots ouverts puis les lots clôturés (lus en ligne par pages). | Responsable production, Direction, Supervision consultative, Administrateur | — |
| Faire entrer des animaux, saisir la journée, collecter les œufs, envoyer à la vente | Les boutons de « Actions sur le lot » ouvrent l’écran voisin avec le lot déjà choisi. | Responsable production, Administrateur | — |
| Clôturer le lot | Fige le coût et ferme le lot. Il ne doit plus contenir d’animaux non vendus, de mortalité en attente ni de vente à livrer. | Responsable production, Administrateur | en ligne |
| Annuler un lot planifié | Seul un lot sans aucune entrée s’annule ; il faut un motif. | Responsable production, Administrateur | en ligne |
| Annuler une entrée ou une pesée | Dans les listes « Entrées » et « Pesées » : les animaux d’une entrée retournent à leur origine, une pesée n’est plus comptée ; il faut un motif. | Responsable production, Administrateur | en ligne |

**Ensuite**

- Lots de production (`/production/lots`) — retour à la liste des lots

#### Tableau de la production

`/pilotage/production` · ECR-ANA-04 · Responsable production, Responsable de ferme, Direction, Supervision consultative, Finance, Administrateur · utilisable hors ligne

Les effectifs, la mortalité, les performances des lots et la ponte de votre périmètre.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Lire les indicateurs | Choisissez la période ; chaque indicateur peut mener aux opérations qui l’expliquent. Hors ligne, le dernier instantané reste affiché. | Responsable production, Responsable de ferme, Direction, Supervision consultative, Finance, Administrateur | — |
| Ouvrir l’explorateur | Pour descendre d’un indicateur jusqu’aux opérations sources (selon vos droits). | Responsable production, Responsable de ferme, Direction, Supervision consultative, Finance, Administrateur | — |

**Ensuite**

- Lots de production (`/production/lots`) — agir sur un lot

### Finance

#### Créances

`/finance/creances` · ECR-FIN-01 · Finance, Direction, Supervision consultative, Responsable commercial · en ligne

Ce que les clients doivent : encours du jour (total, échu, à échoir, échu par tranche de retard), par client ou par titulaire, le plus en retard d’abord. Lecture en ligne ; hors ligne, la dernière lecture reste affichée.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Repérer les retards | Filtrez par échéance, tranche ou site ; les ventes d’un groupe se déplient à la demande. | Finance, Direction, Supervision consultative, Responsable commercial | en ligne |
| Encaisser | « Encaisser » et « Encaisser le reste dû » mènent à l’encaissement du client. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Finance | — |

#### Dépenses

`/finance/depenses` · ECR-FIN-02 · Direction, Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable production, Responsable de ferme, Magasinier, Responsable achats, Finance · utilisable hors ligne

Saisir une dépense (transport, carburant, frais de la ferme) payée maintenant par une caisse ou à payer par la Finance, avec le justificatif en photo ; suivre les dépenses et les payer ou les annuler.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Saisir une dépense | Catégorie, montant, mode de paiement, justificatif. Possible sans réseau ; la validation éventuelle se fait après coup hors ligne. | Direction, Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable production, Responsable de ferme, Magasinier, Responsable achats, Finance | — |
| Suivre les dépenses | Le suivi (vue « suivi ») se lit en ligne. | Direction, Responsable production, Responsable achats, Finance, Responsable commercial, Vendeur de point de vente, Responsable de ferme | en ligne |
| Payer une dépense à payer | Réservé à la Finance, en ligne. | Finance | en ligne |
| Annuler la dépense d’un autre | Pour les rôles qui approuvent les dépenses. | Direction, Finance, Responsable production | en ligne |

#### Factures fournisseurs

`/finance/factures` · ECR-FIN-03 · Direction, Supervision consultative, Responsable achats, Finance · en ligne

Les dettes fournisseurs (dette, échu, avances, retards) et les factures par statut, avec les écarts de rapprochement en clair. Saisir une facture, la contester, l’approuver ou l’annuler.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Saisir une facture | Fournisseur, lignes, photo de la facture ; rapprochée du bon de commande et de la réception. | Finance | en ligne |
| Contester, approuver ou annuler | Jamais sa propre facture. | Direction, Finance | en ligne |
| Suivre les dettes | Lecture seule pour le responsable des achats. | Direction, Supervision consultative, Responsable achats, Finance | en ligne |

#### Paiements fournisseurs

`/finance/paiements` · ECR-FIN-04 · Direction, Supervision consultative, Responsable achats, Finance · en ligne

Payer les fournisseurs, enregistrer et affecter les avances. Un paiement au-delà du seuil attend la décision de la Direction.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Saisir un paiement | Fournisseur, moyen, compte, référence, factures concernées. | Finance | en ligne |
| Affecter une avance | Imputer une avance à des factures. | Finance | en ligne |
| Décider d’un paiement | Dans la file des validations, pour la Direction. | Direction | — |

#### Trésorerie

`/finance/tresorerie` · ECR-FIN-05 · Finance, Direction · en ligne

Sessions de caisse à valider, écarts de remise à clore, remises en transit, dépenses à payer, paiements en attente de la Direction, comptes et leurs mouvements. En ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Valider une session de caisse | Examinez le détail des flux, puis validez avec un motif. | Finance, Direction | en ligne |
| Clore un écart de remise | Imputation et motif. | Finance, Direction | en ligne |
| Recevoir une remise en transit | La Finance reçoit les fonds remis. | Finance, Direction | en ligne |
| Consulter les comptes | Soldes et mouvements de chaque compte. | Finance, Direction | en ligne |

#### Coûts et marges

`/finance/couts-et-marges` · ECR-FIN-06 · Finance, Direction, Supervision consultative · en ligne

Lecture seule : vue d’ensemble de la période (ventes et marge brute, encaissé, dépenses, créances, dettes, trésorerie), valeur des pertes, coûts et marges des lots. En ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Analyser une période | Mois, semaine, jour, année ou dates libres. | Finance, Direction, Supervision consultative | en ligne |
| Ouvrir la fiche d’un lot | Détail des coûts et de la marge d’un lot. | Responsable production, Direction, Supervision consultative, Administrateur | — |

#### Tableau finance et trésorerie

`/pilotage/finance` · ECR-ANA-05 · Finance, Direction, Supervision consultative · en ligne

Le chiffre d’affaires, l’encaissé, les créances, les dettes et la trésorerie.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Lire les indicateurs | Choisissez la période ; chaque indicateur peut mener aux opérations qui l’expliquent. En ligne seulement. | Finance, Direction, Supervision consultative | en ligne |
| Ouvrir l’explorateur | Pour descendre d’un indicateur jusqu’aux opérations sources (selon vos droits). | Finance, Direction, Supervision consultative | — |

### Général

#### Accueil

`/` · ECR-ADM-03 · tous les profils · en ligne

Votre page de départ, propre à votre rôle : d’abord ce qui demande une réaction (signaux), puis les actions du jour, les indicateurs et l’activité récente. Quand le compte cumule plusieurs rôles, un sélecteur choisit celui affiché.

**Avant de commencer**

- L’accueil se calcule en ligne : sans réseau, utilisez le menu « Plus », qui reste complet.
- Vos actions dépendent de vos rôles : si une fonction manque, ouvrez « Aide » sur la page concernée, elle dit quel rôle la porte.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Lancer une action du jour | Les gros boutons mènent directement à l’écran voulu. | tous | — |
| Traiter un signal | Un signal (validations en attente, appareils en retard, conflits…) ouvre l’écran qui le règle. | tous | — |
| Changer de rôle affiché | Avec plusieurs rôles, choisissez celui dont vous voulez les actions. | tous | — |

**Ensuite**

- Guide et aide (`/aide`) — comprendre l’application et ses parcours

#### Synchronisation

`/synchronisation` · ECR-SYN-01 · tous les profils · utilisable hors ligne

Les opérations enregistrées sur ce téléphone et leur envoi au serveur : en attente, acceptées, refusées avec la raison. Un bouton lance une synchronisation à la demande.

**Avant de commencer**

- Rien n’est perdu hors ligne : chaque saisie reste sur le téléphone jusqu’à son envoi.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Voir ce qui attend | Chaque opération avec son état ; une opération refusée montre le motif du serveur en langage métier. | tous | — |
| Synchroniser maintenant | Envoie les opérations en attente et télécharge les nouveautés. | tous | — |

#### Alertes et notifications

`/alertes` · ECR-NOT-01 · tous les profils · utilisable hors ligne

Les alertes de votre périmètre (stock bas, mortalité élevée, retards, écarts…), vos notifications, et pour la Direction et l’Administrateur les règles d’alerte. La lecture et l’accusé se font aussi hors ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Accuser réception d’une alerte | Indique que vous l’avez vue ; possible hors ligne. | tous | — |
| Résoudre ou écarter une alerte | Avec un motif, en ligne. | tous | en ligne |
| Régler les règles d’alerte | Seuils et destinataires. | Direction, Administrateur | en ligne |

#### Notes de direction

`/notes` · ECR-NOT-02 · tous les profils · utilisable hors ligne

Les consignes publiées par la Direction à votre attention. Lisez-les et accusez réception.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Accuser réception | La Direction suit qui a lu. | tous | — |

#### Publier une note

`/notes/publication` · ECR-NOT-03 · Direction · en ligne

Rédiger une note de direction, choisir son audience (rôles, sites), la publier, l’archiver et suivre les accusés de réception. Une note publiée ne se modifie plus. En ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Rédiger et publier | Titre, texte, catégorie, audience. | Direction | en ligne |
| Archiver | Retire la note des écrans sans l’effacer. | Direction | en ligne |
| Suivre les accusés | Qui a lu, qui n’a pas encore lu. | Direction | en ligne |

#### Guide et aide

`/aide` · ECR-HLP-01 · tous les profils · utilisable hors ligne

Le guide complet de l’application : votre profil, ce que vous pouvez faire, les parcours de bout en bout, les pages par domaine, les questions fréquentes. Chaque page a aussi son aide, le bouton « ? » en haut.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Chercher dans le guide | Tapez un mot : seules les pages et les parcours qui le contiennent restent. | tous | — |
| Suivre un parcours | Par exemple « Démarrer un lot » : les étapes, dans l’ordre, avec le rôle qui fait chacune. | tous | — |

#### Catalogue

`/catalogue` · ECR-PRX-01 · Administrateur · en ligne

Les unités, les catégories, les produits (création, modification du nom, de la catégorie et des usages, coût standard daté, désactivation), les conditionnements (immuables) et les motifs utilisés par les écrans de perte, de visite, de rejet, d’inventaire. En ligne.

**Avant de commencer**

- Les animaux d’un lot sont des produits « suivis par lot » : créez-les ici (poussin d’un jour, porcelet…) avant de créer le lot.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Créer un produit | Nom, catégorie, unité de base, usages (vendable, achetable, consommable, suivi par lot…). | Administrateur | en ligne |
| Modifier un produit | Nom, catégorie, drapeaux d’usage ; coût standard daté. | Administrateur | en ligne |
| Désactiver ou réactiver | Un produit désactivé ne se propose plus ; son historique reste. | Administrateur | en ligne |
| Ajouter un motif | Pour les listes de motifs des écrans. | Administrateur | en ligne |

**Ensuite**

- Chargement de données (`/chargement`) — charger beaucoup de produits d’un coup (fichier CSV)

#### Chargement de données

`/chargement` · ECR-IMP-01 · Administrateur, Responsable commercial, Finance, Direction · utilisable hors ligne

Charger des données par fichier CSV : catégories de produit, produits, fournisseurs, clients, stock d’ouverture, comptes de trésorerie, règles de prix, pièces papier de l’historique. Le fichier est contrôlé ligne par ligne sur l’appareil ; rien n’est écrit tant que vous ne chargez pas, et recharger le même fichier ne crée aucun doublon.

**Avant de commencer**

- Les animaux et les produits suivis par lot se chargent par leurs lots, pas par le stock d’ouverture.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Charger un fichier | Choisissez le type, déposez le CSV, corrigez les lignes en erreur, puis chargez les lignes prêtes. | Administrateur, Responsable commercial, Finance, Direction | — |

#### Reporter une pièce papier

`/pieces/report` · ECR-PIE-01 · Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Magasinier, Responsable de ferme, Responsable production, Responsable achats, Finance, Administrateur, Direction · utilisable hors ligne

Reporter dans l’application une opération déjà faite sur un carnet à souche (panne de batterie, zone blanche) : bon de vente, reçu, bon de dépense, réception, transfert, perte… Les champs exigés suivent la commande réelle. Le registre des carnets suit les numéros utilisés.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Reporter une pièce | Type de pièce, numéro du carnet, puis les champs de l’opération ; envoyée comme toute opération. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Magasinier, Responsable de ferme, Responsable production, Responsable achats, Finance, Administrateur, Direction | — |

#### Présence du personnel

`/presence` · ECR-TER-03 · Administrateur, Direction, Responsable production, Responsable de ferme · utilisable hors ligne

Reporter la fiche de présence de la semaine (une feuille par site et par semaine : une ligne par personne, des heures ou un code d’absence par jour), lire les feuilles déjà reportées, imprimer la fiche PT. Usage de suivi, ni paie ni discipline.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Reporter une feuille | Possible sans réseau. | Administrateur, Direction, Responsable production, Responsable de ferme | — |
| Annuler une feuille | Pour la corriger : annulation motivée puis nouveau report, en ligne. | Administrateur, Direction, Responsable production, Responsable de ferme | en ligne |
| Imprimer la fiche PT | Dans la mise en page du papier. | Administrateur, Direction, Responsable production, Responsable de ferme | — |

#### Organisation

`/administration/organisation` · ECR-ADM-06 · Administrateur · en ligne

La structure de l’entreprise : sites (fermes, magasins, points de vente), leurs emplacements (bâtiments, cases, magasins, incubateurs), zones et géorepères, équipes, points de vente. Tout ce que les autres écrans proposent (fermes, magasins, destinations) vient d’ici. En ligne.

**Avant de commencer**

- À faire en premier, avant de créer des comptes de terrain : une ferme, ses bâtiments et un magasin d’aliment ; un magasin central ; les points de vente.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Créer un site | Nom, type (ferme, magasin, point de vente…), zone. | Administrateur | en ligne |
| Ajouter un emplacement | Dans la fiche d’un site : bâtiment, case, magasin, incubateur, éclosoir… | Administrateur | en ligne |
| Modifier, déplacer, fermer | Un site, une zone (déplacement), une équipe (fermeture) se corrigent ; rien ne se supprime. | Administrateur | en ligne |
| Définir un point de vente | Rattache un site de vente à sa source d’approvisionnement. | Administrateur | en ligne |

**Ensuite**

- Comptes et rôles (`/administration/utilisateurs`) — pour affecter un responsable de ferme ou un magasinier à ce site
- Catalogue (`/catalogue`) — produits que la ferme gère

#### Comptes et rôles

`/administration/utilisateurs` · ECR-ADM-04 · Administrateur · en ligne

Créer les comptes, leur donner un ou plusieurs rôles sur un périmètre (global ou un site), suspendre, réactiver, désactiver, réinitialiser un mot de passe. En ligne.

**Avant de commencer**

- Un rôle de terrain (responsable de ferme, magasinier, vendeur) s’affecte à un site : créez le site avant.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Créer un compte | Nom, téléphone, e-mail, mot de passe provisoire (changé à la première connexion) et premier rôle. | Administrateur | en ligne |
| Ajouter ou retirer un rôle | Sur « Global » ou un site. Un compte peut cumuler plusieurs rôles (administrateur et direction, par exemple). | Administrateur | en ligne |
| Réinitialiser un mot de passe | Pour une personne qui l’a oublié. | Administrateur | en ligne |
| Suspendre ou désactiver | Un compte désactivé ne se connecte plus ; son historique reste. | Administrateur | en ligne |

**Ensuite**

- Appareils (`/administration/appareils`) — approuver le téléphone de la personne à sa première connexion

#### Appareils

`/administration/appareils` · ECR-ADM-05 · Direction, Administrateur, Responsable commercial, Responsable production, Responsable de ferme, Magasinier · en ligne

Les téléphones et ordinateurs enrôlés : approuver un nouvel appareil, le bloquer, le déclarer perdu ou le rattacher à un site. Un appareil non approuvé ne peut rien envoyer. En ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Approuver un appareil | Vérifiez le code court affiché sur l’appareil, puis approuvez. | Direction, Administrateur, Responsable commercial, Responsable production, Responsable de ferme, Magasinier | en ligne |
| Bloquer ou déclarer perdu | L’appareil ne peut plus rien envoyer ; ses données peuvent être effacées. | Direction, Administrateur, Responsable commercial, Responsable production, Responsable de ferme, Magasinier | en ligne |
| Rattacher à un site | Définit où l’appareil travaille. | Direction, Administrateur, Responsable commercial, Responsable production, Responsable de ferme, Magasinier | en ligne |

#### Validations

`/validations` · ECR-ADM-08 · Direction, Finance, Responsable commercial, Responsable production, Responsable de ferme, Magasinier, Responsable achats · en ligne

La file des demandes que vous pouvez décider : mortalités, pertes, écarts d’inventaire ou de transfert, remises, annulations, dépenses, demandes d’achat… Chacun ne voit que ce qu’il peut décider. En ligne ; la plus ancienne d’abord.

**Avant de commencer**

- Vous ne pouvez pas valider votre propre demande, sauf la Direction (marquée « auto-validée »).

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Approuver ou refuser | Ouvrez la demande, lisez le motif et les pièces, puis décidez. Un refus appelle une raison. | Direction, Finance, Responsable commercial, Responsable production, Responsable de ferme, Magasinier, Responsable achats | en ligne |

#### Paramètres et politiques

`/administration/parametres` · ECR-ADM-07 · Direction, Administrateur · en ligne

Trois onglets : les paramètres système (seuils, délais, interrupteurs, par domaine, globaux ou par site), les politiques de contrôle (photo, commentaire, validation, approbateur, portée) et l’archive des photos jointes (Administrateur seul : téléchargement par période puis vidage du serveur, plancher de 30 jours). Toute modification crée une nouvelle version et garde l’historique. En ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Modifier un paramètre | La valeur est contrôlée selon ses bornes ; l’historique de la clé reste consultable. | Direction, Administrateur | en ligne |
| Modifier une politique de contrôle | Nouvelle version : photo, commentaire, validation exigés ou non, approbateur. | Direction, Administrateur | en ligne |

#### Journal d’audit

`/administration/audit` · ECR-AUD-01 · Direction, Supervision consultative, Administrateur, Finance · en ligne

La trace de tout ce qui a été fait : qui, quand, quoi, avant et après. Recherche par période, type d’objet, acteur et action. Chaque recherche est elle-même inscrite au journal. La Finance ne voit que les objets financiers.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Rechercher dans le journal | Filtrez, puis ouvrez une ligne pour le détail avant/après, le motif, l’appareil et la commande. | Direction, Supervision consultative, Administrateur, Finance | en ligne |

#### Supervision de la synchronisation

`/synchronisation/supervision` · ECR-SYN-02 · Administrateur, Direction, Supervision consultative · en ligne

La fraîcheur de chaque appareil (dernier envoi, dernier téléchargement, dernier contact) et les files d’opérations en attente qu’il a signalées. En ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Repérer un appareil en retard | Filtre « en retard » ; mène à la file des conflits. | Administrateur, Direction, Supervision consultative | en ligne |

**Ensuite**

- Conflits (`/synchronisation/conflits`) — traiter les opérations en conflit

#### Conflits de synchronisation

`/synchronisation/conflits` · ECR-SYN-03 · Direction, Administrateur, Finance, Responsable commercial, Responsable production, Responsable de ferme, Magasinier, Responsable achats · en ligne

Les opérations faites hors ligne que le serveur a appliquées avec un signalement ou mises de côté (stock insuffisant, lot clôturé, doublon…). Vous traitez ceux de votre domaine. En ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Clore un conflit | Avec un motif : résolu ou écarté. | Direction, Administrateur, Finance, Responsable commercial, Responsable production, Responsable de ferme, Magasinier, Responsable achats | en ligne |

#### Tour de contrôle

`/pilotage/direction` · ECR-ANA-01 · Direction, Supervision consultative · utilisable hors ligne

La vue d’ensemble de la Direction : production, stock, distribution, ventes, finances, équipes et alertes, lisible en moins de 30 secondes.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Lire les indicateurs | Choisissez la période ; chaque indicateur peut mener aux opérations qui l’expliquent. Hors ligne, le dernier instantané reste affiché. | Direction, Supervision consultative | — |
| Ouvrir l’explorateur | Pour descendre d’un indicateur jusqu’aux opérations sources (selon vos droits). | Direction, Supervision consultative | — |

**Ensuite**

- Validations (`/validations`) — décider ce qui attend la Direction

#### Explorateur

`/pilotage/explorateur` · ECR-ANA-06 · Direction, Supervision consultative, Responsable commercial, Responsable production, Responsable achats, Finance · en ligne

Interroger les jeux de données du catalogue analytique : filtrer, trier, grouper, agréger, descendre jusqu’au document source, enregistrer et partager des vues, demander des exports. En ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Explorer un jeu de données | Choisissez le jeu, les colonnes, les filtres et le regroupement. | Direction, Supervision consultative, Responsable commercial, Responsable production, Responsable achats, Finance | en ligne |
| Enregistrer une vue | Garde vos réglages ; partageable à une équipe selon vos droits. | Direction, Supervision consultative, Responsable commercial, Responsable production, Responsable achats, Finance | en ligne |
| Exporter en CSV ou XLSX | Chaque export est inscrit au journal d’audit. | Direction, Supervision consultative, Responsable commercial, Responsable production, Responsable achats, Finance | en ligne |

### Pages de détail

#### Menu « Plus »

`/menu` · tous les profils

Tout ce que votre profil peut ouvrir, par domaine, plus l’apparence (clair, sombre) et la déconnexion. Il reste utilisable hors ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Ouvrir un écran | Les écrans sont groupés par domaine (ventes, stock, production, achats, finance…). | tous | — |
| Choisir l’apparence | Clair, sombre ou celle de l’appareil. | tous | — |
| Se déconnecter | Efface la session de cet appareil. | tous | — |

#### Saisie du jour

`/production/lots/:lotId` · Responsable production, Responsable de ferme, Administrateur

Les quatre saisies de la journée d’un lot : mortalité, aliment et intrants, pesée, observation. Chaque saisie est une opération à part, enregistrée sur le téléphone puis envoyée ; le journal du jour les rassemble.

**Avant de commencer**

- Le lot doit être actif ou en vente : un lot planifié (aucun animal entré), clôturé ou annulé n’accepte pas de saisie.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Déclarer une mortalité | Nombre de morts, bâtiment ou case, cause facultative, photo. Selon la politique de contrôle des mortalités, elle attend la validation d’un responsable (Validations) ; la photo se joint aussi après coup. | Responsable production, Responsable de ferme, Administrateur | — |
| Saisir l’aliment ou un intrant consommé | Produit, quantité et nature du coût (aliment, vétérinaire, autre) : le stock baisse et le coût est imputé au lot. | Responsable production, Responsable de ferme, Administrateur | — |
| Enregistrer une pesée | Nombre de sujets pesés et poids moyen : alimente le gain moyen quotidien de la fiche. | Responsable production, Responsable de ferme, Administrateur | — |
| Noter une observation | Un constat daté (sanitaire, comportement, environnement, incident) avec sa gravité. | Responsable production, Responsable de ferme, Administrateur | — |
| Collecte d’œufs, sortie vers la vente, fiche du lot | Les trois liens en haut de page mènent aux écrans voisins du même lot. | Responsable production, Responsable de ferme, Administrateur | — |
| Corriger une erreur | Une pesée se corrige depuis la fiche du lot (annulation, en ligne) ; une collecte d’œufs depuis l’écran de collecte ; une mortalité refusée par le validateur revient au lot. | Responsable production, Direction, Supervision consultative, Administrateur | — |

**Ensuite**

- Fiche du lot (`/production/fiche`) — effectif, mortalité, indicateurs et coûts
- Sortie vers la vente (`/production/sortie`) — quand les animaux sont prêts

#### Détail d’un transfert

`/stock/transferts/:transferId` · Magasinier, Responsable de ferme, Responsable production, Administrateur

Les lignes, l’état (demandé, en transit, reçu, refusé) et les actions possibles sur un transfert.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Consulter le transfert | Origine, destination, lignes, quantités envoyées et reçues. | Magasinier, Responsable de ferme, Responsable production, Administrateur | — |
| Expédier ou refuser | Pour une demande reçue d’un point de vente. | Magasinier, Responsable de ferme, Responsable production, Administrateur | — |
| Annuler | Tant que le destinataire ne l’a pas reçu : le serveur refuse l’annulation une fois la réception saisie. | Magasinier, Responsable de ferme, Responsable production, Administrateur | — |

#### Réception d’un transfert

`/stock/receptions/:transferId` · Commercial terrain, Vendeur de point de vente, Responsable production, Responsable de ferme, Magasinier, Administrateur

Compter ce qui est arrivé, ligne par ligne, et enregistrer la réception.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Enregistrer la réception | Quantité reçue par ligne ; un écart avec l’envoi est signalé et validé par un responsable. | Commercial terrain, Vendeur de point de vente, Responsable production, Responsable de ferme, Magasinier, Administrateur | — |

**Ensuite**

- Stock (`/stock`) — pour voir l’entrée en stock

#### Réception sans document

`/stock/receptions/sans-document` · Commercial terrain, Vendeur de point de vente, Responsable production, Responsable de ferme, Magasinier, Administrateur

Enregistrer une marchandise arrivée sans transfert saisi. Elle reste à rapprocher du transfert d’origine ; sans rapprochement dans les 48 h, une alerte le signale.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Enregistrer la réception sans document | Produit, quantité, provenance déclarée : entrée en stock immédiate, rapprochement ensuite. | Commercial terrain, Vendeur de point de vente, Responsable production, Responsable de ferme, Magasinier, Administrateur | — |

#### Réception d’un bon de commande

`/achats/receptions/:orderId` · Magasinier, Responsable de ferme, Responsable production, Administrateur

Compter la livraison ligne par ligne : ce qui est livré, rejeté, accepté. Les quantités acceptées entrent en stock ; le reliquat reste dû par le fournisseur.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Enregistrer la réception | Quantités par ligne ; le bon de livraison se photographie et se joint. | Magasinier, Responsable de ferme, Responsable production, Administrateur | — |

**Ensuite**

- Stock (`/stock`) — pour voir l’entrée en stock

#### Réception sans bon de commande

`/achats/receptions/sans-bon` · Magasinier, Responsable de ferme, Responsable production, Administrateur

Enregistrer un achat comptant livré sans bon de commande : poussins, porcelets, aliment. Le prix unitaire est obligatoire (il fonde le coût du lot) ; un produit suivi par lot demande le code de lot du fournisseur.

**Avant de commencer**

- Le fournisseur et les produits achetables sont au catalogue ; sinon demandez au responsable des achats et à l’administrateur de les créer.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Enregistrer la réception | Fournisseur, produits, quantités, prix unitaires, emplacement de réception. | Magasinier, Responsable de ferme, Responsable production, Administrateur | — |

**Ensuite**

- Nouveau lot (`/production/nouveau-lot`) — pour faire entrer les animaux réceptionnés dans un lot

#### Détail d’une vente

`/ventes/:saleId` · Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Direction, Supervision consultative, Finance

Le reçu de la vente, imprimable, et son annulation.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Imprimer ou montrer le reçu | Le reçu se compose sur le téléphone ; le numéro officiel arrive avec la synchronisation. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Direction, Supervision consultative, Finance | — |
| Annuler la vente | Immédiat pour le vendeur dans le délai prévu (15 minutes par défaut) ; sinon la demande part en validation. Un motif est obligatoire. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme | — |

#### Détail d’une commande

`/commandes/:orderId` · Direction, Supervision consultative, Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Magasinier, Finance

La progression de chaque ligne (commandé, vendu, livré, en attente de stock) et ce qu’on peut en faire.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Livrer | Remettre au client ce qui est vendu et pas encore livré. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Magasinier | — |
| Vendre le disponible | Pour la part en attente de stock, quand du stock est arrivé. | Responsable commercial, Commercial terrain, Commercial sédentaire | — |
| Annuler la commande | Tant qu’aucune livraison n’a eu lieu ; un motif est demandé. | Direction, Responsable commercial, Commercial terrain, Commercial sédentaire | — |
| Clôturer le reste | Après une livraison partielle : le reliquat est abandonné. | Direction, Responsable commercial, Commercial terrain, Commercial sédentaire | — |

#### Livrer une commande

`/commandes/:orderId/livrer` · Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Magasinier

Saisir les quantités remises au client, ligne par ligne, avec le nom de la personne qui reçoit. L’écran avertit du reste dû mais ne bloque pas : le serveur refuse en ligne une livraison non payée (sauf client autorisé au crédit) et la signale hors ligne.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Enregistrer la livraison | Quantités plafonnées à ce qui est vendu et pas encore livré. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Magasinier | — |
| Encaisser le reste dû | Mène à l’encaissement du client. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Finance | — |

#### Fiche client

`/clients/:customerId` · Direction, Supervision consultative, Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Finance

Un compte client : coordonnées, stade, crédit et encours, ventes des 7 derniers jours, commandes ouvertes, visites et échanges des 90 derniers jours. Raccourcis vers la vente, la commande, la visite et l’encaissement.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Vendre, commander, visiter | Les boutons de l’en-tête ouvrent l’écran voulu avec le client déjà choisi. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme | — |
| Modifier les coordonnées | Pour les comptes de votre portefeuille. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente | — |
| Noter un échange | Appel, SMS, courriel ou autre ; non modifiable ensuite. | Responsable commercial, Commercial terrain, Commercial sédentaire | — |
| Encaisser | Quand le client a un encours. | Responsable commercial, Commercial terrain, Commercial sédentaire, Vendeur de point de vente, Responsable de ferme, Finance | — |

#### Noter un échange

`/clients/:customerId/echange` · Responsable commercial, Commercial terrain, Commercial sédentaire

Garder la trace d’un contact avec un client : canal, sens, résumé et prochaine action. Un échange enregistré ne se modifie plus.

| Action | Ce qu’elle fait | Qui | Réseau |
|---|---|---|---|
| Enregistrer l’échange | Possible sans réseau. | Responsable commercial, Commercial terrain, Commercial sédentaire | — |

## 4. Questions fréquentes

**Pourquoi je ne vois pas une page, un bouton ou un lot ?**

Trois raisons possibles. 1) Votre rôle ne porte pas la fonction : ouvrez « Aide » (le « ? » en haut) sur la page, la section « Réservé à d’autres profils » nomme les rôles qui peuvent. 2) Votre rôle est de terrain, donc rattaché à un site : vous ne voyez que les données de votre site, et un site qui n’existe pas encore n’a rien à montrer (Administration → Organisation). 3) Le téléphone n’a pas encore tout téléchargé : synchronisez.

**La liste des lots est vide. Que faire ?**

Un lot n’est actif qu’une fois des animaux entrés. Dans l’ordre : une ferme et ses bâtiments (Organisation) ; les animaux en stock sur la ferme (Achats → Réceptions → sans bon de commande) ; Production → Nouveau lot ; puis « Entrée dans un lot ». Le guide « Démarrer et conduire un lot » détaille les étapes.

**Puis-je travailler sans réseau ?**

Oui pour la plupart des saisies du terrain (ventes, saisie du jour, collectes, réceptions, pertes, comptages…) : elles restent sur le téléphone et partent au retour du réseau. Les écrans d’administration, de finance, d’analyse, la clôture d’un lot et les annulations se font en ligne. Chaque page le précise dans son aide (« En ligne »).

**Comment supprimer une opération ?**

Rien ne se supprime : on annule, avec un motif, et l’opération reste à l’historique. Voir le parcours « Corriger une erreur ».

**Pourquoi les coûts et les marges ne s’affichent-ils pas ?**

Les montants (coûts, valeurs, marges) sont réservés aux rôles qui voient les valorisations : Direction, Finance, Responsable production et Supervision. Un compte Administrateur seul n’y a pas accès.

**Qui valide une mortalité ou une perte ?**

Selon la politique de contrôle : le responsable de production, le responsable de ferme ou le magasinier de son périmètre, ou la Direction. La demande attend dans Validations. Nul ne valide sa propre demande, sauf la Direction.

**Une opération a été refusée. Où voir pourquoi ?**

Sur l’écran de l’opération juste après l’envoi, et dans Synchronisation : chaque refus donne sa raison en langage métier. Corrigez puis refaites l’opération.

## Annexe A — Quelles pages pour quel rôle

Une croix indique que le menu propose la page au rôle. Le serveur revérifie chaque permission. Abréviations : DIR = Direction, ADM = Administrateur, RCO = Responsable commercial, CTE = Commercial terrain, CSE = Commercial sédentaire, VEN = Vendeur de point de vente, RPR = Responsable production, RFE = Responsable de ferme, MAG = Magasinier, ACH = Responsable achats, FIN = Finance, SUP = Supervision consultative.

| Page | DIR | ADM | RCO | CTE | CSE | VEN | RPR | RFE | MAG | ACH | FIN | SUP |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Nouvelle vente (`/ventes/nouvelle`) |  |  | × | × | × | × |  | × |  |  |  |  |
| Nouvelle commande (`/commandes/nouvelle`) |  |  | × | × | × |  |  |  |  |  |  |  |
| Commandes (`/commandes`) | × |  | × | × | × | × |  |  | × |  | × | × |
| Encaisser une créance (`/encaisser`) |  |  | × | × | × | × |  | × |  |  | × |  |
| Règles tarifaires (`/prix/regles`) | × |  | × |  |  |  |  |  |  |  |  |  |
| Simulateur de prix (`/prix/simulateur`) | × |  | × |  |  |  |  |  |  |  |  | × |
| Accueil du point de vente (`/pdv`) |  |  |  |  |  | × |  |  |  |  |  |  |
| Caisse du point de vente (`/caisse`) |  |  |  |  |  | × |  |  |  |  | × |  |
| Remises de fonds (`/caisse/remises`) |  |  | × | × | × | × |  | × |  |  | × |  |
| Distribution par point de vente (`/pdv/distribution`) | × |  | × |  |  | × |  |  | × |  | × | × |
| Ventes récentes (`/ventes`) | × |  | × | × | × | × |  | × |  |  | × | × |
| Stock par emplacement (`/stock`) | × | × | × | × | × | × | × | × | × | × | × | × |
| Transferts (`/stock/transferts`) |  | × |  |  |  |  | × | × | × |  |  |  |
| Réceptions de transfert (`/stock/receptions`) |  | × |  | × |  | × | × | × | × |  |  |  |
| Déclarer une perte (`/stock/perte`) |  | × |  | × |  | × | × | × | × |  |  |  |
| Inventaire (`/stock/inventaire`) |  | × |  |  |  | × | × | × | × |  |  |  |
| Registre des mouvements (`/stock/registre`) | × | × | × |  |  |  | × | × | × |  | × | × |
| Consommation d’intrants (`/stock/consommation`) |  | × |  |  |  | × | × | × | × |  |  |  |
| Seuils d’alerte (`/stock/seuils`) | × | × | × |  |  |  | × | × | × |  |  |  |
| Quotas (`/stock/quotas`) | × | × | × |  |  |  |  | × | × |  |  |  |
| Demande de réapprovisionnement (`/pdv/reapprovisionnement`) |  |  |  |  |  | × |  |  |  |  |  |  |
| Tableau du stock (`/pilotage/stock`) | × | × |  |  |  |  | × | × | × | × | × | × |
| Mon portefeuille (`/clients`) |  |  | × | × | × |  |  |  |  |  |  |  |
| Mes objectifs (`/objectifs`) |  |  | × | × | × |  |  |  |  |  |  |  |
| Nouveau prospect (`/clients/nouveau`) |  |  | × | × | × | × |  | × |  |  |  |  |
| Gestion des objectifs (`/objectifs/gestion`) | × |  | × |  |  |  |  |  |  |  |  |  |
| Réaffectation de clients (`/clients/reaffecter`) | × |  | × |  |  |  |  |  |  |  |  |  |
| Présences et activité de l’équipe (`/equipe/activite`) | × |  | × |  |  |  |  |  |  |  |  | × |
| Prendre service (`/service`) |  |  | × | × |  |  |  |  |  |  |  |  |
| Nouvelle visite (`/clients/visite`) |  |  | × | × |  |  |  |  |  |  |  |  |
| Tableau commercial (`/pilotage/commercial`) | × |  | × | × | × |  |  |  |  |  | × | × |
| Bilan de la semaine (`/bilan-hebdomadaire`) | × |  | × | × | × |  |  |  |  |  |  |  |
| Demandes d’achat (`/achats/demandes`) | × | × |  |  |  |  | × | × | × | × | × |  |
| Fournisseurs (`/achats/fournisseurs`) |  |  |  |  |  |  |  |  |  | × |  |  |
| Bons de commande (`/achats/bons-de-commande`) |  |  |  |  |  |  |  |  |  | × |  |  |
| Réceptions d’achat (`/achats/receptions`) |  | × |  |  |  |  | × | × | × |  |  |  |
| Rapprochement commande, réception, facture (`/achats/rapprochement`) | × |  |  |  |  |  |  |  |  | × | × | × |
| Lots de production (`/production/lots`) |  | × |  |  |  |  | × | × |  |  |  |  |
| Collecte d’œufs (`/production/collecte`) |  | × |  |  |  |  | × | × |  |  |  |  |
| Fiche d’un lot (`/production/fiche`) | × | × |  |  |  |  | × |  |  |  |  | × |
| Nouveau lot et entrée d’animaux (`/production/nouveau-lot`) |  | × |  |  |  |  | × |  |  |  |  |  |
| Incubations (`/production/incubation`) |  | × |  |  |  |  | × | × |  |  |  |  |
| Sortie vers la vente (`/production/sortie`) |  | × |  |  |  |  | × | × |  |  |  |  |
| Tableau de la production (`/pilotage/production`) | × | × |  |  |  |  | × | × |  |  | × | × |
| Trésorerie (`/finance/tresorerie`) | × |  |  |  |  |  |  |  |  |  | × |  |
| Dépenses (`/finance/depenses`) | × |  | × | × | × | × | × | × | × | × | × |  |
| Factures fournisseurs (`/finance/factures`) | × |  |  |  |  |  |  |  |  | × | × | × |
| Paiements fournisseurs (`/finance/paiements`) | × |  |  |  |  |  |  |  |  | × | × | × |
| Créances (`/finance/creances`) | × |  | × |  |  |  |  |  |  |  | × | × |
| Coûts et marges (`/finance/couts-et-marges`) | × |  |  |  |  |  |  |  |  |  | × | × |
| Tableau finance et trésorerie (`/pilotage/finance`) | × |  |  |  |  |  |  |  |  |  | × | × |
| Accueil (`/`) | × | × | × | × | × | × | × | × | × | × | × | × |
| Synchronisation (`/synchronisation`) | × | × | × | × | × | × | × | × | × | × | × | × |
| Supervision de la synchronisation (`/synchronisation/supervision`) | × | × |  |  |  |  |  |  |  |  |  | × |
| Conflits de synchronisation (`/synchronisation/conflits`) | × | × | × |  |  |  | × | × | × | × | × |  |
| Catalogue (`/catalogue`) |  | × |  |  |  |  |  |  |  |  |  |  |
| Appareils (`/administration/appareils`) | × | × | × |  |  |  | × | × | × |  |  |  |
| Validations (`/validations`) | × |  | × |  |  |  | × | × | × | × | × |  |
| Comptes et rôles (`/administration/utilisateurs`) |  | × |  |  |  |  |  |  |  |  |  |  |
| Organisation (`/administration/organisation`) |  | × |  |  |  |  |  |  |  |  |  |  |
| Paramètres et politiques (`/administration/parametres`) | × | × |  |  |  |  |  |  |  |  |  |  |
| Journal d’audit (`/administration/audit`) | × | × |  |  |  |  |  |  |  |  | × | × |
| Alertes et notifications (`/alertes`) | × | × | × | × | × | × | × | × | × | × | × | × |
| Notes de direction (`/notes`) | × | × | × | × | × | × | × | × | × | × | × | × |
| Publier une note (`/notes/publication`) | × |  |  |  |  |  |  |  |  |  |  |  |
| Tour de contrôle (`/pilotage/direction`) | × |  |  |  |  |  |  |  |  |  |  | × |
| Explorateur (`/pilotage/explorateur`) | × |  | × |  |  |  | × |  |  | × | × | × |
| Reporter une pièce papier (`/pieces/report`) | × | × | × | × | × | × | × | × | × | × | × |  |
| Chargement de données (`/chargement`) | × | × | × |  |  |  |  |  |  |  | × |  |
| Présence du personnel (`/presence`) | × | × |  |  |  |  | × | × |  |  |  |  |
| Guide et aide (`/aide`) | × | × | × | × | × | × | × | × | × | × | × | × |
