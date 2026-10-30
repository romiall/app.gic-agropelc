/**
 * Retour immédiat après une opération (UX-05) : suit la commande dans l'outbox jusqu'à la réponse du
 * serveur. Enregistrée sur l'appareil, envoyée, acceptée (avec le numéro officiel), acceptée avec
 * avertissement, en conflit ou refusée avec le motif du serveur en langage métier (BR-SYN-009).
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner, type BannerTone } from '../../components/ui/index.js';
import {
  inRepeatedFailure,
  phaseOf,
  rejectionMessage,
  useBehindDeviceApproval,
  useHeldBehindFailure,
  useOutboxCommand,
} from './submit.js';

const BANNER_TONE = {
  error: 'bad',
  warn: 'warn',
  info: 'info',
  ok: 'ok',
} as const satisfies Record<string, BannerTone>;

interface CommandResultProps {
  readonly commandId: string;
  /** Préfixe des clés i18n du résultat (`sales.result`, `orders.result`…). */
  readonly messages: string;
  readonly children?: ReactNode;
}

export function CommandResult({ commandId, messages, children }: CommandResultProps) {
  const { t, i18n } = useTranslation();
  const command = useOutboxCommand(commandId);
  // Retenue derrière une opération plus ancienne en échec répété : elle n'est pas traitée avant.
  const holder = useHeldBehindFailure(command);
  // Appareil en attente d'approbation (AV-228), pour cette commande ou une plus ancienne de l'auteur.
  const deviceApproval = useBehindDeviceApproval(command);
  if (!command) return null;
  const phase = phaseOf(command);
  // Numéro du document créé (vente, perte…) ; numéro du lot pour une création de lot.
  const doc =
    command.server_refs?.docNumber ??
    command.server_refs?.lotCode ??
    command.server_refs?.batchCode ??
    '';
  let text: string;
  const repeated = inRepeatedFailure(command);
  if (repeated) {
    // Renvoyée sans succès : toujours réessayée, mais elle ne bloque plus l'écran.
    text = t('sync.repeated_failure', { reason: rejectionMessage(command) ?? '' });
  } else if (holder) {
    text = t('sync.held_behind_failure', { reason: rejectionMessage(holder) ?? '' });
  } else if (deviceApproval) {
    // Appareil en attente d'approbation (AV-228) : l'opération partira après l'approbation.
    text = t('sync.device_pending');
  } else if (phase === 'WAITING') {
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
      : repeated || holder
        ? 'warn'
        : phase === 'WAITING'
          ? 'info'
          : phase === 'DONE'
            ? 'ok'
            : 'warn';
  return (
    <Banner
      className={`result result-${tone}`}
      tone={BANNER_TONE[tone]}
      role={phase === 'REJECTED' ? 'alert' : 'status'}
      {...(children ? { action: <div className="result-actions">{children}</div> } : {})}
    >
      {text}
    </Banner>
  );
}
