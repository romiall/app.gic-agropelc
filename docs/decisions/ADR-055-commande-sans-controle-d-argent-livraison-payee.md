# ADR-055 — Une commande n'est jamais conditionnée par l'argent : le contrôle du crédit quitte la confirmation et passe à la livraison, où un client sans crédit paie d'abord et un client autorisé est livré à crédit dans son plafond

- **Statut** : ACCEPTÉ (CONFIRMÉ : décisions du porteur du 04/11/2026 (AV-511, tranché) et du 05/11/2026 (AV-512, tranché : « livré à crédit ») ; AV-513 ouvert, défaut mis en œuvre)
- **Date** : 04/11/2026, précisé le 05/11/2026 (AV-512)
- **Précise** : ADR-028 §4, §7 et §8 (la confirmation d'une commande est une vente du disponible ; la livraison ne dépasse pas le vendu non livré ; l'acompte passe à la vente) : **elle ne change ni la vente à la confirmation ni le chiffre d'affaires à la confirmation (AV-024, tranché le 27/09/2026)** ; **remplace** pour une commande le contrôle du crédit de BR-VEN-025 par BR-VEN-033 (aucun à la confirmation) et BR-VEN-034 (à la livraison)
- **Questions liées** : AV-511 et AV-512 (tranchés), AV-513 ; AV-024, AV-028, AV-033, AV-126, AV-129, AV-133, AV-143, AV-150 ; [`D04`](../01-functional/domaines/D04-VEN-commandes-ventes.md) §7 (BR-VEN-025, BR-VEN-033, BR-VEN-034)

## Contexte

La confirmation d'une commande (`sales.order.place`, `confirm_remaining`, hausse par `update`) crée une vente de type
`ORDER` pour le disponible (ADR-028 §4). Parce qu'elle crée une vente, le contrôle du crédit de BR-VEN-025 (client
autorisé au crédit, encours après vente ≤ plafond) s'y appliquait à la part non payée par un acompte : refus
`CREDIT_NOT_ALLOWED` ou `CREDIT_LIMIT_EXCEEDED`, **même saisie hors ligne** (la confirmation étant une intention du
serveur, non un fait accompli, AV-126). La PWA l'annonçait par un avertissement orange sur l'écran de commande (« Ce client
n'a pas droit au crédit : le serveur refusera la commande en ligne si le reste n'est pas payé »). Ce choix était **déduit**
(D04 §15, « À VALIDER ») ; le porteur n'avait jamais demandé que le crédit conditionne une commande. La livraison, elle,
ne contrôlait aucun paiement.

Le 04/11/2026, à la lecture de l'écran « + Nouvelle commande », le porteur a tranché : le droit au crédit vaut pour la
**vente**, pas pour la **commande**. Le client peut commander sans payer ; une commande n'est pas nécessairement un
engagement financier ; elle se reçoit sans qu'il y ait de l'argent et ne doit pas être conditionnée par de l'argent. Ce
qu'on doit faire, c'est s'assurer qu'**avant la livraison** le client a entièrement payé sa commande. « La commande n'est
pas une vente. » À sa question (« commander à crédit, je ne vois pas de problème, non ? »), la réponse est oui, sous la
réserve d'AV-513 ci-dessous.

La première mise en œuvre exigeait donc le paiement complet de tout client, droit au crédit ou non. Le même jour, la
question a été posée au porteur : un client autorisé au crédit (BR-VEN-025) est-il, lui aussi, livré seulement une fois
payé ? **Le 05/11/2026, il a répondu « livré à crédit »** (AV-512 tranché).

## Décision

1. **Aucun contrôle d'argent à la confirmation.** Ni le droit au crédit du client, ni son plafond, ni un paiement ne
   refusent ni ne signalent une commande, en ligne comme hors ligne. `confirmOrderPending` ne contrôle plus le crédit :
   `CREDIT_NOT_ALLOWED` et `CREDIT_LIMIT_EXCEEDED` (et la validation a posteriori `CREDIT_LIMIT_EXCEEDED`) ne refusent plus
   une commande à sa confirmation et ne valent plus que pour une **vente directe** (`sales.sale.record`, BR-VEN-025,
   inchangée) ; la livraison d'une commande a son propre contrôle (décision 2). L'acompte joint à la commande suit toujours
   AV-033 (affecté à la commande, puis passé à la vente à la confirmation) ; l'acompte d'une commande refusée hors ligne
   pour une autre raison reste conservé en crédit client (AV-150).
2. **À la livraison, on paie, ou on livre à crédit un client autorisé.** `sales.order.fulfil` vérifie, avant toute écriture,
   que **chaque vente qui fournit la marchandise livrée** est payée en entier (`balance_due_xaf` nul : total − annulé −
   payé, BR-VEN-026). Une vente à solde dû est jugée ainsi :
   - **client sans droit au crédit**, ou crédit à la livraison interdit par le paramètre : en ligne, refus
     `ORDER_NOT_PAID`, message en français citant le reste dû et le numéro de la vente (et, pour un client sans crédit,
     qu'il n'y a pas droit), aucune écriture ;
   - **client autorisé au crédit** : la livraison est un **crédit accordé**, contrôlé comme celui d'une vente
     (`creditCheck`, BR-VEN-025) sur son **encours de crédit** et son plafond. Dans le plafond, la livraison se fait
     sans refus ni signalement et la vente reste due (créance). Au-delà, ou si le client est autorisé sans plafond défini
     (tout crédit dépasse un plafond absent) : en ligne, refus `CREDIT_LIMIT_EXCEEDED`, aucune écriture. Livrer de la
     marchandise déjà payée n'accorde aucun crédit et ne se refuse jamais ;
   - **hors ligne**, la remise a eu lieu : c'est un fait accompli (BR-SYN-007), appliquée avec l'avertissement
     `DELIVERY_UNPAID` et un conflit informatif `DELIVERY_UNPAID` (rôle `FINANCE`, appliqué) qui liste les ventes à solde
     dû, avec le motif (`ORDER_NOT_PAID` ou `CREDIT_LIMIT_EXCEEDED`) et ses chiffres (plafond, encours avant, crédit
     accordé) ; la vente reste à solde dû et figure aux créances, la Finance relance.
   Le contrôle du paiement est **par vente** (une livraison qui puise dans une vente payée et dans une vente non payée est
   jugée sur l'ensemble). Un client sans droit au crédit paie la vente **en entier** avant livraison : livrer au prorata
   du payé n'est pas retenu, le porteur ayant dit « entièrement payé ». La permission `sales.credit_sale.record` n'est pas
   exigée de celui qui livre (magasinier, livreur) : le droit au crédit est celui du client, comme à la confirmation.
3. **Encours de crédit : le remis non payé.** Ce que le client doit pour de la marchandise **déjà remise** :
   `customerCreditExposureXaf` (`sales`, comptes absorbés compris) somme, par vente non annulée à solde dû, le solde dû
   d'une vente **directe** (remise à la vente) et, pour une vente **sur commande**, la valeur livrée moins le payé (le payé
   s'impute d'abord sur le livré), jamais négative ; le non livré, même impayé, n'est pas un crédit accordé. La valeur
   livrée d'une ligne est la part de son montant que représente la quantité livrée (`deliveredShareXaf`, arrondie au franc,
   demi supérieur ; exactement le montant au livré complet). Le crédit qu'une livraison accorde est la hausse de cet
   encours qu'elle provoque ; il se compare au plafond avec l'encours d'**avant** la livraison. Le contrôle du crédit d'une
   **vente directe** garde son encours d'avant (le reste à encaisser, `customerOutstandingXaf`) : son unification avec
   l'encours de crédit est la suite d'AV-513.
4. **Deux paramètres, vrais par défaut.** `sales.delivery_requires_full_payment` (par site, catalogue `@gic/contracts`,
   semé `true`, visible de l'appareil) : faux, aucun contrôle de paiement à la livraison. `sales.delivery_on_credit_allowed`
   (par site, semé `true`, visible de l'appareil) : faux, tout client paie d'abord, y compris un client autorisé au crédit.
   Le serveur lit chaque valeur du site, à défaut globale, **à défaut `true`**, en vigueur à `occurred_at` ; seule une valeur
   explicitement fausse lève l'exigence, une valeur absente ou mal formée la maintient. L'appareil lit les mêmes valeurs
   (`deliveryPaymentRequired`, `deliveryOnCreditAllowed`).
5. **Verrous (ADR-038).** `sales.order.fulfil` prend désormais le **compte du client** (conservé, et absorbé le cas échéant,
   identifiants croissants, rang N3) avant la commande et ses ventes (rang N4) : le contrôle du plafond se fait sous le
   verrou du compte, comme celui d'une vente directe, et deux livraisons ou une vente concurrentes du même client se
   sérialisent. L'encours de crédit se lit sous verrou partagé, après avoir verrouillé les ventes de la livraison.
6. **L'appareil avertit, il ne bloque pas.** L'écran de commande ne dit plus rien du crédit : il rappelle qu'une commande se
   passe sans payer et se livre payée. L'écran de livraison dit le reste dû que l'appareil connaît (ventes du jeu
   `sales_recent`, sept derniers jours, diminuées des encaissements en attente de l'outbox) : **avertissement** pour un client
   qui paiera d'abord (le serveur refusera en ligne) ou dont le plafond pourrait être dépassé (estimation prudente : son reste
   à encaisser, qui majore son encours de crédit, tient-il dans son plafond ?), **simple information** « Livraison à crédit »
   pour un client autorisé dans son plafond ; il mène à l'encaissement ciblé sur la vente
   (`/encaisser?client=…&vente=…`). Le serveur juge seul, un paiement reçu ailleurs ou une vente que l'appareil ne connaît
   pas ne doivent pas empêcher d'enregistrer une remise déjà faite.
7. **Rien d'autre ne change.** La vente née de la confirmation, son chiffre d'affaires, le mouvement vers « à livrer », le
   prix convenu, le délai de paiement du client, l'annulation et la clôture du reste sont ceux d'ADR-028. Le report des
   pièces papier (PP-B) envoie ses livraisons hors ligne : elles sont appliquées et signalées (`DELIVERY_UNPAID`), jamais
   refusées.

## Conséquences

- **Une commande non payée est une vente à solde dû.** C'est la conséquence de la vente à la confirmation (AV-024) que le
  porteur n'a pas remise en cause : le solde entre dans `balance_due_xaf`, donc dans le reste à encaisser du client, dans les
  créances par ancienneté (échéance à 30 jours depuis la confirmation, AV-129) et dans l'encours du contrôle du crédit d'une
  *vente directe*. Alors que ce solde n'est pas du crédit accordé tant que rien n'est livré. **Le contrôle du crédit à la
  livraison ne compte que le remis non payé** (décision 3) ; **le reste est à trancher par le porteur : AV-513** (créances par
  ancienneté, échéance depuis la livraison plutôt que depuis la confirmation, encours affiché et encours d'une vente directe).
- **Deux notions voisines coexistent**, volontairement : le *reste à encaisser* (`balance_due_xaf`, ce que l'écran
  d'encaissement propose de régler, y compris avant la livraison) et l'*encours de crédit* (le remis non payé, ce que
  le plafond borne à la livraison). Un client qui a commandé sans payer n'a aucun encours de crédit tant qu'on ne lui a
  rien livré.
- **La garde est un paramètre** : un site qui livre sans exiger le paiement (`false`) n'a plus aucun contrôle d'argent sur
  ses commandes ; c'est un choix explicite, tracé dans l'historique des paramètres. Le second paramètre permet de revenir,
  par site ou pour tous, à « tout client paie d'abord ».
- **Aucune migration.** `db:seed` pose les valeurs ; absentes, elles valent vrai des deux côtés. **Appareils déjà
  installés** : une PWA d'avant cette décision affiche encore l'avertissement de crédit sur l'écran de commande (le serveur
  ne refuse plus rien) et ne lit pas les paramètres ni la distinction crédit (bandeau « nouvelle version », AV-505).
- **Essais** : le contrôle du crédit à la confirmation est remplacé par des essais de confirmation sans contrôle (client sans
  crédit, plafond dépassé, payée en partie, hausse) ; la garde est éprouvée par `sales-order-fulfil-commands` (refus en
  ligne sans écriture, paiement par l'acompte ou par un encaissement ultérieur, plusieurs ventes, signalement hors ligne,
  paramètres levés ou mal formés, livraison à crédit dans le plafond, plafond dépassé ou absent, encours de crédit
  qui ne compte que le remis non payé, livraisons partielles au franc près) ; `sales-credit-exposure` éprouve les fonctions
  pures ; AT-008 a une variante pour chaque cas (client sans crédit, client autorisé) ; les autres suites qui livrent des
  commandes sans les payer lèvent la garde sur leur seul site d'essai (`allowDeliveryWithoutPayment`) ; le réglage
  global, partagé entre suites, n'est jamais touché.

## Alternatives écartées

- Ne plus créer de vente à la confirmation d'une commande (la vente naîtrait au paiement ou à la livraison) : lecture la plus
  littérale de « la commande n'est pas une vente », mais elle revient sur AV-024 (vente et chiffre d'affaires à la
  confirmation, tranché le 27/09/2026) et sur ADR-028, et sur toute la chaîne qui en dépend (stock « à livrer », contre-écritures,
  chiffre d'affaires, créances) ; le porteur ne l'a pas demandé.
- Faire payer d'abord tout client, droit au crédit ou non (première mise en œuvre) : écarté par le porteur le 05/11/2026
  (« livré à crédit ») ; reste disponible par `sales.delivery_on_credit_allowed` à faux.
- Contrôler le crédit à la livraison sur le reste à encaisser : une commande non livrée, bientôt payée, consommerait le
  plafond du client et refuserait à tort la livraison qui la précède ; d'où l'encours de crédit, restreint au remis.
- Livrer au prorata du payé un client sans crédit : non retenu (« entièrement payé »), à rouvrir si le terrain le demande.
- Statu quo : contredit la décision du porteur.
