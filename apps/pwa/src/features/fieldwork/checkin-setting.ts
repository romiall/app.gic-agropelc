/**
 * Pointage en service ou non (AV-537 ; décision du porteur du 08/11/2026, questionnaire de clôture Q44) : le
 * pointage est désactivé pour le pilote, le réglage global `fieldwork.checkin_enabled` (visible de l'appareil, jeu
 * `me`) le rétablit. Il ne masque que la présentation : l'écran de prise de service explique que rien n'est à faire
 * et ne relève pas la position, les écrans de visite et de vente n'annoncent plus « hors prise de service ».
 * Rien n'est supprimé : les indicateurs restent écrits par le serveur, la prise de service reste possible.
 *
 * Même règle que le serveur (`isCheckinEnabled`) : valeur absente ou mal formée = vrai, le comportement d'avant la
 * décision (un téléphone qui n'a pas encore reçu le réglage se comporte comme avant).
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { clock } from '../../platform/composition.js';
import { getDb } from '../../storage/db.js';
import { listProjected } from '../../storage/projections.js';
import { settingValue } from '../sales/stock.js';
import type { SettingData } from '../sales/types.js';

export const CHECKIN_ENABLED_SETTING = 'fieldwork.checkin_enabled';

/** Indicateur de visite et de vente que le pointage désactivé ne présente plus. */
export const OUT_OF_SESSION_FLAG = 'OUT_OF_SESSION';

/** Le pointage est-il en service ? Réglage global le plus récent en vigueur à `now`, à défaut vrai. */
export function checkinEnabled(settings: readonly SettingData[], now: Date): boolean {
  const value = settingValue(settings, CHECKIN_ENABLED_SETTING, null, now);
  return typeof value === 'boolean' ? value : true;
}

/** Indicateurs à présenter : sans pointage, « hors prise de service » n'en est plus un. */
export function presentedFlags(flags: readonly string[], enabled: boolean): readonly string[] {
  return enabled ? flags : flags.filter((flag) => flag !== OUT_OF_SESSION_FLAG);
}

/**
 * Réglage lu dans la base locale de l'appareil ; `undefined` tant qu'il se charge (un écran qui relève la position
 * attend de savoir s'il doit le faire).
 */
export function useCheckinEnabled(): boolean | undefined {
  return useLiveQuery(
    async () =>
      checkinEnabled(await listProjected<SettingData>(getDb(), 'me', 'SETTING'), clock.now()),
    [],
  );
}
