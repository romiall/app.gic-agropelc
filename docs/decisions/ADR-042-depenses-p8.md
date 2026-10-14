# ADR-042 — Dépenses : cycle, paiement immédiat, caisse de PDV, hors ligne et coût des objets

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; applique BR-FIN-020 à 022, BR-DIS-013, SM-EXPENSE, BR-SYN-007 ; les choix métier sont AV-263 à AV-270, à confirmer par le porteur)
- **Date** : 13/10/2026
- **Précise** : [ADR-032](ADR-032-sessions-de-caisse-et-remises-de-fonds.md) (attendu de caisse, §7 retenue sur la personne), [ADR-038](ADR-038-ordre-de-verrouillage-global.md) (rangs des documents de P8 : [ADR-043](ADR-043-factures-et-paiements-fournisseurs-p8.md) §9), [ADR-026](ADR-026-cout-de-lot-frais-generaux-coproduits.md) (frais généraux « reliés aux dépenses en P8 »), [ADR-031](ADR-031-cle-de-synchronisation-des-referentiels-a-code.md) (écarté pour les catégories, §9)
- **Questions liées** : AV-058, AV-263 à AV-270

## Contexte

P8 crée les dépenses (`finance.expenses`, SM-EXPENSE). Le registre de trésorerie accepte déjà le type `EXPENSE` (sortie), le registre de coûts accepte déjà la source `EXPENSE` et le type `DEPENSE_DIRECTE`, et l'attendu d'une session de caisse compte toute sortie ordinaire (ADR-032 §3). Restent à fixer : les seuils, la caisse de PDV (session, catégories, plafond), le hors ligne (BR-SYN-007), l'écriture de coût et son annulation, la reclassification d'une dépense rejetée après paiement.

## Décision

1. **Commandes** (permission entre parenthèses) :
   - `finance.expense.record` (`finance.expense.record`, hors ligne admis) ;
   - `finance.expense.pay` (`finance.expense.pay`, en ligne) ;
   - `finance.expense.cancel` (en ligne ; l'auteur avec `finance.expense.record`, ou un détenteur de `finance.expense.approve`) ;
   - décisions `EXPENSE` par `approvals.request.approve` / `reject`, avec un gestionnaire de décision dans `finance`.
2. **Seuils = paramètres** (AV-058, défaut du registre). Comparaisons strictes, comme `orderRequiresApproval`.
   - `finance.expense_approval_threshold_xaf` = 50 000 : au-delà, la dépense attend une validation.
   - `finance.expense_photo_threshold_xaf` = 10 000 : au-delà, un justificatif (`attachment_ids` de l'enveloppe) est exigé.
   - Les deux sont visibles de l'appareil (jeu `me`), qui les applique hors ligne.
   - La politique `EXPENSE_DEFAULT` dit seulement qui approuve (`finance.expense.approve`).
   - Sans politique active : pas de validation, comme pour les pertes (AV-264).
   - La limite d'un rôle (`role_permissions.limits.maxAmountXaf`, RC-06) est vérifiée par le gestionnaire de décision : mécanisme prêt, aucune valeur semée (AV-263). Elle se lit sur `finance.expense.approve` : une politique `EXPENSE` doit donc nommer cet approbateur (revue de P8-14 : une autre permission ferait refuser toute approbation, `APPROVAL_LIMIT_EXCEEDED`).
3. **Statuts** (SM-EXPENSE) :
   - à payer : `RECORDED` (sous le seuil) ou `PENDING_APPROVAL` ;
   - payée immédiatement : `PAID` ou `PAID_PENDING_APPROVAL` ;
   - décision : `APPROVED`, `REJECTED`, `PAID` (approbation a posteriori), `PAID_REJECTED` ;
   - `finance.expense.pay` : `RECORDED` ou `APPROVED` vers `PAID` ;
   - `finance.expense.cancel` : non payée seulement, vers `CANCELLED`.
4. **Paiement**. Toute sortie passe par `recordCashMovement` (`EXPENSE`, `OUT`, source `EXPENSE`).
   - Compte : celui que l'auteur peut mouvementer, selon la règle des remises (`canActOnCashAccount`).
   - En ligne, une caisse `CAISSE_*` ne devient jamais négative (`CASH_INSUFFICIENT`).
   - Hors ligne, la sortie est appliquée avec `CASH_NEGATIVE` (BR-FIN-012).
5. **Caisse de PDV** (BR-DIS-013, AV-266, AV-267). Une dépense payée depuis une `CAISSE_PDV` :
   - exige une catégorie `allowed_on_pos` et un montant ≤ `finance.pos_expense_max_xaf` (50 000 par défaut) ;
   - exige une session ouverte qui couvre son `occurred_at`, comme un encaissement en espèces (P5-14) : `CASH_SESSION_REQUIRED` en ligne, contrôle relu sous le verrou du compte (ADR-038 §4) ;
   - hors ligne : appliquée avec le conflit `CASH_SESSION_MISSING` (entité `EXPENSE`, propriétaire FINANCE). L'ouverture de session résout ce conflit comme pour un encaissement.
   - Son mouvement diminue l'attendu de la session sans changement de formule (ADR-032). Une dépense tardive dans une session close réévalue la session par le delta (INV-FIN-11).
6. **Hors ligne : validation a posteriori plutôt que rejet** (BR-SYN-007, AV-265). Une dépense saisie hors ligne n'est jamais rejetée pour une raison d'état métier. Si elle enfreint une règle que seul le serveur peut juger, elle est appliquée et placée en validation : `PAID_PENDING_APPROVAL` si payée, `PENDING_APPROVAL` sinon, même sous le seuil. Ces règles sont :
   - catégorie désactivée ou non autorisée au PDV ;
   - plafond du PDV dépassé ;
   - justificatif manquant ;
   - objet de coût clos.

   Un objet de coût introuvable n'est pas un motif de revue : il est refusé, même hors ligne (§8). Précision de la revue de P8-14, qui aligne ce paragraphe sur le §8, AV-265 et le dictionnaire : un appareil ne cite que des objets qu'il a tirés, et une création hors ligne sur le même appareil précède la dépense dans sa file (`depends_on`).

   Le motif est gardé dans `review_reasons`, avec l'avertissement `EXPENSE_REVIEW_REQUIRED`. Sans politique `EXPENSE` active, aucune demande n'est ouverte (AV-264) : la dépense reste appliquée avec ses motifs et l'avertissement, et son coût est écrit. La politique semée `EXPENSE_DEFAULT` est toujours active, sauf si la Direction l'a retirée. Précision de la revue de P8-14 : la phrase d'origine annonçait un repli sur `EXPENSE_DEFAULT` même retirée, ce que le code ne fait pas. En ligne, les mêmes règles refusent la commande.
7. **Rejet après paiement** (BR-FIN-022, AV-268). Le décaissement reste. La dépense passe `PAID_REJECTED`, est reclassée dans la catégorie système `NON_JUSTIFIEE` (`reclassified_category_id`) et imputée à son déclarant (`responsibility_user_id`), comme une perte non justifiée (AV-038). Aucune écriture de coût. Le recouvrement auprès de la personne se fait hors de l'application au MVP.
8. **Coût des objets** (BR-FIN-022, AV-269, AV-270). L'écriture de coût passe par `recordCostEntry` d'`inventory` (source `EXPENSE`, `source_id` = id de la dépense). Elle est écrite dès l'enregistrement sans validation, ou à l'approbation ; jamais pour une dépense rejetée. Le type de coût suit l'objet :
   - `PRODUCTION_LOT` ou `INCUBATION_BATCH` : le `default_cost_type` de la catégorie, parmi `VETERINAIRE`, `ALIMENT`, `AUTRE_INTRANT`, `DEPENSE_DIRECTE`, sinon `DEPENSE_DIRECTE` ;
   - `SITE` avec une espèce : `FRAIS_GENERAUX` de cette espèce, qui alimente la masse répartie par `production.overhead.allocate` (ADR-026) ;
   - `SITE` sans espèce : `DEPENSE_DIRECTE` du site (PDV compris), hors répartition.

   L'existence et le statut d'un lot se lisent par une nouvelle lecture publique d'`inventory` (`lotCostObjectStatus`), qui s'appuie sur le lot de stock d'origine : `finance` n'importe pas `production`. Un site est contrôlé par `finance` : il existe, c'est le site de la dépense, dont la portée vient d'être vérifiée (`COST_OBJECT_INVALID` sinon), et avec une espèce c'est une ferme (`SITE_NOT_FARM`, comme `inventory.overhead.record`). Précision de la revue de P8-14 : un vendeur ne peut plus imputer des frais généraux à une autre ferme. Un objet inconnu est refusé, même hors ligne (validité, BR-SYN-007). Annuler une dépense contrepasse son écriture (`reverseCostEntries`). C'est refusé si le mois de frais généraux de l'espèce est déjà réparti (`OVERHEAD_ALREADY_ALLOCATED`, même garde qu'`inventory.overhead.cancel`).
9. **Catégories** (AV-058, AV-270) :
   - `finance.expense_categories` a un identifiant UUIDv7, semé une fois, comme les motifs (`REASON_CODE`). Ce n'est pas une clé dérivée du code (ADR-031) : l'enveloppe d'une commande exige un UUIDv7 comme `aggregate_id`, et une catégorie semée doit pouvoir être modifiée ou désactivée par commande. La clé naturelle reste le code (unique) ;
   - elle est publiée dans le jeu `catalog` (`EXPENSE_CATEGORY`) et rattrapée par le seed (`publish-references`) ;
   - commandes `finance.expense_category.create`, `.update`, `.deactivate` (nouvelle permission `finance.expense_category.manage`, FINANCE et ADMIN) ;
   - `NON_JUSTIFIEE` est une catégorie système (`is_system`), refusée à la saisie.
10. **Numérotation et site**. `DEP-{site}-{AAAA}-{seq6}`, avec pour site celui de la saisie (`siteId` de la charge utile), comme le dit le dictionnaire. Précision de la revue de P8-14 : le texte d'origine disait « celui du compte payeur, sinon celui de la saisie », ce que le code ne fait pas. Le site porte la portée (`finance.expense.read`, `SITE`) ; la propriété `OWN` est celle de l'auteur.
11. **Jeux hors ligne**. Les dépenses de l'auteur des 30 derniers jours vont dans le jeu `cash` (`EXPENSE`, portée `USER`). Les catégories vont dans `catalog`. Les seuils vont dans `me`.

    Précision de la revue de P8-14 : la fenêtre comprend aussi les dépenses modifiées dans les 30 derniers jours et celles qui attendent une décision. Sinon, la décision sur une dépense plus ancienne n'arriverait jamais sur l'appareil de son auteur.

## Conséquences

- La caisse de PDV traite une dépense comme un encaissement : même garde de session, même conflit hors ligne, même résolution à l'ouverture. Le code de résolution de P5 s'étend au type `EXPENSE`, sans changer de règle.
- Aucun fait accompli hors ligne n'est perdu. Les écarts vont à la Finance, en validation avec motif, au lieu d'un conflit de plus.
- Une dépense imputée à un lot entre automatiquement dans le coût restant et le coût par tête (ADR-027). Les sorties déjà faites gardent leur valeur figée (ADR-026, RISK-24).
- Tests : `finance-expense-commands.test.ts`, `finance-expense-decisions.test.ts`, invariants dans `p8-invariants.test.ts`.

## Alternatives

- **Rejeter hors ligne les dépenses non conformes** : contraire à BR-SYN-007, puisque l'argent est déjà sorti. Écartée.
- **Conflit dédié au lieu de la validation a posteriori** : il faudrait un second circuit de décision pour le même objet. Écartée : SM-EXPENSE prévoit déjà `PAID_PENDING_APPROVAL`.
- **Écrire le coût du lot dans `production`** : `finance` n'importe pas `production`, et le registre de coûts appartient à `inventory` (BR-FIN-041). Écartée.
- **Catégories à identifiant dérivé du code** (ADR-031, UUID version 5) : identique d'une base à l'autre, mais refusé comme `aggregate_id` par l'enveloppe des commandes (UUIDv7 exigé). Une catégorie semée ne pourrait alors plus être administrée. Écartée : l'identifiant semé diffère d'une base à l'autre, sans conséquence, puisque l'appareil le reçoit par le jeu `catalog`.
