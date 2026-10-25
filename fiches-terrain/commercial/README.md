# Fiche de reporting commercial — v2.0 (08/10/2026)

Un classeur Excel de 19 feuilles pour que les commerciaux et le responsable commercial **saisissent leur activité** (presque uniquement par listes déroulantes), et obtiennent **automatiquement** leurs rapports journalier, hebdomadaire et mensuel, la fiche de chaque client et un **tableau de bord** de leur performance dans la durée.

## Fichiers

| Fichier | Usage |
|---|---|
| `GIC_Reporting_Commercial_v2.0_MODELE_VIERGE.xlsx` | À remettre à **chaque commercial** (vide). |
| `GIC_Reporting_Commercial_v2.0_DEMARRAGE_Sept2026.xlsx` | Le même classeur, déjà garni avec la fiche « ETAT DEPLOIEMENT SEPTEMBRE » du commercial : 26 PDV et planning des semaines 1, 2 et 4. À remettre au **responsable commercial**. |
| `_generation/` | Scripts Python (openpyxl) qui produisent les deux fichiers. |

Régénérer (depuis `_generation/`, Python 3 avec `openpyxl`) : `python generer_fiche_commercial.py`. L'option `--exemple FICHIER` écrit un classeur d'essai avec des **données fictives**, utilisé pour vérifier les formules dans Excel ; il n'est jamais livré.

## Les feuilles

| Couleur | Feuille | Rôle |
|---|---|---|
| Vert | `LISEZ-MOI` | Mode d'emploi : **ce que je remplis et quand** (une fois, chaque matin, après chaque visite, chaque soir, chaque semaine, chaque mois), trois exemples pas à pas, liens entre les feuilles, règles d'or, sommaire cliquable, vocabulaire. |
| Vert | `Paramètres` | Identité et **code du commercial**, seuils d'alerte, liste de l'équipe. |
| Bleu | `Journal` | Une ligne par jour : heures, zone, frais, bilan ; chiffres du jour calculés. |
| Bleu | `Visites_Contacts` | Chaque visite sur place, appel ou message, avec résultat, prochaine action, veille concurrentielle. |
| Bleu | `Commandes` | Précommandes, commandes, ventes directes, une ligne par produit (prix, montant, statut calculés). |
| Bleu | `Encaissements` | Paiements reçus et versement à l'entreprise (espèces détenues, reste dû du client). |
| Sarcelle | `Clients` | Portefeuille : clients et prospects, statut automatique, pipeline, alertes, CA par client. |
| Sarcelle | `Planning` | Visites à faire par semaine, avec la commande prévisionnelle par jour. |
| Orange | `Stock`, `Objectifs`, `Bilans_Hebdo` | Saisies ponctuelles : stock confié et casses, cibles (semaine ou mois), texte du bilan hebdomadaire (+ chiffres de la semaine calculés). |
| Violet | `Fiche_Client` | **Recherche** d'un client (nom, téléphone, quartier, type) et son historique : visites, commandes, encaissements. |
| Violet | `Rapport_Jour`, `Rapport_Semaine`, `Plan_Mensuel`, `Équipe` | Rapports (formules seules, feuilles protégées sans mot de passe ; seules les cellules jaunes se choisissent). |
| Gris | `Listes`, `Correspondances` | Choix des listes déroulantes (dont dates, heures, quantités qui se mettent à jour seules) ; champ cible indicatif de chaque colonne dans l'application. |
| Violet | `Tableau_de_bord` (dernière page) | Semaine comparée à la précédente (▲/▼), mois comparé aux objectifs, portefeuille, évolution sur 12 semaines, 6 graphiques, répartitions par produit, quartier et résultat de visite. |

## Saisie dynamique (sans macro)

Le classeur est un `.xlsx` **sans macro**, donc sans avertissement de sécurité et ouvrable partout. Les saisies sont guidées ainsi :

- **Dates** : liste déroulante des jours (aujourd'hui en tête ; jours passés ou à venir selon la colonne), calculée à partir de `AUJOURDHUI()` ; lundis pour les semaines, mois pour les plans. Une autre date reste saisissable (message « information », validé par OK).
- **Heures** : liste de 05:00 à 22:00 par quarts d'heure.
- **Clients et produits** : listes déroulantes alimentées par la feuille `Clients` et par `Listes` ; dans Excel 365 la liste se filtre à la frappe (autocomplétion). Le libellé commence par le nom (« Resto La Paix [001] ») pour que la frappe fonctionne ; le numéro entre crochets relie les feuilles.
- **Cases à cocher** : liste à un clic « ☑ Oui / ☐ Non ». (Les cases à cocher natives d'Excel et un vrai calendrier contextuel exigeraient une macro ou une version précise d'Excel ; le choix a été de ne pas imposer de macro.)
- **Quantités, frais, remises** : valeurs courantes proposées en liste, autre valeur permise.
- Les champs obligatoires manquants et les dates mal écrites passent en **rouge**.

## Choix de conception

- **Calculé, jamais saisi** : statut du compte (Prospect → Client → Perdu), N° de commande, prix, montant, statut de la commande, « Versé ? », valeur d'une casse, fin d'un objectif, indicateurs hebdomadaires, tous les rapports et le tableau de bord viennent des lignes saisies.
- **Un client = un numéro** (`Resto La Paix [001]`) : les autres feuilles retrouvent le client par ce numéro et le commercial, pas par le nom. Renommer un client ne casse rien ; deux fiches fusionnées (numéros identiques) restent distinctes grâce à la colonne `Commercial`.
- **Nouveau client = première vente** (règle du contexte métier) : la date de première vente se calcule et le statut passe à « Client ».
- **CA réalisé** = lignes au statut « Livrée », à la date de livraison ; une précommande n'y entre qu'à la livraison.
- **Prochaine action** : celle du dernier contact du client (chaque contact remplace la précédente).
- Compatible **Excel 2010 et suivants** (pas de fonctions dynamiques `FILTER`, `UNIQUE`, `XLOOKUP`).
- Les montants sont en **XAF entiers**, les dates en `jj/mm/aaaa`, les numéros de téléphone en texte.

## Reprise de la fiche « ETAT DEPLOIEMENT SEPTEMBRE »

Les chiffres de la fiche d'origine sont rangés dans le classeur de démarrage, **une ligne complète par point de vente**, pour que le commercial ne reparte pas de zéro :

| Fiche d'origine | Dans le classeur |
|---|---|
| Les 26 points de vente des semaines 1, 2 et 4, avec leur numéro GSM | `Clients` : un prospect par ligne (nom, type, téléphone, localisation, quartier, source, étape, date de création) |
| Commande prévisionnelle par jour | `Clients` : « Potentiel estimé par jour » |
| Type de PDV (RESTO, PARTICULIER, REVENDEUR) | `Clients` : type de client (Restaurant, Particulier / ménage, Revendeur) |
| Découpage en semaines 1, 2 et 4 | `Planning` : une ligne par point de vente avec son numéro de semaine (09/2026) |
| TOTAL COMMANDE PRÉVISIONNELLE JOUR | `Plan_Mensuel` (septembre 2026) : 51 + 39 + 45 = **135 par jour** |

Valeurs de départ retenues, modifiables directement dans les feuilles :

- **Noms** construits d'après le type et la localisation (« Resto Beedi, entrée Maalam (1) », « Hôtel Dovil II », « Boulangerie La Paix »), les libellés en capitales de la fiche étant remis au propre ; « BLGRIE » est lu comme boulangerie.
- **Type de client** : celui de la fiche pour la semaine 4 ; pour les semaines 1 et 2, déduit du libellé quand il est explicite (hôtel, boulangerie, marché), sinon « Autre ».
- **Statut** : « Prospect » (calculé : aucune vente), **étape** « Nouveau », **source** « Prospection terrain », **date de création** = premier jour de la semaine de ciblage (1er, 7 et 21 septembre 2026).
- **Quartier** renseigné quand il ressort du libellé (PK9 à PK13, Logbessou, Logpom, Beedi, Cité des Palmiers).
- **Code commercial** « COM01 » prérempli dans `Paramètres`, à remplacer par le code réel.
- Produit et unité de la commande prévisionnelle : laissés au choix par point de vente ; la quantité par jour est additionnée telle quelle dans le plan mensuel.

**Le petit tableau « RECAP » (SIM reçues / déployées par DSM) n'a pas été repris** : le commercial a précisé qu'il s'y trouvait par erreur (modèle d'une autre activité de vente de SIM), à ignorer. Les codes « DSM », qui n'apparaissaient que dans ce tableau, ne sont donc pas repris non plus.

## Vérification

Chaque version a été ouverte dans Excel (automatisation COM) : recalcul complet **sans aucune erreur de formule** sur les 19 feuilles, structure conservée (noms, listes, validations, mises en forme conditionnelles, protections, graphiques), export PDF contrôlé visuellement (guide, rapports, fiche client, tableau de bord), et résultats contrôlés contre des valeurs calculées à la main sur un jeu d'essai fictif (deux commerciaux, numéros de client en doublon, semaine complète, mois) : 6 visites, 3 prospects, 2 nouveaux clients, 450 000 XAF de commandes, 96 000 XAF de CA, 76 000 XAF encaissés, 30 000 XAF d'espèces non versées. Le plan de septembre reproduit les totaux de la fiche d'origine.

## Chargement futur dans l'application

Non traité ici (demande explicite). La feuille `Correspondances` donne le champ cible indicatif de chaque colonne (clients → `crm.customers`, visites → `crm.visits` / `crm.interactions`, commandes → `sales.sales_orders` / `sales.sales`, encaissements → `sales.customer_payments`, objectifs → `crm.sales_targets`, journal → `fieldwork.work_sessions`). La colonne `Réf. de la ligne` (`COM01-V00012`…) sert de clé pour éviter les doublons.
