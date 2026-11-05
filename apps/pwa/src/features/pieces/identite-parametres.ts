/**
 * Identité de la société et régime de TVA lus des paramètres de l'appareil (AV-324 (a), AV-451 (c)).
 *
 * Les paramètres `company.*` (`organization.system_settings`, visibles des appareils, jeu `me`) pilotent l'en-tête
 * de chaque pièce, les coordonnées de règlement de la facture et les cases « Régime de TVA » / « Mention
 * d'exonération » : l'Admin les règle dans l'écran des paramètres (groupe « Société »). Tant qu'un paramètre n'est pas
 * arrivé sur l'appareil, la valeur de `IDENTITE` (copie de `pieces-papier/charte/identite.json`) s'applique ; un
 * paramètre présent mais vide donne la ligne pointillée du papier, à compléter à la main. Fonctions pures : le
 * moment de lecture est un paramètre.
 */
import {
  COMPANY_IDENTITY_SETTINGS,
  COMPANY_VAT_MENTION_SETTING,
  COMPANY_VAT_REGIME_SETTING,
  type CompanyIdentityField,
} from '@gic/contracts';
import { settingValue } from '../sales/stock.js';
import type { SettingData } from '../sales/types.js';
import { IDENTITE, type Identite } from './identite.js';

/** Identité imprimée : le paramètre de l'appareil, sinon la valeur de `IDENTITE`. */
export function identiteDepuisParametres(
  settings: readonly SettingData[] | undefined,
  now: Date,
): Identite {
  const identite: { -readonly [K in keyof Identite]: string } = { ...IDENTITE };
  if (!settings) return identite;
  for (const champ of Object.keys(COMPANY_IDENTITY_SETTINGS) as CompanyIdentityField[]) {
    const valeur = settingValue(settings, COMPANY_IDENTITY_SETTINGS[champ], null, now);
    if (typeof valeur === 'string') identite[champ] = valeur.trim();
  }
  return identite;
}

/** Libellés des deux cases du modèle de facture validé par le comptable. */
export type RegimeTvaImprime = 'TVA applicable' | 'opération exonérée de TVA';

export interface TvaImprimee {
  /** Case cochée ; `null` : les deux restent à cocher à la main (régime non précisé). */
  readonly regime: RegimeTvaImprime | null;
  /** Mention d'exonération ; `null` : la rubrique reste en pointillés. */
  readonly mention: string | null;
}

/**
 * Régime de TVA et mention d'exonération de la facture (AV-451 (c)). Le choix `VAT_APPLICABLE` coche la case : les
 * montants restent ceux de la vente, prix toutes taxes comprises à TVA nulle (AV-041), tant que le taux n'est pas décidé.
 */
export function tvaDepuisParametres(
  settings: readonly SettingData[] | undefined,
  now: Date,
): TvaImprimee {
  if (!settings) return { regime: null, mention: null };
  const regime = settingValue(settings, COMPANY_VAT_REGIME_SETTING, null, now);
  const mention = settingValue(settings, COMPANY_VAT_MENTION_SETTING, null, now);
  return {
    regime:
      regime === 'VAT_APPLICABLE'
        ? 'TVA applicable'
        : regime === 'VAT_EXEMPT'
          ? 'opération exonérée de TVA'
          : null,
    mention: typeof mention === 'string' && mention.trim() !== '' ? mention.trim() : null,
  };
}
