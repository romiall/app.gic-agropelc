/**
 * Registre serveur des types de commande (05-architecture/02-modules.md §17 `sync` :
 * « registre des gestionnaires de commandes (inversion : les modules s'enregistrent) » ;
 * 03-graphe-dependances.md note 2 : « sync-core ne dépend d'aucun module métier »).
 *
 * Compose {@link CommandRegistry} (@gic/contracts, partagé avec l'appareil : validation du
 * schéma d'enveloppe + `payload`) et y ajoute ce qui reste **propre au serveur** : la
 * **permission requise** (RC-01) et le **gestionnaire** unique du module propriétaire
 * (01-architecture-logicielle.md §3, règle « un gestionnaire unique »). Un seul appel
 * `register()` alimente les deux, pour qu'ils ne puissent pas diverger (même
 * `command_type`/`command_version` connus des deux côtés par construction). Aucune règle
 * de domaine ici — seulement la table de correspondance ; l'orchestration (authenticité,
 * droits, transaction) reste dans `commands/command-pipeline.service.ts`.
 */
import {
  CommandRegistry,
  type CommandEnvelope,
  type ParsedCommand,
  type WarningCode,
} from '@gic/contracts';
import type { z } from 'zod';
import type { UnitOfWork } from '../unit-of-work.js';

export type CommandHandlerOutcome =
  | { readonly status: 'APPLIED'; readonly serverRefs?: Record<string, string> }
  | {
      readonly status: 'APPLIED_WITH_WARNINGS';
      readonly warnings: readonly WarningCode[];
      readonly serverRefs?: Record<string, string>;
    }
  | { readonly status: 'CONFLICT'; readonly conflictId: string }
  | { readonly status: 'REJECTED'; readonly errorCode: string; readonly messageFr: string };

export type CommandHandler<P = unknown> = (
  uow: UnitOfWork,
  envelope: CommandEnvelope<P>,
) => Promise<CommandHandlerOutcome>;

export interface RegisterCommandInput<P> {
  readonly commandType: string;
  readonly version: number;
  readonly payloadSchema: z.ZodType<P>;
  readonly permissionCode: string;
  readonly handler: CommandHandler<P>;
}

interface ServerOnlyEntry {
  readonly permissionCode: string;
  readonly handler: CommandHandler;
}

export class CommandHandlerRegistry {
  private readonly schemaRegistry = new CommandRegistry();
  private readonly serverOnly = new Map<string, ServerOnlyEntry>();

  register<P>(input: RegisterCommandInput<P>): void {
    this.schemaRegistry.register(input.commandType, input.version, input.payloadSchema);
    this.serverOnly.set(registryKey(input.commandType, input.version), {
      permissionCode: input.permissionCode,
      handler: input.handler as CommandHandler,
    });
  }

  /** Validation d'enveloppe + `payload` (délègue à @gic/contracts, partagé avec l'appareil). */
  parse(raw: unknown): ParsedCommand {
    return this.schemaRegistry.parse(raw);
  }

  isVersionSupported(commandType: string, version: number): boolean {
    return this.schemaRegistry.has(commandType, version);
  }

  resolve(commandType: string, version: number): ServerOnlyEntry | undefined {
    return this.serverOnly.get(registryKey(commandType, version));
  }
}

function registryKey(commandType: string, version: number): string {
  return `${commandType}@${version}`;
}
