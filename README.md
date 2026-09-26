# app.gic-agropelc

Application de gestion de la ferme GIC-AGROPELC : une application métier intégrée, utilisable sur téléphone même sans réseau, qui relie approvisionnement, production (volailles, œufs, incubation, porcs), stocks, points de vente, prospection commerciale, ventes, encaissements et pilotage de la Direction.

## État du projet

| Étape | État |
|---|---|
| Cadrage fonctionnel et technique | **Terminé** — référentiel complet dans [`docs/`](docs/README.md) |
| Décisions de démarrage | Hébergement et stack **tranchés** (Hostinger sans VPS ; MySQL) — voir [`docs/A-VALIDER.md`](docs/A-VALIDER.md) §3 |
| Développement | **Phase P0 : code terminé** (P0-01 à P0-16) ; `staging` (P0-17) et démonstration sur appareil physique (P0-18) en attente d'un accès Hostinger — voir [démonstration de sortie de P0](docs/10-development-plan/07-demonstration-p0.md). **Phase P1 : code terminé** (P1-01 à P1-06) — catalogue, moteur de tarification, fournisseurs — voir [démonstration de sortie de P1](docs/10-development-plan/08-demonstration-p1.md) et [passage au développement](docs/10-development-plan/06-passage-au-developpement.md) |

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
