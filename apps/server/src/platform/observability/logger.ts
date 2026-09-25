/**
 * Logs structurés JSON (09-non-functional/02-observabilite.md §2) : `ts`, `level`,
 * `service`, `module`, `correlation_id`, `user_id` (pseudonymisé), `device_id`,
 * `command_type`, `duration_ms`, `code`, `message`. Un module autonome (pas un
 * fournisseur NestJS) : {@link CommandPipelineService} et les tests d'intégration le
 * construisent hors du conteneur de dépendances (`new CommandPipelineService(db, ...)`,
 * répandu dans `apps/server/test/`) — l'imposer par injection aurait forcé ces
 * constructions existantes à changer sans bénéfice.
 *
 * `service: 'api'` : seul le chemin HTTP (`commands.controller.ts`, `sync-push.service.ts`)
 * journalise ainsi pour l'instant ; le worker (`worker.ts`) suivra le même modèle quand un
 * besoin réel s'y présentera (règle CLAUDE.md #2, valeur par défaut paramétrable).
 */
import pino from 'pino';
import { pseudonymizeId } from './pseudonymize.js';

export const appLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'api' },
  messageKey: 'message',
  timestamp: () => `,"ts":"${new Date().toISOString()}"`,
  formatters: {
    level: (label: string) => ({ level: label }),
  },
});

export type LogLevel = 'info' | 'warn' | 'error';

export interface StructuredLogFields {
  readonly module: string;
  readonly correlationId?: string | null | undefined;
  readonly userId?: string | null | undefined;
  readonly deviceId?: string | null | undefined;
  readonly commandType?: string | null | undefined;
  readonly durationMs?: number | undefined;
  readonly code?: string | undefined;
}

/** Interdits (§2) : mots de passe, PIN, jetons, charge de commande complète, GPS précis —
 * aucun de ces champs n'accepte de valeur libre, seulement les identifiants ci-dessus. */
export function logStructured(level: LogLevel, fields: StructuredLogFields, message: string): void {
  appLogger[level](
    {
      module: fields.module,
      correlation_id: fields.correlationId ?? undefined,
      user_id: fields.userId ? pseudonymizeId(fields.userId) : undefined,
      device_id: fields.deviceId ?? undefined,
      command_type: fields.commandType ?? undefined,
      duration_ms: fields.durationMs,
      code: fields.code,
    },
    message,
  );
}
