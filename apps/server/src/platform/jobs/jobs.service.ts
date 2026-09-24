/**
 * `jobs.enqueue(...)` (05-architecture/02-modules.md §1 « platform ») : dépose une tâche
 * dans `platform_jobs`, dans la transaction de l'appelant (comme `audit.record`) — si la
 * transaction est annulée, la tâche ne part jamais (pas de tâche orpheline pour un effet qui
 * n'a finalement pas eu lieu).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Clock, IdGenerator } from '@gic/domain';
import type { UnitOfWork } from '../unit-of-work.js';
import { CLOCK } from '../clock.provider.js';
import { ID_GENERATOR } from '../id-generator.provider.js';
import { jsonValue } from '../kysely/json-value.js';
import { toBin } from '../kysely/uuid-columns.js';

export interface EnqueueJobInput {
  readonly jobType: string;
  readonly payload: unknown;
  /** Éligible dès que possible par défaut ; différer une tâche (reprise, planification simple). */
  readonly runAt?: Date;
}

@Injectable()
export class JobsService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  async enqueue(uow: UnitOfWork, input: EnqueueJobInput): Promise<string> {
    const id = this.idGenerator.newId();
    await uow
      .insertInto('platform_jobs')
      .values({
        id: toBin(id),
        job_type: input.jobType,
        payload: jsonValue(input.payload),
        run_at: input.runAt ?? this.clock.now(),
      })
      .execute();
    return id;
  }
}
