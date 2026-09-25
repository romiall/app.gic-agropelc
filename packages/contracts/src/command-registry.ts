/**
 * Registre des types de commande : associe `command_type` et `command_version` au
 * schéma de validation du `payload` (ADR-021 ; 06-offline-sync/02-synchronisation.md §7
 * « command_version : compatibilité N-1, BR-SYN-016 »).
 *
 * Chaque module (identity, organization, sales…) déclare ses commandes en appelant
 * {@link CommandRegistry.register} à son initialisation ; le pipeline de commande du
 * serveur (`apps/server/src/platform`) résout ainsi `command_type` → schéma → gestionnaire
 * sans connaître les modules à l'avance (inversion de dépendance, comme le registre de
 * `sync`, 05-architecture/03-graphe-dependances.md, note 2).
 */
import type { z } from 'zod';
import {
  commandEnvelopeBaseSchema,
  commandTypeSchema,
  type CommandEnvelope,
} from './command-envelope.js';

export interface RegisteredCommandType<P = unknown> {
  readonly commandType: string;
  readonly version: number;
  readonly payloadSchema: z.ZodType<P>;
}

export type ParsedCommand<P = unknown> =
  | { readonly ok: true; readonly envelope: CommandEnvelope<P> }
  | {
      readonly ok: false;
      readonly reason: 'UNKNOWN_COMMAND_TYPE' | 'UNSUPPORTED_VERSION' | 'VALIDATION_ERROR';
      readonly issues?: z.ZodIssue[];
    };

/**
 * Registre mutable : un `command_type` peut porter plusieurs versions enregistrées
 * simultanément (la version courante **et** la version N-1, tant que le délai de
 * compatibilité de BR-SYN-016 court). `parse` choisit le schéma exact de la version reçue.
 */
export class CommandRegistry {
  private readonly byTypeAndVersion = new Map<string, RegisteredCommandType>();

  register<P>(commandType: string, version: number, payloadSchema: z.ZodType<P>): void {
    const parsedType = commandTypeSchema.safeParse(commandType);
    if (!parsedType.success) {
      throw new Error(
        `command_type invalide : « ${commandType} » (attendu <module>.<agrégat>.<verbe>).`,
      );
    }
    const key = registryKey(commandType, version);
    if (this.byTypeAndVersion.has(key)) {
      throw new Error(`Commande déjà enregistrée : ${commandType} v${version}.`);
    }
    this.byTypeAndVersion.set(key, { commandType, version, payloadSchema });
  }

  has(commandType: string, version: number): boolean {
    return this.byTypeAndVersion.has(registryKey(commandType, version));
  }

  /** Versions enregistrées pour un `command_type`, triées croissantes. */
  versionsOf(commandType: string): number[] {
    const versions: number[] = [];
    for (const entry of this.byTypeAndVersion.values()) {
      if (entry.commandType === commandType) versions.push(entry.version);
    }
    return versions.sort((a, b) => a - b);
  }

  /**
   * Valide une enveloppe brute : champs de transport, puis `payload` selon le schéma
   * exact de `command_type` + `command_version`. Ne fait **aucun** contrôle métier
   * (authenticité, RBAC, règles de validité) — ceux-ci restent au pipeline de commande
   * (05-architecture/01-architecture-logicielle.md §4), qui les applique après cette
   * étape purement structurelle.
   */
  parse(raw: unknown): ParsedCommand {
    const base = commandEnvelopeBaseSchema.safeParse(raw);
    if (!base.success) {
      return { ok: false, reason: 'VALIDATION_ERROR', issues: base.error.issues };
    }
    const { command_type, command_version } = base.data;
    if (this.versionsOf(command_type).length === 0) {
      return { ok: false, reason: 'UNKNOWN_COMMAND_TYPE' };
    }
    const entry = this.byTypeAndVersion.get(registryKey(command_type, command_version));
    if (!entry) {
      return { ok: false, reason: 'UNSUPPORTED_VERSION' };
    }
    const payload = entry.payloadSchema.safeParse((raw as { payload?: unknown }).payload);
    if (!payload.success) {
      return { ok: false, reason: 'VALIDATION_ERROR', issues: payload.error.issues };
    }
    return { ok: true, envelope: { ...base.data, payload: payload.data } };
  }
}

function registryKey(commandType: string, version: number): string {
  return `${commandType}@${version}`;
}
