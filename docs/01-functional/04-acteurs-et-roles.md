# Acteurs et rôles

> Section 6 du format final (PM §48). La matrice détaillée des permissions est dans [`../07-security-rbac/01-rbac.md`](../07-security-rbac/01-rbac.md).

---

## 1. Principes

| # | Principe | Statut |
|---|---|---|
| 1 | Un utilisateur peut avoir **plusieurs rôles** simultanément ; ses droits effectifs sont l'union des droits de ses affectations de rôle actives. | C (CM §6, §47) |
| 2 | Chaque affectation de rôle est **limitée à un périmètre** (global, site, zone, équipe) et **bornée dans le temps**. | C (PM §17) / D (bornage) |
| 3 | Les rôles sont des **données** (configurables), pas du code : ajouter un rôle ne demande aucun développement. | D (ADR-008) |
| 4 | Le rôle Administrateur configure le système mais **n'approuve pas** les opérations métier. | AV-010 |
| 5 | Un utilisateur ne valide jamais sa propre opération soumise à validation, sauf dérogation Direction tracée. | AV-010 |

## 2. Acteurs humains : rôles du CM §47

Légende du besoin hors ligne : **Critique** = l'activité principale doit fonctionner sans réseau ; **Utile** = consultation et quelques saisies ; **Faible** = usage essentiellement connecté.

| Code rôle | Rôle (CM §47) | Mission | Journées et actions principales | Périmètre type | Hors ligne | Appareil type |
|---|---|---|---|---|---|---|
| `DIRECTION` | Direction | Pilotage global et contrôle. | Consulter la tour de contrôle, identifier les anomalies, valider les opérations au-dessus des seuils, activer les tarifs, publier des notes (CM §53). | `ALL` | Faible (dernière vue en cache) | Smartphone, ordinateur |
| `ADMIN` | Administrateur | Configuration du système et gestion des droits. | Utilisateurs, rôles, appareils, sites, zones, emplacements, référentiels, paramètres, supervision de la synchronisation. | `ALL` (configuration) | Faible | Ordinateur |
| `RESP_COMMERCIAL` | Responsable commercial | Pilotage de l'équipe commerciale ; peut aussi être commercial opérationnel (CM §6). | Suivre ventes, prospects, visites, présences, objectifs, clients inactifs ; réaffecter des clients ; valider remises et dérogations de pointage ; préparer les tarifs (CM §34.2). | `TEAM` (+ `OWN` s'il vend) | Utile | Smartphone |
| `COMMERCIAL_TERRAIN` | Commercial terrain | Prospection physique, visites, clients, commandes. | Prendre service, consulter ses objectifs, ajouter des prospects, enregistrer des visites, prendre des commandes, vendre depuis son stock mobile, encaisser, consulter ses performances (CM §50). | `OWN` + ses zones | **Critique** | Smartphone Android |
| `COMMERCIAL_SEDENTAIRE` | Commercial sédentaire | Traitement des leads et clients sans déplacement permanent. | Traiter les clients venus de Kommo, créer des commandes, suivre les livraisons et encaissements. | `OWN` | Utile | Ordinateur, smartphone |
| `VENDEUR_PDV` | Vendeur de point de vente | Ventes et opérations du point de vente. | Ouvrir la caisse, vendre, encaisser, déclarer une perte, recevoir un transfert, demander un réapprovisionnement, participer à l'inventaire, clôturer la caisse. | `SITE` (son PDV) | **Critique** | Smartphone ou tablette partagée |
| `RESP_PRODUCTION` | Responsable production | Pilotage des lots et de la production. | Créer et clôturer des lots, suivre effectifs, mortalités, consommations, œufs, incubations ; valider les mortalités au-dessus du seuil ; analyser coûts et performances (CM §34.5). | `ALL` fermes (AV-005) | Utile | Smartphone |
| `RESP_FERME` | Responsable ferme | Supervision opérationnelle de la ferme. | Saisie du jour, collectes d'œufs, consommations, réceptions et stock de la ferme, sorties vers commercialisation, validations locales sous seuil. | `SITE` (sa ferme) | **Critique** | Smartphone |
| `MAGASINIER` | Magasinier | Réception, stockage, sorties et inventaires. | Consulter les alertes, réceptionner, enregistrer les quantités acceptées, transférer, affecter du stock aux commerciaux, déclarer des pertes, contrôler les stocks, inventorier (CM §51). | `SITE` (son magasin) | **Critique** | Smartphone, tablette |
| `RESP_ACHATS` | Responsable achats | Fournisseurs et approvisionnements. | Gérer les fournisseurs, instruire et valider les demandes d'achat, émettre les bons de commande, suivre les reliquats et rapprochements. | `ALL` | Faible | Ordinateur |
| `FINANCE` | Comptabilité / Finance | Encaissements, dépenses, créances, fournisseurs, reporting financier. | Suivre créances et encaissements, valider les sessions de caisse, enregistrer dépenses, factures et paiements fournisseurs, analyser coûts et marges (CM §34.6). | `ALL` (finance) | Faible | Ordinateur |

### 2.1 Rôles proposés, non confirmés (AV-004)

Ils ne sont **pas créés** au lancement. Le modèle RBAC permet de les ajouter par configuration.

| Code proposé | Besoin constaté | Permissions envisagées |
|---|---|---|
| `OPERATEUR_FERME` | Personne qui fait la saisie quotidienne en ferme sans être responsable (CM §49 « SAISIE DU JOUR »). | Saisie du jour (mortalité sous seuil, consommation, pesée, collecte d'œufs) sur son site ; aucune validation ni lecture financière. |
| `LIVREUR` | Personne qui transporte les transferts ou livre les commandes (CM §22 « par qui »). | Réception de transfert vers son stock mobile, remise au destinataire, livraison de commande. |
| `CAISSIER` | Séparation vendeur / caisse dans un PDV à fort volume. | Encaissements et session de caisse uniquement. |

### 2.2 Cumuls de rôles attendus

| Cas | Rôles cumulés | Effet |
|---|---|---|
| Démarrage commercial (CM §6) | `RESP_COMMERCIAL` + `COMMERCIAL_TERRAIN` | Il voit son équipe (`TEAM`) **et** a son propre portefeuille (`OWN`) ; il ne peut pas valider ses propres remises (AV-010). |
| Petite structure | `DIRECTION` + `ADMIN` | Il configure et approuve ; ses auto-validations portent le marqueur `SELF_APPROVED`. |
| Ferme sans responsable production dédié | `RESP_FERME` + `RESP_PRODUCTION` | Il valide ses propres saisies de mortalité au-dessus du seuil avec le marqueur `SELF_APPROVED`, ou bien la Direction valide (AV-010). |
| Magasin de ferme | `RESP_FERME` + `MAGASINIER` (même site) | Réceptions d'intrants et saisie production sur le même site. |

## 3. Acteurs systèmes

| Acteur | Nature | Interactions | Confiance |
|---|---|---|---|
| **Appareil (PWA)** | Client applicatif sur le terminal d'un utilisateur | Envoie des commandes, télécharge les données de périmètre, capture photos et GPS | **Non fiable** : tout est revalidé côté serveur (PM §37) |
| **Serveur GIC** (API + gestionnaires de commandes) | Autorité | Valide, applique, numérote, journalise | Autorité de vérité |
| **Worker / ordonnanceur** | Processus système interne | Projections, alertes planifiées, clôtures automatiques (sessions de travail, allocations expirées), synchronisation Kommo, traitement des pièces jointes | Interne ; agit sous l'identité technique `system` (auditée) |
| **Kommo** | Système externe | Envoie des webhooks (lead qualifié, modification de contact) ; reçoit clients, commandes, CA cumulé | Externe authentifié ; entrées vérifiées et dédupliquées |
| **Service Web Push** | Externe | Reçoit les notifications à délivrer | Externe |
| **Stockage objet** | Externe | Stocke les fichiers | Externe ; accès par URL signée |

## 4. Matrice acteurs × domaines

Légende : **E** = saisit ou exécute, **V** = valide ou approuve, **L** = lit, **P** = paramètre, — = aucun accès. La portée est indiquée par l'indice o (own), t (team), s (site), z (zone), a (all). Détail exhaustif dans la matrice RBAC.

| Domaine | DIR | ADM | R.COM | C.TER | C.SED | VEND | R.PROD | R.FERME | MAG | ACH | FIN |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Identité, organisation | L a | P a | L t | — | — | — | — | — | — | — | — |
| CRM | L V a | — | E V t | E o | E o | E s | — | — | — | — | L a |
| Pointage | L a | — | L V t | E o | — | — | — | — | — | — | — |
| Commandes et ventes | L V a | — | E V t | E o | E o | E s | — | E s | — | — | L a |
| Tarification | V P a | — | E t | L | L | L | — | L | — | — | L a |
| Stock et transferts | L V a | — | L t | E o | — | E s | L a | E s | E V s | L a | L a |
| Pertes | L V a | — | — | E o | — | E s | V a | E V s | E s | — | L a |
| Inventaires | L V a | — | — | E o | — | E s | L a | E s | E s | — | L V a |
| Production | L V a | — | — | — | — | — | E V a | E s | — | — | L a |
| Approvisionnement | L V a | — | — | — | — | — | E (DA) a | E (DA) s | E (réception) s | E V a | L a |
| Finance | L V a | — | L t | E (encaissement) o | E (encaissement) o | E s | L (coûts) a | — | — | L a | E V a |
| Analytics | L a | — | L t | L o | L o | L s | L a | L s | L s | L a | L a |
| Audit | L a | L a | — | — | — | — | — | — | — | — | L a |
| Synchronisation | L a | P a | L t | own | own | own | own | own | own | own | own |
| Kommo | L a | P a | L t | — | L o | — | — | — | — | — | — |
