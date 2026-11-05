/**
 * Campagnes commerciales (UC-PRX-05, AV-516) : logique pure de la saisie, sans dépendance d'écran (l'essai du
 * serveur en importe la charge, `pwa-command-payloads.test.ts`). Début et fin se saisissent à l'heure de Douala
 * (`datetime-local`, UTC+1) et partent en instants ISO.
 */

/** Instant ISO d'une saisie `datetime-local` lue à l'heure de Douala ; `null` si invalide. */
export function doualaInstant(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00+01:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Saisie `datetime-local` (heure de Douala) d'un instant. */
export function doualaLocal(instant: Date): string {
  const shifted = new Date(instant.getTime() + 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 16);
}

/** Saisie d'une campagne commerciale : début et fin à l'heure de Douala. */
export interface CampaignForm {
  readonly code: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

export type CampaignProblem = 'CODE' | 'CODE_TAKEN' | 'NAME' | 'PERIOD';

/** Premier défaut de la saisie d'une campagne, ou `null` : code libre, nom, fin après le début. */
export function campaignProblem(
  form: CampaignForm,
  takenCodes: readonly (string | undefined)[],
): CampaignProblem | null {
  const code = form.code.trim();
  if (code === '') return 'CODE';
  if (takenCodes.includes(code)) return 'CODE_TAKEN';
  if (form.name.trim() === '') return 'NAME';
  const from = doualaInstant(form.from);
  const to = doualaInstant(form.to);
  return from === null || to === null || to <= from ? 'PERIOD' : null;
}

/** Charge de `pricing.campaign.create` (instants ISO) ; à n'appeler que sans défaut. */
export function campaignPayload(form: CampaignForm) {
  return {
    code: form.code.trim(),
    name: form.name.trim(),
    validFrom: doualaInstant(form.from) as string,
    validTo: doualaInstant(form.to) as string,
  };
}
