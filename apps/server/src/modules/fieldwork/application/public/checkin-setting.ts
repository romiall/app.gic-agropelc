/**
 * Réglage du pointage (AV-537 ; décision du porteur du 08/11/2026, questionnaire de clôture Q44) : le pointage
 * est désactivé pour le pilote (effectif opérationnel nombreux, frictions internes redoutées) ; le dispositif de
 * géolocalisation reste en réserve et se rétablit en remettant `fieldwork.checkin_enabled` à vrai.
 *
 * Le réglage ne masque que la **présentation** : l'action « PRENDRE SERVICE » et le signal « Vous n'avez pas pris
 * service » de l'accueil, les ventes signalées pour le seul motif « hors prise de service ». Rien n'est supprimé ni
 * refusé : la commande `fieldwork.checkin.perform`, les sessions et les dérogations continuent de fonctionner, et
 * les indicateurs `OUT_OF_SESSION` des visites et des ventes continuent d'être écrits (INV-TER : ce sont des faits).
 *
 * Réglage **global** (pas de surcharge par site : le pointage se tient par zone et par personne). Valeur absente ou
 * mal formée : **vrai**, le comportement d'avant la décision, jusqu'à ce que le semis ait posé la valeur du porteur
 * (faux) ; l'appareil applique la même règle (`checkinEnabled`, PWA).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Paramètre qui active le pointage (prise de service géolocalisée) ; faux depuis la décision du 08/11/2026. */
export const CHECKIN_ENABLED_SETTING = 'fieldwork.checkin_enabled';

/** Le pointage est-il en service à l'instant `at` ? Valeur globale en vigueur, à défaut `true`. */
export async function isCheckinEnabled(executor: Executor, at: Date): Promise<boolean> {
  const value = await currentSettingValue(executor, {
    key: CHECKIN_ENABLED_SETTING,
    scopeType: 'GLOBAL',
    scopeId: null,
    at,
  });
  return typeof value === 'boolean' ? value : true;
}
