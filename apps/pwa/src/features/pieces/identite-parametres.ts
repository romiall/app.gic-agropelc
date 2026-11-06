/**
 * Identité de la société et régime de TVA lus des paramètres de l'appareil (AV-324 (a), AV-451 (c)).
 *
 * Les paramètres `company.*` (`organization.system_settings`, visibles des appareils, jeu `me`) pilotent l'en-tête
 * de chaque pièce, les coordonnées de règlement de la facture et les cases « Régime de TVA » / « Mention
 * d'exonération » : l'Admin les règle dans l'écran des paramètres (groupe « Société »). Tant qu'un paramètre n'est pas
 * arrivé sur l'appareil, la valeur de `IDENTITE` (copie de `pieces-papier/charte/identite.json`) s'applique ; un
 * paramètre présent mais vide donne la ligne pointillée du papier. Fonctions pures : le
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
import type { DonneesFA } from './pieces-argent.js';

/**
 * Valeur d'un paramètre : celle en vigueur ; à défaut (version datée d'avance, ou horloge de l'appareil en retard), la
 * plus récente reçue. Le serveur retire de l'appareil la version remplacée dès que la nouvelle arrive : sans ce repli,
 * l'en-tête retomberait sur les valeurs d'origine du dossier — ni l'ancienne ni la nouvelle valeur.
 */
function lire(settings: readonly SettingData[], key: string, now: Date): unknown {
  const inForce = settingValue(settings, key, null, now);
  if (inForce !== undefined) return inForce;
  return settings
    .filter((setting) => setting.key === key && setting.scope_type === 'GLOBAL')
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0]?.value;
}

/** Identité imprimée : le paramètre de l'appareil, sinon la valeur de `IDENTITE`. */
export function identiteDepuisParametres(
  settings: readonly SettingData[] | undefined,
  now: Date,
): Identite {
  const identite: { -readonly [K in keyof Identite]: string } = { ...IDENTITE };
  if (!settings) return identite;
  for (const champ of Object.keys(COMPANY_IDENTITY_SETTINGS) as CompanyIdentityField[]) {
    const valeur = lire(settings, COMPANY_IDENTITY_SETTINGS[champ], now);
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
  const regime = lire(settings, COMPANY_VAT_REGIME_SETTING, now);
  const mention = lire(settings, COMPANY_VAT_MENTION_SETTING, now);
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

/**
 * Données d'une facture complétées des paramètres de la société : coordonnées de règlement (banque, compte, mobile
 * money), régime de TVA et mention d'exonération. Une rubrique non renseignée reste la ligne pointillée du papier, à
 * compléter à la main. Sans paramètres lus (`undefined`), la facture est rendue telle quelle.
 */
export function completerFacture(
  donnees: DonneesFA,
  settings: readonly SettingData[] | undefined,
  now: Date,
): DonneesFA {
  if (!settings) return donnees;
  const identite = identiteDepuisParametres(settings, now);
  const tva = tvaDepuisParametres(settings, now);
  return {
    ...donnees,
    regimeTva: tva.regime,
    mentionExoneration: tva.mention,
    banque: identite.banque || null,
    compte: identite.compte_bancaire || null,
    mobileMoney: identite.mobile_money || null,
  };
}
