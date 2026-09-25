# ADR-015 — Valorisation des stocks et coûts de production

- **Statut** : ACCEPTÉ provisoirement ; **À VALIDER** (AV-042, AV-043)
- **Date** : 24/09/2026

## Contexte
La valeur des pertes, le coût des ventes et la marge par lot sont requis (CM §32, §33). La mortalité répartit le coût du lot sur moins de têtes (CM §16).

## Décision
- **Coût figé sur chaque mouvement**, déterminé par le serveur au moment de l'application.
- Achats et intrants : **CMUP perpétuel** par produit, recalculé à chaque entrée valorisée, dans l'ordre d'application serveur.
- Animaux d'un lot : **coût par tête** = coût cumulé du lot ÷ effectif non vendu ; coût cumulé = registre de coûts (animaux d'origine, intrants consommés, dépenses directes).
- Productions internes sans lot valorisé (œufs) : **coût standard** historisé ; poussins d'éclosion : coût du lot d'incubation ÷ poussins viables.
- Mortalité : valeur économique indicative, sans réduction du coût du lot.
- Registre de coûts et valorisation dans le module `inventory`, pour éviter le cycle avec `finance` (ADR-011).

## Alternatives
FIFO valorisé (lourd, peu utile pour des produits frais) ; coût standard partout (écarts non expliqués) ; revalorisation rétroactive selon `occurred_at` (réécrit le passé).

## Conséquences
Deux indicateurs de marge distincts et libellés : marge brute des ventes (au fil de l'eau) et marge de lot (à la clôture).

## Risques
RISK-24.
