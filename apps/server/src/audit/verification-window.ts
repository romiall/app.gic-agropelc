/**
 * Fenêtre de vérification de la chaîne d'audit (P9-10, AV-470) : où elle commence, en date puis en numéro de ligne.
 *
 * - **Date** : le début du jour métier qui précède celui du **créneau planifié** de la tâche, non celui de
 *   l'instant d'exécution. Après un arrêt du worker, l'ordonnanceur ne dépose qu'une tâche (les créneaux
 *   manqués sont fusionnés) dont `scheduledFor` est le plus ancien dû : la fenêtre remonte alors jusqu'à lui et
 *   aucune écriture de la période n'échappe au contrôle. Une interruption très longue est plafonnée à
 *   {@link MAX_CATCH_UP_DAYS} jours métier (au-delà : vérification complète du mois, P9-22).
 * - **Numéro** : le plus petit `seq` dont l'écriture est postérieure ou égale à cette date, par une requête
 *   **exacte** — jamais une lecture depuis la fin du journal qui supposerait les dates croissantes avec
 *   `seq` : une horloge d'application qui recule (redémarrage d'une VM, resynchronisation) laisserait en queue
 *   une ligne antérieure et viderait ou tronquerait la fenêtre en silence. `audit_audit_log` n'a pas d'index
 *   sur `recorded_at` seul, mais MySQL 8 lit `ix_audit_audit_log_site (site_id, recorded_at)` par saut d'index
 *   (« Covering index skip scan ») : le coût suit la taille de la fenêtre, non celle du journal (mesuré : 20 ms
 *   pour 4 000 lignes sur 40 000). Si un plan l'abandonnait, un index `(recorded_at)` règle le point (P9-22).
 */
import { addBusinessDays, businessDayOf, businessDayStartUtc } from '@gic/domain';
import type { Kysely, Transaction } from 'kysely';
import { passSlotOf } from '../platform/events/detection-events.js';
import type { DB } from '../platform/kysely/database.js';

/** Jours métier de rattrapage au plus, après une interruption prolongée de la tâche. */
export const MAX_CATCH_UP_DAYS = 31;

/**
 * Début de la fenêtre : le début du jour métier précédent celui du créneau planifié (`scheduledFor` de la
 * charge, au plus l'instant courant ; à défaut `now`), jamais plus de {@link MAX_CATCH_UP_DAYS} jours métier
 * avant `now`.
 */
export function verificationWindowStart(payload: unknown, now: Date): Date {
  const planned = new Date(passSlotOf(payload, now));
  const reference =
    Number.isNaN(planned.getTime()) || planned.getTime() > now.getTime() ? now : planned;
  const wanted = businessDayStartUtc(addBusinessDays(businessDayOf(reference), -1));
  const floor = businessDayStartUtc(addBusinessDays(businessDayOf(now), -MAX_CATCH_UP_DAYS));
  return wanted.getTime() < floor.getTime() ? floor : wanted;
}

/** Plus petit `seq` écrit à `from` ou après (date d'écriture `recorded_at`) ; `null` s'il n'y en a aucun. */
export async function firstSeqRecordedAtOrAfter(
  db: Kysely<DB> | Transaction<DB>,
  from: Date,
): Promise<number | null> {
  const row = await db
    .selectFrom('audit_audit_log')
    .select(({ fn }) => fn.min('seq').as('minSeq'))
    .where('recorded_at', '>=', from)
    .executeTakeFirst();
  return row?.minSeq == null ? null : Number(row.minSeq);
}
