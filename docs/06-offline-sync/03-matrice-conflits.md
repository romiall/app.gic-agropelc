# Matrice des conflits offline (PM §30)

> Section 20 du format final (PM §48). Principe : la stratégie dépend de la **criticité métier**, jamais un « last write wins » par défaut.
> Échelles :
> - **Probabilité** : 1 = rare (moins d'une fois par mois), 2 = occasionnelle (hebdomadaire), 3 = fréquente (quotidienne).
> - **Gravité** : 1 = cosmétique, 2 = gêne opérationnelle, 3 = erreur de chiffre corrigible, 4 = perte financière ou fraude possible.
>
> Types de résolution : **FUSION** (automatique), **FAIT** (fait appliqué + conflit informatif), **QUARANTAINE** (non appliqué jusqu'à décision), **REJET** (refus définitif), **PRÉVENTION** (le conflit est empêché en amont).

## 1. Conflits exigés par le PM §30

| Entité | Conflit possible | Prob. | Grav. | Détection | Résolution | Responsable |
|---|---|---:|---:|---|---|---|
| Compte client (prospect) | **Modifié sur deux appareils** (commercial et responsable) | 2 | 2 | `base_version` obsolète | **FUSION** champ par champ si les champs diffèrent. Collision sur un même champ : la valeur de `occurred_at` la plus récente est appliquée, l'autre est conservée dans le conflit `VERSION_CONFLICT` (informatif) avec les deux valeurs, pour correction éventuelle. Étape de pipeline : la plus récente (historique complet dans `customer_stage_history`) | Titulaire (notifié) |
| Compte client | **Réaffecté** pendant que l'ancien titulaire est hors ligne | 2 | 2 | Affectation serveur ≠ titulaire local | Serveur autoritaire sur l'affectation. Les opérations de l'ancien titulaire sont **acceptées** : visites et commandes restent attribuées à leur auteur ; une vente directe est attribuée au titulaire à `occurred_at` (BR-VEN-020). `SCOPE_EXIT` envoyé à l'ancien titulaire ; notification au nouveau | RESP_COMMERCIAL |
| Règle tarifaire | **Prix changé** pendant qu'un appareil vend hors ligne à l'ancien prix | 3 | 3 | Prix figé ≠ prix résolu serveur à `occurred_at` | **FAIT** : vente au prix figé (le client a payé ce prix) ; anomalie `PRICE_MISMATCH` (AV-063). **PRÉVENTION** : règles futures téléchargées à l'avance (BR-PRX-011) | RESP_COMMERCIAL |
| Stock | **Vendu hors ligne** au-delà du stock réel (deux vendeurs, même stock) | 2 | 4 | Solde serveur < 0 après application | **PRÉVENTION** : garde exclusive et allocations (ADR-004), blocage local (AV-025). Si la prévention est contournée : **FAIT** + `STOCK_NEGATIVE` critique, résolution par inventaire, transfert manquant ou perte imputée (stratégie stock §5.4) | Responsable du site |
| Transfert | **Transfert concurrent** : deux expéditions du même stock (deux magasiniers hors ligne), ou réception concurrente | 1 | 3 | Solde de la source < 0 ; réception > expédié | **PRÉVENTION** : allocations sur un magasin `SHARED` ; une seule réception par transfert (la seconde → `TRANSFER_OVER_RECEIVED`). Si c'est arrivé : **FAIT** + `STOCK_NEGATIVE` à la source | MAGASINIER, responsable |
| Produit | **Désactivé** pendant qu'un appareil le vend hors ligne | 1 | 2 | `occurred_at` antérieur à la réception de la désactivation par l'appareil (dernier pull) | **FAIT** : vente acceptée + anomalie `PRODUCT_INACTIVE` (AV-083). En ligne : rejet `PRODUCT_NOT_SELLABLE` | ADMIN |
| Utilisateur | **Désactivé** pendant qu'il travaille hors ligne | 1 | 4 | `occurred_at` vs `status_changed_at` | `occurred_at` antérieur à la désactivation : **appliqué**. Postérieur : **QUARANTAINE** (`USER_DEACTIVATED`) ; un responsable décide (accepter si le fait est réel, sinon rejeter et enquêter) | Responsable + ADMIN |
| Commande client | **Modifiée** hors ligne pendant qu'elle est livrée ou annulée côté serveur | 2 | 3 | `base_version` obsolète ; statut incompatible | Livraison ou annulation serveur déjà faite : la modification est **REJETÉE** (`ORDER_NOT_MODIFIABLE`), expliquée au commercial. Deux modifications concurrentes : **QUARANTAINE** `VERSION_CONFLICT` (quantités en collision) résolue par l'auteur ou le responsable | Commercial / RESP_COMMERCIAL |
| Réception | **En double** : deux magasiniers réceptionnent la même livraison | 1 | 4 | Acceptation cumulée > commandé ; même numéro de BL fournisseur | **QUARANTAINE** de la seconde réception (`QUARANTINED`, aucun effet stock) jusqu'à décision (BR-APP-012) | RESP_ACHATS |
| Encaissement | **En double** : même paiement mobile money saisi deux fois (vente et règlement, ou deux appareils) | 2 | 4 | Unicité (moyen, référence) ; heuristique : même client, même montant, moins de 10 min d'écart, référence absente | Doublon de référence : **QUARANTAINE** (`SUSPECT_DUPLICATE`, sans effet de trésorerie). Heuristique sans référence : **FAIT** + alerte `DUPLICATE_SUSPECTED` | FINANCE |

## 2. Autres conflits identifiés

| Entité | Conflit possible | Prob. | Grav. | Détection | Résolution | Responsable |
|---|---|---:|---:|---|---|---|
| Compte client | Même prospect créé par deux commerciaux hors ligne | 2 | 2 | Unicité du téléphone à l'application | **FAIT** (les deux comptes existent) + `DUPLICATE_CUSTOMER` ; fusion par un responsable, avec l'acquéreur le plus ancien retenu (BR-CRM-007) | RESP_COMMERCIAL |
| Commande client | Livrée deux fois hors ligne | 1 | 3 | Livré cumulé > commandé | **FAIT** : l'excédent devient une vente directe + `ORDER_OVER_FULFILMENT` | RESP_COMMERCIAL |
| Allocation | Consommée après révocation forcée | 1 | 3 | Consommation imputée à un quota `REVOKED` | **FAIT** + `ALLOCATION_REVOKED_CONSUMED` ; contrôle du solde | Responsable PDV |
| Allocation | Dépassement du quota (appareil modifié) | 1 | 4 | Consommation > reste | **FAIT** + anomalie de fraude possible (WF-18) | Responsable + DIRECTION |
| Transfert | Réception sans document, jamais rapprochée | 2 | 3 | Transit non rapproché > 48 h | Conflit `TRANSFER_UNMATCHED` ; rapprochement manuel ou création de l'expédition manquante | MAGASINIER |
| Inventaire | Mouvements tardifs antérieurs au comptage | 3 | 3 | `occurred_at ≤ counted_at` après comptabilisation | **FUSION** automatique : ajustement compensatoire (BR-STK-044) | `system` |
| Perte | Déclarée sur un lot clôturé | 1 | 2 | Statut du lot | **FAIT** + `LOT_CLOSED` ; réouverture ou correction par un responsable | RESP_PRODUCTION |
| Collecte d'œufs | Même lot et même date saisis sur deux appareils | 1 | 3 | Unicité (lot, date) | Seconde collecte : **QUARANTAINE** `VERSION_CONFLICT` ; choix de la bonne collecte ou annulation de l'une | RESP_FERME |
| Session de caisse | Vente tardive sur une session validée | 2 | 3 | `occurred_at` dans une session `VALIDATED` | **FAIT** + réévaluation de la session (BR-DIS-008) | FINANCE |
| Session de travail | Deux prises de service de deux appareils | 1 | 1 | Deux sessions ouvertes | **FUSION** : la plus récente clôt la précédente (`superseded`) | `system` |
| Pointage | Accepté localement, refusé par le serveur (géorepère modifié) | 1 | 2 | Divergence de résultat | Dérogation automatique demandée (BR-TER-003) | RESP_COMMERCIAL |
| Vente | Crédit au-delà du plafond, hors ligne | 2 | 3 | Encours serveur + vente > plafond | **FAIT** + validation a posteriori `CREDIT_LIMIT_EXCEEDED` (BR-VEN-025) | FINANCE / RESP_COMMERCIAL |
| Vente | Annulation directe hors délai (horloge) | 1 | 3 | Délai serveur dépassé | Transformée en demande d'annulation (SM-SALE, hors ligne) | Responsable PDV |
| Appareil | Bloqué ou perdu avec des commandes en attente | 1 | 4 | Statut de l'appareil | **QUARANTAINE** des commandes postérieures au blocage (INV-ADM-03) | ADMIN |
| Appareil | Trou de séquence (commandes perdues ou supprimées) | 1 | 4 | `device_seq` manquant > 24 h | Alerte `DEVICE_SEQ_GAP` ; enquête ; inventaire des stocks du détenteur | ADMIN, DIRECTION |
| Horloge | Écart d'horloge > 5 min | 2 | 3 | `clock_skew_ms` | Marquage `clock_suspect` ; aucun recalcul silencieux (ADR-016) | ADMIN (information) |
| Emplacement | Désactivé avec des mouvements hors ligne en attente | 1 | 2 | Statut | **FAIT** + `LOCATION_INACTIVE` | ADMIN |
| Kommo | Même champ modifié dans GIC et dans Kommo | 2 | 2 | Empreintes | GIC prévaut ; `KOMMO_FIELD_CONFLICT` informatif (BR-KOM-003) | Commercial sédentaire |
| Pièce jointe | Upload jamais reçu | 2 | 2 | Délai de 7 jours | `MISSING` + alerte ; validation bloquée si la pièce est requise | Auteur |

## 3. Règles de propriété de la résolution

| Famille | Rôle qui résout | Portée |
|---|---|---|
| CRM (doublons, versions, réaffectation) | RESP_COMMERCIAL | `TEAM` |
| Stock (négatif, transferts, allocations, lots) | Responsable du site (MAGASINIER, responsable PDV, RESP_FERME) ; DIRECTION au-delà | `SITE` |
| Ventes et prix | RESP_COMMERCIAL | `TEAM` / `SITE` |
| Finance (paiements, caisse, crédit) | FINANCE | `ALL` |
| Authenticité (appareil, utilisateur, séquence) | ADMIN + DIRECTION | `ALL` |

Toute résolution est tracée (SM-CONFLICT) et, si elle crée des documents compensatoires (inventaire, transfert, perte), ceux-ci suivent leur propre cycle de vie et leur propre audit.
