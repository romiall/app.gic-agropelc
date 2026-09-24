# ADR-012 — Pièces jointes et photos hors ligne

- **Statut** : ACCEPTÉ (CONFIRMÉ CM §24, §42 ; PM §29)
- **Date** : 24/09/2026

## Contexte
Photos et justificatifs sont requis selon le risque (CM §24, §42), souvent capturés hors ligne, sur des réseaux lents et avec des appareils modestes.

## Décision
1. Compression sur l'appareil (1 280 px, qualité 0,7, ≤ 400 Ko), SHA-256, stockage local chiffré.
2. Métadonnées envoyées **avec la commande** (la pièce existe dès l'application, `PENDING_UPLOAD`).
3. Upload **séparé, par morceaux de 256 Ko, reprenable** (offset), après le push des commandes ; vérification de l'empreinte et du type.
4. Stockage objet privé, URL signées courtes ; réencodage serveur (suppression des métadonnées EXIF).
5. Une validation qui exige une pièce attend son statut `AVAILABLE` ; alerte après 7 jours.

## Alternatives étudiées
- Pièce incluse dans la commande (base64) : lots énormes, échec global sur réseau faible.
- Upload immédiat obligatoire : impossible hors ligne.

## Conséquences
Table `attachments.attachments` ; endpoints d'upload ; file locale priorisée.

## Risques
RISK-11.
