/**
 * Emplacements virtuels (D06 §7.7 : `V_SUPPLIER`, `V_LOSS`…) pour les modules qui enregistrent
 * des mouvements par `recordStockMove` (ex. `procurement`, réception : `V_SUPPLIER` → emplacement
 * de réception, BR-APP-007). Une seule ligne par type (seed), mise en cache par processus.
 */
export { virtualLocationId } from '../commands/shared.js';
