/**
 * Lignes de flux de changements émises par `catalog` (P5-18, suite d'ADR-031 ; 01-architecture-
 * offline.md §3.1, AV-196) : jeu `catalog`, ligne `GLOBAL` — référentiels de vente téléchargés par
 * tous les appareils :
 * - unités et canaux de vente, dont la clé primaire est leur `code` : clé de synchronisation
 *   dérivée du code (`codeEntityId`, ADR-031), seule valeur qu'un gestionnaire et le seed calculent
 *   à l'identique ; ces tables n'ont pas de version (`row_version` = 1) ;
 * - motifs (`REASON_CODE`), à leur identifiant et à leur version.
 * Les lignes semées sans passer par une commande sont publiées par le seed (`db/seeds/
 * publish-references.ts`). Le type d'entité est une clé de `sync/entity-projections.ts`.
 */
import type { ChangeFeedEntry } from '../../../platform/sync/change-feed.js';
import { codeEntityId } from '../../../platform/sync/code-entity-id.js';

export const CATALOG_DATASET = 'catalog';

export type CodeKeyedReference = 'UNIT' | 'SALES_CHANNEL';

export function codeKeyedReferenceChange(
  entityType: CodeKeyedReference,
  code: string,
): ChangeFeedEntry {
  return {
    dataset: CATALOG_DATASET,
    entityType,
    entityId: codeEntityId(entityType, code),
    scopeType: 'GLOBAL',
    scopeId: null,
  };
}

export function reasonCodeChange(reasonCodeId: string, rowVersion: number): ChangeFeedEntry {
  return {
    dataset: CATALOG_DATASET,
    entityType: 'REASON_CODE',
    entityId: reasonCodeId,
    scopeType: 'GLOBAL',
    scopeId: null,
    rowVersion,
  };
}
