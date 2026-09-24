# ADR-005 — Historisation des prix : règles versionnées immuables et snapshot sur les transactions

- **Statut** : ACCEPTÉ (CONFIRMÉ CM §30 ; PM §7, §9)
- **Date** : 24/09/2026

## Contexte
Les prix varient selon de nombreuses dimensions (CM §29). Un prix changé ne doit jamais réécrire une vente passée ; chaque transaction doit conserver le prix appliqué, pourquoi, quand et selon quelle règle (CM §30).

## Décision
1. `pricing.price_rules` : une règle **active est immuable** (seule sa date de fin peut être avancée). Un changement de prix = nouvelle règle qui remplace l'ancienne (`supersedes_rule_id`, `valid_to` de l'ancienne fixé automatiquement).
2. Résolution déterministe : priorité, puis spécificité, puis palier, puis date, puis identifiant ; conflits interdits à l'activation.
3. **Snapshot** sur chaque ligne de vente et de commande : règle, version, prix catalogue, prix appliqué, source, motif de dérogation.
4. Moteur de résolution **partagé** entre appareil et serveur ; règles futures téléchargées à l'avance.

## Alternatives étudiées
- Table « prix courant » modifiable + historique séparé : risque de divergence.
- Recalcul du prix à la lecture : réécrit l'histoire.
- Listes de prix globales versionnées : moins expressives pour les dimensions croisées.

## Justification
Immuabilité + snapshot = reconstruction exacte du passé, sans jointure temporelle fragile ; le moteur partagé assure la cohérence hors ligne.

## Conséquences
Écran de grille avec historique ; simulateur ; anomalie `PRICE_MISMATCH` pour les ventes hors ligne à l'ancien prix (AV-063).

## Risques
RISK-06.
