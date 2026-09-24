# Exigences non fonctionnelles (Livrable n°13)

> Section 27 du format final (PM §48). Chaque exigence a une **cible mesurable** et une **méthode de vérification**.
> **Appareil de référence** (AV-075) : smartphone Android 8, 2 Go de RAM, processeur 4 cœurs d'entrée de gamme, Chrome 100.
> **Réseau de référence** « 2G/EDGE » : 50 kbit/s, 800 ms de latence, 5 % de pertes. « 3G » : 400 kbit/s, 300 ms.

| ID | Catégorie | Exigence | Cible mesurable | Vérification | Source |
|---|---|---|---|---|---|
| NFR-01 | Offline / performance appareil | Enregistrer une vente hors ligne (validation → confirmation affichée) | p95 ≤ 1 s sur l'appareil de référence | Test E2E instrumenté (profil CPU ×4 plus lent) | CM §3, §49 |
| NFR-02 | Performance appareil | Démarrage de la PWA installée | À froid ≤ 4 s ; à chaud ≤ 1,5 s ; fonctionne sans réseau | Lighthouse + E2E hors ligne | PM §36 |
| NFR-03 | Performance appareil | Recherche locale d'un client parmi 2 000 | ≤ 300 ms | Test de performance local | CM §49 |
| NFR-04 | Offline | Autonomie hors ligne sans perte | ≥ 7 jours (AV-009) ; outbox ≥ 5 000 commandes ; zéro perte après redémarrage de l'appareil ou fermeture du navigateur | Test d'endurance (5 000 commandes, redémarrages) | CM §37, PM §29 |
| NFR-05 | Compatibilité mobile | Taille du bundle initial | JS initial ≤ 300 Ko gzip ; ressources initiales ≤ 1 Mo ; découpage par rôle | Budget en CI (échec si dépassé) | PM §36 |
| NFR-06 | Offline | Stockage local | Données ≤ 20 Mo ; pièces en attente ≤ 50 Mo ; alerte à 80 % du quota | Mesure sur un jeu représentatif | PM §29, §36 |
| NFR-07 | Bande passante réduite | Données échangées | Journée type d'un vendeur (100 ventes) ≤ 1 Mo hors photos ; chargement initial ≤ 5 Mo ; réponses compressées | Mesure sur staging | PM §36 |
| NFR-08 | Bande passante réduite | Photos | ≤ 400 Ko après compression ; upload reprenable par morceaux de 256 Ko | Test d'upload interrompu | ADR-012 |
| NFR-09 | Appareils modestes | Batterie et ressources | Aucun traitement périodique plus fréquent que toutes les 5 min ; géolocalisation seulement aux événements ; pas de polling en arrière-plan | Revue de code + test | CM §10, §56 |
| NFR-10 | Performance serveur | Application d'une commande | p95 ≤ 500 ms (hors réseau) ; lot de 50 ≤ 5 s | Test de charge (k6) | CM §36 |
| NFR-11 | Performance serveur | Lectures d'API paginées | p95 ≤ 300 ms | Test de charge | — |
| NFR-12 | Performance serveur | Tableaux de bord (dont tour de contrôle) | p95 ≤ 3 s ; lisibilité de la tour de contrôle en moins de 30 s (test utilisateur) | Test de charge + test utilisateur | CM §53 |
| NFR-13 | Analytics | Requête de l'explorateur sur 90 jours ; export | p95 ≤ 5 s ; export de 100 000 lignes ≤ 2 min | Test de charge | CM §35 |
| NFR-14 | Évolutivité | Débit soutenu d'une instance d'API | ≥ 20 commandes/s (le besoin H-06 en pointe est d'environ 2/s) | Test de charge | CM §55 |
| NFR-15 | Temps réel | Délai événement → réaction (alerte, message Kommo) | p95 ≤ 10 s | Métrique de retard des consommateurs | CM §36 |
| NFR-16 | Temps réel | Visibilité d'une donnée synchronisée sur les tableaux de bord | ≤ 60 s après application | Test E2E | CM §36 (« quasi immédiate ») |
| NFR-17 | Disponibilité | Disponibilité mensuelle de l'API | ≥ 99,5 % (hors maintenance annoncée ≤ 4 h/mois, hors heures ouvrées) | Sonde externe | CM §36 |
| NFR-18 | Résilience | Indépendance du terrain vis-à-vis du serveur | 100 % des opérations critiques (vente, prospect, visite, perte, réception, transfert, saisie du jour, caisse) fonctionnent pendant une panne serveur | E2E « serveur arrêté » | CM §37 |
| NFR-19 | Résilience réseau | Synchronisation en réseau 2G/EDGE | Lot de 50 commandes ≤ 30 s ; aucune duplication après 100 coupures aléatoires | Tests réseau simulé (Playwright + proxy de dégradation) | CM §37, PM §29 |
| NFR-20 | Sauvegarde | Perte de données maximale (RPO) | ≤ 15 min (PITR) | Contrôle de configuration + test de restauration | PM §36 |
| NFR-21 | Restauration | Délai de reprise (RTO) | ≤ 4 h | Exercice de reprise semestriel | PM §36 |
| NFR-22 | Sauvegarde | Rétention | Quotidiennes 35 jours ; mensuelles 12 mois ; copie hors région ; chiffrées | Contrôle de configuration | PM §36 |
| NFR-23 | Restauration | Tests de restauration | Mensuel en staging, avec procès-verbal (durée, intégrité vérifiée par les tests d'invariants) | Procédure | PM §36 |
| NFR-24 | Autorisation | Couverture du contrôle d'accès | 100 % des endpoints authentifiés et soumis au contrôle de portée (sauf `/auth/login` et webhook authentifié) | Test automatique (introspection des routes) | PM §37 |
| NFR-25 | Sécurité | Vulnérabilités | Aucune vulnérabilité critique ou haute connue non traitée depuis plus de 7 jours en production | Analyse en CI + veille | PM §37 |
| NFR-26 | Sécurité | Transport et mots de passe | TLS 1.2+ (note A sur un test TLS public) ; argon2id | Scan TLS ; revue | PM §37 |
| NFR-27 | Audit | Couverture | 100 % des commandes sensibles produisent une entrée d'audit ; chaîne vérifiée chaque jour | Test de couverture (registre des commandes) + tâche | CM §40, PM §18 |
| NFR-28 | Observabilité | Capture des erreurs | ≥ 95 % des erreurs client et serveur remontées avec `correlation_id` | Tests d'injection d'erreurs | PM §36 |
| NFR-29 | Monitoring | Tableaux de supervision | Latence, erreurs, retard des consommateurs, outbox Kommo, appareils non synchronisés, conflits ouverts, espace disque | Revue avant production | PM §36 |
| NFR-30 | Logs | Rétention | Logs 30 jours ; métriques 13 mois ; audit 10 ans | Configuration | PM §36 |
| NFR-31 | Maintenabilité | Tests | Bibliothèque métier partagée ≥ 90 % de couverture de lignes ; chaque invariant `INV-*` couvert par au moins un test | Rapport de couverture ; matrice invariants → tests | PM §28 |
| NFR-32 | Maintenabilité | Frontières de modules | 0 violation du graphe de dépendances | Contrôle en CI | PM §35 |
| NFR-33 | Évolutivité | Croissance | 10× H-06 absorbables par montée en gamme verticale + réplique en lecture, sans refonte | Test de charge à 10× (avant R4) | CM §55 |
| NFR-34 | Compatibilité | Navigateurs et appareils | Android 8+ avec Chrome ou WebView ≥ 100 (cible) ; bureau : 2 dernières versions de Chrome, Edge, Firefox ; iOS Safari ≥ 16 au mieux, sans synchronisation en arrière-plan | Matrice de tests E2E | PM §5, §36 |
| NFR-35 | Utilisabilité | Ergonomie terrain | Contraste AA ; zones tactiles ≥ 44 px ; action courante ≤ 5 champs obligatoires ; nouvel utilisateur autonome sur son action principale après 30 min de formation | Tests utilisateurs pilotes | CM §3, §49 |
| NFR-36 | Maintenabilité | Internationalisation | 100 % des textes via clés de traduction ; français complet | Lint i18n | AV-079 |
| NFR-37 | Confidentialité | Minimisation et conservation | Périmètre local minimal (O3) ; conservation selon AV-074 ; pseudonymisation possible sous 30 jours après la demande | Revue + procédure | AV-073 |
| NFR-38 | Intégrité | Réconciliation des registres | 0 écart quotidien entre registres et projections (INV-STK-01, INV-FIN-02) ; tout écart = incident | Tâche quotidienne + alerte | PM §6 |
| NFR-39 | Intégrité | Horloge serveur | Synchronisée NTP, écart < 1 s | Supervision | CM §38 |
| NFR-40 | Offline | Chargement initial d'un nouvel appareil | ≤ 3 min en 3G pour le périmètre d'un vendeur ou d'un commercial | Test E2E | PM §29 |
