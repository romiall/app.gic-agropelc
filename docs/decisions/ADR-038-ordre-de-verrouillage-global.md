# ADR-038 — Ordre de verrouillage global des transactions de commande

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; P5-22)
- **Date** : 12/10/2026

## Contexte

Chaque commande s'exécute dans sa propre transaction (ADR-011), en lecture répétable par défaut et en lecture confirmée pour les sessions de caisse (ADR-034). Les règles d'ordre étaient écrites module par module :
- soldes, puis quotas (ADR-033 §5, D04 §15) ;
- commande, ventes, encaissements, compte, session, compteur (ADR-032 §10, D09) ;
- site, caisse, sessions (D05 §15) ;
- ligne-verrou de la paire de transfert d'abord (D06 §15).

Aucun ordre global ne les reliait. La cartographie de P5-22 (lecture du code, sémantique d'InnoDB) a trouvé des cycles entre opérations ordinaires. Un interblocage n'abîme rien : MySQL en choisit une victime, que l'étape 7 du pipeline rend `RETRY_LATER`. Mais il coûte un renvoi, suspend la file de l'auteur (AV-210) et, s'il se répète, la fait signaler bloquée (AV-217).

Cycles relevés :
- **1a** : une vente de [P1, P2] tient les quotas de P1 (verrou d'intervalle de l'index des quotas) avant les soldes de P2 ; un octroi sur P2 tient ces soldes, puis attend l'intervalle.
- **1b** : une révocation ou une libération verrouille le quota sans les soldes, puis met à jour son statut (indexé), alors qu'une vente du couple tient l'entrée d'index et attend le quota.
- **1c** : le consommateur de révocation verrouillait aussi l'emplacement, l'utilisateur et l'appareil joints.
- **5a** : un retour verrouille `V_CUSTOMER`, puis l'emplacement, quand la vente fait l'inverse.
- **5b** : le verrou par plage des lignes de la vente annulée (la plus récente) bloque l'insertion des lignes de toute vente nouvelle.
- **5c** : les remboursements prennent les comptes dans l'ordre des encaissements, et non dans celui des comptes.
- **5d** : l'annulation prend le client après la vente, quand la vente nouvelle du même client fait l'inverse.
- **5f** : deux premières sorties concurrentes d'un lot neuf vers `V_CUSTOMER` (ligne absente : verrous de plage, puis insertions).
- **AV-185** : la condition de l'annulation directe (« session de caisse encore ouverte ») était lue sans verrou ; une clôture validée entre-temps laissait passer un remboursement hors session.
- **Remises de fonds** (révélé par les tests de concurrence de P5-22, alors que la lecture du code le jugeait impossible) : l'annulation d'une remise prend la remise, puis son compte ; l'envoi d'une autre remise depuis la même caisse prend les comptes, puis insère sa remise en fin d'index, là où l'annulation de la plus récente tenait un verrou.
- **Annulation d'une commande contre annulation de sa vente** : une fois le client pris avant la vente annulée, l'annulation de la commande (commande, puis client de la conversion annulée) formait un nouveau cycle avec elle (test existant de P4-06).

## Décision

1. **Ordre global.** Une transaction de commande prend ses verrous dans cet ordre de rangs ; une ressource d'un rang inférieur n'est jamais demandée après une ressource d'un rang supérieur :

| Rang | Ressource | Règle |
|---|---|---|
| N0 | ligne d'inbox de la commande | toujours la première (pipeline, étape 6) |
| N1 | site | partagé, par les commandes de caisse ; ailleurs, implicitement par clé étrangère |
| N2 | documents racines | ligne-verrou de la paire de transfert, transfert, document d'annulation |
| N2b | masse mensuelle des frais généraux (site, espèce, mois) | sous-ressource des documents racines (A7, P9) : prise par toute transaction qui écrit ou garde cette masse (`lockOverheadPool`, `inventory`), après son document (saisie, dépense) et avant tout autre rang ; plusieurs masses en une passe triée (`lockOverheadPools`) |
| N3 | comptes clients | identifiants croissants ; **avant** les commandes et les ventes du client |
| N4 | commandes, puis ventes existantes | identifiants croissants ; lignes **par clé primaire** (identifiants lus sous le verrou du document) |
| N5 | soldes physiques | tous les couples (emplacement, produit) de l'opération, triés par produit, **avant la première lecture de quota** (`lockStockCouples`) |
| N6 | quotas | sous-ressource : seulement par une transaction qui tient déjà les soldes de leur couple |
| N7 | soldes virtuels | après les soldes physiques, y compris pour une entrée depuis un emplacement virtuel (retour, réception de transit) |
| N8 | affectations, puis encaissements | par clé primaire, identifiants croissants |
| N9 | comptes de trésorerie | tous ceux de l'opération, en une passe triée, avant le premier mouvement (`lockCashAccounts`) |
| N10 | remises de fonds ; sessions de caisse, puis ajustements | sous-ressources : seulement sous le verrou de leurs comptes (une remise : ses deux comptes, ordre croissant, comme l'envoi) |
| N11 | demandes de validation, conflits, événements | insertions |
| N12 | compteur de numéros | juste avant l'insertion du document ; exceptions documentées `ANV`, `TRF`, `VTE` (chaque compteur n'est disputé que par des opérations qui le prennent au même rang : aucun cycle) |
| N13 | demande de validation décidée | mise à jour en fin de décision |
| N14 | tête de chaîne d'audit | toujours la dernière |

2. **Verrous restreints.** Un `FOR UPDATE` sur une jointure ne verrouille que la table visée (`forUpdate('table')`) : la ligne de lot (partagée par tous les emplacements), l'emplacement, l'utilisateur et l'appareil joints ne sont pas verrouillés.
3. **Ligne absente.** Une ligne qui peut ne pas exister encore (solde, compteur) est d'abord garantie par un upsert sans effet, qui prend son verrou d'écriture, jamais par un `SELECT … FOR UPDATE` sur une clé absente (verrou de plage).
4. **Condition relue sous verrou.** Une condition qui décide du chemin d'une commande sans verrouiller sa ressource, pour ne pas inverser l'ordre ci-dessus, est relue sous ce verrou quand la commande l'atteint. Si elle a basculé, la transaction est annulée par une erreur transitoire et le renvoi identique prend l'autre chemin. Application : annulation directe et session de caisse (AV-185, AV-221).

## Changements (P5-22)

- **`inventory`** :
  - `lockStockCouples` (public) ;
  - soldes avant quota dans `revoke` et `release` ;
  - contrôle de doublon de l'octroi sous verrou ;
  - soldes physiques avant virtuels dans `recordStockMove` ;
  - upsert sans effet dans l'écriture d'un solde ;
  - `forUpdate('…')` dans la sélection FIFO, les lots d'un couple et le consommateur de révocation.
- **`sales`** :
  - passe des soldes dans la vente directe, la confirmation de commande et l'annulation ;
  - lignes et affectations d'une vente annulée verrouillées par clé primaire ;
  - client(s) avant la vente annulée (annulation directe et décision) ;
  - comptes de remboursement triés ;
  - condition d'AV-185 relue sous le verrou des caisses (`CashSessionClosedDuringCancellation`).
- **`sales`, commandes** : toute commande portant sur une commande (`loadOrderForCommand` : annulation, clôture du reste, modification, livraison) verrouille le client de la commande, et le compte conservé s'il a été fusionné, avant la commande.
- **`finance`** : `lockCashAccounts` exposée par l'API publique ; une remise (réception, annulation, décision d'écart) verrouille ses deux comptes avant sa ligne (`lockTransfer`).
- **Tests** (`p5-lock-order.test.ts`) :
  - deux scénarios déterministes (1a, AV-185) ;
  - tours concurrents pour les autres paires (révocation contre vente, premières ventes d'un produit neuf depuis deux PDV, clôture contre encaissement, envoi contre annulation de remise) ;
  - par mutation : sans la passe des soldes, l'octroi du scénario 1a est renvoyé (interblocage) ; sans la relecture d'AV-185, l'annulation rembourse hors session ; sans le verrou des comptes avant la remise, l'annulation de remise est renvoyée.

## Révision (P5-23, revue adverse)

- **Lecture simple sous instantané** : lire des identifiants sans verrou, puis les verrouiller par clé primaire (cycle 5b) ne voit pas une ligne validée entre l'instantané de la transaction (première lecture simple, en lecture répétable) et le verrou du document. Pour les lignes d'une vente, l'ensemble ne change jamais ; pour ses **affectations**, si (encaissement concurrent). Le payé de la vente, relu sous son verrou, est comparé à la somme des affectations actives de l'instantané, puis à celle des affectations relues sous verrou : s'ils diffèrent, l'annulation est renvoyée (§4, `SaleAllocationsChangedDuringCancellation`). La revue l'a trouvé par lecture : l'encaissement restait affecté à une vente annulée, sans signal. Test déterministe dans `p5-lock-order.test.ts`.
- **§2 appliqué à la lecture d'un conflit** : `findConflict` verrouillait aussi la ligne d'inbox jointe de la commande d'origine ; seul le conflit l'est désormais.
- **N5 étendu aux opérations de stock** (revue adverse) : la passe des soldes n'était faite que par `sales`. L'expédition, la réception (avec et sans document), le mouvement interne, la contre-passation, l'inventaire et la décision d'écart de transfert prennent désormais les soldes de tous leurs couples **physiques**, triés par emplacement puis par produit (`lockPhysicalStockCouples`) ; une réception [P2, P1] et une vente [P1, P2] au même PDV s'interbloquaient.
- **§3 précisé** : la passe des soldes (`lockStockCouples`) et le pré-verrou de la destination lisent un couple (emplacement, produit) par le préfixe de la clé primaire, sans connaître le lot. Sur un couple qui n'a encore aucune ligne, cette lecture pose un verrou d'intervalle ; deux premières entrées concurrentes de produits nouveaux au même emplacement peuvent alors s'interbloquer. Garantir une ligne sans lot pour chaque couple créerait des soldes vides parasites pour les produits suivis par lot : **résidu assumé** (rare, `RETRY_LATER` sans perte).

## Révision (P9, correctif A7 de la revue de P8)

**Défaut.** La revue de P8 a relevé que l'annulation d'une dépense de frais généraux et `production.overhead.allocate` ne partageaient aucun verrou. Le trou existait déjà entre `inventory.overhead.cancel` (P7) et la répartition, et touchait aussi la clôture d'un lot (part estimée). La répartition lisait la masse du mois par une lecture simple, sous l'instantané de sa transaction. Les annulations lisaient « le mois est-il déjà réparti ? » de la même façon. Deux transactions concurrentes passaient donc chacune : les lots portaient la part d'un frais annulé, et la masse du site devenait négative.

**Décision.**
- **Verrou de la masse (rang N2b).** Table `inventory_overhead_pool_locks`, une ligne par (site, espèce, mois métier), propriété d'`inventory` (propriétaire du registre de coûts). Elle est garantie par un upsert sans effet (§3), tenue jusqu'à la fin de la transaction. La répartition, la clôture d'un lot (une masse par mois de sa vie, ordre croissant), l'annulation d'une saisie (une masse par espèce de la saisie, ordre croissant) et l'annulation d'une dépense de frais généraux la prennent **avant** de lire la masse ou la garde.
- **Écritures de la masse.** `recordCostEntry` prend le même verrou pour toute écriture `SITE` `FRAIS_GENERAUX`. Une saisie ou une approbation de dépense attend donc la répartition en cours et ne s'intercale pas dans une lecture verrouillante de la masse. Les lignes d'une saisie sont écrites par espèce croissante, comme l'annulation les verrouille.
- **Lectures courantes.** Sous le verrou, la masse (`costObjectBalance`, option `current`) et la garde « mois déjà réparti » (`siteOverheadMonthAllocated`, `monthAllocated`) se lisent par `FOR SHARE`. Elles rendent les écritures validées jusqu'ici, et non l'instantané de la transaction, qui a pu naître avant l'attente du verrou (même mécanisme que la révision de P5-23). Une seule instruction par lecture, sans verrou d'écriture : la table est en ajout seul, `gic_app` n'a pas `UPDATE`.
- **Pas de clé étrangère** de la table de verrou vers le site : une charge utile qui cite un site inconnu est rejetée proprement (`SITE_NOT_FARM`), pas par une erreur de base prise pour transitoire.

**Alternatives écartées.**
- **Lecture confirmée par commande** (ADR-034) : la clôture de lot calcule un résumé de plusieurs lectures qui doit rester cohérent ; la lecture répétable le garantit, la lecture confirmée non. Une seule méthode pour les quatre commandes, sans changer l'isolation d'aucune.
- **Verrou sur le site** (N1) : il bloquerait toutes les ventes de la ferme pendant la répartition.
- **Verrou nommé MySQL** : il se libère avant la validation de la transaction, donc l'autre commande lirait une masse non encore validée.

**Cycles vérifiés.** Un détenteur de la masse n'attend aucune ressource que les autres commandes concernées tiennent : la répartition n'attend que la masse et des lignes en ajout seul ; l'annulation tient sa saisie ou sa dépense, jamais la masse d'un autre document. Les masses se prennent par espèce puis par mois, dans un ordre unique.

**Tests** : `production-overhead-allocation.test.ts` (annulation pendant la répartition, répartition qui attendait, chaque commande attend le verrou, mois de Douala à la frontière UTC), `finance-expense-commands.test.ts` (saisie, annulation, garde relue à jour). Chaque verrou et chaque lecture courante sont vérifiés par mutation sur la base jetable.

## Résidus assumés

Un interblocage résiduel reste détecté par MySQL et rendu `RETRY_LATER`, sans perte, signalé au-delà de `sync.retry_hold_minutes` (AV-217).
- **Fermeture de site ou désactivation d'emplacement** contre une écriture : le site est pris en exclusif, puis les soldes ; les écritures le touchent par clé étrangère. Opération rare.
- **Reconstructions de maintenance** (`rebuildStockBalances`) : elles verrouillent dans l'ordre de la clé primaire, et non dans celui de N5 à N7. Elles sont lancées à la main, après analyse.
- **Verrous implicites** des clés étrangères et des déclencheurs : partagés, sur des lignes de référence (emplacements, utilisateurs, appareils, sites). Ils ne forment de cycle qu'avec une transaction qui verrouille ces lignes en exclusif, cas que le §2 retire du consommateur de révocation.
- **Configuration d'un PDV** (P5-23, AV-230) : `organization.pos.configure` prend l'emplacement de vente en exclusif **avant toute lecture** de sa transaction ; sa garde de quotas (`inventory`) lit alors sans verrou, dans une vue qui suit tout octroi validé avant elle. Une vente qui tient soldes et quotas puis touche l'emplacement par clé étrangère attend la configuration, qui n'attend rien d'elle : pas de cycle. L'octroi relit le mode de garde sous verrou partagé après le verrou du couple (N5) : il attend une configuration en cours, puis la voit.
- **Transitions d'un appareil** (P5-23, AV-212) : `identity.device.*` lit l'appareil `FOR UPDATE` — rang propre à `identity`, juste après N0 ; ces commandes ne prennent aucun autre rang, d'où aucun cycle. Le contrôle d'appareil du pipeline reste une lecture simple hors transaction : un fait daté après un blocage, reçu pendant les quelques millisecondes où la commande de blocage n'est pas encore validée, passe (la date est déclarée par l'appareil, ADR-016 : cette fenêtre n'ajoute rien au pouvoir d'un appareil volé).
- **Lecture confirmée pour l'annulation** : écartée. Le verrou des lignes par clé primaire suffit au cycle 5b et ne demande pas de réviser ADR-034.

## Alternatives

- **Comptes de trésorerie avant les soldes**, pour toutes les opérations : cette option règle AV-185 sans relecture, mais elle allonge la tenue de la caisse du PDV pendant tout le traitement du stock et contredit ADR-032 §10. Écartée.
- **Verrou consultatif par auteur ou par appareil** (verrou nommé MySQL, connexion dédiée) : il sérialise trop et ne couvre pas les opérations de plusieurs auteurs. Écarté.

## Justification

L'ordre suit le plan (« soldes, quotas, compte, session, numéros ») et les décisions existantes (ADR-032 §10, ADR-033 §5, ADR-034), qu'il relie. Les règles de sous-ressource (N6, N10) rendent indifférent l'entrelacement des quotas, des remises et des sessions entre opérations. La lecture du code n'a pas suffi : un cycle jugé impossible (envoi contre annulation de remise) est apparu en concurrence réelle ; chaque paire de cet ADR a donc son test.

## Conséquences

- Toute nouvelle commande qui touche plusieurs de ces ressources respecte l'ordre ; une revue de code le vérifie.
- Un verrou de plus par entrée depuis un emplacement virtuel (soldes de la destination) et par opération multi-produits (passe des soldes) : coût négligeable devant les écritures.
- D04 §15, D05 §15, D06 §15 et D09 §15 renvoient à cet ADR.
