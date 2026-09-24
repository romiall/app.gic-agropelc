/**
 * Emplacements virtuels (BR-ADM-010) : « créés par le système au démarrage, uniques par
 * type, et ne peuvent être ni modifiés ni désactivés ». Les 9 types sont CONFIRMÉS par la
 * contrainte `ck_organization_locations_type` (db/migrations/20260924100200_create_
 * organization.sql) et le dictionnaire (03-data/dictionnaire/02-organization.md). Les
 * libellés français ci-dessous sont DÉDUITS (non fixés par une source) de leur usage dans
 * le modèle de mouvements de stock (`inventory.stock_moves`, 03-data/dictionnaire/06-
 * inventory.md) : chaque type virtuel est l'autre extrémité d'un mouvement qui n'a pas de
 * contrepartie physique réelle.
 */
export interface VirtualLocationSeed {
  readonly code: string;
  readonly name: string;
  readonly locationType: string;
}

export const VIRTUAL_LOCATIONS: readonly VirtualLocationSeed[] = [
  { code: 'V_OPENING', name: 'Stock initial (ouverture)', locationType: 'V_OPENING' },
  {
    code: 'V_SUPPLIER',
    name: 'Fournisseur (réception sans emplacement dédié)',
    locationType: 'V_SUPPLIER',
  },
  { code: 'V_CUSTOMER', name: 'Client (sortie définitive par vente)', locationType: 'V_CUSTOMER' },
  {
    code: 'V_PRODUCTION',
    name: 'Production (entrées et sorties de lots)',
    locationType: 'V_PRODUCTION',
  },
  {
    code: 'V_CONSUMPTION',
    name: 'Consommation (intrants consommés)',
    locationType: 'V_CONSUMPTION',
  },
  { code: 'V_LOSS', name: 'Pertes confirmées', locationType: 'V_LOSS' },
  {
    code: 'V_PENDING_LOSS',
    name: 'Pertes en attente de validation',
    locationType: 'V_PENDING_LOSS',
  },
  { code: 'V_ADJUSTMENT', name: "Ajustements d'inventaire", locationType: 'V_ADJUSTMENT' },
  { code: 'V_TRANSIT', name: 'Transferts en transit', locationType: 'V_TRANSIT' },
] as const;
