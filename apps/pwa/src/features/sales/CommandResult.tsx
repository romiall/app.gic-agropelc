/**
 * Retour immédiat après une opération (UX-05) : suit la commande dans l'outbox jusqu'à la réponse du
 * serveur. Enregistrée sur l'appareil, envoyée, acceptée (avec le numéro officiel), acceptée avec
 * avertissement, en conflit ou refusée avec le motif du serveur en langage métier (BR-SYN-009).
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { phaseOf, rejectionMessage, useOutboxCommand } from './submit.js';

interface CommandResultProps {
  readonly commandId: string;
  /** Préfixe des clés i18n du résultat (`sales.result`, `orders.result`…). */
  readonly messages: string;
  readonly children?: ReactNode;
}

export function CommandResult({ commandId, messages, children }: CommandResultProps) {
  const { t, i18n } = useTranslation();
  const command = useOutboxCommand(commandId);
  if (!command) return null;
  const phase = phaseOf(command);
  const doc = command.server_refs?.docNumber ?? '';
  let text: string;
  if (phase === 'WAITING') {
    text = t(`${messages}.WAITING_${command.captured_offline ? 'offline' : 'online'}`);
  } else if (phase === 'REJECTED') {
    text = t(`${messages}.REJECTED`, { reason: rejectionMessage(command) ?? '' });
  } else if (phase === 'WARNING') {
    // Libellé propre à l'avertissement renvoyé par le serveur s'il existe (ex. quarantaine).
    const specific = (command.warnings ?? [])
      .map((code) => `${messages}.WARNING_${code}`)
      .find((key) => i18n.exists(key));
    text = t(specific ?? `${messages}.WARNING`, { doc });
  } else {
    text = t(`${messages}.${phase}`, { doc });
  }
  const tone =
    phase === 'REJECTED'
      ? 'error'
      : phase === 'WAITING'
        ? 'info'
        : phase === 'DONE'
          ? 'ok'
          : 'warn';
  return (
    <div className={`result result-${tone}`} role={phase === 'REJECTED' ? 'alert' : 'status'}>
      <p>{text}</p>
      {children ? <div className="result-actions">{children}</div> : null}
    </div>
  );
}
