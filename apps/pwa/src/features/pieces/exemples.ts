/**
 * Données d'exemple des pièces : servent aux tests et à l'aperçu de contrôle visuel
 * (`apercu.test.ts`), jamais à l'application.
 */
import type { DonneesBV } from './pieces-argent.js';

export const EXEMPLE_BV: DonneesBV = {
  numero: 'VTE-DLA1-2026-000123',
  client: 'Restaurant Le Palmier',
  telephone: '+237 677 12 34 56',
  anonyme: false,
  pointDeVente: 'PDV Douala Bonabéri',
  dateHeure: '26/10/2026 à 09 h 42',
  vendeur: 'Aïcha Mbarga',
  lignes: [
    {
      designation: 'Poulet de chair vif',
      unite: 'têtes',
      quantite: '12',
      poidsKg: '27,6',
      prixUnitaire: 2500,
      remise: null,
      montant: 69_000,
    },
    {
      designation: 'Œufs de table calibre M',
      unite: 'plateaux',
      quantite: '10',
      poidsKg: null,
      prixUnitaire: 2300,
      remise: 1000,
      montant: 22_000,
    },
    {
      designation: 'Aliment démarrage 50 kg',
      unite: 'sac',
      quantite: '1',
      poidsKg: null,
      prixUnitaire: 18_500,
      remise: null,
      montant: 18_500,
    },
  ],
  total: 109_500,
  moyens: ['Espèces', 'Orange Money'],
  encaisse: 100_000,
  reference: 'OM 7845123',
  resteDu: 9_500,
};
