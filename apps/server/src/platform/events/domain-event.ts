/**
 * Forme applicative d'une ligne `platform_domain_events` (conversion des colonnes
 * `BINARY(16)` en UUID texte, une fois pour tous les consommateurs — comme le reste du
 * serveur, jamais de `Buffer` exposé au-delà de la frontière Kysely).
 */
import type { Selectable } from 'kysely';
import { fromBin, fromBinOrNull } from '../kysely/uuid-columns.js';
import type { PlatformDomainEvents } from '../kysely/schema.generated.js';

export interface DomainEvent<P = unknown> {
  readonly seq: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly producerModule: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly payload: P;
  readonly commandId: string | null;
  readonly correlationId: string | null;
  readonly causationId: string | null;
}

export function toDomainEvent<P = unknown>(row: Selectable<PlatformDomainEvents>): DomainEvent<P> {
  return {
    seq: Number(row.seq),
    eventId: fromBin(row.event_id),
    eventType: row.event_type,
    eventVersion: row.event_version,
    producerModule: row.producer_module,
    aggregateType: row.aggregate_type,
    aggregateId: fromBin(row.aggregate_id),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    payload: row.payload as P,
    commandId: fromBinOrNull(row.command_id),
    correlationId: fromBinOrNull(row.correlation_id),
    causationId: fromBinOrNull(row.causation_id),
  };
}
