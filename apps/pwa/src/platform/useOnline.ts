/**
 * État du réseau pour les écrans : interface active (`navigator.onLine`) ET serveur joignable au
 * dernier cycle de synchronisation (`connectivity.ts`, ADR-051).
 */
import { useSyncExternalStore } from 'react';
import { isEffectivelyOnline, subscribeConnectivity } from './connectivity.js';

export function useOnline(): boolean {
  return useSyncExternalStore(subscribeConnectivity, isEffectivelyOnline, () => true);
}
