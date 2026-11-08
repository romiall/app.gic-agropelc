# Décisions de clôture du développement (questionnaire à choix)

> Document à remplir par le porteur. Écrit le 08/11/2026 à partir du registre [`A-VALIDER.md`](../A-VALIDER.md) (403 points ouverts, dont aucun bloquant), de [`25-validation-av-pilote.md`](25-validation-av-pilote.md) et de l'état du code relu le même jour. Il remplace, pour le porteur, la lecture du registre : 41 questions à trois ou quatre solutions, dont les 57 points ouverts qu'elles traitent, et un classement par domaine des 346 autres. Une version interactive existe (lien privé du porteur : <https://claude.ai/artifact/XRZ67iFyaCEyazvr3tVm2H>) ; ses réponses sont enregistrées dans sa base, et ce document en est la trace dans le dépôt.

## Comment répondre

1. Chaque question propose des solutions lettrées ; la solution **recommandée** porte ★ et sa raison est dans la colonne de droite. Cochez une solution, ou écrivez la vôtre.
2. Les questions à cases (Q13, Q20, Q41) acceptent plusieurs réponses.
3. Classement des affirmations : **CONFIRMÉ** (relu dans le registre, les réglages semés ou le code le 08/11/2026), **DÉDUIT** (conséquence argumentée), **À VALIDER** (votre décision). Les propositions qui ne viennent d'aucune source du cadrage sont signalées « Variante » ou « Proposition ».
4. Ensuite, chaque décision est consignée au journal de `A-VALIDER.md` § 3, le point passe à TRANCHÉ, et ce qui change dans le code ou les réglages est appliqué selon la méthode choisie à la question 39.

## Vue d'ensemble

| Section | Questions | Avant le pilote | Avant la fin du développement | Peut attendre |
|---|---|---|---|---|
| 1. Démarrer le pilote | Q01 à Q13 (13) | 12 | 1 | 0 |
| 2. Finir le développement | Q14 à Q22 (9) | 0 | 9 | 0 |
| 3. Droits et sécurité | Q23 à Q30 (8) | 2 | 3 | 3 |
| 4. Règles financières et comptables | Q31 à Q37 (7) | 2 | 1 | 4 |
| 5. Clôture et suite | Q38 à Q41 (4) | 0 | 4 | 0 |
| 6. À faire de votre côté | C01 à C14 (14 actions) | | | |

Aucun point du registre n'est bloquant au sens du registre (classe BLOQUANT : aucun). Les questions ci-dessous sont celles qui **conditionnent le pilote** ou qui **ferment un chantier**.

## 1. Démarrer le pilote

Ces décisions conditionnent le premier jour chez GIC : le périmètre, les données de départ, les appareils et l’hébergement.

### Q01 — Comment démarrer chez GIC ?

*Avant le pilote · Registre : AV-001* — **Débloque** : Le calendrier, la formation et la reprise des données.

Le plan prévoit quatre mises en service. R1 : le magasin central, un point de vente et deux commerciaux. R2 : tous les points de vente de Douala. R3 : une ferme, puis toutes. R4 : les tableaux de la Direction et de la Finance. Kommo (R5) est reporté.

| Solution | Ce que ça change |
|---|---|
| **A ★** Par tranches, de R1 à R4 *(Plan actuel)* | On valide chaque tranche avant la suivante. Retour en arrière facile, formation étalée. C’est le plan actuel. |
| **B** Un seul point de vente d’abord | Un point de vente (par exemple Bonabéri) et le responsable commercial pendant 2 à 4 semaines, avant d’élargir. Le moins risqué ; peu de métiers couverts au début. |
| **C** Un point de vente et une ferme ensemble | Éprouve aussi la production dès le départ. Plus de formation en même temps. |
| **D** Tout en même temps | R1 à R4 le même jour. Le plus rapide sur le papier ; une erreur de données touche toute l’entreprise. |

★ **Pourquoi cette recommandation** : Le retour en arrière est facile et la formation s’étale ; les tranches suivent l’ordre dans lequel les phases ont été livrées.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q02 — Quand voulez-vous démarrer le pilote ?

*Avant le pilote* — **Débloque** : Le calendrier de tout le reste.

Aucune date n’est fixée. Elle dépend des préalables de la question 13 : données chargées, essais sur téléphone, formation. Pas de recommandation ici : c’est votre calendrier.

| Solution | Ce que ça change |
|---|---|
| **A** Dans les 2 semaines | Possible seulement si les données de départ et les essais sur téléphone sont prêts très vite. |
| **B** Dans le mois | Laisse le temps de charger les données, de compter le stock et de former les premiers utilisateurs. |
| **C** Dans 2 à 3 mois | Permet aussi d’obtenir l’avis du comptable et de traiter les points de la section « Finir le développement » avant. |
| **D** Sans date fixée | Le jour où les préalables cochés à la question 13 sont faits, vous décidez. |

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q03 — Quand le pilote est-il réussi ?

*Avant le pilote* — **Débloque** : Le passage de R1 à R2 : sans critère clair, un pilote ne finit jamais.

Proposition à valider, qui ne vient pas d’une source du cadrage : un critère simple, partagé avec l’équipe, avant d’étendre à tous les points de vente de Douala.

| Solution | Ce que ça change |
|---|---|
| **A ★** 2 semaines sans blocage, caisse et stock justes *(Court)* | Pendant 10 jours ouvrés : aucune vente perdue, la caisse et le stock du point de vente correspondent au comptage physique, les synchronisations passent. |
| **B** 1 mois complet avec une première clôture *(Long)* | Plus sûr pour la comptabilité : un mois fermé et rapproché. Retarde R2 d’au moins quatre semaines. |
| **C** À votre appréciation, sans critère chiffré | Souple, mais sans repère commun avec l’équipe ni avec la Direction. |

★ **Pourquoi cette recommandation** : Un critère court et mesurable évite un pilote sans fin sans retarder R2 d’un mois ; la première clôture mensuelle se vérifiera pendant R2.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

### Q04 — Qui charge les données de départ ?

*Avant le pilote · Registre : AV-072, AV-002* — **Débloque** : Les sites, le catalogue, les prix, les clients et les fournisseurs : sans données, rien ne se vend.

À charger : sites et zones, comptes, catalogue, prix, clients, fournisseurs, lots biologiques. Le stock d’ouverture, lui, se compte toujours sur place (question 5). Outils déjà prêts : écran Organisation, écran Comptes, écran « Charger des données » (fichiers CSV avec essai à blanc avant tout enregistrement).

| Solution | Ce que ça change |
|---|---|
| **A ★** GIC me donne ses fichiers, je prépare et je charge *(Moins de travail pour vous)* | Vous fournissez les classeurs Excel. Je prépare les fichiers, je fais l’essai à blanc, puis je charge en ligne avec votre accord à chaque chargement. Le moins de travail pour vous. |
| **B** Vous chargez vous-même | Avec l’écran « Charger des données ». Vous gardez la main ; prévoir une formation de 30 minutes et un guide. |
| **C** L’équipe GIC saisit écran par écran | Pour de petits volumes (quelques dizaines de produits ou de clients). Le plus lent pour l’historique. |
| **D** Mixte | Catalogue, prix et clients par fichier ; fournisseurs et lots saisis à l’écran par les responsables concernés. |

★ **Pourquoi cette recommandation** : C’est le chemin qui demande le moins de votre temps, et chaque chargement passe par un essai à blanc puis par votre accord.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q05 — Que faire des valeurs de départ de Bonabéri ?

*Avant le pilote · Registre : AV-500, AV-517* — **Débloque** : La valeur du stock et les marges du premier point de vente.

Le script d’initialisation de Bonabéri, dans le kit de mise en ligne, pose : le site et ses deux emplacements, cinq produits, cinq prix (3 500, 3 000, 2 500, 85 000 et 3 000 XAF), cinq comptes de trésorerie, le rôle de commercial sédentaire en portée globale pour le responsable commercial, et un stock d’ouverture de 15 000 unités de POULET-CHAIR et de 15 000 de POULET-VIF à 2 000 XAF (60 millions de XAF au total). Aucune de ces valeurs ne vient d’un document de GIC. On ne sait pas encore si le script a déjà tourné en ligne : je peux le vérifier en lecture seule si vous le permettez (question 12).

| Solution | Ce que ça change |
|---|---|
| **A ★** Recompter le stock, garder le reste une fois confirmé | Le stock d’ouverture se saisit avec les quantités réellement comptées, un seul produit par oiseau. Si un stock faux est déjà inscrit, il se corrige par un mouvement inverse : rien ne s’efface. |
| **B** Tout garder tel quel | Rapide, mais 60 M XAF de stock fausseraient la valeur du stock et les marges tant que ce n’est pas corrigé. |
| **C** Tout rouvrir, droits compris | Comme A, plus : vos vrais prix, vos vrais comptes de trésorerie, et le responsable commercial ramené à une portée de zone (moindre privilège) au lieu de globale. |

★ **Pourquoi cette recommandation** : Un stock inventé fausserait la valeur du stock et les marges dès le premier jour ; seul un comptage réel est fiable, et une correction se fait sans rien effacer.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

### Q06 — Quels téléphones pour le pilote ?

*Avant le pilote · Registre : AV-075* — **Débloque** : L’achat ou le choix des appareils, et la liste à essayer.

L’application est une PWA compilée pour des navigateurs récents ; aucune vérification de version, de mémoire ou de stockage n’est faite à l’exécution. La liste réelle des appareils du pilote est à relever dans votre liste « À faire de votre côté ».

| Solution | Ce que ça change |
|---|---|
| **A ★** Seuil actuel *(Plan actuel)* | Android 8 ou plus, Chrome 100 ou plus, 2 Go de RAM, 1 Go libre. Convient à un téléphone d’entrée de gamme récent. |
| **B** Seuil relevé *(Variante)* | Android 10 ou plus et 3 Go de RAM : plus fluide, mais exclut des téléphones bon marché que vos équipes ont peut-être déjà. |
| **C** Liste fermée des appareils du pilote | Seuls les modèles que vous me communiquez sont enrôlés et essayés un à un. Le plus sûr pour R1 ; à élargir ensuite. |
| **D** Ajouter l’iPhone *(Hors plan)* | Non essayé aujourd’hui : l’application est conçue pour Android et Chrome. À traiter comme un lot d’essais à part. |

★ **Pourquoi cette recommandation** : Le seuil actuel est celui sur lequel l’application a été conçue ; la liste précise des appareils du pilote se relève de toute façon (liste « À faire de votre côté »).

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q07 — Qui fait vivre l’outil après la fin du développement ?

*Avant la fin du développement · Registre : AV-084* — **Débloque** : Les mises en ligne, les sauvegardes, l’assistance et les correctifs.

L’architecture est dimensionnée pour une petite équipe (1 à 3 développeurs) et des services managés. Déjà en place : un kit de mise en ligne scripté avec sauvegarde avant chaque livraison et retour arrière automatique, et une alerte pour les tâches en échec.

| Solution | Ce que ça change |
|---|---|
| **A ★** Vous, avec des sessions Claude Code à la demande *(Pour le pilote)* | Situation actuelle : le kit est scripté. Désignez un remplaçant pour les mises en ligne et la lecture des alertes en votre absence. |
| **B** Vous et un développeur indépendant en soutien | Un contrat de maintenance pour les correctifs et les mises en ligne. Coût mensuel à définir avec la personne. |
| **C** Un prestataire assure l’exploitation | Contrat avec une agence : hébergement, supervision, correctifs. Coût et engagement les plus élevés ; vous gardez la décision métier. |
| **D** Un employé de GIC formé à l’exploitation | Administrateur technique interne : formation sur le kit, les sauvegardes et les alertes. Dépend d’une embauche ou d’un transfert de poste. |

★ **Pourquoi cette recommandation** : Le kit est scripté et revient seul en arrière en cas d’échec : une petite équipe suffit pour le pilote ; un soutien se décidera sur les premiers retours.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q08 — Sur quelle base de données tourne la production ?

*Avant le pilote · Registre : AV-485* — **Débloque** : La fiabilité des mises en ligne : un défaut propre au moteur ne se voit qu’en production.

L’application est développée et essayée sur MySQL 8.4 (plus de 2 500 essais du serveur). L’hébergement fournit MariaDB 11.8 avec un seul utilisateur de base. Une couche de compatibilité réécrit à l’exécution les deux constructions que MariaDB refuse, et un contrôle les rejoue sur la vraie base avant chaque redémarrage. Le 30/10/2026, la connexion est restée en erreur avant ce correctif.

| Solution | Ce que ça change |
|---|---|
| **A** Rester sur MariaDB mutualisée avec la couche de compatibilité *(Gratuit)* | Aucun coût. Les essais ne tournent pas sur MariaDB : un défaut propre à ce moteur peut n’apparaître qu’en ligne. |
| **B** Passer à une base MySQL 8.4 dédiée avant le pilote *(Coût à chiffrer)* | Même moteur que les essais. Coût mensuel à demander aux hébergeurs ; migration et recette ; plus d’exploitation (sauvegardes, mises à jour). |
| **C ★** Rester sur MariaDB et faire passer les essais sur MariaDB 11.8 *(Effort à chiffrer)* | Aucun coût récurrent. Un premier essai de la suite sur MariaDB chiffrera l’effort ; il demande d’installer MariaDB sur le poste de 8 Go (avec votre accord). Les futurs écarts se voient avant la mise en ligne. |
| **D** A pour le pilote R1, puis C avant R2 *(En deux temps)* | Met en ligne ce qui fonctionne maintenant et traite le risque avant l’extension. |

★ **Pourquoi cette recommandation** : Elle supprime le risque à la source, sans coût récurrent ni changement d’hébergeur ; son effort se chiffre par un premier essai de la suite sur MariaDB.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q09 — Où garder une copie des sauvegardes, hors de l’hébergement ?

*Avant le pilote · Registre : AV-523* — **Débloque** : La survie des données si l’hébergement perd la base.

Aujourd’hui : une sauvegarde est faite avant chaque livraison (cinq gardées). Le planning périodique (une copie tous les deux jours, cinq gardées) est installé sur le serveur, mais, d’après le dernier état connu (07/11), ses deux lignes ne sont pas créées dans hPanel. La copie hors hébergement existe (un script qui rapatrie, vérifie et garde les 30 plus récentes) mais n’est planifiée nulle part.

| Solution | Ce que ça change |
|---|---|
| **A ★** Sur votre PC, planifiée dans Windows *(Gratuit)* | Gratuit. Le PC doit être allumé et connecté ; chaque archive est vérifiée après copie. Un échec est visible dans le Planificateur de tâches. |
| **B** Vers un stockage cloud externe *(Coût et petit lot)* | Indépendant du PC. Il faut un compte, un coût mensuel et un petit lot de script ; la copie devrait être chiffrée. |
| **C** Les deux : PC et cloud | La plus sûre. Cumule l’effort de A et de B. |
| **D** Pas de copie hors hébergement | Si l’hébergeur perd la base et ses sauvegardes, tout est perdu. Déconseillé dès que la production a de vraies données. |

★ **Pourquoi cette recommandation** : Gratuite, vérifiée à chaque copie et suffisante pour un pilote ; le cloud se décidera avec la taille réelle de la base.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q10 — Que faire des photos jointes (réceptions, mortalité, justificatifs) ?

*Avant le pilote · Registre : AV-292, AV-091, AV-074* — **Débloque** : La preuve des pièces : photos conservées 5 ans selon la règle de conservation.

Les photos sont rangées sur le disque du serveur, hors base, et ne sont pas incluses dans les sauvegardes (décision du 07/11 pour limiter l’espace). Le registre estime environ 30 Go la première année. Chaque photo est recodée en JPEG léger sur le téléphone ; une photo par opération au plus.

| Solution | Ce que ça change |
|---|---|
| **A** Laisser ainsi pendant le pilote | Gratuit. Si le disque du serveur est perdu, les photos le sont aussi ; la base, elle, reste sauvegardée. |
| **B ★** Sauvegarder aussi le dossier des photos *(Petit lot)* | Évite la perte. Occupe de l’espace sur l’hébergement (quota à vérifier) et allonge la sauvegarde. Petit lot de script. |
| **C** Stockage objet externe (type Cloudflare R2 ou Backblaze B2) *(Lot moyen, coût)* | Prévu par la conception. Environ 30 Go la première année ; compte, coût mensuel et un lot de code pour brancher le stockage. |

★ **Pourquoi cette recommandation** : Les photos sont des preuves de réception et de mortalité : les perdre avec un disque est un risque évitable pour un petit lot de script.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

### Q11 — Un téléphone est-il lié au premier compte qui l’a connecté ?

*Avant le pilote · Registre : AV-296, AV-521* — **Débloque** : La règle « nul n’approuve l’appareil qu’il a connecté ».

Aujourd’hui, un compte peut se connecter sur un téléphone déjà connecté par quelqu’un d’autre et profite de son statut approuvé, sans gagner de droits. Un réglage, éteint par défaut, lie chaque téléphone non partagé à son premier utilisateur : un autre compte reçoit alors une demande d’enrôlement distincte, à approuver. Les tablettes partagées sont déclarées « partagées » par l’Admin.

| Solution | Ce que ça change |
|---|---|
| **A** Laisser libre (actuel) | Aucun changement. La règle d’approbation peut être contournée par un compte qui connaît l’identifiant d’un téléphone actif. |
| **B ★** Activer la liaison dès le pilote *(Réglage)* | Un téléphone non partagé reste lié à son premier compte. Réaffecter un téléphone passe par la désignation « partagé » ou par un retrait puis un nouvel enrôlement. Aucun code : un réglage. |
| **C** B, puis une clé d’appareil avant la production *(Lot moyen)* | Ajoute une clé cryptographique propre à chaque appareil : le plus sûr, lot de code moyen. |

★ **Pourquoi cette recommandation** : Corrige un contournement connu de la règle d’approbation sans écrire de code : c’est un réglage à activer avant le pilote, comme le registre le recommande.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

### Q12 — Autorisez-vous des lectures en ligne, en lecture seule ?

*Avant le pilote* — **Débloque** : Trois vérifications que je ne peux pas faire sans toucher à la production.

À chaque lecture de la production, j’ai besoin de votre accord. Trois lectures sont en attente : (1) le nombre de tâches du serveur en échec est de 24 depuis la mise en ligne du 08/11 (il valait 0 à tous les relevés jusqu’au 05/11) et sa cause n’est pas connue ; (2) savoir si le script de Bonabéri a déjà tourné ; (3) l’état de l’organisation en ligne (sites, zones). Les sorties sont masquées (ni mot de passe, ni jeton, ni e-mail, ni numéro) et le contenu des opérations n’est jamais lu.

| Solution | Ce que ça change |
|---|---|
| **A ★** Oui, ces trois lectures seulement | En lecture seule, sorties masquées. Je rends compte de ce que j’ai lu, sans rien modifier. |
| **B** Oui, mais seulement les tâches en échec | Les deux autres lectures attendent. Utile si vous voulez d’abord comprendre le point 1. |
| **C** Non, je lance moi-même les commandes | Je vous donne une commande à coller dans PowerShell et vous collez le résultat. Plus lent, sans accès de ma part. |
| **D** Plus tard | Rien n’est lu pour l’instant ; les trois points restent ouverts. |

★ **Pourquoi cette recommandation** : Lecture seule, sorties masquées, et vous gardez la liste des lectures permises ; c’est le plus rapide pour comprendre les 24 tâches en échec.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q13 — Que faut-il avoir fait avant le premier jour du pilote ?

*Avant le pilote* — **Débloque** : La définition de « prêt » : sans elle, la date de la question 2 ne veut rien dire.

Cochez ce qui doit être fait avant le premier jour. Ma recommandation coche l’essentiel ; la facture validée par le comptable et la marge d’un lot validée par la Direction peuvent attendre R2 et R4.

| Solution | Ce que ça change |
|---|---|
| **☐ ★** Essais sur téléphones réels | Les 9 scénarios du protocole d’essai (connexion, code PIN, vente en mode avion, synchronisation, photo, pointage, impression, thèmes clair et sombre). |
| **☐ ★** Formation courte par rôle | Des modules de 30 minutes au plus, orientés action, avec la fiche des cinq réflexes. |
| **☐ ★** Sauvegardes périodiques actives et copie hors hébergement | Les deux lignes cron dans hPanel et la tâche planifiée sur le PC (question 9). |
| **☐ ★** Essai de restauration réussi sur une vraie sauvegarde | Prouve que la sauvegarde sert à quelque chose. |
| **☐ ★** Catalogue et prix chargés et relus par GIC | Produits, unités, conditionnements, règles de prix. |
| **☐ ★** Stock d’ouverture compté à une date d’arrêt | Inventaire physique du magasin central et du point de vente du pilote. |
| **☐ ★** Motifs de départ validés avec GIC | Rejet à la réception, écart de prix, écart d’inventaire, écart de transfert : 24 motifs proposés par défaut. |
| **☐ ★** Comptes, rôles et appareils du pilote prêts | Comptes créés (dont la supervision consultative), appareils enrôlés et approuvés. |
| **☐ ★** Liaison appareil-compte activée | Si vous avez choisi B ou C à la question 11. |
| **☐ ★** Mots de passe de l’installation initiale changés | Ceux qui figurent dans les journaux de l’outil Antigravity. |
| **☐** Facture imprimée validée avec le comptable | Régime de TVA et mention d’exonération (question 31). Recommandé avant R2. |
| **☐** Marge d’un lot pilote validée par la Direction | Condition de clôture de la phase finance (P8). Recommandé avant R4. |

★ **Pourquoi cette recommandation** : Ces dix préalables couvrent ce qui peut mettre en danger le premier jour ; les deux autres dépendent de personnes extérieures et de phases suivantes.

**Réponse du porteur** : cochez ci-dessus. Précision : ____________

## 2. Finir le développement

Ce qui reste à construire, ou à écarter pour de bon. Chaque réponse « non » retire un chantier du plan.

### Q14 — Faut-il activer les notifications Web Push ?

*Avant la fin du développement · Registre : AV-365, AV-536* — **Débloque** : Un chantier à faire avec vos clés et un vrai téléphone.

Le serveur sait envoyer des notifications Web Push (chiffrement et signature conformes aux normes, prouvés par l’exemple officiel). Elles sont inactives en ligne : il manque les clés, que vous générez vous-même, et l’abonnement côté application, qu’on ne peut coder que devant un vrai téléphone. Sans Web Push, les alertes restent visibles dans l’application.

| Solution | Ce que ça change |
|---|---|
| **A** Activer avant le pilote *(Une session avec téléphone)* | Vous générez les clés (une commande), je les pose sur l’hébergement avec votre accord, puis on code l’abonnement de l’application et on teste sur un téléphone. Sur iPhone, le comportement reste à vérifier. |
| **B ★** Après le pilote | Le pilote montrera quelles alertes comptent vraiment avant de les pousser sur les téléphones. |
| **C** Jamais | Les alertes restent dans l’application. Le code d’envoi sort du périmètre. |

★ **Pourquoi cette recommandation** : Le pilote montrera quelles alertes comptent avant de les pousser sur les téléphones ; l’abonnement exige un vrai téléphone et vos clés.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

### Q15 — Plusieurs vendeurs partagent-ils une même tablette ?

*Avant la fin du développement · Registre : AV-522, AV-007* — **Débloque** : Un chantier de refonte du stockage local, qui exige une tablette réelle.

Aujourd’hui : un code PIN par utilisateur et les données locales sont effacées au changement d’utilisateur. Il n’y a pas de bascule rapide entre deux vendeurs, y compris hors ligne. La construire suppose une base locale par utilisateur, un sélecteur de compte et un essai sur tablette.

| Solution | Ce que ça change |
|---|---|
| **A ★** Non : un appareil par vendeur pendant le pilote | Rien à coder. Chaque vendeur a son téléphone, ou la tablette est affectée à un poste. |
| **B** Oui, mais après le pilote *(Gros lot)* | Phase dédiée avec une décision d’architecture écrite et un essai sur tablette réelle. |
| **C** Oui, dès le pilote *(Gros lot, bloque R1)* | Même chantier, mais le pilote attend qu’il soit livré et essayé. |
| **D** Un compte « point de vente » commun | Simple, mais on perd la traçabilité par vendeur (caisse, écarts). Déconseillé. |

★ **Pourquoi cette recommandation** : Évite le plus gros chantier de stockage local avant d’avoir vu si le partage de tablette existe vraiment chez GIC.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q16 — La Direction et la Finance cherchent-elles les clients hors ligne ?

*Avant la fin du développement · Registre : AV-522* — **Débloque** : Le protocole de synchronisation et l’exposition de la base clients sur un téléphone.

Aujourd’hui, un appareil ne reçoit que les clients de son titulaire, de ses équipes et de son site. Les appareils de la Direction et de la Finance cherchent les clients en ligne. Leur donner toute la base (environ 20 000 clients selon l’hypothèse de volume) change le protocole de synchronisation et expose toute la base si un téléphone est perdu.

| Solution | Ce que ça change |
|---|---|
| **A ★** Non : la recherche reste en ligne | Rien à coder. Ces rôles ont de la connexion au bureau. |
| **B** Oui, toute la base hors ligne *(Gros lot)* | Audience de plus par compte, plafond de volume, instantané paginé, mesure sur 20 000 clients. Lot grand. |
| **C** Oui, un résumé seulement *(Variante, lot moyen)* | Nom, téléphone et solde. Moins lourd et moins exposé ; nouveau jeu de données à concevoir. |

★ **Pourquoi cette recommandation** : Exposer une base de 20 000 clients sur le téléphone de la Direction ou de la Finance n’est pas justifié tant que la recherche en ligne suffit.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

### Q17 — Qui fixe l’objectif d’un site ?

*Avant la fin du développement · Registre : AV-522* — **Débloque** : Les objectifs de site (seconde partie des objectifs de l’équipe).

Les objectifs individuels, d’équipe et de zone existent. Pour un site, la question métier n’est pas tranchée.

| Solution | Ce que ça change |
|---|---|
| **A ★** La Direction pour les sites ; le responsable commercial pour les zones et les équipes | C’est le défaut proposé. |
| **B** Le responsable commercial pour tout | Plus simple, mais il fixe aussi les objectifs des sites qu’il ne dirige pas. |
| **C** Le responsable de chaque site fixe le sien | Au plus près du terrain ; risque d’objectifs trop bas sans validation. |
| **D** Pas d’objectif de site pendant le pilote | On suit les objectifs individuels, d’équipe et de zone seulement. |

★ **Pourquoi cette recommandation** : Sépare la fixation des objectifs de site (une décision de direction) de celle des zones et des équipes (un travail de terrain).

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q18 — Faut-il un registre des carnets de papier tenu par le serveur ?

*Avant la fin du développement · Registre : AV-308, AV-312, AV-501* — **Débloque** : Le contrôle central de la continuité des numéros de carnets, site par site.

Aujourd’hui, chaque appareil contrôle les numéros qu’il connaît : numéros manquants, doublons, saut annoncé à la saisie. Le suivi par site pour la Finance et les responsables exige une colonne dédiée « numéro de pièce » sur chaque table d’opération concernée (une dizaine, avec migrations, contrats, jeux hors ligne et écrans).

| Solution | Ce que ça change |
|---|---|
| **A ★** Garder le contrôle sur l’appareil pour le pilote | On décidera d’après l’usage réel du papier. Rien à coder. |
| **B** Colonne dédiée sur toutes les tables, puis registre par site *(Lot moyen à grand)* | Couverture complète. Lot moyen à grand. |
| **C** Colonne dédiée seulement sur les opérations d’argent *(Lot moyen)* | Vente, encaissement, dépense, remise de fonds : couvre le risque principal pour un lot plus petit. |
| **D** Abandonner le registre côté serveur | Le papier n’est qu’un secours ; les pièces reportées n’ont pas de contrôle central. |

★ **Pourquoi cette recommandation** : Le pilote dira si le papier est un secours ou un usage courant, avant d’investir dans une dizaine de tables.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q19 — Quand mesurer la performance et la charge ?

*Avant la fin du développement · Registre : AV-086, AV-386* — **Débloque** : Une garantie que la base tiendra la taille visée (environ 150 utilisateurs, 5 000 lignes de vente par jour).

Jamais mesurés : le délai entre un événement et l’alerte qui en découle (objectif : 95 % en moins de 10 secondes), les plans d’exécution des requêtes et un essai de charge. Environ une semaine de travail.

| Solution | Ce que ça change |
|---|---|
| **A** Avant le pilote | Rassurant avant d’ouvrir, mais retarde le pilote d’une semaine pour un volume que le pilote n’atteindra pas. |
| **B ★** Pendant et après les premiers retours du pilote | On mesure avec de vraies données et de vrais volumes. C’est l’ordre prévu par le plan. |
| **C** Seulement si des lenteurs apparaissent | Aucune dépense tant que tout va bien ; le risque est de découvrir un problème en pleine charge. |
| **D** Jamais | Retire ce chantier du plan. |

★ **Pourquoi cette recommandation** : Les volumes visés ne seront pas atteints en pilote ; mesurer sur de vraies données est plus fiable qu’un essai artificiel.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q20 — Quelles fonctions hors périmètre voulez-vous quand même ajouter ?

*Avant la fin du développement · Registre : AV-029, AV-020, AV-085, AV-076* — **Débloque** : Le périmètre final : chaque ajout rouvre un chantier.

Quatre fonctions sont volontairement hors du premier périmètre. Cochez celles que vous voulez avant la clôture du développement ; ne rien cocher les confirme toutes hors périmètre.

| Solution | Ce que ça change |
|---|---|
| **☐** Retours clients | Aujourd’hui une erreur se corrige par une annulation encadrée. Un retour de marchandise après la vente n’a pas d’écran propre ; le modèle est prévu pour plus tard. |
| **☐** Commissions commerciales | L’attribution de la vente est figée sur chaque vente, ce qui permettra un calcul plus tard ; aucun état de commissions n’existe. |
| **☐** Frais de livraison facturés | Possible aujourd’hui avec un produit de type service ajouté à la vente ; pas de gestion dédiée. |
| **☐** Reçu imprimé au point de vente | Reçu affiché à l’écran et partageable ; pas d’imprimante thermique. Demande un modèle d’imprimante et des essais. |
| **☐ ★** Aucune : elles restent hors périmètre | Le développement se clôt sans ces quatre fonctions ; elles pourront être demandées plus tard comme de nouveaux projets. |

★ **Pourquoi cette recommandation** : Chaque ajout rouvre un chantier ; aucune de ces fonctions n’est nécessaire pour vendre, livrer, encaisser et suivre.

**Réponse du porteur** : cochez ci-dessus. Précision : ____________

### Q21 — Que devient l’intégration Kommo ?

*Avant la fin du développement · Registre : AV-068, AV-069* — **Débloque** : Les points Kommo encore ouverts du registre.

Décision du 26/10/2026 : pas d’abonnement Kommo faute de moyens ; le CRM est entièrement géré dans GIC. La phase est reportée, pas retirée.

| Solution | Ce que ça change |
|---|---|
| **A ★** La retirer du projet | Le CRM reste dans GIC. Les points Kommo ouverts sont clos. On pourra la reprendre plus tard comme un nouveau projet. |
| **B** La laisser reportée, sans date | Statut actuel : les points restent ouverts dans le registre. |
| **C** La planifier après le pilote | Si GIC prend un abonnement. Il faudrait d’abord vérifier les capacités du compte réel (API, webhooks, champs). |

★ **Pourquoi cette recommandation** : Sans abonnement la phase ne peut pas avancer ; la retirer ferme les points Kommo ouverts et clarifie le périmètre.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

### Q22 — L’application sera-t-elle bilingue ?

*Avant la fin du développement · Registre : AV-079* — **Débloque** : La traduction éventuelle de plus de 4 000 lignes de libellés.

Aujourd’hui l’interface est en français ; la structure est prête pour l’anglais.

| Solution | Ce que ça change |
|---|---|
| **A ★** Français seulement | Rien à faire. Les pièces papier et la formation sont en français. |
| **B** Ajouter l’anglais avant le pilote *(Gros lot)* | Traduire et relire plus de 4 000 lignes de libellés, puis vérifier les mises en page (textes plus longs). |
| **C** Ajouter l’anglais après le pilote | Si des utilisateurs le demandent. Même travail, plus tard. |

★ **Pourquoi cette recommandation** : Les pièces papier, la formation et les utilisateurs sont en français ; l’anglais demande de traduire plus de 4 000 lignes.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

## 3. Droits et sécurité

Qui peut faire quoi, comment on se connecte, et les choix techniques où je recommande une solution.

### Q23 — Qui peut saisir une pièce de plus de 72 heures ?

*Avant le pilote · Registre : AV-528, AV-317, AV-531* — **Débloque** : Le chargement de l’historique des pièces papier.

Une pièce saisie avec une date de plus de 24 heures demande un motif ; au-delà de 72 heures, elle est refusée, sauf à qui détient un droit spécial. Ce droit est aujourd’hui à la Direction, à l’Admin et à la Finance. Un compte à rôle unique opérationnel (vendeur, magasinier, responsable de ferme) ne peut donc pas reporter une pièce plus ancienne ; seuls les comptes qui cumulent le droit métier et ce droit le peuvent, comme le vôtre.

| Solution | Ce que ça change |
|---|---|
| **A** Ne rien changer | Les chargements d’historique passent par vos comptes ou ceux de la Direction. Aucun risque supplémentaire d’antidatage. |
| **B** Donner le droit aux rôles opérationnels qui reportent des pièces | Pratique au quotidien. Plus de risque d’antidatage : le motif reste obligatoire et audité. |
| **C ★** Un compte de reprise temporaire *(Recommandé)* | Un compte aux rôles cumulés et avec le droit, ouvert le temps du chargement de l’historique, puis fermé. Le travail quotidien reste limité à 72 heures. |
| **D** Allonger la fenêtre à 7 jours pour tous | Un réglage. Assouplit la garde pour tout le monde, tout le temps. |

★ **Pourquoi cette recommandation** : Concentre le risque d’antidatage sur une période et un compte, sans élargir les droits du quotidien.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q24 — Chaque téléphone doit-il connaître tous les rôles de l’entreprise ?

*Avant la fin du développement · Registre : AV-533* — **Débloque** : L’exposition de l’organisation des droits sur un téléphone perdu.

Aujourd’hui, tous les appareils reçoivent la liste des affectations de rôles (qui a un rôle, sur quel périmètre), sans le code du rôle. L’appareil n’en utilise que celles de son propre utilisateur, pour limiter les zones proposées. La liste complète est servie par la ligne globale du pipeline.

| Solution | Ce que ça change |
|---|---|
| **A ★** Restreindre aux affectations de l’utilisateur *(Petit lot)* | Un téléphone perdu n’expose plus l’organisation des droits. Petit lot : projection de synchronisation et essais. |
| **B** Laisser tel quel | Aucun code ; la liste reste sur chaque appareil. |
| **C** Supprimer le jeu et lire les rôles dans le profil *(Lot moyen)* | Le plus strict : l’appareil lit ses rôles dans le profil de connexion. À vérifier : ce que l’écran des zones propose hors ligne. |

★ **Pourquoi cette recommandation** : L’appareil n’utilise déjà que les affectations de son propre utilisateur : le reste est exposé sans servir.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

### Q25 — La Direction peut-elle approuver ses propres demandes ?

*Avant le pilote · Registre : AV-010, AV-529* — **Débloque** : La séparation des tâches, avec le nouveau rôle de supervision consultative.

Règle actuelle : le déclarant ne peut pas approuver sa propre opération ; l’Admin n’approuve aucune opération métier ; seule la Direction peut s’auto-approuver, avec le marqueur « auto-approuvé » dans l’audit (petite structure). Le rôle de supervision consultative lit tout le journal d’audit, marqueurs compris, mais ne valide rien.

| Solution | Ce que ça change |
|---|---|
| **A ★** Garder la règle actuelle | La Direction s’auto-approuve, la supervision relit l’audit après coup. Aucun code. |
| **B** Interdire toute auto-approbation, même à la Direction | Un second valideur est obligatoire. Impossible tant que la Direction n’a qu’un titulaire : il faudrait un second compte Direction. |
| **C** Autoriser, mais avertir la supervision à chaque fois *(Petit lot)* | La personne de supervision reçoit une alerte à chaque auto-approbation. Petit lot (alerte et destinataire). |
| **D** Autoriser sous un plafond, second valideur au-delà *(Lot moyen)* | Un plafond de montant à fixer ; au-delà, une deuxième personne. Lot moyen. |

★ **Pourquoi cette recommandation** : Convient à une petite structure : l’audit garde le marqueur et la supervision relit tout ; une alerte à la supervision pourra s’ajouter plus tard.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q26 — Faut-il une double authentification ?

*Avant la fin du développement · Registre : AV-008* — **Débloque** : La protection des comptes à données financières.

Aujourd’hui : le numéro de téléphone ou l’adresse e-mail et un mot de passe, plus un code PIN local pour déverrouiller l’appareil. Pas de code SMS. Cinq essais ratés bloquent la connexion pendant 1, 5 puis 15 minutes.

| Solution | Ce que ça change |
|---|---|
| **A ★** Garder la connexion actuelle pour le pilote | Aucun coût. À réexaminer avant la production. |
| **B** Code SMS pour tous *(Coût et lot moyen)* | Un coût par SMS, la dépendance à l’opérateur et un lot de code. Les zones à mauvais réseau seront gênées. |
| **C** Double authentification seulement pour Direction, Admin et Finance *(Lot moyen)* | Protège les comptes sensibles pour un coût limité ; lot moyen. |
| **D** Mot de passe plus long pour les rôles sensibles *(Petit lot)* | Douze caractères au moins, sans SMS. Petit lot, protection limitée. |

★ **Pourquoi cette recommandation** : Le pilote ouvre peu de comptes sensibles ; la double authentification se décidera avant la production, avec le coût d’un fournisseur de SMS.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q27 — Combien de temps un téléphone peut-il travailler sans se synchroniser ?

*Peut attendre le pilote · Registre : AV-009, AV-242* — **Débloque** : L’équilibre entre continuité d’activité et risque d’un appareil perdu ou d’un utilisateur révoqué.

Réglage actuel : 168 heures (7 jours). Un bandeau d’avertissement apparaît dès 48 heures ; au-delà de 7 jours, l’application passe en lecture seule et exige une reconnexion.

| Solution | Ce que ça change |
|---|---|
| **A ★** 7 jours *(Actuel)* | Le réglage actuel. Couvre une semaine sans réseau. |
| **B** 72 heures | Plus prudent : un téléphone perdu reste utilisable moins longtemps. |
| **C** 14 jours | Pour des zones à très mauvaise couverture. Augmente le risque d’un appareil non surveillé. |
| **D** Sans limite | Aucune coupure. Déconseillé : un utilisateur révoqué continuerait de saisir. |

★ **Pourquoi cette recommandation** : Sept jours couvrent une semaine sans réseau avec un avertissement dès 48 heures ; c’est le réglage conçu avec le risque d’appareil perdu.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q28 — Les droits des rôles sont-ils modifiables dans l’application ?

*Peut attendre le pilote · Registre : AV-257, AV-092* — **Débloque** : La gouvernance des droits et l’audit renforcé de certaines permissions.

Aujourd’hui, les douze rôles système sont figés par un jeu de départ versionné ; l’Admin affecte des rôles à des personnes mais ne modifie pas leurs droits. Aucune permission n’est marquée « sensible » (audit renforcé et revue d’attribution périodique).

| Solution | Ce que ça change |
|---|---|
| **A ★** Rôles figés, aucune permission sensible désignée | Le plus simple pour le pilote. À réexaminer avant la production. |
| **B** Rôles figés, permissions financières désignées sensibles *(Lot moyen)* | Valorisation du stock, finance et remises de prix. Le mécanisme de revue périodique reste à spécifier. |
| **C** Permissions modifiables par l’Admin dans l’application *(Gros lot)* | Plus souple, mais les droits peuvent dériver sans trace claire. Gros lot. |

★ **Pourquoi cette recommandation** : Évite de figer une liste de permissions sensibles qu’aucune source ne demande ; le mécanisme de revue reste à spécifier.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

### Q29 — Choix techniques de synchronisation : suivez-vous mes recommandations ?

*Avant la fin du développement · Registre : AV-533, AV-534* — **Débloque** : Quatre points que le registre laisse à votre confirmation.

Mes recommandations. (1) Une commande renvoyée avec un autre drapeau « saisie hors ligne » est refusée : ne rien changer pour le pilote, le cas est rare. (2) L’annulation d’une demande de transfert par le magasinier de la source : oui, déjà en place. (3) Hors ligne, une consommation d’un produit non consommable ou un motif sans commentaire : avertir au lieu de refuser, un fait accompli ne se refuse pas. (4) Deux nouveaux codes de protocole (délai de lot dépassé, commande en cours) : pas avant le pilote.

| Solution | Ce que ça change |
|---|---|
| **A ★** Oui, les quatre | Aucun code supplémentaire avant le pilote. |
| **B** Oui, sauf un ou plusieurs points | Écrivez les numéros à changer et ce que vous voulez à la place. |
| **C** Je veux en discuter point par point | On les reprend un par un avant d’en décider. |

★ **Pourquoi cette recommandation** : Ces quatre choix ne changent aucun comportement du pilote ; les alternatives touchent à l’idempotence ou au protocole et ne se justifient que par un cas réel.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

### Q30 — Affichage, indicateurs et alertes : suivez-vous mes recommandations ?

*Peut attendre le pilote · Registre : AV-473, AV-486, AV-487, AV-488, AV-496* — **Débloque** : Une vingtaine de petits points déjà mis en œuvre à la valeur recommandée.

Mes recommandations. Indicateurs de la Direction (atteinte d’objectif, poids moyen, coût par tête, opérations en attente) et alerte « tâche en échec » : garder les définitions en place (douze points). Éditeur de règle de prix : montrer l’erreur après une saisie, pas à l’ouverture. Trésorerie : lire le total du serveur dans les deux écrans, après la réponse de la Finance sur les comptes inactifs. Bouton de la fiche de suivi de la semaine : le reprendre avec le prochain lot des pièces. Paramètres : validation par le serveur avant le pilote.

| Solution | Ce que ça change |
|---|---|
| **A ★** Oui, toutes | Les points déjà au défaut sont clos ; trois petits lots de l’application suivent. |
| **B** Oui, sauf certains | Écrivez les numéros d’AV à changer. |
| **C** Les passer en revue avec moi | Un par un, avec les alternatives. |

★ **Pourquoi cette recommandation** : Ce sont des définitions d’indicateurs et de petits conforts d’écran, déjà mis en œuvre à la valeur recommandée.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

## 4. Règles financières et comptables

Facture, valorisation du stock, seuils d’argent. Plusieurs points demandent l’avis de votre comptable : je ne donne pas d’avis fiscal.

### Q31 — Que doit porter la facture imprimée : TVA et mention d’exonération ?

*Avant le pilote · Registre : AV-451, AV-041* — **Débloque** : L’impression de la facture à l’identique du modèle validé par le comptable.

La facture est imprimée par l’application dans le modèle de votre comptable. Les prix sont toutes taxes comprises, avec une TVA à 0. Le modèle a deux rubriques : « Régime TVA » et « Mention d’exonération ». Je ne peux pas dire quel régime s’applique à GIC : c’est une question pour votre comptable. Le mécanisme est prêt ; il lui manque votre réponse.

| Solution | Ce que ça change |
|---|---|
| **A ★** Attendre le comptable *(Aucun code)* | Les deux rubriques restent en pointillés, à remplir à la main. Aucun code. Rien ne change tant que le comptable n’a pas répondu. |
| **B** Non assujetti ou exonéré, avec une mention fixe *(Réglage)* | Régime coché et mention écrite, tous deux dans les réglages de la société. Aucun code ; le régime et la mention exacts viennent du comptable. |
| **C** Assujetti, avec calcul de la TVA sur les lignes *(Gros lot)* | Nouveau lot : prix hors taxes, TVA et prix TTC, taux à fournir, arrondis, états de TVA. Touche les ventes, les factures et les marges. |
| **D** TVA différente selon le produit *(Gros lot)* | Certains produits exonérés, d’autres taxés. Plus complexe que C. |

★ **Pourquoi cette recommandation** : Je ne donne pas d’avis fiscal ; le mécanisme est prêt et attend la réponse du comptable, sans bloquer le pilote.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q32 — Comment valoriser le stock ?

*Avant la fin du développement · Registre : AV-042* — **Débloque** : Le coût des ventes et les marges.

Méthode en place : coût moyen unitaire pondéré (CMUP) perpétuel par produit, recalculé à chaque entrée valorisée. Pour les produits biologiques issus d’un lot, le coût unitaire est le coût cumulé du lot divisé par l’effectif vivant. Changer de méthode plus tard est un gros chantier : à ne faire que pour une raison comptable.

| Solution | Ce que ça change |
|---|---|
| **A ★** Coût moyen pondéré (CMUP) *(En place)* | La méthode en place (ADR-015). Aucun changement. |
| **B** Premier entré, premier sorti (FIFO) *(Gros lot)* | Plus proche du flux physique, plus de calculs et de reprises ; change le cœur du registre de stock. |
| **C** Coût standard *(Gros lot)* | Marge simple à lire, mais il faut suivre les écarts de coût en plus. |

★ **Pourquoi cette recommandation** : La méthode est en place et éprouvée ; en changer est un gros chantier qui ne se justifie que par une exigence comptable.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

### Q33 — Faut-il verrouiller les mois clôturés ?

*Peut attendre le pilote · Registre : AV-088* — **Débloque** : L’interdiction d’écrire dans une période close.

Aujourd’hui rien ne verrouille un mois. La fenêtre de saisie rétroactive, l’immuabilité des sessions de caisse validées et les contre-écritures datées suffisent au démarrage.

| Solution | Ce que ça change |
|---|---|
| **A ★** Pas de verrouillage au démarrage | Suffisant tant qu’il n’y a pas d’intégration comptable. |
| **B** Verrouillage mensuel par la Finance *(Lot moyen)* | Les écritures tardives sont redatées au premier jour de la période ouverte. Lot moyen. |
| **C** Verrouillage avec dérogation de la Direction *(Lot moyen)* | Comme B, avec une porte de sortie tracée. Lot moyen. |

★ **Pourquoi cette recommandation** : Sans intégration comptable, la fenêtre de saisie rétroactive et les contre-écritures suffisent ; le verrouillage viendra avec l’export comptable.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

### Q34 — Que livrer à votre comptable ?

*Peut attendre le pilote · Registre : AV-059* — **Débloque** : La remise des chiffres au comptable en fin de mois.

Hors du premier périmètre. L’explorateur permet déjà des exports CSV et XLSX tracés (ventes, encaissements, achats, dépenses, paiements). Le référentiel comptable (SYSCOHADA) reste à confirmer avec le comptable.

| Solution | Ce que ça change |
|---|---|
| **A ★** Les exports de l’explorateur suffisent | Rien à coder. |
| **B** Un lot d’exports mensuels pour le comptable *(Petit lot)* | Mêmes données, mises en forme chaque mois et nommées. Petit lot. |
| **C** Des écritures comptables au référentiel SYSCOHADA *(Gros lot)* | Plan comptable à fournir par le comptable. Gros lot, dépend de lui. |

★ **Pourquoi cette recommandation** : Les exports de l’explorateur existent déjà ; un format précis dépend du logiciel du comptable, qu’on ne connaît pas.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

### Q35 — Les seuils d’argent par défaut vous conviennent-ils ?

*Avant le pilote · Registre : AV-051, AV-037, AV-039, AV-263, AV-266* — **Débloque** : Ce qui demande une validation ou une photo au quotidien.

Valeurs actuelles (toutes réglables dans l’écran des paramètres) : dépense à valider à partir de 50 000 XAF, photo de dépense à partir de 10 000 XAF, petite dépense de caisse de point de vente plafonnée à 50 000 XAF ; bon de commande approuvé par la Direction à partir de 500 000 XAF ; paiement fournisseur à valider à partir de 500 000 XAF ; photo de réception demandée à partir de 100 000 XAF ; perte (casse, détérioration, produit impropre) à valider à partir de 25 000 XAF et inventaire dont l’écart dépasse 25 000 XAF ; alerte de perte élevée à 50 000 XAF ; alerte d’encaisse élevée à partir de 200 000 XAF ; écart de caisse critique à 10 000 XAF.

| Solution | Ce que ça change |
|---|---|
| **A ★** Garder ces montants pour le pilote | On les ajuste d’après les premiers cas réels. |
| **B** Plus stricts : la moitié pendant le pilote | Plus de validations, donc plus de dérangement pour la Direction. |
| **C** Plus souples : le double | Moins de validations ; un risque plus grand passe sans contrôle. |
| **D** Mes propres montants | Écrivez-les dans la zone de précision ; je les règle ensuite. |

★ **Pourquoi cette recommandation** : Ce sont des valeurs de cadrage ; les premiers cas réels diront lesquelles sont trop strictes ou trop souples, et elles se règlent sans code.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q36 — Combien de temps conserver les données ?

*Peut attendre le pilote · Registre : AV-074* — **Débloque** : Une obligation légale et comptable, et la vie privée des commerciaux.

Défaut en place : journal d’audit et pièces financières 10 ans, positions GPS 2 ans, photos 5 ans. Les durées légales exactes sont une question pour votre comptable ou un juriste.

| Solution | Ce que ça change |
|---|---|
| **A ★** Garder ces durées | 10 ans, 2 ans, 5 ans. À confirmer avec le comptable. |
| **B** Raccourcir les positions GPS | Par exemple 6 à 12 mois, pour mieux protéger la vie privée des commerciaux ; le reste ne change pas. |
| **C** Tout garder sans limite | Simple, mais la base grossit sans fin. |
| **D** Je consulte le comptable ou un juriste avant | Les durées restent celles de A en attendant. |

★ **Pourquoi cette recommandation** : Ce sont des durées de prudence qu’il faut faire confirmer par le comptable ; elles se règlent sans code.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ D  ☐ autre : ____________

### Q37 — À quoi sert la présence du personnel ?

*Peut attendre le pilote · Registre : AV-313, AV-514* — **Débloque** : L’usage des feuilles de présence des ouvriers et du personnel administratif.

La présence se reporte chaque semaine depuis la fiche papier. Usage en place : statistique et suivi, ni paie ni discipline. Elle n’entre pas dans les indicateurs de présence des commerciaux.

| Solution | Ce que ça change |
|---|---|
| **A ★** Statistique et suivi seulement *(En place)* | Aucun lien avec la paie ni avec la discipline. Le choix le moins sensible. |
| **B** Aussi comme base de paie *(Gros lot)* | Heures et jours servent à calculer la paie. Demande des contrôles plus stricts et un état de paie. |
| **C** Aussi pour la discipline | Retards et absences peuvent être invoqués. Demande l’avis d’un juriste. |

★ **Pourquoi cette recommandation** : Le choix le moins sensible : aucun lien avec la paie ni la discipline, donc pas d’avis juridique à demander.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

## 5. Clôture et suite

Quand le développement est-il terminé, comment j’applique vos réponses, et que faire des autres points ouverts du registre.

### Q38 — Quand le développement est-il terminé ?

*Avant la fin du développement* — **Débloque** : La fin du plan et le début de la maintenance.

Le plan définit « terminé » ainsi : périmètre livré (hors Kommo), quatre mises en service avec leurs vraies données, recette acceptée par la Direction, décisions ouvertes tranchées ou explicitement laissées à leur défaut.

| Solution | Ce que ça change |
|---|---|
| **A ★** Au démarrage réussi du pilote | Quand R1 a démarré et que ses deux premières semaines se sont passées sans blocage. Ensuite : maintenance, correctifs et nouveautés sur demande ponctuelle. |
| **B** À la définition du plan | R1 à R4 en service avec les vraies données et la recette de la Direction. Garde le développement ouvert pendant tous les déploiements. |
| **C** Dès que vos réponses sont appliquées | Le code s’arrête après ce questionnaire. Tout le reste devient de la maintenance sur demande. |

★ **Pourquoi cette recommandation** : Donne un point d’arrivée daté et vérifiable ; le plan complet (R1 à R4) se poursuit ensuite en maintenance.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

### Q39 — Comment appliquer vos réponses ?

*Avant la fin du développement* — **Débloque** : La méthode de travail.

Vos réponses changeront des réglages, du code, des documents et le registre des décisions. Je les consigne d’abord dans le journal du registre, puis je les applique.

| Solution | Ce que ça change |
|---|---|
| **A ★** En un seul chantier, séquentiel | Je code toutes les décisions, je fais une seule vérification complète, puis je vous donne un récapitulatif. |
| **B** Lot par lot, avec un point après chaque lot | Plus de contrôle pour vous, plus d’allers-retours. |
| **C** Je consigne seulement, j’attends votre « go » pour coder | Rien ne change dans le code avant votre accord explicite. |

★ **Pourquoi cette recommandation** : C’est la méthode qui limite les erreurs : tout coder, une seule vérification complète, puis le récapitulatif.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

### Q40 — Que faire des 346 autres points ouverts ?

*Avant la fin du développement* — **Débloque** : La clôture du registre des décisions.

Le registre compte 403 points ouverts. Aucun n’est bloquant : chacun a un défaut paramétrable déjà en place. Les questions ci-dessus en traitent 57 ; les 346 autres sont classés par domaine à la question suivante. La définition du plan accepte « tranché ou explicitement laissé à son défaut ».

| Solution | Ce que ça change |
|---|---|
| **A ★** Les laisser à leur défaut et les revoir après 4 semaines de pilote | Le registre est clos pour la fin du développement. Les défauts sont ceux du pilote ; la revue se fait sur des faits réels. |
| **B** Les laisser à leur défaut, sauf les domaines que je coche à la question 41 | Vous gardez la main sur les domaines qui vous préoccupent. |
| **C** Les revoir tous un par un avant le pilote *(Long)* | Plusieurs sessions ; retarde le pilote. |

★ **Pourquoi cette recommandation** : Aucun point n’est bloquant et chacun a un défaut en place ; une revue sur de vrais faits sera plus utile qu’une revue sur des hypothèses.

**Réponse du porteur** : ☐ A  ☐ B  ☐ C  ☐ autre : ____________

### Q41 — Quels domaines voulez-vous revoir en détail ?

*Avant la fin du développement* — **Débloque** : Les points ouverts non traités par les questions précédentes.

Utile si vous avez choisi B à la question 40. Chaque domaine montre les règles par défaut en place et la liste de ses points ouverts.

| Domaine | Points ouverts | Règles par défaut en place |
|---|---|---|
| **identite** Identité, appareils et synchronisation | 37 | Connexion par téléphone ou adresse e-mail et mot de passe, code PIN local ; cinq essais ratés bloquent la connexion 1, 5 puis 15 minutes (AV-008, AV-297). ; Un nouvel appareil attend l’approbation de l’Admin ou du responsable de son site ou de son équipe ; nul n’approuve l’appareil qu’il a connecté (AV-006, AV-258, tranchés). ; Un compte ou un appareil bloqué est coupé immédiatement (AV-282, tranché). ; Un fait saisi hors ligne n’est jamais refusé pour une raison d’état métier : il est appliqué et, au besoin, signalé en conflit. ; Saisie rétroactive : motif au-delà de 24 heures, refus au-delà de 72 heures sauf droit spécial (AV-528, question 23). ; Un compte suspendu puis réactivé : ses faits datés de la période de suspension sont mis en quarantaine (AV-229). |
| **catalogue-stock** Catalogue, prix et stock | 8 | Une règle de prix est créée en brouillon par le responsable commercial ou la Direction ; seule la Direction l’active (AV-062). ; Montant de ligne arrondi au franc, le total est la somme des lignes (AV-060). ; Lot obligatoire pour les animaux vivants, suivi automatiquement jusqu’à la vente (AV-036). ; Pertes : validation à partir de 25 000 XAF pour casse, détérioration et produit impropre, toujours pour destruction, perte inexpliquée et vol suspecté ; photo exigée seulement pour la mortalité (AV-037, AV-288). ; Inventaire complet mensuel recommandé ; un écart de plus de 25 000 XAF est validé (AV-039). ; Seuils de réapprovisionnement : aucun par défaut, à saisir par emplacement et produit (AV-040). |
| **clients-ventes** Clients, terrain et ventes | 36 | Un prospect devient client à la première vente confirmée, automatiquement (AV-012). ; Doublon contrôlé par téléphone normalisé, message neutre « déjà suivi par un autre commercial » (AV-014). ; Réaffectation par le responsable commercial ou la Direction ; l’acquéreur ne change jamais (AV-015). ; Pointage hors zone : refus avec demande de dérogation validée (AV-021). ; Aucune session de travail obligatoire ; clôture automatique à 23 h 59 (AV-023). Client inactif : aucune vente depuis 30 jours (AV-013). ; Vente anonyme seulement si payée en entier ; crédit aux clients autorisés dans leur plafond ; une commande n’est jamais bloquée par l’argent, la livraison l’est (AV-027, AV-028, AV-511, AV-512, tranchés). ; Argent d’une vente annulée : celui qui annule choisit remboursement ou crédit client (AV-146). |
| **distribution** Distribution, caisse et quotas | 80 | Vendre ne dépend pas d’une caisse ouverte ; les sorties d’espèces (dépense, paiement fournisseur) l’exigent (AV-509, AV-510, tranchés). ; Session de caisse : ouverture, clôture comptée, écart validé (AV-057). ; Quotas d’appareil accordés explicitement par le magasinier ou le responsable du point de vente ; un emplacement exclusif est entièrement alloué à son titulaire (AV-035). ; Remise de fonds : envoi, réception, écart décidé par une personne ; le serveur n’invente aucun mouvement (AV-173, AV-190). ; Réception sans document : rapprochée automatiquement de l’expédition correspondante, alerte au bout de 48 heures sinon. |
| **achats-production** Achats et production | 9 | Demande d’achat validée par le responsable des achats ou la Direction ; bon de commande de plus de 500 000 XAF approuvé par la Direction (AV-051). ; Réception sans bon de commande autorisée avec justificatif, validée après coup (AV-052). ; Réception de plus de 100 000 XAF : photo attendue, acceptée sans photo mais signalée (AV-246, tranché). ; Production : lots de cinq types, saisie du jour (mortalité, intrants, pesées, observations), collectes d’œufs par calibre, coût restant ; définitions et seuils par défaut (AV-116 à AV-121). |
| **finance** Finance | 27 | Dépense à valider à partir de 50 000 XAF, photo à partir de 10 000 XAF, petite dépense de caisse de point de vente plafonnée à 50 000 XAF (AV-266). ; Facture fournisseur rapprochée du bon de commande et de la réception, écart signalé, validation avant décaissement (ADR-043). ; Avoir fournisseur : documents séparés, rien ne disparaît (AV-272). ; Chiffre d’affaires d’un lot : aucune valeur comptée deux fois (AV-279). Marges par produit, point de vente et commercial (AV-299). |
| **analyse-alertes** Analyse, alertes et notifications | 117 | 37 types d’alertes, seuils réglables, destinataires par rôle (AV-363) ; une alerte critique non traitée monte au bout de 4 heures (AV-466, tranché). ; Tour de contrôle et tableaux par rôle ; le chiffre d’affaires suit la définition d’ADR-041 (AV-376, AV-379). ; Notes de direction avec audience et accusé de lecture (AV-066, AV-426, AV-428). ; Explorateur : exports CSV et XLSX tracés ; valeurs au coût masquées sans le droit (AV-372, AV-390). ; Conservation : alertes closes 730 jours au plancher, notifications 90 jours, tâches terminées 30 jours (AV-470 à AV-472, tranchés). |
| **pieces-chargement** Pièces papier et chargement de données | 14 | Les pièces de GIC s’impriment et se consultent à l’identique du papier ; report des pièces de secours (AV-309, AV-317). ; Le numéro de la pièce est gardé dans la référence locale des commandes ; un doublon est refusé en ligne et signalé hors ligne (AV-501). ; La facture d’une vente, la feuille journalière de caisse et le journal des encaissements ne se reportent pas : ce sont des états calculés (AV-530). ; Chargement par fichier CSV : contrôle sur l’appareil, essai à blanc avant l’envoi (AV-508). ; Présence du personnel : statistique et suivi (AV-313, question 37). |
| **ecrans** Écrans et administration | 14 | Écrans d’administration : organisation, comptes, paramètres, journal d’audit (AV-490 à AV-497). ; Accès aux écrans de finance et de rapprochement par rôle (AV-298 à AV-307). ; Une photo par opération, 50 Mo de photos en attente au plus sur l’appareil (AV-291). |
| **kommo** Kommo et évolutions futures | 4 | Intégration Kommo reportée le 26/10/2026 : pas d’abonnement, le CRM est géré dans GIC (question 21). |

Ou : **Aucun : tout reste à son défaut** ★. Les domaines ne sont pas revus avant le pilote ; ils le seront après quatre semaines si vous avez choisi A à la question 40.

★ **Pourquoi cette recommandation** : Cochez seulement ce qui vous préoccupe ; laisser la liste vide est une réponse.

**Réponse du porteur** : cochez ci-dessus. Précision : ____________

## 6. À faire de votre côté

Ce ne sont pas des choix : ce sont des actions qui vous reviennent ou qui demandent une personne de GIC.

| N° | Action | Détail | Fait |
|---|---|---|---|
| C01 | Créer les deux lignes cron de sauvegarde et de purge dans hPanel | Avancé, Tâches Cron. Le script d’installation affiche les deux lignes à copier ; les scripts sont déjà sur le serveur. | ☐ |
| C02 | Planifier la copie des sauvegardes sur votre PC | Planificateur de tâches de Windows, une fois par jour, après 2 h 30 (selon la question 9). | ☐ |
| C03 | Faire l’essai de restauration d’une vraie sauvegarde | Avec le script de restauration et un fichier d’options que vous créez vous-même (le mot de passe n’est jamais dans une commande). | ☐ |
| C04 | Lancer les 9 essais sur téléphones réels | Protocole d’essai du dossier de documentation. Compte rendu à me donner ; je corrige les défauts. | ☐ |
| C05 | Relever les appareils du pilote | Marque, modèle, version d’Android, version de Chrome, mémoire, utilisateur ou rôle, site, partagé ou non. | ☐ |
| C06 | Fournir les fichiers de données de GIC | Catalogue, prix, fournisseurs, lots biologiques, et clients si ceux du reporting commercial ne suffisent pas. | ☐ |
| C07 | Compter le stock d’ouverture et fixer la date d’arrêt | Magasin central et point de vente du pilote : quantité par produit et par emplacement. | ☐ |
| C08 | Demander au comptable le régime de TVA et la mention d’exonération | Et lui faire valider les modèles de pièces papier. | ☐ |
| C09 | Demander à la Finance si un compte de trésorerie inactif peut porter un solde | Réponse nécessaire pour aligner le total de trésorerie des deux écrans. | ☐ |
| C10 | Désigner qui fait quoi à l’exploitation | Mises en ligne, approbation des appareils, lecture des journaux et alertes, sauvegardes, assistance aux utilisateurs. | ☐ |
| C11 | Valider les libellés des 24 motifs de départ avec GIC | Rejet à la réception, écart de prix, écart d’inventaire, écart de transfert. | ☐ |
| C12 | Faire valider la marge d’un lot pilote par la Direction | Condition de clôture de la phase finance. | ☐ |
| C13 | Changer les mots de passe cités dans les journaux d’Antigravity | À votre rythme, avant l’ouverture à de vrais utilisateurs. | ☐ |
| C14 | Générer les clés de notification Web Push | Seulement si vous avez choisi de l’activer (question 14). La clé privée ne s’écrit jamais dans le dépôt. | ☐ |

## Annexe — les points ouverts du registre et leur traitement

Les 403 points ouverts du registre au 08/11/2026 (classe : 129 importants, 274 secondaires ; aucun bloquant). La dernière colonne dit où chacun est traité : une question de ce document, ou le domaine de la question 41.

| AV | Titre | Classe | Phase | Traité par |
|---|---|---|---|---|
| AV-001 | Périmètre de la première mise en production | Importante | Plan | Q01 |
| AV-002 | Inventaire des sites, magasins, points de vente et bâtiments existants | Importante | P1 | Q04 |
| AV-003 | Hiérarchie des zones et géométrie des zones de pointage | Importante | P0/P1 | Q41 · Identité, appareils et synchronisation |
| AV-007 | Appareils partagés entre plusieurs utilisateurs | Importante | P0/P5 | Q15 |
| AV-008 | Mode d'authentification des utilisateurs terrain | Importante | P0 | Q26 |
| AV-009 | Autonomie maximale hors connexion | Importante | P0 | Q27 |
| AV-010 | Séparation des tâches (déclarant ≠ approbateur) | Importante | P0 | Q25 |
| AV-011 | Étapes du pipeline prospect | Secondaire | P3 | Q41 · Clients, terrain et ventes |
| AV-012 | Règle de conversion prospect → client | Importante | P3/P4 | Q41 · Clients, terrain et ventes |
| AV-013 | Définition client actif / inactif | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-014 | Visibilité des prospects entre commerciaux et doublons | Importante | P3 | Q41 · Clients, terrain et ventes |
| AV-015 | Règles de réaffectation de clients | Importante | P3 | Q41 · Clients, terrain et ventes |
| AV-016 | Structure des objectifs commerciaux | Secondaire | P3 | Q41 · Clients, terrain et ventes |
| AV-018 | Sources de prospects et canaux de vente | Secondaire | P1 | Q41 · Catalogue, prix et stock |
| AV-019 | Interactions des canaux Kommo stockées dans GIC | Secondaire | P10 | Q41 · Kommo et évolutions futures |
| AV-020 | Commissions commerciales | Secondaire | Futur | Q20 |
| AV-021 | Prise de service hors zone : refus ou acceptation signalée | Importante | P3 | Q41 · Clients, terrain et ventes |
| AV-022 | Rayon de tolérance et précision GPS maximale | Secondaire | P3 | Q41 · Clients, terrain et ventes |
| AV-023 | Session de travail obligatoire pour visites et ventes terrain | Importante | P3 | Q41 · Clients, terrain et ventes |
| AV-029 | Retours clients | Secondaire | Futur | Q20 |
| AV-033 | Acomptes sur commande | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-035 | Politique d'allocation de stock | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-036 | Traçabilité par lot jusqu'à la vente | Importante | P2/P7 | Q41 · Catalogue, prix et stock |
| AV-037 | Seuils de preuve et de validation des pertes | Importante | P2 | Q35 |
| AV-039 | Fréquence et procédure d'inventaire | Secondaire | P2/P5 | Q35 |
| AV-040 | Seuils de réapprovisionnement | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-042 | Méthode de valorisation du stock | Importante | P2/P8 | Q32 |
| AV-051 | Seuils de validation des achats | Importante | P6 | Q35 |
| AV-052 | Réception sans bon de commande | Importante | P6 | Q41 · Achats et production |
| AV-053 | Tolérances de rapprochement commande / réception / facture | Secondaire | P6/P8 | Q41 · Achats et production |
| AV-054 | Traitement des quantités rejetées à réception | Secondaire | P6 | Q41 · Achats et production |
| AV-055 | Règles de paiement fournisseur | Secondaire | P8 | Q41 · Finance |
| AV-057 | Procédure de caisse du point de vente | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-058 | Catégories de dépenses et justificatifs | Secondaire | P8 | Q41 · Finance |
| AV-059 | Export / intégration comptable | Secondaire | Futur | Q34 |
| AV-060 | Arrondis monétaires | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-061 | Dimensions tarifaires utilisées au lancement | Secondaire | P1 | Q41 · Catalogue, prix et stock |
| AV-062 | Validation / activation des règles tarifaires | Importante | P1 | Q41 · Catalogue, prix et stock |
| AV-064 | Canaux de notification | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-065 | Alertes initiales et seuils | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-066 | Accusé de lecture des notes de direction | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-067 | Formats et restrictions d'export | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-068 | Capacités du compte Kommo (API, webhooks, pipelines, champs) | Importante | P10 | Q21 |
| AV-069 | Déclencheur de création d'un client GIC depuis Kommo | Importante | P10 | Q21 |
| AV-070 | Données remontées de GIC vers Kommo | Secondaire | P10 | Q41 · Kommo et évolutions futures |
| AV-071 | Correspondance utilisateurs GIC ↔ Kommo | Secondaire | P10 | Q41 · Kommo et évolutions futures |
| AV-072 | Reprise des données existantes | Importante | P1/P2 | Q04 |
| AV-074 | Durées de conservation | Secondaire | P0/P9 | Q10, Q36 |
| AV-075 | Parc d'appareils cible | Importante | P0 | Q06 |
| AV-076 | Impression de reçus au point de vente | Secondaire | Futur | Q20 |
| AV-077 | Format de numérotation officielle des documents | Secondaire | P0 | Q41 · Identité, appareils et synchronisation |
| AV-078 | Saisie rétroactive (heure métier dans le passé) | Importante | P0 | Q41 · Identité, appareils et synchronisation |
| AV-079 | Langues de l'interface | Secondaire | P0 | Q22 |
| AV-080 | Unités de conditionnement | Secondaire | P1 | Q41 · Catalogue, prix et stock |
| AV-081 | Validation préalable des transferts | Secondaire | P2 | Q41 · Catalogue, prix et stock |
| AV-082 | Traitement des écarts de transfert | Secondaire | P2 | Q41 · Catalogue, prix et stock |
| AV-083 | Vente d'un produit désactivé pendant une période hors ligne | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-084 | Équipe et budget de développement / exploitation | Importante | Plan | Q07 |
| AV-085 | Frais de livraison facturés au client | Secondaire | P4 | Q20 |
| AV-086 | Volumétrie cible à 3 ans | Importante | P0/P9 | Q19 |
| AV-087 | Prix appliqué à la livraison d'une commande | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-088 | Clôture et verrouillage de période | Secondaire | P8 | Q33 |
| AV-090 | Modalité d'exécution du serveur Node.js chez Hostinger sans VPS | Importante | Déploiement | Q41 · Identité, appareils et synchronisation |
| AV-091 | Fournisseur de stockage objet S3-compatible (Hostinger sans VPS n'en propose pas) | Secondaire | Déploiement | Q10 |
| AV-092 | Permissions marquant identity.permissions.is_sensitive (audit renforcé et revue d'attribution périodique) | Importante | P0 | Q28 |
| AV-093 | Permission gouvernant attachments.attachment.register | Secondaire | P0 | Q41 · Identité, appareils et synchronisation |
| AV-116 | Définition des indicateurs zootechniques | Secondaire | P7 | Q41 · Achats et production |
| AV-117 | Journée sans événement (« RAS ») | Secondaire | P7 | Q41 · Achats et production |
| AV-118 | Reclassement d'œufs | Secondaire | P7 | Q41 · Achats et production |
| AV-119 | Mortalité constatée hors élevage | Secondaire | P7 | Q41 · Achats et production |
| AV-121 | Seuils de l’alerte de mortalité élevée | Secondaire | P7 | Q41 · Achats et production |
| AV-131 | Perte d'une marchandise vendue avant sa livraison | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-132 | Délai d'alerte d'une vente confirmée non livrée | Secondaire | P4/P9 | Q41 · Clients, terrain et ventes |
| AV-133 | Livraison faite hors ligne qui arrive après l'annulation du reste de la commande | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-134 | Correction d'un bon de livraison saisi avec une mauvaise quantité | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-135 | Décision de la Finance sur un encaissement suspect de doublon : correction de la référence | Importante | P4 | Q41 · Clients, terrain et ventes |
| AV-136 | Commande d'un produit vendu au poids | Importante | P4 | Q41 · Clients, terrain et ventes |
| AV-137 | Vente anonyme saisie hors ligne et non intégralement payée | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-138 | Annulation d'une vente d'animaux après la clôture de leur lot | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-139 | Compte de trésorerie crédité par un mobile money, un virement ou un chèque quand l'entreprise a plusieurs comptes | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-140 | Canal d'une vente quand le vendeur n'en choisit pas, et canaux de vente à créer | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-141 | Vente en ligne avec un prix catalogue différent de celui du serveur | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-142 | Qui traite le stock négatif d'une vente hors ligne | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-143 | Vente à crédit hors ligne à un client non autorisé au crédit | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-144 | Vente directe depuis un magasin (et non un point de vente) | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-145 | Vente en ligne à un client dont le compte a été fusionné | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-146 | Sort de l'argent payé d'une vente annulée : remboursement ou crédit client | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-147 | Remise sur une ligne de commande | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-148 | Confirmation d'un brouillon de commande : prix de la saisie ou prix du jour | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-149 | Annulation d'une vente sur commande : la commande garde-t-elle la quantité ? | Importante | P4 | Q41 · Clients, terrain et ventes |
| AV-150 | Encaissement saisi hors ligne avec une commande que le serveur refuse ; acompte supérieur au total de la commande | Importante | P4 | Q41 · Clients, terrain et ventes |
| AV-151 | Annulation d'un encaissement dont une part a déjà été remboursée au client | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-152 | Mort d'animaux vivants hors d'un lot de production (stock mobile, marchandise vivante achetée) | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-153 | Écart d'une remise de fonds : imputation et excédent | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-155 | Responsabilité d'un écart de caisse avec plusieurs vendeurs et identité du valideur | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-156 | Fonds de caisse initial et écart d'ouverture | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-157 | Mouvements d'espèces hors session ou décidés après coup (encaissement, remboursement, inverse) | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-158 | Remises de fonds : comptes admis, récepteur, alerte de remise non reçue | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-159 | Refus, recomptage et correction d'un écart de caisse | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-160 | Quotas d'appareil : granularité et validité par défaut | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-161 | Quotas d'appareil : dépassement hors ligne, quota révoqué ou échu | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-162 | Qui accorde les quotas (« responsable du PDV ») et permission de libération | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-163 | Garde d'appareil : mode par défaut des emplacements et appareil non désigné | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-164 | Tableau de distribution : définitions de « vendu » et « perdu », périmètre, route | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-165 | Sessions de caisse hors PDV et PDV à plusieurs appareils | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-166 | Vente hors ligne sans quota utilisable sur un emplacement partagé : signal du serveur | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-167 | Ouverture de caisse hors ligne plus ancienne que la session qu'elle chevauche | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-168 | Ouverture de caisse hors ligne pendant la session de la veille, close d'office depuis | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-169 | Clôture de caisse hors ligne datée avant l'ouverture de la session | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-170 | Responsable imputé de l'écart d'une clôture forcée et de l'écart d'ouverture | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-171 | Clôture de caisse datée avant un mouvement déjà enregistré sur la caisse | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-172 | Remises de fonds : qui réceptionne et qui annule | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-173 | Courses hors ligne d'une remise (réception après annulation, annulation après réception, double réception) | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-174 | Décision sur l'écart d'une remise : rejet, retrait, correction, valideur | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-175 | Remise perdue en route | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-176 | Site de numérotation d'une remise entre comptes sans site | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-177 | Réception sans document : critères de rapprochement, choix de l'expédition, excédent | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-178 | Réception sans document vers un emplacement partagé ou saisie hors garde | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-179 | Réception sans document rapprochée après coup : lot et valeur ; produit suivi par lot | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-180 | Retour à la source et réception concurrents ; seconde réception ; retour en double | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-181 | Délai de la réception sans document non rapprochée : origine, propriétaire du conflit, sortie | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-182 | Portée (SITE/OWN) des commandes de stock : quelle extrémité d'un transfert fait ressource, et suite hors ligne | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-183 | Session de caisse ou écart de remise à valider sans politique active | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-184 | Encaissement en espèces au PDV sans session : périmètre de l'exigence, grain et résolution de CASH_SESSION_MISSING | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-185 | Annulation directe : sens de « session de caisse de la vente encore ouverte » (BR-VEN-028) | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-186 | Remboursement en espèces sans session de caisse ouverte | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-187 | Sous-totaux par vendeur d'une session : contenu et attribution | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-188 | Annulation de l'encaissement qui règle une vente anonyme saisie en ligne | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-189 | Droits de lecture des ressources de P5 : quotas, sessions de caisse, remises de fonds, structure, file des conflits | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-190 | Sens d'une résolution manuelle de conflit (sync.conflict.resolve, .dismiss) | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-191 | Qui voit et traite un conflit | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-192 | Clôture d'un conflit par l'auteur du fait qu'il signale | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-193 | Ce que les jeux allocations et cash gardent d'un quota, d'une session ou d'une remise terminés | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-194 | Quotas d'une tablette partagée : cloisonnement par utilisateur | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-195 | Configuration du PDV hors ligne et changement d'appareil désigné | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-196 | Jeux et publication des référentiels de vente (suite d'ADR-031) | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-197 | Comptes destinataires d'une remise de fonds hors ligne | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-198 | Curseur du pull : ligne du flux validée après une ligne de numéro supérieur | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-199 | Flux de distribution d'un PDV : catégories, datation, envoyé net des retours | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-200 | Encaissé d'une période : datation des annulations d'encaissement | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-201 | « Session du jour » d'un PDV et sessions à valider | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-202 | Fraîcheur d'un appareil : dernier contact et appareils d'un PDV | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-203 | Disponible net des quotas dans GET /stock | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-204 | Périmètre du tableau de distribution ; portée du Resp. commercial sur les PDV | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-205 | Frontière entre agrégat et détail du tableau de distribution | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-206 | Valeurs masquées du tableau de distribution | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-207 | Période du tableau de distribution et instants de lecture | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-208 | Accueil Finance et magasinier : contenu de distribution | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-209 | Chiffre d'affaires du jour : accueil contre tableau de distribution | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-210 | Ordre d'un lot après une commande à renvoyer ; dépendance reçue mais non réglée | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-211 | Faits antérieurs à la révocation d'un quota, synchronisés après : comparaison fait par fait | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-212 | Fenêtre de quarantaine d'un appareil débloqué ou retiré | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-213 | Appareil révoqué : envoi de sa file et signal d'effacement local | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-214 | Régularisation d'une vente mise en quarantaine (appareil révoqué) | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-215 | Stock négatif après une sortie hors ligne autre qu'une vente | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-216 | Horloge d'appareil suspecte : dates de référence, seuil et alerte | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-217 | Commande à renvoyer qui ne se règle jamais : suspension du lot bornée | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-218 | Compte de réception d'un encaissement mobile money ou bancaire quand l'entreprise a plusieurs comptes du type | Importante | Écrans PWA | Q41 · Écrans et administration |
| AV-219 | Motif d'un écart d'inventaire exigé dès la saisie sur l'appareil | Secondaire | Écrans PWA | Q41 · Écrans et administration |
| AV-220 | Écran de consommation hors lot (ECR-STK-08) pour le vendeur de PDV et le responsable de production | Secondaire | Écrans PWA | Q41 · Écrans et administration |
| AV-221 | Annulation directe pendant une clôture de caisse concurrente : condition relue sous verrou | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-222 | Gardes des référentiels : valeurs retenues là où une contrainte de la base levait une exception | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-223 | Expédition hors ligne d'une demande qui n'est plus à expédier ; mouvement interne hors de la garde de l'auteur | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-224 | Opération de caisse datée entre deux sessions, appliquée après l'ouverture de la suivante | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-225 | Résolution manuelle du signal d'une commande bloquée : la commande reste-t-elle rejouable ? | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-226 | Tolérance de date future du pipeline | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-227 | Écart d'horloge hors des bornes de stockage | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-228 | Fait saisi par un appareil encore en attente d'approbation | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-229 | Utilisateur suspendu puis réactivé : fenêtre de quarantaine | Importante | P10 | Q41 · Kommo et évolutions futures |
| AV-230 | Quotas actifs d'un emplacement de vente qui passe en garde exclusive | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-231 | Sorties de stock hors ligne au-delà du quota du détenteur ou du solde d'un emplacement exclusif | Importante | Écrans PWA | Q41 · Écrans et administration |
| AV-232 | Comptage de la caisse à l'aveugle | Importante | Écrans PWA | Q41 · Écrans et administration |
| AV-233 | Encaissement en espèces au PDV sans caisse ouverte sur l'appareil | Importante | Écrans PWA | Q41 · Écrans et administration |
| AV-234 | Demande de réapprovisionnement d'un PDV sans source configurée | Secondaire | Écrans PWA | Q41 · Écrans et administration |
| AV-235 | Demandes de réapprovisionnement en double vers un PDV | Secondaire | Écrans PWA | Q41 · Écrans et administration |
| AV-236 | Ventes et encaissé du jour de l'accueil du PDV | Secondaire | Écrans PWA | Q41 · Écrans et administration |
| AV-237 | Libération des quotas sur l'appareil | Importante | Écrans PWA | Q41 · Écrans et administration |
| AV-238 | Détenteurs proposés à l'octroi d'un quota | Importante | Écrans PWA | Q41 · Écrans et administration |
| AV-239 | Remises de fonds sur l'appareil (UC-FIN-07) | Importante | Écrans PWA | Q41 · Écrans et administration |
| AV-240 | Remise au-delà du solde indicatif de la caisse | Secondaire | Écrans PWA | Q41 · Écrans et administration |
| AV-241 | Rôles de l'écran de trésorerie (ECR-FIN-05) | Secondaire | Écrans PWA | Q41 · Écrans et administration |
| AV-242 | Lecture seule au-delà de l'autonomie hors connexion (AV-009) | Importante | Écrans PWA | Q27 |
| AV-243 | Fait hors ligne antérieur au rattachement de l'appareil à un autre site | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-244 | Encaissé : remboursements et doublons approuvés | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-245 | Chiffre d'affaires d'un PDV : site entier (accueil) ou emplacement de vente (tableau) | Secondaire | P5 | Q41 · Distribution, caisse et quotas |
| AV-255 | Ventes signalées de l'accueil : quels drapeaux comptent comme anomalie ? | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-256 | Valeur du stock de l'entreprise : la marchandise en transit compte-t-elle ? | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-257 | Permissions des rôles modifiables depuis l'application ? | Secondaire | MP | Q28 |
| AV-262 | Remise au-delà du plafond ou dépassement d'encours refusés après coup : quel effet ? | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-263 | Plafond d'approbation des dépenses par rôle (Resp. production « ≤ seuil, fermes », RC-06) | Secondaire | P8 | Q35 |
| AV-264 | Dépense au-delà du seuil sans politique EXPENSE active | Secondaire | P8 | Q41 · Finance |
| AV-265 | Dépense hors ligne non conforme, dépense hors ligne non payée | Importante | P8 | Q41 · Finance |
| AV-266 | Plafond d'une petite dépense payée par la caisse du PDV (BR-DIS-013) | Secondaire | P8 | Q35 |
| AV-267 | Session de caisse pour une dépense payée par la caisse du PDV | Importante | P8 | Q41 · Finance |
| AV-268 | Dépense rejetée après paiement : « imputée au déclarant » | Secondaire | P8 | Q41 · Finance |
| AV-269 | Dépense imputée à un site | Secondaire | P8 | Q41 · Finance |
| AV-270 | Catégories de dépense : type de coût, PDV, administration | Secondaire | P8 | Q41 · Finance |
| AV-271 | Facture fournisseur sans bon de commande | Secondaire | P8 | Q41 · Finance |
| AV-272 | Avoir fournisseur | Importante | P8 | Q41 · Finance |
| AV-273 | Échéance par défaut d'une facture fournisseur | Secondaire | P8 | Q41 · Finance |
| AV-274 | Réception ou bon de commande annulé après facturation | Secondaire | P8 | Q41 · Finance |
| AV-275 | Avances fournisseurs et affectation ultérieure | Secondaire | P8 | Q41 · Finance |
| AV-276 | Paiement fournisseur validé : date du décaissement, factures payées entre-temps | Secondaire | P8 | Q41 · Finance |
| AV-277 | Annulation d'un paiement fournisseur enregistré | Secondaire | P8 | Q41 · Finance |
| AV-278 | Lecture des factures, paiements fournisseurs et de la vue d'ensemble financière | Secondaire | P8 | Q41 · Finance |
| AV-279 | Chiffre d'affaires d'un lot de production | Importante | P8 | Q41 · Finance |
| AV-280 | Règles d'un nouveau mot de passe : longueur maximale, réemploi | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-281 | Gardes de la réinitialisation du mot de passe par l'Admin | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-283 | « Classer » une opération refusée ou en conflit sur l'appareil | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-284 | « Encaisser le reste dû » depuis le reçu : sort du surplus | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-289 | Validation d'une réception sans BC dont la photo manque | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-290 | Photo refusée ou jamais reçue | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-291 | Formats, nombre et budget local des photos | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-292 | Stockage des fichiers pour le pilote | Secondaire | MP | Q10 |
| AV-293 | Métadonnées des pièces jointes servies à tous les appareils | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-294 | Politiques de contrôle des achats par défaut | Importante | MP | Q41 · Identité, appareils et synchronisation |
| AV-295 | Droit de décider une validation, jugé aussi à la réception | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-296 | Appareil non partagé lié à l'utilisateur qui l'a connecté | Secondaire | MP | Q11 |
| AV-297 | Verrouillage de connexion : essais simultanés, adresse derrière un proxy | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-298 | Accès aux écrans de finance et action « + Dépense » de l'accueil | Secondaire | P8 | Q41 · Finance |
| AV-299 | Marges par produit, point de vente et commercial | Importante | P8 | Q41 · Finance |
| AV-300 | Ce que P8 ajoute à la trésorerie | Secondaire | P8 | Q41 · Finance |
| AV-301 | Site et imputation proposés à la saisie d'une dépense | Secondaire | P8 | Q41 · Finance |
| AV-302 | Périmètre de l'écran de rapprochement des achats (ECR-APP-05) | Secondaire | P8 | Q41 · Finance |
| AV-303 | Périmètre de l'écran « Coûts et marges » (ECR-FIN-06) | Secondaire | P8 | Q41 · Finance |
| AV-304 | Périmètre de l'écran des créances (ECR-FIN-01) | Secondaire | P8 | Q41 · Finance |
| AV-305 | Créances hors de la liste et écarts avec l'accueil (ECR-FIN-01) | Secondaire | P8 | Q41 · Finance |
| AV-306 | Pièce citée par une opération : existence, document et auteur non vérifiés | Secondaire | P8 | Q41 · Finance |
| AV-307 | Poste de bureau des rôles de bureau et exception de RC-02 | Secondaire | P8 | Q41 · Finance |
| AV-308 | Référence de la pièce papier : champ dédié ou généralisation de local_ref | Importante | PP | Q18 |
| AV-309 | Rendu des pièces : composants de la PWA, police libre, consultation et impression sur le même rendu | Importante | PP | Q41 · Pièces papier et chargement de données |
| AV-310 | Mentions de la pièce imprimée : numéro, duplicata, annulation, données personnelles | Secondaire | PP | Q41 · Pièces papier et chargement de données |
| AV-311 | Journal de caisse imprimé : contenu hors ligne et pagination | Secondaire | PP | Q41 · Pièces papier et chargement de données |
| AV-312 | Registre des carnets : contrôle de continuité | Secondaire | PP | Q18 |
| AV-313 | Présence du personnel non commercial | Importante | PP | Q37 |
| AV-314 | Bilan hebdomadaire du commercial | Secondaire | PP | Q41 · Pièces papier et chargement de données |
| AV-315 | Veille marché dans la visite | Secondaire | PP | Q41 · Pièces papier et chargement de données |
| AV-316 | Profil commercial du client | Importante | PP | Q41 · Pièces papier et chargement de données |
| AV-317 | Écran de report et import par lots des pièces papier | Importante | PP | Q23 |
| AV-318 | Politiques de validation par défaut du stock et du pointage | Importante | MP | Q41 · Identité, appareils et synchronisation |
| AV-319 | Cadence du tirage de l'appareil et écriture du dernier pull | Importante | MP | Q41 · Identité, appareils et synchronisation |
| AV-320 | Motifs par défaut des autres catégories (rejet, inventaire, écart de transfert, prix) | Importante | MP | Q41 · Identité, appareils et synchronisation |
| AV-321 | Quantités préremplies à la réception d'un transfert et d'un bon de commande | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-322 | Appareil enrôlé et jamais approuvé : ancienneté dans le signal d'accueil | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-323 | Opérations sans pièce papier propre | Secondaire | PP | Q41 · Pièces papier et chargement de données |
| AV-324 | Identité de la société imprimée sur les pièces | Secondaire | PP | Q41 · Pièces papier et chargement de données |
| AV-325 | Création d'un compte par l'Admin : mot de passe provisoire hors du journal des commandes | Importante | MP | Q41 · Identité, appareils et synchronisation |
| AV-326 | Périmètres proposés à l'affectation d'un rôle depuis l'écran des comptes | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-327 | L'Admin gère-t-il les rôles de son propre compte ? | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-328 | Suspendre ou désactiver son propre compte | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-329 | Indicateurs des tableaux sans mesure égale dans l'explorateur (AT-054) | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-350 | Seuils des alertes : où les paramétrer | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-351 | Gravité d'une alerte dont le niveau varie | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-352 | Types d'alerte ajoutés au catalogue ; types sans source | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-353 | Résolution automatique des alertes d'état | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-354 | Alerte d'événement : résolution, écart, nouvelle occurrence | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-355 | Alertes de stock « sur mouvement » | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-356 | Alertes de perte anormale et de mortalité élevée | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-357 | Pièce requise jamais reçue (ATTACHMENT_MISSING) | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-358 | Demande d'approbation en attente ; escalade ; sans approbateur | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-359 | Commercial inactif (INACTIVE_COMMERCIAL) | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-360 | Réception incomplète (RECEIPT_INCOMPLETE) | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-361 | Tâches planifiées de détection : créneaux | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-362 | Consommateur d'événements en échec | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-363 | Destinataires d'une alerte | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-364 | Canaux de notification par gravité | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-365 | Web Push : bibliothèque, clés et repli | Importante | P9 | Q14 |
| AV-366 | Regroupement des notifications push | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-367 | Escalade d'une alerte critique | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-368 | Prise en compte d'une alerte hors ligne | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-369 | Notes de direction : audience, brouillon, expiration, correction | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-370 | Note automatique à l'activation d'une règle tarifaire | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-371 | Limites de l'explorateur | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-372 | Mesures protégées : refus ou masquage | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-373 | Étendue exacte des lignes d'un jeu de faits | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-374 | Jeux de faits livrés en P9 | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-375 | Zone d'une ligne de fait : zone seule ou zone et ancêtres | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-376 | Chiffre d'affaires : deux calculs à rapprocher | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-377 | Annulations dans l'explorateur | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-378 | Remontée d'un chiffre jusqu'aux sources | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-379 | Contenu de la tour de contrôle et des tableaux de rôle | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-380 | Instantanés personnels : fréquence, périodes, utilisateurs, retrait | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-381 | Jeu hors ligne kpi | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-382 | Vues sauvegardées : partage, vue par défaut, lecture | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-383 | Exports : formats, asynchronie, durée de vie | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-384 | Droit d'exporter et de télécharger un export | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-385 | Permissions de P9 : codes réutilisés | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-386 | Volumétrie cible et paliers analytiques | Importante | P9 | Q19 |
| AV-387 | Rétention des données de communication et d'analyse | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-388 | Délai événement → alerte et fenêtre de stabilisation | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-389 | Notifications directes d'événements (hors alerte) | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-390 | Valeurs au coût dans les alertes et notifications | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-391 | Sujet d'une alerte à clé composite | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-392 | Alerte d'erreur de synchronisation (SYNC_ERROR) | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-393 | Rôles destinataires d'un déclencheur à rôles propres, règle modifiée | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-394 | Rôles suivis par INACTIVE_COMMERCIAL | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-395 | PRICE_MISMATCH : ventes directes et commandes hors ligne | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-396 | Avance client : doublon probable non contrôlé | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-397 | Encaisse élevée ou sans remise (CASH_HOLDING_HIGH) : définition | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-398 | CASH_MISMATCH : jour métier et écarts sans compte | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-399 | ATTACHMENT_MISSING des dépenses : délai, référence, horizon et rattachement | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-400 | CASH_VARIANCE : écart toléré, ajustement d'ouverture, ajustements restants | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-401 | SALE_UNDELIVERED : livraison demandée à une date ultérieure | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-402 | POS_REPLENISH : condition, cadence et destinataires | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-403 | HIGH_LOSS (seuil absolu) : cumul du jour, mortalité, déclarations en attente | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-404 | LOT_EXPIRING : périmètre, sujet et horizon | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-405 | HIGH_LOSS : part « % du CA » | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-406 | INVENTORY_VARIANCE : seuil, levée et fermeture | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-407 | Date de détection des alertes de stock issues d'un fait | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-408 | TRANSFER_NOT_RECEIVED : délai, site et destinataires | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-409 | LEDGER_MISMATCH : sujet, site et réussite de la tâche | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-410 | Résolution de TRANSFER_UNMATCHED, ALLOCATION_EXPIRED et ALLOCATION_REVOCATION_PENDING | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-411 | HIGH_MORTALITY : effectif de référence, sujet, cadence et couverture | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-412 | DAILY_ENTRY_MISSING : saisie du jour, lots examinés, jours et résolution | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-413 | STANDARD_COST_MISSING : entrées revues, fenêtre et résolution | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-414 | RECEIPT_INCOMPLETE : condition, bornes, cadence et résolution | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-415 | Réception en quarantaine : DUPLICATE_SUSPECTED et sa fermeture | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-416 | APPROVAL_PENDING_LONG : référence du délai, cadence, escalated_at | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-417 | ATTACHMENT_MISSING des réceptions : exigence, présence et portée | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-418 | CHECKIN_SUSPICIOUS : tentatives, sujet, destinataires et date | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-419 | DUPLICATE_SUSPECTED d'un compte client : sujet, charge utile et fermeture | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-420 | AUDIT_CHAIN_BROKEN : fenêtre, partition, heure et récurrence | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-421 | SYNC_ERROR : nature, périmètre, regroupement et codes exclus | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-422 | SYNC_STALE : référence du délai, horizon d'oubli et propriétaire | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-423 | DEVICE_SEQ_GAP : définition du trou, explication par les restes déclarés et mémoire | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-424 | CLOCK_SKEW : passe horaire plutôt que publication à l'envoi | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-425 | CONSUMER_FAILED : consommateurs surveillés, condition, fenêtre et supervision indépendante | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-426 | Audience d'une note de direction : qui une ligne SITE, ZONE, rôle ou utilisateur touche | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-427 | Notes de direction : brouillon, publication, archivage, références et notifications | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-428 | Lecture et accusé de réception d'une note : date du fait, audience et hors-audience | Importante | P9 | Q41 · Analyse, alertes et notifications |
| AV-429 | Lecture des notes de direction : centre de notes, gestion, fiche et suivi des accusés | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-430 | Notifications directes d'événements : événements publiés, destinataires et texte (précise AV-389) | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-431 | Activation des notifications directes par type | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-432 | DeviceEnrollmentRequested : prévenir les approbateurs d'un appareil en attente | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-433 | Jeu hors ligne comms : contenu, portée et rendu des alertes | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-434 | Notifications dans le jeu hors ligne : non lues IN_APP, sortie à la lecture | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-435 | Notes dans le jeu hors ligne : détenteurs, état de lecture, retrait | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-436 | Mortalité comptée d'un lot : statuts comptés et sort de la mortalité refusée | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-437 | Valeur d'un solde de stock : deux définitions | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-438 | Remise et coût d'une ligne de vente annulée | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-439 | Jeu des achats : facturé et payé hors du jeu | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-440 | Pertes et dépenses : constaté, en attente et non justifié en colonnes distinctes | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-441 | Prospection : comptes et conversions lus par l'acteur de l'événement | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-442 | Conversion d'un compte fusionné | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-443 | Achats : date d'un bon de commande et taux de service | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-444 | Soldes de stock, valeur, trésorerie : mesures sans signe ni filtre | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-445 | Tableaux : étendue non représentable par une portée de lecture | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-446 | Vues sauvegardées : propriétaire seul, vue par défaut d'un rôle | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-447 | Exports : échéance, file par demandeur, étendue tronquée, abandon | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-448 | Instantanés personnels : lot, contenu, retrait | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-449 | Document source d'une ligne : dimensions de document et routes | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-450 | Charge : index non ajoutés avant mesure, jeu de ventes seul | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-451 | Facture imprimée : régime de TVA et mention d'exonération | Importante | PP | Q31 |
| AV-473 | Atteinte d'objectif (KPI-COM-16) : quels objectifs, quelle agrégation, quel lecteur | Secondaire | P9 | Q30 |
| AV-474 | Atteinte d'objectif : fenêtre du réalisé et jour de lecture | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-475 | Poids moyen et coût par tête sur un tableau : un type de lot de référence | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-476 | Consommation d'aliment (KPI-PRD-04) : source, imputation, unité | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-477 | Poids moyen (KPI-PRD-05) : pesée de référence d'un lot et pondération | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-478 | Coût par tête (KPI-PRD-09) : agrégation et lecture d'inventory | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-479 | Opérations en attente et conflits ouverts (KPI-OPS-02) : définition, périmètre, deux indicateurs | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-480 | Place des cinq indicateurs dans les blocs ; l'instantané distribution passe de quatre à cinq indicateurs (six avec les conflits) | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-481 | JOB_FAILED : durée de l'alerte après un échec corrigé | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-482 | JOB_FAILED : écran d'action | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-483 | JOB_FAILED : cadence de la passe | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-484 | JOB_FAILED : regroupement et seuil | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-485 | Base de l'hébergement : MariaDB 11.8 mutualisée, non MySQL 8.4 | Importante | Mise en ligne, pilote | Q08 |
| AV-486 | Éditeur de règle de prix : erreurs montrées dès l'ouverture | Secondaire | PWA (prix), après la refonte graphique | Q30 |
| AV-487 | Trésorerie : « Solde des comptes » et total de trésorerie des coûts et marges | Importante | PWA (finance), pilote | Q30 |
| AV-488 | « Fiche de suivi de la semaine » : bouton du module des pièces d'avant la refonte | Secondaire | PWA (pièces papier) | Q30 |
| AV-495 | Équipes : qui voit lesquelles, avec quels membres | Secondaire | RP-1 | Q41 · Identité, appareils et synchronisation |
| AV-496 | Paramètres et journal : contrôles que seul l'écran porte | Importante | RP-1, pilote | Q30 |
| AV-497 | Organisation : actions que les commandes n'offrent pas | Secondaire | RP-1 | Q41 · Identité, appareils et synchronisation |
| AV-498 | Filet de synchronisation : un cycle au moins toutes les 5 minutes, onglet masqué compris | Importante | MP | Q41 · Identité, appareils et synchronisation |
| AV-499 | Enveloppe de commande invalide : refus sur l'appareil, UUIDv7 exigé à la connexion, appareils non actionnables | Importante | MP | Q41 · Identité, appareils et synchronisation |
| AV-500 | Mise en service de Bonabéri : valeurs de départ du script d'initialisation (stock, coût, prix, droits du responsable commercial) | Importante | MP | Q05 |
| AV-501 | Report d'une pièce papier : où le numéro de la pièce atteint le serveur, en attendant la colonne dédiée d'AV-308 | Importante | PP | Q18 |
| AV-502 | Report d'une pièce papier : fait accompli « saisi hors ligne » même appareil connecté | Importante | PP | Q41 · Pièces papier et chargement de données |
| AV-503 | Report d'une pièce papier : commande du serveur choisie pour chaque pièce | Secondaire | PP | Q41 · Pièces papier et chargement de données |
| AV-504 | Report d'une pièce papier : photo de la souche rattachable seulement pour la dépense, la réception et la perte | Secondaire | PP | Q41 · Pièces papier et chargement de données |
| AV-505 | Mise à jour de la PWA à la demande, même avec des opérations en attente | Secondaire | MP | Q41 · Identité, appareils et synchronisation |
| AV-506 | Signalement d'un lot refusé en bloc par le serveur sans désigner de commande | Importante | MP | Q41 · Identité, appareils et synchronisation |
| AV-507 | Commandes refusées sur l'appareil : numéros déclarés au serveur | Importante | MP | Q41 · Identité, appareils et synchronisation |
| AV-508 | Chargement de données par fichier CSV : contrôle sur l'appareil, sans table d'attente du serveur | Importante | RP-2 | Q41 · Pièces papier et chargement de données |
| AV-513 | Solde d'une commande non livrée : créance et encours du client | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-514 | Présence du personnel et bilan hebdomadaire : choix de conception à confirmer et restes (PP-E) | Secondaire | PP | Q37 |
| AV-515 | Administration : modifier un compte, déplacer une zone, fermer une équipe, contrôler les paramètres | Importante | RP-1 | Q41 · Identité, appareils et synchronisation |
| AV-516 | Catalogue et prix : modifier un produit, coût standard daté, campagnes commerciales, abandon d'un brouillon | Secondaire | RP-1 | Q41 · Identité, appareils et synchronisation |
| AV-517 | Stock d'ouverture (commande inventory.opening.post) et chargements par fichier : stock d'ouverture, comptes de trésorerie, règles de prix | Importante | RP-2 | Q05 |
| AV-518 | Finance : créances des comptes fusionnés, interrupteur « livré seulement » (AV-513), détail des mouvements de trésorerie | Secondaire | P4 | Q41 · Clients, terrain et ventes |
| AV-522 | Restes des écrans : accueil du vendeur (S-47), objectifs de l'équipe (S-39), clients du siège (S-12), tablette partagée multi-vendeurs | Secondaire | P5 | Q15, Q16, Q17 |
| AV-523 | Exploitation de la base en ligne : sauvegarde quotidienne planifiée, copie hors hébergement, purge planifiée des alertes, essai de restaura… | Importante | MP | Q09 |
| AV-527 | Rapprochement tardif d'inventaire (BR-STK-044) et répartition de l'écart d'une ligne sans lot sur les lots (BR-STK-045) | Importante | P2 | Q41 · Catalogue, prix et stock |
| AV-528 | Fenêtre de saisie rétroactive appliquée à toute commande (suite d'AV-078 et d'AV-317) : droit de dépasser la fenêtre, motif dans l'audit | Importante | P0 | Q23 |
| AV-530 | Report des pièces papier DA, BC, VC et FI (suite de PP-B) : commandes utilisées, pièces non reportables, numéro de la pièce, contrôle du do… | Importante | PP | Q41 · Pièces papier et chargement de données |
| AV-531 | Report de la fiche de suivi de lot (FL) : saisies du jour du lot, œufs, aliment, fenêtre de 72 h | Importante | PP | Q23 |
| AV-532 | Restes d'AV-514 : jeux hors ligne de la présence et des bilans, vue d'analyse de la présence papier, rattachement d'une personne à son comp… | Secondaire | PP | Q41 · Pièces papier et chargement de données |
| AV-533 | Besoins serveur des écrans (revue du 07/11/2026) : ce qui est fait, ce qui est consigné | Secondaire | P5 | Q24, Q29 |
| AV-534 | Empreinte de l'enveloppe et drapeau captured_offline (S-13) : une commande renvoyée avec un autre drapeau est refusée | Secondaire | P0 | Q29 |
| AV-535 | Restes de P9 (D11 §7.2) : détail par canal et classement des commerciaux du bloc VENTES livrés ; disponible par zone (KPI-STK-01) non livré | Secondaire | P9 | Q41 · Analyse, alertes et notifications |
| AV-536 | Web Push : adaptateur serveur réel (RFC 8291 et 8292) activé par les clés VAPID du porteur ; abonnement de la PWA non fait | Importante | P9 | Q14 |
| AV-521 | Appareils : réservation atomique de l'essai de connexion, appareil lié à son premier compte, effacement des données d'un appareil hors serv… | Importante | MP | Q11 |
| AV-520 | Synchronisation : zones du périmètre, compaction du flux de changements, sortie d'une quarantaine, rapprochement manuel et annulation d'une… | Importante | P5 | Q41 · Distribution, caisse et quotas |
| AV-519 | Réception sans bon de commande, export CSV du registre de stock, motifs par défaut (AV-320) | Importante | P6 | Q41 · Achats et production |
