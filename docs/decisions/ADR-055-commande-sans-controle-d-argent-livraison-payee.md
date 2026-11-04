# ADR-055 — Une commande n'est jamais conditionnée par l'argent : le contrôle du crédit quitte la confirmation, le paiement complet s'exige à la livraison

- **Statut** : ACCEPTÉ (CONFIRMÉ : décision du porteur du 04/11/2026, AV-511 tranché ; AV-512 et AV-513 ouverts, défauts mis en œuvre)
- **Date** : 04/11/2026
- **Précise** : ADR-028 §4, §7 et §8 (la confirmation d'une commande est une vente du disponible ; la livraison ne dépasse pas le vendu non livré ; l'acompte passe à la vente) : **elle ne change ni la vente à la confirmation ni le chiffre d'affaires à la confirmation (AV-024, tranché le 27/09/2026)** ; **remplace** pour une commande le contrôle du crédit de BR-VEN-025 par BR-VEN-033 et BR-VEN-034
- **Questions liées** : AV-511 (tranché), AV-512, AV-513 ; AV-024, AV-028, AV-033, AV-126, AV-129, AV-133, AV-143, AV-150 ; [`D04`](../01-functional/domaines/D04-VEN-commandes-ventes.md) §7 (BR-VEN-025, BR-VEN-033, BR-VEN-034)

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

## Décision

1. **Aucun contrôle d'argent à la confirmation.** Ni le droit au crédit du client, ni son plafond, ni un paiement ne
   refusent ni ne signalent une commande, en ligne comme hors ligne. `confirmOrderPending` ne contrôle plus le crédit ;
   `CREDIT_NOT_ALLOWED` et `CREDIT_LIMIT_EXCEEDED` (et la validation a posteriori `CREDIT_LIMIT_EXCEEDED`) ne valent plus que
   pour une **vente directe** (`sales.sale.record`, BR-VEN-025, inchangée). L'acompte joint à la commande suit toujours AV-033
   (affecté à la commande, puis passé à la vente à la confirmation) ; l'acompte d'une commande refusée hors ligne pour une
   autre raison reste conservé en crédit client (AV-150).
2. **Le paiement complet s'exige à la livraison.** `sales.order.fulfil` vérifie que **chaque vente qui fournit la
   marchandise livrée** est payée en entier (`balance_due_xaf` nul : total − annulé − payé, BR-VEN-026), avant toute
   écriture. En ligne, une vente à solde dû est refusée : `ORDER_NOT_PAID`, message en français citant le reste dû et le
   numéro de la vente, aucune écriture. Hors ligne, la remise a eu lieu : c'est un fait accompli (BR-SYN-007), appliquée
   avec l'avertissement `DELIVERY_UNPAID` et un conflit informatif `DELIVERY_UNPAID` (rôle `FINANCE`, appliqué) qui liste les
   ventes à solde dû ; la vente reste à solde dû et figure aux créances, la Finance relance. Le contrôle est **par vente** :
   une livraison qui puise dans une vente payée et dans une vente non payée est refusée en entier ; une livraison limitée à
   la vente payée passe.
3. **Un paramètre, vrai par défaut.** `sales.delivery_requires_full_payment` (booléen, réglable par site, catalogue
   `@gic/contracts`, semé `true`, visible de l'appareil). Le serveur lit la valeur du site, à défaut globale, **à défaut
   `true`**, en vigueur à `occurred_at` ; seule une valeur explicitement fausse lève l'exigence, une valeur absente ou mal
   formée la maintient. L'appareil lit la même valeur (`deliveryPaymentRequired`).
4. **L'appareil avertit, il ne bloque pas.** L'écran de commande ne dit plus rien du crédit : il rappelle qu'une commande se
   passe sans payer et se livre payée. L'écran de livraison avertit du reste dû que l'appareil connaît (ventes du jeu
   `sales_recent`, sept derniers jours, diminuées des encaissements en attente de l'outbox) et mène à l'encaissement ciblé
   sur la vente (`/encaisser?client=…&vente=…`) ; le serveur juge seul, un paiement reçu ailleurs ou une vente que l'appareil
   ne connaît pas ne doivent pas empêcher d'enregistrer une remise déjà faite.
5. **Rien d'autre ne change.** La vente née de la confirmation, son chiffre d'affaires, le mouvement vers « à livrer », le
   prix convenu, le délai de paiement du client, l'annulation et la clôture du reste sont ceux d'ADR-028. Le report des
   pièces papier (PP-B) envoie ses livraisons hors ligne : elles sont appliquées et signalées (`DELIVERY_UNPAID`), jamais
   refusées.

## Conséquences

- **Une commande non payée est une vente à solde dû.** C'est la conséquence de la vente à la confirmation (AV-024) que le
  porteur n'a pas remise en cause : le solde entre dans `balance_due_xaf`, donc dans l'encours du client (plafond d'une
  *vente directe* de crédit) et dans les créances par ancienneté, avec une échéance à 30 jours depuis la confirmation
  (AV-129). Alors que ce solde n'est pas du crédit accordé : rien n'a été livré, et rien ne le sera avant le paiement. **À
  trancher par le porteur : AV-513** (défaut mis en œuvre : inchangé ; recommandation : ne compter que le livré non payé).
- **Les clients autorisés au crédit ne sont plus livrés à crédit** : le porteur a dit « avant la livraison, le client a
  entièrement payé sa commande », sans exception. **À trancher : AV-512** (défaut : payée d'abord pour tous ; l'exemption
  par le crédit se ferait en déplaçant `creditCheck` de la confirmation à la livraison, ce qui suppose AV-513).
- **La garde est un paramètre** : un site qui livre sans exiger le paiement (`false`) n'a plus aucun contrôle d'argent sur
  ses commandes ; c'est un choix explicite, tracé dans l'historique des paramètres.
- **Aucune migration.** `db:seed` pose la valeur ; absente, elle vaut vrai des deux côtés. **Appareils déjà installés** : une
  PWA d'avant cette décision affiche encore l'avertissement de crédit sur l'écran de commande (le serveur ne refuse plus
  rien) et ne lit pas le paramètre (bandeau « nouvelle version », AV-505).
- **Essais** : le contrôle du crédit à la confirmation est remplacé par des essais de confirmation sans contrôle (client sans
  crédit, plafond dépassé, payée en partie, hausse) ; la garde est éprouvée par `sales-order-fulfil-commands` (refus en
  ligne sans écriture, paiement par l'acompte ou par un encaissement ultérieur, plusieurs ventes, signalement hors ligne,
  paramètre levé ou mal formé) ; les autres suites qui livrent des commandes sans les payer lèvent la garde sur leur seul
  site d'essai (`allowDeliveryWithoutPayment`) ; le réglage global, partagé entre suites, n'est jamais touché.

## Alternatives écartées

- Ne plus créer de vente à la confirmation d'une commande (la vente naîtrait au paiement ou à la livraison) : lecture la plus
  littérale de « la commande n'est pas une vente », mais elle revient sur AV-024 (vente et chiffre d'affaires à la
  confirmation, tranché le 27/09/2026) et sur ADR-028, et sur toute la chaîne qui en dépend (stock « à livrer », contre-écritures,
  chiffre d'affaires, créances) ; le porteur ne l'a pas demandé.
- Contrôler le crédit à la livraison plutôt que le paiement complet : voir AV-512, non retenu faute d'accord et parce que
  l'encours compte aujourd'hui des ventes non livrées (AV-513).
- Statu quo : contredit la décision du porteur.
