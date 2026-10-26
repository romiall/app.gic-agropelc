/**
 * Demande d'impression d'une pièce : le code de la pièce et ses données. Module léger (types
 * seulement) : les écrans le préparent sans charger le moteur d'impression, chargé à la demande.
 */
import type {
  DonneesBD,
  DonneesBV,
  DonneesFA,
  DonneesFJC,
  DonneesJE,
  DonneesRE,
  DonneesRF,
} from './pieces-argent.js';
import type {
  DonneesBC,
  DonneesBL,
  DonneesBR,
  DonneesBT,
  DonneesCC,
  DonneesDA,
  DonneesFI,
  DonneesFL,
  DonneesFP,
} from './pieces-operations.js';

export type DemandePiece =
  | { readonly code: 'BV'; readonly donnees: DonneesBV }
  | { readonly code: 'RE'; readonly donnees: DonneesRE }
  | { readonly code: 'BD'; readonly donnees: DonneesBD }
  | { readonly code: 'RF'; readonly donnees: DonneesRF }
  | { readonly code: 'FJC'; readonly donnees: DonneesFJC }
  | { readonly code: 'JE'; readonly donnees: DonneesJE }
  | { readonly code: 'FA'; readonly donnees: DonneesFA }
  | { readonly code: 'CC'; readonly donnees: DonneesCC }
  | { readonly code: 'BL'; readonly donnees: DonneesBL }
  | { readonly code: 'DA'; readonly donnees: DonneesDA }
  | { readonly code: 'BC'; readonly donnees: DonneesBC }
  | { readonly code: 'BR'; readonly donnees: DonneesBR }
  | { readonly code: 'BT'; readonly donnees: DonneesBT }
  | { readonly code: 'FP'; readonly donnees: DonneesFP }
  | { readonly code: 'FI'; readonly donnees: DonneesFI }
  | { readonly code: 'FL'; readonly donnees: DonneesFL };

export type CodePiece = DemandePiece['code'];
