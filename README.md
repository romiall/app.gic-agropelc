# app.gic-agropelc

Application de gestion de la ferme GIC-AGROPELC : une application métier intégrée, utilisable sur téléphone même sans réseau, qui relie approvisionnement, production (volailles, œufs, incubation, porcs), stocks, points de vente, prospection commerciale, ventes, encaissements et pilotage de la Direction.

## État du projet

| Étape | État |
|---|---|
| Cadrage fonctionnel et technique | **Terminé** — référentiel complet dans [`docs/`](docs/README.md) |
| Décisions de démarrage (stack, hébergement, valeurs par défaut) | En attente de la Direction — voir la [checklist de démarrage](docs/10-development-plan/04-checklist-demarrage.md) |
| Développement | Non démarré — commence par la phase P0 ([passage au développement](docs/10-development-plan/06-passage-au-developpement.md)) |

## Par où commencer

- **Direction** : [Executive Summary](docs/00-reference/03-executive-summary.md), puis [questions ouvertes](docs/A-VALIDER.md).
- **Équipe technique** : [`CLAUDE.md`](CLAUDE.md), puis l'[index maître de la documentation](docs/README.md).

## Documents sources

- [Contexte métier de référence](<Contexte métier de référence — Projet GIC AGROPELC.md>) — source de vérité métier.
- [Prompt maître](<Prompt maître — Cadrage technique et architecture GIC AGROPELC.md>) — cadrage technique et architecture.

## Contrôle de la documentation

```bash
python3 docs/_tools/check_refs.py          # identifiants et liens
python3 docs/_tools/check_refs.py --index  # régénère l'index des règles métier
```
