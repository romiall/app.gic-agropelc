# ADR-041 — Chiffre d'affaires et encaissé par période d'activité : une seule définition pour l'accueil et le tableau

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; applique D11 KPI-COM-08 et KPI-FIN-01 et BR-ANA-003 ; les choix métier sont AV-200, AV-209, AV-244 et AV-245, à confirmer par le porteur)
- **Date** : 13/10/2026
- **Précise** : [ADR-030](ADR-030-accueil-par-role.md) §7 (une seule fonction par indicateur), [ADR-032](ADR-032-sessions-de-caisse-et-remises-de-fonds.md) §9 (« encaissé » d'un PDV), [ADR-035](ADR-035-tableaux-d-analyse-avant-p9.md)
- **Questions liées** : AV-200, AV-209, AV-244, AV-245

## Contexte

L'accueil par rôle (P4, ADR-030) et le tableau de distribution (P5-20, ADR-035) affichent tous deux le chiffre d'affaires et l'encaissé d'un jour. Avant cette décision, ils ne les comptaient pas de la même façon :
- **Chiffre d'affaires.** L'accueil (`salesPeriodSummary`) comptait les ventes du jour non annulées, au jour de la vente. Le tableau (`soldByLocation`) comptait les lignes vendues du jour moins les lignes annulées le jour même, chaque annulation à sa propre date (D11, BR-ANA-003). Une vente de 23 h 58 annulée à 0 h 01 donnait deux valeurs pour le même jour et le même PDV, ce que BR-ANA-009 interdit (AV-209).
- **Encaissé.** Les deux écrans lisaient la même fonction (`cashedSummary`), mais elle ne suivait pas D11 (KPI-FIN-01 : « encaissements confirmés dans P − annulations dans P »). Elle comptait les encaissements `RECORDED` au jour du paiement. Une annulation décidée plus tard retirait donc le paiement de son jour d'origine, et une simple demande d'annulation l'en retirait déjà (AV-200).

Un chiffre passé qui change sans opération nouvelle ce jour-là est un piège pour un rapprochement de caisse ou un rapport déjà transmis.

## Décision

1. **Une seule définition, un seul endroit** : `sales/application/public/period-activity.ts`, API publique de `sales`.
   - `saleActivityArms` donne les deux bras du vendu (lignes vendues, lignes annulées), chacun daté à sa propre date. Il est partagé par `soldByLocation` (tableau, par emplacement) et `salesActivityByDay` (accueil, par jour) : les deux sont égaux par construction.
   - `cashedActivity` donne l'encaissé. `cashedSummary` et `cashedByGroup` en sont la somme et la ventilation.
2. **Vendu** (KPI-COM-08) : lignes des ventes datées de la période, quel que soit leur statut ultérieur, moins lignes des annulations appliquées dans la période, à leur date.
   - Une annulation décidée le lendemain retranche le lendemain, jamais rétroactivement.
   - Un jour peut être négatif.
   - Jour métier `Africa/Douala` (BR-ANA-002).
3. **Encaissé** (KPI-FIN-01) : encaissements confirmés de la période, à leur jour métier, moins annulations décidées dans la période, à leur date (`cancelled_at`).
   - Sont confirmés : `RECORDED`, `CANCELLATION_REQUESTED`, et `CANCELLED` (annulé depuis). Une demande d'annulation en cours ne retire rien.
   - Un encaissement mis de côté comme doublon (`SUSPECT_DUPLICATE`) n'est pas confirmé. S'il est approuvé, il compte à sa date d'origine, comme son mouvement de trésorerie.
   - Les remboursements ne sont pas retranchés (AV-244).
   - Un jour peut être négatif.
4. **Accueil** (`home-service.ts`, `salesBlock`) : une seule lecture de sept jours (`salesActivityByDay`). Le chiffre du jour, la variation sur la veille, la semaine et la courbe viennent des mêmes jours.
   - **Nombre de ventes** (KPI-COM-07) : ventes du jour qui ne sont pas annulées en totalité à l'instant de lecture.
   - **Panier moyen** (KPI-COM-10) : affiché seulement si le nombre de ventes et le chiffre du jour sont positifs.
   - **Chiffre ou encaissé négatif** : ton `warn`.
5. **Périmètres** (AV-245).
   - L'accueil d'un rôle de site compte tout le site.
   - Le tableau compte le vendu de l'emplacement de vente du PDV (BR-DIS-010), qu'il rapproche du stock.
   - L'encaissé est celui du site dans les deux écrans.
   - Même définition, deux périmètres : les chiffres coïncident quand le site ne vend que depuis son emplacement de vente.

## Conséquences

- Le chiffre d'un jour passé ne change plus sans opération ce jour-là. Une annulation tardive se lit le jour où elle est décidée.
- `salesPeriodSummary` et `salesDailySeries` disparaissent de l'API publique de `sales`.
- L'accueil fait une requête de moins par rôle. Le tableau n'a pas changé de résultat, seulement de code (bras partagés).
- Le chiffre de l'accueil de l'appareil (PWA, AV-236 : ventes connues du téléphone) reste une estimation hors ligne. Le chiffre de référence est celui du serveur.
- Tests (`p5-distribution-metrics.test.ts`) :
  - jour par jour sur cinq jours, la somme de `soldByLocation` du site, `salesActivityByDay` et KPI-COM-08 de l'accueil (`buildHome` à date fixe) sont égaux ;
  - l'encaissé du tableau, `cashedSummary` et KPI-FIN-01 sont égaux, y compris pour une vente annulée le lendemain et un encaissement annulé le lendemain ;
  - sept mutations du code sont toutes détectées.

## Alternatives

- **Vue « net par date de vente »** (l'ancienne vue de l'accueil) : BR-ANA-003 la permet, mais seulement sous un libellé distinct. Elle réécrit le passé. Écartée comme vue par défaut ; elle reste possible dans l'explorateur de P9.
- **Deux libellés, deux définitions** (AV-209 (c)) : deux chiffres pour une même question sur deux écrans. Écartée.
- **Retrancher les remboursements de l'encaissé** : D11 ne le demande pas, et un remboursement se lit dans la trésorerie (KPI-FIN-06). Laissé à AV-244.
