/**
 * Envoi et suivi des reports de pièces papier (PP-B ; REQ-303, AV-308, AV-312, AV-078, AV-501 à AV-504).
 *
 * Envoi : la pièce résolue (`report-form.ts`) devient la commande du serveur (`report-commands.ts`),
 * mise dans l'outbox avec l'heure écrite sur la pièce, le motif d'antidatage, la photo de la souche et les
 * indices locaux (`PAPER_SLIP`, `SLIP_TYPE:*`, `PAPER_REF:*`, `SLIP_AMOUNT:*`). Suivi : le registre des
 * carnets relit ces indices dans l'outbox de l'appareil.
 */

import { idGenerator } from '../../platform/composition.js';
import type { GicDatabase, OutboxCommand } from '../../storage/db.js';
import type { EnqueueInput } from '../../sync/outbox.js';
import { photoAttachment } from '../attachments/attachments.js';
import type { PreparedPhoto } from '../attachments/photo.js';
import { submitCommand } from '../sales/submit.js';
import type { SlipMeta } from './report-form.js';
import {
  FLAG_AMOUNT,
  FLAG_PAPER_REF,
  FLAG_PAPER_SLIP,
  FLAG_SLIP_TYPE,
  REPORTABLE_SLIP_TYPES,
  buildReportCommands,
  type ReportCommand,
  type ReportableSlipType,
  type ResolvedSlip,
} from './report-commands.js';

export type { ReportableSlipType } from './report-commands.js';

export type OutboxInput = Omit<EnqueueInput, 'capturedOffline' | 'commandVersion'> & {
  readonly capturedOffline: boolean;
};

/** Entrée de l'outbox pour une commande de report, photo de la souche comprise quand le type la porte. */
export function toOutboxInput(
  command: ReportCommand,
  authorUserId: string,
  photo: PreparedPhoto | null = null,
): OutboxInput {
  return {
    authorUserId,
    commandType: command.commandType,
    aggregateType: command.aggregateType,
    aggregateId: command.aggregateId,
    ...(command.dependsOn.length > 0 ? { dependsOn: command.dependsOn } : {}),
    payload: command.payload,
    occurredAt: command.occurredAt,
    backdatedReason: command.backdatedReason,
    capturedOffline: command.capturedOffline,
    // La photo n'est jointe que si le serveur sait la rattacher à l'opération (AV-504).
    ...(photo && command.photo
      ? {
          attachments: [photoAttachment(photo, { ...command.photo, ownerId: command.aggregateId })],
        }
      : {}),
    localFlags: command.localFlags,
  };
}

/**
 * Enregistre le report de pièce papier dans l'outbox locale (les commandes sont celles du serveur). Une pièce en plusieurs
 * commandes (bon de commande, fiche d'inventaire) les met en file dans l'ordre, chacune dépendant de la précédente ; la
 * commande rendue est la dernière, celle dont le résultat dit si la pièce est entièrement enregistrée.
 */
export async function submitPaperSlipReport(
  slip: ResolvedSlip,
  meta: SlipMeta,
  authorUserId: string,
  photo: PreparedPhoto | null = null,
): Promise<OutboxCommand> {
  const commands = buildReportCommands(slip, {
    paperRef: meta.paperRef,
    occurredAt: meta.occurredAt,
    backdatedReason: meta.backdatedReason,
    aggregateId: idGenerator.newId(),
    dependsOn: meta.dependsOn,
  });
  let previous: OutboxCommand | undefined;
  for (const command of commands) {
    const input = toOutboxInput(command, authorUserId, photo);
    previous = await submitCommand(
      command.dependsOnPrevious && previous
        ? { ...input, dependsOn: [...(input.dependsOn ?? []), previous.command_id] }
        : input,
    );
  }
  return previous!;
}

export interface ReportedSlipRecord {
  readonly commandId: string;
  readonly slipType: ReportableSlipType;
  readonly paperSlipRef: string;
  readonly occurredAt: string;
  readonly submittedAt: string;
  readonly authorUserId: string;
  readonly description: string;
  readonly amountXaf?: number | null;
  readonly status: OutboxCommand['status'];
  readonly hasAttachment: boolean;
  readonly backdatedReason?: string | null;
}

const isSlipType = (value: string): value is ReportableSlipType =>
  (REPORTABLE_SLIP_TYPES as readonly string[]).includes(value);

const countOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
const plural = (n: number, singular: string, many: string): string =>
  `${n} ${n > 1 ? many : singular}`;

/**
 * Traduction des codes que porte la charge utile d'une commande (moyen de paiement, nature de perte) en libellés
 * lisibles : sans elle, le registre afficherait les codes bruts (« Encaissement (ESPECES) »). Chaque fonction rend le
 * code lui-même quand elle ne le connaît pas.
 */
export interface PayloadLabels {
  readonly paymentMethod?: (code: string) => string;
  readonly lossCategory?: (code: string) => string;
}

/** Libellé d'une pièce reportée, tiré de la charge utile de sa commande. */
export function describeReportedPayload(
  type: ReportableSlipType,
  payload: unknown,
  labels: PayloadLabels = {},
): string {
  const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  const methodLabel = (code: string): string => labels.paymentMethod?.(code) ?? code;
  const lossLabel = (code: string): string => labels.lossCategory?.(code) ?? code;
  switch (type) {
    case 'BV':
      return `Vente : ${plural(countOf(p['lines']), 'ligne', 'lignes')}`;
    case 'CC':
      return `Commande client : ${plural(countOf(p['lines']), 'ligne', 'lignes')}`;
    case 'BL':
      return `Livraison : ${plural(countOf(p['lines']), 'ligne', 'lignes')}`;
    case 'RE':
      return `Encaissement (${methodLabel(String(p['methodCode'] ?? ''))})`;
    case 'BD': {
      const payee = typeof p['payeeName'] === 'string' ? `À : ${p['payeeName']} — ` : '';
      return `${payee}${typeof p['description'] === 'string' ? p['description'] : 'Dépense'}`;
    }
    case 'RF':
      return 'Remise de fonds';
    case 'BR':
      return `Réception : ${plural(countOf(p['lines']), 'ligne', 'lignes')}`;
    case 'BT':
      return `Transfert : ${plural(countOf(p['lines']), 'ligne', 'lignes')}`;
    case 'FP':
      return `Perte (${lossLabel(String(p['category'] ?? ''))})`;
    case 'DA':
      return `Demande d'achat : ${plural(countOf(p['lines']), 'ligne', 'lignes')}`;
    case 'BC':
      return `Bon de commande fournisseur : ${plural(countOf(p['lines']), 'ligne', 'lignes')}`;
    case 'VC':
      return 'Visite commerciale';
    case 'FL':
      // La première commande porte les indices : la fiche entière tient en plusieurs saisies du jour.
      return 'Suivi de lot de production';
    case 'FI':
      // La première commande de la chaîne (l'ouverture) porte les indices : elle n'a pas encore les lignes.
      return `Fiche d'inventaire (${
        p['countType'] === 'FULL' ? 'complet' : p['countType'] === 'SPOT' ? 'ponctuel' : 'partiel'
      })`;
  }
}

/**
 * Charge les pièces papier reportées sur cet appareil à partir de l'outbox Dexie (indices locaux écrits
 * par `buildReportCommand`).
 */
export async function loadReportedSlipsFromDb(
  db: GicDatabase,
  labels: PayloadLabels = {},
): Promise<ReportedSlipRecord[]> {
  const commands = await db.outbox.toArray();
  const reported: ReportedSlipRecord[] = [];

  for (const cmd of commands) {
    const flags = cmd.local_flags ?? [];
    if (!flags.includes(FLAG_PAPER_SLIP)) continue;

    let slipType: ReportableSlipType = 'BV';
    let paperSlipRef = '';
    let amountXaf: number | null = null;

    for (const flag of flags) {
      if (flag.startsWith(FLAG_SLIP_TYPE)) {
        const type = flag.slice(FLAG_SLIP_TYPE.length);
        if (isSlipType(type)) slipType = type;
      } else if (flag.startsWith(FLAG_PAPER_REF)) {
        paperSlipRef = flag.slice(FLAG_PAPER_REF.length);
      } else if (flag.startsWith(FLAG_AMOUNT)) {
        const amount = Number(flag.slice(FLAG_AMOUNT.length));
        if (Number.isFinite(amount)) amountXaf = amount;
      }
    }

    reported.push({
      commandId: cmd.command_id,
      slipType,
      paperSlipRef,
      occurredAt: cmd.occurred_at,
      submittedAt: cmd.client_created_at,
      authorUserId: cmd.author_user_id,
      description: describeReportedPayload(slipType, cmd.payload, labels),
      amountXaf,
      status: cmd.status,
      hasAttachment: (cmd.attachment_ids ?? []).length > 0,
      backdatedReason: cmd.backdated_reason,
    });
  }

  // Tri anti-chronologique
  return reported.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}
