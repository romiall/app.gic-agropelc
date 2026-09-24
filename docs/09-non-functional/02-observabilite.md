# Observabilité

> Section 29 du format final (PM §48). Exigences associées : NFR-28, NFR-29, NFR-30, NFR-38.

---

## 1. Principes

1. **Corrélation de bout en bout** : un `correlation_id` est créé par requête ou par lot de synchronisation. Il est propagé aux gestionnaires, aux événements (`platform.domain_events.correlation_id`), à l'audit et aux logs, et renvoyé au client dans les réponses d'erreur.
2. **Trois signaux** : logs structurés, métriques, traces (échantillonnées). Plus la **remontée des erreurs** côté serveur **et** côté PWA.
3. **Pas de donnée personnelle ni de secret** dans les logs et la télémétrie (téléphones masqués, pas de charge utile de commande en clair dans les logs).
4. **Santé métier observable**, pas seulement la santé technique : files en retard, appareils non synchronisés, conflits ouverts, écarts de registres.

## 2. Logs

| Aspect | Règle |
|---|---|
| Format | JSON : `ts`, `level`, `service` (api/worker), `module`, `correlation_id`, `user_id` (pseudonymisé), `device_id`, `command_type`, `duration_ms`, `code`, `message` |
| Niveaux | `ERROR` (action requise), `WARN` (anomalie gérée : conflit, rejet), `INFO` (transitions importantes), `DEBUG` (désactivé en production) |
| Rétention | 30 jours (NFR-30) |
| Interdits | Mots de passe, PIN, jetons, charges de commande complètes, coordonnées GPS précises |

## 3. Métriques

| Famille | Métriques | Seuil d'alerte opérationnelle |
|---|---|---|
| API | Latence p50/p95/p99 par route et par type de commande ; taux d'erreurs 5xx ; 429 | p95 commande > 1 s pendant 10 min ; 5xx > 1 % |
| Synchronisation | Commandes reçues par statut ; délai `received_at − client_created_at` (distribution) ; taille des lots ; conflits ouverts par type ; trous de séquence ; écart d'horloge | Conflits `STOCK_NEGATIVE` ouverts > 0 depuis plus de 24 h ; `REJECTED` > 2 % sur 1 h |
| Appareils | Appareils actifs ; non synchronisés depuis plus de 24 h ; versions de l'application ; opérations en attente déclarées | > 10 % des appareils actifs non synchronisés depuis plus de 24 h |
| Worker | Retard par consommateur (`max(seq) − last_seq`, et en secondes) ; tâches en échec ; durée des tâches planifiées | Retard > 60 s pendant 5 min ; tâche planifiée en échec |
| Intégration | Messages Kommo `PENDING` / `DEAD` ; âge du plus ancien | `DEAD` > 0 ; âge > 1 h |
| Base de données | Connexions, requêtes lentes (> 1 s), taille des tables et partitions, retard de réplication (si réplique), stockage | Espace > 80 % |
| Intégrité | Résultat des réconciliations (registre de stock vs soldes ; trésorerie vs soldes) ; chaîne d'audit | Tout écart ≠ 0 |
| PWA (télémétrie anonymisée) | Erreurs JavaScript ; durée des actions clés (NFR-01) ; échecs de synchronisation ; quota de stockage | Hausse soudaine des erreurs |

## 4. Traces

Traces distribuées (standard OpenTelemetry) sur l'API et le worker : échantillonnage de 10 % en production, 100 % pour les requêtes en erreur ou lentes. Chaque étape du pipeline de commande (authentification, droits, validation, gestionnaire, écriture) est une étape de trace.

## 5. Tableaux de supervision

| Tableau | Public | Contenu |
|---|---|---|
| Santé technique | Équipe technique | Latences, erreurs, ressources, base, files |
| Santé de la synchronisation | Admin, équipe technique | Appareils par fraîcheur, rejets et conflits par type, trous de séquence, écarts d'horloge, versions de l'application (écran ECR-SYN-02) |
| Intégrité | Admin, Direction | Réconciliations, chaîne d'audit, soldes négatifs ouverts |
| Intégration Kommo | Admin | Files entrantes et sortantes, messages `DEAD` (écran ECR-KOM-01) |

## 6. Alertes opérationnelles

Elles sont distinctes des alertes métier du module `communication` (D13) :

- routage vers l'équipe technique (e-mail ou messagerie) ;
- chaque alerte opérationnelle a un runbook (procédure courte : diagnostic, action, escalade) rédigé avant la mise en production de la phase concernée.

## 7. Sondes

- Sonde externe de disponibilité toutes les minutes sur `/health` (NFR-17).
- `/health/ready` : base joignable, migrations à jour, retard du worker < seuil.
