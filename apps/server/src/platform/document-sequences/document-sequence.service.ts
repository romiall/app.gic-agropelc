/**
 * `sequences.next(...)` (BR-ADM-021 ; AV-077, SECONDAIRE/OUVERT — recommandation déjà
 * retenue et implémentée ici comme valeur par défaut paramétrable, CLAUDE.md règle 2) :
 * numéro officiel de document, format `{TYPE}-{CODE_SITE}-{AAAA}-{seq6}`, un compteur par
 * `(doc_type, site_id, year)`, sans trou (INV-GLO-07). Même motif que `audit.record`
 * (P0-06) : verrou de ligne tenu dans la transaction de l'appelant, valeur lue puis
 * incrémentée avant COMMIT.
 *
 * `platform` ne dépend d'aucun module (graphe N0, 05-architecture/03-graphe-dependances.md) :
 * `codeSite` (code humain, ex. `DLA01`) n'est pas résolu ici — `organization.sites` n'est pas
 * une dépendance disponible — l'appelant (qui, lui, a accès au module organization) le
 * fournit.
 *
 * `(doc_type, site_id, year)` peut ne pas encore exister à l'appel : un upsert sans effet
 * (`ON DUPLICATE KEY UPDATE` qui réécrit `next_value` sur lui-même) garantit d'abord son
 * existence et prend le verrou d'écriture en un aller-retour. Un simple `SELECT … FOR UPDATE`
 * sur une clé absente ne poserait qu'un verrou de plage (les verrous de plage de plusieurs
 * transactions ne s'excluent pas mutuellement) : deux transactions concurrentes pourraient
 * alors tenter l'INSERT initial en parallèle et l'une échouerait sur la contrainte d'unicité
 * au lieu d'attendre son tour — l'upsert préalable élimine cette course.
 */
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { UnitOfWork } from '../unit-of-work.js';
import { toBin } from '../kysely/uuid-columns.js';

export interface NextDocumentNumberInput {
  readonly docType: string;
  readonly siteId: string;
  readonly codeSite: string;
  readonly year: number;
}

@Injectable()
export class DocumentSequenceService {
  async next(uow: UnitOfWork, input: NextDocumentNumberInput): Promise<string> {
    const siteIdBin = toBin(input.siteId);

    await uow
      .insertInto('platform_document_sequences')
      .values({ doc_type: input.docType, site_id: siteIdBin, year: input.year, next_value: 1 })
      .onDuplicateKeyUpdate({ next_value: sql`next_value` })
      .execute();

    const row = await uow
      .selectFrom('platform_document_sequences')
      .select('next_value')
      .where('doc_type', '=', input.docType)
      .where('site_id', '=', siteIdBin)
      .where('year', '=', input.year)
      .forUpdate()
      .executeTakeFirstOrThrow();

    await uow
      .updateTable('platform_document_sequences')
      .set({ next_value: row.next_value + 1 })
      .where('doc_type', '=', input.docType)
      .where('site_id', '=', siteIdBin)
      .where('year', '=', input.year)
      .execute();

    const seq6 = String(row.next_value).padStart(6, '0');
    return `${input.docType}-${input.codeSite}-${input.year}-${seq6}`;
  }
}
