# Registre des décisions d'architecture (Livrable n°18)

> Section 35 du format final (PM §48). Format : Contexte, Décision, Alternatives étudiées, Justification, Conséquences, Risques (PM §43).
> Statuts : **ACCEPTÉ** (retenu pour le développement), **PROPOSÉ** (à confirmer), **À VALIDER** (dépend d'une décision métier du registre `A-VALIDER.md`), **REMPLACÉ**.

| ADR | Titre | Statut | Exigé par le PM §43 |
|---|---|---|---|
| [ADR-001](ADR-001-offline-first.md) | Offline-first : PWA, base locale, commandes, serveur autoritaire | ACCEPTÉ | Oui |
| [ADR-002](ADR-002-identifiants.md) | Stratégie d'identifiants | ACCEPTÉ | Oui |
| [ADR-003](ADR-003-registre-stock.md) | Registre de stock en partie double | ACCEPTÉ | Oui |
| [ADR-004](ADR-004-allocations-offline.md) | Garde exclusive, quotas et réservations | ACCEPTÉ (politique AV-025, AV-035) ; décision 3 (réservations) remplacée par ADR-028 §4, précisé par ADR-033 | Oui |
| [ADR-005](ADR-005-historisation-prix.md) | Historisation des prix | ACCEPTÉ | Oui |
| [ADR-006](ADR-006-annulation-vs-suppression.md) | Annulation vs suppression | ACCEPTÉ | Oui |
| [ADR-007](ADR-007-synchronisation.md) | Stratégie de synchronisation | ACCEPTÉ | Oui |
| [ADR-008](ADR-008-rbac.md) | Modèle RBAC | ACCEPTÉ | Oui |
| [ADR-009](ADR-009-frontieres-kommo.md) | Frontières avec Kommo | ACCEPTÉ (AV-068 à 071) | Oui |
| [ADR-010](ADR-010-comptabilite-operationnelle.md) | Comptabilité opérationnelle | ACCEPTÉ | Oui |
| [ADR-011](ADR-011-architecture-backend.md) | Architecture backend | ACCEPTÉ | Oui |
| [ADR-012](ADR-012-pieces-jointes-offline.md) | Pièces jointes offline | ACCEPTÉ | Oui |
| [ADR-013](ADR-013-monnaie-quantites.md) | Monnaie, montants, quantités | ACCEPTÉ | — |
| [ADR-014](ADR-014-commande-vente-livraison.md) | Commande, vente, livraison | REMPLACÉ en totalité (par ADR-025 et ADR-028) | — |
| [ADR-015](ADR-015-valorisation.md) | Valorisation et coûts de production | À VALIDER (AV-042) ; complété par ADR-026 (AV-043) | — |
| [ADR-016](ADR-016-temps-metier.md) | Temps métier et horloges | ACCEPTÉ | — |
| [ADR-017](ADR-017-compte-client-unique.md) | Compte client unique | ACCEPTÉ (AV-012) | — |
| [ADR-018](ADR-018-validations-generiques.md) | Validations génériques | ACCEPTÉ | — |
| [ADR-019](ADR-019-style-api.md) | Style d'API | ACCEPTÉ | — |
| [ADR-020](ADR-020-postgresql.md) | PostgreSQL | REMPLACÉ (par ADR-023) | — |
| [ADR-021](ADR-021-stack-technique.md) | Stack technique | PROPOSÉ | — |
| [ADR-022](ADR-022-structure-documentaire.md) | Organisation de la documentation | ACCEPTÉ | — |
| [ADR-023](ADR-023-mysql.md) | Base de données : MySQL (remplace ADR-020) | ACCEPTÉ | — |
| [ADR-024](ADR-024-hebergement-hostinger.md) | Hébergement cible : Hostinger sans VPS | ACCEPTÉ | — |
| [ADR-025](ADR-025-vente-a-la-confirmation.md) | Vente reconnue à la confirmation, marchandise « à livrer » (remplace en partie ADR-014) | ACCEPTÉ | — |
| [ADR-026](ADR-026-cout-de-lot-frais-generaux-coproduits.md) | Coût de lot : frais généraux de ferme et coproduits d'abattage (complète ADR-015 ; amendé le 28/09/2026) | ACCEPTÉ | — |
| [ADR-027](ADR-027-valorisation-lots-biologiques.md) | Valorisation des lots biologiques : coût restant, productions au coût standard, lots de stock propres | ACCEPTÉ | — |
| [ADR-028](ADR-028-commande-vente-livraison-p4.md) | Commandes, ventes et livraisons après ADR-025 : emplacement « à livrer » virtuel par site, vente du disponible, bon de livraison, contre-écritures partielles | ACCEPTÉ | — |
| [ADR-029](ADR-029-contre-ecriture-partielle-du-stock.md) | Contre-écriture partielle et livraison du stock vendu : mouvements rattachés à une origine (`origin_move_id`), plafond et valeur exacte garantis en base | ACCEPTÉ | — |
| [ADR-030](ADR-030-accueil-par-role.md) | Accueil par rôle : une page de référence calculée à la demande, composée dans la couche de transport (`home-api/`), périmètre par rôle | ACCEPTÉ | — |
| [ADR-031](ADR-031-cle-de-synchronisation-des-referentiels-a-code.md) | Clé de synchronisation des référentiels dont la clé primaire est un code (UUID version 5 dérivé du code) | ACCEPTÉ | — |
| [ADR-032](ADR-032-sessions-de-caisse-et-remises-de-fonds.md) | Sessions de caisse et remises de fonds : un écart n'est compté qu'une fois (attendu tiré du registre, rattachement à l'insertion, réévaluation par delta, remise sans second mouvement) | ACCEPTÉ | — |
| [ADR-033](ADR-033-quotas-d-appareil-apres-adr-028.md) | Quotas d'appareil après ADR-028 : consommation dans `inventory`, disponible par consommateur, source unique de la garde, restitution à l'annulation | ACCEPTÉ | — |
| [ADR-034](ADR-034-isolation-par-commande.md) | Niveau d'isolation choisi par commande : lecture confirmée (`isolationLevel: 'read committed'`) réservée aux commandes sérialisées sous un verrou de ligne explicite (sessions de caisse) | ACCEPTÉ | — |
| [ADR-035](ADR-035-tableaux-d-analyse-avant-p9.md) | Tableaux d'analyse avant P9 : composés dans la couche de transport (`distribution-api/`), périmètre tiré de la permission, mesures et détails masqués par droit, contrat repris sans changement par P9 | ACCEPTÉ | — |
| [ADR-036](ADR-036-navigation-par-role-sur-l-appareil.md) | Navigation par rôle sur l'appareil : registre des écrans de la PWA, route complétée par l'appareil, navigation mémorisée hors ligne, menu `/menu` (fork « Écrans PWA », numéro de fork 050) | ACCEPTÉ | — |
| [ADR-037](ADR-037-synchronisation-appareil-durcie.md) | Synchronisation de l'appareil durcie : joignabilité réelle du serveur, enveloppe immuable, décompte jusqu'au tirage, reprise des envois, un seul titulaire des données (fork « Écrans PWA », numéro de fork 051) | ACCEPTÉ | — |
| [ADR-038](ADR-038-ordre-de-verrouillage-global.md) | Ordre de verrouillage global des transactions de commande : rangs (inbox, site, documents racines, clients, commandes et ventes, soldes physiques, quotas, soldes virtuels, affectations et encaissements, comptes, sessions, insertions, compteur, audit), verrous restreints, upsert d'une ligne absente, condition relue sous verrou (P5-22) | ACCEPTÉ | — |
| [ADR-039](ADR-039-envoi-strict-dans-l-ordre-de-l-appareil.md) | Envoi de l'appareil dans l'ordre strict de `device_seq`, dépendantes comprises ; renvois distingués par motif (`PRECEDING_COMMAND_PENDING` neutre, `COMMAND_STALLED` signalé et renvoyé une fois par cycle) ; révise ADR-037 §11 (fork « Écrans PWA », phase des écrans de P5, numéro de fork 052) | ACCEPTÉ | — |
| [ADR-040](ADR-040-garde-jugee-a-la-date-du-fait.md) | Garde d'un emplacement jugée à la date du fait hors ligne : historique des gardes (`organization_location_custody_periods`, INV-DIS-03), date du dernier rattachement d'un appareil ; précise ADR-033 §2 (AV-195 (2), AV-243) | ACCEPTÉ | — |
| [ADR-041](ADR-041-activite-par-periode-accueil-et-tableau.md) | Chiffre d'affaires et encaissé par période d'activité : une seule définition (`period-activity.ts`) pour l'accueil et le tableau de distribution, une annulation compte à sa date ; précise ADR-030 §7, ADR-032 §9, ADR-035 (AV-200, AV-209, AV-244, AV-245) | ACCEPTÉ | — |
| [ADR-060](ADR-060-depenses-p8.md) | Dépenses : seuils en paramètres, caisse du PDV traitée comme un encaissement (session, `CASH_SESSION_MISSING`), hors ligne appliquée puis validée a posteriori, rejet après paiement reclassé `NON_JUSTIFIEE`, coût des objets par `inventory`, catégories administrables à identifiant UUIDv7 (AV-350 à 357) | ACCEPTÉ | — |
| [ADR-061](ADR-061-factures-et-paiements-fournisseurs-p8.md) | Factures et paiements fournisseurs : rapprochement partagé, quantités facturées écrites par `procurement` à l'appel de `finance`, avoir par annulation et rectificative, décaissement après validation (affectations `PLANNED`), avances, dettes, rangs de verrouillage des documents de P8 ; précise ADR-038 (AV-358 à 365) | ACCEPTÉ | — |
| [ADR-062](ADR-062-couts-complets-et-marges-p8.md) | Coûts complets et marges : CA d'un lot avec ses produits d'abattage (œufs exclus), valeur des pertes, vue d'ensemble financière (AT-040, AT-041, AV-366) | ACCEPTÉ | — |

Règle : toute nouvelle décision structurante pendant le développement fait l'objet d'un nouvel ADR (numérotation continue). Une décision remplacée n'est pas supprimée : elle passe au statut REMPLACÉ, avec un lien vers la remplaçante.
