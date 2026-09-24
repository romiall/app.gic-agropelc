# ADR-009 — Frontières avec Kommo

- **Statut** : ACCEPTÉ ; détails techniques À VALIDER (AV-068 à AV-071)
- **Date** : 24/09/2026

## Contexte
Kommo gère leads digitaux, conversations, WhatsApp, pipeline relationnel, relances et automatisations (CM §44). GIC doit le compléter sans le copier (CM §44, §45) et éviter toute double vérité (CM §59 ; PM §16).

## Décision
- **Kommo est source** des leads, conversations et du pipeline digital ; **GIC est source** de l'identité opérationnelle du client, des commandes, ventes, prix, paiements, stock et production.
- Entrée : un lead qualifié (statut configuré) crée ou rapproche un compte GIC.
- Sortie : GIC enrichit le contact et le lead (stade, CA cumulé, commandes).
- Champs partagés (nom, téléphone, e-mail, adresse) : **GIC prévaut** ; une modification Kommo n'est appliquée que sans modification concurrente dans GIC.
- Asynchrone (outbox et inbox), idempotent, anti-boucle par empreinte, reprise avec abandon puis rejeu manuel. Une indisponibilité de Kommo n'affecte jamais GIC.

## Alternatives étudiées
- Kommo source des clients : incompatible avec le terrain hors ligne et le CM §45.
- Synchronisation bidirectionnelle symétrique : boucles et doubles vérités.
- Aucune intégration : rupture du parcours digital (CM §46).

## Conséquences
Module `integrations` ; tables de liens et de messages ; configuration des champs et des statuts ; supervision.

## Risques
RISK-14.
