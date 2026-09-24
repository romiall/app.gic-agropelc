# Périmètre du système (Livrable n°2)

> Objectif : fixer ce dont GIC AGROPELC (l'application) est responsable, ce qui reste hors système et ce qui est prévu plus tard, afin d'**éviter toute double responsabilité** (PM §22, CM §59).

---

## 1. Dans le système (responsabilité de l'application GIC AGROPELC)

| # | Capacité | Contenu | Domaine | Statut |
|---|---|---|---|---|
| S-01 | Identité et accès | Utilisateurs, rôles multiples, permissions à portée, affectations de rôle, appareils autorisés, sessions, PIN hors ligne | ADM | C (CM §47, §48, §57) |
| S-02 | Organisation | Sites, emplacements (y compris stocks mobiles et emplacements virtuels), zones hiérarchiques, géorepères, équipes, points de vente, paramètres | ADM | C (CM §12, §57) / D |
| S-03 | Validations et contrôles | Politiques de contrôle proportionnées au risque, demandes de validation, file de validation des responsables | ADM | C (CM §24, §42, §52) |
| S-04 | Pièces justificatives | Photos et documents attachés aux opérations, capture hors ligne, upload reprenable | ADM | C (CM §42) |
| S-05 | CRM opérationnel | Comptes clients (prospects et clients), acquisition, portefeuille et réaffectations, visites, interactions hors Kommo, pipeline prospect, objectifs | CRM | C (CM §7–§9) |
| S-06 | Pointage terrain | Prises et fins de service géolocalisées, tentatives, sessions de travail, dérogations | TER | C (CM §10) |
| S-07 | Commandes clients | Création, confirmation, réservation de stock, acomptes, livraison, annulation | VEN | C (CM §4, §7) |
| S-08 | Ventes | Ventes directes et sur commande, prix figés, attribution, annulation par contre-écriture | VEN | C (CM §13) |
| S-09 | Tarification | Règles tarifaires multi-dimensions, campagnes commerciales, résolution du prix en ligne et hors ligne, historique | PRX | C (CM §29, §30) |
| S-10 | Stock | Registre de mouvements, soldes, lots de traçabilité, transferts, affectations physiques, allocations et réservations, pertes, consommations, inventaires, seuils, valorisation | STK | C (CM §20–§25, §39) |
| S-11 | Distribution et PDV | Réapprovisionnement, stock des points de vente, vendeurs, caisse de PDV, suivi envoyé / vendu / restant / perdu / encaissé | DIS | C (CM §12, §22) |
| S-12 | Production | Lots (chair, pondeuses, porcs), entrées, mortalité, consommations, pesées, collectes d'œufs, incubation, sorties vers commercialisation, clôture, coûts de lot | PRD, VOL, OEU, INC, POR | C (CM §14–§19, §33) |
| S-13 | Approvisionnement | Fournisseurs, demandes d'achat, validation, bons de commande, réceptions (livré, rejeté, accepté), rapprochement | APP | C (CM §26–§28) |
| S-14 | Finance opérationnelle | Encaissements et affectations, créances, comptes de trésorerie, sessions et remises de caisse, dépenses, factures et paiements fournisseurs, registre de coûts, marges, valorisation | FIN | C (CM §31, §32) |
| S-15 | Pilotage | Tableaux de bord par rôle, analyse flexible (filtrer, trier, grouper, colonnes, agréger, exporter, sauvegarder la vue), alertes actionnables | ANA, NOT | C (CM §34, §35, §54) |
| S-16 | Communication interne | Notes de direction ciblées, accusés de lecture optionnels | NOT | C (CM §43) |
| S-17 | Audit | Journal d'audit en ajout seul des opérations sensibles et des accès | AUD | C (CM §40) |
| S-18 | Synchronisation | Outbox, inbox idempotente, flux de changements par périmètre, conflits, supervision des appareils | SYN | C (CM §36–§39) |
| S-19 | Intégration Kommo | Liens d'identifiants, entrées (leads qualifiés), sorties (clients, commandes, CA cumulé), anti-boucle, reprise | KOM | C (CM §44–§46) |

## 2. Hors système

| Fonction | Responsable | Ce que GIC en conserve | Justification |
|---|---|---|---|
| Conversations WhatsApp, messagerie digitale | **Kommo** (avec WhatsApp) | Rien du contenu ; lien vers le contact ou le lead Kommo | CM §44 ; ADR-009 |
| Leads digitaux, qualification digitale, pipeline relationnel digital, relances, nurturing, automatisations marketing | **Kommo** | Identifiant du lead d'origine sur le compte client ; source `KOMMO` | CM §44 ; PM §16 |
| Publicité, réseaux sociaux | Outils externes, puis Kommo | Source du prospect | CM §46 |
| Transport physique des messages WhatsApp | **WhatsApp** (via Kommo) | — | CM §11, §44 |
| Comptabilité générale réglementaire (grand livre, bilan, liasse fiscale) | **Logiciel comptable externe** (futur) ou cabinet | Exports structurés des documents financiers | CM §31, §56 ; ADR-010 |
| Transactions des opérateurs de mobile money | **Opérateurs** (Orange, MTN…) | Référence de transaction saisie sur l'encaissement | AV-056 |
| Transactions bancaires | **Banque** | Référence de virement, relevés rapprochés manuellement | D |
| Cartographie, fonds de carte | **Service externe** (tuiles cartographiques en ligne) | Coordonnées GPS uniquement | D |
| Envoi de notifications push | **Services Web Push des navigateurs** | Abonnements push | D |
| Stockage physique des fichiers | **Service de stockage objet** | Métadonnées, empreinte, clé de stockage | D |
| Paie, gestion RH exhaustive | Hors système | Identité et rôles des utilisateurs uniquement | CM §56 |

## 3. Propriété des données partagées (source de vérité)

Réponse au CM §59 (« Quel système ou module possède l'information officielle ? »).

| Donnée | Propriétaire officiel | Copie ou lecture ailleurs | Règle en cas de divergence |
|---|---|---|---|
| Identité client opérationnel (nom, téléphone, adresse, catégorie, localisation) | **GIC – module CRM** | Kommo (copie pour la conversation) | GIC prévaut. Une modification faite dans Kommo est proposée à GIC via webhook et appliquée seulement si le champ n'a pas été modifié dans GIC depuis la dernière synchronisation ; sinon conflit tracé (voir [`../08-api-events/03-integration-kommo.md`](../08-api-events/03-integration-kommo.md)). |
| Lead digital, statut du pipeline Kommo | **Kommo** | GIC : identifiant du lead et statut d'origine figés à la conversion | Kommo prévaut ; GIC ne modifie jamais un lead. |
| Conversation WhatsApp | **Kommo** | Aucune | — |
| Stade du compte client (prospect / client / perdu), commercial titulaire | **GIC – CRM** | Kommo (champ informatif) | GIC prévaut. |
| Produits, catalogue | **GIC – Catalogue** | Kommo (liste éventuelle) | GIC prévaut. |
| Prix | **GIC – Pricing** | Appareils (copie hors ligne), Kommo (informatif) | GIC prévaut ; le prix figé sur une vente fait foi pour cette vente. |
| Commande client | **GIC – Ventes** | Kommo (statut informatif) | GIC prévaut. |
| Vente, CA | **GIC – Ventes** | Kommo (CA cumulé informatif) | GIC prévaut. |
| Stock | **GIC – Stock** (registre) | Appareils (soldes et allocations de périmètre) | Le registre serveur fait foi ; une copie locale n'est qu'un cache. |
| Paiement client | **GIC – Finance** | Kommo (informatif) | GIC prévaut. |
| Production, lots | **GIC – Production** | — | — |
| Achats, fournisseurs | **GIC – Approvisionnement** | — | — |
| Utilisateurs | **GIC – Identité** | Kommo (utilisateurs propres, reliés par table de correspondance) | Chacun gère ses comptes ; correspondance explicite (AV-071). |

## 4. Futures extensions (hors MVP, anticipées sans être construites)

| # | Extension | Source | Anticipation dans l'architecture (sans coût MVP) |
|---|---|---|---|
| F-01 | Géolocalisation permanente, suivi des tournées | CM §56 | Aucune ; les points GPS sont liés aux événements. |
| F-02 | Optimisation des tournées de livraison | CM §56 | Commandes géolocalisées via le compte client. |
| F-03 | IA prédictive (prévision des ventes, mortalité) | CM §56 | Faits analytiques historisés, datés par `occurred_at`. |
| F-04 | IoT et capteurs (température, poids automatique) | CM §56 | `production.lot_weighings` accepte une source `DEVICE` ; pas de connecteur. |
| F-05 | Paie et RH complètes | CM §56 | Aucune. |
| F-06 | Maintenance industrielle avancée | CM §56 | Aucune. |
| F-07 | Comptabilité réglementaire intégrée (SYSCOHADA) | CM §56 ; AV-059 | Documents financiers typés et immuables, exports, colonnes de taxe prévues (AV-041). |
| F-08 | Identification individuelle des animaux | CM §19 ; PM §10 | Table `production.animals` décrite mais non créée ; le registre accepte un identifiant d'animal comme lot. |
| F-09 | Commissions commerciales | CM §8 ; AV-020 | Attribution figée sur chaque vente. |
| F-10 | Retours clients | AV-029 | Types de mouvement `CUSTOMER_RETURN` réservés. |
| F-11 | Abattage et transformation | AV-032 | Mouvements `PRODUCTION_INPUT` / `PRODUCTION_OUTPUT` génériques. |
| F-12 | Calibrage des œufs | CM §17 ; AV-046 | Nouveaux produits d'œufs par calibre ; collecte extensible. |
| F-13 | Naissage porcin (truies, mises-bas) | AV-045 | Entrée de lot de type `BIRTH` déjà prévue. |
| F-14 | Plan de prophylaxie et vaccination | AV-050 | Consommations vétérinaires déjà imputées au lot. |
| F-15 | Impression de reçus Bluetooth | AV-076 | Modèle de reçu. |
| F-16 | Intégration API des opérateurs de mobile money | AV-056 | Référence externe unique sur l'encaissement. |
| F-17 | Notifications SMS ou WhatsApp sortantes | AV-064 | Canal de notification abstrait. |
| F-18 | Application native (enveloppe Capacitor) : GPS natif, détection de faux GPS, synchronisation en arrière-plan fiable | L-02 | Code PWA réutilisable tel quel. |
| F-19 | Multi-entreprise | H-02 | Non anticipé : décision explicite de ne pas le faire. |

## 5. Frontière MVP (rappel)

Le MVP fonctionnel est celui du CM §57 (REQ-080), livré en tranches (AV-001). Les exclusions du CM §56 (REQ-079) sont respectées. Le découpage détaillé par phase est dans [`../10-development-plan/01-plan-developpement.md`](../10-development-plan/01-plan-developpement.md).
