# ADR-027 — Valorisation des lots biologiques : coût restant, productions au coût standard, lots de stock propres

- **Statut** : ACCEPTÉ (décisions du porteur du projet du 28/09/2026 : AV-097, AV-098, AV-099, AV-100, AV-111 ; complète ADR-015 et ADR-026)
- **Date** : 28/09/2026

## Contexte

ADR-015 valorise les animaux d'un lot au **coût par tête** = coût cumulé du lot ÷ effectif non vendu (BR-PRD-012). L'analyse de P7 a montré que cette formule réimpute aux têtes restantes le coût des têtes déjà vendues : sur l'exemple de la stratégie finance (lot de 2 400 poulets, coût 5 600 000 XAF), le coût des ventes atteindrait environ 8 000 000 XAF (+43 %). Trois autres points restaient sans règle : la valeur des productions des lots reproducteurs (œufs, porcelets), les lots qui réuniraient plusieurs produits (truies et porcelets, poules et coqs), et le lot de stock des œufs et des produits d'abattage.

## Décision

1. **Coût restant** (AV-097) : coût par tête d'un lot à un instant = coût restant ÷ effectif non vendu, où
   - coût restant = Σ écritures de coût du lot (débits − crédits) − Σ valeurs figées des sorties définitives du lot (ventes, abattage, sevrage ou transfert vers un autre lot) ;
   - la mortalité et les écarts d'inventaire **ne réduisent pas** le coût restant : ils le répartissent sur moins de têtes (BR-PRD-013, CM §16) ;
   - la dernière sortie (quantité = effectif) emporte exactement le coût restant (absorption des arrondis) ;
   - la somme des coûts figés des sorties égale le coût du lot.
2. **Productions au coût standard** (AV-098) : un œuf collecté (par calibre) ou un porcelet né entre en stock au **coût standard en vigueur** de son produit ; le lot producteur reçoit une écriture de **crédit** du même montant (production transférée). L'écart entre le coût réel et le standard reste dans le résultat du lot producteur.
3. **Un lot par produit** (AV-099) : un lot garde un seul produit biologique ; les lots d'une même bande (truies, verrats, porcelets ; poules, coqs) sont **liés**. Naissage (AV-111) : lot truies, lot verrats, lot porcelets lié aux truies ; au sevrage, les porcelets passent vers un lot d'engraissement avec leur coût (coût restant du lot porcelets).
4. **Lots de stock propres** (AV-100) : chaque collecte crée un lot de stock d'origine `COLLECTION`, chaque abattage un lot d'origine transformation, avec date de péremption ; ils sont rattachés au lot de production par leur origine. La clôture d'un lot d'animaux n'affecte pas ces lots.
5. **Responsabilité technique** (DÉDUIT) : la valorisation reste dans `inventory` (ADR-015). `inventory` lit le coût restant d'un lot dans son propre registre de coûts et dans ses mouvements (sans dépendre de `production`) ; `production` transmet le coût déclaré des entrées de production (mise en place, éclosion, abattage) et les écritures de coût passent par l'API publique d'`inventory`.

## Alternatives

Moyenne figée (coût cumulé ÷ têtes entrées moins mortes) ; formule écrite telle quelle (coût des ventes supérieur au coût du lot). Coût réel mensuel des productions ; porcelets porteurs des coûts d'exploitation. Produit principal et produits autorisés dans un même lot ; produit mixte. Lot de stock partagé entre animaux et dérivés (clôture bloquée tant qu'il reste des œufs ou des découpes).

## Justification

Choix du porteur du projet (28/09/2026), recommandations de l'analyse de P7 retenues sauf pour les lots à plusieurs produits (un lot par produit, préféré au produit principal avec produits autorisés).

## Conséquences

- BR-PRD-012, la stratégie de stock §9 et la stratégie finance §6 sont à corriger (coût restant) ; l'exemple chiffré d'AT-026 est à refaire avec les frais généraux (ADR-026).
- `inventory` : valorisation des sorties d'un lot biologique au coût par tête ; coût déclaré accepté pour les entrées `PRODUCTION_OUTPUT` ; écritures de coût de production transférée (`CREDIT`).
- Coût standard requis pour chaque produit produit en interne (œufs par calibre, porcelet, poussin) ; à défaut, entrée à 0 XAF signalée, jamais de rejet d'un fait physique.

## Risques

RISK-24 : erreurs de coût par tête. Mitigation : invariant de conservation (Σ coûts des sorties + coût restant = coût du lot) vérifié par test sur toute la base.
