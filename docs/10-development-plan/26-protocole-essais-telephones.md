# Protocole d'essais sur téléphones réels (lot RP-7b)

> **Statut : rédigé le 03/11/2026** pour préparer la campagne de recette et le pilote terrain sur smartphones réels ([plan de reprise](../../reprise/prompt-reprise-reste-a-faire.md) § 4, NFR-01, NFR-02, NFR-05, NFR-35).
> Classement des informations : **CONFIRMÉ** (spécifications validées), **DÉDUIT** (déroulement logique sur smartphone), **À VALIDER** (conditions locales de test opérateur).

---

## 1. Objectif et périmètre du protocole

Ce protocole vise à valider le comportement de la PWA GIC AGROPELC dans les conditions réelles d'utilisation sur le terrain camerounais (smartphones Android d'entrée et milieu de gamme, réseau cellulaire intermittent 2G/3G/4G, coupures électriques, géolocalisation en zone urbaine et rurale).

Les essais s'articulent autour de **neuf scénarios clés** :
1. Installation PWA et premier chargement (mise en cache du Service Worker).
2. Authentification multicanal (téléphone ou e-mail) et approbation de l'appareil.
3. Établissement et déverrouillage sécurisé par code PIN à 6 chiffres.
4. Vente et encaissement en mode hors ligne strict (mode avion).
5. Synchronisation au retour réseau (vidage de l'outbox, réconciliation).
6. Prise de vue et compression de photos jointes (pièces de dépenses / bons).
7. Pointage GPS et détection de présence dans la zone d'affectation.
8. Consultation et impression autonome des pièces papier (moteur `ADR-048`).
9. Ergonomie et confort visuel (commutation thèmes clair / sombre).

---

## 2. Matériel et pré-requis d'essai

### 2.1 Échantillon de terminaux recommandés
- **Terminal A (cible référence)** : Smartphone Android 10+ (ex. Tecno Spark, Infinix Hot, Samsung Galaxy A03/A12, 2 Go à 4 Go RAM).
- **Terminal B (terminal secondaire)** : Smartphone Android récent ou iOS (Safari 16+).
- **Navigateur principal** : Google Chrome (moteur Chromium recommandé pour l'API Badging et Web Bluetooth).
- **Connectivité** : Carte SIM locale (Orange CM / MTN CM) et possibilité de basculer en mode avion.

### 2.2 Pré-requis applicatifs
- Environnement cible : `https://app.gic-agropelc.com` (en ligne) ou serveur local accessible via Wi-Fi.
- Comptes d'essai configurés avec rôles actifs :
  - Compte Commercial terrain (`COMMERCIAL_TERRAIN`).
  - Compte Vendeur point de vente (`VENDEUR_PDV`).
  - Compte Responsable ou Administrateur pour les approbations.

---

## 3. Déroulement des scénarios d'essai

### Scénario 1 : Installation PWA et mise en cache
1. Ouvrir le navigateur Chrome sur le téléphone et naviguer vers l'URL de l'application.
2. Vérifier la bannière ou le menu du navigateur « Installer l'application » ou « Ajouter à l'écran d'accueil ».
3. Installer l'application. Revenir à l'écran d'accueil du téléphone et lancer l'icône installée.
4. **Résultat attendu** :
   - L'application s'ouvre en mode autonome (`standalone`), sans barre d'adresse du navigateur.
   - Les polices de caractères locales (Barlow Semi Condensed, Noto Sans) et le logo officiel s'affichent instantanément.
   - Le Service Worker met en cache les ressources requises (budget initial ≤ 300 Ko gzip respecté, NFR-05).

### Scénario 2 : Connexion et approbation de l'appareil (ECR-ADM-01 / 05)
1. Saisir l'identifiant (numéro de téléphone camerounais au format international `+237...` ou adresse e-mail professionnelle) et le mot de passe provisoire.
2. Valider le formulaire.
3. **Résultat attendu** :
   - Si l'appareil n'est pas encore approuvé, un bandeau d'attente apparaît avec un **code court à 4 caractères** (ex. `A7B9`, règle BR-ADM-007).
   - Depuis un poste administrateur (ou via l'outil `approve-device.mjs`), l'appareil est approuvé.
   - Dès l'approbation, la PWA débloque l'écran et passe à l'étape suivante.

### Scénario 3 : Code PIN local et verrouillage (BR-ADM-024)
1. L'application demande la saisie d'un code PIN à 6 chiffres pour les déverrouillages rapides hors ligne.
2. Saisir deux fois le code PIN choisi.
3. Fermer l'application et la rouvrir.
4. **Résultat attendu** :
   - L'écran de déverrouillage par PIN se présente (`PinSetupScreen` / `PinUnlock`).
   - La saisie d'un PIN incorrect décrémente le compteur de tentatives (5 tentatives avant purge de sécurité locale, BR-ADM-024).
   - La saisie du bon PIN déverrouille immédiatement la session sans appel réseau.

### Scénario 4 : Vente et clôture en mode hors ligne strict (ECR-VEN-01)
1. Activer le **Mode Avion** sur le smartphone (aucun réseau mobile, aucun Wi-Fi).
2. L'indicateur de réseau dans la barre supérieure passe à l'état déconnecté / hors ligne.
3. Ouvrir l'écran de vente (`/ventes/nouvelle`).
4. Sélectionner un client du portefeuille local, ajouter des produits disponibles en stock local.
5. Valider la vente en espèces.
6. **Résultat attendu** :
   - La vente est enregistrée localement dans IndexedDB (Dexie).
   - Le stock disponible de l'appareil est décrémenté immédiatement.
   - Le compteur de l'outbox dans le badge de synchronisation s'incrémente de 1 (`1 en attente`).
   - L'application reste rapide, fluide, sans blocage ni message d'erreur bloquant.

### Scénario 5 : Reconnexion et synchronisation (ECR-SYN-01)
1. Désactiver le Mode Avion et rétablir la connexion Internet.
2. Observer le badge de synchronisation dans la barre supérieure.
3. Ouvrir l'écran de synchronisation (`/synchronisation`).
4. **Résultat attendu** :
   - La PWA détecte le retour réseau et déclenche le cycle de push/pull.
   - L'opération en attente est envoyée au serveur, traitée de manière idempotente et confirmée.
   - Le badge passe à l'état synchronisé (vert) et le compteur en attente retombe à zéro.
   - Aucun conflit n'est généré pour une vente standard.

### Scénario 6 : Pièce jointe photo et compression (ADR-012, MP-10)
1. Aller dans « Nouvelle dépense » (`/depenses/nouvelle`) ou déclarer une mortalité (`/production/lots`).
2. Renseigner les champs obligatoires et cliquer sur « Joindre une photo ».
3. Prendre une photo en direct avec l'appareil photo du smartphone (caméra 12 à 50 MP).
4. **Résultat attendu** :
   - La photo est immédiatement redimensionnée et compressée côté client (Canvas / Web Workers).
   - Le poids final ne dépasse pas le seuil maximal (≤ 400 Ko, règle ADR-012).
   - La vignette de prévisualisation s'affiche proprement avec possibilité de suppression ou remplacement.
   - L'opération est mise en file d'attente avec son fichier joint local.

### Scénario 7 : Pointage GPS et présence de terrain (ECR-TER-01)
1. Se connecter avec le compte `COMMERCIAL_TERRAIN`.
2. Ouvrir l'écran « Prise de service » (`/equipe/service`).
3. Autoriser l'accès à la localisation du navigateur sur le smartphone.
4. Cliquer sur « Prendre mon service ».
5. **Résultat attendu** :
   - Les coordonnées GPS (latitude, longitude, précision en mètres) sont relevées.
   - Si la précision est acceptable et que le commercial est dans sa zone affectée, la prise de service est acceptée immédiatement.
   - En cas d'écart hors zone, l'application propose l'enregistrement avec dérogation motivée (`CHECKIN_OVERRIDE`).

### Scénario 8 : Consultation et impression des pièces papier (ADR-048)
1. Aller dans le détail d'une vente effectuée (`/ventes/:id`).
2. Cliquer sur l'action « Voir la pièce / Imprimer ».
3. **Résultat attendu** :
   - Le document Bon de vente (BV) ou Reçu s'affiche dans une iframe avec la mise en page exacte de la papeterie GIC (vert, orange doré, logos).
   - Les montants en lettres sont correctement orthographiés en français (`packages/domain`).
   - L'appel d'impression ouvre la boîte de dialogue d'impression système Android (PDF / imprimante thermique Bluetooth / Wi-Fi).
   - Le corps de la pièce tient sur une page A5 paysage ou A4 selon le gabarit.

### Scénario 9 : Bascule des thèmes Clair / Sombre
1. Cliquer sur l'avatar du compte en haut à droite pour ouvrir la feuille de compte.
2. Basculer entre le mode « Clair » et le mode « Sombre ».
3. Parcourir les écrans d'accueil, de vente et d'indicateurs.
4. **Résultat attendu** :
   - Les contrastes respectent les tokens du design system (`--bg`, `--card`, `--primary`, `--text`).
   - Aucun texte n'est illisible, aucun fond en dur n'apparaît blanc sur fond noir.
   - La préférence est conservée au redémarrage de la PWA.

---

## 4. Grille d'évaluation et de recette (PV d'essais)

| Réf. | Test | Critère de succès | Observé | Statut (OK/KO) |
|---|---|---|---|---|
| **ESS-01** | Installation PWA | Icône sur écran d'accueil, lancement en mode standalone sans chrome navigateur | | |
| **ESS-02** | Connexion | Acceptation numéro téléphone `+237...` et e-mail, prompt code court appareil | | |
| **ESS-03** | Code PIN | Déverrouillage hors ligne instantané, blocage après 5 faux PIN | | |
| **ESS-04** | Hors ligne | Vente complète en mode avion, décrément stock local, outbox incrémentée | | |
| **ESS-05** | Synchronisation | Vidage automatique de l'outbox au retour réseau, badge vert | | |
| **ESS-06** | Photo jointe | Compression automatique de la photo sous 400 Ko, affichage vignette | | |
| **ESS-07** | Géolocalisation | Relevé des coordonnées, précision affichée, dérogation si hors zone | | |
| **ESS-08** | Pièces papier | Affichage conforme du Bon de vente, montant en lettres correct, dialogue d'impression | | |
| **ESS-09** | Thèmes UI | Bascule fluide clair/sombre, lisibilité parfaite des cartes et contrastes | | |

---

## 5. Fiche d'anomalie type

En cas de constat d'échec sur le terrain, renseigner :
- **Modèle du téléphone et version Android** :
- **Navigateur et version** (ex. Chrome Mobile 128) :
- **Identifiant du compte testeur** :
- **Heure locale et conditions réseau** (Wi-Fi, 4G, 2G, Hors ligne) :
- **Description précise du comportement constaté** :
- **Capture d'écran jointe** :
