import { createContext, useContext, type ReactNode } from 'react';
import type { Tone } from './Surface.js';

export interface ToastApi {
  /** Affiche une notification brève (4 s ; 7 s pour une erreur). */
  notify: (message: ReactNode, tone?: Tone) => void;
}

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast doit être appelé sous un ToastProvider.');
  return api;
}
