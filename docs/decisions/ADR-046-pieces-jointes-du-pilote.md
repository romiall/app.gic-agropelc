# ADR-046 — Pièces jointes du pilote : enregistrement séparé, rattachement par propriétaire, lecture protégée, régularisation de la photo manquante

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; applique les décisions du porteur du 14/10/2026 : AV-285 à AV-288)
- **Date** : 14/10/2026
- **Précise** : ADR-012 (pièces jointes hors ligne), BR-ADM-019, BR-ADM-020, BR-APP-014, SM-ATTACHMENT
- **Questions liées** : AV-091, AV-093, AV-107, AV-246, AV-285 à AV-292

## Contexte

MP-10 rend la photo utilisable de bout en bout : prise sur le téléphone, stockée hors ligne, envoyée, rattachée au bon de livraison d'une réception d'achat et à une perte, vue par le valideur. La lecture de l'existant (14/10/2026) montre que le serveur sait enregistrer une pièce (`attachments.attachment.register`) et en recevoir les octets par morceaux, mais :

- le référentiel dit que les métadonnées partent « dans » la commande métier (02-synchronisation §8, ADR-012 point 2), alors que le serveur les reçoit par une commande séparée ;
- aucun type de document propriétaire n'est fixé, sauf `STOCK_LOSS` pour la mortalité (AV-107) ;
- une pièce citée dans `attachment_ids` devient une pièce exigée par la validation, dont la liste est figée ; si elle n'arrive jamais, la validation est bloquée à vie ;
- rien ne régularise la « photo manquante » d'une réception (AV-246) ;
- personne ne peut voir une photo : l'URL signée attend le choix du stockage objet (AV-091) ;
- la fin de l'envoi ne vérifie que l'empreinte, pas la nature du contenu (02-securite §9).

## Décision

1. **Enregistrement par une commande séparée, sans dépendance.** Chaque photo est enregistrée par `attachments.attachment.register`, placée dans la file de l'appareil **juste avant** l'opération qui la porte (même transaction locale). L'opération ne dépend **pas** d'elle (`depends_on` vide) : un refus de la pièce ne doit jamais faire refuser un fait (BR-SYN-007). L'ordre strict de la file (ADR-039) suffit. Les octets partent après l'envoi des commandes, une fois l'enregistrement accepté.
2. **Propriétaires connus.** Le propriétaire d'une pièce est le document de l'opération : son type d'agrégat et l'identifiant choisi par l'appareil (`@gic/contracts`, `ATTACHMENT_OWNER_TYPES`).
   - `GOODS_RECEIPT` : bon de livraison d'une réception d'achat (nature `DELIVERY_NOTE`).
   - `STOCK_LOSS` : photo d'une perte ou d'une mortalité (nature `PHOTO`).

   Un autre propriétaire est refusé à l'enregistrement (revue de MP-10) ; un nouveau s'ajoute à la liste.
3. **Pièce citée ou rattachée.**
   - Une réception **cite** sa photo dans `attachment_ids` : c'est sa « photo présente » (BR-APP-014), et une validation de réception l'exige.
   - Une perte ou une mortalité ne la cite **pas** : la pièce reste rattachée par son propriétaire. L'approbation d'une mortalité vérifie la photo (nature `PHOTO`) du document (AV-107). Une photo de perte reste facultative (AV-288). Une pièce qui n'arriverait jamais ne fige ainsi aucune validation.
   - Une pièce exigée par une validation, refusée ou jamais enregistrée, est remplacée par une autre pièce reçue du même document, de même nature si elle est connue (AV-290) : la liste figée d'une demande ne bloque plus l'approbation à vie.
4. **Régularisation de la photo manquante (AV-285).** À la fin de l'envoi, une pièce `DELIVERY_NOTE` d'une `GOODS_RECEIPT`, reçue et vérifiée, dont l'auteur est le réceptionnaire ou peut enregistrer des réceptions sur le site de la réception, clôt le conflit informatif `RECEIPT_PHOTO_MISSING` de la réception (`COMPENSATE`, la pièce en référence, dans la transaction de fin d'envoi ; rangs N11 puis N14 d'ADR-038). Le Resp. achats peut toujours le clore à la main avec un motif (`sync.conflict.dismiss`). Joindre une photo après coup passe par la seule commande d'enregistrement : l'opération d'origine, déjà envoyée, ne change jamais.
5. **Lecture protégée (AV-286).** `GET /api/v1/attachments/{id}/content` rend les octets d'une pièce `AVAILABLE`, sans mise en cache (`private, no-store`, `nosniff`). Peuvent la lire :
   - son auteur ;
   - qui peut décider une validation en attente sur le document (le valideur voit ce qu'il décide) ;
   - qui lit le document dans sa portée : réception, `procurement.order.read` sur son site ; perte, `inventory.loss.read` sur son site ou sa zone, ou sa propre déclaration (AV-094).

   Tout autre accès est refusé (403 audité). La file de validation liste les pièces du document de chaque demande. L'URL signée reste pour le stockage objet (AV-091).
6. **Fin de l'envoi.** L'empreinte **et** la signature du fichier (premiers octets conformes au type déclaré) sont vérifiées ; sinon `QUARANTINED`. Un morceau qui dépasse la taille annoncée est refusé (400). Un envoi sur une pièce qui n'en accepte plus rend son statut (`details.upload_status`), pour que l'appareil sache si elle est reçue ou à reprendre. La fin est **rejouable** : si tous les octets sont sur le stockage sans que la fin ait été enregistrée, la session suivante ou le renvoi du dernier morceau la constate ; une pièce déjà finalisée ne change plus d'état (une seule fin enregistrée).
7. **Sur l'appareil.**
   - Photo recodée en JPEG (côté long 1 280 px, qualité 0,7 puis par paliers jusqu'à 400 Ko), empreinte SHA-256. Le recodage retire les métadonnées EXIF.
   - Fiche et octets dans deux magasins locaux. Envoi par l'auteur seul, après les commandes, les plus petites d'abord, par morceaux de 128 Ko, dans un budget par cycle. Une coupure pendant une pièce la reporte et laisse le tirage se faire. Seule une réponse portant un code d'erreur connu du serveur rend un envoi définitivement refusé.
   - Photo jointe après coup : depuis le résultat ou la liste des réceptions de l'utilisateur (signal « photo manquante » ou photo refusée), et depuis les mortalités du lot en attente de validation, quel que soit leur jour.
   - Octets retirés de l'appareil une fois la pièce reçue.
   - Pas de chiffrement des photos pour l'instant, comme la file des opérations (AV-287).

## Conséquences

- 02-synchronisation §8 et SM-ATTACHMENT sont alignés sur la commande séparée. 08-api-events §4.10 décrit la lecture `GET …/content`.
- Une pièce en quarantaine ou refusée ne se rattrape que par une nouvelle photo (AV-290). Le passage à `MISSING` après 7 jours et son alerte relèvent de P9.
- La réception sans bon de commande, non proposée par la PWA, garde ses règles (AV-289).
- Le stockage reste le disque local du serveur : `ATTACHMENTS_STORAGE_DIR` doit désigner un volume sauvegardé pour le pilote (AV-292).
- Les métadonnées des pièces restent servies à tous les appareils par le repli `GLOBAL` du pipeline (AV-293, à traiter avec le durcissement du tirage).
- Deux envois concurrents du même morceau ne sont pas sérialisés sur le stockage (seul l'auteur envoie, la PWA un cycle à la fois) ; la fin d'envoi, elle, n'est enregistrée qu'une fois.
