/**
 * `GET /health` — sans authentification, sans dépendance : sonde de disponibilité externe
 * (NFR-17). `GET /health/ready` — base joignable et retard du worker sous seuil
 * (09-non-functional/02-observabilite.md §7 ; P0-16).
 */
import { Controller, Get, HttpCode, Inject } from '@nestjs/common';
import { sql } from 'kysely';
import { Public } from '../platform/http/authorization.decorators.js';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { ApiError } from '../platform/http/api-error.exception.js';
import {
  EVENT_CONSUMER_REGISTRY,
  type EventConsumerRegistry,
} from '../platform/events/event-consumer-registry.provider.js';

// Nombre d'événements non encore atteints par le consommateur le plus en retard : proxy
// simple du « retard du worker » (§7) faute d'un signal en secondes directement disponible
// ici — la mesure temporelle du tableau de bord (§5, alerte « > 60 s ») reste à affiner
// (DÉDUIT, seuil paramétrable plus tard, règle CLAUDE.md #2). La vérification « migrations à
// jour » (§7) n'est pas faite ici : elle appartient à la CI/au déploiement (schema.sql
// committé, rejoué avant démarrage), pas à une sonde d'exécution.
const WORKER_LAG_THRESHOLD_EVENTS = 1000;

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EVENT_CONSUMER_REGISTRY) private readonly consumers: EventConsumerRegistry,
  ) {}

  @Get()
  @Public()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HttpCode(200)
  @Public()
  async ready(): Promise<{
    status: 'ok';
    checks: { readonly database: 'ok'; readonly worker_lag_events: number };
  }> {
    await sql`SELECT 1`.execute(this.db);

    const events = await this.db
      .selectFrom('platform_domain_events')
      .select(({ fn }) => fn.max('seq').as('maxSeq'))
      .executeTakeFirst();
    const maxSeq = Number(events?.maxSeq ?? 0);

    // Seuls les consommateurs actuellement enregistrés (`EventConsumerRegistry`, alimenté au
    // démarrage) comptent : une ligne oubliée d'un consommateur renommé ou retiré (ou, en
    // test, un nom d'appareil éphémère jamais réutilisé) resterait figée à un `last_seq`
    // ancien et fausserait le retard pour toujours si elle était incluse sans discrimination.
    const consumerNames = this.consumers.names();
    let lag = 0;
    if (consumerNames.length > 0) {
      const offsets = await this.db
        .selectFrom('platform_event_consumer_offsets')
        .select(({ fn }) => fn.min('last_seq').as('minLastSeq'))
        .where('consumer_name', 'in', consumerNames)
        .executeTakeFirst();
      const minLastSeq = Number(offsets?.minLastSeq ?? maxSeq);
      lag = Math.max(0, maxSeq - minLastSeq);
    }

    if (lag > WORKER_LAG_THRESHOLD_EVENTS) {
      throw new ApiError(503, 'WORKER_LAG', `Retard du worker : ${lag} événements non consommés.`);
    }

    return { status: 'ok', checks: { database: 'ok', worker_lag_events: lag } };
  }
}
