/**
 * P3-08 — invariants CRM et pointage vérifiés sur **toute** la base de test (02-domain-model/
 * 01-invariants.md ; plan de développement §4, P3 : « Tests d'intégration INV-CRM-01 à 05,
 * INV-TER-01, 02 »). Les tests de commande de P3-03 à P3-07 écrivent réellement (aucun
 * retour arrière) : ce balayage porte donc sur des centaines de comptes, affectations, fusions,
 * sessions et visites produits par le vrai pipeline, et vaut à tout moment de la suite.
 *
 * Les contraintes déclaratives (INV-CRM-01 acquéreur immuable, INV-CRM-04, INV-TER-02 tentative
 * immuable) sont aussi démontrées par `db/tests/crm-fieldwork.test.ts` ; ici, leur respect sur les
 * données produites, et les invariants que seule la transaction garantit (INV-CRM-05, cohérence
 * du titulaire dénormalisé, références sans clé étrangère des sessions).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { closeTestDb, db } from './helpers.js';

async function count(query: ReturnType<typeof sql<{ n: number }>>): Promise<number> {
  const result = await query.execute(db);
  return Number(result.rows[0]?.n ?? 0);
}

describe('P3-08 : invariants CRM et pointage sur les données produites', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  it('INV-CRM-05 : un compte fusionné pointe vers un compte non fusionné (chaîne sans cycle)', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM crm_customers a
        JOIN crm_customers b ON b.id = a.merged_into_id
        WHERE a.stage = 'MERGED' AND b.stage = 'MERGED'`),
    ).toBe(0);
    // Un doublon en attente pointe vers un compte non fusionné (re-pointé à la fusion).
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM crm_customers a
        JOIN crm_customers b ON b.id = a.duplicate_of_id
        WHERE a.stage <> 'MERGED' AND b.stage = 'MERGED'`),
    ).toBe(0);
  });

  it('INV-CRM-02 : au plus un titulaire actif ; périodes sans chevauchement ; titulaire dénormalisé cohérent', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM (
          SELECT customer_id FROM crm_customer_assignments WHERE valid_to IS NULL
          GROUP BY customer_id HAVING COUNT(*) > 1) t`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM crm_customer_assignments x
        JOIN crm_customer_assignments y ON y.customer_id = x.customer_id AND y.id > x.id
        WHERE x.valid_from < COALESCE(y.valid_to, '9999-12-31 00:00:00')
          AND y.valid_from < COALESCE(x.valid_to, '9999-12-31 00:00:00')`),
    ).toBe(0);
    // `owner_user_id` (dénormalisé) = titulaire de l'affectation en cours, hors comptes fusionnés.
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM crm_customers c
        LEFT JOIN crm_customer_assignments a ON a.customer_id = c.id AND a.valid_to IS NULL
        WHERE c.stage <> 'MERGED' AND NOT (c.owner_user_id <=> a.user_id)`),
    ).toBe(0);
  });

  it('INV-CRM-03 / INV-CRM-04 : téléphone unique parmi les comptes uniques ; un client a sa première vente', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM (
          SELECT phone_key FROM crm_customers WHERE phone_key IS NOT NULL
          GROUP BY phone_key HAVING COUNT(*) > 1) t`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM crm_customers WHERE stage = 'CUSTOMER' AND first_sale_id IS NULL`),
    ).toBe(0);
    // INV-CRM-01 : l'acquisition reste celle de la création (aucun acquéreur postérieur à celle-ci).
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM crm_customers WHERE acquired_at <> occurred_at`),
    ).toBe(0);
  });

  it('INV-TER-01 : au plus une session non clôturée par utilisateur', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM (
          SELECT user_id FROM fieldwork_work_sessions WHERE status = 'OPEN'
          GROUP BY user_id HAVING COUNT(*) > 1) t`),
    ).toBe(0);
  });

  it('INV-TER-02 et références : chaque session pointe une tentative existante du même agent', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM fieldwork_work_sessions s
        LEFT JOIN fieldwork_geo_checkins g ON g.id = s.start_checkin_id
        WHERE g.id IS NULL OR g.user_id <> s.user_id`),
    ).toBe(0);
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM fieldwork_work_sessions s
        LEFT JOIN fieldwork_geo_checkins g ON g.id = s.end_checkin_id
        WHERE s.end_checkin_id IS NOT NULL AND (g.id IS NULL OR g.user_id <> s.user_id)`),
    ).toBe(0);
    // Une tentative rattachée à une session appartient au même agent.
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM fieldwork_geo_checkins g
        JOIN fieldwork_work_sessions s ON s.id = g.work_session_id
        WHERE s.user_id <> g.user_id`),
    ).toBe(0);
    // Une tentative refusée n'ouvre jamais de session à son heure (BR-TER-004) ; une session
    // ouverte par dérogation pointe une tentative refusée (BR-TER-005).
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM fieldwork_work_sessions s
        JOIN fieldwork_geo_checkins g ON g.id = s.start_checkin_id
        WHERE s.override_status = 'NOT_REQUIRED' AND g.server_result <> 'ACCEPTED'`),
    ).toBe(0);
  });

  it('BR-CRM-013 : une visite rattachée à une session est celle de son auteur, commencée avant elle', async () => {
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM crm_visits v
        JOIN fieldwork_work_sessions s ON s.id = v.work_session_id
        WHERE s.user_id <> v.user_id OR v.occurred_at < s.started_at`),
    ).toBe(0);
    // Hors session : l'indicateur est posé (AV-023).
    expect(
      await count(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM crm_visits
        WHERE work_session_id IS NULL AND NOT JSON_CONTAINS(flags, '"OUT_OF_SESSION"')`),
    ).toBe(0);
  });
});
