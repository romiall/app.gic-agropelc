# Dictionnaire de données (Livrable n°5, section 15)

> Pour chaque table : responsabilité métier, colonnes (type logique, nullabilité, défaut, rôle), clé primaire, clés étrangères, unicités, contraintes de vérification, index, relations, politique de suppression, historisation, audit, comportement hors ligne, règles d'intégrité (PM §25).
> Les blocs de colonnes standard `[STD-ID]`, `[STD-AUDIT]`, `[STD-ORIGIN]`, `[STD-DOC]`, `[STD-CANCEL]` sont définis dans [`../01-identifiants-et-conventions.md`](../01-identifiants-et-conventions.md) §3 : une ligne `[STD-…]` dans un tableau de colonnes signifie « toutes les colonnes du bloc ».
> Ces définitions sont **logiques**. Les migrations SQL seront écrites phase par phase ; toute divergence doit d'abord être répercutée ici.

| Fichier | Schémas |
|---|---|
| [01-identity.md](01-identity.md) | `identity` |
| [02-organization.md](02-organization.md) | `organization` |
| [03-catalog-pricing.md](03-catalog-pricing.md) | `catalog`, `pricing` |
| [04-crm-fieldwork.md](04-crm-fieldwork.md) | `crm`, `fieldwork` |
| [05-sales.md](05-sales.md) | `sales` |
| [06-inventory.md](06-inventory.md) | `inventory` |
| [07-production.md](07-production.md) | `production` |
| [08-procurement.md](08-procurement.md) | `procurement` |
| [09-finance.md](09-finance.md) | `finance` |
| [10-approvals-attachments-communication.md](10-approvals-attachments-communication.md) | `approvals`, `attachments`, `communication` |
| [11-audit-sync-integrations-platform.md](11-audit-sync-integrations-platform.md) | `audit`, `sync`, `integrations`, `platform` |
| [12-analytics.md](12-analytics.md) | `analytics` |

Abréviations des rubriques : **PK** clé primaire · **FK** clés étrangères · **UQ** unicités · **CK** contraintes de vérification · **IX** index · **Suppr.** politique de suppression · **Hist.** historisation · **Audit** actions auditées · **Offline** comportement hors ligne · **Intégrité** règles et invariants liés.
