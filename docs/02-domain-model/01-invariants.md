# INVARIANTS DU SYSTÈME (Livrable n°6)

> Section 11 du format final (PM §48). Ce sont les règles qui **ne doivent jamais être violées**. Chaque invariant indique :
> - le **problème qu'il empêche** ;
> - son **mécanisme d'application** : `DB` (contrainte base de données), `TX` (vérification dans la transaction de la commande), `JOB` (contrôle de réconciliation planifié, qui lève une alerte), `CODE` (propriété structurelle du code, vérifiée par test) ;
> - le **type de test** qui le couvre : `U` (unitaire), `P` (propriété / génératif), `I` (intégration base réelle), `S` (scénario de synchronisation), `E` (E2E).
>
> Ce document est la source des suites de tests d'invariants (voir [`../09-non-functional/03-plan-de-tests.md`](../09-non-functional/03-plan-de-tests.md) §4). Un invariant violé en production est un **incident**, pas une anomalie métier.

---

## 1. Transverses (GLO)

| ID | Invariant | Problème empêché | Application | Tests |
|---|---|---|---|---|
| INV-GLO-01 | Toute ligne transactionnelle porte `occurred_at`, `created_by`, `created_at` et, si elle vient d'un appareil, `created_device_id` et `command_id`. Ces champs sont **immuables**. | Perte de la dimension responsabilité (CM §5.3) ; réécriture de l'histoire | DB (`NOT NULL`, déclencheur de refus de modification) | U, I |
| INV-GLO-02 | `occurred_at` ≤ `received_at` + 5 min, après correction de l'écart d'horloge mesuré. | Opérations datées dans le futur (fraude, horloge fausse) | TX | U, S |
| INV-GLO-03 | Aucune ligne d'une table de catégorie Transaction, Registre ou Audit n'est supprimée physiquement. | Disparition silencieuse (CM §40) | DB (privilège `DELETE` non accordé au rôle applicatif ; déclencheur) | I |
| INV-GLO-04 | Tout effet métier appliqué a exactement une entrée d'audit `SUCCESS`, écrite dans la même transaction. | Opération non traçable | TX + CODE | I |
| INV-GLO-05 | Une table n'est écrite que par son module propriétaire. | Plusieurs sources de vérité (CM §59) | DB (un rôle de base par schéma de module) + CODE (règles d'import) | I, revue |
| INV-GLO-06 | Les montants sont des entiers en XAF. Les montants de document sont ≥ 0 ; le sens est porté par une colonne dédiée (`direction`, `move_type`), jamais par un montant négatif. | Erreurs de signe, arrondis | DB (`CHECK`) | U |
| INV-GLO-07 | Un numéro officiel de document est unique par (type, site, année). | Doublons de numérotation | DB (`UNIQUE`) | I |

## 2. Synchronisation (SYN)

| ID | Invariant | Problème empêché | Application | Tests |
|---|---|---|---|---|
| INV-SYN-01 | Un `command_id` est appliqué **au plus une fois**. Toute ligne créée par une commande porte ce `command_id`, unique sur la table du document créé. | Vente ou paiement synchronisés deux fois (PM §28) | DB (`command_inbox.command_id` PK ; `UNIQUE (command_id)` sur les documents racines) | S, P |
| INV-SYN-02 | Un même `command_id` porte toujours la même empreinte de contenu. | Rejeu altéré ou falsifié | TX | S |
| INV-SYN-03 | (`device_id`, `device_seq`) est unique. | Rejeu déguisé ; perte de détection de trous | DB (`UNIQUE`) | S |
| INV-SYN-04 | Les commandes d'un même appareil sont appliquées dans l'ordre croissant de `device_seq`. | Effets dans le désordre (livraison avant commande) | TX (verrou par appareil) | S |
| INV-SYN-05 | Une commande `REJECTED` n'a laissé **aucun** effet dans les tables métier. | Effets partiels | TX (transaction unique) | S |
| INV-SYN-06 | Une commande constatant un fait physique ou financier accompli n'est jamais `REJECTED` pour une raison d'état métier : stock, prix, allocation, produit désactivé (BR-SYN-007). | Perte d'une vente réelle ; écart inexplicable | CODE (catalogue des motifs de rejet par type) | S |

## 3. Stock (STK)

| ID | Invariant | Problème empêché | Application | Tests |
|---|---|---|---|---|
| INV-STK-01 | Pour tout (emplacement, produit, lot) : `stock_balances.qty_on_hand` = Σ quantités entrantes − Σ quantités sortantes de `stock_moves`. | Stock modifié sans mouvement (CM §21) | TX (mise à jour atomique) + JOB (réconciliation quotidienne, alerte `LEDGER_MISMATCH`) | P, I |
| INV-STK-02 | Chaque mouvement a une quantité > 0, une source ≠ destination, et un couple (source, destination) conforme à son type (BR-STK-006). | Mouvements absurdes ou sans cause (PM §28 « un mouvement doit avoir une cause ») | DB (`CHECK`) + TX | U, I |
| INV-STK-03 | **Conservation** : pour tout produit, Σ soldes sur tous les emplacements (physiques et virtuels, les virtuels sources étant négatifs) = 0. | Création ou disparition de quantités | CODE (partie double) + JOB | P |
| INV-STK-04 | Un mouvement est immuable. Il ne peut être inversé qu'une seule fois, par un mouvement portant `reverses_move_id` (unique). Un inverse porte le même produit, le même lot, la même quantité et le même coût unitaire. | Double correction ; réécriture | DB (`UNIQUE (reverses_move_id)`, déclencheur d'immuabilité) | I, P |
| INV-STK-05 | Une opération hors ligne attestant un fait physique n'est jamais rejetée pour stock insuffisant. Si elle rend un solde physique négatif, un conflit `STOCK_NEGATIVE` **ouvert** existe pour ce couple (emplacement, produit) tant que le solde reste négatif. | Vente réelle perdue ; négatif ignoré (C-08) | TX + JOB | S |
| INV-STK-06 | Une opération **en ligne** ne rend jamais négatif le disponible d'un emplacement physique. | Survente en ligne (PM §6) | TX (verrou sur la ligne de solde) | I, S |
| INV-STK-07 | Un emplacement `INACTIVE` n'a, au moment de sa désactivation, aucun solde non nul, aucune allocation ou réservation active, aucun transfert ouvert. | Stock « orphelin » | TX | I |
| INV-STK-08 | Pour un transfert clôturé : Σ expédié = Σ reçu + Σ écart + Σ retourné, par ligne. Le transit du transfert est nul. | Marchandise perdue en route sans trace (CM §22) | TX + JOB | I, P |
| INV-STK-09 | Pour un inventaire `POSTED` : solde de chaque ligne à `counted_at` = quantité comptée, après les rapprochements tardifs. | Écart d'inventaire faussé par les synchronisations tardives | TX (rapprochement BR-STK-044) + JOB | S |
| INV-STK-10 | À l'octroi : Σ restes d'allocations actives + réservations actives ≤ solde de l'emplacement. Le reste d'une allocation ne devient jamais négatif par une consommation **en ligne**. | Double consommation hors ligne (PM §28, CM §39) | TX | S, P |
| INV-STK-11 | Une allocation `DEVICE_QUOTA` n'est consommée que par des opérations de son couple (utilisateur, appareil). | Consommation du quota d'autrui | TX | S |
| INV-STK-12 | Σ mouvements `PURCHASE_RECEIPT` d'une ligne de réception = `qty_accepted`. | Stock gonflé par des quantités non acceptées (CM §28, PM §28) | TX | I |
| INV-STK-13 | Un produit à suivi par lot `REQUIRED` n'a aucun mouvement sans lot. | Perte de traçabilité de lot | TX | I |
| INV-STK-14 | Le solde de `V_PENDING_LOSS` imputable à une déclaration de perte est > 0 seulement si la déclaration est `PENDING_APPROVAL`. Il est nul après toute décision. | Pertes bloquées indéfiniment | TX + JOB | I |
| INV-STK-15 | Tout mouvement d'un produit valorisé porte un `unit_cost_xaf` non nul et ≥ 0, déterminé par le serveur. | Pertes et marges non valorisables (CM §32) | DB (`CHECK`) + TX | I |
| INV-STK-16 | Pour une vente annulée, Σ net des mouvements `SALE` et de leurs inverses = 0 par ligne. | Annulation qui ne corrige pas le stock (PM §28) | TX | I, S |

## 4. Ventes et commandes (VEN)

| ID | Invariant | Problème empêché | Application | Tests |
|---|---|---|---|---|
| INV-VEN-01 | Une vente synchronisée n'est créée qu'une fois (INV-SYN-01 appliqué à `sales`). | Double vente (PM §28) | DB | S |
| INV-VEN-02 | Une vente `CONFIRMED` est immuable, à l'exception de `status` (annulation), des champs dérivés de paiement et du numéro officiel. | Réécriture de l'histoire | DB (déclencheur par liste blanche de colonnes) | I |
| INV-VEN-03 | Montant de ligne = arrondi(quantité de tarification × prix appliqué) − remise ; total = Σ lignes. | Montants incohérents | TX + DB (`CHECK` sur la ligne) | U, P |
| INV-VEN-04 | Pour chaque ligne de commande : quantité livrée cumulée ≤ quantité commandée. | Livraison au-delà de l'engagement | TX | I, S |
| INV-VEN-05 | Chaque ligne de vente conserve prix catalogue, prix appliqué, règle, version et source. Une modification tarifaire ne modifie aucune vente existante. | Réécriture de prix (CM §30, PM §28) | DB (`NOT NULL` + immuabilité) | I |
| INV-VEN-06 | Σ affectations actives sur une vente ≤ total ; `payment_status` = f(Σ affectations actives, total). | Surpaiement non détecté ; statut faux | TX + JOB | P |
| INV-VEN-07 | Une vente sans client est `PAID` à l'enregistrement. | Créance sans débiteur | TX | U |
| INV-VEN-08 | Pour une vente `CONFIRMED`, par ligne non `SERVICE` : Σ mouvements `SALE` = quantité en unité de base. | Vente sans sortie de stock (CM §13) | TX + JOB | I |
| INV-VEN-09 | Une vente `CANCELLED` n'a plus d'effet net : mouvements neutralisés (INV-STK-16), aucune affectation active. | Annulation partielle | TX | I |
| INV-VEN-10 | L'attribution (vendeur, commercial, canal, zone) est figée à la création et n'est jamais recalculée. | Performances réécrites par une réaffectation (CM §8) | DB (immuabilité) | I |

## 5. Finance (FIN)

| ID | Invariant | Problème empêché | Application | Tests |
|---|---|---|---|---|
| INV-FIN-01 | Une transaction financière (encaissement, paiement, dépense, mouvement de trésorerie, facture, écriture de coût) ne disparaît jamais : annulation par contre-écriture uniquement. | Disparition d'argent (PM §28) | DB (INV-GLO-03) | I |
| INV-FIN-02 | Solde d'un compte de trésorerie = Σ `IN` − Σ `OUT` de `cash_movements` ; la projection est exacte. | Caisse modifiée sans trace | TX + JOB | P, I |
| INV-FIN-03 | (moyen de paiement, référence externe) est unique parmi les encaissements `RECORDED`. | Double paiement (PM §30) | DB (index unique partiel) | I, S |
| INV-FIN-04 | Σ affectations actives d'un encaissement ≤ son montant. | Affectation d'argent inexistant | TX | P |
| INV-FIN-05 | Une session de caisse `VALIDATED` ne change plus, hors mouvements compensatoires rattachés et tracés. | Réécriture d'une caisse validée | DB + TX | I |
| INV-FIN-06 | Au plus une session `OPEN` par compte de caisse. | Double caisse | DB (index unique partiel) | I |
| INV-FIN-07 | Σ affectations de paiements fournisseurs sur une facture ≤ son montant. | Surpaiement fournisseur | TX | I |
| INV-FIN-08 | Le registre de coûts est en ajout seul ; coût d'un objet = Σ de ses écritures. | Coût de lot modifié arbitrairement | DB | I |
| INV-FIN-09 | Un encaissement `SUSPECT_DUPLICATE` ou `REJECTED` n'a aucun mouvement de trésorerie ni affectation active. | Doublon comptabilisé | TX | S |
| INV-FIN-10 | Toute affectation active porte sur une vente non annulée ou une commande non annulée. | Argent affecté à une vente annulée | TX | I |

## 6. CRM et pointage (CRM, TER)

| ID | Invariant | Problème empêché | Application | Tests |
|---|---|---|---|---|
| INV-CRM-01 | `acquired_by_user_id` et `acquired_at` sont immuables. | Réattribution frauduleuse d'acquisition (CM §7) | DB | I |
| INV-CRM-02 | Un compte a au plus une affectation de titulaire active ; les périodes d'affectation ne se chevauchent pas. | Deux commerciaux responsables du même client (CM §8) | DB (contrainte d'exclusion sur la plage temporelle) | I |
| INV-CRM-03 | Le téléphone principal normalisé est unique parmi les comptes non `MERGED`. | Doublons de clients | DB (index unique partiel) — hors ligne : conflit `DUPLICATE_CUSTOMER` puis fusion | I, S |
| INV-CRM-04 | Un compte `CUSTOMER` a un `first_sale_id` non nul. | Client sans achat | DB (`CHECK`) | I |
| INV-CRM-05 | Un compte `MERGED` pointe vers un compte non `MERGED` ; la chaîne de fusion est sans cycle. | Chaîne de fusion infinie | TX | U |
| INV-TER-01 | Au plus une session de travail non clôturée par utilisateur. | Présence incohérente | DB (index unique partiel) | I |
| INV-TER-02 | Toute tentative de pointage est conservée, y compris refusée. | Effacement de tentatives frauduleuses (CM §10) | DB (INV-GLO-03) | I |

## 7. Production (PRD, OEU, INC)

| ID | Invariant | Problème empêché | Application | Tests |
|---|---|---|---|---|
| INV-PRD-01 | L'effectif d'un lot n'est stocké nulle part comme valeur saisie : il est égal à Σ soldes de son lot de traçabilité. `initial_quantity` = Σ entrées `PLACEMENT`. | Effectif modifié arbitrairement (CM §15) | CODE (aucune colonne d'effectif modifiable) + JOB | I |
| INV-PRD-02 | Un lot `CLOSED` a un effectif non vendu nul ; aucun nouveau mouvement ne porte son lot après la clôture, sauf opération hors ligne tardive (alors conflit `LOT_CLOSED`). | Mouvements sur un lot fermé | TX | I, S |
| INV-PRD-03 | La mortalité n'existe qu'une fois : déclaration de perte de catégorie `MORTALITE` (aucune autre table de mortalité). | Double comptage (C-09) | CODE (modèle) | revue, I |
| INV-OEU-01 | Pour une collecte : collectés = cassés + non conformes + commercialisables + à couver ; mouvements = commercialisables et à couver. | Œufs créés ou perdus sans trace (CM §17) | DB (`CHECK`) + TX | U, I |
| INV-INC-01 | Pour un lot d'incubation clôturé : œufs incubés = infertiles + morts embryonnaires + pertes accidentelles + non éclos + éclos (viables + non viables). | Œufs engagés non reliés au résultat (CM §18) | TX (à l'éclosion) + DB (`CHECK`) | U, I |

## 8. Approvisionnement (APP)

| ID | Invariant | Problème empêché | Application | Tests |
|---|---|---|---|---|
| INV-APP-01 | Pour une ligne de réception : 0 ≤ `qty_rejected` ≤ `qty_delivered` et `qty_accepted` = `qty_delivered` − `qty_rejected`. | Incohérence livré, rejeté, accepté (CM §28) | DB (`CHECK`) | U |
| INV-APP-02 | Pour une ligne de BC : Σ accepté des réceptions `POSTED` ≤ commandé, sauf excédent tracé en revue (`OVER_RECEIPT`). | Réception fantôme | TX | I, S |
| INV-APP-03 | Une réception `QUARANTINED` ou `REJECTED` n'a aucun mouvement de stock. | Double réception (PM §28) | TX | S |
| INV-APP-04 | Les lignes d'un BC `SENT` ne sont jamais augmentées. | Engagement modifié après envoi | TX | I |

## 9. Tarification (PRX)

| ID | Invariant | Problème empêché | Application | Tests |
|---|---|---|---|---|
| INV-PRX-01 | Une règle `ACTIVE` est immuable, à l'exception d'une réduction de `valid_to`. | Prix historique modifié (CM §30) | DB (déclencheur) | I |
| INV-PRX-02 | Il n'existe jamais deux règles actives en conflit (BR-PRX-006). | Prix ambigu | TX (à l'activation) | P |
| INV-PRX-03 | Aucune règle n'est supprimée. | Historique des prix perdu | DB | I |
| INV-PRX-04 | Pour un même contexte et un même jeu de règles, le résultat de la résolution est identique sur l'appareil et sur le serveur. | Écarts de prix hors ligne injustifiés | CODE (moteur unique) + tests croisés | P |

## 10. Administration, audit, intégration, alertes (ADM, AUD, KOM, NOT)

| ID | Invariant | Problème empêché | Application | Tests |
|---|---|---|---|---|
| INV-ADM-01 | Au moins un utilisateur `ADMIN` actif. | Système inadministrable | TX | U |
| INV-ADM-02 | Approbateur ≠ demandeur, sauf `SELF_APPROVED` par un utilisateur `DIRECTION`. | Auto-validation frauduleuse (CM §5.3) | TX | U, I |
| INV-ADM-03 | Aucune commande d'un appareil `BLOCKED`, `LOST` ou `RETIRED` dont `occurred_at` est postérieur au blocage n'est appliquée automatiquement. | Utilisation d'un appareil volé | TX | S |
| INV-ADM-04 | Les affectations de rôle ne sont jamais supprimées (révocation datée). | Perte de l'historique des droits | DB | I |
| INV-ADM-05 | Un emplacement `MOBILE` a exactement un détenteur ; un utilisateur a au plus un emplacement `MOBILE` actif. | Responsabilité de stock ambiguë (CM §23) | DB (index unique partiel) | I |
| INV-AUD-01 | Le journal d'audit est en ajout seul ; le chaînage de hachage est vérifiable de bout en bout. | Falsification de l'audit | DB + JOB | I |
| INV-AUD-02 | Aucun secret (mot de passe, PIN, jeton) n'apparaît dans l'audit ni dans les logs. | Fuite de secrets | CODE (liste de champs masqués) + test | U |
| INV-KOM-01 | (système, type externe, identifiant externe) correspond à une seule entité GIC. | Doublons d'intégration | DB (`UNIQUE`) | I |
| INV-KOM-02 | Un webhook (clé de déduplication) n'est traité qu'une fois. | Double création depuis Kommo | DB (`UNIQUE`) | S |
| INV-KOM-03 | GIC ne modifie jamais un champ dont Kommo est propriétaire. | Double responsabilité (CM §59) | CODE (mapping déclaratif) | U |
| INV-NOT-01 | Au plus une alerte ouverte par (type, objet concerné). | Accumulation de notifications (CM §54) | DB (index unique partiel) | I |

## 11. Couverture des exemples du PM §28

| Exemple du PM §28 | Invariants |
|---|---|
| Une vente synchronisée ne doit pas être créée deux fois | INV-SYN-01, INV-VEN-01 |
| Un UUID d'opération doit être idempotent | INV-SYN-01, INV-SYN-02 |
| Une réception ne peut alimenter le stock que pour la quantité acceptée | INV-STK-12, INV-APP-01, INV-APP-03 |
| Une modification tarifaire ne réécrit pas une ancienne vente | INV-VEN-05, INV-PRX-01 |
| Un mouvement de stock doit avoir une cause | INV-STK-02 |
| Une annulation de vente doit corriger le stock | INV-STK-16, INV-VEN-09 |
| Une transaction financière ne doit pas disparaître sans trace | INV-FIN-01, INV-GLO-03 |
| Une quantité allouée offline ne doit pas être consommée deux fois | INV-STK-10, INV-STK-11 |
