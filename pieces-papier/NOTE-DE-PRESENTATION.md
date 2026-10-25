# GIC AGROPELC — Pièces papier : note de présentation et de validation

**À l'attention de** la Direction, du responsable administratif et du promoteur de l'activité. Les annexes techniques sont à l'attention de l'imprimeur. Version 1.1 du 20 octobre 2026.

## 1. Objet

GIC AGROPELC doit disposer de **pièces physiques** qui répondent à deux besoins :

1. **Laisser une trace papier de chaque opération** enregistrée dans l'application. Le référentiel comptable OHADA/SYSCOHADA veut que les opérations soient justifiées par des pièces datées, conservées, classées et reliées aux écritures. L'application rend l'information accessible et facilite le reporting et l'analyse des tendances ; la pièce papier en est le **support probant**.
2. **Servir de relais quand l'application est indisponible** (absence d'électricité, appareil non chargé, pas de réseau, site isolé) : l'opération s'écrit sur la pièce, puis se reporte dans l'application au rétablissement.

La présente note propose **25 pièces** : carnets à souches pré-numérotés, blocs, registres, papeterie. Elles portent le logo de la société, la même charte graphique et les mêmes termes que l'application, de sorte que la ressaisie se fait sans interprétation. Une **facture** est prévue comme **modèle provisoire** et un **journal des encaissements** comme registre récapitulatif.

## 2. Décisions demandées

1. **Valider** le jeu de 25 pièces et leurs formats (§4).
2. **Faire valider par le comptable** les points légaux et fiscaux (§10), la facture en premier lieu : le modèle ne doit pas être imprimé avant cette validation.
3. **Compléter** les informations de la société qui manquent (§8).
4. **Autoriser** la consultation d'au moins trois imprimeurs sur la base du cahier des charges joint, puis l'épreuve (BAT) avant tirage.
5. **Prendre acte** des orientations d'intégration à l'application (§9), qui feront l'objet d'une instruction par l'équipe de développement.

## 3. Contenu du dossier

| Fichier ou dossier | Contenu |
|---|---|
| `pdf/CODE.pdf` | Aperçu de chaque pièce à l'échelle 1:1 (logo en couleur, numéro d'exemple 000001). |
| `pdf/CODE-impression.pdf` | Fichier à remettre à l'imprimeur : traits de coupe, légende technique, zone de numérotation vide, logo en deux encres. |
| `apercu/CODE-pN.png` | Images des pièces. |
| `gabarits/CODE.html` | Sources modifiables, une par pièce. |
| `charte/` | Logo officiel et variantes d'impression, feuille de style, identité de la société. |
| `CAHIER-DES-CHARGES-IMPRIMEUR.md` et `.pdf` | Spécifications d'impression pièce par pièce. |
| `CORRESPONDANCE-APPLICATION.xlsx` | Rubrique de chaque pièce, champ de l'application, référentiels, seuils. |
| `PROPOSITION-INTEGRATION-APPLICATION.md` | Proposition destinée à l'équipe de développement de l'application. |
| `REGLEMENTATION.md` | Points légaux vérifiés ou à valider, avec les sources. |
| `DOSSIER-DE-VALIDATION.pdf` | L'ensemble en un seul fichier. |
| `_generation/` | Scripts de fabrication (pièces, logo, classeur, dossier). |

## 4. Les 25 pièces : formats et supports

**Rappel des formats.** Le papier se commande par coupes d'une feuille **A4** (21 × 29,7 cm) : **A5** est un A4 coupé en deux (14,8 × 21 cm), **A6** un A5 coupé en deux. **Portrait** désigne la position verticale, **paysage** la position horizontale. Une **souche** est la bande perforée qui reste dans le carnet quand la pièce est remise. Un jeu **autocopiant** superpose 2 ou 3 feuillets sans papier carbone ; couleurs usuelles : ① blanc, ② rose, ③ jaune ; c'est le **jaune**, dernier feuillet, qui reste dans le carnet comme souche complète. Un **bloc** est un ensemble de feuilles collées en tête ; un **registre** est un cahier relié aux pages numérotées.

### Série « Argent » : carnets à souches, A5 paysage (210 × 148 mm), 3 feuillets autocopiants, 50 jeux par carnet

Format retenu : peu de lignes à écrire, usage au comptoir, tient dans un tiroir-caisse, deux pièces par feuille A4 donc coût d'impression réduit, souche de 43 mm à gauche.

| Code | Pièce | Objet | ① blanc | ② rose | ③ jaune |
|---|---|---|---|---|---|
| **BV** | Bon de vente | enregistrer une vente quand l'application est indisponible | client | comptabilité | carnet |
| **RE** | Reçu d'encaissement | prouver qu'un client a payé tout ou partie d'une vente | client | comptabilité | carnet |
| **BD** | Bon de décaissement (pièce de caisse) | justifier toute sortie d'argent : dépense, paiement fournisseur, avance, remboursement | bénéficiaire | comptabilité | carnet |
| **RF** | Remise de fonds | bordereau d'envoi puis de réception d'argent entre deux caisses ou vers la banque | destinataire | Finance | remettant |

### Série « Commande et livraison » : carnets à 3 feuillets autocopiants

| Code | Pièce | Format | Objet |
|---|---|---|---|
| **BL** | Bon de livraison (client) | A5 paysage, souche | prouver la remise des produits, livraison partielle et reste à livrer |
| **CC** | Bon de commande client | A5 paysage, souche | noter une commande prise sur le terrain, avec acompte |
| **BC** | Bon de commande fournisseur | A4 portrait | formaliser un achat ; il ne prouve ni la livraison ni le paiement |
| **BR** | Bon de réception | A4 portrait | contrôler commandé, livré, rejeté, accepté ; seul l'accepté entre en stock |
| **BT** | Bon de transfert de stock | A4 portrait | tracer un envoi entre deux emplacements, avec la partie « réception » |
| **FA** | Facture (**modèle provisoire**) | A4 portrait | à valider avec le comptable avant tout usage |

### Blocs et registres

| Code | Pièce | Format | Support | Objet |
|---|---|---|---|---|
| **FJC** | Feuille journalière de caisse | A4 portrait | bloc de 50 jeux, 2 feuillets | journal chronologique de la caisse : **28 lignes**, une opération par ligne, entrée ou sortie ; rapprochement des espèces, écart, signatures. Valable pour la caisse d'un point de vente, d'un commercial ou la caisse centrale. |
| **JE** | Journal des encaissements | A4 portrait | registre relié, 100 pages numérotées | récapitulatif par mode de paiement, **30 lignes** par page |
| **DA** | Demande d'achat | A4 portrait | bloc de 50 jeux, 2 feuillets | exprimer un besoin ; justification obligatoire |
| **FP** | Fiche de perte ou de consommation | A5 portrait | bloc de 50 jeux, 2 feuillets | mortalité, casse, perte inexpliquée, consommation d'intrant |
| **FI** | Fiche d'inventaire | A4 portrait | bloc de 100 feuilles | comptage physique d'un emplacement |
| **FL** | Suivi de lot de production | A4 paysage | bloc de 50 feuilles | mortalité, aliment, pesée, collecte d'œufs, jour par jour |
| **VC** | Fiche de visite commerciale | A5 portrait | bloc de 100 feuilles | visite, profil du client, veille sur les prix du marché, résultat |
| **BH** | Bilan hebdomadaire du commercial | A5 portrait | bloc de 50 feuilles | réussites, difficultés, besoins, priorités, informations du marché, visa du responsable |
| **PT** | Présence et pointage | A4 paysage | bloc de 50 feuilles | présence hebdomadaire, secours du pointage numérique |
| **RC** | Registre de suivi des carnets | A4 paysage | registre relié, 100 pages | numéros détenus, remise contre signature, retour, pièces annulées |

### Papeterie de marque (impression en couleur)

| Code | Pièce | Format | Support |
|---|---|---|---|
| **EL** | Papier à en-tête | A4 portrait | ramettes, 80 à 90 g |
| **BN-G / BN-R / BN-T** | Blocs-notes général, de réunion, de terrain | A5 portrait | 50 feuilles collées en tête, dos carton |
| **CV** | Couvertures de carnet : face avant (titre, plage de numéros, site, responsable) et dos (huit règles d'usage) | format du carnet | carton 250 à 300 g |

Les nombres de jeux, de feuilles et de pages sont des **usages courants** de l'imprimerie, non des prescriptions : l'imprimeur peut en proposer d'autres sans changer le dessin.

## 5. Papier autocopiant et souche : fonctionnement

- **Le papier autocopiant existe en carnets numérotés de 2 ou 3 exemplaires.** Il se compose d'un feuillet supérieur (CB), d'un intermédiaire (CFB) et d'un dernier (CF) traités chimiquement : ce qui est écrit au stylo à bille sur le feuillet du dessus se **reproduit par pression** sur ceux du dessous, sans papier carbone. Des fournisseurs proposent couramment des carnets de 50 feuillets numérotés en trois exemplaires. La disponibilité et le prix à Douala sont à confirmer par devis ; un article sur l'imprimerie de Douala indique que des ateliers de la ville fabriquent des carnets à souche et des liasses autocopiantes.
- **Sur chaque feuillet est imprimé le même dessin, souche comprise.** L'écriture se retrouve donc aussi dans la zone « souche » des feuillets rose et jaune.
- **À l'usage** : le feuillet blanc et le feuillet rose se détachent le long du pointillé ; leurs souches restent dans le carnet. Le feuillet jaune n'est pas détaché : il reste dans le carnet comme **souche complète**. Chaque pièce laisse ainsi trois traces concordantes.

## 6. Règles communes

1. **Numérotation continue**, six chiffres en orange, par type de pièce, **imprimée deux fois** (pièce et souche). L'imprimeur numérote ; le fichier d'impression laisse la zone vide.
2. **Une pièce erronée ne s'arrache jamais** : elle est barrée, marquée « ANNULÉ », la case « pièce annulée » est cochée et tous ses feuillets sont conservés. C'est la règle de l'application : on annule par contre-écriture, on ne supprime pas.
3. **Chaque pièce porte** : logo et identité de la société, titre, numéro, site ou point de vente, date et heure de l'opération, nom de la personne qui l'établit, signatures utiles (deux personnes dès qu'il s'agit d'argent ou de stock), cachet.
4. **Cartouche « Report dans l'application »** : date de saisie, saisi par, numéro d'opération, photo jointe.
5. **Deux encres** à l'impression : le vert du logo et l'orange doré de l'œuf, plus le noir du texte. Les aplats clairs sont des tramés du vert. Les pièces restent lisibles en photocopie noir et blanc.
6. **Photographiables** : repères de coin, contraste, rien d'important dans les 5 mm du bord. La photo de la pièce est la **pièce justificative numérique** de l'opération.
7. **Cases à cocher et codes de l'application** : mêmes libellés que les listes de l'application (moyens de paiement, catégories de dépense, catégories de perte, résultats de visite, unités).

## 7. Procédure de secours et report dans l'application

1. Constater l'indisponibilité de l'application et prendre le carnet du type d'opération.
2. Prendre la pièce suivante dans l'ordre des numéros. Écrire au stylo à bille, en appuyant, en majuscules lisibles, avec la **date et l'heure réelles** de l'opération. Faire signer.
3. Remettre le feuillet blanc ; le jaune reste dans le carnet.
4. En fin de journée, compléter la feuille journalière de caisse (FJC) et le journal des encaissements (JE).
5. Dès le rétablissement, **reporter chaque pièce dans l'ordre des numéros** : l'heure de l'opération est celle écrite sur la pièce ; le numéro imprimé est recopié ; la photo de la pièce est jointe ; la souche reçoit la date de saisie, le nom du saisissant et le numéro d'opération.
6. **Délai** : de préférence sous 24 heures. Valeurs actuelles de l'application (point AV-078, encore ouvert, paramétrables) : justification demandée au-delà de 24 heures, saisie refusée au-delà de 72 heures sauf validation.
7. **Doublon** : un fait déjà saisi ne se ressaisit pas ; la souche porte « déjà saisi — n° … ».
8. **Annulation d'une opération déjà saisie** : annuler dans l'application (contre-écriture) et annuler la pièce papier.

## 8. Identité de la société portée sur les pièces

| Rubrique | Valeur | État |
|---|---|---|
| Raison sociale | GIC AGROPELC | fournie |
| Boîte postale | 7633 Douala | fournie |
| Téléphone | +237 699 348 371 | fournie |
| NIU | M032416655486P | fournie |
| N° RCCM / autorisation | 24/034CMR/LT/01/GIC/004000/004000002 | fournie ; **à confirmer** : s'agit-il du numéro de RCCM ou de l'autorisation d'exercer du GIC ? |
| Siège (adresse) | — | **à fournir** |
| Forme juridique | — | à fournir (exemple : Groupe d'Initiative Commune) |
| Adresse e-mail, site web | — | à fournir |
| Banque, numéro de compte, mobile money | — | à fournir (facture et papier à en-tête) |
| Régime fiscal | — | à fournir |

Une rubrique vide s'imprime en pointillés à compléter à la main. Les rubriques se renseignent une seule fois dans `charte/identite.json`, puis les fichiers se régénèrent.

## 9. Orientations pour l'application

Le porteur a retenu douze orientations pour que les pièces et l'application se rejoignent. **Elles ne modifient pas l'application** : elles sont consignées dans `PROPOSITION-INTEGRATION-APPLICATION.md`, à l'attention de l'équipe de développement, qui vérifie leur conformité à la planification initiale.

| Sujet | Orientation retenue |
|---|---|
| Impression | l'application imprime chaque opération sur papier blanc, dans la mise en page des pièces, depuis le téléphone ou l'ordinateur, y compris hors ligne |
| Numéro de pièce | un champ « pièce papier » commun à toutes les opérations |
| Facture client | hors application pour l'instant |
| Journal de caisse | un journal par compte de trésorerie, imprimé par l'application ; la feuille vierge reste le secours |
| Caisse des commerciaux | même feuille de caisse, case « caisse du commercial » |
| Présence | petite table de présence alimentée chaque semaine à partir de la fiche PT |
| Registre des carnets | registre papier, contrôle de continuité par les numéros saisis |
| Bilan hebdomadaire | nouvelle fiche BH et nouvel écran |
| Veille marché | rubriques « fournisseur ou concurrent » et « prix constaté » sur la fiche de visite et dans la visite |
| Profil client | produit d'intérêt, potentiel par jour, mode de paiement habituel, ajoutés à la fiche et au compte client |
| Entrée des données | écran de report pour le courant, import par lots pour l'historique |
| Délai de report | 24 heures conseillées, 72 heures au maximum |

## 10. Points légaux à valider avec le comptable

Détail et sources dans `REGLEMENTATION.md`.

- **Facture** : liste exacte des mentions obligatoires ; mode d'émission. La fiche de la DGI sur la TVA indique que l'acheteur assujetti au réel doit disposer d'une facture générée par le système de facturation de l'administration, et la facturation électronique est annoncée par la loi de finances 2026. Le carnet de factures papier est donc **provisoire**.
- **TVA** : taux général 19,25 % ; traitement des œufs, de la volaille, des porcs et des aliments du bétail à confirmer (exonération possible).
- **Mention du RCCM** (numéro et lieu) sur les documents commerciaux : exigée par l'Acte uniforme OHADA sur le droit commercial général (art. 59). Déjà portée dans l'en-tête de chaque pièce.
- **Conservation** : dix ans d'après l'Acte uniforme OHADA relatif au droit comptable (source secondaire, article non vérifié).
- **Sans source trouvée** : droit de timbre sur les quittances, cotation et paraphe des registres, imprimeur agréé.
- **Paiement en espèces** : au-delà de 100 000 FCFA, une facture payée en espèces n'ouvre pas droit à déduction chez l'acheteur au réel (fiche DGI).

## 11. Étapes jusqu'à l'impression

1. Validation du jeu de pièces par la Direction.
2. Validation des points légaux par le comptable, puis passage de `validation_comptable_facture` à `true` dans `charte/identite.json` pour autoriser le fichier d'impression de la facture.
3. Complément de l'identité (§8) et régénération : `node pieces-papier/_generation/build.mjs all`.
4. Remise d'une version **vectorielle** du logo à l'imprimeur si elle existe (plus nette qu'une image).
5. Consultation d'au moins trois imprimeurs sur le cahier des charges.
6. **BAT signé** avant tirage : numérotation continue, perforation de la souche à 52 mm du bord gauche, couleurs des feuillets, coupe.
7. Quantités : nombre moyen d'opérations par jour et par type de pièce, multiplié par 90 jours, divisé par 50 jeux par carnet, plus un carnet de réserve par site (méthode indicative).
8. Remise des carnets contre signature dans le registre RC ; formation courte des équipes à la procédure de secours.
