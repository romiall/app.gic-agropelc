/**
 * Requête des plages de numéros manquantes d'un appareil (`sync.devices.seq_gap_check`, AV-423), isolée de la tâche
 * pour que `deploy/hostinger/compat-check.mjs` la rejoue telle quelle sur la vraie base avant chaque redémarrage.
 *
 * Portable MySQL 8.4 et MariaDB 11.8 : `LAG(x, 1, 0)` (valeur par défaut en troisième argument) est refusé par
 * MariaDB, qui n'accepte que `LAG(x[, décalage])` ; la valeur par défaut s'écrit donc `COALESCE(LAG(x) OVER w, 0)`.
 * La mise en ligne du 06/11/2026 avait laissé cette tâche échouer toutes les heures (erreur de syntaxe sur le
 * troisième argument) dès qu'un appareil actif avait un trou à examiner ; `failed_jobs` de `GET /health/ready`
 * valait 24 sans que rien d'autre ne le signale.
 */
import { sql, type RawBuilder } from 'kysely';

export interface GapRow {
  readonly device_id: Buffer;
  readonly from_seq: string | number;
  readonly to_seq: string | number;
  readonly opened_at: Date | string;
}

/**
 * Plages absentes de la boîte de commandes pour les appareils donnés : pour chaque numéro reçu, la plage entre le
 * numéro précédent (0 pour le premier) et lui, avec la date de réception du premier numéro qui l'a suivie.
 * `deviceIds` : identifiants binaires, jamais vide.
 */
export function sequenceGapQuery(deviceIds: readonly Buffer[]): RawBuilder<GapRow> {
  return sql<GapRow>`
      SELECT device_id, from_seq, to_seq, opened_at FROM (
        SELECT device_id,
               COALESCE(LAG(device_seq) OVER w, 0) + 1 AS from_seq,
               device_seq - 1 AS to_seq,
               device_seq - COALESCE(LAG(device_seq) OVER w, 0) AS step,
               MIN(received_at) OVER (
                 PARTITION BY device_id ORDER BY device_seq
                 ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
               ) AS opened_at
          FROM sync_command_inbox
         WHERE device_seq IS NOT NULL AND device_id IN (${sql.join(deviceIds)})
        WINDOW w AS (PARTITION BY device_id ORDER BY device_seq)
      ) gaps
       WHERE step > 1
       ORDER BY device_id, from_seq
    `;
}
