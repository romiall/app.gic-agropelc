-- Module `analytics` (AV-514 (5), AV-532) : jeu de faits de la présence du personnel relevée sur les fiches PT.
-- Source : docs/decisions/ADR-064 (§2, §3) ; D11 §7 et §8 ; docs/03-data/dictionnaire/12-analytics.md ; PP-E (ADR-056).
--
-- La présence des ouvriers et du personnel administratif se reporte chaque semaine depuis la fiche papier PT : une ligne par
-- personne et par jour (`fieldwork_staff_presence`), sous une feuille d'un site (`fieldwork_presence_sheets`). Ce jeu ne
-- recoupe pas `analytics_f_attendance` (les sessions de travail du pointage numérique des commerciaux de terrain) : aucun
-- jour n'est compté dans l'un et dans l'autre. Usage statistique et de suivi, ni paie ni discipline (AV-313).
--
-- Mêmes principes que les autres vues `analytics_f_*` : `SQL SECURITY INVOKER`, lecture seule, `ALGORITHM = TEMPTABLE`
-- (non modifiable), portée dérivée dans la vue (le site de la feuille). Les feuilles annulées n'y figurent pas (règle 4 : la
-- feuille annulée reste en base, elle ne compte plus). Le jour est le jour métier de la ligne (`presence_date`).
--
-- Le libellé constant `day_status` porte la collation explicite des colonnes (ADR-064 §2) : sans elle, un filtre
-- `day_status = ?` de l'explorateur échoue (« Illegal mix of collations ») quand la connexion qui crée la vue et celle qui
-- l'interroge n'ont pas la même collation par défaut.
-- Une durée n'existe que pour un jour relevé en heures, départ non antérieur à l'arrivée (calcul en secondes, portable).
-- Expand seulement : une vue nouvelle, que la version précédente du code ignore.
--
-- migrate:up transaction:false

CREATE ALGORITHM = TEMPTABLE SQL SECURITY INVOKER VIEW analytics_f_staff_presence AS
SELECT
  p.presence_date AS business_day,
  s.site_id,
  p.sheet_id,
  p.id AS presence_id,
  p.person_role AS role_label,
  p.absence_code,
  CASE
    WHEN p.absence_code IS NOT NULL THEN _utf8mb4'ABSENT' COLLATE utf8mb4_0900_as_cs
    WHEN p.arrival_time IS NOT NULL THEN _utf8mb4'PRESENT' COLLATE utf8mb4_0900_as_cs
    ELSE _utf8mb4'NON_RENSEIGNE' COLLATE utf8mb4_0900_as_cs
  END AS day_status,
  CASE WHEN p.arrival_time IS NOT NULL THEN 1 ELSE 0 END AS present_count,
  CASE WHEN p.absence_code IS NOT NULL THEN 1 ELSE 0 END AS absent_count,
  CASE
    WHEN p.arrival_time IS NOT NULL AND p.departure_time IS NOT NULL AND p.departure_time >= p.arrival_time
    THEN (TIME_TO_SEC(p.departure_time) - TIME_TO_SEC(p.arrival_time)) DIV 60
  END AS worked_minutes
FROM fieldwork_staff_presence p
JOIN fieldwork_presence_sheets s ON s.id = p.sheet_id
WHERE s.status = 'RECORDED';

GRANT SELECT ON analytics_f_staff_presence TO 'gic_app'@'%';

-- migrate:down transaction:false
DROP VIEW IF EXISTS analytics_f_staff_presence;
