# 24 — Refonte graphique, lot L4 (Stock)

> Suivi du lot L4, tenu par la session qui le mène ; il est consolidé dans le suivi principal [`24-refonte-graphique.md`](24-refonte-graphique.md) au lot L10. Règles communes : § 6 bis du suivi principal.

## Périmètre

- `apps/pwa/src/features/stock/` (stock, registre, transferts, réceptions, réception sans document, inventaire, perte, consommation, quotas)
- `apps/pwa/src/features/distribution/ReplenishScreen.tsx` (demande de réapprovisionnement, qui emploie `stock/LinesEditor.tsx`)

## Livré

_À remplir par la session du lot : ce qui change, écran par écran._

## Vérification

_Types, ESLint, essais du domaine, contrôle visuel mobile et bureau (clair et sombre)._

## Questions à trancher

_Une question métier ou de design qui ne peut pas se résoudre seule : `Q-L4-1`, `Q-L4-2`… (jamais d'AV ni d'ADR : la session principale les numérote et les enregistre au lot L10)._

## Notes
