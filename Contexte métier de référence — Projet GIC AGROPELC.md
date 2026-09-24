# CONTEXTE MÉTIER DE RÉFÉRENCE  
## Projet d'application de gestion intégrée GIC AGROPELC

---

# 0. STATUT DE CE DOCUMENT

Le présent document décrit le **contexte métier, les objectifs opérationnels et les contraintes réelles** dans lesquels doit être conçue l'application de gestion de GIC AGROPELC.

Il constitue une **source de vérité métier initiale** pour les travaux d'analyse, d'architecture, de modélisation et de développement.

Il ne constitue pas encore :

- un schéma définitif de base de données ;
- une architecture logicielle définitive ;
- une spécification exhaustive de toutes les règles métier ;
- une liste finale d'écrans ;
- un choix définitif de technologies.

Lorsqu'une information n'est pas explicitement définie dans ce contexte, elle ne doit pas être inventée comme si elle était déjà décidée.

Les éléments manquants devront être :

- déduits lorsqu'une seule solution raisonnable découle du métier ;
- signalés lorsqu'une décision reste nécessaire ;
- marqués comme `À VALIDER` lorsqu'ils nécessitent une décision de GIC AGROPELC.

---

# 1. PRÉSENTATION GÉNÉRALE DU BESOIN

GIC AGROPELC entre dans une phase de croissance où une gestion manuelle, dispersée dans des cahiers, feuilles Excel, messages WhatsApp ou mémoires individuelles ne sera plus suffisante pour piloter correctement l'activité.

L'exploitation doit produire et commercialiser plusieurs catégories de produits issus notamment de :

- l'élevage de poulets ;
- la production d'œufs ;
- l'incubation et la production éventuelle de poussins ;
- l'élevage de porcs ;
- la commercialisation de produits issus de ces productions.

L'augmentation future des volumes implique également :

- davantage de clients ;
- davantage de commerciaux ;
- plusieurs responsables ;
- plusieurs points de vente ;
- plusieurs lieux de stockage ;
- davantage de fournisseurs ;
- davantage d'intrants ;
- davantage de mouvements physiques ;
- davantage de transactions financières ;
- davantage de risques d'erreur ou de fraude ;
- davantage de données à consolider pour la direction.

GIC AGROPELC souhaite donc créer une application interne permettant de piloter l'ensemble de ces opérations de manière cohérente.

L'objectif n'est pas simplement de disposer d'un logiciel de stock ou d'un CRM.

L'objectif est de construire progressivement un **système central de contrôle opérationnel de l'entreprise**.

---

# 2. VISION GÉNÉRALE DU SYSTÈME

La vision du projet peut être résumée ainsi :

> **Permettre à la direction de GIC AGROPELC de savoir, avec un niveau élevé de fiabilité, ce qui a été acheté, reçu, produit, stocké, transféré, vendu, perdu, encaissé et dépensé, ainsi que les personnes responsables de chacune de ces opérations.**

À tout moment, le système doit tendre à répondre à des questions simples mais fondamentales :

### Production

- Combien d'animaux avons-nous ?
- Combien avons-nous perdu ?
- Combien d'œufs avons-nous produits ?
- Combien sont commercialisables ?
- Combien ont été affectés à l'incubation ?
- Combien d'animaux sont prêts ou susceptibles d'être commercialisés ?

### Stock

- Quel stock avons-nous ?
- Où se trouve-t-il ?
- Depuis quand ?
- De quel lot ou de quelle opération provient-il ?
- Quelle quantité est disponible ?
- Quelle quantité est affectée à un commercial ou à un point de vente ?

### Commercial

- Combien de prospects avons-nous ?
- Qui les a acquis ?
- Quel commercial est responsable de quel client ?
- Combien de visites ont été réalisées ?
- Combien de ventes chaque commercial génère-t-il ?
- Quels sont les meilleurs clients ?
- Quels clients ne commandent plus ?

### Distribution

- Quelle quantité a été envoyée vers chaque point de vente ?
- Quelle quantité y a été vendue ?
- Quelle quantité y reste ?
- Quelles pertes ou casses ont été déclarées ?
- Faut-il réapprovisionner le point de vente ?

### Finance

- Quel chiffre d'affaires a été réalisé ?
- Combien a effectivement été encaissé ?
- Quelles créances restent ouvertes ?
- Combien avons-nous dépensé ?
- Combien nous coûtent les pertes ?
- Quelle marge l'activité produit-elle ?

### Responsabilité

- Qui a effectué l'opération ?
- Quand ?
- Où ?
- Sur quel appareil ?
- L'opération a-t-elle été réalisée en ligne ou hors connexion ?
- Qui l'a validée lorsqu'une validation était nécessaire ?

---

# 3. PHILOSOPHIE GÉNÉRALE DU PRODUIT

GIC AGROPELC ne souhaite pas construire un logiciel inutilement complexe.

L'application devra être :

- simple à comprendre ;
- rapide à utiliser ;
- adaptée au téléphone ;
- utilisable par des profils non techniques ;
- adaptée aux réalités du terrain ;
- robuste lorsque la connexion Internet est mauvaise ;
- rigoureuse dans la manière dont elle enregistre les opérations.

La philosophie générale du produit est donc :

> **Interface simple, moteur rigoureux.**

La complexité métier et technique doit être prise en charge autant que possible par le système et ne doit pas être transférée inutilement vers les utilisateurs.

Un commercial ne devrait pas avoir besoin de comprendre la structure de la base de données ou les mécanismes de synchronisation.

Il doit simplement pouvoir effectuer facilement son travail.

Même logique pour :

- le vendeur ;
- le magasinier ;
- le responsable de production ;
- le comptable ;
- le responsable commercial.

---

# 4. CHAÎNE DE VALEUR À PILOTER

L'activité doit être envisagée comme une chaîne cohérente :

**APPROVISIONNER  
→ RECEVOIR  
→ PRODUIRE  
→ STOCKER  
→ TRANSFÉRER  
→ PROSPECTER  
→ COMMANDER  
→ VENDRE  
→ LIVRER  
→ ENCAISSER  
→ ANALYSER**

Ces opérations ne doivent pas vivre dans des systèmes indépendants.

Elles représentent différentes étapes d'une même activité.

Exemple :

Un achat d'aliments pour poulets peut avoir un effet sur :

- les achats ;
- les fournisseurs ;
- la réception ;
- le stock d'intrants ;
- le coût d'un lot de production ;
- la trésorerie ;
- la marge future de la production concernée.

De la même manière, la vente d'un poulet peut potentiellement avoir un impact sur :

- le stock ;
- le point de vente ;
- le commercial ;
- le client ;
- la commande ;
- le chiffre d'affaires ;
- l'encaissement ;
- la créance éventuelle ;
- la marge ;
- les performances commerciales.

Le système doit donc préserver les relations entre ces événements.

---

# 5. LES TROIS DIMENSIONS DE CONTRÔLE

Toutes les opérations importantes doivent idéalement pouvoir être analysées selon trois dimensions.

## 5.1 Dimension physique

Elle représente ce qui existe ou ce qui bouge réellement.

Exemples :

- animaux ;
- œufs ;
- poussins ;
- porcs ;
- aliments ;
- médicaments ;
- emballages ;
- consommables ;
- marchandises ;
- produits finis.

Elle permet de répondre :

> Qu'avons-nous ?

> Combien ?

> Où ?

---

## 5.2 Dimension financière

Elle représente la valeur économique associée à l'activité.

Exemples :

- vente ;
- achat ;
- dépense ;
- encaissement ;
- créance ;
- paiement fournisseur ;
- coût de production ;
- perte ;
- marge.

Elle permet de répondre :

> Combien cela nous coûte ?

> Combien cela nous rapporte ?

> Combien avons-nous réellement encaissé ?

---

## 5.3 Dimension responsabilité

Elle permet de savoir qui est responsable des opérations.

Elle doit permettre autant que possible de retrouver :

- l'utilisateur ;
- le rôle ;
- le lieu ;
- la date ;
- l'heure ;
- l'appareil ;
- la personne ayant validé ;
- l'état de synchronisation.

Cette dimension est particulièrement importante pour réduire :

- les erreurs ;
- les pertes inexpliquées ;
- les modifications non autorisées ;
- les contestations ;
- les fraudes internes.

---

# 6. ORGANISATION COMMERCIALE

GIC AGROPELC souhaite développer une véritable force de vente.

L'organisation commencera avec un responsable commercial pouvant temporairement jouer plusieurs rôles, notamment :

- responsable commercial ;
- commercial opérationnel.

À mesure que l'activité évoluera, plusieurs commerciaux pourront être recrutés sous sa responsabilité.

Le système doit donc être conçu dès le départ pour fonctionner avec plusieurs commerciaux.

Plusieurs catégories de vendeurs peuvent exister.

### Commercial terrain

Il prospecte physiquement des clients.

### Commercial sédentaire

Il travaille principalement depuis un bureau ou à travers les canaux digitaux.

### Vendeur de point de vente

Il opère depuis un emplacement commercial déterminé.

### Responsable commercial

Il suit les performances de l'équipe et supervise l'activité commerciale.

Un même utilisateur peut cumuler plusieurs fonctions.

Le modèle organisationnel ne doit donc pas considérer qu'une personne possède nécessairement un seul rôle.

---

# 7. PROSPECTION ET ACQUISITION CLIENT

Chaque commercial doit pouvoir développer son propre portefeuille.

Le système devra permettre d'enregistrer notamment :

- les prospects identifiés ;
- leurs coordonnées ;
- leur localisation ;
- leur activité lorsque pertinente ;
- leur type ;
- la source du prospect ;
- le commercial responsable ;
- les visites ;
- les interactions ;
- les commandes ;
- l'évolution du prospect ;
- son éventuelle conversion en client.

L'objectif est de mesurer l'effort commercial, pas seulement le résultat final.

Le système doit par exemple pouvoir répondre à :

> Combien de prospects un commercial a-t-il ajoutés aujourd'hui ?

> Combien de prospects a-t-il visités cette semaine ?

> Combien ont effectivement commandé ?

> Combien sont devenus clients ?

> Quel chiffre d'affaires provient des clients acquis par ce commercial ?

---

# 8. PROPRIÉTÉ ET ATTRIBUTION DES CLIENTS

Il doit être possible de rattacher un client à un commercial.

Cette relation est importante pour :

- la responsabilité commerciale ;
- le suivi du portefeuille ;
- le calcul des performances ;
- l'analyse du chiffre d'affaires ;
- les objectifs ;
- les éventuelles commissions futures.

Le système doit pouvoir répondre à des questions telles que :

> Quel commercial gère ce client ?

> Quel client génère le plus de chiffre d'affaires ?

> Quels sont les clients les plus importants du commercial X ?

> Quel chiffre d'affaires provient du portefeuille du commercial Y ?

L'historique d'éventuelles réaffectations devra être pris en considération lors de la conception.

---

# 9. MESURE DE LA PERFORMANCE COMMERCIALE

La direction souhaite pouvoir suivre les performances de chaque commercial sur une période quelconque.

Les périodes ne doivent pas être limitées à des rapports fixes.

L'utilisateur doit pouvoir sélectionner :

- aujourd'hui ;
- hier ;
- cette semaine ;
- ce mois ;
- cette année ;
- ou une plage de dates personnalisée.

Les principaux indicateurs commerciaux peuvent notamment inclure :

- prospects créés ;
- prospects visités ;
- contacts collectés ;
- nouveaux clients ;
- commandes ;
- ventes ;
- chiffre d'affaires ;
- quantité vendue ;
- panier moyen ;
- conversion ;
- clients actifs ;
- clients inactifs ;
- réachat ;
- performance par produit ;
- performance par zone ;
- performance par canal.

Les indicateurs devront être calculés à partir des opérations enregistrées et non saisis manuellement.

---

# 10. PRISE DE SERVICE DES COMMERCIAUX

Pour les commerciaux terrain, la présence sur le terrain constitue une information importante.

Lorsqu'un commercial commence son activité, il doit pouvoir déclarer sa prise de service.

La prise de service doit pouvoir contenir notamment :

- utilisateur ;
- date ;
- heure ;
- zone déclarée ;
- position géographique ;
- précision fournie par l'appareil ;
- appareil utilisé.

Le système doit vérifier que la position est compatible avec la zone dans laquelle le commercial prétend travailler.

La tolérance géographique envisagée se situe autour d'un rayon de plusieurs centaines de mètres, avec une valeur initialement envisagée de **500 mètres**.

L'objectif n'est pas de disposer d'un système militaire de géolocalisation extrêmement précis.

L'objectif est de réduire les déclarations manifestement frauduleuses.

Une tentative de prise de service hors zone peut être conservée pour audit.

Il n'est pas actuellement nécessaire d'imposer une géolocalisation permanente de la personne toute la journée.

Les événements importants de localisation sont prioritairement :

- prise de service ;
- éventuellement fin de service ;
- visite d'un prospect ;
- opérations terrain importantes.

---

# 11. CANAUX COMMERCIAUX

Les ventes de GIC AGROPELC peuvent provenir de plusieurs canaux.

Notamment :

- prospection terrain ;
- vente directe ;
- points de vente ;
- commercial sédentaire ;
- leads digitaux ;
- WhatsApp ;
- canaux gérés à travers Kommo.

Le système doit éviter de considérer que toutes les ventes viennent d'une seule source.

Cette information doit permettre d'analyser :

- les ventes terrain ;
- les ventes digitales ;
- les ventes en point de vente ;
- les performances commerciales par canal.

---

# 12. POINTS DE VENTE

GIC AGROPELC prévoit à terme d'ouvrir plusieurs points de vente, notamment dans différents marchés ou zones commerciales.

Chaque point de vente doit pouvoir fonctionner comme une unité opérationnelle identifiable.

Il peut disposer :

- d'un stock ;
- d'un ou plusieurs vendeurs ;
- de prix applicables ;
- d'une caisse ;
- de ventes ;
- de pertes ;
- de transferts ;
- d'inventaires.

La direction doit pouvoir savoir presque immédiatement :

- ce qui a été envoyé au point de vente ;
- ce qui a été vendu ;
- ce qui reste ;
- ce qui a été perdu ;
- ce qui a été encaissé ;
- si un réapprovisionnement est nécessaire.

---

# 13. VENTES

Lorsqu'un vendeur effectue une vente, celle-ci doit être enregistrée dans le système.

La vente doit pouvoir être associée selon le contexte à :

- un vendeur ;
- un commercial ;
- un client ;
- un point de vente ;
- un produit ;
- une quantité ;
- un prix ;
- une date ;
- un paiement ;
- éventuellement un lot d'origine.

Une vente ne doit pas simplement augmenter le chiffre d'affaires.

Elle doit avoir les effets appropriés sur les autres dimensions du système.

Par exemple :

- diminution du stock concerné ;
- augmentation du chiffre d'affaires ;
- création ou mise à jour éventuelle d'une créance ;
- rattachement à un commercial ;
- rattachement à un client ;
- prise en compte dans les tableaux de bord.

---

# 14. PRODUCTION

L'application doit permettre de suivre l'activité de production.

La notion de production couvre plusieurs réalités différentes qui ne doivent pas être artificiellement confondues.

---

# 15. PRODUCTION DE POULETS

La production avicole doit pouvoir être organisée autour de lots ou campagnes.

Exemple :

> Campagne de 2 400 poulets.

Pour un lot, il peut être nécessaire de suivre notamment :

- quantité initiale ;
- date de démarrage ;
- bâtiment ;
- fournisseur ;
- souche lorsque pertinente ;
- mortalités ;
- effectif restant ;
- alimentation ;
- poids lorsque disponible ;
- coûts ;
- transferts ;
- sortie vers commercialisation.

La quantité disponible ne doit pas être arbitrairement modifiée.

Elle doit évoluer selon les événements réellement enregistrés.

---

# 16. MORTALITÉ ANIMALE

La mortalité constitue un événement métier important.

Lorsqu'un animal meurt :

- le stock biologique réel change ;
- la quantité future commercialisable change ;
- la performance du lot change ;
- le coût du lot est réparti sur une quantité plus faible ;
- une perte économique est générée.

La mortalité doit donc être traçable.

Selon l'importance de l'événement, une preuve ou une validation pourra être nécessaire.

---

# 17. PRODUCTION D'ŒUFS

Les œufs ne doivent pas être considérés uniquement comme une quantité de stock.

La production quotidienne peut nécessiter de distinguer :

- œufs collectés ;
- œufs cassés ;
- œufs non conformes ;
- œufs commercialisables ;
- œufs destinés à l'incubation.

Selon l'évolution de l'exploitation, d'autres classifications pourront être ajoutées.

Le stock d'œufs commercialisables doit résulter de ces événements.

---

# 18. INCUBATION

Une partie des œufs peut être destinée à produire des poussins.

Le processus d'incubation constitue donc une activité distincte.

Il peut inclure notamment :

- constitution d'un lot d'œufs ;
- entrée en incubateur ;
- quantité incubée ;
- mirage ;
- œufs infertiles ;
- mortalité embryonnaire ;
- transfert vers éclosoir ;
- poussins obtenus ;
- pertes ;
- taux d'éclosion.

L'objectif est de pouvoir relier la quantité d'œufs engagés au résultat réel obtenu.

---

# 19. PRODUCTION PORCINE

Le système doit également pouvoir gérer la production porcine.

Le suivi pourra initialement fonctionner par groupe ou lot.

Les principales informations peuvent notamment comprendre :

- entrée ;
- case ou bâtiment ;
- effectif ;
- alimentation ;
- poids lorsque suivi ;
- mortalité ;
- transfert ;
- vente.

L'identification individuelle des animaux pourra être prévue comme évolution future sans nécessairement être imposée au MVP.

---

# 20. GESTION DES STOCKS

Le stock constitue l'un des domaines les plus critiques du projet.

GIC AGROPELC souhaite connaître avec fiabilité les quantités disponibles.

Le stock ne concerne pas uniquement les produits destinés à la vente.

Il faut distinguer plusieurs familles.

### Stock biologique

Exemples :

- poulets ;
- poussins ;
- porcs.

### Production commercialisable

Exemples :

- œufs ;
- animaux prêts à la vente ;
- produits transformés éventuels.

### Stock commercial

Produits affectés à :

- un magasin ;
- un point de vente ;
- un vendeur ;
- une zone de distribution.

### Intrants

Exemples :

- aliments ;
- maïs ;
- soja ;
- médicaments ;
- vaccins ;
- produits sanitaires ;
- emballages ;
- alvéoles ;
- autres consommables.

---

# 21. PRINCIPE DE TRAÇABILITÉ DU STOCK

Le stock doit être traçable.

Un utilisateur ne devrait généralement pas simplement remplacer :

> Stock = 100

par :

> Stock = 95.

Il faut comprendre pourquoi le stock est passé de 100 à 95.

Exemples de causes :

- vente ;
- perte ;
- mortalité ;
- transfert ;
- consommation ;
- inventaire ;
- casse.

Le système doit donc conserver une histoire permettant de reconstruire les variations.

---

# 22. TRANSFERTS

Les produits peuvent circuler entre plusieurs emplacements.

Exemples :

- ferme vers magasin ;
- magasin vers point de vente ;
- ferme vers point de vente ;
- magasin vers commercial ;
- point de vente vers autre point de vente ;
- retour vers magasin.

La direction doit pouvoir connaître :

- ce qui a quitté l'emplacement A ;
- quand ;
- par qui ;
- ce qui a été reçu dans l'emplacement B ;
- par qui ;
- les éventuelles différences.

---

# 23. AFFECTATION DE STOCK AUX UTILISATEURS

Certains vendeurs ou commerciaux peuvent recevoir une quantité déterminée de marchandises.

Exemple :

> Commercial A reçoit 50 poulets.

Il devient responsable de cette quantité jusqu'à ce qu'elle soit :

- vendue ;
- retournée ;
- transférée ;
- déclarée comme perte ;
- régularisée lors d'un inventaire.

Cette logique devient particulièrement importante lorsque le commercial travaille sans connexion Internet.

---

# 24. PERTES, CASSES ET INCIDENTS

L'activité peut produire différentes formes de pertes.

Exemples :

- mortalité ;
- casse d'œufs ;
- détérioration ;
- produit impropre à la vente ;
- destruction ;
- perte inexpliquée ;
- vol suspecté ;
- erreur d'inventaire.

Une perte doit pouvoir être documentée avec notamment :

- nature ;
- produit ;
- quantité ;
- lieu ;
- date ;
- utilisateur ;
- motif ;
- commentaire ;
- lot lorsque pertinent.

Selon la nature ou le niveau de la perte, le système pourra demander :

- une photo ;
- une validation ;
- une justification renforcée.

L'objectif n'est pas de bureaucratiser chaque petite perte.

L'objectif est d'améliorer la traçabilité en fonction du risque.

---

# 25. INVENTAIRE

Le système doit pouvoir comparer :

### Stock théorique

Quantité calculée à partir des opérations enregistrées.

### Stock physique

Quantité effectivement constatée.

Un écart doit être visible et expliqué.

Exemple :

> Théorique : 100

> Physique : 97

> Écart : -3

Le système ne doit pas simplement masquer cette différence.

Elle doit générer une opération de régularisation traçable.

---

# 26. FOURNISSEURS

GIC AGROPELC souhaite mieux contrôler ses fournisseurs et ses approvisionnements.

Les fournisseurs peuvent fournir notamment :

- aliments ;
- matières premières ;
- médicaments ;
- équipements ;
- emballages ;
- consommables ;
- autres intrants.

Le système devra progressivement permettre de connaître :

- ce qui a été commandé ;
- à qui ;
- à quel prix ;
- ce qui a réellement été reçu ;
- les écarts ;
- les documents correspondants ;
- les montants facturés ;
- les montants payés.

---

# 27. PROCESSUS D'ACHAT

Le processus cible doit permettre de distinguer plusieurs événements.

Conceptuellement :

**BESOIN  
→ DEMANDE D'ACHAT  
→ VALIDATION  
→ COMMANDE FOURNISSEUR  
→ RÉCEPTION  
→ FACTURE  
→ PAIEMENT**

Ces étapes ne représentent pas nécessairement toutes des interfaces différentes, mais elles constituent des événements métier différents.

Il est fondamental de comprendre que :

> commandé ≠ livré ≠ reçu ≠ accepté ≠ facturé ≠ payé.

---

# 28. RÉCEPTION DES INTRANTS

Le magasinier ou responsable concerné doit confirmer ce qui est réellement reçu.

Exemple :

> Commandé : 100 sacs

> Livré : 98 sacs

> Rejeté : 3 sacs

> Accepté : 95 sacs

Le stock ne doit augmenter que de la quantité réellement acceptée.

La réception doit être traçable.

Elle pourra comporter :

- fournisseur ;
- commande ;
- produit ;
- quantité ;
- date ;
- magasinier ;
- justificatif ;
- observations ;
- lot fournisseur éventuel.

---

# 29. TARIFICATION

Les prix de GIC AGROPELC ne seront pas nécessairement identiques partout.

Ils pourront varier selon différents critères.

Exemples :

- Douala ;
- Yaoundé ;
- marché ;
- quartier ;
- point de vente ;
- saison ;
- type de client ;
- quantité achetée ;
- période commerciale.

La direction ou les personnes autorisées doivent pouvoir modifier les tarifs.

Une fois une règle tarifaire applicable, les vendeurs doivent accéder au bon prix sans attendre une réunion, un appel ou une note manuelle.

---

# 30. HISTORIQUE DES PRIX

Lorsqu'un prix change, les anciennes transactions ne doivent pas être réécrites.

Exemple :

Un poulet vendu le 10 septembre à 4 500 FCFA doit rester enregistré à 4 500 FCFA même si son prix passe à 4 800 FCFA le 20 septembre.

La transaction doit donc conserver les informations permettant de savoir :

- quel prix a été appliqué ;
- pourquoi ;
- quand ;
- selon quelle règle.

---

# 31. FINANCE ET COMPTABILITÉ OPÉRATIONNELLE

La direction souhaite que les opérations commerciales et physiques aient une traduction financière cohérente.

À court terme, l'objectif principal n'est pas de reconstruire un logiciel comptable réglementaire exhaustif.

L'objectif est d'obtenir une **comptabilité opérationnelle fiable de l'activité**.

Le système doit permettre de suivre notamment :

- ventes ;
- chiffre d'affaires ;
- encaissements ;
- créances ;
- dépenses ;
- achats ;
- fournisseurs ;
- paiements ;
- caisses ;
- pertes ;
- coût des stocks ;
- marges.

---

# 32. RELATION ENTRE STOCK ET FINANCE

Les dimensions physiques et financières ne doivent pas être complètement indépendantes.

Exemple :

Lorsqu'une quantité est vendue :

- le stock diminue ;
- une vente existe ;
- une valeur financière existe ;
- un encaissement peut exister ;
- une créance peut éventuellement exister.

Lorsqu'une perte importante est enregistrée :

- la quantité physique diminue ;
- la valeur du stock perdu doit pouvoir être connue.

Lorsqu'un intrant est acheté :

- une dépense ou dette fournisseur apparaît ;
- une réception augmente éventuellement le stock.

Le système doit permettre à terme de rapprocher ces informations.

---

# 33. PILOTAGE DES CAMPAGNES DE PRODUCTION

La direction doit pouvoir analyser la performance d'une campagne ou d'un lot.

Exemple :

> Campagne : 2 400 poulets

Le système doit permettre progressivement d'analyser :

- quantité initiale ;
- mortalités ;
- quantité vendue ;
- quantité restante ;
- intrants consommés ;
- coûts ;
- pertes ;
- chiffre d'affaires ;
- marge.

L'objectif est de pouvoir déterminer la rentabilité réelle d'une production et non uniquement le chiffre d'affaires généré.

---

# 34. TABLEAUX DE BORD

Plusieurs catégories d'utilisateurs ont besoin de tableaux de bord différents.

---

## 34.1 Direction

La direction doit obtenir une vue synthétique de l'activité.

Elle doit pouvoir comprendre rapidement :

- production ;
- stock ;
- ventes ;
- encaissements ;
- dépenses ;
- créances ;
- pertes ;
- performances commerciales ;
- alertes.

L'objectif est de créer une véritable **tour de contrôle opérationnelle**.

---

## 34.2 Responsable commercial

Il doit pouvoir suivre :

- ventes ;
- prospects ;
- visites ;
- clients ;
- objectifs ;
- performances individuelles ;
- performances par zone ;
- clients inactifs ;
- tendances commerciales.

---

## 34.3 Commercial

Il doit voir prioritairement ses propres informations :

- objectifs ;
- prospects ;
- clients ;
- visites ;
- commandes ;
- ventes ;
- performances ;
- actions à réaliser.

---

## 34.4 Magasinier

Il doit principalement voir :

- réceptions ;
- sorties ;
- transferts ;
- stock ;
- alertes ;
- pertes ;
- inventaires.

---

## 34.5 Production

Il doit pouvoir suivre :

- lots ;
- effectifs ;
- mortalités ;
- production ;
- alimentation ;
- œufs ;
- incubation ;
- disponibilité.

---

## 34.6 Finance / Comptabilité

Il doit pouvoir suivre :

- ventes ;
- paiements ;
- créances ;
- dépenses ;
- fournisseurs ;
- caisse ;
- coûts ;
- marges.

---

# 35. ANALYSE FLEXIBLE DES DONNÉES

GIC AGROPELC ne souhaite pas dépendre uniquement de rapports fixes.

La direction souhaite retrouver une flexibilité proche d'un tableau Excel ou d'un tableau croisé dynamique.

L'utilisateur doit pouvoir effectuer des analyses telles que :

> ventes entre deux dates ;

> ventes par commercial ;

> ventes par produit ;

> ventes par zone ;

> ventes par point de vente ;

> pertes par produit ;

> pertes par lot ;

> prospects créés par période ;

> performances des vendeurs ;

> meilleurs clients.

Les grandes vues analytiques devront donc permettre autant que possible :

- filtre ;
- tri ;
- regroupement ;
- sélection de colonnes ;
- agrégation ;
- export.

---

# 36. TEMPS RÉEL

Lorsque les appareils disposent d'une connexion Internet, la direction souhaite pouvoir observer rapidement l'évolution de l'activité.

Exemples :

- nouvelle vente ;
- nouvelle commande ;
- stock restant ;
- besoin de réapprovisionnement ;
- nouvelle réception ;
- perte importante.

Toutefois, le contexte réseau ne permet pas de garantir une connexion Internet permanente.

Il faut donc distinguer deux situations.

### Appareil connecté

Les nouvelles données peuvent être remontées rapidement vers le système central.

### Appareil hors connexion

L'opération reste enregistrée localement et devient visible globalement après synchronisation.

La promesse métier correcte est donc :

> **mise à jour quasi immédiate lorsque l'utilisateur est connecté et synchronisation automatique lorsque la connexion revient.**

---

# 37. CONTRAINTE MAJEURE : FONCTIONNEMENT HORS CONNEXION

L'application doit être utilisable dans des zones où la connexion Internet peut être :

- lente ;
- intermittente ;
- temporairement inexistante.

Cette contrainte concerne particulièrement :

- commerciaux terrain ;
- vendeurs ;
- magasinier ;
- exploitation agricole.

L'absence de connexion ne doit pas empêcher systématiquement :

- l'enregistrement d'une vente ;
- l'enregistrement d'un prospect ;
- l'enregistrement d'une visite ;
- certaines déclarations de pertes ;
- certaines opérations de terrain ;
- la consultation des informations essentielles déjà synchronisées.

L'application doit donc être pensée **offline-first dès le départ**.

---

# 38. HEURE RÉELLE DES OPÉRATIONS

Une opération effectuée hors connexion doit conserver son heure réelle.

Exemple :

> Vente effectuée : 11h47.

> Retour Internet : 14h22.

> Synchronisation : 14h23.

L'heure métier de la vente reste **11h47**.

Le système doit distinguer :

- le moment réel de l'opération ;
- le moment de création technique éventuel ;
- le moment de réception par le serveur ;
- le moment de synchronisation.

Cette distinction est importante pour :

- les rapports ;
- les performances commerciales ;
- les caisses ;
- l'audit.

---

# 39. CONFLITS DE STOCK HORS CONNEXION

Le fonctionnement hors connexion crée un risque important.

Exemple :

Deux utilisateurs pensent disposer du même stock lorsqu'ils n'ont plus Internet.

Ils peuvent alors théoriquement vendre plus que la quantité réellement disponible.

GIC AGROPELC souhaite éviter autant que possible ce problème.

Une stratégie envisagée consiste à affecter explicitement certaines quantités à :

- un point de vente ;
- un commercial ;
- un vendeur ;
- un magasin.

Ainsi, un utilisateur travaillant hors ligne ne consomme prioritairement que le stock dont il est responsable.

Cette exigence doit être étudiée avec attention lors de la conception technique.

---

# 40. TRAÇABILITÉ

La traçabilité constitue une exigence fondamentale du projet.

Pour les opérations sensibles, la direction doit pouvoir comprendre :

- ce qui s'est passé ;
- qui l'a fait ;
- quand ;
- où ;
- avec quel appareil ;
- quelle était l'ancienne information ;
- quelle est la nouvelle information ;
- si l'opération a été effectuée hors connexion ;
- qui l'a validée.

Une opération importante ne doit pas pouvoir disparaître silencieusement.

---

# 41. ANNULATION ET CORRECTION

Dans les domaines sensibles, corriger une erreur ne doit pas nécessairement signifier supprimer toute trace de l'opération précédente.

Exemples :

- vente ;
- paiement ;
- réception ;
- mouvement de stock ;
- perte.

La direction souhaite pouvoir reconstruire l'histoire.

Les mécanismes de :

- correction ;
- annulation ;
- contre-opération ;
- ajustement ;

devront donc être étudiés.

---

# 42. PIÈCES JUSTIFICATIVES

Pour certaines opérations importantes, une pièce justificative peut être nécessaire.

Exemples :

- réception de marchandises ;
- achat ;
- dépense ;
- perte importante ;
- incident inhabituel.

Les justificatifs peuvent notamment être :

- photo ;
- facture ;
- reçu ;
- bon de livraison ;
- document fournisseur.

Le niveau de justificatif demandé devra rester proportionnel au risque.

---

# 43. NOTES ET COMMUNICATION INTERNE

La direction souhaite également pouvoir transmettre certaines informations internes.

Exemples :

- nouveau prix ;
- instruction commerciale ;
- changement de procédure ;
- information importante.

Toutefois, une note de direction ne doit pas remplacer une règle qui pourrait être automatisée.

Exemple :

Si le prix d'un produit change, la note informe les équipes.

Mais le système doit également appliquer le nouveau prix automatiquement à partir de sa date d'effet.

---

# 44. KOMMO CRM

GIC AGROPELC utilise ou prévoit d'utiliser Kommo comme outil de gestion de la relation commerciale et notamment des conversations digitales.

Kommo peut notamment conserver une responsabilité importante sur :

- leads digitaux ;
- conversations ;
- WhatsApp ;
- pipeline relationnel ;
- relances ;
- automatisations commerciales.

L'application GIC AGROPELC doit compléter Kommo plutôt que le copier intégralement.

---

# 45. RESPONSABILITÉ DE L'APPLICATION GIC AGROPELC

L'application doit principalement devenir la source métier pour :

- clients opérationnels ;
- produits ;
- commandes ;
- ventes ;
- stock ;
- production ;
- prix ;
- paiements ;
- achats ;
- fournisseurs ;
- performances commerciales ;
- pilotage opérationnel.

Kommo et l'application devront pouvoir échanger certaines informations.

---

# 46. EXEMPLE DE PARCOURS DIGITAL

Un parcours possible peut être :

**Publicité / réseau social  
→ WhatsApp  
→ Kommo  
→ Lead  
→ qualification  
→ attribution commerciale  
→ conversion client  
→ commande GIC AGROPELC  
→ vente  
→ paiement  
→ historique client**

La vente et les informations commerciales importantes pourront ensuite enrichir le profil relationnel du client.

Exemple :

> Client actif

> 14 commandes

> CA cumulé : 745 000 FCFA

---

# 47. RÔLES MÉTIER ENVISAGÉS

Le système doit anticiper au minimum les profils suivants.

### Direction

Pilotage global et contrôle.

### Administrateur

Configuration du système et gestion des droits.

### Responsable commercial

Pilotage de l'équipe commerciale.

### Commercial terrain

Prospection, visites, clients, commandes.

### Commercial sédentaire

Traitement des leads et clients sans déplacement permanent.

### Vendeur de point de vente

Ventes et opérations du point de vente.

### Responsable production

Pilotage des lots et de la production.

### Responsable ferme

Supervision opérationnelle de la ferme lorsque nécessaire.

### Magasinier

Réception, stockage, sorties et inventaires.

### Responsable achats

Fournisseurs et approvisionnements.

### Comptabilité / Finance

Encaissements, dépenses, créances, fournisseurs et reporting financier.

Un utilisateur pourra cumuler plusieurs rôles.

---

# 48. DROITS ET RESPONSABILITÉS

Tous les utilisateurs ne doivent pas avoir accès à toutes les informations.

Par exemple :

Un commercial terrain peut principalement travailler sur :

- ses prospects ;
- ses clients ;
- ses visites ;
- ses commandes ;
- ses performances.

Un responsable commercial peut disposer d'une vue élargie sur son équipe.

Un magasinier peut avoir accès aux opérations de stock sans nécessairement accéder à toutes les informations financières.

La direction peut disposer d'une vue globale.

La logique exacte des permissions devra être formalisée lors de la conception.

---

# 49. UX ET ADOPTION

L'adoption du logiciel constitue une priorité.

Les utilisateurs ne doivent pas avoir besoin d'une longue formation pour accomplir les actions courantes.

Le système doit privilégier des actions métier évidentes.

Exemples :

**PRENDRE SERVICE**

**+ AJOUTER PROSPECT**

**+ ENREGISTRER VISITE**

**+ NOUVELLE COMMANDE**

**+ NOUVELLE VENTE**

**RÉCEPTIONNER**

**TRANSFÉRER**

**DÉCLARER UNE PERTE**

**SAISIE DU JOUR**

La conception doit privilégier les parcours correspondant à la journée réelle des utilisateurs plutôt qu'une accumulation de formulaires CRUD abstraits.

---

# 50. JOURNÉE TYPE D'UN COMMERCIAL TERRAIN

Un parcours typique peut être :

**Se connecter  
→ prendre service  
→ consulter ses objectifs  
→ visiter des prospects  
→ enregistrer les contacts  
→ enregistrer les visites  
→ créer des commandes  
→ enregistrer éventuellement des ventes  
→ consulter ses performances  
→ terminer sa journée**

Certaines actions doivent continuer à fonctionner lorsqu'Internet disparaît.

---

# 51. JOURNÉE TYPE D'UN MAGASINIER

Un parcours typique peut être :

**Consulter les alertes  
→ réceptionner des marchandises  
→ enregistrer les quantités réellement acceptées  
→ transférer du stock  
→ déclarer des pertes  
→ contrôler les stocks  
→ effectuer éventuellement un inventaire**

---

# 52. JOURNÉE TYPE DU RESPONSABLE

Un responsable doit pouvoir prioritairement :

**Consulter les KPI  
→ identifier les anomalies  
→ suivre les équipes  
→ suivre les commandes  
→ voir les alertes  
→ valider certaines opérations  
→ prendre une décision**

Le système doit éviter d'obliger le responsable à naviguer dans des dizaines d'écrans simplement pour comprendre ce qui se passe.

---

# 53. JOURNÉE TYPE DE LA DIRECTION

La direction doit pouvoir ouvrir l'application et obtenir très rapidement une vue sur :

### PRODUCTION

### STOCK

### DISTRIBUTION

### VENTES

### FINANCES

### ÉQUIPES

### ALERTES

L'objectif est qu'en quelques dizaines de secondes, la direction puisse comprendre la situation générale de l'entreprise.

---

# 54. ALERTES

Le système pourra progressivement produire des alertes réellement utiles.

Exemples :

- stock faible ;
- rupture ;
- perte anormalement élevée ;
- mortalité élevée ;
- réception incomplète ;
- écart d'inventaire ;
- créance en retard ;
- anomalie de caisse ;
- erreur de synchronisation ;
- commercial sans activité ;
- point de vente à réapprovisionner.

Les alertes doivent être conçues pour provoquer une action et non simplement accumuler des notifications.

---

# 55. ÉVOLUTIVITÉ

L'application est destinée à accompagner la croissance de GIC AGROPELC.

Le système doit donc permettre progressivement :

- davantage d'utilisateurs ;
- davantage de sites ;
- davantage de points de vente ;
- davantage de produits ;
- davantage de fournisseurs ;
- davantage de lots ;
- davantage de transactions.

Le modèle ne doit pas être conçu uniquement pour l'organisation actuelle.

---

# 56. CE QUI NE DOIT PAS SURCHARGER LE MVP

Certaines capacités pourront être utiles à long terme mais ne sont pas prioritaires pour la première version.

Notamment :

- géolocalisation permanente ;
- intelligence artificielle prédictive ;
- IoT complet ;
- capteurs automatisés ;
- optimisation avancée des tournées ;
- paie RH complète ;
- gestion RH exhaustive ;
- maintenance industrielle avancée ;
- comptabilité réglementaire complète intégrée.

L'architecture peut anticiper certaines de ces possibilités sans rendre le MVP inutilement complexe.

---

# 57. PRIORITÉS DU MVP

Le MVP doit prioritairement fournir une base fiable autour des grands domaines suivants.

## Core

- utilisateurs ;
- rôles ;
- sites ;
- zones ;
- appareils ;
- audit ;
- synchronisation.

## Commercial

- prospects ;
- clients ;
- visites ;
- pointage ;
- commandes ;
- objectifs.

## Distribution

- produits ;
- mouvements ;
- stock ;
- transferts ;
- points de vente ;
- ventes ;
- pertes ;
- inventaires.

## Production

- lots ;
- bâtiments ;
- animaux ;
- mortalité ;
- œufs ;
- incubation ;
- production porcine.

## Approvisionnement

- fournisseurs ;
- demandes ;
- commandes fournisseurs ;
- réceptions ;
- intrants.

## Finance

- encaissements ;
- créances ;
- dépenses ;
- caisse ;
- coûts ;
- marges.

## Pilotage

- tableaux de bord ;
- analytics ;
- exports ;
- notifications ;
- audit.

Kommo intervient comme intégration transversale.

---

# 58. QUESTION FONDAMENTALE DE COHÉRENCE

Le système sera considéré comme fiable lorsqu'il sera capable de raconter la même histoire à travers plusieurs dimensions.

Exemple idéal :

Un poulet provenant d'une campagne donnée doit pouvoir contribuer statistiquement à une chaîne telle que :

**Lot  
→ production  
→ disponibilité  
→ transfert  
→ point de vente  
→ vente  
→ client  
→ commercial  
→ paiement  
→ chiffre d'affaires  
→ marge**

Lorsque le produit ne termine pas sa chaîne par une vente :

**Lot  
→ mortalité / perte  
→ motif  
→ quantité  
→ coût**

C'est cette continuité qui donnera à la direction confiance dans les chiffres.

---

# 59. PRINCIPE DE SOURCE DE VÉRITÉ

Le projet doit éviter les informations dupliquées sans propriétaire clair.

Pour chaque donnée importante, il faudra déterminer :

> Quel système ou module possède l'information officielle ?

Exemples à déterminer précisément pendant l'architecture :

- identité client ;
- stock ;
- prix ;
- commande ;
- statut commercial ;
- paiement ;
- conversation WhatsApp.

La synchronisation entre plusieurs systèmes ne doit jamais créer plusieurs vérités contradictoires.

---

# 60. QUALITÉ DE DONNÉES

Le projet ne doit pas seulement permettre d'enregistrer beaucoup de données.

Les données doivent être :

- fiables ;
- explicables ;
- traçables ;
- cohérentes ;
- exploitables.

Lorsque deux chiffres sont différents, le système doit permettre de comprendre pourquoi.

Exemple :

> stock théorique = 100

> stock physique = 97

Il ne suffit pas de montrer 97.

Il faut conserver l'existence de l'écart de 3 et sa justification.

---

# 61. OBJECTIF FINAL DU PROJET

Le produit recherché n'est pas simplement un logiciel administratif.

Il doit devenir progressivement le **système nerveux opérationnel de GIC AGROPELC**.

Il doit permettre de relier :

**PRODUCTION  
↕  
STOCK  
↕  
DISTRIBUTION  
↕  
COMMERCIAL  
↕  
CLIENT  
↕  
FINANCE**

avec trois caractéristiques fondamentales :

### Simplicité

L'utilisateur doit pouvoir faire son travail facilement.

### Traçabilité

La direction doit pouvoir comprendre l'origine des informations.

### Fiabilité

Les chiffres physiques, commerciaux et financiers doivent être cohérents.

---

# 62. CRITÈRE CENTRAL DE RÉUSSITE

Le critère principal n'est pas le nombre de fonctionnalités développées.

Le système est réussi lorsque GIC AGROPELC peut lui faire confiance pour répondre à une question opérationnelle importante.

Par exemple :

> « Combien de poulets réellement disponibles pouvons-nous vendre aujourd'hui à Douala ? »

> « Combien avons-nous vendu cette semaine ? »

> « Quel commercial a généré ces ventes ? »

> « Quels clients ont commandé ? »

> « Combien avons-nous réellement encaissé ? »

> « Quelles pertes avons-nous enregistrées ? »

> « Combien cette production nous a-t-elle coûté ? »

> « Quelle quantité a été envoyée à ce point de vente ? »

> « Pourquoi manque-t-il cinq unités par rapport au stock théorique ? »

Si le système peut répondre de manière fiable, traçable et compréhensible à ces questions, il remplit sa mission.

---

# 63. DIRECTIVE POUR TOUTE ANALYSE FUTURE

Toute proposition fonctionnelle ou technique réalisée à partir de ce contexte doit respecter les principes suivants :

1. ne pas inventer de règle métier absente ;
2. distinguer besoin confirmé, déduction et hypothèse ;
3. préserver la traçabilité ;
4. préserver la cohérence entre physique, finance et responsabilité ;
5. considérer le fonctionnement hors connexion comme une contrainte fondamentale ;
6. préserver l'historique des opérations ;
7. privilégier la simplicité utilisateur ;
8. éviter les fonctionnalités dont la complexité dépasse leur valeur opérationnelle ;
9. éviter la duplication des responsabilités entre Kommo et GIC AGROPELC ;
10. concevoir l'architecture pour évoluer sans transformer le MVP en usine à gaz.

---

# 64. FORMULE DIRECTRICE DU PROJET

La philosophie du système peut finalement être résumée ainsi :

> **GIC AGROPELC doit savoir ce qui entre, ce qui est produit, ce qui existe, où cela se trouve, qui en est responsable, ce qui a été vendu, ce qui a été perdu et où est passé l'argent correspondant.**

Et techniquement :

> **La complexité doit vivre dans le moteur du système, jamais inutilement dans l'écran de l'utilisateur.**