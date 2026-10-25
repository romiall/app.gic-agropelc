// Agrégation des définitions de pièces (une famille par module p-*.mjs).
import { PIECES_CAISSE } from './p-caisse.mjs'
import { PIECES_CAISSE2 } from './p-caisse2.mjs'
import { PIECES_ACHATS_STOCK } from './p-achats-stock.mjs'
import { PIECES_TERRAIN } from './p-terrain.mjs'
import { PIECES_PAPETERIE } from './p-papeterie.mjs'

export const PIECES = [...PIECES_CAISSE, ...PIECES_CAISSE2, ...PIECES_ACHATS_STOCK, ...PIECES_TERRAIN, ...PIECES_PAPETERIE]
