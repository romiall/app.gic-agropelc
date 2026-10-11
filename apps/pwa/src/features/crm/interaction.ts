/**
 * Échange avec un compte (appel, SMS, courriel, autre ; BR-CRM-017) : logique pure de
 * `crm.interaction.record`. Textes vides jamais envoyés (le serveur refuse une chaîne vide).
 */
import type { InteractionData } from '../sales/types.js';

export const INTERACTION_CHANNELS = ['APPEL', 'SMS', 'EMAIL', 'AUTRE'] as const;
export const MAX_INTERACTION_SUMMARY = 4000;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface InteractionDraft {
  readonly channel: InteractionData['channel'] | '';
  readonly direction: InteractionData['direction'];
  readonly summary: string;
  readonly nextActionAt: string;
  readonly nextActionNote: string;
}

export const EMPTY_INTERACTION: InteractionDraft = {
  channel: '',
  direction: 'SORTANT',
  summary: '',
  nextActionAt: '',
  nextActionNote: '',
};

export type InteractionIssue = 'CHANNEL_REQUIRED' | 'NEXT_ACTION_PAST';

export function checkInteraction(draft: InteractionDraft, today: string): InteractionIssue[] {
  const issues: InteractionIssue[] = [];
  if (!draft.channel) issues.push('CHANNEL_REQUIRED');
  if (draft.nextActionAt && (!DATE_ONLY.test(draft.nextActionAt) || draft.nextActionAt < today)) {
    issues.push('NEXT_ACTION_PAST');
  }
  return issues;
}

export function interactionPayload(customerId: string, draft: InteractionDraft) {
  const summary = draft.summary.trim();
  const nextActionNote = draft.nextActionNote.trim();
  return {
    customerId,
    channel: draft.channel,
    direction: draft.direction,
    ...(summary ? { summary } : {}),
    ...(draft.nextActionAt ? { nextActionAt: draft.nextActionAt } : {}),
    ...(nextActionNote ? { nextActionNote } : {}),
  };
}
