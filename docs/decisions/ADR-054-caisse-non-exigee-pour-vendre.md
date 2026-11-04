# ADR-054 — Une vente n'est jamais conditionnée par l'ouverture d'une caisse : la session de caisse devient un paramètre, non exigée par défaut

- **Statut** : ACCEPTÉ (CONFIRMÉ : décision du porteur du 04/11/2026, AV-509 tranché ; AV-510 DÉDUIT, ouvert avec son défaut)
- **Date** : 04/11/2026
- **Précise** : ADR-032 §8 (session exigée à l'encaissement en espèces, P5-14), ADR-042 (dépense payée par la caisse d'un PDV), ADR-043 (paiement fournisseur) ; **remplace** la règle BR-DIS-005 de D05 §7 par le paramètre décrit ici
- **Questions liées** : AV-509, AV-510 ; AV-057, AV-184, AV-233, AV-267 (les défauts qu'ils décrivaient ne valent plus que si le paramètre est vrai) ; [`D05`](../01-functional/domaines/D05-DIS-distribution-points-de-vente.md) §7 (BR-DIS-005) et §8

## Contexte

BR-DIS-005 exigeait une session de caisse ouverte pour tout encaissement en espèces au point de vente. Sa source, AV-057,
n'était qu'une recommandation de procédure de caisse (une session par PDV et par jour, fonds compté, clôture avec comptage,
écart validé par la Finance) : elle ne disait pas qu'une vente en dépend. C'est P5-14 qui en avait **déduit** (AV-184,
AV-233) un refus `CASH_SESSION_REQUIRED` en ligne, un conflit `CASH_SESSION_MISSING` hors ligne et, sur la PWA, une invite
« Ouvrir la caisse » avec blocage de l'encaissement en espèces. P8 l'avait reprise pour les dépenses payées par la caisse
d'un PDV (AV-267) et pour les paiements fournisseurs en espèces.

Le 04/11/2026, à la lecture de l'écran « Nouvelle vente » (bandeau « la caisse du PDV doit être ouverte… »), le porteur a
tranché : on ne conditionne pas une vente par l'ouverture d'une caisse. Le responsable commercial ou le commercial vend sur
le terrain sans qu'une caisse soit ouverte à l'entrepôt, à la boutique ou au point de vente ; ce n'est pas une règle
obligatoire. Ce qui valide l'opération, c'est que le client verse l'argent sur un compte marchand (MTN Mobile Money,
Orange Money) ou bancaire de l'entreprise. L'ouverture d'une caisse n'est raisonnable que pour encaisser des espèces
**devant la caissière** : celui qui veut payer comptant va à la caisse ; celui qui paie par un moyen électronique n'a pas à
y passer, il paie, la transaction est reçue, on le livre.

## Décision

1. **Un paramètre, non exigé par défaut.** `finance.cash_session_required` (booléen, réglable par site, catalogue
   `@gic/contracts`, semé `false`, visible de l'appareil). Faux, et c'est le défaut : aucune vente, aucun encaissement
   hors vente, aucun acompte, ni aucune sortie d'espèces de la caisse d'un PDV n'est refusé ni signalé faute de session.
   Vrai pour un site (un PDV à caissière) ou pour tous : le comportement de P5-14 est celui d'avant, sans autre changement
   (refus en ligne `CASH_SESSION_REQUIRED`, conflit hors ligne `CASH_SESSION_MISSING`, invite « Ouvrir la caisse »,
   blocage de l'encaissement en espèces en ligne).
2. **Lecture à l'heure du fait.** Le serveur lit la valeur du site, à défaut globale, **à défaut `false`**, en vigueur à
   `occurred_at` (`isCashSessionRequired`, `finance`) ; une valeur absente ou mal formée ne rétablit jamais l'exigence.
   L'appareil lit la même valeur dans ses paramètres (`cashSessionRequired`) et ne montre ni bandeau ni blocage quand
   elle n'est pas vraie.
3. **Ce que le système ne peut pas savoir.** « Devant la caissière » n'est pas un fait que le serveur ou l'appareil puisse
   juger : le rôle `VENDEUR_PDV` tient la caisse comme la vente. L'exigence ne se module donc pas par rôle ni par moyen de
   paiement (les moyens électroniques n'ont jamais eu de session, ils créditent un compte `MOBILE_MONEY` ou `BANQUE`
   avec une référence de transaction) : elle se règle **par site**, selon que le point de vente a une caissière ou non.
4. **La session reste l'outil de la caissière.** Elle s'ouvre et se ferme comme avant (ECR-DIS-02, SM-CASH-SESSION). Quand
   une session couvre l'heure d'un mouvement, l'index `cash_session_id` est posé ; sinon il reste nul. L'attendu d'une
   session se lit toujours par fenêtre de temps, jamais par cet index (ADR-032 §2).
5. **Les sorties d'espèces suivent (AV-510, DÉDUIT).** La dépense payée par la caisse d'un PDV (à l'enregistrement ou
   payée ensuite) et le paiement fournisseur en espèces lisent le même paramètre : garder l'exigence sur les sorties alors
   qu'elle disparaît sur les entrées aurait donné une caisse où l'on encaisse sans session mais où l'on ne dépense pas, sans
   raison métier dite. Les plafonds et les catégories permises au PDV (BR-DIS-013, AV-266) restent exigés.

## Conséquences

- **Le contrôle de la caisse physique reste entier**, il n'est plus une condition de la vente : un encaissement sans
  session est au registre de la caisse du PDV ; à l'ouverture suivante, le fonds compté est mis en face du registre et
  l'écart d'ouverture est validé par la Finance s'il n'est pas nul (même traitement que le remboursement sans session,
  AV-186). L'annulation directe d'une vente en espèces sans session reste soumise à la session (AV-030, AV-185) : elle
  devient une demande, ce qui est la prudence voulue pour de l'argent qui n'est dans aucune session.
- **Ce qui n'existe plus par défaut** : l'attribution d'un encaissement à une session (les sous-totaux par vendeur d'une
  session, AV-187, ne comptent que les encaissements de sa fenêtre) et le signal `CASH_SESSION_MISSING` à la Finance. Les
  conflits déjà ouverts restent à clore (résolus par la prochaine ouverture qui les couvre, ou par la Finance).
- **Aucune migration.** `db:seed` pose la valeur ; absente, elle vaut faux des deux côtés. **Appareils déjà installés** :
  une PWA d'avant cette décision ne lit pas le paramètre et affiche encore le bandeau et le blocage en ligne tant qu'elle
  n'est pas mise à jour (bandeau « nouvelle version », AV-505) ; le serveur, lui, n'exige plus rien.
- **Essais** : l'exigence est éprouvée sur des sites d'essai dont le réglage est posé à vrai (`requireCashSession`), le
  défaut par des sites sans réglage ; le réglage global, partagé entre suites, n'est jamais touché.

## Alternatives écartées

- Retirer l'exigence du code, sans paramètre : perd la possibilité de rétablir la discipline de caisse d'un PDV qui a une
  caissière, que le porteur juge « raisonnable » pour l'espèce encaissée devant elle.
- Exiger la session selon le rôle de l'auteur ou le montant : le système ne sait pas qui est devant la caissière (point 3).
- Statu quo : contredit la décision du porteur.
