# ADR-002 — Stratégie d'identifiants

- **Statut** : ACCEPTÉ (DÉDUIT de PM §26 ; format de numérotation AV-077)
- **Date** : 24/09/2026

## Contexte
Il faut créer des entités hors ligne sans demander d'identifiant au serveur (PM §26), fournir des références lisibles aux clients (reçus hors ligne), numéroter officiellement les documents, et détecter les commandes perdues ou supprimées.

## Décision
| Usage | Identifiant |
|---|---|
| Clé primaire de toute entité | **UUIDv7**, généré par l'appareil ou par le serveur ; type `uuid` natif PostgreSQL |
| Idempotence | `command_id` (UUIDv7) distinct des identifiants d'entités |
| Référence locale (reçu hors ligne) | `{CODE_APPAREIL}-{seq6}` |
| Numéro officiel | `{TYPE}-{CODE_SITE}-{AAAA}-{seq6}`, attribué par le serveur (compteur par type, site et année) |
| Ordre et intégrité par appareil | `device_seq` strictement croissant |
| Curseurs | `bigserial` serveur (flux de changements, audit) |

Le serveur vérifie le format UUIDv7 et l'horodatage embarqué (≤ 24 h dans le futur) ; il n'utilise jamais cet horodatage comme heure métier.

## Alternatives étudiées
UUIDv4 (fragmentation des index), ULID (pas de type natif), séquences numériques (impossibles hors ligne), plages pré-allouées par appareil (fragiles en cas de réinstallation). Détail : [`../03-data/01-identifiants-et-conventions.md`](../03-data/01-identifiants-et-conventions.md) §1.

## Justification
UUIDv7 = génération hors ligne + ordre temporel (localité d'index sur les registres volumineux) + type natif. Les numéros lisibles restent des attributs, jamais des clés.

## Conséquences
Générateur UUIDv7 partagé (bibliothèque) ; `platform.document_sequences` ; code court d'appareil ; contrôle des trous de séquence.

## Risques
Horodatage visible dans les identifiants (fuite mineure de chronologie) : accepté. Collision négligeable.
